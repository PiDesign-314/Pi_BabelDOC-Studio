@echo off
setlocal
cd /d "%~dp0"

where pythonw.exe >nul 2>nul
if errorlevel 1 (
  echo [BabelDOC Studio] 没有找到 pythonw.exe，请先安装 Python 3.10 以上版本。
  pause
  exit /b 1
)

start "" pythonw.exe "%~dp0app.py"
exit /b 0
