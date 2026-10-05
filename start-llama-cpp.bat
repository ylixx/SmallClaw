@echo off
title SmallClaw llama.cpp model backend (Qwen3.8-9B + vision, full GPU, 48K ctx)
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
rem    -ngl 99        full GPU offload; weights ~5.2GB + vision ~0.9GB
rem    --mmproj ...   multimodal projector: image recognition via the
rem                  /v1/chat/completions image_url part
rem    --ctx-size 49152  48K context; 64K also verified fine (33/33
rem                  retrieval trials), dropped to 48K to leave more
rem                  VRAM headroom for the vision encoder
rem    --cache-type-k/v q8_0  quantized KV cache to fit on 8GB
rem    --reasoning off   REQUIRED: Qwen3 otherwise spends all tokens
rem                  on thinking and returns empty content
rem ============================================================

set MODEL=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M\Qwen3.8-9B-heretic-uncensored.Q4_K_M.gguf
set MMPROJ=D:\models\Qwen3.8-9B-heretic-uncensored.Q4_K_M\mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf

if not exist "%MODEL%" (
  echo ERROR: model file not found: %MODEL%
  pause
  exit /b 1
)
if not exist "%MMPROJ%" (
  echo WARNING: mmproj file not found, continuing WITHOUT image support: %MMPROJ%
)

llama-server -m "%MODEL%" --mmproj "%MMPROJ%" --host 127.0.0.1 --port 8080 -ngl 99 --ctx-size 49152 --cache-type-k q8_0 --cache-type-v q8_0 --alias qwen3.8-9b --reasoning off

pause
