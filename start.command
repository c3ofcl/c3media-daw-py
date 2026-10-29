#!/bin/bash
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
    echo "仮想環境 .venv が見つかりません。README のセットアップ手順で作成してください。"
    read -n 1 -s -r -p "何かキーを押すと終了します..."
    exit 1
fi

open http://127.0.0.1:5000
.venv/bin/python app.py
