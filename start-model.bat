@echo off
title SmallClaw - 模型服务 (llama.cpp :8080)
echo ==================================================
echo   SmallClaw 模型服务  llama.cpp
echo   切换模型请修改下方 MODEL_DIR 后保存
echo   若模型无视觉投影，请删除 mmproj 参数
echo ==================================================
echo.

set "MODEL_DIR=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M"
set "MODEL_FILE=%MODEL_DIR%\Qwen3.8-9B-heretic-uncensored.Q4_K_M.gguf"
set "MMPROJ=%MODEL_DIR%\mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf"
set "PORT=8080"

rem 启动前清理：若模型端口已被占用，先结束占用进程再启动（避免端口冲突）
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
  echo [*] 端口 %PORT% 被 PID=%%p 占用，正在结束该进程...
  taskkill /F /PID %%p >nul 2>&1
  if not errorlevel 1 ( echo [OK] 已结束 PID=%%p ) else ( echo [!] 无法结束 PID=%%p，请手动关闭 )
)
timeout /t 2 /nobreak >nul 2>&1

echo 正在加载模型: %MODEL_FILE%
echo 上下文 65536 / GPU 99 层 / Flash Attn / KV q4_0
echo 日志实时显示在此窗口，按 Ctrl+C 停止
echo --------------------------------------------------
"E:\llama-b11000\llama-server.exe" --model "%MODEL_FILE%" --host 127.0.0.1 --port %PORT% --ctx-size 65536 --n-predict 16384 --gpu-layers 99 --threads 8 --flash-attn on --cache-type-k q4_0 --cache-type-v q4_0 --batch-size 512 --ubatch-size 256 --jinja --alias "Qwen3.8-9B-heretic-uncensored.Q4_K_M" --parallel 1 --temp 0.6 --reasoning off --mmproj "%MMPROJ%"

echo.
echo [模型服务已停止]
pause
