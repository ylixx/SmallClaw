/**
 * tree — 递归目录树（对标常见的 tree 工具）
 *
 * 设计要点：
 * - 纯 Node，无外部依赖
 * - depth 可控（默认 3，最大 8），防止超大目录打爆上下文
 * - 可选是否列出文件、是否列出隐藏文件（. 开头）
 * - 跳过大目录（node_modules/.git/dist...）
 * - 复用 isPathAllowed
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'logs',
  '.sessions', 'vendor', 'target', '.turbo', '.idea', '.vscode',
  '.smallclaw', 'artifacts',
]);

const MAX_DEPTH = 8;
const MAX_ENTRIES = 2000; // 总条目上限

interface TreeArgs {
  path?: string;
  depth?: number;
  include_files?: boolean;
  hidden?: boolean;
}

interface TreeLine {
  depth: number;
  name: string;
  isDir: boolean;
}

async function walk(
  dirAbs: string,
  relDir: string,
  depth: number,
  maxDepth: number,
  includeFiles: boolean,
  hidden: boolean,
  out: TreeLine[],
  counter: { n: number },
): Promise<void> {
  if (depth > maxDepth || counter.n >= MAX_ENTRIES) return;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  // 目录在前，按名称排序
  const dirs: import('fs').Dirent[] = [];
  const files: import('fs').Dirent[] = [];
  for (const ent of entries) {
    if (counter.n >= MAX_ENTRIES) break;
    if (!hidden && ent.name.startsWith('.')) continue;
    if (ent.isDirectory()) dirs.push(ent);
    else if (includeFiles && ent.isFile()) files.push(ent);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));

  for (const ent of [...dirs, ...files]) {
    if (counter.n >= MAX_ENTRIES) return;
    counter.n += 1;
    const isDir = ent.isDirectory();
    out.push({ depth: relDir ? relDir.split('/').length : 0, name: ent.name, isDir });
    if (isDir && !IGNORED_DIRS.has(ent.name)) {
      const childAbs = path.join(dirAbs, ent.name);
      const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
      await walk(childAbs, childRel, depth + 1, maxDepth, includeFiles, hidden, out, counter);
    }
  }
}

export async function executeTree(args: TreeArgs): Promise<ToolResult> {
  try {
    const config = getConfig().getConfig();
    const workspace = config.workspace.path;

    const targetRel = String(args?.path || '').trim();
    const targetAbs = path.isAbsolute(targetRel) ? targetRel : path.join(workspace, targetRel);
    const pathCheck = isPathAllowed(targetAbs);
    if (!pathCheck.allowed) return { success: false, error: pathCheck.reason };
    if (!fsSync.existsSync(targetAbs) || !fsSync.statSync(targetAbs).isDirectory()) {
      return { success: false, error: `Not a directory: ${targetRel || workspace}` };
    }

    const maxDepth = Math.min(Math.max(Number(args?.depth ?? 3) || 3, 1), MAX_DEPTH);
    const includeFiles = args?.include_files !== false; // 默认含文件
    const hidden = args?.hidden === true;

    const out: TreeLine[] = [];
    const counter = { n: 0 };
    await walk(targetAbs, '', 1, maxDepth, includeFiles, hidden, out, counter);

    const rootName = path.basename(targetAbs) || targetAbs;
    const lines: string[] = [rootName + '/'];
    for (const item of out) {
      const indent = '  '.repeat(item.depth);
      const prefix = item.isDir ? '📁 ' : '📄 ';
      lines.push(`${indent}${prefix}${item.name}${item.isDir ? '/' : ''}`);
    }

    let outStr = lines.join('\n');
    if (counter.n >= MAX_ENTRIES) {
      outStr += `\n[已达条目上限 ${MAX_ENTRIES}，结果可能不完整]`;
    }

    return {
      success: true,
      stdout: outStr,
      data: {
        root: targetAbs,
        entries: out.length,
        truncated: counter.n >= MAX_ENTRIES,
      },
    };
  } catch (err: any) {
    return { success: false, error: `tree failed: ${err?.message || err}` };
  }
}

export const treeTool = {
  name: 'tree',
  description:
    'Recursively list a directory tree (depth-capped). Use to understand project structure. Options: depth (default 3, max 8), include_files (default true), hidden (default false, skips dotfiles). Big dirs (node_modules/.git/dist) are skipped.',
  execute: executeTree,
  schema: {
    path: 'string (optional) - root dir (default workspace root)',
    depth: 'number (optional, default 3, max 8) - max nesting depth',
    include_files: 'boolean (optional, default true) - include files (not just dirs)',
    hidden: 'boolean (optional, default false) - include dotfiles/dirs',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'root dir (default workspace root)' },
      depth: { type: 'number', description: 'max depth (default 3, max 8)' },
      include_files: { type: 'boolean', description: 'include files (default true)' },
      hidden: { type: 'boolean', description: 'include dotfiles (default false)' },
    },
    required: [],
    additionalProperties: false,
  },
};
