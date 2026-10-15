/**
 * copy_tree — 递归复制整个目录子树（对标 cp -r）
 *
 * 设计要点：
 * - 纯 Node，无外部依赖
 * - 保留相对目录结构，目标已存在的同名文件默认跳过（overwrite 可覆盖）
 * - 双路径均经 isPathAllowed 校验
 * - 文件数 / 总字节上限保护，防止误复制超大目录
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 256MB 总上限

interface CopyTreeArgs {
  src: string;
  dest: string;
  overwrite?: boolean;
}

interface CopyState {
  copied: number;
  skipped: number;
  failed: number;
  bytes: number;
  aborted: boolean;
  errors: string[];
}

async function walkCopy(
  srcAbs: string,
  destAbs: string,
  overwrite: boolean,
  state: CopyState,
): Promise<void> {
  if (state.aborted) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(srcAbs, { withFileTypes: true });
  } catch (err: any) {
    state.failed += 1;
    state.errors.push(`${srcAbs}: ${String(err?.message || err).slice(0, 120)}`);
    return;
  }

  for (const ent of entries) {
    if (state.aborted) return;
    if (state.copied + state.skipped >= MAX_FILES) {
      state.aborted = true;
      return;
    }
    const s = path.join(srcAbs, ent.name);
    const d = path.join(destAbs, ent.name);
    try {
      if (ent.isDirectory()) {
        await fs.mkdir(d, { recursive: true });
        await walkCopy(s, d, overwrite, state);
      } else if (ent.isFile()) {
        const st = await fs.stat(s);
        if (state.bytes + st.size > MAX_TOTAL_BYTES) {
          state.aborted = true;
          return;
        }
        if (fsSync.existsSync(d) && !overwrite) {
          state.skipped += 1;
          continue;
        }
        await fs.mkdir(path.dirname(d), { recursive: true });
        await fs.copyFile(s, d);
        state.copied += 1;
        state.bytes += st.size;
      }
    } catch (err: any) {
      state.failed += 1;
      state.errors.push(`${s}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }
}

export async function executeCopyTree(args: CopyTreeArgs): Promise<ToolResult> {
  try {
    if (!args?.src?.trim() || !args?.dest?.trim()) {
      return { success: false, error: 'src and dest are required' };
    }
    const config = getConfig().getConfig();
    const workspace = config.workspace.path;
    const srcAbs = path.isAbsolute(args.src) ? args.src : path.join(workspace, args.src);
    const destAbs = path.isAbsolute(args.dest) ? args.dest : path.join(workspace, args.dest);

    const srcCheck = isPathAllowed(srcAbs);
    if (!srcCheck.allowed) return { success: false, error: `src: ${srcCheck.reason}` };
    const destCheck = isPathAllowed(destAbs);
    if (!destCheck.allowed) return { success: false, error: `dest: ${destCheck.reason}` };

    if (!fsSync.existsSync(srcAbs) || !fsSync.statSync(srcAbs).isDirectory()) {
      return { success: false, error: `src is not a directory: ${args.src}` };
    }
    // 防止复制到自身子树内
    const normSrc = path.resolve(srcAbs).replace(/[\\/]$/, '');
    const normDest = path.resolve(destAbs).replace(/[\\/]$/, '');
    if (normDest === normSrc || normDest.startsWith(normSrc + path.sep)) {
      return { success: false, error: 'dest cannot be inside src' };
    }

    await fs.mkdir(destAbs, { recursive: true });
    const state: CopyState = { copied: 0, skipped: 0, failed: 0, bytes: 0, aborted: false, errors: [] };
    await walkCopy(srcAbs, destAbs, args.overwrite === true, state);

    const note = state.aborted ? ' [已触发上限，复制可能不完整]' : '';
    return {
      success: state.failed === 0,
      stdout: `复制完成：copied=${state.copied}, skipped=${state.skipped}, failed=${state.failed}, bytes=${state.bytes}${note}` +
        (state.errors.length ? '\n' + state.errors.slice(0, 10).join('\n') : ''),
      data: {
        src: srcAbs,
        dest: destAbs,
        copied: state.copied,
        skipped: state.skipped,
        failed: state.failed,
        bytes: state.bytes,
        aborted: state.aborted,
        errors: state.errors,
      },
    };
  } catch (err: any) {
    return { success: false, error: `copy_tree failed: ${err?.message || err}` };
  }
}

export const copyTreeTool = {
  name: 'copy_tree',
  description:
    'Recursively copy a directory tree (preserves relative structure), like cp -r. By default skips existing files at dest; set overwrite=true to replace. Both paths must be workspace-allowed. Capped at 2000 files / 256MB.',
  execute: executeCopyTree,
  schema: {
    src: 'string (required) - source directory (workspace-relative or absolute within allowed paths)',
    dest: 'string (required) - destination directory',
    overwrite: 'boolean (optional, default false) - overwrite existing files at dest',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      src: { type: 'string', description: 'source directory' },
      dest: { type: 'string', description: 'destination directory' },
      overwrite: { type: 'boolean', description: 'overwrite existing files (default false)' },
    },
    required: ['src', 'dest'],
    additionalProperties: false,
  },
};
