/**
 * delegate_external_agent — 把难活委派给外部 Agent Runner（ACP/stdio）
 *
 * 定位：本地小模型当「包工头」，干不动时把任务甩给更大的外部 agent
 * （claude_code / codex / opencode / qwen_code 等）。
 *
 * 实现要点：
 * - 配置驱动：runner 在 config.external_agents 声明（command/args/env）。
 *   无配置时 list 返回空 + 指引（优雅降级，不崩溃）。
 * - 传输：子进程 stdio，换行分隔的 JSON-RPC 2.0，方法名对齐 ACP
 *   （initialize / session/new / session/prompt / session/cancel）。
 * - 长驻进程缓存 + 每请求超时 + 取消；流式文本经 session/update 通知累积。
 * - 安全：用户文本经 stdin(JSON-RPC) 发送，绝不进 argv；仅 launch argv 来自
 *   受信配置，故 spawn 可用 shell:true 以兼容 Windows 的 .cmd 垫片。
 *
 * 注意：不同 runner 的 ACP 细节可能有差异，本客户端按标准 ACP 方法名实现，
 * 已用 mock JSON-RPC server 验证生命周期；真实 runner 兼容性取决于其协议遵循度。
 */

import { spawn, ChildProcess } from 'child_process';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import type { ExternalAgentDef } from '../types.js';

type Action = 'list' | 'status' | 'start' | 'message' | 'close';

interface ExternalAgentArgs {
  action: Action;
  runner?: string;
  message?: string;
  cwd?: string;
  max_runtime?: number; // 单次 turn 超时（秒），默认 300
}

const DEFAULT_TURN_TIMEOUT_MS = 300 * 1000;
const INIT_TIMEOUT_MS = 30 * 1000;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
}

interface RunnerProc {
  def: ExternalAgentDef;
  child: ChildProcess;
  nextId: number;
  pending: Map<number, Pending>;
  sessionId: string | null;
  updates: string[]; // 累积的 session/update 文本
  buffer: string;
  initialized: boolean;
  lastError?: string;
}

const runners = new Map<string, RunnerProc>();

function getRunnerDefs(): ExternalAgentDef[] {
  const cfg = getConfig().getConfig();
  const list = (cfg as any)?.external_agents;
  if (!Array.isArray(list)) return [];
  return list
    .filter((r: any) => r && typeof r.command === 'string' && r.command.trim())
    .filter((r: any) => r.enabled !== false)
    .map((r: any) => ({
      id: String(r.id || r.command),
      name: r.name ? String(r.name) : undefined,
      command: String(r.command),
      args: Array.isArray(r.args) ? r.args.map((a: any) => String(a)) : [],
      env: r.env && typeof r.env === 'object' ? r.env : undefined,
      enabled: r.enabled !== false,
    }));
}

function killRunner(id: string): void {
  const r = runners.get(id);
  if (!r) return;
  try { r.child.kill(); } catch { /* ignore */ }
  for (const [, p] of r.pending) {
    clearTimeout(p.timer);
    p.reject(new Error('runner process terminated'));
  }
  r.pending.clear();
  runners.delete(id);
}

function handleLine(r: RunnerProc, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return; }

  // JSON-RPC response (has id) -> resolve pending
  if (msg && msg.id != null && r.pending.has(msg.id)) {
    const p = r.pending.get(msg.id)!;
    r.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  // Notification (has method, no id) -> session/update 文本累积
  if (msg && msg.method && msg.id == null) {
    if (msg.method === 'session/update' || /update/i.test(msg.method)) {
      const text = extractUpdateText(msg.params);
      if (text) r.updates.push(text);
    }
  }
}

function extractUpdateText(params: any): string {
  if (!params) return '';
  const upd = params.update ?? params;
  // ACP: update.content 可能是 [{type:"text", text}] 或 {type:"text", text}
  const content = upd?.content ?? upd?.text ?? params.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('');
  }
  if (typeof upd?.text === 'string') return upd.text;
  return '';
}

function sendRequest(r: RunnerProc, method: string, params: any, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!r.child.stdin || r.child.killed) {
      reject(new Error('runner process not running'));
      return;
    }
    const id = r.nextId++;
    const timer = setTimeout(() => {
      r.pending.delete(id);
      reject(new Error(`${method} 超时 (${Math.round(timeoutMs / 1000)}s)`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    r.pending.set(id, { resolve, reject, timer });
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    try {
      r.child.stdin.write(payload + '\n');
    } catch (err: any) {
      r.pending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

async function ensureRunner(def: ExternalAgentDef): Promise<RunnerProc> {
  const existing = runners.get(def.id);
  if (existing && !existing.child.killed) return existing;

  const env = { ...process.env, ...(def.env || {}) };
  const child = spawn(def.command, def.args || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    windowsHide: true,
    shell: process.platform === 'win32', // 兼容 .cmd 垫片；argv 仅来自受信配置
  });

  const r: RunnerProc = {
    def,
    child,
    nextId: 1,
    pending: new Map(),
    sessionId: null,
    updates: [],
    buffer: '',
    initialized: false,
  };
  runners.set(def.id, r);

  child.stdout?.on('data', (chunk: Buffer) => {
    r.buffer += chunk.toString('utf-8');
    let idx: number;
    while ((idx = r.buffer.indexOf('\n')) >= 0) {
      const line = r.buffer.slice(0, idx);
      r.buffer = r.buffer.slice(idx + 1);
      handleLine(r, line);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    r.lastError = (r.lastError ? r.lastError + '\n' : '') + chunk.toString('utf-8').slice(0, 500);
  });
  child.on('exit', (code) => {
    for (const [, p] of r.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`runner 退出 (code ${code})${r.lastError ? ': ' + r.lastError.slice(0, 200) : ''}`));
    }
    r.pending.clear();
    if (runners.get(def.id) === r) runners.delete(def.id);
  });
  child.on('error', (err: any) => {
    r.lastError = String(err?.message || err);
    for (const [, p] of r.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`runner 启动失败: ${r.lastError}（检查 command 是否存在：${def.command}）`));
    }
    r.pending.clear();
    if (runners.get(def.id) === r) runners.delete(def.id);
  });

  // initialize 握手
  try {
    await sendRequest(r, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    }, INIT_TIMEOUT_MS);
    r.initialized = true;
  } catch (err) {
    killRunner(def.id);
    throw err;
  }
  return r;
}

async function runTurn(r: RunnerProc, text: string, cwd: string | undefined, timeoutMs: number): Promise<string> {
  if (!r.sessionId) {
    const res = await sendRequest(r, 'session/new', { cwd: cwd || process.cwd(), mcpServers: [] }, timeoutMs);
    r.sessionId = res?.sessionId || res?.session?.id || null;
    if (!r.sessionId) throw new Error('session/new 未返回 sessionId');
  }
  const mark = r.updates.length;
  await sendRequest(r, 'session/prompt', {
    sessionId: r.sessionId,
    prompt: [{ type: 'text', text }],
  }, timeoutMs);
  const out = r.updates.slice(mark).join('');
  return out.trim() || '(外部 agent 无文本输出)';
}

export async function executeDelegateExternalAgent(args: ExternalAgentArgs): Promise<ToolResult> {
  const action = String(args?.action || '').trim() as Action;
  const valid: Action[] = ['list', 'status', 'start', 'message', 'close'];
  if (!valid.includes(action)) {
    return { success: false, error: `action 必须是: ${valid.join(' / ')}` };
  }

  const defs = getRunnerDefs();

  if (action === 'list') {
    if (defs.length === 0) {
      return {
        success: true,
        stdout:
          '未配置任何外部 agent runner。\n' +
          '在 config 的 external_agents 数组中声明，例如：\n' +
          '  { "id": "claude_code", "command": "claude", "args": ["--acp"] }\n' +
          '或用 npx：{ "id": "claude_code", "command": "npx", "args": ["@zed-industries/claude-code-acp"] }',
        data: { runners: [] },
      };
    }
    const lines = defs.map((d) =>
      `- ${d.id}${d.name ? ` (${d.name})` : ''}: ${d.command} ${(d.args || []).join(' ')}` +
      `${runners.has(d.id) && !runners.get(d.id)!.child.killed ? ' [会话已开]' : ''}`);
    return { success: true, stdout: `已配置 ${defs.length} 个外部 runner:\n${lines.join('\n')}`, data: { runners: defs.map((d) => d.id) } };
  }

  if (action === 'status') {
    const target = args?.runner ? defs.filter((d) => d.id === args.runner) : defs;
    if (args?.runner && target.length === 0) {
      return { success: false, error: `未找到 runner "${args.runner}"。可用：${defs.map((d) => d.id).join(', ') || '(无)'}` };
    }
    const lines = target.map((d) => {
      const r = runners.get(d.id);
      const alive = r && !r.child.killed;
      return `- ${d.id}: ${alive ? `会话${r!.sessionId ? '已开(' + r!.sessionId + ')' : '未开'}` : '未启动'}`;
    });
    return { success: true, stdout: lines.join('\n') || '(无 runner)', data: {} };
  }

  const def = defs.find((d) => d.id === args?.runner);
  if (!def) {
    return { success: false, error: `未找到 runner "${args?.runner || ''}"。先 action:"list" 看可用 runner。` };
  }

  if (action === 'close') {
    killRunner(def.id);
    return { success: true, stdout: `已关闭 runner: ${def.id}` };
  }

  const timeoutMs = Math.min(Math.max(Number(args?.max_runtime ?? DEFAULT_TURN_TIMEOUT_MS / 1000) || DEFAULT_TURN_TIMEOUT_MS / 1000, 5), 1800) * 1000;

  try {
    const r = await ensureRunner(def);
    const text = String(args?.message ?? '').trim() || (action === 'start' ? 'hi' : '');
    if (!text) return { success: false, error: 'start/message 需要 message（start 缺省发送 hi）' };
    const out = await runTurn(r, text, args?.cwd, timeoutMs);
    return {
      success: true,
      stdout: `[${def.id}] ${out}`,
      data: { runner: def.id, sessionId: r.sessionId, output: out },
    };
  } catch (err: any) {
    // turn 失败但保留会话（ACP 语义：超时/取消不断会话），仅进程级错误才清理
    const msg = String(err?.message || err);
    if (/启动失败|退出|not running/i.test(msg)) killRunner(def.id);
    return { success: false, error: `delegate ${action} 失败 (${def.id}): ${msg}` };
  }
}

export const delegateExternalAgentTool = {
  name: 'delegate_external_agent',
  description:
    'Delegate a task to an external agent runner over ACP/stdio (claude_code/codex/opencode/...). The local model acts as orchestrator; the external agent does the heavy lifting. Actions: list, status, start(runner,message?), message(runner,message), close(runner). Runners are declared in config.external_agents; if none, list returns setup guidance. User text goes over stdin (JSON-RPC), never argv.',
  execute: executeDelegateExternalAgent,
  schema: {
    action: 'string (required) - list | status | start | message | close',
    runner: 'string (start/message/status/close) - runner id from config.external_agents',
    message: 'string (start/message) - text to send (start defaults to "hi")',
    cwd: 'string (optional) - working directory for the external agent session',
    max_runtime: 'number (optional, seconds, default 300, max 1800) - per-turn timeout',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'start', 'message', 'close'], description: 'operation' },
      runner: { type: 'string', description: 'runner id from config.external_agents' },
      message: { type: 'string', description: 'text to send (start defaults to hi)' },
      cwd: { type: 'string', description: 'working directory for the session' },
      max_runtime: { type: 'number', description: 'per-turn timeout in seconds (default 300, max 1800)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
