/**
 * tool-batch — 多工具批量编排元工具（对标 QwenPaw 的 run_tool_batch）
 *
 * 设计要点：
 * - 串行执行一个动作列表，每个动作可调用一个已注册工具，并支持跨步引用结果。
 * - 占位符：${args.X}（顶层传入参数）、${steps.N.field}（第 N 步结果的字段，
 *   支持 . 路径遍历如 ${steps.0.data.items}）、${vars.X}（运行时变量）。
 * - 控制流：set_var（赋值，支持简单算术 ${vars.count} + 1）、goto（无条件跳到 label）、
 *   goto_if（{ cond, to } 条件跳转，cond 形如 "${vars.count} < 3"）。
 * - 保护：动作数上限 50；总步数上限 maxstep（默认 500，防死循环）；stop_on_error 全局/单步；
 *   last_only 仅返回最后一步紧凑摘要；禁止递归调用 run_tool_batch 自身。
 * - 只读调用其他工具，本身不修改任何文件；是 QwenPaw 工具主导型 agent 的核心编排能力。
 */

import { getToolRegistry } from './registry.js';
import { ToolResult } from '../types.js';

const MAX_ACTIONS = 50;
const DEFAULT_MAX_STEP = 500;

export interface BatchAction {
  tool_name?: string;
  arguments?: Record<string, any>;
  label?: string;
  set_var?: { name: string; value: any };
  goto?: string;
  goto_if?: { cond: string; to: string };
  stop_on_error?: boolean;
}

export interface ToolBatchArgs {
  actions?: BatchAction[] | string;
  file_path?: string;
  args?: Record<string, any>;
  stop_on_error?: boolean;
  last_only?: boolean;
  maxstep?: number;
}

interface ExecContext {
  args: Record<string, any>;
  vars: Record<string, any>;
  steps: ToolResult[];
}

// ── 占位符解析 ────────────────────────────────────────────────────────────────
function resolvePlaceholders(value: any, ctx: ExecContext): any {
  if (typeof value === 'string') {
    // 整串就是一个占位符 → 返回原始值（可能为数字/布尔/对象 JSON 串）
    const whole = value.match(/^\$\{([^}]+)\}$/);
    if (whole) {
      const resolved = resolvePlaceholderBody(whole[1].trim(), ctx);
      if (resolved !== undefined) return resolved;
    }
    // 否则做内联替换
    return value.replace(/\$\{([^}]+)\}/g, (_m, body: string) => {
      const resolved = resolvePlaceholderBody(body.trim(), ctx);
      return resolved === undefined ? _m : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, ctx));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolvePlaceholders(v, ctx);
    return out;
  }
  return value;
}

/** 解析 ${...} 内部表达式，返回原始类型值或 undefined（未匹配）。 */
function resolvePlaceholderBody(body: string, ctx: ExecContext): any {
  // args.X
  let m = body.match(/^args\.([\w.]+)$/);
  if (m) return traverse(ctx.args, m[1]);
  // vars.X
  m = body.match(/^vars\.([\w.]+)$/);
  if (m) return traverse(ctx.vars, m[1]);
  // steps.N[.field...]
  m = body.match(/^steps\.(\d+)(?:\.(.+))?$/);
  if (m) {
    const idx = Number(m[1]);
    const step = ctx.steps[idx];
    if (step === undefined) return undefined;
    if (!m[2]) return step;
    return traverse(step, m[2]);
  }
  return undefined;
}

function traverse(obj: any, path: string): any {
  let cur: any = obj;
  for (const seg of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// ── 简单算术：${vars.count} + 1 这类 ──────────────────────────────────────────
function evalSetVarValue(raw: any, ctx: ExecContext): any {
  const str = typeof raw === 'string' ? resolvePlaceholders(raw, ctx) : raw;
  if (typeof str === 'string') {
    const arith = str.match(/^\s*(-?\d+(?:\.\d+)?)\s*([+\-*/])\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (arith) {
      const a = parseFloat(arith[1]);
      const b = parseFloat(arith[3]);
      switch (arith[2]) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b !== 0 ? a / b : NaN;
      }
    }
    return str;
  }
  return str;
}

// ── 条件求值："${vars.count} < 3" ─────────────────────────────────────────────
function evalCondition(cond: string, ctx: ExecContext): boolean {
  const resolved = resolvePlaceholders(cond, ctx);
  const m = String(resolved).match(/^\s*(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+?)\s*$/);
  if (!m) return false;
  const lhs = m[1];
  const op = m[2];
  const rhs = m[3];
  const ln = Number(lhs);
  const rn = Number(rhs);
  const numeric = !Number.isNaN(ln) && !Number.isNaN(rn);
  const a: any = numeric ? ln : lhs;
  const b: any = numeric ? rn : rhs;
  switch (op) {
      case '==': return a == b;
      case '!=': return a != b;
    case '<': return a < b;
    case '>': return a > b;
    case '<=': return a <= b;
    case '>=': return a >= b;
  }
  return false;
}

// ── 步骤结果 → 紧凑摘要 ───────────────────────────────────────────────────────
function summarize(result: ToolResult): any {
  if (result.stdout && String(result.stdout).trim()) return String(result.stdout).trim();
  if (result.data !== undefined) return result.data;
  if (result.error) return `[ERROR] ${result.error}`;
  return result.success ? '(ok, no output)' : '(failed)';
}

// ── 主执行 ────────────────────────────────────────────────────────────────────
export async function executeToolBatch(input: ToolBatchArgs): Promise<ToolResult> {
  const registry = getToolRegistry();
  const stopOnError = input.stop_on_error !== false;
  const lastOnly = input.last_only === true;
  const maxStep = Math.min(Math.max(Number(input.maxstep) || DEFAULT_MAX_STEP, 1), 2000);

  // 解析动作列表
  let actions: BatchAction[] = [];
  if (input.file_path) {
    try {
      const fs = await import('fs');
      const raw = fs.readFileSync(input.file_path, 'utf-8');
      const parsed = JSON.parse(raw);
      actions = Array.isArray(parsed) ? parsed : parsed.actions;
    } catch (e: any) {
      return { success: false, error: `Failed to read actions file "${input.file_path}": ${e.message}` };
    }
  } else if (typeof input.actions === 'string') {
    try {
      const parsed = JSON.parse(input.actions);
      actions = Array.isArray(parsed) ? parsed : parsed.actions;
    } catch (e: any) {
      return { success: false, error: `Failed to parse actions JSON: ${e.message}` };
    }
  } else if (Array.isArray(input.actions)) {
    actions = input.actions;
  }

  if (!actions || actions.length === 0) {
    return { success: false, error: 'No actions provided (need "actions" array or "file_path").' };
  }
  if (actions.length > MAX_ACTIONS) {
    return { success: false, error: `Too many actions: ${actions.length} > ${MAX_ACTIONS}.` };
  }

  // 预建 label → index 映射
  const labelMap = new Map<string, number>();
  actions.forEach((a, i) => {
    if (a.label) {
      if (labelMap.has(a.label)) return { success: false, error: `Duplicate label "${a.label}"` } as any;
      labelMap.set(a.label, i);
    }
  });

  const ctx: ExecContext = {
    args: (input.args && typeof input.args === 'object') ? input.args : {},
    vars: {},
    steps: [],
  };

  const execLog: Array<{ step: number; tool_name?: string; ok: boolean; result?: any; error?: string }> = [];
  let i = 0;
  let stepsRun = 0;
  let completed = 0;

  while (i < actions.length && stepsRun < maxStep) {
    const action = actions[i];
    stepsRun++;
    const entry: { step: number; tool_name?: string; ok: boolean; result?: any; error?: string } = {
      step: i,
      ok: true,
    };

    // 1) 工具调用
    if (action.tool_name) {
      if (action.tool_name === 'run_tool_batch') {
        return { success: false, error: 'Recursion blocked: run_tool_batch cannot invoke itself.' };
      }
      const tool = registry.get(action.tool_name);
      if (!tool) {
        entry.ok = false;
        entry.error = `Tool not found: ${action.tool_name}`;
        execLog.push(entry);
        if (action.stop_on_error ?? stopOnError) break;
        i++;
        continue;
      }
      try {
        const resolvedArgs = resolvePlaceholders(action.arguments || {}, ctx);
        const res = await registry.execute(action.tool_name, resolvedArgs);
        ctx.steps[i] = res;
        entry.tool_name = action.tool_name;
        entry.ok = !!res.success;
        entry.result = summarize(res);
        if (res.success) completed++;
        else entry.error = res.error || 'tool returned failure';
      } catch (e: any) {
        ctx.steps[i] = { success: false, error: e.message };
        entry.ok = false;
        entry.error = e.message;
      }
    }

    // 2) set_var
    if (action.set_var && action.set_var.name) {
      ctx.vars[action.set_var.name] = evalSetVarValue(action.set_var.value, ctx);
    }

    execLog.push(entry);

    // 3) 控制流
    let jumped = false;
    if (action.goto_if && action.goto_if.to) {
      if (evalCondition(action.goto_if.cond, ctx)) {
        const target = labelMap.get(action.goto_if.to);
        if (target !== undefined) { i = target; jumped = true; }
      }
    }
    if (!jumped && action.goto) {
      const target = labelMap.get(action.goto);
      if (target !== undefined) { i = target; jumped = true; }
    }

    if (!jumped) i++;

    // 4) 错误停止
    if (!entry.ok && (action.stop_on_error ?? stopOnError)) {
      break;
    }
  }

  if (stepsRun >= maxStep) {
    execLog.push({ step: -1, ok: false, error: `maxstep (${maxStep}) reached — possible infinite loop guarded.` });
  }

  const failed = execLog.filter((e) => !e.ok).length;
  const overallOk = failed === 0;

  let payload: any;
  if (lastOnly && execLog.length > 0) {
    const last = execLog[execLog.length - 1];
    payload = {
      ok: overallOk,
      total: execLog.length,
      completed,
      last_step: last,
    };
  } else {
    payload = {
      ok: overallOk,
      total: execLog.length,
      completed,
      results: execLog,
    };
  }

  return {
    success: overallOk,
    error: overallOk ? undefined : `${failed}/${execLog.length} steps failed`,
    data: payload,
    stdout: JSON.stringify(payload, null, 2),
  };
}

export const toolBatchTool = {
  name: 'run_tool_batch',
  description:
    'Orchestrate multiple tool calls in sequence with control flow. Each action calls a registered tool; ' +
    'results can be referenced across steps via ${steps.N.field} (e.g. ${steps.0.stdout}), ${args.X} (batch args), ' +
    'and ${vars.X} (runtime vars). Supports set_var (with simple arithmetic like ${vars.count} + 1), ' +
    'goto (unconditional jump to a label), and goto_if ({cond, to}) for loops/branches. ' +
    'Useful for multi-step workflows (search → read → analyze → write) without round-trips. ' +
    'Read-only orchestration: it does not modify files itself.',
  execute: executeToolBatch,
  schema: {
    actions: 'JSON array of steps (or JSON string). Each step: {tool_name, arguments?, label?, set_var?, goto?, goto_if?, stop_on_error?}.',
    file_path: 'Path to a JSON file containing the actions array (mutually exclusive with "actions").',
    args: 'Optional JSON object providing values for ${args.X} placeholders.',
    stop_on_error: 'boolean (default true) — stop the whole batch on first failed step.',
    last_only: 'boolean (default false) — return only the last step compact summary (saves tokens).',
    maxstep: 'integer (default 500, max 2000) — max total executed steps (guards against infinite loops).',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      actions: { type: ['array', 'string'], description: 'Array of action steps, or a JSON string of such an array.' },
      file_path: { type: 'string', description: 'Path to a JSON file with the actions array.' },
      args: { type: 'object', description: 'Values for ${args.X} placeholders.' },
      stop_on_error: { type: 'boolean', description: 'Stop on first failure (default true).' },
      last_only: { type: 'boolean', description: 'Return only last step summary (default false).' },
      maxstep: { type: 'number', description: 'Max executed steps (default 500).' },
    },
    additionalProperties: true,
  },
};
