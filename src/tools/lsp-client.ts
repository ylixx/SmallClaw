/**
 * lsp-client — 最小可用的 LSP 客户端（JSON-RPC 2.0 over stdio）
 *
 * 设计要点：
 * - 启动语言服务器子进程，完成 initialize 握手 + initialized 通知。
 * - 查询前对目标文件发 textDocument/didOpen（读盘内容），保证 definition/references/
 *   hover/documentSymbol 等能在未打开文件中工作。
 * - 支持：definition / references / hover / implementation / documentSymbol / workspaceSymbol。
 * - 结果统一规整为 {uri, range:{start,end}} 列表，行/列转为 1-based（编辑器风格）便于展示。
 * - 长驻进程按 (rootUri + languageId) 缓存复用，避免每次查询重启服务器。
 * - 带超时与错误类型；进程异常退出会拒绝在途请求。
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import { pathToFileURL } from 'url';

const REQUEST_TIMEOUT_MS = 20_000;

export class LspError extends Error {}

interface PendingRequest {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  timer: NodeJS.Timeout;
}

function uriOf(absPath: string): string {
  return pathToFileURL(absPath).href;
}

function fileFromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  let p = decodeURIComponent(new URL(uri).pathname);
  // Windows: file:///E:/x → "/E:/x"；去掉开头的 "/" 变为 "E:/x"
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
  return p;
}

/** LSP Range/Position → 1-based {line, character} */
function toDisplayRange(range: any): { start: any; end: any } | null {
  if (!range) return null;
  const conv = (p: any) => ({ line: (p?.line ?? 0) + 1, character: (p?.character ?? 0) + 1 });
  return { start: conv(range.start), end: conv(range.end) };
}

/** 把 LSP Location / LocationLink / 数组 规整成统一展示结构 */
function normalizeLocations(locs: any): any[] {
  if (!locs) return [];
  const arr = Array.isArray(locs) ? locs : [locs];
  return arr.map((loc) => {
    // LocationLink 用 targetUri/targetRange
    const uri = loc.uri || loc.targetUri;
    const range = loc.range || loc.targetRange;
    return {
      file: fileFromUri(uri),
      range: toDisplayRange(range),
    };
  });
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private opened = new Set<string>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  readonly rootUri: string;
  readonly languageId: string;

  constructor(private argv: string[], rootPath: string, languageId: string) {
    this.rootUri = uriOf(rootPath);
    this.languageId = languageId;
    this.proc = spawn(argv[0], argv.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // shell:true 让 Windows 能解析 .cmd 垫片（如 typescript-language-server.cmd）；
      // 这里 argv 只含 --stdio 之类，无空格/$ 等特殊字符，不会被 shell 误拆。
      shell: true,
      windowsHide: true,
    });
    this.proc.on('exit', () => this.failAll('LSP server exited'));
    this.proc.on('error', (e) => this.failAll(String(e)));
    this.proc.stdout.on('data', (d: Buffer) => this.onData(d));
  }

  private failAll(reason: string): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new LspError(reason));
    }
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8');
    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;
      const header = this.buf.slice(0, headerEnd);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { this.buf = ''; break; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this.buf.length < start + len) break;
      const body = this.buf.slice(start, start + len);
      this.buf = this.buf.slice(start + len);
      let msg: any;
      try { msg = JSON.parse(body); } catch { continue; }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new LspError(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
    // 忽略通知（method 且无 id）
  }

  private send(obj: any): void {
    const json = JSON.stringify(obj);
    const payload = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
    this.proc.stdin.write(payload);
  }

  private request(method: string, params: any, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new LspError(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await this.request('initialize', {
          processId: process.pid,
          rootUri: this.rootUri,
          capabilities: {
            textDocument: {
              definition: { linkSupport: true },
              references: true,
              hover: {},
              implementation: { linkSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
              synchronization: { dynamicRegistration: false },
            },
            workspace: { symbol: true, workspaceFolders: false },
          },
          workspaceFolders: [{ uri: this.rootUri, name: 'workspace' }],
        });
        this.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
        this.initialized = true;
      })().catch((e) => {
        this.initPromise = null;
        throw e;
      });
    }
    return this.initPromise;
  }

  private async didOpenIfNeeded(absPath: string): Promise<void> {
    if (this.opened.has(absPath)) return;
    let text = '';
    try { text = fs.readFileSync(absPath, 'utf-8'); } catch { text = ''; }
    this.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: uriOf(absPath),
          languageId: this.languageId,
          version: 1,
          text,
        },
      },
    });
    this.opened.add(absPath);
  }

  private position(line1: number, char1: number) {
    return { line: Math.max(0, line1 - 1), character: Math.max(0, char1 - 1) };
  }

  async definition(absPath: string, line: number, character: number): Promise<any[]> {
    await this.ensureInitialized();
    await this.didOpenIfNeeded(absPath);
    const res = await this.request('textDocument/definition', {
      textDocument: { uri: uriOf(absPath) },
      position: this.position(line, character),
    });
    return normalizeLocations(res);
  }

  async references(absPath: string, line: number, character: number): Promise<any[]> {
    await this.ensureInitialized();
    await this.didOpenIfNeeded(absPath);
    const res = await this.request('textDocument/references', {
      textDocument: { uri: uriOf(absPath) },
      position: this.position(line, character),
      context: { includeDeclaration: false },
    });
    return normalizeLocations(res);
  }

  async hover(absPath: string, line: number, character: number): Promise<any> {
    await this.ensureInitialized();
    await this.didOpenIfNeeded(absPath);
    const res = await this.request('textDocument/hover', {
      textDocument: { uri: uriOf(absPath) },
      position: this.position(line, character),
    });
    if (!res) return null;
    let value = '';
    if (typeof res.contents === 'string') value = res.contents;
    else if (Array.isArray(res.contents)) value = res.contents.join('\n');
    else if (res.contents?.value) value = res.contents.value;
    return { value, range: toDisplayRange(res.range) };
  }

  async implementation(absPath: string, line: number, character: number): Promise<any[]> {
    await this.ensureInitialized();
    await this.didOpenIfNeeded(absPath);
    const res = await this.request('textDocument/implementation', {
      textDocument: { uri: uriOf(absPath) },
      position: this.position(line, character),
    });
    return normalizeLocations(res);
  }

  async documentSymbol(absPath: string): Promise<any[]> {
    await this.ensureInitialized();
    await this.didOpenIfNeeded(absPath);
    const res = await this.request('textDocument/documentSymbol', {
      textDocument: { uri: uriOf(absPath) },
    });
    return this.flattenSymbols(res || []);
  }

  private flattenSymbols(symbols: any[], out: any[] = []): any[] {
    for (const s of symbols) {
      out.push({
        name: s.name,
        kind: s.kind,
        range: toDisplayRange(s.range),
        detail: s.detail || '',
      });
      if (Array.isArray(s.children)) this.flattenSymbols(s.children, out);
    }
    return out;
  }

  async workspaceSymbol(query: string): Promise<any[]> {
    await this.ensureInitialized();
    const res = await this.request('workspace/symbol', { query });
    return (res || []).map((s: any) => ({
      name: s.name,
      kind: s.kind,
      container: s.containerName || '',
      file: fileFromUri(s.location?.uri || s.location?.targetUri),
      range: toDisplayRange(s.location?.range || s.location?.targetRange),
    }));
  }

  dispose(): void {
    try {
      this.send({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: null });
      this.send({ jsonrpc: '2.0', method: 'exit', params: {} });
    } catch { /* ignore */ }
    try { this.proc.kill(); } catch { /* ignore */ }
  }
}

// ── 进程缓存（按 rootUri + languageId 复用） ──────────────────────────────────
const clientCache = new Map<string, LspClient>();

export function getClient(rootPath: string, languageId: string, argv: string[]): LspClient {
  const key = `${uriOf(rootPath)}::${languageId}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new LspClient(argv, rootPath, languageId);
    clientCache.set(key, client);
  }
  return client;
}

export function disposeAllLspClients(): void {
  for (const c of clientCache.values()) c.dispose();
  clientCache.clear();
}

export { uriOf, fileFromUri };
