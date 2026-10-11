# SmallClaw Changelog

A running log of features, fixes, and improvements added to SmallClaw. Each entry includes what changed, why, and notes for update posts.

---

## [Unreleased] — In Progress

> Features built but not yet tagged in a release.

### 2026-10-11 — Repository Housekeeping (A)

- Moved 8 stray `.git-msg-*.txt` commit-message drafts and `diag.txt` into the gitignored `.backup/clutter_20261011/` (recoverable, not committed).
- Removed the leftover `.tmp-test/` directory entirely. It contained 35 scratch/log files: 33 test artifacts (moved to `.backup/clutter_20261011/` earlier) plus the 2 gateway logs `gateway.log` / `gateway-err.log` that were previously locked by the running gateway (PID 16588) — now deleted after the gateway was stopped.
- Also relocated the stray `docs/memory-flush-optimization-plan.md` planning draft into `.backup/clutter_20261011/`.
- Root directory and `git status` are now fully clean: no untracked files, no scratch/draft clutter.

### 2026-10-11 — Workspace Privacy Guard (B)

- `.gitignore`: replaced the per-extension `workspace/...` rules with a whole-directory ignore (`workspace/*` + `!workspace/.gitkeep`). Previously `workspace/*.md` was NOT ignored, so user documents (`sales_report.md`, `简历.md`, `会议纪要_*.md`, ...) could be committed by accident.
- Added `workspace/.gitkeep` so the directory still exists in a fresh clone.

### 2026-10-11 — Rename Residue Cleanup (C)

- `.gitignore`: header comment `LocalClaw` → `SmallClaw`; removed the dead `.localclaw/` ignore block (project already migrated to `.smallclaw/`); dropped the `.tmp_openclaw_*/` OpenClaw-era temp pattern. `.smallclaw/` rules unchanged.

### 2026-10-11 — README Overhaul + Bilingual Switch (F)

- Rewrote `README.md` to match the actual codebase. The old README claimed a "single-pass, no planning/execution/verification agents" design that contradicted the real `orchestration` system.
- **Architecture corrected**: core is a single-pass `handleChat()` loop; an **optional, config-gated** multi-agent orchestration layer (planner/executor/verifier + plan mode + verification-flow + self-healer) is also built in (controlled by `orchestration` in `.smallclaw/config.json`).
- Added the missing capabilities to the feature list and docs: Knowledge Base (RAG), Flows, Office/PPT/Image tools, `run_code`, Memory system, Cron scheduler, model tiers (≤4B / 5–9B / ≥10B), MCP, Telegram/Discord/WhatsApp channels.
- Replaced the 4-group config snippet with a realistic example derived from `src/types.ts` (`SmallClawConfig`, ≈20 top-level keys); removed the misleading `reactor.ts` reference.
- Updated the Roadmap to mark shipped items (KB, Flows, Office, PPT, Image, Memory, Cron, Orchestration, channels).
- Added a 🇨🇳 中文 / 🇺🇸 English **tab switcher** (HTML radio + `<style>`). Works as tabs in VS Code / WorkBuddy / Typora previews; degrades gracefully to full bilingual display on GitHub (which strips `<style>`/`<input>`).
- Fixed repo URLs in badges/clones from `XposeMarket/SmallClaw` to the actual remote `ylixx/SmallClaw`.
- Note: bilingual duplication roughly doubles README length; on GitHub both languages render (no tab switching) by design.

### 2026-10-11 — server-v2 Split Phase 0: Safety Net (G)

- Began executing the `server-v2.ts` split plan (`docs/server-v2-split-plan.md`). **Phase 0 only adds a safety net — `server-v2.ts` itself is untouched.**
- `package.json`: added `"typecheck": "tsc --noEmit"` and `"smoke": "vitest run tests/smoke-gateway.test.ts"`.
- `tests/server-v2-integrity.test.ts` (always on, safe — does NOT import the giant module): static symbol guard on `server-v2.ts` source (handleChat still defined, still `export { app, server }`) + real imports of the already-extracted helpers (`server-v2-text`, `run-command-router`) to catch accidental deletions/renames during later extractions.
- `tests/smoke-gateway.test.ts` (opt-in, gated by `SMALLCLAW_SMOKE=1`): spawns the real gateway as a separate process, probes `/api/status` (HTTP 200), then tears the process tree down (taskkill `/T` + by-port fallback — tsx forks a child, so killing the parent alone leaks the server).
- **Why not import `server-v2.ts` in vitest**: it calls `server.listen()` at module top-level and reads config on load, so importing it would actually start the server and bind a port.
- Verified: `typecheck` → 0 errors; default `npm test` → 71 passed / 1 skipped (smoke skipped, no server started); `SMALLCLAW_SMOKE=1 npm test` → real gateway boot, 200, no leftover process.

### 2026-10-11 — server-v2 Split Phase 1: Config Bootstrap + Failure Circuit Breaker (H)

- 执行拆分方案 Phase 1：新增 `config-bootstrap.ts` 与 `request-guards.ts`（失败熔断部分）；`server-v2.ts` 仅替换 import 与调用点，业务行为字节级不变。
- `src/gateway/config-bootstrap.ts`（新）：cwd 规范化、config 加载、workspace.path 合法性校验、配置目录推导、端口/主机推导、`repairLegacyTaskChannelMetadata` 全部下沉。仅依赖叶子模块（config/task-store），无反向引用 → 无循环依赖。
- `src/gateway/request-guards.ts`（新）：重复失败熔断（`noteToolFailure` + `toolFailureTracker` + `TOOL_FAILURE_LIMIT`）下沉；新增 `resetToolFailure(sessionId)` 封装，承接 `executeTool` 成功分支原先直接 `toolFailureTracker.delete` 的逻辑，行为一致。
- **已排除的隐性风险**：`noteToolFailure` 之外，`executeTool` 成功分支也直接访问 `toolFailureTracker`，已用 `resetToolFailure` 封装，无悬挂引用。Model-Busy 守卫（`let isModelBusy` 模块级可变单例，跨 11 处读写 + 4 个闭包访问器）耦合度高，属高风险抽取项，已刻意留待后续独立小步，本次不碰。
- 验证：typecheck 0 错；默认 `npm test` 71 passed / 1 skipped（冒烟跳过）；`SMALLCLAW_SMOKE=1` 真实网关启动 → /api/status 200 → 无残留。
- 对应文档：`docs/server-v2-split-plan.md` Phase 1 标记完成，并注明 Model-Busy 守卫延后。

### 2026-10-11 — server-v2 Split Phase 2 Prep: /api/tools Snapshot Lock (I)

- Phase 2 抽取前的**准备动作**：在既有 `tests/smoke-gateway.test.ts`（已验证、受 `SMALLCLAW_SMOKE=1` 门控）内新增 `GET /api/tools` 锁断言，**复用同一网关进程，零新增端口、零端口冲突**。
- 锁内容：① `success===true`；② `tools` 为非空字符串数组；③ 核心无依赖文件工具 `read_file/list_files/grep_content/create_file` 必在；④ `expect(tools).toMatchSnapshot()` 字节级锁定当前 **53 个工具名**列表，抽取时任何误删/改名都会让快照比对失败。
- 代码边界探查（只读，为下一步抽取定位）：工具注册表簇 = `applyToolCompactness`(1214) + `buildTools`(1241, ~470 行, 56 个纯数据定义, 0 个 `fn:` 实现指针) + `filterToolsByIntent`(3778) + `applyToolPolicy`(1942)。其中 `buildTools` 区间(1241–1945)耦合极低：仅 2 处 `config.`、0 处 `sendSSE`、3 处 `getConfig()`，是**风险最低的首抽目标**。
- 验证：`SMALLCLAW_SMOKE=1` → 2 tests passed + 1 snapshot written；teardown 后 18789 释放、无 node/tsx 残留；默认 `npm test` 71 passed / 2 skipped（冒烟跳过，无服务）。

### 2026-10-11 — server-v2 Split Phase 2a: Tool Compaction Helpers → tool-registry.ts (J)

- 新建 `src/gateway/tool-registry.ts`，承接 3 个**零耦合纯函数**：`getModelTier()`（模型档位推断，经 `require('../config/config.js')` 读取、不依赖 server-v2 顶层单例）、`compactToolDescription()`、`applyToolCompactness()`（按档位压缩 tool 描述/参数）。
- `server-v2.ts` 改为 `import { getModelTier, applyToolCompactness } from './tool-registry'`；`ModelTier` 类型改为 `export` 以便类型侧依赖（`import type` 编译期擦除，杜绝循环依赖）。
- **buildTools 实际耦合比原评估更重**：其尾段(1705–1709)调用 5 个工具构建器（`getKnowledgeToolDefinitions` 来自 `../tools/knowledge`、`planToolDefinitions` 来自 `./plan-mode`，以及 server-v2 内部 3 个 `agentShellEnabled`/`shellExecToolDefinition`/`buildMcpToolDefinitions`）。原"56 个纯数据定义、0 个 fn 指针"只覆盖中段数据，buildTools 不可整体原样搬移，故**本轮不碰**，留作下一步单独提案。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed / 2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（字节级不变），网关启动/清理无残留。
- 备份点：`git tag backup/pre-phase2a-20261011`。

### 2026-10-11 — server-v2 Split Phase 2b: buildTools Cluster → tool-registry.ts (K)

- 采用 **路径 A**：把 `buildTools` 整簇搬入 `tool-registry.ts`；server-v2.ts 仅 `import { buildTools, agentShellEnabled, MCP_TOOL_PREFIX, collectMcpToolEntries }`（外加 2a 的 `getModelTier`/`applyToolCompactness`）。
- 搬入内容：`buildTools()`（~430 行、56 个工具定义 + 容器内装配逻辑）、`agentShellEnabled`、`shellExecToolDefinition`、MCP 簇（`MCP_TOOL_PREFIX`/`sanitizeMcpNamePart`/`normalizeMcpInputSchema`/`McpToolEntry`/`collectMcpToolEntries`/`buildMcpToolDefinitions`）。
- buildTools 依赖的 ~10 个工具定义提供方（browser/desktop/office/image/file-batch/knowledge/plan/mcp/agent-builder/multi-agent）均为叶子模块；全 src 扫描确认只有 `tool-registry.ts` 的 `import type { ModelTier }` 引用 server-v2（编译期擦除、运行时无环）。
- **唯一真障碍**：`isOrchestrationSkillEnabled`（依赖 server-v2 的 `skillsManager` 单例，无法平移）→ 通过 `buildTools(tier?, deps?)` 的 `deps.isOrchestrationSkillEnabled` 参数注入，server-v2 在 3 个调用点（含 `/api/tools` 端点）传入真实实现；`isOrchestrationSkillEnabled` 仍留在 server-v2（3945/9938 行亦用）。
- server-v2.ts 净减 ~581 行（10,814 → 10,115，累计净减 699 行）；tool-registry.ts 现 ~664 行。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（含 `request_secondary_assist`，证明注入正确、行为字节级不变），网关启动/清理无残留。
- 备份点：`git tag backup/pre-phase2b-20261011`。

### 2026-10-11 — server-v2 Split Phase 2c: filterToolsByIntent Cluster → tool-registry.ts (L)

- 把 **零外部/server-v2 状态依赖**的 `filterToolsByIntent` 簇搬入 `tool-registry.ts`：`filterToolsByIntent()`（原 3160）+ 11 个 `CAT_*` 常量（原 3139-3158）+ 紧邻的纯函数 `detectToolCategories()`（原 850）。
- server-v2.ts 改为 `import { filterToolsByIntent, detectToolCategories }`（`detectToolCategories` 在原 1035 行另有调用，一并保留引用）；旧定义从 server-v2 完全清除、无残留。
- 该簇正是 `/api/tools` 端点（锁 53 工具名）的核心路径——搬移后快照比对通过，证明字节级行为不变。
- ⚠️ **`applyToolPolicy`（原 1324，连带 `checkToolDenied` 1347）本轮未搬**：其依赖簇牵连 5 个 helper + 9 个 `*_TOOL_NAMES` 集合 + `TOOL_GROUPS` + 外部 import（`isPlanTool`/`getAgentById`/`getDefaultAgent`），且 `profileAllowsTool`/`TOOL_GROUPS` 仍被 server-v2 别处使用——牵一发动全身，拆为独立 **Phase 2d** 谨慎小步。
- server-v2.ts 净减 94 行（10,115 → 10,020，累计净减 794 行）；tool-registry.ts 763 行。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（字节级不变），网关启动/清理无残留。
- 备份点：`git tag backup/pre-phase2c-20261011`。

---

### 2026-10-04 — 2026-10-11 — Feature & Hardening Wave (D)

> 自 2026-02-27 之后的能力跃迁。覆盖知识库、流程固化、办公/PPT/图像、工具系统重构、记忆与上下文预算、UI 中文化、多模型档案、聊天健壮性、安全加固。详细提交见 `git log --since=2026-03-01`。

**Knowledge Base（本地 RAG）**
- 本地知识库：add/search/list/remove + 聊天自动 RAG 注入（`src/tools/knowledge`）。
- 聊天内 `@引用` 文件 + UI 选择器；知识库面板（📚 入口、点击自动 @引用、删除、上传）。
- 修复知识库点击处理器静默失效（属性引号 bug）、列表渲染、加载防抖 300ms。

**Flows（一键流程固化）**
- 一键流程模板固化 + 侧边栏运行面板。
- 流程 CRUD：UI 新建/编辑/删除 + API；修复流程运行后产物不可见。
- 周报流程沉淀为 `weekly-report` 技能；技能规范动态引用、消除双注入；产物模板 flow 固化 + 中文 skill 匹配（数据整理报告）。

**Office / PPT / Image（办公生产力）**
- Office：`doc_ocr`、`doc_parse_lab`；`doc_batch` 批量处理 + 内置模板库；Excel 数据透视 `doc_pivot` + xlsx 公式写入；md/txt 读取、md→docx 走 python-docx；办公链路小模型友好化。
- PPT：一键生成 flow（内置美化 + 技能规范）；渲染引擎升级为豆包式版式体系（多主题 + 四类页面）。
- Image：新增 `image_edit`（抠图/压缩/水印，纯本地 PIL）。

**Tools System Overhaul（小模型工具调用重构）**
- 按模型档位三套配置（small≤4B / mid 5-9B / large≥10B）；档位判定改为「活体上下文 × 参数量」双维度。
- 工具描述两段式（short/full），≤4B 自动换短版；运行时动态裁剪——20 个常开工具拆为 5 核心 + 意图组。
- `list_files` 升级为查询工具（摘要/过滤/排序/截断）；新增 `grep_content`；`read` 带行号。
- 新增 `run_code` 真实代码执行工具；Markdown 全语法解析 + 代码块语法高亮/复制。
- 工具定义按需注入、slim tool definitions（injected 64→56，payload 39K→29.7K chars）。

**Memory & Context Budget**
- 会话历史上下文预算（跟随活跃模型 n_ctx）；轮内上下文预算（跟随窗口 + 速度自适应）。
- 记忆相关性过滤注入（显式许可头 + 容量上限 + 中文意图识别）。
- 最近对话回顾注入、对话记录可真正删除、FILE_ANALYSIS 改主模型 + 系统代读。

**UI 全量中文化 & 体验**
- 主要界面文案、任务面板、定时任务卡片/弹窗、空状态/加载/错误提示全面中文化。
- 思考模式(think)可视化开关；可拖拽分栏宽度、聊天输入框高度；🦞 favicon。
- 聊天区常驻模型切换下拉；第三方 OpenAI 兼容端点 Base URL / Key 补全。

**Multi-Model Profiles & Providers**
- 多套模型配置档案，一键切换当前生效模型。
- 兼容带版本段的 API 地址（智谱 `/paas/v4` 等），档案密钥独立入 vault；chat 超时 120s→300s + 自动重试。
- 视觉：用户消息图片附件以 `image_url` content part 注入主模型。

**Chat Robustness**
- 会话元问答注入（"最后一组/总共几组"毫秒级）、报告改为自包含 HTML；小模型不再强制思考。
- 问候轮 fallback 根因修复；provider 拒绝畸形工具参数时纠正重试。

**Security & Hardening**
- `run_command` 加固：阻止可执行扩展名启动、校验目标存在、workspace cwd、office 格式白名单、防 workspace 越界。
- 多机器部署加固：工作区/配置路径与启动目录解耦。
- 配置化消除硬编码（模型路径/ctx/reasoning）；移除 num_ctx/num_predict 硬编码。

> 注意：README 的 "Architecture" 一节仍写 "single-pass，无 planning/execution/verification 多 agent"，与代码实际的多智能体编排（`src/orchestration/multi-agent.ts`、`verification-flow.ts`、`subagent-manager.ts`）不符，需后续单独修订 README。

---

## 2026-02-27 — Sub-Agent Spawn Architecture

### What Changed
SmallClaw now supports spawning child agents from within background tasks. The primary agent can delegate work to isolated specialist sub-agents, wait for their results, and resume with their output injected into context — enabling multi-step agentic workflows without overloading a single context window.

### Two Modes

**Default mode (`subagent_mode: false`) — `delegate_to_specialist`**
Designed for 4B local models. Fixed specialist roles with structured I/O. Sequential execution. Safe and reliable on any Ollama setup.

**Full mode (`subagent_mode: true`) — `subagent_spawn`**
Free-form arbitrary task prompts (Claude Cowork-style). Parallel execution. Primary agent acts as orchestrator. Best for larger/smarter models.

Both modes share identical underlying machinery — only the entry-point tool differs.

### Tool Profiles
Sub-agents receive a restricted tool set based on their assigned role:

| Profile | Tools Available |
|---|---|
| `file_editor` | read/write file operations |
| `researcher` | read files + web search/fetch |
| `shell_runner` | run_command + read files |
| `reader_only` | read files only |

No profile includes `delegate_to_specialist` or `subagent_spawn` — recursion is prevented at the profile level and with an explicit depth guard.

### How It Works

```
Parent task calls delegate_to_specialist / subagent_spawn
        ↓
Child task created (parentTaskId, subagentProfile, onResumeInstruction)
        ↓
Parent status → 'waiting_subagent'
        ↓
Child BackgroundTaskRunner executes independently
        ↓
Child completes → resolveSubagentCompletion() fires
        ↓
[SUBAGENT RESULT: title]\n{summary}\n[/SUBAGENT RESULT] injected into parent context
        ↓
If all children done → parent status → 'queued', resumes automatically
```

### New Task Status
`waiting_subagent` — parent task pauses here until all pending child tasks complete.

### Config
```ts
orchestration: {
  subagent_mode: false  // true = full multi-agent spawn mode
}
```
Toggleable via `POST /api/orchestration/config`.

### Files Modified
- `src/gateway/task-store.ts` — `waiting_subagent` status, `SubagentProfile` type, `resolveSubagentCompletion()`, parent/child fields on `TaskRecord`
- `src/gateway/background-task-runner.ts` — delivery hook, run-loop waiting_subagent handling, context injection for profile/resume notes
- `src/gateway/server-v2.ts` — `TOOL_PROFILES`, `delegate_to_specialist` / `subagent_spawn` tool definitions, spawn handler in `handleChat()`, config API wiring
- `src/config/config.ts` — `subagent_mode: false` default
- `src/types.ts` — `subagent_mode?: boolean` on `SmallClawConfig`

### Update Post Draft
> **SmallClaw can now spawn sub-agents 🤖→🤖**
>
> Background tasks can delegate to specialist child agents — a file editor, a researcher, a shell runner — and wait for their results before continuing.
>
> The parent pauses, the child runs in its own isolated context, and when it's done the result is automatically injected back so the parent can carry on.
>
> Two modes: a conservative 4B-safe delegate mode with fixed specialist roles, and a full free-form spawn mode for larger models. Same plumbing either way.
>
> Zero new dependencies. Five files changed.

---

## 2026-02-27 — Soul & Memory Growth System

### What Changed
SmallClaw now has a full personality growth loop — it learns who you are, evolves its own character, and writes that knowledge to disk so it survives restarts and context resets.

### Core Pieces Built

**`workspace/SOUL.md` — rewritten with explicit growth rules.** The AI is now clearly instructed to:
- Extract user preferences and write them to `memory_write` proactively
- Update `USER.md` whenever it learns something new about the user
- Update its own `SOUL.md` when it develops a new operating principle
- Write session notes to daily memory before context compresses

**`workspace/USER.md` — rebuilt as a living document** with structured sections for identity, work style, projects, preferences, and technical context. Starts with helpful placeholders; Claw fills it in over time.

**`src/tools/persona.ts` — two new tools:**
- `persona_read` — reads SOUL.md, USER.md, IDENTITY.md, etc. with line numbers (read before editing)
- `persona_update` — surgically updates persona files via 4 modes: `append_section`, `upsert_line`, `replace_section`, `full_rewrite`. Every update is logged to today's daily memory.

**`src/gateway/session.ts` — upgraded memory flush prompt.** The pre-compaction silent turn now explicitly instructs the AI to run `memory_write`, `persona_update USER.md`, `persona_update SOUL.md`, and write a session note — not just a vague "save facts" reminder.

### The Growth Loop (How It Works)

```
User chats with Claw
        ↓
Claw learns something new (preference, project, fact)
        ↓
Claw calls memory_write or persona_update immediately
        ↓
Fact survives restart (in MEMORY.md, USER.md, or facts.json)
        ↓
Next session: fact is injected into system prompt
        ↓
Claw acts on it without being told again
```

When the context window fills up:
```
Context ~80% full → silent flush turn fires automatically
        ↓
Claw writes session notes + preference updates + USER.md changes
        ↓
Context compresses → new session starts with updated workspace files
```

### What This Looks Like in Practice
- First session: blank USER.md, generic SOUL.md
- After a few chats: Claw knows your name, your preferred response length, your timezone, which projects matter
- After a few weeks: SOUL.md has a `## Learned About [Name]` section. USER.md is full. Claw's tone is tuned to you.
- New sessions feel like continuing a conversation, not starting over

### Files Changed
- `workspace/SOUL.md` — full rewrite with growth rules
- `workspace/USER.md` — rebuilt as living user model
- `src/tools/persona.ts` — new file (`persona_read`, `persona_update`)
- `src/tools/registry.ts` — registered new persona tools
- `src/gateway/session.ts` — upgraded `PRE_COMPACTION_MEMORY_FLUSH_PROMPT`

### Update Post Draft
> **SmallClaw now grows with you 🌱**
>
> Every session, SmallClaw learns a little more about how you work — your preferences, your projects, how you like to communicate. It writes that to disk so it survives restarts.
>
> When the context window fills up, a silent turn fires automatically: Claw writes its session notes, updates its model of you, and evolves its own soul file before the context compresses.
>
> Over time: SOUL.md develops a `## Learned About [You]` section. USER.md fills in. The AI's tone tunes to yours.
>
> New sessions feel like continuing a conversation, not starting over.

---

## 2026-02-27 — Self-Repair System (Design Phase)

### What Changed
Designed the full self-repair architecture. No code written yet — see `SELF-REPAIR.md` for the complete plan.

### What It Will Enable
SmallClaw will be able to:
- Read its own source code (`src/`) to analyze errors from failed background tasks
- Generate a surgical unified diff patch to fix the bug
- Send you a proposal over Telegram with the exact change it wants to make
- Wait for your explicit `/approve <id>` before touching anything
- Apply the patch, rebuild, restart, and confirm — or revert and report if the build fails

### Architecture Summary
Four new deliverables:
1. `workspace/SELF.md` — architecture map injected into system prompt (AI learns its own file structure)
2. `src/tools/source-access.ts` — read-only `read_source` / `list_source` tools exposing `src/` to the AI
3. `src/tools/self-repair.ts` — `propose_repair` tool that stores pending patches with approval gate
4. `/approve` and `/reject` handlers in `telegram-channel.ts`

### Key Design Decision
The AI can **read and analyze** source autonomously. It can **never apply changes** without your explicit `/approve <id>` over Telegram. The confirmation gate is hardcoded — not a setting.

### Status
- [x] Architecture designed (`SELF-REPAIR.md`)
- [x] `workspace/SELF.md` — complete
- [x] `src/tools/source-access.ts` — complete (`read_source`, `list_source`)
- [x] `src/tools/self-repair.ts` — complete (`propose_repair`, `applyApprovedRepair`)
- [x] Telegram `/repairs`, `/repair`, `/approve`, `/reject` handlers — complete
- [x] Registry registration — complete
- [x] `SELF.md` injected into `buildPersonalityContext` in `server-v2.ts`

### Update Post Draft
> **Coming to SmallClaw: Self-Repair 🔧**
>
> Working on something ambitious: SmallClaw will soon be able to find and fix bugs in its own source code.
>
> When a background task fails with what looks like a source bug, it reads its own codebase, analyzes the error, writes a patch, and asks you over Telegram: "Want me to fix this?"
>
> You reply `/approve` — it patches, rebuilds, restarts, and confirms. Or `/reject` to discard it.
>
> The AI can never touch source code without your explicit approval. That gate is hardcoded.
>
> Still in design — implementation coming next.

---

## 2026-02-27 — Telegram File Browser

### What Changed
Added a full inline file browser to the Telegram channel (`src/gateway/telegram-channel.ts`), inspired by the [openclaw-telegram-chat-file-browser](https://github.com/timotme/openclaw-telegram-chat-file-browser) plugin.

No new dependencies — built entirely on the existing raw Telegram Bot API fetch layer already in SmallClaw.

### New Commands

| Command | Description |
|---|---|
| `/browse` | Opens the file browser at your workspace root |
| `/browse <path>` | Opens the browser at a specific subfolder |
| `/download <path>` | Sends a file directly as a Telegram attachment |

### How It Works

- **Inline keyboard navigation** — tapping a folder button navigates into it; the message edits in-place (no new messages spamming the chat).
- **File preview** — text files render in a `<pre>` block with ◀️ / ▶️ pagination (2,500 chars per page, configurable).
- **Binary detection** — files with null bytes are detected and shown with their size + a `/download` hint instead of garbled output.
- **Path safety** — all paths are clamped to the workspace root; no directory traversal possible.
- **Paths in callback_data** — absolute paths are base64url-encoded directly into button data, so zero server-side state is needed for navigation.

### Files Modified
- `src/gateway/telegram-channel.ts` — all changes contained here

### Config Constants (top of file, easy to tune)
```ts
const BROWSER_MAX_BUTTONS_PER_ROW = 2;   // buttons per row in the keyboard
const BROWSER_MAX_BUTTONS_TOTAL   = 40;  // max files/folders shown per directory
const BROWSER_MAX_TEXT_PREVIEW    = 2500; // chars per page for text preview
```

### Update Post Draft
> **New in SmallClaw: Telegram File Browser 📁**
>
> You can now browse your entire workspace from Telegram — no app switching, no SSH.
>
> Send `/browse` to your SmallClaw bot and get an inline keyboard showing your workspace files and folders. Tap to navigate, tap a file to preview it, and use `/download <path>` to pull any file directly into the chat as an attachment.
>
> Works on text files with full pagination, detects binary files and shows their size, and navigates entirely in-place (edits the same message — no chat spam).
>
> Zero new dependencies. One file changed.

---

## Template — How to Add a New Entry

Copy this block when logging the next change:

```md
## YYYY-MM-DD — Short Title

### What Changed
1–3 sentence summary of what was built or fixed.

### New Commands / APIs / Config
(table or bullet list if applicable)

### How It Works
Brief technical explanation — enough for someone reading the code cold.

### Files Modified
- `path/to/file.ts` — what changed

### Update Post Draft
> Ready-to-post blurb for socials / release notes.
```

---

*This file is maintained manually. Add an entry every time a meaningful feature or fix lands.*
