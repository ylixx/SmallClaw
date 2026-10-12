/**
 * server-v2.ts - SmallClaw v2 Gateway
 * 
 * Architecture: Native Ollama Tool Calling
 * Memory: Reads SOUL.md, IDENTITY.md, USER.md, MEMORY.md from workspace
 * Search: Tavily / Google Custom Search API / Brave / DuckDuckGo
 * Logging: Daily session logs in memory/
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';


import {getConfig} from '../config/config';

import {mergeOptimizationTier, tierFromContextWindow} from './server-v2-text';
import {broadcastWS} from './realtime';


import {createExecuteTool, createTaskControlHandler} from './chat-execution';
import {createChatHandler, probeLlamaNctx} from './chat-handler';



import {addMessage, getHistory, setWorkspace, clearHistory, cleanupSessions} from './session';
import {hookBus} from './hooks';

import {runBootMd} from './boot';

import {TaskState} from './task-runner';










import {CronScheduler} from './cron-scheduler';
import {HeartbeatRunner} from './heartbeat-runner';

import {TelegramChannel} from './telegram-channel';
import {callSecondaryPreflight} from '../orchestration/multi-agent';
import {createTask, appendJournal, listTasks} from './task-store';
import {BackgroundTaskRunner} from './background-task-runner';





import {registerSystemRoutes} from './api-system';
import {registerBootstrapRoutes} from './api-bootstrap';

import {registerMiscRoutes} from './api-misc';
import {registerMcpRoutes} from './api-mcp';
import {registerSettingsRoutes} from './api-settings';
import {registerSkillsRoutes} from './api-skills';
import {registerTasksRoutes} from './api-tasks';
import {registerFlowRoutes} from './api-flows';
import {resolveChannelsConfig, registerChannelsRoutes} from './api-channels';
import {registerSchedulesRoutes} from './api-schedules';
import {registerAgentRoutes} from './api-agents';
import {createServerLifecycle} from './server-bootstrap';
import {registerChatRoutes} from './chat-routes';
import {registerKbRoutes} from './api-kb';
import {registerFileRoutes} from './api-files';
import {skillsManager, isOrchestrationSkillEnabled, renderFlowInstruction, recoverSkillsIfEmpty, setOrchestrationEnabled} from './skills-bootstrap';
import {buildPersonalityContext} from './personality-context';
import {createHeartbeatDomain, registerHeartbeatRoutes} from './task-heartbeat';
import {buildWebhookRouter, resolveHookConfig} from './webhook-handler';
import {internalAgentTaskRouter} from './internal-agent-task';

import {normalizeCwd, validateWorkspacePath, getConfigDirPath, derivePort, deriveHost, repairLegacyTaskChannelMetadata, KNOWLEDGE_DIR} from './config-bootstrap';

import {getModelTier} from './tool-registry';
import {getModelBusy} from './model-busy-guard';

// ─── Config ────────────────────────────────────────────────────────────────────
// cwd 规范化 / 配置加载 / workspace 路径校验 / 端口推导 已下沉到 config-bootstrap.ts
normalizeCwd();

const config = getConfig().getConfig();
validateWorkspacePath(config);
const CONFIG_DIR_PATH = getConfigDirPath();
const PORT = derivePort(config);
const HOST = deriveHost(config);

{
  const cleaned = cleanupSessions();
  if (cleaned.deleted > 0) {
    console.log(`[session] Cleaned up ${cleaned.deleted} stale automated session file(s).`);
  }
  repairLegacyTaskChannelMetadata();
}

// Search config is now read dynamically from config on each request
// so changing keys via settings takes effect immediately without restart

// Active tasks (keyed by session)
const activeTasks: Map<string, TaskState> = new Map();








// Safe commands allowlist for run_command

// run_command routing now lives in ./run-command-router.ts - extracted so the
// allowlist logic can be unit-tested without booting the whole gateway.
// See resolveRunCommand() there.

// ── Real shell escape hatch (opt-in, OFF by default) ─────────────────────────
// src/tools/shell.ts already implements a full shell (PTY + workspace


// ── Sub-Agent Tool Profiles (moved to server-v2-text.ts as TOOL_PROFILES) ───────────────

// ─── Model-Busy Guard (state owned by model-busy-guard.ts; see getModelBusy/setModelBusy) ──

let lastMainSessionId = 'default';



// ─── CronScheduler Init ────────────────────────────────────────────────────────

const cronStorePath = path.join(CONFIG_DIR_PATH, 'cron', 'jobs.json');
const cronScheduler = new CronScheduler({
  storePath: cronStorePath,
  handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
    handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
  broadcast: broadcastWS,
  getIsModelBusy: getModelBusy,
  deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
  getMainSessionId: () => lastMainSessionId || 'default',
  injectSystemEvent: (sessionId, text, job) => {
    addMessage(sessionId, {
      role: 'assistant',
      content: `[System Event: ${job.name}]\n${text}`,
      timestamp: Date.now(),
    });
    broadcastWS({
      type: 'system_event',
      sessionId,
      source: 'cron',
      jobId: job.id,
      jobName: job.name,
      text,
    });
  },
  spawnBackgroundTask: async (job) => {
    try {
      // ── Step 1: ask the preflight advisor to generate a real task plan ──────
      // Awaited properly so the cron scheduler gets a real taskId back.
      let taskTitle = job.name;
      let plan: Array<{ index: number; description: string; status: 'pending' }> = [];

      try {
        const preflight = await callSecondaryPreflight({ userMessage: job.prompt });
        if (preflight?.task_plan && preflight.task_plan.length > 0) {
          taskTitle = preflight.task_title || job.name;
          plan = preflight.task_plan.map((desc: string, i: number) => ({
            index: i,
            description: desc,
            status: 'pending' as const,
          }));
          console.log(`[CronScheduler] Preflight generated ${plan.length} steps for "${job.name}"`);
        }
      } catch (preflightErr: any) {
        console.warn(`[CronScheduler] Preflight unavailable for "${job.name}", using default plan:`, preflightErr.message);
      }

      // ── Step 2: fall back to a smart default plan if preflight gave nothing ─
      if (plan.length === 0) {
        const prompt = job.prompt.toLowerCase();
        const isNews = /news|summar|stories|headlines|brief|report|digest/.test(prompt);
        const isResearch = /research|find|look up|search|gather|collect/.test(prompt);
        const isEmail = /email|inbox|gmail|message/.test(prompt);

        if (isNews) {
          plan = [
            { index: 0, description: 'Search for today\'s top news stories from multiple sources', status: 'pending' },
            { index: 1, description: 'Fetch and read full article content from results', status: 'pending' },
            { index: 2, description: 'Synthesize stories into a concise 3-5 bullet summary with sources', status: 'pending' },
            { index: 3, description: 'Deliver final summary to user', status: 'pending' },
          ];
        } else if (isResearch) {
          plan = [
            { index: 0, description: 'Search for relevant information on the topic', status: 'pending' },
            { index: 1, description: 'Read and extract key details from top results', status: 'pending' },
            { index: 2, description: 'Compile findings into a clear summary', status: 'pending' },
          ];
        } else if (isEmail) {
          plan = [
            { index: 0, description: 'Check inbox for new messages', status: 'pending' },
            { index: 1, description: 'Summarize important emails', status: 'pending' },
          ];
        } else {
          plan = [
            { index: 0, description: `Execute: ${job.prompt.slice(0, 120)}`, status: 'pending' },
            { index: 1, description: 'Review results and deliver output to user', status: 'pending' },
          ];
        }
      }

      // ── Step 3: create the task and launch the runner ────────────────────────
      const cronSessionId = `cron_${job.id}`;
      const task = createTask({
        title: taskTitle,
        prompt: job.prompt,
        sessionId: cronSessionId,
        channel: 'web',
        plan,
      });
      appendJournal(task.id, { type: 'status_push', content: `Scheduled job "${job.name}" launched as background task (${plan.length} steps)` });
      const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
      runner.start().catch((err: any) => console.error(`[CronScheduler] Task ${task.id} error:`, err.message));
      broadcastWS({ type: 'cron_task_spawned', jobId: job.id, jobName: job.name, taskId: task.id });
      return { taskId: task.id, sessionId: cronSessionId };
    } catch (err: any) {
      console.error('[CronScheduler] spawnBackgroundTask failed:', err.message);
      return null;
    }
  },
});

// ─── Telegram Channel Init ─────────────────────────────────────────────────────────

const telegramChannel = new TelegramChannel(
  resolveChannelsConfig().telegram,
  {
    handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
      handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
    addMessage,
    getIsModelBusy: getModelBusy,
    broadcast: broadcastWS,
  }
);

const heartbeatRunner = new HeartbeatRunner({
  workspacePath: getConfig().getWorkspacePath(),
  configPath: path.join(CONFIG_DIR_PATH, 'heartbeat', 'config.json'),
  handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
    handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
  getMainSessionId: () => lastMainSessionId || 'default',
  getIsModelBusy: getModelBusy,
  broadcast: broadcastWS,
  deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
});

// --- Hook: gateway:startup -> run BOOT.md ------------------------------------
function buildBootStartupSnapshot(workspacePath: string): string {
  const lines: string[] = [];
  lines.push(`workspace_path: ${workspacePath}`);

  try {
    const blocked = listTasks({ status: ['paused', 'stalled', 'needs_assistance'] }).slice(0, 12);
    if (blocked.length === 0) {
      lines.push('blocked_tasks: none');
    } else {
      lines.push('blocked_tasks:');
      for (const t of blocked) {
        const total = Math.max(1, Number(t.plan?.length || 0));
        const step = Math.min(total, Math.max(1, Number(t.currentStepIndex || 0) + 1));
        lines.push(`- [${t.id}] [${t.status}] ${t.title} (step ${step}/${total})`);
      }
    }
  } catch (err: any) {
    lines.push(`blocked_tasks: unavailable (${String(err?.message || err || 'unknown')})`);
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterdayDate = new Date(now.getTime() - (24 * 60 * 60 * 1000));
  const yesterday = yesterdayDate.toISOString().slice(0, 10);
  const memDir = path.join(workspacePath, 'memory');
  const todayMem = path.join(memDir, `${today}.md`);
  const yesterdayMem = path.join(memDir, `${yesterday}.md`);

  // Inject actual memory content so LLM doesn't need to read files during boot
  const memFileToRead = fs.existsSync(todayMem) ? todayMem : fs.existsSync(yesterdayMem) ? yesterdayMem : null;
  if (memFileToRead) {
    try {
      const memContent = fs.readFileSync(memFileToRead, 'utf-8').trim();
      const memFilename = path.basename(memFileToRead);
      lines.push(`memory_content (${memFilename} — last 3000 chars):`);
      lines.push(memContent.slice(-3000));
    } catch {
      lines.push('memory_content: unreadable');
    }
  } else {
    lines.push('memory_content: no memory file found for today or yesterday');
  }

  try {
    const dirents = fs.readdirSync(workspacePath, { withFileTypes: true });
    const topFiles = dirents.filter(d => d.isFile()).map(d => d.name);
    const tmpFiles = topFiles.filter((f) => /_tmp(\.|$)/i.test(f)).slice(0, 20);
    lines.push(`tmp_files: ${tmpFiles.length ? tmpFiles.join(', ') : 'none'}`);

    const todoHead: string[] = [];
    for (const file of topFiles.slice(0, 200)) {
      try {
        const head = fs.readFileSync(path.join(workspacePath, file), 'utf-8')
          .split('\n')
          .slice(0, 5)
          .join('\n');
        if (/\bTODO\b/i.test(head)) {
          todoHead.push(file);
          if (todoHead.length >= 20) break;
        }
      } catch {
        // skip unreadable files
      }
    }
    lines.push(`todo_in_first_5_lines: ${todoHead.length ? todoHead.join(', ') : 'none'}`);
  } catch (err: any) {
    lines.push(`workspace_scan: unavailable (${String(err?.message || err || 'unknown')})`);
  }

  return lines.join('\n');
}

hookBus.register('gateway:startup', async ({ workspacePath }) => {
  const bootSessionId = 'boot-startup';
  setWorkspace(bootSessionId, workspacePath);
  clearHistory(bootSessionId);
  const startupSnapshot = buildBootStartupSnapshot(workspacePath);
  await runBootMd(workspacePath, async (message, sessionId, sendSSE) => {
    const bootContext = [
      'CONTEXT: Internal startup BOOT.md turn. All data has been pre-fetched and is in the snapshot below.',
      'Do NOT call any tools. Read the snapshot and write a 2-3 sentence startup summary.',
      '[BOOT STARTUP SNAPSHOT - pre-fetched runtime data, no tools needed]',
      startupSnapshot,
      '[/BOOT STARTUP SNAPSHOT]',
    ].join('\n\n');
    const effectiveSessionId = sessionId || bootSessionId;
    setWorkspace(effectiveSessionId, workspacePath);
    const result = await handleChat(message, effectiveSessionId, sendSSE, undefined, undefined, bootContext);
    if (result?.text) {
      broadcastWS({ type: 'boot_greeting', text: result.text, sessionId: effectiveSessionId });
    }
    return { text: result.text };
  });
});

// --- Hook: command:new -> snapshot session before reset -----------------------
hookBus.register('command:new', async ({ sessionId, workspacePath }) => {
  const history = getHistory(sessionId, 10);
  if (history.length === 0) return;

  const memDir = path.join(workspacePath, 'memory');
  fs.mkdirSync(memDir, { recursive: true });

  const stamp = new Date().toISOString().replace('T', '_').slice(0, 16).replace(':', '-');
  const slug = String(sessionId || '').slice(0, 8) || 'default';
  const outPath = path.join(memDir, `${stamp}-${slug}.md`);
  const lines = history.map((m) => `**${m.role}**: ${String(m.content || '').slice(0, 300)}`);
  fs.writeFileSync(outPath, `# Session snapshot - ${stamp}\n\n${lines.join('\n\n')}\n`, 'utf-8');
  console.log(`[hooks:command:new] Saved session snapshot -> ${path.basename(outPath)}`);
});


// ─── Session Logger ────────────────────────────────────────────────────────────


// ─── Tool Definitions ──────────────────────────────────────────────────────────

// ── Tool description two-stage (short/full) ────────────────────────────────
// Tool descriptions are the single biggest prompt cost. Tiers decide how much
// to compress: small (aggressive) swaps to short descriptions (manual
// shortDescription when the definition provides one, else first sentence ≤180
// chars) and trims parameter descriptions to ≤60 chars; mid keeps a richer
// short form (≤300 chars, params ≤120); large keeps everything.
// Parameters/schema stay intact so native function-call wiring never breaks.
//
// IMPORTANT: the tier is NOT a pure "parameter size" classification. Local
// deployments run BIGGER models with SHORTER contexts (KV cache memory), so a
// 9B model often fits far less prompt than a 2B at -c 128000. resolveModelTier
// therefore merges two dimensions and takes the more aggressive one:
//   - byCtx    : live n_ctx / configured window  → hard constraint (fits?)
//   - byParams : parameter size                   → soft constraint (follows?)
export type ModelTier = 'small' | 'mid' | 'large';

// Synchronous parameter-size inference (fallback only; see resolveModelTier).
// (moved) getModelTier() → ./tool-registry.ts

// Effective context window from the same sources as resolveHistoryBudgetTokens:
// live llama-server probe (follows the RUNNING server, e.g. -c 128000) first,
// then the preset's context_window / server.ctx_size, else null.
async function probeEffectiveNctx(): Promise<number | null> {
  try {
    const raw = getConfig().getConfig() as any;
    const llm = raw?.llm || {};
    const preset = llm.presets?.[String(llm.active_preset || '')];
    if (preset) {
      if (preset.provider === 'llama_cpp') {
        const endpoint = String(preset.providers?.llama_cpp?.endpoint || 'http://localhost:8080');
        const modelPath = String(preset.server?.model_path || preset.providers?.llama_cpp?.model || '');
        const live = await probeLlamaNctx(endpoint, modelPath);
        if (live) return live;
      }
      const ctxWindow = Number(preset.context_window ?? preset.server?.ctx_size);
      if (Number.isFinite(ctxWindow) && ctxWindow > 0) return ctxWindow;
    }
  } catch {
    // fall through
  }
  return null;
}

// Merged optimization tier: explicit config > min(byCtx, byParams) > byParams.
async function resolveModelTier(): Promise<ModelTier> {
  try {
    const raw = getConfig().getConfig() as any;
    const explicit = String(raw?.models?.tier || '').trim().toLowerCase();
    if (explicit === 'small' || explicit === 'mid' || explicit === 'large') return explicit;
  } catch {
    // fall through to probe
  }
  const byParams = getModelTier();
  const nctx = await probeEffectiveNctx();
  if (nctx == null) return byParams;
  // Take the more aggressive dimension: short contexts are a hard constraint
  // (9B with 8-16K must compress to fit); weak small models need short prompts
  // even with a big window (2B at 128K still follows short descriptions better).
  return mergeOptimizationTier(tierFromContextWindow(nctx), byParams);
}

// (moved) compactToolDescription() + applyToolCompactness() → ./tool-registry.ts





// Knowledge auto-injection: questions that clearly reference stored material
// trigger a local RAG lookup. Kept deliberately narrow so everyday chat is
// never delayed or polluted by a search.

// ─── Artifact log: what tools produced/changed in this gateway run ────────────












// ─── Path Guard ───────────────────────────────────────────────────────────────





// ─── Tool Execution ────────────────────────────────────────────────────────────











// ─── Browser Tool Result Interceptor (Multi-Agent) ──────────────────────────
// When multi-agent orchestrator is active, the LLM should NEVER see raw browser
// snapshot data — only the secondary AI (via getBrowserAdvisorPacket) gets that.
// The LLM receives a short acknowledgment so it knows the tool ran, then waits
// for the advisor's directive telling it what to do next.


// (goalIsInteractiveAction moved to server-v2-text.ts)









/**
 * Convert a user message into multimodal content when it carries image
 * attachments (front-end format: "\n\n[attached file] <path>"). Image files
 * are read, base64-encoded and sent as image_url parts — the llama.cpp
 * backend (openai-compat) passes them through to the mmproj vision encoder.
 * Non-image attachments and unreadable paths stay as plain text (the agent
 * reads those via doc_inspect / read_file as before).
 */
/**
 * One-shot, per-session nudge: if the user has multiple model presets and the
 * current request looks heavy (large accumulated context or bulk-task wording),
 * send an SSE info hint pointing at the preset switcher. Never throws.
 */


// ── Tool-call argument parse failure: corrective retry ──────────────────────────
// Small/local models (e.g. llama.cpp 9B) sometimes emit tool-call arguments that
// are not valid JSON (long payloads truncated or escaping broken). llama.cpp
// rejects them server-side with a 500. Instead of surfacing the error directly,
// feed the model one corrective hint and retry once.

/**
 * Resolve the chat-history token budget from the ACTIVE model's context window:
 *   budget = clamp(window * 0.5, 8000, 60000)
 * Window sources, in priority order:
 *   1. preset.context_window   (explicit, user-configurable per model profile)
 *   2. preset.server.ctx_size  (local llama.cpp presets; unset = model native)
 *   3. 131072 default for cloud OpenAI-compatible models (128K+ modern models)
 * An explicit SMALLCLAW_HISTORY_BUDGET_TOKENS env var overrides everything, so
 * nothing is hard-locked: a 128K model gets a large history, a 48K local model
 * gets a smaller one automatically.
 */
// Live n_ctx probe cache: llama.cpp context follows the RUNNING server, never a
// hard-coded preset value. Keyed by endpoint+model so switching models re-probes.
// 30s TTL keeps per-chat overhead at zero after the first probe.



// ── In-round context budget: cross-turn shared state ───────────────────────
// Calibration + adaptive budget live at MODULE level so they persist across
// chat turns (per-turn state would reset every request and never learn the
// real chars→tokens density of the active model).


/**
 * Deterministically answer "how many exchanges / what was the last exchange"
 * straight from the session ledger. Returns '' when the message is not a
 * confident meta-question (then the model answers with the injected ledger).
 */

/**
 * Compile the conversation ledger into a self-contained HTML chat-log report
 * (no model involved). Returns { summary, html } or null when empty.
 */


// ─── SSE + Routes ──────────────────────────────────────────────────────────────

function launchBackgroundTaskRunner(taskId: string): void {
  const runner = new BackgroundTaskRunner(taskId, handleChat, makeBroadcastForTask(taskId), telegramChannel);
  runner.start().catch(err => console.error(`[BackgroundTaskRunner] task_control start ${taskId} error:`, err.message));
}

const handleTaskControlAction = createTaskControlHandler({ launchBackgroundTaskRunner });


// Tool execution core lives in chat-execution.ts; handleTaskControlAction and
// cronScheduler are injected here to break the circular reference (both close
// over handleChat / telegramChannel, which stay in the composition root).
const executeTool = createExecuteTool({ handleTaskControlAction, cronScheduler });


const app = express();

registerFileRoutes(app);
registerKbRoutes(app);

registerChannelsRoutes(app, { telegramChannel });
app.use(cors());
app.use(express.json());

const webUiPath = path.join(__dirname, '..', '..', 'web-ui');
app.use(express.static(webUiPath));

// ─── Files: upload / download ─────────────────────────────────────────────────
// Upload sends raw bytes (Content-Type: application/octet-stream) so the global
// express.json() limit never applies to binary payloads.

registerSkillsRoutes(app, { skillsManager, recoverSkillsIfEmpty, setOrchestrationEnabled, activeTasks });

const heartbeatDomain = createHeartbeatDomain({
  getHandleChat: () => handleChat,
  telegramChannel,
  CONFIG_DIR_PATH,
});
const { makeBroadcastForTask } = heartbeatDomain;

registerHeartbeatRoutes(app, {
  loadTaskHeartbeatConfig: heartbeatDomain.loadTaskHeartbeatConfig,
  saveTaskHeartbeatConfig: heartbeatDomain.saveTaskHeartbeatConfig,
  scheduleTaskHeartbeat: heartbeatDomain.scheduleTaskHeartbeat,
});

const handleChat = createChatHandler({
  executeTool,
  telegramChannel,
  makeBroadcastForTask,
  isOrchestrationSkillEnabled,
  resolveModelTier,
  KNOWLEDGE_DIR,
  skillsManager,
  buildPersonalityContext,
  renderFlowInstruction,
  activeTasks,
});

registerChatRoutes(app, {
  handleChat,
  handleTaskControlAction,
  setMainSessionId: (id: string) => { lastMainSessionId = id; },
});
registerFlowRoutes(app, { handleChat, addMessage });

registerTasksRoutes(app, { cronScheduler, heartbeatRunner, loadTaskHeartbeatConfig: heartbeatDomain.loadTaskHeartbeatConfig, handleChat, makeBroadcastForTask, telegramChannel });

registerAgentRoutes(app);

registerSchedulesRoutes(app, { cronScheduler });

registerSystemRoutes(app);

registerBootstrapRoutes(app);













registerMiscRoutes(app, { isOrchestrationSkillEnabled });

registerSettingsRoutes(app);
registerMcpRoutes(app, { resolveModelTier, isOrchestrationSkillEnabled });

// ─── Webhook Routes ──────────────────────────────────────────────────────────
// Mounted dynamically so the path is always read fresh from config.
// Must be registered BEFORE the SPA catch-all below.
(() => {
  const hookCfg = resolveHookConfig();
  if (!hookCfg.enabled) {
    console.log('[Webhooks] Disabled — set hooks.enabled=true in config to activate.');
    return;
  }
  if (!hookCfg.token) {
    console.warn('[Webhooks] hooks.enabled=true but no hooks.token set — webhooks will be disabled until a token is configured.');
    return;
  }
  const webhookRouter = buildWebhookRouter({
    handleChat: (message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode) =>
      handleChat(message, sessionId, sendSSE, pinnedMessages, abortSignal, callerContext, modelOverride, executionMode),
    addMessage,
    getIsModelBusy: getModelBusy,
    broadcast: broadcastWS,
    deliverTelegram: (text: string) => telegramChannel.sendToAllowed(text),
  });
  app.use(hookCfg.path, webhookRouter);
  console.log(`[Webhooks] Listening at ${hookCfg.path} (wake, agent, status)`);
})();

// ─── Internal Agent Task endpoint (called by Agent Builder for AI-authoring nodes)
// Localhost-only unless SMALLCLAW_INTERNAL_TOKEN is set.
app.use('/internal/agent-task', internalAgentTaskRouter);
console.log('[InternalAgentTask] Endpoint mounted at POST /internal/agent-task');

app.get('*', (_req, res) => { res.sendFile(path.join(webUiPath, 'index.html')); });

const { server } = createServerLifecycle({
  app,
  host: HOST,
  port: PORT,
  configDirPath: CONFIG_DIR_PATH,
  skillsManager,
  cronScheduler,
  telegramChannel,
  heartbeatRunner,
  scheduleTaskHeartbeat: () => heartbeatDomain.scheduleTaskHeartbeat(),
  loadTaskHeartbeatConfig: () => heartbeatDomain.loadTaskHeartbeatConfig(),
});

export { app, server };