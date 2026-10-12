# SmallClaw Changelog

A running log of features, fixes, and improvements added to SmallClaw. Each entry includes what changed, why, and notes for update posts.

---

## [Unreleased] — In Progress

> Features built but not yet tagged in a release.

### 2026-10-12 — server-v2 Split Phase 5d（13~18）：Personality / Skills / Files / KB / Chat 路由下沉——已完成并推送

> 承接 5d-1~12 节奏：tag 备份 → 提取脚本 → 新模块（registerXxxRoutes(app, deps)）→ 三层验证 → commit+push。`server-v2.ts` 由 **1,920 行降至 1,005 行**（累计 10,814 → 1,005，净减 **-9,809**），剩余为组合根装配（Express 装配、路由注册、Webhook IIFE、SPA catch-all、Server 启动区）。

- **5d-13**（`42abd04`）：文档收尾——CHANGELOG 补 5d-1~12 全段（含每步 hash）；split-plan 状态行更新。
- **5d-14**（`9b5f326`）：Workspace Memory + Tiered Prompt 簇（loadWorkspaceFile/readDailyMemoryContext/MEMORY_RECALL_RE/TOOL_BLOCKS/readMemoryCategories/readMemorySnippets/TOOL_TO_MEMORY_CATS/buildPersonalityContext，~255 行）→ `personality-context.ts`（纯 import）。buildPersonalityContext export（handleChat deps 用）。1,920 → 1,666。
- **5d-15**（`683abd1`）：Skills 初始化簇（目录解析 + SkillsManager 单例 + isOrchestrationSkillEnabled/renderFlowInstruction/recoverSkillsIfEmpty/setOrchestrationEnabled + 启动对齐 IIFE，~143 行）→ `skills-bootstrap.ts`（**模块顶层副作用**：resolveSkillsDir + new SkillsManager；server-v2 是唯一 importer，vitest 不碰，安全）。修 CONFIG_DIR_PATH → getConfigDirPath()、config → getConfig().getConfig()。1,666 → 1,523。
- **5d-16**（`b027e8c`）：Files/Doc/Plan/artifacts/status 路由（sanitizeUploadName + /api/files + /api/fs + /api/doc/apply + /api/plan + /api/artifacts + /api/status，~235 行）→ `api-files.ts`（零 deps 注入）。修 /api/status 的 `config` 本地变量 → getConfig().getConfig()。1,523 → 1,288。
- **5d-17**（`9c594aa`）：Knowledge base REST（/api/knowledge + /add + /remove，~40 行）→ `api-kb.ts`；**KNOWLEDGE_DIR 上移 config-bootstrap 单一来源**（server-v2 与 api-kb 共用）。1,288 → 1,248。
- **5d-18**（`c33b5cc`）：Chat 路由区（tryHandleBlockedTaskFollowup + /api/chat + /api/open-path + /api/clear-history + /api/sessions/delete + /api/memory/clear，~245 行）→ `chat-routes.ts`（deps={ handleChat, handleTaskControlAction, setMainSessionId }；lastMainSessionId 用 setter 闭包）。1,248 → 1,005。
- 拆分产物新增：personality-context ≈263 / skills-bootstrap ≈154 / api-files ≈254 / api-kb ≈51 / chat-routes ≈280。
- 验证链：每步 tag 备份；typecheck 0 错、`npm test` 70 passed/2 skipped、`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed；每步 commit+push（local==origin/main）。

### 2026-10-11 — server-v2 Split Phase 5d: REST 路由按域下沉（1~12）——已完成并推送

> 方法论：变更前 `git tag backup/pre-phase5dN` → 提取脚本（ts AST/行范围）→ `api-*.ts`（`registerXxxRoutes(app, deps)` 模式）→ server-v2 原位替换 → 三层验证（typecheck 0 错 / `npm test` 70 passed+2 skipped / `SMALLCLAW_SMOKE=1 npm run smoke` 2 passed）→ commit+push。`server-v2.ts` 由 **4,369 行降至 1,920 行**（累计 -2,449），业务行为字节级不变。

- **5d-1**（`825b183`）：`/api/system-stats` + `getCpuPercent` + `prevCpuTimes` → `api-system.ts`（`registerSystemRoutes(app)`，零 deps）。
- **5d-2a+2b**：`requireGatewayAuth`（64 行、11 处跨域使用）→ `api-auth.ts`；Agent Session Context + Approvals（`pendingApprovals` Map）+ Memory stub + open-path → `api-misc.ts`（deps 仅 `isOrchestrationSkillEnabled`）。
- **5d-3**（`88e0a11`）：MCP API 6 路由 + `/api/tools` → `api-mcp.ts`（deps={ resolveModelTier, isOrchestrationSkillEnabled }）。
- **5d-4**（`8fc3a29`）：Provider/Model Settings（~270 行）+ Webhook Settings（3 路由）→ `api-settings.ts`（零 deps；`CONFIG_DIR_PATH` → 局部常量）。
- **5d-5**：Skills API 6 路由 + Orchestration Settings 4 路由 + `clampInt`/`getOrchestrationConfigForApi` → `api-skills.ts`（deps={ skillsManager, recoverSkillsIfEmpty, setOrchestrationEnabled, activeTasks }）。
- **5d-6**（`6a6138e`）：Tasks/Cron API 10 路由 + Background Task Kanban 8 路由（含 SSE stream）→ `api-tasks.ts`（deps={ cronScheduler, heartbeatRunner, loadTaskHeartbeatConfig, handleChat, makeBroadcastForTask, telegramChannel }）。
- **5d-7**：Flow templates 5 路由 + `/api/flows/:id/run`（SSE 执行流程）→ `api-flows.ts`（deps={ handleChat, addMessage }）。
- **5d-8**（`cdfcf88`）：Channels API 8 路由 + 4 类型 + 5 helper（resolveToken/normalize*/resolveChannelsConfig）→ `api-channels.ts`（deps={ telegramChannel }；`resolveChannelsConfig` 保持 export 供组合根 telegram init 使用）。
- **5d-9**（`09e851a`）：Scheduler API 7 路由（CRUD/run/parse）→ `api-schedules.ts`（deps={ cronScheduler }；`isConfirmed` import 自 chat-execution）。
- **5d-10**（`d140050`）：通用 Settings（search/credentials/paths/agent）+ Model/Ollama Settings（settings/model、settings/think）并入 `api-settings.ts`（补 fs/getVault import）。
- **5d-11**（`d7d2863`）：Agents API 8 路由 + 4 本地 helper（sanitizeAgentId/normalizeAgentDefinition/normalizeAgentsForSave/findLastCronRunAt）→ `api-agents.ts`（零 deps 注入；import 自 config/config + scheduler + agents/spawner）。
- **5d-12**（`52d2db8`）：Task Heartbeat 域（状态 + scheduleTaskFollowup/makeBroadcastForTask/scheduleTaskHeartbeat/runTaskHeartbeat + heartbeat-config 路由）→ `task-heartbeat.ts` **createHeartbeatDomain(deps) 工厂**。**循环依赖破法**：createChatHandler 闭包 makeBroadcastForTask、而 makeBroadcastForTask→scheduleTaskFollowup→handleChat，工厂接受惰性 `getHandleChat()` getter，组合根先建 heartbeatDomain 再建 handleChat。
- 拆分产物（行数）：api-system 102 / api-auth ≈56 / api-misc 127 / api-mcp ≈120 / api-settings ≈540 / api-skills ≈270 / api-tasks ≈380 / api-flows ≈90 / api-channels ≈410 / api-schedules ≈160 / api-agents ≈250 / task-heartbeat ≈218；此前已拆 chat-handler ≈3,575 / chat-execution ≈1,670 / tool-registry 915 / 等。
- 验证链：每步 `git tag backup/pre-phase5dN-20261011` 备份；typecheck 0 错、`npm test` 70 passed/2 skipped、`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed；每步 commit+push（local==origin/main）。

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

### 2026-10-11 — server-v2 Split Phase 2d: applyToolPolicy Policy Cluster → tool-registry.ts (M)

- 把 `applyToolPolicy`/`checkToolDenied` + 其 policy helper 簇搬入 `tool-registry.ts`：`*_TOOL_NAMES` 集合（FILE/SHELL/WEB/MEMORY/SCHEDULE/TASK/ORCHESTRATION + `KNOWLEDGE_TOOL_NAMES` 展开）、`TOOL_GROUPS`、`matchToolPattern`、`profileAllowsTool`、`resolveSessionAgent`、`resolveAgentToolPolicy`、`resolveGlobalEnabledSet`、`applyToolPolicy`、`checkToolDenied`。
- **选择性搬移**：`KNOWLEDGE_DIR`/`KB_AUTO_INJECT_RE`/`ArtifactEntry`/`recordArtifact`/`listArtifacts` 与该簇交错在同一区块，但被 server-v2 外部（3829/3834/3866/7079/7129-7156/1591/1871-1910 等）调用，故**留在 server-v2**。
- **关键耦合处理**：`sessionAgentBindings`（被 server-v2 7290-7291 直接 `set`/`delete` 的 live Map 单例）改为 `export const` 由 server-v2 import 同一实例（同 Phase 2b 的 `MCP_TOOL_PREFIX` 模式），行为不变。
- 叶子 import 新增：`isPlanTool`(plan-mode)、`AGENT_BUILDER_TOOL_NAMES`(agent-builder-integration)、`KNOWLEDGE_TOOL_NAMES`(tools/knowledge)、`getAgentById`/`getDefaultAgent`(config/config)；已验证无循环依赖。
- server-v2.ts 净减 135 行（10,020 → 9,885，累计净减 929 行）；tool-registry.ts 915 行。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（字节级不变），网关启动/清理无残留。
- 备份点：`git tag backup/pre-phase2d-20261011`。

### 2026-10-11 — server-v2 Split Phase 1.5: Model-Busy Guard → model-busy-guard.ts (N)

- 高风险项谨慎小步：把 Model-Busy 并发锁单例 `let isModelBusy` 抽出到独立模块 `src/gateway/model-busy-guard.ts`（模块级单例 + 纯 accessor `getModelBusy()`/`setModelBusy(bool)`）。
- **单一事实来源**：server-v2 不再持有本地 `let`，杜绝"两个布尔实例"导致 busy guard 失效（拆错 = 4B 模型并发推理真 bug）。
- server-v2.ts 13 处引用全替换：4 个外部模块装配闭包 `getIsModelBusy: getModelBusy`（CronScheduler/TelegramChannel/HeartbeatRunner/buildWebhookRouter）+ 函数体 6 处读判定 + 4 处写（flow/chat 端点 try/finally）→ `setModelBusy(...)`；删除 `let isModelBusy` 声明（保留相邻 `lastMainSessionId`）。
- 4 个消费方均为叶子模块、不反向依赖 server-v2（仅注释提及），下沉安全、无循环依赖。
- server-v2.ts 净减 2 行（9,885 → 9,883，累计净减 931 行）；model-busy-guard.ts 28 行（新建）。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（网关启动 + `/api/tools` 仍锁定 53 工具名 + 清理无残留），busy guard 行为字节级不变。
- 备份点：`git tag backup/pre-phase15-20261011`。

### 2026-10-11 — server-v2 Split Phase 3: Realtime SSE/WS → realtime.ts (O)

- 按拆分路线图 Phase 3（实时通道，中等风险）：新建 `src/gateway/realtime.ts`（40 行），下沉 SSE/WS 广播职责。
- `src/gateway/realtime.ts`（新）：模块级 `wss` 单例 + 三个 accessor/广播函数——
  - `broadcastWS(data)`（字节级原样搬移）：向所有 OPEN 的 WebSocket 客户端推送 JSON 帧（cron 滴答、任务心跳、子智能体派生、boot 问候等）；
  - `createSSESender(res)`（字节级原样搬移）：SSE 写入器，供 chat/flow 端点构造 `sendSSE`；
  - `setWss(server)` / `closeWss()`：wss 单例的赋值与关闭访问器（**单一事实来源**——server-v2 不再持有本地 `let wss`，杜绝"两个 WebSocketServer 实例"致广播失效）。
- `server-v2.ts` 只保留组合根职责：`new WebSocketServer` 构造 + `/ws` 连接/错误接线（局部 `wsServer` + `setWss(wsServer)`）、shutdown `closeWss()`；所有 `broadcastWS`/`createSSESender` 调用点改走 import，**签名字节级不变**（4 个外部模块装配闭包 CronScheduler/TelegramChannel/HeartbeatRunner/buildWebhookRouter 的 `broadcast: broadcastWS` 无需改动）。
- 循环依赖：realtime.ts 仅 `import type`（ws 的 `WebSocketServer`、express 的 `Response`），运行时零依赖 server-v2，无环。
- server-v2.ts 净减 18 行（9,883 → 9,865，累计净减 949 行）；realtime.ts 40 行（新建）。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关启动 + `/api/status` 200 + `/api/tools` 仍锁定 53 工具名快照 + 按进程树/端口强杀，无进程残留、18789 释放）。
- 备份点：`git tag backup/pre-phase3-20261011`。

### 2026-10-11 — server-v2 Split Phase 4: Flow Integration → flow-integration.ts (P)

- 按拆分路线图 Phase 4（流程/验证接线，中等风险）：新建 `src/gateway/flow-integration.ts`（79 行），下沉 flow 模板管理与产物打包编排。
- `src/gateway/flow-integration.ts`（新）：
  - `flowsManager` 单例（`export const`，live 单例模式同 Phase 2d）——server-v2 不再本地构造 `new FlowsManager(...)`，`handleChat` 内 `flowsManager.matchTrigger()`（3520）与 `/api/flows/:id/run`（7025）共享同一实例；
  - `buildFlowDonePayload(result, workspacePath?)`——run/chat 两个端点原本**字节级重复**的 done 事件构造（reply/mode/sections/thinking/results/artifacts + `extractFlowArtifacts`）抽为一处，两处调用点替换；
  - 5 个 flow CRUD handler（`listFlows`/`getFlowById`/`createFlow`/`updateFlow`/`deleteFlow`）——薄透传下沉；server-v2 保留 Express 路由注册（组合根职责），仅改为引用 handler。
- server-v2.ts 净减 ~55 行（9,865 → ~9,810，累计净减 ~1,004）；flow-integration.ts 79 行（新建）。
- 循环依赖：flow-integration 仅依赖叶子模块（flows-manager/config-bootstrap/flow-artifacts/config），运行时零依赖 server-v2，无环。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + `/api/tools` 仍锁 53 工具名快照）；**flow e2e 补测**：真网关 `GET /api/flows` → success=true、count=4（data-report/doc-analysis-report 等）、`GET /api/flows/nonexistent` → 404，结构不变；清理无残留、18789 释放。
- 备份点：`git tag backup/pre-phase4-20261011`。

### 2026-10-11 — server-v2 Split Phase 5a: Task Helpers → task-integration.ts (Q)

- 按拆分路线图 Phase 5（chat-handler，最高风险）**第 1 子步**：先把 handleChat/executeToolImpl 依赖的**纯任务辅助函数簇**下沉到 `src/gateway/task-integration.ts`（160 行，17 个导出），消除其对 server-v2 本地 task 助手的依赖。
- 分析：handleChat 2143 行、executeToolImpl 1078 行，直接整块搬会连带任务系统/广播/调度大量符号形成大爆炸；按"从叶子到根"分层，先搬**零 handleChat/telegramChannel 依赖**的纯函数簇。
- `task-integration.ts`（新，160 行）：`ACTIVE_TASK_STATUSES` 常量 + 16 个纯函数（`inferTaskChannelFromSession`/`latestTaskForSession`/`findBlockedTaskForSession`/`isResumeIntent`/`isRerunIntent`/`isCancelIntent`/`isStatusQuestion`/`isTaskListIntent`/`isAdjustmentIntent`/`getLatestPauseContext`/`summarizeTaskRecord`/`buildBlockedTaskStatusMessage`/`parseTaskStatusFilter`/`getTaskScopeBuckets`/`parseTaskIdFromText`/`renderTaskCandidatesForHuman`）——字节级原样搬移，仅依赖 task-store 叶子 import，运行时零依赖 server-v2，无循环。
- server-v2.ts 保留 `launchBackgroundTaskRunner`（引 handleChat/telegramChannel）与 `handleTaskControlAction`（组合根职责，Phase 5 后期处理），改由 import 使用这些助手；净减 157 行（9,814 → 9,657）。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + `/api/tools` 仍锁 53 工具名快照）；task e2e 补测：真网关 `GET /api/tasks` → 200（jobs 结构不变），无残留、18789 释放。
- 备份点：`git tag backup/pre-phase5-20261011`。

### 2026-10-11 — server-v2 Split Phase 5b: Tool Execution Cluster → chat-execution.ts (R)

- 按拆分路线图 Phase 5 **第 2 子步**：把 **executeToolImpl（1078 行工具执行主分发器）及其全部本地依赖** 字节级下沉到 `src/gateway/chat-execution.ts`（新，~1,310 行）。
- 搬移内容：`ArtifactEntry`/`ARTIFACT_LOG_LIMIT`/`artifactLog` + `recordArtifact`/`listArtifacts`（模块级 artifact 状态随搬）、路径守卫 `isPathInsideDirectory`/`realpathForGuard`、`resolveToolFilePath`、`rejectOfficeTextEdit`、`ToolResult`/`TaskControlResponse`/`ScheduleJobAction` 类型、`normalizeScheduleJobAction`/`isConfirmed`/`summarizeCronJob`/`normalizeDeliveryChannel`/`normalizeToolArgs`、`TEXT_SNAPSHOT_MAX_BYTES`/`ANALYSIS_INJECT_MAX_CHARS`/`resolveAnalysisTarget`/`readTextSnapshot`/`textTargetOf`、`executeTool`（plan-gate 薄包装）、`executeToolImpl`、`lastFilenameUsed` 本地状态——共 12 段 1359 行，用 `.backup/move-chat-execution.py` 字节级搬移，未手工重抄。
- **循环依赖处理**：`executeToolImpl` 内 `handleTaskControlAction`（闭包 handleChat/telegramChannel）与 `cronScheduler`（server-v2 本地单例）改为 **deps 注入**——`createExecuteTool(deps)` 闭包返回 `executeTool`，server-v2 组合根 `const executeTool = createExecuteTool({ handleTaskControlAction, cronScheduler })`；executeToolImpl 内部 10 处 cronScheduler 引用改 `deps.cronScheduler`。
- 修正第一阶段 typecheck 的 76 errors：header import 路径纠偏（ollama-client/office/image/file-batch/knowledge 在 `../tools` 系、plan-mode 非 plan-gate）+ 补齐 browser-tools(8)/desktop-tools(10)/request-guards/tool-registry/agent-builder-integration import + `lastFilenameUsed` 状态随搬 + 6 个待导出符号加 export + server-v2 import 回 `ToolResult`/`resolveToolFilePath`（/api/files 路由 6 处）。
- server-v2.ts 净减 1,356 行（9,657 → 8,301，组合根仍保留 `export { app, server }`）。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped（7 files，与基线一致）；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + `/api/tools` 仍锁 53 工具名快照）；e2e 补测：真网关 `/api/status` 200、`/api/flows` → 4、`/api/tasks` → 200，端口 18789 释放。
- 备份点：沿用 `git tag backup/pre-phase5-20261011`（5b 变更前已打）。

### 2026-10-11 — server-v2 Split Phase 5c-1: Chat-Loop Helpers → chat-handler.ts (S)

- 按拆分路线图 Phase 5 **第 3 子步**：把 handleChat 依赖的**专属辅助函数簇**（36 个符号，546 行）字节级下沉到 `src/gateway/chat-handler.ts`（新，~535 行），server-v2 改 import 使用，handleChat 本体仍在 server-v2（5c-2 再搬）。
- **簇闭包探查**（`.backup/phase5c-probe*.py`）：handleChat 实测 3168 行（1724-4891），引用 35 个本地符号；用"种子 + 簇外零引用收敛"确定随搬簇——辅助函数 + 常量 + 类型 + 模块级状态（`recordOrchestrationEvent`/`getPreemptSessionCount`/`incrementPreemptSessionCount`/`logToDaily`/`KB_AUTO_INJECT_RE`/`resolveWorkspaceFilePath`/`collectFileSnapshots`/`buildBrowserAck`/`buildDesktopAck`/`isBrowserHeavyResearchPage`/`BrowserSnapshotQuality`/`SnapshotDiagnostics`/`goalLikelyNeedsTextInput`/`parseSnapshotDiagnostics`/`evaluateBrowserSnapshotQuality`/`HandleChatResult`/`modelSwitchHintedSessions`/`maybeSuggestModelSwitch`/`buildMultimodalUserContent`/`MAX_TOOL_ARG_PARSE_RETRIES`/`TOOL_ARG_PARSE_RETRY_HINT`/`nctxProbe`/`NCTX_PROBE_TTL_MS`/`probeLlamaNctx`/`resolveHistoryBudgetTokens`/`computeSessionMetaAnswer`/`buildChatLogReport`/`MAX_TOOL_ROUNDS`/`ExecutionMode`/`SubagentProfile`/`OrchestrationEvent`/`OrchestrationSessionStats`/`orchestrationSessionStats`/`preemptSessionCounts`/`getOrchestrationSessionStats`）。
- **关键决策**：`inRound*` 4 个可变校准状态（`inRoundCtxCharPerToken`/`inRoundLastSentChars`/`inRoundAdaptiveBudget`/`inRoundBudgetModelKey`）与 `INROUND_*` 3 常量**留在 server-v2**——handleChat 每轮直接读写它们，而 **TS 禁止给 import 的 let 绑定赋值（TS2632）**；ESM live binding 运行时可共享，但类型层不允许，故状态留在组合根（handleChat 本体同文件），chat-handler 只搬纯函数。
- 验证：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped（7 files，与基线一致）；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + `/api/tools` 仍锁 53 工具名快照）。
- server-v2.ts 净减 532 行（8,301 → 7,769，组合根 `export { app, server }` 保留）；累计净减 ~3,045。
- 备份点：`git tag backup/pre-phase5c1-20261011`。

### 2026-10-11 — server-v2 Split Phase 5c-2: handleChat 本体下沉 → chat-handler.ts (T)

- 按拆分路线图 Phase 5 **第 4 子步（最高风险）**：把 **handleChat 本体 3,168 行（含 inRound* 轮内预算状态 12 行）** 字节级下沉到 `chat-handler.ts`，改造为 **`createChatHandler(deps)` 闭包工厂**——handleChat 从"函数声明"转为"工厂返回的函数表达式"，`return async function handleChat(...)` 直接复用原函数体（零手工重抄）。
- **精确区间用 ts AST 定位**（`tsbounds.js`）：handleChat = 1-indexed 1192-4359（词法配平曾因正则字面量中的花括号提前归零、错报 3334——踩坑后改用 TypeScript 编译器 API 拿函数节点 start/end，最可靠）。
- **依赖面分级处理**（`phase5c2-symmap.py` 反查 import→模块）：
  - 随搬：`inRound*` 7 状态 + `INROUND_*` 3 常量（与 handleChat 同文件，避开 TS2632 跨模块赋值限制）。
  - 注入（ChatHandlerDeps，10 项）：`executeTool`（createExecuteTool 闭包）、`telegramChannel`（live 单例）、`makeBroadcastForTask`（任务广播拦截）、`isOrchestrationSkillEnabled`、`resolveModelTier`、`KNOWLEDGE_DIR`、`skillsManager`、`buildPersonalityContext`、`renderFlowInstruction`、`activeTasks`。
  - 直接 import（handleChat 引用面 38→~55 符号）：multi-agent（OrchestrationTriggerState/callSecondary*/shouldRunPreflight/format*Hint/clampPreemptConfig）、file-op-v2（FileOp*/classifyFileOpType/buildFailureSignature/checkpoint 簇）、server-v2-text（sanitizeFinalReply/isBrowserAutomationRequest/separateThinkingFromContent 等 16 个）、browser/desktop-tools、flow-integration（flowsManager）、realtime（broadcastWS）、tools/knowledge（executeKnowledgeTool）、tools/office（parseDocPreview）、task-store（createTask/loadTask/saveTask/appendJournal）、task-runner（runTask/TaskState）、ollama-process-manager、agent-builder-integration（getWorkflowContextBlock）、skills-manager。
- **循环依赖处理**：chat-handler 不 import server-v2——10 个组合根单例全部 deps 注入；4 个调用方（cron/telegram/heartbeat/boot）均运行时延迟解析，装配顺序无关。
- **漏替换修复**：词法替换后 6 处未命中（对象简写 `{ isOrchestrationSkillEnabled }` 两处、`executeTool` 1 处、`telegramChannel` 2 处、`skillsManager`/`buildPersonalityContext`/`renderFlowInstruction`/`activeTasks` 各 1 处）→ 逐处锚定补齐；对象简写改为 `{ isOrchestrationSkillEnabled: deps.isOrchestrationSkillEnabled }`。
- **守卫测试随重构演进**：`server-v2-integrity.test.ts` 原断言"server-v2 仍定义 handleChat"已过时 → 改为断言组合根装配 `const handleChat = createChatHandler({`。
- 验证：`typecheck` 0 错；`npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + 53 工具名锁）。
- server-v2.ts 净减 3,163 行（7,769 → **4,606**，组合根 `export { app, server }` 保留）；chat-handler.ts ≈3,575；累计净减 ~6,208（原 10,814）。
- 备份点：`git tag backup/pre-phase5c2-20261011`。

### 2026-10-11 — server-v2 Split Phase 5c-3: handleTaskControlAction → chat-execution.ts (U)

- 按拆分路线图 Phase 5 **第 5 子步**：把 **handleTaskControlAction（任务控制动作分发器，243 行）** 字节级下沉到 `chat-execution.ts`，改造为 **`createTaskControlHandler(deps)` 闭包工厂**（ts AST 提取函数体，零手工重抄）。
- **依赖面极干净**（`phase5c3-dep.js` ts AST 分析）：本地依赖仅 `launchBackgroundTaskRunner` 1 个（组合根装配函数，内部闭包 handleChat/makeBroadcastForTask/telegramChannel）→ deps 注入；其余 16 个符号全部是已拆模块 import（task-integration 5 个 / task-store 9 个 / background-task-runner 1 个 / chat-execution 自带 isConfirmed）→ 直接 import，无循环。
- server-v2：删函数（1188-1430）+ 组合根装配 `const handleTaskControlAction = createTaskControlHandler({ launchBackgroundTaskRunner })`；`createExecuteTool({ handleTaskControlAction, cronScheduler })` 引用名不变。
- 验证：`typecheck` 0 错；`npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed（真网关 + 53 工具名锁）。
- server-v2.ts 净减 237 行（4,606 → **4,369**）；chat-execution.ts ≈1,670；累计净减 ~6,445（原 10,814）。
- 备份点：`git tag backup/pre-phase5c3-20261011`。

### 2026-10-11 — server-v2 Split Phase 6a+6b: 清 legacy + 补 lint/format 基建 (V)

- **Phase 6a — 物理删除死代码**：`server-legacy.ts`（10,476 行）、`reactor-legacy.ts`、`orchestrator.ts`（仅为 legacy 可加载的空 shim）、`golden-routing.test.ts`（894 行，测被 file-op-v2/multi-agent 取代的旧路由逻辑）。引用链完全闭环在 legacy 内部（生产代码零真实 import，仅注释提及），typecheck 0 错确认无残留。合计删除 ~21k 行死重量。
- **Phase 6b — eslint/prettier 基建**：
  - 新增 devDeps：eslint、prettier、typescript-eslint、eslint-config-prettier（102 包）。
  - `eslint.config.js`（flat config）：typescript-eslint recommended + 项目定制（no-explicit-any/ban-ts-comment/no-require-imports 关闭——小模型友好宽松；no-unused-vars 降 warn）→ **`npm run lint` 0 errors / 222 warnings**（存量 unused-vars 提示清单，不阻断；max-warnings 300 兜底）。
  - `.prettierrc` + scripts：`lint` / `lint:fix` / `format` / `format:check`（prettier 独立于 eslint，不把格式当 error，存量代码不被空白阻塞）。
  - `--fix` 自动修复 5 个 error：prefer-const ×4 + no-unused-expressions ×1（server-v2 1743 三元语句改 if/else，语义不变）。
- 验证：typecheck 0 错；npm test 70 passed/2 skipped；SMALLCLAW_SMOKE=1 smoke 2 passed（53 工具名锁）。
- 备份点：`git tag backup/pre-phase6a-20261011`。

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
