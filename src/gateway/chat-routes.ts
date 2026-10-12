/** chat-routes.ts — chat SSE route + session/memory helper routes +
 * blocked-task followup detection, extracted from server-v2.ts (Phase 5d-18).
 * Injected deps are composition-root closures: handleChat, task control
 * handler, and a main-session-id setter. Everything else is a plain import. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { getAgentById } from '../config/config';
import { getWorkspace, clearHistory, deleteSession, addMessage } from './session';
import { sessionAgentBindings } from './tool-registry';
import { hookBus } from './hooks';
import { createSSESender } from './realtime';
import { setModelBusy } from './model-busy-guard';
import { buildFlowDonePayload } from './flow-integration';
import {
  findBlockedTaskForSession, isResumeIntent, isRerunIntent, isCancelIntent,
  parseTaskIdFromText,
} from './task-integration';

export interface ChatRouteDeps {
  handleChat: (message: string, sessionId: string, sendSSE: (event: string, payload: any) => void, pinnedMessages?: any[], abortSignal?: { aborted: boolean }, internalContext?: string) => Promise<{ text: string }>;
  handleTaskControlAction: (sessionId: string, params: { action: string; task_id: string; note?: string }) => Promise<{ success: boolean; message?: string }>;
  setMainSessionId: (id: string) => void;
}

export function registerChatRoutes(app: express.Express, deps: ChatRouteDeps): void {
  const { handleChat, handleTaskControlAction, setMainSessionId } = deps;

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

app.post('/api/chat', async (req, res) => {
  const { message, sessionId = 'default', pinnedMessages, agentId } = req.body;
  if (!message || typeof message !== 'string') { res.status(400).json({ error: 'Message required' }); return; }
  const lastMainSessionId = String(sessionId || 'default');
  setMainSessionId(lastMainSessionId);
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
}
