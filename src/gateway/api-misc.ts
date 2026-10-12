/** api-misc.ts — miscellaneous gateway routes extracted from server-v2.ts
 * (Phase 5d-2b): agent session context, approvals, memory stub, open-path.
 * deps: getHistory (session) + isOrchestrationSkillEnabled (composition root). */
import express from 'express';
import path from 'path';
import { getConfig } from '../config/config';
import { getOrchestrationConfig } from '../orchestration/multi-agent';
import { getHistory } from './session';
import { requireGatewayAuth } from './api-auth';

export interface MiscRouteDeps {
  isOrchestrationSkillEnabled: () => boolean;
}

export function registerMiscRoutes(app: express.Express, deps: MiscRouteDeps): void {


const pendingApprovals: Map<string, { id: string; action: string; reason: string }> = new Map();




// ─── Agent Session Context API ────────────────────────────────────────────────

app.get('/api/agent/session/:id', (req, res) => {
  const sessionId = req.params.id;
  const history = getHistory(sessionId, 50);
  const userMessages = history.filter(h => h.role === 'user');
  const recent = history.slice(-8).map(h => ({
    kind: h.role,
    status: 'completed',
    text: String(h.content || '').slice(0, 120),
  }));
  res.json({
    mode_lock: null,
    mode: ((getOrchestrationConfig()?.enabled ?? false) && deps.isOrchestrationSkillEnabled()) ? 'agent' : 'chat',
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
}
