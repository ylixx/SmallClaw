/**
 * office/index.ts
 *
 * Node side of the Office document tool suite.
 *
 * All document parsing/editing happens in Python (office_helper.py) because
 * openpyxl / python-docx / python-pptx / pypdf are already installed on this
 * machine and there are no npm equivalents without adding dependencies.
 *
 * Protocol: one JSON payload on stdin -> one JSON document on stdout.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const OFFICE_READ_EXTENSIONS = ['.xlsx', '.xlsm', '.docx', '.pptx', '.pdf', '.csv', '.tsv'];
export const OFFICE_WRITE_EXTENSIONS = ['.xlsx', '.xlsm', '.docx', '.pptx'];

const MAX_RESULT_CHARS = 60000;
const DEFAULT_TIMEOUT_MS = 60000;
const WRITE_TIMEOUT_MS = 120000;
const CONVERT_TIMEOUT_MS = 200000;
const OCR_TIMEOUT_MS = 300000;
const CAPS_TIMEOUT_MS = 45000;
const PROBE_RETRY_MS = 60000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const PREVIEW_MAX_ENTRIES = 200;

const XLSX_OPS = new Set(['cells', 'rows', 'add_sheet', 'chart']);
const DOCX_OPS = new Set(['replace', 'insert', 'heading', 'table', 'add_table', 'add_image', 'content']);
const PPTX_OPS = new Set(['set_text', 'title', 'textbox', 'table', 'image', 'delete_shape', 'add_slide', 'outline']);

export interface OfficeCapabilities {
  python: string;
  helper: string;
  formats: Record<string, boolean>;
  libs: Record<string, boolean>;
}

interface OfficeCallResult {
  ok: boolean;
  data?: any;
  error?: string;
  detail?: any;
}

let cachedCaps: OfficeCapabilities | null = null;
let capsPromise: Promise<OfficeCapabilities | null> | null = null;
let lastCapsFailure = 0;
let resolvedPython: string | null = null;
let helperPath: string | null = null;

function candidateHelperPaths(): string[] {
  const here = __dirname;
  return [
    path.join(here, 'office_helper.py'),
    path.join(here, '..', '..', '..', 'src', 'tools', 'office', 'office_helper.py'),
    path.join(process.cwd(), 'src', 'tools', 'office', 'office_helper.py'),
  ];
}

function resolveHelperPath(): string | null {
  if (helperPath) return helperPath;
  for (const candidate of candidateHelperPaths()) {
    try {
      if (fs.existsSync(candidate)) {
        helperPath = candidate;
        return helperPath;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function pythonCandidates(): string[] {
  const list: string[] = [];
  const fromEnv = String(process.env.SMALLCLAW_PYTHON || '').trim();
  if (fromEnv) list.push(fromEnv);
  if (process.platform === 'win32') {
    list.push('python', 'python3', 'py');
  } else {
    list.push('python3', 'python');
  }
  return [...new Set(list)];
}

function tryPython(candidates: string[], index: number, timeoutMs: number): Promise<string | null> {
  if (index >= candidates.length) return Promise.resolve(null);
  const candidate = candidates[index];
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      const args = candidate.endsWith('py') ? ['-3', '--version'] : ['--version'];
      child = spawn(candidate, args, { windowsHide: true });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    let out = '';
    child.stdout?.on('data', chunk => { out += String(chunk); });
    child.stderr?.on('data', chunk => { out += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', code => {
      clearTimeout(timer);
      finish(code === 0 || /\b3\.\d+\.\d+/.test(out) ? candidate : null);
    });
  });
}

async function findPython(): Promise<string | null> {
  if (resolvedPython) return resolvedPython;
  const found = await tryPython(pythonCandidates(), 0, 15000);
  resolvedPython = found;
  return found;
}

export function runOfficeHelper(
  payload: Record<string, any>,
  opts?: { timeoutMs?: number },
): Promise<OfficeCallResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const helper = resolveHelperPath();
  if (!helper) {
    return Promise.resolve({ ok: false, error: 'office helper script not found (office_helper.py)' });
  }
  return findPython().then(python => {
    if (!python) {
      return { ok: false, error: 'Python interpreter not found. Set SMALLCLAW_PYTHON to enable Office tools.' } as OfficeCallResult;
    }
    return new Promise<OfficeCallResult>(resolve => {
      let settled = false;
      const finish = (value: OfficeCallResult) => {
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
        finish({ ok: false, error: `failed to start office helper: ${err?.message || err}` });
        return;
      }

      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish({ ok: false, error: `office helper timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.on('error', err => {
        clearTimeout(timer);
        finish({ ok: false, error: `office helper spawn failed: ${err?.message || err}` });
      });
      child.on('close', code => {
        clearTimeout(timer);
        const trimmed = stdout.trim();
        if (!trimmed) {
          finish({ ok: false, error: `office helper produced no output (exit ${code})`, detail: stderr.slice(-600) || undefined });
          return;
        }
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch (err: any) {
          finish({ ok: false, error: `office helper returned invalid JSON: ${err?.message || err}`, detail: trimmed.slice(0, 400) });
          return;
        }
        if (!parsed || typeof parsed !== 'object') {
          finish({ ok: false, error: 'office helper returned an unexpected payload' });
          return;
        }
        finish(parsed as OfficeCallResult);
      });

      const stdin = child.stdin;
      if (stdin) {
        stdin.on('error', () => { /* helper may exit early */ });
        stdin.end(JSON.stringify(payload));
      } else {
        finish({ ok: false, error: 'office helper stdin is unavailable' });
      }
    });
  });
}

async function probeCapabilities(): Promise<OfficeCapabilities | null> {
  const helper = resolveHelperPath();
  if (!helper) return null;
  const python = await findPython();
  if (!python) return null;
  const res = await runOfficeHelper({ op: 'capabilities' }, { timeoutMs: CAPS_TIMEOUT_MS });
  if (!res.ok || !res.data) return null;
  const formats = (res.data.formats || {}) as Record<string, boolean>;
  if (!Object.values(formats).some(Boolean)) return null;
  return {
    python: String(res.data.python || python),
    helper,
    formats,
    libs: (res.data.libs || {}) as Record<string, boolean>,
  };
}

function kickOffProbe(): Promise<OfficeCapabilities | null> {
  if (capsPromise) return capsPromise;
  if (Date.now() - lastCapsFailure < PROBE_RETRY_MS) return Promise.resolve(null);
  capsPromise = probeCapabilities()
    .then(caps => {
      if (caps) cachedCaps = caps;
      else lastCapsFailure = Date.now();
      return caps;
    })
    .catch(() => {
      lastCapsFailure = Date.now();
      return null;
    })
    .finally(() => {
      capsPromise = null;
    });
  return capsPromise;
}

/** Fire-and-forget: used by buildTools() (which is synchronous). */
export function ensureOfficeCapabilities(): void {
  if (cachedCaps || capsPromise) return;
  void kickOffProbe();
}

export async function getOfficeCapabilities(): Promise<OfficeCapabilities | null> {
  if (cachedCaps) return cachedCaps;
  await kickOffProbe();
  return cachedCaps;
}

export function getOfficeCapabilitiesSync(): OfficeCapabilities | null {
  return cachedCaps;
}

export function resetOfficeCapabilitiesForTests(): void {
  cachedCaps = null;
  capsPromise = null;
  lastCapsFailure = 0;
  resolvedPython = null;
  helperPath = null;
}

// ─── Path / ops validation ────────────────────────────────────────────────────

export function officeExtensionOf(filePath: unknown): string {
  return path.extname(String(filePath || '')).toLowerCase();
}

export function isOfficeReadFile(filePath: unknown): boolean {
  return OFFICE_READ_EXTENSIONS.includes(officeExtensionOf(filePath));
}

export function isOfficeWriteFile(filePath: unknown): boolean {
  return OFFICE_WRITE_EXTENSIONS.includes(officeExtensionOf(filePath));
}

function allowedOpsFor(ext: string): Set<string> {
  if (ext === '.xlsx' || ext === '.xlsm') return XLSX_OPS;
  if (ext === '.docx') return DOCX_OPS;
  if (ext === '.pptx') return PPTX_OPS;
  return new Set();
}

/** Returns an error string when the ops payload is not acceptable. */
export function validateOfficeOps(filePath: unknown, ops: unknown): string | null {
  const ext = officeExtensionOf(filePath);
  if (!OFFICE_WRITE_EXTENSIONS.includes(ext)) {
    return `Cannot write "${String(filePath || '')}". Writing is supported for .xlsx, .docx and .pptx only.`;
  }
  if (!Array.isArray(ops) || ops.length === 0) {
    return 'ops must be a non-empty array of operation objects.';
  }
  if (ops.length > 200) {
    return `Too many ops (${ops.length}, limit 200). Split the write into smaller batches.`;
  }
  const allowed = allowedOpsFor(ext);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      return `ops[${i}] must be an object.`;
    }
    const kind = String((op as any).op || '').trim();
    if (!kind) return `ops[${i}] is missing an "op" field.`;
    if (!allowed.has(kind)) {
      return `ops[${i}] has unsupported op "${kind}" for ${ext}. Supported: ${[...allowed].join(', ')}.`;
    }
  }
  return null;
}

// ─── Preview bookkeeping ──────────────────────────────────────────────────────

interface PreviewEntry {
  sessionId: string;
  path: string;
  ops: unknown[];
  createdAt: number;
}

const previewStore = new Map<string, PreviewEntry>();

export function docPreviewId(filePath: string, ops: unknown[]): string {
  const canonical = JSON.stringify({ p: String(filePath || '').toLowerCase(), o: ops });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function prunePreviewStore(): void {
  const now = Date.now();
  for (const [key, entry] of previewStore) {
    if (now - entry.createdAt > PREVIEW_TTL_MS) previewStore.delete(key);
  }
  if (previewStore.size > PREVIEW_MAX_ENTRIES) {
    const overflow = previewStore.size - PREVIEW_MAX_ENTRIES;
    let toDrop = overflow;
    for (const key of previewStore.keys()) {
      if (toDrop <= 0) break;
      previewStore.delete(key);
      toDrop--;
    }
  }
}

export function rememberDocPreview(sessionId: string, filePath: string, ops: unknown[], previewId: string): void {
  prunePreviewStore();
  previewStore.set(previewId, {
    sessionId: String(sessionId || 'default'),
    path: String(filePath || ''),
    ops,
    createdAt: Date.now(),
  });
}

export interface DocPreviewRecord {
  previewId: string;
  sessionId: string;
  path: string;
  ops: unknown[];
  markdown: string;
  createdAt: number;
}

let lastDocPreview: DocPreviewRecord | null = null;

function stashDocPreview(record: DocPreviewRecord): void {
  lastDocPreview = record;
}

/** Returns the preview produced by the most recent doc_write preview call (and clears it). */
export function consumeLastDocPreview(): DocPreviewRecord | null {
  const record = lastDocPreview;
  lastDocPreview = null;
  return record;
}

export function getDocPreview(previewId: unknown): DocPreviewRecord | null {
  const id = String(previewId || '');
  if (!id) return null;
  if (lastDocPreview && lastDocPreview.previewId === id) return lastDocPreview;
  const entry = previewStore.get(id);
  if (!entry) return null;
  return {
    previewId: id,
    sessionId: entry.sessionId,
    path: entry.path,
    ops: entry.ops,
    markdown: '',
    createdAt: entry.createdAt,
  };
}

export interface DocPreviewBlock {
  kind: 'heading' | 'text' | 'table';
  text?: string;
  headers?: string[];
  rows?: string[][];
}

/** Split a preview markdown document into renderable blocks (no markdown engine needed in the UI). */
export function parseDocPreview(markdown: unknown): DocPreviewBlock[] {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const blocks: DocPreviewBlock[] = [];
  let textBuf: string[] = [];

  const flushText = () => {
    const text = textBuf.join(' ').trim();
    textBuf = [];
    if (!text) return;
    const strong = /^\*\*[^*]+\*\*$/.test(text);
    blocks.push(strong ? { kind: 'heading', text: text.replace(/^\*\*|\*\*$/g, '') } : { kind: 'text', text });
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushText();
      blocks.push({ kind: 'heading', text: headingMatch[2].replace(/\s+#{1,6}\s*$/, '').trim() });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushText();
      i++;
      continue;
    }
    if (/^\*\*[^*]+\*\*$/.test(line.trim())) {
      flushText();
      blocks.push({ kind: 'heading', text: line.trim().replace(/^\*\*|\*\*$/g, '') });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flushText();
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(
          lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()),
        );
        i++;
      }
      const isSeparator = (cells: string[]) => cells.length > 0 && cells.every(c => /^:?-+:?$/.test(c));
      let header: string[] = [];
      let body: string[][] = [];
      if (rows.length >= 2 && isSeparator(rows[1])) {
        header = rows[0];
        body = rows.slice(2);
      } else {
        body = rows;
      }
      if (header.length || body.length) blocks.push({ kind: 'table', headers: header, rows: body });
      continue;
    }
    if (!line.trim()) {
      flushText();
      i++;
      continue;
    }
    textBuf.push(line.trim());
    i++;
  }
  flushText();
  return blocks;
}

export function docPreviewStatus(
  sessionId: string,
  filePath: string,
  ops: unknown[],
  previewId: unknown,
): { ok: boolean; message?: string } {
  const expected = docPreviewId(filePath, ops);
  if (previewId && String(previewId) !== expected) {
    return { ok: false, message: 'preview_id does not match these ops - the document changed or ops were edited, run mode:"preview" again.' };
  }
  const entry = previewStore.get(expected);
  if (!entry) {
    return { ok: false, message: 'No matching preview found. Call doc_write with mode:"preview" first, then apply with the returned preview_id.' };
  }
  if (entry.sessionId !== String(sessionId || 'default')) {
    return { ok: false, message: 'The preview belongs to another session - run mode:"preview" again in this session.' };
  }
  return { ok: true };
}

export function isDocPreviewRequired(): boolean {
  try {
    const cfg: any = (getConfigSafe() as any) || {};
    if (cfg && cfg.office && typeof cfg.office.require_preview === 'boolean') {
      return cfg.office.require_preview !== false;
    }
  } catch {
    // ignore
  }
  return true;
}

function getConfigSafe(): any {
  try {
    // Lazy require to avoid a circular import at module load time.
    const mod = require('../../config/config');
    return mod?.getConfig ? mod.getConfig().getConfig() : null;
  } catch {
    return null;
  }
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const DOC_OPS_JSON = {
  type: 'array',
  description: 'Array of operations to perform. Each entry needs an "op" field.',
  items: { type: 'object', properties: { op: { type: 'string' } }, additionalProperties: true },
};

export function getOfficeToolDefinitions(): any[] {
  ensureOfficeCapabilities();
  if (!cachedCaps) return [];
  const defs: any[] = [];

  defs.push({
    type: 'function',
    function: {
      name: 'doc_inspect',
      description:
        'Inspect structure of an Office/PDF/CSV document: worksheets/dimensions/header rows (xlsx), outline/headings/tables (docx), slides/shapes (pptx), pages (pdf), columns (csv). Use first to learn where things are.',
      parameters: {
        type: 'object',
        required: ['filename'],
        properties: { filename: { type: 'string', description: 'Document path (absolute, or relative to the workspace)' } },
      },
    },
  });

  defs.push({
    type: 'function',
    function: {
      name: 'doc_read',
      description:
        'Read an Office/PDF/CSV document as Markdown (tables rendered). Supports xlsx cell ranges, docx paragraph windows, pptx slides, pdf pages.',
      parameters: {
        type: 'object',
        required: ['filename'],
        properties: {
          filename: { type: 'string', description: 'Document path' },
          target: {
            type: 'string',
            description:
              'xlsx: range like "Sheet1!A1:D50". docx: paragraph index "12". pptx: slide number "3". pdf: page number "2".',
          },
          stats: { type: 'boolean', description: 'xlsx only: per-column stats (min/max/sum/avg/numeric counts).' },
          limit: { type: 'number', description: 'docx/csv/pdf: max paragraphs/rows/pages (default 200).' },
          row_limit: { type: 'number', description: 'xlsx/csv: max rows per Markdown table (default 50).' },
        },
      },
    },
  });

  defs.push({
    type: 'function',
    function: {
      name: 'doc_write',
      description:
        'Create or edit an .xlsx / .docx / .pptx (created from scratch if missing). ALWAYS call mode:"preview" first: returns a rendered Markdown preview plus preview_id and writes nothing. Only call mode:"apply" with that preview_id after the user approves; if rejected, show the preview only.\n'
        + 'ops by format:\n'
        + 'xlsx: {op:"cells",sheet,ref,values} | {op:"rows",sheet,at,values} | {op:"add_sheet",name} | {op:"chart",range,type:"bar|line|pie|area|scatter",title,anchor}\n'
        + 'docx: {op:"content",markdown} (append headings/lists/tables/images from Markdown - easiest) | {op:"heading",at:"#append",level,text} | {op:"insert",after:"#append",text} | {op:"add_table",rows} | {op:"add_image",image} | existing content: replace/heading with at:"#12", insert with after:"#12", table with at:"#T0",r,c\n'
        + 'pptx: {op:"outline",markdown} ("# deck title", "## slide", "- bullet", "---" = next slide - builds a whole deck in one call) | {op:"add_slide",title,bullets} | existing slides: title/set_text/textbox/table/image/delete_shape with slide numbers.',
      parameters: {
        type: 'object',
        required: ['filename', 'ops'],
        properties: {
          filename: { type: 'string', description: 'Document path (.xlsx, .docx, .pptx) - created if missing' },
          ops: DOC_OPS_JSON,
          mode: {
            type: 'string',
            enum: ['preview', 'apply'],
            description: 'preview (default) = show what would change, write nothing; apply = actually write.',
          },
          preview_id: {
            type: 'string',
            description: 'Returned by the preview call. Required for apply. Re-run preview if ops changed.',
          },
          out: { type: 'string', description: 'Optional: write to a different file (same extension) instead of overwriting.' },
        },
      },
    },
  });

  if (cachedCaps.formats.chart) {
    defs.push({
      type: 'function',
      function: {
        name: 'doc_chart',
        description:
          'Render a chart to a PNG (bar, line, pie, area, scatter) from inline data or an xlsx/csv range, optionally inserting it into a .docx/.pptx in the same call. Use for 数据可视化 / 图表 / 配图. Output path is a workspace file.',
        parameters: {
          type: 'object',
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ['bar', 'line', 'pie', 'area', 'scatter'], description: 'Chart type.' },
            data: {
              type: 'array',
              description: 'Rows of values, row 1 = headers, col A = labels. e.g. [["month","sales"],["Jan",120],["Feb",150]]',
            },
            file: { type: 'string', description: 'Alternative to data: xlsx/csv file to read numbers from.' },
            range: { type: 'string', description: 'With file: range like "Sheet1!A1:D12" (default = used range).' },
            title: { type: 'string', description: 'Chart title.' },
            xlabel: { type: 'string', description: 'X axis label.' },
            ylabel: { type: 'string', description: 'Y axis label.' },
            out: { type: 'string', description: 'PNG path in the workspace (default chart-<time>.png).' },
            embed: { type: 'string', description: 'Optional .docx or .pptx to insert the chart into.' },
            width: { type: 'number', description: 'PNG width in px (default 1200).' },
            height: { type: 'number', description: 'PNG height in px (default 700).' },
          },
        },
      },
    });
  }

  if (cachedCaps.formats.convert) {
    defs.push({
      type: 'function',
      function: {
        name: 'doc_convert',
        description:
          'Convert a document via LibreOffice. Sources: .doc/.docx/.odt/.rtf/.txt/.md/.html/.xls/.xlsx/.csv/.ppt/.pptx/.pdf. Targets: pdf, docx, xlsx, pptx, txt, csv, html. E.g. markdown -> pdf, legacy .doc -> .docx.',
        parameters: {
          type: 'object',
          required: ['filename', 'to'],
          properties: {
            filename: { type: 'string', description: 'Source document path' },
            to: {
              type: 'string',
              enum: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'csv', 'html'],
              description: 'Target format',
            },
            out: { type: 'string', description: 'Optional output path (must end with target extension). Defaults to the source name.' },
          },
        },
      },
    });
  }

  if (cachedCaps.formats.ocr) {
    defs.push({
      type: 'function',
      function: {
        name: 'doc_ocr',
        description:
          'OCR scanned pages of a PDF (medical/imaging reports are often scanned with no text layer) and return recognized text as Markdown. Use when doc_read returns "(no extractable text - this may be a scanned PDF; use OCR)".',
        parameters: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', description: 'PDF path' },
            pages: {
              type: 'string',
              description:
                'Pages to OCR: "auto" (default) = detect pages with no text layer; "all" = every page; or a comma list like "2,3,5".',
            },
          },
        },
      },
    });
  }

  if (cachedCaps.formats.pdf) {
    defs.push({
      type: 'function',
      function: {
        name: 'doc_parse_lab',
        description:
          'Parse a hospital lab report PDF (检验报告单) into structured data: patient header, dated batches of lab items (code/name/value/reference/unit), abnormal flags (偏高/偏低), full test-date timeline. Returns Markdown summary with embedded structured JSON. Use for 化验单/检验报告 analysis.',
        parameters: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string', description: 'Lab report PDF path' },
          },
        },
      },
    });
  }

  return defs;
}

// ─── Execution ────────────────────────────────────────────────────────────────

export interface OfficeToolOutcome {
  result: string;
  error: boolean;
  /** Files this call created or modified, absolute or workspace-relative. */
  paths?: string[];
}

function clipResult(text: string): string {
  if (!text) return '(empty result)';
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated ${text.length - MAX_RESULT_CHARS} characters]`;
}

function describeError(res: OfficeCallResult): string {
  const parts = [res.error || 'office helper failed'];
  if (res.detail) {
    const detail = typeof res.detail === 'string' ? res.detail : JSON.stringify(res.detail);
    if (detail) parts.push(detail);
  }
  return parts.join('\n');
}

export interface OfficePathGuard {
  (workspacePath: string, filename: unknown): { ok: true; path: string } | { ok: false; error: string };
}

export async function executeOfficeTool(
  name: string,
  args: any,
  workspacePath: string,
  sessionId: string = 'default',
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  const caps = await getOfficeCapabilities();
  if (!caps) {
    return {
      result: 'Office document tools are unavailable: no Python interpreter with openpyxl/python-docx/python-pptx found. Set SMALLCLAW_PYTHON to a Python 3 install with those packages.',
      error: true,
    };
  }

  const rawName = String(args?.filename || args?.name || args?.path || args?.file || '').trim();
  if (!rawName && name !== 'doc_chart') return { result: 'filename is required', error: true };

  if (name === 'doc_chart') {
    return executeDocChart(args, workspacePath, guard);
  }

  const resolved = resolveOfficePath(workspacePath, rawName, guard);
  if (!resolved.ok) return { result: resolved.error, error: true };
  const filePath = resolved.path;

  if (name === 'doc_inspect') {
    const res = await runOfficeHelper({ op: 'inspect', path: filePath }, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (!res.ok) return { result: describeError(res), error: true };
    return { result: clipResult(String(res.data?.markdown || res.data?.text || '(empty)')), error: false };
  }

  if (name === 'doc_read') {
    const payload: Record<string, any> = { op: 'read', path: filePath };
    if (args.target !== undefined && args.target !== null && String(args.target).trim() !== '') {
      payload.target = String(args.target).trim();
    }
    if (args.stats === true || args.stats === 'true') payload.stats = true;
    if (Number.isFinite(Number(args.limit)) && Number(args.limit) > 0) payload.limit = Number(args.limit);
    if (Number.isFinite(Number(args.row_limit)) && Number(args.row_limit) > 0) payload.row_limit = Number(args.row_limit);
    const res = await runOfficeHelper(payload, { timeoutMs: DEFAULT_TIMEOUT_MS });
    if (!res.ok) return { result: describeError(res), error: true };
    return { result: clipResult(String(res.data?.markdown || res.data?.text || '(empty)')), error: false };
  }

  if (name === 'doc_convert') {
    const to = String(args.to || '').trim().toLowerCase().replace(/^\./, '');
    if (!to) return { result: 'to is required (pdf, docx, xlsx, pptx, txt, csv or html)', error: true };
    let outArg: string | undefined;
    if (args.out !== undefined && args.out !== null && String(args.out).trim() !== '') {
      const resolvedOut = resolveOfficePath(workspacePath, String(args.out).trim(), guard);
      if (!resolvedOut.ok) return { result: resolvedOut.error, error: true };
      if (officeExtensionOf(resolvedOut.path).replace(/^\./, '') !== to) {
        return { result: `out must end with ".${to}"`, error: true };
      }
      outArg = resolvedOut.path;
    }
    const res = await runOfficeHelper(
      { op: 'convert', path: filePath, to, out: outArg },
      { timeoutMs: CONVERT_TIMEOUT_MS },
    );
    if (!res.ok) return { result: describeError(res), error: true };
    const data = res.data || {};
    return { result: clipResult(String(data.markdown || `${filePath} -> ${data.out || to}`)), error: false };
  }

  if (name === 'doc_ocr') {
    const payload: Record<string, any> = { op: 'ocr', path: filePath };
    if (args.pages !== undefined && args.pages !== null && String(args.pages).trim() !== '') {
      payload.pages = String(args.pages).trim();
    }
    const res = await runOfficeHelper(payload, { timeoutMs: OCR_TIMEOUT_MS });
    if (!res.ok) return { result: describeError(res), error: true };
    const data = res.data || {};
    const pages = Array.isArray(data.ocr_pages) ? data.ocr_pages.join(', ') : '?';
    return { result: clipResult(String(data.markdown || `OCR complete (${pages})`)), error: false };
  }

  if (name === 'doc_parse_lab') {
    const res = await runOfficeHelper({ op: 'parse_lab', path: filePath }, { timeoutMs: OCR_TIMEOUT_MS });
    if (!res.ok) return { result: describeError(res), error: true };
    const data = res.data || {};
    return { result: clipResult(String(data.markdown || '(empty)')), error: false };
  }

  if (name === 'doc_write') {
    const invalid = validateOfficeOps(filePath, args.ops);
    if (invalid) return { result: invalid, error: true };
    const normalizedOps = normalizeOpsPaths(args.ops, workspacePath, guard);
    if (typeof normalizedOps === 'string') return { result: normalizedOps, error: true };
    const ops = normalizedOps;

    const mode = String(args.mode || 'preview').trim().toLowerCase() === 'apply' ? 'apply' : 'preview';
    const outPath = args.out ? String(args.out).trim() : '';
    if (outPath) {
      const resolvedOut = resolveOfficePath(workspacePath, outPath, guard);
      if (!resolvedOut.ok) return { result: resolvedOut.error, error: true };
      if (officeExtensionOf(resolvedOut.path) !== officeExtensionOf(filePath)) {
        return { result: 'out must keep the same extension as the source (use doc_convert to change format).', error: true };
      }
      args.out = resolvedOut.path;
    }

    const previewId = docPreviewId(filePath, ops);

    if (mode === 'preview') {
      const res = await runOfficeHelper(
        { op: 'write', path: filePath, mode: 'preview', ops, out: args.out || undefined },
        { timeoutMs: WRITE_TIMEOUT_MS },
      );
      if (!res.ok) return { result: describeError(res), error: true };
      rememberDocPreview(sessionId, filePath, ops, previewId);
      const data = res.data || {};
      const header = data.applied
        ? ''
        : `preview_id: \`${previewId}\`\n`;
      const footer = data.applied
        ? ''
        : `\n\n---\n_Preview only - nothing written yet. Call doc_write with mode:"apply" and this preview_id once the user approves._`;
      const markdown = String(data.markdown || '');
      rememberDocPreview(sessionId, filePath, ops, previewId);
      stashDocPreview({
        previewId,
        sessionId: String(sessionId || 'default'),
        path: filePath,
        ops,
        markdown,
        createdAt: Date.now(),
      });
      return { result: clipResult(`${header}${markdown}${footer}`), error: false };
    }

    if (isDocPreviewRequired()) {
      const status = docPreviewStatus(sessionId, filePath, ops, args.preview_id);
      if (!status.ok) return { result: status.message || 'preview required', error: true };
    }

    const res = await runOfficeHelper(
      { op: 'write', path: filePath, mode: 'apply', ops, out: args.out || undefined },
      { timeoutMs: WRITE_TIMEOUT_MS },
    );
    if (!res.ok) return { result: describeError(res), error: true };
    const data = res.data || {};
    previewStore.delete(previewId);
    const written = String(data.out || args.out || filePath);
    return { result: clipResult(String(data.markdown || 'written')), error: data.failed > 0, paths: [written] };
  }

  return { result: `Unknown office tool: ${name}`, error: true };
}

function resolveOfficePath(
  workspacePath: string,
  raw: string,
  guard?: OfficePathGuard,
): { ok: true; path: string } | { ok: false; error: string } {
  if (raw.includes('\0')) return { ok: false, error: 'Invalid filename' };
  if (guard) {
    const guarded = guard(workspacePath, raw);
    if (guarded && typeof guarded === 'object') return guarded;
  }
  return { ok: true, path: path.resolve(String(workspacePath || ''), raw) };
}

/** Resolve image paths referenced by ops so python never touches files outside the workspace. */
function normalizeOpsPaths(ops: any[], workspacePath: string, guard?: OfficePathGuard): any[] | string {
  if (!Array.isArray(ops)) return ops;
  const out: any[] = [];
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out.push(raw);
      continue;
    }
    const kind = String(raw.op || '');
    const key = kind === 'add_image' ? 'image' : kind === 'image' ? 'file' : '';
    if (!key || !raw[key]) {
      out.push(raw);
      continue;
    }
    const resolved = resolveOfficePath(workspacePath, String(raw[key]), guard);
    if (!resolved.ok) return `${kind} op: ${resolved.error}`;
    out.push({ ...raw, [key]: resolved.path });
  }
  return out;
}

const MAX_CHART_ROWS = 501;

async function executeDocChart(
  args: any,
  workspacePath: string,
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  const type = String(args?.type || 'bar').trim().toLowerCase().replace(/^\./, '');
  const payload: Record<string, any> = { op: 'chart', type, nonce: Date.now() };

  const data = args?.data;
  if (Array.isArray(data) && data.length) {
    if (data.length > MAX_CHART_ROWS) {
      return { result: `data has ${data.length} rows (limit ${MAX_CHART_ROWS}). Trim the data or point at a file range.`, error: true };
    }
    payload.data = data;
  }

  const srcRaw = String(args?.file || args?.filename || args?.path || '').trim();
  if (!payload.data && !srcRaw) {
    return { result: 'chart needs either "data" (rows of values) or "file" (xlsx/csv to read).', error: true };
  }
  if (srcRaw) {
    const resolvedSrc = resolveOfficePath(workspacePath, srcRaw, guard);
    if (!resolvedSrc.ok) return { result: resolvedSrc.error, error: true };
    payload.path = resolvedSrc.path;
  }
  if (args?.range) payload.range = String(args.range).trim();
  if (args?.sheet) payload.sheet = String(args.sheet).trim();
  for (const key of ['title', 'xlabel', 'ylabel', 'size'] as const) {
    if (args?.[key] !== undefined && args[key] !== null && String(args[key]).trim() !== '') {
      payload[key] = String(args[key]).trim();
    }
  }
  if (Number.isFinite(Number(args?.width)) && Number(args.width) > 0) payload.width = Number(args.width);
  if (Number.isFinite(Number(args?.height)) && Number(args.height) > 0) payload.height = Number(args.height);

  const outRaw = String(args?.out || '').trim();
  const outName = outRaw || `chart-${Date.now()}.png`;
  const resolvedOut = resolveOfficePath(workspacePath, outName, guard);
  if (!resolvedOut.ok) return { result: resolvedOut.error, error: true };
  payload.out = resolvedOut.path;

  const embedRaw = String(args?.embed || '').trim();
  if (embedRaw) {
    const resolvedEmbed = resolveOfficePath(workspacePath, embedRaw, guard);
    if (!resolvedEmbed.ok) return { result: resolvedEmbed.error, error: true };
    payload.embed = resolvedEmbed.path;
  }

  const res = await runOfficeHelper(payload, { timeoutMs: WRITE_TIMEOUT_MS });
  if (!res.ok) return { result: describeError(res), error: true };
  const info = res.data || {};
  const outPath = String(info.out || payload.out);
  const embedPath = String(payload.embed || '');
  const paths = embedPath ? [outPath, embedPath] : [outPath];
  return { result: clipResult(String(info.markdown || `chart written to ${outPath}`)), error: false, paths };
}
