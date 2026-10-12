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
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  getConfig,
  getAgents,
  getAgentById,
  getDefaultAgent,
  ensureAgentWorkspace,
  resolveAgentWorkspace,
} from '../config/config';
import { getMCPManager, type MCPTool } from './mcp-manager';
import { mergeOptimizationTier, tierFromContextWindow } from './server-v2-text';
import { broadcastWS, createSSESender, setWss, closeWss } from './realtime';
import { flowsManager, buildFlowDonePayload, listFlows, getFlowById, createFlow, updateFlow, deleteFlow } from './flow-integration';
import { ACTIVE_TASK_STATUSES, inferTaskChannelFromSession, latestTaskForSession, findBlockedTaskForSession, isResumeIntent, isRerunIntent, isCancelIntent, isStatusQuestion, isTaskListIntent, isAdjustmentIntent, getLatestPauseContext, summarizeTaskRecord, buildBlockedTaskStatusMessage, parseTaskStatusFilter, getTaskScopeBuckets, parseTaskIdFromText, renderTaskCandidatesForHuman } from './task-integration';
import { createExecuteTool, createTaskControlHandler, isConfirmed, normalizeToolArgs, resolveAnalysisTarget, listArtifacts, ANALYSIS_INJECT_MAX_CHARS, resolveToolFilePath, type ToolResult, type TaskControlResponse } from './chat-execution';
import { createChatHandler, MAX_TOOL_ROUNDS, type ExecutionMode, type OrchestrationEvent, type OrchestrationSessionStats, getOrchestrationSessionStats, recordOrchestrationEvent, getPreemptSessionCount, incrementPreemptSessionCount, type SubagentProfile, logToDaily, KB_AUTO_INJECT_RE, collectFileSnapshots, buildBrowserAck, buildDesktopAck, isBrowserHeavyResearchPage, type SnapshotDiagnostics, type BrowserSnapshotQuality, goalLikelyNeedsTextInput, parseSnapshotDiagnostics, evaluateBrowserSnapshotQuality, type HandleChatResult, maybeSuggestModelSwitch, buildMultimodalUserContent, MAX_TOOL_ARG_PARSE_RETRIES, TOOL_ARG_PARSE_RETRY_HINT, probeLlamaNctx, resolveHistoryBudgetTokens, computeSessionMetaAnswer, buildChatLogReport } from './chat-handler';
import { getVault } from '../security/vault';
import { getOllamaClient } from '../agents/ollama-client';
import { spawnAgent } from '../agents/spawner';
import { getSession, addMessage, getHistory, getHistoryForApiCall, getWorkspace, setWorkspace, clearHistory, deleteSession, cleanupSessions } from './session';
import { hookBus } from './hooks';
import { loadWorkspaceHooks } from './hook-loader';
import { runBootMd } from './boot';
import { resolveRunCommand, suggestRunCommandFix, SAFE_COMMANDS, ARG_SAFE_COMMANDS } from './run-command-router';
import { LlamaServerManager } from './llama-server-manager';
import { TaskRunner, runTask, TaskTool, TaskState } from './task-runner';
import { setupErrorResponseEndpoint } from './error-response-endpoint-integrated';
import { initCredentialHandler, getCredentialHandler } from '../security/credential-handler';
import { getVerificationFlowManager } from './verification-flow';
import { getErrorAnalyzer } from './error-analyzer';
import { getErrorHistory } from './error-history';
import { getRetryStrategy } from './retry-strategy';
import { getVisualErrorDetector } from './visual-error-detection';
import { getErrorAudit } from '../security/error-audit';
import { webSearch, webFetch, tavilySearch, googleSearch, duckDuckGoSearch } from './server-v2-search';
import {
  logToolCall,
  separateThinkingFromContent,
  normalizeForDedup,
  isGreetingLikeMessage,
  sanitizeFinalReply,
  stripExplicitThinkTags,
  isExecutionLikeRequest,
  isBrowserAutomationRequest,
  isDesktopAutomationRequest,
  extractLikelyUrl,
  looksLikeSafetyRefusal,
  looksLikeIntentOnlyReply,
  hasConcreteCompletion,
  isBrowserToolName,
  isDesktopToolName,
  isHighStakesFile,
  requestedFullTemplate,
  isToolArgParseFailure,
} from './server-v2-text';
import { getContextInjectionManager } from './context-injection';
import { SkillsManager } from './skills-manager';
import {
  browserOpen,
  browserSnapshot,
  browserClick,
  browserFill,
  browserPressKey,
  browserWait,
  browserScroll,
  browserClose,
  getBrowserToolDefinitions,
  getBrowserSessionInfo,
  getBrowserAdvisorPacket,
} from './browser-tools';
import {
  desktopScreenshot,
  desktopFindWindow,
  desktopFocusWindow,
  desktopClick,
  desktopDrag,
  desktopWait,
  desktopType,
  desktopPressKey,
  desktopGetClipboard,
  desktopSetClipboard,
  getDesktopToolDefinitions,
  getDesktopAdvisorPacket,
} from './desktop-tools';
import {
  getOfficeToolDefinitions,
  executeOfficeTool,
  ensureOfficeCapabilities,
  isOfficeReadFile,
  isOfficeWriteFile,
  consumeLastDocPreview,
  getDocPreview,
  parseDocPreview,
} from '../tools/office';
import {
  getImageToolDefinitions,
  executeImageTool,
} from '../tools/image';
import {
  getFileBatchToolDefinitions,
  executeFileBatchTool,
} from '../tools/file-batch';
import {
  getKnowledgeToolDefinitions,
  executeKnowledgeTool,
  KNOWLEDGE_TOOL_NAMES,
} from '../tools/knowledge';
import {
  planToolDefinitions,
  isPlanGateActive,
  isPlanModeEnabledFor,
  isPlanTool,
  setPlanModeEnabled,
  getPlanState,
  getPendingPlan,
  resolvePlanDecision,
  planGateMessage,
  awaitPlanDecision,
  PLAN_READONLY_TOOLS,
} from './plan-mode';
import { CronScheduler } from './cron-scheduler';
import { HeartbeatRunner } from './heartbeat-runner';
import {
  initializeAgentSchedules,
  reloadAgentSchedules,
  stopAgentSchedules,
  getAgentRunHistory,
  getAgentLastRun,
  recordAgentRun,
} from '../scheduler';
import { TelegramChannel } from './telegram-channel';
import {
  OrchestrationTriggerState,
  callSecondaryPreflight,
  callSecondaryAdvisor,
  callSecondaryFileOpClassifier,
  callSecondaryFileAnalyzer,
  callSecondaryFileVerifier,
  callSecondaryFilePatchPlanner,
  callSecondaryBrowserAdvisor,
  callSecondaryDesktopAdvisor,
  callSecondaryHeartbeatAdvisor,
  formatPreflightExecutionObjective,
  formatPreflightHint,
  formatAdvisoryHint,
  formatBrowserAdvisorHint,
  formatDesktopAdvisorHint,
  getOrchestrationConfig,
  clampOrchestrationConfig,
  clampPreemptConfig,
  checkOrchestrationEligibility,
  shouldRunPreflight,
  type TaskSnapshot as HeartbeatTaskSnapshot,
} from '../orchestration/multi-agent';
import {
  createTask,
  loadTask,
  saveTask,
  updateTaskStatus,
  appendJournal,
  updateResumeContext,
  listTasks,
  deleteTask,
  mutatePlan,
  buildTaskSnapshot,
  type TaskRecord,
  type TaskStatus,
} from './task-store';
import { BackgroundTaskRunner } from './background-task-runner';
import { SubagentManager } from './subagent-manager';
import {
  FileOpProgressWatchdog,
  FileOpType,
  classifyFileOpType,
  resolveFileOpSettings,
  isFileMutationTool,
  isFileCreateTool,
  isFileEditTool,
  extractFileToolTarget,
  estimateFileToolChange,
  canPrimaryApplyFileTool,
  shouldVerifyFileTurn,
  isSmallSuggestedFix,
  buildFailureSignature,
  buildPatchSignature,
  loadFileOpCheckpoint,
  saveFileOpCheckpoint,
  clearFileOpCheckpoint,
} from '../orchestration/file-op-v2';
import { OllamaProcessManager } from './ollama-process-manager';
import { raceWithWatchdog, PreemptState } from './preempt-watchdog';
import { detectGpu, logGpuStatus } from './gpu-detector';
import { registerSystemRoutes } from './api-system';
import { requireGatewayAuth } from './api-auth';
import { registerMiscRoutes } from './api-misc';
import { registerMcpRoutes } from './api-mcp';
import { registerSettingsRoutes } from './api-settings';
import { registerSkillsRoutes } from './api-skills';
import { registerTasksRoutes } from './api-tasks';
import { registerFlowRoutes } from './api-flows';
import { resolveChannelsConfig, registerChannelsRoutes } from './api-channels';
import { registerSchedulesRoutes } from './api-schedules';
import { registerAgentRoutes } from './api-agents';
import { skillsManager, isOrchestrationSkillEnabled, renderFlowInstruction, recoverSkillsIfEmpty, setOrchestrationEnabled } from './skills-bootstrap';
import { buildPersonalityContext } from './personality-context';
import { createHeartbeatDomain, registerHeartbeatRoutes } from './task-heartbeat';
import { buildWebhookRouter, resolveHookConfig } from './webhook-handler';
import { internalAgentTaskRouter } from './internal-agent-task';
import {
  registerAgentBuilderTools,
  executeAgentBuilderTool,
  AGENT_BUILDER_TOOL_NAMES,
  getWorkflowContextBlock,
} from './agent-builder-integration';
import { normalizeCwd, validateWorkspacePath, getConfigDirPath, derivePort, deriveHost, repairLegacyTaskChannelMetadata } from './config-bootstrap';
import { noteToolFailure, resetToolFailure } from './request-guards';
import { getModelTier, applyToolCompactness, buildTools, agentShellEnabled, MCP_TOOL_PREFIX, collectMcpToolEntries, filterToolsByIntent, detectToolCategories, applyToolPolicy, checkToolDenied, sessionAgentBindings } from './tool-registry';
import { getModelBusy, setModelBusy } from './model-busy-guard';

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
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

// run_command routing now lives in ./run-command-router.ts - extracted so the
// allowlist logic can be unit-tested without booting the whole gateway.
// See resolveRunCommand() there.

// ── Real shell escape hatch (opt-in, OFF by default) ─────────────────────────
// src/tools/shell.ts already implements a full shell (PTY + workspace


// ── Sub-Agent Tool Profiles ────────────────────────────────────────────────────────────
const TOOL_PROFILES: Record<SubagentProfile, Set<string>> = {
  file_editor:  new Set(['read_file', 'create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'list_files']),
  researcher:   new Set(['read_file', 'list_files', 'web_search', 'web_fetch']),
  shell_runner: new Set(['run_command', 'read_file', 'list_files']),
  reader_only:  new Set(['read_file', 'list_files']),
};

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




const KNOWLEDGE_DIR = path.join(__dirname, '..', '..', 'knowledge');

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


function goalIsInteractiveAction(goal: string): boolean {
  // Returns true when the user's goal is to DO something on the page (post, click, fill, submit)
  // rather than READ or RESEARCH. Used to skip feed-collection mode on social feeds.
  return /\b(post|tweet|retweet|reply|send|publish|submit|compose|write.*tweet|make.*post|create.*post|type.*message|fill|click|navigate to|go to|open composer|draft)\b/i.test(String(goal || ''));
}









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


async function tryHandleBlockedTaskFollowup(sessionId: string, rawMessage: string): Promise<string | null> {
  if (String(sessionId || '').startsWith('task_')) return null;
  const message = String(rawMessage || '').trim();
  if (!message) return null;

  // ── Path A: Explicit task UUID in the message (original behavior) ───────────
  const explicitTaskId = parseTaskIdFromText(message);
  if (explicitTaskId) {
    const rerunRequested = isRerunIntent(message);
    const resumeRequested = isResumeIntent(message);
    const cancelRequested = isCancelIntent(message);
    if (!rerunRequested && !resumeRequested && !cancelRequested) return null;
    const action = rerunRequested ? 'rerun' : cancelRequested ? 'pause' : 'resume';
    const ctl = await handleTaskControlAction(sessionId, { action, task_id: explicitTaskId, note: message });
    return ctl.success ? (ctl.message || null) : null;
  }

  // ── Path B: No UUID — look for a blocked/escalated task on this session ─────
  // Handles user messages like "proceed", "I logged in", "go ahead", "fixed it", etc.
  // where the task ID is implicit from context.
  const blockedTask = findBlockedTaskForSession(sessionId);
  if (!blockedTask) return null;

  const cancelRequested = isCancelIntent(message);
  const rerunRequested = isRerunIntent(message);

  // Broad resume detection: standard resume verbs OR short affirmations that only
  // make sense as "yes, continue" replies when a blocked task already exists.
  const resumeRequestedBroad =
    isResumeIntent(message) ||
    /^\s*(proceed|go ahead|ok|okay|continue|yes|yep|sure|do it|keep going|try again|move on|sounds good|ready|done|fixed|logged in|i logged in|it('s| is) fixed|all good)\.?\s*$/i.test(message) ||
    /\b(logged in|fixed it|done now|all set|ready now|proceed|go ahead)\.?$/i.test(message);

  if (!resumeRequestedBroad && !cancelRequested && !rerunRequested) return null;

  // Safety: if the message is long and contains strong new-task language, let it
  // fall through to the AI rather than hijacking it as a resume.
  const hasNewTaskLanguage =
    message.length > 80 &&
    /\b(open|go to|navigate|search for|create a|make a|write a|post a|send a|find me|check the)\b/i.test(message);
  if (hasNewTaskLanguage) return null;

  const action = rerunRequested ? 'rerun' : cancelRequested ? 'pause' : 'resume';
  const ctl = await handleTaskControlAction(sessionId, {
    action,
    task_id: blockedTask.id,
    note: message,
  });

  if (!ctl.success) return null;

  const verb = action === 'resume' ? 'Resuming' : action === 'rerun' ? 'Rerunning' : 'Cancelling';
  const taskLabel = `"${blockedTask.title}"`;
  return `${verb} task ${taskLabel}. ${ctl.message || ''}`.trim();
}

const app = express();

registerChannelsRoutes(app, { telegramChannel });
app.use(cors());
app.use(express.json());

const webUiPath = path.join(__dirname, '..', '..', 'web-ui');
app.use(express.static(webUiPath));

// ─── Files: upload / download ─────────────────────────────────────────────────
// Upload sends raw bytes (Content-Type: application/octet-stream) so the global
// express.json() limit never applies to binary payloads.

function sanitizeUploadName(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const base = path.basename(value);
  // Upload names must be plain file names - no directories, no traversal.
  if (base !== value || value === '.' || value === '..') return null;
  if (/[\\/:*?"<>|\0]/.test(base)) return null;
  if (base.length > 180) return null;
  return base;
}

app.post('/api/files', requireGatewayAuth, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const name = sanitizeUploadName(req.query.name || req.headers['x-file-name']);
  if (!name) {
    res.status(400).json({ ok: false, error: 'A file name is required (?name=report.xlsx)' });
    return;
  }
  const body: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!body.length) {
    res.status(400).json({ ok: false, error: 'Empty upload' });
    return;
  }
  const workspacePath = getConfig().getWorkspacePath();
  const guarded = resolveToolFilePath(workspacePath, name);
  if (!guarded.ok) {
    res.status(403).json({ ok: false, error: guarded.error });
    return;
  }
  try {
    fs.writeFileSync(guarded.path, body);
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'Failed to save upload' });
    return;
  }
  res.json({ ok: true, name, path: guarded.path, bytes: body.length });
});

app.get('/api/files', requireGatewayAuth, (req, res) => {
  const raw = String(req.query.path || '').trim();
  if (!raw) {
    res.status(400).json({ ok: false, error: 'path is required' });
    return;
  }
  const workspacePath = getConfig().getWorkspacePath();
  const guarded = resolveToolFilePath(workspacePath, raw);
  if (!guarded.ok) {
    res.status(403).json({ ok: false, error: guarded.error });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(guarded.path);
  } catch {
    res.status(404).json({ ok: false, error: 'File not found' });
    return;
  }
  if (!stat.isFile()) {
    res.status(400).json({ ok: false, error: 'Not a file' });
    return;
  }
  if (String(req.query.inline || '') === '1') {
    const ext = path.extname(guarded.path).toLowerCase();
    const inlineTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
      '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    };
    res.setHeader('Content-Type', inlineTypes[ext] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(path.basename(guarded.path))}"`);
    const stream = fs.createReadStream(guarded.path);
    stream.on('error', () => { if (!res.headersSent) res.status(500).json({ ok: false, error: 'Read failed' }); });
    stream.pipe(res);
    return;
  }
  res.download(guarded.path, path.basename(guarded.path), err => {
    if (err && !res.headersSent) res.status(500).json({ ok: false, error: 'Download failed' });
  });
});

// ─── Workspace file listing for the artifacts / files panel ───────────────────
app.get('/api/fs', requireGatewayAuth, (req, res) => {
  const raw = String(req.query.path || '').trim();
  const workspacePath = getConfig().getWorkspacePath();
  const guarded = resolveToolFilePath(workspacePath, raw || '.');
  if (!guarded.ok) {
    res.status(403).json({ ok: false, error: guarded.error });
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(guarded.path);
  } catch {
    res.status(404).json({ ok: false, error: 'Not found' });
    return;
  }
  if (!stat.isDirectory()) {
    res.status(400).json({ ok: false, error: 'Not a directory' });
    return;
  }
  const baseRel = (raw || '.').replace(/\\/g, '/').replace(/^\.\//, '');
  const prefix = baseRel === '.' ? '' : `${baseRel}/`;
  const entries: Array<{ name: string; path: string; type: 'file' | 'dir'; bytes: number; mtime: number }> = [];
  try {
    for (const item of fs.readdirSync(guarded.path, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      let childStat: fs.Stats | null = null;
      try {
        childStat = fs.statSync(path.join(guarded.path, item.name));
      } catch {
        childStat = null;
      }
      entries.push({
        name: item.name,
        path: `${prefix}${item.name}`,
        type: childStat?.isDirectory() ? 'dir' : 'file',
        bytes: childStat?.size || 0,
        mtime: childStat ? Math.floor(childStat.mtimeMs) : 0,
      });
      if (entries.length >= 1000) break;
    }
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'readdir failed' });
    return;
  }
  entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.json({ ok: true, path: prefix || '.', entries });
});

// ─── Document write: apply a previously previewed change ──────────────────────
app.post('/api/doc/apply', requireGatewayAuth, async (req, res) => {
  const previewId = String(req.body?.preview_id || '').trim();
  if (!previewId) {
    res.status(400).json({ ok: false, error: 'preview_id is required' });
    return;
  }
  const record = getDocPreview(previewId);
  if (!record) {
    res.status(404).json({ ok: false, error: 'Preview not found or expired. Ask the model to run doc_write with mode:"preview" again.' });
    return;
  }
  const workspacePath = getConfig().getWorkspacePath();
  try {
    const outcome = await executeOfficeTool(
      'doc_write',
      { filename: record.path, ops: record.ops, mode: 'apply', preview_id: previewId },
      workspacePath,
      record.sessionId,
      resolveToolFilePath,
    );
    res.json({ ok: !outcome.error, result: outcome.result });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err?.message || 'apply failed' });
  }
});


// ─── Plan mode: toggle per session, approve/reject a submitted plan ───────────
app.get('/api/plan', requireGatewayAuth, (req, res) => {
  const sessionId = String(req.query?.sessionId || 'default');
  res.json({
    ok: true,
    state: getPlanState(sessionId),
    pending: getPendingPlan(sessionId),
  });
});

app.post('/api/plan', requireGatewayAuth, (req, res) => {
  const sessionId = String(req.body?.sessionId || 'default');
  const action = String(req.body?.action || '').trim().toLowerCase();
  const note = req.body?.note !== undefined && req.body?.note !== null
    ? String(req.body.note).slice(0, 500)
    : undefined;

  if (action === 'enable' || action === 'disable') {
    setPlanModeEnabled(sessionId, action === 'enable');
    res.json({ ok: true, state: getPlanState(sessionId) });
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const result = resolvePlanDecision(sessionId, action === 'approve', note);
    if (!result.ok) {
      res.status(409).json({ ok: false, error: result.error || 'no pending plan', state: getPlanState(sessionId) });
      return;
    }
    res.json({ ok: true, state: getPlanState(sessionId) });
    return;
  }
  res.status(400).json({ ok: false, error: 'action must be enable, disable, approve or reject' });
});

app.get('/api/artifacts', requireGatewayAuth, (req, res) => {
  const sessionId = req.query?.sessionId === undefined ? undefined : String(req.query.sessionId);
  res.json({ ok: true, artifacts: listArtifacts(sessionId) });
});

app.get('/api/status', async (_req, res) => {
  let connected = false;
  try {
    connected = await getOllamaClient().testConnection();
  } catch {
    connected = false; // a misconfigured provider must never crash the gateway
  }
  const rawCfg = getConfig().getConfig() as any;
  const provider: string = rawCfg.llm?.provider || 'ollama';
  const providerCfg = rawCfg.llm?.providers?.[provider] || {};
  const activeModel: string = providerCfg.model || rawCfg.models?.primary || 'unknown';
  const orchCfg = getOrchestrationConfig();
  // Report the EFFECTIVE secondary model (follows the active preset, then the
  // primary model) instead of the raw configured value, so the UI never shows
  // a stale hard-coded model the user is not actually running.
  let effectiveSecondary: { provider: string; model: string } | null = null;
  if (orchCfg) {
    const llm = rawCfg.llm || {};
    const preset = llm.presets?.[String(llm.active_preset || '')];
    const effProvider: string = preset?.provider || llm.provider || orchCfg.secondary.provider;
    const effModel: string =
      preset?.providers?.[preset.provider]?.model ||
      providerCfg.model ||
      rawCfg.models?.primary ||
      orchCfg.secondary.model;
    effectiveSecondary = { provider: String(effProvider), model: String(effModel) };
  }
  res.json({
    status: 'ok', version: 'v2-tools', ollama: connected,
    provider,
    currentModel: activeModel,
    workspace: (config as any).workspace?.path || '',
    search: rawCfg.search?.google_api_key ? 'google' : (rawCfg.search?.tavily_api_key ? 'tavily' : 'none'),
    orchestration: orchCfg ? {
      enabled: orchCfg.enabled,
      secondary: effectiveSecondary,
    } : null,
  });
});

// ─── Knowledge base REST (web UI management) ────────────────────────────────
// GET    /api/knowledge          — list + status
// POST   /api/knowledge/add      — { filename } relative to workspace (or path)
// POST   /api/knowledge/remove   — { name }
app.get('/api/knowledge', async (_req, res) => {
  try {
    const [listOut, statusOut] = await Promise.all([
      executeKnowledgeTool('knowledge_list', {}, KNOWLEDGE_DIR),
      executeKnowledgeTool('knowledge_status', {}, KNOWLEDGE_DIR),
    ]);
    res.json({ success: true, files: listOut.files || [], status: statusOut });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/knowledge/add', async (req, res) => {
  try {
    const raw = String(req.body?.filename || req.body?.path || '').trim();
    if (!raw) { res.status(400).json({ success: false, error: 'filename required' }); return; }
    const workspacePath = getConfig().getWorkspacePath();
    const resolved = resolveToolFilePath(workspacePath, raw);
    if (!resolved.ok) { res.status(403).json({ success: false, error: resolved.error }); return; }
    const outcome = await executeKnowledgeTool('knowledge_add', { path: resolved.path }, KNOWLEDGE_DIR);
    res.json({ success: !!outcome.ok, ...(outcome.ok ? { name: outcome.name, chunks: outcome.chunks, total_files: outcome.total_files } : { error: outcome.error }) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/knowledge/remove', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ success: false, error: 'name required' }); return; }
    const outcome = await executeKnowledgeTool('knowledge_remove', { name }, KNOWLEDGE_DIR);
    res.json({ success: !!outcome.ok, ...(outcome.ok ? { removed: outcome.removed } : { error: outcome.error }) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'default', pinnedMessages, agentId } = req.body;
  if (!message || typeof message !== 'string') { res.status(400).json({ error: 'Message required' }); return; }
  lastMainSessionId = String(sessionId || 'default');
  const requestedAgentId = typeof agentId === 'string' ? agentId.trim() : '';
  if (requestedAgentId) {
    if (getAgentById(requestedAgentId)) sessionAgentBindings.set(lastMainSessionId, requestedAgentId);
    else sessionAgentBindings.delete(lastMainSessionId);
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = createSSESender(res);
  const heartbeat = setInterval(() => sendSSE('heartbeat', { state: 'processing' }), 5000);

  // ── Model busy guard — block cron scheduler while user chat is running ──
  setModelBusy(true);

  const abortSignal = { aborted: false };
  let requestCompleted = false;
  res.on('close', () => {
    if (!requestCompleted && !abortSignal.aborted) {
      abortSignal.aborted = true;
      console.log(`[v2] Client disconnected — aborting task for session ${sessionId}`);
    }
  });

  try {
    const userMsg = { role: 'user' as const, content: message, timestamp: Date.now() };
    const addResult = addMessage(sessionId, userMsg, { deferOnMemoryFlush: true, deferOnCompaction: true });
    if (addResult.deferredForCompaction && addResult.compactionPrompt) {
      console.log(`[v2] Context compaction triggered for session ${sessionId} (${addResult.estimatedTokens}/${addResult.contextLimitTokens} est. tokens)`);
      try {
        const internalCompactionContext = 'CONTEXT: Internal context compaction turn. Summarize prior conversation into compact retained context only.';
        const compactResult = await handleChat(
          addResult.compactionPrompt,
          sessionId,
          () => {},
          undefined,
          abortSignal,
          internalCompactionContext,
        );
        if (!abortSignal.aborted && compactResult?.text) {
          addMessage(
            sessionId,
            { role: 'assistant', content: compactResult.text, timestamp: Date.now() },
            { disableMemoryFlushCheck: true, disableCompactionCheck: true },
          );
        }
      } catch (compactErr: any) {
        console.warn('[v2] Context compaction turn failed:', compactErr?.message || compactErr);
      }
      if (abortSignal.aborted) return;
      addMessage(sessionId, userMsg, { disableMemoryFlushCheck: true, disableCompactionCheck: true });
    } else if (addResult.deferredForMemoryFlush && addResult.memoryFlushPrompt) {
      console.log(`[v2] Pre-compaction memory flush triggered for session ${sessionId} (${addResult.estimatedTokens}/${addResult.contextLimitTokens} est. tokens)`);
      try {
        const internalFlushContext = 'CONTEXT: Internal pre-compaction memory flush turn. Before continuing, save important durable user/task facts to memory now.';
        const flushResult = await handleChat(
          addResult.memoryFlushPrompt,
          sessionId,
          () => {},
          undefined,
          abortSignal,
          internalFlushContext,
        );
        if (!abortSignal.aborted && flushResult?.text) {
          addMessage(
            sessionId,
            { role: 'assistant', content: flushResult.text, timestamp: Date.now() },
            { disableMemoryFlushCheck: true, disableCompactionCheck: true },
          );
        }
      } catch (flushErr: any) {
        console.warn('[v2] Pre-compaction memory flush failed:', flushErr?.message || flushErr);
      }
      if (abortSignal.aborted) return;
      addMessage(sessionId, userMsg, { disableMemoryFlushCheck: true, disableCompactionCheck: true });
    }

    console.log(`\n[v2] USER: ${message.slice(0, 100)}`);
    const followupHandled = await tryHandleBlockedTaskFollowup(sessionId, message);
    if (followupHandled) {
      if (!abortSignal.aborted) {
        addMessage(sessionId, { role: 'assistant', content: followupHandled, timestamp: Date.now() });
        sendSSE('final', { text: followupHandled });
        sendSSE('done', {
          reply: followupHandled,
          mode: 'chat',
          sections: [{ type: 'text', content: followupHandled }],
        });
      }
      return;
    }
    const pins = Array.isArray(pinnedMessages) ? pinnedMessages.slice(0, 3) : [];
    const result = await handleChat(message, sessionId, sendSSE, pins.length > 0 ? pins : undefined, abortSignal);
    if (!abortSignal.aborted) {
      addMessage(sessionId, { role: 'assistant', content: result.text, timestamp: Date.now() });
      sendSSE('final', { text: result.text });
      sendSSE('done', buildFlowDonePayload(result));
    }
  } catch (err: any) {
    if (!abortSignal.aborted) {
      console.error('[v2] ERROR:', err);
      sendSSE('error', { message: err.message || 'Unknown error' });
    }
  } finally {
    requestCompleted = true;
    clearInterval(heartbeat);
    setModelBusy(false); // release busy guard — cron scheduler may now run
    res.end();
  }
});

app.get('/api/open-path', async (req, res) => {
  const fp = req.query.path as string;
  if (!fp) { res.status(400).json({ error: 'Path required' }); return; }
  try {
    const { exec } = await import('child_process');
    const cmd = process.platform === 'win32' ? `start "" "${fp}"` : process.platform === 'darwin' ? `open "${fp}"` : `xdg-open "${fp}"`;
    exec(cmd, (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ success: true });
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clear-history', async (req, res) => {
  const sid = req.body.sessionId || 'default';
  const ws = getWorkspace(sid) || (getConfig().getConfig() as any).workspace?.path || '';
  if (ws) {
    await hookBus.fire({
      type: 'command:reset',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    });
    await hookBus.fire({
      type: 'command:new',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    });
  }
  clearHistory(sid);
  res.json({ success: true });
});

// Permanently delete a session: removes the on-disk session JSON
// (.smallclaw/sessions/<id>.json) plus the in-memory state, so a "deleted
// conversation" cannot be resurrected by a pending debounced save.
app.post('/api/sessions/delete', async (req, res) => {
  const sid = String(req.body.sessionId || '').trim();
  if (!sid) { res.status(400).json({ error: 'sessionId required' }); return; }
  try {
    deleteSession(sid);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Clear conversation memory logs (workspace/memory/<date>.md) — the source
// behind the [RECENT_CONVERSATIONS] context injection. body: { date: 'today'
// (default) | 'YYYY-MM-DD' | 'all' }. Deleting these means the model can no
// longer recall those conversations via the daily-log injection.
app.post('/api/memory/clear', async (req, res) => {
  try {
    const ws = (getConfig().getConfig() as any)?.workspace?.path || getConfig().getWorkspacePath();
    const memDir = path.join(ws, 'memory');
    const target = String(req.body?.date || 'today').trim();
    let deleted = 0;
    if (!fs.existsSync(memDir)) { res.json({ success: true, deleted: 0 }); return; }
    if (target === 'all') {
      const files = fs.readdirSync(memDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
      for (const f of files) { try { fs.unlinkSync(path.join(memDir, f)); deleted++; } catch { /* continue */ } }
    } else if (target === 'today') {
      const today = new Date().toISOString().split('T')[0];
      const p = path.join(memDir, `${today}.md`);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); deleted = 1; } catch { /* continue */ } }
    } else {
      const p = path.join(memDir, `${target}.md`);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); deleted = 1; } catch { /* continue */ } }
    }
    res.json({ success: true, deleted });
  } catch (err: any) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

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

registerFlowRoutes(app, { handleChat, addMessage });

registerTasksRoutes(app, { cronScheduler, heartbeatRunner, loadTaskHeartbeatConfig: heartbeatDomain.loadTaskHeartbeatConfig, handleChat, makeBroadcastForTask, telegramChannel });

registerAgentRoutes(app);

registerSchedulesRoutes(app, { cronScheduler });

registerSystemRoutes(app);














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

// ─── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wsServer = new WebSocketServer({ server, path: '/ws' });
setWss(wsServer);
wsServer.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${HOST}:${PORT} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] WebSocket error:', err?.message || err);
  process.exit(1);
});
wsServer.on('connection', (ws: WebSocket) => {
  console.log('[v2] WS connected');
  ws.on('message', (d) => { try { JSON.parse(d.toString()); } catch {} });
  ws.on('close', () => console.log('[v2] WS disconnected'));
});

server.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${HOST}:${PORT} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] HTTP server error:', err?.message || err);
  process.exit(1);
});

// Setup error response endpoint
setupErrorResponseEndpoint(app);

// ─── Initialize Advanced Error Response Systems ────────────────────────────────
const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const credentialHandler = initCredentialHandler(encryptionKey);
const verificationFlowManager = getVerificationFlowManager();
const errorAnalyzer = getErrorAnalyzer();
const errorHistory = getErrorHistory();
const retryStrategy = getRetryStrategy();
const visualErrorDetector = getVisualErrorDetector();
const errorAudit = getErrorAudit(process.env.ERROR_AUDIT_LOG_PATH || path.join(CONFIG_DIR_PATH, 'logs', 'audit.log'));
const contextInjectionManager = getContextInjectionManager();

console.log('[Server] ✅ Advanced error response systems initialized');
console.log(`[Server] - Credential Handler: ${encryptionKey.substring(0, 8)}...`);
console.log('[Server] - Verification Flow Manager: Ready');
console.log('[Server] - Error Analyzer: Ready');
console.log('[Server] - Error History: Ready');
console.log('[Server] - Retry Strategy: Ready');
console.log('[Server] - Visual Error Detector: Ready');
console.log('[Server] - Error Audit: Ready');
console.log('[Server] - Context Injection Manager: Ready');

server.listen(PORT, HOST, () => {
  // Detect GPU hardware once — logs a single clean line, caches result for
  // the lifetime of the process (used by /api/system-stats, no repeated probes).
  logGpuStatus();

  const liveConfig = getConfig().getConfig();
  const searchCfg = (liveConfig as any).search || {};
  // HIGH-03: resolve vault references before checking presence — never log the key value itself
  const cm = getConfig();
  const tavilyKey = cm.resolveSecret(searchCfg.tavily_api_key);
  const googleKey = cm.resolveSecret(searchCfg.google_api_key);
  const hasSearch = tavilyKey ? '✓ Tavily' : googleKey ? '✓ Google' : '✗ None (configure in Settings → Search)';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              SmallClaw v2 Gateway (Native Tools)              ║
╠════════════════════════════════════════════════════════════════╣
║  Tasks:   Cron scheduler active, jobs at .smallclaw/cron/     ║
║  Skills: ${String(skillsManager.getAll().length + ' loaded, ' + skillsManager.getEnabledSkills().length + ' enabled').padEnd(49)}║
║  Search:  ${hasSearch.padEnd(49)}║
║  Memory:  SOUL.md + IDENTITY.md + USER.md + MEMORY.md         ║
║                                                               ║
║  Web UI:    http://${HOST}:${PORT}                            ║
║  Model:     ${liveConfig.models.primary.padEnd(45)}║
║  Workspace: ${liveConfig.workspace.path.slice(0, 43).padEnd(45)}║
╚════════════════════════════════════════════════════════════════╝
`);
  // Auto-connect enabled MCP servers
  getMCPManager().startEnabledServers().catch(err => console.warn('[MCP] Startup error:', err?.message));

  // Probe the Office helper (Python) in the background so doc_* tools appear
  // in buildTools() as soon as capabilities are known.
  ensureOfficeCapabilities();

  cronScheduler.start();
  console.log('[CronScheduler] Tick loop started — heartbeat:', cronScheduler.getConfig().enabled ? 'ON' : 'OFF');
  initializeAgentSchedules();
  console.log('[Scheduler] Agent cron schedules initialized.');
  heartbeatRunner.start();
  console.log('[HeartbeatRunner] Started — interval:', heartbeatRunner.getConfig().intervalMinutes, 'min');
  telegramChannel.start().then(() => {
    // Check if we just restarted after a self-update
    const selfUpdateStatusFile = path.join(require('os').homedir(), '.smallclaw', 'last_self_update.txt');
    if (fs.existsSync(selfUpdateStatusFile)) {
      try {
        const statusContent = fs.readFileSync(selfUpdateStatusFile, 'utf-8').trim();
        fs.unlinkSync(selfUpdateStatusFile); // consume it — only notify once
        if (statusContent.startsWith('UPDATE_SUCCESS')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `✅ SmallClaw self-update complete!\n\nI ran the update, rebuilt, and have restarted the gateway. I'm back online and up to date.\n\n🕐 Updated at: ${timestamp.trim()}`;
          setTimeout(() => telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update Telegram notification queued.');
        } else if (statusContent.startsWith('UPDATE_FAILED')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `❌ SmallClaw self-update failed.\n\nThe update process encountered an error. Gateway has restarted with the previous version. Check the terminal for details.\n\n🕐 Attempted at: ${timestamp.trim()}`;
          setTimeout(() => telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update failure Telegram notification queued.');
        }
      } catch (e: any) {
        console.warn('[Gateway] Could not read self-update status file:', e.message);
      }
    }
  }).catch(err => console.error('[Telegram] Start failed:', err.message));
  heartbeatDomain.scheduleTaskHeartbeat();
  console.log('[TaskHeartbeat] Scheduled — interval:', heartbeatDomain.loadTaskHeartbeatConfig().interval_minutes, 'min');

  const bootWorkspace = getConfig().getWorkspacePath() || (getConfig().getConfig() as any).workspace?.path || '';
  if (bootWorkspace) {
    loadWorkspaceHooks(bootWorkspace);
    hookBus
      .fire({ type: 'gateway:startup', workspacePath: bootWorkspace })
      .catch((err: any) => console.warn('[hooks] gateway:startup error:', err?.message || err));
  }
});

let shuttingDown = false;
function gracefulShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[Gateway] Shutting down error response systems...');
  try { credentialHandler.stop(); console.log('[Gateway] ✅ Credential handler stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  try { verificationFlowManager.stop(); console.log('[Gateway] ✅ Verification flow stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  console.log(`[Gateway] Received ${signal}; shutting down...`);
  try { skillsManager.persistState(); } catch {}
  try { telegramChannel.stop(); } catch {}
  try { getMCPManager().disconnectAll(); } catch {}
  try { cronScheduler.stop(); } catch {}
  try { stopAgentSchedules(); } catch {}
  try { heartbeatRunner.stop(); } catch {}
  try { closeWss(); } catch {}
  try {
    server.close(() => process.exit(0));
    const forceExitTimer = setTimeout(() => process.exit(0), 1200) as any;
    if (typeof forceExitTimer?.unref === 'function') forceExitTimer.unref();
  } catch {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

export { app, server };