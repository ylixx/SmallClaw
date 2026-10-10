/**
 * image/index.ts
 *
 * Image tools:
 *  - image_render: HTML/CSS -> PNG through headless browser (Playwright / Edge).
 *                  Works fully offline; templates cover poster/slide/card/banner.
 *  - image_generate: optional OpenAI-compatible text-to-image endpoint
 *                  (only registered when image.generate.endpoint is configured).
 *
 * Both write their PNG into the workspace through the standard path guard.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { OfficeToolOutcome, OfficePathGuard } from '../office';

const RENDER_TIMEOUT_MS = 60000;
const GENERATE_TIMEOUT_MS = 180000;
const EDIT_TIMEOUT_MS = 120000;
const MAX_HTML_CHARS = 200000;
const MAX_PROMPT_CHARS = 4000;

export const IMAGE_RENDER_TEMPLATES = ['poster', 'slide', 'card', 'banner'] as const;
export type ImageRenderTemplate = (typeof IMAGE_RENDER_TEMPLATES)[number];

const SIZES: Record<string, [number, number]> = {
  poster: [1080, 1440],
  story: [1080, 1920],
  square: [1080, 1080],
  a4: [794, 1123],
  hd: [1280, 720],
  slide: [1600, 900],
  card: [800, 420],
  banner: [1200, 300],
};

let playwrightPromise: Promise<any | null> | null = null;
let renderChain: Promise<void> = Promise.resolve();

function loadPlaywright(): Promise<any | null> {
  if (!playwrightPromise) {
    playwrightPromise = (async () => {
      try {
        return await (Function('return import("playwright")')() as Promise<any>);
      } catch {
        return null;
      }
    })();
  }
  return playwrightPromise;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function asText(value: unknown): string {
  return String(value ?? '').trim();
}

function bulletsOf(args: any): string[] {
  const raw = args?.bullets ?? args?.items;
  if (Array.isArray(raw)) return raw.map(v => asText(v)).filter(Boolean).slice(0, 40);
  const body = asText(args?.body ?? args?.text);
  return body
    .split(/[\n\r]+/)
    .map(line => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 40);
}

function resolveSize(template: string, args: any): [number, number] {
  const w = Math.round(Number(args?.width));
  const h = Math.round(Number(args?.height));
  const sizeKey = asText(args?.size).toLowerCase();
  if (w >= 160 && w <= 4096 && h >= 160 && h <= 4096) return [w, h];
  if (sizeKey && SIZES[sizeKey]) return SIZES[sizeKey];
  return SIZES[template] || SIZES.poster;
}

function templateHtml(template: ImageRenderTemplate, args: any): string {
  const title = escapeHtml(asText(args?.title) || 'SmallClaw');
  const subtitle = escapeHtml(asText(args?.subtitle));
  const lines = bulletsOf(args).map(b => `<li>${escapeHtml(b)}</li>`).join('');
  const accent = escapeHtml(asText(args?.accent) || '#4f7cff');
  const theme = asText(args?.theme).toLowerCase();
  const dark = theme === 'dark';
  const fg = dark ? '#f5f7ff' : '#111527';
  const muted = dark ? 'rgba(245,247,255,.72)' : 'rgba(17,21,39,.66)';
  const bg = dark
    ? 'radial-gradient(120% 120% at 12% 0%, #1b2340 0%, #0b0e1a 62%)'
    : `radial-gradient(120% 120% at 12% 0%, ${accent}22 0%, #f7f9ff 58%)`;
  const bannerBg = dark
    ? 'linear-gradient(100deg,#0b0e1a,#1c2447)'
    : `linear-gradient(100deg,${accent},#7b5cff)`;
  const cardBg = dark
    ? 'linear-gradient(160deg,#171d33,#0f1424)'
    : 'linear-gradient(160deg,#ffffff,#f4f7ff)';
  const cardPageBg = dark ? '#0b0e1a' : '#eef2ff';
  const font = `'Microsoft YaHei','PingFang SC','Segoe UI',system-ui,sans-serif`;

  if (template === 'slide') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{width:100vw;height:100vh;font-family:${font};background:${bg};color:${fg};
        display:flex;flex-direction:column;justify-content:center;gap:34px;padding:96px 110px}
      .bar{width:96px;height:10px;border-radius:6px;background:${accent}}
      h1{font-size:76px;line-height:1.12;letter-spacing:-.5px;font-weight:800}
      .sub{font-size:32px;color:${muted};line-height:1.5}
      ul{display:flex;flex-direction:column;gap:18px;margin-top:8px}
      li{font-size:34px;line-height:1.5;color:${fg};padding-left:34px;position:relative}
      li::before{content:'';position:absolute;left:0;top:16px;width:14px;height:14px;border-radius:50%;background:${accent}}
      .foot{position:absolute;right:64px;bottom:44px;font-size:20px;color:${muted}}
    </style></head><body>
      <div class="bar"></div>
      <h1>${title}</h1>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
      ${lines ? `<ul>${lines}</ul>` : ''}
      <div class="foot">SmallClaw</div>
    </body></html>`;
  }

  if (template === 'card') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{width:100vw;height:100vh;font-family:${font};background:${cardPageBg};
        display:flex;align-items:center;justify-content:center;padding:48px}
      .card{width:100%;height:100%;border-radius:36px;padding:54px 58px;display:flex;flex-direction:column;
        justify-content:center;gap:22px;background:${cardBg};
        border:2px solid ${accent}44;box-shadow:0 30px 70px rgba(16,24,64,.18)}
      .tag{align-self:flex-start;font-size:20px;font-weight:700;letter-spacing:2px;color:${accent};
        background:${accent}1a;border:1px solid ${accent}55;border-radius:999px;padding:8px 20px}
      h1{font-size:56px;line-height:1.18;font-weight:800;color:${fg}}
      .sub{font-size:26px;color:${muted};line-height:1.55}
      ul{display:flex;flex-direction:column;gap:12px}
      li{font-size:26px;color:${fg};line-height:1.5;padding-left:28px;position:relative}
      li::before{content:'▸';position:absolute;left:0;color:${accent}}
    </style></head><body>
      <div class="card">
        <div class="tag">SMALLCLAW</div>
        <h1>${title}</h1>
        ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
        ${lines ? `<ul>${lines}</ul>` : ''}
      </div>
    </body></html>`;
  }

  if (template === 'banner') {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      body{width:100vw;height:100vh;font-family:${font};background:${bannerBg};
        color:#fff;display:flex;align-items:center;gap:44px;padding:0 72px}
      .dot{width:88px;height:88px;border-radius:28px;background:rgba(255,255,255,.18);
        border:2px solid rgba(255,255,255,.4);display:flex;align-items:center;justify-content:center;
        font-size:42px;font-weight:800}
      h1{font-size:60px;font-weight:800;line-height:1.15;letter-spacing:-.5px}
      .sub{font-size:26px;color:rgba(255,255,255,.86);margin-top:10px}
      .right{margin-left:auto;text-align:right;font-size:24px;color:rgba(255,255,255,.8);line-height:1.6}
    </style></head><body>
      <div class="dot">S</div>
      <div>
        <h1>${title}</h1>
        ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
      </div>
      ${lines ? `<div class="right">${bulletsOf(args).map(b => `<div>${escapeHtml(b)}</div>`).join('')}</div>` : ''}
    </body></html>`;
  }

  // poster (default)
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{width:100vw;height:100vh;font-family:${font};background:${bg};color:${fg};
      display:flex;flex-direction:column;justify-content:space-between;padding:88px 76px;position:relative}
    .top{display:flex;align-items:center;gap:18px}
    .logo{width:56px;height:56px;border-radius:16px;background:${accent};color:#fff;display:flex;
      align-items:center;justify-content:center;font-size:28px;font-weight:800}
    .brand{font-size:24px;font-weight:700;letter-spacing:3px;color:${muted}}
    h1{font-size:96px;line-height:1.08;font-weight:800;letter-spacing:-1.5px}
    .sub{font-size:34px;color:${muted};line-height:1.55;margin-top:28px;max-width:880px}
    ul{display:flex;flex-direction:column;gap:16px;margin-top:40px;max-width:880px}
    li{font-size:30px;line-height:1.5;padding-left:34px;position:relative}
    li::before{content:'';position:absolute;left:0;top:15px;width:14px;height:14px;border-radius:4px;background:${accent}}
    .rule{height:6px;width:160px;border-radius:4px;background:${accent};margin-top:40px}
    .foot{display:flex;justify-content:space-between;font-size:22px;color:${muted}}
  </style></head><body>
    <div class="top"><div class="logo">S</div><div class="brand">SMALLCLAW</div></div>
    <div>
      <div class="rule"></div>
      <h1>${title}</h1>
      ${subtitle ? `<div class="sub">${subtitle}</div>` : ''}
      ${lines ? `<ul>${lines}</ul>` : ''}
    </div>
    <div class="foot"><span>${escapeHtml(asText(args?.footer) || 'Generated locally')}</span><span>${new Date().toISOString().slice(0, 10)}</span></div>
  </body></html>`;
}

async function launchBrowser(pw: any): Promise<any> {
  const attempts: any[] = [
    { channel: 'msedge', headless: true },
    { channel: 'chrome', headless: true },
    { headless: true },
  ];
  let lastErr: any = null;
  for (const opts of attempts) {
    try {
      return await pw.chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('No browser available for image_render');
}

async function renderPng(html: string, width: number, height: number, outPath: string): Promise<void> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error('Playwright is not installed (npm install playwright). image_render needs a browser.');
  // One render at a time keeps memory bounded on small machines.
  const run = renderChain.then(async () => {
    let browser: any = null;
    try {
      browser = await launchBrowser(pw);
      const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: 'load', timeout: RENDER_TIMEOUT_MS / 2 });
      try {
        await page.evaluate(() => (globalThis as any).document?.fonts?.ready);
      } catch {
        // optional
      }
      await page.waitForTimeout(120);
      await page.screenshot({ path: outPath, type: 'png' });
    } finally {
      if (browser) {
        try { await browser.close(); } catch { /* ignore */ }
      }
    }
  });
  renderChain = run.then(() => undefined, () => undefined);
  await run;
}

function resolveDynamicPath(workspacePath: string, raw: unknown, guard?: OfficePathGuard):
  { ok: true; path: string } | { ok: false; error: string } {
  const name = asText(raw);
  if (!name.includes('\0')) {
    if (guard) {
      const guarded = guard(workspacePath, name);
      if (guarded && typeof guarded === 'object') return guarded;
    }
    return { ok: true, path: path.resolve(String(workspacePath || ''), name) };
  }
  return { ok: false, error: 'Invalid filename' };
}

async function executeImageRender(
  args: any,
  workspacePath: string,
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  const rawHtml = asText(args?.html);
  const template = (asText(args?.template) || 'poster').toLowerCase();
  if (!rawHtml && !(IMAGE_RENDER_TEMPLATES as readonly string[]).includes(template)) {
    return {
      result: `Unknown template "${template}". Use one of: ${IMAGE_RENDER_TEMPLATES.join(', ')} or pass html.`,
      error: true,
    };
  }
  if (rawHtml.length > MAX_HTML_CHARS) {
    return { result: `html is too long (${rawHtml.length} chars, limit ${MAX_HTML_CHARS})`, error: true };
  }
  const [width, height] = resolveSize(template, args);
  const html = rawHtml
    ? (/<html[\s>]/i.test(rawHtml) ? rawHtml : `<!doctype html><html><head><meta charset="utf-8"></head><body>${rawHtml}</body></html>`)
    : templateHtml(template as ImageRenderTemplate, args);

  const outRaw = asText(args?.out) || `image-${Date.now()}.png`;
  const outName = outRaw.toLowerCase().endsWith('.png') ? outRaw : `${outRaw}.png`;
  const resolved = resolveDynamicPath(workspacePath, outName, guard);
  if (!resolved.ok) return { result: resolved.error, error: true };

  try {
    await renderPng(html, width, height, resolved.path);
  } catch (err: any) {
    return { result: `image_render failed: ${err?.message || err}`, error: true };
  }
  let bytes = 0;
  try {
    bytes = fs.statSync(resolved.path).size;
  } catch {
    return { result: `image_render produced no file at ${resolved.path}`, error: true };
  }
  const lines = [
    '### 已渲染图片（Rendered image）',
    `- 文件 / file: \`${resolved.path}\` (${(bytes / 1024).toFixed(1)} KB)`,
    `- 尺寸 / size: ${width}x${height} (2x = ${width * 2}x${height * 2} px)`,
    `- 模板 / template: ${rawHtml ? 'custom html' : template}`,
    '',
    '将该 PNG 插入文档：doc_write ops [{op:"add_image", image:"' + path.basename(resolved.path) + '"}]，或用 doc_chart 的 embed 参数。',
  ];
  return { result: lines.join('\n'), error: false, paths: [resolved.path] };
}

function imageGenerateConfig(): { endpoint: string; apiKey: string; model: string; size: string } {
  try {
    const mod = require('../../config/config');
    const cfg: any = mod?.getConfig ? mod.getConfig().getConfig() : null;
    const gen = cfg?.image?.generate || {};
    return {
      endpoint: asText(gen.endpoint).replace(/\/+$/, ''),
      apiKey: asText(gen.api_key),
      model: asText(gen.model),
      size: asText(gen.size) || '1024x1024',
    };
  } catch {
    return { endpoint: '', apiKey: '', model: '', size: '1024x1024' };
  }
}

export function isImageGenerateConfigured(): boolean {  return Boolean(imageGenerateConfig().endpoint);
}

// ─── image_edit (PIL, fully offline) ──────────────────────────────────────────

let editPython: string | null | undefined;
let editHelper: string | null | undefined;

async function findEditPython(): Promise<string | null> {
  if (editPython !== undefined && editPython !== null) return editPython;
  const candidates = [
    process.env.SMALLCLAW_PYTHON,
    'python',
    'py',
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const res = await new Promise<boolean>((resolve) => {
        const p = spawn(c, ['-c', 'import PIL, sys; print(sys.version.split()[0])'], { windowsHide: true });
        let ok = false;
        p.on('close', (code) => { ok = code === 0; resolve(ok); });
        p.on('error', () => resolve(false));
      });
      if (res) { editPython = c; return c; }
    } catch { /* try next */ }
  }
  editPython = null;
  return null;
}

function resolveEditHelper(): string | null {
  if (editHelper) return editHelper;
  const here = __dirname;
  const candidates = [
    path.join(here, 'image_edit.py'),
    path.join(here, '..', '..', '..', 'src', 'tools', 'image', 'image_edit.py'),
    path.join(process.cwd(), 'src', 'tools', 'image', 'image_edit.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { editHelper = c; return c; }
  }
  return null;
}

function runImageEdit(payload: Record<string, any>): Promise<OfficeToolOutcome> {
  return new Promise(async (resolve) => {
    const helper = resolveEditHelper();
    if (!helper) return resolve({ result: 'image_edit helper not found (image_edit.py)', error: true });
    const python = await findEditPython();
    if (!python) {
      return resolve({ result: 'Python with Pillow not found. Set SMALLCLAW_PYTHON or install Pillow.', error: true });
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(python, ['-X', 'utf8', helper], { windowsHide: true });
    } catch (err) {
      return resolve({ result: `image_edit spawn failed: ${(err as Error)?.message || err}`, error: true });
    }
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => (out += c));
    child.stderr?.on('data', (c) => (err += c));
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
    }, EDIT_TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); resolve({ result: `image_edit failed: ${e.message}`, error: true }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        if (parsed?.ok) return resolve({ result: JSON.stringify(parsed.data, null, 2), error: false });
        const detail = parsed?.detail ? `\n${parsed.detail}` : '';
        return resolve({ result: `${parsed?.error || 'image_edit failed'}${detail}`, error: true });
      } catch {
        return resolve({ result: `image_edit returned invalid output (exit ${code}). stderr: ${err.slice(0, 300)}`, error: true });
      }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

async function executeImageEdit(
  args: any,
  workspacePath: string,
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  const action = asText(args?.action);
  if (!['cutout', 'compress', 'watermark'].includes(action)) {
    return { result: `image_edit action must be one of: cutout, compress, watermark (got "${action}")`, error: true };
  }
  const src = asText(args?.filename || args?.path || args?.image);
  if (!src) return { result: 'filename is required (image path to edit)', error: true };
  const resolved = resolveDynamicPath(workspacePath, src, guard);
  if (!resolved.ok) return { result: resolved.error, error: true };
  if (!fs.existsSync(resolved.path)) return { result: `source image not found: ${src}`, error: true };

  const outName = asText(args?.out);
  const payload: Record<string, any> = { action, path: resolved.path };
  if (outName) {
    const ro = resolveDynamicPath(workspacePath, outName, guard);
    if (!ro.ok) return { result: ro.error, error: true };
    payload.out = ro.path;
  }
  for (const k of ['color', 'threshold', 'trim', 'quality', 'target_kb', 'max_dim', 'text', 'image', 'opacity', 'position', 'size', 'max_width', 'color']) {
    if (args?.[k] !== undefined && args?.[k] !== null && args?.[k] !== '') payload[k] = args[k];
  }
  return runImageEdit(payload);
}

async function executeImageGenerate(
  args: any,
  workspacePath: string,
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  const cfg = imageGenerateConfig();
  if (!cfg.endpoint) {
    return {
      result: 'image_generate is not configured. Set image.generate.endpoint in .smallclaw/config.json (OpenAI-compatible /v1 endpoint), or use image_render to build images from HTML/CSS (works offline).',
      error: true,
    };
  }
  const prompt = asText(args?.prompt);
  if (!prompt) return { result: 'prompt is required', error: true };
  if (prompt.length > MAX_PROMPT_CHARS) return { result: `prompt too long (limit ${MAX_PROMPT_CHARS})`, error: true };
  const size = asText(args?.size) || cfg.size;
  if (!/^\d{2,4}x\d{2,4}$/.test(size)) return { result: `size must look like "1024x1024" (got "${size}")`, error: true };

  const outName = asText(args?.out) || `gen-${Date.now()}.png`;
  const resolved = resolveDynamicPath(workspacePath, outName, guard);
  if (!resolved.ok) return { result: resolved.error, error: true };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const body: Record<string, any> = {
    model: cfg.model || undefined,
    prompt,
    n: 1,
    size,
    response_format: 'b64_json',
  };

  let resp: Response;
  try {
    resp = await fetch(`${cfg.endpoint}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });
  } catch (err: any) {
    return { result: `image_generate request failed: ${err?.message || err}`, error: true };
  }
  if (!resp.ok) {
    const text = (await resp.text().catch(() => '')).slice(0, 500);
    return { result: `image_generate HTTP ${resp.status}: ${text}`, error: true };
  }
  let json: any;
  try {
    json = await resp.json();
  } catch (err: any) {
    return { result: `image_generate returned invalid JSON: ${err?.message || err}`, error: true };
  }
  const item = Array.isArray(json?.data) ? json.data[0] : null;
  try {
    if (item?.b64_json) {
      fs.writeFileSync(resolved.path, Buffer.from(String(item.b64_json), 'base64'));
    } else if (item?.url) {
      const img = await fetch(String(item.url), { signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS) });
      if (!img.ok) return { result: `image_generate could not download result (HTTP ${img.status})`, error: true };
      const buf = Buffer.from(await img.arrayBuffer());
      fs.writeFileSync(resolved.path, buf);
    } else {
      return { result: `image_generate returned no image data: ${JSON.stringify(json).slice(0, 300)}`, error: true };
    }
  } catch (err: any) {
    return { result: `image_generate could not save the image: ${err?.message || err}`, error: true };
  }
  const bytes = fs.statSync(resolved.path).size;
  return {
    result: [
      '### 已生成图片（Generated image）',
      `- 文件 / file: \`${resolved.path}\` (${(bytes / 1024).toFixed(1)} KB)`,
      `- 尺寸 / size: ${size}`,
      `- 模型 / model: ${cfg.model || 'endpoint default'}`,
    ].join('\n'),
    error: false,
  };
}

export function getImageToolDefinitions(): any[] {
  const defs: any[] = [
    {
      type: 'function',
      function: {
        name: 'image_render',
        description:
          'Render a PNG image from HTML/CSS via headless browser (offline, fast). Pick a template with title/subtitle/bullets, or pass complete html for full control. Use for 海报、封面、卡片、banner、配图、社交媒体图、幻灯片封面.',
        parameters: {
          type: 'object',
          required: [],
          properties: {
            template: {
              type: 'string',
              enum: [...IMAGE_RENDER_TEMPLATES],
              description: 'Layout template (default poster): poster, slide (16:9), card, banner.',
            },
            title: { type: 'string', description: 'Main headline.' },
            subtitle: { type: 'string', description: 'Supporting line under the title.' },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Up to 30 bullet lines.' },
            body: { type: 'string', description: 'Alternative to bullets: one line per item.' },
            accent: { type: 'string', description: 'Accent color, e.g. #4f7cff.' },
            theme: { type: 'string', enum: ['light', 'dark'], description: 'Color scheme (default light).' },
            size: { type: 'string', description: 'Named size: poster, story, square, a4, hd, slide, card, banner.' },
            width: { type: 'number', description: 'Custom width px (160-4096), overrides size.' },
            height: { type: 'number', description: 'Custom height px (160-4096), overrides size.' },
            html: { type: 'string', description: 'Complete HTML/CSS to render instead of a template.' },
            out: { type: 'string', description: 'Output PNG path in the workspace (default image-<time>.png).' },
          },
        },
      },
    },
  ];
  if (isImageGenerateConfigured()) {
    defs.push({
      type: 'function',
      function: {
        name: 'image_generate',
        description: 'Generate an image from a text prompt with a configured local/remote image model (AI绘图). Prefer image_render for diagrams/posters with exact text copy.',
        parameters: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string', description: 'What to generate, describe style and composition.' },
            size: { type: 'string', description: 'e.g. 1024x1024, 1792x1024, 1024x1792.' },
            out: { type: 'string', description: 'Output PNG path in the workspace.' },
          },
        },
      },
    });
  }
  defs.push({
    type: 'function',
    function: {
      name: 'image_edit',
      description:
        'Edit an image locally with Pillow (offline): cutout (remove a solid/near-uniform background -> transparent PNG), compress (reduce file size via quality / target_kb / max_dim), watermark (overlay text or an image watermark). Use for 抠图/去背景、图片压缩、加水印.',
      parameters: {
        type: 'object',
        required: ['action', 'filename'],
        properties: {
          action: {
            type: 'string',
            enum: ['cutout', 'compress', 'watermark'],
            description: 'cutout = remove background to transparent PNG; compress = reduce size; watermark = overlay text/image.',
          },
          filename: { type: 'string', description: 'Path of the image to edit (in the workspace).' },
          out: { type: 'string', description: 'Output path (default: <name>_cutout.png / _compressed.jpg / _watermarked.png).' },
          color: { type: 'string', description: 'cutout: background color to remove, e.g. "ffffff" (default = auto-detect from corners/edges).' },
          threshold: { type: 'number', description: 'cutout: color-distance tolerance 0-200 (default 40). Higher removes more.' },
          trim: { type: 'boolean', description: 'cutout: crop to content bounding box after removal.' },
          quality: { type: 'number', description: 'compress: JPEG/WebP quality 20-95 (default 80).' },
          target_kb: { type: 'number', description: 'compress: target file size in KB; auto-finds best quality.' },
          max_dim: { type: 'number', description: 'compress: downscale so max side is this many px.' },
          text: { type: 'string', description: 'watermark: watermark text (one of text/image required).' },
          image: { type: 'string', description: 'watermark: path to a watermark image instead of text.' },
          opacity: { type: 'number', description: 'watermark: opacity 0.0-1.0 (default 0.35).' },
          position: {
            type: 'string',
            description: 'watermark: top-left/top-right/bottom-left/bottom-right/center (default bottom-right).',
          },
          size: { type: 'number', description: 'watermark: font size in px (default auto).' },
          max_width: { type: 'number', description: 'watermark(image): max width as fraction of source (default 0.3).' },
        },
      },
    },
  });
  return defs;
}

export async function executeImageTool(
  name: string,
  args: any,
  workspacePath: string,
  _sessionId: string = 'default',
  guard?: OfficePathGuard,
): Promise<OfficeToolOutcome> {
  if (name === 'image_render') return executeImageRender(args, workspacePath, guard);
  if (name === 'image_generate') return executeImageGenerate(args, workspacePath, guard);
  if (name === 'image_edit') return executeImageEdit(args, workspacePath, guard);
  return { result: `Unknown image tool: ${name}`, error: true };
}
