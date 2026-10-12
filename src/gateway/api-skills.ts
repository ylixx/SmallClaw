/** api-skills.ts — skills CRUD/toggle + orchestration settings routes
 * extracted from server-v2.ts (Phase 5d-5). deps: composition-root singletons
 * (skillsManager/activeTasks) + local helper functions. */
import express from 'express';
import { getConfig } from '../config/config';
import { getOrchestrationConfig, clampOrchestrationConfig, clampPreemptConfig, checkOrchestrationEligibility } from '../orchestration/multi-agent';
import { getOrchestrationSessionStats } from './chat-handler';


export function getOrchestrationConfigForApi() {
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


export interface SkillsRouteDeps {
  skillsManager: {
    getAll: () => any[];
    get: (id: string) => any;
    toggle: (id: string) => any;
    create: (s: any) => any;
    update: (id: string, patch: any) => any;
    delete: (id: string) => boolean;
  };
  recoverSkillsIfEmpty: () => void;
  setOrchestrationEnabled: (enabled: boolean) => void;
  activeTasks: Map<string, any>;
}

export function registerSkillsRoutes(app: express.Express, deps: SkillsRouteDeps): void {
// ─── Skills API + Orchestration Settings ─────────────────────────────────



// ─── Skills API ────────────────────────────────────────────────────────────────

app.get('/api/skills', async (_req, res) => {
  deps.recoverSkillsIfEmpty();

  let orchestrationEligibility: { eligible: boolean; reason?: string } = { eligible: true };
  try {
    orchestrationEligibility = await checkOrchestrationEligibility();
  } catch {}

  const skills = deps.skillsManager.getAll().map(s => {
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
  const skill = deps.skillsManager.get(req.params.id);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill });
});



app.post('/api/skills/:id/toggle', async (req, res) => {
  const skillId = req.params.id;
  const current = deps.skillsManager.get(skillId);
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

  const skill = deps.skillsManager.toggle(skillId);
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }

  if (skillId === 'multi-agent-orchestrator') {
    deps.setOrchestrationEnabled(skill.enabled);
  }

  res.json({ success: true, skill: { id: skill.id, name: skill.name, enabled: skill.enabled } });
});



app.post('/api/skills', (req, res) => {
  try {
    const { id, name, description, emoji, instructions } = req.body;
    if (!name || !instructions) { res.status(400).json({ success: false, error: 'Name and instructions required' }); return; }
    const skillId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const skill = deps.skillsManager.create({ id: skillId, name, description: description || '', emoji: emoji || '🧩', instructions });
    res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
});



app.put('/api/skills/:id', (req, res) => {
  const { name, description, emoji, instructions } = req.body;
  const skill = deps.skillsManager.update(req.params.id, { name, description, emoji, instructions });
  if (!skill) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true, skill: { id: skill.id, name: skill.name, description: skill.description, emoji: skill.emoji, enabled: skill.enabled } });
});



app.delete('/api/skills/:id', (req, res) => {
  const ok = deps.skillsManager.delete(req.params.id);
  if (!ok) { res.status(404).json({ success: false, error: 'Skill not found' }); return; }
  res.json({ success: true });
});



// ——— Orchestration Settings API ————————————————————————————————








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
  const task = deps.activeTasks.get(sessionId);
  if (!task) { res.json({ active: false }); return; }
  res.json({ active: task.status === 'running', ...task, journal: task.journal.slice(-10) });
});


}
