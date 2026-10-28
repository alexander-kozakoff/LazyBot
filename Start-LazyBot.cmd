@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "LAZYBOT_NODE=node.exe"
if exist "%~dp0.runtime\node.exe" set "LAZYBOT_NODE=%~dp0.runtime\node.exe"
"%LAZYBOT_NODE%" -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 24 || (major === 24 && minor < 17)) process.exit(1)"
if errorlevel 1 (
  echo Нужен Node.js 24.17 или новее. Откройте README.md для инструкции.
  pause
  exit /b 1
)
if not exist node_modules\discord.js\package.json (
  echo Сначала установите зависимости по инструкции README.md.
  pause
  exit /b 1
)
"%LAZYBOT_NODE%" scripts\setup.js
if errorlevel 1 goto finish
"%LAZYBOT_NODE%" src\index.js
:finish
pause
