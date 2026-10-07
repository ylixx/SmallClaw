@echo off
title SmallClaw - start backend for active preset
rem ============================================================
rem  One-click launcher for the SmallClaw local model backend.
rem  Follows the ACTIVE preset in .smallclaw/config.json:
rem    - llama_cpp preset  -> starts llama-server with that model
rem    - cloud/other       -> tells you no local backend is needed
rem  If 127.0.0.1:8080 already runs the same model, it says so
rem  and exits. If a different model is running, it asks before
rem  restarting.
rem  (Legacy hard-coded Qwen launcher replaced 2026-10-07.)
rem ============================================================

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"

"%NODE%" "%~dp0scripts\start-backend.js"

pause
