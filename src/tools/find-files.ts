/**
 * find_files — 按文件名/路径模式查找（对标 OpenClaw 的 glob/find 工具）
 *
 * 设计要点（与 grep_content 一致的小模型友好 + 可移植）：
 * - 纯 Node 实现，不依赖外部 rg/find 二进制
 * - 支持 glob 通配：`*` 匹配非分隔符段，`**` 匹配任意层（含跨目录），`?` 单字符
 * - 可选 `content` 正则：仅返回「路径匹配 且 内容含该正则」的文件（内容过滤）
 * - 跳过大目录（node_modules/.git/dist...），扫描文件数/结果数上限保护
 * - 路径边界复用 files.ts 的 isPathAllowed（workspace 权限一致）
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const MAX_FILES_SCANNED = 6000;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB，内容过滤时大文件跳过
const MAX_DEPTH = 20;
const MAX_RESULTS_DEFAULT = 200;
const MAX_OUTPUT_CHARS = 30000;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'logs',
  '.sessions', 'vendor', 'target', '.turbo', '.idea', '.vscode',
  '.smallclaw', 'artifacts',
]);

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

// 将 glob 模式编译为正则（匹配相对路径，使用 / 分隔）
function globToRegExp(glob: string, caseSensitive: boolean): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // ** 跨目录匹配
        re += '(?:.*\\/)?';
        i++;
        // 允许 **/ 或 /** 形式
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^\\/]*';
      }
    } else if (c === '?') {
      re += '[^\\/]';
    } else if (c === '.') {
      re += '\\.';
    } else if ('+^$(){}[]|\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$', caseSensitive ? '' : 'i');
}

export interface FindFilesArgs {
  pattern?: string;          // glob 模式，缺省匹配所有文件名
  path?: string;             // 根目录（默认 workspace）
  content?: string;          // 可选内容正则过滤
  case_sensitive?: boolean;  // 文件名/内容是否大小写敏感（默认 false）
  limit?: number;
}

interface WalkState {
  filesScanned: number;
  aborted: boolean;
  results: Array<{ file: string; size: number; mtime: string }>;
}

async function walk(
  dirAbs: string,
  relDir: string,
  reGlob: RegExp | null,
  contentRe: RegExp | null,
  limit: number,
  state: WalkState,
  depth: number,
): Promise<void> {
  if (state.aborted || depth > MAX_DEPTH) return;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (state.aborted || state.results.length >= limit) {
      if (state.results.length >= limit) state.aborted = true;
      return;
    }
    if (state.filesScanned >= MAX_FILES_SCANNED) {
      state.aborted = true;
      return;
    }

    const entAbs = path.join(dirAbs, ent.name);
    const relName = relDir ? `${relDir}/${ent.name}` : ent.name;

    if (ent.isDirectory()) {
      if (isIgnoredDir(ent.name)) continue;
      await walk(entAbs, relName, reGlob, contentRe, limit, state, depth + 1);
      continue;
    }

    if (!ent.isFile()) continue;

    // 文件名/路径 glob 匹配
    if (reGlob && !reGlob.test(relName)) continue;

    // 内容过滤（可选）
    if (contentRe) {
      state.filesScanned += 1;
      let stat: fsSync.Stats;
      try {
        stat = fsSync.statSync(entAbs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = await fs.readFile(entAbs, 'utf-8');
      } catch {
        continue;
      }
      contentRe.lastIndex = 0;
      if (!contentRe.test(content)) continue;
      // 重新取 mtime（已 stat 过）
      state.results.push({ file: relName, size: stat.size, mtime: stat.mtime.toISOString() });
    } else {
      state.results.push({ file: relName, size: 0, mtime: '' });
    }
  }
}

export async function executeFindFiles(args: FindFilesArgs): Promise<ToolResult> {
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

    const caseSensitive = args?.case_sensitive === true;
    let reGlob: RegExp | null = null;
    const globPattern = String(args?.pattern || '').trim();
    if (globPattern) {
      try {
        reGlob = globToRegExp(globPattern, caseSensitive);
      } catch (err: any) {
        return { success: false, error: `Invalid glob pattern "${globPattern.slice(0, 80)}": ${err?.message || err}` };
      }
    }

    let contentRe: RegExp | null = null;
    const contentPattern = String(args?.content || '').trim();
    if (contentPattern) {
      try {
        contentRe = new RegExp(contentPattern, caseSensitive ? 'gm' : 'gim');
      } catch (err: any) {
        return { success: false, error: `Invalid content regex "${contentPattern.slice(0, 80)}": ${err?.message || err}` };
      }
    }

    const limitRaw = Number(args?.limit ?? MAX_RESULTS_DEFAULT);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 1000)
      : MAX_RESULTS_DEFAULT;

    const state: WalkState = { filesScanned: 0, aborted: false, results: [] };
    await walk(
      targetAbs,
      path.relative(workspace, targetAbs).split(path.sep).join('/') || '',
      reGlob,
      contentRe,
      limit,
      state,
      0,
    );

    if (state.results.length === 0) {
      return {
        success: true,
        stdout: '未找到匹配文件',
        data: { count: 0, results: [], scanned_note: state.aborted ? `扫描上限 ${MAX_FILES_SCANNED} 已达` : '' },
      };
    }

    const lines = state.results.map(r => {
      const meta = r.size ? ` (${r.size}B${r.mtime ? ', ' + r.mtime.slice(0, 10) : ''})` : '';
      return r.file + meta;
    });
    let out = lines.join('\n');
    if (state.results.length >= limit) {
      out += `\n[已截断：仅显示前 ${limit} 个，可用更精确的 pattern]`;
    }
    if (state.aborted) {
      out += `\n[扫描文件数达上限 ${MAX_FILES_SCANNED}，结果可能不完整]`;
    }
    if (out.length > MAX_OUTPUT_CHARS) {
      out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出过长已截断，请缩小 pattern 或 path]`;
    }

    return {
      success: true,
      stdout: out,
      data: {
        count: state.results.length,
        truncated: state.results.length >= limit || state.aborted,
        results: state.results,
        scanned_note: state.aborted ? `扫描上限 ${MAX_FILES_SCANNED} 已达` : '',
      },
    };
  } catch (err: any) {
    return { success: false, error: `find_files failed: ${err?.message || err}` };
  }
}

export const findFilesTool = {
  name: 'find_files',
  description:
    'Find files by name/path glob pattern (e.g. "**/*.controller.ts", "src/**/*.ts", "*.json") with optional content regex filter. Use when you need to LOCATE files by name/path (NOT by content — for content search use grep_content). Recurses, skips big dirs (node_modules/.git/dist), caps results.',
  execute: executeFindFiles,
  schema: {
    pattern: 'string (optional) - glob pattern; supports * (one segment), ** (any dirs), ? (one char). Empty = match all',
    path: 'string (optional) - root dir to search (default workspace root)',
    content: 'string (optional) - only return files whose content matches this regex',
    case_sensitive: 'boolean (optional) - default false (case-insensitive)',
    limit: 'number (optional, default 200, max 1000) - max files to return',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob pattern (e.g. "**/*.ts"). Empty = all files' },
      path: { type: 'string', description: 'root dir (default workspace root)' },
      content: { type: 'string', description: 'optional content regex filter' },
      case_sensitive: { type: 'boolean', description: 'default false' },
      limit: { type: 'number', description: 'max files (default 200, max 1000)' },
    },
    required: [],
    additionalProperties: false,
  },
};
