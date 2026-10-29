@echo off
chcp 65001 > nul
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo 仮想環境 .venv が見つかりません。README のセットアップ手順で作成してください。
    pause
    exit /b 1
)

start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
pause
