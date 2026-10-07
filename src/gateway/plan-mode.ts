/**
 * plan-mode.ts
 *
 * Plan mode: the model researches with read-only tools, submits a plan with
 * `plan_submit`, and the chat blocks until the user approves or rejects it in
 * the UI. While a session is in plan mode, every tool that changes anything is
 * refused with a message telling the model to call plan_submit first.
 *
 * Approve/resove happens through POST /api/plan (see server-v2.ts).
 */

import { getConfig } from '../config/config';

export interface PlanStep {
  text: string;
}

export interface PlanRequest {
  sessionId: string;
  summary: string;
  steps: string[];
  createdAt: number;
}

interface PendingPlan extends PlanRequest {
  resolve: (outcome: PlanOutcome) => void;
  timer: NodeJS.Timeout;
}

export interface PlanOutcome {
  status: 'approved' | 'rejected' | 'timeout';
  note?: string;
}

const pendingPlans = new Map<string, PendingPlan>();
const sessionPlanEnabled = new Map<string, boolean>();
const sessionPlanApproved = new Set<string>();

/** Read-only tools that stay available while plan mode gates a session. */
export const PLAN_READONLY_TOOLS = new Set<string>([
  'list_files',
  'read_file',
  'doc_inspect',
  'doc_read',
  'web_search',
  'web_fetch',
  'memory_read',
  'memory_browse',
  'time_now',
  'get_time',
  'get_date',
  'parse_schedule_pattern',
  'plan_submit',
  'plan_status',
]);

export function planToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      function: {
        name: 'plan_submit',
        description:
          '提交执行计划并等待用户批准 (submit an execution plan and wait for approval). Required in plan mode BEFORE any tool that changes files or runs commands. Research first with read-only tools (list_files, read_file, doc_inspect, doc_read, web_search), then send summary + concrete steps. Blocks until approved/rejected; after approval, execute step by step.',
        parameters: {
          type: 'object',
          required: ['summary', 'steps'],
          properties: {
            summary: { type: 'string', description: '一句话说明要做什么 (one-line what and why).' },
            steps: {
              type: 'array',
              items: { type: 'string' },
              description: '按顺序的具体步骤 (ordered concrete steps, 2-10 items, name the tools/files involved).',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'plan_status',
        description:
          '查询 Plan 模式状态 (check plan-mode state): enabled/approved/pending + the pending plan if any. Read-only, always allowed.',
        parameters: { type: 'object', properties: {} },
      },
    },
  ];
}

function planConfig(): { enabled: boolean; timeoutMs: number } {
  let cfg: any = null;
  try {
    cfg = (getConfig() as any)?.getConfig?.() ?? null;
  } catch {
    cfg = null;
  }
  const planCfg = cfg?.plan || {};
  const enabled = planCfg.enabled === true;
  const minutes = Number(planCfg.timeout_minutes);
  const timeoutMs = (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
  return { enabled, timeoutMs };
}

export function isPlanModeEnabledFor(sessionId: string): boolean {
  const sid = String(sessionId || 'default');
  return planConfig().enabled || sessionPlanEnabled.get(sid) === true;
}

export function setPlanModeEnabled(sessionId: string, enabled: boolean): void {
  const sid = String(sessionId || 'default');
  sessionPlanEnabled.set(sid, enabled === true);
  if (!enabled) {
    sessionPlanApproved.delete(sid);
    cancelPending(sid);
  }
}

export function getPlanState(sessionId: string): { enabled: boolean; approved: boolean; pending: boolean } {
  const sid = String(sessionId || 'default');
  return {
    enabled: isPlanModeEnabledFor(sid),
    approved: sessionPlanApproved.has(sid),
    pending: pendingPlans.has(sid),
  };
}

/** True when mutating tools must be refused for this session. */
export function isPlanGateActive(sessionId: string): boolean {
  const sid = String(sessionId || 'default');
  if (!isPlanModeEnabledFor(sid)) return false;
  if (sessionPlanApproved.has(sid)) return false;
  if (pendingPlans.has(sid)) return true;
  return true;
}

export function planGateMessage(name: string): string {
  return [
    `PLAN MODE：${name} 被拦截 - 当前会话处于 Plan 模式，尚未获得执行批准。`,
    '先用只读工具调研（list_files / read_file / doc_inspect / doc_read / web_search），然后调用 plan_submit(summary, steps) 提交计划；用户批准后才能执行任何修改操作。',
  ].join('\n');
}

function cancelPending(sessionId: string): void {
  const pending = pendingPlans.get(sessionId);
  if (!pending) return;
  pendingPlans.delete(sessionId);
  clearTimeout(pending.timer);
}

export function isPlanTool(name: string): boolean {
  return name === 'plan_submit' || name === 'plan_status';
}

/**
 * Store the plan and block until /api/plan resolves it (approve/reject) or the
 * timeout fires. `emit` lets the caller push an SSE event to the open chat.
 */
export function awaitPlanDecision(
  sessionId: string,
  summary: string,
  steps: string[],
  emit?: (event: string, data: any) => void,
): Promise<PlanOutcome> {
  const sid = String(sessionId || 'default');
  cancelPending(sid);

  const { timeoutMs } = planConfig();
  const request: PlanRequest = { sessionId: sid, summary, steps, createdAt: Date.now() };

  return new Promise<PlanOutcome>(resolve => {
    const timer = setTimeout(() => {
      if (pendingPlans.get(sid)?.resolve === entry.resolve) {
        pendingPlans.delete(sid);
      }
      resolve({ status: 'timeout' });
    }, timeoutMs);
    timer.unref?.();

    const entry: PendingPlan = { ...request, resolve, timer };
    pendingPlans.set(sid, entry);

    try {
      emit?.('plan_request', {
        session_id: sid,
        summary,
        steps,
        timeout_ms: timeoutMs,
      });
    } catch {
      // SSE emit is best effort.
    }
  });
}

export function resolvePlanDecision(sessionId: string, approved: boolean, note?: string): { ok: boolean; error?: string } {
  const sid = String(sessionId || 'default');
  const pending = pendingPlans.get(sid);
  if (!pending) {
    return { ok: false, error: 'no pending plan for this session' };
  }
  pendingPlans.delete(sid);
  clearTimeout(pending.timer);
  if (approved) {
    sessionPlanApproved.add(sid);
    pending.resolve({ status: 'approved', note });
  } else {
    sessionPlanApproved.delete(sid);
    pending.resolve({ status: 'rejected', note });
  }
  return { ok: true };
}

export function getPendingPlan(sessionId: string): { summary: string; steps: string[]; createdAt: number } | null {
  const pending = pendingPlans.get(String(sessionId || 'default'));
  if (!pending) return null;
  return { summary: pending.summary, steps: pending.steps, createdAt: pending.createdAt };
}

export function clearPlanApproval(sessionId: string): void {
  sessionPlanApproved.delete(String(sessionId || 'default'));
}
