# server-v2.ts 拆分方案（规划文档）

> 状态：Phase 0（安全网）✅、Phase 1（config-bootstrap + 失败熔断）✅、Phase 2a（工具压缩纯函数 → tool-registry）✅、Phase 2b（buildTools 整簇 → tool-registry）✅、Phase 2c（filterToolsByIntent 簇 → tool-registry）✅、Phase 2d（applyToolPolicy policy 簇 → tool-registry）✅ 已完成并验证；Phase 1.5（Model-Busy 守卫）、Phase 3–6 待执行。`server-v2.ts` 现为 **9,885 行**（原 10,814，累计净减 929 行），业务行为字节级不变。
> 目标：把 `src/gateway/server-v2.ts`（**10,814 行 / 100+ 导出符号**）从巨型单体拆成按域组织的模块，保留 `server-v2.ts` 作为"组合根（composition root）"——只做模块装配、Express 路由、SSE 接线，业务细节下沉到子模块。

---

## 1. 现状盘点

| 项 | 数据 |
|---|---|
| 核心文件 | `src/gateway/server-v2.ts` — 10,814 行 |
| 已抽出的 helper（证明模式可行） | `server-v2-text.ts` (311)、`server-v2-search.ts` (196)、`run-command-router.ts` (233) |
| 历史遗留（已被 tsconfig `exclude` 排除，不参与编译） | `server-legacy.ts` (10,476)、`reactor-legacy.ts` (4) |
| 已独立的网关子模块 | `session.ts`、`task-runner.ts`、`background-task-runner.ts`、`browser-tools.ts`、`desktop-tools.ts`、`mcp-manager.ts`、`skills-manager.ts`、`flow-artifacts.ts`、`context-injection.ts`、`orchestrator.ts`、`verification-flow.ts`、`boot.ts` 等 |

**结论**：server-v2.ts 当前仍承担"配置引导 + 工具定义装配 + SSE/WS 广播 + 聊天主循环 + 流程/验证接线 + 各类守卫"等多重职责，是唯一的"上帝文件"。拆分方向清晰——把上面这些职责逐个下沉，复用已验证的抽出方式。

---

## 2. 拆分原则

1. **先建安全网，再动刀**：第一步加 `typecheck` 脚本与网关冒烟测试，确保每阶段都能客观验证"行为不变"。
2. **每阶段可独立回滚**：一次只搬一类职责，搬完即通过 `tsc --noEmit` + 测试 + 冒烟，再提交。
3. **依赖只向下，禁止循环**：子模块只依赖叶子模块（`config`、`session`、各 tools），需要跨模块状态时通过函数参数注入，不让 `server-v2.ts` 与子模块互相 import。
4. **输出字节级一致**：工具定义、SSE 协议、API 响应格式搬移前后必须完全一致（用快照/契约测试锁住）。
5. **不重写逻辑**：仅做"移动 + 重导出"，不改行为；行为优化留到拆分完成之后。

---

## 3. 目标模块地图

| 目标文件 | 承接的职责（来自 server-v2.ts） | 风险 |
|---|---|---|
| `gateway/config-bootstrap.ts` | cwd 推导、workspace.path 合法性检查、配置装配（部分已在 `boot.ts`，合并至此） | 低 |
| `gateway/request-guards.ts` | 重复失败熔断（`noteToolFailure`/`resetToolFailure`/`toolFailureTracker`）、safe-command 路由判定 | 低 |
| `gateway/tool-registry.ts` | 全部工具 schema/定义装配（`TOOL_PROFILES`、delegate/subagent、browser/desktop/system 工具定义、`/api/tools` 输出） | 中（需保证定义字节一致） |
| `gateway/realtime.ts` | WebSocket `wss`、SSE 流辅助、`broadcastWS` | 中 |
| `gateway/flow-integration.ts` | 流程产物抽取与 verification-flow 接线（逻辑已在 `flow-artifacts.ts`，此处只搬编排） | 中 |
| `gateway/chat-handler.ts` | 核心 `handleChat()` 循环（建提示词 → 单次 LLM 调用 → 工具分发 → 流式回传） | 高（重度闭包/状态） |
| `gateway/server-v2.ts`（收尾） | 仅保留：模块 import、Express 路由注册、SSE/WS 接线、调用上述 handler | — |

---

## 4. 分阶段路线

### Phase 0 — 安全网（✅ 已完成并验证）
- ✅ `package.json` 增加 `"typecheck": "tsc --noEmit"` 与 `"smoke": "vitest run tests/smoke-gateway.test.ts"`。
- ✅ `tests/server-v2-integrity.test.ts`（常开、安全，**不 import 巨型文件**）：对 `server-v2.ts` 源码做静态符号守护（handleChat 仍在、仍 `export { app, server }`）+ 真实 import 已抽出的 helper（`server-v2-text`/`run-command-router`）校验导出。
- ✅ `tests/smoke-gateway.test.ts`（默认 `skipIf`，仅 `SMALLCLAW_SMOKE=1` 启用）：**子进程**启动真实网关 → 探 `/api/status` 返回 200 → **按进程树 + 按端口兜底强杀**（tsx 会 fork 子进程，只杀父进程清不干净）。
- ⚠️ 关键教训：不能 `import server-v2.ts` 做金丝雀——它在模块顶层 `server.listen()` 且加载即读配置，import 会真起服务绑端口。端口探测也不能靠 `GATEWAY_PORT` env（被 `config.gateway.port` 覆盖），须解析启动日志里的实际绑定端口。
- 验收（已通过）：`typecheck` 0 错；默认 `npm test` 71 passed / 1 skipped（冒烟跳过、无服务）；`SMALLCLAW_SMOKE=1 npm test` 真起网关→200→无残留。

### Phase 1 — 配置引导 + 守卫（低风险）✅ 已完成并验证
- ✅ 新增 `src/gateway/config-bootstrap.ts`：cwd 规范化、config 加载、workspace.path 校验、配置目录推导、端口/主机推导、`repairLegacyTaskChannelMetadata` 全部下沉；仅依赖叶子模块，无循环依赖。
- ✅ 新增 `src/gateway/request-guards.ts`：**仅搬失败熔断**（`noteToolFailure` + `toolFailureTracker` + `TOOL_FAILURE_LIMIT`）+ 新增 `resetToolFailure(sessionId)` 封装（承接 `executeTool` 成功分支原先直接 `toolFailureTracker.delete` 的逻辑，行为一致）。
- ⚠️ **Model-Busy 守卫（`let isModelBusy` 模块级可变单例，跨 11 处读写 + 4 个闭包访问器）耦合度高，属高风险抽取项，已刻意从 Phase 1 拆出，留作后续独立谨慎小步（建议 Phase 1.5），本次未碰。**
- 验收（已通过）：`typecheck` 0 错；默认 `npm test` 71 passed / 1 skipped（冒烟跳过）；`SMALLCLAW_SMOKE=1 npm test` 真起网关→200→无残留。

### Phase 2 — 工具定义装配（最大行数收益）

**前置（已完成 ✅）**：`/api/tools` 快照锁已写入 `tests/smoke-gateway.test.ts`（受 `SMALLCLAW_SMOKE=1` 门控），当前锁定 **53 个工具名**字节级基线；抽取时任何误删/改名都会让快照比对失败。

**渐进式子步骤（一点一点来）**：
- **Phase 2a（✅ 已完成并验证）**：新建 `src/gateway/tool-registry.ts`，搬入 3 个**零耦合纯函数**：
  - `getModelTier()`(原 1149) — 模型档位推断，经 `require('../config/config.js')` 读取配置，**不依赖 server-v2 顶层单例**；
  - `compactToolDescription()`(原 1207) — 纯首句截断；
  - `applyToolCompactness()`(原 1214) — 按档位压缩 tool 描述/参数。
  - `server-v2.ts` 改为 `import { getModelTier, applyToolCompactness } from './tool-registry'`；`ModelTier` 类型改为 `export`（类型侧依赖，`import type` 编译期擦除，杜绝循环依赖）。
  - ⚠️ **buildTools 实际耦合比原评估更重**：其尾段(1705–1709)调用了 5 个工具构建器——`getKnowledgeToolDefinitions`(来自 `../tools/knowledge`)、`planToolDefinitions`(来自 `./plan-mode`)、以及 server-v2 内部 3 个 `agentShellEnabled`/`shellExecToolDefinition`/`buildMcpToolDefinitions`。原"56 个纯数据定义、0 个 fn 指针"只覆盖了中段(1241–~1700)的数据，`buildTools` 并非可整体原样搬移。因此 **buildTools 本轮未搬**，留作下一步单独提案（见 Phase 2b）。
  - 验收（已通过）：`typecheck` 0 错；默认 `npm test` 71 passed / 2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（字节级不变），网关启动/清理无残留。
- **Phase 2b（✅ 已完成并验证，采用路径 A）**：把 `buildTools` 整簇搬入 `tool-registry.ts`：
  - 搬入：`buildTools()`（~430 行：56 个工具定义 + 容器内装配）、`agentShellEnabled`、`shellExecToolDefinition`、MCP 簇（`MCP_TOOL_PREFIX`/`sanitizeMcpNamePart`/`normalizeMcpInputSchema`/`McpToolEntry`/`collectMcpToolEntries`/`buildMcpToolDefinitions`）。
  - 依赖的 ~10 个工具定义提供方（browser/desktop/office/image/file-batch/knowledge/plan/mcp/agent-builder/multi-agent）均为叶子模块；全 src 扫描确认**只有** `tool-registry.ts` 的 `import type { ModelTier }` 引用 server-v2（编译期擦除、运行时无环）。
  - **唯一真障碍 — `isOrchestrationSkillEnabled`**（依赖 server-v2 的 `skillsManager` 单例，无法平移）：改为通过 `buildTools(tier?, deps?)` 的 `deps.isOrchestrationSkillEnabled` 参数注入，server-v2 在 3 个调用点（含 `/api/tools` 端点）传入真实实现；`isOrchestrationSkillEnabled` 仍留在 server-v2（3945/9938 行亦用）。此为唯一必要的微小签名调整，行为不变。
  - server-v2.ts 净减 ~581 行（10,814 → 10,115，累计净减 699 行）；tool-registry.ts 现 ~664 行。
  - 验收（已通过）：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（含 `request_secondary_assist`，证明注入正确、行为字节级不变），网关启动/清理无残留。
- **Phase 2c（部分完成 ✅：filterToolsByIntent 簇已搬；applyToolPolicy 因耦合深拆出为 Phase 2d）**：
  - ✅ **已搬 `filterToolsByIntent` 簇**（原 3133-3203）：`filterToolsByIntent()` + 11 个 `CAT_*` 常量 + 紧邻的纯函数 `detectToolCategories()`（原 850）。**零外部/server-v2 状态依赖**（仅彼此 + `ModelTier` 类型 + `console`/`Set`），干净整体搬入 `tool-registry.ts` 并 `export`；server-v2 改为 `import { filterToolsByIntent, detectToolCategories }`（`detectToolCategories` 在 1035 行亦有调用）。server-v2.ts 净减 94 行（10,115 → 10,020，累计净减 794 行）；tool-registry.ts 763 行。
  - ⚠️ **`applyToolPolicy`（原 1324，连带 `checkToolDenied` 1347）本轮未搬**：探查发现其依赖簇远超"纯数据"——牵连 5 个 helper（`matchToolPattern`/`profileAllowsTool`/`resolveAgentToolPolicy`/`resolveGlobalEnabledSet`/`sessionGlobalAllowlist`）+ 9 个 `*_TOOL_NAMES` 集合 + `TOOL_GROUPS` + 外部 import（`isPlanTool`/`getAgentById`/`getDefaultAgent`）。`profileAllowsTool`/`TOOL_GROUPS` 还被 server-v2 别处（1587 等）使用，牵一发动全身。拆为独立 **Phase 2d** 谨慎小步。
  - 验收（filterToolsByIntent 部分，已通过）：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（`filterToolsByIntent` 正是该端点核心路径，字节级不变），网关启动/清理无残留。备份点：`git tag backup/pre-phase2c-20261011`。
- **Phase 2d（✅ 已完成并验证）**：把 `applyToolPolicy` + `checkToolDenied` + 其 policy helper 簇搬入 `tool-registry.ts`：
  - 搬入（11 行组 + `sessionAgentBindings` 模块级 Map）：`*_TOOL_NAMES` 集合（FILE/SHELL/WEB/MEMORY/SCHEDULE/TASK/ORCHESTRATION + `KNOWLEDGE_TOOL_NAMES` 展开）、`TOOL_GROUPS`、`matchToolPattern`、`profileAllowsTool`、`resolveSessionAgent`、`resolveAgentToolPolicy`、`resolveGlobalEnabledSet`、`applyToolPolicy`、`checkToolDenied`。
  - **选择性搬移**：`KNOWLEDGE_DIR`/`KB_AUTO_INJECT_RE`/`ArtifactEntry`/`recordArtifact`/`listArtifacts` 与 policy 簇**交错**在同一区块，但它们被 server-v2 外部（3829/3834/3866/7079/7129-7156/1591/1871-1910 等）调用，故**留在 server-v2**，未搬。
  - **关键耦合处理**：`sessionAgentBindings` 被 server-v2 7290-7291 行直接 `set`/`delete`（live Map 单例）→ 改为 `export const` 由 server-v2 `import` 同一实例（同 Phase 2b `MCP_TOOL_PREFIX` 模式），行为不变。
  - 叶子 import 新增：`isPlanTool`(plan-mode)、`AGENT_BUILDER_TOOL_NAMES`(agent-builder-integration)、`KNOWLEDGE_TOOL_NAMES`(tools/knowledge)、`getAgentById`/`getDefaultAgent`(config/config)；全验证无循环依赖。
  - server-v2.ts 净减 135 行（10,020 → 9,885，累计净减 929 行）；tool-registry.ts 915 行。
  - 验收（已通过）：`typecheck` 0 错；默认 `npm test` 71 passed/2 skipped；`SMALLCLAW_SMOKE=1 npm run smoke` 2 passed，`/api/tools` 仍锁定 53 个工具名（字节级不变），网关启动/清理无残留。备份点：`git tag backup/pre-phase2d-20261011`。

- 验收：**搬移前后 `/api/tools` 输出逐字节一致**（快照比对通过）；`tsc` 0 错。

### Phase 3 — 实时通道
- 搬 `realtime.ts`（SSE/WS 广播）。
- 验收：用 `curl -N` 或测试客户端连 SSE，确认事件格式不变。

### Phase 4 — 流程/验证接线
- 搬 `flow-integration.ts`。
- 验收：跑一个最小流程（如数据整理报告），产物可见性与之前一致。

### Phase 5 — 聊天主循环（最高风险，放最后）
- 搬 `handleChat()` 到 `chat-handler.ts`，`server-v2.ts` 仅 `import { handleChat } from './chat-handler'`。
- 验收：端到端冒烟——向本地 llama（或 mock provider）发一条消息，确认能流式返回且工具调用路径不变。

### Phase 6 — 清理遗留
- 删除 `server-legacy.ts`、`reactor-legacy.ts`；补 `eslint` + `prettier`（当前无 lint 配置，见审查意见 P2-6）。

---

## 5. 循环依赖防范

- `chat-handler.ts` 不得 `import` 回 `server-v2.ts`；它只 import 叶子依赖（`config`、`session`、`tools/*`、`providers/*`）。
- 跨模块需要的共享状态（如 `TaskRunner` 实例、`hookBus`、`getConfig`）由 `server-v2.ts` 在启动时**构造并作为参数传入**子模块的初始化函数，而非子模块自行 `require` 顶层单例。
- 若发现某职责强依赖 `server-v2` 内部闭包变量，先把它提升为 `session.ts`/独立 store 的字段，再搬。

---

## 6. 验证策略（每阶段必做）

1. `npm run typecheck` → 必须 0 错误（`strict` 已开）。
2. `npm test`（vitest）→ 全绿；Phase 2/3 新增快照/契约测试。
3. 端到端冒烟（Phase 5 必需）：启动网关，发送一条真实聊天，确认流式回传与工具调用路径无回归。
4. 提交信息标注本阶段搬运了哪些函数，便于 `git bisect` 回滚。

---

## 7. 验收标准（整体完成）

- `server-v2.ts` ≤ ~500 行，且不含具体业务逻辑（只剩路由注册与模块装配）。
- 无新增 `*-legacy.ts`；原 legacy 文件已删除。
- 全量 `tsc --noEmit` 0 错、测试全绿、网关端到端冒烟通过。
- 引入 lint 配置，CI 跑 typecheck + test + lint。

---

## 8. 备注

- 该方案只解决"单体文件"这一个问题（审查意见 P0-1）。代码层面的其它项（测试薄弱、console.* 横飞、README 与代码能力脱节）需另立任务跟进。
- README 的架构描述矛盾已在 F 项（README Overhaul）修正：核心是单趟 `handleChat()`，多智能体编排（`src/orchestration/`）为可配置开关，与代码一致。
