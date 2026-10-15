@echo off
title SmallClaw - 平台网关 (http://127.0.0.1:18789)
echo ==================================================
echo   SmallClaw 平台网关
echo   页面:  http://127.0.0.1:18789
echo   模型:  请先运行 start-model.bat
echo ==================================================
echo.

set "GATEWAY_PORT=18789"

rem 启动前清理：若网关端口已被占用，先结束占用进程再启动（避免端口冲突）
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %GATEWAY_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
  echo [*] 端口 %GATEWAY_PORT% 被 PID=%%p 占用，正在结束该进程...
  taskkill /F /PID %%p >nul 2>&1
  if not errorlevel 1 ( echo [OK] 已结束 PID=%%p ) else ( echo [!] 无法结束 PID=%%p，请手动关闭 )
)
timeout /t 2 /nobreak >nul 2>&1

cd /d "%~dp0"
echo 启动平台网关，日志实时显示，按 Ctrl+C 停止...
echo --------------------------------------------------
node --import tsx src/gateway/server-v2.ts

echo.
echo [平台已停止]
pause
