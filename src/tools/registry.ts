import { ToolResult } from '../types.js';
import { shellTool } from './shell.js';
import { readTool, writeTool, editTool, listTool, deleteTool, renameTool, copyTool, mkdirTool, statTool, appendTool, applyPatchTool } from './files.js';
import { grepContentTool } from './grep-content.js';
import { astSearchTool } from './ast-search.js';
import { findFilesTool } from './find-files.js';
import { treeTool } from './tree.js';
import { copyTreeTool } from './copy-tree.js';
import { tailTool } from './tail.js';
import { diffTool } from './diff.js';
import { toolBatchTool } from './tool-batch.js';
import { viewMediaTool } from './view-media.js';
import { browserTool } from './browser.js';
import { tokenUsageTool } from './token-usage.js';
import { lspTool } from './lsp.js';
import { delegateExternalAgentTool } from './external-agent.js';
import { webSearchTool, webFetchTool } from './web.js';
import { memorySearchTool, memoryWriteTool } from './memory.js';
import { memoryReadTool } from './memory-read.js';
import { memoryFileSearchTool } from './memory-file-search.js';
import { skillListTool, skillSearchTool, skillInstallTool, skillRemoveTool, skillExecTool } from './skills.js';
import { timeNowTool } from './time.js';
import { selfUpdateTool } from './self-update.js';
import { readSourceTool, listSourceTool } from './source-access.js';
import { proposeRepairTool } from './self-repair.js';
import { personaReadTool, personaUpdateTool } from './persona.js';

export interface Tool {
  name: string;
  description: string;
  execute: (args: any) => Promise<ToolResult>;
  schema: Record<string, string>;
  // Optional explicit OpenAPI-style JSON schema for native function-call parameters.
  // When provided, this is used instead of description-based type inference.
  jsonSchema?: Record<string, any>;
}

export type ToolProfile = 'minimal' | 'coding' | 'web' | 'full';

const TOOL_PROFILE_TOOL_NAMES: Record<Exclude<ToolProfile, 'full'>, ReadonlySet<string>> = {
  minimal: new Set([
    'memory_search',
    'memory_write',
    'time_now',
  ]),
  coding: new Set([
    'shell',
    'read',
    'write',
    'edit',
    'list',
    'delete',
    'rename',
    'copy',
    'mkdir',
    'stat',
    'append',
    'apply_patch',
    'grep_content',
    'ast_search',
    'find_files',
    'tree',
    'copy_tree',
    'tail',
    'diff',
    'browser',
    'run_tool_batch',
    'delegate_external_agent',
    'lsp',
    'memory_search',
    'memory_write',
  ]),
  web: new Set([
    'web_search',
    'web_fetch',
    'memory_search',
    'memory_write',
  ]),
};

function isToolProfile(value: string): value is ToolProfile {
  return value === 'minimal' || value === 'coding' || value === 'web' || value === 'full';
}

const spawnAgentTool: Tool = {
  name: 'spawn_agent',
  description:
    'Spawn a sub-agent to handle a specific task. Narrow its scope with allowed_tools (only these named tools are exposed/called), isolate file changes with fork (throwaway git worktree), or dispatch several independent tasks at once with tasks[] (concurrency 3). NOTE: the raw node_call code channel is governed by the VM sandbox, not allowed_tools — use fork for filesystem isolation.',
  schema: {
    agentId: 'ID of the agent to spawn (from config)',
    task: 'Task description to give the agent',
    context: 'Optional extra context to inject',
    maxSteps: 'Max reactor steps (default 8)',
    allowed_tools: 'array (optional) - restrict the named tools this sub-agent may see + call (e.g. ["read","grep_content"])',
    fork: 'boolean (optional) - run in a throwaway git worktree so file edits are isolated + mergeable (requires a git repo)',
    tasks: 'array (optional, batch mode) - [{agentId, task, allowed_tools?, maxSteps?, fork?}]; runs up to 3 concurrently, returns all results',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'ID of the agent to spawn (from config)' },
      task: { type: 'string', description: 'Task description to give the agent' },
      context: { type: 'string', description: 'Optional extra context to inject' },
      maxSteps: { type: 'number', description: 'Max reactor steps (default 8)' },
      allowed_tools: { type: 'array', items: { type: 'string' }, description: 'restrict named tools this sub-agent may see + call' },
      fork: { type: 'boolean', description: 'run in a throwaway git worktree (isolates file edits)' },
      tasks: {
        type: 'array',
        description: 'batch mode: independent tasks, concurrency 3',
        items: {
          type: 'object',
          properties: {
            agentId: { type: 'string' },
            task: { type: 'string' },
            allowed_tools: { type: 'array', items: { type: 'string' } },
            maxSteps: { type: 'number' },
            fork: { type: 'boolean' },
          },
          required: ['agentId', 'task'],
        },
      },
    },
    required: [],
    additionalProperties: true,
  },
  execute: async (params: any): Promise<ToolResult> => {
    const { spawnAgent, spawnAgentsBatch } = await import('../agents/spawner.js');

    const normAllowed = (raw: any): string[] | undefined => {
      if (Array.isArray(raw)) {
        const names = raw.map((v) => String(v || '').trim()).filter(Boolean);
        return names.length ? names : undefined;
      }
      if (typeof raw === 'string' && raw.trim()) {
        const names = raw.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
        return names.length ? names : undefined;
      }
      return undefined;
    };

    // Batch mode
    if (Array.isArray(params?.tasks) && params.tasks.length > 0) {
      const tasks = params.tasks.slice(0, 10).map((t: any) => ({
        agentId: String(t?.agentId || '').trim(),
        task: String(t?.task || '').trim(),
        maxSteps: t?.maxSteps != null ? Number(t.maxSteps) : undefined,
        allowedTools: normAllowed(t?.allowed_tools),
        fork: t?.fork === true,
      })).filter((t: any) => t.agentId && t.task);
      if (!tasks.length) return { success: false, error: 'tasks[] 每项需含 agentId 和 task' };
      const results = await spawnAgentsBatch(tasks, 3);
      const ok = results.filter((r) => r.success).length;
      const lines = results.map((r, i) =>
        `[${i + 1}] ${r.agentName}: ${r.success ? r.result : 'FAILED: ' + r.error}` +
        (r.fork ? `\n     (fork 分支 ${r.fork.branch} @ ${r.fork.worktreePath})` : ''));
      return {
        success: ok === results.length,
        stdout: `批量子代理 ${ok}/${results.length} 成功\n\n${lines.join('\n')}`,
        data: { results },
      };
    }

    const result = await spawnAgent({
      agentId: params?.agentId,
      task: params?.task,
      context: params?.context,
      maxSteps: params?.maxSteps,
      allowedTools: normAllowed(params?.allowed_tools),
      fork: params?.fork === true,
    });
    return {
      success: result.success,
      stdout: result.success
        ? `[${result.agentName}] ${result.result}` +
          (result.fork ? `\n\n(isolated in fork branch ${result.fork.branch} @ ${result.fork.worktreePath})` : '')
        : `[${result.agentName}] FAILED: ${result.error}`,
      data: result,
    };
  },
};

// 统一工具结果预算（字符）：兜底截断异常大的 stdout，保护小模型上下文。
// 默认宽松，避免误伤 read@deep 等合法大输出；可用 env 覆盖。
const TOOL_RESULT_BUDGET = (() => {
  const v = Number(process.env.SMALLCLAW_TOOL_RESULT_BUDGET);
  return Number.isFinite(v) && v >= 1000 ? Math.floor(v) : 24000;
})();

// 生成紧凑的参数提示（用于参数类错误自纠）
function schemaHint(tool: Tool): string {
  const entries = Object.entries(tool.schema || {});
  if (!entries.length) return '';
  const lines = entries.slice(0, 8).map(([k, d]) => `- ${k}: ${String(d).slice(0, 80)}`);
  let out = lines.join('\n');
  if (entries.length > 8) out += `\n- …(共 ${entries.length} 个参数)`;
  return out.length > 700 ? `${out.slice(0, 700)}…` : out;
}

class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private registerSafe(tool: Tool): void {
    try {
      this.register(tool);
    } catch (err: any) {
      const label = tool?.name || 'unknown_tool';
      const message = String(err?.message || err || 'unknown error');
      console.warn(`[tools] Failed to register "${label}": ${message}`);
    }
  }

  constructor() {
    // Core filesystem + shell
    this.registerSafe(shellTool);
    this.registerSafe(readTool);
    this.registerSafe(writeTool);
    this.registerSafe(editTool);
    this.registerSafe(listTool);
    this.registerSafe(deleteTool);
    this.registerSafe(grepContentTool);
    // Structural (AST) code search — complementary to grep_content (regex)
    this.registerSafe(astSearchTool);
    // File name/path lookup (glob) — complements grep_content (content search)
    this.registerSafe(findFilesTool);
    // Recursive directory tree — complements list (single-level)
    this.registerSafe(treeTool);
    // Recursive directory copy (cp -r) — complements copy (single file)
    this.registerSafe(copyTreeTool);
    // Read last N lines — complements read (windowed from start)
    this.registerSafe(tailTool);
    // Two-file line diff (unified style) — complements apply_patch (apply)
    this.registerSafe(diffTool);
    // Multi-tool batch orchestration meta-tool (control flow across tools)
    this.registerSafe(toolBatchTool);
    // Media inspection tool (image/video/audio metadata + image dimensions)
    this.registerSafe(viewMediaTool);
    // Web automation (verb-based, playwright) — lets a local model DO web tasks
    this.registerSafe(browserTool);
    // Token usage reporter (session-level LLM token accumulation)
    this.registerSafe(tokenUsageTool);
    // Code intelligence via LSP (definition/references/hover/symbols)
    this.registerSafe(lspTool);
    // Delegate hard tasks to external agent runners (ACP/stdio)
    this.registerSafe(delegateExternalAgentTool);
    // Additional filesystem utilities
    this.registerSafe(renameTool);
    this.registerSafe(copyTool);
    this.registerSafe(mkdirTool);
    this.registerSafe(statTool);
    this.registerSafe(appendTool);
    this.registerSafe(applyPatchTool);
    // Web tools
    this.registerSafe(webSearchTool);
    this.registerSafe(webFetchTool);
    // Memory tools
    this.registerSafe(memoryWriteTool);
    this.registerSafe(memorySearchTool);
    this.registerSafe(memoryReadTool);
    this.registerSafe(memoryFileSearchTool);
    // Time tool (system clock — no network)
    this.registerSafe(timeNowTool);
    // ClawHub skills tools
    this.registerSafe(skillListTool);
    this.registerSafe(skillSearchTool);
    this.registerSafe(skillInstallTool);
    this.registerSafe(skillRemoveTool);
    this.registerSafe(skillExecTool);
    // Self-update tool
    this.registerSafe(selfUpdateTool);
    // Self-repair tools (source read + repair proposal)
    this.registerSafe(readSourceTool);
    this.registerSafe(listSourceTool);
    this.registerSafe(proposeRepairTool);
    // Persona / memory growth tools
    this.registerSafe(personaReadTool);
    this.registerSafe(personaUpdateTool);
    // Multi-agent spawn tool
    this.registerSafe(spawnAgentTool);
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  private listByProfile(profile: ToolProfile = 'full'): Tool[] {
    if (profile === 'full') return this.list();
    const toolNames = TOOL_PROFILE_TOOL_NAMES[profile];
    return this.list().filter((tool) => toolNames.has(tool.name));
  }

  resolveToolProfile(profile?: string | null): ToolProfile {
    const normalized = String(profile || '').trim().toLowerCase();
    return isToolProfile(normalized) ? normalized : 'full';
  }

  async execute(toolName: string, args: any, allowedTools?: string[]): Promise<ToolResult> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      return {
        success: false,
        error: `Tool not found: ${toolName}. Available tools: ${Array.from(this.tools.keys()).join(', ')}`
      };
    }

    // Per-run tool allowlist enforcement (e.g. narrowed sub-agents)
    if (Array.isArray(allowedTools) && allowedTools.length > 0 && !allowedTools.includes(toolName)) {
      return {
        success: false,
        error: `Tool "${toolName}" is not permitted for this agent. Allowed tools: ${allowedTools.join(', ')}`,
      };
    }

    // 参数类错误的可自纠提示（小模型常写错参数名/漏必填）
    const paramErrorRe = /\b(required|missing|must be|must appear|invalid|unsupported|expected|not a (file|directory)|no target paths|is required)\b/i;

    try {
      const result = await tool.execute(args);
      // 统一结果预算：兜底截断异常大的 stdout，保护小模型上下文（默认宽松，避免误伤 read@deep 等合法输出）
      if (result && typeof result.stdout === 'string' && result.stdout.length > TOOL_RESULT_BUDGET) {
        result.stdout = `${result.stdout.slice(0, TOOL_RESULT_BUDGET)}\n...[结果超过预算 ${TOOL_RESULT_BUDGET} 字符已截断，共 ${result.stdout.length} 字符]`;
      }
      // 失败且疑似参数问题：附上该工具参数说明，便于模型下一次写对
      if (result && result.success === false && result.error && paramErrorRe.test(result.error)) {
        const hint = schemaHint(tool);
        if (hint) result.error = `${result.error}\n[参数提示] ${tool.name} 可用参数:\n${hint}`;
      }
      return result;
    } catch (error: any) {
      const msg = `Tool execution failed: ${error.message}`;
      const hint = schemaHint(tool);
      return {
        success: false,
        error: paramErrorRe.test(msg) && hint ? `${msg}\n[参数提示] ${tool.name} 可用参数:\n${hint}` : msg,
      };
    }
  }

  getToolSchemas(profile: ToolProfile = 'full', onlyNames?: string[]): string {
    let tools = this.listByProfile(profile);
    if (Array.isArray(onlyNames) && onlyNames.length > 0) {
      const allow = new Set(onlyNames);
      tools = tools.filter((t) => allow.has(t.name));
    }
    return tools.map(tool => {
      const schemaStr = Object.entries(tool.schema)
        .map(([key, desc]) => `  - ${key}: ${desc}`)
        .join('\n');
      
      return `${tool.name}: ${tool.description}\n${schemaStr}`;
    }).join('\n\n');
  }

  getToolDefinitionsForChat(profile: ToolProfile = 'full', onlyNames?: string[]): any[] {
    let tools = this.listByProfile(profile);
    if (Array.isArray(onlyNames) && onlyNames.length > 0) {
      const allow = new Set(onlyNames);
      tools = tools.filter((t) => allow.has(t.name));
    }
    const inferParamSchema = (key: string, desc: string): any => {
      const k = String(key || '').toLowerCase();
      const d = String(desc || '').toLowerCase();
      if (/\b(true|false|boolean)\b/.test(d) || /\b(force|strict|recursive|enabled|disabled|stream|dry_run|dry run)\b/.test(k)) {
        return { type: 'boolean', description: String(desc || '') };
      }
      if (
        /\b(integer|number|count|max|min|limit|timeout|ms|seconds?|minutes?|days?)\b/.test(d)
        || /(max|min|count|limit|timeout|num|days|hours|minutes|seconds|retries|offset|line|chars|size|port)$/.test(k)
      ) {
        return { type: 'number', description: String(desc || '') };
      }
      if (/\bjson\b/.test(d) || /(args|params|options|payload|values)_?json$/.test(k)) {
        return {
          anyOf: [
            { type: 'object' },
            { type: 'array' },
            { type: 'string' },
          ],
          description: String(desc || ''),
        };
      }
      return { type: 'string', description: String(desc || '') };
    };
    const buildInferredParameters = (tool: Tool): Record<string, any> => {
      const properties: Record<string, any> = {};
      for (const [key, desc] of Object.entries(tool.schema || {})) {
        properties[key] = inferParamSchema(key, String(desc || ''));
      }
      return {
        type: 'object',
        properties,
        additionalProperties: true,
      };
    };
    const normalizeExplicitParameters = (tool: Tool): Record<string, any> | null => {
      const raw = tool.jsonSchema;
      if (!raw || typeof raw !== 'object') return null;
      const normalized: Record<string, any> = { ...raw };
      if (normalized.type == null) normalized.type = 'object';
      if (normalized.properties == null) normalized.properties = {};
      if (normalized.additionalProperties == null) normalized.additionalProperties = true;
      return normalized;
    };
    return tools.map((tool) => {
      const explicitParameters = normalizeExplicitParameters(tool);
      const inferredParameters = buildInferredParameters(tool);
      const parameters = explicitParameters || inferredParameters;
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters,
        },
      };
    });
  }

  isToolEnabled(toolName: string, enabledTools: string[]): boolean {
    return enabledTools.includes(toolName);
  }
}

// Singleton instance
let registryInstance: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!registryInstance) {
    registryInstance = new ToolRegistry();
  }
  return registryInstance;
}
