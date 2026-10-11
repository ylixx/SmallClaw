/** api-agents.ts — agent CRUD/history/spawn routes + normalization helpers
 * extracted from server-v2.ts (Phase 5d-11). All deps are imports; no
 * deps injection needed. */
import express from 'express';
import fs from 'fs';
import path from 'path';
import { getConfig, getAgents, getAgentById, ensureAgentWorkspace, resolveAgentWorkspace } from '../config/config';
import { spawnAgent } from '../agents/spawner';
import { reloadAgentSchedules, getAgentRunHistory, getAgentLastRun, recordAgentRun } from '../scheduler';

export function registerAgentRoutes(app: express.Express): void {
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
}
