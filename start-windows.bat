@echo off
chcp 65001 > nul
cd /d "%~dp0"
where py > nul 2>&1 && (py -3 serve.py & goto :end)
where python > nul 2>&1 && (python serve.py & goto :end)
echo Python が見つかりませんでした。
echo   - python.org から Python を入れてから、もう一度このファイルをダブルクリックしてください
echo   - またはサーバーなしで standalone\code-reader.html をダブルクリックして開くこともできます
pause
:end
