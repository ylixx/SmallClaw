import fs from 'fs';
import path from 'path';
import { ToolResult } from '../types.js';
import {
  listSkillManifests,
  loadSkillManifest,
  refreshSkillPack,
  removeSkillPack,
  setSkillExecutionEnabled,
  writeSkillPackFromContent,
  SkillManifest,
} from '../skills/processor.js';
import { normalizeSkillId, resolveSkillDir, resolveSkillLockFile } from '../skills/store.js';
import { executeShell } from './shell.js';

function summarizeSkillForApi(m: SkillManifest): any {
  return {
    id: m.id,
    slug: m.id,
    name: m.name,
    description: m.description,
    type: m.type,
    status: m.status,
    execution_enabled: m.execution_enabled,
    risk: m.risk,
    requirements: m.requirements,
    source: m.source,
    confirm_gates: m.confirm_gates,
    templates: m.templates,
    version: m.version || 'unknown',
    generated_at: m.generated_at,
    path: resolveSkillDir(m.id),
  };
}

function updateLockFromManifest(manifest: SkillManifest): void {
  try {
    const lockPath = resolveSkillLockFile();
    const lockDir = path.dirname(lockPath);
    fs.mkdirSync(lockDir, { recursive: true });
    let lock: Record<string, any> = {};
    if (fs.existsSync(lockPath)) {
      lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    }
    lock[manifest.id] = {
      slug: manifest.id,
      version: manifest.version || 'unknown',
      installed_at: manifest.source?.installed_at || Date.now(),
      source_type: manifest.source?.type || 'manual',
      status: manifest.status,
      risk_level: manifest.risk?.level || 'low',
    };
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf-8');
  } catch {
    // best effort only
  }
}

function removeFromLock(skillId: string): void {
  try {
    const lockPath = resolveSkillLockFile();
    if (!fs.existsSync(lockPath)) return;
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (lock && typeof lock === 'object' && Object.prototype.hasOwnProperty.call(lock, skillId)) {
      delete lock[skillId];
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), 'utf-8');
    }
  } catch {
    // best effort only
  }
}

function normalizeActionId(input: string): string {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function shellQuote(value: string): string {
  const v = String(value ?? '');
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(v)) return v;
  return `'${v.replace(/'/g, "''")}'`;
}

function placeholderVariants(raw: string): string[] {
  const base = String(raw || '').trim();
  if (!base) return [];
  const norm = normalizeActionId(base).replace(/_/g, '');
  const withUnderscore = String(base || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const withDash = String(base || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return Array.from(new Set([
    base,
    base.toLowerCase(),
    withUnderscore,
    withUnderscore.replace(/_/g, ''),
    withDash,
    withDash.replace(/-/g, ''),
    norm,
  ].filter(Boolean)));
}

function pickTemplate(manifest: SkillManifest, action?: string, command?: string): { action: string; label: string; command: string; requires_confirmation: boolean } | null {
  const templates = Array.isArray(manifest.templates) ? manifest.templates : [];
  if (!templates.length) return null;

  if (action) {
    const target = normalizeActionId(action);
    const found = templates.find((t: any) => {
      const a = normalizeActionId(String(t?.action || ''));
      const l = normalizeActionId(String(t?.label || ''));
      return a === target || l === target;
    });
    if (found) return found as any;
  }

  if (command) {
    const cmd = String(command || '').trim();
    const found = templates.find((t: any) => String(t?.command || '').trim() === cmd);
    if (found) return found as any;
  }

  return null;
}

function renderTemplateCommand(templateCommand: string, params: Record<string, any>): { ok: boolean; command?: string; error?: string; missing?: string[] } {
  const base = String(templateCommand || '').trim();
  if (!base) return { ok: false, error: 'Template command is empty' };
  const input = params && typeof params === 'object' ? params : {};
  let rendered = base;
  const missing = new Set<string>();
  const phs = Array.from(new Set([
    ...Array.from(base.matchAll(/<([^>]+)>/g)).map((m) => String(m[1] || '').trim()),
    ...Array.from(base.matchAll(/\{\{([^}]+)\}\}/g)).map((m) => String(m[1] || '').trim()),
  ].filter(Boolean)));

  for (const ph of phs) {
    const keys = placeholderVariants(ph);
    let value: any = undefined;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(input, k)) {
        value = (input as any)[k];
        break;
      }
    }
    if (value === undefined || value === null || String(value).trim() === '') {
      missing.add(ph);
      continue;
    }
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    const safe = shellQuote(str);
    rendered = rendered.replace(new RegExp(`<${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g'), safe);
    rendered = rendered.replace(new RegExp(`\\{\\{${ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g'), safe);
  }

  if (missing.size > 0) {
    return { ok: false, error: 'Missing template parameters', missing: Array.from(missing) };
  }
  if (/<[^>]+>/.test(rendered) || /\{\{[^}]+\}\}/.test(rendered)) {
    return { ok: false, error: 'Unresolved template placeholders remain' };
  }
  return { ok: true, command: rendered.trim() };
}

function hasBlockedShellOperators(command: string): string | null {
  const c = String(command || '').trim();
  if (!c) return 'empty_command';
  if (/[|`]/.test(c)) return 'pipe_or_backtick_not_allowed';
  if (/&&|\|\|/.test(c)) return 'command_chaining_not_allowed';
  if (/[<>]/.test(c)) return 'redirection_not_allowed';
  if (/;\s*/.test(c)) return 'statement_chaining_not_allowed';
  if (/\$\(/.test(c)) return 'subshell_not_allowed';
  return null;
}

function ensureTemplateShape(template: string, rendered: string): boolean {
  const esc = String(template || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/<[^>]+>/g, '[\\s\\S]+?')
    .replace(/\\\{\\\{[^}]+\\\}\\\}/g, '[\\s\\S]+?');
  try {
    const re = new RegExp(`^${esc}$`);
    return re.test(String(rendered || '').trim());
  } catch {
    return false;
  }
}

function summarizeMissing(manifest: SkillManifest): string[] {
  return [
    ...manifest.requirements.missing_binaries,
    ...manifest.requirements.missing_env,
    ...manifest.requirements.missing_files,
  ];
}

export async function executeSkillList(_args: {}): Promise<ToolResult> {
  const manifests = listSkillManifests();
  if (manifests.length === 0) {
    return { success: true, data: { skills: [] }, stdout: 'No skills installed. Use skill_search to find skills in configured registries.' };
  }
  const lines = manifests.map((m) => {
    const missing = [
      ...m.requirements.missing_binaries,
      ...m.requirements.missing_env,
      ...m.requirements.missing_files,
    ];
    const missingText = missing.length ? ` missing:${missing.length}` : '';
    return `- ${m.id} [${m.status}] risk:${m.risk.level}${missingText}`;
  });
  return {
    success: true,
    data: { skills: manifests.map(summarizeSkillForApi) },
    stdout: `Installed skills (${manifests.length}):\n${lines.join('\n')}`,
  };
}

export async function executeSkillSearch(args: { query: string }): Promise<ToolResult> {
  if (!args.query?.trim()) return { success: false, error: 'query is required' };

  try {
    const url = `https://clawhub.ai/api/search?q=${encodeURIComponent(args.query)}&limit=8`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'SmallClaw/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { success: false, error: `Skill registry API returned ${res.status}. Try installing manually: skill_install <slug> confirmed:true` };
    }

    const data: any = await res.json();
    const results = Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];

    if (results.length === 0) {
      return { success: true, stdout: `No skills found for: "${args.query}"` };
    }

    const lines = results.map((r: any) =>
      `- **${r.slug || r.name}** v${r.version || '?'}: ${r.description || ''}\n  Install: skill_install ${r.slug || r.name}`
    );
    return {
      success: true,
      data: { results },
      stdout: `Skill registry results for "${args.query}":\n\n${lines.join('\n\n')}`,
    };
  } catch (err: any) {
    return { success: false, error: `Skill search failed: ${err.message}` };
  }
}

export async function executeSkillInstall(args: { slug: string; confirmed?: boolean }): Promise<ToolResult> {
  if (!args.slug?.trim()) return { success: false, error: 'slug is required' };
  const slug = normalizeSkillId(args.slug);

  if (!args.confirmed) {
    return {
      success: false,
      error: `CONFIRMATION REQUIRED: About to download and install skill "${slug}" from registry.\n` +
        `Please review the skill first at https://clawhub.ai/skills/${slug}\n` +
        `Then call skill_install again with confirmed: true`,
    };
  }

  try {
    const rawUrl = `https://clawhub.ai/skills/${slug}/SKILL.md`;
    const res = await fetch(rawUrl, {
      headers: { 'User-Agent': 'SmallClaw/1.0' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { success: false, error: `Skill "${slug}" not found in registry (HTTP ${res.status})` };
    }

    const content = await res.text();
    if ((!/skill/i.test(content) && content.length < 50) || !content.trim()) {
      return { success: false, error: `Downloaded content for "${slug}" looks invalid. Skipping install.` };
    }

    const manifest = writeSkillPackFromContent({
      id: slug,
      skillMdContent: content,
      sourceType: 'clawhub',
      sourceUrl: rawUrl,
    });
    updateLockFromManifest(manifest);

    return {
      success: true,
      data: { skill: summarizeSkillForApi(manifest) },
      stdout: `Skill "${slug}" installed to ${resolveSkillDir(slug)} (${manifest.status}, risk:${manifest.risk.level}).`,
    };
  } catch (err: any) {
    return { success: false, error: `Skill install failed: ${err.message}` };
  }
}

export async function executeSkillUpload(args: { skill_md: string; skill_id?: string; filename?: string }): Promise<ToolResult> {
  const content = String(args.skill_md || '').trim();
  if (!content) return { success: false, error: 'skill_md is required' };
  try {
    const manifest = writeSkillPackFromContent({
      id: args.skill_id || args.filename || undefined,
      skillMdContent: content,
      sourceType: 'upload',
      sourceFilename: args.filename || undefined,
    });
    updateLockFromManifest(manifest);
    return {
      success: true,
      data: { skill: summarizeSkillForApi(manifest) },
      stdout: `Skill "${manifest.id}" uploaded (${manifest.status}, risk:${manifest.risk.level}).`,
    };
  } catch (err: any) {
    return { success: false, error: `Skill upload failed: ${err.message}` };
  }
}

export async function executeSkillSetEnabled(args: { slug: string; enabled: boolean }): Promise<ToolResult> {
  if (!args.slug?.trim()) return { success: false, error: 'slug is required' };
  const updated = setSkillExecutionEnabled(args.slug, !!args.enabled);
  if (!updated) return { success: false, error: `Skill "${args.slug}" not found` };
  updateLockFromManifest(updated);
  return {
    success: true,
    data: { skill: summarizeSkillForApi(updated) },
    stdout: `Skill "${updated.id}" execution ${updated.execution_enabled ? 'enabled' : 'disabled'} (${updated.status}).`,
  };
}

export async function executeSkillInspect(args: { slug: string }): Promise<ToolResult> {
  if (!args.slug?.trim()) return { success: false, error: 'slug is required' };
  const m = loadSkillManifest(args.slug);
  if (!m) return { success: false, error: `Skill "${args.slug}" not found` };
  return { success: true, data: { skill: summarizeSkillForApi(m) }, stdout: `Skill "${m.id}" loaded.` };
}

export async function executeSkillRescan(args: { slug: string }): Promise<ToolResult> {
  if (!args.slug?.trim()) return { success: false, error: 'slug is required' };
  const m = refreshSkillPack(args.slug);
  if (!m) return { success: false, error: `Skill "${args.slug}" not found` };
  updateLockFromManifest(m);
  return {
    success: true,
    data: { skill: summarizeSkillForApi(m) },
    stdout: `Skill "${m.id}" re-scanned (${m.status}, risk:${m.risk.level}).`,
  };
}

export async function executeSkillRemove(args: { slug: string }): Promise<ToolResult> {
  if (!args.slug?.trim()) return { success: false, error: 'slug is required' };
  const id = normalizeSkillId(args.slug);
  const removed = removeSkillPack(id);
  if (!removed) {
    return { success: false, error: `Skill "${args.slug}" is not installed` };
  }
  removeFromLock(id);
  return { success: true, stdout: `Skill "${id}" removed.` };
}

export async function executeSkillExec(args: {
  slug: string;
  action?: string;
  command?: string;
  params?: Record<string, any>;
  confirmed?: boolean;
  dry_run?: boolean;
  cwd?: string;
}): Promise<ToolResult> {
  const slug = String(args.slug || '').trim();
  if (!slug) return { success: false, error: 'slug is required' };
  const manifest = loadSkillManifest(slug);
  if (!manifest) return { success: false, error: `Skill "${slug}" not found` };

  if (!manifest.execution_enabled) {
    return {
      success: false,
      error: `Skill "${manifest.id}" execution is disabled. Enable it first.`,
      data: { reason: 'execution_disabled', status: manifest.status },
    };
  }

  const missing = summarizeMissing(manifest);
  if (missing.length > 0 || manifest.status === 'needs_setup') {
    return {
      success: false,
      error: `Skill "${manifest.id}" needs setup before execution.`,
      data: {
        reason: 'needs_setup',
        missing,
        requirements: manifest.requirements,
      },
    };
  }

  const tpl = pickTemplate(manifest, args.action, args.command);
  if (!tpl) {
    const actions = (manifest.templates || []).map((t: any) => String(t?.action || '').trim()).filter(Boolean);
    return {
      success: false,
      error: `No matching template found. Provide action or command from this skill.`,
      data: { reason: 'template_not_found', available_actions: actions },
    };
  }

  if (tpl.requires_confirmation && !args.confirmed) {
    return {
      success: false,
      error: `CONFIRMATION REQUIRED: Template "${tpl.action}" requires confirmation. Re-run with confirmed:true.`,
      data: { reason: 'confirmation_required', action: tpl.action, command: tpl.command },
    };
  }

  const rendered = renderTemplateCommand(tpl.command, args.params || {});
  if (!rendered.ok || !rendered.command) {
    return {
      success: false,
      error: rendered.error || 'Failed to render template command',
      data: { reason: 'template_render_failed', missing: rendered.missing || [] },
    };
  }

  const command = rendered.command;
  const opErr = hasBlockedShellOperators(command);
  if (opErr) {
    return {
      success: false,
      error: `Blocked command pattern: ${opErr}`,
      data: { reason: 'blocked_operator', command },
    };
  }

  const firstToken = String(command.split(/\s+/)[0] || '').trim().toLowerCase();
  const allowedBinaries = manifest.requirements.binaries.length
    ? manifest.requirements.binaries.map((b) => String(b || '').toLowerCase())
    : [String(tpl.command || '').trim().split(/\s+/)[0]?.toLowerCase()].filter(Boolean) as string[];
  if (allowedBinaries.length > 0 && !allowedBinaries.includes(firstToken)) {
    return {
      success: false,
      error: `Rendered command binary "${firstToken}" is not allowed by skill manifest.`,
      data: { reason: 'binary_not_allowed', allowed_binaries: allowedBinaries, command },
    };
  }

  if (!ensureTemplateShape(tpl.command, command)) {
    return {
      success: false,
      error: 'Rendered command does not match template shape.',
      data: { reason: 'template_shape_mismatch', template: tpl.command, command },
    };
  }

  if (args.dry_run) {
    return {
      success: true,
      stdout: `Dry run for ${manifest.id}:${tpl.action}\n${command}`,
      data: {
        skill: manifest.id,
        action: tpl.action,
        command,
        requires_confirmation: !!tpl.requires_confirmation,
      },
    };
  }

  const shellRes = await executeShell({ command, cwd: args.cwd });
  if (!shellRes.success) {
    return {
      success: false,
      error: shellRes.error || 'Skill command failed',
      stdout: shellRes.stdout,
      stderr: shellRes.stderr,
      exitCode: shellRes.exitCode,
      data: {
        skill: manifest.id,
        action: tpl.action,
        command,
      },
    };
  }

  return {
    success: true,
    stdout: shellRes.stdout,
    stderr: shellRes.stderr,
    exitCode: shellRes.exitCode,
    data: {
      skill: manifest.id,
      action: tpl.action,
      command,
    },
  };
}

export const skillListTool = {
  name: 'skill_list',
  description: 'List installed skills',
  execute: executeSkillList,
  schema: {},
};

export const skillSearchTool = {
  name: 'skill_search',
  description: 'Search configured skill registries',
  execute: executeSkillSearch,
  schema: {
    query: 'string (required) - Search query (e.g. "python", "docker", "git")',
  },
};

export const skillInstallTool = {
  name: 'skill_install',
  description: 'Download and install a skill from a configured registry (requires confirmation)',
  execute: executeSkillInstall,
  schema: {
    slug: 'string (required) - Skill slug (e.g. "python-expert")',
    confirmed: 'boolean (optional) - Must be true to actually install (safety gate)',
  },
};

export const skillRemoveTool = {
  name: 'skill_remove',
  description: 'Remove an installed skill',
  execute: executeSkillRemove,
  schema: {
    slug: 'string (required) - Skill slug to remove',
  },
};

export const skillExecTool = {
  name: 'skill_exec',
  description: 'Execute an installed skill template with strict validation and confirmation gates',
  execute: executeSkillExec,
  schema: {
    slug: 'string (required) - Installed skill ID',
    action: 'string (optional) - Template action name from skill templates',
    command: 'string (optional) - Exact template command text if action not provided',
    params: 'object (optional) - Placeholder arguments for template rendering',
    confirmed: 'boolean (optional) - Required for sensitive templates',
    dry_run: 'boolean (optional) - Render/validate only, do not execute',
    cwd: 'string (optional) - Working directory (defaults to workspace)',
  },
};
