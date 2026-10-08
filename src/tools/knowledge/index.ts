/**
 * knowledge/index.ts — Node side of the SmallClaw knowledge base (RAG).
 *
 * Python backend: knowledge_helper.py (zero new dependencies: stdlib + pymupdf
 * for PDFs; Office files via stdlib zipfile+xml). Protocol: one JSON payload
 * on stdin -> one JSON document on stdout.
 */
import { spawn, spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export interface KnowledgeCallResult {
  ok: boolean;
  error?: string;
  detail?: string;
  [key: string]: any;
}

function candidateHelperPaths(): string[] {
  const here = __dirname;
  return [
    path.join(here, 'knowledge_helper.py'),
    path.join(here, '..', '..', '..', 'src', 'tools', 'knowledge', 'knowledge_helper.py'),
    path.join(process.cwd(), 'src', 'tools', 'knowledge', 'knowledge_helper.py'),
  ];
}

function resolveHelperPath(): string | null {
  for (const candidate of candidateHelperPaths()) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function findPython(): string | null {
  const env = process.env.SMALLCLAW_PYTHON;
  if (env && fs.existsSync(env)) return env;
  for (const name of ['python', 'python3']) {
    try {
      const r = spawnSync(name, ['-c', 'print(1)'], { timeout: 8000, windowsHide: true });
      if (r.status === 0 && String(r.stdout || '').trim() === '1') return name;
    } catch { /* try next */ }
  }
  return null;
}

export function runKnowledge(
  payload: Record<string, any>,
  opts?: { timeoutMs?: number },
): Promise<KnowledgeCallResult> {
  const timeoutMs = opts?.timeoutMs ?? 60000;
  const helper = resolveHelperPath();
  if (!helper) {
    return Promise.resolve({ ok: false, error: 'knowledge helper script not found (knowledge_helper.py)' });
  }
  const python = findPython();
  if (!python) {
    return Promise.resolve({ ok: false, error: 'Python interpreter not found. Set SMALLCLAW_PYTHON to enable the knowledge base.' });
  }
  return new Promise<KnowledgeCallResult>((resolve) => {
    let settled = false;
    const finish = (value: KnowledgeCallResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, [helper], {
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      });
    } catch (err: any) {
      finish({ ok: false, error: `failed to start knowledge helper: ${err?.message || err}` });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: `knowledge helper timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `knowledge helper spawn failed: ${err?.message || err}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        finish({ ok: false, error: `knowledge helper produced no output (exit ${code})`, detail: stderr.slice(-600) || undefined });
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err: any) {
        finish({ ok: false, error: `knowledge helper returned invalid JSON: ${err?.message || err}`, detail: trimmed.slice(0, 400) });
        return;
      }
      if (!parsed || typeof parsed !== 'object') {
        finish({ ok: false, error: 'knowledge helper returned an unexpected payload' });
        return;
      }
      finish(parsed as KnowledgeCallResult);
    });
    const stdin = child.stdin;
    if (stdin) {
      stdin.on('error', () => { /* helper may exit early */ });
      stdin.end(JSON.stringify(payload));
    } else {
      finish({ ok: false, error: 'knowledge helper stdin unavailable' });
    }
  });
}

export const KNOWLEDGE_TOOL_NAMES = [
  'knowledge_add',
  'knowledge_search',
  'knowledge_get',
  'knowledge_list',
  'knowledge_status',
  'knowledge_remove',
];

export function getKnowledgeToolDefinitions(knowledgeDir: string): any[] {
  const wrap = (def: any) => ({ type: 'function', function: def, _meta: { kb: true, dir: knowledgeDir } });
  return [
    wrap({
      name: 'knowledge_add',
      description:
        'Add a document to the local RAG knowledge base (PDF, .docx, .xlsx, .pptx, txt/md/html/csv/json; offline BM25). Re-adding the same file updates it. Returns chunk counts.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path of the document to add' },
          filename: { type: 'string', description: 'Alternative: a workspace-relative filename (resolved automatically)' },
        },
      },
    }),
    wrap({
      name: 'knowledge_search',
      description:
        'Search the local knowledge base and return top matching chunks with scores and source files. Use before answering questions referring to stored documents/reports/data (e.g. "上次那份报告", "资料里怎么说", "之前的检验数据").',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords or natural language question' },
          top_k: { type: 'number', description: 'Number of chunks to return (default 5, max 10)' },
        },
        required: ['query'],
      },
    }),
    wrap({
      name: 'knowledge_get',
      description:
        'Fetch the full content chunks of ONE stored file by name (fuzzy match). Use when the user @-references a KB file (e.g. "看 @report.docx 里的数据") or asks about a specific stored document.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Stored file name or a prefix of it' },
          max_chunks: { type: 'number', description: 'Max chunks to return (default 10)' },
        },
        required: ['name'],
      },
    }),
    wrap({
      name: 'knowledge_list',
      description: 'List all documents currently stored in the knowledge base.',
      parameters: { type: 'object', properties: {} },
    }),
    wrap({
      name: 'knowledge_status',
      description: 'Show knowledge base stats (file count, chunk count, supported formats).',
      parameters: { type: 'object', properties: {} },
    }),
    wrap({
      name: 'knowledge_remove',
      description: 'Remove a document from the knowledge base by its stored name.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Stored file name (see knowledge_list)' } },
        required: ['name'],
      },
    }),
  ];
}

export function executeKnowledgeTool(name: string, args: any, knowledgeDir: string): Promise<KnowledgeCallResult> {
  const dir = knowledgeDir || path.join(__dirname, '..', '..', '..', 'knowledge');
  switch (name) {
    case 'knowledge_add': {
      const p = String(args?.path || args?.filename || '').trim();
      if (!p) return Promise.resolve({ ok: false, error: 'path/filename required' });
      return runKnowledge({ op: 'add', path: p, knowledge_dir: dir }, { timeoutMs: 180000 });
    }
    case 'knowledge_search': {
      const q = String(args?.query || '').trim();
      if (!q) return Promise.resolve({ ok: false, error: 'query required' });
      const topK = Math.min(Math.max(parseInt(String(args?.top_k ?? '5'), 10) || 5, 1), 10);
      return runKnowledge({ op: 'search', query: q, top_k: topK, knowledge_dir: dir }, { timeoutMs: 30000 });
    }
    case 'knowledge_get': {
      const n = String(args?.name || '').trim();
      if (!n) return Promise.resolve({ ok: false, error: 'name required' });
      const maxC = Math.min(Math.max(parseInt(String(args?.max_chunks ?? '10'), 10) || 10, 1), 20);
      return runKnowledge({ op: 'get', name: n, max_chunks: maxC, knowledge_dir: dir }, { timeoutMs: 30000 });
    }
    case 'knowledge_list':
      return runKnowledge({ op: 'list', knowledge_dir: dir }, { timeoutMs: 30000 });
    case 'knowledge_status':
      return runKnowledge({ op: 'status', knowledge_dir: dir }, { timeoutMs: 30000 });
    case 'knowledge_remove': {
      const n = String(args?.name || '').trim();
      if (!n) return Promise.resolve({ ok: false, error: 'name required' });
      return runKnowledge({ op: 'remove', name: n, knowledge_dir: dir }, { timeoutMs: 30000 });
    }
    default:
      return Promise.resolve({ ok: false, error: `unknown knowledge tool: ${name}` });
  }
}
