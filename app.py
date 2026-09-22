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
import threading
import uuid

from flask import Flask, request, jsonify, send_from_directory, render_template
from flask_socketio import SocketIO
from pydub import AudioSegment

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "exports")
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

ALLOWED_EXT = {"mp3", "wav", "ogg", "m4a", "flac", "aac", "wma"}
MAX_CONTENT_LENGTH = 300 * 1024 * 1024  # 300MB

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_CONTENT_LENGTH
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", uuid.uuid4().hex)
socketio = SocketIO(app, cors_allowed_origins="*")


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXT


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