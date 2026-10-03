/**
 * files/index.ts - file_batch: batch file operations with preview/apply.
 *
 * Small-model friendly: one tool, five ops (rename, move, copy, delete,
 * organize), tiny schema, markdown plan preview before anything changes -
 * same UX as doc_write (mode:"preview" -> preview_id -> mode:"apply").
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { OfficeToolOutcome, OfficePathGuard } from './office';
import { isDocPreviewRequired } from './office';

const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 100;
const MAX_FILES = 200;

export type FileBatchOp = 'rename' | 'move' | 'copy' | 'delete' | 'organize';

interface PlannedEntry {
  src: string;
  srcDisplay: string;
  dest?: string;
  destDisplay?: string;
  kind: string;
  exists: boolean;
  error?: string;
}

interface Plan {
  id: string;
  sessionId: string;
  op: FileBatchOp;
  entries: PlannedEntry[];
  createdAt: number;
}

const previewStore = new Map<string, Plan>();

function sweepPreviews(): void {
  const now = Date.now();
  for (const [key, plan] of previewStore) {
    if (now - plan.createdAt > PREVIEW_TTL_MS) previewStore.delete(key);
  }
  while (previewStore.size > PREVIEW_MAX_ENTRIES) {
    const oldest = previewStore.keys().next().value;
    if (oldest === undefined) break;
    previewStore.delete(oldest);
  }
}

function previewIdFor(op: string, payload: any): string {
  return crypto.createHash('sha1').update(JSON.stringify({ op, payload })).digest('hex').slice(0, 32);
}

function relFrom(workspacePath: string, abs: string): string {
  const rel = path.relative(String(workspacePath || ''), abs);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : abs;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

const TYPE_FOLDERS: Array<{ exts: string[]; folder: string }> = [
  { exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'], folder: 'images' },
  { exts: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a'], folder: 'audio' },
  { exts: ['.mp4', '.mov', '.mkv', '.avi', '.webm'], folder: 'video' },
  { exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz'], folder: 'archives' },
  { exts: ['.pdf', '.doc', '.docx', '.txt', '.md', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.rtf'], folder: 'documents' },
  { exts: ['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.json', '.yml', '.yaml', '.toml', '.html', '.css', '.sh', '.ps1'], folder: 'code' },
];

function folderForFile(file: string): string {
  const ext = path.extname(file).toLowerCase();
  for (const group of TYPE_FOLDERS) {
    if (group.exts.includes(ext)) return group.folder;
  }
  return 'other';
}

function resolveOne(
  workspacePath: string,
  raw: unknown,
  guard?: OfficePathGuard,
): { ok: true; path: string } | { ok: false; error: string } {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, error: 'empty path' };
  if (value.includes('\0')) return { ok: false, error: 'Invalid filename' };
  if (guard) {
    const guarded = guard(workspacePath, value);
    if (guarded && typeof guarded === 'object') return guarded;
  }
  return { ok: true, path: path.resolve(String(workspacePath || ''), value) };
}

function normalizeOp(raw: unknown): FileBatchOp | null {
  const op = String(raw || '').trim().toLowerCase();
  return (['rename', 'move', 'copy', 'delete', 'organize'] as string[]).includes(op)
    ? (op as FileBatchOp)
    : null;
}

function listRawFiles(args: any): string[] {
  const raw = args?.files ?? args?.file ?? args?.paths ?? args?.path;
  if (Array.isArray(raw)) return raw.map(v => String(v ?? '').trim()).filter(Boolean);
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(/[\n,]+/).map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function buildPlan(
  op: FileBatchOp,
  args: any,
  workspacePath: string,
  sessionId: string,
  guard?: OfficePathGuard,
): { ok: true; plan: Plan } | { ok: false; error: string } {
  const entries: PlannedEntry[] = [];

  if (op === 'organize') {
    const destRaw = String(args?.dest ?? '').trim();
    const destResolved = destRaw ? resolveOne(workspacePath, destRaw, guard) : { ok: true as const, path: path.resolve(workspacePath) };
    if (!destResolved.ok) return { ok: false, error: `dest: ${destResolved.error}` };
    let names: string[] = [];
    try {
      names = fs.readdirSync(workspacePath);
    } catch (err: any) {
      return { ok: false, error: `cannot list workspace: ${err?.message || err}` };
    }
    const destRoot = destResolved.path;
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const src = path.join(workspacePath, name);
      if (isDirectory(src)) continue;
      const ext = path.extname(name).toLowerCase();
      if (!ext) continue;
      const folder = folderForFile(name);
      const dest = path.join(destRoot, folder, name);
      if (path.resolve(dest) === path.resolve(src)) continue;
      entries.push({
        src,
        srcDisplay: relFrom(workspacePath, src),
        dest,
        destDisplay: relFrom(workspacePath, dest),
        kind: 'move',
        exists: exists(src),
      });
    }
    if (!entries.length) {
      return { ok: false, error: 'nothing to organize (no top-level files with an extension found in the workspace)' };
    }
  } else {
    const rawFiles = listRawFiles(args);
    if (!rawFiles.length) return { ok: false, error: 'files is required (1-200 workspace-relative paths)' };
    if (rawFiles.length > MAX_FILES) return { ok: false, error: `${rawFiles.length} files - limit is ${MAX_FILES} per call` };

    if (op === 'rename') {
      if (rawFiles.length !== 1) return { ok: false, error: 'rename takes exactly one file and "to"' };
      const to = String(args?.to ?? '').trim();
      if (!to) return { ok: false, error: 'rename needs "to" (new name)' };
      const srcResolved = resolveOne(workspacePath, rawFiles[0], guard);
      if (!srcResolved.ok) return { ok: false, error: srcResolved.error };
      const destResolved = resolveOne(workspacePath, to, guard);
      if (!destResolved.ok) return { ok: false, error: `to: ${destResolved.error}` };
      entries.push({
        src: srcResolved.path,
        srcDisplay: relFrom(workspacePath, srcResolved.path),
        dest: destResolved.path,
        destDisplay: relFrom(workspacePath, destResolved.path),
        kind: 'move',
        exists: exists(srcResolved.path),
      });
    } else {
      const destRaw = String(args?.dest ?? '').trim();
      const destResolved = destRaw ? resolveOne(workspacePath, destRaw, guard) : { ok: true as const, path: path.resolve(workspacePath) };
      if (!destResolved.ok) return { ok: false, error: `dest: ${destResolved.error}` };
      for (const rawFile of rawFiles) {
        const srcResolved = resolveOne(workspacePath, rawFile, guard);
        if (!srcResolved.ok) return { ok: false, error: `${rawFile}: ${srcResolved.error}` };
        const kind = op === 'delete' ? 'delete' : op === 'copy' ? 'copy' : 'move';
        const entry: PlannedEntry = {
          src: srcResolved.path,
          srcDisplay: relFrom(workspacePath, srcResolved.path),
          kind,
          exists: exists(srcResolved.path),
        };
        if (op !== 'delete') {
          const dest = path.join(destResolved.path, path.basename(srcResolved.path));
          entry.dest = dest;
          entry.destDisplay = relFrom(workspacePath, dest);
        }
        entries.push(entry);
      }
    }
  }

  const id = previewIdFor(op, entries.map(e => [e.kind, e.src, e.dest || '', e.exists]));
  const plan: Plan = { id, sessionId: String(sessionId || 'default'), op, entries, createdAt: Date.now() };
  return { ok: true, plan };
}

function planMarkdown(plan: Plan, applied: boolean): string {
  const lines: string[] = [];
  if (!applied) lines.push(`### 批量操作预览（尚未执行 / preview only）`);
  else lines.push(`### 批量操作已执行 / applied`);
  lines.push(`**op**: ${plan.op} · **${plan.entries.length} 项**`, '');
  lines.push('| # | 操作 | 源 / source | 目标 / target | 状态 |');
  lines.push('|---|---|---|---|---|');
  plan.entries.forEach((entry, i) => {
    const status = entry.error
      ? `❌ ${entry.error}`
      : applied
        ? '✅ done'
        : entry.exists
          ? 'ok'
          : '⚠️ 源文件不存在';
    lines.push(
      `| ${i + 1} | ${entry.kind} | \`${entry.srcDisplay}\` | ${entry.dest ? `\`${entry.destDisplay}\`` : '-'} | ${status} |`
    );
  });
  if (!applied) {
    lines.push('', `preview_id: \`${plan.id}\``, '', '---', '_Preview only - nothing changed yet. Call file_batch with mode:"apply" and this preview_id once the user approves._');
  }
  return lines.join('\n');
}

export function getFileBatchToolDefinitions(): any[] {
  return [
    {
      type: 'function',
      function: {
        name: 'file_batch',
        description:
          'Batch file operations in the workspace: rename, move, copy, delete, organize (group files into folders by type). ALWAYS call mode:"preview" first to see the plan; apply with the preview_id after the user approves. Deletes and moves are irreversible, so never skip the preview.',
        parameters: {
          type: 'object',
          required: ['op'],
          properties: {
            op: { type: 'string', enum: ['rename', 'move', 'copy', 'delete', 'organize'], description: 'Operation.' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Workspace-relative paths (1-200). Not needed for organize.',
            },
            to: { type: 'string', description: 'rename only: the new name/path.' },
            dest: { type: 'string', description: 'move/copy/organize: destination folder (created if missing).' },
            mode: { type: 'string', enum: ['preview', 'apply'], description: 'preview (default) writes nothing; apply executes the plan.' },
            preview_id: { type: 'string', description: 'Returned by preview. Required for apply.' },
          },
        },
      },
    },
  ];
}

export async function executeFileBatchTool(
  args: any,
  workspacePath: string,
  sessionId: string = 'default',
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  sweepPreviews();
  const op = normalizeOp(args?.op);
  if (!op) return { result: 'op must be one of: rename, move, copy, delete, organize', error: true };

  const mode = String(args?.mode || 'preview').trim().toLowerCase() === 'apply' ? 'apply' : 'preview';

  if (mode === 'preview') {
    const built = buildPlan(op, args, workspacePath, sessionId, guard);
    if (!built.ok) return { result: built.error, error: true };
    previewStore.set(built.plan.id, built.plan);
    return { result: planMarkdown(built.plan, false), error: false };
  }

  if (isDocPreviewRequired()) {
    const id = String(args?.preview_id || '').trim();
    if (!id) return { result: 'preview_id is required. Call file_batch with mode:"preview" first.', error: true };
    const plan = previewStore.get(id);
    if (!plan) return { result: 'No matching preview found (expired or never previewed). Run mode:"preview" again.', error: true };
    if (plan.sessionId !== String(sessionId || 'default')) {
      return { result: 'The preview belongs to another session - run mode:"preview" again in this session.', error: true };
    }
    if (plan.op !== op) return { result: `preview_id was for op "${plan.op}", not "${op}". Run mode:"preview" again.`, error: true };
    return runPlan(plan, workspacePath, guard);
  }

  const built = buildPlan(op, args, workspacePath, sessionId, guard);
  if (!built.ok) return { result: built.error, error: true };
  return runPlan(built.plan, workspacePath, guard);
}

function runPlan(plan: Plan, workspacePath: string, guard?: OfficePathGuard): OfficeToolOutcome {
  const createdDirs = new Set<string>();
  let ok = 0;
  const fail = (entry: PlannedEntry, message: string) => {
    entry.error = message;
  };

  for (const entry of plan.entries) {
    try {
      // Re-resolve through the guard: the workspace may have changed since preview.
      const srcCheck = guard ? guard(workspacePath, entry.src) : ({ ok: true as const, path: entry.src });
      if (!srcCheck.ok) { fail(entry, srcCheck.error); continue; }
      if (!exists(entry.src)) { fail(entry, 'source not found'); continue; }

      if (entry.kind === 'delete') {
        if (isDirectory(entry.src)) { fail(entry, 'refusing to delete a directory'); continue; }
        fs.unlinkSync(entry.src);
        ok++;
        continue;
      }

      const dest = String(entry.dest || '');
      if (!dest) { fail(entry, 'missing destination'); continue; }
      const destDir = path.dirname(dest);
      if (guard) {
        const destCheck = guard(workspacePath, dest);
        if (!destCheck.ok) { fail(entry, destCheck.error); continue; }
      }
      if (exists(dest)) { fail(entry, 'destination already exists'); continue; }
      if (destDir && !isDirectory(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        createdDirs.add(destDir);
      }
      if (entry.kind === 'copy') {
        fs.copyFileSync(entry.src, dest);
      } else {
        fs.renameSync(entry.src, dest);
      }
      ok++;
    } catch (err: any) {
      fail(entry, String(err?.message || err).slice(0, 120));
    }
  }

  const failed = plan.entries.length - ok;
  if (!failed) previewStore.delete(plan.id);
  return {
    result: planMarkdown(plan, true) + `\n\n成功 ${ok} / 失败 ${failed}`,
    error: failed > 0,
    paths: plan.entries
      .filter(e => !e.error)
      .flatMap(e => (e.kind === 'delete' ? [e.src] : e.dest ? [e.dest] : [])),
  };
}
