/** personality-context.ts — workspace memory loader + tiered prompt
 * (buildPersonalityContext) extracted from server-v2.ts (Phase 5d-14).
 * Pure helpers; deps are imports only (fs/path/hookBus/tool-registry). */
import fs from 'fs';
import path from 'path';
import { hookBus } from './hooks';
import { detectToolCategories } from './tool-registry';

// ─── Workspace Memory Loader ───────────────────────────────────────────────────

function loadWorkspaceFile(workspacePath: string, filename: string, maxChars: number = 500): string {
  try {
    const filePath = path.join(workspacePath, filename);
    if (!fs.existsSync(filePath)) return '';
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (content.length <= maxChars) return content;
    return content.slice(0, maxChars) + '\n...(truncated)';
  } catch { return ''; }
}

// ─── Tiered Prompt System ─────────────────────────────────────────────────────


// Tool rule blocks — compact, injected only when relevant
// User message signals "I want to recall past conversations" → only then inject
// [RECENT_CONVERSATIONS]. Without this gate the daily-log tail leaked into
// every prompt and the model answered current questions with old memory topics.
// The pattern must cover natural phrasing: "生成最近聊天记录报告" failed the
// first version (matched 昨天/对话记录 only) and the model started guessing
// file names instead of reading memory/*.md.
const MEMORY_RECALL_RE = /(上次|昨天|前天|之前|以前|刚才|还记得|回忆|最后一次|最近一次|最近聊|聊天记录|对话记录|历史对话|前两天|这两天|这几天|上次会话|上次聊|我们聊过|我们说过|聊过什么|我们谈了|之前说的)/i;

const TOOL_BLOCKS: Record<string, string> = {
  web: `WEB TOOLS: web_search(query) → headlines+snippets. web_fetch(url) → full page text. Use web_search first to get URLs, then web_fetch to read. For Reddit: web_search with site:reddit.com "keyword", then web_fetch post URLs — never open browser for Reddit.`,

  browser: `BROWSER TOOLS: browser_open(url) → opens+returns snapshot. browser_snapshot() → refresh elements. browser_click(ref) → click by @ref. browser_fill(ref,text) → fill input. browser_press_key(key) → Enter/Tab/Escape. browser_wait(ms) → wait then snapshot. browser_close() → close tab. Chrome profile is persistent — already logged into sites. SNAPSHOT RULE: browser_open, browser_fill, browser_wait, and browser_click ALL return a fresh snapshot automatically — do NOT call browser_snapshot immediately after any of them. Only call browser_snapshot when you have NOT received a snapshot recently. Calling browser_snapshot twice in a row or after any tool that already returned one is a loop bug — act on the existing snapshot instead. SCROLL RULE: Do NOT scroll/PageDown on an interactive page before reading its snapshot — the compose area and action buttons are visible without scrolling. Read the snapshot refs and act. POST/TWEET RULE: After filling a tweet/post composer, the fill result will show "⚠️ COMPOSER SUBMIT BUTTON: @N" — you MUST click that exact @N ref immediately as your very next action. Do NOT click any other ref, do NOT snapshot, do NOT wait. If no COMPOSER SUBMIT BUTTON annotation appears, find the button named "Post" or "Tweet" that is visually inside the composer area and click it. Filling the textarea alone is NOT completion. After clicking Post, snapshot to verify it was published.`,

  desktop: `DESKTOP TOOLS: desktop_screenshot() → capture+OCR. desktop_find_window(name) → find window. desktop_focus_window(name) → bring to front (use SHORT process name: msedge, chrome, code). desktop_click(x,y) → click coords. desktop_type(text) → type. desktop_press_key(key) → key combo. desktop_drag(x1,y1,x2,y2) → drag. desktop_get_clipboard()/set_clipboard(text). Always screenshot first. Focus window before click/type. Fail twice on focus → stop and report.`,

  files: `FILE TOOLS: read_file(filename) → contents with line numbers. Always read before editing. replace_lines(filename,start,end,content) → surgical edit. insert_after(filename,line,content) → insert. delete_lines(filename,start,end) → delete. find_replace(filename,find,replace) → exact text swap. create_file(filename,content) → new only (fails if exists). delete_file(filename). RULES: read first, surgical edits only, never rewrite whole file for partial changes.`,

  task: `TASK TOOLS: task_control(action,...)  actions: list/get/resume/rerun/pause/delete. start_task(title,prompt) → launch new background task. Check for existing tasks first before creating — never duplicate. Do NOT use read_file to check task state.`,

  schedule: `SCHEDULE TOOL: schedule_job(action,...) actions: list/create/update/pause/resume/delete/run_now. Always confirm before create/update/delete. Keep schedule timing separate from instruction_prompt content.`,

  shell: `SHELL TOOL: run_command(command) → opens app for user to see (chrome, notepad, vscode, word/winword). To open a document with its default program: start <file>. For web automation use browser_* not run_command. For desktop interaction use desktop_* not run_command.`,

  memory: `MEMORY TOOLS: memory_browse(file) → list categories in user.md or soul.md. memory_write(file,category,content) → add/update a fact (creates category if new). memory_read(file) → full file contents. File is "user" or "soul". Browse first to find the right category. Write immediately when you learn something — don't wait.`,

  debug: `DEBUG: If asked about errors or architecture, use read_source(file) to inspect SmallClaw source. SELF.md has architecture overview. Workspace files: IDENTITY.md, SOUL.md, USER.md, TOOLS.md, SELF.md. Read the relevant one before diagnosing.`,
};

// Read memory categories for a specific file (for category-aware injection)
function readMemorySnippets(workspacePath: string, categories: string[]): string {
  if (categories.length === 0) return '';
  const snippets: string[] = [];
  for (const file of ['USER.md', 'SOUL.md']) {
    const filePath = path.join(workspacePath, file);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    let inSection = false;
    let currentSection = '';
    const sectionLines: string[] = [];
    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)/);
      if (headingMatch) {
        if (inSection && sectionLines.length > 0) {
          snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
        }
        currentSection = headingMatch[1].trim();
        inSection = categories.some(cat => currentSection.toLowerCase().includes(cat.toLowerCase()) || cat.toLowerCase().includes(currentSection.toLowerCase()));
        sectionLines.length = 0;
      } else if (inSection && line.trim()) {
        sectionLines.push(line);
      }
    }
    if (inSection && sectionLines.length > 0) {
      snippets.push(`[${file}:${currentSection}]\n${sectionLines.join('\n')}`);
    }
  }
  return snippets.slice(0, 6).join('\n\n');
}

// Map tool categories to memory category keywords
const TOOL_TO_MEMORY_CATS: Record<string, string[]> = {
  web: ['web', 'research', 'search'],
  browser: ['browser', 'web'],
  files: ['files', 'coding', 'editing', 'development'],
  task: ['tasks', 'workflow'],
  schedule: ['schedule', 'automation'],
  shell: ['shell', 'commands'],
  memory: ['preferences', 'communication'],
};

export async function buildPersonalityContext(
  sessionId: string,
  workspacePath: string,
  messageText: string,
  executionMode: string,
  historyLength: number,
): Promise<string> {

  // ── Recent conversation recall ─────────────────────────────────────────────
  // Daily conversation logs live in memory/<date>.md (written by logToDaily
  // every turn) but were never injected, so the model had no idea what was
  // discussed on previous days or in other sessions — "the last conversation"
  // could not be located. Inject the tail of the most recent days so the model
  // can actually recall recent discussions. Tail-heavy: recent talk is what
  // matters for recall.
  // Recall is injected ONLY when the user actually asks about past
  // conversations: unconditional injection leaked yesterday's topics into the
  // current task (the model answered today's question with old memory content).
  const RECENT_CONV_DAYS = 2;
  const RECENT_CONV_TAIL_CHARS = 1400;
  const wantsRecall = MEMORY_RECALL_RE.test(messageText);
  const recentConversations: string[] = [];
  if (wantsRecall) {
    for (let i = RECENT_CONV_DAYS; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().split('T')[0];
      const p = path.join(workspacePath, 'memory', `${d}.md`);
      try {
        if (!fs.existsSync(p)) continue;
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (!content) continue;
        const tail = content.slice(-RECENT_CONV_TAIL_CHARS);
        recentConversations.push(`[${d} 对话记录]\n${tail}`);
      } catch { /* missing/unreadable daily log is not fatal */ }
    }
  }
  const recentConvBlock = recentConversations.length > 0
    ? `\n\n[RECENT_CONVERSATIONS — 以下是历史对话记录（仅尾部摘要），仅供回忆"上次/最后一次对话/最近聊天记录"等提问；它们不是当前任务的事实，回答当前问题以最近的用户消息为准。如需完整记录，可用 read_file 读取 memory/ 目录下的 <日期>.md 文件（如 memory/2026-10-05.md）]\n${recentConversations.join('\n\n')}`
    : '';

  // ── Path B: autonomous execution — full prompt, no changes ─────────────────
  const isAutonomous = executionMode === 'background_task' || executionMode === 'cron' || executionMode === 'heartbeat';
  if (isAutonomous) {
    const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
    const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 800);
    const user = loadWorkspaceFile(workspacePath, 'USER.md', 600);
    const today = new Date().toISOString().split('T')[0];
    const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
    const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      soul ? `[SOUL]\n${soul}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
      recentConvBlock || '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Path A: interactive chat — tiered ─────────────────────────────────────
  const identity = loadWorkspaceFile(workspacePath, 'IDENTITY.md', 400);
  const user = loadWorkspaceFile(workspacePath, 'USER.md', 500);
  const today = new Date().toISOString().split('T')[0];
  const intradayPath = path.join(workspacePath, 'memory', `${today}-intraday-notes.md`);
  const intradayNotes = fs.existsSync(intradayPath) ? fs.readFileSync(intradayPath, 'utf-8').trim().slice(-600) : '';

  // ── Tier 1: first message in session ──────────────────────────────────────
  if (historyLength === 0) {
    const parts = [
      identity ? `[IDENTITY]\n${identity}` : '',
      user ? `[USER]\n${user}` : '',
      intradayNotes ? `[TODAY_NOTES]\n${intradayNotes}` : '',
      recentConvBlock || '',
    ].filter(Boolean);
    await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
    return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
  }

  // ── Tier 2 / 3: subsequent messages — detect intent ───────────────────────
  const cats = detectToolCategories(messageText);
  // SOUL was already fully injected on the session's first message; on later
  // messages a trimmed excerpt is enough to keep the personality hint without
  // paying the full cost on every turn.
  const soul = loadWorkspaceFile(workspacePath, 'SOUL.md', 250);

  // Build tool blocks for detected categories
  const toolBlockParts: string[] = [];
  for (const cat of cats) {
    if (TOOL_BLOCKS[cat]) toolBlockParts.push(TOOL_BLOCKS[cat]);
  }

  // Build memory snippets for categories related to detected tool groups.
  // Inject only when the message signals that domain; cap the size; mark the
  // block background-only so unrelated memory never steers the current task.
  const memoryCategoryKeywords: string[] = [];
  for (const cat of cats) {
    const memCats = TOOL_TO_MEMORY_CATS[cat] || [];
    memoryCategoryKeywords.push(...memCats);
  }
  const rawMemorySnippets = memoryCategoryKeywords.length > 0
    ? readMemorySnippets(workspacePath, memoryCategoryKeywords)
    : '';
  const memorySnippets = rawMemorySnippets.length > 1500 ? rawMemorySnippets.slice(0, 1500) : rawMemorySnippets;
  const memoryBlock = memorySnippets
    ? `[RELEVANT_MEMORY — 相关背景记忆，仅供背景参考；与当前任务无关时请忽略，不要据此编造事实]\n${memorySnippets}`
    : '';
  console.log(`[v2] memory injection: cats=${Array.from(cats).join(',')} snippets=${memorySnippets.length} chars`);

  // Tier 3: complex/multi-domain — add tools.md hint
  const isComplex = cats.size >= 3 || /\b(how do i|help me|can you|i need to|i want to)\b/i.test(messageText);
  const toolsHint = isComplex ? `\nFor full tool reference: read_file TOOLS.md` : '';

  // Self.md for debug
  const self = cats.has('debug') ? loadWorkspaceFile(workspacePath, 'SELF.md', 600) : '';

  const parts = [
    identity ? `[IDENTITY]\n${identity}` : '',
    user ? `[USER — 用户档案背景，仅当与当前任务相关时参考]\n${user}` : '',
    soul ? `[SOUL]\n${soul}` : '',
    intradayNotes ? `[TODAY_NOTES — 今日笔记背景，仅当与当前任务相关时参考]\n${intradayNotes}` : '',
    recentConvBlock || '',
    toolBlockParts.length > 0 ? `[TOOLS]\n${toolBlockParts.join('\n\n')}${toolsHint}` : (toolsHint ? `[TOOLS]${toolsHint}` : ''),
    memoryBlock,
    self ? `[SELF]\n${self}` : '',
  ].filter(Boolean);

  await hookBus.fire({ type: 'agent:bootstrap', sessionId, workspacePath, bootstrapFiles: [], timestamp: Date.now() });
  return parts.length > 0 ? '\n\n' + parts.join('\n\n') : '';
}
