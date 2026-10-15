/**
 * lsp — 代码智能工具（对标 QwenPaw 的 lsp_tool）
 *
 * 操作：goToDefinition / findReferences / hover / goToImplementation / documentSymbol /
 *       workspaceSymbol。
 * 行/列均为 1-based（编辑器风格）；结果行/列也以 1-based 返回。
 * 语言服务器按需发现并长驻缓存（见 lsp-servers / lsp-client）。
 * 不可用的语言会明确提示回退到 grep_search / ast_search。
 */

import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';
import { LspError, getClient, disposeAllLspClients } from './lsp-client.js';
import { languageForFile, detectServerArgv, displayName } from './lsp-servers.js';

const MAX_RESULTS = 200;

export interface LspArgs {
  operation: string;
  file_path?: string;
  line?: number;
  character?: number;
  query?: string;
}

function workspaceRoot(): string {
  return path.resolve(getConfig().getConfig().workspace.path);
}

function pickWorkspaceLanguage(): string | null {
  for (const lang of ['python', 'typescript', 'javascript', 'go', 'rust']) {
    if (detectServerArgv(lang)) return lang;
  }
  return null;
}

export async function executeLsp(args: LspArgs): Promise<ToolResult> {
  const op = args.operation;
  if (!op || !['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'documentSymbol', 'workspaceSymbol'].includes(op)) {
    return { success: false, error: `Unknown operation "${op}". Valid: goToDefinition, findReferences, hover, goToImplementation, documentSymbol, workspaceSymbol.` };
  }

  // workspaceSymbol 不需要文件
  let absPath: string | null = null;
  let languageId = '';
  const root = workspaceRoot();

  if (op === 'workspaceSymbol') {
    if (!args.query) return { success: false, error: 'workspaceSymbol requires "query".' };
    languageId = pickWorkspaceLanguage() || '';
    if (!languageId) return { success: false, error: 'No LSP server available in this workspace. Fall back to grep_search / ast_search.' };
  } else {
    if (!args.file_path) return { success: false, error: `Operation "${op}" requires "file_path".` };
    const perm = isPathAllowed(path.resolve(args.file_path));
    if (!perm.allowed) return { success: false, error: `Path not allowed: ${perm.reason || 'outside workspace'}` };
    absPath = path.resolve(args.file_path);
    if (!require('fs').existsSync(absPath) || !require('fs').statSync(absPath).isFile()) {
      return { success: false, error: `File not found: ${absPath}` };
    }
    languageId = languageForFile(absPath);
    if (!languageId) return { success: false, error: `Cannot infer language for ${path.basename(absPath)}. Fall back to grep_search / ast_search.` };
  }

  const argv = detectServerArgv(languageId);
  if (!argv) {
    return { success: false, error: `LSP for ${displayName(languageId)} is not available in this workspace. Fall back to grep_search / ast_search.` };
  }

  try {
    const client = getClient(root, languageId, argv);
    let result: any;
    switch (op) {
      case 'goToDefinition':
        result = await client.definition(absPath!, args.line || 0, args.character || 0);
        break;
      case 'findReferences':
        result = await client.references(absPath!, args.line || 0, args.character || 0);
        break;
      case 'hover':
        result = await client.hover(absPath!, args.line || 0, args.character || 0);
        break;
      case 'goToImplementation':
        result = await client.implementation(absPath!, args.line || 0, args.character || 0);
        break;
      case 'documentSymbol':
        result = await client.documentSymbol(absPath!);
        break;
      case 'workspaceSymbol':
        result = await client.workspaceSymbol(args.query || '');
        break;
      default:
        return { success: false, error: `Unhandled operation ${op}` };
    }

    const capped = Array.isArray(result) ? result.slice(0, MAX_RESULTS) : result;
    const truncated = Array.isArray(result) && result.length > MAX_RESULTS;
    const payload: any = { operation: op, language: displayName(languageId), truncated };
    if (op === 'workspaceSymbol') payload.query = args.query;
    else if (absPath) payload.file = absPath;
    payload.results = capped;

    return {
      success: true,
      data: payload,
      stdout: JSON.stringify(payload, null, 2),
      stderr: '',
    };
  } catch (e: any) {
    const msg = e instanceof LspError ? e.message : String(e?.message || e);
    return { success: false, error: `LSP ${op} failed — ${msg}` };
  }
}

export const lspTool = {
  name: 'lsp',
  description: 'Code intelligence via Language Server Protocol: goToDefinition, findReferences, hover, ' +
    'goToImplementation, documentSymbol, workspaceSymbol. Line and character are 1-based. ' +
    'Falls back gracefully (with a hint) when a language server is not installed — use grep_search / ast_search then. ' +
    'Requires the relevant language server (e.g. typescript-language-server, pylsp, gopls, rust-analyzer) to be available.',
  execute: executeLsp,
  schema: {
    operation: 'One of: goToDefinition, findReferences, hover, goToImplementation, documentSymbol, workspaceSymbol.',
    file_path: 'Path to the source file (required for all ops except workspaceSymbol).',
    line: '1-based line number (required for position ops).',
    character: '1-based column number (required for position ops).',
    query: 'Query string (required for workspaceSymbol).',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: ['goToDefinition', 'findReferences', 'hover', 'goToImplementation', 'documentSymbol', 'workspaceSymbol'],
      },
      file_path: { type: 'string' },
      line: { type: 'number' },
      character: { type: 'number' },
      query: { type: 'string' },
    },
    required: ['operation'],
    additionalProperties: true,
  },
};

export { disposeAllLspClients };
