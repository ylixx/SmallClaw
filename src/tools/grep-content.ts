/**
 * grep_content — 按内容搜索工作区文件（对标 OpenClaw Mini 的 grep 工具）
 *
 * 设计要点（小模型友好 + 可移植）：
 * - 纯 Node 实现，不依赖外部 rg 二进制（Windows/多机部署无环境依赖）
 * - 递归遍历，白名单扩展名，忽略 node_modules/.git/dist 等大目录
 * - 输出 `相对路径:行号: 行内容`，模型可直接定位 + 配合 edit 使用
 * - 超限显式标注：命中数截断 / 输出字符截断 / 扫描文件数上限
 * - 路径边界复用 files.ts 的 isPathAllowed（workspace 权限一致）
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

// 扫描上限（防大项目打爆上下文/卡死）
const MAX_FILES_SCANNED = 3000;
const MAX_FILE_BYTES = 512 * 1024; // 512KB，大文件跳过
const MAX_DEPTH = 20;
const MAX_RESULTS_DEFAULT = 100;
const MAX_OUTPUT_CHARS = 30000;

// 忽略的目录（相对路径名匹配）
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', 'logs',
  '.sessions', 'vendor', 'target', '.turbo', '.idea', '.vscode',
  '.smallclaw', 'artifacts',
]);

// 文本文件白名单（扩展名小写）
const TEXT_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.jsx', '.tsx', '.json', '.md', '.mdx',
  '.txt', '.html', '.htm', '.css', '.scss', '.less', '.py', '.java',
  '.c', '.cpp', '.h', '.hpp', '.go', '.rs', '.rb', '.php', '.sh', '.bat',
  '.ps1', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.sql', '.xml', '.svg', '.csv', '.tsv', '.vue', '.svelte', '.lock',
]);

function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

function isTextFile(name: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function buildRegex(pattern: string, caseSensitive: boolean): RegExp {
  return new RegExp(pattern, caseSensitive ? 'gm' : 'gim');
}

interface WalkOptions {
  pattern: RegExp;
  rootAbs: string;
  relRoot: string;
  limit: number;
  caseSensitive: boolean;
  ctxBefore: number;
  ctxAfter: number;
}

type GrepHit_ = GrepHit;

async function walkSearch(
  dirAbs: string,
  relDir: string,
  opts: WalkOptions,
  state: { files: number; matches: number; hits: GrepHit_[]; aborted: boolean },
  depth: number,
): Promise<void> {
  if (state.aborted || depth > MAX_DEPTH) return;

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return; // 无权限/不存在的目录静默跳过
  }

  for (const ent of entries) {
    if (state.aborted) return;
    if (state.files >= MAX_FILES_SCANNED) {
      state.aborted = true;
      return;
    }

    const entAbs = path.join(dirAbs, ent.name);
    const relName = relDir ? `${relDir}/${ent.name}` : ent.name;

    if (ent.isDirectory()) {
      if (isIgnoredDir(ent.name)) continue;
      await walkSearch(entAbs, relName, opts, state, depth + 1);
      continue;
    }

    if (!ent.isFile()) continue;
    if (!isTextFile(ent.name)) continue;

    state.files += 1;

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
      continue; // 二进制误判/编码错误跳过
    }

    const lines = content.split('\n');
    const matchIdx: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      opts.pattern.lastIndex = 0;
      if (opts.pattern.test(lines[i])) {
        matchIdx.push(i);
        state.matches += 1;
        if (state.matches >= opts.limit) {
          state.aborted = true;
          break;
        }
      }
    }
    if (matchIdx.length === 0) continue;

    // 展开上下文行（按文档顺序，matched 标 isMatch=true）
    const emitted = new Set<number>();
    for (const mi of matchIdx) {
      const from = Math.max(0, mi - opts.ctxBefore);
      const to = Math.min(lines.length - 1, mi + opts.ctxAfter);
      for (let j = from; j <= to; j++) {
        if (emitted.has(j)) continue;
        emitted.add(j);
        state.hits.push({
          file: relName,
          line: j + 1,
          text: lines[j].trim().slice(0, 240),
          isMatch: j === mi,
        });
      }
    }
  }
}

export interface GrepHit {
  file: string;
  line: number;
  text: string;
  isMatch: boolean;
}

export interface GrepContentArgs {
  pattern: string;
  path?: string;
  limit?: number;
  case_sensitive?: boolean;
  context_before?: number; // -B: lines of context before each match
  context_after?: number;  // -A: lines of context after each match
  context?: number;        // -C: sets both before and after
}

export async function executeGrepContent(args: GrepContentArgs): Promise<ToolResult> {
  try {
    const pattern = String(args?.pattern || '').trim();
    if (!pattern) return { success: false, error: 'pattern is required' };

    // 预编译正则，非法正则直接报错（不让模型试错）
    let regex: RegExp;
    try {
      regex = buildRegex(pattern, args?.case_sensitive === true);
    } catch (err: any) {
      return {
        success: false,
        error: `Invalid regex pattern "${pattern.slice(0, 80)}": ${err?.message || err}`,
      };
    }

    const limitRaw = Number(args?.limit ?? MAX_RESULTS_DEFAULT);
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(Math.floor(limitRaw), 1), 500)
      : MAX_RESULTS_DEFAULT;

    // 上下文行参数（-B/-A/-C），上限各 10 行，避免噪声过大
    const ctxC = Math.min(Math.max(Number(args?.context ?? 0) || 0, 0), 10);
    const ctxB = Math.min(Math.max(Number(args?.context_before ?? ctxC) || 0, 0), 10);
    const ctxA = Math.min(Math.max(Number(args?.context_after ?? ctxC) || 0, 0), 10);

    const config = getConfig().getConfig();
    const workspace = config.workspace.path;
    const targetRel = String(args?.path || '').trim();
    const targetAbs = path.isAbsolute(targetRel)
      ? targetRel
      : path.join(workspace, targetRel);

    // 权限检查：与 read/write 同一套 workspace 边界
    const pathCheck = isPathAllowed(targetAbs);
    if (!pathCheck.allowed) {
      return { success: false, error: pathCheck.reason };
    }

    if (!fsSync.existsSync(targetAbs)) {
      return { success: false, error: `Path does not exist: ${targetRel || workspace}` };
    }
    const stat = fsSync.statSync(targetAbs);
    if (!stat.isDirectory()) {
      // 单文件搜索：直接匹配
      if (!isTextFile(targetAbs)) {
        return { success: false, error: `Not a text file: ${targetRel}` };
      }
      const content = await fs.readFile(targetAbs, 'utf-8');
      const lines = content.split('\n');
      const relFile = path.relative(workspace, targetAbs).split(path.sep).join('/') || targetAbs;
      const hits: GrepHit[] = [];
      let matches = 0;
      const matchIdx: number[] = [];
      regex.lastIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matchIdx.push(i);
          matches += 1;
          if (matches >= limit) break;
        }
      }
      const emitted = new Set<number>();
      for (const mi of matchIdx) {
        const from = Math.max(0, mi - ctxB);
        const to = Math.min(lines.length - 1, mi + ctxA);
        for (let j = from; j <= to; j++) {
          if (emitted.has(j)) continue;
          emitted.add(j);
          hits.push({ file: relFile, line: j + 1, text: lines[j].trim().slice(0, 240), isMatch: j === mi });
        }
      }
      return formatGrepResult(hits, limit, matches);
    }

    // 目录递归搜索
    const state = { files: 0, matches: 0, hits: [] as GrepHit[], aborted: false };
    await walkSearch(
      targetAbs,
      path.relative(workspace, targetAbs).split(path.sep).join('/') || '',
      { pattern: regex, rootAbs: targetAbs, relRoot: '', limit, caseSensitive: args?.case_sensitive === true, ctxBefore: ctxB, ctxAfter: ctxA },
      state,
      0,
    );

    const scannedNote = state.files >= MAX_FILES_SCANNED
      ? `\n[扫描文件数已达上限 ${MAX_FILES_SCANNED}，结果可能不完整]`
      : '';
    return formatGrepResult(state.hits, limit, state.matches, scannedNote);
  } catch (err: any) {
    return { success: false, error: `grep_content failed: ${err?.message || err}` };
  }
}

function formatGrepResult(
  hits: GrepHit[],
  limit: number,
  matchCount: number,
  extraNote = '',
): ToolResult {
  if (hits.length === 0) {
    return { success: true, stdout: '未找到匹配', data: { count: 0, results: [] } };
  }

  // 命中行正常输出；上下文行以 "| " 前缀标记
  const lines = hits.map((h) => {
    const marker = h.isMatch ? '' : '| ';
    return `${h.file}:${h.line}: ${marker}${h.text}`;
  });
  let out = lines.join('\n');
  if (matchCount >= limit) {
    out += `\n[已截断：仅显示前 ${limit} 条匹配，可用更精确的 pattern 缩小范围]`;
  }
  if (extraNote) out += extraNote;
  if (out.length > MAX_OUTPUT_CHARS) {
    out = `${out.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出过长已截断，请缩小 pattern 或 path]`;
  }

  return {
    success: true,
    stdout: out,
    data: {
      count: matchCount,
      context_lines: hits.length - matchCount,
      truncated: matchCount >= limit,
      results: hits,
    },
  };
}

export const grepContentTool = {
  name: 'grep_content',
  description:
    'Search file contents inside the workspace with a regex and return "file:line: text" matches. Use when you need to FIND where something is written (a config key, function name, string) — do NOT guess file by file. Patterns are JavaScript RegExp (e.g. "compactionThreshold", "memoryFlush.*threshold", "^export class"). Large dirs (node_modules/.git/dist) are skipped; limit matches; invalid regex returns an error.',
  execute: executeGrepContent,
  schema: {
    pattern: 'string (required) - regex to search for (JavaScript RegExp syntax)',
    path: 'string (optional) - file or directory to search (default: workspace root)',
    limit: 'number (optional, default 100, max 500) - max matches to return',
    case_sensitive: 'boolean (optional) - default false (case-insensitive)',
    context_before: 'number (optional, 0-10) - lines of context before each match (-B)',
    context_after: 'number (optional, 0-10) - lines of context after each match (-A)',
    context: 'number (optional, 0-10) - sets both context_before and context_after (-C)',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'regex to search for (JavaScript RegExp syntax)' },
      path: { type: 'string', description: 'file or directory to search (default: workspace root)' },
      limit: { type: 'number', description: 'max matches to return (default 100, max 500)' },
      case_sensitive: { type: 'boolean', description: 'default false (case-insensitive)' },
      context_before: { type: 'number', description: 'lines of context before each match (-B), 0-10' },
      context_after: { type: 'number', description: 'lines of context after each match (-A), 0-10' },
      context: { type: 'number', description: 'sets both before/after context (-C), 0-10' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
};
