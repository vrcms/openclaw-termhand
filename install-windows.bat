@echo off
echo ================================================
echo   TermHand Bridge (终端手) - Windows 安装器
echo ================================================
echo.

REM 检查 Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo [错误] 未找到 Node.js！
  echo 请先安装 Node.js: https://nodejs.org/
  pause
  exit /b 1
)

echo [1/3] Node.js 已找到
node --version

REM 安装依赖
echo.
echo [2/3] 安装依赖 (ws)...
npm install ws --save-silent
if errorlevel 1 (
  echo [错误] npm install 失败
  pause
  exit /b 1
)

echo.
echo [3/3] 启动 TermHand Bridge...
echo.
echo ================================================
echo   连接中...
echo   VPS: 149.13.91.10:9877
echo ================================================
echo.

node bridge.js --server ws://149.13.91.10:9877/termhand-ws --token 3b5f7e6af054d030a28f7048304465eb0732902dc6314097ea97e6304da1c802

pause
