@echo off
setlocal
title SmallClaw Gateway
cd /d "%~dp0"

rem ============ 可调参数 ============
set "SMALLCLAW_PYTHON=C:\Users\LiJiaLu\AppData\Local\Programs\Python\Python314\python.exe"
set "MODEL_PORT=8080"
set "GATEWAY_PORT=18789"
rem ==================================

echo ============================================
echo   SmallClaw 网关启动器（模型请用 start-model.bat）
echo ============================================

rem 1. 检查 Python
if exist "%SMALLCLAW_PYTHON%" (
  echo [OK] Python: %SMALLCLAW_PYTHON%
) else (
  echo [警告] 未找到 Python: %SMALLCLAW_PYTHON%
  echo        请修改本文件顶部的 SMALLCLAW_PYTHON 后重试
)

rem 2. 检查模型端口（只提示，不启动模型）
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%MODEL_PORT%);'UP'}catch{'DOWN'};$c.Close()"`) do set "MODEL_STATUS=%%i"
if /i "%MODEL_STATUS%"=="UP" (
  echo [OK] 模型在线（端口 %MODEL_PORT%）
) else (
  echo [警告] 模型端口 %MODEL_PORT% 未响应！
  echo        请先运行 start-model.bat 启动模型（可切换预设）。
  echo        10 秒后仍将启动网关（回车继续 / Ctrl+C 取消）
  timeout /t 10 /nobreak >nul
)

rem 3. 清理占用网关端口的旧进程
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %GATEWAY_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
  echo [OK] 已停止旧网关进程 PID=%%p
  taskkill /F /PID %%p >nul 2>&1
)

rem 4. 启动网关
echo [OK] 启动网关 http://127.0.0.1:%GATEWAY_PORT%
echo ------------------------------------------------------------
node --import tsx src/gateway/server-v2.ts

echo.
echo [信息] 网关已退出。
pause
endlocal