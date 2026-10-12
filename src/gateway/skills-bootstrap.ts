/** skills-bootstrap.ts — skills directory resolution + SkillsManager
 * singleton + orchestration-skill helpers, extracted from server-v2.ts
 * (Phase 5d-15). Module-level init runs only when the composition root
 * imports it (server-v2 is the sole importer; vitest does not touch it). */
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { getConfigDirPath } from './config-bootstrap';
import { clampOrchestrationConfig, clampPreemptConfig } from '../orchestration/multi-agent';
import { SkillsManager } from './skills-manager';

// Skills system
const configuredSkillsDir = (getConfig().getConfig() as any).skills?.directory || path.join(getConfigDirPath(), 'skills');
const fallbackSkillsDir = path.join(getConfigDirPath(), 'skills');

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

export const skillsDir = resolveSkillsDir(configuredSkillsDir);
export const skillsManager = new SkillsManager(skillsDir, '');
console.log(`[Skills] Directory: ${skillsDir}`);

export function isOrchestrationSkillEnabled(): boolean {
  return skillsManager.get('multi-agent-orchestrator')?.enabled === true;
}

/**
 * Expand `{{skill:<id>}}` placeholders inside a flow template instruction
 * with the referenced skill's full markdown body. This keeps a single source
 * of truth for the process spec (the SKILL.md) — editing the skill propagates
 * to every flow that references it, instead of drifting copies.
 * Unknown skills leave the placeholder untouched so the error is visible.
 */
export function renderFlowInstruction(instruction: string): string {
  return String(instruction || '').replace(/\{\{\s*skill:([a-zA-Z0-9_-]+)\s*\}\}/g, (match, id: string) => {
    const skill = skillsManager.get(id);
    if (!skill) return match;
    return `\n\n【技能规范：${skill.name}（${id}）】\n${skill.instructions}\n`;
  });
}

export function recoverSkillsIfEmpty(): void {
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

export function setOrchestrationEnabled(enabled: boolean): void {
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
