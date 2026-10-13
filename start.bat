@echo off
setlocal
title SmallClaw Gateway
cd /d "%~dp0"

rem ============ �ɵ����� ============
rem SMALLCLAW_PYTHON is not hard-coded. If already set in the environment and works, use it;
rem otherwise auto-detect a working Python 3 on this machine. The knowledge base relies on
rem knowledge_helper.py, so we smoke-test with "import zipfile" and skip broken interpreters.
set "MODEL_PORT=8080"
set "GATEWAY_PORT=18789"
rem ==================================

rem ---- Auto-detect Python (machine-agnostic; no need to edit this block) ----
if defined SMALLCLAW_PYTHON (
  "%SMALLCLAW_PYTHON%" -c "import zipfile" >nul 2>&1 && goto :py_ready
)
set "SMALLCLAW_PYTHON="
for %%e in (python python3) do (
  for /f "usebackq delims=" %%p in (`where %%e 2^>nul`) do (
    "%%p" -c "import zipfile" >nul 2>&1 && set "SMALLCLAW_PYTHON=%%p" && goto :py_ready
  )
)
for %%d in (
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
  "%ProgramFiles%\Python312\python.exe"
  "%ProgramFiles%\Python313\python.exe"
  "%ProgramFiles%\Python314\python.exe"
) do (
  if exist %%d ("%%~d" -c "import zipfile" >nul 2>&1 && set "SMALLCLAW_PYTHON=%%~d" && goto :py_ready)
)
:py_ready

echo ============================================
echo   SmallClaw ������������ģ������ start-model.bat��
echo ============================================

rem 1. ��� Python
if exist "%SMALLCLAW_PYTHON%" (
  echo [OK] Python: %SMALLCLAW_PYTHON%
) else (
  echo [����] δ�ҵ� Python: %SMALLCLAW_PYTHON%
  echo        ���޸ı��ļ������� SMALLCLAW_PYTHON ������
)

rem 2. ���ģ�Ͷ˿ڣ�ֻ��ʾ��������ģ�ͣ�
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$c=New-Object Net.Sockets.TcpClient; try{$c.Connect('127.0.0.1',%MODEL_PORT%);'UP'}catch{'DOWN'};$c.Close()"`) do set "MODEL_STATUS=%%i"
if /i "%MODEL_STATUS%"=="UP" (
  echo [OK] ģ�����ߣ��˿� %MODEL_PORT%��
) else (
  echo [����] ģ�Ͷ˿� %MODEL_PORT% δ��Ӧ��
  echo        �������� start-model.bat ����ģ�ͣ����л�Ԥ�裩��
  echo        10 ����Խ��������أ��س����� / Ctrl+C ȡ����
  timeout /t 10 /nobreak >nul
)

rem 3. ����ռ�����ض˿ڵľɽ���
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %GATEWAY_PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"`) do (
  echo [OK] ��ֹͣ�����ؽ��� PID=%%p
  taskkill /F /PID %%p >nul 2>&1
)

rem 4. ��������
echo [OK] �������� http://127.0.0.1:%GATEWAY_PORT%
echo ------------------------------------------------------------
node --import tsx src/gateway/server-v2.ts

echo.
echo [��Ϣ] �������˳���
pause
endlocal