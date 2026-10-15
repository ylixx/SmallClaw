/**
 * browser — 动词式网页自动化工具（本地小模型友好）
 *
 * 设计要点：
 * - 一组「动词」而非让模型写代码：goto / click / type / extract_text /
 *   extract_links / screenshot / wait / back / close。复杂度吞在工具里，
 *   小模型只做选择，比 QwenPaw 的 browser(code)（要模型写 SDK）友好得多。
 * - 懒加载 playwright（仅首次使用时 import），避免拖慢启动；chromium 二进制
 *   缺失时返回明确安装指引（优雅降级，不崩溃）。
 * - 长驻 browser/context/page 复用；空闲超时自动关闭，防泄漏。
 * - extract/screenshot 输出截断；截图路径走 isPathAllowed（workspace 边界）。
 */

import fsSync from 'fs';
import path from 'path';
import { getConfig } from '../config/config.js';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

type BrowserAction =
  | 'goto' | 'click' | 'type' | 'extract_text' | 'extract_links'
  | 'screenshot' | 'wait' | 'back' | 'close';

interface BrowserArgs {
  action: BrowserAction;
  url?: string;
  selector?: string;
  text?: string;
  path?: string;
  timeout_ms?: number;
  full_page?: boolean;
}

const EXTRACT_MAX_CHARS = 6000;
const LINKS_MAX = 60;
const DEFAULT_ACTION_TIMEOUT = 15000;
const IDLE_CLOSE_MS = 5 * 60 * 1000; // 5 分钟空闲自动关闭

// 长驻浏览器状态（进程内单例）
interface BrowserState {
  browser: any;
  context: any;
  page: any;
  lastUsed: number;
}
let state: BrowserState | null = null;
let idleTimer: NodeJS.Timeout | null = null;

function workspacePath(): string {
  return getConfig().getConfig().workspace.path;
}

function resolveOut(p: string): string {
  return path.isAbsolute(p) ? p : path.join(workspacePath(), p);
}

function armIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { void closeBrowser(); }, IDLE_CLOSE_MS);
  // 不阻塞进程退出
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function closeBrowser(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const s = state;
  state = null;
  if (!s) return;
  try { await s.browser?.close(); } catch { /* ignore */ }
}

async function ensureBrowser(): Promise<{ ok: true; page: any } | { ok: false; error: string }> {
  if (state?.page) {
    state.lastUsed = Date.now();
    armIdleTimer();
    return { ok: true, page: state.page };
  }
  let chromium: any;
  try {
    // 懒加载：仅在真正用时加载 playwright
    ({ chromium } = await import('playwright'));
  } catch (err: any) {
    return { ok: false, error: `playwright 加载失败: ${err?.message || err}` };
  }
  let browser: any;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/Executable doesn'?t exist|browserType.launch|download|install/i.test(msg)) {
      return {
        ok: false,
        error:
          `chromium 未安装或启动失败: ${msg}\n` +
          `请先安装浏览器二进制：在项目根目录运行  npx playwright install chromium  （约 150MB，一次性）`,
      };
    }
    return { ok: false, error: `chromium 启动失败: ${msg}` };
  }
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT);
  state = { browser, context, page, lastUsed: Date.now() };
  armIdleTimer();
  return { ok: true, page };
}

export async function executeBrowser(args: BrowserArgs): Promise<ToolResult> {
  const action = String(args?.action || '').trim();
  const valid: BrowserAction[] = ['goto', 'click', 'type', 'extract_text', 'extract_links', 'screenshot', 'wait', 'back', 'close'];
  if (!valid.includes(action as BrowserAction)) {
    return { success: false, error: `action 必须是: ${valid.join(' / ')}` };
  }

  if (action === 'close') {
    await closeBrowser();
    return { success: true, stdout: '浏览器已关闭' };
  }

  // 纯参数预校验（在启动浏览器之前，避免被 chromium 启动报错盖过）
  if (action === 'goto') {
    const url = String(args?.url || '').trim();
    if (!url) return { success: false, error: 'goto 需要 url' };
    if (!/^https?:\/\//i.test(url)) return { success: false, error: `url 必须以 http(s):// 开头: ${url}` };
  }
  if (action === 'click' && !String(args?.selector || '').trim()) {
    return { success: false, error: 'click 需要 selector' };
  }
  if (action === 'type' && !String(args?.selector || '').trim()) {
    return { success: false, error: 'type 需要 selector' };
  }
  let screenshotOut = '';
  if (action === 'screenshot') {
    screenshotOut = resolveOut(String(args?.path || '').trim() || `screenshots/browser-${Date.now()}.png`);
    const check = isPathAllowed(screenshotOut);
    if (!check.allowed) return { success: false, error: check.reason };
  }

  const ensured = await ensureBrowser();
  if (!ensured.ok) return { success: false, error: ensured.error };
  const page = ensured.page;
  const timeout = Math.min(Math.max(Number(args?.timeout_ms ?? DEFAULT_ACTION_TIMEOUT) || DEFAULT_ACTION_TIMEOUT, 1000), 60000);

  try {
    switch (action) {
      case 'goto': {
        const url = String(args?.url || '').trim();
        const resp = await page.goto(url, { timeout, waitUntil: 'domcontentloaded' });
        const title = await page.title().catch(() => '');
        return {
          success: true,
          stdout: `已打开: ${page.url()}\n标题: ${title || '(无)'}${resp ? `\n状态: ${resp.status()}` : ''}`,
          data: { url: page.url(), title, status: resp ? resp.status() : null },
        };
      }
      case 'click': {
        const sel = String(args?.selector || '').trim();
        await page.click(sel, { timeout });
        return { success: true, stdout: `已点击: ${sel}` };
      }
      case 'type': {
        const sel = String(args?.selector || '').trim();
        const text = String(args?.text ?? '');
        await page.fill(sel, text, { timeout });
        return { success: true, stdout: `已在 ${sel} 填入 ${text.length} 字符` };
      }
      case 'extract_text': {
        const sel = String(args?.selector || '').trim() || 'body';
        const text = await page.innerText(sel, { timeout }).catch((e: any) => { throw e; });
        const trimmed = String(text || '').replace(/\n{3,}/g, '\n\n');
        const out = trimmed.length > EXTRACT_MAX_CHARS
          ? `${trimmed.slice(0, EXTRACT_MAX_CHARS)}\n...[文本过长已截断，共 ${trimmed.length} 字符，可用更具体的 selector]`
          : trimmed;
        return {
          success: true,
          stdout: out || '(无文本)',
          data: { url: page.url(), chars: trimmed.length, truncated: trimmed.length > EXTRACT_MAX_CHARS },
        };
      }
      case 'extract_links': {
        const links = await page.$$eval('a[href]', (els: any[]) =>
          els.map((e) => ({ text: (e.innerText || '').trim().slice(0, 80), href: e.href }))
        ).catch(() => [] as Array<{ text: string; href: string }>);
        const seen = new Set<string>();
        const uniq: Array<{ text: string; href: string }> = [];
        for (const l of links) {
          if (!l.href || seen.has(l.href)) continue;
          seen.add(l.href);
          uniq.push(l);
          if (uniq.length >= LINKS_MAX) break;
        }
        const out = uniq.map((l, i) => `${i + 1}. ${l.text || '(无文字)'} -> ${l.href}`).join('\n');
        return {
          success: true,
          stdout: out || '(无链接)',
          data: { url: page.url(), count: uniq.length, links: uniq },
        };
      }
      case 'screenshot': {
        const outPath = screenshotOut;
        fsSync.mkdirSync(path.dirname(outPath), { recursive: true });
        await page.screenshot({ path: outPath, fullPage: args?.full_page === true });
        const size = fsSync.existsSync(outPath) ? fsSync.statSync(outPath).size : 0;
        return {
          success: true,
          stdout: `截图已保存: ${outPath} (${size}B)${args?.full_page ? ' [整页]' : ''}`,
          data: { path: outPath, size },
        };
      }
      case 'wait': {
        const sel = String(args?.selector || '').trim();
        if (sel) {
          await page.waitForSelector(sel, { timeout });
          return { success: true, stdout: `元素已出现: ${sel}` };
        }
        await page.waitForTimeout(timeout);
        return { success: true, stdout: `已等待 ${timeout}ms` };
      }
      case 'back': {
        await page.goBack({ timeout }).catch(() => {});
        return { success: true, stdout: `已返回: ${page.url()}` };
      }
      default:
        return { success: false, error: `未实现的 action: ${action}` };
    }
  } catch (err: any) {
    const msg = String(err?.message || err);
    // 常见小模型可自纠的错，给出明确提示
    let hint = '';
    if (/Timeout|timeout/i.test(msg)) hint = '（超时：页面慢或选择器不对，可加大 timeout_ms 或检查 selector）';
    else if (/selector|not found|waiting for/i.test(msg)) hint = `（选择器未命中：${args?.selector || ''}，可先 extract_text/extract_links 看页面结构）`;
    return { success: false, error: `browser ${action} 失败: ${msg}${hint}` };
  }
}

export const browserTool = {
  name: 'browser',
  description:
    'Web automation via a small set of verbs (local-model friendly). Actions: goto(url), click(selector), type(selector,text), extract_text(selector?), extract_links, screenshot(path?,full_page?), wait(ms|selector), back, close. One action per call. Reuses a persistent headless Chromium page. If Chromium is missing it returns install guidance (npx playwright install chromium).',
  execute: executeBrowser,
  schema: {
    action: 'string (required) - goto | click | type | extract_text | extract_links | screenshot | wait | back | close',
    url: 'string (goto) - http(s) URL to open',
    selector: 'string (click/type/extract_text/wait) - CSS selector',
    text: 'string (type) - text to fill',
    path: 'string (screenshot) - output png path (default screenshots/browser-<ts>.png)',
    full_page: 'boolean (screenshot) - capture full page',
    timeout_ms: 'number (optional, 1000-60000) - per-action timeout',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['goto', 'click', 'type', 'extract_text', 'extract_links', 'screenshot', 'wait', 'back', 'close'], description: 'browser verb' },
      url: { type: 'string', description: 'http(s) URL to open (goto)' },
      selector: { type: 'string', description: 'CSS selector (click/type/extract_text/wait)' },
      text: { type: 'string', description: 'text to fill (type)' },
      path: { type: 'string', description: 'screenshot output png path' },
      full_page: { type: 'boolean', description: 'screenshot: capture full page' },
      timeout_ms: { type: 'number', description: 'per-action timeout in ms (1000-60000)' },
    },
    required: ['action'],
    additionalProperties: false,
  },
};
