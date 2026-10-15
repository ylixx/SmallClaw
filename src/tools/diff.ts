/**
 * diff — 两文件行级差异（类 unified diff，基于 LCS）
 *
 * 设计要点：
 * - 纯 Node，无外部依赖（自实现 LCS 生成 unified 风格差异）
 * - 支持 context 行数（默认 3），输出截断保护
 * - 双路径均经 isPathAllowed 校验，仅文本文件
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const MAX_OUTPUT_CHARS = 30000;

interface DiffArgs {
  a: string;
  b: string;
  context?: number;
}

// LCS 表 -> 回溯生成差异块
function diffLines(aLines: string[], bLines: string[]): Array<{ type: ' ' | '-' | '+'; text: string }> {
  const n = aLines.length;
  const m = bLines.length;
  // dp[i][j] = LCS length of aLines[i..], bLines[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Array<{ type: ' ' | '-' | '+'; text: string }> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      out.push({ type: ' ', text: aLines[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', text: aLines[i] });
      i++;
    } else {
      out.push({ type: '+', text: bLines[j] });
      j++;
    }
  }
  while (i < n) { out.push({ type: '-', text: aLines[i] }); i++; }
  while (j < m) { out.push({ type: '+', text: bLines[j] }); j++; }
  return out;
}

function groupHunks(
  diff: Array<{ type: ' ' | '-' | '+' ; text: string }>,
  context: number,
): Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ type: ' ' | '-' | '+'; text: string }> }> {
  const changes: number[] = [];
  diff.forEach((d, idx) => { if (d.type !== ' ') changes.push(idx); });
  if (changes.length === 0) return [];

  const hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; lines: Array<{ type: ' ' | '-' | '+' ; text: string }> }> = [];
  let c = 0;
  while (c < changes.length) {
    // 聚合连续（含 context 间隔）的变更区间为同一 hunk
    const blockStart = changes[c];
    let blockEnd = blockStart;
    let k = c;
    while (k < changes.length) {
      const ci = changes[k];
      if (ci - blockEnd <= context * 2 + 1) {
        blockEnd = ci;
        k++;
      } else {
        break;
      }
    }
    c = k;

    const from = Math.max(0, blockStart - context);
    const to = Math.min(diff.length - 1, blockEnd + context);
    const lines = diff.slice(from, to + 1);
    let oldStart = 1, newStart = 1;
    for (let x = 0; x < from; x++) {
      if (diff[x].type === ' ' || diff[x].type === '-') oldStart++;
      if (diff[x].type === ' ' || diff[x].type === '+') newStart++;
    }
    let oldCount = 0, newCount = 0;
    for (const l of lines) {
      if (l.type === ' ' || l.type === '-') oldCount++;
      if (l.type === ' ' || l.type === '+') newCount++;
    }
    hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
  }
  return hunks;
}

export async function executeDiff(args: DiffArgs): Promise<ToolResult> {
  try {
    if (!args?.a?.trim() || !args?.b?.trim()) return { success: false, error: 'a and b are required' };
    const config = getConfig().getConfig();
    const workspace = config.workspace.path;
    const aAbs = path.isAbsolute(args.a) ? args.a : path.join(workspace, args.a);
    const bAbs = path.isAbsolute(args.b) ? args.b : path.join(workspace, args.b);
    for (const [label, p] of [['a', aAbs], ['b', bAbs]] as const) {
      const check = isPathAllowed(p);
      if (!check.allowed) return { success: false, error: `${label}: ${check.reason}` };
      if (!fsSync.existsSync(p) || !fsSync.statSync(p).isFile()) {
        return { success: false, error: `${label} is not a file: ${p}` };
      }
    }
    const context = Math.min(Math.max(Number(args?.context ?? 3) || 3, 0), 10);
    const [aText, bText] = await Promise.all([fs.readFile(aAbs, 'utf-8'), fs.readFile(bAbs, 'utf-8')]);
    const aLines = aText.split('\n');
    const bLines = bText.split('\n');
    const diff = diffLines(aLines, bLines);
    const hunks = groupHunks(diff, context);

    if (hunks.length === 0) {
      return { success: true, stdout: '两文件内容一致（无差异）', data: { identical: true, hunks: 0 } };
    }

    const relA = path.relative(workspace, aAbs).split(path.sep).join('/') || aAbs;
    const relB = path.relative(workspace, bAbs).split(path.sep).join('/') || bAbs;
    const out: string[] = [`--- a/${relA}`, `+++ b/${relB}`];
    for (const h of hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines) out.push(`${l.type} ${l.text}`);
    }
    let outStr = out.join('\n');
    if (outStr.length > MAX_OUTPUT_CHARS) {
      outStr = `${outStr.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出过长已截断，请缩小对比范围]`;
    }
    const added = diff.filter(d => d.type === '+').length;
    const removed = diff.filter(d => d.type === '-').length;
    return {
      success: true,
      stdout: outStr,
      data: { identical: false, hunks: hunks.length, added, removed },
    };
  } catch (err: any) {
    return { success: false, error: `diff failed: ${err?.message || err}` };
  }
}

export const diffTool = {
  name: 'diff',
  description:
    'Compare two text files line-by-line and return a unified-diff-style result (LCS-based, no external deps). Use to see what changed between two versions. Both paths must be workspace-allowed. Supports context lines (default 3).',
  execute: executeDiff,
  schema: {
    a: 'string (required) - first file (workspace-relative or allowed absolute)',
    b: 'string (required) - second file',
    context: 'number (optional, default 3, max 10) - context lines per hunk',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      a: { type: 'string', description: 'first file' },
      b: { type: 'string', description: 'second file' },
      context: { type: 'number', description: 'context lines per hunk (default 3, max 10)' },
    },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};
