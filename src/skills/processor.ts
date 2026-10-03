import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { getConfig } from '../config/config.js';
import { listSkillIds, normalizeSkillId, resolveSkillDir } from './store.js';

export type SkillRiskLevel = 'low' | 'medium' | 'high';
export type SkillRuntimeStatus = 'ready' | 'needs_setup' | 'blocked';
export type SkillSourceType = 'clawhub' | 'upload' | 'manual';
export type SkillType = 'cli' | 'docs' | 'native';

export interface SkillTemplate {
  action: string;
  label: string;
  command: string;
  requires_confirmation: boolean;
}

export interface SkillManifest {
  schema_version: 1;
  id: string;
  name: string;
  description: string;
  source: {
    type: SkillSourceType;
    url?: string;
    filename?: string;
    installed_at: number;
  };
  type: SkillType;
  status: SkillRuntimeStatus;
  execution_enabled: boolean;
  requirements: {
    binaries: string[];
    env: string[];
    files: string[];
    credentials: string[];
    missing_binaries: string[];
    missing_env: string[];
    missing_files: string[];
  };
  risk: {
    level: SkillRiskLevel;
    reasons: string[];
    warnings: string[];
  };
  confirm_gates: string[];
  templates: SkillTemplate[];
  files: {
    skill_md: string;
    prompt_md: string;
    manifest_json: string;
    risk_json: string;
  };
  version?: string;
  generated_at: number;
}

interface SkillPackWriteInput {
  id?: string;
  skillMdContent: string;
  sourceType: SkillSourceType;
  sourceUrl?: string;
  sourceFilename?: string;
}

function safeJsonParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(String(text || '')) as T;
  } catch {
    return fallback;
  }
}

function readJsonIfExists<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return safeJsonParse<T>(fs.readFileSync(p, 'utf-8'), null as any);
  } catch {
    return null;
  }
}

function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const raw = String(content || '');
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const frontRaw = String(m[1] || '');
  const body = String(m[2] || '');
  const out: Record<string, string> = {};
  for (const line of frontRaw.split(/\r?\n/)) {
    const mm = line.match(/^\s*([a-zA-Z0-9_\-]+)\s*:\s*(.+?)\s*$/);
    if (!mm) continue;
    out[String(mm[1] || '').trim().toLowerCase()] = String(mm[2] || '').trim().replace(/^['"]|['"]$/g, '');
  }
  return { frontmatter: out, body };
}

function firstHeading(text: string): string {
  const mm = String(text || '').match(/^\s*#\s+(.+?)\s*$/m);
  return String(mm?.[1] || '').trim();
}

function firstParagraph(text: string): string {
  const lines = String(text || '').split(/\r?\n/);
  let started = false;
  const chunk: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      if (started) break;
      continue;
    }
    if (/^#{1,6}\s+/.test(t)) continue;
    started = true;
    chunk.push(t);
  }
  return chunk.join(' ').trim();
}

function normalizeActionId(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'run';
}

function extractTemplates(content: string): SkillTemplate[] {
  const lines = String(content || '').split(/\r?\n/);
  const templates: SkillTemplate[] = [];
  const seen = new Set<string>();
  let inCode = false;

  const maybePush = (label: string, command: string) => {
    const cmd = String(command || '').trim().replace(/^`|`$/g, '');
    if (!cmd) return;
    if (!/^[a-z0-9._-]+\s+.+/i.test(cmd)) return;
    const key = cmd.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const requiresConfirmation = /\b(send|delete|remove|drop|clear|create|append|update|write|rm)\b/i.test(cmd);
    const action = normalizeActionId(label || cmd.split(/\s+/).slice(1, 3).join('_'));
    templates.push({
      action,
      label: String(label || action).trim(),
      command: cmd,
      requires_confirmation: requiresConfirmation,
    });
  };

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      inCode = !inCode;
      continue;
    }
    if (!trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;

    if (inCode) {
      maybePush('', trimmed);
      continue;
    }

    const labeled = trimmed.match(/^(?:[-*]\s*)?([^:]{2,60}):\s*`?([a-z0-9._-]+[\s\S]*?)`?\s*$/i);
    if (labeled?.[2]) {
      maybePush(String(labeled[1] || '').trim(), String(labeled[2] || '').trim());
      continue;
    }

    const plain = trimmed.replace(/^[-*]\s*/, '');
    if (/^[a-z0-9._-]+\s+[^.]+$/i.test(plain) && !/[.!?]$/.test(plain)) {
      maybePush('', plain);
    }
  }

  return templates.slice(0, 24);
}

function extractBinaries(templates: SkillTemplate[]): string[] {
  const out = new Set<string>();
  for (const t of templates) {
    const bin = String(t.command || '').trim().split(/\s+/)[0];
    if (bin) out.add(bin.toLowerCase());
  }
  return Array.from(out);
}

function extractEnvVars(content: string): string[] {
  const out = new Set<string>();
  for (const mm of String(content || '').matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=/g)) {
    const k = String(mm[1] || '').trim();
    if (k) out.add(k);
  }
  return Array.from(out);
}

function extractRequiredFiles(content: string): string[] {
  const out = new Set<string>();
  for (const mm of String(content || '').matchAll(/\b([a-zA-Z0-9_./\\-]+\.(?:json|ya?ml|pem|p12|key|txt|env))\b/g)) {
    const p = String(mm[1] || '').trim();
    if (p) out.add(p);
  }
  return Array.from(out);
}

function extractCredentialSignals(content: string): string[] {
  const low = String(content || '').toLowerCase();
  const out: string[] = [];
  if (/\boauth\b/.test(low)) out.push('oauth');
  if (/\bapi key\b/.test(low)) out.push('api_key');
  if (/\btoken\b/.test(low)) out.push('token');
  if (/\bclient_secret\b/.test(low)) out.push('client_secret');
  if (/\bcredential/.test(low)) out.push('credentials');
  return Array.from(new Set(out));
}

function binaryExists(binary: string): boolean {
  const bin = String(binary || '').trim();
  if (!bin) return false;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = spawnSync(cmd, [bin], { stdio: 'pipe', encoding: 'utf-8' });
    return Number(out.status) === 0;
  } catch {
    return false;
  }
}

function requiredFileExists(filePath: string): boolean {
  const p = String(filePath || '').trim();
  if (!p) return true;
  if (path.isAbsolute(p)) return fs.existsSync(p);
  const candidates = new Set<string>([
    path.join(process.cwd(), p),
  ]);
  try {
    const workspace = getConfig().getConfig().workspace.path;
    if (workspace) candidates.add(path.join(workspace, p));
  } catch {
    // ignore
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return true;
  }
  return false;
}

function computeRisk(content: string, templates: SkillTemplate[], binaries: string[], credentials: string[]): {
  level: SkillRiskLevel;
  reasons: string[];
  warnings: string[];
} {
  const low = String(content || '').toLowerCase();
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  if (binaries.length) {
    reasons.push('third_party_binary');
    score += 1;
  }
  if (credentials.length) {
    reasons.push('credentials_required');
    score += 2;
  }
  if (templates.some((t) => t.requires_confirmation)) {
    reasons.push('sensitive_actions');
    score += 1;
  }
  if (/\b(brew|apt|yum|choco|pip|npm)\s+install\b|\bcurl\b|\bwget\b/i.test(low)) {
    warnings.push('contains_manual_install_steps');
    score += 1;
  }
  if (/\bconfirm before\b/.test(low)) {
    warnings.push('skill_requests_manual_confirmation');
  }

  const level: SkillRiskLevel = score >= 4 ? 'high' : (score >= 2 ? 'medium' : 'low');
  return { level, reasons: Array.from(new Set(reasons)), warnings: Array.from(new Set(warnings)) };
}

function chooseSkillType(templates: SkillTemplate[], content: string): SkillType {
  if (templates.length > 0) return 'cli';
  if (/\btool\b|\bapi\b/i.test(String(content || ''))) return 'native';
  return 'docs';
}

function buildPromptDoc(manifest: SkillManifest): string {
  const lines: string[] = [];
  lines.push(`# Skill: ${manifest.name}`);
  lines.push('');
  lines.push(manifest.description || 'Use this skill for its specialized workflow.');
  lines.push('');
  lines.push('## Rules');
  lines.push('- Follow only the command templates and safety notes in this prompt.');
  lines.push('- Ask for confirmation before actions marked as confirmation-required.');
  lines.push('- Prefer deterministic arguments and avoid inventing flags.');
  lines.push('');
  if (manifest.templates.length) {
    lines.push('## Command Templates');
    for (const t of manifest.templates.slice(0, 10)) {
      lines.push(`- ${t.label}: \`${t.command}\`${t.requires_confirmation ? ' (confirm first)' : ''}`);
    }
    lines.push('');
  }
  lines.push('## Requirements');
  if (manifest.requirements.binaries.length) {
    lines.push(`- Binary: ${manifest.requirements.binaries.join(', ')}`);
  }
  if (manifest.requirements.env.length) {
    lines.push(`- Env vars: ${manifest.requirements.env.join(', ')}`);
  }
  if (manifest.requirements.files.length) {
    lines.push(`- Files: ${manifest.requirements.files.join(', ')}`);
  }
  lines.push('');
  lines.push('## Safety');
  if (manifest.confirm_gates.length) {
    lines.push(`- Confirmation gates: ${manifest.confirm_gates.join(', ')}`);
  } else {
    lines.push('- No explicit confirmation gates detected.');
  }
  return lines.join('\n').trim() + '\n';
}

function parseVersion(content: string): string | undefined {
  const m = String(content || '').match(/\bversion\s*:\s*([0-9]+(?:\.[0-9]+){0,2})\b/i);
  return m?.[1] ? String(m[1]) : undefined;
}

function deriveIdFromContent(content: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const fmName = String(frontmatter.name || '').trim();
  const heading = firstHeading(body);
  return normalizeSkillId(fmName || heading || 'skill');
}

function deriveDescription(content: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const fmDesc = String(frontmatter.description || '').trim();
  if (fmDesc) return fmDesc;
  return firstParagraph(body) || 'Imported skill';
}

function deriveName(content: string, fallbackId: string): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const fmName = String(frontmatter.name || '').trim();
  if (fmName) return fmName;
  const heading = firstHeading(body);
  if (heading) return heading;
  return fallbackId;
}

function computeStatus(manifest: Pick<SkillManifest, 'execution_enabled' | 'requirements' | 'risk'>): SkillRuntimeStatus {
  const missing = (manifest.requirements.missing_binaries.length + manifest.requirements.missing_env.length + manifest.requirements.missing_files.length) > 0;
  if (missing) return 'needs_setup';
  if (!manifest.execution_enabled) return 'blocked';
  return 'ready';
}

function buildManifest(input: SkillPackWriteInput, existing?: SkillManifest | null): SkillManifest {
  const skillMd = String(input.skillMdContent || '').trim();
  const id = normalizeSkillId(input.id || existing?.id || deriveIdFromContent(skillMd));
  const name = deriveName(skillMd, id);
  const description = deriveDescription(skillMd);
  const templates = extractTemplates(skillMd);
  const binaries = extractBinaries(templates);
  const env = extractEnvVars(skillMd);
  const files = extractRequiredFiles(skillMd);
  const credentials = extractCredentialSignals(skillMd);
  const missingBinaries = binaries.filter((b) => !binaryExists(b));
  const missingEnv = env.filter((k) => !String(process.env[k] || '').trim());
  const missingFiles = files.filter((f) => !requiredFileExists(f));
  const risk = computeRisk(skillMd, templates, binaries, credentials);
  const confirmGates = Array.from(new Set(
    templates.filter((t) => t.requires_confirmation).map((t) => t.action)
  ));
  const type = chooseSkillType(templates, skillMd);
  const defaultEnabled = risk.level === 'low' && missingBinaries.length === 0 && missingEnv.length === 0 && missingFiles.length === 0;
  const executionEnabled = typeof existing?.execution_enabled === 'boolean'
    ? existing.execution_enabled
    : defaultEnabled;
  const manifest: SkillManifest = {
    schema_version: 1,
    id,
    name,
    description,
    source: {
      type: input.sourceType || existing?.source?.type || 'manual',
      url: input.sourceUrl || existing?.source?.url,
      filename: input.sourceFilename || existing?.source?.filename,
      installed_at: existing?.source?.installed_at || Date.now(),
    },
    type,
    status: 'blocked',
    execution_enabled: executionEnabled,
    requirements: {
      binaries,
      env,
      files,
      credentials,
      missing_binaries: missingBinaries,
      missing_env: missingEnv,
      missing_files: missingFiles,
    },
    risk,
    confirm_gates: confirmGates,
    templates,
    files: {
      skill_md: 'SKILL.md',
      prompt_md: 'PROMPT.md',
      manifest_json: 'skill.json',
      risk_json: 'RISK.json',
    },
    version: parseVersion(skillMd) || existing?.version,
    generated_at: Date.now(),
  };
  manifest.status = computeStatus(manifest);
  return manifest;
}

function pathsForSkill(id: string): { dir: string; skillMd: string; promptMd: string; manifest: string; risk: string } {
  const dir = resolveSkillDir(id);
  return {
    dir,
    skillMd: path.join(dir, 'SKILL.md'),
    promptMd: path.join(dir, 'PROMPT.md'),
    manifest: path.join(dir, 'skill.json'),
    risk: path.join(dir, 'RISK.json'),
  };
}

export function writeSkillPackFromContent(input: SkillPackWriteInput): SkillManifest {
  const tempId = normalizeSkillId(input.id || deriveIdFromContent(input.skillMdContent || ''));
  const p = pathsForSkill(tempId);
  ensureDir(p.dir);
  const existing = readJsonIfExists<SkillManifest>(p.manifest);
  const manifest = buildManifest({ ...input, id: tempId }, existing);
  const finalPaths = pathsForSkill(manifest.id);
  ensureDir(finalPaths.dir);

  fs.writeFileSync(finalPaths.skillMd, String(input.skillMdContent || '').trim() + '\n', 'utf-8');
  fs.writeFileSync(finalPaths.promptMd, buildPromptDoc(manifest), 'utf-8');
  fs.writeFileSync(finalPaths.manifest, JSON.stringify(manifest, null, 2), 'utf-8');
  fs.writeFileSync(finalPaths.risk, JSON.stringify({
    id: manifest.id,
    level: manifest.risk.level,
    reasons: manifest.risk.reasons,
    warnings: manifest.risk.warnings,
    requirements: {
      missing_binaries: manifest.requirements.missing_binaries,
      missing_env: manifest.requirements.missing_env,
      missing_files: manifest.requirements.missing_files,
    },
    generated_at: manifest.generated_at,
  }, null, 2), 'utf-8');
  return manifest;
}

export function loadSkillManifest(skillId: string): SkillManifest | null {
  const id = normalizeSkillId(skillId);
  const p = pathsForSkill(id);
  const manifest = readJsonIfExists<SkillManifest>(p.manifest);
  if (manifest) return manifest;
  if (!fs.existsSync(p.skillMd)) return null;
  const content = fs.readFileSync(p.skillMd, 'utf-8');
  return writeSkillPackFromContent({
    id,
    skillMdContent: content,
    sourceType: 'manual',
  });
}

export function listSkillManifests(): SkillManifest[] {
  const out: SkillManifest[] = [];
  for (const id of listSkillIds()) {
    const m = loadSkillManifest(id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function setSkillExecutionEnabled(skillId: string, enabled: boolean): SkillManifest | null {
  const m = loadSkillManifest(skillId);
  if (!m) return null;
  m.execution_enabled = !!enabled;
  m.status = computeStatus(m);
  m.generated_at = Date.now();
  const p = pathsForSkill(m.id);
  fs.writeFileSync(p.promptMd, buildPromptDoc(m), 'utf-8');
  fs.writeFileSync(p.manifest, JSON.stringify(m, null, 2), 'utf-8');
  fs.writeFileSync(p.risk, JSON.stringify({
    id: m.id,
    level: m.risk.level,
    reasons: m.risk.reasons,
    warnings: m.risk.warnings,
    requirements: {
      missing_binaries: m.requirements.missing_binaries,
      missing_env: m.requirements.missing_env,
      missing_files: m.requirements.missing_files,
    },
    generated_at: m.generated_at,
  }, null, 2), 'utf-8');
  return m;
}

export function removeSkillPack(skillId: string): boolean {
  const id = normalizeSkillId(skillId);
  const dir = resolveSkillDir(id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export function refreshSkillPack(skillId: string): SkillManifest | null {
  const id = normalizeSkillId(skillId);
  const p = pathsForSkill(id);
  if (!fs.existsSync(p.skillMd)) return null;
  const content = fs.readFileSync(p.skillMd, 'utf-8');
  const existing = readJsonIfExists<SkillManifest>(p.manifest);
  const sourceType = existing?.source?.type || 'manual';
  return writeSkillPackFromContent({
    id,
    skillMdContent: content,
    sourceType,
    sourceUrl: existing?.source?.url,
    sourceFilename: existing?.source?.filename,
  });
}

