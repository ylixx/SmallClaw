/**
 * tail — 读取文件末尾 N 行（对标 tail -n）
 *
 * 设计要点：
 * - 纯 Node，无外部依赖
 * - 默认 50 行，最大 2000 行，带行号（从文件真实起始行号）
 * - 复用 isPathAllowed，仅文本文件（UTF-8）
 * - 文件 <= 16MB 整读（行号精确）；更大则只读尾部 16MB 块，行号标注「不精确」
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const DEFAULT_LINES = 50;
const MAX_LINES = 2000;
const READ_CAP = 16 * 1024 * 1024; // 16MB：超过则只读尾部块

interface TailArgs {
  path: string;
  lines?: number;
}

export async function executeTail(args: TailArgs): Promise<ToolResult> {
  try {
    if (!args?.path?.trim()) return { success: false, error: 'path is required' };
    const config = getConfig().getConfig();
    const workspace = config.workspace.path;
    const abs = path.isAbsolute(args.path) ? args.path : path.join(workspace, args.path);
    const check = isPathAllowed(abs);
    if (!check.allowed) return { success: false, error: check.reason };
    if (!fsSync.existsSync(abs)) return { success: false, error: `File does not exist: ${abs}` };
    const st = fsSync.statSync(abs);
    if (!st.isFile()) return { success: false, error: `Not a file: ${abs}` };

    const n = Math.min(Math.max(Number(args?.lines ?? DEFAULT_LINES) || DEFAULT_LINES, 1), MAX_LINES);
    const fileSize = st.size;

    let content: string;
    let totalLines = -1;

    if (fileSize <= READ_CAP) {
      content = await fs.readFile(abs, 'utf-8');
      const all = content.split('\n');
      if (all.length && all[all.length - 1] === '') all.pop();
      totalLines = all.length;
      const tailLines = all.slice(-n);
      const startLine = Math.max(1, totalLines - tailLines.length + 1);
      const out = tailLines.map((l, i) => `${startLine + i}\t${l}`).join('\n');
      return {
        success: true,
        data: { path: abs, lines_requested: n, lines_returned: tailLines.length, start_line: startLine, total_lines: totalLines },
        stdout: out,
      };
    }

    // 大文件：只读尾部块
    const take = Math.min(fileSize, READ_CAP);
    const fd = await fs.open(abs, 'r');
    const buf = Buffer.alloc(take);
    await fd.read(buf, 0, take, fileSize - take);
    await fd.close();
    content = buf.toString('utf-8');
    const nl = content.indexOf('\n');
    if (nl >= 0) content = content.slice(nl + 1); // 丢弃首段不完整行

    const parts = content.split('\n');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    const tailLines = parts.slice(-n);
    const out = tailLines.map((l, i) => `${i + 1}\t${l}`).join('\n');

    return {
      success: true,
      data: {
        path: abs,
        lines_requested: n,
        lines_returned: tailLines.length,
        start_line: 1,
        total_lines: -1,
        note: '尾部截断（文件 > 16MB），行号为相对值，不精确',
      },
      stdout: out,
    };
  } catch (err: any) {
    return { success: false, error: `tail failed: ${err?.message || err}` };
  }
}

export const tailTool = {
  name: 'tail',
  description:
    'Read the last N lines of a text file (default 50, max 2000), with line numbers. Use to inspect logs/end of files without loading the whole file. Text (UTF-8) files only.',
  execute: executeTail,
  schema: {
    path: 'string (required) - file to read (workspace-relative or allowed absolute)',
    lines: 'number (optional, default 50, max 2000) - number of trailing lines',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file to read' },
      lines: { type: 'number', description: 'trailing lines (default 50, max 2000)' },
    },
    required: ['path'],
    additionalProperties: false,
  },
};
