import fs from 'fs/promises';
import path from 'path';
import fsSync from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import iconv from 'iconv-lite';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';

const execFileAsync = promisify(execFile);
const PATCH_OUTPUT_MAX_CHARS = 8000;

// Helper function to check if path is allowed
function resolveWorkspacePath(targetPath: string): string {
  const config = getConfig().getConfig();
  const workspace = config.workspace.path;
  if (path.isAbsolute(targetPath)) return targetPath;
  return path.join(workspace, targetPath);
}

function normalizePathForCompare(p: string): string {
  const resolved = path.resolve(String(p || ''));
  if (process.platform === 'win32') return resolved.toLowerCase();
  return resolved;
}

function isPathInside(basePath: string, targetPath: string): boolean {
  const base = normalizePathForCompare(basePath);
  const target = normalizePathForCompare(targetPath);
  if (!base || !target) return false;
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function isPathAllowed(targetPath: string): { allowed: boolean; reason?: string } {
  const config = getConfig().getConfig();
  const permissions = config.tools.permissions.files;
  const absPath = path.resolve(String(targetPath || ''));

  // Check blocked paths
  for (const blocked of permissions.blocked_paths) {
    if (isPathInside(blocked, absPath)) {
      return {
        allowed: false,
        reason: `Path is in blocked directory: ${blocked}`
      };
    }
  }

  // Check allowed paths
  const isInAllowedPath = permissions.allowed_paths.some(allowed => 
    isPathInside(allowed, absPath)
  );

  if (!isInAllowedPath) {
    return {
      allowed: false,
      reason: `Path is not in any allowed directory. Allowed: ${permissions.allowed_paths.join(', ')}`
    };
  }

  return { allowed: true };
}

function truncateOutput(text: string): string {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.length <= PATCH_OUTPUT_MAX_CHARS) return t;
  return `${t.slice(0, PATCH_OUTPUT_MAX_CHARS)} ...[truncated]`;
}

function countSkippedPatches(text: string): number {
  const src = String(text || '')
    .replace(/\x1b\[[0-9;]*m/g, '');
  if (!src) return 0;
  const matches = src.match(/Skipped patch\b/gi);
  return matches ? matches.length : 0;
}

function parsePatchPathToken(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('"')) {
    const m = trimmed.match(/^"([^"]+)"/);
    return m?.[1] || '';
  }
  return trimmed.split(/\s+/)[0] || '';
}

function normalizePatchPath(rawPath: string): string {
  let p = String(rawPath || '').trim();
  if (!p || p === '/dev/null') return '';
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function extractPatchTargetPaths(patchText: string): string[] {
  const paths = new Set<string>();
  const lines = String(patchText || '').split('\n');

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git\s+(?:"([^"]+)"|(\S+))\s+(?:"([^"]+)"|(\S+))/);
      const left = normalizePatchPath(m?.[1] || m?.[2] || '');
      const right = normalizePatchPath(m?.[3] || m?.[4] || '');
      if (left) paths.add(left);
      if (right) paths.add(right);
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      const token = parsePatchPathToken(line.slice(4));
      const normalized = normalizePatchPath(token);
      if (normalized) paths.add(normalized);
      continue;
    }

    if (line.startsWith('rename from ')) {
      const fromPath = normalizePatchPath(line.slice('rename from '.length));
      if (fromPath) paths.add(fromPath);
      continue;
    }

    if (line.startsWith('rename to ')) {
      const toPath = normalizePatchPath(line.slice('rename to '.length));
      if (toPath) paths.add(toPath);
    }
  }

  return Array.from(paths);
}

function validatePatchPaths(paths: string[]): { ok: true; relativePaths: string[] } | { ok: false; error: string } {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, error: 'No target paths found in patch. Include standard unified diff headers (---/+++).' };
  }

  const unique = Array.from(new Set(paths.map(p => String(p || '').trim()).filter(Boolean)));
  for (const relPath of unique) {
    if (path.isAbsolute(relPath)) {
      return { ok: false, error: `Patch path must be relative: ${relPath}` };
    }
    const absPath = resolveWorkspacePath(relPath);
    const pathCheck = isPathAllowed(absPath);
    if (!pathCheck.allowed) {
      return { ok: false, error: `Patch path not allowed (${relPath}): ${pathCheck.reason}` };
    }
  }

  return { ok: true, relativePaths: unique };
}

async function runGitApply(workspacePath: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out = await execFileAsync('git', args, {
    cwd: workspacePath,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  } as any);
  return {
    stdout: String((out as any)?.stdout || ''),
    stderr: String((out as any)?.stderr || ''),
  };
}

// READ TOOL
export interface ReadToolArgs {
  path: string;
  start_line?: number;
  num_lines?: number;
  encoding?: string; // 'utf-8' | 'auto' | 'gbk' | 'gb2312' | 'gb18030' | 'latin1' | 'ascii' | 'base64' | 'hex'
}

type RetrievalMode = 'fast' | 'standard' | 'deep';

function getLocalConfigFilePath(): string {
  const projectCfg = path.join(__dirname, '..', '..', '.smallclaw', 'config.json');
  return fsSync.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.smallclaw', 'config.json');
}

function getRetrievalMode(): RetrievalMode {
  try {
    const p = getLocalConfigFilePath();
    if (!fsSync.existsSync(p)) return 'standard';
    const raw = JSON.parse(fsSync.readFileSync(p, 'utf-8'));
    const mode = String(raw?.agent_policy?.retrieval_mode || 'standard').toLowerCase();
    if (mode === 'fast' || mode === 'deep') return mode;
    return 'standard';
  } catch {
    return 'standard';
  }
}

function retrievalMaxLines(mode: RetrievalMode): number {
  if (mode === 'fast') return 120;
  if (mode === 'deep') return 480;
  return 240;
}

// 将 Buffer 按指定编码解码为文本；auto 模式检测 BOM 与二进制
function decodeBuffer(buf: Buffer, enc: string): { text?: string; binary?: boolean; error?: string } {
  const lower = String(enc || 'auto').toLowerCase();
  if (lower === 'auto') {
    if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
      return { text: buf.toString('utf-8', 3) };
    }
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
      return { text: buf.toString('utf16le', 2) };
    }
    if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      return { text: iconv.decode(buf.slice(2), 'utf-16be') };
    }
    // 二进制探测：前 8KB 出现 NUL 字节视为二进制
    const scan = Math.min(buf.length, 8192);
    for (let i = 0; i < scan; i++) {
      if (buf[i] === 0x00) return { binary: true };
    }
    return { text: buf.toString('utf-8') };
  }
  switch (lower) {
    case 'utf-8':
    case 'utf8':
      return { text: buf.toString('utf-8') };
    case 'latin1':
    case 'binary':
      return { text: buf.toString('latin1') };
    case 'ascii':
      return { text: buf.toString('ascii') };
    case 'base64':
      return { text: buf.toString('base64') };
    case 'hex':
      return { text: buf.toString('hex') };
    case 'gbk':
    case 'gb2312':
    case 'gb18030':
      try {
        return { text: iconv.decode(buf, lower) };
      } catch (e: any) {
        return { error: `decode ${lower} failed: ${e?.message || e}` };
      }
    default:
      return { error: `unsupported encoding: ${enc}` };
  }
}

export async function executeRead(args: ReadToolArgs): Promise<ToolResult> {
  try {
    const absPath = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(absPath);
    if (!pathCheck.allowed) {
      return {
        success: false,
        error: pathCheck.reason
      };
    }
    const buf = await fs.readFile(absPath);
    const encoded = String(args.encoding || 'auto');
    const decoded = decodeBuffer(buf, encoded);
    if (decoded.error) {
      return { success: false, error: decoded.error };
    }
    if (decoded.binary) {
      // 纯二进制（非文本）：返回元信息，不尝试按行输出
      const previewHex = buf.slice(0, 64).toString('hex').replace(/(.{2})/g, '$1 ').trim();
      return {
        success: true,
        data: {
          path: absPath,
          binary: true,
          size: buf.length,
          detected_encoding: encoded === 'auto' ? 'binary' : encoded,
          preview_hex: previewHex,
          note: '文件被识别为二进制（含 NUL 字节），read 仅返回元信息。如需图片/音视频元数据请用 view_media。',
        },
        stdout: `[二进制文件] size=${buf.length}B, preview_hex=${previewHex}`,
      };
    }
    const content = decoded.text ?? '';
    const allLines = content.split('\n');
    const mode = getRetrievalMode();
    const cap = retrievalMaxLines(mode);
    const startLine = Math.max(1, Number(args.start_line || 1) || 1);
    const requested = Math.max(1, Number(args.num_lines || cap) || cap);
    const windowSize = Math.min(requested, cap);
    const startIdx = Math.max(0, startLine - 1);
    const selected = allLines.slice(startIdx, startIdx + windowSize);
    // 行号前缀（`行号\t内容`）：模型可精确引用"第 N 行"，与 edit 工具联动
    const outContent = selected.map((l, i) => `${startLine + i}\t${l}`).join('\n');
    const endLine = startLine + selected.length - 1;
    const truncated = (allLines.length > selected.length) || startLine > 1 || requested > cap;
    return {
      success: true,
      data: {
        path: absPath,
        encoding: encoded === 'auto' ? 'utf-8(detected)' : encoded,
        content: outContent,
        size: outContent.length,
        lines: allLines.length,
        window: {
          retrieval_mode: mode,
          start_line: startLine,
          end_line: endLine,
          returned_lines: selected.length,
          max_lines_cap: cap,
          truncated,
        },
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to read file: ${error.message}`
    };
  }
}

// WRITE TOOL
export interface WriteToolArgs {
  path: string;
  content: string;
  backup?: boolean; // 写入前若已存在则先复制为 <path>.bak
}

async function backupIfRequested(absPath: string, doBackup: boolean): Promise<{ backupPath?: string; error?: string }> {
  if (!doBackup) return {};
  try {
    if (fsSync.existsSync(absPath)) {
      const bak = `${absPath}.bak`;
      await fs.copyFile(absPath, bak);
      return { backupPath: bak };
    }
    return {};
  } catch (err: any) {
    return { error: `backup failed: ${err?.message || err}` };
  }
}

export async function executeWrite(args: WriteToolArgs): Promise<ToolResult> {
  try {
    if (!args || typeof args.path !== 'string' || !args.path.trim()) {
      return {
        success: false,
        error: 'path is required'
      };
    }
    if (typeof (args as any).content !== 'string') {
      return {
        success: false,
        error: 'content must be a string'
      };
    }
    const absPath = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(absPath);
    if (!pathCheck.allowed) {
      return {
        success: false,
        error: pathCheck.reason
      };
    }
    const bak = await backupIfRequested(absPath, args.backup === true);
    if (bak.error) return { success: false, error: bak.error };
    // Ensure directory exists
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    // Write file
    await fs.writeFile(absPath, args.content, 'utf-8');
    return {
      success: true,
      data: {
        path: absPath,
        size: args.content.length,
        lines: args.content.split('\n').length,
        backup: bak.backupPath || null,
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to write file: ${error.message}`
    };
  }
}

// EDIT TOOL (find and replace)
export interface EditToolArgs {
  path: string;
  old_str: string;
  new_str: string;
  backup?: boolean; // 写入前若已存在则先复制为 <path>.bak
}

export async function executeEdit(args: EditToolArgs): Promise<ToolResult> {
  try {
    const absPath = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(absPath);
    if (!pathCheck.allowed) {
      return {
        success: false,
        error: pathCheck.reason
      };
    }
    // Read current content
    const content = await fs.readFile(absPath, 'utf-8');
    // Check if old_str exists
    if (!content.includes(args.old_str)) {
      return {
        success: false,
        error: `String not found in file: "${args.old_str.slice(0, 50)}..."`
      };
    }
    // Count occurrences
    const occurrences = (content.match(new RegExp(args.old_str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (occurrences > 1) {
      return {
        success: false,
        error: `String appears ${occurrences} times in file. For safety, it must appear exactly once. Please be more specific.`
      };
    }
    // Perform replacement
    const newContent = content.replace(args.old_str, args.new_str);
    const bak = await backupIfRequested(absPath, args.backup === true);
    if (bak.error) return { success: false, error: bak.error };
    // Write back
    await fs.writeFile(absPath, newContent, 'utf-8');
    return {
      success: true,
      data: {
        path: absPath,
        replacements: 1,
        old_length: content.length,
        new_length: newContent.length,
        diff: newContent.length - content.length,
        backup: bak.backupPath || null,
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to edit file: ${error.message}`
    };
  }
}

// LIST DIRECTORY TOOL
export interface ListToolArgs {
  path: string;
}

export async function executeList(args: ListToolArgs): Promise<ToolResult> {
  try {
    const absPath = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(absPath);
    if (!pathCheck.allowed) {
      return {
        success: false,
        error: pathCheck.reason
      };
    }

    const entries = await fs.readdir(absPath, { withFileTypes: true });
    
    const files = entries
      .filter(e => e.isFile())
      .map(e => e.name);
    
    const directories = entries
      .filter(e => e.isDirectory())
      .map(e => e.name);

    return {
      success: true,
      data: {
        path: absPath,
        files,
        directories,
        total: entries.length
      }
    };
  } catch (error: any) {
    return {
      success: false,
      error: `Failed to list directory: ${error.message}`
    };
  }
}

// Tool exports
export const readTool = {
  name: 'read',
  description: 'Read file contents (snippet-windowed by retrieval mode caps). Supports encoding: utf-8 (default), auto (detect BOM + binary), gbk/gb2312/gb18030, latin1, ascii, base64, hex.',
  execute: executeRead,
  schema: {
    path: 'string (required) - Path to the file to read',
    start_line: 'number (optional) - 1-based starting line (default 1)',
    num_lines: 'number (optional) - number of lines to return (capped by retrieval mode)',
    encoding: 'string (optional) - utf-8 | auto | gbk | gb2312 | gb18030 | latin1 | ascii | base64 | hex (default auto)',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
      start_line: { type: 'number', description: '1-based starting line (default 1)' },
      num_lines: { type: 'number', description: 'number of lines to return (capped by retrieval mode)' },
      encoding: { type: 'string', description: 'utf-8 | auto | gbk | gb2312 | gb18030 | latin1 | ascii | base64 | hex (default auto)' },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

export const writeTool = {
  name: 'write',
  description: 'Create or overwrite a file. Set backup:true to save a <path>.bak before overwriting.',
  execute: executeWrite,
  schema: {
    path: 'string (required) - Path to the file',
    content: 'string (required) - File contents',
    backup: 'boolean (optional) - if true and file exists, copy to <path>.bak before writing'
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      content: { type: 'string', description: 'File contents' },
      backup: { type: 'boolean', description: 'if true and file exists, copy to <path>.bak before writing' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
};

export const editTool = {
  name: 'edit',
  description: 'Edit a file by replacing text (string must appear exactly once). Set backup:true to save a <path>.bak before writing.',
  execute: executeEdit,
  schema: {
    path: 'string (required) - Path to the file',
    old_str: 'string (required) - Text to find (must appear exactly once)',
    new_str: 'string (required) - Replacement text',
    backup: 'boolean (optional) - if true and file exists, copy to <path>.bak before writing'
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file' },
      old_str: { type: 'string', description: 'Text to find (must appear exactly once)' },
      new_str: { type: 'string', description: 'Replacement text' },
      backup: { type: 'boolean', description: 'if true and file exists, copy to <path>.bak before writing' },
    },
    required: ['path', 'old_str', 'new_str'],
    additionalProperties: false,
  },
};

export const listTool = {
  name: 'list',
  description: 'List files and directories',
  execute: executeList,
  schema: {
    path: 'string (required) - Path to directory'
  }
};

// ── DELETE ────────────────────────────────────────────────────────────────────
import { rmSync, existsSync } from 'fs';

async function executeDelete(args: { path: string; recursive?: boolean }): Promise<ToolResult> {
  if (!args.path?.trim()) return { success: false, error: 'path is required' };
  const absPath = resolveWorkspacePath(args.path);
  if (!existsSync(absPath)) return { success: false, error: `Path does not exist: ${absPath}` };
  try {
    rmSync(absPath, { recursive: args.recursive ?? false, force: true });
    return { success: true, stdout: `Deleted: ${absPath}` };
  } catch (err: any) {
    return { success: false, error: `Delete failed: ${err.message}` };
  }
}

export const deleteTool = {
  name: 'delete',
  description: 'Delete a file or directory',
  execute: executeDelete,
  schema: {
    path: 'string (required) - Path to delete',
    recursive: 'boolean (optional) - Delete directories recursively (default false)'
  }
};

// ── RENAME / MOVE ───────────────────────────────────────────────────────────
export interface RenameArgs {
  path: string;
  new_path: string;
}
export async function executeRename(args: RenameArgs): Promise<ToolResult> {
  try {
    const src = resolveWorkspacePath(args.path);
    const dest = resolveWorkspacePath(args.new_path);
    const srcCheck = isPathAllowed(src);
    const destCheck = isPathAllowed(dest);
    if (!srcCheck.allowed) return { success: false, error: srcCheck.reason };
    if (!destCheck.allowed) return { success: false, error: destCheck.reason };
    // Ensure source exists
    if (!(await fs.stat(src).catch(() => null))) {
      return { success: false, error: `Source does not exist: ${src}` };
    }
    // Ensure destination dir
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(src, dest);
    return { success: true, data: { from: src, to: dest } };
  } catch (err: any) {
    return { success: false, error: `Rename failed: ${err.message}` };
  }
}

export const renameTool = {
  name: 'rename',
  description: 'Rename or move a file/directory',
  execute: executeRename,
  schema: {
    path: 'string (required) - Existing path',
    new_path: 'string (required) - New path'
  }
};

// ── COPY ─────────────────────────────────────────────────────────────────────
export interface CopyArgs {
  path: string;
  dest: string;
}
export async function executeCopy(args: CopyArgs): Promise<ToolResult> {
  try {
    const src = resolveWorkspacePath(args.path);
    const dest = resolveWorkspacePath(args.dest);
    const srcCheck = isPathAllowed(src);
    const destCheck = isPathAllowed(dest);
    if (!srcCheck.allowed) return { success: false, error: srcCheck.reason };
    if (!destCheck.allowed) return { success: false, error: destCheck.reason };
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    return { success: true, data: { from: src, to: dest } };
  } catch (err: any) {
    return { success: false, error: `Copy failed: ${err.message}` };
  }
}

export const copyTool = {
  name: 'copy',
  description: 'Copy a file',
  execute: executeCopy,
  schema: {
    path: 'string (required) - Source file',
    dest: 'string (required) - Destination path'
  }
};

// ── MKDIR ────────────────────────────────────────────────────────────────────
export interface MkdirArgs {
  path: string;
  recursive?: boolean;
}
export async function executeMkdir(args: MkdirArgs): Promise<ToolResult> {
  try {
    const abs = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(abs);
    if (!pathCheck.allowed) return { success: false, error: pathCheck.reason };
    await fs.mkdir(abs, { recursive: args.recursive ?? true });
    return { success: true, data: { path: abs } };
  } catch (err: any) {
    return { success: false, error: `Mkdir failed: ${err.message}` };
  }
}

export const mkdirTool = {
  name: 'mkdir',
  description: 'Create a directory',
  execute: executeMkdir,
  schema: {
    path: 'string (required) - Directory path',
    recursive: 'boolean (optional) - Create parents'
  }
};

// ── STAT / INFO ──────────────────────────────────────────────────────────────
export interface StatArgs {
  path: string;
}
export async function executeStat(args: StatArgs): Promise<ToolResult> {
  try {
    const abs = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(abs);
    if (!pathCheck.allowed) return { success: false, error: pathCheck.reason };
    const st = await fs.stat(abs);
    return { success: true, data: { path: abs, size: st.size, mtime: st.mtime, isFile: st.isFile(), isDirectory: st.isDirectory() } };
  } catch (err: any) {
    return { success: false, error: `Stat failed: ${err.message}` };
  }
}

export const statTool = {
  name: 'stat',
  description: 'Get file info',
  execute: executeStat,
  schema: {
    path: 'string (required) - Path to file or directory'
  }
};

// ── APPEND ───────────────────────────────────────────────────────────────────
export interface AppendArgs {
  path: string;
  content: string;
}
export async function executeAppend(args: AppendArgs): Promise<ToolResult> {
  try {
    const abs = resolveWorkspacePath(args.path);
    const pathCheck = isPathAllowed(abs);
    if (!pathCheck.allowed) return { success: false, error: pathCheck.reason };
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, args.content, 'utf-8');
    return { success: true, data: { path: abs } };
  } catch (err: any) {
    return { success: false, error: `Append failed: ${err.message}` };
  }
}

export const appendTool = {
  name: 'append',
  description: 'Append text to a file (creates file if missing)',
  execute: executeAppend,
  schema: {
    path: 'string (required) - Path to file',
    content: 'string (required) - Text to append'
  }
};

// ── APPLY PATCH ────────────────────────────────────────────────────────────────
export interface ApplyPatchArgs {
  patch: string;
  check?: boolean;
}

export async function executeApplyPatch(args: ApplyPatchArgs): Promise<ToolResult> {
  const patchText = String(args?.patch || '');
  if (!patchText.trim()) {
    return { success: false, error: 'patch is required (unified diff string).' };
  }

  const targetPaths = extractPatchTargetPaths(patchText);
  const validation = validatePatchPaths(targetPaths);
  if (!validation.ok) return { success: false, error: validation.error };

  const workspacePath = getConfig().getConfig().workspace.path;
  const tempPatchPath = path.join(
    os.tmpdir(),
    `smallclaw-apply-${Date.now()}-${Math.random().toString(36).slice(2)}.patch`
  );

  try {
    await fs.writeFile(tempPatchPath, patchText, 'utf-8');
    const checked = await runGitApply(workspacePath, ['apply', '--check', '--whitespace=nowarn', '--recount', '--verbose', tempPatchPath]);
    const checkedOutput = [checked.stdout, checked.stderr].filter(Boolean).join('\n');
    const skippedOnCheck = countSkippedPatches(checkedOutput);
    if (skippedOnCheck >= validation.relativePaths.length) {
      const msg = truncateOutput(checkedOutput) || 'Patch check skipped all target files.';
      return { success: false, error: `apply_patch check failed: ${msg}` };
    }

    if (args.check === true) {
      return {
        success: true,
        data: {
          checked_only: true,
          files: validation.relativePaths,
          file_count: validation.relativePaths.length,
        },
        stdout: `Patch check passed for ${validation.relativePaths.length} file(s).`,
      };
    }

    const applied = await runGitApply(workspacePath, ['apply', '--whitespace=nowarn', '--recount', '--verbose', tempPatchPath]);
    const rawOutput = [applied.stdout, applied.stderr].filter(Boolean).join('\n');
    const skippedOnApply = countSkippedPatches(rawOutput);
    if (skippedOnApply >= validation.relativePaths.length) {
      const msg = truncateOutput(rawOutput) || 'Patch apply skipped all target files.';
      return { success: false, error: `apply_patch failed: ${msg}` };
    }
    const output = truncateOutput(rawOutput);

    return {
      success: true,
      data: {
        files: validation.relativePaths,
        file_count: validation.relativePaths.length,
      },
      stdout: output || `Patch applied to ${validation.relativePaths.length} file(s).`,
    };
  } catch (err: any) {
    const details = truncateOutput(String(err?.stderr || err?.stdout || err?.message || err || 'unknown error'));
    return { success: false, error: `apply_patch failed: ${details}` };
  } finally {
    await fs.unlink(tempPatchPath).catch(() => {});
  }
}

export const applyPatchTool = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to workspace files',
  execute: executeApplyPatch,
  schema: {
    patch: 'string (required) - Unified diff patch text',
    check: 'boolean (optional) - Validate patch only without applying it',
  }
};
