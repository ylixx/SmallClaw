/**
 * chat-handler.ts — chat-loop support helpers extracted from server-v2.ts
 * (Phase 5c-1). Pure helpers + module-level calibration state used by
 * handleChat; the loop itself stays in server-v2 until Phase 5c-2.
 * No dependency on server-v2 locals (verified by cluster-closure probe):
 * everything referenced here is either imported below or defined here.
 */
import fs from 'fs';
import path from 'path';
import { getConfig } from '../config/config';
import { resolveToolFilePath } from './chat-execution';
import type { ToolResult } from './chat-execution';
import { getOrchestrationConfig } from '../orchestration/multi-agent';


export const MAX_TOOL_ROUNDS = 20;
export type ExecutionMode = 'interactive' | 'background_task' | 'heartbeat' | 'cron';
export type OrchestrationEvent = {
  ts: number;
  trigger: 'preflight' | 'explicit' | 'auto';
  mode: 'planner' | 'rescue';
  reason: string;
  route?: string;
};
export type OrchestrationSessionStats = {
  assistCount: number;
  events: OrchestrationEvent[];
};
export const orchestrationSessionStats: Map<string, OrchestrationSessionStats> = new Map();
export const preemptSessionCounts: Map<string, number> = new Map();
export function getOrchestrationSessionStats(sessionId: string): OrchestrationSessionStats {
  const id = String(sessionId || 'default');
  const existing = orchestrationSessionStats.get(id);
  if (existing) return existing;
  const created: OrchestrationSessionStats = { assistCount: 0, events: [] };
  orchestrationSessionStats.set(id, created);
  return created;
}
export function recordOrchestrationEvent(
  sessionId: string,
  event: Omit<OrchestrationEvent, 'ts'>,
  cfg: ReturnType<typeof getOrchestrationConfig>,
): OrchestrationSessionStats {
  const stats = getOrchestrationSessionStats(sessionId);
  stats.assistCount += 1;
  stats.events.push({ ts: Date.now(), ...event });
  const limit = cfg?.limits?.telemetry_history_limit ?? 100;
  if (stats.events.length > limit) {
    stats.events = stats.events.slice(-limit);
  }
  return stats;
}
export function getPreemptSessionCount(sessionId: string): number {
  return preemptSessionCounts.get(String(sessionId || 'default')) || 0;
}
export function incrementPreemptSessionCount(sessionId: string): number {
  const id = String(sessionId || 'default');
  const next = getPreemptSessionCount(id) + 1;
  preemptSessionCounts.set(id, next);
  return next;
}
export type SubagentProfile = 'file_editor' | 'researcher' | 'shell_runner' | 'reader_only';
export function logToDaily(workspacePath: string, role: string, content: string) {
  try {
    const memDir = path.join(workspacePath, 'memory');
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const logPath = path.join(memDir, `${today}.md`);
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = `[${timestamp}] **${role}**: ${content.slice(0, 300)}\n`;

    fs.appendFileSync(logPath, entry);
  } catch {}
}
export const KB_AUTO_INJECT_RE =
  /(知识库|资料库|库里|检索一下|查一下(知识库|资料|文档|报告)|上次那(份|个)(报告|文档|资料|数据|文件)|之前的(报告|文档|资料|数据|文件)|(报告|文档|资料|材料)里(说|写|提到|有没|有没有|的内容))/;
export function resolveWorkspaceFilePath(workspacePath: string, filename: string): string {
  if (!filename) return '';
  const guarded = resolveToolFilePath(workspacePath, filename);
  return guarded.ok ? guarded.path : '';
}
export function collectFileSnapshots(
  workspacePath: string,
  files: string[],
  maxCharsPerFile: number = 3600,
): Array<{
  filename: string;
  exists: boolean;
  content_preview: string;
  line_count: number;
  char_count: number;
}> {
  const out: Array<{
    filename: string;
    exists: boolean;
    content_preview: string;
    line_count: number;
    char_count: number;
  }> = [];
  const seen = new Set<string>();
  for (const raw of files || []) {
    const fn = String(raw || '').trim();
    if (!fn) continue;
    if (seen.has(fn.toLowerCase())) continue;
    seen.add(fn.toLowerCase());

    const fp = resolveWorkspaceFilePath(workspacePath, fn);
    if (!fp) continue;
    if (!fs.existsSync(fp)) {
      out.push({
        filename: fn,
        exists: false,
        content_preview: '',
        line_count: 0,
        char_count: 0,
      });
      continue;
    }
    try {
      const content = fs.readFileSync(fp, 'utf-8');
      const lines = content.split('\n');
      const numbered = lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
      out.push({
        filename: fn,
        exists: true,
        content_preview: numbered.slice(0, maxCharsPerFile),
        line_count: lines.length,
        char_count: content.length,
      });
    } catch {
      out.push({
        filename: fn,
        exists: true,
        content_preview: '',
        line_count: 0,
        char_count: 0,
      });
    }
    if (out.length >= 10) break;
  }
  return out;
}
export function buildBrowserAck(toolName: string, result: ToolResult): string {
  if (result.error) {
    // On error the LLM does need to know what failed so it can decide next step
    return `${toolName} failed: ${result.result.slice(0, 200)}`;
  }
  switch (toolName) {
    case 'browser_open':
      return 'Browser opened. Secondary AI is analyzing the page — wait for directive.';
    case 'browser_snapshot':
      return 'Snapshot captured. Secondary AI is analyzing — wait for directive.';
    case 'browser_press_key':
      return 'Key pressed. Page updating — secondary AI will instruct next step.';
    case 'browser_wait':
      return 'Wait complete.';
    case 'browser_click':
      return 'Clicked. Secondary AI is analyzing the result — wait for directive.';
    case 'browser_fill':
      return 'Input filled.';
    default:
      return `${toolName} complete.`;
  }
}
export function buildDesktopAck(toolName: string, result: ToolResult): string {
  if (result.error) {
    return `${toolName} failed: ${result.result.slice(0, 200)}`;
  }
  switch (toolName) {
    case 'desktop_screenshot':
      return 'Desktop screenshot captured. Secondary AI is analyzing window context and will direct next step.';
    case 'desktop_find_window':
      return 'Window search complete.';
    case 'desktop_focus_window':
      return 'Window focused.';
    case 'desktop_click':
      return 'Desktop click executed.';
    case 'desktop_drag':
      return 'Desktop drag executed.';
    case 'desktop_wait':
      return 'Desktop wait complete.';
    case 'desktop_type':
      return 'Text input sent to focused window.';
    case 'desktop_press_key':
      return 'Key press sent.';
    case 'desktop_get_clipboard':
      return 'Clipboard read complete.';
    case 'desktop_set_clipboard':
      return 'Clipboard updated.';
    default:
      return `${toolName} complete.`;
  }
}
export function isBrowserHeavyResearchPage(input: {
  url?: string;
  pageType?: string;
  snapshotElements?: number;
  feedCount?: number;
  goal?: string;
}): boolean {
  const url = String(input.url || '').toLowerCase();
  const pageType = String(input.pageType || '').toLowerCase();
  const elements = Number(input.snapshotElements || 0);
  const feedCount = Number(input.feedCount || 0);

  if (pageType === 'x_feed' || pageType === 'search_results' || pageType === 'article') return true;
  if (feedCount >= 6) return true;
  if (elements >= 10) return true;
  return /(x\.com|twitter\.com|reddit\.com|google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com|news|search\?q=)/.test(url);
}
export type SnapshotDiagnostics = {
  scanned: number;
  included: number;
  hidden: number;
  unlabeledNonInput: number;
  unnamedInputIncluded: number;
};
export type BrowserSnapshotQuality = {
  low: boolean;
  reasons: string[];
  elementCount: number;
  inputCandidates: number;
  dominantRoles: string[];
  diagnostics: SnapshotDiagnostics | null;
};
export function goalLikelyNeedsTextInput(goal: string): boolean {
  const text = String(goal || '');
  return /\b(type|fill|enter|input|message|say|send|search|write|reply|post|submit|login|log ?in|chat|comment)\b/i.test(text);
}
export function parseSnapshotDiagnostics(snapshot: string): SnapshotDiagnostics | null {
  const m = String(snapshot || '').match(
    /Snapshot diagnostics:\s*scanned=([0-9]*)\s+included=([0-9]*)\s+hidden=([0-9]*)\s+unlabeled_non_input=([0-9]*)\s+unnamed_input_included=([0-9]*)/i,
  );
  if (!m) return null;
  const toInt = (x: string) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  };
  return {
    scanned: toInt(m[1]),
    included: toInt(m[2]),
    hidden: toInt(m[3]),
    unlabeledNonInput: toInt(m[4]),
    unnamedInputIncluded: toInt(m[5]),
  };
}
export function evaluateBrowserSnapshotQuality(snapshot: string, snapshotElements: number, goal: string): BrowserSnapshotQuality {
  const elementCount = Number.isFinite(Number(snapshotElements)) ? Math.max(0, Math.floor(Number(snapshotElements))) : 0;
  const roleCounts = new Map<string, number>();
  let inputCandidates = 0;

  for (const raw of String(snapshot || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[@\d+\]\s+([a-z0-9_-]+)/i);
    if (!m) continue;
    const role = String(m[1] || '').toLowerCase();
    roleCounts.set(role, (roleCounts.get(role) || 0) + 1);
    if (
      /\[INPUT\]/i.test(line)
      || role === 'textbox'
      || role === 'searchbox'
      || role === 'combobox'
      || role === 'textarea'
    ) {
      inputCandidates++;
    }
  }

  const dominantRoles = Array.from(roleCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([role, count]) => `${role}:${count}`);
  const diagnostics = parseSnapshotDiagnostics(snapshot);
  const reasons: string[] = [];
  const needsInput = goalLikelyNeedsTextInput(goal);
  if (elementCount < 10) reasons.push(`low_elements=${elementCount}`);
  if (needsInput && inputCandidates === 0) reasons.push('expected_input_but_none_detected');
  if (needsInput && inputCandidates === 0 && dominantRoles.length) {
    reasons.push(`top_roles=${dominantRoles.join(',')}`);
  }
  if (diagnostics && diagnostics.hidden > diagnostics.included) {
    reasons.push('many_hidden_candidates');
  }
  if (diagnostics && diagnostics.unlabeledNonInput > diagnostics.included) {
    reasons.push('many_unlabeled_non_input_candidates');
  }

  return {
    low: reasons.length > 0,
    reasons,
    elementCount,
    inputCandidates,
    dominantRoles,
    diagnostics,
  };
}
export interface HandleChatResult {
  type: 'chat' | 'execute';
  text: string;
  thinking?: string;
  toolResults?: ToolResult[];
}
export const modelSwitchHintedSessions = new Set<string>();
export function maybeSuggestModelSwitch(
  sessionId: string,
  message: string,
  history: Array<{ role: string; content: any }>,
  sendSSE: (event: string, data: any) => void,
): void {
  try {
    const cfg = getConfig().getConfig() as any;
    const presets = Object.values(cfg?.llm?.presets || {});
    if (presets.length < 2) return;
    if (modelSwitchHintedSessions.has(sessionId)) return;
    const approxChars = String(message || '').length
      + (history || []).reduce((n: number, h) => n + String(h?.content || '').length, 0);
    const heavyWording = /整个项目|全部文件|整个工作区|大规模|批量|分析所有|全量|超长|几万字|几百个文件|几千行/i.test(String(message || ''));
    if (approxChars > 18000 || heavyWording) {
      modelSwitchHintedSessions.add(sessionId);
      sendSSE('info', {
        message: '当前请求上下文较大或较复杂。若回答质量不足，可在「设置 → 模型档案」一键切换到更强模型。',
      });
    }
  } catch { /* never break the turn */ }
}
export function buildMultimodalUserContent(rawMessage: string, workspacePath: string): string | any[] {  const markerRe = /\[attached file\]\s+([^\n]+)/g;
  const attached: string[] = [];
  const text = rawMessage.replace(markerRe, (_, p: string) => {
    attached.push(String(p || '').trim());
    return '';
  }).trim();

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
  const MAX_IMAGES = 3;
  const MAX_BYTES = 8 * 1024 * 1024;
  const wsNorm = String(workspacePath || '').toLowerCase().replace(/[\\/]+$/, '');

  const imageParts: any[] = [];
  for (const rawPath of attached.slice(0, MAX_IMAGES)) {
    if (!rawPath) continue;
    // Relative paths must stay inside the workspace (path-escape guard).
    if (!path.isAbsolute(rawPath)) {
      const resolved = path.resolve(workspacePath || '', rawPath);
      if (
        wsNorm &&
        resolved.toLowerCase() !== wsNorm &&
        !resolved.toLowerCase().startsWith(wsNorm + path.sep)
      ) continue;
    }
    if (!IMAGE_EXT.test(rawPath)) continue; // non-image attachment -> keep as text
    const candidate = path.isAbsolute(rawPath) ? rawPath : path.join(workspacePath || '', rawPath);
    let buf: Buffer;
    try {
      buf = fs.readFileSync(candidate);
    } catch { continue; }
    if (!buf.length || buf.length > MAX_BYTES) continue;
    const ext = path.extname(candidate).toLowerCase().replace(/^\./, '');
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    imageParts.push({
      type: 'image_url',
      image_url: { url: `data:image/${mime};base64,${buf.toString('base64')}` },
    });
  }

  if (!imageParts.length) return text;
  const parts: any[] = [{ type: 'text', text: text || '请描述这张图片。' }];
  parts.push(...imageParts);
  return parts;
}
export const MAX_TOOL_ARG_PARSE_RETRIES = 1;
export const TOOL_ARG_PARSE_RETRY_HINT =
  '你的上一条工具调用参数（arguments）不是合法 JSON，模型服务端解析失败，该调用未被执行。\n' +
  '请重新发起该工具调用，并遵守：\n' +
  '1. arguments 必须是严格合法的 JSON 对象：键和字符串值都用双引号，无尾随逗号；\n' +
  '2. 参数值内的引号、换行、反斜杠必须正确转义；\n' +
  '3. 如果某个参数内容非常长（例如整个 HTML 文件全文），不要一次性塞进工具参数——先用 create_file 写入骨架，再分几步追加或整文件重写；\n' +
  '4. 不要重复调用已经成功完成的工具，直接继续下一步。';
export let nctxProbe: { key: string; value: number; at: number } | null = null;
export const NCTX_PROBE_TTL_MS = 30_000;
export async function probeLlamaNctx(endpoint: string, modelPath: string): Promise<number | null> {
  const key = `${endpoint}|${modelPath}`;
  if (nctxProbe && nctxProbe.key === key && Date.now() - nctxProbe.at < NCTX_PROBE_TTL_MS) {
    return nctxProbe.value > 0 ? nctxProbe.value : null;
  }
  let value = 0;
  try {
    const url = String(endpoint || 'http://localhost:8080').replace(/\/+$/, '');
    const res = await fetch(`${url}/props`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const props: any = await res.json();
      // llama-server exposes n_ctx inside default_generation_settings; tolerate
      // a top-level n_ctx too in case the schema moves.
      const nctx = Number(props?.default_generation_settings?.n_ctx ?? props?.n_ctx);
      if (Number.isFinite(nctx) && nctx > 0) value = nctx;
    }
  } catch {
    // probe failure (server down / not llama.cpp) → fall back to config below
  }
  nctxProbe = { key, value, at: Date.now() };
  return value > 0 ? value : null;
}
export async function resolveHistoryBudgetTokens(): Promise<number> {
  const explicit = Number(process.env.SMALLCLAW_HISTORY_BUDGET_TOKENS);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const raw = getConfig().getConfig() as any;
  const llm = raw?.llm || {};
  const preset = llm.presets?.[String(llm.active_preset || '')];
  let window = 131072;
  if (preset) {
    if (preset.provider === 'llama_cpp') {
      // Context follows the LIVE llama-server (e.g. -c 128000), not a stale
      // preset ctx_size. The preset value is only the fallback when the
      // server cannot be probed.
      const endpoint = String(preset.providers?.llama_cpp?.endpoint || 'http://localhost:8080');
      const modelPath = String(preset.server?.model_path || preset.providers?.llama_cpp?.model || '');
      const liveNctx = await probeLlamaNctx(endpoint, modelPath);
      if (liveNctx) {
        window = liveNctx;
        console.log(`[v2] CTX: active preset "${String(llm.active_preset)}" probed n_ctx=${liveNctx} from live llama-server`);
      } else {
        const serverCtx = Number(preset.server?.ctx_size);
        if (Number.isFinite(serverCtx) && serverCtx > 0) window = serverCtx;
      }
    } else {
      const explicitWindow = Number(preset.context_window);
      if (Number.isFinite(explicitWindow) && explicitWindow > 0) {
        window = explicitWindow;
      } else {
        const serverCtx = Number(preset.server?.ctx_size);
        if (Number.isFinite(serverCtx) && serverCtx > 0) window = serverCtx;
      }
    }
  }
  const budget = Math.round(window * 0.5);
  return Math.min(60000, Math.max(8000, budget));
}
export function computeSessionMetaAnswer(
  message: string,
  hist: Array<{ role: string; content: any }>,
  userCount: number,
  asstCount: number,
): string {
  const m = String(message || '').trim();
  if (!m) return '';

  // Guard: questions about a specific location/object are not meta questions.
  if (/(在哪|哪里|怎么|为什么|什么文件|哪个文件)/.test(m)) return '';

  // 1) Counting questions: "几组/多少组/几轮/多少轮/几条/多少条/组对话/轮对话/条消息"
  if (/(几组|多少组|几轮|多少轮|几条|多少条|几段|多少段|几轮对话|组对话|轮对话|条消息|组消息|段对话)/i.test(m)) {
    const pairs = Math.min(userCount, asstCount);
    return `当前会话共 ${pairs} 组对话（${hist.length} 条消息：${userCount} 条用户消息、${asstCount} 条助手消息）。`;
  }

  // 2) Last-exchange questions: "最后/最近/上一/刚才 + 聊天/对话/内容/说了/聊"
  if (/(最后|最近|上一|刚才).{0,8}(聊天|对话|内容|消息|说过|说了|讲了|聊)/i.test(m)) {
    let lastAsstIdx = -1;
    for (let i = hist.length - 1; i >= 0; i--) {
      if (hist[i].role === 'assistant') { lastAsstIdx = i; break; }
    }
    if (lastAsstIdx === -1) return '';
    let userIdx = -1;
    for (let i = lastAsstIdx - 1; i >= 0; i--) {
      if (hist[i].role === 'user') { userIdx = i; break; }
    }
    const asstText = String(hist[lastAsstIdx].content || '').replace(/\s+/g, ' ').slice(0, 300);
    const usrText = userIdx >= 0 ? String(hist[userIdx].content || '').replace(/\s+/g, ' ').slice(0, 200) : '';
    if (userIdx >= 0) {
      return `最后一组聊天内容：\n- 用户：${usrText}\n- 助手：${asstText}`;
    }
    return `最后一组聊天内容是助手回复：${asstText}`;
  }

  return '';
}
export function buildChatLogReport(
  message: string,
  hist: Array<{ role: string; content: any; timestamp?: any }>,
): { summary: string; html: string } | null {
  if (!hist.length) return null;
  const userCount = hist.filter((m) => m.role === 'user').length;
  const asstCount = hist.filter((m) => m.role === 'assistant').length;
  const pairs = Math.min(userCount, asstCount);

  const esc = (s: any): string =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const groups: string[] = [];
  let pendingUser: string | null = null;
  let pendingTs = '';
  for (const m of hist) {
    const text = String(m.content || '').replace(/\s+/g, ' ').trim();
    const ts = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    if (m.role === 'user') {
      pendingUser = text;
      pendingTs = ts;
    } else if (m.role === 'assistant' && pendingUser !== null) {
      groups.push(
        `<div class="group"><div class="ts">${esc(pendingTs)}</div>` +
        `<div class="msg user"><span class="who">用户</span><div class="body">${esc(pendingUser || '（空）')}</div></div>` +
        `<div class="msg asst"><span class="who">助手</span><div class="body">${esc(text || '（空）')}</div></div>` +
        `</div>`,
      );
      pendingUser = null;
    }
  }
  if (pendingUser !== null) {
    groups.push(
      `<div class="group"><div class="ts">${esc(pendingTs)}</div>` +
      `<div class="msg user"><span class="who">用户</span><div class="body">${esc(pendingUser || '（空）')}</div></div>` +
      `<div class="msg asst"><span class="who">助手</span><div class="body">（尚未回复）</div></div>` +
      `</div>`,
    );
  }

  const generatedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>聊天记录报告</title>
<style>
  body{margin:0;padding:32px 16px;background:#f5f6f8;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:#1a1b1c;}
  .wrap{max-width:860px;margin:0 auto;}
  h1{font-size:24px;color:#2c5f8a;margin:0 0 8px;}
  .meta{color:#5f6670;font-size:13px;margin-bottom:24px;line-height:1.7;}
  .group{background:#fff;border:1px solid #e4e3dd;border-radius:8px;padding:16px 18px;margin-bottom:14px;}
  .ts{font-size:12px;color:#8a9099;margin-bottom:10px;}
  .msg{display:flex;gap:10px;margin-bottom:10px;}
  .msg:last-child{margin-bottom:0;}
  .who{flex:0 0 40px;font-size:12px;font-weight:600;padding-top:4px;text-align:center;border-radius:4px;height:22px;line-height:22px;}
  .msg.user .who{background:#e8f1f8;color:#2c5f8a;}
  .msg.asst .who{background:#eef7ee;color:#35705a;}
  .body{flex:1;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}
</style>
</head>
<body>
<div class="wrap">
  <h1>聊天记录报告</h1>
  <div class="meta">生成时间：${esc(generatedAt)}<br>共 ${pairs} 组对话（${hist.length} 条消息：${userCount} 条用户、${asstCount} 条助手）</div>
  ${groups.join('\n  ')}
</div>
</body>
</html>
`;
  const summary = `已生成聊天记录报告（HTML 格式）：共 ${pairs} 组对话（${hist.length} 条消息：${userCount} 条用户、${asstCount} 条助手）。`;
  return { summary, html };
}
