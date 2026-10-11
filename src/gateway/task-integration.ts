/**
 * task-integration.ts — pure task helper functions extracted from server-v2.ts
 * (Phase 5a). Intent classification / task summarization / scope bucketing used
 * by the task_control flow. server-v2 keeps the task_control handler itself
 * (it closes over handleChat/telegramChannel) but delegates these helpers, so
 * handleChat / executeToolImpl no longer depend on server-v2-local task helpers.
 */
import {
  loadTask,
  saveTask,
  updateTaskStatus,
  appendJournal,
  updateResumeContext,
  listTasks,
  deleteTask,
  type TaskRecord,
  type TaskStatus,
} from './task-store';

export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  'queued',
  'running',
  'paused',
  'stalled',
  'needs_assistance',
  'failed',
  'waiting_subagent',
];

export function inferTaskChannelFromSession(sessionId: string): 'web' | 'telegram' {
  return String(sessionId || '').startsWith('telegram_') ? 'telegram' : 'web';
}

export function latestTaskForSession(sessionId: string, statuses: TaskStatus[]): TaskRecord | null {
  const tasks = listTasks({ status: statuses })
    .filter(t => t.sessionId === sessionId)
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return tasks[0] || null;
}

export function findBlockedTaskForSession(sessionId: string): TaskRecord | null {
  const blocked = listTasks({ status: ['needs_assistance', 'stalled', 'paused', 'failed'] })
    .filter(t => t.sessionId === sessionId)
    .filter(t =>
      t.status === 'needs_assistance'
      || t.status === 'stalled'
      || t.status === 'failed'
      || (t.status === 'paused' && t.pauseReason !== 'user_pause'),
    )
    .sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  return blocked[0] || null;
}

export function isResumeIntent(message: string): boolean {
  const text = message.trim();
  // Must explicitly reference resuming/continuing a task — not just a casual "go ahead"
  // which people often say when starting a NEW task ("go ahead and open chatgpt").
  // Require task context, or an explicit resume/rerun keyword standalone.
  if (/\b(resume|rerun|re-run|run again|retry|restart)\b/i.test(text)) return true;
  if (/\b(continue|proceed)\b.*\b(task|it|that|this)\b/i.test(text)) return true;
  if (/\b(go ahead|do it|apply)\b.*\b(task|resume|rerun)\b/i.test(text)) return true;
  return false;
}

export function isRerunIntent(message: string): boolean {
  return /\b(rerun|re-run|run again|retry|restart|start again)\b/i.test(message);
}

export function isCancelIntent(message: string): boolean {
  return /\b(cancel|abort|stop( task)?|do not continue|don't continue)\b/i.test(message);
}

export function isStatusQuestion(message: string): boolean {
  return /\?|^\s*(what|why|how|status|did|where|when)\b/i.test(message)
    || /\b(what happened|why did|status|stuck|failed|error|progress|what went wrong)\b/i.test(message);
}

export function isTaskListIntent(message: string): boolean {
  return /\b(what|which|show|list)\b.*\b(background\s+)?tasks?\b/i.test(message)
    || /\b(background\s+)?tasks?\b.*\b(do we have|running|active|current)\b/i.test(message);
}

export function isAdjustmentIntent(message: string): boolean {
  return /\b(instead|change|adjust|update|only|skip|don't|do not|use|delete|remove|clear|keep|retry|try again)\b/i.test(message);
}

export function getLatestPauseContext(task: TaskRecord): { reason: string; detail: string } {
  const latestPause = [...(task.journal || [])].reverse().find((j) => j.type === 'pause');
  if (latestPause) {
    return {
      reason: String(latestPause.content || '').replace(/^Task paused for assistance:\s*/i, '').slice(0, 220),
      detail: String(latestPause.detail || '').slice(0, 420),
    };
  }
  return { reason: task.pauseReason || 'paused', detail: '' };
}

export function summarizeTaskRecord(task: TaskRecord): Record<string, any> {
  const total = Array.isArray(task.plan) ? task.plan.length : 0;
  const step = Math.min((task.currentStepIndex || 0) + 1, Math.max(1, total));
  const done = (task.plan || []).filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const latestPause = getLatestPauseContext(task);
  return {
    task_id: task.id,
    title: task.title,
    status: task.status,
    pause_reason: task.pauseReason || null,
    step,
    total_steps: Math.max(1, total),
    completed_steps: done,
    last_issue: latestPause.reason || null,
    last_issue_detail: latestPause.detail || null,
    channel: task.channel,
    session_id: task.sessionId,
    last_progress_at: task.lastProgressAt,
    last_progress_iso: new Date(task.lastProgressAt).toISOString(),
    started_at: task.startedAt,
    started_at_iso: new Date(task.startedAt).toISOString(),
    completed_at: task.completedAt || null,
    completed_at_iso: task.completedAt ? new Date(task.completedAt).toISOString() : null,
  };
}

export function buildBlockedTaskStatusMessage(task: TaskRecord): string {
  const summary = summarizeTaskRecord(task);
  const lines = [
    `Task status: ${summary.title}`,
    `Status: ${summary.status}`,
    `Step: ${summary.step}/${summary.total_steps} (${summary.completed_steps} completed)`,
    summary.last_issue ? `Last issue: ${summary.last_issue}` : '',
    summary.last_issue_detail ? `Details: ${summary.last_issue_detail}` : '',
    `Task ID: ${summary.task_id}`,
    `You can say: "resume task ${summary.task_id}" or "rerun task ${summary.task_id}".`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function parseTaskStatusFilter(raw: any): TaskStatus[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const valid = new Set<TaskStatus>([
    'queued',
    'running',
    'paused',
    'stalled',
    'needs_assistance',
    'failed',
    'complete',
    'waiting_subagent',
  ]);
  const values = String(raw)
    .split(/[,\s]+/)
    .map(v => v.trim())
    .filter(Boolean) as TaskStatus[];
  const filtered = values.filter(v => valid.has(v));
  return filtered.length > 0 ? filtered : undefined;
}

export function getTaskScopeBuckets(sessionId: string, statuses?: TaskStatus[]) {
  const all = listTasks(statuses ? { status: statuses } : undefined).sort((a, b) => b.lastProgressAt - a.lastProgressAt);
  const sessionTasks = all.filter(t => t.sessionId === sessionId);
  const channel = inferTaskChannelFromSession(sessionId);
  const channelTasks = all.filter(t => t.channel === channel && t.sessionId !== sessionId);
  return { all, sessionTasks, channelTasks, channel };
}

export function parseTaskIdFromText(text: string): string | null {
  const m = String(text || '').match(/\b([a-f0-9]{8}-[a-f0-9-]{27,})\b/i);
  return m ? m[1] : null;
}
export function renderTaskCandidatesForHuman(candidates: Array<Record<string, any>>): string {
  if (!Array.isArray(candidates) || candidates.length === 0) return 'No candidates found.';
  return candidates
    .slice(0, 3)
    .map((c, i) => `${i + 1}. ${c.title} [${c.status}] — Task ID: ${c.task_id}`)
    .join('\n');
}
