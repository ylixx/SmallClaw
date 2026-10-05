@echo off
title SmallClaw llama.cpp model backend (Qwen3.8-9B, full GPU, 64K ctx)
rem ============================================================
rem  One-click launcher for the llama.cpp model backend used by
rem  SmallClaw. Params match .smallclaw/config.json:
rem    llm.providers.llama_cpp.endpoint = http://localhost:8080
rem
rem  Usage: double-click, or run from a terminal:
rem    start-llama-cpp.bat
rem  Model load takes 30-60s. Ready when this window shows
rem  "server is listening" / port 8080 responds to /health.
rem
rem  Config rationale (tested 2026-10-05 on RTX 4060 8GB):
rem    -ngl 99        full GPU offload; 6.3GB VRAM, ~41 tok/s
rem    --ctx-size 65536  64K context, verified 100% retrieval accuracy
rem                  up to the full 64K window (33/33 trials)
rem    --cache-type-k/v q8_0  quantized KV cache to fit 64K on 8GB
rem    --reasoning off   REQUIRED: Qwen3 otherwise spends all tokens
rem                  on thinking and returns empty content
rem ============================================================

set MODEL=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M\Qwen3.8-9B-heretic-uncensored.Q4_K_M.gguf

if not exist "%MODEL%" (
  echo ERROR: model file not found: %MODEL%
  pause
  exit /b 1
)

llama-server -m "%MODEL%" --host 127.0.0.1 --port 8080 -ngl 99 --ctx-size 65536 --cache-type-k q8_0 --cache-type-v q8_0 --alias qwen3.8-9b --reasoning off

pause
