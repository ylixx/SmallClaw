/** task-heartbeat.ts — background-task heartbeat + quick follow-up resume
 * machinery, extracted from server-v2.ts (Phase 5d-12). Part of the
 * composition-root assembly chain: createChatHandler closes over
 * makeBroadcastForTask, which needs handleChat at runtime, so the factory
 * takes a lazy getHandleChat() getter to break the cycle. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { BackgroundTaskRunner } from './background-task-runner';
import { broadcastWS } from './realtime';
import { getModelBusy } from './model-busy-guard';
import {
  callSecondaryHeartbeatAdvisor,
  getOrchestrationConfig,
  type TaskSnapshot as HeartbeatTaskSnapshot,
} from '../orchestration/multi-agent';
import {
  loadTask,
  updateTaskStatus,
  appendJournal,
  listTasks,
  mutatePlan,
  buildTaskSnapshot,
} from './task-store';

export interface HeartbeatDomainDeps {
  getHandleChat: () => any;
  telegramChannel: any;
  CONFIG_DIR_PATH: string;
}

export interface HeartbeatRoutesDeps {
  loadTaskHeartbeatConfig: () => { enabled: boolean; interval_minutes: number };
  saveTaskHeartbeatConfig: (cfg: { enabled: boolean; interval_minutes: number }) => void;
  scheduleTaskHeartbeat: () => void;
}

export function createHeartbeatDomain(deps: HeartbeatDomainDeps): {
  loadTaskHeartbeatConfig: () => { enabled: boolean; interval_minutes: number };
  saveTaskHeartbeatConfig: (cfg: { enabled: boolean; interval_minutes: number }) => void;
  scheduleTaskHeartbeat: () => void;
  makeBroadcastForTask: (taskId: string) => (data: object) => void;
} {
// Task heartbeat config API
const taskHeartbeatPath = path.join(deps.CONFIG_DIR_PATH, 'task-heartbeat.json');

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
      deps.getHandleChat(),
      makeBroadcastForTask(decision.resume_task_id),
      deps.telegramChannel,
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
    const runner = new BackgroundTaskRunner(taskId, deps.getHandleChat(), makeBroadcastForTask(taskId), deps.telegramChannel);
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

  return { loadTaskHeartbeatConfig, saveTaskHeartbeatConfig, scheduleTaskHeartbeat, makeBroadcastForTask };
}

export function registerHeartbeatRoutes(app: express.Express, h: HeartbeatRoutesDeps): void {
app.get('/api/bg-tasks/heartbeat/config', (_req, res) => {
  res.json({ success: true, config: h.loadTaskHeartbeatConfig() });
});

app.put('/api/bg-tasks/heartbeat/config', (req, res) => {
  const current = h.loadTaskHeartbeatConfig();
  const next = {
    enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : current.enabled,
    interval_minutes: Math.max(1, Math.min(1440, Number(req.body.interval_minutes) || current.interval_minutes)),
  };
  h.saveTaskHeartbeatConfig(next);
  h.scheduleTaskHeartbeat();
  res.json({ success: true, config: next });
});
}
