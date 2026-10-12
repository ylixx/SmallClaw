/** api-files.ts — file upload/download/listing + doc-apply + plan + artifacts
 * + status routes, extracted from server-v2.ts (Phase 5d-16). All deps are
 * imports; no deps injection needed. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { requireGatewayAuth } from './api-auth';
import { resolveToolFilePath, listArtifacts } from './chat-execution';
import { executeOfficeTool, getDocPreview } from '../tools/office';
import { setPlanModeEnabled, getPlanState, getPendingPlan, resolvePlanDecision } from './plan-mode';
import { getOllamaClient } from '../agents/ollama-client';
import { getOrchestrationConfig } from '../orchestration/multi-agent';

export function registerFileRoutes(app: express.Express): void {
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
    // providerOnline: connection state of the ACTIVE provider (the legacy
    // "ollama" field above conflated llama.cpp/ollama states under one name).
    providerOnline: connected,
    // gateway: the address this gateway is actually listening on.
    gateway: `http://127.0.0.1:${rawCfg.gateway?.port ?? 18789}`,
    provider,
    currentModel: activeModel,
    workspace: (getConfig().getConfig() as any).workspace?.path || '',
    search: rawCfg.search?.google_api_key ? 'google' : (rawCfg.search?.tavily_api_key ? 'tavily' : 'none'),
    orchestration: orchCfg ? {
      enabled: orchCfg.enabled,
      secondary: effectiveSecondary,
    } : null,
  });
});
}
