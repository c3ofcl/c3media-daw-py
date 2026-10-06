"""
マルチトラック音声エディタ - Flaskバックエンド

機能:
  - 複数音声ファイルのアップロード（トラック化）
  - タイムライン情報(開始位置・トリム範囲)に基づくミックスダウン書き出し
    (トリミング / カット / 結合はフロントエンド側で非破壊的に管理し、
     書き出し時にpydubで実際の音声処理を行う)
  - 共同編集(オンライン編集): Flask-SocketIOでリアルタイムに画面を同期しつつ、
    「編集権」を持つ1人だけがタイムラインを編集できるトークンパッシング方式
    (詳細は下の「共同編集: ルーム状態」セクションを参照)

事前準備:
  pip install -r requirements.txt
  ffmpeg がシステムにインストールされている必要があります
    - macOS: brew install ffmpeg
    - Ubuntu/Debian: sudo apt install ffmpeg
    - Windows: https://ffmpeg.org/download.html からダウンロードしPATHに追加

起動:
  python app.py
  ブラウザで http://127.0.0.1:5000 を開く（同じネットワーク内の他の人は
  http://<このPCのIPアドレス>:5000 でアクセスすると同じルームに参加できます）
"""

import os
import math
import random
import shutil
import struct
import threading
import uuid
import wave

from flask import Flask, request, jsonify, send_from_directory, render_template
from flask_socketio import SocketIO
from pydub import AudioSegment

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
DEMO_DIR = os.path.join(BASE_DIR, "demo")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)
os.makedirs(DEMO_DIR, exist_ok=True)

ALLOWED_EXT = {"mp3", "wav", "ogg", "m4a", "flac", "aac", "wma"}
MAX_CONTENT_LENGTH = 300 * 1024 * 1024  # 300MB

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", uuid.uuid4().hex)
socketio = SocketIO(app, cors_allowed_origins="*")


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


# ================= デモ音源 =================
# 「とりあえず試しに使ってみたい」場合のために、著作権を気にせず使える短いデモ音源を
# 用意しておく。外部の音声素材を使わず、サイン波やノイズからその場で合成するので、
# インターネット接続やffmpeg無しでも(wave/struct/mathなど標準ライブラリのみで)生成できる。
# 一度生成したファイルはdemo/ディレクトリに保存され、次回起動時は再利用される。

SAMPLE_RATE = 44100


def _write_wav(path, samples, sample_rate=SAMPLE_RATE):
    """-1.0〜1.0のfloatサンプル列を16bit PCM モノラルWAVとして書き出す"""
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        clipped = (max(-1.0, min(1.0, s)) for s in samples)
        frames = b"".join(struct.pack("<h", int(s * 32767)) for s in clipped)
        wf.writeframes(frames)


def _wav_duration_sec(path):
    with wave.open(path, "r") as wf:
        return wf.getnframes() / float(wf.getframerate())


def _sine(freq, duration, sample_rate=SAMPLE_RATE, amp=0.5):
    n = int(duration * sample_rate)
    return [amp * math.sin(2 * math.pi * freq * i / sample_rate) for i in range(n)]


def _silence(duration, sample_rate=SAMPLE_RATE):
    return [0.0] * int(duration * sample_rate)


def _envelope(samples, attack=0.01, release=0.05, sample_rate=SAMPLE_RATE):
    """単純なフェードイン/フェードアウトをかけて、音の出始め/終わりのプチノイズを防ぐ"""
    n = len(samples)
    a = int(attack * sample_rate)
    r = int(release * sample_rate)
    out = list(samples)
    for i in range(min(a, n)):
        out[i] *= i / max(1, a)
    for i in range(min(r, n)):
        out[n - 1 - i] *= i / max(1, r)
    return out


def _mix(*tracks):
    length = max((len(t) for t in tracks), default=0)
    out = [0.0] * length
    for t in tracks:
        for i, v in enumerate(t):
            out[i] += v
    peak = max([abs(v) for v in out], default=1.0) or 1.0
    if peak > 1.0:
        out = [v / peak for v in out]
    return out


def _kick(sample_rate=SAMPLE_RATE):
    """低音が急速に減衰するサイン波による簡易キックドラム"""
    dur = 0.18
    n = int(dur * sample_rate)
    samples = []
    for i in range(n):
        t = i / sample_rate
        freq = 150 * math.exp(-t * 18) + 40
        amp = math.exp(-t * 14)
        samples.append(0.9 * amp * math.sin(2 * math.pi * freq * t))
    return samples


def _hihat(sample_rate=SAMPLE_RATE):
    """短いノイズバーストによる簡易ハイハット"""
    dur = 0.05
    n = int(dur * sample_rate)
    samples = [0.5 * (random.random() * 2 - 1) for _ in range(n)]
    return _envelope(samples, attack=0.001, release=dur * 0.8, sample_rate=sample_rate)


def generate_demo_beat(path, bpm=100, bars=4):
    """シンプルなキック+ハイハットのドラムパターンを合成する"""
    step = (60.0 / bpm) / 2  # 8分音符刻み
    total_steps = bars * 8
    kick_pattern = ([1, 0, 0, 0, 1, 0, 0, 0] * bars)[:total_steps]
    hat_pattern = [1] * total_steps
    timeline = _silence(total_steps * step + 0.3)
    for i in range(total_steps):
        start = int(i * step * SAMPLE_RATE)
        if kick_pattern[i]:
            for j, v in enumerate(_kick()):
                if start + j < len(timeline):
                    timeline[start + j] += v
        if hat_pattern[i]:
            for j, v in enumerate(_hihat()):
                if start + j < len(timeline):
                    timeline[start + j] += v * 0.5
    peak = max([abs(v) for v in timeline], default=1.0) or 1.0
    timeline = [v / peak * 0.9 for v in timeline]
    _write_wav(path, timeline)


def generate_demo_bass(path, bpm=100):
    """シンプルな4拍のベースライン(サイン波)"""
    notes_hz = [55.00, 55.00, 65.41, 73.42, 55.00, 49.00, 55.00, 65.41]  # A1近辺
    note_dur = 60.0 / bpm
    samples = []
    for freq in notes_hz:
        s = _sine(freq, note_dur, amp=0.55)
        samples.extend(_envelope(s, attack=0.01, release=note_dur * 0.3))
    _write_wav(path, samples)


def generate_demo_melody(path, bpm=100):
    """Cメジャースケールを使った簡単なメロディ"""
    scale_hz = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25]
    sequence = [0, 2, 4, 5, 7, 5, 4, 2, 0, 4, 7, 4, 2, 0]
    beat_sec = 60.0 / bpm
    note_dur = beat_sec * 0.85
    gap = beat_sec * 0.15
    samples = []
    for idx in sequence:
        s = _sine(scale_hz[idx], note_dur, amp=0.45)
        samples.extend(_envelope(s, attack=0.01, release=note_dur * 0.3))
        samples.extend(_silence(gap))
    _write_wav(path, samples)


def generate_demo_pad(path, duration=6.0):
    """持続するコード(パッド)音。Cメジャートライアドを3つのサイン波で重ねる"""
    chord_hz = [130.81, 164.81, 196.00]  # C3, E3, G3
    tracks = [_sine(f, duration, amp=0.28) for f in chord_hz]
    mixed = _mix(*tracks)
    mixed = _envelope(mixed, attack=1.2, release=1.8)
    _write_wav(path, mixed)


DEMO_TRACK_DEFS = [
    {"id": "demo_beat", "name": "デモ: ドラムビート", "filename": "demo_beat.wav", "generate": generate_demo_beat},
    {"id": "demo_bass", "name": "デモ: ベースライン", "filename": "demo_bass.wav", "generate": generate_demo_bass},
    {"id": "demo_melody", "name": "デモ: メロディ", "filename": "demo_melody.wav", "generate": generate_demo_melody},
    {"id": "demo_pad", "name": "デモ: パッド(コード)", "filename": "demo_pad.wav", "generate": generate_demo_pad},
]


def ensure_demo_tracks():
    """デモ音源のWAVファイルが無ければ合成して用意し、各トラックの長さを控えておく"""
    for d in DEMO_TRACK_DEFS:
        path = os.path.join(DEMO_DIR, d["filename"])
        if not os.path.exists(path):
            d["generate"](path)
        d["duration"] = _wav_duration_sec(path)


ensure_demo_tracks()


# ================= 共同編集: ルーム状態 =================
# このアプリは「単一プロジェクトを、その場にいる数人で共同編集する」という
# シンプルな用途を想定しており、ルームは常に1つだけ(プロセス内メモリ上で管理)。
#
# 役割:
#   host   : 最初に参加した人。編集権リクエストの承認/却下、強制的な編集権の
#            取り戻しができる。
#   editor : 現在「編集権(トークン)」を持っている、ただ1人のユーザー。
#            タイムラインを書き換えられるのはこの人だけ。
#   viewer : それ以外の全員。画面はリアルタイムに見えるが編集はできず、
#            「編集権をリクエスト」できるのみ。
#
# クライアントはページ読み込み時にランダムなユーザートークンを生成して
# localStorageに保持し、Socket.IO接続時に名前と一緒に送ってくる。
# サーバー側はこのトークンで各ユーザーを識別する(ログイン機能は持たない)。
room_lock = threading.Lock()
room = {
    "host_token": None,
    "editor_token": None,
    "users": {},   # token -> {"name": str, "sid": str}
    "pending": [], # 編集権をリクエスト中のtoken一覧(順番=リクエスト順)
    "project": {"tracks": []},  # 共有されるプロジェクトの状態(トラック/クリップ配置)
}


def is_current_editor(token):
    """指定トークンが現在の編集者かどうか(REST APIの権限チェック用)"""
    with room_lock:
        return bool(token) and token == room["editor_token"]


def public_room_state():
    """クライアントに送るルーム状態。内部のsidなどは含めない。"""
    return {
        "hostToken": room["host_token"],
        "editorToken": room["editor_token"],
        "users": [
            {"token": t, "name": u["name"]} for t, u in room["users"].items()
        ],
        "pending": [
            {"token": t, "name": room["users"][t]["name"]}
            for t in room["pending"]
            if t in room["users"]
        ],
    }


def broadcast_room_state():
    socketio.emit("room_state", public_room_state())


def broadcast_project_state():
    socketio.emit("project_state", room["project"])


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/upload", methods=["POST"])
def upload():
    if not is_current_editor(request.headers.get("X-User-Token")):
        return jsonify({"error": "編集権がありません"}), 403

    if "file" not in request.files:
        return jsonify({"error": "ファイルがありません"}), 400

    f = request.files["file"]
    if f.filename == "" or not allowed_file(f.filename):
        return jsonify({"error": "対応していないファイル形式です"}), 400

    ext = f.filename.rsplit(".", 1)[1].lower()
    file_id = uuid.uuid4().hex
    saved_name = f"{file_id}.{ext}"
    path = os.path.join(UPLOAD_DIR, saved_name)
    f.save(path)

    try:
        audio = AudioSegment.from_file(path)
    except Exception as e:  # noqa: BLE001
        os.remove(path)
        return jsonify({"error": f"音声を読み込めませんでした: {e}"}), 400

    duration = len(audio) / 1000.0  # 秒

    return jsonify(
        {
            "id": file_id,
            "ext": ext,
            "filename": f.filename,
            "url": f"/uploads/{saved_name}",
            "duration": duration,
        }
    )


@app.route("/api/demo-tracks", methods=["GET"])
def list_demo_tracks():
    """利用可能なデモ音源の一覧(名前と長さ)を返す。誰でも閲覧できる(編集権は不要)。"""
    return jsonify(
        [{"id": d["id"], "name": d["name"], "duration": d["duration"]} for d in DEMO_TRACK_DEFS]
    )


@app.route("/api/demo-tracks/<demo_id>/add", methods=["POST"])
def add_demo_track(demo_id):
    """選んだデモ音源をuploads/へコピーし、通常のアップロードと同じ形式で返す。
    (以降の扱い―削除・書き出し・共同編集での同期―を、ユーザーがアップロードした
     ファイルと完全に同じコードパスに乗せるため)"""
    if not is_current_editor(request.headers.get("X-User-Token")):
        return jsonify({"error": "編集権がありません"}), 403

    demo = next((d for d in DEMO_TRACK_DEFS if d["id"] == demo_id), None)
    if demo is None:
        return jsonify({"error": "指定されたデモ音源が見つかりません"}), 404

    src_path = os.path.join(DEMO_DIR, demo["filename"])
    if not os.path.exists(src_path):
        return jsonify({"error": "デモ音源ファイルがサーバーに見つかりません"}), 404

    file_id = uuid.uuid4().hex
    saved_name = f"{file_id}.wav"
    dst_path = os.path.join(UPLOAD_DIR, saved_name)
    shutil.copyfile(src_path, dst_path)

    return jsonify(
        {
            "id": file_id,
            "ext": "wav",
            "filename": demo["name"],
            "url": f"/uploads/{saved_name}",
            "duration": demo["duration"],
        }
    )


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/exports/<path:filename>")
def serve_export(filename):
    return send_from_directory(EXPORT_DIR, filename, as_attachment=True)


@app.route("/api/exports/<filename>", methods=["DELETE"])
def delete_export(filename):
    for name in os.listdir(EXPORT_DIR):
        if name == filename:
            os.remove(os.path.join(EXPORT_DIR, name))
            return jsonify({"ok": True})
    return jsonify({"error": "ファイルが見つかりません"}), 404


@app.route("/api/uploads/<file_id>", methods=["DELETE"])
def delete_upload(file_id):
    if not is_current_editor(request.headers.get("X-User-Token")):
        return jsonify({"error": "編集権がありません"}), 403

    deleted = False
    for name in os.listdir(UPLOAD_DIR):
        if name.rsplit(".", 1)[0] == file_id:
            os.remove(os.path.join(UPLOAD_DIR, name))
            deleted = True
            break
    if not deleted:
        return jsonify({"error": "ファイルが見つかりません"}), 404
    return jsonify({"ok": True})


@app.route("/api/uploads", methods=["DELETE"])
def delete_all_uploads():
    if not is_current_editor(request.headers.get("X-User-Token")):
        return jsonify({"error": "編集権がありません"}), 403

    count = 0
    for name in os.listdir(UPLOAD_DIR):
        path = os.path.join(UPLOAD_DIR, name)
        if os.path.isfile(path):
            os.remove(path)
            count += 1
    return jsonify({"ok": True, "deleted": count})


@app.route("/api/export", methods=["POST"])
def export():
    """
    リクエストJSON形式:
    {
      "format": "wav" | "mp3",
      "clips": [
        {
          "fileId": "...",
          "ext": "mp3",
          "trimStart": 0.0,      # 元ファイル内での開始秒
          "trimEnd": 5.2,        # 元ファイル内での終了秒
          "timelineStart": 3.0,  # タイムライン上での開始秒
          "volume": 1.0          # トラック音量(倍率。1.0=等倍、任意項目、省略時は1.0)
        },
        ...
      ]
    }
    """
    data = request.get_json(force=True, silent=True) or {}
    clips = data.get("clips", [])
    fmt = data.get("format", "wav")
    if fmt not in {"wav", "mp3"}:
        fmt = "wav"

    if not clips:
        return jsonify({"error": "クリップがありません"}), 400

    loaded = []  # [(timeline_start_ms, clip_audio), ...] トリム済み・サンプリングレート未統一のクリップ

    for c in clips:
        file_id = c.get("fileId")
        ext = c.get("ext")
        path = os.path.join(UPLOAD_DIR, f"{file_id}.{ext}")
        if not file_id or not ext or not os.path.exists(path):
            return jsonify({"error": f"ファイルが見つかりません: {file_id}"}), 400

        audio = AudioSegment.from_file(path)
        src_len_ms = len(audio)

        trim_start_ms = max(0, int(float(c.get("trimStart", 0)) * 1000))
        trim_end_ms = int(float(c.get("trimEnd", src_len_ms / 1000)) * 1000)
        trim_end_ms = min(trim_end_ms, src_len_ms)
        if trim_end_ms <= trim_start_ms:
            continue  # 空クリップはスキップ

        clip_audio = audio[trim_start_ms:trim_end_ms]

        # トラックの音量フェーダー(倍率。1.0=等倍, 0=無音)をdBゲインに変換して適用する
        volume = c.get("volume", 1)
        volume = float(volume) if volume is not None else 1.0
        if volume <= 0.0001:
            clip_audio = clip_audio.apply_gain(-120)  # 実質的に無音にする
        elif abs(volume - 1.0) > 1e-6:
            clip_audio = clip_audio.apply_gain(20 * math.log10(volume))

        timeline_start_ms = max(0, int(float(c.get("timelineStart", 0)) * 1000))
        loaded.append((timeline_start_ms, clip_audio))

    if not loaded:
        return jsonify({"error": "有効なクリップがありません"}), 400

    # ---- サンプリングレートの統一 ----
    # 各クリップの元ファイルはサンプリングレートがバラバラな場合がある。統一しないまま
    # overlay()を繰り返すと、pydubが重ね合わせのたびに暗黙的・段階的にリサンプリングし、
    # クリップの並び順次第で音質が変わってしまう。ここで明示的に単一のターゲットレート
    # （今回のクリップ群のうち最大の値）へ揃えてからミックスすることで、不要なダウン
    # サンプリングを避けつつ一貫した音質にする。
    target_frame_rate = max(clip_audio.frame_rate for _, clip_audio in loaded)
    segments = [
        (start_ms, clip_audio.set_frame_rate(target_frame_rate))
        for start_ms, clip_audio in loaded
    ]
    total_end_ms = max(start_ms + len(clip_audio) for start_ms, clip_audio in segments)

    mix = AudioSegment.silent(duration=total_end_ms, frame_rate=target_frame_rate)
    for start_ms, clip_audio in segments:
        mix = mix.overlay(clip_audio, position=start_ms)

    out_name = f"mix_{uuid.uuid4().hex}.{fmt}"
    out_path = os.path.join(EXPORT_DIR, out_name)
    mix.export(out_path, format=fmt)

    return jsonify({"url": f"/exports/{out_name}", "filename": out_name})


# ================= 共同編集: Socket.IOイベント =================

@socketio.on("join")
def handle_join(data):
    """名前を入力してルームに参加する。最初の参加者が自動的にホスト兼編集者になる。"""
    token = (data or {}).get("token")
    name = ((data or {}).get("name") or "").strip()[:40] or "名無しさん"
    if not token:
        return

    with room_lock:
        room["users"][token] = {"name": name, "sid": request.sid}
        if room["host_token"] is None:
            room["host_token"] = token
            room["editor_token"] = token
        project_snapshot = room["project"]

    socketio.emit("project_state", project_snapshot, to=request.sid)
    broadcast_room_state()


@socketio.on("disconnect")
def handle_disconnect():
    with room_lock:
        token = None
        for t, u in list(room["users"].items()):
            if u["sid"] == request.sid:
                token = t
                break
        if token is None:
            return

        del room["users"][token]
        if token in room["pending"]:
            room["pending"].remove(token)

        if room["editor_token"] == token:
            # 編集者が抜けたら、いったんホストに編集権を戻す
            room["editor_token"] = room["host_token"]

        if room["host_token"] == token:
            # ホストが抜けたら、残っている中で最も古い参加者を新ホストにする
            remaining = list(room["users"].keys())
            room["host_token"] = remaining[0] if remaining else None
            room["editor_token"] = room["host_token"]

    broadcast_room_state()


@socketio.on("request_edit")
def handle_request_edit(data):
    """閲覧者が編集権をリクエストする"""
    token = (data or {}).get("token")
    with room_lock:
        if not token or token not in room["users"]:
            return
        if token == room["editor_token"]:
            return
        if token not in room["pending"]:
            room["pending"].append(token)
    broadcast_room_state()


@socketio.on("cancel_request")
def handle_cancel_request(data):
    """リクエストを取り下げる"""
    token = (data or {}).get("token")
    with room_lock:
        if token in room["pending"]:
            room["pending"].remove(token)
    broadcast_room_state()


@socketio.on("approve_edit")
def handle_approve_edit(data):
    """ホストがリクエストを承認し、編集権を渡す"""
    requester_token = (data or {}).get("token")
    approver_token = (data or {}).get("byToken")
    with room_lock:
        if not approver_token or approver_token != room["host_token"]:
            return
        if requester_token not in room["users"]:
            return
        room["editor_token"] = requester_token
        if requester_token in room["pending"]:
            room["pending"].remove(requester_token)
    broadcast_room_state()


@socketio.on("reject_edit")
def handle_reject_edit(data):
    """ホストがリクエストを却下する"""
    requester_token = (data or {}).get("token")
    approver_token = (data or {}).get("byToken")
    with room_lock:
        if not approver_token or approver_token != room["host_token"]:
            return
        if requester_token in room["pending"]:
            room["pending"].remove(requester_token)
    broadcast_room_state()


@socketio.on("reclaim_edit")
def handle_reclaim_edit(data):
    """ホストが編集権を強制的に取り戻す"""
    token = (data or {}).get("token")
    with room_lock:
        if not token or token != room["host_token"]:
            return
        room["editor_token"] = token
    broadcast_room_state()


@socketio.on("project_sync")
def handle_project_sync(data):
    """編集者の操作結果(トラック/クリップの配置)をサーバーへ反映し、全員に配信する"""
    token = (data or {}).get("token")
    tracks = (data or {}).get("tracks")
    with room_lock:
        if not token or token != room["editor_token"]:
            return  # 編集者以外からの変更は無視する
        if not isinstance(tracks, list):
            return
        room["project"] = {"tracks": tracks}

    broadcast_project_state()


if __name__ == "__main__":
    # host="0.0.0.0" にすることで、同じネットワーク内の他のPC/スマホからも
    # 「http://<このPCのIPアドレス>:5000」でアクセスできるようになる。
    # (127.0.0.1のままだと自分のPCからしか繋がらない)
    socketio.run(app, debug=True, host="0.0.0.0", port=5000, allow_unsafe_werkzeug=True)