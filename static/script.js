// ===== マルチトラック音声エディタ フロントエンド =====

let PX_PER_SEC = 60; // 横方向(時間軸)のズーム。ズームボタンで自分の画面だけ変更できる
const LABEL_WIDTH = 150;
const GRID_SNAP_SEC = 1; // グリッドスナップの間隔(秒)。track-laneの背景の縦線(1秒間隔)と揃えている
const SNAP_PX_THRESHOLD = 8; // スナップが効く距離(px)。PX_PER_SECで秒に換算して使う

// ズームの範囲。広すぎたり狭すぎたりして操作不能にならないようクランプする
const MIN_PX_PER_SEC = 8;
const MAX_PX_PER_SEC = 400;
const DEFAULT_PX_PER_SEC = 60;
const MIN_TRACK_H = 40;
const MAX_TRACK_H = 160;
const DEFAULT_TRACK_H = 72;
const COMPACT_TRACK_H_THRESHOLD = 50; // これ以下の高さでは、トラックラベル内をトラック名だけの簡易表示にする
const ZOOM_STEP = 1.25;

let trackH = DEFAULT_TRACK_H; // 縦方向(トラックの高さ)のズーム。--track-h と同期する

const state = {
  tracks: [],       // [{trackId, label, clips: [clip, ...]}]
  selectedClipId: null,
  playheadSec: 0,
  isPlaying: false,
  bufferCache: {},     // fileId -> Promise<AudioBuffer> (デコード済み音声データ、クリップ間で共有)
  activeSources: [],   // 再生中のAudioBufferSourceNode一覧
  activeGainNodes: {}, // trackId -> GainNode (再生中のトラック音量を反映するためのノード)
  activeAnalysers: {}, // trackId -> AnalyserNode (dBメーター表示用。信号経路には影響しない)
  masterAnalyser: null,   // 全トラック合算のdBメーター用AnalyserNode
  meterFillEls: {},       // trackId -> メーターの塗りつぶし要素(DOM参照キャッシュ)
  meterDisplayDb: {},     // trackId | "master" -> 表示用に減衰させた現在のdB値
  rafId: null,
  playStartCtxTime: 0, // 再生開始時のAudioContext.currentTime
  _playStartSec: 0,    // 再生開始時点のタイムライン上の秒数
};

let clipCounter = 0;
let trackCounter = 0;

const el = {
  fileInput: document.getElementById("fileInput"),
  fileBtnLabel: document.querySelector(".file-btn"), // 現在は<button id="addTrackBtn">
  addTrackWrap: document.getElementById("addTrackWrap"),
  addTrackBtn: document.getElementById("addTrackBtn"),
  addTrackMenu: document.getElementById("addTrackMenu"),
  addFromFileBtn: document.getElementById("addFromFileBtn"),
  addFromDemoBtn: document.getElementById("addFromDemoBtn"),
  demoTracksPanel: document.getElementById("demoTracksPanel"),
  demoTracksList: document.getElementById("demoTracksList"),
  tracksContainer: document.getElementById("tracksContainer"),
  ruler: document.getElementById("ruler"),
  workspaceBody: document.getElementById("workspaceBody"),
  emptyHint: document.getElementById("emptyHint"),
  status: document.getElementById("status"),
  playBtn: document.getElementById("playBtn"),
  stopBtn: document.getElementById("stopBtn"),
  masterMeterFill: document.getElementById("masterMeterFill"),
  cutBtn: document.getElementById("cutBtn"),
  deleteBtn: document.getElementById("deleteBtn"),
  clearUploadsBtn: document.getElementById("clearUploadsBtn"),
  zoomInH: document.getElementById("zoomInH"),
  zoomOutH: document.getElementById("zoomOutH"),
  zoomInV: document.getElementById("zoomInV"),
  zoomOutV: document.getElementById("zoomOutV"),
  zoomFitBtn: document.getElementById("zoomFitBtn"),
  exportBtn: document.getElementById("exportBtn"),
  formatSelect: document.getElementById("formatSelect"),
  currentTimeLabel: document.getElementById("currentTimeLabel"),
  totalTimeLabel: document.getElementById("totalTimeLabel"),
  joinModal: document.getElementById("joinModal"),
  joinNameInput: document.getElementById("joinNameInput"),
  joinBtn: document.getElementById("joinBtn"),
  myRoleBadge: document.getElementById("myRoleBadge"),
  editorInfo: document.getElementById("editorInfo"),
  collabActions: document.getElementById("collabActions"),
  participantsWrap: document.getElementById("participantsWrap"),
  participantsBtn: document.getElementById("participantsBtn"),
  participantsPanel: document.getElementById("participantsPanel"),
  participantsList: document.getElementById("participantsList"),
  participantsCount: document.getElementById("participantsCount"),
};

function setStatus(msg, isError = false) {
  el.status.textContent = msg || "";
  el.status.style.color = isError ? "#ff6b6b" : "";
}

function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------- 共同編集(オンライン編集) ----------
// サーバー(app.py)が「正」のプロジェクト状態(トラック/クリップ配置)を持ち、
// 「編集権」を持つ1人のユーザーだけがそれを書き換えられる(トークンパッシング方式)。
// 役割: host(承認/剥奪ができる) / editor(今まさに編集できる1人) / viewer(閲覧のみ)。
// ユーザーの識別にはログインを使わず、ブラウザごとに生成した匿名トークンを使う。

const ROLE_LABEL = { host: "ホスト", editor: "編集者", viewer: "閲覧者" };

const collab = {
  token: localStorage.getItem("daw_user_token") || generateToken(),
  name: "",
  hostToken: null,
  editorToken: null,
  users: [],
  pending: [],
  socket: null,
};
localStorage.setItem("daw_user_token", collab.token);

function generateToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isEditor() {
  return !!collab.editorToken && collab.token === collab.editorToken;
}
function isHost() {
  return !!collab.hostToken && collab.token === collab.hostToken;
}
function myRole() {
  if (isHost()) return "host";
  if (isEditor()) return "editor";
  return "viewer";
}

// 編集権を持つ人の操作だけをサーバーへ送信し、全員へ配信してもらう。
// (閲覧者からの呼び出しは isEditor() チェックで何もしない)
function syncProject() {
  if (!collab.socket || !isEditor()) return;
  collab.socket.emit("project_sync", { token: collab.token, tracks: state.tracks });
}

// サーバーから届いたプロジェクト状態(トラック/クリップ配置)を自分の画面に反映する
function applyRemoteProjectState(data) {
  state.tracks = (data && data.tracks) || [];
  ensureTrackDefaults(state.tracks);
  syncCountersFromTracks(state.tracks);
  if (state.selectedClipId && !findClip(state.selectedClipId)) {
    state.selectedClipId = null;
  }
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      loadBuffer(clip.fileId, clip.url).catch(() => {});
    }
  }
  renderAll();
}

// 古いプロジェクトデータ(volume/muted/soloフィールドが無いトラックなど)にも対応するための補完
function ensureTrackDefaults(tracks) {
  for (const track of tracks) {
    if (typeof track.volume !== "number" || Number.isNaN(track.volume)) {
      track.volume = 1;
    }
    if (typeof track.muted !== "boolean") track.muted = false;
    if (typeof track.solo !== "boolean") track.solo = false;
  }
}

// いずれかのトラックがソロ中かどうか
function anySolo(tracks) {
  return tracks.some((t) => t.solo);
}

// 「実際に鳴るべきかどうか」を判定する。
// ソロ中のトラックが1つでもあれば、ソロされていないトラックは(ミュートの有無に関わらず)自動的に無音になる。
function isEffectivelyMuted(track, tracks) {
  if (anySolo(tracks)) return !track.solo;
  return track.muted;
}

// 現在再生中の全トラックのGainNodeに、最新のミュート/ソロ/音量を反映する。
// (再生中にフェーダーやM/Sボタンを操作した際、その場で音に反映するために呼ぶ)
function applyLiveMixToActiveNodes() {
  for (const track of state.tracks) {
    const gainNode = state.activeGainNodes[track.trackId];
    if (!gainNode) continue;
    const vol = isEffectivelyMuted(track, state.tracks) ? 0 : track.volume ?? 1;
    gainNode.gain.value = vol;
  }
}

// 編集権が別の人に移った直後などにIDカウンターがリセットされたままだと、
// 新しい編集者が作るトラック/クリップのIDが既存のものと衝突しうるため、
// 受け取ったプロジェクト内の最大値までカウンターを進めておく
function syncCountersFromTracks(tracks) {
  let maxTrack = trackCounter;
  let maxClip = clipCounter;
  for (const track of tracks) {
    const tn = parseInt(String(track.trackId).replace(/^t/, ""), 10);
    if (!Number.isNaN(tn) && tn > maxTrack) maxTrack = tn;
    for (const clip of track.clips) {
      const cn = parseInt(String(clip.clipId).replace(/^c/, ""), 10);
      if (!Number.isNaN(cn) && cn > maxClip) maxClip = cn;
    }
  }
  trackCounter = maxTrack;
  clipCounter = maxClip;
}

// 役割(host/editor/viewer)に応じて編集系UIの有効/無効を切り替える
function updateEditPermissionUI() {
  const editing = isEditor();
  [el.cutBtn, el.deleteBtn, el.clearUploadsBtn].forEach((btn) => {
    if (btn) btn.disabled = !editing;
  });
  if (el.fileBtnLabel) {
    el.fileBtnLabel.classList.toggle("is-disabled", !editing);
    el.fileBtnLabel.disabled = !editing;
  }
  if (!editing) {
    el.addTrackMenu.hidden = true;
    el.demoTracksPanel.hidden = true;
  }
  el.tracksContainer.classList.toggle("view-only", !editing);
  document.querySelectorAll(".track-volume-fader, .track-volume-value, .track-toggle-btn").forEach((elm) => {
    elm.disabled = !editing;
  });
}

// 指定トークンの人が現在host/editor/viewerのどれかを判定する(自分以外の参加者表示にも使う)
function roleForToken(token) {
  if (token === collab.hostToken) return "host";
  if (token === collab.editorToken) return "editor";
  return "viewer";
}

// 参加者一覧パネルの中身を最新の状態に更新する(開閉状態はここでは変えない)
function renderParticipantsList() {
  el.participantsCount.textContent = String(collab.users.length);
  el.participantsList.innerHTML = "";
  const iAmHost = isHost();

  for (const u of collab.users) {
    const li = document.createElement("li");
    li.className = "participants-item";

    const row = document.createElement("div");
    row.className = "participants-row";

    const nameSpan = document.createElement("span");
    nameSpan.className = "participants-name";
    nameSpan.textContent = u.name + (u.token === collab.token ? "（あなた）" : "");
    row.appendChild(nameSpan);

    const roleOfUser = roleForToken(u.token);
    const isPending = collab.pending.some((p) => p.token === u.token);

    const roleBadge = document.createElement("span");
    roleBadge.className = `role-badge role-${roleOfUser} participants-role-badge`;
    roleBadge.textContent = isPending ? "リクエスト中" : ROLE_LABEL[roleOfUser];
    if (isPending) roleBadge.classList.add("role-pending");
    row.appendChild(roleBadge);

    li.appendChild(row);

    // 権限操作(付与/剥奪/承認/却下)は、自分自身を除き、ホストだけに表示する
    if (iAmHost && u.token !== collab.token) {
      const actions = document.createElement("div");
      actions.className = "participants-actions";

      if (roleOfUser === "editor") {
        const revokeBtn = document.createElement("button");
        revokeBtn.className = "btn tiny";
        revokeBtn.textContent = "編集権を外す";
        revokeBtn.addEventListener("click", () => {
          collab.socket.emit("reclaim_edit", { token: collab.token });
        });
        actions.appendChild(revokeBtn);
      } else if (isPending) {
        const approveBtn = document.createElement("button");
        approveBtn.className = "btn tiny primary";
        approveBtn.textContent = "承認";
        approveBtn.addEventListener("click", () => {
          collab.socket.emit("approve_edit", { token: u.token, byToken: collab.token });
        });
        actions.appendChild(approveBtn);

        const rejectBtn = document.createElement("button");
        rejectBtn.className = "btn tiny";
        rejectBtn.textContent = "却下";
        rejectBtn.addEventListener("click", () => {
          collab.socket.emit("reject_edit", { token: u.token, byToken: collab.token });
        });
        actions.appendChild(rejectBtn);
      } else {
        const grantBtn = document.createElement("button");
        grantBtn.className = "btn tiny";
        grantBtn.textContent = "編集権を付与";
        grantBtn.addEventListener("click", () => {
          // リクエストの有無に関わらず、ホストは直接誰にでも編集権を渡せる
          collab.socket.emit("approve_edit", { token: u.token, byToken: collab.token });
        });
        actions.appendChild(grantBtn);
      }

      li.appendChild(actions);
    }

    el.participantsList.appendChild(li);
  }
  if (collab.users.length === 0) {
    const li = document.createElement("li");
    li.className = "participants-empty";
    li.textContent = "誰も参加していません";
    el.participantsList.appendChild(li);
  }
}

function toggleParticipantsPanel(forceOpen) {
  const willOpen = forceOpen ?? el.participantsPanel.hidden;
  el.participantsPanel.hidden = !willOpen;
}

el.participantsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleParticipantsPanel();
});
// パネルの外側をクリックしたら閉じる
document.addEventListener("click", (e) => {
  if (!el.participantsPanel.hidden && !el.participantsWrap.contains(e.target)) {
    toggleParticipantsPanel(false);
  }
});

function renderCollabBar() {
  const role = myRole();
  el.myRoleBadge.textContent = `${collab.name}（${ROLE_LABEL[role]}）`;
  el.myRoleBadge.className = `role-badge role-${role}`;
  renderParticipantsList();

  const editorUser = collab.users.find((u) => u.token === collab.editorToken);
  if (editorUser) {
    el.editorInfo.textContent = `✏️ 編集中: ${editorUser.name}${
      editorUser.token === collab.token ? "（あなた）" : ""
    }`;
  } else {
    el.editorInfo.textContent = "✏️ 編集者なし";
  }

  el.collabActions.innerHTML = "";

  if (role === "viewer") {
    const alreadyRequested = collab.pending.some((p) => p.token === collab.token);
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = alreadyRequested ? "リクエスト取消" : "✋ 編集権をリクエスト";
    btn.addEventListener("click", () => {
      if (alreadyRequested) {
        collab.socket.emit("cancel_request", { token: collab.token });
      } else {
        collab.socket.emit("request_edit", { token: collab.token });
      }
    });
    el.collabActions.appendChild(btn);
  }
  // ホストによる承認/却下/編集権の付与・剥奪は「👥 参加者」一覧の各行から行う(そちらに統合)
}

function connectSocket() {
  collab.socket = io();

  collab.socket.on("connect", () => {
    collab.socket.emit("join", { token: collab.token, name: collab.name });
  });

  collab.socket.on("room_state", (data) => {
    collab.hostToken = data.hostToken;
    collab.editorToken = data.editorToken;
    collab.users = data.users || [];
    collab.pending = data.pending || [];
    renderCollabBar();
    updateEditPermissionUI();
  });

  collab.socket.on("project_state", (data) => {
    applyRemoteProjectState(data);
  });
}

el.joinBtn.addEventListener("click", doJoin);
el.joinNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doJoin();
});

function doJoin() {
  const name = el.joinNameInput.value.trim();
  if (!name) {
    el.joinNameInput.focus();
    return;
  }
  collab.name = name;
  el.joinModal.style.display = "none";
  connectSocket();
}

// ---------- 音声再生エンジン(Web Audio API) ----------
// <audio>要素 + setTimeoutでの再生は、シーク・再生開始のタイミングに数十ms単位の
// 誤差やゆらぎが出やすく、カットした境目で音が途切れたり重なったりする原因になる。
// Web Audio APIでバッファを直接スケジューリングし、カット前後のクリップをサンプル
// 単位の精度でつなぐことで、境目のノイズを解消する。

let audioContext = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
  }
  return audioContext;
}

// ---------- dBメーター ----------
// AnalyserNodeは信号経路(GainNode→destination)には影響を与えず、並行して
// タップ(接続)しておくだけで波形データを覗き見できる。ここではその波形の
// ピーク値をdBに変換し、見やすいように「立ち上がりは一瞬、下降はゆっくり」
// という典型的なピークメーターの動きに整えてから画面に反映する。
const METER_MIN_DB = -60;
const METER_DECAY_PER_FRAME = 0.6; // dB/フレーム。下降時のみこの速さで滑らかに減衰させる
let meterScratch = new Float32Array(512);

function analyserPeakDb(analyser) {
  if (meterScratch.length !== analyser.fftSize) {
    meterScratch = new Float32Array(analyser.fftSize);
  }
  analyser.getFloatTimeDomainData(meterScratch);
  let peak = 0;
  for (let i = 0; i < meterScratch.length; i++) {
    const v = Math.abs(meterScratch[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-5) return METER_MIN_DB;
  return Math.max(METER_MIN_DB, 20 * Math.log10(peak));
}

// 立ち上がりは即座に、下降はゆっくり追従させることで、数値がチラつかず読み取りやすくする
function smoothedDb(key, rawDb) {
  const prev = state.meterDisplayDb[key] ?? METER_MIN_DB;
  const next = rawDb > prev ? rawDb : Math.max(rawDb, prev - METER_DECAY_PER_FRAME);
  state.meterDisplayDb[key] = next;
  return next;
}

function applyMeterFill(fillEl, db) {
  if (!fillEl) return;
  const level = Math.min(1, Math.max(0, (db - METER_MIN_DB) / (0 - METER_MIN_DB)));
  fillEl.style.transform = `scaleX(${1 - level})`;
}

function updateMeters() {
  for (const track of state.tracks) {
    const analyser = state.activeAnalysers[track.trackId];
    const fillEl = state.meterFillEls[track.trackId];
    if (!analyser || !fillEl) continue;
    applyMeterFill(fillEl, smoothedDb(track.trackId, analyserPeakDb(analyser)));
  }
  if (state.masterAnalyser) {
    applyMeterFill(el.masterMeterFill, smoothedDb("master", analyserPeakDb(state.masterAnalyser)));
  }
}

// 再生停止時、メーターを静止状態(表示なし)に戻す
function resetMeters() {
  state.meterDisplayDb = {};
  Object.values(state.meterFillEls).forEach((fillEl) => applyMeterFill(fillEl, METER_MIN_DB));
  applyMeterFill(el.masterMeterFill, METER_MIN_DB);
}

// 同じ音声ファイルはクリップ(カット後の断片含む)間でデコード結果を共有し、
// 再生のたびに毎回フェッチ・デコードし直さないようにする
function loadBuffer(fileId, url) {
  if (!state.bufferCache[fileId]) {
    state.bufferCache[fileId] = fetch(url)
      .then((res) => res.arrayBuffer())
      .then((arrayBuffer) => getAudioContext().decodeAudioData(arrayBuffer));
  }
  return state.bufferCache[fileId];
}

// ---------- アップロード ----------

el.fileInput.addEventListener("change", async (e) => {
  if (!isEditor()) {
    setStatus("編集権がありません。ホストにリクエストしてください", true);
    e.target.value = "";
    return;
  }
  const files = Array.from(e.target.files || []);
  for (const file of files) {
    await uploadFile(file);
  }
  e.target.value = "";
  renderAll();
  syncProject();
});

async function uploadFile(file) {
  setStatus(`アップロード中: ${file.name} ...`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/upload", {
      method: "POST",
      headers: { "X-User-Token": collab.token },
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "アップロードに失敗しました"}`, true);
      return;
    }
    addTrackFromResponseData(data);
    setStatus(`追加しました: ${file.name}`);
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
}

// /api/upload または /api/demo-tracks/<id>/add のレスポンス(同じ形式)から
// 新しいトラック+クリップをタイムラインに追加する共通処理
function addTrackFromResponseData(data) {
  trackCounter += 1;
  const trackId = `t${trackCounter}`;
  const clip = {
    clipId: `c${++clipCounter}`,
    fileId: data.id,
    ext: data.ext,
    filename: data.filename,
    url: data.url,
    srcDuration: data.duration,
    trimStart: 0,
    trimEnd: data.duration,
    timelineStart: 0,
    trackId,
  };
  state.tracks.push({ trackId, label: data.filename, volume: 1, muted: false, solo: false, clips: [clip] });
  loadBuffer(clip.fileId, clip.url).catch(() => {}); // 再生に備えて先にデコードしておく
}

// デモ音源(サーバーが合成した試用音源)を1つ選んでタイムラインに追加する
async function addDemoTrack(demoId, demoName) {
  if (!isEditor()) {
    setStatus("編集権がありません", true);
    return;
  }
  setStatus(`デモ音源を追加中: ${demoName} ...`);
  try {
    const res = await fetch(`/api/demo-tracks/${demoId}/add`, {
      method: "POST",
      headers: { "X-User-Token": collab.token },
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "デモ音源の追加に失敗しました"}`, true);
      return;
    }
    addTrackFromResponseData(data);
    renderAll();
    syncProject();
    setStatus(`追加しました: ${demoName}`);
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
}

// ---------- 「+ ファイルを追加」ドロップダウン(ファイル / デモ音源の選択) ----------

el.addTrackBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!isEditor()) return;
  el.demoTracksPanel.hidden = true;
  el.addTrackMenu.hidden = !el.addTrackMenu.hidden;
});

el.addFromFileBtn.addEventListener("click", () => {
  el.addTrackMenu.hidden = true;
  el.fileInput.click();
});

el.addFromDemoBtn.addEventListener("click", () => {
  openDemoTracksPanel();
});

// メニュー/パネルの外側をクリックしたら閉じる
document.addEventListener("click", (e) => {
  if (!el.addTrackWrap.contains(e.target)) {
    el.addTrackMenu.hidden = true;
    el.demoTracksPanel.hidden = true;
  }
});

async function openDemoTracksPanel() {
  el.addTrackMenu.hidden = true;
  el.demoTracksPanel.hidden = false;
  el.demoTracksList.innerHTML = `<li class="demo-tracks-empty">読み込み中...</li>`;
  try {
    const res = await fetch("/api/demo-tracks");
    const list = await res.json();
    el.demoTracksList.innerHTML = "";
    if (!Array.isArray(list) || list.length === 0) {
      el.demoTracksList.innerHTML = `<li class="demo-tracks-empty">デモ音源がありません</li>`;
      return;
    }
    for (const d of list) {
      const li = document.createElement("li");
      li.className = "demo-tracks-item";

      const info = document.createElement("div");
      info.className = "demo-tracks-info";
      const nameSpan = document.createElement("span");
      nameSpan.className = "demo-tracks-name";
      nameSpan.textContent = d.name;
      info.appendChild(nameSpan);
      const durSpan = document.createElement("span");
      durSpan.className = "demo-tracks-duration";
      durSpan.textContent = fmtTime(d.duration);
      info.appendChild(durSpan);
      li.appendChild(info);

      const addBtn = document.createElement("button");
      addBtn.className = "btn tiny primary";
      addBtn.textContent = "追加";
      addBtn.disabled = !isEditor();
      addBtn.addEventListener("click", () => {
        el.demoTracksPanel.hidden = true;
        addDemoTrack(d.id, d.name);
      });
      li.appendChild(addBtn);

      el.demoTracksList.appendChild(li);
    }
  } catch (err) {
    el.demoTracksList.innerHTML = `<li class="demo-tracks-empty">読み込みに失敗しました</li>`;
  }
}

// ---------- 描画 ----------

// ---------- ズーム(横=時間軸 / 縦=トラックの高さ) ----------
// どちらも「自分のブラウザでの見え方」だけの設定で、プロジェクトの共有データには含めない。
// サーバーへの同期は行わないため、他の人の画面には一切影響しない。

function setPxPerSec(value) {
  PX_PER_SEC = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, Math.round(value)));
  renderAll();
}

function setTrackH(value) {
  trackH = Math.min(MAX_TRACK_H, Math.max(MIN_TRACK_H, Math.round(value)));
  document.documentElement.style.setProperty("--track-h", `${trackH}px`);
  // 高さを詰めすぎるとラベル内のM/Sボタンやフェーダーが収まらないため、
  // 一定以下ではトラック名だけの簡易表示に切り替える
  el.tracksContainer.classList.toggle("compact-labels", trackH <= COMPACT_TRACK_H_THRESHOLD);
}

el.zoomInH.addEventListener("click", () => setPxPerSec(PX_PER_SEC * ZOOM_STEP));
el.zoomOutH.addEventListener("click", () => setPxPerSec(PX_PER_SEC / ZOOM_STEP));
el.zoomInV.addEventListener("click", () => setTrackH(trackH * ZOOM_STEP));
el.zoomOutV.addEventListener("click", () => setTrackH(trackH / ZOOM_STEP));

// 全トラック・タイムライン全体の長さが、ちょうど画面に収まるよう横/縦のズームを自動計算する
el.zoomFitBtn.addEventListener("click", () => {
  const total = Math.max(1, timelineTotalDuration());
  const availW = Math.max(100, el.workspaceBody.clientWidth - LABEL_WIDTH - 40);
  setPxPerSec(availW / total);

  const trackCount = Math.max(1, state.tracks.length);
  const rulerAndPadding = 26 + 16; // ルーラーの高さ + workspace-bodyの余白ぶんの見込み
  const availH = Math.max(MIN_TRACK_H, el.workspaceBody.clientHeight - rulerAndPadding);
  setTrackH(availH / trackCount);
});

function timelineTotalDuration() {
  let maxT = 30;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT + 15;
}

// 実際の音声コンテンツの長さ(最後のクリップの終端)。ルーラー表示用の余白は含まない。
function contentDurationSec() {
  let maxT = 0;
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const end = clip.timelineStart + (clip.trimEnd - clip.trimStart);
      if (end > maxT) maxT = end;
    }
  }
  return maxT;
}

// 画面上部の「現在位置 / 合計時間」表示を更新する
function updateTimeDisplay(currentSec) {
  const cur = currentSec !== undefined ? currentSec : state.playheadSec;
  el.currentTimeLabel.textContent = fmtTime(cur);
  el.totalTimeLabel.textContent = fmtTime(contentDurationSec());
}

function renderRuler() {
  const total = timelineTotalDuration();
  el.ruler.innerHTML = "";
  el.ruler.style.width = `${total * PX_PER_SEC}px`;
  for (let s = 0; s <= total; s += 5) {
    const tick = document.createElement("div");
    tick.className = "tick";
    tick.style.left = `${s * PX_PER_SEC}px`;
    tick.textContent = fmtTime(s);
    el.ruler.appendChild(tick);
  }
}

// ルーラーの目盛り(5秒間隔)と同じ位置に、トラック全体を貫通するグリッド線を描画する
function renderGridLines(total) {
  for (let s = 0; s <= total; s += 5) {
    const line = document.createElement("div");
    line.className = "grid-line";
    line.style.left = `${LABEL_WIDTH + s * PX_PER_SEC}px`;
    el.tracksContainer.appendChild(line);
  }
}

function renderAll() {
  el.emptyHint.style.display = state.tracks.length === 0 ? "block" : "none";
  renderRuler();
  updateTimeDisplay();

  // 既存の track-row / grid-line / playhead を削除して再構築
  el.tracksContainer.querySelectorAll(".track-row, .grid-line, .playhead").forEach((n) => n.remove());
  state.meterFillEls = {}; // トラック削除で消えた要素の古い参照が残らないようにする

  const total = timelineTotalDuration();
  renderGridLines(total);

  for (const track of state.tracks) {
    const row = document.createElement("div");
    row.className = "track-row";
    if (isEffectivelyMuted(track, state.tracks)) {
      row.classList.add("track-row--silenced");
    }

    const label = document.createElement("div");
    label.className = "track-label";

    const labelTop = document.createElement("div");
    labelTop.className = "track-label-top";

    const labelText = document.createElement("span");
    labelText.className = "track-label-text";
    labelText.textContent = track.label;
    labelText.title = track.label;
    labelTop.appendChild(labelText);

    const trackDeleteBtn = document.createElement("button");
    trackDeleteBtn.className = "track-delete-btn";
    trackDeleteBtn.title = "この音源ファイルをサーバーから削除";
    trackDeleteBtn.textContent = "🗑";
    trackDeleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTrackFile(track);
    });
    labelTop.appendChild(trackDeleteBtn);

    label.appendChild(labelTop);
    label.appendChild(buildTrackControlsEl(track));
    label.appendChild(buildTrackMeterEl(track));

    row.appendChild(label);

    const lane = document.createElement("div");
    lane.className = "track-lane";
    lane.style.width = `${total * PX_PER_SEC}px`;
    lane.dataset.trackId = track.trackId;
    lane.addEventListener("click", (e) => {
      if (e.target === lane) seekFromClientX(e.clientX, lane);
    });

    for (const clip of track.clips) {
      lane.appendChild(buildClipEl(clip));
    }

    row.appendChild(lane);
    el.tracksContainer.appendChild(row);
  }

  const playhead = document.createElement("div");
  playhead.className = "playhead";
  playhead.id = "playheadEl";
  playhead.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;

  const handle = document.createElement("div");
  handle.className = "playhead-handle";
  playhead.appendChild(handle);
  attachScrub(handle, el.ruler); // つまみ(丸)からもスクラブできるようにする。座標計算はルーラー基準。

  el.tracksContainer.appendChild(playhead);
}

// トラックラベル内の操作行(ミュート/ソロボタン + 音量フェーダー)を組み立てる
function buildTrackControlsEl(track) {
  const wrap = document.createElement("div");
  wrap.className = "track-volume";

  const editing = isEditor();

  const muteBtn = document.createElement("button");
  muteBtn.className = "track-toggle-btn track-mute-btn" + (track.muted ? " active" : "");
  muteBtn.textContent = "M";
  muteBtn.title = "ミュート";
  muteBtn.disabled = !editing;
  muteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isEditor()) return;
    track.muted = !track.muted;
    renderAll();
    applyLiveMixToActiveNodes();
    syncProject();
  });
  wrap.appendChild(muteBtn);

  const soloBtn = document.createElement("button");
  soloBtn.className = "track-toggle-btn track-solo-btn" + (track.solo ? " active" : "");
  soloBtn.textContent = "S";
  soloBtn.title = "ソロ(このトラックだけを聴く)";
  soloBtn.disabled = !editing;
  soloBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!isEditor()) return;
    track.solo = !track.solo;
    renderAll();
    applyLiveMixToActiveNodes();
    syncProject();
  });
  wrap.appendChild(soloBtn);

  const fader = document.createElement("input");
  fader.type = "range";
  fader.className = "track-volume-fader";
  fader.min = "0";
  fader.max = "150";
  fader.step = "1";
  fader.value = String(Math.round((track.volume ?? 1) * 100));
  fader.disabled = !editing;
  fader.title = "トラックの音量";

  // 数値を直接タイプしても調整できるよう、表示はテキストではなく<input type="number">にする
  const valueWrap = document.createElement("span");
  valueWrap.className = "track-volume-value-wrap";

  const valueInput = document.createElement("input");
  valueInput.type = "number";
  valueInput.className = "track-volume-value";
  valueInput.min = "0";
  valueInput.max = "150";
  valueInput.step = "1";
  valueInput.value = fader.value;
  valueInput.disabled = !editing;
  valueInput.title = "数値を入力して音量を調整(0〜150%)";

  const unitLabel = document.createElement("span");
  unitLabel.className = "track-volume-unit";
  unitLabel.textContent = "%";

  // ドラッグ/入力中はローカルに即反映(再生中ならリアルタイムにも反映)し、
  // 指を離した・入力を確定した(change)タイミングでサーバーへ同期する
  function applyVolumePercent(percent) {
    const vol = percent / 100;
    track.volume = vol;
    fader.value = String(percent);
    valueInput.value = String(percent);
    applyLiveMixToActiveNodes();
  }

  fader.addEventListener("input", () => {
    if (!isEditor()) return;
    applyVolumePercent(Number(fader.value));
  });
  fader.addEventListener("change", () => {
    if (!isEditor()) return;
    syncProject();
  });

  valueInput.addEventListener("input", () => {
    if (!isEditor()) return;
    const n = parseInt(valueInput.value, 10);
    if (Number.isNaN(n)) return; // 入力途中(空など)はいったん無視し、確定時に補正する
    applyVolumePercent(Math.min(150, Math.max(0, n)));
  });
  valueInput.addEventListener("change", () => {
    if (!isEditor()) return;
    // 空欄や範囲外のまま確定された場合は、有効な値に補正してから同期する
    let n = parseInt(valueInput.value, 10);
    if (Number.isNaN(n)) n = Math.round((track.volume ?? 1) * 100);
    applyVolumePercent(Math.min(150, Math.max(0, n)));
    syncProject();
  });
  valueInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      valueInput.blur(); // blurでchangeが発火し、確定・同期される
    }
  });
  valueInput.addEventListener("focus", () => valueInput.select());
  valueInput.addEventListener("click", (e) => e.stopPropagation());

  valueWrap.appendChild(valueInput);
  valueWrap.appendChild(unitLabel);

  wrap.appendChild(fader);
  wrap.appendChild(valueWrap);
  return wrap;
}

// トラックの音量メーター(細い横バー)を組み立てる。再生中のみ動き、
// 停止中は静止(空)のまま。DOM参照はstate.meterFillElsにキャッシュしておく。
function buildTrackMeterEl(track) {
  const meter = document.createElement("div");
  meter.className = "track-meter";
  const fill = document.createElement("div");
  fill.className = "track-meter-fill";
  meter.appendChild(fill);
  state.meterFillEls[track.trackId] = fill;
  return meter;
}

function buildClipEl(clip) {
  const dur = clip.trimEnd - clip.trimStart;
  const div = document.createElement("div");
  div.className = "clip" + (state.selectedClipId === clip.clipId ? " selected" : "");
  div.style.left = `${clip.timelineStart * PX_PER_SEC}px`;
  div.style.width = `${Math.max(dur * PX_PER_SEC, 10)}px`;
  div.dataset.clipId = clip.clipId;

  const labelDiv = document.createElement("div");
  labelDiv.className = "clip-label";
  labelDiv.textContent = clip.filename;
  div.appendChild(labelDiv);

  const leftHandle = document.createElement("div");
  leftHandle.className = "handle left";
  div.appendChild(leftHandle);

  const rightHandle = document.createElement("div");
  rightHandle.className = "handle right";
  div.appendChild(rightHandle);

  div.addEventListener("click", (e) => {
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    renderAll();
  });

  attachDrag(div, clip);
  attachResize(leftHandle, clip, "left");
  attachResize(rightHandle, clip, "right");

  return div;
}

function findClip(clipId) {
  for (const track of state.tracks) {
    const clip = track.clips.find((c) => c.clipId === clipId);
    if (clip) return { clip, track };
  }
  return null;
}

// ---------- スナップ(自動吸着) ----------
// クリップの移動・トリミング時に、きりのいい秒数(1秒刻みのグリッド)や、
// 他のクリップの端(特にカットでできた前後のパート)に近づいたら自動でぴったり合わせる。

// 指定クリップ以外の、全トラック上のクリップの開始・終了位置をスナップ候補として集める
function collectSnapCandidates(excludeClipId) {
  const candidates = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      if (clip.clipId === excludeClipId) continue;
      candidates.push(clip.timelineStart);
      candidates.push(clip.timelineStart + (clip.trimEnd - clip.trimStart));
    }
  }
  return candidates;
}

// targetに最も近いスナップ候補(グリッド or 他クリップの端)への補正量(秒)を返す。
// しきい値内に候補が無ければnullを返す。
function bestSnapDelta(target, edgeCandidates) {
  const thresholdSec = SNAP_PX_THRESHOLD / PX_PER_SEC;
  const candidates = edgeCandidates.concat([Math.round(target / GRID_SNAP_SEC) * GRID_SNAP_SEC]);

  let best = null;
  let bestDist = thresholdSec;
  for (const c of candidates) {
    if (c < 0) continue; // タイムラインは0秒以降のみ
    const dist = Math.abs(c - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = c - target;
    }
  }
  return best;
}

// ---------- ドラッグ移動 ----------

function attachDrag(clipEl, clip) {
  clipEl.addEventListener("mousedown", (e) => {
    if (e.target.classList.contains("handle")) return;
    if (!isEditor()) return; // 閲覧者はクリップを動かせない
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTimelineStart = clip.timelineStart;
    const dur = clip.trimEnd - clip.trimStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;
      let newStart = Math.max(0, startTimelineStart + deltaSec);

      // クリップの開始端・終了端のどちらか近い方をスナップさせる
      const startDelta = bestSnapDelta(newStart, snapCandidates);
      const endDelta = bestSnapDelta(newStart + dur, snapCandidates);
      if (startDelta !== null && (endDelta === null || Math.abs(startDelta) <= Math.abs(endDelta))) {
        newStart += startDelta;
      } else if (endDelta !== null) {
        newStart += endDelta;
      }

      clip.timelineStart = Math.max(0, newStart);
      clipEl.style.left = `${clip.timelineStart * PX_PER_SEC}px`;
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      renderAll();
      syncProject();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- トリミング(端のドラッグ) ----------

function attachResize(handleEl, clip, side) {
  handleEl.addEventListener("mousedown", (e) => {
    if (!isEditor()) return; // 閲覧者はトリミングできない
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.clipId;
    const startX = e.clientX;
    const startTrimStart = clip.trimStart;
    const startTrimEnd = clip.trimEnd;
    const startTimelineStart = clip.timelineStart;
    const snapCandidates = collectSnapCandidates(clip.clipId);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const deltaSec = dx / PX_PER_SEC;

      if (side === "left") {
        let newTrimStart = startTrimStart + deltaSec;
        newTrimStart = Math.max(0, Math.min(newTrimStart, startTrimEnd - 0.05));
        let actualDelta = newTrimStart - startTrimStart;
        let newTimelineStart = Math.max(0, startTimelineStart + actualDelta);

        // 左端(タイムライン上の開始位置)をスナップさせ、trimStartも整合を取り直す
        const snapDelta = bestSnapDelta(newTimelineStart, snapCandidates);
        if (snapDelta !== null) {
          newTimelineStart += snapDelta;
          actualDelta = newTimelineStart - startTimelineStart;
          newTrimStart = Math.max(0, Math.min(startTrimStart + actualDelta, startTrimEnd - 0.05));
          actualDelta = newTrimStart - startTrimStart;
          newTimelineStart = Math.max(0, startTimelineStart + actualDelta);
        }

        clip.trimStart = newTrimStart;
        clip.timelineStart = newTimelineStart;
      } else {
        let newTrimEnd = startTrimEnd + deltaSec;
        newTrimEnd = Math.min(clip.srcDuration, Math.max(newTrimEnd, startTrimStart + 0.05));

        // 右端(タイムライン上の終了位置)をスナップさせ、trimEndへ逆算する
        const newEndOnTimeline = clip.timelineStart + (newTrimEnd - clip.trimStart);
        const snapDelta = bestSnapDelta(newEndOnTimeline, snapCandidates);
        if (snapDelta !== null) {
          const snappedEndOnTimeline = newEndOnTimeline + snapDelta;
          let snappedTrimEnd = clip.trimStart + (snappedEndOnTimeline - clip.timelineStart);
          snappedTrimEnd = Math.min(clip.srcDuration, Math.max(snappedTrimEnd, startTrimStart + 0.05));
          newTrimEnd = snappedTrimEnd;
        }

        clip.trimEnd = newTrimEnd;
      }
      renderAll();
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      syncProject();
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// ---------- カット / 削除 ----------

el.cutBtn.addEventListener("click", () => {
  if (!isEditor()) {
    setStatus("編集権がありません", true);
    return;
  }
  if (!state.selectedClipId) {
    setStatus("カットするクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;

  const clipStartT = clip.timelineStart;
  const clipEndT = clip.timelineStart + (clip.trimEnd - clip.trimStart);
  const playhead = state.playheadSec;

  if (playhead <= clipStartT + 0.05 || playhead >= clipEndT - 0.05) {
    setStatus("カットしたい位置に再生ヘッドを合わせてから実行してください", true);
    return;
  }

  const cutLocal = clip.trimStart + (playhead - clipStartT); // 元ファイル内でのカット位置

  const clipB = {
    ...clip,
    clipId: `c${++clipCounter}`,
    trimStart: cutLocal,
    timelineStart: clip.timelineStart + (cutLocal - clip.trimStart),
  };
  clip.trimEnd = cutLocal;

  const idx = track.clips.indexOf(clip);
  track.clips.splice(idx + 1, 0, clipB);

  setStatus("カットしました。2つのクリップに分割されました。");
  renderAll();
  syncProject();
});

el.deleteBtn.addEventListener("click", () => {
  if (!isEditor()) {
    setStatus("編集権がありません", true);
    return;
  }
  if (!state.selectedClipId) {
    setStatus("削除するクリップを選択してください", true);
    return;
  }
  const found = findClip(state.selectedClipId);
  if (!found) return;
  const { clip, track } = found;
  track.clips = track.clips.filter((c) => c.clipId !== clip.clipId);
  if (track.clips.length === 0) {
    state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);
  }
  state.selectedClipId = null;
  renderAll();
  syncProject();
});

// トラック1つ分の音源ファイルをサーバーから削除し、タイムラインからも取り除く
async function deleteTrackFile(track) {
  if (!isEditor()) {
    setStatus("編集権がありません", true);
    return;
  }
  const fileId = track.clips[0]?.fileId;

  if (fileId) {
    if (!confirm(`「${track.label}」をサーバーから完全に削除します。よろしいですか?`)) {
      return;
    }
    setStatus(`削除中: ${track.label} ...`);
    try {
      const res = await fetch(`/api/uploads/${fileId}`, {
        method: "DELETE",
        headers: { "X-User-Token": collab.token },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
        return;
      }
    } catch (err) {
      setStatus(`通信エラー: ${err}`, true);
      return;
    }
    delete state.bufferCache[fileId];
  }

  if (track.clips.some((c) => c.clipId === state.selectedClipId)) {
    state.selectedClipId = null;
  }
  state.tracks = state.tracks.filter((t) => t.trackId !== track.trackId);

  setStatus(`削除しました: ${track.label}`);
  renderAll();
  syncProject();
}

// サーバーに保存されている音源ファイルを(前回セッション分も含めて)まとめて削除する
el.clearUploadsBtn.addEventListener("click", async () => {
  if (!isEditor()) {
    setStatus("編集権がありません", true);
    return;
  }
  if (!confirm("サーバーに保存されている音源ファイルを全て削除します。よろしいですか?\n(現在編集中のタイムラインも空になります)")) {
    return;
  }
  setStatus("音源を全削除中...");
  try {
    const res = await fetch("/api/uploads", {
      method: "DELETE",
      headers: { "X-User-Token": collab.token },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "削除に失敗しました"}`, true);
      return;
    }
    stopPlayback();
    state.tracks = [];
    state.selectedClipId = null;
    state.bufferCache = {};
    setStatus(`削除しました(${data.deleted ?? 0}件)`);
    renderAll();
    syncProject();
  } catch (err) {
    setStatus(`通信エラー: ${err}`, true);
  }
});

// ---------- 再生ヘッド / シーク ----------

function seekFromClientX(clientX, referenceEl) {
  const rect = referenceEl.getBoundingClientRect();
  const x = clientX - rect.left;
  let sec = Math.max(0, x / PX_PER_SEC);

  // グリッド(1秒刻み)や他クリップの端(カットでできた前後のパートなど)に近ければスナップさせる。
  // 「カット」は再生ヘッドの位置で行われるため、これによりカット位置もぴったり合わせられる。
  const snapDelta = bestSnapDelta(sec, collectSnapCandidates());
  if (snapDelta !== null) {
    sec = Math.max(0, sec + snapDelta);
  }

  state.playheadSec = sec;
  renderPlayheadOnly();
}

// ドラッグ中はクリップを再構築せず、再生ヘッドの位置だけ動かす(軽量・無段階)
function renderPlayheadOnly() {
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + state.playheadSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(state.playheadSec);
}

// ルーラー、または再生ヘッドのつまみを押しながら動かす(スクラブ)ことで
// 無段階に再生ヘッドを移動できるようにする。
// triggerEl: mousedownを検知する要素 / referenceEl: 座標(秒)計算の基準にする要素
function attachScrub(triggerEl, referenceEl = triggerEl) {
  triggerEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.isPlaying) {
      stopPlayback();
    }
    seekFromClientX(e.clientX, referenceEl);

    function onMove(ev) {
      seekFromClientX(ev.clientX, referenceEl);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

attachScrub(el.ruler);
// ---------- 再生 / 停止 ----------

function stopPlayback() {
  state.isPlaying = false;
  state.activeSources.forEach((source) => {
    try {
      source.stop();
    } catch (e) {
      // 既に再生を終えたノードのstop()はエラーになるだけなので無視してよい
    }
  });
  state.activeSources = [];
  Object.values(state.activeGainNodes).forEach((gainNode) => {
    try {
      gainNode.disconnect();
    } catch (e) {
      // 既に切断済みの場合は無視してよい
    }
  });
  state.activeGainNodes = {};
  Object.values(state.activeAnalysers).forEach((analyser) => {
    try {
      analyser.disconnect();
    } catch (e) {
      // 既に切断済みの場合は無視してよい
    }
  });
  state.activeAnalysers = {};
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = null;
  resetMeters();
}

el.playBtn.addEventListener("click", async () => {
  stopPlayback();
  const ctx = getAudioContext();
  state.isPlaying = true;
  const startPlayhead = state.playheadSec;

  // 再生対象のクリップを先に洗い出す
  const targets = [];
  for (const track of state.tracks) {
    for (const clip of track.clips) {
      const dur = clip.trimEnd - clip.trimStart;
      const clipStartT = clip.timelineStart;
      const clipEndT = clip.timelineStart + dur;
      if (clipEndT <= startPlayhead) continue; // 既に終わっている
      targets.push({ clip, track, clipStartT, clipEndT });
    }
  }

  if (targets.length === 0) {
    setStatus("再生できるクリップがありません", true);
    state.isPlaying = false;
    return;
  }

  // 全クリップの音声データを先に確保してから、まとめて同じ基準時刻でスケジュールする。
  // バラバラにawaitすると、クリップごとの再生開始タイミングがズレてカットした
  // 境目にノイズが生じるため。
  let buffers;
  try {
    buffers = await Promise.all(targets.map((t) => loadBuffer(t.clip.fileId, t.clip.url)));
  } catch (err) {
    setStatus(`音声の読み込みに失敗しました: ${err}`, true);
    state.isPlaying = false;
    return;
  }

  if (!state.isPlaying) return; // 読み込み待ちの間に停止/再クリックされていたら何もしない

  // 少し先の時刻を共通の基準にすることで、全クリップをサンプル単位でぴったり同期させる
  const baseWhen = ctx.currentTime + 0.05;
  state.playStartCtxTime = baseWhen;
  state._playStartSec = startPlayhead;

  // マスターメーター用のAnalyserNode(全トラックのGainNodeをここにも並行してつなぐ)
  if (!state.masterAnalyser) {
    state.masterAnalyser = ctx.createAnalyser();
    state.masterAnalyser.fftSize = 512;
  }

  targets.forEach(({ clip, track, clipStartT, clipEndT }, i) => {
    const source = ctx.createBufferSource();
    source.buffer = buffers[i];

    // トラックごとにGainNodeを1つ共有し、フェーダーの値を音量として反映する。
    // 同じトラックの複数クリップ(カットで分かれた断片など)は同じGainNodeにつなぐ。
    let gainNode = state.activeGainNodes[track.trackId];
    if (!gainNode) {
      gainNode = ctx.createGain();
      gainNode.gain.value = isEffectivelyMuted(track, state.tracks) ? 0 : track.volume ?? 1;
      gainNode.connect(ctx.destination);
      gainNode.connect(state.masterAnalyser); // マスターメーターへ並行してタップ
      state.activeGainNodes[track.trackId] = gainNode;

      // トラック個別のdBメーター用AnalyserNode。出力先には接続せず、値を読み取るだけに使う。
      const trackAnalyser = ctx.createAnalyser();
      trackAnalyser.fftSize = 512;
      gainNode.connect(trackAnalyser);
      state.activeAnalysers[track.trackId] = trackAnalyser;
    }
    source.connect(gainNode);

    const offsetIntoClip = clip.trimStart + Math.max(0, startPlayhead - clipStartT);
    const startDelay = Math.max(0, clipStartT - startPlayhead);
    const playDuration = clipEndT - Math.max(clipStartT, startPlayhead);

    source.start(baseWhen + startDelay, offsetIntoClip, playDuration);
    state.activeSources.push(source);
  });

  setStatus("再生中...");
  tickPlayhead();
});

function tickPlayhead() {
  if (!state.isPlaying) return;
  const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
  const nowSec = state._playStartSec + elapsed;
  const playheadEl = document.getElementById("playheadEl");
  if (playheadEl) {
    playheadEl.style.left = `${LABEL_WIDTH + nowSec * PX_PER_SEC}px`;
  }
  updateTimeDisplay(nowSec);
  updateMeters();
  state.rafId = requestAnimationFrame(tickPlayhead);
}

el.stopBtn.addEventListener("click", () => {
  if (state.isPlaying) {
    const elapsed = Math.max(0, getAudioContext().currentTime - state.playStartCtxTime);
    state.playheadSec = state._playStartSec + elapsed;
  }
  stopPlayback();
  setStatus("停止しました");
  renderAll();
});

// ---------- 書き出し(結合) ----------

el.exportBtn.addEventListener("click", async () => {
  const clips = [];
  for (const track of state.tracks) {
    const effectiveVolume = isEffectivelyMuted(track, state.tracks) ? 0 : track.volume ?? 1;
    for (const clip of track.clips) {
      clips.push({
        fileId: clip.fileId,
        ext: clip.ext,
        trimStart: clip.trimStart,
        trimEnd: clip.trimEnd,
        timelineStart: clip.timelineStart,
        volume: effectiveVolume,
      });
    }
  }
  if (clips.length === 0) {
    setStatus("書き出すクリップがありません", true);
    return;
  }

  const fmt = el.formatSelect.value;

  // 対応ブラウザ(Chrome/Edgeなど)では、実際にミックスダウンする前に保存先を選んでもらう。
  // ここでキャンセルされた場合はサーバー側での処理自体を行わない。
  // 非対応ブラウザ(Firefox/Safariなど)では従来通りブラウザのダウンロード機能にお任せする。
  let saveHandle = null;
  if (window.showSaveFilePicker) {
    try {
      saveHandle = await window.showSaveFilePicker({
        suggestedName: `mix.${fmt}`,
        types: [
          {
            description: fmt === "mp3" ? "MP3音声" : "WAV音声",
            accept: { [fmt === "mp3" ? "audio/mpeg" : "audio/wav"]: [`.${fmt}`] },
          },
        ],
      });
    } catch (err) {
      if (err.name === "AbortError") {
        setStatus("書き出しをキャンセルしました");
      } else {
        setStatus(`保存先の選択に失敗しました: ${err}`, true);
      }
      return;
    }
  }

  setStatus("書き出し中...");
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clips, format: fmt }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(`エラー: ${data.error || "書き出しに失敗しました"}`, true);
      return;
    }

    // サーバー上の書き出し結果をこちらで完全に取得してから保存する。
    // (保存方法によらず、取得が終わった時点でサーバー側の一時ファイルを削除できるようにするため)
    const blob = await (await fetch(data.url)).blob();

    if (saveHandle) {
      const writable = await saveHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      setStatus("書き出し完了。指定した保存先に保存しました。");
    } else {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      setStatus("書き出し完了。ダウンロードを開始します。");
    }

    // ダウンロード(取得)が完了したので、サーバー上に溜まっていく書き出しファイルは削除しておく
    fetch(`/api/exports/${encodeURIComponent(data.filename)}`, { method: "DELETE" }).catch((err) => {
      console.warn("書き出しファイルのサーバー側削除に失敗しました", err);
    });
  } catch (err) {
    setStatus(`書き出しに失敗しました: ${err}`, true);
  }
});

// 初期描画
renderAll();