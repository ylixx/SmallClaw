/**
 * ast_search — 基于 ast-grep 的结构化代码搜索（对标 QwenPaw 的 ast_tool）
 *
 * 设计要点：
 * - 封装 ast-grep CLI（`ast-grep` / `sg`，Rust 单文件二进制），做**语法树级**模式匹配，
 *   区别于 grep_content 的正则/文本匹配——能按结构（函数签名、类、调用）精确搜，不会误伤字符串。
 * - 只读，不做任何改写；要改先用 ast_search 看全调用点，再用 edit/write。
 * - 二进制解析顺序：① 本地 node_modules/.bin（项目已装 @ast-grep/cli）② PATH 上的 ast-grep/sg。
 * - 路径边界复用 files.ts 的 isPathAllowed（与 read/write/grep 同一套 workspace 权限）。
 * - 限制：匹配数上限、单条片段字符上限、总输出字符上限，避免大项目打爆上下文。
 * - 行/列 1-based（编辑器风格），与 QwenPaw 行为一致。
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

// ── 限制常量 ──────────────────────────────────────────────────────────────────
const AST_GREP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MATCHES = 200;
const MAX_MATCHES_CAP = 1000;
const MAX_SNIPPET_CHARS = 400;
const MAX_TOTAL_OUTPUT_CHARS = 80_000;

// ── 二进制解析 ────────────────────────────────────────────────────────────────
/**
 * 解析 ast-grep 的启动方式。返回 { command, argsPrefix }，调用方用
 * spawn(command, [...argsPrefix, ...cliArgs], { shell: false }) 启动。
 *
 * 关键：Windows 下 node_modules/.bin/ast-grep 是个 .cmd 垫片，若用 shell:true 启动，
 * cmd.exe 会把 pattern 里的 `$C { $$$M }` 当多个裸参数拆开执行（"系统找不到指定的文件"），
 * 导致 --pattern 只收到首词、搜索结果错乱。因此 Windows 一律改用 `node` 直接跑
 * @ast-grep/cli 的 JS 入口，参数按 argv 原样传递，彻底绕开 cmd 引号陷阱。
 * POSIX 下直接用 node_modules/.bin/ast-grep（带 shebang 的可执行脚本）。
 */
interface AstGrepCommand {
  command: string;
  argsPrefix: string[];
}

function resolveAstGrepCommand(): AstGrepCommand | null {
  // 1) 项目本地 @ast-grep/cli 的 JS 入口（最可靠，已随依赖安装）
  const jsEntry = resolveAstGrepJsEntry();
  if (jsEntry) {
    return { command: process.execPath, argsPrefix: [jsEntry] };
  }

  // 2) 本地 node_modules/.bin/ast-grep（POSIX 直接可执行；Windows 走上面的 JS 入口已覆盖）
  const cwdRoot = process.cwd();
  const localCandidates = [
    path.join(cwdRoot, 'node_modules', '.bin', 'ast-grep'),
    path.join(cwdRoot, '..', 'node_modules', '.bin', 'ast-grep'),
    path.join(__dirname, '..', '..', 'node_modules', '.bin', 'ast-grep'),
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c) && !c.endsWith('.cmd')) return { command: c, argsPrefix: [] };
  }

  // 3) PATH 上的 ast-grep / sg（全局安装）
  for (const name of ['ast-grep', 'sg']) {
    const found = syncWhich(name);
    if (found && !found.endsWith('.cmd')) return { command: found, argsPrefix: [] };
  }

  return null;
}

/** 定位 @ast-grep/cli 包内的 JS 启动入口（bin 字段），用于以 `node <entry>` 方式运行。 */
function resolveAstGrepJsEntry(): string | null {
  const searchRoots = [
    process.cwd(),
    path.join(process.cwd(), '..'),
    path.join(__dirname, '..', '..'),
  ];
  for (const root of searchRoots) {
    const pkgPath = path.join(root, 'node_modules', '@ast-grep', 'cli', 'package.json');
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const bin = pkg?.bin?.['ast-grep'] ?? pkg?.bin?.astgrep;
      if (typeof bin === 'string') return path.join(path.dirname(pkgPath), bin);
    } catch {
      /* 解析失败则尝试下一个 root */
    }
  }
  return null;
}

function syncWhich(name: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(cmd, [name], { encoding: 'utf-8', windowsHide: true }).trim();
    const first = out.split(/\r?\n/)[0]?.trim();
    return first || null;
  } catch {
    return null;
  }
}

// ── 输出格式化 ────────────────────────────────────────────────────────────────
interface AstMatch {
  file: string;
  line: number;
  column: number;
  end_line: number;
  snippet: string;
}

function formatMatches(
  raw: any[],
  rootAbs: string,
  maxMatches: number,
): { matches: AstMatch[]; truncated: boolean } {
  const matches: AstMatch[] = [];
  let truncated = false;
  let totalChars = 0;
  const rootResolved = path.resolve(rootAbs);

  for (const entry of raw) {
    if (matches.length >= maxMatches) {
      truncated = true;
      break;
    }
    const rng = entry?.range || {};
    const start = rng.start || {};
    const end = rng.end || {};

    let displayPath = String(entry?.file || '');
    try {
      const fp = path.isAbsolute(displayPath) ? path.resolve(displayPath) : path.resolve(rootResolved, displayPath);
      displayPath = path.relative(rootResolved, fp).split(path.sep).join('/');
    } catch {
      displayPath = String(entry?.file || '').replace(/\\/g, '/');
    }

    const snippetRaw = entry?.lines ?? entry?.text ?? '';
    let snippet = String(snippetRaw).replace(/\s+$/, '');
    if (snippet.length > MAX_SNIPPET_CHARS) {
      snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + '…';
    }

    const match: AstMatch = {
      file: displayPath,
      line: (Number(start.line) || 0) + 1,
      column: (Number(start.column) || 0) + 1,
      end_line: (Number(end.line) || 0) + 1,
      snippet,
    };

    const entryChars = JSON.stringify(match).length;
    if (totalChars + entryChars > MAX_TOTAL_OUTPUT_CHARS) {
      truncated = true;
      break;
    }
    totalChars += entryChars;
    matches.push(match);
  }

  return { matches, truncated };
}

// ── 运行 ast-grep（spawn + 手动超时，Windows 下走 shell 以兼容 .cmd 垫片） ────────
function runAstGrep(
  binary: string,
  cliArgs: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(binary, cliArgs, {
      cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, AST_GREP_TIMEOUT_MS);

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err) => { stderr += `\n[spawn error] ${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed && code === null) stderr += `\n[timed out after ${AST_GREP_TIMEOUT_MS}ms]`;
      resolve({ stdout, stderr, code });
    });
  });
}

// ── 执行 ────────────────────────────────────────────────────────────────────────
export interface AstSearchArgs {
  pattern: string;
  language: string;
  path?: string;
  max_matches?: number;
}

export async function executeAstSearch(args: AstSearchArgs): Promise<ToolResult> {
  try {
    const pattern = String(args?.pattern || '').trim();
    const language = String(args?.language || '').trim();
    if (!pattern) return { success: false, error: 'pattern is required (ast-grep pattern, e.g. "def $FUNC($$$ARGS): $$$BODY")' };
    if (!language) return { success: false, error: 'language is required (e.g. python, typescript, go, rust)' };

    const resolved = resolveAstGrepCommand();
    if (!resolved) {
      return {
        success: false,
        error:
          'ast-grep CLI not found. Install with "npm i @ast-grep/cli" (or "pip install ast-grep-cli") and ensure it is on PATH, then retry.',
      };
    }
    const { command, argsPrefix } = resolved;

    const maxMatches = Math.min(
      Math.max(Math.floor(Number(args?.max_matches ?? DEFAULT_MAX_MATCHES)) || DEFAULT_MAX_MATCHES, 1),
      MAX_MATCHES_CAP,
    );

    // ── 路径边界：与 read/write/grep 同一套 workspace 权限 ──
    const config = getConfig().getConfig();
    const workspace = path.resolve(config.workspace.path);
    const targetRel = String(args?.path || '').trim();
    const targetAbs = path.isAbsolute(targetRel) ? targetRel : path.join(workspace, targetRel);

    const pathCheck = isPathAllowed(targetAbs);
    if (!pathCheck.allowed) {
      return { success: false, error: pathCheck.reason };
    }
    if (!fs.existsSync(targetAbs)) {
      return { success: false, error: `Path does not exist: ${targetRel || workspace}` };
    }

    // 传给 ast-grep 的 target：相对 workspace 的路径（让输出 file 也是相对路径）
    const relTarget = targetAbs === workspace ? '.' : path.relative(workspace, targetAbs);

    const cliArgs = [
      'run',
      '--pattern', pattern,
      '--lang', language,
      '--json=compact',
      relTarget,
    ];

    let stdout = '';
    let stderr = '';
    const result = await runAstGrep(command, [...argsPrefix, ...cliArgs], workspace);
    stdout = result.stdout;
    stderr = result.stderr;
    const { code } = result;
    // ast-grep 把"无匹配"也走 stdout 返回 []（exit 0）；非零退出通常是语法/语言错误
    if (code !== 0 && !stdout.trim()) {
      const msg = (stderr || `exit code ${code}`).trim();
      return { success: false, error: `ast-grep failed: ${msg.slice(0, 300)}` };
    }

    let raw: any[];
    try {
      const trimmed = (stdout || '').trim();
      raw = trimmed ? JSON.parse(trimmed) : [];
    } catch {
      // stdout 不是合法 JSON：可能是 ast-grep 的报错信息
      const msg = (stdout || stderr || 'unknown error').trim();
      return { success: false, error: `ast-grep returned non-JSON output — ${msg.slice(0, 300)}` };
    }

    if (!Array.isArray(raw)) {
      return { success: false, error: `unexpected ast-grep output (expected a JSON list).` };
    }
    if (raw.length === 0) {
      return {
        success: true,
        stdout: `No matches for pattern in language=${language}.`,
        data: { count: 0, results: [] },
      };
    }

    const { matches, truncated } = formatMatches(raw, workspace, maxMatches);
    if (matches.length === 0) {
      return {
        success: true,
        stdout: `No matches within limit (max_matches=${maxMatches}) for pattern in language=${language}.`,
        data: { count: 0, results: [], truncated: true },
      };
    }

    const payload = {
      count: matches.length,
      truncated,
      results: matches,
    };
    const pretty = JSON.stringify(payload, null, 2);
    return {
      success: true,
      stdout: pretty,
      data: payload,
    };
  } catch (err: any) {
    return { success: false, error: `ast_search failed: ${err?.message || err}` };
  }
}

export const astSearchTool = {
  name: 'ast_search',
  description:
    'Structural code search via ast-grep (AST pattern matching), NOT regex. Use when you need to find code by SYNTAX/STRUCTURE — function/class definitions, call sites, assignments — across the workspace or a path. Patterns use $NAME (single node) and $$$NAME (multi-node) captures, e.g. "def $FUNC($$$ARGS): $$$BODY" (python) or "class $C { $$$M }" (typescript). Requires `language` (python/typescript/go/rust/...). Read-only; to change code, read matches then use edit/write. Returns JSON list of {file, line, column, end_line, snippet}.',
  execute: executeAstSearch,
  schema: {
    pattern: 'string (required) - ast-grep pattern, e.g. "function $NAME($$$ARGS) { $$$BODY }"',
    language: 'string (required) - source language: python, typescript, javascript, tsx, go, rust, java, c, cpp, ruby, php, ...',
    path: 'string (optional) - file or directory to search (default: workspace root)',
    max_matches: 'number (optional, default 200, max 1000) - hard cap on returned matches',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'ast-grep pattern, e.g. "function $NAME($$$ARGS) { $$$BODY }"' },
      language: { type: 'string', description: 'source language: python, typescript, go, rust, ...' },
      path: { type: 'string', description: 'file or directory to search (default: workspace root)' },
      max_matches: { type: 'number', description: 'hard cap on returned matches (default 200, max 1000)' },
    },
    required: ['pattern', 'language'],
    additionalProperties: false,
  },
};

