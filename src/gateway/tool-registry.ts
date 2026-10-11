/**
 * tool-registry.ts — 工具定义装配（从 server-v2.ts 抽出）
 *
 * 职责（Phase 2a + 2b）：
 *  - 模型档位推断 / 工具描述压缩纯函数（Phase 2a）
 *  - buildTools() 及其依赖的 server-v2 内部工具构建器：agentShellEnabled、
 *    shellExecToolDefinition、MCP 簇（MCP_TOOL_PREFIX / sanitizeMcpNamePart /
 *    normalizeMcpInputSchema / collectMcpToolEntries / buildMcpToolDefinitions）
 *    （Phase 2b）
 *
 * 设计约束（见 docs/server-v2-split-plan.md）：
 *  - 本模块不依赖 server-v2 的运行时状态；仅用 `import type` 引入类型（编译期擦除）。
 *  - buildTools 需要的 isOrchestrationSkillEnabled（依赖 server-v2 的 skillsManager
 *    单例，无法平移）通过 deps 参数注入，由 server-v2 在调用点传入，避免循环依赖。
 *  - 其余工具定义提供方（browser/desktop/office/image/file-batch/knowledge/plan/
 *    mcp/agent-builder/multi-agent）均为已验证不反向依赖 server-v2 的叶子模块。
 */

import type { ModelTier } from './server-v2';
import path from 'path';
import { getConfig } from '../config/config';
import { getKnowledgeToolDefinitions } from '../tools/knowledge';
import { planToolDefinitions } from './plan-mode';
import { getMCPManager, type MCPTool } from './mcp-manager';
import { getBrowserToolDefinitions } from './browser-tools';
import { getDesktopToolDefinitions } from './desktop-tools';
import { getOfficeToolDefinitions } from '../tools/office';
import { getImageToolDefinitions } from '../tools/image';
import { getFileBatchToolDefinitions } from '../tools/file-batch';
import { registerAgentBuilderTools } from './agent-builder-integration';
import { getOrchestrationConfig } from '../orchestration/multi-agent';

export function getModelTier(): ModelTier {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfig } = require('../config/config.js');
    const cfg = getConfig().getConfig()?.models || {};
    const explicit = String(cfg.tier || '').trim().toLowerCase();
    if (explicit === 'small' || explicit === 'mid' || explicit === 'large') return explicit;
    const modelId = String(cfg.primary || '').toLowerCase();
    if (/[:\-_](0\.5|1|1\.5|2|3|4)b/.test(modelId)) return 'small';
    if (/[:\-_](5|6|7|8|9)b/.test(modelId)) return 'mid';
    return 'large';
  } catch {
    return 'large';
  }
}

/** 取描述首句并截断，用于小模型档位的紧凑化。 */
function compactToolDescription(desc: string, limit = 180): string {
  const trimmed = String(desc || '').trim();
  if (!trimmed) return '';
  const firstSentence = trimmed.split(/(?<=[。.!?])\s+|\n/)[0] || trimmed;
  return firstSentence.slice(0, limit);
}

/**
 * 按档位压缩 tool 定义的描述与参数说明，降低 token 占用。
 * 返回新数组，不修改入参。
 */
export function applyToolCompactness(defs: any[], tier: ModelTier): any[] {
  const descLimit = tier === 'small' ? 180 : 300;
  const paramLimit = tier === 'small' ? 60 : 120;
  return defs.map((d: any) => {
    if (!d?.function) return d;
    const f = d.function;
    const clone = { ...d, function: { ...f } };
    clone.function.description = f.shortDescription || compactToolDescription(f.description || '', descLimit);
    delete clone.function.shortDescription;
    const props = clone.function.parameters?.properties;
    if (props && typeof props === 'object') {
      clone.function.parameters = {
        ...clone.function.parameters,
        properties: Object.fromEntries(
          Object.entries(props).map(([k, v]: [string, any]) => {
            if (!v || typeof v !== 'object') return [k, v];
            const { description, ...rest } = v;
            if (typeof description === 'string') rest.description = description.slice(0, paramLimit);
            return [k, { ...rest }];
          })
        ),
      };
    }
    return clone;
  });
}

// confinement + dangerous-command filters), but it was never exposed to the
// agent, so any command outside run_command's allowlist had no valid outlet.
// It stays off by default because enabling it hands the model a real shell.
// Named "shell_exec" on purpose: naming it "shell" would make it match the
// legacy config.tools.enabled entry and silently filter every other tool out.
export function agentShellEnabled(): boolean {
  try {
    const cfg = getConfig().getConfig() as any;
    return cfg?.tools?.permissions?.shell?.expose_to_agent === true;
  } catch {
    return false;
  }
}

function shellExecToolDefinition(): any {
  return {
    type: 'function',
    function: {
      name: 'shell_exec',
      description: 'Run a real terminal command in the workspace and return its output. Use when run_command rejects a command (run_command is only a GUI launcher). Confined to the workspace; destructive patterns are blocked.',
      parameters: {
        type: 'object', required: ['command'],
        properties: {
          command: { type: 'string', description: 'Command to run, e.g. "npm test" or "git status". Paths outside the workspace are rejected.' },
          cwd: { type: 'string', description: 'Optional working directory, defaults to the workspace root.' },
        },
      },
    },
  };
}

// ─── MCP Tool Wiring ──────────────────────────────────────────────────────────

export const MCP_TOOL_PREFIX = 'mcp__';

function sanitizeMcpNamePart(value: string): string {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'x';
}

function normalizeMcpInputSchema(schema: any): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { type: 'object', properties: {}, additionalProperties: true };
  }
  const normalized: any = { ...schema };
  if (normalized.type !== 'object') normalized.type = 'object';
  if (!normalized.properties || typeof normalized.properties !== 'object' || Array.isArray(normalized.properties)) {
    normalized.properties = {};
  }
  return normalized;
}

interface McpToolEntry {
  exposed: string;
  serverId: string;
  toolName: string;
  definition: any;
}

export function collectMcpToolEntries(reserved?: Set<string>): McpToolEntry[] {
  let tools: MCPTool[] = [];
  try {
    tools = getMCPManager().getAllTools();
  } catch {
    return [];
  }
  const entries: McpToolEntry[] = [];
  const used = new Set<string>(reserved || []);
  for (const tool of tools) {
    const base = `${MCP_TOOL_PREFIX}${sanitizeMcpNamePart(tool.serverId)}__${sanitizeMcpNamePart(tool.name)}`;
    let exposed = base.slice(0, 64);
    let suffix = 2;
    while (used.has(exposed)) {
      exposed = `${base.slice(0, 60)}_${suffix++}`;
    }
    used.add(exposed);
    const rawDescription = String(tool.description || tool.name || '').trim();
    entries.push({
      exposed,
      serverId: tool.serverId,
      toolName: tool.name,
      definition: {
        type: 'function',
        function: {
          name: exposed,
          description: `[MCP:${tool.serverName || tool.serverId}] ${rawDescription.slice(0, 1000) || tool.name}`,
          parameters: normalizeMcpInputSchema(tool.inputSchema),
        },
      },
    });
  }
  return entries;
}

function buildMcpToolDefinitions(reserved?: Set<string>): any[] {
  return collectMcpToolEntries(reserved).map(entry => entry.definition);
}

export function buildTools(tier?: ModelTier, deps?: { isOrchestrationSkillEnabled?: () => boolean }): any[] {
  const effectiveTier = tier ?? getModelTier();
  const isOrchestrationSkillEnabled = deps?.isOrchestrationSkillEnabled ?? (() => false);
  const toolDefs = [
    {
      type: 'function',
      function: {
        name: 'list_files',
        shortDescription: 'List workspace files with sizes, largest first. Optional pattern/sort_by/max_entries.',
        description: 'List workspace files with sizes, sorted by size DESCENDING (largest first) by default. The first line is a summary "[N files, total SIZE, updated DATE]" — use it to answer "how many files / total size / newest file". Optional: pattern (filter by name, e.g. ".pdf" or "report"), sort_by ("size"|"name"|"mtime"; mtime shows modified time and sorts newest first), max_entries (limit output for large folders). Directories are marked with trailing "/".',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Optional: only list files whose name contains this substring (case-insensitive), e.g. ".pdf", "report".' },
            sort_by: { type: 'string', enum: ['size', 'name', 'mtime'], description: 'Sort order. Default "size" (largest first). "name" = alphabetical. "mtime" = newest modified first and each entry shows its modified time.' },
            max_entries: { type: 'number', description: 'Optional: maximum number of file entries to return (useful for large folders).' },
          },
          required: [],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'grep_content',
        shortDescription: 'Find where something is written: regex-search file contents, returns "file:line: text" matches.',
        description: 'Search file contents inside the workspace with a regex and return "file:line: text" matches. Use when you need to FIND where something is written (a config key, function name, string) — do NOT guess file by file. Patterns are JavaScript RegExp (e.g. "compactionThreshold", "memoryFlush.*threshold"). Large dirs (node_modules/.git/dist) are skipped; invalid regex returns an error. If the first pattern returns NO matches, do NOT conclude the file lacks the content: re-search with shorter or synonymous keywords (e.g. "产物" → "交付物"/"产出"/"验收"/"deliverable"), and if the document may be English also try English keywords (e.g. deliverable/output/acceptance/criteria). When searching a specific file use path="FULLPLAN.md" style exact filenames (note: project docs like FULLPLAN.md live in the workspace directory).',
        parameters: {
          type: 'object', required: ['pattern'],
          properties: {
            pattern: { type: 'string', description: 'regex to search for (JavaScript RegExp syntax)' },
            path: { type: 'string', description: 'file or directory to search (default: workspace root)' },
            limit: { type: 'number', description: 'max matches to return (default 100, max 500)' },
            case_sensitive: { type: 'boolean', description: 'default false (case-insensitive)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        shortDescription: 'Read a file with line numbers. Use before editing.',
        description: 'Read a file with line numbers. Use before editing.',
        parameters: {
          type: 'object', required: ['filename'],
          properties: { filename: { type: 'string', description: 'Name of the file to read' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        shortDescription: 'Create a NEW file (fails if exists). Needs filename + content; large files: skeleton first, then insert_after.',
        description: 'Create a NEW file (fails if filename already exists). Requires BOTH "filename" and "content". For LARGE files (HTML reports, long docs > 80 lines or > 3000 chars): do NOT write the entire file in one call — it will get truncated. Instead: (1) create_file with just the skeleton (doctype + head + empty body + closing tags), then (2) use insert_after to append each section one at a time. Always end HTML files with </html>. If the file already exists and you want to create a DIFFERENT new file, choose a new filename — do not reuse the source filename.',
        parameters: {
          type: 'object', required: ['filename', 'content'],
          properties: {
            filename: { type: 'string', description: 'Name of the new file, e.g. "report.html". Must not already exist.' },
            content: { type: 'string', description: 'Full file content. For large files, write only the skeleton first, then use insert_after.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_lines',
        description: 'Replace a line range in an existing file (1-based, inclusive).',
        parameters: {
          type: 'object', required: ['filename', 'start_line', 'end_line', 'new_content'],
          properties: {
            filename: { type: 'string' },
            start_line: { type: 'number', description: 'First line to replace (1-based)' },
            end_line: { type: 'number', description: 'Last line to replace (1-based, inclusive)' },
            new_content: { type: 'string', description: 'New content to insert' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'insert_after',
        description: 'Insert lines after a line number (0 = beginning).',
        parameters: {
          type: 'object', required: ['filename', 'after_line', 'content'],
          properties: {
            filename: { type: 'string' },
            after_line: { type: 'number', description: 'Line number to insert after (0 = beginning)' },
            content: { type: 'string', description: 'Content to insert' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_lines',
        description: 'Delete specific lines from a file.',
        parameters: {
          type: 'object', required: ['filename', 'start_line', 'end_line'],
          properties: {
            filename: { type: 'string' },
            start_line: { type: 'number', description: 'First line to delete (1-based)' },
            end_line: { type: 'number', description: 'Last line to delete (1-based, inclusive)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'find_replace',
        description: 'Find exact text in a file and replace it.',
        parameters: {
          type: 'object', required: ['filename', 'find', 'replace'],
          properties: {
            filename: { type: 'string' },
            find: { type: 'string', description: 'Exact text to find' },
            replace: { type: 'string', description: 'Text to replace with' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file from the workspace.',
        parameters: {
          type: 'object', required: ['filename'],
          properties: { filename: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_note',
        description: 'Write a note to today\'s intraday memory (persists through the day, auto-cleaned at day end, included in next boot context).',
        parameters: {
          type: 'object', required: ['content'],
          properties: {
            content: { type: 'string', description: 'Note content: what you found, decided, or want to remember' },
            tag: { type: 'string', description: 'Optional: task, debug, discovery, or general (default general)' },
            task_id: { type: 'string', description: 'Optional task ID this note relates to' },
            step: { type: 'string', description: 'Legacy: mapped to tag' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_search',
        shortDescription: 'Search the web for current info; returns titles + snippets + URLs. Follow up with web_fetch.',
        description: 'Search the web for current information. Use web_fetch on result URLs for full content.',
        parameters: {
          type: 'object', required: ['query'],
          properties: { query: { type: 'string', description: 'Search query' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: 'Fetch full text of a webpage URL. Use AFTER web_search to get real page content, details and context.',
        parameters: {
          type: 'object', required: ['url'],
          properties: { url: { type: 'string', description: 'Full URL to fetch (from web_search results or any URL)' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        shortDescription: 'Launch GUI apps or open files for the user (notepad, calc, word, "start file.docx"). Not a shell.',
        description: 'Launch GUI apps or open files for the USER (visible on their screen). NOT a shell: no pipelines, globs, redirects, switches; returns no output; do NOT pass file-size/stat commands like du, ls, dir, stat. Do NOT open Chrome/Edge here (no debug port; use browser_* tools for web). Use for: GUI apps (notepad, calc, word, excel, powerpoint), opening a file with the system default program ("start report.docx"; if no default app the OS picker appears - do not retry), opening a path in VS Code / Explorer.',
        parameters: {
          type: 'object', required: ['command'],
          properties: {
            command: { type: 'string', description: 'Bare app name ("notepad", "calc", "word"); app + path ("code D:\\project", "word report.docx" - only notepad/code/explorer/word/winword take a path); file via system default ("start report.docx", "open report.docx"); or a URL. Rejected: "powershell <cmd>", switches, pipes, shell metacharacters. No "chrome"/"msedge" - use browser_* instead.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_code',
        description: 'Execute a short code snippet for REAL and return its actual output. Use this whenever the user asks "write code and show the result", "what does this script output", or any code whose output must be真实运行结果. Supports language "python" (and "javascript"/"node"). The code runs in the workspace directory with a 30s timeout; stdout+stderr (up to 3000 chars) are returned verbatim. Never invent an output — run the code.',
        parameters: {
          type: 'object', required: ['language', 'code'],
          properties: {
            language: { type: 'string', enum: ['python', 'javascript', 'node'], description: 'Runtime language. python uses the configured SMALLCLAW_PYTHON; javascript/node uses node.' },
            code: { type: 'string', description: 'The code to execute. For python, write a complete script (imports included).' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'start_task',
        description: 'Start a multi-step task (browser automation, complex file ops) that runs with a sliding context window for 20+ steps.',
        parameters: {
          type: 'object', required: ['goal'],
          properties: {
            goal: { type: 'string', description: 'What the task should accomplish (be specific)' },
            max_steps: { type: 'number', description: 'Maximum steps (default 25)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'task_control',
        description: 'Query and control background tasks (list/latest/get/resume/rerun/pause/cancel/delete).',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', description: 'list, latest, get, resume, rerun, pause, cancel, delete' },
            task_id: { type: 'string', description: 'Required for get/pause/cancel/delete; optional for resume/rerun' },
            status: { type: 'string', description: 'Optional filter: queued|running|paused|stalled|needs_assistance|failed|complete|waiting_subagent' },
            include_all_sessions: { type: 'boolean', description: 'List across all sessions; default false (scoped)' },
            limit: { type: 'number', description: 'Max tasks (default 20, max 100)' },
            note: { type: 'string', description: 'Operator note appended on resume/rerun' },
            confirm: { type: 'boolean', description: 'Required true for cancel/delete' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'schedule_job',
        description: 'Manage scheduled jobs (list/create/update/pause/resume/delete/run_now) for recurring or time-based automation.',
        parameters: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', description: 'list, create, update, pause, resume, delete, run_now' },
            job_id: { type: 'string', description: 'Required for update/pause/resume/delete/run_now' },
            name: { type: 'string', description: 'Job name (create/update)' },
            instruction_prompt: { type: 'string', description: 'What the scheduled run should do (create/update)' },
            schedule: {
              type: 'object',
              properties: {
                kind: { type: 'string', description: 'recurring or one_shot' },
                cron: { type: 'string', description: 'Cron expression for recurring jobs' },
                run_at: { type: 'string', description: 'ISO timestamp for one-shot jobs' },
              },
            },
            timezone: { type: 'string', description: 'IANA timezone (e.g. America/New_York)' },
            delivery: {
              type: 'object',
              properties: {
                channel: { type: 'string', description: 'web, telegram, discord, whatsapp' },
                session_target: { type: 'string', description: 'main or isolated' },
              },
            },
            model_override: { type: 'string', description: 'Optional model override for this job' },
            confirm: { type: 'boolean', description: 'Must be true for create/update/delete. When the user has already explicitly asked you to create/update/delete a job in this conversation, set confirm=true in the SAME call — do not stall waiting for a second confirmation. Also accepts the string "true".' },
            limit: { type: 'number', description: 'Optional max jobs for list' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'parse_schedule_pattern',
        description: 'Parse natural-language schedule patterns (e.g. "daily at 3:13pm") to cron expressions. Use before creating schedules.',
        parameters: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', description: 'Natural language pattern, e.g. "daily at 3:13pm", "every weekday at 9am", "weekly on monday"' },
            timezone: { type: 'string', description: 'Optional IANA timezone (e.g. America/New_York). Defaults to UTC.' },
          },
        },
      },
    },
    // Browser automation tools
    ...getBrowserToolDefinitions(),
    ...getDesktopToolDefinitions(),
    // Orchestration tool — only exposed when orchestration is enabled
    ...(() => {
      const oc = getOrchestrationConfig();
      if (!oc?.enabled || !isOrchestrationSkillEnabled()) return [];
      return [{
        type: 'function' as const,
        function: {
          name: 'request_secondary_assist',
          description: 'Request guidance from the secondary AI advisor when stuck, need a plan, or have failed repeatedly. Returns a structured action plan. Use proactively for complex tasks.',
          parameters: {
            type: 'object',
            required: ['reason'],
            properties: {
              reason: { type: 'string', description: 'Why you need help: planning, stuck, repeated failures, risky edit, etc.' },
              mode:   { type: 'string', enum: ['planner', 'rescue'], description: 'planner = upfront strategy; rescue = stuck/failing' },
            },
          },
        },
      }];
    })(),
    // ── Sub-agent tools ── shown based on subagent_mode toggle ────────────────────────────────────
    ...(() => {
      const subagentMode = (getConfig().getConfig() as any).orchestration?.subagent_mode === true;
      if (subagentMode) {
        // Full Claude Cowork–style: free-form arbitrary spawn (multi-agent ON)
        return [{
          type: 'function' as const,
          function: {
            name: 'subagent_spawn',
            description:
              'Spawn a child agent in an isolated session for a parallel subtask. The current task pauses until ALL spawned children complete. Do NOT call recursively from inside a child task.',
            parameters: {
              type: 'object',
              required: ['task_title', 'task_prompt'],
              properties: {
                task_title:      { type: 'string', description: 'Short title for the sub-agent task' },
                task_prompt:     { type: 'string', description: 'Full instruction for the sub-agent (be precise)' },
                context_snippet: { type: 'string', description: 'Relevant context pre-extracted (file contents, URLs, etc.)' },
                expected_output: { type: 'string', description: 'What the sub-agent should return when done' },
                profile: {
                  type: 'string',
                  enum: ['file_editor', 'researcher', 'shell_runner', 'reader_only'],
                  description: 'Tool access: file_editor=read/write files, researcher=read+web, shell_runner=run_command, reader_only=read only',
                },
              },
            },
          },
        }];
      }
      // Conservative 4B-safe mode: fixed specialist templates (multi-agent OFF)
      return [{
        type: 'function' as const,
        function: {
          name: 'delegate_to_specialist',
          description:
            'Delegate a focused, self-contained subtask to a specialist sub-agent (file edits, research lookups, shell commands). The current task pauses until it completes.',
          parameters: {
            type: 'object',
            required: ['type', 'input'],
            properties: {
              type: {
                type: 'string',
                enum: ['file_editor', 'researcher', 'shell_runner', 'reader_only'],
                description: 'Specialist role',
              },
              input: { type: 'string', description: 'Precise instruction for the specialist' },
              context_snippet: { type: 'string', description: 'Relevant context (file content, URL, etc.)' },
              target_file: { type: 'string', description: 'File to operate on (for file_editor)' },
            },
          },
        },
      }];
    })(),
    // Modular subagent spawning — create custom specialists on the fly
    {
      type: 'function' as const,
      function: {
        name: 'spawn_subagent',
        description:
          'Create and spawn a specialized sub-agent with dynamically defined tools, constraints and instructions. ' +
          'Configs are persisted and reusable (call the same subagent_id again later).',
        parameters: {
          type: 'object',
          required: ['subagent_id', 'task_prompt'],
          properties: {
            subagent_id: {
              type: 'string',
              description: 'Unique persistent id, e.g. "news_researcher_v1" (saved to .smallclaw/subagents/)',
            },
            task_prompt: {
              type: 'string',
              description: 'The specific task for this subagent to complete',
            },
            context_data: {
              type: 'object',
              description: 'Optional context: snapshots, URLs, previously extracted text, etc.',
            },
            create_if_missing: {
              type: 'object',
              description: 'If subagent does not exist, create it with these specifications (saved to .smallclaw/subagents/)',
              properties: {
                description: { type: 'string', description: 'What this subagent specializes in' },
                allowed_tools: { type: 'array', items: { type: 'string' }, description: 'Tools it can access. Wildcards ok, e.g. "browser_*", "web_fetch", "read_file"' },
                forbidden_tools: { type: 'array', items: { type: 'string' }, description: 'Tool blacklist, e.g. ["run_command", "create_file"]' },
                system_instructions: { type: 'string', description: 'How this subagent should think and behave' },
                constraints: { type: 'array', items: { type: 'string' }, description: 'Hard rules it MUST follow, e.g. "Extract ONLY facts"' },
                success_criteria: { type: 'string', description: 'When the subagent has completed successfully' },
                max_steps: { type: 'number', description: 'Max tool calls before stopping (default 20)' },
                timeout_ms: { type: 'number', description: 'Max milliseconds to wait (default 300000)' },
                model: { type: 'string', description: 'Optional model override' },
              },
              required: ['description', 'allowed_tools', 'system_instructions', 'constraints', 'success_criteria'],
            },
          },
        },
      },
    },
    // ── Memory Tools ──────────────────────────────────────────────────────────
    {
      type: 'function',
      function: {
        name: 'memory_browse',
        description: 'List category sections in USER.md or SOUL.md. Call before memory_write to pick the right category.',
        parameters: {
          type: 'object',
          required: ['file'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_write',
        description: 'Write a fact/update to USER.md or SOUL.md under a category (creates it if missing). Use memory_browse first.',
        parameters: {
          type: 'object',
          required: ['file', 'category', 'content'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
            category: { type: 'string', description: 'Category section name (e.g. "coding", "communication_style"). Use existing when possible.' },
            content: { type: 'string', description: 'The fact/update to write. Specific and concise. Example: "Prefers vanilla JS over frameworks"' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'memory_read',
        description: 'Read the full contents of USER.md or SOUL.md.',
        parameters: {
          type: 'object',
          required: ['file'],
          properties: {
            file: { type: 'string', description: '"user" for USER.md or "soul" for SOUL.md' },
          },
        },
      },
    },
    // ── Agent Builder Integration Tools (opt-in: config.tools.agent_builder === true) ──
  ] as any[];
  try {
    const cfg = (getConfig().getConfig() as any) ?? {};
    if (cfg?.tools?.agent_builder === true) registerAgentBuilderTools(toolDefs);
  } catch {
    /* config read failure - skip agent builder tools */
  }
  toolDefs.push(...getOfficeToolDefinitions());
  toolDefs.push(...getImageToolDefinitions());
  toolDefs.push(...getFileBatchToolDefinitions());
  const knowledgeDir = path.join(__dirname, '..', '..', 'knowledge');
  toolDefs.push(...getKnowledgeToolDefinitions(knowledgeDir));
  if (agentShellEnabled()) toolDefs.push(shellExecToolDefinition());
  toolDefs.push(...planToolDefinitions());
  toolDefs.push(...buildMcpToolDefinitions(new Set(toolDefs.map((t: any) => String(t?.function?.name || '')))));
  if (effectiveTier !== 'large') {
    const fullChars = toolDefs.reduce((n: number, t: any) => n + String(t?.function?.description || '').length, 0);
    const compacted = applyToolCompactness(toolDefs, effectiveTier);
    const shortChars = compacted.reduce((n: number, t: any) => n + String(t?.function?.description || '').length, 0);
    console.log(`[tools] compact descriptions (${effectiveTier}): ${fullChars} -> ${shortChars} chars (${Math.round((1 - shortChars / Math.max(fullChars, 1)) * 100)}% saved)`);
    return compacted;
  }
  return toolDefs;
}

// ─── Intent-based tool filtering (from server-v2.ts, Phase 2c) ───

// Intent detection: returns matched tool categories for the message
export function detectToolCategories(text: string): Set<string> {
  const lower = String(text || '').toLowerCase();
  const cats = new Set<string>();
  const WEB = ['search', 'find', 'look up', 'google', 'what is', 'who is', 'news', 'latest', 'research', 'look into', 'check online', 'summarize', 'article', 'read about', '查一下', '搜索', '查找', '资讯', '新闻', '搜一搜', '百度'];
  const BROWSER = ['open', 'login', 'log in', 'website', 'click', 'fill', 'form', 'navigate', 'go to', 'browse', 'sign in', 'download', '打开网页', '浏览器', '登录', '网址'];
  const DESKTOP = ['desktop', 'screenshot', 'window', 'focus window', 'app', 'screen', 'type into', 'drag', 'clipboard', '桌面', '截图', '窗口'];
  const FILES = ['read file', 'write file', 'edit file', 'create file', 'modify', 'replace', 'open file', 'delete file', 'rename', 'copy file', 'make a file', 'update the file', 'change the file', 'save to', '文件', '读取', '列出', '目录', '工作区', '看看', '读一下', '列表', '打开文件', '文件夹', '里面有哪些', '有什么文件'];
  const TASK = ['task', 'background', 'run this', 'start a', 'status', 'paused', 'resume', 'in progress', 'what tasks', 'running tasks', '任务', '待办', '进度', '后台'];
  const SCHEDULE = ['schedule', 'every day', 'every week', 'at ', 'recurring', 'cron', 'automate', 'remind me', 'daily', 'weekly', '定时', '提醒', '每天', '每周', '周期'];
  const SHELL = ['run command', 'execute', 'terminal', 'powershell', 'script', 'command line', 'cmd', 'bash', '命令', '终端', '脚本', '运行'];
  const MEMORY = ['remember', 'note that', 'save that', 'write that down', 'dont forget', "don't forget", 'keep in mind', 'update my', 'add to my', 'i prefer', 'i like', 'i hate', 'i use', 'my name', 'call me', 'i work', 'my project', 'my stack', '记忆', '记住', '记得', '忘了', '以前', '上次', '偏好', '喜欢'];
  const DEBUG = ['why', 'error', 'failed', 'how does', 'architecture', 'debug', 'caused', 'broke', 'not working', 'explain how', 'whats wrong', "what's wrong", '为什么', '报错', '怎么回事', '坏了', '查原因', '分析原因'];
  if (WEB.some(k => lower.includes(k))) cats.add('web');
  if (BROWSER.some(k => lower.includes(k))) cats.add('browser');
  if (DESKTOP.some(k => lower.includes(k))) cats.add('desktop');
  if (FILES.some(k => lower.includes(k))) cats.add('files');
  if (TASK.some(k => lower.includes(k))) cats.add('task');
  if (SCHEDULE.some(k => lower.includes(k))) cats.add('schedule');
  if (SHELL.some(k => lower.includes(k))) cats.add('shell');
  if (MEMORY.some(k => lower.includes(k))) cats.add('memory');
  if (DEBUG.some(k => lower.includes(k))) cats.add('debug');
  return cats;
}

// ── On-demand tool definition injection ───────────────────────────────────────
// buildTools() returns 56 definitions (~30K chars ≈ 8.3K tokens) — the single
// biggest prompt cost. Injecting all of them every turn drowns a 2B model.
// Keep a compact always-on core; browser/desktop/office/knowledge/subagent
// groups are added only when the message signals that intent (same detector
// that drives TOOL_BLOCKS). Unknown tools stay so nothing silently breaks.
const CAT_ALWAYS_TOOLS = new Set([
  // 任何消息都注入的最小只读核心
  'list_files', 'read_file', 'web_search', 'web_fetch', 'memory_read',
]);
const CAT_FILE_WRITE_TOOLS = new Set([
  'create_file', 'replace_lines', 'insert_after', 'delete_lines',
  'find_replace', 'delete_file', 'write_note', 'run_code',
]);
const CAT_TASK_TOOLS = new Set([
  'start_task', 'task_control', 'schedule_job', 'parse_schedule_pattern',
]);
const CAT_SUBAGENT_TOOLS = new Set(['spawn_subagent']);
const CAT_MEMORY_WRITE_TOOLS = new Set(['memory_write', 'memory_browse']);
const CAT_BROWSER_PREFIX = 'browser_';
const CAT_DESKTOP_PREFIX = 'desktop_';
const CAT_OFFICE_PREFIX = 'doc_';
const CAT_KNOWLEDGE_PREFIX = 'knowledge_';
const CAT_PLAN_PREFIX = 'plan_';
const CAT_OFFICE_EXTRAS = new Set(['image_render', 'file_batch']);
const CAT_SUBAGENT_EXTRAS = new Set(['request_secondary_assist', 'delegate_to_specialist']);

export function filterToolsByIntent(toolDefs: any[], messageText: string, tier: ModelTier = 'small'): any[] {
  // Large models (≥10B / unknown cloud) have ample context — give them the
  // full tool set; dynamic trimming would only risk mis-cuts.
  if (tier === 'large') {
    console.log(`[tools] intent filter skipped (large tier): ${toolDefs.length} tools`);
    return toolDefs;
  }
  const cats = detectToolCategories(messageText);
  const lower = String(messageText || '').toLowerCase();
  const wantOffice = cats.has('files')
    || /(doc|文档|office|word|pdf|表格|excel|report|报告)/i.test(lower);
  const wantKnowledge = cats.has('memory')
    || /(知识库|knowledge|检索|资料|查一下)/i.test(lower);
  const wantSubagent = cats.size >= 2
    || /(子任务|subagent|并行|同时|拆分|分工)/i.test(lower);
  const wantFileWrite = cats.has('files')
    || /(创建|新建|写入|修改|编辑|删除|替换|追加|写文件|改成|改为|保存|生成|修复|重构|整理|处理|写|编)/i.test(lower);
  const wantTask = /(任务|待办|定时|提醒|schedule|提醒我|计划任务|创建任务)/i.test(lower);
  const wantMemory = /(记忆|记住|忘了|以前|上次|memory|长期)/i.test(lower);
  const wantGui = /(打开|启动|运行|开启|弹出).{0,8}(应用|程序|app|word|excel|ppt|notepad|calc|code|explorer|浏览器|文件)/i.test(lower)
    || /^(start|open)\s/i.test(lower);
  const filtered = toolDefs.filter((t: any) => {
    const n = String(t?.function?.name || '');
    if (CAT_ALWAYS_TOOLS.has(n)) return true;
    // Mid tier (5-9B) has enough context to always keep the file-write group
    // open — its main job is document/material work, not context starvation.
    if (tier === 'mid' && CAT_FILE_WRITE_TOOLS.has(n)) return true;
    if (CAT_FILE_WRITE_TOOLS.has(n)) return wantFileWrite;
    if (CAT_TASK_TOOLS.has(n)) return wantTask;
    if (CAT_SUBAGENT_TOOLS.has(n)) return wantSubagent;
    if (CAT_MEMORY_WRITE_TOOLS.has(n)) return wantMemory;
    if (n === 'run_command') return wantGui;
    if (n.startsWith(CAT_BROWSER_PREFIX)) return cats.has('browser');
    if (n.startsWith(CAT_DESKTOP_PREFIX)) return cats.has('desktop');
    if (n.startsWith(CAT_OFFICE_PREFIX)) return wantOffice;
    if (n.startsWith(CAT_KNOWLEDGE_PREFIX)) return wantKnowledge;
    if (CAT_OFFICE_EXTRAS.has(n)) return wantOffice;
    if (CAT_SUBAGENT_EXTRAS.has(n)) return wantSubagent;
    if (n.startsWith(CAT_PLAN_PREFIX)) return wantSubagent;
    return true;
  });
  console.log(`[tools] intent filter (${tier}): ${toolDefs.length} -> ${filtered.length} tools | "${String(messageText || '').slice(0, 40)}"`);
  return filtered;
}
