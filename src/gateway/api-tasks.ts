/** api-tasks.ts — cron task + background task kanban routes extracted from
 * server-v2.ts (Phase 5d-6). deps: scheduler/heartbeat singletons + chat
 * runner wiring (handleChat/makeBroadcastForTask/telegramChannel). */
import express from 'express';
import path from 'path';
import { getConfig } from '../config/config';
import { getWorkspace, addMessage } from './session';
import { BackgroundTaskRunner } from './background-task-runner';
import { hookBus } from './hooks';
import { getCredentialHandler } from '../security/credential-handler';
import { getErrorAudit } from '../security/error-audit';
import { getConfigDirPath } from './config-bootstrap';
import { loadTask, deleteTask, updateTaskStatus, appendJournal, updateResumeContext, listTasks } from './task-store';
import type { TaskStatus } from './task-store';

const CONFIG_DIR_PATH = getConfigDirPath();

export interface TasksRouteDeps {
  cronScheduler: {
    getJobs: () => any[];
    getConfig: () => any;
    createJob: (j: any) => any;
    updateJob: (id: string, patch: any) => any;
    deleteJob: (id: string) => boolean;
    reorderJobs: (ids: string[]) => void;
    runJobNow: (id: string, opts: any) => Promise<void>;
    updateConfig: (c: any) => any;
  };
  heartbeatRunner: { getConfig: () => any; updateConfig: (c: any) => any };
  loadTaskHeartbeatConfig: () => { enabled: boolean; interval_minutes: number };
  handleChat: (...args: any[]) => Promise<any>;
  makeBroadcastForTask: (taskId: string) => (data: object) => void;
  telegramChannel: { sendToAllowed: (text: string) => Promise<void>; sendMessage?: (chatId: number, text: string) => Promise<void> };
}

export function registerTasksRoutes(app: express.Express, deps: TasksRouteDeps): void {
// ─── Tasks / Cron + Background Task Kanban API ────────────────────────────



app.post('/api/tasks', (req, res) => {
  const { name, prompt, type, schedule, tz, runAt, priority, sessionTarget, payloadKind, systemEventText, model } = req.body;
  if (!name || !prompt) { res.status(400).json({ success: false, error: 'name and prompt required' }); return; }
  if (type === 'heartbeat') {
    res.status(400).json({ success: false, error: 'Heartbeat is no longer a CronJob. Configure HEARTBEAT.md and /api/heartbeat/config instead.' });
    return;
  }
  const job = deps.cronScheduler.createJob({
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



app.post('/api/tasks', (req, res) => {
  const { name, prompt, type, schedule, tz, runAt, priority, sessionTarget, payloadKind, systemEventText, model } = req.body;
  if (!name || !prompt) { res.status(400).json({ success: false, error: 'name and prompt required' }); return; }
  if (type === 'heartbeat') {
    res.status(400).json({ success: false, error: 'Heartbeat is no longer a CronJob. Configure HEARTBEAT.md and /api/heartbeat/config instead.' });
    return;
  }
  const job = deps.cronScheduler.createJob({
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



app.delete('/api/tasks/:id', (req, res) => {
  const ok = deps.cronScheduler.deleteJob(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true });
});



app.delete('/api/tasks/:id', (req, res) => {
  const ok = deps.cronScheduler.deleteJob(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true });
});



app.post('/api/tasks/reorder', (req, res) => {
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) { res.status(400).json({ success: false, error: 'orderedIds array required' }); return; }
  deps.cronScheduler.reorderJobs(orderedIds);
  res.json({ success: true });
});



app.post('/api/tasks/:id/run', async (req, res) => {
  const jobs = deps.cronScheduler.getJobs();
  const job = jobs.find(j => j.id === req.params.id);
  if (!job) { res.status(404).json({ success: false, error: 'Job not found' }); return; }
  res.json({ success: true, message: 'Job queued for immediate run' });
  deps.cronScheduler.runJobNow(req.params.id, { respectActiveHours: false }).catch(console.error);
});



app.put('/api/tasks/config', (req, res) => {
  deps.cronScheduler.updateConfig(req.body);
  res.json({ success: true, config: deps.cronScheduler.getConfig() });
});



app.put('/api/tasks/config', (req, res) => {
  deps.cronScheduler.updateConfig(req.body);
  res.json({ success: true, config: deps.cronScheduler.getConfig() });
});



app.put('/api/heartbeat/config', (req, res) => {
  const cfg = deps.heartbeatRunner.updateConfig(req.body || {});
  res.json({ success: true, config: cfg });
});



app.put('/api/heartbeat/config', (req, res) => {
  const cfg = deps.heartbeatRunner.updateConfig(req.body || {});
  res.json({ success: true, config: cfg });
});



// ─── Background Task Kanban API ─────────────────────────────────────────────────

app.get('/api/bg-tasks', (_req, res) => {
  const tasks = listTasks();
  const heartbeatConfig = deps.loadTaskHeartbeatConfig();
  res.json({ success: true, tasks, heartbeatConfig });
});



app.delete('/api/bg-tasks/:id', (req, res) => {
  const ok = deleteTask(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Task not found' }); return; }
  res.json({ success: true });
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
    const runner = new BackgroundTaskRunner(task.id, deps.handleChat, deps.makeBroadcastForTask(task.id), deps.telegramChannel);
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
  const runner = new BackgroundTaskRunner(task.id, deps.handleChat, deps.makeBroadcastForTask(task.id), deps.telegramChannel);
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
    const runner = new BackgroundTaskRunner(task.id, deps.handleChat, deps.makeBroadcastForTask(task.id), deps.telegramChannel);
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


}
