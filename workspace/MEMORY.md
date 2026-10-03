# MEMORY.md — Long-Term Memory

## Architecture Decisions
- v2 uses native Ollama tool calling (not text-based node_call<> parsing)
- Line-based editing tools prevent the model from nuking entire files
- Qwen3:4b works well with structured tool calling
- Model dumps reasoning inline with think=false — server strips it before showing to user
- System prompt must be forceful about surgical edits
- Workspace personality files (SOUL, IDENTITY, USER, MEMORY) load into system prompt each session

## Task Runner System (NEW)
- Sliding context window: goal + compressed journal + current state per step
- Journal keeps last 8 entries in full, summarizes older ones
- Each step: model picks ONE action from available tools
- Max 25 steps per task (configurable)
- Works by re-prompting with fresh compact context each step
- This is how multi-step browser automation will work (Moltbook goal)

## Lessons Learned
- 4B models can't plan AND code in one shot — they spiral
- Native tool calling is far more reliable than text-based code generation
- The model defaults to write_file (rewrite everything) unless strongly prompted against it
- Line-number tools are more reliable than find_replace (whitespace matching is hard for small models)
- Personality context must be compact — system prompt + tools eat most of the 8K context window
- One action per turn works well for small models — don't ask them to multi-plan

## Project Status
- server-v2.ts: Native tool calling with line-based editing — working
- Task Runner: Built (task-runner.ts) — sliding context, multi-step loops
- run_command: App launching tool with safety allowlist
- Web Search: Google Custom Search API integrated
- Memory: Workspace files (SOUL, IDENTITY, USER, MEMORY, AGENTS, TOOLS) created
- Daily Logs: Auto-written to memory/YYYY-MM-DD.md
- Audit Log: Tool calls logged to tool_audit.log
- Skills: Not yet implemented (Phase 3/4)
- Browser Automation: Not yet (needs Playwright integration)
- Context Pin UI: Planned — user pins 1-3 messages with TTL slider

## Upcoming Features
- Playwright browser tools (navigate, snapshot, click, fill)
- Skills system with UI toggle
- Context pinning: user selects old messages to re-inject with auto-expire
- Moltbook integration test (sign up + post autonomously)
