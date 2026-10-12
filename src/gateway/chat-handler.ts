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

import { ANALYSIS_INJECT_MAX_CHARS, normalizeToolArgs, resolveAnalysisTarget } from './chat-execution';
import { addMessage, getHistoryForApiCall, getSession, getWorkspace, setWorkspace } from './session';
import { applyToolPolicy, buildTools, filterToolsByIntent } from './tool-registry';
import { findBlockedTaskForSession, inferTaskChannelFromSession } from './task-integration';
import { BackgroundTaskRunner } from './background-task-runner';
import { PreemptState, raceWithWatchdog } from './preempt-watchdog';
import { getOllamaClient } from '../agents/ollama-client';
import { TelegramChannel } from './telegram-channel';
import { detectAnalysisScenario, buildScenarioContext } from './scenario-tuned-prompt';

import { isBrowserToolName, isDesktopToolName, isGreetingLikeMessage, separateThinkingFromContent, stripExplicitThinkTags, logToolCall, extractLikelyUrl, looksLikeSafetyRefusal, sanitizeFinalReply, isBrowserAutomationRequest, isDesktopAutomationRequest, hasConcreteCompletion, isHighStakesFile, requestedFullTemplate, isToolArgParseFailure } from './server-v2-text';
import { OrchestrationTriggerState, callSecondaryPreflight, callSecondaryAdvisor, callSecondaryFileOpClassifier, callSecondaryFileVerifier, callSecondaryFilePatchPlanner, callSecondaryBrowserAdvisor, callSecondaryDesktopAdvisor, shouldRunPreflight, formatPreflightHint, formatPreflightExecutionObjective, formatAdvisoryHint, formatBrowserAdvisorHint, formatDesktopAdvisorHint, clampPreemptConfig } from '../orchestration/multi-agent';
import { FileOpProgressWatchdog, FileOpType, classifyFileOpType, resolveFileOpSettings, isFileMutationTool, isFileCreateTool, extractFileToolTarget, estimateFileToolChange, canPrimaryApplyFileTool, shouldVerifyFileTurn, isSmallSuggestedFix, buildFailureSignature, buildPatchSignature, clearFileOpCheckpoint, loadFileOpCheckpoint, saveFileOpCheckpoint } from '../orchestration/file-op-v2';
import { getBrowserSessionInfo, getBrowserAdvisorPacket } from './browser-tools';
import { getDesktopAdvisorPacket } from './desktop-tools';
import { flowsManager } from './flow-integration';
import { broadcastWS } from './realtime';
import { executeKnowledgeTool } from '../tools/knowledge';
import { OllamaProcessManager } from './ollama-process-manager';
import { getWorkflowContextBlock } from './agent-builder-integration';
import { createTask, loadTask, saveTask, appendJournal } from './task-store';
import { runTask, type TaskState } from './task-runner';
import { consumeLastDocPreview, parseDocPreview } from '../tools/office';
import { SkillsManager } from './skills-manager';


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
// ── In-round context budget: cross-turn shared state ───────────────────────
// Calibration + adaptive budget live at MODULE level so they persist across
// chat turns (per-turn state would reset every request and never learn the
// real chars→tokens density of the active model). handleChat reads/writes
// them directly, so they stay here (TS imports are read-only bindings).
const INROUND_SLOW_TPS = 8;    // below this → shrink budget (small-model friendly)
const INROUND_FAST_TPS = 20;   // above this → relax budget back toward base
const INROUND_MIN_BUDGET = 4000;
let inRoundCtxCharPerToken = 1.0;  // conservative start: 1 CJK char ≈ 1 token
let inRoundLastSentChars = 0;      // chars actually sent in the last generation
let inRoundAdaptiveBudget = 0;     // 0 = not initialized for the active model yet
let inRoundBudgetModelKey = '';    // resets calibration when the model changes

// ── Chat-loop factory ────────────────────────────────────────────────────────
// handleChat closes over six server-v2 composition-root singletons; they are
// injected here to avoid a circular import (chat-handler cannot import server-v2).
// All callers (cron/telegram/heartbeat/boot/task runners) resolve handleChat at
// runtime, so wiring order in server-v2 is irrelevant.
export interface ChatHandlerDeps {
  executeTool: (name: string, args: any, workspacePath: string, sessionId: string, emit?: (event: string, data: any) => void) => Promise<ToolResult>;
  telegramChannel: TelegramChannel;
  makeBroadcastForTask: (taskId: string) => (data: object) => void;
  isOrchestrationSkillEnabled: () => boolean;
  resolveModelTier: () => Promise<'small' | 'mid' | 'large'>;
  KNOWLEDGE_DIR: string;
  skillsManager: SkillsManager;
  buildPersonalityContext: (sessionId: string, workspacePath: string, messageText: string, executionMode: string, historyLength: number) => Promise<string>;
  renderFlowInstruction: (instruction: string) => string;
  activeTasks: Map<string, TaskState>;
}

export function createChatHandler(deps: ChatHandlerDeps) {
  return async function handleChat(
  message: string,
  sessionId: string,
  sendSSE: (event: string, data: any) => void,
  pinnedMessages?: Array<{ role: string; content: string }>,
  abortSignal?: { aborted: boolean },
  callerContext?: string,
  modelOverride?: string,
  executionMode: ExecutionMode = 'interactive',
  suppressFlowTrigger = false,
): Promise<HandleChatResult> {
  const ollama = getOllamaClient();
  const isBootStartupTurn = /\bBOOT\.md\b/i.test(String(callerContext || ''));
  const bootAllowedTools = new Set(['list_files', 'read_file']);
  const configuredWorkspace = getConfig().getWorkspacePath();
  const sessionWorkspace = getWorkspace(sessionId);
  const workspacePath = configuredWorkspace || sessionWorkspace;
  if (workspacePath && sessionWorkspace !== workspacePath) {
    setWorkspace(sessionId, workspacePath);
  }
  // Merged optimization tier: live n_ctx (hard constraint) × parameter size
  // (soft constraint). Computed once per turn so buildTools/filter use one value.
  const tier = await deps.resolveModelTier();
  console.log(`[v2] SESSION: ${sessionId} | Workspace: ${workspacePath}`);
  const history = getHistoryForApiCall(sessionId, 5);
  const tools = applyToolPolicy(
    isBootStartupTurn
      ? buildTools(tier, { isOrchestrationSkillEnabled: deps.isOrchestrationSkillEnabled }).filter((t: any) => bootAllowedTools.has(String(t?.function?.name || '')))
      : filterToolsByIntent(buildTools(tier, { isOrchestrationSkillEnabled: deps.isOrchestrationSkillEnabled }), message, tier),
    sessionId,
  );
  console.log(`[v2] TOOLS: n=${tools.length} chars=${JSON.stringify(tools).length} estTokens=${Math.ceil(JSON.stringify(tools).length / 3.6)}`);
  const allToolResults: ToolResult[] = [];
  let toolArgParseRetries = 0;
  let allThinking = '';
  let preflightReasonForTurn = '';
  let continuationNudges = 0;
  const MAX_CONTINUATION_NUDGES = 2;
  const orchestrationSkillEnabled = deps.isOrchestrationSkillEnabled();
  const greetingLikeTurn = isGreetingLikeMessage(message);

  // ── Preempt watchdog setup ─────────────────────────────────────────────────
  const rawCfgForPreempt = (getConfig().getConfig() as any);
  const primaryProvider = rawCfgForPreempt.llm?.provider || 'ollama';
  const preemptCfg: {
    enabled: boolean;
    stallThresholdMs: number;
    maxPerTurn: number;
    maxPerSession: number;
    restartMode: 'inherit_console' | 'detached_hidden';
  } = (() => {
    const oc = rawCfgForPreempt.orchestration;
    const preemptRaw = {
      ...(oc?.preempt || {}),
      restart_mode: oc?.preempt?.restart_mode
        || process.env.SMALLCLAW_OLLAMA_RESTART_MODE
        || (process.platform === 'win32' ? 'inherit_console' : 'detached_hidden'),
    };
    const normalizedPreempt = clampPreemptConfig(preemptRaw);
    return {
      enabled: orchestrationSkillEnabled
        && primaryProvider === 'ollama'
        && normalizedPreempt.enabled,
      stallThresholdMs: normalizedPreempt.stall_threshold_seconds * 1000,
      maxPerTurn: normalizedPreempt.max_preempts_per_turn,
      maxPerSession: normalizedPreempt.max_preempts_per_session,
      restartMode: normalizedPreempt.restart_mode === 'detached_hidden'
        ? 'detached_hidden'
        : 'inherit_console',
    };
  })();
  const preemptState = new PreemptState();
  preemptState.preemptsThisSession = getPreemptSessionCount(sessionId);
  const ollamaEndpoint = rawCfgForPreempt.llm?.providers?.ollama?.endpoint
    || rawCfgForPreempt.ollama?.endpoint
    || 'http://localhost:11434';
  const ollamaProcMgr = preemptCfg.enabled
    ? new OllamaProcessManager({ endpoint: ollamaEndpoint, restartMode: preemptCfg.restartMode })
    : null;
  let browserContinuationPending = false;
  let browserAdvisorRoute: 'answer_now' | 'continue_browser' | 'collect_more' | 'handoff_primary' | null = null;
  let browserAdvisorHintPreview = '';
  let browserForcedRetries = 0;
  let browserAdvisorCallsThisTurn = 0;
  // Scroll-before-act gate: tracks whether a fill/click has happened yet this turn.
  // Blocks PageDown/scroll calls on interactive pages until the model actually acts.
  let browserFillOrClickDoneThisTurn = false;
  let browserScrollBeforeActCount = 0;
  const SCROLL_BEFORE_ACT_MAX = 1; // allow at most 1 scroll before a fill/click
  let desktopContinuationPending = false;
  let desktopAdvisorRoute: 'answer_now' | 'continue_desktop' | 'handoff_primary' | null = null;
  let desktopAdvisorHintPreview = '';
  let desktopAdvisorCallsThisTurn = 0;
  let browserAdvisorLastHash = '';
  let browserAdvisorUrlKey = '';
  let consecutiveUnchangedSnapshots = 0;
  let browserAdvisorBatch = 0;
  let browserAdvisorDedupeCount = 0;
  let browserNoFeedProgressStreak = 0;
  let browserStabilizeUrlKey = '';
  let browserStabilizeWaitRetries = 0;
  let browserStabilizeTabProbes = 0;
  let browserStabilizeExhausted = false;
  const browserAdvisorCollectedFeed: Array<Record<string, any>> = [];
  const browserAdvisorSeenFeedKeys = new Set<string>();
  const orchRuntimeCfg = getOrchestrationConfig();
  const fileOpSettings = resolveFileOpSettings(orchRuntimeCfg as any);

  // 根据当前激活的 provider 自适应文件操作阈值：
  // 云端 API 大模型（openai / openai_codex）放宽到上限，本地小模型保持保守值，
  // 用户切档案时无需手动改 config.json。
  {
    const rawCfgNow = getConfig().getConfig();
    const llmNow: any = rawCfgNow.llm || {};
    const activePresetNow = llmNow.presets?.[String(llmNow.active_preset || '')];
    const effProviderNow = String(activePresetNow?.provider || llmNow.provider || 'ollama');
    const isCloud = effProviderNow === 'openai' || effProviderNow === 'openai_codex';
    if (isCloud) {
      fileOpSettings.primary_create_max_lines = 400;
      fileOpSettings.primary_create_max_chars = 40000;
      fileOpSettings.primary_edit_max_lines = 50;
      fileOpSettings.primary_edit_max_chars = 4000;
    } else {
      fileOpSettings.primary_create_max_lines = 100;
      fileOpSettings.primary_create_max_chars = 6000;
      fileOpSettings.primary_edit_max_lines = 20;
      fileOpSettings.primary_edit_max_chars = 1500;
    }
  }
  const fileOpRouterEnabled =
    orchestrationSkillEnabled
    && (orchRuntimeCfg?.enabled ?? false)
    && fileOpSettings.enabled
    && !isBootStartupTurn;
  const localFileOpClassification = fileOpRouterEnabled
    ? classifyFileOpType(message)
    : { type: 'CHAT' as FileOpType, reason: 'file-op v2 disabled' };
  let fileOpClassification = localFileOpClassification;
  if (fileOpRouterEnabled) {
    const secondaryClass = await callSecondaryFileOpClassifier({
      userMessage: message,
      recentHistory: history.slice(-4).map(h => ({ role: h.role, content: h.content })),
    });
    if (secondaryClass) {
      fileOpClassification = {
        type: secondaryClass.operation as FileOpType,
        reason: `secondary classifier: ${secondaryClass.reason || 'runtime classification'} (confidence ${secondaryClass.confidence.toFixed(2)})`,
      };
      sendSSE('orchestration', {
        trigger: 'file_op_classifier',
        mode: 'router',
        route: secondaryClass.operation === 'BROWSER_OP'
          ? 'browser_ops'
          : secondaryClass.operation === 'DESKTOP_OP'
            ? 'desktop_ops'
            : (secondaryClass.operation === 'CHAT' ? 'chat' : 'file_ops'),
        reason: secondaryClass.reason || 'secondary runtime classification',
        operation: secondaryClass.operation,
        confidence: secondaryClass.confidence,
      });
    } else {
      // Secondary classifier unavailable — degrade to local classifier rather than
      // collapsing to CHAT. Falling back to CHAT silently strips all file-op gating
      // and verification, letting unchecked primary writes bypass all thresholds.
      // Local classification is conservative (FILE_EDIT/FILE_CREATE) and safer.
      sendSSE('info', {
        message: `FILE_OP router: secondary classifier unavailable; degrading to local classification (${localFileOpClassification.type}).`,
      });
      fileOpClassification = {
        type: localFileOpClassification.type,
        reason: `secondary classifier unavailable — local fallback: ${localFileOpClassification.reason}`,
      };
    }
  }
  // User preference: no automatic browser retries/snapshots.
  // Let the model explicitly decide when to call browser_snapshot.
  const browserAutoSnapshotRetriesEnabled = false;
  const browserMaxForcedRetries = browserAutoSnapshotRetriesEnabled
    ? (orchRuntimeCfg?.browser?.max_forced_retries ?? 2)
    : 0;
  const browserMaxAdvisorCallsPerTurn = orchRuntimeCfg?.browser?.max_advisor_calls_per_turn ?? 5;
  const desktopMaxAdvisorCallsPerTurn = 4;
  const browserMaxCollectedItems = orchRuntimeCfg?.browser?.max_collected_items ?? 80;
  const browserMinFeedItemsBeforeAnswer = orchRuntimeCfg?.browser?.min_feed_items_before_answer ?? 12;
  const browserStabilizeMaxWaitRetries = browserAutoSnapshotRetriesEnabled ? 2 : 0;
  const browserStabilizeMaxTabProbes = browserAutoSnapshotRetriesEnabled ? 2 : 0;
  const browserPacketMaxItems = Math.max(12, Math.min(60, Math.min(browserMaxCollectedItems, 40)));
  const seenToolCalls = new Set<string>();
  const cachedReadOnlyToolResults = new Map<string, ToolResult>();
  const canReplayReadOnlyCall = (toolName: string): boolean =>
    toolName === 'list_files' || toolName === 'read_file';
  const loopDetectionEnabled = orchRuntimeCfg?.triggers?.loop_detection !== false;
  const loopWarningThreshold = 3;
  const loopCriticalThreshold = 5;
  const loopWarnNudged = new Set<string>();
  const loopBlockNudged = new Set<string>();
  const recentToolCalls: Array<{ name: string; argsHash: string }> = [];
  const hashArgs = (args: any): string => {
    try {
      const normalize = (v: any): any => {
        if (Array.isArray(v)) return v.map(normalize);
        if (v && typeof v === 'object') {
          const out: Record<string, any> = {};
          for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
          return out;
        }
        return v;
      };
      return JSON.stringify(normalize(args || {})).slice(0, 200);
    } catch {
      return String(args || '').slice(0, 200);
    }
  };
  const checkLoopDetection = (toolName: string, args: any): { state: 'ok' | 'warn' | 'block'; repeats: number } => {
    if (!loopDetectionEnabled) return { state: 'ok', repeats: 1 };
    const argsHash = hashArgs(args);
    // Count includes this current attempt so thresholds are exact:
    // warning at 3rd identical call, block at 5th.
    const repeats = recentToolCalls.filter((t) => t.name === toolName && t.argsHash === argsHash).length + 1;
    recentToolCalls.push({ name: toolName, argsHash });
    if (recentToolCalls.length > 20) recentToolCalls.shift();
    if (repeats >= loopCriticalThreshold) return { state: 'block', repeats };
    if (repeats >= loopWarningThreshold) return { state: 'warn', repeats };
    return { state: 'ok', repeats };
  };
  const orchestrationState = new OrchestrationTriggerState();
  const orchestrationLog: string[] = [];
  const orchestrationStats = getOrchestrationSessionStats(sessionId);
  // Cached once per turn — used by browser interception, preempt nudge, and advisor calls
  const multiAgentActive = orchestrationSkillEnabled && ((getOrchestrationConfig()?.enabled) ?? false);
  const fileOpV2Active = multiAgentActive
    && fileOpSettings.enabled
    && (fileOpClassification.type === 'FILE_ANALYSIS' || fileOpClassification.type === 'FILE_CREATE' || fileOpClassification.type === 'FILE_EDIT');
  const fileOpType = fileOpClassification.type;
  // FILE_ANALYSIS is handled by the PRIMARY model with its read tools (it can
  // actually read the target file). A tool-less secondary analyzer used to
  // answer from a truncated file-name list and misdiagnosed existing files as
  // missing — the user's rule: when the model can't complete a task alone, call
  // tools to complete it.
  let fileOpOwner: 'primary' | 'secondary' = 'primary';
  const fileOpTouchedFiles = new Set<string>();
  const fileOpToolHistory: Array<{
    tool: string;
    args: any;
    result: string;
    error: boolean;
    actor: 'primary' | 'secondary';
    estimate_lines: number;
    estimate_chars: number;
  }> = [];
  let fileOpPrimaryWriteLines = 0;
  let fileOpPrimaryWriteChars = 0;
  let fileOpHadCreate = false;
  let fileOpHadToolFailure = false;
  let fileOpLastFailureSignature = '';
  const fileOpPatchSignatures: string[] = [];
  const fileOpWatchdog = new FileOpProgressWatchdog(fileOpSettings.watchdog_no_progress_cycles);
  const resumedFileOpCheckpoint = (fileOpV2Active && fileOpSettings.checkpointing_enabled)
    ? loadFileOpCheckpoint(sessionId)
    : null;
  if (
    resumedFileOpCheckpoint
    && resumedFileOpCheckpoint.goal === message
    && resumedFileOpCheckpoint.phase !== 'done'
  ) {
    fileOpOwner = resumedFileOpCheckpoint.owner || fileOpOwner;
    for (const f of resumedFileOpCheckpoint.files_changed || []) {
      if (f) fileOpTouchedFiles.add(String(f));
    }
    for (const sig of resumedFileOpCheckpoint.patch_history_signatures || []) {
      if (sig) fileOpPatchSignatures.push(String(sig));
    }
    if (fileOpPatchSignatures.length > 20) {
      fileOpPatchSignatures.splice(0, fileOpPatchSignatures.length - 20);
    }
  }
  // Synthetic tool calls queued by the browser advisor for deterministic next steps.
  // When set, the main loop skips LLM generation and executes these directly.
  let pendingSyntheticToolCalls: Array<{ function: { name: string; arguments: any } }> = [];

  const trackFileOpMutation = (toolName: string, toolArgs: any, toolResult: ToolResult, actor: 'primary' | 'secondary') => {
    if (!isFileMutationTool(toolName)) return;
    const estimate = estimateFileToolChange(toolName, toolArgs);
    const target = extractFileToolTarget(toolName, toolArgs);
    if (target) fileOpTouchedFiles.add(target);
    if (actor === 'primary') {
      fileOpPrimaryWriteLines += estimate.lines_changed;
      fileOpPrimaryWriteChars += estimate.chars_changed;
    }
    if (isFileCreateTool(toolName) && !toolResult.error) fileOpHadCreate = true;
    if (toolResult.error) fileOpHadToolFailure = true;
    fileOpToolHistory.push({
      tool: toolName,
      args: toolArgs,
      result: toolResult.result,
      error: toolResult.error,
      actor,
      estimate_lines: estimate.lines_changed,
      estimate_chars: estimate.chars_changed,
    });
    if (fileOpToolHistory.length > 64) fileOpToolHistory.shift();
    maybeSaveFileOpCheckpoint({
      phase: 'execute',
      next_action: `${actor} applied ${toolName}`,
    });
  };

  const maybeSaveFileOpCheckpoint = (patch: {
    phase: 'plan' | 'execute' | 'verify' | 'repair' | 'done';
    next_action: string;
    findings?: any[];
  }) => {
    if (!fileOpV2Active || !fileOpSettings.checkpointing_enabled) return;
    saveFileOpCheckpoint(sessionId, {
      goal: message,
      phase: patch.phase,
      owner: fileOpOwner,
      operation: fileOpType,
      files_changed: Array.from(fileOpTouchedFiles).slice(0, 24),
      last_verifier_findings: Array.isArray(patch.findings) ? patch.findings : [],
      patch_history_signatures: fileOpPatchSignatures.slice(-12),
      next_action: patch.next_action,
    });
  };

  const executeSecondaryPatchCalls = async (
    calls: Array<{ tool: string; args: any }>,
    reason: string,
  ): Promise<{ ran: number; patchSignature: string }> => {
    const planCalls = (calls || []).filter(c => c && c.tool && typeof c.args === 'object');
    if (!planCalls.length) return { ran: 0, patchSignature: '' };
    const patchSignature = buildPatchSignature(planCalls.map(c => ({ tool: c.tool, args: c.args })));
    fileOpPatchSignatures.push(patchSignature);
    if (fileOpPatchSignatures.length > 20) fileOpPatchSignatures.shift();
    sendSSE('info', { message: `FILE_OP v2: applying ${planCalls.length} secondary patch call(s) (${reason}).` });
    let ran = 0;
    for (const call of planCalls) {
      const toolName = String(call.tool || '').trim();
      const toolArgs = call.args || {};
      sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1, synthetic: true, actor: 'secondary' });
      const toolResult = await deps.executeTool(toolName, toolArgs, workspacePath, sessionId, sendSSE);
      allToolResults.push(toolResult);
      logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
      trackFileOpMutation(toolName, toolArgs, toolResult, 'secondary');
      if (toolResult.error) fileOpHadToolFailure = true;
      sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 500), error: toolResult.error, stepNum: allToolResults.length, synthetic: true, actor: 'secondary' });
      const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
      const isBrowserTool = isBrowserToolName(toolName);
      const isDesktopTool = isDesktopToolName(toolName);
      const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
        ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
        : toolResult.result;
      messages.push({ role: 'tool', tool_name: toolName, content: toolMessageContent + goalReminder });
      orchestrationLog.push(
        toolResult.error
          ? `✗ [secondary_patch] ${toolName}: ${toolResult.result.slice(0, 100)}`
          : `✓ [secondary_patch] ${toolName}: ${toolResult.result.slice(0, 80)}`,
      );
      ran++;
    }
    return { ran, patchSignature };
  };

  if (fileOpV2Active) {
    sendSSE('info', {
      message: `FILE_OP v2 active: ${fileOpType} (${fileOpClassification.reason}).`,
    });
    sendSSE('orchestration', {
      trigger: 'file_op_router',
      mode: 'router',
      route: 'file_ops',
      reason: `${fileOpType} (${fileOpClassification.reason})`,
      file_op_type: fileOpType,
      owner: fileOpOwner,
    });
    if (resumedFileOpCheckpoint && resumedFileOpCheckpoint.goal === message && resumedFileOpCheckpoint.phase !== 'done') {
      sendSSE('info', {
        message: `FILE_OP v2: resuming checkpoint at phase="${resumedFileOpCheckpoint.phase}" next="${resumedFileOpCheckpoint.next_action || 'n/a'}".`,
      });
    } else {
      maybeSaveFileOpCheckpoint({
        phase: 'plan',
        next_action: 'primary execution',
      });
    }
  }

  // ── Scenario-tuned prompt (Phase 7a): analysis/summary tasks get a compact
  // <300-char system instead of the full personality injection — fewer tokens
  // for 2-9B local models, and no memory noise steering the current task.
  const scenarioCtx = detectAnalysisScenario(message) ? buildScenarioContext(message) : '';
  if (scenarioCtx) console.log(`[v2] SCENARIO tuned system active (${scenarioCtx.length} chars, vs full personality)`);

  const personalityCtx = scenarioCtx
    ? scenarioCtx
    : await deps.buildPersonalityContext(sessionId, workspacePath, message, executionMode || 'interactive', history.length);

  // Inject active browser session state so LLM knows to reuse it instead of re-opening
  const browserInfo = getBrowserSessionInfo(sessionId);
  const browserStateCtx = browserInfo.active
    ? `\n\n[BROWSER SESSION ACTIVE: A browser tab is already open.${
        browserInfo.title ? ` Current page: "${browserInfo.title}"` : ''
      }${
        browserInfo.url ? ` at ${browserInfo.url}` : ''
      }. Use browser_snapshot to see current elements, or browser_click to navigate. Do NOT call browser_open unless you need to go to a completely different site.]`
    : '';

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const executionModeSystemBlock = (() => {
    if (executionMode === 'background_task') {
      return [
        'EXECUTION MODE: Autonomous background task.',
        'You are running without user oversight. Do not ask clarifying questions.',
        'Make decisions based on available context. Use tools precisely.',
        'If truly blocked: return a concise blocked reason and the best next action.',
      ].join('\n');
    }
    if (executionMode === 'heartbeat') {
      return [
        'EXECUTION MODE: Heartbeat check.',
        'Run concise, decisive checks and report only actionable issues.',
      ].join('\n');
    }
    if (executionMode === 'cron') {
      return [
        'EXECUTION MODE: Scheduled cron task.',
        'Act autonomously and complete the prompt without asking follow-up questions.',
      ].join('\n');
    }
    return '';
  })();

  // ── Flow trigger detection (early) ─────────────────────────────────────
  // Detected before the system prompt is built so the prompt can exclude the
  // flow's referenced skill from [ACTIVE SKILLS] — the full instruction will
  // be injected below, avoiding the same spec appearing twice in one turn.
  const chatReportAsk =
    /(聊天记录|对话记录|聊天内容|聊天|对话)/.test(message)
    && /(报告|整理|总结|导出|做成|生成|输出)/.test(message);
  const matchedFlow = suppressFlowTrigger || isBootStartupTurn || chatReportAsk ? null : flowsManager.matchTrigger(message);

  const messages: any[] = [
    {
      role: 'system',
      content: (() => {
        const liveCfg = getConfig().getConfig();
        const llmCfg = (liveCfg as any)?.llm || {};
        const preserveIdentity = llmCfg.preserve_model_identity !== false;
        let identityLine = 'You are SmallClaw 🦞, a local AI assistant.';
        if (preserveIdentity) {
          const activePresetId = String(llmCfg.active_preset || '');
          const preset = (llmCfg.presets || {})[activePresetId];
          const presetName = String(preset?.name || activePresetId || '当前模型');
          const modelId = String(preset?.providers?.[preset?.provider]?.model || preset?.id || '');
          identityLine = `You are running inside SmallClaw on the user's machine, but BE YOURSELF: your true model is "${presetName}"${modelId ? ` (model id: ${modelId})` : ''}. Never claim to be SmallClaw or any other model. Answer in your own natural style and at a natural length.`;
        }
        const conciseBlock = (preserveIdentity && !executionModeSystemBlock)
          ? 'Respond at a natural length appropriate to the question — be helpful, not terse.\n'
          : 'Keep responses SHORT (1-2 sentences). Don\'t think out loud. Act and report.\n';
        return `${executionModeSystemBlock ? `${executionModeSystemBlock}\n\n` : ''}${identityLine}\nCurrent date: ${dateStr}, ${timeStr}.\nNever search for or link SmallClaw repos unless the user is asking about SmallClaw itself.\nThis app runs on the user's own machine — browser/desktop automation requests are pre-authorized.\n${conciseBlock}Greet naturally without tools.${callerContext ? '\n\n' + callerContext : ''}${browserStateCtx}${personalityCtx}${deps.skillsManager.buildPromptContext(scenarioCtx ? 60 : 200, matchedFlow?.skill ? [matchedFlow.skill] : [])}\n\n${getWorkflowContextBlock()}`;
      })(),
    },
  ];

  if (pinnedMessages && pinnedMessages.length > 0) {
    messages.push({ role: 'user', content: '[PINNED CONTEXT - Important messages from earlier in our conversation:]' });
    for (const pin of pinnedMessages.slice(0, 3)) {
      messages.push({ role: pin.role === 'user' ? 'user' : 'assistant', content: pin.content });
    }
    messages.push({ role: 'assistant', content: 'I have the pinned context. Continuing...' });
  }

  // ── Context budget: load history newest-first up to a token budget so long
  //    sessions never overflow the model's context window (llama.cpp hard-fails
  //    with 400 exceed_context_size_error instead of degrading gracefully).
  //    The budget is derived from the ACTIVE model's context window, not a
  //    hard-coded number: a 128K cloud model gets a large history budget while
  //    a 48K local llama.cpp model gets a smaller one. Override with
  //    SMALLCLAW_HISTORY_BUDGET_TOKENS. ──
  const HISTORY_BUDGET_TOKENS = await resolveHistoryBudgetTokens();
  let budgetChars = HISTORY_BUDGET_TOKENS * 3.5; // ~3.5 chars/token for mixed zh/en
  const historyKept: Array<{ role: string; content: any }> = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    const len = String(m?.content || '').length;
    if (len > budgetChars) {
      if (historyKept.length > 0) break; // budget exhausted → drop this and all older
      historyKept.unshift(m); // single oversized message: keep the freshest context anyway
      break;
    }
    historyKept.unshift(m);
    budgetChars -= len;
  }
  const skippedHistory = history.length - historyKept.length;
  if (skippedHistory > 0) {
    console.log(`[v2] CTX: history pruned ${skippedHistory}/${history.length} msgs (budget ${HISTORY_BUDGET_TOKENS} tok)`);
    messages.push({ role: 'user', content: `[Context budget] ${skippedHistory} earlier message(s) were omitted to fit the model's context window; do not claim knowledge of the omitted details.` });
  }
  for (const msg of historyKept) {
    messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
  }

  // ── Session-history meta questions ─────────────────────────────────────────
  // A small local model cannot accurately answer "what was the last exchange /
  // how many turns" from a pruned prompt, so when the user asks about the
  // conversation itself we hand it the real ledger from the session store.
  // The injection also demands a terse answer and caps output tokens: without
  // that, MiniCPM5-2B retells the whole ledger (~1000+ tok at ~3 tok/s → the
  // turn appears frozen for minutes).
  const SESSION_META_RE = /((最后|最近|上一|刚才)(的)?(聊天|对话|消息|会话|一轮|一组|一条|几句|几轮|几组))|(几组|多少组|几轮|多少轮|几条|多少条|总共|一共)|(聊天记录|对话内容|历史对话|说过什么|之前说了|都说了)/i;
  let metaQuestionInjected = false;
  // Ledger for both meta questions and chat-log reports (shared, excludes the
  // current question itself — it was already stored by /api/chat).
  const metaSession = getSession(sessionId);
  const metaHist = (metaSession?.history || []).filter(
    (m: any) => !(m.role === 'user' && String(m.content || '') === message),
  );
  if (!isBootStartupTurn && !/@[^\s@，。；、！？?？\n]/.test(message) && SESSION_META_RE.test(message)) {
    if (metaHist.length > 0) {
      const metaUserMsgs = metaHist.filter((m: any) => m.role === 'user').length;
      const metaAsstMsgs = metaHist.filter((m: any) => m.role === 'assistant').length;
      const metaRecent = metaHist.slice(-8);
      const metaLines = metaRecent.map((m: any, i: number) => {
        const who = m.role === 'user' ? '用户' : '助手';
        const t = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 200);
        return `${i + 1}. [${who} ${t}] ${text}`;
      }).join('\n');
      messages.push({
        role: 'user',
        content:
          `[会话历史实况] 当前会话共 ${metaHist.length} 条消息（${metaUserMsgs} 条用户消息、${metaAsstMsgs} 条助手消息）。\n最近的消息：\n${metaLines}\n若用户问的是"最后一组/总共几组/历史对话"，请用最多 2 句话直接回答，只引用实况中已有的内容，不要复述、展开或总结实况之外的东西。`,
      });
      metaQuestionInjected = true;

      // ── System-computed answers for deterministic meta questions ─────────
      // "几组/几轮/几条/总共" counting and "最后一组/最近聊天内容" are exact
      // lookups on the ledger. A 2B model answers them slowly at best (retells
      // the ledger) and at worst emits reasoning-only output that is discarded
      // (→ "Hey! How can I help?" fallback). The system computes them directly:
      // instant, exact, zero model dependency — the "use the system when the
      // model can't" principle.
      const metaAnswer = computeSessionMetaAnswer(message, metaHist, metaUserMsgs, metaAsstMsgs);
      if (metaAnswer) {
        console.log(`[v2] META: answered from ledger (${metaAnswer.length} chars)`);
        return { type: 'chat', text: metaAnswer, toolResults: [] };
      }
    }
  }

  // ── Chat-log report: user asks to turn the conversation into a report ────
  // e.g. "把这12组对话做成报告". Without this, the message mis-triggers the
  // doc-analysis-report flow and sends the 2B model into a workspace-file
  // tool loop (list_files → read USER.md/SOUL.md/memory.md → EISDIR on
  // memory/ → frontend timeout → "aborted due to timeout" = frozen UI).
  // The ledger is already local, so the system compiles the report directly.
  // (chatReportAsk is computed above, before the system prompt is built.)
  if (!isBootStartupTurn && chatReportAsk && metaHist.length > 0) {
    const report = buildChatLogReport(message, metaHist);
    if (report) {
      let savedPath = '';
      try {
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
        const fname = `聊天记录报告_${stamp}.html`;
        const fpath = path.join(workspacePath || process.cwd(), fname);
        fs.writeFileSync(fpath, report.html, 'utf8');
        savedPath = fname;
      } catch (e: any) {
        console.warn('[chat-report] write failed: ' + (e?.message || e));
      }
      console.log(`[v2] CHAT_REPORT: built from ledger (${report.html.length} chars) saved=${savedPath}`);
      const head = savedPath ? `\n\n已保存为工作区文件：${savedPath}（HTML 格式，可直接双击打开）` : '';
      return { type: 'chat', text: report.summary + head, toolResults: [] };
    }
  }

  messages.push({ role: 'user', content: buildMultimodalUserContent(message, workspacePath) });

  // ── One-click flow: if the message matches a flow trigger, inject the
  //    flow instruction (with {{skill:...}} placeholders expanded to the
  //    skill's full body) so the model follows the fixed process end-to-end. ──
  if (matchedFlow) {
    console.log(`[v2] FLOW: "${matchedFlow.id}" (${matchedFlow.name}) triggered by message`);
    messages.push({
      role: 'user',
      content:
        `【已启用流程模板「${matchedFlow.name}」】请严格按以下执行规范完成用户任务，不要省略步骤，完成后按规范交付产物：\n${deps.renderFlowInstruction(matchedFlow.instruction)}`,
    });
    sendSSE('flow_start', { flow_id: matchedFlow.id, name: matchedFlow.name });
  }

  // ── Knowledge auto-injection (RAG): if the question clearly references
  //    stored material, fetch top chunks locally and inject them with
  //    sources so the model answers from the knowledge base, not from memory.
  //    Bounded by a 6s race — a slow/missing KB never blocks or delays chat. ──
  if (!isBootStartupTurn && !suppressFlowTrigger && KB_AUTO_INJECT_RE.test(message)) {
    try {
      const searchPromise = executeKnowledgeTool(
        'knowledge_search',
        { query: String(message).slice(0, 120), top_k: 4 },
        deps.KNOWLEDGE_DIR,
      );
      const timeoutPromise = new Promise<{ ok: boolean; results?: any[] }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), 6000);
      });
      const kbOutcome = await Promise.race([searchPromise, timeoutPromise]);
      if (kbOutcome.ok && Array.isArray(kbOutcome.results) && kbOutcome.results.length > 0) {
        const hits = kbOutcome.results
          .slice(0, 4)
          .map((r: any) => `【${r.file}】\n${String(r.text || '').slice(0, 900)}`)
          .join('\n\n---\n\n');
        messages.push({
          role: 'user',
          content:
            `【本地知识库自动检索结果】用户的问题涉及已存储资料，以下是本地知识库的相关内容（来源文件见各段标题）。回答时请优先依据这些内容，并注明来源文件；若内容不足以回答，请明确说明：\n\n${hits}`,
        });
        console.log(`[v2] KB auto-inject: ${kbOutcome.results.length} chunks matched for "${String(message).slice(0, 40)}"`);
        sendSSE('knowledge_injected', { matched: kbOutcome.results.length });
      }
    } catch (err: any) {
      console.log(`[v2] KB auto-inject skipped: ${err?.message || err}`);
    }
  }

  // ── @-reference injection: "@filename" in the message pulls that stored
  //    file's content into context so the model answers from that file. ──
  const atRefMatch = !isBootStartupTurn && /@([^\s@，。；、！？?？\n]{1,80})/.exec(message);
  if (atRefMatch && atRefMatch[1]) {
    try {
      const getPromise = executeKnowledgeTool(
        'knowledge_get',
        { name: String(atRefMatch[1]).trim(), max_chunks: 40, query: message },
        deps.KNOWLEDGE_DIR,
      );
      const timeoutPromise = new Promise<{ ok: boolean; chunks?: any[]; name?: string }>((resolve) => {
        setTimeout(() => resolve({ ok: false }), 6000);
      });
      const refOutcome = await Promise.race([getPromise, timeoutPromise]);
      if (refOutcome.ok && Array.isArray(refOutcome.chunks) && refOutcome.chunks.length > 0) {
        const refText = String(refOutcome.chunks.join('\n---\n')).slice(0, 24000);
        messages.push({
          role: 'user',
          content:
            `【@引用文件：${refOutcome.name}】用户 @ 引用了知识库文件「${refOutcome.name}」，其内容如下。回答请优先依据该文件内容，并注明这是来自该文件的信息：\n\n${refText}`,
        });
        console.log(`[v2] KB @-ref: ${refOutcome.name} (${refOutcome.chunks.length} chunks)`);
        sendSSE('knowledge_referenced', { file: refOutcome.name });
      } else if (refOutcome.ok) {
        console.log(`[v2] KB @-ref: "${atRefMatch[1]}" matched nothing`);
      }
    } catch (err: any) {
      console.log(`[v2] KB @-ref skipped: ${err?.message || err}`);
    }
  }

  // ── Lightweight model-switch suggestion ──────────────────────────────────
  // If the request is heavy (large context / obvious bulk-task wording) and
  // the user has more than one model preset, nudge them once per session.
  maybeSuggestModelSwitch(sessionId, message, history, sendSSE);

  const replaceCurrentUserPromptWithAdvisorObjective = (objective: string): boolean => {
    const objectiveText = String(objective || '').trim();
    if (!objectiveText) return false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== 'user') continue;
      // content may be a ContentPart[] when the message carried images
      const msgText = Array.isArray(msg?.content)
        ? msg.content.filter((p: any) => p?.type === 'text').map((p: any) => String(p.text || '')).join('\n')
        : String(msg?.content || '');
      if (msgText !== message) continue;
      messages.splice(i, 1);
      break;
    }
    messages.push({ role: 'user', content: objectiveText });
    messages.push({
      role: 'assistant',
      content: 'Understood. I will execute this objective and preserve literal values from the request.',
    });
    return true;
  };

  const buildSecondaryAssistContext = () => {
    const availableTools = (tools || [])
      .map((t: any) => String(t?.function?.name || '').trim())
      .filter(Boolean);

    const recentToolExecutions = allToolResults.slice(-24).map((tr, idx, arr) => {
      const step = allToolResults.length - arr.length + idx + 1;
      return {
        step,
        name: String(tr.name || '').slice(0, 80),
        args: tr.args ?? {},
        result: String(tr.result || '').slice(0, 6000),
        error: tr.error === true,
      };
    });

    const recentModelMessages = (messages || [])
      .slice(-60)
      .map((m: any) => {
        const role = String(m?.role || '').trim();
        if (!role || !['user', 'assistant', 'tool'].includes(role)) return null;

        let content = String(m?.content || '');
        if (role === 'assistant' && Array.isArray(m?.tool_calls) && m.tool_calls.length) {
          const toolCallSummary = m.tool_calls
            .slice(0, 10)
            .map((c: any) => {
              const n = String(c?.function?.name || 'unknown');
              let a = '{}';
              try { a = JSON.stringify(c?.function?.arguments || {}); } catch {}
              return `${n}(${a.slice(0, 240)})`;
            })
            .join(' | ');
          content = content
            ? `${content}\nTOOL_CALLS: ${toolCallSummary}`
            : `TOOL_CALLS: ${toolCallSummary}`;
        } else if (role === 'tool') {
          const toolName = String(m?.tool_name || 'tool');
          content = `${toolName}: ${content}`;
        }

        const trimmed = content.replace(/\r/g, '').trim();
        if (!trimmed) return null;
        return { role, content: trimmed.slice(0, 2200) };
      })
      .filter(Boolean)
      .slice(-28) as Array<{ role: string; content: string }>;

    let latestBrowserSnapshot = '';
    let latestDesktopSnapshot = '';
    for (let i = allToolResults.length - 1; i >= 0; i--) {
      const tr = allToolResults[i];
      if (!tr || typeof tr.name !== 'string') continue;
      const txt = String(tr.result || '').trim();
      if (!txt) continue;
      if (!latestBrowserSnapshot && tr.name.startsWith('browser_')) {
        latestBrowserSnapshot = txt.slice(0, 7000);
      }
      if (!latestDesktopSnapshot && tr.name.startsWith('desktop_')) {
        latestDesktopSnapshot = txt.slice(0, 7000);
      }
      if (latestBrowserSnapshot && latestDesktopSnapshot) break;
    }

    return {
      availableTools,
      recentToolExecutions,
      recentModelMessages,
      recentProcessNotes: orchestrationLog.slice(-28),
      latestBrowserSnapshot,
      latestDesktopSnapshot,
    };
  };

  const rawOrchCfg = ((getConfig().getConfig() as any).orchestration || {}) as any;

  // Optional preflight advisor pass: secondary model can route and provide
  // a compact execution plan before primary starts tool calling.
  const preflightCfg = orchestrationSkillEnabled ? getOrchestrationConfig() : null;
  if (!preflightCfg?.enabled && String(rawOrchCfg?.preflight?.mode || '') === 'always') {
    sendSSE('info', {
      message: 'Preflight advisor is set to Always, but Multi-Agent Orchestrator skill is disabled.',
    });
  }
  const skipGenericPreflightForFileOp = fileOpV2Active;
  if (skipGenericPreflightForFileOp) {
    sendSSE('info', {
      message: `FILE_OP v2 route selected (${fileOpType}); skipping generic advisor preflight.`,
    });
  }
  // Task runner sessions (sessionId starts with 'task_') are already inside a background task
  // execution — skip preflight entirely to prevent recursive task spawning loops.
  const isTaskRunnerSession = sessionId.startsWith('task_');

  if (
    preflightCfg?.enabled &&
    !isBootStartupTurn &&
    !skipGenericPreflightForFileOp &&
    !isTaskRunnerSession &&
    shouldRunPreflight(message, preflightCfg.preflight.mode) &&
    orchestrationStats.assistCount < preflightCfg.limits.max_assists_per_session
  ) {
    sendSSE('info', {
      message: `Running advisor preflight via ${preflightCfg.secondary.provider}:${preflightCfg.secondary.model}...`,
    });
    console.log(
      `[Orchestrator] Preflight start (${preflightCfg.secondary.provider}:${preflightCfg.secondary.model})`,
    );
    const preflightBlockedTask = findBlockedTaskForSession(sessionId);
    const preflight = await callSecondaryPreflight({
      userMessage: message,
      recentHistory: history.slice(-4).map(h => ({ role: h.role, content: h.content })),
      blockedTask: preflightBlockedTask
        ? {
            id: preflightBlockedTask.id,
            title: preflightBlockedTask.title,
            status: preflightBlockedTask.status,
            currentStepIndex: preflightBlockedTask.currentStepIndex,
            planLength: Array.isArray(preflightBlockedTask.plan) ? preflightBlockedTask.plan.length : 0,
            pauseReason: preflightBlockedTask.pauseReason,
          }
        : undefined,
    });

    if (preflight) {
      preflightReasonForTurn = String(preflight.reason || '').trim();
      orchestrationLog.push(`[preflight:${preflight.route}] ${preflight.reason || 'no reason'}`);
      console.log(
        `[Orchestrator] Preflight route=${preflight.route} reason=${(preflight.reason || 'n/a').slice(0, 120)}`,
      );
      const stats = recordOrchestrationEvent(
        sessionId,
        {
          trigger: 'preflight',
          mode: 'planner',
          reason: preflight.reason || 'preflight routing',
          route: preflight.route,
        },
        preflightCfg,
      );
      sendSSE('orchestration', {
        trigger: 'preflight',
        mode: 'planner',
        route: preflight.route,
        reason: preflight.reason,
        preflight,
        assist_count: stats.assistCount,
        assist_cap: preflightCfg.limits.max_assists_per_session,
      });

      // ── Background task route ────────────────────────────────────────────
      if (preflight.route === 'background_task' && multiAgentActive) {
        const taskTitle = preflight.task_title || 'Background Task';
        const taskPlan = (preflight.task_plan || []).map((desc, i) => ({
          index: i,
          description: desc,
          status: 'pending' as const,
        }));
        const taskChannel = inferTaskChannelFromSession(sessionId);
        const parsedTelegramChatId = taskChannel === 'telegram'
          ? Number(String(sessionId || '').replace(/^telegram_/, ''))
          : NaN;
        const telegramChatId = Number.isFinite(parsedTelegramChatId) && parsedTelegramChatId > 0
          ? parsedTelegramChatId
          : undefined;
        const task = createTask({
          title: taskTitle,
          prompt: message,
          sessionId,
          channel: taskChannel,
          telegramChatId,
          plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
        });
        appendJournal(task.id, { type: 'status_push', content: `Task queued: ${taskTitle}` });
        // Fire background runner (detached — does not block HTTP response)
        const runner = new BackgroundTaskRunner(task.id, handleChat, deps.makeBroadcastForTask(task.id), deps.telegramChannel);
        runner.start().catch(err => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
        const queuedMessage = preflight.friendly_queued_message
          || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
        sendSSE('task_queued', { taskId: task.id, title: taskTitle });
        logToDaily(workspacePath, 'SmallClaw', queuedMessage);
        addMessage(sessionId, { role: 'assistant', content: queuedMessage, timestamp: Date.now() });
        return { type: 'chat', text: queuedMessage };
      }

      if (
        preflight.route === 'secondary_chat' &&
        preflightCfg.preflight.allow_secondary_chat &&
        preflight.secondary_response?.trim()
      ) {
        sendSSE('info', {
          message: 'Advisor route selected secondary_chat. Returning secondary response directly.',
        });
        const text = preflight.secondary_response.trim();
        logToDaily(workspacePath, 'SmallClaw', text);
        return { type: 'chat', text };
      }

      if (preflight.route === 'secondary_chat' && !preflightCfg.preflight.allow_secondary_chat) {
        sendSSE('info', {
          message: 'Advisor suggested secondary_chat, but direct secondary chat is disabled. Continuing with primary.',
        });
      } else if (preflight.route === 'primary_direct') {
        sendSSE('info', { message: 'Advisor route selected primary_direct. Continuing with primary response.' });
      } else if (preflight.route === 'primary_with_plan') {
        // primary_with_plan is retired when multi-agent is active — upgrade to background_task
        if (multiAgentActive) {
          sendSSE('info', { message: 'Advisor returned primary_with_plan but multi-agent is active — upgrading to background_task.' });
          const taskTitle = preflight.task_title || (preflight.reason ? preflight.reason.slice(0, 60) : 'Background Task');
          const taskPlan = (preflight.task_plan || preflight.quick_plan || []).map((desc: string, i: number) => ({
            index: i, description: desc, status: 'pending' as const,
          }));
          const taskChannel = inferTaskChannelFromSession(sessionId);
          const parsedTelegramChatId = taskChannel === 'telegram'
            ? Number(String(sessionId || '').replace(/^telegram_/, ''))
            : NaN;
          const telegramChatId = Number.isFinite(parsedTelegramChatId) && parsedTelegramChatId > 0
            ? parsedTelegramChatId
            : undefined;
          const task = createTask({
            title: taskTitle,
            prompt: message,
            sessionId,
            channel: taskChannel,
            telegramChatId,
            plan: taskPlan.length > 0 ? taskPlan : [{ index: 0, description: 'Execute task', status: 'pending' }],
          });
          appendJournal(task.id, { type: 'status_push', content: `Task queued (upgraded from primary_with_plan): ${taskTitle}` });
          const runner = new BackgroundTaskRunner(task.id, handleChat, deps.makeBroadcastForTask(task.id), deps.telegramChannel);
          runner.start().catch((err: Error) => console.error(`[BackgroundTaskRunner] Task ${task.id} error:`, err.message));
          const queuedMessage = preflight.friendly_queued_message
            || `On it! I've queued "${taskTitle}" as a background task. You can track progress in the Tasks panel.`;
          sendSSE('task_queued', { taskId: task.id, title: taskTitle });
          logToDaily(workspacePath, 'SmallClaw', queuedMessage);
          addMessage(sessionId, { role: 'assistant', content: queuedMessage, timestamp: Date.now() });
          return { type: 'chat', text: queuedMessage };
        }
        sendSSE('info', { message: 'Advisor route selected primary_with_plan. Injecting execution objective and plan guidance.' });
      }

      const shouldInjectObjective = preflight.route === 'primary_with_plan';
      if (shouldInjectObjective) {
        const objectiveHint = formatPreflightExecutionObjective(preflight);
        const injected = replaceCurrentUserPromptWithAdvisorObjective(objectiveHint);
        if (!injected) {
          sendSSE('warn', {
            message: 'Advisor objective injection failed; falling back to raw user prompt.',
          });
        }
      }

      if (preflight.route === 'primary_with_plan') {
        const hint = formatPreflightHint(preflight);
        messages.push({ role: 'user', content: hint });
        messages.push({ role: 'assistant', content: 'Understood. I will follow this preflight guidance.' });
      }
    }
  } else if (
    preflightCfg?.enabled &&
    !isBootStartupTurn &&
    !isTaskRunnerSession &&
    shouldRunPreflight(message, preflightCfg.preflight.mode) &&
    orchestrationStats.assistCount >= preflightCfg.limits.max_assists_per_session
  ) {
    sendSSE('info', { message: 'Advisor preflight skipped: session assist cap reached.' });
  }

  const resetBrowserAdvisorCollection = () => {
    browserAdvisorCollectedFeed.length = 0;
    browserAdvisorSeenFeedKeys.clear();
    browserAdvisorDedupeCount = 0;
    browserAdvisorBatch = 0;
    browserAdvisorLastHash = '';
    consecutiveUnchangedSnapshots = 0;
    browserNoFeedProgressStreak = 0;
    browserStabilizeUrlKey = '';
    browserStabilizeWaitRetries = 0;
    browserStabilizeTabProbes = 0;
    browserStabilizeExhausted = false;
  };

  const toUrlKey = (rawUrl: string): string => {
    try {
      const u = new URL(String(rawUrl || ''));
      return `${u.hostname}${u.pathname}`.toLowerCase();
    } catch {
      return String(rawUrl || '').toLowerCase().split('?')[0];
    }
  };

  const feedItemKey = (item: Record<string, any>): string => {
    if (item?.id) return `id:${String(item.id)}`;
    if (item?.link) return `link:${String(item.link)}`;
    const text = String(item?.text || item?.snippet || item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 220);
    const handle = String(item?.handle || item?.author || '').toLowerCase();
    const time = String(item?.time || '').slice(0, 40);
    return `hash:${handle}|${time}|${text}`;
  };

  const mergeBrowserFeedBatch = (batch: Array<Record<string, any>>): { added: number; deduped: number; total: number } => {
    let added = 0;
    let deduped = 0;
    for (const raw of batch || []) {
      const item = raw && typeof raw === 'object' ? raw : {};
      const key = feedItemKey(item);
      if (!key || browserAdvisorSeenFeedKeys.has(key)) {
        deduped++;
        continue;
      }
      browserAdvisorSeenFeedKeys.add(key);
      browserAdvisorCollectedFeed.push(item);
      if (browserAdvisorCollectedFeed.length > browserMaxCollectedItems) {
        browserAdvisorCollectedFeed.shift();
      }
      added++;
    }
    browserAdvisorDedupeCount += deduped;
    return { added, deduped, total: browserAdvisorCollectedFeed.length };
  };

  const maybeRunBrowserAdvisorPass = async (triggerToolName: string, triggerResult: ToolResult): Promise<void> => {
    if (!isBrowserToolName(triggerToolName) || triggerResult.error) return;
    const orchCfg = getOrchestrationConfig();
    if (!orchestrationSkillEnabled || !orchCfg?.enabled) return;
    if (browserAdvisorCallsThisTurn >= browserMaxAdvisorCallsPerTurn) return;
    if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) return;

    const packet = await getBrowserAdvisorPacket(sessionId, { maxItems: browserPacketMaxItems, snapshotElements: 180 });
    if (!packet) return;
    const packetUrlKey = toUrlKey(packet.page.url);
    if (
      triggerToolName === 'browser_open'
      || (browserAdvisorUrlKey && packetUrlKey && packetUrlKey !== browserAdvisorUrlKey && !browserContinuationPending)
    ) {
      resetBrowserAdvisorCollection();
    }
    browserAdvisorUrlKey = packetUrlKey || browserAdvisorUrlKey;
    if (!browserStabilizeUrlKey || (packetUrlKey && packetUrlKey !== browserStabilizeUrlKey)) {
      browserStabilizeUrlKey = packetUrlKey || browserStabilizeUrlKey;
      browserStabilizeWaitRetries = 0;
      browserStabilizeTabProbes = 0;
      browserStabilizeExhausted = false;
    }

    const isFeedOrSearchPage = packet.page.pageType === 'x_feed' || packet.page.pageType === 'search_results';
    const quality = evaluateBrowserSnapshotQuality(packet.snapshot, packet.snapshotElements, message);
    if (quality.low) {
      const diag = quality.diagnostics;
      const diagMsg = diag
        ? ` hidden=${diag.hidden}, unlabeled_non_input=${diag.unlabeledNonInput}, unnamed_input_included=${diag.unnamedInputIncluded}`
        : '';
      sendSSE('info', {
        message: `Snapshot quality low: elements=${quality.elementCount}, input_candidates=${quality.inputCandidates}, reasons=${quality.reasons.join(' | ')}.${diagMsg}`,
      });
      const logLine = `[snapshot_quality] low | elements=${quality.elementCount} | inputs=${quality.inputCandidates} | reasons=${quality.reasons.join('; ')}`;
      orchestrationLog.push(logLine.slice(0, 260));
    }

    const stabilizationEligibleTool = (
      triggerToolName === 'browser_open'
      || triggerToolName === 'browser_snapshot'
      || triggerToolName === 'browser_wait'
      || triggerToolName === 'browser_press_key'
    );
    const stabilizationEligiblePage = packet.page.pageType === 'generic' || packet.page.pageType === 'article';
    const shouldAutoStabilize =
      quality.elementCount < 10
      || (goalLikelyNeedsTextInput(message) && quality.inputCandidates === 0);
    if (
      stabilizationEligibleTool
      && stabilizationEligiblePage
      && quality.low
      && shouldAutoStabilize
      && !isFeedOrSearchPage
      && !browserStabilizeExhausted
    ) {
      if (browserStabilizeWaitRetries < browserStabilizeMaxWaitRetries) {
        browserStabilizeWaitRetries += 1;
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Snapshot stabilization in progress';
        pendingSyntheticToolCalls = [
          { function: { name: 'browser_wait', arguments: { ms: 1500 } } },
          { function: { name: 'browser_snapshot', arguments: {} } },
        ];
        sendSSE('info', {
          message: `Snapshot stabilization: wait+snapshot (${browserStabilizeWaitRetries}/${browserStabilizeMaxWaitRetries}) before advisor routing.`,
        });
        return;
      }

      const shouldProbeFocus = goalLikelyNeedsTextInput(message) && quality.inputCandidates === 0;
      if (shouldProbeFocus && browserStabilizeTabProbes < browserStabilizeMaxTabProbes) {
        browserStabilizeTabProbes += 1;
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Input focus probe in progress';
        pendingSyntheticToolCalls = [
          { function: { name: 'browser_press_key', arguments: { key: 'Tab' } } },
          { function: { name: 'browser_wait', arguments: { ms: 500 } } },
          { function: { name: 'browser_snapshot', arguments: {} } },
        ];
        sendSSE('info', {
          message: `Snapshot stabilization: Tab focus probe (${browserStabilizeTabProbes}/${browserStabilizeMaxTabProbes}) to surface input controls.`,
        });
        return;
      }

      browserStabilizeExhausted = true;
      sendSSE('info', {
        message: 'Snapshot stabilization exhausted for this page; proceeding with current snapshot evidence.',
      });
    } else if (
      !quality.low
      && (browserStabilizeWaitRetries > 0 || browserStabilizeTabProbes > 0)
    ) {
      sendSSE('info', {
        message: `Snapshot stabilization complete: elements=${quality.elementCount}, input_candidates=${quality.inputCandidates}.`,
      });
      browserStabilizeWaitRetries = 0;
      browserStabilizeTabProbes = 0;
      browserStabilizeExhausted = false;
    }

    if (
      !isBrowserHeavyResearchPage({
        url: packet.page.url,
        pageType: packet.page.pageType,
        snapshotElements: packet.snapshotElements,
        feedCount: packet.extractedFeed.length,
      })
    ) {
      return;
    }
    const hashUnchanged = packet.contentHash === browserAdvisorLastHash;
    if (hashUnchanged && !browserContinuationPending) {
      // On non-feed interactive pages, a stuck snapshot hash means the model is looping.
      // After 2 consecutive identical snapshots, force the advisor to run so it generates
      // a concrete @ref-based action instead of silently returning and letting the model re-snapshot.
      consecutiveUnchangedSnapshots += 1;
      if (consecutiveUnchangedSnapshots >= 2) {
        // Force advisor call — override the early return so it runs with existing data.
        // Applies to ALL page types including feed pages: if the snapshot hasn't changed,
        // the model is looping and needs a concrete directive from the advisor.
        browserContinuationPending = true;
        browserAdvisorRoute = 'continue_browser';
        browserAdvisorHintPreview = 'Snapshot unchanged — forcing advisor to generate concrete action';
        sendSSE('info', { message: `Snapshot hash unchanged (${consecutiveUnchangedSnapshots}x) — forcing browser advisor to generate concrete action.` });
        // Don't return — fall through to advisor call below
      } else {
        return;
      }
    } else {
      consecutiveUnchangedSnapshots = 0;
    }
    browserAdvisorLastHash = packet.contentHash;
    browserAdvisorCallsThisTurn += 1;
    browserAdvisorBatch += 1;

    const merged = mergeBrowserFeedBatch(packet.extractedFeed as Array<Record<string, any>>);
    const isFeedCollectionPage = packet.page.pageType === 'x_feed' || packet.page.pageType === 'search_results';
    if (isFeedCollectionPage) {
      browserNoFeedProgressStreak = merged.added > 0 ? 0 : (browserNoFeedProgressStreak + 1);
    } else {
      browserNoFeedProgressStreak = 0;
    }

    sendSSE('browser_advisor_start', {
      trigger_tool: triggerToolName,
      page_type: packet.page.pageType,
      url: packet.page.url,
      snapshot_elements: packet.snapshotElements,
      extracted_count: packet.extractedFeed.length,
    });
    sendSSE('feed_collected', {
      batch: browserAdvisorBatch,
      added: merged.added,
      total: merged.total,
      deduped: merged.deduped,
      url: packet.page.url,
    });

    const recentFailures = allToolResults
      .filter((r) => r.error)
      .slice(-4)
      .map((r) => `${r.name}: ${String(r.result || '').slice(0, 180)}`);

    const advisorFeed = browserAdvisorCollectedFeed.length > 0
      ? browserAdvisorCollectedFeed.slice(-browserMaxCollectedItems)
      : (packet.extractedFeed as Array<Record<string, any>>);

    // ── Change 5: chat_interface generation-wait — skip advisor, inject synthetic wait ──
    if (browserAutoSnapshotRetriesEnabled && packet.page.pageType === 'chat_interface' && packet.isGenerating) {
      sendSSE('info', { message: 'Browser: chat interface still generating — waiting for response before advising.' });
      pendingSyntheticToolCalls = [
        { function: { name: 'browser_wait', arguments: { ms: 3000 } } },
        { function: { name: 'browser_snapshot', arguments: {} } },
      ];
      return; // don't call advisor yet — next round will re-enter this function with fresh snapshot
    }

    let advisor = await callSecondaryBrowserAdvisor({
      goal: message,
      minFeedItemsBeforeAnswer: browserMinFeedItemsBeforeAnswer,
      page: {
        title: packet.page.title,
        url: packet.page.url,
        pageType: packet.page.pageType,
        snapshotElements: packet.snapshotElements,
      },
      extractedFeed: advisorFeed,
      textBlocks: packet.textBlocks,
      snapshot: packet.snapshot,
      scrollState: {
        batch: browserAdvisorBatch,
        total_collected: advisorFeed.length,
        dedupe_count: browserAdvisorDedupeCount,
      },
      lastActions: orchestrationLog.slice(-8),
      recentFailures,
      pageText: packet.pageText,
      isGenerating: packet.isGenerating,
    });
    if (!advisor) return;

    // Guardrail: collect_more should only run on feed/search collection pages.
    // For generic pages (e.g. chatgpt.com composer), force decisive routing.
    if (advisor.route === 'collect_more' && !isFeedCollectionPage) {
      sendSSE('info', {
        message: 'Browser advisor override: collect_more disabled on non-feed page; switching to direct interaction mode.',
      });
      advisor = {
        ...advisor,
        route: 'handoff_primary',
        reason: 'collect_more disabled for non-feed pages; choose a concrete interaction from current snapshot.',
        next_tool: { tool: 'browser_snapshot', params: {} },
        primary_hint: 'Do not scroll/PageDown here. Use the current snapshot refs to click/fill the correct control directly.',
      };
    }

    // Guardrail: if feed collection is making no progress, stop scroll loops.
    if (
      advisor.route === 'collect_more'
      && isFeedCollectionPage
      && browserNoFeedProgressStreak >= 2
      && advisorFeed.length === 0
    ) {
      sendSSE('info', {
        message: 'Browser advisor override: collection stalled with zero extracted items; stopping scroll loop.',
      });
      advisor = {
        ...advisor,
        route: 'continue_browser',
        reason: 'No feed items extracted after repeated collection attempts; stop scrolling and select a concrete next interaction.',
        next_tool: { tool: 'browser_snapshot', params: {} },
        primary_hint: 'Collection is stalled (0 extracted). Do not keep PageDown looping. Use snapshot evidence and pick a concrete click/fill step.',
      };
    }

    if (advisor.route === 'collect_more') {
      if (!advisor.next_tool?.tool) {
        advisor = {
          ...advisor,
          next_tool: { tool: 'browser_press_key', params: { key: 'PageDown' } },
        };
      } else if (
        advisor.next_tool.tool === 'browser_press_key'
        && (!advisor.next_tool.params || !advisor.next_tool.params.key)
      ) {
        advisor = {
          ...advisor,
          next_tool: { tool: 'browser_press_key', params: { ...(advisor.next_tool.params || {}), key: 'PageDown' } },
        };
      }
    }

    const hint = formatBrowserAdvisorHint(advisor);
    const stats = recordOrchestrationEvent(
      sessionId,
      {
        trigger: 'auto',
        mode: 'planner',
        reason: `browser_advisor:${advisor.route}${advisor.reason ? ` (${advisor.reason})` : ''}`,
        route: advisor.route,
      },
      orchCfg,
    );

    browserAdvisorRoute = advisor.route;
    browserAdvisorHintPreview = String(advisor.primary_hint || advisor.reason || advisor.answer || '').slice(0, 220);
    browserContinuationPending = advisor.route === 'continue_browser' || advisor.route === 'collect_more';
    if (!browserContinuationPending) {
      browserForcedRetries = 0;
    }

    sendSSE('browser_advisor_route', {
      route: advisor.route,
      reason: advisor.reason,
      answer: advisor.answer || '',
      primary_hint: advisor.primary_hint || '',
      next_tool: advisor.next_tool || null,
      collect_policy: advisor.collect_policy || null,
      raw_response: advisor.raw_response || '',
      assist_count: stats.assistCount,
      assist_cap: orchCfg.limits.max_assists_per_session,
    });
    sendSSE('browser_advisor_nudge', {
      route: advisor.route,
      preview: browserAdvisorHintPreview,
    });

    orchestrationLog.push(`[browser:${advisor.route}] ${String(advisor.reason || 'n/a').slice(0, 200)}`);

    // ── Synthetic tool call injection for deterministic collect_more scrolls ─────────
    // When the advisor says scroll (PageDown), skip LLM generation entirely.
    // Inject as a synthetic assistant message that the main loop executes directly.
    // This eliminates the 75s stall window between advisor directive and actual scroll.
    const isCollectMoreScroll = advisor.route === 'collect_more'
      && multiAgentActive
      && isFeedCollectionPage
      && advisor.next_tool?.tool === 'browser_press_key';
    const isCollectMoreWait = advisor.route === 'collect_more'
      && multiAgentActive
      && isFeedCollectionPage
      && advisor.next_tool?.tool === 'browser_wait';

    if (browserAutoSnapshotRetriesEnabled && (isCollectMoreScroll || isCollectMoreWait)) {
      // Queue synthetic tool calls: scroll + wait + snapshot (all deterministic)
      const scrollParams = advisor.next_tool!.params || { key: 'PageDown' };
      pendingSyntheticToolCalls = [
        { function: { name: advisor.next_tool!.tool, arguments: scrollParams } },
        { function: { name: 'browser_wait', arguments: { ms: 1500 } } },
        { function: { name: 'browser_snapshot', arguments: {} } },
      ];
      sendSSE('info', { message: `Advisor: synthetic scroll queued (${advisor.route}) — skipping LLM generation.` });
      // Push a compact hint so the LLM knows what happened after the synthetic round
      messages.push({ role: 'user', content: hint });
      messages.push({ role: 'assistant', content: `[ADVISOR] ${advisorFeed.length}/${browserMinFeedItemsBeforeAnswer} items. Scrolling for more.` });
      return;
    }

    // For non-deterministic steps, use the normal message injection path
    // ── Changes 2 & 3: context wipe + stripped executor system for browser ops ──────────
    // Secondary holds full state via buildSecondaryAssistContext().
    // Primary only needs: minimal system + original goal + last 4 tool acks + this directive.
    // Wipe now, before pushing the hint pair, so the hint ends up at the bottom cleanly.
    if (multiAgentActive) {
      // Stripped executor system — no editing rules, no identity prose, just tool list + 3 rules
      const strippedSystem = {
        role: 'system',
        content: `You are SmallClaw. Execute browser tool calls exactly as instructed by the advisor directive below.

BROWSER TOOLS: browser_open, browser_snapshot, browser_click, browser_fill, browser_press_key, browser_wait, browser_scroll, browser_close, web_fetch

RULES:
1. Call exactly the tool and params the advisor specifies.
2. Do not think, plan, or explain. Just call the tool.
3. If the directive says answer_now, respond in 1-2 sentences using the provided draft.`,
      };
      // Keep last 4 tool-result messages so the LLM has minimal recent action context
      const recentToolMsgs = messages
        .filter((m: any) => m.role === 'tool')
        .slice(-4);
      // Rebuild messages: stripped system + goal + last 4 tool acks
      messages.length = 0;
      messages.push(strippedSystem);
      messages.push({ role: 'user', content: message });
      messages.push({ role: 'assistant', content: 'Understood. Executing browser task.' });
      for (const tm of recentToolMsgs) messages.push(tm);
    }

    messages.push({ role: 'user', content: hint });
    messages.push({ role: 'assistant', content: 'Understood. Continuing with browser advisor guidance.' });
    if (advisor.route === 'answer_now' && advisor.answer.trim()) {
      messages.push({
        role: 'user',
        content: `Use the browser evidence and answer now in 1-2 concise sentences. Draft answer: ${advisor.answer.slice(0, 700)}`,
      });
    } else if (advisor.next_tool?.tool) {
      const isWebFetchStep = advisor.next_tool.tool === 'web_fetch';
      const collectTail = advisor.route === 'collect_more' && !isWebFetchStep
        ? ' Then continue collection: if needed call browser_wait(1200) and browser_snapshot before deciding again.'
        : '';
      const webFetchNote = isWebFetchStep
        ? ' Use web_fetch (not browser_open) since you already have the URL and only need the text content.'
        : '';
      messages.push({
        role: 'user',
        content: `Immediate next step: call ${advisor.next_tool.tool} with params ${JSON.stringify(advisor.next_tool.params || {})}. Do not stop with intent text.${collectTail}${webFetchNote}`,
      });
    }
  };

  const maybeRunDesktopAdvisorPass = async (triggerToolName: string, triggerResult: ToolResult): Promise<void> => {
    if (!isDesktopToolName(triggerToolName) || triggerResult.error) return;
    if (triggerToolName !== 'desktop_screenshot') return;
    const orchCfg = getOrchestrationConfig();
    if (!orchestrationSkillEnabled || !orchCfg?.enabled) return;
    if (desktopAdvisorCallsThisTurn >= desktopMaxAdvisorCallsPerTurn) return;
    if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) return;

    const packet = getDesktopAdvisorPacket(sessionId);
    if (!packet) return;

    desktopAdvisorCallsThisTurn += 1;
    sendSSE('desktop_advisor_start', {
      trigger_tool: triggerToolName,
      active_window: packet.activeWindow?.title || '',
      open_windows: packet.openWindows.length,
      width: packet.width,
      height: packet.height,
      ocr_confidence: Number(packet.ocrConfidence || 0),
      ocr_chars: String(packet.ocrText || '').length,
    });

    const recentFailures = allToolResults
      .filter((r) => r.error)
      .slice(-4)
      .map((r) => `${r.name}: ${String(r.result || '').slice(0, 180)}`);
    const clipboardPreview = (() => {
      for (let i = allToolResults.length - 1; i >= 0; i--) {
        const r = allToolResults[i];
        if (!r || r.error) continue;
        if (r.name !== 'desktop_get_clipboard') continue;
        return String(r.result || '').slice(0, 1200);
      }
      return '';
    })();

    const advisor = await callSecondaryDesktopAdvisor({
      goal: message,
      screenshot: {
        width: packet.width,
        height: packet.height,
        capturedAt: packet.capturedAt,
        contentHash: packet.contentHash,
      },
      // Pass the raw screenshot to the advisor when available. The advisor function
      // will only inject it as an image_url content part when the secondary provider
      // supports vision (openai / openai_codex). For Ollama/llama.cpp it is ignored.
      screenshotBase64: packet.screenshotBase64 || undefined,
      activeWindow: packet.activeWindow
        ? { processName: packet.activeWindow.processName, title: packet.activeWindow.title }
        : undefined,
      openWindows: packet.openWindows.slice(0, 40).map((w) => ({ processName: w.processName, title: w.title })),
      lastActions: orchestrationLog.slice(-8),
      recentFailures,
      clipboardPreview,
      ocrText: packet.ocrText || '',
      ocrConfidence: Number(packet.ocrConfidence || 0),
    });
    if (!advisor) return;

    const hint = formatDesktopAdvisorHint(advisor);
    const stats = recordOrchestrationEvent(
      sessionId,
      {
        trigger: 'auto',
        mode: 'planner',
        reason: `desktop_advisor:${advisor.route}${advisor.reason ? ` (${advisor.reason})` : ''}`,
        route: advisor.route,
      },
      orchCfg,
    );

    desktopAdvisorRoute = advisor.route;
    desktopAdvisorHintPreview = String(advisor.primary_hint || advisor.reason || advisor.answer || '').slice(0, 220);
    desktopContinuationPending = advisor.route === 'continue_desktop';

    sendSSE('desktop_advisor_route', {
      route: advisor.route,
      reason: advisor.reason,
      answer: advisor.answer || '',
      primary_hint: advisor.primary_hint || '',
      next_tool: advisor.next_tool || null,
      raw_response: advisor.raw_response || '',
      assist_count: stats.assistCount,
      assist_cap: orchCfg.limits.max_assists_per_session,
    });
    sendSSE('desktop_advisor_nudge', {
      route: advisor.route,
      preview: desktopAdvisorHintPreview,
    });

    orchestrationLog.push(`[desktop:${advisor.route}] ${String(advisor.reason || 'n/a').slice(0, 200)}`);

    if (multiAgentActive) {
      const strippedSystem = {
        role: 'system',
        content: `You are SmallClaw. Execute desktop tool calls exactly as instructed by the advisor directive below.

DESKTOP TOOLS: desktop_screenshot, desktop_find_window, desktop_focus_window, desktop_click, desktop_drag, desktop_wait, desktop_type, desktop_press_key, desktop_get_clipboard, desktop_set_clipboard

RULES:
1. Call exactly the tool and params the advisor specifies.
2. Do not think, plan, or explain. Just call the tool.
3. If the directive says answer_now, respond in 1-2 sentences using the provided draft.`,
      };
      const recentToolMsgs = messages
        .filter((m: any) => m.role === 'tool')
        .slice(-4);
      messages.length = 0;
      messages.push(strippedSystem);
      messages.push({ role: 'user', content: message });
      messages.push({ role: 'assistant', content: 'Understood. Executing desktop task.' });
      for (const tm of recentToolMsgs) messages.push(tm);
    }

    messages.push({ role: 'user', content: hint });
    messages.push({ role: 'assistant', content: 'Understood. Continuing with desktop advisor guidance.' });
    if (advisor.route === 'answer_now' && advisor.answer.trim()) {
      messages.push({
        role: 'user',
        content: `Use desktop evidence and answer now in 1-2 concise sentences. Draft answer: ${advisor.answer.slice(0, 700)}`,
      });
    } else if (advisor.next_tool?.tool) {
      messages.push({
        role: 'user',
        content: `Immediate next step: call ${advisor.next_tool.tool} with params ${JSON.stringify(advisor.next_tool.params || {})}. After acting, capture desktop_screenshot again if fresh state is needed.`,
      });
    }
  };

  if (fileOpV2Active && fileOpType === 'FILE_ANALYSIS') {
    // FILE_ANALYSIS now runs on the PRIMARY model, with the system performing
    // the file read on the model's behalf: small local models often do not
    // reliably issue tool calls on their own, so the user's rule applies —
    // when the model can't complete a task alone, call tools to complete it.
    // read_file / doc_read handle PDF & Office files, so the model gets the
    // real file content in context and can answer (e.g. "the last line of
    // data"). Delegating to a tool-less secondary LLM used to produce
    // diagnosis-only answers from a truncated file-name list and misdiagnosed
    // existing files as missing. Fall through to the main tool loop below.
    sendSSE('info', { message: 'FILE_OP v2: FILE_ANALYSIS handled by primary model with tools (no secondary delegation).' });
    maybeSaveFileOpCheckpoint({ phase: 'plan', next_action: 'primary reads and analyzes target file with tools' });
    const analysisTarget = resolveAnalysisTarget(message, workspacePath);
    if (analysisTarget) {
      sendSSE('info', { message: `FILE_OP v2: system reading "${analysisTarget}" on the model's behalf.` });
      const read = await deps.executeTool('read_file', { filename: analysisTarget }, workspacePath, sessionId, sendSSE);
      if (!read.error && read.result) {
        const full = String(read.result);
        const cap = ANALYSIS_INJECT_MAX_CHARS;
        const shown = full.length > cap ? `[File truncated: last ${cap} chars of ${full.length} total.]\n${full.slice(-cap)}` : full;
        messages.push({
          role: 'user',
          content: `[SYSTEM: I read the file "${analysisTarget}" for you. Use its content to answer the user's question precisely; do not claim you cannot access it.]\n${shown}`,
        });
        sendSSE('info', { message: `FILE_OP v2: injected ${full.length} chars of file content into model context.` });
      } else {
        sendSSE('info', { message: `FILE_OP v2: read failed for "${analysisTarget}": ${String(read?.result || '').slice(0, 160)}` });
      }
    }
  }

  logToDaily(workspacePath, 'User', message);

  // ── FILE_CREATE upfront size routing ──
  // If the request is clearly secondary territory (full page / large template),
  // skip primary entirely — queue secondary patch plan now so round 0 executes
  // it as synthetic calls without ever running the LLM for generation.
  // This eliminates the stall→restart spiral for large creates.
  if (
    fileOpV2Active
    && fileOpType === 'FILE_CREATE'
    && fileOpOwner === 'primary'
    && pendingSyntheticToolCalls.length === 0
  ) {
    const looksLarge = requestedFullTemplate(message)
      || /\b(landing page|full html|multi.?section|multiple sections|panels?|sections?.+panels?|panels?.+sections?|full.?page|whole page|full.?site|complete.?page)\b/i.test(message);
    if (looksLarge) {
      fileOpOwner = 'secondary';
      sendSSE('info', {
        message: 'FILE_OP v2: large FILE_CREATE detected upfront — routing directly to secondary (skipping primary generation).',
      });
      maybeSaveFileOpCheckpoint({ phase: 'plan', next_action: 'upfront secondary routing for large create' });
      const patchPlan = await callSecondaryFilePatchPlanner({
        userMessage: message,
        operationType: 'FILE_CREATE',
        owner: 'secondary',
        reason: 'Upfront large-create detection: request exceeds primary create thresholds before generation',
        fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
        verifier: null,
      });
      if (patchPlan?.tool_calls?.length) {
        pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
          function: { name: tc.tool, arguments: tc.args || {} },
        }));
        sendSSE('info', {
          message: `FILE_OP v2: queued ${pendingSyntheticToolCalls.length} secondary call(s) for large create.`,
        });
        maybeSaveFileOpCheckpoint({ phase: 'execute', next_action: 'execute secondary upfront create batch' });
      }
    }
  }

  sendSSE('info', { message: 'Thinking...' });
  console.log(`\n[v2] ── CHAT (native tools) ──`);

  // ── In-round context budget ────────────────────────────────────────────────
  // The cross-turn history is pruned above, but the tool-call loop appends
  // every assistant/tool round to `messages`, so a multi-step task can still
  // grow the prompt to 10K+ tokens. llama.cpp's --context-shift keeps the KV
  // cache alive but does NOT shrink the prompt we resend every round. So we cap
  // the in-round payload: keep the system message + the latest 2 full rounds
  // intact, compress the middle to one-liners.
  // The budget FOLLOWS THE MODEL WINDOW (≈25% of it, clamped 4K–40K): a 128K
  // model starts at ~32K, a 48K model at ~12K, an 8K model at 4K — nothing
  // hard-coded. On top of that a runtime adaptive loop shrinks the budget when
  // the model slows down and relaxes it when speed recovers (small models lose
  // throughput on long contexts, so they self-tighten). Override the starting
  // value with SMALLCLAW_INROUND_BUDGET_TOKENS.
  const baseInRoundBudget = (() => {
    const explicit = Number(process.env.SMALLCLAW_INROUND_BUDGET_TOKENS);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return Math.min(40000, Math.max(4000, Math.round(HISTORY_BUDGET_TOKENS * 0.5)));
  })();
  const budgetKey = `${String((getConfig().getConfig() as any)?.llm?.active_preset || '')}|${modelOverride || ''}`;
  if (inRoundBudgetModelKey !== budgetKey) {
    // Model changed → recalibrate from scratch for the new model.
    inRoundBudgetModelKey = budgetKey;
    inRoundAdaptiveBudget = 0;
    inRoundCtxCharPerToken = 1.0;
    inRoundLastSentChars = 0;
    console.log(`[v2] CTX: in-round calibration reset (model key "${budgetKey}")`);
  }
  if (inRoundAdaptiveBudget <= 0) {
    inRoundAdaptiveBudget = baseInRoundBudget;
    console.log(`[v2] CTX: in-round budget base=${baseInRoundBudget} tok (env ${process.env.SMALLCLAW_INROUND_BUDGET_TOKENS || 'unset'})`);
  }
  let inRoundTrimNotified = false;
  const trimInRoundMessages = (msgs: any[]): any[] => {
    let chars = 0;
    for (const m of msgs) {
      const raw = m?.content;
      chars += (typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).length;
      if (m?.tool_calls) chars += 80;
    }
    const total = Math.ceil(chars * inRoundCtxCharPerToken) + msgs.length * 8;
    if (total <= inRoundAdaptiveBudget) {
      inRoundLastSentChars = chars;
      return msgs;
    }

    const kept: any[] = [msgs[0]]; // system stays intact
    // Keep the latest 3 full rounds so a long tool chain's recent state stays
    // coherent for small models (2 rounds was enough for trimming but left a
    // 3-round chain without enough recent context and answers drifted).
    const TAIL_ROUNDS = 3;
    const tail = msgs.length > TAIL_ROUNDS ? msgs.slice(-TAIL_ROUNDS) : msgs.slice(1);
    const middle = msgs.slice(1, msgs.length - tail.length);
    // Nothing to drop in the middle → the budget warning was a false
    // positive (e.g. an oversized system block); send as-is.
    if (middle.length === 0) {
      inRoundLastSentChars = chars;
      return msgs;
    }
    // Drop the middle rounds entirely, then tell the model what happened.
    // (Compressing each round into "[compressed role] ..." one-liners was tried
    // first but small models mimic that format and stop calling tools — plain
    // dropping keeps the remaining history natural and predictable.)
    const dropped = middle.length;
    kept.push({
      role: 'user',
      content: `[上下文预算] 为控制模型上下文长度，较早的 ${dropped} 条中间消息已被省略；如果确实需要其中的细节，请询问用户。请基于最近保留的对话继续，用自己的自然风格回答。`,
    });
    for (const m of tail) kept.push(m);
    // Message count genuinely shrank (dropped > 0) — no extra gain check needed.
    let keptChars = 0;
    for (const m of kept) {
      const raw = m?.content;
      keptChars += (typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')).length;
      if (m?.tool_calls) keptChars += 80;
    }
    // Calibration baseline must match what was ACTUALLY sent (the trimmed copy).
    inRoundLastSentChars = keptChars;

    if (!inRoundTrimNotified) {
      inRoundTrimNotified = true;
      console.log(`[v2] CTX: in-round trimmed ${msgs.length} -> ${kept.length} msgs (dropped ${dropped}, est ${total} tok > budget ${inRoundAdaptiveBudget})`);
      sendSSE('info', { message: `[上下文预算] 本轮工具链较长，已省略中间 ${dropped} 条消息，保留最近 3 轮完整上下文。` });
    }
    return kept;
  };

  // Report generation throughput (tokens/s) over SSE so the UI can show the
  // model's output speed. llama.cpp's OpenAI-compat endpoint returns usage
  // { prompt_tokens, completion_tokens }, and we time the call locally.
  const reportGenerationStats = (result: any, startedAt: number): void => {
    const usage = (result as any)?.usage;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    const elapsedMs = Math.max(1, Date.now() - startedAt);
    const tps = completionTokens > 0 ? completionTokens / (elapsedMs / 1000) : 0;
    console.log(`[v2] GEN: ${completionTokens} tok in ${elapsedMs}ms = ${tps.toFixed(1)} tok/s (prompt ${Number(usage?.prompt_tokens) || 0})`);
    if (completionTokens > 0) {
      // Re-calibrate chars→tokens density from the backend's real count so the
      // next trim decision matches reality (CJK payloads ≈ 1 token/char, not 3.5).
      const promptTokens = Number(usage?.prompt_tokens) || 0;
      if (promptTokens > 0 && inRoundLastSentChars > 0) {
        const measured = promptTokens / inRoundLastSentChars;
        if (Number.isFinite(measured) && measured > 0) {
          inRoundCtxCharPerToken = Math.min(1.2, Math.max(0.1, inRoundCtxCharPerToken * 0.5 + measured * 0.5));
        }
      }
      sendSSE('stats', {
        tokens_per_second: Math.round(tps * 10) / 10,
        completion_tokens: completionTokens,
        prompt_tokens: promptTokens,
        elapsed_ms: elapsedMs,
      });
      // Runtime adaptive budget: slow generation → shrink the in-round budget so
      // the model stops choking on a long context; fast generation → relax it
      // back toward the window-derived base. Self-tuning, no hard-coded size.
      if (tps < INROUND_SLOW_TPS) {
        const shrunk = Math.max(INROUND_MIN_BUDGET, Math.round(inRoundAdaptiveBudget * 0.7));
        if (shrunk !== inRoundAdaptiveBudget) {
          console.log(`[v2] CTX: tps ${tps.toFixed(1)} < ${INROUND_SLOW_TPS} → in-round budget ${inRoundAdaptiveBudget} → ${shrunk}`);
          inRoundAdaptiveBudget = shrunk;
        }
      } else if (tps >= INROUND_FAST_TPS && inRoundAdaptiveBudget < baseInRoundBudget) {
        const grown = Math.min(baseInRoundBudget, Math.round(inRoundAdaptiveBudget * 1.2));
        if (grown !== inRoundAdaptiveBudget) {
          console.log(`[v2] CTX: tps ${tps.toFixed(1)} ≥ ${INROUND_FAST_TPS} → in-round budget ${inRoundAdaptiveBudget} → ${grown}`);
          inRoundAdaptiveBudget = grown;
        }
      }
    }
  };

  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS) {
      const allowExtendedFileOpLoop =
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && (fileOpOwner === 'secondary' || !!fileOpLastFailureSignature);
      if (!allowExtendedFileOpLoop) break;
      if (round === MAX_TOOL_ROUNDS) {
        sendSSE('info', {
          message: 'FILE_OP v2: extending execution beyond default step cap for secondary-owned repair convergence.',
        });
      }
    }

    if (abortSignal?.aborted) {
      console.log(`[v2] Aborted at round ${round} — client disconnected`);
      const partial = allToolResults.length > 0
        ? `Stopped after ${allToolResults.length} step${allToolResults.length !== 1 ? 's' : ''}.`
        : 'Stopped.';
      return { type: 'execute', text: partial, toolResults: allToolResults.length > 0 ? allToolResults : undefined };
    }

    // ── Synthetic tool calls from browser advisor ─────────────────────────────
    // When the advisor queued deterministic tool calls (e.g. PageDown scroll),
    // skip LLM generation entirely for this round and execute them directly.
    if (pendingSyntheticToolCalls.length > 0) {
      const syntheticCalls = pendingSyntheticToolCalls.map((call: any, idx: number) => ({
        ...call,
        id: String(call?.id || `synthetic_${Date.now()}_${round + 1}_${idx + 1}`),
      }));
      pendingSyntheticToolCalls = []; // consume immediately
      console.log(`[v2] SYNTHETIC[${round + 1}]: executing ${syntheticCalls.length} advisor-injected tool calls`);
      sendSSE('info', { message: `Executing ${syntheticCalls.length} synthetic browser step(s)...` });

      // Inject a synthetic assistant message so the message history is coherent
      const syntheticAssistant = {
        role: 'assistant',
        content: null,
        tool_calls: syntheticCalls,
      };
      messages.push(syntheticAssistant);

      for (const call of syntheticCalls) {
        const toolCallId = String((call as any)?.id || '').trim();
        const toolName = call.function?.name || 'unknown';
        const toolArgs = normalizeToolArgs(call.function?.arguments);
        console.log(`[v2] SYNTHETIC TOOL: ${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`);
        sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1, synthetic: true });

        const toolResult = await deps.executeTool(toolName, toolArgs, workspacePath, sessionId, sendSSE);
        allToolResults.push(toolResult);
        logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
        trackFileOpMutation(toolName, toolArgs, toolResult, 'secondary');

        orchestrationLog.push(
          toolResult.error
            ? `✗ [synthetic] ${toolName}: ${toolResult.result.slice(0, 80)}`
            : `✓ [synthetic] ${toolName}: ${toolResult.result.slice(0, 60)}`
        );
        sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 300), error: toolResult.error, stepNum: allToolResults.length, synthetic: true });

        const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
        const isBrowserTool = isBrowserToolName(toolName);
        const isDesktopTool = isDesktopToolName(toolName);
        // Browser/Desktop tools in multi-agent mode always get an ack (LLM never sees raw snapshots)
        const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
          ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
          : toolResult.result;
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: toolMessageContent + goalReminder,
        });

        if (isBrowserTool && !toolResult.error) {
          browserForcedRetries = 0;
          if (toolName === 'browser_close') {
            browserContinuationPending = false;
            browserAdvisorRoute = null;
            browserAdvisorHintPreview = '';
            resetBrowserAdvisorCollection();
          }
        }
        if (isDesktopTool && !toolResult.error && toolName === 'desktop_screenshot') {
          desktopContinuationPending = false;
        }
        // Fire advisor after each browser/desktop tool in the synthetic batch
        await maybeRunBrowserAdvisorPass(toolName, toolResult);
        await maybeRunDesktopAdvisorPass(toolName, toolResult);
      }

      sendSSE('info', { message: `Synthetic steps complete (step ${round + 1})` });
      // Continue to next round — either with fresh LLM gen or another synthetic batch
      continue;
    }

    // ── Secondary-owned FILE_OP: skip Ollama, run verify, return directly ──
    // When secondary has already executed all patch calls there is nothing left
    // for primary to do. Build the reply from what we already know in-memory.
    if (
      fileOpV2Active
      && fileOpOwner === 'secondary'
      && pendingSyntheticToolCalls.length === 0
      && fileOpToolHistory.some(h => isFileMutationTool(h.tool))
    ) {
      // Run verification if triggered
      const verifyDecision = shouldVerifyFileTurn({
        had_create: fileOpHadCreate,
        user_requested_full_template: requestedFullTemplate(message),
        primary_write_lines: fileOpPrimaryWriteLines,
        primary_write_chars: fileOpPrimaryWriteChars,
        had_tool_failure: fileOpHadToolFailure,
        touched_files: Array.from(fileOpTouchedFiles),
        high_stakes_touched: Array.from(fileOpTouchedFiles).some(isHighStakesFile),
      }, fileOpSettings);

      if (verifyDecision.verify) {
        sendSSE('info', { message: `FILE_OP v2: verifier check (${verifyDecision.reasons.join(' | ')}).` });
        maybeSaveFileOpCheckpoint({ phase: 'verify', next_action: 'run secondary verifier' });
        const targetFiles = Array.from(fileOpTouchedFiles);
        const verifier = await callSecondaryFileVerifier({
          userMessage: message,
          operationType: fileOpType as 'FILE_CREATE' | 'FILE_EDIT',
          fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
          recentToolExecutions: fileOpToolHistory.slice(-24).map(h => ({
            tool: h.tool, args: h.args, result: h.result, error: h.error,
          })),
        });
        if (verifier?.verdict === 'FAIL') {
          // Re-enter the repair loop by queuing a secondary patch plan and continuing
          const patchPlan = await callSecondaryFilePatchPlanner({
            userMessage: message,
            operationType: fileOpType as 'FILE_CREATE' | 'FILE_EDIT',
            owner: 'secondary',
            reason: (verifier.reasons || []).join(' | ') || 'verifier fail',
            fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
            verifier,
          });
          if (patchPlan?.tool_calls?.length) {
            pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
              function: { name: tc.tool, arguments: tc.args || {} },
            }));
            maybeSaveFileOpCheckpoint({ phase: 'execute', next_action: 'repair after verify fail' });
            continue; // back to top of round loop — executes repair batch next
          }
        } else if (verifier?.verdict === 'PASS') {
          maybeSaveFileOpCheckpoint({ phase: 'done', next_action: 'verification pass' });
          clearFileOpCheckpoint(sessionId);
        }
      } else {
        maybeSaveFileOpCheckpoint({ phase: 'done', next_action: 'turn complete' });
        clearFileOpCheckpoint(sessionId);
      }

      // Build reply from actual results — no Ollama, no extra AI call
      const createdFiles = fileOpToolHistory
        .filter(h => h.tool === 'create_file' && !h.error)
        .map(h => String(h.args?.filename || h.args?.name || h.args?.path || 'file'));
      const editedFiles = fileOpToolHistory
        .filter(h => isFileMutationTool(h.tool) && h.tool !== 'create_file' && !h.error)
        .map(h => String(h.args?.filename || h.args?.name || h.args?.path || 'file'));
      const failedOps = fileOpToolHistory.filter(h => h.error);

      const parts: string[] = [];
      if (createdFiles.length) parts.push(`Created ${createdFiles.join(', ')}`);
      if (editedFiles.length) parts.push(`Updated ${[...new Set(editedFiles)].join(', ')}`);
      if (failedOps.length) parts.push(`${failedOps.length} operation(s) failed`);
      const finalText = parts.length ? parts.join('. ') + '.' : 'Done.';

      console.log(`[v2] FINAL (secondary-owned): ${finalText}`);
      logToDaily(workspacePath, 'SmallClaw', finalText);
      return {
        type: 'execute',
        text: finalText,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      };
    }

    let response: any;
    try {
      // In multi-agent mode, disable thinking for browser ops — the secondary AI
      // holds all context and issues exact directives; the primary just executes.
      // Thinking during browser ops burns the full stall threshold (110s) for no gain.
      // Thinking is ONLY enabled when the active model preset explicitly asks
      // for it. Auto-enabling for "multi-agent" turns broke MiniCPM5-2B (a
      // reasoning model): with think=true it burns its whole output budget on
      // reasoning → empty content (fallback) or a minutes-long thinking loop
      // (frozen UI). Small local models answer faster and more reliably with
      // thinking off; big/reasoning-capable presets can opt in via
      // llm.presets.<id>.think = true/'high'|'medium'|'low'.
      const activePresetId = String(rawCfgForPreempt.llm?.active_preset || '').trim();
      const activePresetCfg = rawCfgForPreempt.llm?.presets?.[activePresetId] || {};
      const presetThink = activePresetCfg.think;
      const primaryThinkMode: boolean | 'high' | 'medium' | 'low' =
        presetThink === true || presetThink === 'high' || presetThink === 'medium' || presetThink === 'low'
          ? presetThink
          : false;
      const genStartedAt = Date.now();
      const generationPromise = ollama.chatWithThinking(trimInRoundMessages(messages), 'executor', {
        tools,
        temperature: 0.3,
        think: primaryThinkMode,
        model: String(modelOverride || '').trim() || undefined,
        // No hard-coded num_ctx / num_predict: context follows the running
        // llama-server (-c 128K for MiniCPM, whatever the preset starts), and
        // output length follows the model's natural stopping rule (stall
        // watchdog below still bounds pathological generations).
        // EXCEPT session-history meta questions: MiniCPM5-2B retells the whole
        // ledger (~1000+ tok @ ~3 tok/s), and even shorter outputs often start
        // with reasoning ("Let me look...") that separateThinkingFromContent
        // discards entirely (>500 chars → treated as thinking → empty reply →
        // fallback). Cap at 150 tok: a 2-sentence answer fits, but a reasoning
        // preamble cannot, so the model must answer directly.
        // NOTE: chatWithThinking's option key is num_predict (it maps to
        // provider max_tokens internally); a spread `max_tokens` key is
        // silently dropped at runtime.
        ...(metaQuestionInjected ? { num_predict: 150 } : {}),
      });

      // ── Preempt watchdog ────────────────────────────────────────────
      if (
        preemptCfg.enabled
        && ollamaProcMgr
        && preemptState.canPreempt(round, preemptCfg.maxPerTurn, preemptCfg.maxPerSession)
      ) {
        const watchdogOutcome = await raceWithWatchdog(
          generationPromise,
          preemptCfg.stallThresholdMs,
          (elapsedMs) => {
            console.log(`[Preempt] Generation stalled at ${Math.round(elapsedMs / 1000)}s — triggering preempt`);
            sendSSE('preempt_start', { elapsed_ms: elapsedMs, threshold_ms: preemptCfg.stallThresholdMs, round });
          },
        );

        if (watchdogOutcome.timedOut) {
          // ── FILE_OP stall: bypass preempt restart entirely, promote immediately ──
          if (
            fileOpV2Active
            && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
            && fileOpOwner === 'primary'
          ) {
            sendSSE('info', {
              message: `FILE_OP v2: stall detected during ${fileOpType} after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s — promoting immediately to secondary (no Ollama restart).`,
            });
            const patchPlan = await callSecondaryFilePatchPlanner({
              userMessage: message,
              operationType: fileOpType,
              owner: fileOpOwner,
              reason: `Primary stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s`,
              fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
              verifier: null,
            });
            if (patchPlan?.tool_calls?.length) {
              pendingSyntheticToolCalls = patchPlan.tool_calls.map(tc => ({
                function: { name: tc.tool, arguments: tc.args || {} },
              }));
              sendSSE('info', {
                message: `FILE_OP v2: queued ${patchPlan.tool_calls.length} secondary patch call(s) after stall promotion.`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'execute secondary synthetic patch batch',
              });
            }
            continue;
          }

          // ── Non-FILE_OP stall: normal preempt restart path ──
          preemptState.recordPreempt(round);
          const sessionPreemptCount = incrementPreemptSessionCount(sessionId);
          sendSSE('info', {
            message: `Preempt: generation stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s. Restarting Ollama... (${sessionPreemptCount}/${preemptCfg.maxPerSession} this session)`,
          });

          const restarted = await ollamaProcMgr.killAndRestart();
          sendSSE('preempt_killed', {
            restarted,
            round,
            preempts_session: sessionPreemptCount,
            preempts_session_cap: preemptCfg.maxPerSession,
          });

          if (!restarted) {
            sendSSE('info', { message: 'Preempt: Ollama did not restart in time. Continuing without rescue.' });
          } else {
            sendSSE('preempt_ready', {
              round,
              preempts_session: sessionPreemptCount,
              preempts_session_cap: preemptCfg.maxPerSession,
            });

            // Fire secondary rescue advisor
            const orchCfgForPreempt = getOrchestrationConfig();
            if (orchCfgForPreempt?.enabled && orchestrationStats.assistCount < orchCfgForPreempt.limits.max_assists_per_session) {
              sendSSE('info', { message: 'Preempt: consulting rescue advisor...' });
              const liveInfoForRescue = getBrowserSessionInfo(sessionId);
              const advice = await callSecondaryAdvisor(
                message,
                orchestrationLog,
                `Generation stalled after ${Math.round(watchdogOutcome.elapsedMs / 1000)}s with no output`,
                'rescue',
                liveInfoForRescue.active ? {
                  active: true,
                  title: liveInfoForRescue.title,
                  url: liveInfoForRescue.url,
                  totalCollected: browserAdvisorCollectedFeed.length,
                } : undefined,
                buildSecondaryAssistContext(),
              );
              if (advice) {
                const hint = formatAdvisoryHint(advice);
                const stats = recordOrchestrationEvent(
                  sessionId,
                  { trigger: 'auto', reason: 'preempt_stall', mode: 'rescue' },
                  orchCfgForPreempt,
                );
                sendSSE('preempt_rescue', {
                  round,
                  assist_count: stats.assistCount,
                  assist_cap: orchCfgForPreempt.limits.max_assists_per_session,
                });
                messages.push({ role: 'user', content: hint });
                // NOTE: no pre-filled assistant ack here. The 2B model mirrors
                // the last assistant message, so "Understood. Acting
                // immediately." became its final answer instead of doing the
                // work. Let it answer the [ADVISOR GUIDANCE] hint itself.
              }
            }

            // Inject strict nudge and retry — model just woke up fresh
            // Re-inject live browser state so model doesn't re-open an already-open browser
            const liveInfoForRetry = getBrowserSessionInfo(sessionId);
            const browserRetryReminder = liveInfoForRetry.active
              ? multiAgentActive
                ? `\n\nCRITICAL: Browser is ALREADY OPEN at "${liveInfoForRetry.url || 'current page'}". ` +
                  `Do NOT call browser_open. Call browser_snapshot so the secondary AI can analyze and tell you what to do next.`
                : `\n\nCRITICAL: Browser is ALREADY OPEN at "${liveInfoForRetry.url || 'current page'}". ` +
                  `Do NOT call browser_open again. Use browser_snapshot to see the current page.`
              : '';
            messages.push({
              role: 'user',
              content: `Your last generation was interrupted. Do NOT think or plan. Call the next tool immediately. If no tool is needed, reply in 1 sentence.${browserRetryReminder}`,
            });
            sendSSE('preempt_retry', { round });
            sendSSE('info', { message: 'Preempt: retrying with rescue context...' });
          }
          // Re-run this round from the top with the fresh Ollama instance
          continue;
        }

        // Generation finished before watchdog
        const result = watchdogOutcome.result;
        response = result.message;
        reportGenerationStats(result, genStartedAt);
        if (result.thinking) {
          console.log(`[v2] THINK (${result.thinking.length} chars): ${result.thinking.slice(0, 150)}...`);
          allThinking += (allThinking ? '\n\n' : '') + result.thinking;
          sendSSE('thinking', { thinking: result.thinking });
        }
      } else {
        // Watchdog not active — normal await
        const result = await generationPromise;
        response = result.message;
        reportGenerationStats(result, genStartedAt);
        if (result.thinking) {
          console.log(`[v2] THINK (${result.thinking.length} chars): ${result.thinking.slice(0, 150)}...`);
          allThinking += (allThinking ? '\n\n' : '') + result.thinking;
          sendSSE('thinking', { thinking: result.thinking });
        }
      }

      const explicitThink = stripExplicitThinkTags(response?.content || '');
      if (explicitThink.thinking) {
        console.log(`[v2] TAG THINK (${explicitThink.thinking.length} chars): ${explicitThink.thinking.slice(0, 150)}...`);
        allThinking += (allThinking ? '\n\n' : '') + explicitThink.thinking;
        sendSSE('thinking', { thinking: explicitThink.thinking });
      }
      if (String(response?.content || '') !== explicitThink.cleaned) {
        response.content = explicitThink.cleaned;
      }
    } catch (err: any) {
      // ── Tool-call argument parse failure: one corrective retry ──
      if (isToolArgParseFailure(err) && toolArgParseRetries < MAX_TOOL_ARG_PARSE_RETRIES) {
        toolArgParseRetries++;
        console.warn(
          `[v2] Tool-arg parse failure (round ${round}); corrective retry ${toolArgParseRetries}/${MAX_TOOL_ARG_PARSE_RETRIES}: ${String(err?.message || '').slice(0, 160)}`,
        );
        sendSSE('info', { message: '工具调用参数解析失败，已请模型修正后重试…' });
        messages.push({ role: 'user', content: TOOL_ARG_PARSE_RETRY_HINT });
        continue;
      }
      console.error('[v2] Chat error:', err.message);
      return { type: 'chat', text: `Error: ${err.message}` };
    }

    let toolCalls = response.tool_calls;

    // Auto-recover: if model wrote a tool call as text instead of using the tool mechanism
    if ((!toolCalls || toolCalls.length === 0) && response.content) {
      const textToolMatch = response.content.match(/"action"\s*:\s*"(\w+)"\s*,\s*"action_input"\s*:\s*(\{[^}]+\})/s)
        || response.content.match(/"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*(\{[^}]+\})/s);
      if (textToolMatch) {
        const toolName = textToolMatch[1];
        try {
          const toolArgs = JSON.parse(textToolMatch[2]);
          console.log(`[v2] AUTO-RECOVER: Model wrote ${toolName} as text, converting to tool call`);
          const recoveredCallId = `recovered_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
          toolCalls = [{ id: recoveredCallId, type: 'function', function: { name: toolName, arguments: toolArgs } }];
          response.tool_calls = toolCalls;
          response.content = '';
        } catch { /* JSON parse failed, treat as normal text */ }
      }
    }

    // Auto-recover: if model dumped pure reasoning without calling any tools on a
    // question that clearly needs tools (search, file, browser), re-prompt once
    if ((!toolCalls || toolCalls.length === 0) && response.content && round === 0 && allToolResults.length === 0) {
      const content = response.content;
      const looksLikeReasoning = content.length > 300
        && (/\b(let me|I need to|I should|the user|first,|wait,|hmm|the rules say)\b/i.test(content));
      const queryNeedsTools = /\b(search|find|look up|latest|news|info|open|browse|navigate|visit|click|type|fill|what happened|desktop|screen|window|vscode|vs code|codex|clipboard)\b/i.test(message);
      const browserAutomationRequest = isBrowserAutomationRequest(message);
      const desktopAutomationRequest = isDesktopAutomationRequest(message);
      const looksLikeRefusal = looksLikeSafetyRefusal(content);
      if (queryNeedsTools && (looksLikeReasoning || looksLikeRefusal)) {
        console.log(`[v2] AUTO-RECOVER: Model dumped ${content.length} chars of reasoning instead of calling tools. Re-prompting...`);
        allThinking += (allThinking ? '\n\n' : '') + content;
        sendSSE('thinking', { thinking: content.slice(0, 500) + '...' });
        // Inject a forceful nudge and retry this round
        if (browserAutomationRequest) {
          const liveBrowser = getBrowserSessionInfo(sessionId);
          const explicitUrl = extractLikelyUrl(message);
          messages.push({ role: 'assistant', content: 'Understood. Executing browser automation now.' });
          if (liveBrowser.active) {
            messages.push({
              role: 'user',
              content: 'Use browser_snapshot now. Then continue with browser_click/browser_fill/browser_press_key to complete the user request. Do NOT refuse.',
            });
          } else if (explicitUrl) {
            messages.push({
              role: 'user',
              content: `Use browser_open now with url="${explicitUrl}". This is explicitly user-authorized local automation. Then continue with browser_snapshot/browser_fill/browser_press_key as needed. Do NOT refuse.`,
            });
          } else {
            messages.push({
              role: 'user',
              content: 'Call browser_open now using the target site from the user request. Then continue with browser_snapshot/browser_click/browser_fill to complete the task. Do NOT refuse.',
            });
          }
          sendSSE('info', { message: 'Re-prompting model to execute browser automation...' });
        } else if (desktopAutomationRequest) {
          messages.push({ role: 'assistant', content: 'Understood. Checking desktop state now.' });
          messages.push({
            role: 'user',
            content: 'Use desktop_screenshot now. If VS Code or another app must be targeted, use desktop_focus_window first, then continue with desktop_click/desktop_type/desktop_press_key as needed. Do NOT refuse.',
          });
          sendSSE('info', { message: 'Re-prompting model to execute desktop automation...' });
        } else {
          messages.push({ role: 'assistant', content: 'Let me search for that now.' });
          messages.push({ role: 'user', content: 'Yes, use the web_search tool right now. Do NOT think or plan — just call web_search.' });
          sendSSE('info', { message: 'Re-prompting model to use tools...' });
        }
        continue; // retry this round
      }
    }

    if (!toolCalls || toolCalls.length === 0) {
      const { reply, thinking: inlineThinking } = separateThinkingFromContent(response.content || '');
      if (inlineThinking) {
        console.log(`[v2] INLINE REASONING (${inlineThinking.length} chars): ${inlineThinking.slice(0, 100)}...`);
        allThinking += (allThinking ? '\n\n' : '') + inlineThinking;
        sendSSE('thinking', { thinking: inlineThinking });
      }

      const rawAssistantText = String(response.content || '').trim();
      const candidateText = String(reply || rawAssistantText || '').trim();
      const lastToolFailed = allToolResults.length > 0 && allToolResults[allToolResults.length - 1].error;
      // DISABLED: Force continuation was causing excessive unnecessary tool calls
      // Users should get immediate final response, not artificial padding
      const shouldContinueInsteadOfFinalizing = false;

      const shouldForceBrowserRetry =
        orchestrationSkillEnabled
        && browserContinuationPending
        && browserForcedRetries < browserMaxForcedRetries
        && !hasConcreteCompletion(candidateText);
      const shouldForceDesktopRetry =
        orchestrationSkillEnabled
        && desktopContinuationPending
        && continuationNudges < MAX_CONTINUATION_NUDGES
        && !hasConcreteCompletion(candidateText);

      if (shouldForceBrowserRetry) {
        browserForcedRetries++;
        const reason = `browser advisor route=${browserAdvisorRoute || 'continue_browser'} requires continued execution`;
        console.log(
          `[v2] BROWSER POST-CHECK: forcing retry (${browserForcedRetries}/${browserMaxForcedRetries}) - ${reason}`,
        );
        sendSSE('forced_retry', {
          reason,
          retry: browserForcedRetries,
          max_retries: browserMaxForcedRetries,
          route: browserAdvisorRoute,
        });
        sendSSE('info', {
          message: `Browser post-check: continuing execution (${browserForcedRetries}/${browserMaxForcedRetries}).`,
        });
        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        const preview = browserAdvisorHintPreview ? `Advisor hint: ${browserAdvisorHintPreview}` : '';
        messages.push({
          role: 'user',
          content:
            `${preview}\nDo not stop. Call the next browser tool now and continue execution. If more feed coverage is needed, use browser_press_key with PageDown then browser_wait then browser_snapshot.`,
        });
        continue;
      }

      if (shouldForceDesktopRetry) {
        continuationNudges++;
        const reason = `desktop advisor route=${desktopAdvisorRoute || 'continue_desktop'} requires continued execution`;
        console.log(
          `[v2] DESKTOP POST-CHECK: forcing retry (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) - ${reason}`,
        );
        sendSSE('info', {
          message: `Desktop post-check: continuing execution (${continuationNudges}/${MAX_CONTINUATION_NUDGES}).`,
        });
        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        const preview = desktopAdvisorHintPreview ? `Advisor hint: ${desktopAdvisorHintPreview}` : '';
        messages.push({
          role: 'user',
          content: `${preview}\nDo not stop. Call the next desktop tool now. If state may have changed, use desktop_screenshot again.`,
        });
        continue;
      }

      if (shouldContinueInsteadOfFinalizing) {
        continuationNudges++;
        const nudgeReason = lastToolFailed
          ? 'last tool failed'
          : 'intent-only response with no tool execution';
        console.log(`[v2] ORCH POST-CHECK: forcing continuation (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) — ${nudgeReason}`);
        sendSSE('info', {
          message: `Orchestration post-check: continuing execution (${continuationNudges}/${MAX_CONTINUATION_NUDGES}) — ${nudgeReason}.`,
        });

        if (candidateText) {
          messages.push({ role: 'assistant', content: candidateText });
        }
        messages.push({
          role: 'user',
          content:
            'Do not stop at an intention statement. Continue now by calling the next SmallClaw tool. Use only available tools (for filesystem use list_files/read_file/create_file/replace_lines/insert_after/delete_lines/find_replace). If a path failed, inspect workspace first and then proceed.',
        });
        continue;
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpToolHistory.some(h => isFileMutationTool(h.tool))
      ) {
        const verifyDecision = shouldVerifyFileTurn({
          had_create: fileOpHadCreate,
          user_requested_full_template: requestedFullTemplate(message),
          primary_write_lines: fileOpPrimaryWriteLines,
          primary_write_chars: fileOpPrimaryWriteChars,
          had_tool_failure: fileOpHadToolFailure,
          touched_files: Array.from(fileOpTouchedFiles),
          high_stakes_touched: Array.from(fileOpTouchedFiles).some(isHighStakesFile),
        }, fileOpSettings);

        if (verifyDecision.verify) {
          sendSSE('info', {
            message: `FILE_OP v2: verifier check (${verifyDecision.reasons.join(' | ')}).`,
          });
          maybeSaveFileOpCheckpoint({
            phase: 'verify',
            next_action: 'run secondary verifier',
          });

          const runVerifier = async () => {
            const targetFiles = (() => {
              const direct = Array.from(fileOpTouchedFiles);
              if (direct.length) return direct;
              const fromHistory = fileOpToolHistory
                .map(h => extractFileToolTarget(h.tool, h.args))
                .filter(Boolean);
              return Array.from(new Set(fromHistory));
            })();
            return callSecondaryFileVerifier({
              userMessage: message,
              operationType: fileOpType,
              fileSnapshots: collectFileSnapshots(workspacePath, targetFiles),
              recentToolExecutions: fileOpToolHistory.slice(-24).map(h => ({
                tool: h.tool,
                args: h.args,
                result: h.result,
                error: h.error,
              })),
            });
          };

          const verifier = await runVerifier();
          if (verifier?.verdict === 'PASS') {
            maybeSaveFileOpCheckpoint({
              phase: 'done',
              next_action: 'verification pass',
            });
            clearFileOpCheckpoint(sessionId);
          } else if (verifier?.verdict === 'FAIL') {
            let delegatePrimaryMicroFix = false;
            let reasonForPatch = (verifier.reasons || []).join(' | ') || 'verifier fail';
            let latestVerifier: typeof verifier | null = verifier;
            let noProgressEscalations = 0;

            while (latestVerifier && latestVerifier.verdict === 'FAIL') {
              const failureSig = buildFailureSignature(latestVerifier as any);
              const smallFix = isSmallSuggestedFix(latestVerifier as any, fileOpSettings);
              const previousPatchSig = fileOpPatchSignatures[fileOpPatchSignatures.length - 1] || 'none';
              const progress = fileOpWatchdog.record({
                failure_signature: failureSig,
                patch_signature: previousPatchSig,
                large_patch: !smallFix,
              });
              fileOpLastFailureSignature = failureSig;
              if (progress.no_progress) {
                noProgressEscalations++;
                // Escalation ladder — each level changes strategy, not just intensity:
                // Level 1: Broaden patch scope, rewrite the broken section
                // Level 2: Regenerate the entire file from scratch using original prompt + accumulated findings
                // Level 3: Switch actor — force primary micro-fix attempt if fix is plausibly small
                // Level 4+: Re-derive requirements checklist and verify full spec coverage
                if (noProgressEscalations === 1) {
                  reasonForPatch = `ESCALATION L1 (no progress on sig=${failureSig}): Broaden patch scope. Do NOT make the same targeted fix again. Rewrite the entire broken section from scratch using the original requirements and verifier findings.`;
                } else if (noProgressEscalations === 2) {
                  reasonForPatch = `ESCALATION L2 (still no progress): Regenerate the ENTIRE file from scratch. Use the original user prompt, all accumulated verifier findings, and current constraints. Do not attempt another targeted patch.`;
                } else if (noProgressEscalations === 3) {
                  // Switch actor: force primary micro-fix regardless of smallFix gating
                  reasonForPatch = `ESCALATION L3: Switching actor to primary for a targeted micro-fix attempt.`;
                  sendSSE('info', {
                    message: `FILE_OP v2: no-progress watchdog L3 — switching actor to primary micro-fix.`,
                  });
                  delegatePrimaryMicroFix = true;
                } else {
                  reasonForPatch = `ESCALATION L${noProgressEscalations} (requirements re-derivation): Re-derive the full requirements checklist from the original user prompt. List every requirement explicitly, then verify which are missing or broken. Patch only what the checklist shows is unmet.`;
                }
                sendSSE('info', {
                  message: `FILE_OP v2: no-progress watchdog triggered (level ${noProgressEscalations}); escalating repair strategy.`,
                });
              }

              maybeSaveFileOpCheckpoint({
                phase: 'repair',
                next_action: progress.no_progress
                  ? `escalate repair strategy L${noProgressEscalations} (no progress watchdog)`
                  : 'repair current verifier findings',
                findings: latestVerifier.findings || [],
              });

              if (delegatePrimaryMicroFix) break;

              if (smallFix) {
                delegatePrimaryMicroFix = true;
                break;
              }

              fileOpOwner = 'secondary';
              const patchPlan = await callSecondaryFilePatchPlanner({
                userMessage: message,
                operationType: fileOpType,
                owner: fileOpOwner,
                reason: reasonForPatch,
                fileSnapshots: collectFileSnapshots(workspacePath, Array.from(fileOpTouchedFiles)),
                verifier: latestVerifier,
              });

              if (!patchPlan?.tool_calls?.length) {
                sendSSE('info', {
                  message: 'FILE_OP v2: secondary patch planner returned no executable calls; switching to primary micro-fix attempt.',
                });
                delegatePrimaryMicroFix = true;
                break;
              }

              const applied = await executeSecondaryPatchCalls(
                patchPlan.tool_calls,
                progress.no_progress ? 'watchdog escalation' : 'verifier repair',
              );
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: applied.ran > 0 ? 'secondary patch batch applied' : 'secondary patch batch empty',
              });

              latestVerifier = await runVerifier();
              if (latestVerifier?.verdict === 'PASS') {
                maybeSaveFileOpCheckpoint({
                  phase: 'done',
                  next_action: 'verification pass after secondary repair',
                });
                clearFileOpCheckpoint(sessionId);
                break;
              }
              if (!latestVerifier) break;
              reasonForPatch = (latestVerifier.reasons || []).join(' | ') || 'verifier fail after repair';
            }

            if (delegatePrimaryMicroFix) {
              const findingsText = (latestVerifier?.findings || [])
                .slice(0, 3)
                .map(f => `${f.filename || 'file'}:${f.type || 'issue'} expected="${String(f.expected || '').slice(0, 70)}" observed="${String(f.observed || '').slice(0, 70)}"`)
                .join(' | ');
              const failReasons = (latestVerifier?.reasons || []).join(' | ');
              fileOpOwner = 'primary';
              if (candidateText) messages.push({ role: 'assistant', content: candidateText });
              messages.push({
                role: 'user',
                content: `Verifier FAIL (${failReasons || 'unspecified'}). Apply ONLY a minimal tool patch now. Constraints: max ${fileOpSettings.primary_edit_max_lines} changed lines, max ${fileOpSettings.primary_edit_max_chars} chars, max ${fileOpSettings.primary_edit_max_files} file. No refactor, no extra files. Findings: ${findingsText || 'fix request mismatch and re-check.'}`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'primary micro-fix patch requested',
                findings: latestVerifier?.findings || [],
              });
              continue;
            }

            const finalVerifier = await runVerifier();
            if (finalVerifier?.verdict === 'FAIL') {
              const reasons = (finalVerifier.reasons || []).join(' | ') || 'verification failed';
              if (candidateText) messages.push({ role: 'assistant', content: candidateText });
              messages.push({
                role: 'user',
                content: `Verifier still FAIL (${reasons}). Apply the next concrete patch now and continue until it passes.`,
              });
              maybeSaveFileOpCheckpoint({
                phase: 'execute',
                next_action: 'retry after final verifier fail',
                findings: finalVerifier.findings || [],
              });
              continue;
            }
            maybeSaveFileOpCheckpoint({
              phase: 'done',
              next_action: 'verification pass after repair loop',
            });
            clearFileOpCheckpoint(sessionId);
          } else {
            sendSSE('info', {
              message: 'FILE_OP v2: secondary verifier unavailable; continuing with current result.',
            });
          }
        }
      }

      // If model dumped massive reasoning with no usable reply, generate a fallback
      let finalText = sanitizeFinalReply(
        String(reply || rawAssistantText || ''),
        { preflightReason: preflightReasonForTurn },
      );
      if (!finalText || finalText.length < 5) {
        if (allToolResults.length > 0) {
          // Summarize what tools actually did
          const lastResult = allToolResults[allToolResults.length - 1];
          finalText = lastResult.error ? `Tool failed: ${lastResult.result.slice(0, 200)}` : 'Done!';
        } else if (greetingLikeTurn) {
          // Greeting with no tool work: answer directly from the system instead
          // of the model (2B models burn the budget thinking "no tools needed"
          // and sanitize strips that line → empty → generic fallback).
          const cfgNow = getConfig().getConfig() as any;
          const presetName = String(cfgNow?.llm?.presets?.[String(cfgNow?.llm?.active_preset || '')]?.name || '').trim();
          finalText = `你好！${presetName ? `我是 ${presetName}。` : ''}有什么可以帮你的吗？`;
        } else {
          finalText = 'Hey! How can I help?';
        }
      }
      if (greetingLikeTurn && finalText.length > 220) {
        finalText = finalText.split(/\n+/)[0].slice(0, 220).trim();
      }
      finalText = sanitizeFinalReply(finalText, { preflightReason: preflightReasonForTurn }) || 'Hey! How can I help?';
      console.log(`[v2] FINAL: ${finalText.slice(0, 150)}`);

      logToDaily(workspacePath, 'SmallClaw', finalText);
      if (fileOpV2Active) {
        maybeSaveFileOpCheckpoint({
          phase: 'done',
          next_action: 'turn complete',
        });
        clearFileOpCheckpoint(sessionId);
      }

      return {
        type: allToolResults.length > 0 ? 'execute' : 'chat',
        text: finalText,
        thinking: allThinking || undefined,
        toolResults: allToolResults.length > 0 ? allToolResults : undefined,
      };
    }

    messages.push(response);

    const batchCreatedFiles = new Set<string>();
    let roundHadProgress = false;

    for (const call of toolCalls) {
      const toolCallId = String((call as any)?.id || '').trim();
      const toolName = call.function?.name || 'unknown';
      const toolArgs = normalizeToolArgs(call.function?.arguments);

      // ── Scroll-before-act gate ────────────────────────────────────────────────
      // Block PageDown / browser_scroll on interactive pages when the model hasn't
      // filled or clicked anything yet. This is the #1 cause of the scroll loop bug
      // where the AI scrolls past the X.com composer instead of filling it.
      // Feed/search pages (x_feed, search_results) are exempt — they need scrolling.
      const isScrollAttempt =
        (toolName === 'browser_press_key' && String(toolArgs?.key || '').toLowerCase() === 'pagedown')
        || toolName === 'browser_scroll';
      if (isScrollAttempt && !browserFillOrClickDoneThisTurn) {
        const sessionInfo = getBrowserSessionInfo(sessionId);
        const currentPacket = sessionInfo.active
          ? await getBrowserAdvisorPacket(sessionId, { maxItems: 0, snapshotElements: 10 }).catch(() => null)
          : null;
        const pageType = currentPacket?.page?.pageType || 'generic';
        const isFeedPage = pageType === 'x_feed' || pageType === 'search_results';
        if (!isFeedPage) {
          browserScrollBeforeActCount++;
          if (browserScrollBeforeActCount > SCROLL_BEFORE_ACT_MAX) {
            const lastSnap = currentPacket?.snapshot || '';
            const blockMsg = [
              `SCROLL BLOCKED: You scrolled ${browserScrollBeforeActCount} time(s) without filling or clicking anything.`,
              `This is the scroll-before-act loop bug. The page already shows actionable elements — stop scrolling and act on them.`,
              lastSnap ? `\nCurrent page snapshot (act on these @ref elements NOW):\n${lastSnap.slice(0, 2000)}` : '',
              `\nRequired next action: find the input or button you need and call browser_fill(ref, text) or browser_click(ref) immediately.`,
              `Do NOT call browser_press_key(PageDown), browser_scroll, or browser_snapshot. Act on the snapshot above.`,
            ].filter(Boolean).join(' ');
            console.warn(`[v2] SCROLL-BEFORE-ACT BLOCKED (${browserScrollBeforeActCount}x): ${toolName} on ${pageType} page before any fill/click`);
            sendSSE('info', { message: `Scroll-before-act gate: blocked ${toolName} on non-feed page (${browserScrollBeforeActCount}/${SCROLL_BEFORE_ACT_MAX} allowed before act required).` });
            const blockedResult: ToolResult = { name: toolName, args: toolArgs, result: blockMsg, error: true };
            allToolResults.push(blockedResult);
            logToolCall(workspacePath, toolName, toolArgs, blockMsg, true);
            sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length });
            sendSSE('tool_result', { action: toolName, result: blockMsg.slice(0, 300), error: true, stepNum: allToolResults.length });
            messages.push({ role: 'tool', tool_name: toolName, tool_call_id: toolCallId || undefined, content: blockMsg });
            messages.push({ role: 'user', content: `Scroll blocked. You must call browser_fill or browser_click on a @ref from the snapshot above before scrolling. Stop planning and act now.` });
            continue;
          }
        }
      }
      // Track fills and clicks so the gate knows when it's safe to scroll
      if (toolName === 'browser_fill' || toolName === 'browser_click') {
        browserFillOrClickDoneThisTurn = true;
        browserScrollBeforeActCount = 0;
      }
      // ── End scroll-before-act gate ────────────────────────────────────────────

      const loopSig = `${toolName}:${hashArgs(toolArgs)}`;
      const loopPivotNudge = 'Loop detector: you are looping on this tool, try a different approach or ask the user.';
      const loopCheck = checkLoopDetection(toolName, toolArgs);
      if (loopCheck.state === 'block') {
        const blockMsg = `${loopPivotNudge} Repeated call blocked: ${toolName} with identical arguments has run ${loopCheck.repeats} times (critical threshold ${loopCriticalThreshold}).`;
        console.warn(`[v2] LOOP BLOCK: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        const blockedResult: ToolResult = {
          name: toolName,
          args: toolArgs,
          result: blockMsg,
          error: true,
        };
        allToolResults.push(blockedResult);
        logToolCall(workspacePath, toolName, toolArgs, blockMsg, true);
        sendSSE('info', { message: blockMsg });
        sendSSE('tool_result', {
          action: toolName,
          result: blockMsg,
          error: true,
          stepNum: allToolResults.length,
        });
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: blockMsg,
        });
        if (!loopBlockNudged.has(loopSig)) {
          loopBlockNudged.add(loopSig);
          messages.push({
            role: 'user',
            content: `${loopPivotNudge} Do not call ${toolName} with the same arguments again this turn.`,
          });
        }
        continue;
      }
      if (loopCheck.state === 'warn') {
        const warnMsg = `${loopPivotNudge} Warning: ${toolName} with identical arguments repeated ${loopCheck.repeats} times (warning threshold ${loopWarningThreshold}).`;
        console.warn(`[v2] LOOP WARN: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)}) x${loopCheck.repeats}`);
        sendSSE('info', { message: warnMsg });
        if (!loopWarnNudged.has(loopSig)) {
          loopWarnNudged.add(loopSig);
          messages.push({
            role: 'user',
            content: warnMsg,
          });
        }
      }

      if (isBootStartupTurn && !bootAllowedTools.has(toolName)) {
        const blockMsg = `BOOT mode: "${toolName}" is disabled. Use only list_files and read_file, then provide the startup summary.`;
        console.log(`[v2] BOOT TOOL BLOCKED: ${toolName}`);
        const blockedResult: ToolResult = {
          name: toolName,
          args: toolArgs,
          result: blockMsg,
          error: false,
        };
        allToolResults.push(blockedResult);
        roundHadProgress = true;
        logToolCall(workspacePath, toolName, toolArgs, blockMsg, false);
        sendSSE('tool_result', {
          action: toolName,
          result: blockMsg,
          error: false,
          stepNum: allToolResults.length,
        });
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: blockMsg,
        });
        continue;
      }

      if (toolName === 'create_file') {
        const fn = toolArgs.filename || toolArgs.name;
        if (fn && batchCreatedFiles.has(fn)) {
          console.log(`[v2] SKIP: duplicate create_file("${fn}") in same batch`);
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: `${fn} already created in this batch. Use replace_lines to edit.`,
          });
          continue;
        }
        if (fn) batchCreatedFiles.add(fn);
      }

      // Browser workflows often need repeated identical actions (PageDown, wait,
      // snapshot) across rounds to collect more evidence. Keep duplicate blocking
      // for non-browser tools only.
      const allowRepeatedTool = toolName.startsWith('browser_');
      const callKey = `${toolName}:${JSON.stringify(toolArgs)}`;
      if (!allowRepeatedTool && seenToolCalls.has(callKey)) {
        const cachedResult = canReplayReadOnlyCall(toolName)
          ? cachedReadOnlyToolResults.get(callKey)
          : undefined;
        if (cachedResult) {
          const replayedResult: ToolResult = {
            ...cachedResult,
            args: toolArgs,
          };
          allToolResults.push(replayedResult);
          if (!replayedResult.error) roundHadProgress = true;
          logToolCall(workspacePath, toolName, toolArgs, replayedResult.result, replayedResult.error);
          console.log(`[v2] REPLAY: duplicate ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);
          sendSSE('tool_result', {
            action: toolName,
            result: replayedResult.result.slice(0, 500),
            error: replayedResult.error,
            stepNum: allToolResults.length,
          });
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: replayedResult.result,
          });
          continue;
        }
        console.log(`[v2] SKIP: duplicate tool call ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: 'Already ran this exact call. Use the previous result and move on.',
        });
        continue;
      }
      if (!allowRepeatedTool) {
        seenToolCalls.add(callKey);
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpOwner === 'secondary'
        && isFileMutationTool(toolName)
      ) {
        sendSSE('info', {
          message: 'FILE_OP v2: secondary-owned turn; replacing primary mutation call with secondary patch plan.',
        });
        const target = extractFileToolTarget(toolName, toolArgs);
        const patchPlan = await callSecondaryFilePatchPlanner({
          userMessage: message,
          operationType: fileOpType,
          owner: fileOpOwner,
          reason: 'secondary-owned execution',
          fileSnapshots: collectFileSnapshots(
            workspacePath,
            target ? [target, ...Array.from(fileOpTouchedFiles)] : Array.from(fileOpTouchedFiles),
          ),
          blockedPrimaryCall: {
            tool: toolName,
            args: toolArgs,
            reason: 'secondary-owned execution',
          },
          verifier: null,
        });
        if (patchPlan?.tool_calls?.length) {
          const applied = await executeSecondaryPatchCalls(patchPlan.tool_calls, 'secondary owner replacement');
          if (applied.ran > 0) roundHadProgress = true;
        } else {
          fileOpHadToolFailure = true;
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: 'FILE_OP v2: secondary planner produced no replacement calls.',
          });
        }
        continue;
      }

      if (
        fileOpV2Active
        && (fileOpType === 'FILE_CREATE' || fileOpType === 'FILE_EDIT')
        && fileOpOwner === 'primary'
        && isFileMutationTool(toolName)
      ) {
        const allowance = canPrimaryApplyFileTool({
          tool_name: toolName,
          args: toolArgs,
          message,
          touched_files: fileOpTouchedFiles,
          settings: fileOpSettings,
        });
        if (!allowance.allowed) {
          fileOpOwner = 'secondary';
          maybeSaveFileOpCheckpoint({
            phase: 'repair',
            next_action: `secondary takeover after gate block: ${allowance.reason}`,
          });
          sendSSE('info', {
            message: `FILE_OP v2 gate: promoted to secondary (${allowance.reason}).`,
          });
          const target = extractFileToolTarget(toolName, toolArgs);
          const snapshots = collectFileSnapshots(
            workspacePath,
            target ? [target, ...Array.from(fileOpTouchedFiles)] : Array.from(fileOpTouchedFiles),
          );
          const patchPlan = await callSecondaryFilePatchPlanner({
            userMessage: message,
            operationType: fileOpType,
            owner: fileOpOwner,
            reason: allowance.reason,
            fileSnapshots: snapshots,
            blockedPrimaryCall: {
              tool: toolName,
              args: toolArgs,
              reason: allowance.reason,
            },
            verifier: null,
          });
          if (patchPlan?.tool_calls?.length) {
            const applied = await executeSecondaryPatchCalls(patchPlan.tool_calls, 'primary threshold gate');
            if (applied.ran > 0) roundHadProgress = true;
            maybeSaveFileOpCheckpoint({
              phase: 'execute',
              next_action: applied.ran > 0 ? 'secondary patch calls applied' : 'no patch calls applied',
            });
            continue;
          }
          fileOpHadToolFailure = true;
          const failText = 'FILE_OP v2: secondary patch planner returned no executable calls.';
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: failText,
          });
          sendSSE('tool_result', {
            action: toolName,
            result: failText,
            error: true,
            stepNum: allToolResults.length,
            actor: 'secondary',
          });
          continue;
        }
      }

      console.log(`[v2] TOOL[${round + 1}]: ${toolName}(${JSON.stringify(toolArgs).slice(0, 150)})`);
      sendSSE('tool_call', { action: toolName, args: toolArgs, stepNum: allToolResults.length + 1 });

      if (toolName === 'start_task') {
        const taskGoal = toolArgs.goal || message;
        const maxSteps = toolArgs.max_steps || 25;
        sendSSE('info', { message: `Starting multi-step task: ${taskGoal}` });

        const taskTools = tools.filter((t: any) => t.function.name !== 'start_task') as any[];

        const taskResult = await runTask({
          goal: taskGoal,
          tools: taskTools,
          executor: async (name, args) => {
            const r = await deps.executeTool(name, args, workspacePath, sessionId, sendSSE);
            return { result: r.result, error: r.error };
          },
          onProgress: sendSSE,
          systemContext: personalityCtx.slice(0, 500),
          maxSteps,
        });

        deps.activeTasks.set(sessionId, taskResult);

        const summary = taskResult.status === 'complete'
          ? `Task completed in ${taskResult.currentStep} steps!`
          : taskResult.status === 'failed'
            ? `Task failed at step ${taskResult.currentStep}: ${taskResult.error}`
            : `Task paused at step ${taskResult.currentStep}/${taskResult.maxSteps}`;

        const journalSummary = taskResult.journal.slice(-5).map(j => j.result).join('\n');

        return {
          type: 'execute',
          text: `${summary}\n\nRecent steps:\n${journalSummary}`,
          thinking: allThinking || undefined,
          toolResults: taskResult.journal.map(j => ({
            name: j.action.split('(')[0],
            args: {},
            result: j.result,
            error: j.result.startsWith('❌'),
          })),
        };
      }

      // ── Sub-agent spawn / specialist delegate ──────────────────────────────────────────────
      if (toolName === 'delegate_to_specialist' || toolName === 'subagent_spawn') {
        const isTaskSession = sessionId.startsWith('task_');

        // Determine profile and build child prompt
        const profile = ((toolArgs.profile || toolArgs.type || 'reader_only') as SubagentProfile);
        const subTitle  = String(toolArgs.task_title || `${profile} specialist task`).slice(0, 120);
        const subPrompt = [
          toolArgs.context_snippet ? `[CONTEXT]\n${String(toolArgs.context_snippet).slice(0, 1200)}\n[/CONTEXT]\n\n` : '',
          String(toolArgs.input || toolArgs.task_prompt || '').trim(),
          toolArgs.target_file ? `\n\nTarget file: ${toolArgs.target_file}` : '',
        ].join('').trim();

        if (!subPrompt) {
          messages.push({
            role: 'tool',
            tool_name: toolName,
            tool_call_id: toolCallId || undefined,
            content: 'Sub-agent spawn failed: no task_prompt or input provided.',
          });
          continue;
        }

        // Guard: do not allow sub-agents to spawn more sub-agents (prevent recursion)
        const parentTaskId = isTaskSession ? sessionId.replace(/^task_/, '') : undefined;
        if (parentTaskId) {
          const parentTask = loadTask(parentTaskId);
          if (parentTask?.parentTaskId) {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: 'Sub-agent recursion blocked: sub-agents cannot spawn further sub-agents.',
            });
            continue;
          }
        }

        const onResumeInstruction =
          `Sub-agent "${subTitle}" has completed. Review the [SUBAGENT RESULT] injected above and continue the parent task.`;
        const parentTask = parentTaskId ? loadTask(parentTaskId) : null;
        const childChannel = parentTask?.channel || inferTaskChannelFromSession(sessionId);

        // Create the child TaskRecord
        const childTask = createTask({
          title: subTitle,
          prompt: subPrompt,
          sessionId: `task_${crypto.randomUUID()}`,
          channel: childChannel,
          plan: [{ index: 0, description: subPrompt.slice(0, 120), status: 'pending' as const }],
          parentTaskId,
          subagentProfile: profile,
          onResumeInstruction,
        });

        // Register child in parent and flip parent to waiting_subagent
        if (parentTaskId) {
          if (parentTask) {
            parentTask.pendingSubagentIds = [...(parentTask.pendingSubagentIds || []), childTask.id];
            parentTask.status = 'waiting_subagent';
            saveTask(parentTask);
          }
        }

        // Spawn the child BackgroundTaskRunner
        const childRunner = new BackgroundTaskRunner(
          childTask.id,
          handleChat,
          deps.makeBroadcastForTask(childTask.id),
          deps.telegramChannel,
        );
        childRunner.start().catch((err: Error) =>
          console.error(`[SubagentSpawn] Child ${childTask.id} error:`, err.message)
        );

        const ackMsg = toolName === 'subagent_spawn'
          ? `Spawned sub-agent "${subTitle}" (ID: ${childTask.id}, profile: ${profile}). Parent task is paused pending completion.`
          : `Delegated to ${profile} specialist (ID: ${childTask.id}). Parent task is paused until specialist completes.`;

        console.log(`[SubagentSpawn] ${ackMsg}`);
        appendJournal(parentTaskId || childTask.id, { type: 'status_push', content: ackMsg });
        broadcastWS({ type: 'task_subagent_spawned', parentTaskId, childTaskId: childTask.id, subTitle, profile });

        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: ackMsg,
        });
        // Break out of the tool loop — parent task status is now waiting_subagent,
        // which the BackgroundTaskRunner will detect on its next iteration.
        break;
      }

      // ── Orchestration: explicit request from primary
      if (toolName === 'request_secondary_assist') {
        const orchCfg = getOrchestrationConfig();
        if (orchestrationSkillEnabled && orchCfg?.enabled) {
          if (orchestrationStats.assistCount >= orchCfg.limits.max_assists_per_session) {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: `Secondary advisor session cap reached (${orchCfg.limits.max_assists_per_session}). Continue without escalation.`,
            });
            continue;
          }

          const mode   = (toolArgs.mode || 'rescue') as 'planner' | 'rescue';
          const reason = toolArgs.reason || 'Explicitly requested by executor';
          sendSSE('info', { message: `Consulting secondary advisor (${mode} mode)...` });
          console.log(`[Orchestrator] Explicit trigger: ${reason}`);
          const advice = await callSecondaryAdvisor(
            message,
            orchestrationLog,
            reason,
            mode,
            undefined,
            buildSecondaryAssistContext(),
          );
          if (advice) {
            const hint = formatAdvisoryHint(advice);
            orchestrationState.markFired(round);
            const stats = recordOrchestrationEvent(
              sessionId,
              { trigger: 'explicit', reason, mode },
              orchCfg,
            );
            sendSSE('orchestration', {
              trigger: 'explicit',
              reason,
              mode,
              advice,
              assist_count: stats.assistCount,
              assist_cap: orchCfg.limits.max_assists_per_session,
            });
            console.log(
              `[Orchestrator] Explicit assist complete (${stats.assistCount}/${orchCfg.limits.max_assists_per_session})`,
            );
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: hint,
            });
          } else {
            messages.push({
              role: 'tool',
              tool_name: toolName,
              tool_call_id: toolCallId || undefined,
              content: 'Secondary advisor unavailable. Continue with your best judgment.',
            });
          }
          continue;
        }
        messages.push({
          role: 'tool',
          tool_name: toolName,
          tool_call_id: toolCallId || undefined,
          content: 'Multi-agent orchestration is not enabled.',
        });
        continue;
      }

      const toolResult = await deps.executeTool(toolName, toolArgs, workspacePath, sessionId, sendSSE);
      if (canReplayReadOnlyCall(toolName)) cachedReadOnlyToolResults.set(callKey, toolResult);
      allToolResults.push(toolResult);
      logToolCall(workspacePath, toolName, toolArgs, toolResult.result, toolResult.error);
      trackFileOpMutation(toolName, toolArgs, toolResult, 'primary');
      if (fileOpV2Active && toolResult.error) fileOpHadToolFailure = true;
      if (!toolResult.error) roundHadProgress = true;

      // ── Orchestration: track trigger state
      orchestrationState.recordToolResult(round, toolName, toolArgs, toolResult.error);
      orchestrationLog.push(
        toolResult.error
          ? `✗ ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}): ${toolResult.result.slice(0, 100)}`
          : `✓ ${toolName}(${JSON.stringify(toolArgs).slice(0, 60)}): ${toolResult.result.slice(0, 80)}`
      );

      console.log(toolResult.error ? `[v2] TOOL FAIL: ${toolResult.result.slice(0, 100)}` : `[v2] TOOL OK: ${toolResult.result.slice(0, 100)}`);
      sendSSE('tool_result', { action: toolName, result: toolResult.result.slice(0, 500), error: toolResult.error, stepNum: allToolResults.length });

      if (toolName === 'doc_write') {
        const docPreview = consumeLastDocPreview();
        if (docPreview && docPreview.sessionId === sessionId && docPreview.markdown) {
          sendSSE('doc_preview', {
            preview_id: docPreview.previewId,
            path: docPreview.path,
            markdown: docPreview.markdown,
            blocks: parseDocPreview(docPreview.markdown),
          });
        }
      }

      const goalReminder = `\n\n[GOAL REMINDER: Your task is still: "${message.slice(0, 120)}". Stay focused on this goal only.]`;
      // list_files returns entries sorted by size DESCENDING — the first entry
      // is the largest file. Tell a small model to answer directly instead of
      // reciting the whole list (which burns its output budget).
      const listFilesHint = toolName === 'list_files'
        ? `\n[list_files: the first line is a summary "[N files, total SIZE, updated DATE]". By default entries are sorted by size DESCENDING so the first entry is the largest file. Answer the user's question directly and concisely from the summary/first entries; do NOT recite the full list.]`
        : '';
      // ── Multi-agent browser interception ────────────────────────────────────
      // When orchestrator is active, LLM never sees raw snapshot/browser data.
      // Full data still flows to advisor via getBrowserAdvisorPacket().
      const isBrowserTool = isBrowserToolName(toolName);
      const isDesktopTool = isDesktopToolName(toolName);
      const toolMessageContent = (multiAgentActive && (isBrowserTool || isDesktopTool))
        ? (isBrowserTool ? buildBrowserAck(toolName, toolResult) : buildDesktopAck(toolName, toolResult))
        : toolResult.result;
      messages.push({
        role: 'tool',
        tool_name: toolName,
        tool_call_id: toolCallId || undefined,
        content: toolMessageContent + goalReminder + listFilesHint,
      });

      if (isBrowserTool && !toolResult.error) {
        browserForcedRetries = 0;
        if (toolName === 'browser_close') {
          browserContinuationPending = false;
          browserAdvisorRoute = null;
          browserAdvisorHintPreview = '';
          resetBrowserAdvisorCollection();
        }
      }
      if (isDesktopTool && !toolResult.error && toolName === 'desktop_screenshot') {
        desktopContinuationPending = false;
      }
      await maybeRunBrowserAdvisorPass(toolName, toolResult);
      await maybeRunDesktopAdvisorPass(toolName, toolResult);
    }

    // ── Orchestration: auto-trigger check after each round
    const orchCfg = getOrchestrationConfig();
    if (orchestrationSkillEnabled && orchCfg?.enabled && !isBootStartupTurn) {
      if (!roundHadProgress) orchestrationState.recordRoundNoProgress(round);
      const { fire, reason } = orchestrationState.shouldTrigger(
        orchCfg,
        round,
        Date.now(),
        orchestrationStats.assistCount,
      );
      if (fire && orchestrationStats.assistCount < orchCfg.limits.max_assists_per_session) {
        sendSSE('info', { message: `Auto-consulting advisor: ${reason}` });
        console.log(`[Orchestrator] Auto-trigger (${reason})`);
        const advice = await callSecondaryAdvisor(
          message,
          orchestrationLog,
          reason,
          'rescue',
          undefined,
          buildSecondaryAssistContext(),
        );
        if (advice) {
          const hint = formatAdvisoryHint(advice);
          orchestrationState.markFired(round);
          const stats = recordOrchestrationEvent(
            sessionId,
            { trigger: 'auto', reason, mode: 'rescue' },
            orchCfg,
          );
          sendSSE('orchestration', {
            trigger: 'auto',
            reason,
            mode: 'rescue',
            advice,
            assist_count: stats.assistCount,
            assist_cap: orchCfg.limits.max_assists_per_session,
          });
          console.log(
            `[Orchestrator] Auto assist complete (${stats.assistCount}/${orchCfg.limits.max_assists_per_session})`,
          );
          messages.push({ role: 'user', content: hint });
          // NOTE: no pre-filled assistant ack (same mirroring bug as the
          // preempt path — the model repeats "Understood. Following the
          // advisor guidance now." as its whole answer). Let it respond.
        }
      }
    }

    sendSSE('info', { message: `Processing... (step ${round + 1})` });
  }

  return { type: 'execute', text: 'Hit max steps.', toolResults: allToolResults };
}
}