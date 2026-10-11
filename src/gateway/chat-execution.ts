/**
 * chat-execution.ts — tool execution core extracted from server-v2.ts (Phase 5b).
 * executeTool is a thin plan-gate wrapper; executeToolImpl is the 1k-line
 * per-tool dispatcher (files / shell / web / cron / task / knowledge / MCP /
 * multimodal). server-v2 keeps the Express routes and composition-root wiring;
 * handleTaskControlAction and cronScheduler are injected via
 * createExecuteTool(deps) to avoid a circular import (both close over
 * handleChat / telegramChannel which stay in the composition root).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { getOllamaClient } from '../agents/ollama-client';
import {
  isPlanGateActive, isPlanModeEnabledFor, isPlanTool, getPlanState, getPendingPlan,
  planGateMessage, awaitPlanDecision, PLAN_READONLY_TOOLS,
} from './plan-mode';
import {
  executeOfficeTool, isOfficeReadFile, isOfficeWriteFile,
} from '../tools/office';
import { executeImageTool } from '../tools/image';
import { executeFileBatchTool } from '../tools/file-batch';
import { executeKnowledgeTool } from '../tools/knowledge';
import {
  browserOpen, browserSnapshot, browserClick, browserFill, browserPressKey,
  browserWait, browserScroll, browserClose,
} from './browser-tools';
import {
  desktopScreenshot, desktopFindWindow, desktopFocusWindow, desktopClick, desktopDrag,
  desktopWait, desktopType, desktopPressKey, desktopGetClipboard, desktopSetClipboard,
} from './desktop-tools';
import { getMCPManager } from './mcp-manager';
import { SubagentManager } from './subagent-manager';
import { broadcastWS } from './realtime';
import { resolveRunCommand, suggestRunCommandFix, SAFE_COMMANDS, ARG_SAFE_COMMANDS } from './run-command-router';
import { webSearch, webFetch } from './server-v2-search';
import { noteToolFailure, resetToolFailure } from './request-guards';
import { checkToolDenied, agentShellEnabled, collectMcpToolEntries } from './tool-registry';
import { executeAgentBuilderTool } from './agent-builder-integration';
import type { CronScheduler } from './cron-scheduler';

// Last-filename memory shared by executeToolImpl's file tools (moved with it).
const lastFilenameUsed: Map<string, string> = new Map();

export interface ArtifactEntry {
  sessionId: string;
  tool: string;
  paths: string[];
  summary: string;
  at: number;
  before?: string;
  after?: string;
}
const ARTIFACT_LOG_LIMIT = 300;
const artifactLog: ArtifactEntry[] = [];
function recordArtifact(
  sessionId: string,
  tool: string,
  outcome: { result: string; error: boolean; paths?: string[] },
  extra?: { before?: string | null; after?: string | null },
): void {
  if (outcome?.error) return;
  const paths = (Array.isArray(outcome.paths) ? outcome.paths : [])
    .filter(Boolean)
    .map(String)
    .slice(0, 20);
  const entry: ArtifactEntry = {
    sessionId: String(sessionId || 'default'),
    tool: String(tool || ''),
    paths,
    summary: String(outcome.result || '').slice(0, 300),
    at: Date.now(),
  };
  if (typeof extra?.before === 'string') entry.before = extra.before;
  if (typeof extra?.after === 'string') entry.after = extra.after;
  artifactLog.push(entry);
  while (artifactLog.length > ARTIFACT_LOG_LIMIT) artifactLog.shift();
}

export function listArtifacts(sessionId?: string): ArtifactEntry[] {
  const sid = String(sessionId || '').trim();
  const items = sid ? artifactLog.filter(e => e.sessionId === sid) : artifactLog.slice();
  return items.slice(-100).reverse();
}
function isPathInsideDirectory(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  if (resolvedBase === resolvedTarget) return true;
  const rel = path.relative(resolvedBase, resolvedTarget);
  if (!rel) return true;
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false;
  return !path.isAbsolute(rel);
}

function realpathForGuard(target: string): string {
  let current = path.resolve(String(target || ''));
  const tail: string[] = [];
  for (let i = 0; i < 64 && !fs.existsSync(current); i++) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  try {
    current = fs.realpathSync(current);
  } catch {
    // Keep the unresolved path when realpath fails.
  }
  return tail.length ? path.join(current, ...tail) : current;
}
export function resolveToolFilePath(
  workspacePath: string,
  filename: unknown,
): { ok: true; path: string } | { ok: false; error: string } {
  const raw = String(filename ?? '').trim();
  if (!raw) return { ok: false, error: 'Missing required parameter "filename". You must pass a filename in the tool call arguments, e.g. {"filename": "report.html", "content": "..."}. Do not retry without it.' };
  if (raw.includes('\0')) return { ok: false, error: 'Invalid filename' };

  const resolved = realpathForGuard(path.resolve(String(workspacePath || ''), raw));

  let filesPermissions: any = null;
  try {
    filesPermissions = (getConfig().getConfig() as any)?.tools?.permissions?.files;
  } catch {
    filesPermissions = null;
  }

  const allowedRaw: any[] = Array.isArray(filesPermissions?.allowed_paths) ? filesPermissions.allowed_paths : [];
  const blockedRaw: any[] = Array.isArray(filesPermissions?.blocked_paths) ? filesPermissions.blocked_paths : [];

  const allowedBases = [...new Set([workspacePath, ...allowedRaw]
    .filter((value: any): value is string => typeof value === 'string' && !!value.trim())
    .map((value: string) => realpathForGuard(value.trim())))];

  const blockedBases = [...new Set(blockedRaw
    .filter((value: any): value is string => typeof value === 'string' && !!value.trim())
    .map((value: string) => realpathForGuard(value.trim())))];

  for (const blocked of blockedBases) {
    if (isPathInsideDirectory(blocked, resolved)) {
      return { ok: false, error: `Access denied: "${raw}" is inside blocked directory "${blocked}".` };
    }
  }

  if (!allowedBases.some(base => isPathInsideDirectory(base, resolved))) {
    const suffix = allowedBases.length ? ` Allowed: ${allowedBases.join(', ')}` : '';
    return { ok: false, error: `Access denied: "${raw}" is outside the allowed directories.${suffix}` };
  }

  return { ok: true, path: resolved };
}
const OFFICE_TEXT_EDIT_HINT =
  ' is a binary Office document - text edits would corrupt it. Use doc_write instead (call it with mode:"preview" first, then mode:"apply" after approval), or read it with doc_read / doc_inspect.';

function rejectOfficeTextEdit(filePath: string, filename: string): string | null {
  return isOfficeWriteFile(filePath) ? `"${filename}"${OFFICE_TEXT_EDIT_HINT}` : null;
}
export interface ToolResult {
  name: string;
  args: any;
  result: string;
  error: boolean;
}

export interface TaskControlResponse {
  success: boolean;
  action: string;
  code?: string;
  message?: string;
  scope?: string;
  task?: Record<string, any> | null;
  tasks?: Array<Record<string, any>>;
  candidates?: Array<Record<string, any>>;
}

type ScheduleJobAction =
  | 'list'
  | 'create'
  | 'update'
  | 'pause'
  | 'resume'
  | 'delete'
  | 'run_now';
function normalizeScheduleJobAction(raw: any): ScheduleJobAction | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (v === 'run-now') return 'run_now';
  if (['list', 'create', 'update', 'pause', 'resume', 'delete', 'run_now'].includes(v)) {
    return v as ScheduleJobAction;
  }
  return null;
}

/**
 * 布尔确认容错：小模型 JSON 输出常把 true 写成字符串 'true'/'True'/'TRUE'。
 * 只有显式确认值才返回 true，保持安全闸门语义不变。
 */
export function isConfirmed(value: any): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function summarizeCronJob(job: any): Record<string, any> {
  return {
    id: String(job?.id || ''),
    name: String(job?.name || ''),
    type: String(job?.type || 'recurring'),
    status: String(job?.status || 'scheduled'),
    enabled: job?.enabled !== false,
    schedule: job?.schedule || null,
    runAt: job?.runAt || null,
    tz: job?.tz || null,
    nextRun: job?.nextRun || null,
    lastRun: job?.lastRun || null,
    lastResult: job?.lastResult || null,
    sessionTarget: job?.sessionTarget || 'isolated',
    model: job?.model || null,
  };
}

function normalizeDeliveryChannel(raw: any): 'web' | 'telegram' | 'discord' | 'whatsapp' {
  const v = String(raw || 'web').trim().toLowerCase();
  if (v === 'telegram' || v === 'discord' || v === 'whatsapp') return v;
  return 'web';
}

export function normalizeToolArgs(rawArgs: any): any {
  if (rawArgs == null) return {};
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof rawArgs === 'object') return rawArgs;
  return {};
}
const TEXT_SNAPSHOT_MAX_BYTES = 200_000;

// Max chars of a file's content injected into the model context when the system
// reads a FILE_ANALYSIS target on the model's behalf (small local models often
// do not reliably issue tool calls themselves). Tail-heavy: "last line / last
// record" questions need the end of the file.
export const ANALYSIS_INJECT_MAX_CHARS = 16_000;

// Resolve the file the user is most likely asking about in a FILE_ANALYSIS
// request: workspace files whose basename appears in the message win by match
// length; returns null when nothing matches (the model may then list_files).
export function resolveAnalysisTarget(message: string, workspacePath: string): string | null {
  try {
    const files = fs.readdirSync(workspacePath, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => e.name);
    const msg = String(message || '').toLowerCase();
    const scored = files
      .map((name) => {
        const base = name.replace(/\.[^.]+$/, '').toLowerCase();
        let score = 0;
        if (base.length >= 2 && msg.includes(base)) score = base.length;
        else if (base.length >= 2 && msg.includes(base.split(/[_\-]/)[0])) score = 1;
        return { name, score };
      })
      .filter(s => s.score > 0);
    scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return scored.length ? scored[0].name : null;
  } catch {
    return null;
  }
}
function readTextSnapshot(filePath: string | null): string | null {
  if (!filePath) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_SNAPSHOT_MAX_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    if (buf.includes(0)) return null;
    return buf.toString('utf-8');
  } catch {
    return null;
  }
}
function textTargetOf(args: any, workspacePath: string): string | null {
  const raw = String(args?.filename || args?.name || args?.path || '').trim();
  if (!raw) return null;
  const guarded = resolveToolFilePath(workspacePath, raw);
  return guarded.ok ? guarded.path : null;
}
export interface ExecuteToolDeps {
  handleTaskControlAction: (sessionId: string, args: any) => Promise<TaskControlResponse>;
  cronScheduler: CronScheduler;
}

export function createExecuteTool(deps: ExecuteToolDeps) {
  return async function executeTool(name: string, args: any, workspacePath: string, sessionId: string = 'default', emit?: (event: string, data: any) => void): Promise<ToolResult> {
    // ── Plan mode: only read-only tools until the user approves a submitted plan.
    if (isPlanGateActive(sessionId) && !PLAN_READONLY_TOOLS.has(name) && !isPlanTool(name)) {
      return { name, args, result: planGateMessage(name), error: true };
    }

    const targetPath = ['create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'delete_file'].includes(name)
      ? textTargetOf(args, workspacePath)
      : null;
    const beforeText = targetPath ? readTextSnapshot(targetPath) : null;

    const result = await executeToolImpl(name, args, workspacePath, sessionId, emit, deps);

    // Circuit breaker: the same call failing repeatedly means the model is stuck
    // guessing. Surface that instead of letting it burn more steps on it.
    if (result.error) {
      const breaker = noteToolFailure(sessionId, name, args);
      if (breaker) {
        return { name, args, result: `${result.result}\n\n${breaker}`, error: true };
      }
    } else {
      resetToolFailure(sessionId);
    }

    if (!result.error && targetPath) {
      const afterText = readTextSnapshot(targetPath);
      const changed = afterText !== null
        ? (beforeText === null ? name === 'create_file' : afterText !== beforeText)
        : (name === 'delete_file' && beforeText !== null);
      if (changed) {
        recordArtifact(sessionId, name, { ...result, paths: [targetPath] }, { before: beforeText, after: afterText });
      }
    }
    return result;
  };
}
export async function executeToolImpl(name: string, args: any, workspacePath: string, sessionId: string = 'default', emit?: (event: string, data: any) => void, deps: ExecuteToolDeps = { handleTaskControlAction: async () => ({ success: false, action: '', message: 'task_control unavailable' }), cronScheduler: null as any }): Promise<ToolResult> {
  // Filename inference: if the model forgot to pass filename, use the last one
  const needsFilename = ['read_file', 'create_file', 'replace_lines', 'insert_after', 'delete_lines', 'find_replace', 'delete_file'];
  if (needsFilename.includes(name)) {
    // Normalize: secondary AI sometimes returns "path" or "file" instead of "filename"
    if (!args.filename && !args.name) {
      if (args.path) { args.filename = args.path; }
      else if (args.file) { args.filename = args.file; }
    }
    const fn = args.filename || args.name;
    if (fn) {
      lastFilenameUsed.set(sessionId, fn);
    } else if (lastFilenameUsed.has(sessionId)) {
      args.filename = lastFilenameUsed.get(sessionId);
      console.log(`[v2] AUTO-FIX: Injected missing filename "${args.filename}" for ${name}`);
    }
  }

  const policyDenial = checkToolDenied(name, sessionId);
  if (policyDenial) {
    console.log(`[v2] TOOL BLOCKED: ${name} (${policyDenial})`);
    return { name, args, result: policyDenial, error: true };
  }

  try {
    switch (name) {
      case 'run_code': {
        // Real code execution: write the snippet to a temp file in the
        // workspace and run it, returning actual stdout/stderr. Never let the
        // model invent a "result" — the tool returns the verbatim output.
        const language = String(args.language || 'python').toLowerCase();
        const code = String(args.code || '');
        if (!code.trim()) return { name, args, result: 'No code provided.', error: true };
        const runPy = language === 'python';
        const runJs = language === 'javascript' || language === 'node';
        if (!runPy && !runJs) {
          return { name, args, result: `Unsupported language "${language}" (use python, javascript, or node).`, error: true };
        }
        const osMod = await import('os');
        const { execFile } = await import('child_process');
        const cryptoMod = await import('crypto');
        const ext = runPy ? '.py' : '.js';
        const tmpFile = path.join(
          osMod.tmpdir(),
          `smallclaw_run_${cryptoMod.randomBytes(4).toString('hex')}${ext}`,
        );
        fs.writeFileSync(tmpFile, code, 'utf-8');
        const pythonBin = (process.env.SMALLCLAW_PYTHON || '').trim() || 'python';
        const bin = runPy ? pythonBin : 'node';
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        try {
          await new Promise<void>((resolve, reject) => {
            execFile(
              bin,
              [tmpFile],
              { cwd: workspacePath, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
              (err, so, se) => {
                if (err) {
                  // timeout / non-zero exit are reported via stderr below
                  if ((err as any).killed) timedOut = true;
                }
                stdout = String(so || '');
                stderr = String(se || '');
                resolve();
              },
            );
          });
        } catch (e) {
          stderr += String((e as Error)?.message || e);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch { /* best effort */ }
        }
        const outLines: string[] = [];
        if (timedOut) outLines.push('[run_code] Timed out after 30s (result truncated).');
        if (stdout.trim()) outLines.push(stdout.trim());
        if (stderr.trim()) outLines.push(stderr.trim());
        const result = outLines.join('\n').slice(0, 3000) || '(no output)';
        return { name, args, result, error: !!stderr.trim() && !stdout.trim() };
      }

      case 'list_files': {
        // File query tool: summary header + entries. Supports pattern filter,
        // sort (size/name/mtime) and max_entries truncation so a 2B model gets
        // just what it needs — a giant unfiltered list makes it recite instead
        // of answer.
        const pattern = String(args.pattern || '').toLowerCase();
        const sortBy = args.sort_by === 'name' || args.sort_by === 'mtime' ? args.sort_by : 'size';
        const maxEntries = Number.isFinite(Number(args.max_entries))
          ? Math.max(1, Math.floor(Number(args.max_entries)))
          : 0;
        const entries = fs.readdirSync(workspacePath);
        const files: { name: string; size: number; sizeStr: string; mtime: number }[] = [];
        const dirs: string[] = [];
        for (const f of entries) {
          try {
            const st = fs.statSync(path.join(workspacePath, f));
            if (st.isDirectory()) {
              if (!pattern || f.toLowerCase().includes(pattern)) dirs.push(`${f}/`);
              continue;
            }
            if (pattern && !f.toLowerCase().includes(pattern)) continue;
            const b = st.size;
            const sizeStr = b >= 1024 * 1024
              ? `${(b / (1024 * 1024)).toFixed(1)} MB`
              : b >= 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`;
            files.push({ name: f, size: b, sizeStr, mtime: st.mtimeMs });
          } catch { /* skip unreadable */ }
        }
        if (sortBy === 'name') files.sort((a, b) => a.name.localeCompare(b.name));
        else if (sortBy === 'mtime') files.sort((a, b) => b.mtime - a.mtime);
        else files.sort((a, b) => b.size - a.size);

        const totalBytes = files.reduce((s, f) => s + f.size, 0);
        const totalStr = totalBytes >= 1024 * 1024
          ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
          : totalBytes >= 1024 ? `${(totalBytes / 1024).toFixed(1)} KB` : `${totalBytes} B`;
        const newest = files.length
          ? new Date(Math.max(...files.map(f => f.mtime))).toISOString().slice(5, 16).replace('T', ' ')
          : '—';
        const header = `[${files.length} files, total ${totalStr}, updated ${newest}]`;

        let labels = sortBy === 'mtime'
          ? files.map(f => {
              const mt = new Date(f.mtime).toISOString().slice(5, 16).replace('T', ' ');
              return `${f.name} (${f.sizeStr}, ${mt})`;
            })
          : files.map(f => `${f.name} (${f.sizeStr})`);
        if (maxEntries > 0) labels = labels.slice(0, maxEntries);

        return { name, args, result: JSON.stringify([header, ...labels, ...dirs]), error: false };
      }

      case 'grep_content': {
        const { getToolRegistry } = await import('../tools/registry.js');
        const res = await getToolRegistry().execute('grep_content', args);
        return {
          name,
          args,
          result: res.success
            ? (res.stdout || '(no output)')
            : (res.error || 'grep_content failed'),
          error: !res.success,
        };
      }

      case 'read_file': {
        const filename = args.filename || args.name;
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        if (!fs.existsSync(filePath)) return { name, args, result: `File "${filename}" not found`, error: true };
        if (isOfficeReadFile(filePath)) {
          const outcome = await executeOfficeTool('doc_read', { filename: filePath }, workspacePath, sessionId, resolveToolFilePath);
          return { name, args, result: outcome.result, error: outcome.error };
        }
        const content = fs.readFileSync(filePath, 'utf-8');
        const numbered = content.split('\n').map((line, i) => `${i + 1}: ${line}`).join('\n');
        return { name, args, result: `${filename} (${content.split('\n').length} lines):\n${numbered}`, error: false };
      }

      case 'create_file': {
        const filename = args.filename || args.name;
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        if (isOfficeWriteFile(filePath)) {
          return {
            name,
            args,
            result: `"${filename}" is a binary Office document and cannot be written as plain text (it would be corrupted). Use doc_write to edit it (mode:"preview" first), or doc_convert to create it from another format.`,
            error: true,
          };
        }
        if (fs.existsSync(filePath)) return { name, args, result: `"${filename}" already exists. If you meant to EDIT this file, use replace_lines or insert_after. If you meant to CREATE A NEW FILE (e.g. a report based on it), choose a different filename (e.g. "report.html") — do NOT reuse the source filename.`, error: true };
        const content = typeof args.content === 'string' ? args.content : '';
        if (!content.trim()) return { name, args, result: 'Missing required parameter "content". Pass the full file content as a string, e.g. {"filename": "report.html", "content": "<html>...</html>"}.', error: true };
        fs.writeFileSync(filePath, content, 'utf-8');
        // Completeness check: HTML files must end with </html>
        const lower = filename.toLowerCase();
        if ((lower.endsWith('.html') || lower.endsWith('.htm')) && !content.trimEnd().endsWith('</html>')) {
          return { name, args, result: `${filename} created but appears INCOMPLETE: missing closing </html> tag (file has ${content.split('\n').length} lines, ends with: ...${content.slice(-80).replace(/\n/g,' ')}. Use insert_after to append the remaining sections and closing tags, then read_file to verify.`, error: false };
        }
        return { name, args, result: `${filename} created`, error: false };
      }

      case 'replace_lines': {
        const filename = args.filename || args.name;
        const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const endLine = Math.max(startLine, Math.floor(Number(args.end_line) || startLine));
        const newContent = args.new_content || '';
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        const officeBlocked = rejectOfficeTextEdit(filePath, String(filename || ''));
        if (officeBlocked) return { name, args, result: officeBlocked, error: true };
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        if (startLine > lines.length) return { name, args, result: `Line ${startLine} past end (${lines.length} lines)`, error: true };
        const end = Math.min(endLine, lines.length);
        lines.splice(startLine - 1, end - startLine + 1, ...newContent.split('\n'));
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: replaced lines ${startLine}-${end} (now ${lines.length} lines)`, error: false };
      }

      case 'insert_after': {
        const filename = args.filename || args.name;
        const afterLine = Math.max(0, Math.floor(Number(args.after_line) || 0));
        const content = String(args.content || '').replace(/\\n/g, '\n');
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        const officeBlockedInsert = rejectOfficeTextEdit(filePath, String(filename || ''));
        if (officeBlockedInsert) return { name, args, result: officeBlockedInsert, error: true };
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const insertAt = Math.min(afterLine, lines.length);
        lines.splice(insertAt, 0, ...content.split('\n'));
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: inserted after line ${afterLine} (now ${lines.length} lines)`, error: false };
      }

      case 'delete_lines': {
        const filename = args.filename || args.name;
        const startLine = Math.max(1, Math.floor(Number(args.start_line) || 1));
        const endLine = Math.max(startLine, Math.floor(Number(args.end_line) || startLine));
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        const officeBlockedDelete = rejectOfficeTextEdit(filePath, String(filename || ''));
        if (officeBlockedDelete) return { name, args, result: officeBlockedDelete, error: true };
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
        const end = Math.min(endLine, lines.length);
        lines.splice(startLine - 1, end - startLine + 1);
        fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
        return { name, args, result: `${filename}: deleted lines ${startLine}-${end} (now ${lines.length} lines)`, error: false };
      }

      case 'find_replace': {
        const filename = args.filename || args.name;
        const find = args.find || '';
        const replace = args.replace ?? '';
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        const officeBlockedReplace = rejectOfficeTextEdit(filePath, String(filename || ''));
        if (officeBlockedReplace) return { name, args, result: officeBlockedReplace, error: true };
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(find)) return { name, args, result: `Text not found. Use read_file to check exact content.`, error: true };
        fs.writeFileSync(filePath, content.replace(find, replace), 'utf-8');
        return { name, args, result: `${filename} updated`, error: false };
      }

      case 'delete_file': {
        const filename = args.filename || args.name;
        const guardedPath = resolveToolFilePath(workspacePath, filename);
        if (!guardedPath.ok) return { name, args, result: guardedPath.error, error: true };
        const filePath = guardedPath.path;
        if (!fs.existsSync(filePath)) return { name, args, result: `"${filename}" not found`, error: true };
        fs.unlinkSync(filePath);
        return { name, args, result: `${filename} deleted`, error: false };
      }

      case 'doc_inspect':
      case 'doc_read':
      case 'doc_write':
      case 'doc_chart':
      case 'doc_convert':
      case 'doc_ocr':
      case 'doc_parse_lab': {
        const outcome = await executeOfficeTool(name, args, workspacePath, sessionId, resolveToolFilePath);
        recordArtifact(sessionId, name, outcome);
        return { name, args, result: outcome.result, error: outcome.error };
      }

      case 'knowledge_add':
      case 'knowledge_search':
      case 'knowledge_get':
      case 'knowledge_list':
      case 'knowledge_status':
      case 'knowledge_remove': {
        const kbDir = path.join(__dirname, '..', '..', 'knowledge');
        if (name === 'knowledge_add') {
          const raw = String(args?.path || args?.filename || '').trim();
          const resolved = raw ? resolveToolFilePath(workspacePath, raw) : null;
          if (resolved && !resolved.ok) {
            return { name, args, result: '', error: true };
          }
          args = { ...args, path: resolved ? resolved.path : raw };
        }
        const outcome = await executeKnowledgeTool(name, args, kbDir);
        const kbResult: ToolResult = {
          name,
          args,
          result: outcome.ok ? JSON.stringify(outcome, null, 1) : (outcome.error || 'knowledge tool failed'),
          error: !!outcome.error,
        };
        recordArtifact(sessionId, name, kbResult);
        return kbResult;
      }

      case 'image_render':
      case 'image_generate': {
        const outcome = await executeImageTool(name, args, workspacePath, sessionId, resolveToolFilePath);
        recordArtifact(sessionId, name, outcome);
        return { name, args, result: outcome.result, error: outcome.error };
      }

      case 'file_batch': {
        const outcome = await executeFileBatchTool(args, workspacePath, sessionId, resolveToolFilePath);
        recordArtifact(sessionId, name, outcome);
        return { name, args, result: outcome.result, error: outcome.error };
      }

      case 'plan_status': {
        const state = getPlanState(sessionId);
        const pending = getPendingPlan(sessionId);
        return {
          name,
          args,
          result: JSON.stringify({ ...state, pending }, null, 2),
          error: false,
        };
      }

      case 'plan_submit': {
        const summary = String(args?.summary || '').trim();
        const rawSteps = args?.steps;
        const steps = (Array.isArray(rawSteps) ? rawSteps : [])
          .map(s => String(s ?? '').trim())
          .filter(Boolean)
          .slice(0, 12);
        if (!summary) return { name, args, result: 'summary is required', error: true };
        if (!steps.length) return { name, args, result: 'steps must be a non-empty array of strings (2-10 steps).', error: true };

        if (!isPlanModeEnabledFor(sessionId)) {
          return {
            name,
            args,
            result: 'Plan mode is off for this session - no approval needed, continue with the task directly.',
            error: false,
          };
        }
        if (getPlanState(sessionId).approved) {
          return { name, args, result: 'Plan already approved for this session - execute the steps now.', error: false };
        }

        const outcome = await awaitPlanDecision(sessionId, summary, steps, emit);
        if (outcome.status === 'approved') {
          const note = outcome.note ? ` 用户备注：${outcome.note}` : '';
          return {
            name,
            args,
            result: `用户已批准该计划，可以执行。${note}\n按步骤逐步执行，先做最小的一步并检查结果。`,
            error: false,
          };
        }
        if (outcome.status === 'rejected') {
          const note = outcome.note ? `（${outcome.note}）` : '';
          return {
            name,
            args,
            result: `用户拒绝了该计划${note}。不要执行任何修改操作 - 把计划和拒绝原因说明给用户，等待新的指示。`,
            error: true,
          };
        }
        return {
          name,
          args,
          result: '计划等待超时，用户未响应。不要执行任何修改操作 - 把计划展示给用户并结束本轮。',
          error: true,
        };
      }

      case 'web_search': {
        const result = await webSearch(args.query || '');
        return { name, args, result, error: false };
      }

      case 'web_fetch': {
        const result = await webFetch(args.url || '');
        return { name, args, result, error: result.startsWith('Fetch failed') || result.startsWith('Fetch error') || result.startsWith('Fetch timed') };
      }

      case 'run_command': {
        const rawCmd = (args.command || '').trim();
        const { execCmd, blocked, targetFile } = resolveRunCommand(rawCmd);

        if (blocked) {
          return { name, args, result: `Blocked: "${rawCmd.toLowerCase()}" contains unsafe pattern "${blocked}"`, error: true };
        }

        if (!execCmd) {
          const fix = suggestRunCommandFix(rawCmd);
          const lines = [
            `Command "${rawCmd}" not recognized.`,
            'run_command is NOT a shell - it only launches GUI apps for the user to see.',
            'It cannot run pipelines, globs, redirects, switches, or arbitrary binaries.',
            '',
            'Supported forms:',
            `  - bare app name: ${Object.keys(SAFE_COMMANDS).join(', ')}`,
            `  - app + file path: ${Array.from(ARG_SAFE_COMMANDS).map(a => `${a} <path>`).join(', ')}`,
            '  - open a local file with the default app: start <file> / open <file>',
            '  - open a URL: chrome <url>, or just a URL / bare domain',
          ];
          if (fix) lines.push('', fix);
          return {
            name,
            args,
            result: lines.join('\n'),
            error: true,
          };
        }

        // Verify the target file exists BEFORE launching the GUI. A bad path
        // (typo, wrong drive, wrong join) must never reach Word/Excel as a
        // popup error - return a helpful error the agent can self-correct from.
        // Remember the workspace root: relative paths must resolve against it
        // when the command actually runs (exec cwd), not just during the
        // existence check. Otherwise `start "" "report.xlsx"` silently fails
        // when the gateway's own cwd is not the workspace.
        const wsRoot = getConfig().getWorkspacePath();

        if (targetFile) {
          // Path-escape guard: relative targets must stay inside the workspace.
          if (!path.isAbsolute(targetFile)) {
            const resolved = path.resolve(wsRoot, targetFile);
            const wsNorm = wsRoot.toLowerCase().replace(/[\\/]+$/, '');
            if (
              resolved.toLowerCase() !== wsNorm &&
              !resolved.toLowerCase().startsWith(wsNorm + path.sep)
            ) {
              return {
                name,
                args,
                result: `Cannot open "${targetFile}": path escapes the workspace (${wsRoot}). Use a path inside the workspace.`,
                error: true,
              };
            }
          }
          const absolute = path.isAbsolute(targetFile) ? targetFile : path.join(wsRoot, targetFile);
          if (!fs.existsSync(absolute)) {
            let docs: string[] = [];
            try {
              docs = fs.readdirSync(wsRoot)
                .filter(f => /\.(docx?|xlsx?|pptx?|pdf)$/i.test(f))
                .slice(0, 12);
            } catch { /* ignore listing errors */ }
            const hint = docs.length
              ? `Office files available in the workspace (${wsRoot}): ${docs.join(', ')}`
              : `The workspace (${wsRoot}) has no office documents.`;
            return {
              name,
              args,
              result: `Cannot open "${targetFile}": no such file. ${hint}`,
              error: true,
            };
          }
        }

        try {
          const { exec } = await import('child_process');
          exec(execCmd, { cwd: wsRoot });
          return { name, args, result: `Executed: ${execCmd}`, error: false };
        } catch (err: any) {
          return { name, args, result: `Failed: ${err.message}`, error: true };
        }
      }

      case 'shell_exec': {
        if (!agentShellEnabled()) {
          return { name, args, result: 'shell_exec is disabled. Enable it by setting tools.permissions.shell.expose_to_agent = true in the config.', error: true };
        }
        const command = String(args?.command || '').trim();
        if (!command) return { name, args, result: 'shell_exec requires a "command" argument.', error: true };
        try {
          const { executeShell } = await import('../tools/shell.js');
          const res = await executeShell({ command, cwd: args?.cwd });
          return {
            name,
            args,
            result: res.success ? (res.stdout || '(command succeeded, no output)') : (res.error || 'command failed'),
            error: !res.success,
          };
        } catch (err: any) {
          return { name, args, result: `shell_exec failed: ${err?.message || err}`, error: true };
        }
      }

      case 'start_task': {
        // This is handled specially in handleChat — shouldn't reach here
        return { name, args, result: 'Task system ready. Use the task endpoint.', error: false };
      }

      case 'task_control': {
        const out = await deps.handleTaskControlAction(sessionId, args);
        return {
          name,
          args,
          result: JSON.stringify(out, null, 2),
          error: out.success !== true,
        };
      }

      case 'schedule_job': {
        const action = normalizeScheduleJobAction(args.action);
        if (!action) {
          return {
            name,
            args,
            result: 'schedule_job requires a valid action: list, create, update, pause, resume, delete, run_now',
            error: true,
          };
        }

        const requiresConfirm = action === 'create' || action === 'update' || action === 'delete';
        if (requiresConfirm && !isConfirmed(args.confirm)) {
          return {
            name,
            args,
            result: JSON.stringify({
              success: false,
              needs_confirmation: true,
              action,
              message: `Action "${action}" requires explicit confirmation. Re-run with confirm=true after user says yes.`,
            }, null, 2),
            error: true,
          };
        }

        if (action === 'list') {
          const limitRaw = Number(args.limit);
          const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 50;
          const jobs = deps.cronScheduler.getJobs().map(summarizeCronJob).slice(0, limit);
          return {
            name,
            args,
            result: JSON.stringify({ success: true, count: jobs.length, jobs }, null, 2),
            error: false,
          };
        }

        const jobId = String(args.job_id || args.jobId || '').trim();

        if (action === 'create') {
          const instructionPrompt = String(args.instruction_prompt || args.prompt || '').trim();
          if (!instructionPrompt) {
            return { name, args, result: 'schedule_job(create) requires instruction_prompt', error: true };
          }

          const schedule = (args.schedule && typeof args.schedule === 'object') ? args.schedule : {};
          const rawKind = String(schedule.kind || args.kind || 'recurring').trim().toLowerCase();
          const kind: 'recurring' | 'one-shot' = (rawKind === 'one_shot' || rawKind === 'one-shot') ? 'one-shot' : 'recurring';
          const cron = String(schedule.cron || args.cron || '').trim();
          const runAtRaw = String(schedule.run_at || args.run_at || '').trim();
          const timezone = String(args.timezone || args.tz || '').trim() || undefined;
          const delivery = (args.delivery && typeof args.delivery === 'object') ? args.delivery : {};
          const channel = normalizeDeliveryChannel(delivery.channel || args.channel);
          const sessionTarget = String(delivery.session_target || args.session_target || 'isolated').toLowerCase() === 'main'
            ? 'main'
            : 'isolated';
          const modelOverride = String(args.model_override || args.model || '').trim() || undefined;
          const nameValue = String(args.name || '').trim() || `Scheduled task ${new Date().toLocaleString()}`;

          if (channel !== 'web') {
            return {
              name,
              args,
              result: `Delivery channel "${channel}" is not enabled for scheduler jobs yet. Use channel "web" for now.`,
              error: true,
            };
          }

          if (kind === 'one-shot') {
            if (!runAtRaw) return { name, args, result: 'schedule.kind=one_shot requires schedule.run_at (ISO datetime)', error: true };
            const parsed = new Date(runAtRaw);
            if (!Number.isFinite(parsed.getTime())) {
              return { name, args, result: `Invalid run_at value: "${runAtRaw}"`, error: true };
            }
          } else if (!cron) {
            return { name, args, result: 'schedule.kind=recurring requires schedule.cron', error: true };
          }

          const created = deps.cronScheduler.createJob({
            name: nameValue,
            prompt: instructionPrompt,
            type: kind,
            schedule: kind === 'recurring' ? cron : undefined,
            runAt: kind === 'one-shot' ? new Date(runAtRaw).toISOString() : undefined,
            tz: timezone,
            sessionTarget,
            model: modelOverride,
          } as any);

          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              action: 'create',
              job: summarizeCronJob(created),
              message: `Scheduled job "${created.name}" created.`,
            }, null, 2),
            error: false,
          };
        }

        if (!jobId) {
          return { name, args, result: `schedule_job(${action}) requires job_id`, error: true };
        }

        if (action === 'pause') {
          const updated = deps.cronScheduler.updateJob(jobId, { status: 'paused', enabled: false } as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return { name, args, result: JSON.stringify({ success: true, action: 'pause', job: summarizeCronJob(updated) }, null, 2), error: false };
        }

        if (action === 'resume') {
          const updated = deps.cronScheduler.updateJob(jobId, { status: 'scheduled', enabled: true } as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return { name, args, result: JSON.stringify({ success: true, action: 'resume', job: summarizeCronJob(updated) }, null, 2), error: false };
        }

        if (action === 'run_now') {
          const exists = deps.cronScheduler.getJobs().some(j => j.id === jobId);
          if (!exists) return { name, args, result: `Job not found: ${jobId}`, error: true };
          deps.cronScheduler.runJobNow(jobId, { respectActiveHours: false }).catch(err =>
            console.error(`[schedule_job] run_now failed for ${jobId}:`, err?.message || err)
          );
          return {
            name,
            args,
            result: JSON.stringify({ success: true, action: 'run_now', job_id: jobId, message: 'Job queued for immediate run.' }, null, 2),
            error: false,
          };
        }

        if (action === 'delete') {
          const ok = deps.cronScheduler.deleteJob(jobId);
          if (!ok) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return {
            name,
            args,
            result: JSON.stringify({ success: true, action: 'delete', job_id: jobId, message: 'Job deleted.' }, null, 2),
            error: false,
          };
        }

        if (action === 'update') {
          const schedule = (args.schedule && typeof args.schedule === 'object') ? args.schedule : {};
          const patch: Record<string, any> = {};

          if (args.name !== undefined) patch.name = String(args.name || '').trim();
          if (args.instruction_prompt !== undefined || args.prompt !== undefined) {
            patch.prompt = String(args.instruction_prompt || args.prompt || '').trim();
          }
          if (args.timezone !== undefined || args.tz !== undefined) {
            patch.tz = String(args.timezone || args.tz || '').trim();
          }
          if (args.model_override !== undefined || args.model !== undefined) {
            const mv = String(args.model_override || args.model || '').trim();
            patch.model = mv || undefined;
          }
          if (args.delivery !== undefined || args.channel !== undefined) {
            const delivery = (args.delivery && typeof args.delivery === 'object') ? args.delivery : {};
            const channel = normalizeDeliveryChannel(delivery.channel || args.channel);
            if (channel !== 'web') {
              return {
                name,
                args,
                result: `Delivery channel "${channel}" is not enabled for scheduler jobs yet. Use channel "web" for now.`,
                error: true,
              };
            }
            const sessionTarget = String(delivery.session_target || args.session_target || '').toLowerCase();
            if (sessionTarget === 'main' || sessionTarget === 'isolated') patch.sessionTarget = sessionTarget;
          }

          const rawKind = String(schedule.kind || args.kind || '').trim().toLowerCase();
          if (rawKind === 'one_shot' || rawKind === 'one-shot') patch.type = 'one-shot';
          if (rawKind === 'recurring') patch.type = 'recurring';
          if (schedule.cron !== undefined || args.cron !== undefined) patch.schedule = String(schedule.cron || args.cron || '').trim();
          if (schedule.run_at !== undefined || args.run_at !== undefined) patch.runAt = String(schedule.run_at || args.run_at || '').trim();

          if (Object.keys(patch).length === 0) {
            return { name, args, result: 'No update fields provided for schedule_job(update).', error: true };
          }

          if (patch.type === 'one-shot' && !patch.runAt) {
            return { name, args, result: 'Updating to one_shot requires schedule.run_at', error: true };
          }
          if (patch.type === 'recurring' && patch.schedule === '') {
            return { name, args, result: 'Updating to recurring requires schedule.cron', error: true };
          }
          if (patch.runAt) {
            const parsed = new Date(String(patch.runAt));
            if (!Number.isFinite(parsed.getTime())) {
              return { name, args, result: `Invalid run_at value: "${patch.runAt}"`, error: true };
            }
            patch.runAt = parsed.toISOString();
          }

          const updated = deps.cronScheduler.updateJob(jobId, patch as any);
          if (!updated) return { name, args, result: `Job not found: ${jobId}`, error: true };
          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              action: 'update',
              job: summarizeCronJob(updated),
              message: `Scheduled job "${updated.name}" updated.`,
            }, null, 2),
            error: false,
          };
        }

        return { name, args, result: `Unsupported schedule_job action: ${action}`, error: true };
      }

      case 'spawn_subagent': {
        // Spawn a specialized sub-agent with restricted tool set
        // This is used by primary agents to delegate work to secondary specialists
        try {
          const subagentId = String(args.subagent_id || '').trim();
          const taskPrompt = String(args.task_prompt || '').trim();
          const contextData = args.context_data && typeof args.context_data === 'object' ? args.context_data : undefined;
          const createIfMissing = args.create_if_missing && typeof args.create_if_missing === 'object' ? args.create_if_missing : undefined;

          if (!subagentId) {
            return { name, args, result: 'spawn_subagent requires subagent_id', error: true };
          }
          if (!taskPrompt) {
            return { name, args, result: 'spawn_subagent requires task_prompt', error: true };
          }

          // Get workspace path from config
          const workspacePath = getConfig().getConfig().workspace?.path || process.cwd();

          // Create SubagentManager with broadcast capability
          const subagentMgr = new SubagentManager(workspacePath, broadcastWS);

          // Call the subagent (creates if missing)
          const result = await subagentMgr.callSubagent(
            {
              subagent_id: subagentId,
              task_prompt: taskPrompt,
              context_data: contextData,
              create_if_missing: createIfMissing,
            },
            sessionId // parent task ID (session context)
          );

          return {
            name,
            args,
            result: JSON.stringify(result, null, 2),
            error: false,
          };
        } catch (err: any) {
          return { name, args, result: `spawn_subagent error: ${err.message}`, error: true };
        }
      }

      case 'parse_schedule_pattern': {
        const text = String(args.text || '').trim();
        if (!text) {
          return { name, args, result: 'parse_schedule_pattern requires text parameter', error: true };
        }
        
        try {
          let cron = '';
          let preview = '';
          const t = text.toLowerCase().trim();
          
          // Helper: extract time from text and handle AM/PM
          function extractTime(text: string): { hour: number; minute: number } | null {
            const timeMatch = text.match(/(\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
            if (!timeMatch) return null;
            
            let hour = parseInt(timeMatch[1], 10);
            const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
            const period = timeMatch[3]?.toLowerCase();
            
            if (period === 'pm' && hour !== 12) {
              hour += 12;
            } else if (period === 'am' && hour === 12) {
              hour = 0;
            }
            
            if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
            
            return { hour, minute };
          }
          
          if (t.includes('daily') || t.includes('every day')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              const hourStr = String(timeInfo.hour).padStart(2, '0');
              const minStr = String(timeInfo.minute).padStart(2, '0');
              cron = `${timeInfo.minute} ${timeInfo.hour} * * *`;
              preview = `Daily at ${hourStr}:${minStr}`;
            } else {
              cron = '0 9 * * *';
              preview = 'Daily at 09:00';
            }
          } else if (t.includes('weekly')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              cron = `${timeInfo.minute} ${timeInfo.hour} * * 1`;
              preview = `Weekly on Monday at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
            } else {
              cron = '0 9 * * 1';
              preview = 'Weekly on Monday at 09:00';
            }
          } else if (t.includes('monday') || t.includes('tuesday') || t.includes('wednesday') || t.includes('thursday') || t.includes('friday')) {
            const timeInfo = extractTime(t);
            if (timeInfo) {
              cron = `${timeInfo.minute} ${timeInfo.hour} * * 1-5`;
              preview = `Weekdays at ${String(timeInfo.hour).padStart(2, '0')}:${String(timeInfo.minute).padStart(2, '0')}`;
            } else {
              cron = '0 9 * * 1-5';
              preview = 'Weekdays at 09:00';
            }
          } else if (/^\d{1,2} \d{1,2} \d|\d \d \*/.test(t)) {
            cron = t;
            preview = 'Custom cron pattern';
          } else {
            return {
              name,
              args,
              result: JSON.stringify({
                success: false,
                error: 'Could not parse pattern. Try: "daily at 3:13pm", "daily at 15:13", "weekly", or cron like "0 9 * * *"',
              }, null, 2),
              error: true,
            };
          }
          
          return {
            name,
            args,
            result: JSON.stringify({
              success: true,
              cron,
              preview,
              timezone: args.timezone || 'UTC',
            }, null, 2),
            error: false,
          };
        } catch (err: any) {
          return { name, args, result: `parse_schedule_pattern error: ${err.message}`, error: true };
        }
      }

      // Browser automation tools
      case 'browser_open': {
        const result = await browserOpen(sessionId, args.url || '');
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_snapshot': {
        const result = await browserSnapshot(sessionId);
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_click': {
        const result = await browserClick(sessionId, Number(args.ref || 0));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_fill': {
        const result = await browserFill(sessionId, Number(args.ref || 0), String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_press_key': {
        const result = await browserPressKey(sessionId, String(args.key || 'Enter'));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_wait': {
        const result = await browserWait(sessionId, Number(args.ms || 2000));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_scroll': {
        const dir = String(args.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
        const result = await browserScroll(sessionId, dir, Number(args.multiplier || 1));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'browser_close': {
        const result = await browserClose(sessionId);
        return { name, args, result, error: false };
      }

      // Desktop automation tools
      case 'desktop_screenshot': {
        const result = await desktopScreenshot(sessionId);
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_find_window': {
        const result = await desktopFindWindow(String(args.name || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_focus_window': {
        const result = await desktopFocusWindow(String(args.name || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_click': {
        const result = await desktopClick(
          Number(args.x),
          Number(args.y),
          String(args.button || 'left').toLowerCase() === 'right' ? 'right' : 'left',
          args.double_click === true,
        );
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_drag': {
        const result = await desktopDrag(
          Number(args.from_x),
          Number(args.from_y),
          Number(args.to_x),
          Number(args.to_y),
          Number(args.steps || 20),
        );
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_wait': {
        const result = await desktopWait(Number(args.ms || 500));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_type': {
        const result = await desktopType(String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_press_key': {
        const result = await desktopPressKey(String(args.key || 'Enter'));
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_get_clipboard': {
        const result = await desktopGetClipboard();
        return { name, args, result, error: result.startsWith('ERROR') };
      }
      case 'desktop_set_clipboard': {
        const result = await desktopSetClipboard(String(args.text || ''));
        return { name, args, result, error: result.startsWith('ERROR') };
      }

      case 'memory_browse': {
        const mbFile = String(args.file || 'user').toLowerCase().trim();
        const mbFilename = mbFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mbPath = path.join(workspacePath, mbFilename);
        if (!fs.existsSync(mbPath)) {
          return { name, args, result: `${mbFilename} not found. Create it first.`, error: true };
        }
        const mbContent = fs.readFileSync(mbPath, 'utf-8');
        const mbMatches = mbContent.match(/^## (.+)/gm) || [];
        const mbCategories = mbMatches.map((m: string) => m.replace(/^## /, '').trim());
        if (mbCategories.length === 0) {
          return { name, args, result: `${mbFilename} has no categories yet. Use memory_write to create the first one.`, error: false };
        }
        return { name, args, result: `${mbFilename} categories:\n${mbCategories.map((c: string) => `- ${c}`).join('\n')}\n\nUse memory_write(file="${mbFile}", category="<name>", content="...") to add a fact.`, error: false };
      }

      case 'memory_write': {
        const mwFile = String(args.file || 'user').toLowerCase().trim();
        const mwCategory = String(args.category || '').trim().toLowerCase().replace(/\s+/g, '_');
        const mwContent = String(args.content || '').trim();
        if (!mwCategory) return { name, args, result: 'memory_write: category is required', error: true };
        if (!mwContent) return { name, args, result: 'memory_write: content is required', error: true };
        const mwFilename = mwFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mwPath = path.join(workspacePath, mwFilename);
        if (!fs.existsSync(mwPath)) return { name, args, result: `${mwFilename} not found`, error: true };
        let mwFileContent = fs.readFileSync(mwPath, 'utf-8');
        const mwDate = new Date().toISOString().split('T')[0];
        const mwEntry = `- ${mwContent} [${mwDate}]`;
        const mwSectionHeader = `## ${mwCategory}`;
        const mwSectionIdx = mwFileContent.indexOf(`\n${mwSectionHeader}`);
        if (mwSectionIdx !== -1) {
          // Section exists — find end of section, insert before next ## or EOF
          const afterHeader = mwSectionIdx + mwSectionHeader.length + 1;
          const nextSection = mwFileContent.indexOf('\n## ', afterHeader);
          const insertAt = nextSection !== -1 ? nextSection : mwFileContent.length;
          mwFileContent = mwFileContent.slice(0, insertAt) + '\n' + mwEntry + mwFileContent.slice(insertAt);
        } else {
          // New category — append before closing --- or at end
          const closingComment = mwFileContent.lastIndexOf('\n---');
          const insertAt = closingComment !== -1 ? closingComment : mwFileContent.length;
          mwFileContent = mwFileContent.slice(0, insertAt) + '\n\n' + mwSectionHeader + '\n' + mwEntry + mwFileContent.slice(insertAt);
        }
        fs.writeFileSync(mwPath, mwFileContent, 'utf-8');
        return { name, args, result: `Written to ${mwFilename} [${mwCategory}]: ${mwContent}`, error: false };
      }

      case 'memory_read': {
        const mrFile = String(args.file || 'user').toLowerCase().trim();
        const mrFilename = mrFile === 'soul' ? 'SOUL.md' : 'USER.md';
        const mrPath = path.join(workspacePath, mrFilename);
        if (!fs.existsSync(mrPath)) return { name, args, result: `${mrFilename} not found`, error: true };
        const mrContent = fs.readFileSync(mrPath, 'utf-8');
        return { name, args, result: mrContent, error: false };
      }

      case 'write_note': {
        const noteContent = String(args.content || '').trim();
        if (!noteContent) {
          return { name, args, result: 'write_note: empty content', error: true };
        }
        const noteTag = String(args.tag || args.step || 'general').trim();
        const noteTaskId = args.task_id ? String(args.task_id) : null;

        // Always write to intraday notes file (works in all sessions)
        try {
          const noteDate = new Date().toISOString().split('T')[0];
          const memDir = path.join(workspacePath, 'memory');
          if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
          const intradayFile = path.join(memDir, `${noteDate}-intraday-notes.md`);
          const timestamp = new Date().toISOString();
          let entry = `\n### [${noteTag.toUpperCase()}] ${timestamp}\n${noteContent}`;
          if (noteTaskId) entry += `\n_Related task: ${noteTaskId}_`;
          fs.appendFileSync(intradayFile, entry + '\n');
        } catch (err: any) {
          return { name, args, result: `write_note: failed to write intraday note: ${err.message}`, error: true };
        }

        // Also append to task journal if in a task session
        const isTaskSession = String(sessionId || '').startsWith('task_');
        if (isTaskSession) {
          try {
            const taskId = sessionId.replace(/^task_/, '');
            const { appendJournal } = require('./task-store');
            appendJournal(taskId, {
              type: 'write_note',
              content: `[${noteTag}] ${noteContent.slice(0, 300)}`,
              detail: noteContent.slice(0, 2000),
            });
          } catch {}
        }

        return { name, args, result: `Note saved [${noteTag}] (${noteContent.length} chars) → intraday-notes`, error: false };
      }

      // ── Agent Builder Integration ────────────────────────────────────────────
      case 'architect_workflow':
      case 'verify_workflow_credentials':
      case 'test_workflow':
      case 'deploy_workflow':
      case 'get_workflow_status':
      case 'search_workflow_templates':
      case 'execute_workflow_template':
      case 'create_node_subagent': {
        const result = await executeAgentBuilderTool(name, args);
        return { name, args, result, error: false };
      }

      default: {
        const mcpEntry = collectMcpToolEntries().find(entry => entry.exposed === name);
        if (mcpEntry) {
          try {
            const mcpResult = await getMCPManager().callTool(
              mcpEntry.serverId,
              mcpEntry.toolName,
              (args || {}) as Record<string, any>,
            );
            const text = (mcpResult.content || [])
              .map(part => (typeof part?.text === 'string' ? part.text : JSON.stringify(part)))
              .join('\n');
            const clipped = text.length > 40000 ? `${text.slice(0, 40000)}\n...[truncated]` : text;
            return { name, args, result: clipped || '(empty result)', error: mcpResult.isError === true };
          } catch (err: any) {
            return { name, args, result: `MCP error: ${err?.message || err}`, error: true };
          }
        }
        return { name, args, result: `Unknown tool: ${name}`, error: true };
      }
    }
  } catch (err: any) {
    return { name, args, result: `Error: ${err.message}`, error: true };
  }
}