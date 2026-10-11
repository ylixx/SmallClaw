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

// Skills system
const configuredSkillsDir = (config as any).skills?.directory || path.join(CONFIG_DIR_PATH, 'skills');
const fallbackSkillsDir = path.join(CONFIG_DIR_PATH, 'skills');

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function syncMissingSkills(sourceDir: string, targetDir: string): void {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceSkillDir = path.join(sourceDir, entry.name);
    const sourceSkillMd = path.join(sourceSkillDir, 'SKILL.md');
    if (!fs.existsSync(sourceSkillMd)) continue;

    const targetSkillDir = path.join(targetDir, entry.name);
    if (fs.existsSync(path.join(targetSkillDir, 'SKILL.md'))) continue;
    fs.cpSync(sourceSkillDir, targetSkillDir, { recursive: true });
  }
}

function ensureMultiAgentSkill(targetDir: string): void {
  const targetSkillDir = path.join(targetDir, 'multi-agent-orchestrator');
  const targetSkillMd = path.join(targetSkillDir, 'SKILL.md');
  if (fs.existsSync(targetSkillMd)) return;

  const templateCandidates = [
    path.join(fallbackSkillsDir, 'multi-agent-orchestrator', 'SKILL.md'),
    path.join(process.cwd(), 'src', 'orchestration', 'SKILL.md'),
  ];

  const templatePath = templateCandidates.find(p => fs.existsSync(p));
  if (!templatePath) return;

  fs.mkdirSync(targetSkillDir, { recursive: true });
  fs.writeFileSync(targetSkillMd, fs.readFileSync(templatePath, 'utf-8'), 'utf-8');
}

function migrateSkillsStateIfMissing(targetDir: string): void {
  const targetStatePath = path.join(path.dirname(targetDir), 'skills_state.json');
  if (fs.existsSync(targetStatePath)) return;

  const sourceStatePath = path.join(path.dirname(fallbackSkillsDir), 'skills_state.json');
  if (!fs.existsSync(sourceStatePath)) return;

  fs.mkdirSync(path.dirname(targetStatePath), { recursive: true });
  fs.copyFileSync(sourceStatePath, targetStatePath);
}

function resolveSkillsDir(configuredDir: string): string {
  const fallbackDir = fallbackSkillsDir;
  const targetDir = configuredDir || fallbackDir;

  try {
    fs.mkdirSync(targetDir, { recursive: true });
    if (!samePath(targetDir, fallbackDir)) {
      syncMissingSkills(fallbackDir, targetDir);
      migrateSkillsStateIfMissing(targetDir);
    }
    ensureMultiAgentSkill(targetDir);
    return targetDir;
  } catch (err: any) {
    console.warn(`[Skills] Failed to prepare configured skills directory "${targetDir}": ${err.message}`);
    fs.mkdirSync(fallbackDir, { recursive: true });
    ensureMultiAgentSkill(fallbackDir);
    return fallbackDir;
  }
}

const skillsDir = resolveSkillsDir(configuredSkillsDir);
const skillsManager = new SkillsManager(skillsDir, '');
console.log(`[Skills] Directory: ${skillsDir}`);

function isOrchestrationSkillEnabled(): boolean {
  return skillsManager.get('multi-agent-orchestrator')?.enabled === true;
}

/**
 * Expand `{{skill:<id>}}` placeholders inside a flow template instruction
 * with the referenced skill's full markdown body. This keeps a single source
 * of truth for the process spec (the SKILL.md) — editing the skill propagates
 * to every flow that references it, instead of drifting copies.
 * Unknown skills leave the placeholder untouched so the error is visible.
 */
function renderFlowInstruction(instruction: string): string {
  return String(instruction || '').replace(/\{\{\s*skill:([a-zA-Z0-9_-]+)\s*\}\}/g, (match, id: string) => {
    const skill = skillsManager.get(id);
    if (!skill) return match;
    return `\n\n【技能规范：${skill.name}（${id}）】\n${skill.instructions}\n`;
  });
}

function recoverSkillsIfEmpty(): void {
  // Refresh from disk first (handles files added while server is running).
  skillsManager.scanSkills();
  if (skillsManager.getAll().length > 0) return;
  if (samePath(skillsDir, fallbackSkillsDir)) return;

  try {
    syncMissingSkills(fallbackSkillsDir, skillsDir);
    migrateSkillsStateIfMissing(skillsDir);
    ensureMultiAgentSkill(skillsDir);
    skillsManager.scanSkills();
  } catch (err: any) {
    console.warn(`[Skills] Recovery failed: ${err.message}`);
  }
}

// Ensure skills are available for prompt injection from the first turn.
recoverSkillsIfEmpty();

function setOrchestrationEnabled(enabled: boolean): void {
  const raw = getConfig().getConfig() as any;
  const current = raw.orchestration || {};
  // Use the single-source-of-truth clamp utility from multi-agent.ts so bounds
  // can never silently diverge from getOrchestrationConfig() or getOrchestrationConfigForApi().
  const clamped = clampOrchestrationConfig(current);
  const preempt = clampPreemptConfig(current.preempt || {});
  const merged = {
    enabled,
    secondary: {
      provider: String(current.secondary?.provider || '').trim(),
      model: String(current.secondary?.model || '').trim(),
    },
    ...clamped,
    preempt,
  };
  getConfig().updateConfig({ orchestration: merged } as any);
}

// Keep config flag aligned with persisted skill state on startup.
(() => {
  const orchestratorSkill = skillsManager.get('multi-agent-orchestrator');
  if (!orchestratorSkill) return;
  const configEnabled = (getConfig().getConfig() as any).orchestration?.enabled === true;
  if (configEnabled !== orchestratorSkill.enabled) {
    setOrchestrationEnabled(orchestratorSkill.enabled);
  }
})();

// ─── Model-Busy Guard (state owned by model-busy-guard.ts; see getModelBusy/setModelBusy) ──

let lastMainSessionId = 'default';

type TelegramChannelConfig = {
  enabled: boolean;
  botToken: string;
  allowedUserIds: number[];
  streamMode: 'full' | 'partial';
};

type DiscordChannelConfig = {
  enabled: boolean;
  botToken: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  webhookUrl: string;
};

type WhatsAppChannelConfig = {
  enabled: boolean;
  accessToken: string;
  phoneNumberId: string;
  businessAccountId: string;
  verifyToken: string;
  webhookSecret: string;
  testRecipient: string;
};

type ChannelsConfig = {
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
  whatsapp: WhatsAppChannelConfig;
};

// HIGH-01 fix: resolve vault references when normalizing channel configs.
// Tokens stored as "vault:<key>" are decrypted here at point-of-use,
// so they never have to be plaintext in config.json.
function resolveToken(raw: string | undefined): string {
  if (!raw) return '';
  return getConfig().resolveSecret(raw) || '';
}

function normalizeTelegramConfig(raw: any): TelegramChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    allowedUserIds: Array.isArray(raw?.allowedUserIds) ? raw.allowedUserIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : [],
    streamMode: raw?.streamMode === 'partial' ? 'partial' : 'full',
  };
}

function normalizeDiscordConfig(raw: any): DiscordChannelConfig {
  return {
    enabled: raw?.enabled === true,
    botToken: resolveToken(raw?.botToken),
    applicationId: String(raw?.applicationId || ''),
    guildId: String(raw?.guildId || ''),
    channelId: String(raw?.channelId || ''),
    webhookUrl: resolveToken(raw?.webhookUrl) || String(raw?.webhookUrl || ''),
  };
}

function normalizeWhatsAppConfig(raw: any): WhatsAppChannelConfig {
  return {
    enabled: raw?.enabled === true,
    accessToken: resolveToken(raw?.accessToken),
    phoneNumberId: String(raw?.phoneNumberId || ''),
    businessAccountId: String(raw?.businessAccountId || ''),
    verifyToken: resolveToken(raw?.verifyToken) || String(raw?.verifyToken || ''),
    webhookSecret: resolveToken(raw?.webhookSecret) || String(raw?.webhookSecret || ''),
    testRecipient: String(raw?.testRecipient || ''),
  };
}

function resolveChannelsConfig(): ChannelsConfig {
  const cfg = getConfig().getConfig() as any;
  const channels = cfg.channels || {};
  const legacyTelegram = cfg.telegram || {};
  return {
    telegram: normalizeTelegramConfig({ ...(channels.telegram || {}), ...legacyTelegram }),
    discord: normalizeDiscordConfig(channels.discord || {}),
    whatsapp: normalizeWhatsAppConfig(channels.whatsapp || {}),
  };
}

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

// ─── Workspace Memory Loader ───────────────────────────────────────────────────

function loadWorkspaceFile(workspacePath: string, filename: string, maxChars: number = 500): string {
  try {
    const filePath = path.join(workspacePath, filename);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '\n...(truncated)';
  } catch { return ''; }
}

function readDailyMemoryContext(workspacePath: string, maxTokens: number = 800): string {
  try {
    const memDir = path.join(workspacePath, 'memory');
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const sections: string[] = [];

    for (const day of [yesterday, today]) {
      const p = path.join(memDir, `${day}.md`);
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, 'utf-8').trim();
      if (!raw) continue;
      sections.push(`### Memory: ${day}\n${raw}`);
    }

    if (!sections.length) return '';

    let combined = sections.join('\n\n');
    const charLimit = Math.floor(maxTokens * 3.5);
    if (combined.length > charLimit) {
      combined = combined.slice(-charLimit);
    }
    return `\n\n## Recent Memory Notes\n${combined}`;
  } catch {
    return '';
  }
}

// ─── Tiered Prompt System ─────────────────────────────────────────────────────


// Tool rule blocks — compact, injected only when relevant
// User message signals "I want to recall past conversations" → only then inject
// [RECENT_CONVERSATIONS]. Without this gate the daily-log tail leaked into
// every prompt and the model answered current questions with old memory topics.
// The pattern must cover natural phrasing: "生成最近聊天记录报告" failed the
// first version (matched 昨天/对话记录 only) and the model started guessing
// file names instead of reading memory/*.md.
const MEMORY_RECALL_RE = /(上次|昨天|前天|之前|以前|刚才|还记得|回忆|最后一次|最近一次|最近聊|聊天记录|对话记录|历史对话|前两天|这两天|这几天|上次会话|上次聊|我们聊过|我们说过|聊过什么|我们谈了|之前说的)/i;

const TOOL_BLOCKS: Record<string, string> = {
  web: `WEB TOOLS: web_search(query) → headlines+snippets. web_fetch(url) → full page text. Use web_search first to get URLs, then web_fetch to read. For Reddit: web_search with site:reddit.com "keyword", then web_fetch post URLs — never open browser for Reddit.`,

  browser: `BROWSER TOOLS: browser_open(url) → opens+returns snapshot. browser_snapshot() → refresh elements. browser_click(ref) → click by @ref. browser_fill(ref,text) → fill input. browser_press_key(key) → Enter/Tab/Escape. browser_wait(ms) → wait then snapshot. browser_close() → close tab. Chrome profile is persistent — already logged into sites. SNAPSHOT RULE: browser_open, browser_fill, browser_wait, and browser_click ALL return a fresh snapshot automatically — do NOT call browser_snapshot immediately after any of them. Only call browser_snapshot when you have NOT received a snapshot recently. Calling browser_snapshot twice in a row or after any tool that already returned one is a loop bug — act on the existing snapshot instead. SCROLL RULE: Do NOT scroll/PageDown on an interactive page before reading its snapshot — the compose area and action buttons are visible without scrolling. Read the snapshot refs and act. POST/TWEET RULE: After filling a tweet/post composer, the fill result will show "⚠️ COMPOSER SUBMIT BUTTON: @N" — you MUST click that exact @N ref immediately as your very next action. Do NOT click any other ref, do NOT snapshot, do NOT wait. If no COMPOSER SUBMIT BUTTON annotation appears, find the button named "Post" or "Tweet" that is visually inside the composer area and click it. Filling the textarea alone is NOT completion. After clicking Post, snapshot to verify it was published.`,

  desktop: `DESKTOP TOOLS: desktop_screenshot() → capture+OCR. desktop_find_window(name) → find window. desktop_focus_window(name) → bring to front (use SHORT process name: msedge, chrome, code). desktop_click(x,y) → click coords. desktop_type(text) → type. desktop_press_key(key) → key combo. desktop_drag(x1,y1,x2,y2) → drag. desktop_get_clipboard()/set_clipboard(text). Always screenshot first. Focus window before click/type. Fail twice on focus → stop and report.`,

  files: `FILE TOOLS: read_file(filename) → contents with line numbers. Always read before editing. replace_lines(filename,start,end,content) → surgical edit. insert_after(filename,line,content) → insert. delete_lines(filename,start,end) → delete. find_replace(filename,find,replace) → exact text swap. create_file(filename,content) → new only (fails if exists). delete_file(filename). RULES: read first, surgical edits only, never rewrite whole file for partial changes.`,

  task: `TASK TOOLS: task_control(action,...)  actions: list/get/resume/rerun/pause/delete. start_task(title,prompt) → launch new background task. Check for existing tasks first before creating — never duplicate. Do NOT use read_file to check task state.`,

  schedule: `SCHEDULE TOOL: schedule_job(action,...) actions: list/create/update/pause/resume/delete/run_now. Always confirm before create/update/delete. Keep schedule timing separate from instruction_prompt content.`,

  shell: `SHELL TOOL: run_command(command) → opens app for user to see (chrome, notepad, vscode, word/winword). To open a document with its default program: start <file>. For web automation use browser_* not run_command. For desktop interaction use desktop_* not run_command.`,

  memory: `MEMORY TOOLS: memory_browse(file) → list categories in user.md or soul.md. memory_write(file,category,content) → add/update a fact (creates category if new). memory_read(file) → full file contents. File is "user" or "soul". Browse first to find the right category. Write immediately when you learn something — don't wait.`,

  debug: `DEBUG: If asked about errors or architecture, use read_source(file) to inspect SmallClaw source. SELF.md has architecture overview. Workspace files: IDENTITY.md, SOUL.md, USER.md, TOOLS.md, SELF.md. Read the relevant one before diagnosing.`,
};

// Read memory categories for a specific file (for category-aware injection)
function readMemoryCategories(workspacePath: string, file: 'user' | 'soul'): string[] {
  const filename = file === 'user' ? 'USER.md' : 'SOUL.md';
  const filePath = path.join(workspacePath, filename);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const matches = content.match(/^##\s+([^\n]+)/gm) || [];
  return matches.map(m => m.replace(/^##\s+/, '').trim());
}

// Read memory snippets matching detected categories (for category-aware injection)
function readMemorySnippets(workspacePath: string, categories: string[]): string {
  if (categories.length === 0) return '';
  const snippets: string[] = [];
  for (const file of ['USER.md', 'SOUL.md']) {
    const filePath = path.join(workspacePath, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    let currentSection = '';
    const sectionLines: string[] = [];
    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        if (inSection && sectionLines.length > 0) {
          snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
        }
        currentSection = headingMatch[1].trim();
        inSection = categories.some(cat => currentSection.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(currentSection.toLowerCase()));
        sectionLines.length = 0;
      } else if (inSection && line.trim()) {
        sectionLines.push(line);
      }
    }
    if (inSection && sectionLines.length > 0) {
      snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
    }
  }
  return snippets.slice(0, 6).join('\n\n');
}

// Map tool categories to memory category keywords
const TOOL_TO_MEMORY_CATS: Record<string, string[]> = {
  web: ['web', 'research', 'search'],
  browser: ['browser', 'web'],
  files: ['files', 'coding', 'editing', 'development'],
  task: ['tasks', 'workflow'],
  schedule: ['schedule', 'automation'],
  shell: ['shell', 'commands'],
  memory: ['preferences', 'communication'],
};

async function buildPersonalityContext(
  sessionId: string,
  workspacePath: string,
  messageText: string,
  executionMode: string,
  historyLength: number,
): Promise<string> {

  // ── Recent conversation recall ─────────────────────────────────────────────
  // Daily conversation logs live in memory/<date>.md (written by logToDaily
  // every turn) but were never injected, so the model had no idea what was
  // discussed on previous days or in other sessions — "the last conversation"
  // could not be located. Inject the tail of the most recent days so the model
  // can actually recall recent discussions. Tail-heavy: recent talk is what
  // matters for recall.
  // Recall is injected ONLY when the user actually asks about past
  // conversations: unconditional injection leaked yesterday's topics into the
  // current task (the model answered today's question with old memory content).
  const RECENT_CONV_DAYS = 2;
  const RECENT_CONV_TAIL_CHARS = 1400;
  const wantsRecall = MEMORY_RECALL_RE.test(messageText);
  const recentConversations: string[] = [];
  if (wantsRecall) {
    for (let i = RECENT_CONV_DAYS; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0];
      const p = path.join(workspacePath, 'memory', `${d}.md`);
      try {
        if (!fs.existsSync(p)) continue;
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (!content) continue;
        const tail = content.slice(-RECENT_CONV_TAIL_CHARS);
        recentConversations.push(`[${d} 对话记录]\n${tail}`);
      } catch { /* missing/unreadable daily log is not fatal */ }
    }
  }
  const recentConvBlock = recentConversations.length > 0
    ? `\n\n[RECENT_CONVERSATIONS — 以下是历史对话记录（仅尾部摘要），仅供回忆"上次/最后一次对话/最近聊天记录"等提问；它们不是当前任务的事实，回答当前问题以最近的用户消息为准。如需完整记录，可用 read_file 读取 memory/ 目录下的 <日期>.md 文件（如 memory/2026-10-05.md）]\n${recentConversations.join('\n\n')}`
    : '';

  // ── Path B: autonomous execution — full prompt, no changes ─────────────────
  const isAutonomous = executionMode === 'background_task' || executionMode === 'cron' || executionMode === 'heartbeat';
  if (isAutonomous) {
    const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
    const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 800);
    const user = loadWorkspaceFile(workspacePath, 'USER.md', 600);
    const today = new Date().toISOString().split('T')[0];
    const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
    const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      soul ? `[SOUL]\n${soul}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
      recentConvBlock || '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Path A: interactive chat — tiered ─────────────────────────────────────
  const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
  const user = loadWorkspaceFile(workspacePath, 'USER.md', 500);
  const today = new Date().toISOString().split('T')[0];
  const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
  const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';

  // ── Tier 1: first message in session ──────────────────────────────────────
  if (historyLength === 0) {
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
      recentConvBlock || '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Tier 2 / 3: subsequent messages — detect intent ───────────────────────
  const cats = detectToolCategories(messageText);
  // SOUL was already fully injected on the session's first message; on later
  // messages a trimmed excerpt is enough to keep the personality hint without
  // paying the full cost on every turn.
  const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 250);

  // Build tool blocks for detected categories
  const toolBlockParts: string[] = [];
  for (const cat of cats) {
    if (TOOL_BLOCKS[cat]) toolBlockParts.push(TOOL_BLOCKS[cat]);
  }

  // Build memory snippets for categories related to detected tool groups.
  // Inject only when the message signals that domain; cap the size; mark the
  // block background-only so unrelated memory never steers the current task.
  const memoryCategoryKeywords: string[] = [];
  for (const cat of cats) {
    const memCats = TOOL_TO_MEMORY_CATS[cat] || [];
    memoryCategoryKeywords.push(...memCats);
  }
  const rawMemorySnippets = memoryCategoryKeywords.length > 0
    ? readMemorySnippets(workspacePath, memoryCategoryKeywords)
    : '';
  const memorySnippets = rawMemorySnippets.length > 1500 ? rawMemorySnippets.slice(0, 1500) : rawMemorySnippets;
  const memoryBlock = memorySnippets
    ? `[RELEVANT_MEMORY — 相关背景记忆，仅供背景参考；与当前任务无关时请忽略，不要据此编造事实]\n${memorySnippets}`
    : '';
  console.log(`[v2] memory injection: cats=${Array.from(cats).join(',')} snippets=${memorySnippets.length} chars`);

  // Tier 3: complex/multi-domain — add tools.md hint
  const isComplex = cats.size >= 3 || /\b(how do i|help me|can you|i need to|i want to)\b/i.test(messageText);
  const toolsHint = isComplex ? `\nFor full tool reference: read_file TOOLS.md` : '';

  // Self.md for debug
  const self = cats.has('debug') ? loadWorkspaceFile(workspacePath, 'SELF.md', 600) : '';

  const parts = [
    identity ? `[IDENTITY]\n${identity}` : '',
    user ? `[USER — 用户档案背景，仅当与当前任务相关时参考]\n${user}` : '',
    soul ? `[SOUL]\n${soul}` : '',
    intradayNotes ? `[TODAY_NOTES — 今日笔记背景，仅当与当前任务相关时参考]\n${intradayNotes}` : '',
    recentConvBlock || '',
    toolBlockParts.length > 0 ? `[TOOLS]\n${toolBlockParts.join('\n\n')}${toolsHint}` : (toolsHint ? `[TOOLS]${toolsHint}` : ''),
    memoryBlock,
    self ? `[SELF]\n${self}` : '',
  ].filter(Boolean);

  await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}

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

// ─── Flow templates (one-click process fix) ───────────────────────────────────
// GET /api/flows — list all flow templates
app.get('/api/flows', listFlows);

// GET /api/flows/:id — single flow template
app.get('/api/flows/:id', getFlowById);

// POST /api/flows — create a flow template (persisted to .smallclaw/flows/)
app.post('/api/flows', createFlow);

// PUT /api/flows/:id — update a flow template in place
app.put('/api/flows/:id', updateFlow);

// DELETE /api/flows/:id — remove a flow template
app.delete('/api/flows/:id', deleteFlow);

// POST /api/flows/:id/run — execute a flow explicitly (SSE stream, same
// pipeline as /api/chat: agent loop + tools + skills + retries)
app.post('/api/flows/:id/run', async (req, res) => {
  const flow = flowsManager.get(String(req.params.id || ''));
  if (!flow) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
  const sessionId = String(req.body?.sessionId || 'default');
  const extra = String(req.body?.message || '').trim();

  if (getModelBusy()) {
    res.status(429).json({ success: false, error: 'Model is busy, try again in a moment' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = createSSESender(res);
  const heartbeat = setInterval(() => sendSSE('heartbeat', { state: 'processing' }), 5000);
  setModelBusy(true);
  const abortSignal = { aborted: false };
  let requestCompleted = false;
  res.on('close', () => {
    if (!requestCompleted && !abortSignal.aborted) {
      abortSignal.aborted = true;
      console.log(`[v2] Flow run aborted — session ${sessionId}, flow ${flow.id}`);
    }
  });

  try {
    const message =
      `请执行流程「${flow.name}」并交付产物。${extra ? `\n用户补充要求：${extra}` : ''}\n\n【执行规范】\n${flow.instruction}`;
    console.log(`[v2] FLOW RUN: ${flow.id} (${flow.name}) session=${sessionId}`);
    const result = await handleChat(
      message,
      sessionId,
      sendSSE,
      undefined,
      abortSignal,
      undefined,
      undefined,
      'interactive',
      true, // suppressFlowTrigger — instruction already injected
    );
    requestCompleted = true;
    if (!abortSignal.aborted) {
      addMessage(sessionId, { role: 'assistant', content: result.text, timestamp: Date.now() });
      sendSSE('final', { text: result.text });
      sendSSE('done', buildFlowDonePayload(result));
    }
  } catch (err: any) {
    requestCompleted = true;
    console.error('[v2] Flow run error:', err?.message || err);
    if (!abortSignal.aborted) sendSSE('error', { message: String(err?.message || err) });
  } finally {
    clearInterval(heartbeat);
    setModelBusy(false);
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

// ─── Skills API ────────────────────────────────────────────────────────────────

app.get('/api/skills', async (_req, res) => {
  recoverSkillsIfEmpty();

  let orchestrationEligibility: { eligible: boolean; reason?: string } = { eligible: true };
  try {
    orchestrationEligibility = await checkOrchestrationEligibility();
  } catch {}

  const skills = skillsManager.getAll().map(s => {
    const isOrchestrator = s.id === 'multi-agent-orchestrator';
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      emoji: s.emoji,
      version: s.version,
      enabled: s.enabled,
      createdAt: s.createdAt,
      eligible: isOrchestrator ? orchestrationEligibility.eligible : true,
      eligibleReason: isOrchestrator
        ? (orchestrationEligibility.eligible ? undefined : orchestrationEligibility.reason)
        : undefined,
    };
  });
  res.json({ success: true, skills });
});

app.get('/api/skills/:id', (req, res) => {
  const skill = skillsManager.get(req.params.id);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill });
});

app.post('/api/skills/:id/toggle', async (req, res) => {
  const skillId = req.params.id;
  const current = skillsManager.get(skillId);
  if (!current) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }

  // Guard enabling orchestration skill until config is eligible.
  if (skillId === 'multi-agent-orchestrator' && !current.enabled) {
    const eligibility = await checkOrchestrationEligibility();
    if (!eligibility.eligible) {
      res.status(409).json({
        success: false,
        error: eligibility.reason || 'Configure a valid secondary model first.',
      });
      return;
    }
  }

  const skill = skillsManager.toggle(skillId);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }

  if (skillId === 'multi-agent-orchestrator') {
    setOrchestrationEnabled(skill.enabled);
  }

  res.json({ success: true, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } });
});

app.post('/api/skills', (req, res) => {
  try {
    const { id, name, description, emoji, instructions } = req.body;
    if (!name || !instructions) { res.status(400).json({ success: false, error: 'Name and instructions required' }); return; }
    const skillId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const skill = skillsManager.create({ id: skillId, name, description: description || '', emoji: emoji || '🧩', instructions });
    res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/skills/:id', (req, res) => {
  const { name, description, emoji, instructions } = req.body;
  const skill = skillsManager.update(req.params.id, { name, description, emoji, instructions });
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
});

app.delete('/api/skills/:id', (req, res) => {
  const ok = skillsManager.delete(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true });
});

// ——— Orchestration Settings API ————————————————————————————————

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function getOrchestrationConfigForApi() {
  const raw = (getConfig().getConfig() as any).orchestration || {};
  // Use the single-source-of-truth clamp utility — no inline duplication.
  const clamped = clampOrchestrationConfig(raw);
  const preempt = clampPreemptConfig(raw.preempt || {});
  return {
    enabled: raw.enabled === true,
    secondary: {
      provider: String(raw.secondary?.provider || '').trim(),
      model: String(raw.secondary?.model || '').trim(),
    },
    ...clamped,
    preempt,
    subagent_mode: raw.subagent_mode === true,
  };
}

app.get('/api/orchestration/config', (_req, res) => {
  res.json(getOrchestrationConfigForApi());
});

app.post('/api/orchestration/config', (req, res) => {
  const current = getOrchestrationConfigForApi();
  const incoming = req.body || {};
  const incomingMode = String(incoming.preflight?.mode || '').trim();
  const incomingRestartMode = String(incoming.preempt?.restart_mode || '').trim();

  const mergedRaw = {
    enabled: typeof incoming.enabled === 'boolean' ? incoming.enabled : current.enabled,
    secondary: {
      provider: String(incoming.secondary?.provider ?? current.secondary.provider).trim(),
      model: String(incoming.secondary?.model ?? current.secondary.model).trim(),
    },
    triggers: {
      ...current.triggers,
      ...(incoming.triggers && typeof incoming.triggers === 'object' ? incoming.triggers : {}),
      loop_detection: typeof incoming.triggers?.loop_detection === 'boolean'
        ? incoming.triggers.loop_detection
        : current.triggers.loop_detection,
    },
    preflight: {
      ...current.preflight,
      ...(incoming.preflight && typeof incoming.preflight === 'object' ? incoming.preflight : {}),
      mode: ['off', 'complex_only', 'always'].includes(incomingMode)
        ? incomingMode
        : current.preflight.mode,
      allow_secondary_chat: typeof incoming.preflight?.allow_secondary_chat === 'boolean'
        ? incoming.preflight.allow_secondary_chat
        : current.preflight.allow_secondary_chat,
    },
    limits: {
      ...current.limits,
      ...(incoming.limits && typeof incoming.limits === 'object' ? incoming.limits : {}),
    },
    browser: {
      ...current.browser,
      ...(incoming.browser && typeof incoming.browser === 'object' ? incoming.browser : {}),
    },
    file_ops: {
      ...current.file_ops,
      ...(incoming.file_ops && typeof incoming.file_ops === 'object' ? incoming.file_ops : {}),
      enabled: typeof incoming.file_ops?.enabled === 'boolean'
        ? incoming.file_ops.enabled
        : current.file_ops.enabled,
      verify_create_always: typeof incoming.file_ops?.verify_create_always === 'boolean'
        ? incoming.file_ops.verify_create_always
        : current.file_ops.verify_create_always,
      checkpointing_enabled: typeof incoming.file_ops?.checkpointing_enabled === 'boolean'
        ? incoming.file_ops.checkpointing_enabled
        : current.file_ops.checkpointing_enabled,
    },
    preempt: {
      ...current.preempt,
      ...(incoming.preempt && typeof incoming.preempt === 'object' ? incoming.preempt : {}),
      enabled: typeof incoming.preempt?.enabled === 'boolean'
        ? incoming.preempt.enabled
        : current.preempt.enabled,
      restart_mode: ['inherit_console', 'detached_hidden'].includes(incomingRestartMode)
        ? incomingRestartMode
        : current.preempt.restart_mode,
    },
  };

  const clamped = clampOrchestrationConfig(mergedRaw);
  const preempt = clampPreemptConfig(mergedRaw.preempt || {});
  const merged = {
    enabled: mergedRaw.enabled,
    secondary: mergedRaw.secondary,
    ...clamped,
    preempt: {
      ...preempt,
      enabled: mergedRaw.preempt.enabled,
    },
  };

  // Persist subagent_mode separately (not inside clampOrchestrationConfig)
  const finalMerged = {
    ...merged,
    subagent_mode: typeof incoming.subagent_mode === 'boolean'
      ? incoming.subagent_mode
      : (current as any).subagent_mode ?? false,
  };

  getConfig().updateConfig({ orchestration: finalMerged } as any);
  res.json({ success: true, config: finalMerged });
});

app.get('/api/orchestration/eligible', async (_req, res) => {
  const eligibility = await checkOrchestrationEligibility();
  res.json(eligibility);
});

app.get('/api/orchestration/telemetry', (req, res) => {
  const sessionId = String(req.query.sessionId || 'default');
  const stats = getOrchestrationSessionStats(sessionId);
  const cfg = getOrchestrationConfig();
  const limit = cfg?.limits?.telemetry_history_limit || 100;
  res.json({
    sessionId,
    assistCount: stats.assistCount,
    assistCap: cfg?.limits?.max_assists_per_session || 0,
    events: stats.events.slice(-limit),
  });
});

app.get('/api/task-status', (req, res) => {
  const sessionId = (req.query.sessionId as string) || 'default';
  const task = activeTasks.get(sessionId);
  if (!task) { res.json({ active: false }); return; }
  res.json({ active: task.status === 'running', ...task, journal: task.journal.slice(-10) });
});

// ─── Tasks / Cron API ──────────────────────────────────────────────────────────

app.get('/api/tasks', (_req, res) => {
  res.json({ success: true, jobs: cronScheduler.getJobs(), config: cronScheduler.getConfig() });
});

app.post('/api/tasks', (req, res) => {
  const { name, prompt, type, schedule, tz, runAt, priority, sessionTarget, payloadKind, systemEventText, model } = req.body;
  if (!name || !prompt) { res.status(400).json({ success: false, error: 'name and prompt required' }); return; }
  if (type === 'heartbeat') {
    res.status(400).json({ success: false, error: 'Heartbeat is no longer a CronJob. Configure HEARTBEAT.md and /api/heartbeat/config instead.' });
    return;
  }
  const job = cronScheduler.createJob({
    name,
    prompt,
    type,
    schedule,
    tz,
    runAt,
    priority,
    sessionTarget,
    payloadKind,
    systemEventText,
    model,
  });
  res.json({ success: true, job });
});

app.put('/api/tasks/:id', (req, res) => {
  const job = cronScheduler.updateJob(req.params.id, req.body);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true, job });
});

app.delete('/api/tasks/:id', (req, res) => {
  const ok = cronScheduler.deleteJob(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true });
});

app.post('/api/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) { res.status(400).json({ success: false, error: 'orderedIds array required' }); return; }
  cronScheduler.reorderJobs(orderedIds);
  res.json({ success: true });
});

app.post('/api/tasks/:id/run', async (req, res) => {
  const jobs = cronScheduler.getJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true, message: 'Job queued for immediate run' });
  cronScheduler.runJobNow(req.params.id, { respectActiveHours: false }).catch(console.error);
});

app.get('/api/tasks/config', (_req, res) => {
  res.json({ success: true, config: cronScheduler.getConfig() });
});

app.put('/api/tasks/config', (req, res) => {
  cronScheduler.updateConfig(req.body);
  res.json({ success: true, config: cronScheduler.getConfig() });
});

app.get('/api/heartbeat/config', (_req, res) => {
  res.json({ success: true, config: heartbeatRunner.getConfig() });
});

app.put('/api/heartbeat/config', (req, res) => {
  const cfg = heartbeatRunner.updateConfig(req.body || {});
  res.json({ success: true, config: cfg });
});

// ─── Background Task Kanban API ─────────────────────────────────────────────────

app.get('/api/bg-tasks', (_req, res) => {
  const tasks = listTasks();
  const heartbeatConfig = loadTaskHeartbeatConfig();
  res.json({ success: true, tasks, heartbeatConfig });
});

app.get('/api/bg-tasks/:id', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  res.json({ success: true, task });
});

app.delete('/api/bg-tasks/:id', (req, res) => {
  const ok = deleteTask(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  res.json({ success: true });
});

app.post('/api/bg-tasks/:id/pause', (req, res) => {
  const task = updateTaskStatus(req.params.id, 'paused', { pauseReason: 'user_pause' });
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  BackgroundTaskRunner.requestPause(req.params.id);
  const sid = task.sessionId || 'default';
  const ws = getWorkspace(sid) || (getConfig().getConfig() as any).workspace?.path || '';
  if (ws) {
    hookBus.fire({
      type: 'command:stop',
      sessionId: sid,
      workspacePath: ws,
      timestamp: Date.now(),
    }).catch((err: any) => console.warn('[hooks] command:stop error:', err?.message || err));
  }
  res.json({ success: true });
});

app.post('/api/bg-tasks/:id/resume', (req, res) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  const resumableStatuses: TaskStatus[] = ['paused', 'queued', 'stalled', 'needs_assistance', 'running', 'failed'];
  if (resumableStatuses.includes(task.status as TaskStatus)) {
    // If status is 'running' but no active runner exists, the runner died without cleanup.
    // Treat it as resumable — reset to queued and start a fresh runner.
    if (task.status === 'running' && BackgroundTaskRunner.isRunning(task.id)) {
      res.json({ success: false, error: 'Task is already actively running.' });
      return;
    }
    // Status is 'running' but runner is dead — clear any ghost activeRunners entry before relaunching
    if (task.status === 'running') {
      BackgroundTaskRunner.forceRelease(task.id);
    }
    updateTaskStatus(task.id, 'queued');
    const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
    runner.start().catch(err => console.error(`[BackgroundTaskRunner] Resume ${task.id} error:`, err.message));
    res.json({ success: true });
  } else {
    res.json({ success: false, error: `Task status is ${task.status}, cannot resume` });
  }
});

// ─── Error Response Endpoint ────────────────────────────────────────────────
// Receives structured user response to a task error, injects it as a resume
// instruction, and relaunches the task runner so the agent acts on it.
app.post('/api/bg-tasks/:id/error-response', async (req: any, res: any) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }

  const { action, category, inputs } = req.body || {};
  if (!action) { res.status(400).json({ success: false, error: 'action is required' }); return; }

  // Build a clear natural-language injection the agent will see on its next round
  let instruction = '';

  if (action === 'cancel') {
    // User wants to stop — mark failed and return
    updateTaskStatus(task.id, 'failed', { pauseReason: undefined });
    appendJournal(task.id, { type: 'status_push', content: 'User cancelled task via error response.' });
    res.json({ success: true, resumed: false });
    return;
  }

  if (action === 'credentials' && inputs?.email) {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has provided login credentials to resolve the authentication error.`,
      `Email: ${inputs.email}`,
      `Password: [PROVIDED — use the credential ID to retrieve it]`,
      ``,
      `Your next steps:`,
      `1. Return to the login form on the page`,
      `2. Fill the email field with: ${inputs.email}`,
      `3. Fill the password field with the provided password`,
      `4. Click the login/submit button`,
      `5. If a 2FA/verification code is requested next, pause and ask the user`,
      `6. Do NOT retry with the same credentials if login fails — pause and ask user instead`,
    ].join('\n');

    // Store credentials securely if credential handler is available
    try {
      const credHandler = getCredentialHandler();
      const credId = credHandler.store(task.id, 'auth', { email: inputs.email, password: inputs.password || '' });
      instruction += `\nCredential ID (for secure retrieval): ${credId}`;
      getErrorAudit(path.join(CONFIG_DIR_PATH, 'logs', 'audit.log')).logCredentialProvided(task.id, 'auth');
    } catch {}

  } else if (action === 'verification_code' && inputs?.code) {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has provided the verification/2FA code: ${inputs.code}`,
      ``,
      `Your next steps:`,
      `1. Find the verification code input field on the page`,
      `2. Fill it with: ${inputs.code}`,
      `3. Submit/confirm the code`,
      `4. Continue the original task after successful verification`,
    ].join('\n');

  } else if (action === 'manual_complete') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has manually completed the CAPTCHA or challenge.`,
      `The page should now be accessible. Continue from where you left off.`,
      `Take a fresh browser_snapshot() to see the current page state before proceeding.`,
    ].join('\n');

  } else if (action === 'retry_now' || action === 'retry_delay') {
    const delayMs = action === 'retry_delay' ? 30000 : 0;
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has requested a retry after the network/service error.`,
      `Retry the last failed operation. If it fails again, pause for assistance.`,
    ].join('\n');

  } else if (action === 'skip_content' || action === 'skip_step' || action === 'skip') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has chosen to skip this step/content.`,
      `Do not attempt this step again. Move on to the next task step.`,
      `Mark this step as skipped and continue.`,
    ].join('\n');

  } else if (action === 'grant_permission') {
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user has granted permission or resolved the access issue.`,
      `Retry the operation that was blocked. If still denied, skip and continue.`,
    ].join('\n');

  } else if (action === 'google' || action === 'oauth') {
    const provider = inputs?.provider || 'Google';
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `The user wants to use ${provider} OAuth sign-in.`,
      `Find and click the "Sign in with ${provider}" button on the page.`,
      `The browser will handle the OAuth redirect. Wait for it to complete and return to the original page.`,
      `If a verification code or additional step is needed after OAuth, pause and ask the user.`,
    ].join('\n');

  } else {
    // Generic fallback — pass raw action as instruction
    instruction = [
      `CRITICAL INSTRUCTION (from user — error response):`,
      `User action: ${action}`,
      inputs ? `Additional context: ${JSON.stringify(inputs)}` : '',
      `Proceed accordingly. If unsure, take a fresh browser_snapshot() and reassess.`,
    ].filter(Boolean).join('\n');
  }

  // Inject instruction into resume context so the runner sees it immediately
  updateResumeContext(task.id, { onResumeInstruction: instruction });
  appendJournal(task.id, {
    type: 'status_push',
    content: `Error response received: action=${action} category=${category || 'unknown'}. Resuming task.`,
  });

  // Requeue and relaunch
  updateTaskStatus(task.id, 'queued', { pauseReason: undefined });
  const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
  runner.start().catch((err: any) => console.error(`[ErrorResponse] Task ${task.id} resume error:`, err.message));

  res.json({ success: true, resumed: true, action });
});

// Inject a user message into the task's session — lets the web UI chat directly with the task agent.
// If the task is paused/needs_assistance, it also resumes it so the agent sees and responds to the message.
app.post('/api/bg-tasks/:id/message', async (req: any, res: any) => {
  const task = loadTask(req.params.id);
  if (!task) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  const userMessage = String(req.body?.message || '').trim();
  if (!userMessage) { res.status(400).json({ success: false, error: 'message is required' }); return; }

  // Inject the message into the task session so the agent sees it on the next round.
  const sessionId = `task_${task.id}`;
  addMessage(sessionId, { role: 'user', content: userMessage, timestamp: Date.now() });
  appendJournal(task.id, { type: 'status_push', content: `User replied via task panel: ${userMessage.slice(0, 200)}` });

  // If the task is waiting for guidance, resume it so it processes the message.
  const needsResume = task.status === 'needs_assistance' || task.status === 'paused' || task.status === 'stalled';
  if (needsResume) {
    updateTaskStatus(task.id, 'queued');
    const runner = new BackgroundTaskRunner(task.id, handleChat, makeBroadcastForTask(task.id), telegramChannel);
    runner.start().catch((err: any) => console.error(`[BackgroundTaskRunner] MessageResume ${task.id} error:`, err.message));
  }

  res.json({ success: true, resumed: needsResume });
});

// SSE stream for live task updates
app.get('/api/bg-tasks/:id/stream', (req, res) => {
  const taskId = req.params.id;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const send = (data: any) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  };

  // Send current state immediately
  const task = loadTask(taskId);
  if (task) send({ type: 'snapshot', task });

  // Poll task file every 2s for updates
  let lastJournalLen = task?.journal?.length || 0;
  const poll = setInterval(() => {
    const t = loadTask(taskId);
    if (!t) { clearInterval(poll); send({ type: 'error', message: 'Task not found' }); res.end(); return; }
    if (t.journal.length !== lastJournalLen) {
      lastJournalLen = t.journal.length;
      send({ type: 'update', task: t });
    }
    if (t.status === 'complete' || t.status === 'failed') {
      send({ type: 'final', task: t });
      clearInterval(poll);
      res.end();
    }
  }, 2000);

  req.on('close', () => clearInterval(poll));
});

// Task heartbeat config API
const taskHeartbeatPath = path.join(CONFIG_DIR_PATH, 'task-heartbeat.json');

function loadTaskHeartbeatConfig(): { enabled: boolean; interval_minutes: number } {
  try {
    if (fs.existsSync(taskHeartbeatPath)) return JSON.parse(fs.readFileSync(taskHeartbeatPath, 'utf-8'));
  } catch {}
  return { enabled: true, interval_minutes: 10 };
}

function saveTaskHeartbeatConfig(cfg: { enabled: boolean; interval_minutes: number }): void {
  try { fs.mkdirSync(path.dirname(taskHeartbeatPath), { recursive: true }); } catch {}
  fs.writeFileSync(taskHeartbeatPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

app.get('/api/bg-tasks/heartbeat/config', (_req, res) => {
  res.json({ success: true, config: loadTaskHeartbeatConfig() });
});

app.put('/api/bg-tasks/heartbeat/config', (req, res) => {
  const current = loadTaskHeartbeatConfig();
  const next = {
    enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : current.enabled,
    interval_minutes: Math.max(1, Math.min(1440, Number(req.body.interval_minutes) || current.interval_minutes)),
  };
  saveTaskHeartbeatConfig(next);
  scheduleTaskHeartbeat();
  res.json({ success: true, config: next });
});

// ─── Task Heartbeat Scheduler ───────────────────────────────────────────────

let taskHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;

// Per-task followup timers — fired when a step completes to resume quickly
// instead of waiting the full heartbeat interval.
const taskFollowupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTaskFollowup(taskId: string, delayMs: number): void {
  // Cancel any existing followup for this task
  const existing = taskFollowupTimers.get(taskId);
  if (existing) clearTimeout(existing);
  console.log(`[TaskFollowup] Scheduling quick resume for task ${taskId} in ${Math.round(delayMs / 1000)}s`);
  const t = setTimeout(async () => {
    taskFollowupTimers.delete(taskId);
    if (getModelBusy()) {
      // Retry in 30s if model is busy
      scheduleTaskFollowup(taskId, 30_000);
      return;
    }
    const task = loadTask(taskId);
    if (!task || task.status === 'complete' || task.status === 'failed' || task.status === 'running') return;
    console.log(`[TaskFollowup] Quick-resuming task ${taskId}: ${task.title}`);
    updateTaskStatus(taskId, 'queued');
    appendJournal(taskId, { type: 'heartbeat', content: 'Quick follow-up resume triggered after step completion.' });
    const runner = new BackgroundTaskRunner(taskId, handleChat, makeBroadcastForTask(taskId), telegramChannel);
    runner.start().catch(err => console.error(`[TaskFollowup] Runner error:`, err.message));
    broadcastWS({ type: 'task_heartbeat_resumed', taskId, rationale: 'Quick step follow-up' });
  }, delayMs);
  if (t && typeof (t as any).unref === 'function') (t as any).unref();
  taskFollowupTimers.set(taskId, t);
}

// Broadcast interceptor for BackgroundTaskRunner — catches internal signals
// that need server-side action (like scheduling a quick step follow-up)
// while still forwarding all events to WS clients.
function makeBroadcastForTask(taskId: string): (data: object) => void {
  return (data: object) => {
    const d = data as any;
    if (d.type === 'task_step_followup_needed' && d.taskId === taskId) {
      scheduleTaskFollowup(taskId, d.delayMs || 120_000);
      // Don't forward this internal signal to UI clients
      return;
    }
    broadcastWS(data);
  };
}


// Chat loop lives in chat-handler.ts; the six singletons it closes over are
// injected here (composition root). All callers (cron/telegram/heartbeat/boot
// /task runners) resolve handleChat at runtime, so this wiring order is safe.
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

function scheduleTaskHeartbeat(): void {
  if (taskHeartbeatTimer) clearTimeout(taskHeartbeatTimer);
  const cfg = loadTaskHeartbeatConfig();
  if (!cfg.enabled) return;
  const intervalMs = cfg.interval_minutes * 60 * 1000;
  taskHeartbeatTimer = setTimeout(runTaskHeartbeat, intervalMs);
  if (taskHeartbeatTimer && typeof (taskHeartbeatTimer as any).unref === 'function') {
    (taskHeartbeatTimer as any).unref();
  }
}

async function runTaskHeartbeat(): Promise<void> {
  if (getModelBusy()) {
    scheduleTaskHeartbeat();
    return;
  }
  const orchCfg = getOrchestrationConfig();
  if (!orchCfg?.enabled) {
    scheduleTaskHeartbeat();
    return;
  }

  const pausedOrQueued = listTasks({ status: ['paused', 'queued', 'stalled'] });
  if (pausedOrQueued.length === 0) {
    scheduleTaskHeartbeat();
    return;
  }

  console.log(`[TaskHeartbeat] Firing advisor for ${pausedOrQueued.length} task(s)...`);
  broadcastWS({ type: 'task_heartbeat_tick', taskCount: pausedOrQueued.length });

  // Single-pass map: pull both buildTaskSnapshot fields and raw task timestamps together
  // so there is no implicit index coupling between chained map calls.
  const snapshots: HeartbeatTaskSnapshot[] = pausedOrQueued.map(t => {
    const s = buildTaskSnapshot(t);
    return {
      id: s.id,
      title: s.title,
      status: s.status,
      pauseReason: s.pauseReason,
      currentStepIndex: s.currentStepIndex,
      totalSteps: s.totalSteps,
      currentStepDescription: s.currentStep,
      lastProgressAt: t.lastProgressAt,
      startedAt: t.startedAt,
      lastJournalEntries: s.recentJournal,
      channel: s.channel,
      sessionId: s.sessionId,
    };
  });

  try {
    const decision = await callSecondaryHeartbeatAdvisor({ tasks: snapshots, currentTimeMs: Date.now() });
    if (!decision || decision.verdict !== 'continue' || !decision.resume_task_id) {
      console.log(`[TaskHeartbeat] Advisor verdict: ${decision?.verdict || 'null'} — nothing to resume.`);
      scheduleTaskHeartbeat();
      return;
    }

    const taskToResume = loadTask(decision.resume_task_id);
    if (!taskToResume) {
      scheduleTaskHeartbeat();
      return;
    }

    // Apply any plan mutations the advisor suggested
    if (decision.plan_mutations?.length) {
      mutatePlan(decision.resume_task_id, decision.plan_mutations);
    }

    appendJournal(decision.resume_task_id, {
      type: 'heartbeat',
      content: `Heartbeat resume: ${decision.rationale.slice(0, 120)}`,
    });

    updateTaskStatus(decision.resume_task_id, 'queued');
    const runner = new BackgroundTaskRunner(
      decision.resume_task_id,
      handleChat,
      makeBroadcastForTask(decision.resume_task_id),
      telegramChannel,
      decision.opening_action,
    );
    runner.start().catch(err => console.error(`[TaskHeartbeat] Runner error:`, err.message));
    broadcastWS({ type: 'task_heartbeat_resumed', taskId: decision.resume_task_id, rationale: decision.rationale });
    console.log(`[TaskHeartbeat] Resuming task ${decision.resume_task_id}: ${taskToResume.title}`);
  } catch (err: any) {
    console.error('[TaskHeartbeat] Advisor error:', err.message);
  }

  scheduleTaskHeartbeat();
}

// ─── Channels API ──────────────────────────────────────────────────────────────

async function testTelegramConfig(token: string): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!token) return { success: false, error: 'No Telegram bot token provided' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, { method: 'POST' });
    const data: any = await resp.json();
    if (!data.ok) return { success: false, error: data.description || 'Invalid token' };
    return { success: true, bot: { username: data.result.username, firstName: data.result.first_name, id: data.result.id } };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testDiscordConfig(dc: DiscordChannelConfig): Promise<{ success: boolean; bot?: any; error?: string }> {
  if (!dc.botToken) return { success: false, error: 'No Discord bot token provided' };
  try {
    const meResp = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${dc.botToken}` },
    });
    const meData: any = await meResp.json();
    if (!meResp.ok) return { success: false, error: meData?.message || `Discord API ${meResp.status}` };

    return {
      success: true,
      bot: { username: meData.username, id: meData.id, discriminator: meData.discriminator },
    };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

async function testWhatsAppConfig(wa: WhatsAppChannelConfig): Promise<{ success: boolean; account?: any; error?: string }> {
  if (!wa.accessToken) return { success: false, error: 'No WhatsApp access token provided' };
  if (!wa.phoneNumberId) return { success: false, error: 'No WhatsApp phone number ID provided' };
  try {
    const url = `https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}?fields=id,display_phone_number,verified_name`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${wa.accessToken}` },
    });
    const data: any = await resp.json();
    if (!resp.ok) return { success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` };
    return { success: true, account: data };
  } catch (err: any) {
    return { success: false, error: String(err?.message || err) };
  }
}

app.get('/api/channels/status', (_req, res) => {
  const runtimeTelegram = telegramChannel.getStatus();
  const channels = resolveChannelsConfig();

  res.json({
    success: true,
    telegram: {
      ...runtimeTelegram,
      enabled: channels.telegram.enabled,
      hasToken: !!channels.telegram.botToken,
      allowedUserIds: channels.telegram.allowedUserIds,
    },
    discord: {
      enabled: channels.discord.enabled,
      hasToken: !!channels.discord.botToken,
      hasWebhook: !!channels.discord.webhookUrl,
      applicationId: channels.discord.applicationId,
      guildId: channels.discord.guildId,
      channelId: channels.discord.channelId,
    },
    whatsapp: {
      enabled: channels.whatsapp.enabled,
      hasAccessToken: !!channels.whatsapp.accessToken,
      phoneNumberId: channels.whatsapp.phoneNumberId,
      businessAccountId: channels.whatsapp.businessAccountId,
      verifyTokenSet: !!channels.whatsapp.verifyToken,
      webhookSecretSet: !!channels.whatsapp.webhookSecret,
      testRecipient: channels.whatsapp.testRecipient,
    },
  });
});

app.post('/api/channels/config', async (req, res) => {
  const incoming = req.body?.channels || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();

  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...(incoming.telegram || {}) });
  const mergedDiscord = normalizeDiscordConfig({ ...existing.discord, ...(incoming.discord || {}) });
  const mergedWhatsApp = normalizeWhatsAppConfig({ ...existing.whatsapp, ...(incoming.whatsapp || {}) });

  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: mergedDiscord,
    whatsapp: mergedWhatsApp,
  };

  // Keep legacy top-level telegram key in sync for backward compatibility.
  cm.updateConfig({
    channels,
    telegram: mergedTelegram,
  } as any);

  telegramChannel.updateConfig(mergedTelegram);

  res.json({
    success: true,
    channels: {
      telegram: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds },
      discord: { enabled: mergedDiscord.enabled, hasToken: !!mergedDiscord.botToken, hasWebhook: !!mergedDiscord.webhookUrl },
      whatsapp: { enabled: mergedWhatsApp.enabled, hasAccessToken: !!mergedWhatsApp.accessToken, phoneNumberId: mergedWhatsApp.phoneNumberId },
    },
  });
});

app.post('/api/channels/test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    const token = String(req.body?.botToken || channels.telegram.botToken || '');
    const result = await testTelegramConfig(token);
    res.json(result);
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const result = await testDiscordConfig(dc);
    res.json(result);
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const result = await testWhatsAppConfig(wa);
    res.json(result);
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

app.post('/api/channels/send-test/:channel', async (req, res) => {
  const channel = String(req.params.channel || '').toLowerCase();
  const channels = resolveChannelsConfig();

  if (channel === 'telegram') {
    try {
      await telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
      res.json({ success: true });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'discord') {
    const dc = normalizeDiscordConfig({ ...channels.discord, ...(req.body || {}) });
    const text = String(req.body?.text || '🦞 SmallClaw test message - Discord is connected!');
    if (dc.webhookUrl) {
      try {
        const resp = await fetch(dc.webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          res.json({ success: false, error: body || `Discord webhook HTTP ${resp.status}` });
          return;
        }
        res.json({ success: true });
      } catch (err: any) {
        res.json({ success: false, error: String(err?.message || err) });
      }
      return;
    }
    if (!dc.botToken || !dc.channelId) {
      res.json({ success: false, error: 'Provide Discord webhook URL or bot token + channel ID' });
      return;
    }
    try {
      const resp = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(dc.channelId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${dc.botToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ content: text }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.message || `Discord API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.id });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  if (channel === 'whatsapp') {
    const wa = normalizeWhatsAppConfig({ ...channels.whatsapp, ...(req.body || {}) });
    const to = String(req.body?.to || wa.testRecipient || '').trim();
    const text = String(req.body?.text || 'SmallClaw test message - WhatsApp is connected!');
    if (!wa.accessToken || !wa.phoneNumberId || !to) {
      res.json({ success: false, error: 'Provide WhatsApp access token, phone number ID, and test recipient number' });
      return;
    }
    try {
      const resp = await fetch(`https://graph.facebook.com/v20.0/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${wa.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      const data: any = await resp.json();
      if (!resp.ok) {
        res.json({ success: false, error: data?.error?.message || `WhatsApp API ${resp.status}` });
        return;
      }
      res.json({ success: true, messageId: data?.messages?.[0]?.id || null });
    } catch (err: any) {
      res.json({ success: false, error: String(err?.message || err) });
    }
    return;
  }

  res.status(400).json({ success: false, error: `Unsupported channel: ${channel}` });
});

// Legacy Telegram endpoints (compatibility wrappers)
app.get('/api/telegram/status', (_req, res) => {
  const runtimeTelegram = telegramChannel.getStatus();
  const channels = resolveChannelsConfig();
  res.json({
    success: true,
    ...runtimeTelegram,
    enabled: channels.telegram.enabled,
    hasToken: !!channels.telegram.botToken,
    allowedUserIds: channels.telegram.allowedUserIds,
  });
});

app.post('/api/telegram/config', async (req, res) => {
  const incoming = req.body || {};
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const existing = resolveChannelsConfig();
  const mergedTelegram = normalizeTelegramConfig({ ...existing.telegram, ...incoming });
  const channels = {
    ...(current.channels || {}),
    telegram: mergedTelegram,
    discord: existing.discord,
    whatsapp: existing.whatsapp,
  };
  cm.updateConfig({ channels, telegram: mergedTelegram } as any);
  telegramChannel.updateConfig(mergedTelegram);
  res.json({ success: true, config: { enabled: mergedTelegram.enabled, hasToken: !!mergedTelegram.botToken, allowedUserIds: mergedTelegram.allowedUserIds } });
});

app.post('/api/telegram/test', async (req, res) => {
  const channels = resolveChannelsConfig();
  const token = String(req.body?.botToken || channels.telegram.botToken || '');
  const result = await testTelegramConfig(token);
  res.json(result);
});

app.post('/api/telegram/send-test', async (req, res) => {
  try {
    await telegramChannel.sendToAllowed('🦞 SmallClaw test message - Telegram is connected!');
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: String(err?.message || err) });
  }
});

type AgentToolProfile = 'minimal' | 'coding' | 'web' | 'full';

function sanitizeAgentId(value: any): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeAgentDefinition(raw: any, fallbackId?: string): any {
  const id = sanitizeAgentId(raw?.id || fallbackId || '');
  const profile = String(raw?.tools?.profile || '').trim();
  const normalized: any = {
    id,
    name: String(raw?.name || id || 'Agent').trim() || 'Agent',
  };
  if (raw?.description !== undefined) normalized.description = String(raw.description || '').trim();
  if (raw?.emoji !== undefined) normalized.emoji = String(raw.emoji || '').trim();
  if (raw?.workspace !== undefined) normalized.workspace = String(raw.workspace || '').trim();
  if (raw?.model !== undefined) normalized.model = String(raw.model || '').trim();
  if (typeof raw?.minimalPrompt === 'boolean') normalized.minimalPrompt = raw.minimalPrompt;
  if (typeof raw?.default === 'boolean') normalized.default = raw.default;
  if (typeof raw?.canSpawn === 'boolean') normalized.canSpawn = raw.canSpawn;
  if (raw?.cronSchedule !== undefined) normalized.cronSchedule = String(raw.cronSchedule || '').trim();
  if (raw?.maxSteps !== undefined) {
    const n = Number(raw.maxSteps);
    if (Number.isFinite(n) && n > 0) normalized.maxSteps = Math.floor(n);
  }
  if (Array.isArray(raw?.spawnAllowlist)) {
    normalized.spawnAllowlist = raw.spawnAllowlist
      .map((v: any) => sanitizeAgentId(v))
      .filter((v: string) => !!v);
  }
  if (raw?.tools && typeof raw.tools === 'object') {
    normalized.tools = {};
    if (Array.isArray(raw.tools.allow)) normalized.tools.allow = raw.tools.allow.map((s: any) => String(s || '').trim()).filter(Boolean);
    if (Array.isArray(raw.tools.deny)) normalized.tools.deny = raw.tools.deny.map((s: any) => String(s || '').trim()).filter(Boolean);
    if (['minimal', 'coding', 'web', 'full'].includes(profile)) normalized.tools.profile = profile as AgentToolProfile;
    if (!normalized.tools.allow && !normalized.tools.deny && !normalized.tools.profile) delete normalized.tools;
  }
  if (Array.isArray(raw?.bindings)) {
    normalized.bindings = raw.bindings
      .filter((b: any) => b && ['telegram', 'discord', 'whatsapp'].includes(String(b.channel || '')))
      .map((b: any) => ({
        channel: String(b.channel),
        ...(b.accountId ? { accountId: String(b.accountId) } : {}),
        ...(b.peerId ? { peerId: String(b.peerId) } : {}),
      }));
  }
  return normalized;
}

function normalizeAgentsForSave(incomingAgents: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const raw of incomingAgents || []) {
    const n = normalizeAgentDefinition(raw);
    if (!n.id || seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  if (out.length > 0 && !out.some(a => a.default === true)) out[0].default = true;
  if (out.filter(a => a.default === true).length > 1) {
    let found = false;
    for (const a of out) {
      if (a.default === true && !found) { found = true; continue; }
      if (a.default === true) a.default = false;
    }
  }
  return out;
}

function findLastCronRunAt(agentId: string): number | null {
  const entries = getAgentRunHistory(agentId, 100);
  const hit = entries.find((e) => e.trigger === 'cron');
  return hit ? hit.finishedAt : null;
}

app.get('/api/agents', (_req, res) => {
  const cfg = getConfig().getConfig() as any;
  const explicitAgents = Array.isArray(cfg.agents) ? cfg.agents : [];
  const agents = getAgents().map((agent) => {
    const workspace = resolveAgentWorkspace(agent as any);
    const lastRun = getAgentLastRun(agent.id);
    return {
      ...agent,
      workspaceResolved: workspace,
      workspaceExists: fs.existsSync(workspace),
      isSynthetic: explicitAgents.length === 0 && agent.id === 'main',
      lastRun: lastRun || null,
      lastHeartbeatAt: findLastCronRunAt(agent.id),
    };
  });
  const defaultAgent = agents.find((a) => a.default) || agents[0] || null;
  res.json({ success: true, agents, defaultAgentId: defaultAgent?.id || null });
});

app.get('/api/agents/history', (req, res) => {
  const agentId = String(req.query.agentId || '').trim() || undefined;
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  res.json({ success: true, history: getAgentRunHistory(agentId, limit) });
});

app.post('/api/agents', (req, res) => {
  const incoming = req.body?.agent || req.body || {};
  const normalized = normalizeAgentDefinition(incoming);
  if (!normalized.id) {
    res.status(400).json({ success: false, error: 'agent.id is required' });
    return;
  }
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const idx = explicitAgents.findIndex((a: any) => sanitizeAgentId(a.id) === normalized.id);
  const next = idx >= 0
    ? explicitAgents.map((a: any, i: number) => (i === idx ? { ...a, ...normalized } : a))
    : [...explicitAgents, normalized];
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  const saved = finalAgents.find(a => a.id === normalized.id);
  if (saved) ensureAgentWorkspace(saved as any);
  reloadAgentSchedules();
  res.json({ success: true, agent: saved || normalized, created: idx < 0 });
});

app.put('/api/agents/:id', (req, res) => {
  const targetId = sanitizeAgentId(req.params.id);
  if (!targetId) {
    res.status(400).json({ success: false, error: 'Invalid agent id' });
    return;
  }
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const idx = explicitAgents.findIndex((a: any) => sanitizeAgentId(a.id) === targetId);
  if (idx < 0) {
    res.status(404).json({ success: false, error: `Agent "${targetId}" not found in config` });
    return;
  }
  const merged = normalizeAgentDefinition({ ...explicitAgents[idx], ...(req.body?.agent || req.body || {}), id: targetId }, targetId);
  const next = explicitAgents.map((a: any, i: number) => (i === idx ? merged : a));
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  ensureAgentWorkspace(merged as any);
  reloadAgentSchedules();
  res.json({ success: true, agent: merged });
});

app.delete('/api/agents/:id', (req, res) => {
  const targetId = sanitizeAgentId(req.params.id);
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const explicitAgents = Array.isArray(current.agents) ? current.agents : [];
  const next = explicitAgents.filter((a: any) => sanitizeAgentId(a.id) !== targetId);
  if (next.length === explicitAgents.length) {
    res.status(404).json({ success: false, error: `Agent "${targetId}" not found` });
    return;
  }
  const finalAgents = normalizeAgentsForSave(next);
  cm.updateConfig({ agents: finalAgents } as any);
  reloadAgentSchedules();
  res.json({ success: true });
});

app.get('/api/agents/:id/agents-md', (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const workspace = ensureAgentWorkspace(agent as any);
  const filePath = path.join(workspace, 'AGENTS.md');
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  res.json({ success: true, agentId, path: filePath, content });
});

app.put('/api/agents/:id/agents-md', (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const content = String(req.body?.content || '');
  const workspace = ensureAgentWorkspace(agent as any);
  const filePath = path.join(workspace, 'AGENTS.md');
  fs.writeFileSync(filePath, content, 'utf-8');
  res.json({ success: true, path: filePath });
});

app.post('/api/agents/:id/spawn', async (req, res) => {
  const agentId = sanitizeAgentId(req.params.id);
  const agent = getAgentById(agentId);
  if (!agent) {
    res.status(404).json({ success: false, error: `Agent "${agentId}" not found` });
    return;
  }
  const task = String(req.body?.task || '').trim();
  if (!task) {
    res.status(400).json({ success: false, error: 'task is required' });
    return;
  }
  const context = req.body?.context !== undefined ? String(req.body.context) : undefined;
  const maxStepsRaw = req.body?.maxSteps;
  const maxSteps = Number.isFinite(Number(maxStepsRaw)) && Number(maxStepsRaw) > 0
    ? Math.floor(Number(maxStepsRaw))
    : undefined;
  const timeoutRaw = req.body?.timeoutMs;
  const timeoutMs = Number.isFinite(Number(timeoutRaw)) && Number(timeoutRaw) > 0
    ? Math.floor(Number(timeoutRaw))
    : 120000;

  const startedAt = Date.now();
  const result = await spawnAgent({
    agentId,
    task,
    context,
    maxSteps,
    timeoutMs,
  });
  const finishedAt = Date.now();
  const historyEntry = recordAgentRun({
    agentId: result.agentId,
    agentName: result.agentName,
    trigger: 'manual',
    success: result.success,
    startedAt,
    finishedAt,
    durationMs: result.durationMs,
    stepCount: result.stepCount,
    error: result.error,
    resultPreview: result.success ? String(result.result || '').slice(0, 400) : undefined,
  });
  res.json({ success: result.success, result, historyEntry });
});

// ─── Scheduler API ────────────────────────────────────────────────────────────────

app.get('/api/schedules', (_req, res) => {
  const jobs = cronScheduler.getJobs();
  res.json({
    success: true,
    schedules: jobs.map((job: any) => ({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      cron: job.cron,
      run_at: job.run_at,
      timezone: job.timezone,
      status: job.status || 'active',
      next_run: job.nextRun,
      last_run: job.lastRun,
      delivery_channel: job.deliveryChannel || 'web',
    })),
  });
});

app.post('/api/schedules', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, delivery_channel, confirm } = req.body;
  
  // Require confirmation for create
  if (!isConfirmed(confirm)) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  if (!name || !pattern || !prompt) {
    return res.json({ success: false, error: 'name, pattern, and prompt are required' });
  }
  
  try {
    const job = cronScheduler.createJob({
      name: String(name).slice(0, 100),
      prompt: String(prompt).slice(0, 2000),
      schedule: /^\d/.test(pattern) ? pattern : null,  // If starts with number, assume cron
      runAt: !/^\d/.test(pattern) ? pattern : null,  // NL pattern
      tz: timezone || 'UTC',
      delivery: 'web',  // Only web supported for now
    });
    
    res.json({
      success: true,
      job: {
        id: job.id,
        name: job.name,
        status: 'active',
        next_run: job.nextRun,
      },
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.put('/api/schedules/:id', (req: any, res: any) => {
  const { name, pattern, prompt, timezone, delivery_channel, confirm } = req.body;
  
  if (!isConfirmed(confirm)) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  try {
    const job = cronScheduler.updateJob(req.params.id, {
      name: name ? String(name).slice(0, 100) : undefined,
      prompt: prompt ? String(prompt).slice(0, 2000) : undefined,
      schedule: pattern && /^\d/.test(pattern) ? pattern : undefined,
      runAt: pattern && !/^\d/.test(pattern) ? pattern : undefined,
      tz: timezone || undefined,
    });
    
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.delete('/api/schedules/:id', (req: any, res: any) => {
  const { confirm } = req.body;
  
  if (!isConfirmed(confirm)) {
    return res.json({
      success: false,
      needs_confirmation: true,
      error: 'This action requires explicit confirmation. Set confirm: true to proceed.',
    });
  }
  
  try {
    cronScheduler.deleteJob(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.patch('/api/schedules/:id', (req: any, res: any) => {
  const { status } = req.body;
  
  try {
    const job = cronScheduler.updateJob(req.params.id, { status });
    res.json({ success: true, job });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/schedules/:id/run', (req: any, res: any) => {
  try {
    cronScheduler.runJobNow(req.params.id);
    res.json({ success: true, message: 'Schedule triggered' });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/schedules/parse', (req: any, res: any) => {
  const { text, timezone } = req.body;
  
  if (!text) {
    return res.json({ success: false, error: 'text is required' });
  }
  
  try {
    let cron = '';
    let preview = '';
    const t = text.toLowerCase().trim();
    
    // Helper: extract time from text and handle AM/PM
    function extractTime(text: string): { hour: number; minute: number } | null {
      // Match: "3:13pm", "15:13", "3:13", "11am", etc.
      const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
      if (!timeMatch) return null;
      
      let hour = parseInt(timeMatch[1], 10);
      const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const period = timeMatch[3]?.toLowerCase();
      
      // Convert 12-hour to 24-hour format if AM/PM specified
      if (period === 'pm' && hour !== 12) {
        hour += 12;
      } else if (period === 'am' && hour === 12) {
        hour = 0;
      }
      
      // Validate ranges
      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
      
      return { hour, minute };
    }
    
    if (t.includes('daily') || t.includes('every day')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        const hourStr = String(timeInfo.hour).padStart(2, '0');
        const minStr = String(timeInfo.minute).padStart(2, '0');
        cron = `${timeInfo.minute} ${timeInfo.hour} * * *`;
        preview = `Daily at ${hourStr}:${minStr}`;
      } else {
        cron = '0 9 * * *';
        preview = 'Daily at 09:00';
      }
    } else if (t.includes('weekly')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1`;
        preview = `Weekly on Monday at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1';
        preview = 'Weekly on Monday at 09:00';
      }
    } else if (t.includes('monday') || t.includes('tuesday') || t.includes('wednesday') || t.includes('thursday') || t.includes('friday')) {
      const timeInfo = extractTime(t);
      if (timeInfo) {
        cron = `${timeInfo.minute} ${timeInfo.hour} * * 1-5`;
        preview = `Weekdays at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
      } else {
        cron = '0 9 * * 1-5';
        preview = 'Weekdays at 09:00';
      }
    } else if (/^\d{1,2} \d{1,2} \d|\d \d \*/.test(t)) {
      cron = t;
      preview = 'Custom cron pattern';
    } else {
      return res.json({
        success: false,
        error: 'Could not parse pattern. Try: "daily at 3:13pm", "daily at 15:13", "weekly", or cron like "0 9 * * *"',
        confidence: 0,
      });
    }
    
    res.json({
      success: true,
      kind: 'cron',
      cron,
      human_text: preview,
      preview,
      timezone: timezone || 'UTC',
      confidence: 0.8,
    });
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ─── Settings API ────────────────────────────────────────────────────────────────

app.get('/api/settings/search', (_req, res) => {
  const cm = getConfig();
  const cfg = (cm.getConfig() as any).search || {};
  // Resolve then mask — never send actual key values to the browser.
  // Returns '••••••••' if a key is present (vault or plaintext), '' if not set.
  const maskIfSet = (val: string | undefined): string => {
    if (!val) return '';
    const resolved = cm.resolveSecret(val);
    return resolved ? '••••••••' : '';
  };
  res.json({
    preferred_provider: cfg.preferred_provider || 'tavily',
    search_rigor: cfg.search_rigor || 'verified',
    tavily_api_key: maskIfSet(cfg.tavily_api_key),
    google_api_key: maskIfSet(cfg.google_api_key),
    google_cx: cfg.google_cx || '',   // CSE ID is not a secret
    brave_api_key: maskIfSet(cfg.brave_api_key),
  });
});

app.post('/api/settings/search', (req, res) => {
  const { preferred_provider, search_rigor, tavily_api_key, google_api_key, google_cx, brave_api_key } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  // Only write a key field if the user actually entered a new value.
  // '••••••••' means "leave existing vault entry alone".
  const isNew = (v: any) => v !== undefined && v !== '' && v !== '••••••••';
  const newSearch = {
    ...((current.search || {})),
    ...(preferred_provider !== undefined && { preferred_provider }),
    ...(search_rigor !== undefined && { search_rigor }),
    ...(isNew(tavily_api_key) && { tavily_api_key }),
    ...(isNew(google_api_key) && { google_api_key }),
    ...(google_cx !== undefined && { google_cx }),
    ...(isNew(brave_api_key) && { brave_api_key }),
  };
  cm.updateConfig({ search: newSearch } as any);
  // migrateSecretsToVault() runs inside updateConfig → saveConfig, so any
  // plaintext key just entered is automatically encrypted and replaced with
  // a "vault:<key>" reference before hitting disk.
  res.json({ success: true });
});

// GET /api/credentials/status — list which vault keys are currently stored (names only, no values)
app.get('/api/credentials/status', (_req, res) => {
  try {
    const vault = getVault();
    res.json({ success: true, keys: vault.keys() });
  } catch (err: any) {
    res.json({ success: false, keys: [], error: err.message });
  }
});

// GET /api/credentials/audit — return last N lines of vault-audit.log (scrubbed)
app.get('/api/credentials/audit', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const auditPath = path.join(process.cwd(), '.smallclaw', 'vault', 'vault-audit.log');
    if (!fs.existsSync(auditPath)) { res.json({ success: true, lines: [] }); return; }
    const raw = fs.readFileSync(auditPath, 'utf-8');
    const lines = raw.split('\n').filter((l: string) => l.trim());
    res.json({ success: true, lines: lines.slice(-40) });
  } catch (err: any) {
    res.json({ success: false, lines: [], error: err.message });
  }
});

app.get('/api/settings/paths', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    workspace_path: (cfg as any).workspace?.path || '',
    allowed_paths: (cfg as any).tools?.permissions?.files?.allowed_paths || [],
    blocked_paths: (cfg as any).tools?.permissions?.files?.blocked_paths || [],
  });
});

app.post('/api/settings/paths', (req, res) => {
  const { workspace_path, allowed_paths, blocked_paths } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const tools = {
    ...current.tools,
    permissions: {
      ...current.tools?.permissions,
      files: {
        ...(current.tools?.permissions?.files || {}),
        ...(Array.isArray(allowed_paths) && { allowed_paths }),
        ...(Array.isArray(blocked_paths) && { blocked_paths }),
      },
    },
  };
  const workspacePath = typeof workspace_path === 'string' ? workspace_path.trim() : '';
  if (workspacePath) {
    try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
  }
  cm.updateConfig({
    tools,
    ...(workspacePath ? { workspace: { ...(current.workspace || {}), path: workspacePath } } : {}),
  } as any);
  res.json({ success: true });
});

app.get('/api/settings/agent', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).agent_policy || {};
  res.json({
    force_web_for_fresh: cfg.force_web_for_fresh !== false,
    memory_fallback_on_search_failure: cfg.memory_fallback_on_search_failure !== false,
    auto_store_web_facts: cfg.auto_store_web_facts !== false,
    natural_language_tool_router: cfg.natural_language_tool_router !== false,
    retrieval_mode: cfg.retrieval_mode || 'standard',
  });
});

app.post('/api/settings/agent', (req, res) => {
  const { force_web_for_fresh, memory_fallback_on_search_failure, auto_store_web_facts, natural_language_tool_router, retrieval_mode } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const newPolicy = {
    ...(current.agent_policy || {}),
    ...(force_web_for_fresh !== undefined && { force_web_for_fresh }),
    ...(memory_fallback_on_search_failure !== undefined && { memory_fallback_on_search_failure }),
    ...(auto_store_web_facts !== undefined && { auto_store_web_facts }),
    ...(natural_language_tool_router !== undefined && { natural_language_tool_router }),
    ...(retrieval_mode !== undefined && { retrieval_mode }),
  };
  cm.updateConfig({ agent_policy: newPolicy } as any);
  res.json({ success: true });
});

// ─── Model / Ollama Settings API ──────────────────────────────────────────────────

app.get('/api/settings/model', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    primary: cfg.models.primary,
    roles: cfg.models.roles,
    ollama_endpoint: (cfg as any).ollama?.endpoint || 'http://localhost:11434',
  });
});

app.post('/api/settings/model', (req, res) => {
  const { primary, roles, ollama_endpoint } = req.body;
  const cm = getConfig();
  const current = cm.getConfig();
  if (primary || roles) {
    cm.updateConfig({
      models: {
        primary: primary || current.models.primary,
        roles: { ...current.models.roles, ...(roles || {}) },
      }
    });
  }
  if (ollama_endpoint) {
    cm.updateConfig({
      ollama: { ...(current as any).ollama, endpoint: ollama_endpoint }
    } as any);
  }
  res.json({ success: true, model: getConfig().getConfig().models.primary });
});

// GET /api/settings/think — active model preset's thinking (think) config
app.get('/api/settings/think', (_req, res) => {
  try {
    const cfg = getConfig().getConfig() as any;
    const activeId = String(cfg.llm?.active_preset || '').trim();
    const preset = cfg.llm?.presets?.[activeId] || {};
    const t = preset.think;
    let enabled = false;
    let level: 'low' | 'medium' | 'high' = 'medium';
    if (t === true || t === 'high') { enabled = true; level = 'high'; }
    else if (t === 'medium') { enabled = true; level = 'medium'; }
    else if (t === 'low') { enabled = true; level = 'low'; }
    res.json({ success: true, active_preset: activeId, enabled, level });
  } catch (err: any) {
    res.json({ success: false, error: err?.message || String(err) });
  }
});

// POST /api/settings/think — set think for the active preset (takes effect
// immediately: handleChat reads the preset's think on every turn).
app.post('/api/settings/think', (req, res) => {
  try {
    const { enabled, level } = req.body || {};
    const cm = getConfig();
    const cfg = cm.getConfig() as any;
    const activeId = String(cfg.llm?.active_preset || '').trim();
    if (!activeId) { res.json({ success: false, error: 'no active preset' }); return; }
    const presets = { ...(cfg.llm?.presets || {}) };
    const preset = { ...(presets[activeId] || {}) };
    if (enabled) {
      const lvl = level === 'low' || level === 'high' ? level : 'medium';
      preset.think = lvl;
    } else {
      preset.think = false;
    }
    presets[activeId] = preset;
    cm.updateConfig({ llm: { ...(cfg.llm || {}), presets } } as any);
    res.json({ success: true, active_preset: activeId, enabled: !!enabled, level: enabled ? (preset.think || 'medium') : false });
  } catch (err: any) {
    res.json({ success: false, error: err?.message || String(err) });
  }
});

// Fetch available Ollama models (proxies Ollama /api/tags)
app.get('/api/ollama/models', async (_req, res) => {
  try {
    const ollamaEndpoint = (getConfig().getConfig() as any).ollama?.endpoint || 'http://localhost:11434';
    const response = await fetch(`${ollamaEndpoint}/api/tags`);
    if (!response.ok) { res.json({ success: false, models: [], error: `Ollama returned ${response.status}` }); return; }
    const data = await response.json() as any;
    const models = (data.models || []).map((m: any) => ({
      name: m.name,
      size: m.size,
      parameter_size: m.details?.parameter_size || '',
      family: m.details?.family || '',
      modified_at: m.modified_at,
    }));
    res.json({ success: true, models });
  } catch (err: any) {
    res.json({ success: false, models: [], error: err.message });
  }
});

// ─── System Stats API ───────────────────────────────────────────────────────────

import * as osModule from 'os';

// Track previous CPU times for accurate utilization
let prevCpuTimes: { idle: number; total: number } | null = null;

function getCpuPercent(): number {
  const cpus = osModule.cpus();
  let totalIdle = 0; let totalTick = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) totalTick += (cpu.times as any)[type];
    totalIdle += cpu.times.idle;
  }
  const idle = totalIdle / cpus.length;
  const total = totalTick / cpus.length;
  if (!prevCpuTimes) { prevCpuTimes = { idle, total }; return 0; }
  const idleDiff = idle - prevCpuTimes.idle;
  const totalDiff = total - prevCpuTimes.total;
  prevCpuTimes = { idle, total };
  if (totalDiff === 0) return 0;
  return Math.round(100 * (1 - idleDiff / totalDiff));
}

app.get('/api/system-stats', async (_req, res) => {
  const totalMem = osModule.totalmem();
  const freeMem = osModule.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = (usedMem / totalMem) * 100;
  const cpuPercent = getCpuPercent();
  const rss = process.memoryUsage().rss;

  // Check if Ollama is reachable
  let ollamaRunning = false;
  const ollamaMemMb = 0;
  let ollamaCount = 0;
  try {
    const ollamaEndpoint = (getConfig().getConfig() as any).ollama?.endpoint || 'http://localhost:11434';
    const r = await fetch(`${ollamaEndpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      ollamaRunning = true;
      const data = await r.json() as any;
      ollamaCount = (data.models || []).length;
    }
  } catch {}

  // GPU stats — use the cached detector (probed once at startup, never calls
  // nvidia-smi again). On non-NVIDIA systems this is instant and silent.
  const gpuInfo = detectGpu();
  let gpuStats = { available: false, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: '' };
  if (gpuInfo.nvidiaAvailable) {
    // Re-query utilization metrics only when NVIDIA is confirmed present.
    // This is the *only* place nvidia-smi runs at runtime; startup detection
    // already verified the GPU exists so this call is guaranteed to succeed.
    try {
      const { execSync } = await import('child_process');
      const smiOut = execSync(
        'nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits',
        { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const parts = smiOut.trim().split(',').map((s: string) => s.trim());
      if (parts.length >= 4) {
        const vramUsedMb = Number(parts[2]);
        const vramTotalMb = Number(parts[3]);
        gpuStats = {
          available: true,
          name: parts[0],
          gpu_util_percent: Number(parts[1]),
          vram_used_percent: vramTotalMb > 0 ? (vramUsedMb / vramTotalMb) * 100 : 0,
          vram_used_gb: vramUsedMb / 1024,
          vram_total_gb: vramTotalMb / 1024,
        };
      }
    } catch { /* nvidia-smi already confirmed working at startup; ignore transient errors */ }
  } else if (gpuInfo.amdAvailable) {
    gpuStats = { available: true, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: gpuInfo.name ?? 'AMD GPU' };
  } else if (gpuInfo.appleSilicon) {
    gpuStats = { available: true, gpu_util_percent: 0, vram_used_percent: 0, vram_used_gb: 0, vram_total_gb: 0, name: gpuInfo.name ?? 'Apple Silicon' };
  }

  res.json({
    system: {
      cpu_percent: cpuPercent,
      memory_percent: memPercent,
      memory_used_gb: usedMem / (1024 ** 3),
      memory_total_gb: totalMem / (1024 ** 3),
    },
    gpu: gpuStats,
    ollama_process: { running: ollamaRunning, process_count: ollamaCount, total_memory_mb: ollamaMemMb },
    gateway_process: { rss_mb: rss / (1024 * 1024) },
    active_provider: (getConfig().getConfig() as any).llm?.provider || 'ollama',
    active_model: (() => { const c = getConfig().getConfig() as any; const p = c.llm?.provider || 'ollama'; return c.llm?.providers?.[p]?.model || c.models?.primary || 'unknown'; })(),
    timestamp: new Date().toISOString(),
  });
});

// ─── Agent Session Context API ────────────────────────────────────────────────

app.get('/api/agent/session/:id', (req, res) => {
  const sessionId = req.params.id;
  const history = getHistory(sessionId, 50);
  const userMessages = history.filter(h => h.role === 'user');
  const aiMessages = history.filter(h => h.role === 'assistant');
  const recent = history.slice(-8).map(h => ({
    kind: h.role,
    status: 'completed',
    text: String(h.content || '').slice(0, 120),
  }));
  res.json({
    mode_lock: null,
    mode: ((getOrchestrationConfig()?.enabled ?? false) && isOrchestrationSkillEnabled()) ? 'agent' : 'chat',
    tasks: [],
    task_counts: { total: 0, done: 0 },
    turn_counts: { completed: history.length, open: 0 },
    execution_counts: { total: 0, done: 0, running: 0, failed: 0 },
    recent_turns: recent,
    recent_turn_executions: [],
    current_turn_execution: null,
    overview_objective: userMessages.length > 0 ? String(userMessages[0]?.content || '').slice(0, 80) : null,
    active_objective: userMessages.length > 0 ? String(userMessages[userMessages.length - 1]?.content || '').slice(0, 80) : null,
  });
});

// ─── Approvals API ───────────────────────────────────────────────────────────
// SECURITY: All approval endpoints require gateway auth. Approvals are the
// confirmation gate before the agent executes irreversible actions — an
// unauthenticated bypass here is a critical vulnerability.

// ─── Gateway Auth Middleware ──────────────────────────────────────────────────
// CRIT-03 / CRIT-01 fix: protects approval, memory-confirm, and open-path
// endpoints from unauthenticated access.
//
// Auth strategy (in priority order):
//   1. Bearer token in Authorization header  →  Authorization: Bearer <token>
//   2. X-Gateway-Token header                →  X-Gateway-Token: <token>
//   3. Localhost bypass (127.0.0.1 / ::1)    →  always trusted when no token configured
//
// Token is read from config at request time so it takes effect immediately
// after a config save without requiring a gateway restart.

function requireGatewayAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const cfg = getConfig().getConfig() as any;
  const configuredToken = String(cfg?.gateway?.auth_token || '').trim();

  // If no token is configured, fall back to localhost-only access.
  if (!configuredToken) {
    const remoteIp = String(
      req.ip ||
      req.socket?.remoteAddress ||
      (req.connection as any)?.remoteAddress ||
      ''
    );
    const isLocalhost =
      remoteIp === '127.0.0.1' ||
      remoteIp === '::1' ||
      remoteIp === '::ffff:127.0.0.1';
    if (isLocalhost) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized: configure gateway.auth_token to enable remote access to this endpoint.' });
    return;
  }

  // Extract token from Authorization header or X-Gateway-Token header.
  const authHeader = String(req.headers['authorization'] || '');
  const xGatewayToken = String(req.headers['x-gateway-token'] || '');
  let providedToken = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedToken = authHeader.slice('bearer '.length).trim();
  } else if (xGatewayToken) {
    providedToken = xGatewayToken.trim();
  }

  if (!providedToken || providedToken !== configuredToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}

const pendingApprovals: Map<string, { id: string; action: string; reason: string }> = new Map();

app.get('/api/approvals', requireGatewayAuth, (_req, res) => {
  res.json(Array.from(pendingApprovals.values()));
});

app.post('/api/approvals/:id', requireGatewayAuth, (req, res) => {
  const { decision } = req.body;
  const VALID_DECISIONS = ['approved', 'rejected'];
  if (!decision || !VALID_DECISIONS.includes(decision)) {
    res.status(400).json({ success: false, error: `decision must be one of: ${VALID_DECISIONS.join(', ')}` });
    return;
  }
  const approval = pendingApprovals.get(req.params.id);
  if (!approval) {
    res.status(404).json({ success: false, error: 'Approval not found' });
    return;
  }
  pendingApprovals.delete(req.params.id);
  // Security audit: log every approval action (action name only, no payload)
  import('../security/log-scrubber').then(({ log }) => {
    log.security('[approvals]', decision.toUpperCase(), 'approval-id:', req.params.id, 'action:', approval.action);
  }).catch(() => {});
  res.json({ success: true, decision });
});

// ─── Memory API (stub) ───────────────────────────────────────────────────────────

app.post('/api/memory/confirm', requireGatewayAuth, (req, res) => {
  // Memory persistence stub — can be wired to ChromaDB/vector store
  // SECURITY: req.body is user/agent-supplied content — never log it raw.
  // scrubSecrets runs inside sanitizeToolLog before any write.
  import('../security/log-scrubber').then(({ log, sanitizeToolLog }) => {
    log.info('[Memory]', sanitizeToolLog('confirm', req.body));
  }).catch(() => {});
  res.json({ ok: true });
});

// Open a file path in the OS file explorer
// SECURITY: This endpoint uses execFile() (not exec()) so the path is passed
// as an argument, not interpolated into a shell string. The path is also
// validated to be inside the workspace before execution.
app.post('/api/open-path', requireGatewayAuth, async (req, res) => {
  const fp = (req.body?.path || '') as string;
  if (!fp) { res.status(400).json({ ok: false, error: 'Path required' }); return; }

  // Resolve and validate — must be inside workspace or config dir
  const resolvedFp = path.resolve(fp);
  const workspacePath = getConfig().getWorkspacePath();
  const configDirPath = getConfig().getConfigDir();
  const isInWorkspace = resolvedFp.startsWith(path.resolve(workspacePath));
  const isInConfigDir = resolvedFp.startsWith(path.resolve(configDirPath));
  if (!isInWorkspace && !isInConfigDir) {
    res.status(403).json({ ok: false, error: 'Path is outside allowed directories' });
    return;
  }

  try {
    const { execFile } = await import('child_process');
    // execFile passes args as a list — no shell interpolation possible
    if (process.platform === 'win32') {
      execFile('explorer.exe', [resolvedFp]);
    } else if (process.platform === 'darwin') {
      execFile('open', [resolvedFp]);
    } else {
      execFile('xdg-open', [resolvedFp]);
    }
    res.json({ ok: true });
  } catch (err: any) { res.status(500).json({ ok: false, error: err.message }); }
});

// ─── Provider / Model Settings API ───────────────────────────────────────────
// Used by the Settings → Models tab to read/write provider config and
// trigger the OpenAI OAuth flow.

import { getProvider, resetProvider, buildProviderForLLM } from '../providers/factory';
import { buildWebhookRouter, resolveHookConfig } from './webhook-handler';
import { startOAuthFlow, isConnected, clearTokens, loadTokens, exchangeManualCodeFromPending } from '../auth/openai-oauth';

function sanitizeLLMConfig(llm: any): any {
  if (!llm || typeof llm !== 'object') return llm;
  const copy = JSON.parse(JSON.stringify(llm));
  const codexModel = copy?.providers?.openai_codex?.model;
  if (typeof codexModel === 'string' && codexModel.trim() === 'codex-davinci-002') {
    copy.providers.openai_codex.model = 'gpt-4o';
  }
  return copy;
}

// HIGH-02 fix: redact all api_key / token fields before sending to the UI.
// Vault references ("vault:...") and env references ("env:...") are also masked
// so neither the vault key name nor the env var name leaks to the browser.
const SENSITIVE_KEY_PATTERNS = /api[_-]?key|apikey|token|secret|password|passwd|credential/i;

function redactConfigForUI(obj: any, depth = 0): any {
  if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactConfigForUI(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '••••••••';
    } else {
      out[k] = redactConfigForUI(v, depth + 1);
    }
  }
  return out;
}

// GET /api/settings/provider  — return active provider config (keys redacted)
app.get('/api/settings/provider', (_req, res) => {
  const raw = getConfig().getConfig() as any;
  const llmRaw = raw.llm || {
    provider: 'ollama',
    providers: { ollama: { endpoint: raw.ollama?.endpoint || 'http://localhost:11434', model: raw.models?.primary || 'qwen3:4b' } },
  };
  const llm = redactConfigForUI(sanitizeLLMConfig(llmRaw));
  res.json({ success: true, llm });
});

// POST /api/settings/provider  — update provider config
app.post('/api/settings/provider', (req, res) => {
  try {
    const llm = sanitizeLLMConfig(req.body?.llm);
    if (!llm?.provider) { res.status(400).json({ success: false, error: 'Missing llm.provider' }); return; }
    const configManager = getConfig();
    const current = (configManager.getConfig() as any)?.llm || {};
    // Merge with the current llm node and explicitly keep presets: the generic
    // settings panel does not manage model presets and must not clobber them
    // (config-level updateConfig also guards this).
    const merged = { ...current, ...llm, presets: current.presets };
    // Consistency: if the active preset's provider no longer matches the newly
    // saved provider, the user has manually diverged from the preset — clear
    // active_preset (switching via a preset restores both fields together).
    let activePreset = String(current.active_preset || '');
    if (activePreset) {
      const ap = current.presets?.[activePreset];
      if (!ap || ap.provider !== merged.provider) activePreset = '';
    }
    merged.active_preset = activePreset;
    configManager.updateConfig({ llm: merged } as any);
    resetProvider();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/models/test  — test connectivity for the active (or a given) provider
app.post('/api/models/test', async (req, res) => {
  try {
    const llmOverride = req.body?.llm ? sanitizeLLMConfig(req.body.llm) : null;
    const provider = llmOverride ? buildProviderForLLM(llmOverride) : getProvider();
    const ok = await provider.testConnection();
    const models = ok ? await provider.listModels() : [];
    res.json({ success: ok, models, error: ok ? undefined : 'Could not connect' });
  } catch (err: any) {
    res.json({ success: false, models: [], error: err.message });
  }
});

// ─── Model presets (multi-model switching) ──────────────────────────────────────

/** The masked value the UI shows for secrets — treated as "unchanged" on save. */
const PRESET_MASK = '••••••••';

function getPresetsState(): { llm: any; presets: Record<string, any>; active: string } {
  const cfg = getConfig().getConfig() as any;
  const llm = cfg.llm || {};
  return { llm, presets: llm.presets || {}, active: String(llm.active_preset || '') };
}

function presetSummary(preset: any, active: boolean): any {
  const prov = preset?.providers?.[preset?.provider] || {};
  const out: any = {
    id: preset?.id,
    name: preset?.name,
    provider: preset?.provider,
    model: String(prov?.model || ''),
    endpoint: String(prov?.endpoint || ''),
    active,
    builtin: !!preset?.builtin,
  };
  if (preset?.provider === 'llama_cpp' && preset?.server) {
    out.server = {
      model_path: preset.server.model_path,
      mmproj_path: preset.server.mmproj_path || '',
      alias: preset.server.alias || '',
      ngl: preset.server.ngl ?? 99,
      ctx_size: preset.server.ctx_size, // unset → model's native context (follows the model)
    };
  }
  return out;
}

/** Strip masked secrets so they never overwrite real keys on save. */
function sanitizePresetForSave(preset: any): any {
  const copy = JSON.parse(JSON.stringify(preset || {}));
  const prov = copy.providers?.[copy.provider];
  if (prov && typeof prov === 'object') {
    for (const k of Object.keys(prov)) {
      if (SENSITIVE_KEY_PATTERNS.test(k) && prov[k] === PRESET_MASK) delete prov[k];
    }
  }
  return copy;
}

// GET /api/models/presets — list all presets + the active one
app.get('/api/models/presets', (_req, res) => {
  const { presets, active } = getPresetsState();
  const list = Object.values(presets).map((p: any) => presetSummary(p, p?.id === active));
  res.json({ success: true, presets: list, active_preset: active });
});

// POST /api/models/presets — create or update a preset
app.post('/api/models/presets', (req, res) => {
  try {
    const raw = sanitizePresetForSave(req.body?.preset);
    if (!raw || typeof raw !== 'object') { res.status(400).json({ success: false, error: 'preset object required' }); return; }
    const id = String(raw.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (!id) { res.status(400).json({ success: false, error: 'preset.id required (a-z0-9_-)' }); return; }
    if (!raw.name || !raw.provider) { res.status(400).json({ success: false, error: 'preset.name and preset.provider required' }); return; }

    const { llm } = getPresetsState();
    const presets = { ...(llm.presets || {}) };
    const existing = presets[id] || {};
    presets[id] = { ...existing, ...raw, id, builtin: !!existing.builtin }; // builtin flag preserved
    const updatedLlm = { ...llm, presets };
    getConfig().updateConfig({ llm: updatedLlm } as any);
    res.json({ success: true, preset: presetSummary(presets[id], id === llm.active_preset) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/models/presets/:id — remove a non-builtin, non-active preset
app.delete('/api/models/presets/:id', (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    const { llm, presets, active } = getPresetsState();
    const target = presets[id];
    if (!target) { res.status(404).json({ success: false, error: 'Preset not found' }); return; }
    if (target.builtin) { res.status(400).json({ success: false, error: 'Built-in presets cannot be deleted' }); return; }
    if (id === active) { res.status(400).json({ success: false, error: 'Switch away from the active preset before deleting it' }); return; }
    const next = { ...presets };
    delete next[id];
    const updatedLlm = { ...llm, presets: next };
    getConfig().updateConfig({ llm: updatedLlm } as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/models/presets/switch — activate a preset (restarts llama-server if needed)
app.post('/api/models/presets/switch', async (req, res) => {
  const presetId = String(req.body?.preset_id || '').trim();
  const { llm, presets } = getPresetsState();
  const preset = presets[presetId];
  if (!preset) { res.status(404).json({ success: false, error: 'Preset not found' }); return; }

  try {
    // 1) Persist: switch provider + merge this preset's provider config (others untouched)
    const mergedProviders = { ...(llm.providers || {}) };
    for (const [k, v] of Object.entries(preset.providers || {})) {
      // Per-field merge: if the preset doesn't carry an api key, keep the one
      // already configured (vault ref or plaintext) instead of dropping it.
      const prev = mergedProviders[k] || {};
      mergedProviders[k] = Object.assign({}, prev, v);
    }
    const updatedLlm = { ...llm, provider: preset.provider, active_preset: presetId, providers: mergedProviders };
    // Sync models.primary — reactor uses it to detect small models (native
    // tool-call channel on/off). Use the preset's model name so the regex works.
    // Keep existing models.roles untouched (shallow merge would drop them).
    const cfgNow = getConfig().getConfig() as any;
    const primaryModel = String(preset.providers?.[preset.provider]?.model || preset.id || '');
    // Keep orchestration.secondary following the newly activated preset so the
    // advisor and the UI never show a stale hard-coded model.
    const orchNow = cfgNow.orchestration;
    const nextPatch: any = {
      llm: updatedLlm,
      models: { ...(cfgNow.models || {}), primary: primaryModel },
    };
    if (orchNow?.secondary) {
      nextPatch.orchestration = {
        ...orchNow,
        secondary: { provider: preset.provider, model: primaryModel },
      };
    }
    getConfig().updateConfig(nextPatch as any);
    resetProvider();

    // 2) llama.cpp presets need a server restart to load the new weights
    if (preset.provider === 'llama_cpp') {
      const endpoint = preset.providers?.llama_cpp?.endpoint || 'http://localhost:8080';
      const mgr = new LlamaServerManager(endpoint);
      const result = await mgr.switch(preset.server);
      res.json({ success: result.ok, preset_id: presetId, restart_ms: result.restartMs, error: result.ok ? undefined : 'llama-server did not become ready in time' });
      return;
    }

    res.json({ success: true, preset_id: presetId, restart_ms: 0 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/openai/status  — is the user connected via OAuth?
app.get('/api/auth/openai/status', (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  const connected = isConnected(configDir);
  const tokens    = connected ? loadTokens(configDir) : null;
  res.json({ connected, account_id: tokens?.account_id || null, expires_at: tokens?.expires_at || null });
});

// POST /api/auth/openai/start  — kick off OAuth flow (opens browser)
app.post('/api/auth/openai/start', async (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  try {
    const result = await startOAuthFlow(configDir);
    if (result.needsManualPaste) {
      res.json({ success: false, needsManualPaste: true, authUrl: result.authUrl });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/manual  — manual paste fallback token exchange
app.post('/api/auth/openai/manual', async (req, res) => {
  const configDir = CONFIG_DIR_PATH;
  const redirectedUrl = String(req.body?.url || '').trim();
  if (!redirectedUrl) {
    res.status(400).json({ success: false, error: 'Missing redirect URL' });
    return;
  }
  try {
    const result = await exchangeManualCodeFromPending(configDir, redirectedUrl);
    res.json(result);
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/disconnect  — revoke stored tokens
app.post('/api/auth/openai/disconnect', (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  clearTokens(configDir);
  res.json({ success: true });
});

// ─── Webhook Settings API ────────────────────────────────────────────────────

app.get('/api/settings/hooks', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).hooks || {};
  res.json({
    success: true,
    hooks: {
      enabled: cfg.enabled === true,
      token: cfg.token ? '••••••••' : '',           // never return the real token
      tokenSet: !!cfg.token,
      path: cfg.path || '/hooks',
    },
  });
});

app.post('/api/settings/hooks', (req, res) => {
  try {
    const { enabled, token, path: hookPath } = req.body || {};
    const current = (getConfig().getConfig() as any).hooks || {};
    const updated = {
      enabled: enabled === true,
      // If the user sent the masked placeholder, keep the existing token
      token: token && token !== '••••••••' ? String(token).trim() : (current.token || ''),
      path: hookPath ? String(hookPath).trim() : (current.path || '/hooks'),
    };
    getConfig().updateConfig({ hooks: updated } as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/hooks/test', async (req, res) => {
  try {
    const cfg = (getConfig().getConfig() as any).hooks || {};
    if (!cfg.enabled) { res.json({ success: false, error: 'Webhooks are disabled' }); return; }
    if (!cfg.token)   { res.json({ success: false, error: 'No token configured' }); return; }
    res.json({ success: true, message: 'Webhook endpoint is active', path: cfg.path || '/hooks' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── MCP API ──────────────────────────────────────────────────────────────────

app.get('/api/mcp/servers', (_req, res) => {
  try {
    const mgr = getMCPManager();
    const configs = mgr.getConfigs();
    const status = mgr.getStatus();
    const merged = configs.map(cfg => {
      const s = status.find(x => x.id === cfg.id);
      return { ...cfg, status: s?.status || 'disconnected', toolCount: s?.tools || 0, toolNames: s?.toolNames || [], error: s?.error };
    });
    res.json({ success: true, servers: merged });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers', (req, res) => {
  try {
    const mgr = getMCPManager();
    const cfg = req.body;
    if (!cfg.id || !cfg.name) { res.status(400).json({ success: false, error: 'id and name are required' }); return; }
    if (!cfg.id.match(/^[a-z0-9_-]+$/i)) { res.status(400).json({ success: false, error: 'id must be alphanumeric/underscore/dash only' }); return; }
    mgr.upsertConfig(cfg);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/mcp/servers/:id', (req, res) => {
  try {
    const mgr = getMCPManager();
    const deleted = mgr.deleteConfig(req.params.id);
    res.json({ success: deleted, error: deleted ? undefined : 'Server not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers/:id/connect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    const result = await mgr.connect(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers/:id/disconnect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    await mgr.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/mcp/tools', (_req, res) => {
  try {
    const mgr = getMCPManager();
    res.json({ success: true, tools: mgr.getAllTools() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/tools', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || 'default');
    // Resolve the same merged tier the chat path uses, so the UI tool list
    // matches what is actually injected into the prompt for this model.
    const tier = await resolveModelTier();
    const tools = applyToolPolicy(buildTools(tier, { isOrchestrationSkillEnabled }), sessionId);
    res.json({
      success: true,
      sessionId,
      count: tools.length,
      tools: tools.map((t: any) => String(t?.function?.name || '')).filter(Boolean),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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
  scheduleTaskHeartbeat();
  console.log('[TaskHeartbeat] Scheduled — interval:', loadTaskHeartbeatConfig().interval_minutes, 'min');

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