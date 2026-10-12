@echo off
setlocal EnableExtensions
title SmallClaw Model Launcher
cd /d "%~dp0"

rem ============ 基础配置 ============
set "LLAMA_DIR=E:\llama-b11000"
set "PORT=8080"
rem ==================================

rem ---- 预设 1：Qwen3.8-9B 视觉版 ----
set "P1_ID=qwen9b"
set "P1_NAME=Qwen3.8-9B 视觉版"
set "P1_MODEL=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M\Qwen3.8-9B-heretic-uncensored.Q4_K_M.gguf"
set "P1_CTX=65536"
set "P1_ALIAS=Qwen3.8-9B-heretic-uncensored.Q4_K_M"
rem 需要图片理解能力时，取消下面一行的注释（注意显存占用会增加）：
set "P1_MMPROJ=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M\mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf"

rem ---- 预设 2：MiniCPM5-2B ----
set "P2_ID=minicpm5"
set "P2_NAME=MiniCPM5-2B"
set "P2_MODEL=D:\models\MiniCPM5-2B-Q4_K_M\MiniCPM5-2B-Q4_K_M.gguf"
set "P2_CTX=128000"
set "P2_ALIAS=D:/models/MiniCPM5-2B-Q4_K_M/MiniCPM5-2B-Q4_K_M.gguf"

rem ---- 新增模型：照上面复制一组 P3_xx 即可 ----

rem ============ 选择预设 ============
set "PRESET=%~1"
if "%PRESET%"=="" (
  echo.
  echo 可用模型预设：
  echo   1^) %P1_NAME%
  echo   2^) %P2_NAME%
  echo.
  set /p "CHOICE=请输入编号 ^(1-2^)："
  if "%CHOICE%"=="1" set "PRESET=%P1_ID%"
  if "%CHOICE%"=="2" set "PRESET=%P2_ID%"
  if "%PRESET%"=="" (
    echo [错误] 无效选择。
    pause
    exit /b 1
  )
)

set "MODEL="
set "CTX="
set "ALIAS="
set "MMPROJ="
set "MMPROJ_ARG="

if "%PRESET%"=="%P1_ID%" (
  set "MODEL=%P1_MODEL%"
  set "CTX=%P1_CTX%"
  set "ALIAS=%P1_ALIAS%"
  if defined P1_MMPROJ set "MMPROJ=%P1_MMPROJ%"
) else if "%PRESET%"=="%P2_ID%" (
  set "MODEL=%P2_MODEL%"
  set "CTX=%P2_CTX%"
  set "ALIAS=%P2_ALIAS%"
) else (
  echo [错误] 未知预设：%PRESET%
  echo 可用预设：%P1_ID% / %P2_ID%
  pause
  exit /b 1
)

if defined MMPROJ set "MMPROJ_ARG=--mmproj "%MMPROJ%""

if not exist "%MODEL%" (
  echo [错误] 模型文件不存在：%MODEL%
  pause
  exit /b 1
)

echo.
echo [模型] %MODEL%
echo [上下文] %CTX%
echo [别名] %ALIAS%
if defined MMPROJ echo [视觉] %MMPROJ%

rem ============ 端口占用处理（切换需先终止旧实例） ============
set "OLD_PID="
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do set "OLD_PID=%%p"
if defined OLD_PID (
  echo.
  echo [提示] 端口 %PORT% 已有模型在运行 ^(PID=%OLD_PID%^)。
  set /p "KILL=切换模型需终止它，是否继续？(Y/N)："
  if /i not "%KILL%"=="Y" (
    echo 已取消。
    pause
    exit /b 0
  )
  taskkill /F /PID %OLD_PID% /T >nul 2>&1
  echo 已终止旧实例。
  timeout /t 2 /nobreak >nul
)

rem ============ 启动 llama-server ============
echo.
echo [启动] llama-server http://127.0.0.1:%PORT%
pushd "%LLAMA_DIR%"
"%LLAMA_DIR%\llama-server.exe" ^
  --model "%MODEL%" ^
  --host 127.0.0.1 ^
  --port %PORT% ^
  --ctx-size %CTX% ^
  --n-predict 16384 ^
  --gpu-layers 99 ^
  --threads 8 ^
  --flash-attn on ^
  --cache-type-k q4_0 ^
  --cache-type-v q4_0 ^
  --batch-size 512 ^
  --ubatch-size 256 ^
  --jinja ^
  --alias "%ALIAS%" ^
  --parallel 1 ^
  --temp 0.6 ^
  --reasoning off ^
  %MMPROJ_ARG%
set "EXIT_CODE=%ERRORLEVEL%"
popd
echo.
echo llama-server exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%