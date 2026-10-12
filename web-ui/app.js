const API = '';
let ws = null;
let selectedJobId = null;
let allJobs = [];
let pollInterval = null;
let currentMode = 'chat';
let sidebarTab = 'jobs';
const CHAT_SESSIONS_KEY = 'smallclaw_chat_sessions_v1';
const AGENT_SESSION_KEY = 'smallclaw_agent_session_id';
const THEME_KEY = 'smallclaw_theme';
function generateSessionId() {
  return (crypto?.randomUUID?.() || ('sess_' + Math.random().toString(36).slice(2)));
}
function setAgentSessionId(id) {
  const next = String(id || '').trim() || generateSessionId();
  agentSessionId = next;
  localStorage.setItem(AGENT_SESSION_KEY, next);
  return next;
}
let agentSessionId = '';
setAgentSessionId(generateSessionId()); // always fresh session on page load

// Chat state
let chatHistory = [];
let chatSessions = [];
let activeChatSessionId = null;
let sessionsEditMode = false;
let isThinking = false;
let streamingSessionId = null; // which session owns the active stream
let processLogEntries = [];
let currentTurnStartIndex = -1;
let lastAgentMode = '-';
let lastTurnKind = '-';
let settingsTab = 'system';
let liveTaskSteps = [];
let quickSearchRigor = 'verified';
let quickThinkingEffort = localStorage.getItem('smallclaw_quick_thinking_effort') || 'off';
let queuedPrompts = [];
const MAX_QUEUED_PROMPTS = 8;
let currentPreflightStatus = '';
let currentProgressLines = [];
let processLogAutoFollow = true;
let rightColumnAutoFollow = true;

// Agent Execution Tracking
let agentExecutionMap = new Map(); // Map<agentId, { name, status, task, logs: [] }>
let agentIdCounter = 0;
const AGENT_STATUS = { ACTIVE: 'active', COMPLETED: 'completed', PAUSED: 'paused' };
let agentsConfigList = [];
let selectedAgentId = '';
let agentMdEditor = null;
// (skills cache moved to skillsCache in v2 skills management section)
let lastHeartbeat = {
  state: 'idle',
  level: '',
  current_step: '-',
  retry_count: 0,
  format_violation_count: 0,
  message: '',
};
let lastHeartbeatLogSignature = '';

function renderQueuedPromptsPanel() {
  const panel = document.getElementById('queued-prompts-panel');
  const list = document.getElementById('queued-prompts-list');
  const title = document.getElementById('queued-prompts-title');
  if (!panel || !list || !title) return;
  const count = queuedPrompts.length;
  if (count === 0) {
    panel.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  panel.style.display = 'block';
  title.textContent = `待发送提示词 (${count})`;
  list.innerHTML = queuedPrompts.map((q, i) => `
    <div class="queued-item">
      <div class="queued-item-text">${escHtml(q)}</div>
      <button class="queued-item-btn" onclick="removeQueuedPrompt(${i})">Remove</button>
    </div>
  `).join('');
}

function removeQueuedPrompt(index) {
  if (!Number.isInteger(index) || index < 0 || index >= queuedPrompts.length) return;
  queuedPrompts.splice(index, 1);
  updateQueuedPromptUI();
}

function clearQueuedPrompts() {
  if (!queuedPrompts.length) return;
  queuedPrompts = [];
  addProcessEntry('info', 'Cleared queued prompts.');
  updateQueuedPromptUI();
}

function updateQueuedPromptUI() {
  const badge = document.getElementById('queued-prompts-indicator');
  const sendBtn = document.getElementById('send-btn');
  const input = document.getElementById('chat-input');
  const count = queuedPrompts.length;
  if (badge) {
    if (count > 0) {
      badge.style.display = 'inline';
      badge.textContent = `Queued: ${count}`;
    } else {
      badge.style.display = 'none';
      badge.textContent = '';
    }
  }
  if (sendBtn) {
    sendBtn.disabled = false;
    sendBtn.title = isThinking ? `Queue next prompt${count ? ` (${count} queued)` : ''}` : 'Send';
  }
  if (input) {
    input.placeholder = isThinking
      ? 'Assistant is responding. Press Enter/Send to queue next prompt.'
      : '输入消息…（Enter 发送，Shift+Enter 换行）';
  }
  renderQueuedPromptsPanel();
}

function saveChatSessions() {
  localStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(chatSessions));
}

function makeSessionTitle(history) {
  const firstUser = (history || []).find(m => m.role === 'user');
  return firstUser ? firstUser.content.slice(0, 42) : 'New chat';
}

function loadChatSessions() {
  try {
    chatSessions = JSON.parse(localStorage.getItem(CHAT_SESSIONS_KEY) || '[]');
  } catch {
    chatSessions = [];
  }
  if (!Array.isArray(chatSessions)) chatSessions = [];
  if (chatSessions.length === 0) {
    const id = crypto?.randomUUID?.() || ('chat_' + Math.random().toString(36).slice(2));
    chatSessions.push({ id, title: 'New chat', history: [], processLog: [], createdAt: Date.now(), updatedAt: Date.now() });
    activeChatSessionId = id;
    setAgentSessionId(id);
    saveChatSessions();
  } else if (!activeChatSessionId || !chatSessions.some(s => s.id === activeChatSessionId)) {
    activeChatSessionId = chatSessions[0].id;
    setAgentSessionId(activeChatSessionId);
  }
  if (!agentSessionId || agentSessionId !== activeChatSessionId) setAgentSessionId(activeChatSessionId);
  syncActiveChat();
}

function syncActiveChat() {
  const sess = chatSessions.find(s => s.id === activeChatSessionId);
  chatHistory = sess ? (sess.history || []) : [];
  processLogEntries = sess ? (sess.processLog || []) : [];
  liveTaskSteps = [];  // clear live steps so a different session never inherits in-progress tool display
  // Mark session as read when opening it
  if (sess) sess.unread = false;
  renderChatMessages();
  renderProcessLog();
  renderLiveStepsPanel();
  renderSessionsList();
  updateStats([]);
  loadAgentSessionContext();
}

function persistActiveChat() {
  const idx = chatSessions.findIndex(s => s.id === activeChatSessionId);
  if (idx === -1) return;
  chatSessions[idx].history = chatHistory;
  chatSessions[idx].processLog = processLogEntries;
  chatSessions[idx].title = makeSessionTitle(chatHistory);
  chatSessions[idx].updatedAt = Date.now();
  saveChatSessions();
  renderSessionsList();
  updateStats([]);
}

function newChatSession() {
  const id = crypto?.randomUUID?.() || ('chat_' + Math.random().toString(36).slice(2));
  chatSessions.unshift({ id, title: 'New chat', history: [], processLog: [], createdAt: Date.now(), updatedAt: Date.now() });
  activeChatSessionId = id;
  setAgentSessionId(id);
  syncActiveChat();
}

function toggleSessionsEditMode() {
  sessionsEditMode = !sessionsEditMode;
  const btn = document.getElementById('sessions-edit-btn');
  if (btn) btn.textContent = sessionsEditMode ? 'Done' : 'Edit';
  renderSessionsList();
}

function deleteChatSession(id, ev) {
  if (ev) ev.stopPropagation();
  const idx = chatSessions.findIndex(s => s.id === id);
  if (idx === -1) return;

  chatSessions.splice(idx, 1);
  // Permanently delete the backend session too, so the conversation cannot be
  // recalled again (session JSON in .smallclaw/sessions/ is removed).
  fetch('/api/sessions/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id }),
  }).catch(err => console.error('Failed to delete backend session:', err));
  if (chatSessions.length === 0) {
    const newId = crypto?.randomUUID?.() || ('chat_' + Math.random().toString(36).slice(2));
    chatSessions.push({ id: newId, title: 'New chat', history: [], processLog: [], createdAt: Date.now(), updatedAt: Date.now() });
    activeChatSessionId = newId;
    setAgentSessionId(newId);
  } else if (activeChatSessionId === id) {
    activeChatSessionId = chatSessions[0].id;
    setAgentSessionId(activeChatSessionId);
  }

  saveChatSessions();
  syncActiveChat();
}

function openSession(id) {
  activeChatSessionId = id;
  setAgentSessionId(id);
  syncActiveChat();
  if (typeof loadPlanState === 'function') loadPlanState();
}

function markSessionUnread(sessionId) {
  const sess = chatSessions.find(s => s.id === sessionId);
  if (sess && sessionId !== activeChatSessionId) {
    sess.unread = true;
    renderSessionsList();
  }
}

// ---- Mode switching ----
function setMode(mode) {
  if (mode !== 'chat' && mode !== 'bgtasks' && mode !== 'schedule') mode = 'chat';
  currentMode = mode;
  // Toggle buttons
  document.getElementById('btn-chat').classList.toggle('active', mode === 'chat');
  const bgtBtn = document.getElementById('btn-bgtasks');
  if (bgtBtn) bgtBtn.classList.toggle('active', mode === 'bgtasks');
  const schedBtn = document.getElementById('btn-schedule');
  if (schedBtn) schedBtn.classList.toggle('active', mode === 'schedule');
  const kbBtn = document.getElementById('btn-knowledge');
  if (kbBtn) kbBtn.classList.toggle('active', mode === 'knowledge');
  // Toggle views
  document.getElementById('chat-view').style.display = mode === 'chat' ? 'flex' : 'none';
  const bgtView = document.getElementById('bgtasks-view');
  if (bgtView) bgtView.style.display = mode === 'bgtasks' ? 'flex' : 'none';
  const schedView = document.getElementById('schedule-view');
  if (schedView) schedView.style.display = mode === 'schedule' ? 'flex' : 'none';
  // Toggle sidebar + right panel visibility
  const aside = document.querySelector('aside');
  const rightPanel = document.getElementById('right-panel');
  if (aside) aside.style.display = mode === 'chat' ? '' : 'none';
  if (rightPanel) rightPanel.style.display = mode === 'chat' ? '' : 'none';
  // Column resizers only make sense on the chat (3-column) layout
  const resizerSide = document.getElementById('resizer-sidebar');
  const resizerRight = document.getElementById('resizer-right');
  if (resizerSide) resizerSide.style.display = mode === 'chat' ? '' : 'none';
  if (resizerRight) resizerRight.style.display = mode === 'chat' ? '' : 'none';
  // Load data when switching to respective views
  if (mode === 'bgtasks') refreshBgTasks();
  if (mode === 'schedule') refreshSchedules();
}

// Knowledge base is a chat-mode sidebar view: restore the main view
// (aside/right panel are hidden by setMode in other modes) then open it.
function setKnowledgeMode() {
  if (currentMode !== 'chat') setMode('chat');
  setSidebarTab('knowledge');
  const chatBtn = document.getElementById('btn-chat');
  if (chatBtn) chatBtn.classList.remove('active');
  const kbBtn = document.getElementById('btn-knowledge');
  if (kbBtn) kbBtn.classList.add('active');
}

// --- Heartbeat / Tasks System -----------------------------------------------
let hbJobs = [];
let hbConfig = { enabled: false, intervalMinutes: 30, activeHoursStart: 8, activeHoursEnd: 22 };
let editingTaskId = null;

async function loadTasksFromServer() {
  try {
    const data = await api('/api/tasks');
    if (data.success) {
      hbJobs = data.jobs || [];
      hbConfig = data.config || hbConfig;
      renderHeartbeatPage();
    }
  } catch (err) { console.error('[HB] Load failed:', err); }
}

function renderHeartbeatPage() {
  // Update topbar
  const dot = document.getElementById('hb-dot');
  const label = document.getElementById('hb-label');
  const meta = document.getElementById('hb-meta');
  const btn = document.getElementById('hb-toggle-btn');
  if (dot) dot.className = 'hb-status-dot ' + (hbConfig.enabled ? 'active' : '');
  if (label) label.textContent = hbConfig.enabled ? 'Heartbeat ON' : 'Heartbeat OFF';
  if (meta) meta.textContent = `Every ${hbConfig.intervalMinutes}m \u00b7 ${hbConfig.activeHoursStart}:00\u2013${hbConfig.activeHoursEnd}:00`;
  if (btn) { btn.textContent = hbConfig.enabled ? 'Pause' : 'Enable'; btn.className = 'hb-btn' + (hbConfig.enabled ? ' danger' : ' primary'); }

  // Split jobs into sections
  const running = hbJobs.filter(j => j.status === 'running');
  const queued = hbJobs.filter(j => j.enabled && j.status !== 'running' && j.status !== 'completed' && j.status !== 'paused').sort((a,b) => a.priority - b.priority);
  const paused = hbJobs.filter(j => j.status === 'paused');
  const completed = hbJobs.filter(j => j.status === 'completed' || j.type === 'one-shot' && j.lastRun).slice(0, 15);

  const empty = document.getElementById('hb-empty');
  if (empty) empty.style.display = hbJobs.length === 0 ? '' : 'none';

  renderHBSection('hb-section-running', 'hb-running-cards', running, 'running');
  renderHBSection('hb-section-queued', 'hb-queued-cards', [...queued, ...paused], 'queued');
  renderHBSection('hb-section-scheduled', 'hb-scheduled-cards', queued.filter(j => j.schedule), 'scheduled');
  renderHBSection('hb-section-completed', 'hb-completed-cards', completed, 'completed');
}

function renderHBSection(sectionId, cardsId, jobs, sectionType) {
  const section = document.getElementById(sectionId);
  const container = document.getElementById(cardsId);
  if (!section || !container) return;
  section.style.display = jobs.length > 0 ? '' : 'none';
  container.innerHTML = jobs.map(j => renderTaskCard(j, sectionType)).join('');
}

function renderTaskCard(job, sectionType) {
  const statusClass = job.status === 'running' ? 'running' : job.status === 'completed' ? 'completed' : job.status === 'paused' ? 'paused' : '';
  const scheduleText = job.schedule ? cronToHuman(job.schedule) : (job.runAt ? 'One-shot: ' + new Date(job.runAt).toLocaleString() : 'Manual');
  const lastRunText = job.lastRun ? timeAgo(new Date(job.lastRun).getTime()) : 'Never';
  const nextRunText = job.nextRun ? new Date(job.nextRun).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit'}) : '-';
  const resultSnippet = job.lastResult ? (job.lastResult.length > 60 ? job.lastResult.slice(0,60)+'...' : job.lastResult) : '';
  const isOk = /^\s*HEARTBEAT_OK\s*$/i.test(job.lastResult || '');

  return `<div class="hb-card ${statusClass}" data-job-id="${job.id}">
    <div class="hb-card-drag">${sectionType === 'completed' ? '' : '\u2261'}</div>
    <div class="hb-card-body">
      <div class="hb-card-name">${escHtml(job.name)}</div>
      <div class="hb-card-meta">
        <span>${scheduleText}</span>
        <span>Next: ${nextRunText}</span>
        <span>Last: ${lastRunText}</span>
        ${resultSnippet && !isOk ? `<span style="color:var(--text);font-weight:600">${escHtml(resultSnippet)}</span>` : ''}
        ${isOk ? '<span style="color:var(--ok)">\u2713 OK</span>' : ''}
      </div>
    </div>
    <div class="hb-card-actions">
      ${job.status !== 'running' ? `<button class="hb-card-btn" onclick="runTaskNow('${job.id}')" title="Run now">\u25b6</button>` : '<span style="font-size:11px;color:var(--brand)">Running...</span>'}
      <button class="hb-card-btn" onclick="editTask('${job.id}')" title="Edit">\u270e</button>
      <button class="hb-card-btn" onclick="toggleTaskPause('${job.id}')" title="${job.status === 'paused' ? 'Resume' : 'Pause'}">${job.status === 'paused' ? '\u25b6' : '\u23f8'}</button>
      <button class="hb-card-btn danger" onclick="deleteTask('${job.id}')" title="Delete">\u2715</button>
      ${job.sessionId ? `<button class="hb-card-btn" onclick="viewTaskSession('${job.sessionId}')" title="View response">\u2192</button>` : ''}
    </div>
  </div>`;
}

function cronToHuman(expr) {
  if (!expr) return 'Manual';
  const p = expr.split(/\s+/);
  if (p.length !== 5) return expr;
  const [min, hr, dom, , dow] = p;
  if (min.startsWith('*/')) return `Every ${min.slice(2)}m`;
  if (hr === '*') return `Every minute`;
  if (dom === '*' && dow === '*') return `Daily at ${hr}:${min.padStart(2,'0')}`;
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  if (dow !== '*') return `${days[Number(dow)] || dow} at ${hr}:${min.padStart(2,'0')}`;
  return expr;
}

async function toggleHeartbeatEnabled() {
  try {
    const data = await api('/api/tasks/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled: !hbConfig.enabled }) });
    if (data.success) { hbConfig = data.config; renderHeartbeatPage(); }
  } catch (err) { console.error('[HB] Toggle failed:', err); }
}

async function runTaskNow(id) {
  try { await api(`/api/tasks/${id}/run`, { method: 'POST' }); } catch {}
}

async function deleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    hbJobs = hbJobs.filter(j => j.id !== id);
    renderHeartbeatPage();
  } catch {}
}

async function toggleTaskPause(id) {
  const job = hbJobs.find(j => j.id === id);
  if (!job) return;
  const newStatus = job.status === 'paused' ? 'scheduled' : 'paused';
  try {
    const data = await api(`/api/tasks/${id}`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ status: newStatus, enabled: newStatus !== 'paused' }) });
    if (data.success) { Object.assign(job, data.job); renderHeartbeatPage(); }
  } catch {}
}

function viewTaskSession(sessionId) {
  // Switch to chat mode and open the automated session
  const session = chatSessions.find(s => s.id === sessionId);
  if (session) {
    setMode('chat');
    openSession(sessionId);
  }
}

function openTaskModal(taskId) {
  editingTaskId = taskId || null;
  const job = taskId ? hbJobs.find(j => j.id === taskId) : null;
  const modal = document.getElementById('task-modal');
  modal.style.display = '';
  modal.innerHTML = `<div class="hb-modal-overlay" onclick="if(event.target===this)closeTaskModal()">
    <div class="hb-modal">
      <h3>${job ? 'Edit Task' : 'Add Task'}</h3>
      <label>Name</label>
      <input id="tm-name" value="${job ? escHtml(job.name) : ''}" placeholder="e.g. Check inbox for urgent emails">
      <label>Prompt (what the LLM should do)</label>
      <textarea id="tm-prompt" placeholder="e.g. Search for any urgent emails or messages I should know about">${job ? escHtml(job.prompt) : ''}</textarea>
      <label>Type</label>
      <select id="tm-type">
        <option value="recurring" ${!job || job.type==='recurring' ? 'selected' : ''}>Recurring (cron)</option>
        <option value="one-shot" ${job?.type==='one-shot' ? 'selected' : ''}>One-shot (run once)</option>
      </select>
      <label>Schedule (cron expression)</label>
      <input id="tm-schedule" value="${job?.schedule || '*/30 * * * *'}" placeholder="*/30 * * * * (every 30 min)">
      <div style="font-size:10px;color:var(--muted);margin-top:2px">Examples: */30 * * * * (every 30m), 0 9 * * * (daily 9am), 0 9 * * 1 (Mon 9am)</div>
      <div class="hb-modal-actions">
        <button class="hb-btn" onclick="closeTaskModal()">Cancel</button>
        <button class="hb-btn primary" onclick="saveTask()">Save</button>
      </div>
    </div>
  </div>`;
}

function editTask(id) { openTaskModal(id); }

function closeTaskModal() {
  document.getElementById('task-modal').style.display = 'none';
  editingTaskId = null;
}

async function saveTask() {
  const name = document.getElementById('tm-name').value.trim();
  const prompt = document.getElementById('tm-prompt').value.trim();
  const type = document.getElementById('tm-type').value;
  const schedule = document.getElementById('tm-schedule').value.trim();
  if (!name || !prompt) { alert('Name and prompt are required'); return; }
  try {
    if (editingTaskId) {
      const data = await api(`/api/tasks/${editingTaskId}`, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, prompt, type, schedule }) });
      if (data.success) {
        const idx = hbJobs.findIndex(j => j.id === editingTaskId);
        if (idx >= 0) hbJobs[idx] = data.job;
      }
    } else {
      const data = await api('/api/tasks', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name, prompt, type, schedule }) });
      if (data.success) hbJobs.push(data.job);
    }
    closeTaskModal();
    renderHeartbeatPage();
  } catch (err) { alert('Failed to save: ' + err.message); }
}

// ---- Sidebar tabs ----
function setSidebarTab(tab) {
  sidebarTab = tab;
  document.getElementById('tab-jobs').classList.toggle('active', tab === 'jobs');
  document.getElementById('tab-skills').classList.toggle('active', tab === 'skills');
  document.getElementById('tab-flows').classList.toggle('active', tab === 'flows');
  document.getElementById('tab-knowledge').classList.toggle('active', tab === 'knowledge');
  document.getElementById('sidebar-jobs').style.display = tab === 'jobs' ? 'flex' : 'none';
  document.getElementById('sidebar-skills').style.display = tab === 'skills' ? 'flex' : 'none';
  document.getElementById('sidebar-flows').style.display = tab === 'flows' ? 'flex' : 'none';
  document.getElementById('sidebar-knowledge').style.display = tab === 'knowledge' ? 'flex' : 'none';
  // Keep the topbar Knowledge button in sync with the sidebar tab
  const kbBtn = document.getElementById('btn-knowledge');
  if (kbBtn) kbBtn.classList.toggle('active', tab === 'knowledge');
  if (tab === 'skills') loadInstalledSkills();
  if (tab === 'flows') loadFlows();
  if (tab === 'knowledge') loadKnowledge();
}

// Tool usage is automatic: the model calls tools when its own capability
// is insufficient (controlled by orchestration config). No manual Chat/Agent
// switch anymore — the badge shows the current tool policy state.
let orchestrationEnabled = false;
async function updateAgentModeIndicator() {
  try {
    const boot = window.__bootData;
    const cfg = (boot && boot.orchestration && boot.orchestration.config) || await api('/api/orchestration/config');
    orchestrationEnabled = !!(cfg && cfg.enabled);
    const elig = (boot && boot.orchestration && boot.orchestration.eligible) || await api('/api/orchestration/eligible');
    const skillOn = !!(elig && elig.eligible);
    const badge = document.getElementById('agent-mode-badge');
    if (!badge) return;
    badge.textContent = '工具: 自动';
    badge.title = orchestrationEnabled && skillOn
      ? '工具策略：模型能力不足时自动调用工具（编排已启用）'
      : '工具策略：模型能力不足时自动调用工具';
    badge.classList.add('visible');
  } catch { /* keep default badge text */ }
}

// ---- Chat ----
function renderThinkBlock(thinking) {
  if (!thinking || !thinking.trim()) return '';
  const id = 'think_' + Math.random().toString(36).slice(2);
  const wordCount = thinking.trim().split(/\s+/).length;
  return `
    <div class="think-block">
      <button class="think-toggle" id="${id}_btn" onclick="toggleThink('${id}')">
        <span class="think-icon">...</span>
        <span>思考过程</span>
        <span style="margin-left:auto;opacity:0.5">${wordCount} 字</span>
      </button>
      <div class="think-content" id="${id}_body">${escHtml(thinking)}</div>
    </div>
  `;
}

function toggleThink(id) {
  const btn = document.getElementById(id + '_btn');
  const body = document.getElementById(id + '_body');
  if (!btn || !body) return;
  const open = body.style.display !== 'none' && body.style.display !== '';
  body.style.display = open ? 'none' : 'block';
  btn.classList.toggle('open', !open);
}

function renderReactSteps(steps) {
  if (!steps || steps.length === 0) return '';
  const toolSteps = steps.filter(s => s.action);
  if (toolSteps.length === 0) return '';

  const getSearchDiagnostics = (s) => s?.toolData?.search_diagnostics || s?.diagnostics || null;
  const extractUrls = (s, resultText) => {
    const fromToolData = Array.isArray(s?.toolData?.results)
      ? s.toolData.results.map(r => String(r?.url || '').trim()).filter(u => /^https?:\/\//i.test(u))
      : [];
    const fromText = String(resultText || '').match(/https?:\/\/[^\s)]+/g) || [];
    const merged = [...fromToolData, ...fromText.map(u => String(u).trim())];
    const out = [];
    const seen = new Set();
    for (const u of merged) {
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= 5) break;
    }
    return out;
  };
  const providerSummary = (diag) => {
    if (!diag || !Array.isArray(diag.attempted) || !diag.attempted.length) return '';
    return diag.attempted.map(a => {
      const p = String(a.provider || '').toLowerCase();
      const status = String(a.status || '').toLowerCase();
      if (status === 'success') {
        const count = Number.isFinite(a.result_count) ? `, ${a.result_count} result${a.result_count === 1 ? '' : 's'}` : '';
        return `${p}=success${count}`;
      }
      if (status === 'skipped') return `${p}=skipped${a.reason ? ` (${a.reason})` : ''}`;
      return `${p}=failed${a.reason ? ` (${a.reason})` : ''}`;
    }).join(' | ');
  };

  const id = 'steps_' + Math.random().toString(36).slice(2);
  const items = toolSteps.map(s => {
    const resultText = typeof s.toolResult === 'string' ? s.toolResult : JSON.stringify(s.toolResult || '');
    const diag = String(s.action || '') === 'web_search' ? getSearchDiagnostics(s) : null;
    const query = String(diag?.query || s?.params?.query || '').trim();
    const selectedProvider = String(diag?.selected_provider || s?.toolData?.provider || '').toLowerCase();
    const providers = diag ? providerSummary(diag) : '';
    const urls = String(s.action || '') === 'web_search' ? extractUrls(s, resultText) : [];
    return `
      <div class="react-step">
        ${s.thought ? `<div class="react-step-thought">${escHtml(s.thought.slice(0, 120))}</div>` : ''}
        <div class="react-step-action">${escHtml(s.action)}</div>
        ${resultText ? `<div class="react-step-result${resultText.startsWith('ERROR') ? ' error' : ''}">${escHtml(resultText.slice(0, 160))}${resultText.length > 160 ? '…' : ''}</div>` : ''}
        ${diag ? `
          <div style="margin-top:6px;font-size:10px;color:var(--muted);line-height:1.5">
            ${query ? `<div><b>query</b>: ${escHtml(query)}</div>` : ''}
            ${selectedProvider ? `<div><b>provider hit</b>: ${escHtml(selectedProvider)}</div>` : ''}
            ${providers ? `<div><b>providers</b>: ${escHtml(providers)}</div>` : ''}
          </div>
        ` : ''}
        ${String(s.action || '') === 'web_search' && !diag ? `
          <div style="margin-top:6px;font-size:10px;color:var(--muted);line-height:1.5">
            ${selectedProvider ? `<div><b>provider hit</b>: ${escHtml(selectedProvider)}</div>` : ''}
          </div>
        ` : ''}
        ${urls.length ? `
          <div style="margin-top:6px;font-size:10px;line-height:1.6">
            <div style="color:var(--muted);margin-bottom:2px"><b>sources</b>:</div>
            ${urls.slice(0, 3).map((u, i) => `<div>${i + 1}. <a href="${escHtml(u)}" target="_blank" rel="noopener noreferrer">${escHtml(u)}</a></div>`).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  return `
    <div class="react-steps-toggle" onclick="toggleSteps('${id}')">
      ? ${toolSteps.length} tool step${toolSteps.length !== 1 ? 's' : ''} used
    </div>
    <div class="react-steps" id="${id}" style="display:none">${items}</div>
  `;
}

function toggleSteps(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const visible = el.style.display !== 'none';
  el.style.display = visible ? 'none' : 'block';
  el.previousElementSibling.textContent = `${visible ? '?' : '?'} ${el.querySelectorAll('.react-step').length} tool step${el.querySelectorAll('.react-step').length !== 1 ? 's' : ''} used`;
}

// ---- Markdown rendering: safe allow-list renderer, no external deps ----
// Lets doc_read / doc_inspect / tool results render as real headings, tables,
// lists and code blocks in the chat stream instead of escaped plain text.
// Every source string is escaped (escHtml); only allow-listed tags are emitted.
function mdInline(text) {
  const out = [];
  const rest = String(text || '');
  const TOKEN = /\*\*([^*]+?)\*\*|~~([^~]+?)~~|`([^`]+?)`|\*([^*]+?)\*|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0, m;
  while ((m = TOKEN.exec(rest))) {
    if (m.index > last) out.push(escHtml(rest.slice(last, m.index)));
    if (m[1] !== undefined) out.push('<strong>' + escHtml(m[1]) + '</strong>');
    else if (m[2] !== undefined) out.push('<del>' + escHtml(m[2]) + '</del>');
    else if (m[3] !== undefined) out.push('<code>' + escHtml(m[3]) + '</code>');
    else if (m[4] !== undefined) out.push('<em>' + escHtml(m[4]) + '</em>');
    else if (m[5] !== undefined) {
      // Image ![alt](url) — only allow http(s) images; render inline img.
      const imgUrl = String(m[6] || '').trim();
      const safeImg = /^https?:\/\//i.test(imgUrl) ? imgUrl : '';
      if (safeImg) {
        const alt = String(m[5] || '');
        out.push('<img src="' + escHtml(safeImg) + '" alt="' + escHtml(alt) + '" loading="lazy" style="max-width:100%;border-radius:6px;margin:4px 0;">');
      } else {
        out.push(escHtml('![' + m[5] + '](' + m[6] + ')'));
      }
    }
    else if (m[7] !== undefined) {
      const url = String(m[8] || '').trim();
      const safe = /^(https?:|mailto:)/i.test(url) ? url : '';
      out.push(safe
        ? '<a href="' + escHtml(safe) + '" target="_blank" rel="noopener noreferrer">' + escHtml(m[7]) + '</a>'
        : escHtml(m[7] + ' (' + url + ')'));
    }
    last = m.index + m[0].length;
  }
  if (last < rest.length) out.push(escHtml(rest.slice(last)));
  return out.join('');
}

function splitTableRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function renderMarkdown(text) {
  const raw = String(text || '').replace(/\r/g, '');
  if (!raw.trim()) return '';
  // Extract fenced code blocks first so their contents are never parsed as markdown.
  // Structure: <pre class="md-code"><div class="md-code-head"><span class="md-code-lang">
  //   LANG</span><button class="md-code-copy">复制</button></div><code class="hljs lang-X">…
  // The copy button is bound via a document-level click handler; highlighting is
  // applied by the MutationObserver in highlightCodeBlocks().
  const fenced = [];
  let body = raw.replace(/```([^\n]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const langRaw = String(lang || '').trim();
    const langCls = langRaw.replace(/[^a-zA-Z0-9_+-]/g, '');
    const langLabel = langRaw && /^[a-zA-Z0-9_+-]+$/.test(langRaw) ? langRaw : (langRaw || 'text');
    const codeHtml = escHtml(code.replace(/\n$/, ''));
    fenced.push('<pre class="md-code"><div class="md-code-head"><span class="md-code-lang">' + escHtml(langLabel) + '</span><button class="md-code-copy" type="button" title="复制代码">复制</button></div><code class="hljs' + (langCls ? ' lang-' + langCls : '') + '">' + codeHtml + '</code></pre>');
    return '\u0000' + (fenced.length - 1) + '\u0000';
  });
  const lines = body.split('\n');
  const html = [];
  let para = [];
  const flushPara = () => {
    if (para.length) { html.push('<p>' + mdInline(para.join(' ')) + '</p>'); para = []; }
  };
  const isTableSep = (s) => /^\|?[\s:|-]+\|?$/.test(String(s || '').trim()) && String(s || '').includes('-');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ph = line.match(/^\u0000(\d+)\u0000$/);
    if (ph) { flushPara(); html.push(fenced[+ph[1]]); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); html.push('<h' + h[1].length + ' class="md-h">' + mdInline(h[2]) + '</h' + h[1].length + '>'); continue; }
    const hr = line.trim().match(/^([-*_])\1{2,}\s*$/);
    if (hr) { flushPara(); html.push('<hr class="md-hr">'); continue; }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flushPara();
      const hdr = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(splitTableRow(lines[i])); i++; }
      i--;
      html.push('<table class="md-table"><thead><tr>' + hdr.map(c => '<th>' + mdInline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }
    const task = line.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
    if (task) {
      flushPara();
      const items = [{ checked: /[xX]/.test(task[1]), text: task[2] }];
      while (i + 1 < lines.length) {
        const n = lines[i + 1].match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
        if (!n) break;
        items.push({ checked: /[xX]/.test(n[1]), text: n[2] }); i++;
      }
      html.push('<ul class="md-list md-task">' + items.map(it =>
        '<li class="md-task-item"><input type="checkbox" disabled' + (it.checked ? ' checked' : '') + '> <span>' + mdInline(it.text) + '</span></li>'
      ).join('') + '</ul>');
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      flushPara();
      const items = [ul[1]];
      while (i + 1 < lines.length) {
        const n = lines[i + 1].match(/^\s*[-*]\s+(.*)$/);
        if (!n) break;
        items.push(n[1]); i++;
      }
      html.push('<ul class="md-list">' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ul>');
      continue;
    }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) {
      flushPara();
      const items = [ol[1]];
      while (i + 1 < lines.length) {
        const n = lines[i + 1].match(/^\s*\d+\.\s+(.*)$/);
        if (!n) break;
        items.push(n[1]); i++;
      }
      html.push('<ol class="md-list">' + items.map(it => '<li>' + mdInline(it) + '</li>').join('') + '</ol>');
      continue;
    }
    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      flushPara();
      const qs = [q[1]];
      while (i + 1 < lines.length) {
        const n = lines[i + 1].match(/^>\s?(.*)$/);
        if (!n) break;
        qs.push(n[1]); i++;
      }
      html.push('<blockquote class="md-quote">' + qs.map(s => '<p>' + mdInline(s) + '</p>').join('') + '</blockquote>');
      continue;
    }
    if (!line.trim()) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return html.join('\n');
}

// ── Code block highlighting + copy (mirrors the project's code-block style) ──
function highlightCodeBlocksIn(rootEl) {
  if (typeof hljs === 'undefined') return;
  const root = rootEl || document;
  const codes = root.querySelectorAll ? root.querySelectorAll('pre.md-code code[class*="lang-"]') : [];
  codes.forEach((code) => {
    if (code.dataset.hlDone) return;
    code.dataset.hlDone = '1';
    try { hljs.highlightElement(code); } catch { /* keep plain text */ }
  });
}

function copyCodeFromButton(btn) {
  const pre = btn.closest('.md-code');
  if (!pre) return;
  const code = pre.querySelector('code');
  const text = code ? code.textContent : '';
  if (!text) return;
  const done = () => {
    btn.textContent = '已复制';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = '复制'; btn.classList.remove('copied'); }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { /* clipboard blocked */ }
  document.body.removeChild(ta);
}

// Global click delegation so copy buttons work for any message (streamed or
// re-rendered), without re-binding per render.
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('.md-code-copy') : null;
  if (btn) copyCodeFromButton(btn);
});

// Highlight code blocks as messages are rendered / streamed in.
(function initCodeHighlightObserver() {
  if (typeof MutationObserver === 'undefined') return;
  const container = document.getElementById('chat-messages');
  if (!container) return;
  const mo = new MutationObserver((muts) => {
    let need = false;
    for (const m of muts) {
      if (m.addedNodes && m.addedNodes.length) { need = true; break; }
    }
    if (need) highlightCodeBlocksIn(container);
  });
  mo.observe(container, { childList: true, subtree: true });
  highlightCodeBlocksIn(container);
})();

function renderAssistantContent(content) {
  const text = String(content || '');
  const hasStaged = /(^|\n)(Initial chat|Execution result|Final chat):\s*/i.test(text);
  if (!hasStaged) return `<div class="msg-content">${renderMarkdown(text)}</div>`;
  const chunks = text
    .split(/\n\s*---\s*\n/g)
    .map(s => String(s || '').trim())
    .filter(Boolean);
  const html = chunks.map((chunk, idx) => {
    const m = chunk.match(/^(Initial chat|Execution result|Final chat):\s*\n?/i);
    const title = m ? m[1] : `Section ${idx + 1}`;
    const body = m ? chunk.slice(m[0].length).trim() : chunk;
    return `
      <div class="msg-stage">
        <div class="msg-stage-title">${escHtml(title)}</div>
        <div class="msg-content">${renderMarkdown(body)}</div>
      </div>
    `;
  }).join('');
  return `<div class="msg-staged">${html}</div>`;
}

function renderArtifacts(artifacts) {
  const rows = Array.isArray(artifacts) ? artifacts : [];
  if (!rows.length) return '';
  const cards = rows.map((a, idx) => {
    const type = String(a?.type || '').trim();
    const title = String(a?.title || type || `Artifact ${idx + 1}`).trim();
    const status = String(a?.status || 'ok').toLowerCase();
    const pathVal = String(a?.path || '').trim();
    const fromPath = String(a?.from_path || '').trim();
    const toPath = String(a?.to_path || '').trim();
    const summary = String(a?.summary || '').trim();
    const preview = String(a?.preview || '').trim();
    const files = Array.isArray(a?.files) ? a.files.slice(0, 12).map(x => String(x || '')).filter(Boolean) : [];
    const dirs = Array.isArray(a?.directories) ? a.directories.slice(0, 8).map(x => String(x || '')).filter(Boolean) : [];
    const locationTarget = toPath || pathVal || fromPath;
    return `
      <div class="artifact-card">
        <div class="artifact-head">
          <div class="artifact-title">${escHtml(title)}</div>
          <div class="artifact-status ${escHtml(status)}">${escHtml(status)}</div>
        </div>
        ${pathVal ? `<div class="artifact-row"><b>Path:</b> <code>${escHtml(pathVal)}</code></div>` : ''}
        ${fromPath ? `<div class="artifact-row"><b>From:</b> <code>${escHtml(fromPath)}</code></div>` : ''}
        ${toPath ? `<div class="artifact-row"><b>To:</b> <code>${escHtml(toPath)}</code></div>` : ''}
        ${summary ? `<div class="artifact-row">${escHtml(summary)}</div>` : ''}
        ${files.length ? `<div class="artifact-row"><b>Files:</b> ${escHtml(files.join(', '))}${Array.isArray(a?.files) && a.files.length > files.length ? ' ...' : ''}</div>` : ''}
        ${dirs.length ? `<div class="artifact-row"><b>Directories:</b> ${escHtml(dirs.join(', '))}${Array.isArray(a?.directories) && a.directories.length > dirs.length ? ' ...' : ''}</div>` : ''}
        ${preview ? `<div class="artifact-preview">${escHtml(preview)}</div>` : ''}
        ${locationTarget ? `
          <div class="artifact-actions">
            <button class="artifact-btn" onclick="openInFileLocation('${escHtml(locationTarget).replace(/'/g, '&#39;')}')">Open In File Location</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
  return `<div class="artifact-list">${cards}</div>`;
}

async function openInFileLocation(targetPath) {
  const p = String(targetPath || '').trim();
  if (!p) return;
  try {
    const res = await fetch('/api/open-path', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok) {
      throw new Error(String(data?.error || `HTTP ${res.status}`));
    }
    addProcessEntry('info', `Opened in file location: ${p}`);
  } catch (err) {
    addProcessEntry('error', `Open path failed: ${String(err?.message || err)}`);
  }
}

function renderChatMessages() {
  const container = document.getElementById('chat-messages');

  if (chatHistory.length === 0) {
    container.innerHTML = `
      <div class="chat-welcome" id="chat-welcome">
        <div class="chat-welcome-icon">🦞</div>
        <h2>SmallClaw</h2>
        <p>直接与本地模型对话，无需 API 密钥、不依赖云端 — 只有你和模型。</p>
        <div class="hint">小模型建议关闭思考以获得更快响应；输入 @ 可引用知识库文件。</div>
      </div>`;
    return;
  }

  container.innerHTML = chatHistory.map((msg, idx) => {
    const pinClass = contextPinMode ? ' pin-selectable' : '';
    const selectedClass = (contextPinMode && pinnedMessageIndices.has(idx)) ? ' pin-selected' : '';
    // Also show green for confirmed pins even outside pin mode
    const confirmedClass = (!contextPinMode && confirmedPins.some(p => p.content === msg.content && p.role === (msg.role === 'user' ? 'user' : 'assistant'))) ? ' pin-selected' : '';
    const clickHandler = contextPinMode ? ` onclick="togglePinMessage(${idx})"` : '';
    return `
    <div class="msg ${msg.role}${pinClass}${selectedClass}${confirmedClass}"${clickHandler}>
      <div class="msg-avatar">${msg.role === 'user' ? 'U' : '🦞'}</div>
      <div class="msg-body">
        <div class="msg-role">${msg.role === 'user' ? '你' : (msg.mode === 'agentic' ? 'SmallClaw (Agent)' : 'SmallClaw')}</div>
        ${msg.role === 'ai' ? renderAssistantContent(msg.content) : `<div class="msg-content">${escHtml(msg.content)}</div>`}
        ${msg.role === 'ai' ? renderArtifacts(msg.artifacts) : ''}
        ${msg.role === 'ai' && msg.processEntries && msg.processEntries.length ? renderProcessPill(msg.processEntries) : ''}
        ${msg.role === 'ai' ? renderThinkBlock(msg.thinking) : ''}
        ${msg.role === 'ai' ? renderReactSteps(msg.steps) : ''}
      </div>
    </div>`;
  }).join('');

  if (isThinking && streamingSessionId === activeChatSessionId) {
    const progressHtml = currentProgressLines.length
      ? `<div style="margin:6px 0 8px 0;font-size:11px;line-height:1.6;color:var(--muted)">
          ${currentProgressLines.map((l) => `<div>• ${escHtml(l)}</div>`).join('')}
        </div>`
      : '';
    container.innerHTML += `
      <div class="msg ai" id="thinking-msg">
        <div class="msg-avatar">🦞</div>
        <div class="msg-body">
          <div class="msg-role">SmallClaw</div>
          ${currentPreflightStatus ? `<div class="msg-content" style="margin-bottom:6px;color:#26487e">${escHtml(currentPreflightStatus)}</div>` : ''}
          ${progressHtml}
          <div class="thinking">
            <div class="thinking-dot"></div>
            <div class="thinking-dot"></div>
            <div class="thinking-dot"></div>
          </div>
          <div style="margin-top:8px">
            <button class="skill-install-btn" style="font-size:10px;padding:3px 9px" onclick="toggleCurrentProcess()">过程</button>
            <div id="current-turn-process" style="display:none;margin-top:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);padding:8px;max-height:220px;overflow:auto;font-size:11px;line-height:1.6"></div>
          </div>
        </div>
      </div>`;
  }

  container.scrollTop = container.scrollHeight;
}

function pushProgressLine(line) {
  const txt = String(line || '').trim();
  if (!txt) return;
  const last = currentProgressLines[currentProgressLines.length - 1] || '';
  if (last === txt) return;
  currentProgressLines.push(txt);
  if (currentProgressLines.length > 8) currentProgressLines = currentProgressLines.slice(-8);
  if (isThinking) renderChatMessages();
}

// ---- Process log ----
function renderProcessPill(entries) {
  const id = 'proc_' + Math.random().toString(36).slice(2);
  return `
    <div style="margin-top:8px">
      <button class="skill-install-btn" style="font-size:10px;padding:3px 9px" onclick="togglePL('${id}')">过程</button>
      <div id="${id}" style="display:none;margin-top:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2);padding:8px;max-height:220px;overflow:auto;font-size:11px;line-height:1.6">
        ${formatProcessLines(entries)}
      </div>
    </div>
  `;
}

function formatProcessLines(entries) {
  if (!entries || entries.length === 0) return '<div style="color:var(--muted)">暂无过程详情</div>';
  const TYPE_COLORS = {
    user: 'var(--text)', think: '#388bfd', tool: '#e3b341',
    result: '#bc8cff', error: 'var(--red)', final: '#56d364',
    warn: 'var(--yellow)', step: '#56d364', info: '#79c0ff',
    split: 'var(--accent2)', synth: 'var(--accent2)',
  };
  return entries.map(e => {
    const rawType = String(e.type || 'info');
    const typeLabel = escHtml(rawType).toUpperCase();
    const typeColor = TYPE_COLORS[rawType] || 'var(--muted)';
    const content = escHtml(String(e.content || ''));
    return `<div style="margin-bottom:4px"><span style="color:var(--muted)">[${escHtml(String(e.ts || ''))}]</span> <span style="color:${typeColor};font-weight:600">${typeLabel}</span> ${content}</div>`;
  }).join('');
}

function toggleCurrentProcess() {
  const panel = document.getElementById('current-turn-process');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  if (!open) {
    const turnEntries = currentTurnStartIndex >= 0 ? processLogEntries.slice(currentTurnStartIndex) : [];
    panel.innerHTML = formatProcessLines(turnEntries);
  }
}

function isNearBottom(el, threshold = 40) {
  if (!el) return true;
  return (el.scrollHeight - (el.scrollTop + el.clientHeight)) <= threshold;
}

function setupProcessAndRightScrollTracking() {
  const processEl = document.getElementById('process-log');
  if (processEl && !processEl.dataset.scrollBound) {
    processEl.dataset.scrollBound = '1';
    processEl.addEventListener('scroll', () => {
      processLogAutoFollow = isNearBottom(processEl, 36);
    });
  }

  const rightEl = document.getElementById('right-panel');
  if (rightEl && !rightEl.dataset.scrollBound) {
    rightEl.dataset.scrollBound = '1';
    rightEl.addEventListener('scroll', () => {
      rightColumnAutoFollow = isNearBottom(rightEl, 28);
    });
  }
}

function maybeAutoScrollRightColumn(force = false) {
  const rightEl = document.getElementById('right-panel');
  if (!rightEl) return;
  if (force || rightColumnAutoFollow || isThinking) {
    rightEl.scrollTop = rightEl.scrollHeight;
  }
}

function updateHeartbeatUI() {
  const stateEl = document.getElementById('r-heartbeat-state');
  const metaEl = document.getElementById('r-heartbeat-meta');
  if (stateEl) {
    const state = String(lastHeartbeat.state || 'idle').toLowerCase();
    stateEl.textContent = state || 'idle';
    stateEl.style.color = state === 'running' || state === 'retrying'
      ? 'var(--warn)'
      : (state === 'stalled' ? 'var(--err)' : 'var(--text)');
  }
  if (metaEl) {
    const step = String(lastHeartbeat.current_step || '-');
    const retries = Number(lastHeartbeat.retry_count || 0);
    const fv = Number(lastHeartbeat.format_violation_count || 0);
    const lvl = String(lastHeartbeat.level || '').toLowerCase();
    const lvlTag = lvl ? ` ${lvl}` : '';
    metaEl.textContent = `step:${step} • retries:${retries} • fv:${fv}${lvlTag}`;
  }
}

function clearProcessLog() {
  processLogEntries.length = 0;
  const el = document.getElementById('process-log');
  if (el) el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px 0;opacity:0.5">Waiting for activity...</div>';
  processLogAutoFollow = true;
  rightColumnAutoFollow = true;
  maybeAutoScrollRightColumn(true);
  persistActiveChat();
}

function addProcessEntry(type, content, extra) {
  const ts = new Date().toLocaleTimeString();
  processLogEntries.push({ ts, type, content, extra });
  renderProcessLog();
  maybeAutoScrollRightColumn(isThinking || rightColumnAutoFollow);
  persistActiveChat();
  if (isThinking) {
    const panel = document.getElementById('current-turn-process');
    if (panel && panel.style.display !== 'none' && currentTurnStartIndex >= 0) {
      panel.innerHTML = formatProcessLines(processLogEntries.slice(currentTurnStartIndex));
    }
  }
}

function renderProcessLog() {
  const el = document.getElementById('process-log');
  if (!el) return;
  setupProcessAndRightScrollTracking();
  const shouldFollow = processLogAutoFollow || isThinking;

  if (processLogEntries.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px 0;opacity:0.5">Waiting for activity...</div>';
    if (shouldFollow) el.scrollTop = el.scrollHeight;
    return;
  }

  el.innerHTML = processLogEntries.map((e,i) => {
    let icon, color, label, labelColor;
    switch(e.type) {
      case 'user':    icon='?'; color='var(--accent2)'; labelColor='var(--text)';     label='USER';   break;
      case 'think':   icon='??'; color='#388bfd';        labelColor='#388bfd';         label='THINK';  break;
      case 'tool':    icon='?'; color='#e3b341';        labelColor='#e3b341';         label='TOOL';   break;
      case 'result':  icon='?'; color='#bc8cff';        labelColor='#bc8cff';         label='OK';     break;
      case 'error':   icon='?'; color='var(--red)';     labelColor='var(--red)';      label='FAIL';   break;
      case 'final':   icon='?'; color='#56d364';        labelColor='#56d364';         label='FINAL';  break;
      case 'warn':    icon='?'; color='var(--yellow)';  labelColor='var(--yellow)';   label='WARN';   break;
      case 'step':    icon='?'; color='#56d364';        labelColor='#56d364';         label='STEP';   break;
      case 'split':   icon='?'; color='var(--accent2)'; labelColor='var(--accent2)';  label='SPLIT';  break;
      case 'synth':   icon='?'; color='var(--accent2)'; labelColor='var(--accent2)';  label='SYNTH';  break;
      case 'info':    icon='·'; color='#79c0ff';        labelColor='#79c0ff';         label='INFO';   break;
      default:        icon='·'; color='var(--muted)';   labelColor='var(--muted)';    label=e.type;   break;
    }

    // Think entries: show full content in a scrollable block
    if (e.type === 'think' && e.content && e.content.length > 60) {
      const id = 'pl_' + Math.random().toString(36).slice(2,8);
      const preview = e.content.slice(0, 80).replace(/\n/g,' ');
      return `
        <div style="margin-bottom:4px">
          <span style="color:var(--muted);font-size:10px">${e.ts}</span>
          <span style="color:${color};margin:0 6px">${icon} <span style="color:${labelColor}">${label}</span></span>
          <span style="color:var(--muted);cursor:pointer;text-decoration:underline;font-size:10px" onclick="togglePL('${id}')">${escHtml(preview)}…</span>
        </div>
        <div id="${id}" style="display:none;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px;white-space:pre-wrap;color:var(--muted);font-size:10px;max-height:200px;overflow-y:auto;font-style:italic">${escHtml(e.content)}</div>
      `;
    }

    // Tool result entries: collapsible if long
    if (e.type === 'result' && e.content && e.content.length > 120) {
      const id = 'pl_' + Math.random().toString(36).slice(2,8);
      const preview = e.content.slice(0, 100).replace(/\n/g,' ');
      return `
        <div style="margin-bottom:4px">
          <span style="color:var(--muted);font-size:10px">${e.ts}</span>
          <span style="color:${color};margin:0 6px">${icon} <span style="color:${labelColor}">${label}</span></span>
          <span style="color:${color};cursor:pointer;font-size:10px" onclick="togglePL('${id}')">${escHtml(preview)}… <span style="opacity:0.5">[expand]</span></span>
        </div>
        <div id="${id}" style="display:none;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px;white-space:pre-wrap;color:var(--text);font-size:10px;max-height:300px;overflow-y:auto">${escHtml(e.content)}</div>
      `;
    }

    // Memory suggestion: show approve/reject buttons
    if (e.type === 'memory') {
      const id = 'pl_mem_' + i;
      const suggest = e.extra || {};
      return `
        <div style="margin-bottom:6px">
          <span style="color:var(--muted);font-size:10px">${e.ts}</span>
          <span style="color:${color};margin:0 6px">${icon} <span style="color:${labelColor}">${label}</span></span>
          <span style="color:var(--text);">${escHtml(String(e.content || ''))}</span>
          <div style="margin-top:6px">
            <button class="btn btn-sm" onclick="confirmMemory(${i})">Approve</button>
            <button class="btn btn-sm" style="margin-left:6px" onclick="rejectMemory(${i})">Reject</button>
          </div>
        </div>
      `;
    }

    // If an 'extra' object/array was provided, show a details toggle
    if (e.extra) {
      const id = 'pl_extra_' + i;
      const pretty = escHtml(JSON.stringify(e.extra, null, 2));
      return `
        <div style="margin-bottom:3px">
          <span style="color:var(--muted);font-size:10px">${e.ts}</span>
          <span style="color:${color}">${icon} <span style="color:${labelColor}">${label}</span></span>
          <span style="color:var(--text);margin-left:8px">${escHtml(String(e.content || ''))}</span>
          <span style="color:var(--muted);cursor:pointer;margin-left:8px;font-size:10px" onclick="togglePL('${id}')">[details]</span>
        </div>
        <pre id="${id}" style="display:none;background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:8px;margin-bottom:6px;color:var(--muted);font-size:11px;max-height:300px;overflow:auto">${pretty}</pre>
      `;
    }

    return `<div style="margin-bottom:3px"><span style="color:var(--muted);font-size:10px">${e.ts}</span> <span style="color:${color}">${icon} <span style="color:${labelColor}">${label}</span></span>  <span style="color:var(--text)">${escHtml(String(e.content || ''))}</span></div>`;
  }).join('');

  if (shouldFollow) el.scrollTop = el.scrollHeight;
}

function togglePL(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function isFailedTurnReply(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return true;
  if (/^blocked\b/.test(t)) return true;
  if (/^no response received\.?$/.test(t)) return true;
  if (/^connection error:/.test(t)) return true;
  if (/^sorry, i didn'?t catch that/.test(t)) return true;
  if (/could not|couldn't/.test(t) && /(verify|format|synthes|extract|read|write|tool|request)/.test(t)) return true;
  return false;
}

// ---- Send chat (SSE version) ----
// ---- Attachments & document write preview ----
let pendingAttachments = [];
let activeDocPreview = null;

async function handleAttachFile(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const chips = document.getElementById('attach-chips');
  if (chips) chips.style.opacity = '0.5';
  try {
    const res = await fetch('/api/files?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    pendingAttachments.push({ name: data.name, path: data.path });
    renderAttachChips();
    addProcessEntry('result', 'Uploaded ' + data.name + ' (' + data.bytes + ' bytes) -> ' + data.path);
  } catch (err) {
    addProcessEntry('error', 'Upload failed: ' + (err && err.message ? err.message : err));
  } finally {
    if (chips) chips.style.opacity = '';
    input.value = '';
  }
}

function renderAttachChips() {
  const box = document.getElementById('attach-chips');
  if (!box) return;
  if (!pendingAttachments.length) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'flex';
  box.innerHTML = pendingAttachments.map(function (a, i) {
    return (
      '<span class="attach-chip"><span class="chip-name">' + escHtml(a.name) + '</span>' +
      '<a href="/api/files?path=' + encodeURIComponent(a.path) + '" title="Download" download>\u2193</a>' +
      '<span class="chip-x" onclick="removeAttachment(' + i + ')" title="Close">\u00d7</span></span>'
    );
  }).join('');
}

function removeAttachment(index) {
  pendingAttachments.splice(index, 1);
  renderAttachChips();
}

function clearAttachments() {
  pendingAttachments = [];
  renderAttachChips();
}

function inlinePreviewText(value) {
  let text = escHtml(String(value == null ? '' : value));
  text = text.replace(/`([^`]+)`/g, '<code class="dp-code">$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return text;
}

function showDocPreview(event) {
  const panel = document.getElementById('doc-preview-panel');
  if (!panel) return;
  activeDocPreview = {
    previewId: String(event.preview_id || ''),
    path: String(event.path || ''),
  };
  const blocks = Array.isArray(event.blocks) ? event.blocks : [];
  let html = '';
  html += '<div class="dp-head"><div class="dp-title">Write preview</div>' +
    '<span style="cursor:pointer;font-weight:800;font-size:16px" onclick="dismissDocPreview()" title="Close">\u00d7</span></div>';
  html += '<div class="dp-sub">' + escHtml(activeDocPreview.path) +
    ' &nbsp;\u2022&nbsp; <code class="dp-code">' + escHtml(activeDocPreview.previewId) + '</code></div>';

  for (const block of blocks) {
    if (block.kind === 'heading') {
      html += '<div class="dp-h">' + inlinePreviewText(block.text) + '</div>';
    } else if (block.kind === 'text') {
      html += '<div class="dp-t">' + inlinePreviewText(block.text) + '</div>';
    } else if (block.kind === 'table') {
      const headers = Array.isArray(block.headers) ? block.headers : [];
      const rows = Array.isArray(block.rows) ? block.rows : [];
      const cols = Math.max(headers.length, rows.reduce(function (m, r) { return Math.max(m, (r || []).length); }, 0));
      html += '<div class="dp-tablewrap"><table class="dp-table"><thead><tr>';
      for (let c = 0; c < headers.length; c++) html += '<th>' + inlinePreviewText(headers[c]) + '</th>';
      html += '</tr></thead><tbody>';
      for (const row of rows) {
        const cells = Array.isArray(row) ? row : [];
        const changed = cells.some(function (cell) { return String(cell || '').indexOf('**') !== -1; });
        html += '<tr>';
        for (let c = 0; c < cols; c++) {
          html += '<td class="' + (changed ? 'changed' : '') + '">' + inlinePreviewText(cells[c]) + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';
    }
  }

  html += '<div class="dp-actions">' +
    '<button class="dp-btn primary" id="dp-apply-btn" onclick="applyDocPreview()">Write file</button>' +
    '<button class="dp-btn" onclick="dismissDocPreview()">Keep view only</button>' +
    '</div>';
  html += '<div class="dp-status" id="dp-status" style="display:none"></div>';

  panel.innerHTML = html;
  panel.style.display = 'block';
  panel.scrollTop = 0;
}

function setDocPreviewStatus(text, kind) {
  const el = document.getElementById('dp-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'dp-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

async function applyDocPreview() {
  if (!activeDocPreview || !activeDocPreview.previewId) return;
  const btn = document.getElementById('dp-apply-btn');
  if (btn) btn.disabled = true;
  setDocPreviewStatus('Writing file...', '');
  try {
    const res = await fetch('/api/doc/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preview_id: activeDocPreview.previewId }),
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.ok) throw new Error(data.error || data.result || ('HTTP ' + res.status));
    setDocPreviewStatus('Written: ' + activeDocPreview.path, 'ok');
    addProcessEntry('result', 'doc_write applied -> ' + activeDocPreview.path);
    if (btn) btn.style.display = 'none';
  } catch (err) {
    setDocPreviewStatus('Write failed: ' + (err && err.message ? err.message : err), 'err');
    if (btn) btn.disabled = false;
  }
}

function dismissDocPreview() {
  const panel = document.getElementById('doc-preview-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.innerHTML = '';
  }
  activeDocPreview = null;
}

// ---- Plan mode (plan_submit -> approve / reject) ----
let planState = { enabled: false, approved: false, pending: false };
let activePlanRequest = null;

async function apiJson(url, opts) {
  try {
    const res = await fetch(url, opts);
    const data = await res.json().catch(function () { return {}; });
    return { ok: res.ok && data.ok !== false, status: res.status, data: data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: String(err && err.message ? err.message : err) } };
  }
}

function renderPlanPill() {
  const label = document.getElementById('plan-pill-label');
  const pill = document.getElementById('plan-pill');
  if (!label || !pill) return;
  if (!planState.enabled) {
    label.textContent = '计划: 关';
    pill.style.background = '';
    pill.style.color = '';
    pill.style.borderColor = '';
  } else if (planState.pending) {
    label.textContent = '计划: 待审批';
    pill.style.background = 'var(--plan-warn-bg)';
    pill.style.color = 'var(--plan-warn-fg)';
    pill.style.borderColor = 'var(--plan-warn-bd)';
  } else if (planState.approved) {
    label.textContent = '计划: 已批准';
    pill.style.background = 'var(--plan-ok-bg)';
    pill.style.color = 'var(--plan-ok-fg)';
    pill.style.borderColor = 'var(--plan-ok-bd)';
  } else {
    label.textContent = '计划: 开';
    pill.style.background = 'var(--plan-on-bg)';
    pill.style.color = 'var(--sel-text)';
    pill.style.borderColor = 'var(--plan-on-bd)';
  }
}

async function loadPlanState() {
  const res = await apiJson('/api/plan?sessionId=' + encodeURIComponent(activeChatSessionId || 'default'));
  if (res.ok && res.data && res.data.state) {
    planState = {
      enabled: !!res.data.state.enabled,
      approved: !!res.data.state.approved,
      pending: !!res.data.state.pending,
    };
    if (res.data.pending) activePlanRequest = res.data.pending;
    renderPlanPill();
  }
}

async function togglePlanMode() {
  const next = !planState.enabled;
  const res = await apiJson('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: activeChatSessionId || 'default', action: next ? 'enable' : 'disable' }),
  });
  if (res.ok) {
    planState.enabled = next;
    planState.approved = next ? false : planState.approved;
    if (!next) hidePlanPanel();
    renderPlanPill();
    addProcessEntry('info', next
      ? 'Plan mode enabled: the assistant must submit a plan and wait for your approval.'
      : 'Plan mode disabled.');
  }
}

function showPlanRequest(event) {
  const panel = document.getElementById('plan-panel');
  if (!panel) return;
  activePlanRequest = {
    summary: String(event.summary || ''),
    steps: Array.isArray(event.steps) ? event.steps : [],
    sessionId: String(event.session_id || activeChatSessionId || 'default'),
  };
  planState.pending = true;
  renderPlanPill();

  let html = '<div class="dp-head"><div class="dp-title">Plan approval</div>' +
    '<span style="cursor:pointer;font-weight:800;font-size:16px" onclick="hidePlanPanel()" title="Close">\u00d7</span></div>';
  html += '<div class="dp-t" style="font-weight:700">' + escHtml(activePlanRequest.summary) + '</div>';
  if (activePlanRequest.steps.length) {
    html += '<ol style="margin:8px 0 0 18px;padding:0;font-size:12.5px;line-height:1.7;color:var(--text)">';
    for (let i = 0; i < activePlanRequest.steps.length; i++) {
      html += '<li>' + escHtml(activePlanRequest.steps[i]) + '</li>';
    }
    html += '</ol>';
  }
  html += '<div class="dp-actions">' +
    '<button class="dp-btn primary" id="plan-approve-btn" onclick="resolvePlan(true)">Approve</button>' +
    '<button class="dp-btn" id="plan-reject-btn" onclick="resolvePlan(false)">Reject</button>' +
    '<span class="dp-sub" style="margin:0 0 0 4px">Files stay untouched until you approve.</span>' +
    '</div>';
  html += '<div class="dp-status" id="plan-status" style="display:none"></div>';
  panel.innerHTML = html;
  panel.style.display = 'block';
  panel.scrollTop = 0;
}

function setPlanStatus(text, kind) {
  const el = document.getElementById('plan-status');
  if (!el) return;
  el.style.display = 'block';
  el.className = 'dp-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

async function resolvePlan(approved) {
  const btn = document.getElementById(approved ? 'plan-approve-btn' : 'plan-reject-btn');
  if (btn) btn.disabled = true;
  setPlanStatus(approved ? 'Approving...' : 'Rejecting...', '');
  const res = await apiJson('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: (activePlanRequest && activePlanRequest.sessionId) || activeChatSessionId || 'default',
      action: approved ? 'approve' : 'reject',
    }),
  });
  if (res.ok) {
    planState.pending = false;
    planState.approved = !!approved;
    renderPlanPill();
    setPlanStatus(approved ? 'Plan approved - execution continues.' : 'Plan rejected.', approved ? 'ok' : 'err');
    addProcessEntry(approved ? 'result' : 'info', approved ? 'Plan approved by user.' : 'Plan rejected by user.');
    if (btn) btn.style.display = 'none';
    setTimeout(hidePlanPanel, 900);
  } else {
    setPlanStatus('Failed: ' + ((res.data && res.data.error) || ('HTTP ' + res.status)), 'err');
    if (btn) btn.disabled = false;
  }
}

function hidePlanPanel() {
  const panel = document.getElementById('plan-panel');
  if (panel) {
    panel.style.display = 'none';
    panel.innerHTML = '';
  }
  activePlanRequest = null;
}

// ---- Artifacts panel: workspace files, changes with diffs, previews ----
let artifactsOpen = false;
let artifactsTab = 'files';
let artifactsPath = '.';

function toggleArtifacts() {
  artifactsOpen = !artifactsOpen;
  const panel = document.getElementById('artifacts-panel');
  const btn = document.getElementById('artifacts-toggle-btn');
  if (!panel) return;
  if (artifactsOpen) {
    panel.style.display = 'flex';
    if (btn) { btn.style.background = 'var(--sel-bg)'; btn.style.borderColor = 'var(--sel-border)'; btn.style.color = 'var(--sel-text)'; }
    setArtifactsTab(artifactsTab);
    refreshArtifacts();
  } else {
    panel.style.display = 'none';
    if (btn) { btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = ''; }
    closeArtifactsPreview();
  }
}

function setArtifactsTab(tab) {
  artifactsTab = tab === 'changes' ? 'changes' : 'files';
  const filesBtn = document.getElementById('art-tab-files');
  const changesBtn = document.getElementById('art-tab-changes');
  const filesView = document.getElementById('art-files-view');
  const changesView = document.getElementById('art-changes-view');
  if (filesBtn) {
    filesBtn.style.color = artifactsTab === 'files' ? 'var(--brand)' : 'var(--muted)';
    filesBtn.style.borderBottom = artifactsTab === 'files' ? '2px solid var(--brand)' : '2px solid transparent';
  }
  if (changesBtn) {
    changesBtn.style.color = artifactsTab === 'changes' ? 'var(--brand)' : 'var(--muted)';
    changesBtn.style.borderBottom = artifactsTab === 'changes' ? '2px solid var(--brand)' : '2px solid transparent';
  }
  if (filesView) filesView.style.display = artifactsTab === 'files' ? 'block' : 'none';
  if (changesView) changesView.style.display = artifactsTab === 'changes' ? 'block' : 'none';
  refreshArtifacts();
}

async function refreshArtifacts() {
  if (artifactsTab === 'files') loadArtifactsFiles(artifactsPath);
  else loadArtifactsChanges();
}

function fmtBytes(n) {
  const num = Number(n) || 0;
  if (num < 1024) return num + ' B';
  if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
  return (num / (1024 * 1024)).toFixed(1) + ' MB';
}

async function loadArtifactsFiles(dirPath) {
  const view = document.getElementById('art-files-view');
  if (!view) return;
  artifactsPath = dirPath || '.';
  view.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px">Loading...</div>';
  const res = await apiJson('/api/fs?path=' + encodeURIComponent(artifactsPath));
  if (!res.ok || !res.data || !res.data.entries) {
    view.innerHTML = '<div style="font-size:12px;color:#9c1a1a;padding:8px">' +
      escHtml((res.data && res.data.error) || 'Failed to list workspace') + '</div>';
    return;
  }
  let html = '';
  if (artifactsPath !== '.') {
    const parent = artifactsPath.split('/').slice(0, -1).join('/') || '.';
    html += '<div class="art-row art-dir" onclick="loadArtifactsFiles(\'' + escHtml(parent).replace(/'/g, "\\'") + '\')">' +
      '<span class="art-icon">&#8617;</span><span class="art-name">..</span></div>';
  }
  for (const entry of res.data.entries) {
    const isDir = entry.type === 'dir';
    const safePath = String(entry.path || '').replace(/\\/g, '/');
    if (isDir) {
      html += '<div class="art-row art-dir" onclick="loadArtifactsFiles(\'' + escHtml(safePath).replace(/'/g, "\\'") + '\')">' +
        '<span class="art-icon">&#128193;</span><span class="art-name">' + escHtml(entry.name) + '</span></div>';
    } else {
      html += '<div class="art-row" onclick="openArtifactsPreview(\'' + escHtml(safePath).replace(/'/g, "\\'") + '\', ' + Number(entry.bytes || 0) + ')">' +
        '<span class="art-icon">&#128196;</span><span class="art-name">' + escHtml(entry.name) + '</span>' +
        '<span class="art-size">' + fmtBytes(entry.bytes) + '</span></div>';
    }
  }
  if (!res.data.entries.length) html = '<div style="font-size:12px;color:var(--muted);padding:8px">Empty folder</div>';
  view.innerHTML = html;
}

const TEXT_PREVIEW_EXT = ['txt', 'md', 'csv', 'json', 'log', 'js', 'ts', 'css', 'html', 'py', 'yml', 'yaml', 'xml', 'ini', 'cfg', 'sh', 'ps1'];
const IMAGE_PREVIEW_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];

function extOf(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

async function openArtifactsPreview(filePath, bytes) {
  const wrap = document.getElementById('art-preview');
  const frame = document.getElementById('art-preview-frame');
  const nameEl = document.getElementById('art-preview-name');
  const metaEl = document.getElementById('art-preview-meta');
  const dl = document.getElementById('art-preview-download');
  if (!wrap || !frame) return;
  const ext = extOf(filePath);
  const name = String(filePath).split('/').pop();
  if (nameEl) nameEl.textContent = filePath;
  if (dl) {
    dl.href = '/api/files?path=' + encodeURIComponent(filePath);
    dl.setAttribute('download', name);
  }
  if (metaEl) metaEl.textContent = (ext ? ext.toUpperCase() + ' \u2022 ' : '') + fmtBytes(bytes || 0);

  const inlineable = IMAGE_PREVIEW_EXT.includes(ext) || ['pdf', 'html', 'htm'].includes(ext);
  if (inlineable) {
    frame.src = '/api/files?path=' + encodeURIComponent(filePath) + '&inline=1';
    wrap.style.display = 'flex';
    return;
  }
  if (TEXT_PREVIEW_EXT.includes(ext)) {
    try {
      const res = await fetch('/api/files?path=' + encodeURIComponent(filePath) + '&inline=1');
      const text = await res.text();
      const escaped = escHtml(text).replace(/\t/g, '    ');
      frame.removeAttribute('src');
      frame.srcdoc = '<!doctype html><html><body style="margin:0"><pre style="font-family:Consolas,monospace;font-size:12.5px;line-height:1.6;padding:14px;white-space:pre-wrap;word-break:break-word">' + escaped + '</pre></body></html>';
      wrap.style.display = 'flex';
      return;
    } catch {}
  }
  // Fallback: offer a download only (binary Office formats etc.)
  frame.removeAttribute('src');
  frame.srcdoc = '<!doctype html><html><body style="font-family:Manrope,sans-serif;padding:24px;color:#444">' +
    '<h3 style="margin:0 0 8px">' + escHtml(name) + '</h3>' +
    '<p style="font-size:13px">No inline preview for this format. Use <b>Download</b> to open it locally, ' +
    'or ask the assistant to inspect it with <code>doc_read</code>.</p></body></html>';
  wrap.style.display = 'flex';
}

function closeArtifactsPreview() {
  const wrap = document.getElementById('art-preview');
  const frame = document.getElementById('art-preview-frame');
  if (wrap) wrap.style.display = 'none';
  if (frame) {
    frame.removeAttribute('src');
    try { frame.srcdoc = ''; } catch {}
  }
}

function diffLines(before, after) {
  const a = String(before == null ? '' : before).split('\n');
  const b = String(after == null ? '' : after).split('\n');
  const out = [];
  const max = Math.max(a.length, b.length);
  let i = 0;
  let j = 0;
  // Simple line diff: advance through matching lines, mark the rest as changed.
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++; j++;
      continue;
    }
    const nextMatchA = a.indexOf(b[j] === undefined ? '\u0000' : b[j], i + 1);
    const nextMatchB = b.indexOf(a[i] === undefined ? '\u0000' : a[i], j + 1);
    if (j < b.length && (nextMatchA === -1 || (nextMatchB !== -1 && nextMatchB - j <= nextMatchA - i))) {
      out.push({ kind: 'add', text: b[j] });
      j++;
    } else if (i < a.length) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    }
    if (out.length > 4000) break;
  }
  return out;
}

async function loadArtifactsChanges() {
  const view = document.getElementById('art-changes-view');
  if (!view) return;
  view.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px">Loading...</div>';
  const res = await apiJson('/api/artifacts?sessionId=' + encodeURIComponent(activeChatSessionId || 'default'));
  const items = res.ok && Array.isArray(res.data.artifacts) ? res.data.artifacts : [];
  if (!items.length) {
    view.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px">本次会话暂无文件变更记录。</div>';
    return;
  }
  let html = '';
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const time = new Date(item.at || Date.now()).toLocaleTimeString();
    const paths = (item.paths || []).map(p => '<code class="dp-code">' + escHtml(String(p).split(/[\\/]/).pop()) + '</code>').join(' ');
    html += '<div class="art-change" style="border:1px solid var(--line);border-radius:10px;margin-bottom:8px;overflow:hidden">';
    html += '<div style="display:flex;gap:8px;align-items:center;padding:7px 10px;background:var(--panel-2);font-size:11px">' +
      '<b>' + escHtml(item.tool || '') + '</b><span style="color:var(--muted)">' + time + '</span>' + paths + '</div>';
    if (typeof item.before === 'string' && typeof item.after === 'string') {
      const lines = diffLines(item.before, item.after).slice(0, 400);
      html += '<div style="font-family:Consolas,monospace;font-size:11.5px;line-height:1.55;padding:6px 0;max-height:260px;overflow:auto">';
      for (const line of lines) {
        const cls = line.kind === 'add' ? 'art-add' : line.kind === 'del' ? 'art-del' : '';
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
        html += '<div class="' + cls + '" style="white-space:pre-wrap;word-break:break-word;padding:0 10px;' +
          (line.kind === 'add' ? 'background:#e8f8ee;color:#12633a' : line.kind === 'del' ? 'background:#fdecec;color:#9c1a1a' : 'color:var(--muted)') +
          '">' + sign + ' ' + escHtml(line.text) + '</div>';
      }
      html += '</div>';
    } else {
      html += '<div style="padding:8px 10px;font-size:11.5px;color:var(--muted);white-space:pre-wrap;word-break:break-word">' +
        escHtml(String(item.summary || '').slice(0, 400)) + '</div>';
    }
    html += '</div>';
  }
  view.innerHTML = html;
}

// ---- Selection -> chat (select text in previews/messages, send it as context) ----
function sendSelectionToChat() {
  const sel = window.getSelection ? String(window.getSelection()) : '';
  const text = String(sel || '').trim();
  if (!text) return;
  const input = document.getElementById('chat-input');
  if (!input) return;
  const quoted = text.split('\n').slice(0, 30).map(l => '> ' + l).join('\n');
  const prompt = 'Selected text:\n\n' + quoted + '\n\nPlease edit/replace this selected part:';
  input.value = prompt;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  input.focus();
  const btn = document.getElementById('sel-edit-btn');
  if (btn) btn.style.display = 'none';
  addProcessEntry('info', 'Selection sent to the chat input.');
}

function updateSelectionAffordance() {
  const btn = document.getElementById('sel-edit-btn');
  if (!btn) return;
  const sel = window.getSelection ? window.getSelection() : null;
  const text = sel ? String(sel).trim() : '';
  if (!text || text.length < 3) {
    btn.style.display = 'none';
    return;
  }
  const anchor = sel.getRangeAt(0).getBoundingClientRect();
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = 'flex';
  const top = Math.max(8, anchor.bottom + window.scrollY - 96);
  const left = Math.min(Math.max(8, anchor.left + window.scrollX), window.innerWidth - 210);
  btn.style.top = top + 'px';
  btn.style.left = left + 'px';
}

async function sendChat(queuedMessage = null) {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  let raw = typeof queuedMessage === 'string' ? queuedMessage : input.value;
  if (pendingAttachments.length && typeof queuedMessage !== 'string') {
    raw = String(raw || '') + pendingAttachments.map(a => '\n\n[attached file] ' + a.path).join('');
    clearAttachments();
  }
  const message = String(raw || '').trim();
  if (!message) return;
  if (isThinking) {
    if (typeof queuedMessage === 'string') return;
    if (queuedPrompts.length >= MAX_QUEUED_PROMPTS) {
      addProcessEntry('warn', `Queue full (${MAX_QUEUED_PROMPTS}). Wait for current run to finish.`);
      return;
    }
    queuedPrompts.push(message);
    addProcessEntry('info', `Queued prompt #${queuedPrompts.length}. It will run automatically next.`);
    input.value = '';
    input.style.height = 'auto';
    updateQueuedPromptUI();
    return;
  }

  chatHistory.push({ role: 'user', content: message });
  persistActiveChat();
  if (typeof queuedMessage !== 'string') {
    input.value = '';
    input.style.height = 'auto';
  }
  isThinking = true;
  streamingSessionId = activeChatSessionId; // lock bubble to this session
  setButtonState(true);
  currentPreflightStatus = '';
  currentProgressLines = [];
  liveTaskSteps = [];
  lastHeartbeat = {
    state: 'running',
    level: '',
    current_step: 'dispatch',
    retry_count: 0,
    format_violation_count: 0,
    message: 'Turn started',
  };
  lastHeartbeatLogSignature = '';
  processLogAutoFollow = true;
  rightColumnAutoFollow = true;
  updateHeartbeatUI();
  renderLiveStepsPanel();
  sendBtn.disabled = false;
  updateQueuedPromptUI();
  renderChatMessages();
  maybeAutoScrollRightColumn(true);

  currentTurnStartIndex = processLogEntries.length;
  addProcessEntry('user', message);

  const historyForAPI = chatHistory.slice(-13, -1).map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content
  }));

  const allSteps = [];
  let finalReply = '';
  let finalArtifacts = [];
  const turnThinkingBuffer = [];
  const turnThinkingSeen = new Set();
  let sawExecuteModeThisTurn = false;
  let sawToolActivityThisTurn = false;
  const collectTurnThinking = (value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key || turnThinkingSeen.has(key)) return;
    turnThinkingSeen.add(key);
    turnThinkingBuffer.push(text);
  };

  try {
    // Use SSE fetch — stream steps live as they arrive
    currentAbortController = new AbortController();
    let partialContent = '';

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream'
      },
      signal: currentAbortController.signal,
      body: JSON.stringify({ message, history: historyForAPI, sessionId: agentSessionId, pinnedMessages: confirmedPins.length > 0 ? confirmedPins : undefined })
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let event;
        try { event = JSON.parse(line.slice(6)); } catch { continue; }

        switch (event.type) {
          case 'agent_mode':
            lastAgentMode = event.mode || '-';
            lastTurnKind = event.turnKind || lastTurnKind;
            if (event.mode === 'execute') sawExecuteModeThisTurn = true;
            addProcessEntry(
              'info',
              `Agent mode: ${event.mode || 'unknown'}${event.turnKind ? ` (${event.turnKind})` : ''}${event.switched_from ? ` | switched_from=${event.switched_from}` : ''}${event.route_target ? ` | route_target=${event.route_target}` : ''}${event.trigger ? ` | trigger=${event.trigger}` : ''}`
            );
            if (event.mode === 'execute') renderLiveStepsPanel();
            loadAgentSessionContext();
            break;

          case 'session_mode_locked':
            addProcessEntry('info', `Session mode locked: ${event.mode || 'unknown'}`);
            break;

          case 'decomposed':
            addProcessEntry('split', `Split into ${event.questions.length} sub-questions: ${event.questions.map((q,i) => `Q${i+1}: ${q.slice(0,40)}`).join(' | ')}`);
            break;

          case 'thinking':
            if (event.thinking && String(event.thinking).trim()) {
              const thinkingText = String(event.thinking).trim();
              collectTurnThinking(thinkingText);
              addProcessEntry('think', thinkingText);
            }
            break;

          case 'info':
            if (event.message) addProcessEntry('info', String(event.message));
            break;

          case 'stats':
            if (event && Number(event.tokens_per_second) > 0) {
              const el = document.getElementById('gen-stats');
              if (el) {
                const tps = Number(event.tokens_per_second).toFixed(1);
                const ct = Number(event.completion_tokens) || 0;
                const pt = Number(event.prompt_tokens) || 0;
                el.textContent = `${tps} tok/s · ${ct} tok 出 · ${pt} tok 入`;
              }
            }
            break;

          case 'heartbeat': {
            lastHeartbeat = {
              ...lastHeartbeat,
              state: event.state || lastHeartbeat.state,
              level: event.level || lastHeartbeat.level,
              current_step: event.current_step || lastHeartbeat.current_step,
              retry_count: Number(event.retry_count || lastHeartbeat.retry_count || 0),
              format_violation_count: Number(event.format_violation_count || lastHeartbeat.format_violation_count || 0),
              message: event.message || lastHeartbeat.message || '',
            };
            updateHeartbeatUI();
            const sig = `${lastHeartbeat.state}|${lastHeartbeat.level}|${lastHeartbeat.current_step}|${lastHeartbeat.retry_count}|${lastHeartbeat.format_violation_count}`;
            if (sig !== lastHeartbeatLogSignature) {
              const level = String(lastHeartbeat.level || '').toLowerCase();
              const text = String(lastHeartbeat.message || `state=${lastHeartbeat.state} step=${lastHeartbeat.current_step}`).trim();
              addProcessEntry(level === 'hard' ? 'warn' : 'info', `Heartbeat: ${text}`);
              lastHeartbeatLogSignature = sig;
            }
            break;
          }

          case 'ui_preflight':
            if (event.message) {
              currentPreflightStatus = String(event.message);
              pushProgressLine(currentPreflightStatus);
              renderChatMessages();
            }
            break;

          case 'tool_call': {
            const action = String(event.action || '').trim();
            const stepNum = Number(event.stepNum || 0);
            const args = (event.args && typeof event.args === 'object') ? event.args : null;
            const argsPreview = args ? JSON.stringify(args).slice(0, 260) : '';
            const syntheticTag = event.synthetic ? ' [synthetic]' : '';
            sawToolActivityThisTurn = true;
            if (action) pushProgressLine(`${stepNum ? `Step ${stepNum}: ` : ''}Running ${action}...`);
            upsertLiveStep(action || 'tool', stepNum || (liveTaskSteps.length + 1), 'in_progress', 'running');
            if (action) {
              addProcessEntry(
                'tool',
                `${stepNum ? `Step ${stepNum}: ` : ''}${action}${syntheticTag}${argsPreview ? ` ${argsPreview}` : ''}`,
                args || undefined,
              );
            }
            break;
          }

          case 'tool_result': {
            const action = String(event.action || '').trim();
            const stepNum = Number(event.stepNum || 0);
            sawToolActivityThisTurn = true;
            const text = String(event.result || '');
            const ok = event.error === true ? false : !/^ERROR:/i.test(text);
            const syntheticTag = event.synthetic ? ' [synthetic]' : '';
            if (action) pushProgressLine(`${stepNum ? `Step ${stepNum}: ` : ''}${action} ${ok ? 'complete' : 'failed'}`);
            upsertLiveStep(action || 'tool', stepNum || (liveTaskSteps.length + 1), ok ? 'done' : 'failed', ok ? 'completed' : text.slice(0, 120));
            addProcessEntry(
              ok ? 'result' : 'error',
              `${stepNum ? `Step ${stepNum}: ` : ''}${action || 'tool'}${syntheticTag} => ${text || '(no output)'}`,
            );
            loadAgentSessionContext();
            break;
          }

          case 'doc_preview': {
            showDocPreview(event);
            addProcessEntry('info', `Document write preview for ${event.path || ''} — waiting for approval.`);
            break;
          }

          case 'plan_request': {
            showPlanRequest(event);
            addProcessEntry('info', 'Plan submitted — waiting for your approval.');
            break;
          }

          case 'orchestration': {
            try {
              if (typeof window !== 'undefined' && typeof window._orchEventHandler === 'function') {
                window._orchEventHandler(event);
              }
            } catch {}
            const trigger = String(event.trigger || 'unknown');
            const mode = String(event.mode || 'rescue');
            const route = event.route ? ` | route=${event.route}` : '';
            const reason = event.reason ? ` | ${event.reason}` : '';
            const cap = (Number.isFinite(Number(event.assist_count)) && Number.isFinite(Number(event.assist_cap)))
              ? ` | assists ${event.assist_count}/${event.assist_cap}`
              : '';
            addProcessEntry('info', `Orchestrator: trigger=${trigger} mode=${mode}${route}${reason}${cap}`, event);
            if (event.preflight?.quick_plan?.length) {
              addProcessEntry('info', `Orchestrator plan: ${event.preflight.quick_plan[0]}`);
            } else if (event.advice?.next_actions?.length) {
              addProcessEntry('info', `Orchestrator next: ${event.advice.next_actions[0]}`);
            }
            const preflightRaw = String(event.preflight?.raw_response || '').trim();
            if (preflightRaw) {
              addProcessEntry('think', `[Secondary AI preflight raw response]\n${preflightRaw}`);
            }
            const adviceRaw = String(event.advice?.raw_response || '').trim();
            if (adviceRaw) {
              addProcessEntry('think', `[Secondary AI advisor raw response]\n${adviceRaw}`);
            }
            break;
          }

          case 'browser_advisor_start': {
            const pageType = event.page_type ? ` type=${event.page_type}` : '';
            const count = Number.isFinite(Number(event.extracted_count)) ? ` | extracted=${event.extracted_count}` : '';
            addProcessEntry('info', `Browser advisor start:${pageType}${count}`);
            break;
          }

          case 'feed_collected': {
            const b = Number(event.batch || 0);
            const added = Number(event.added || 0);
            const total = Number(event.total || 0);
            const deduped = Number(event.deduped || 0);
            addProcessEntry('info', `Feed collected: batch ${b} | +${added} | total ${total} | deduped ${deduped}`);
            break;
          }

          case 'browser_advisor_route': {
            const route = String(event.route || 'unknown');
            const reason = event.reason ? ` | ${String(event.reason)}` : '';
            const cap = (Number.isFinite(Number(event.assist_count)) && Number.isFinite(Number(event.assist_cap)))
              ? ` | assists ${event.assist_count}/${event.assist_cap}`
              : '';
            const nextTool = event.next_tool?.tool ? ` | next=${event.next_tool.tool}` : '';
            addProcessEntry('info', `Browser advisor route=${route}${nextTool}${reason}${cap}`, event);
            const rawResponse = String(event.raw_response || '').trim();
            if (rawResponse) {
              addProcessEntry('think', `[Secondary AI browser advisor raw response]\n${rawResponse}`);
            }
            break;
          }

          case 'browser_advisor_nudge': {
            const route = event.route ? `[${event.route}] ` : '';
            const preview = String(event.preview || '').trim();
            if (preview) addProcessEntry('info', `Advisor nudge ${route}${preview}`);
            break;
          }

          case 'forced_retry': {
            const reason = String(event.reason || 'advisor requested continuation');
            const retry = Number(event.retry || 0);
            const max = Number(event.max_retries || 0);
            addProcessEntry('warn', `Forced retry ${retry}/${max}: ${reason}`);
            break;
          }

          case 'preempt_start': {
            const elapsedSec = Math.max(1, Math.round(Number(event.elapsed_ms || 0) / 1000));
            const thresholdSec = Math.max(1, Math.round(Number(event.threshold_ms || 0) / 1000));
            addProcessEntry('warn', `Preempt start: generation stalled ${elapsedSec}s (threshold ${thresholdSec}s).`);
            break;
          }

          case 'preempt_killed': {
            const restarted = event.restarted === true;
            const cap = (Number.isFinite(Number(event.preempts_session)) && Number.isFinite(Number(event.preempts_session_cap)))
              ? ` | preempts ${event.preempts_session}/${event.preempts_session_cap}`
              : '';
            addProcessEntry(restarted ? 'info' : 'warn', `Preempt kill/restart ${restarted ? 'completed' : 'failed'}${cap}`);
            break;
          }

          case 'preempt_ready': {
            const cap = (Number.isFinite(Number(event.preempts_session)) && Number.isFinite(Number(event.preempts_session_cap)))
              ? ` | preempts ${event.preempts_session}/${event.preempts_session_cap}`
              : '';
            addProcessEntry('info', `Preempt ready: Ollama online, running rescue advisor${cap}`);
            break;
          }

          case 'preempt_rescue': {
            const cap = (Number.isFinite(Number(event.assist_count)) && Number.isFinite(Number(event.assist_cap)))
              ? ` | assists ${event.assist_count}/${event.assist_cap}`
              : '';
            addProcessEntry('info', `Preempt rescue guidance injected${cap}`);
            break;
          }

          case 'preempt_retry':
            addProcessEntry('info', 'Preempt retry: re-running primary with rescue context.');
            break;

          case 'synthesizing':
            pushProgressLine(`Synthesizing ${Number(event.count || 1)} answer(s)...`);
            addProcessEntry('synth', `Combining ${event.count} answers...`);
            break;

          case 'step': {
            const s = event;
            allSteps.push(s);

            // Show step number
            if (s.stepNum && !s.isFormatViolation && !s.finalAnswer && !s.action) {
              // just a step counter with no other info — skip
            }

            // Thinking block
            if (s.thinking) {
              collectTurnThinking(s.thinking);
              addProcessEntry('think', s.thinking);
            }

            // Format violation
            if (s.isFormatViolation) {
              addProcessEntry('warn', 'Format violation — retrying');
              break;
            }

            // Tool call
            if (s.action && !s.toolResult) {
              sawToolActivityThisTurn = true;
              addProcessEntry('tool', `${s.action}  ${JSON.stringify(s.params || {}).slice(0, 100)}`);
              if (s.thought) addProcessEntry('info', s.thought);
            }

            // Tool result (same step object updated)
            if (s.action && s.toolResult) {
              sawToolActivityThisTurn = true;
              const toolText = typeof s.toolResult === 'string' ? s.toolResult : JSON.stringify(s.toolResult || '');
              const isErr = toolText.startsWith('ERROR');
              addProcessEntry(isErr ? 'error' : 'result', toolText);
              if (s.action === 'web_search') {
                const diag = s?.toolData?.search_diagnostics || s?.diagnostics || null;
                if (diag) {
                  const query = String(diag.query || s?.params?.query || '').trim();
                  if (query) addProcessEntry('info', `Search query: ${query}`);
                  if (Array.isArray(diag.attempted) && diag.attempted.length) {
                    const providers = diag.attempted.map(a => {
                      const p = String(a.provider || '').toLowerCase();
                      const status = String(a.status || '').toLowerCase();
                      if (status === 'success') {
                        const count = Number.isFinite(a.result_count) ? `, ${a.result_count} result${a.result_count === 1 ? '' : 's'}` : '';
                        return `${p}=success${count}`;
                      }
                      if (status === 'skipped') return `${p}=skipped${a.reason ? ` (${a.reason})` : ''}`;
                      return `${p}=failed${a.reason ? ` (${a.reason})` : ''}`;
                    }).join(' | ');
                    addProcessEntry('info', `Providers: ${providers}`);
                  }
                }
              }
            }

            // Final answer
            if (s.finalAnswer) {
              addProcessEntry('final', s.finalAnswer);
              partialContent = s.finalAnswer; // track for stop
            }
            break;
          }

          case 'memory_suggest':
            // event.suggestion: { fact, reference, source_tool, source_output, actor }
            const s = event.suggestion || {};
            addProcessEntry('memory', s.fact || '(memory suggestion)', s);
            addProcessEntry('info', 'A memory suggestion was created; approve to persist.');
            break;

          case 'memory_saved':
            addProcessEntry(event.ok ? 'result' : 'warn', event.ok
              ? `Memory updated${event.key ? ` (${event.key})` : ''}.`
              : 'Memory update failed.');
            break;

          case 'web_search_snippets':
            // event: { query, snippets }
            const q = event.query || '(search)';
            addProcessEntry('info', `Search results: ${q}`, event.snippets || []);
            if (event.diagnostics && Array.isArray(event.diagnostics.attempted)) {
              const providers = event.diagnostics.attempted.map(a => {
                const p = String(a.provider || '').toLowerCase();
                const status = String(a.status || '').toLowerCase();
                if (status === 'success') {
                  const count = Number.isFinite(a.result_count) ? `, ${a.result_count} result${a.result_count === 1 ? '' : 's'}` : '';
                  return `${p}=success${count}`;
                }
                if (status === 'skipped') return `${p}=skipped${a.reason ? ` (${a.reason})` : ''}`;
                return `${p}=failed${a.reason ? ` (${a.reason})` : ''}`;
              }).join(' | ');
              addProcessEntry('info', `Providers: ${providers}`);
            }
            break;

          case 'error':
            addProcessEntry('error', event.message);
            break;

          case 'done':
            finalReply = event.reply || '';
            if (finalReply) partialContent = finalReply;
            finalArtifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
            loadAgentSessionContext();
            renderLiveStepsPanel();
            break;

          case 'turn_execution_created':
          case 'turn_execution_updated':
            loadAgentSessionContext();
            break;
        }
      }
    }

    if (finalReply) {
      const finalStep = allSteps.find(s => s.finalAnswer);
      const mergedThinking = turnThinkingBuffer.join('\n\n').trim();
      const shouldAttachThinkingPanel = sawExecuteModeThisTurn || sawToolActivityThisTurn;
      const turnEntries = currentTurnStartIndex >= 0 ? processLogEntries.slice(currentTurnStartIndex) : [];
      chatHistory.push({
        role: 'ai',
        content: finalReply,
        artifacts: finalArtifacts,
        steps: allSteps,
        mode: 'chat',
        thinking: shouldAttachThinkingPanel ? (mergedThinking || finalStep?.thinking) : '',
        processEntries: turnEntries
      });
    } else {
      const turnEntries = currentTurnStartIndex >= 0 ? processLogEntries.slice(currentTurnStartIndex) : [];
      chatHistory.push({ role: 'ai', content: 'No response received.', processEntries: turnEntries });
    }
    persistActiveChat();

  } catch (err) {
    const turnEntries = currentTurnStartIndex >= 0 ? processLogEntries.slice(currentTurnStartIndex) : [];
    if (err.name === 'AbortError') {
      addProcessEntry('warn', 'Generation stopped by user.');
      const content = partialContent ||
        (allSteps.length ? `[Stopped — ${allSteps.length} step${allSteps.length !== 1 ? 's' : ''} completed]` : '[Generation stopped]');
      chatHistory.push({ role: 'ai', content, steps: allSteps, mode: 'chat', processEntries: turnEntries });
    } else {
      lastHeartbeat = { ...lastHeartbeat, state: 'stalled', level: 'hard', message: String(err.message || 'connection_error'), current_step: 'error' };
      updateHeartbeatUI();
      addProcessEntry('error', err.message);
      chatHistory.push({ role: 'ai', content: `Connection error: ${err.message}`, processEntries: turnEntries });
    }
    persistActiveChat();
  }

  isThinking = false;
  streamingSessionId = null; // release session lock
  currentAbortController = null;
  setButtonState(false);
  currentPreflightStatus = '';
  currentProgressLines = [];
  lastHeartbeat = { ...lastHeartbeat, state: 'idle', level: '', message: '', current_step: 'done' };
  updateHeartbeatUI();
  currentTurnStartIndex = -1;
  sendBtn.disabled = false;
  renderChatMessages();
  updateQueuedPromptUI();

  const shouldPauseQueue = isFailedTurnReply(finalReply || (chatHistory[chatHistory.length - 1]?.content || ''));
  if (queuedPrompts.length > 0 && shouldPauseQueue) {
    addProcessEntry('warn', 'Queue paused because the previous turn failed/blocked. Press Send to resume queued prompts.');
  } else if (queuedPrompts.length > 0) {
    const next = queuedPrompts.shift();
    updateQueuedPromptUI();
    addProcessEntry('info', `Auto-running queued prompt${queuedPrompts.length ? ` (${queuedPrompts.length} remaining)` : ''}.`);
    setTimeout(() => { sendChat(next); }, 0);
  }
}

// ---- Agent Execution Tracking ----
function spawnAgentExecution(agentName, taskPrompt, isSubagent = false) {
  const agentId = (isSubagent ? 'sub_' : 'main_') + (++agentIdCounter);
  const agentData = {
    id: agentId,
    name: agentName,
    status: AGENT_STATUS.ACTIVE,
    task: taskPrompt,
    logs: [],
    isSubagent: isSubagent,
    startTime: new Date(),
  };
  agentExecutionMap.set(agentId, agentData);
  renderAgentExecutionPanel();
  return agentId;
}

function addAgentLog(agentId, type, content) {
  const agentData = agentExecutionMap.get(agentId);
  if (!agentData) return;
  const ts = new Date().toLocaleTimeString();
  agentData.logs.push({ ts, type, content });
  // Keep only last 20 logs per agent
  if (agentData.logs.length > 20) agentData.logs.shift();
  renderAgentExecutionPanel();
}

function completeAgentExecution(agentId) {
  const agentData = agentExecutionMap.get(agentId);
  if (!agentData) return;
  agentData.status = AGENT_STATUS.COMPLETED;
  renderAgentExecutionPanel();
}

function pauseAgentExecution(agentId, reason) {
  const agentData = agentExecutionMap.get(agentId);
  if (!agentData) return;
  agentData.status = AGENT_STATUS.PAUSED;
  if (reason) addAgentLog(agentId, 'error', reason);
  renderAgentExecutionPanel();
}

function renderAgentExecutionPanel() {
  const panel = document.getElementById('agent-execution-panel');
  if (!panel) return;

  if (agentExecutionMap.size === 0) {
    panel.innerHTML = '<div style="padding:8px 12px;font-size:11px;color:var(--muted)">Waiting for task execution...</div>';
    return;
  }

  const agents = Array.from(agentExecutionMap.values()).sort((a, b) => a.startTime - b.startTime);
  panel.innerHTML = agents.map((agent) => {
    const statusClass = agent.status === AGENT_STATUS.ACTIVE ? 'active' : 
                        agent.status === AGENT_STATUS.COMPLETED ? 'completed' : 'paused';
    const arrow = agent.expanded ? '▼' : '▶';
    const logsHtml = agent.logs.length > 0
      ? agent.logs.map(log => `<div class="agent-log-entry"><span class="agent-log-entry-time">${escHtml(log.ts)}</span><span class="agent-log-entry-type">[${escHtml(log.type.toUpperCase())}]</span><span class="agent-log-entry-content">${escHtml(log.content)}</span></div>`).join('')
      : '<div style="color:var(--muted);opacity:0.6">暂无日志</div>';

    return `
      <div class="agent-item ${agent.expanded ? 'expanded' : ''}" onclick="toggleAgentPanel('${agent.id}')">
        <div class="agent-item-header">
          <span style="color:var(--muted);font-size:10px;min-width:12px">${arrow}</span>
          <div class="agent-item-name">${escHtml(agent.isSubagent ? '└─ ' + agent.name : agent.name)}</div>
          <div class="agent-item-status ${statusClass}">${agent.status.toUpperCase()}</div>
        </div>
        <div class="agent-item-task">${escHtml(agent.task.substring(0, 70))}${agent.task.length > 70 ? '...' : ''}</div>
        <div class="agent-item-logs">${logsHtml}</div>
      </div>
    `;
  }).join('');
}

function toggleAgentPanel(agentId) {
  const agentData = agentExecutionMap.get(agentId);
  if (!agentData) return;
  agentData.expanded = !agentData.expanded;
  renderAgentExecutionPanel();
}

function openProcessLogFile() {
  // Call server endpoint to open the process log file
  if (activeTaskId) {
    fetch(`/api/open-file?task=${encodeURIComponent(activeTaskId)}&type=process`)
      .catch(err => console.error('Unable to open process log:', err));
  }
}

function clearChat() {
  chatHistory = [];
  persistActiveChat();
  renderChatMessages();
  // Also clear the backend session history so a cleared conversation is not
  // re-injected from the persisted session JSON on a later turn.
  fetch('/api/clear-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: activeChatSessionId || 'default' }),
  }).catch(err => console.error('Failed to clear backend history:', err));
}

// ---- Draggable chat input height ----
(function initInputResizer() {
  const input = document.getElementById('chat-input');
  const bar = document.getElementById('input-resizer');
  if (!input || !bar) return;
  const KEY = 'sc-input-h';
  const saved = localStorage.getItem(KEY);
  if (saved) input.style.height = saved + 'px';
  let drag = null;
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    // Handle sits on the input's TOP edge: pulling up grows, pushing down shrinks
    const h = Math.min(Math.max(drag.startH - (e.clientY - drag.startY), 44), 600);
    input.style.height = h + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    localStorage.setItem(KEY, String(Math.round(input.getBoundingClientRect().height)));
    bar.classList.remove('active');
    drag = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    drag = { startY: e.clientY, startH: input.getBoundingClientRect().height };
    bar.classList.add('active');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
})();

// Enter to send, Shift+Enter for newline
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

// ---- Draggable column widths (sidebar | main | right) ----
(function initColResizers() {
  const root = document.documentElement;
  const KEY_S = 'sc-col-sidebar';
  const KEY_R = 'sc-col-right';
  const savedS = localStorage.getItem(KEY_S);
  const savedR = localStorage.getItem(KEY_R);
  if (savedS) root.style.setProperty('--col-sidebar', savedS + 'px');
  if (savedR) root.style.setProperty('--col-right', savedR + 'px');
  let drag = null;
  document.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    if (drag.side === 'sidebar') {
      const w = Math.min(Math.max(drag.start + dx, 150), 560);
      root.style.setProperty('--col-sidebar', w + 'px');
    } else {
      const w = Math.min(Math.max(drag.start - dx, 320), 1000);
      root.style.setProperty('--col-right', w + 'px');
    }
  });
  document.addEventListener('mouseup', () => {
    if (!drag) return;
    const el = drag.side === 'sidebar' ? document.querySelector('aside') : document.getElementById('right-panel');
    if (el) {
      const w = Math.round(el.getBoundingClientRect().width);
      if (drag.side === 'sidebar') localStorage.setItem(KEY_S, String(w));
      else localStorage.setItem(KEY_R, String(w));
    }
    if (drag.bar) drag.bar.classList.remove('active');
    drag = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
  document.querySelectorAll('.col-resizer').forEach((bar) => {
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const side = bar.getAttribute('data-side');
      // Read the panel's real rendered width (defaults may be calc/max() expressions)
      const el = side === 'sidebar' ? document.querySelector('aside') : document.getElementById('right-panel');
      const cur = el ? el.getBoundingClientRect().width : (side === 'sidebar' ? 280 : 520);
      drag = { side, startX: e.clientX, start: cur, bar };
      bar.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
  });
})();

// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

// ---- Knowledge base @-picker ----
// Clicking "@ 引用" on a KB file card drops "@name " into the chat input.
function insertKbRef(name) {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const base = String(name || '').replace(/\.[^.]+$/, '');
  inp.value = (inp.value ? inp.value.replace(/\s*$/, '') + ' ' : '') + '@' + base + ' ';
  inp.focus();
  inp.dispatchEvent(new Event('input'));
}

// Typing @ in the chat input shows a picker of knowledge base files.
const kbAtMenu = document.getElementById('kb-at-menu');
const kbAtInput = document.getElementById('chat-input');

function updateKbAtMenu() {
  if (!kbAtMenu || !kbAtInput) return;
  const v = kbAtInput.value;
  const lastAt = v.lastIndexOf('@');
  if (lastAt < 0) { kbAtMenu.style.display = 'none'; return; }
  const after = v.slice(lastAt + 1);
  if (!after || /[\s，。；、！？?？\n]/.test(after.slice(0, 1))) { kbAtMenu.style.display = 'none'; return; }
  if (!knowledgeFiles || knowledgeFiles.length === 0) { loadKnowledge(); kbAtMenu.style.display = 'none'; return; }
  const q = after.trim();
  const list = knowledgeFiles.filter((f) => !q || String(f.name).toLowerCase().includes(q.toLowerCase()));
  if (list.length === 0) { kbAtMenu.style.display = 'none'; return; }
  kbAtMenu.innerHTML = list.slice(0, 8).map((f) => {
    const base = String(f.name).replace(/\.[^.]+$/, '');
    return '<div class="kb-at-item" data-kb="' + escHtml(base) + '" title="' + escHtml(f.name) + '">' +
      '<span style="font-size:11px;color:var(--accent)">@</span> ' + escHtml(base) +
      '<span style="font-size:10px;color:var(--muted);margin-left:6px">' + (f.chunks || 0) + ' 分块</span>' +
      '</div>';
  }).join('');
  kbAtMenu.style.display = 'block';
}

function pickKbAt(item) {
  if (!kbAtInput || !item) return;
  const base = item.getAttribute('data-kb');
  const v = kbAtInput.value;
  const lastAt = v.lastIndexOf('@');
  kbAtInput.value = v.slice(0, lastAt) + '@' + base + ' ';
  kbAtInput.focus();
  kbAtMenu.style.display = 'none';
  kbAtInput.dispatchEvent(new Event('input'));
}

if (kbAtInput) {
  kbAtInput.addEventListener('input', updateKbAtMenu);
  kbAtInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (kbAtMenu) kbAtMenu.style.display = 'none'; return; }
    if (kbAtMenu && kbAtMenu.style.display !== 'none' && e.key === 'Tab') {
      const sel = kbAtMenu.querySelector('.kb-at-item');
      if (sel) { e.preventDefault(); pickKbAt(sel); }
    }
  });
}
if (kbAtMenu) {
  kbAtMenu.addEventListener('mousedown', (e) => {
    const item = e.target && e.target.closest ? e.target.closest('.kb-at-item') : null;
    if (item) { e.preventDefault(); pickKbAt(item); }
  });
}

// ---- WebSocket ----
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'jobs_update') {
      allJobs = msg.jobs;
      updateStats([]);
      if (selectedJobId) refreshJobDetail(selectedJobId);
    }
    if (msg.type === 'job_created') {
      log(`Job created: ${msg.jobId}`, 'info');
    }
    if (msg.type === 'boot_greeting') {
      // Inject boot greeting as first message in current fresh session
      const bootSess = chatSessions.find(s => s.id === activeChatSessionId);
      if (bootSess && (!bootSess.history || bootSess.history.length === 0)) {
        bootSess.history = [{ role: 'assistant', content: msg.text }];
        bootSess.updatedAt = Date.now();
        saveChatSessions();
        syncActiveChat();
        renderChatMessages();
      }
    }
    // -- Cron/Heartbeat task events --
    if (msg.type === 'tasks_update') {
      hbJobs = msg.jobs || [];
      if (msg.config) hbConfig = msg.config;
      if (currentMode === 'heartbeat') renderHeartbeatPage();
    }
    if (msg.type === 'task_running') {
      const job = hbJobs.find(j => j.id === msg.jobId);
      if (job) job.status = 'running';
      if (currentMode === 'heartbeat') renderHeartbeatPage();
      addProcessEntry('info', `Task running: ${msg.jobName}`);
    }
    if (msg.type === 'task_done') {
      hbJobs = msg.jobs || hbJobs;
      if (msg.config) hbConfig = msg.config;
      if (currentMode === 'heartbeat') renderHeartbeatPage();
      if (msg.automatedSession && !msg.isOk) {
        // Add the automated session to chatSessions so it appears in the sidebar
        const as = msg.automatedSession;
        const existingIdx = chatSessions.findIndex(s => s.id === as.id);
        const newSession = {
          id: as.id, title: as.title,
          history: as.history.map(m => ({ role: m.role === 'ai' ? 'assistant' : m.role, content: m.content })),
          processLog: [], createdAt: as.createdAt, updatedAt: Date.now(),
          automated: true, jobName: as.jobName, unread: true,
        };
        if (existingIdx === -1) chatSessions.push(newSession);
        else chatSessions[existingIdx] = { ...chatSessions[existingIdx], ...newSession };
        saveChatSessions();
        renderSessionsList();
        bgtToast('\uD83D\uDD50 Scheduled task done', `"${msg.jobName}" — results in sidebar`);
        addProcessEntry('info', `Task "${msg.jobName}" completed — check sidebar for results`);
      } else if (msg.isOk) {
        addProcessEntry('info', `Task "${msg.jobName}" — OK (nothing to report)`);
      }
    }
    // Cron job spawned a background task — switch to tasks view if currently watching
    if (msg.type === 'cron_task_spawned') {
      bgtToast('\uD83D\uDD50 Scheduled job running', `"${msg.jobName}" started as background task`);
      if (currentMode === 'bgtasks') refreshBgTasks();
    }
    if (msg.type === 'task_sse') {
      // Live progress from a running task — could update the NOW card
      if (currentMode === 'heartbeat' && msg.event === 'tool_result') {
        const card = document.querySelector(`[data-job-id="${msg.jobId}"] .hb-card-meta`);
        if (card) card.innerHTML = `<span style="color:var(--brand)">Working: ${escHtml((msg.data?.action || '').slice(0,40))}...</span>`;
      }
    }
    // -- Background Task (Kanban) events --
    if (msg.type === 'task_running' || msg.type === 'task_complete' || msg.type === 'task_paused' ||
        msg.type === 'task_failed' || msg.type === 'task_needs_assistance' || msg.type === 'task_step_done' || msg.type === 'task_tool_call' ||
        msg.type === 'task_heartbeat_tick' || msg.type === 'task_heartbeat_resumed') {
      // Live-refresh the kanban board if visible
      if (currentMode === 'bgtasks') refreshBgTasks();
      // If panel is open for this task, refresh it
      if (bgtOpenTaskId && (msg.taskId === bgtOpenTaskId)) {
        bgtRefreshOpenPanel();
      }
      // Toast notification for completions and errors
      if (msg.type === 'task_complete') {
        bgtToast(`\u2713 Task complete`, msg.summary ? msg.summary.slice(0,120) : '');
        // If this task has a cron session ID (starts with cron_), create/update a sidebar session
        // so the results are immediately visible without a page refresh.
        if (msg.taskId) {
          (async () => {
            try {
              const data = await fetch(`/api/bg-tasks/${msg.taskId}`).then(r => r.json());
              const task = data?.task || data;
              if (task && task.sessionId && task.sessionId.startsWith('cron_')) {
                const journal = task.journal || [];
                const summaryEntry = journal.filter(e => e.type === 'summary' || e.type === 'complete').pop();
                const summaryText = msg.summary || (summaryEntry?.content) || '(Task complete — open Tasks panel for details)';
                const titleText = `\uD83D\uDD50 ${task.title || 'Scheduled Task'} \u2014 ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
                const sessionId = `auto_${task.id}_${Date.now()}`;
                const existingIdx = chatSessions.findIndex(s => s.id === task.sessionId || (s.jobName && s.automated && s.title === titleText));
                const newSession = {
                  id: sessionId, title: titleText,
                  history: [
                    { role: 'user', content: `[Scheduled Task: ${task.title}]\n\n${task.prompt || ''}` },
                    { role: 'assistant', content: summaryText },
                  ],
                  processLog: [], createdAt: Date.now(), updatedAt: Date.now(),
                  automated: true, jobName: task.title, unread: true,
                };
                if (existingIdx === -1) chatSessions.push(newSession);
                saveChatSessions();
                renderSessionsList();
              }
            } catch {}
          })();
        }
      } else if (msg.type === 'task_failed') {
        bgtToast(`\u2715 Task failed`, msg.error ? msg.error.slice(0,120) : '');
      } else if (msg.type === 'task_needs_assistance') {
        bgtToast(`Task paused`, msg.reason ? String(msg.reason).slice(0, 120) : 'Needs assistance');
      }
    }
    // Panel-only refresh (frequent tool_call updates — only refresh open panel, not full kanban)
    if (msg.type === 'task_panel_update') {
      if (bgtOpenTaskId && msg.taskId === bgtOpenTaskId) {
        bgtRefreshOpenPanel();
      }
    }
    // Notification from task runner (status push to channel)
    if (msg.type === 'task_notification' && msg.sessionId) {
      // Try to add a status message to the originating chat session
      const sess = chatSessions.find(s => s.id === msg.sessionId);
      if (sess) {
        sess.history = sess.history || [];
        sess.history.push({ role: 'assistant', content: msg.message || '' });
        saveChatSessions();
        if (currentSessionId === msg.sessionId) renderMessages();
      }
    }
    // ---- Agent Execution Events ----
    if (msg.type === 'agent_spawned') {
      const agentId = spawnAgentExecution(msg.name || 'Subagent', msg.task || '', msg.isSubagent);
      // Store mapping for WebSocket message routing
      if (msg.serverAgentId) {
        if (!window.agentIdMap) window.agentIdMap = {};
        window.agentIdMap[msg.serverAgentId] = agentId;
      }
    }
    if (msg.type === 'agent_log') {
      const agentId = window.agentIdMap?.[msg.serverAgentId] || msg.agentId;
      if (agentId) addAgentLog(agentId, msg.logType || 'info', msg.content);
    }
    if (msg.type === 'agent_completed') {
      const agentId = window.agentIdMap?.[msg.serverAgentId] || msg.agentId;
      if (agentId) completeAgentExecution(agentId);
    }
    if (msg.type === 'agent_paused') {
      const agentId = window.agentIdMap?.[msg.serverAgentId] || msg.agentId;
      if (agentId) pauseAgentExecution(agentId, msg.reason);
    }
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onerror = () => ws.close();
}

// ---- API ----
async function api(path, opts = {}) {
  const r = await fetch(API + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const ct = String(r.headers.get('content-type') || '').toLowerCase();
  const bodyText = await r.text();

  if (!ct.includes('application/json')) {
    const preview = bodyText.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`Expected JSON from ${path}, got ${ct || 'unknown'} (HTTP ${r.status}) :: ${preview}`);
  }

  let data = null;
  try {
    data = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    const preview = bodyText.slice(0, 120).replace(/\s+/g, ' ');
    throw new Error(`Invalid JSON from ${path} (HTTP ${r.status}) :: ${preview}`);
  }

  if (!r.ok) {
    const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : `HTTP ${r.status}`;
    throw new Error(msg);
  }

  return data;
}

async function loadSearchSettingsSummary() {
  try {
    const boot = window.__bootData;
    const s = (boot && boot.searchSettings) || await api('/api/settings/search');
    const el = document.getElementById('r-failed');
    if (el) el.textContent = s.preferred_provider || 'tavily';
    quickSearchRigor = s.search_rigor || 'verified';
    updateQuickModeUI();
  } catch {}
  loadQuickThinkingFromBackend();
}

function updateQuickModeUI() {
  const lbl = document.getElementById('quick-mode-label');
  const RIGOR_LABEL = { fast: '快速', verified: '已核验', strict: '严格' };
  if (lbl) lbl.textContent = RIGOR_LABEL[quickSearchRigor] || RIGOR_LABEL.verified;
  ['fast', 'verified', 'strict'].forEach(v => {
    const el = document.getElementById(`rigor-${v}`);
    if (el) el.classList.toggle('active', quickSearchRigor === v);
  });
  ['off', 'standard', 'extended'].forEach(v => {
    const el = document.getElementById(`think-${v}`);
    if (el) el.classList.toggle('active', quickThinkingEffort === v);
  });
}

function toggleQuickModePopover() {
  const pop = document.getElementById('quick-mode-popover');
  if (!pop) return;
  const nextOpen = !pop.classList.contains('open');
  pop.classList.toggle('open', nextOpen);
  if (nextOpen) {
    pop.classList.remove('clamp-left');
    requestAnimationFrame(() => {
      const rect = pop.getBoundingClientRect();
      if (rect.left < 8) pop.classList.add('clamp-left');
      const after = pop.getBoundingClientRect();
      if (after.top < 8) {
        pop.style.bottom = 'auto';
        pop.style.top = '34px';
      } else {
        pop.style.top = '';
        pop.style.bottom = '34px';
      }
    });
  }
  updateQuickModeUI();
}

async function setQuickSearchRigor(level) {
  quickSearchRigor = level;
  updateQuickModeUI();
  try {
    const s = await api('/api/settings/search');
    const payload = {
      preferred_provider: s.preferred_provider || 'tavily',
      search_rigor: level,
      tavily_api_key: s.tavily_api_key || '',
      google_api_key: s.google_api_key || '',
      google_cx: s.google_cx || '',
      brave_api_key: s.brave_api_key || '',
    };
    await api('/api/settings/search', { method: 'POST', body: JSON.stringify(payload) });
    addProcessEntry('info', `Search rigor set to ${level}.`);
    await loadSearchSettingsSummary();
  } catch (err) {
    addProcessEntry('error', `Failed to set search rigor: ${err.message}`);
  }
}

function toggleThinkFromHint() {
  setQuickThinking(quickThinkingEffort === 'off' ? 'standard' : 'off');
}

function renderThinkToggleState() {
  const el = document.getElementById('think-toggle-state');
  if (!el) return;
  el.textContent = quickThinkingEffort === 'off' ? 'Off' : (quickThinkingEffort === 'extended' ? 'Extended' : 'Standard');
  const btn = document.getElementById('think-toggle-btn');
  if (btn) btn.style.color = quickThinkingEffort === 'off' ? 'var(--muted)' : 'var(--brand)';
}

function setQuickThinking(mode) {
  const payload = mode === 'off'
    ? { enabled: false }
    : { enabled: true, level: mode === 'extended' ? 'high' : 'medium' };
  api('/api/settings/think', { method: 'POST', body: JSON.stringify(payload) })
    .then(j => {
      if (!j || j.success === false) throw new Error((j && j.error) || 'failed');
      quickThinkingEffort = mode === 'off' ? 'off' : (mode === 'extended' ? 'extended' : 'standard');
      localStorage.setItem('smallclaw_quick_thinking_effort', quickThinkingEffort);
      updateQuickModeUI();
      renderThinkToggleState();
      const label = mode === 'off' ? 'Off (不思考)' : (mode === 'extended' ? 'Extended (深度思考)' : 'Standard (标准思考)');
      addProcessEntry('info', `Thinking mode → ${label}，已保存到模型档案「${j.active_preset || ''}」，立即生效。`);
    })
    .catch(err => {
      addProcessEntry('error', `Failed to set thinking mode: ${err.message}`);
    });
}

function applyThinkFromPayload(j) {
  if (!j || j.success === false) return;
  quickThinkingEffort = !j.enabled ? 'off' : (j.level === 'high' ? 'extended' : 'standard');
  updateQuickModeUI();
  renderThinkToggleState();
}

function loadQuickThinkingFromBackend() {
  const boot = window.__bootData;
  const j = boot && boot.thinkSettings;
  if (j) { applyThinkFromPayload(j); return; }
  api('/api/settings/think')
    .then(applyThinkFromPayload)
    .catch(() => {});
}

function setSettingsTab(tab) {
  settingsTab = tab;
  const tabs = ['system', 'search', 'credentials', 'policy', 'security', 'models', 'agents', 'channels', 'integrations'];
  tabs.forEach(t => {
    const btn = document.getElementById(`settings-tab-${t}`);
    const panel = document.getElementById(`settings-panel-${t}`);
    if (btn) {
      btn.style.background = (t === tab) ? 'var(--sel-bg)' : 'var(--panel)';
      btn.style.borderColor = (t === tab) ? 'var(--sel-border)' : 'var(--line)';
      btn.style.color = (t === tab) ? 'var(--sel-text)' : 'var(--muted)';
    }
    if (panel) {
      if (t === tab) {
        const gridTabs = ['system', 'search', 'models'];
        panel.style.display = gridTabs.includes(t) ? 'block' : 'block';
        if (t === 'channels') loadChannelsStatus();
        if (t === 'models') loadModelSettings();
        if (t === 'agents') loadAgentsTab();
        if (t === 'integrations') loadIntegrationsTab();
        if (t === 'credentials') loadCredentialsTab();
      } else {
        panel.style.display = 'none';
      }
    }
  });
}

// --- Credentials Tab ---------------------------------------------------------

async function loadCredentialsTab() {
  await Promise.all([loadCredFields(), loadCredVaultStatus(), loadCredVaultLog()]);
}

async function loadCredFields() {
  try {
    const s = await api('/api/settings/search');
    // Server returns '••••••••' if key is set, '' if not
    const setField = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (!el.hasAttribute('data-placeholder')) el.setAttribute('data-placeholder', el.getAttribute('placeholder') || '');
      el.value = val || '';
      el.placeholder = val ? '••••••••  (key stored — enter new value to replace)' : (el.getAttribute('data-placeholder') || '');
    };
    setField('cred-tavily-key',  s.tavily_api_key);
    setField('cred-google-key',  s.google_api_key);
    setField('cred-brave-key',   s.brave_api_key);
    const cxEl = document.getElementById('cred-google-cx');
    if (cxEl) cxEl.value = s.google_cx || '';
  } catch(e) {
    console.warn('loadCredFields:', e);
  }
}

async function loadCredVaultStatus() {
  const el = document.getElementById('cred-vault-status');
  if (!el) return;
  try {
    const data = await api('/api/credentials/status');
    const keys = data.keys || [];
    if (!keys.length) {
      el.innerHTML = '<span style="color:var(--warn)">⚠ 暂无凭据存储。</span>';
      return;
    }
    el.innerHTML = keys.map(k => {
      const label = {
        'search.tavily_api_key':  'Tavily API Key',
        'search.google_api_key':  'Google API Key',
        'search.brave_api_key':   'Brave API Key',
        'llm.openai.api_key':     'OpenAI API Key',
        'hooks.token':            'Webhook Token',
        'channels.telegram.botToken': 'Telegram Token',
        'channels.discord.botToken':  'Discord Token',
      }[k] || k;
      return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px">
        <span style="color:var(--ok);font-size:13px">✓</span>
        <span style="font-size:12px;color:var(--text)">${label}</span>
        <span style="font-size:10px;color:var(--muted);font-family:monospace">${k}</span>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<span style="color:var(--err);font-size:12px">Could not load vault status: ${e.message}</span>`;
  }
}

async function loadCredVaultLog() {
  const el = document.getElementById('cred-vault-log');
  if (!el) return;
  try {
    const data = await api('/api/credentials/audit');
    const lines = (data.lines || []).slice(-18).reverse();
    if (!lines.length) { el.textContent = '暂无审计记录。'; return; }
    el.innerHTML = lines.map(l => {
      const safe = l.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const color = l.includes('SET') ? 'var(--ok)' : l.includes('GET') ? 'var(--brand)' : l.includes('DEL') ? 'var(--err)' : 'var(--muted)';
      return `<div style="color:${color};white-space:nowrap">${safe}</div>`;
    }).join('');
  } catch(e) {
    el.textContent = 'Could not load audit log.';
  }
}

function toggleCredVis(inputId, btn) {
  const el = document.getElementById(inputId);
  if (!el) return;
  if (el.type === 'password') {
    el.type = 'text';
    btn.textContent = '🙈';
    // Auto-rehide after 8s
    setTimeout(() => { el.type = 'password'; btn.textContent = '👁'; }, 8000);
  } else {
    el.type = 'password';
    btn.textContent = '👁';
  }
}

// --- Provider-aware Model Settings ------------------------------------------

const PROVIDER_IDS = ['ollama', 'llama_cpp', 'lm_studio', 'openai', 'openai_codex'];

function onProviderChange() {
  const provider = document.getElementById('settings-llm-provider').value;
  // Show only the matching fields panel
  PROVIDER_IDS.forEach(id => {
    const el = document.getElementById('prov-fields-' + id);
    if (el) el.style.display = id === provider ? 'block' : 'none';
  });
  if (provider === 'openai') {
    refreshOpenAIModels(true).catch(() => {});
  } else if (['ollama', 'lm_studio', 'llama_cpp'].includes(provider)) {
    refreshProviderModels().catch(() => {});
  }
  syncOrchPreemptControls();
}

async function loadModelSettings() {
  try {
    const data = await api('/api/settings/provider');
    const llm = data?.llm || { provider: 'ollama', providers: {} };
    const prov = llm.provider || 'ollama';
    const provSel = document.getElementById('settings-llm-provider');
    if (provSel) provSel.value = prov;
    onProviderChange();

    const pc = llm.providers || {};

    // Populate each provider's fields from saved config
    const v = (id, val) => { const el = document.getElementById(id); if (el && val) el.value = val; };
    v('settings-ollama-endpoint',  pc.ollama?.endpoint);
    v('settings-llamacpp-endpoint', pc.llama_cpp?.endpoint);
    v('settings-llamacpp-model',    pc.llama_cpp?.model);
    v('settings-lmstudio-endpoint', pc.lm_studio?.endpoint);
    v('settings-lmstudio-model',    pc.lm_studio?.model);
    v('settings-openai-key',        pc.openai?.api_key);
    if (pc.openai?.model) { const s = document.getElementById('settings-openai-model'); if (s) s.value = pc.openai.model; }
    if (pc.openai_codex?.model) { const s = document.getElementById('settings-codex-model'); if (s) s.value = pc.openai_codex.model; }

    // Check Codex OAuth status
    await refreshCodexStatus();

    // Refresh OpenAI model dropdown from current key when applicable
    if (prov === 'openai') await refreshOpenAIModels(true);

    // Auto-load model list for list-capable providers
    if (['ollama', 'lm_studio', 'llama_cpp'].includes(prov)) await refreshProviderModels();

    // Load model presets
    await loadPresets();

    // Populate the always-visible chat-area model switcher
    await refreshChatModelSwitch();
  } catch (e) {
    console.warn('loadModelSettings error:', e);
  }
}

// ─── Model presets UI ──────────────────────────────────────────────────────────

let presetEditingId = null;

async function loadPresets() {
  const listEl = document.getElementById('presets-list');
  const statusEl = document.getElementById('presets-status');
  if (!listEl) return;
  try {
    const data = await api('/api/models/presets');
    const presets = data?.presets || [];
    const active = String(data?.active_preset || '');
    listEl.innerHTML = presets.length ? '' : '<div style="font-size:12px;color:var(--muted)">暂无档案，点击下方「新建档案」创建。</div>';
    presets.forEach(function (p) {
      const card = document.createElement('div');
      card.style.cssText = 'display:flex;align-items:center;gap:10px;border:1px solid ' + (p.active ? 'var(--brand)' : 'var(--line)') + ';border-radius:10px;padding:8px 10px;background:' + (p.active ? 'var(--bg-soft)' : 'transparent');
      const badge = p.active
        ? '<span style="font-size:10px;font-weight:800;color:#fff;background:var(--brand);border-radius:6px;padding:2px 6px">当前</span>'
        : '';
      const builtinTag = p.builtin ? '<span style="font-size:10px;color:var(--muted)">内置</span>' : '';
      card.innerHTML =
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:13px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px">' + escHtml(p.name) + ' ' + badge + ' ' + builtinTag + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(p.provider) + (p.model ? ' · ' + escHtml(p.model) : '') + (p.server ? ' · ctx ' + p.server.ctx_size : '') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
          (p.active ? '' : '<button class="btn btn-sm" onclick="switchPreset(\'' + escHtml(p.id) + '\')" style="background:var(--brand);color:#fff;border:none">切换</button>') +
          '<button class="btn btn-sm" onclick="openPresetEditor(\'' + escHtml(p.id) + '\')" style="background:var(--panel);border:1px solid var(--line);color:var(--text)">编辑</button>' +
          (p.builtin ? '' : '<button class="btn btn-sm" onclick="deletePreset(\'' + escHtml(p.id) + '\')" style="background:var(--panel);border:1px solid var(--err);color:var(--err)">删除</button>') +
        '</div>';
      listEl.appendChild(card);
    });
    if (statusEl) statusEl.textContent = '';
    // Keep the chat-area switcher in sync with the preset list
    refreshChatModelSwitch();
  } catch (e) {
    if (statusEl) statusEl.textContent = '加载档案失败: ' + (e.message || e);
  }
}

async function switchPreset(id) {
  const statusEl = document.getElementById('presets-status');
  if (!statusEl) return;
  statusEl.textContent = '正在切换模型，请稍候…（llama.cpp 需重启加载约 30-60 秒）';
  statusEl.style.color = 'var(--warn)';
  try {
    const data = await api('/api/models/presets/switch', { method: 'POST', body: JSON.stringify({ preset_id: id }) });
    if (data && data.success) {
      statusEl.style.color = 'var(--ok)';
      statusEl.textContent = data.restart_ms ? ('切换成功，llama-server 重启耗时 ' + Math.round(data.restart_ms / 1000) + ' 秒') : '切换成功';
      await loadPresets();
    } else {
      statusEl.style.color = 'var(--err)';
      statusEl.textContent = '切换失败: ' + (data?.error || '未知错误');
    }
  } catch (e) {
    statusEl.style.color = 'var(--err)';
    statusEl.textContent = '切换失败: ' + (e.message || e);
  }
}

// --- Chat-area model switcher ----------------------------------------------
// Lets the user change the active model preset without leaving the chat view.

async function refreshChatModelSwitch() {
  const sel = document.getElementById('chat-model-switch');
  if (!sel) return;
  try {
    const data = await api('/api/models/presets');
    const presets = data?.presets || [];
    const active = String(data?.active_preset || '');
    const prev = sel.value;
    sel.innerHTML = '';
    presets.forEach(function (p) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name + (p.active ? '（当前）' : '');
      if (String(p.id) === active) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!presets.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '暂无档案（到设置添加）';
      sel.appendChild(opt);
    }
  } catch (e) { /* keep previous options */ }
}

async function onChatModelSwitch(sel) {
  const id = sel.value;
  if (!id || sel.disabled) return;
  sel.disabled = true;
  const q = document.getElementById('queued-prompts-indicator');
  const errEl = document.getElementById('chat-switch-err');
  const showErr = function (msg) {
    if (errEl) { errEl.textContent = msg; errEl.style.display = 'inline'; setTimeout(function () { errEl.style.display = 'none'; }, 8000); }
  };
  try {
    const data = await api('/api/models/presets/switch', { method: 'POST', body: JSON.stringify({ preset_id: id }) });
    if (data && data.success) {
      if (q) {
        q.textContent = data.restart_ms ? ('已切换（llama-server 重启 ' + Math.round(data.restart_ms / 1000) + 's）') : '已切换 ✓';
        q.style.display = 'inline';
        setTimeout(function () { q.style.display = 'none'; }, 6000);
      }
      await checkStatus();
      await refreshChatModelSwitch();
    } else {
      showErr('切换失败：' + (data?.error || '未知错误') + '（仍在使用当前模型）');
      await refreshChatModelSwitch();
    }
  } catch (e) {
    showErr('切换失败：' + (e.message || e) + '（仍在使用当前模型）');
    await refreshChatModelSwitch();
  } finally {
    sel.disabled = false;
  }
}

function onPresetProviderChange() {
  const p = document.getElementById('preset-provider').value;
  const lf = document.getElementById('preset-llamacpp-fields');
  const of = document.getElementById('preset-openai-fields');
  if (lf) lf.style.display = p === 'llama_cpp' ? 'block' : 'none';
  if (of) of.style.display = p === 'openai' ? 'block' : 'none';
  // 动态切换 Endpoint 字段文案：选 openai/第三方兼容时变成 Base URL
  const epLabel = document.getElementById('preset-endpoint-label');
  const epInput = document.getElementById('preset-endpoint');
  if (p === 'openai') {
    if (epLabel) epLabel.textContent = 'Base URL（OpenAI 兼容地址）';
    if (epInput) epInput.placeholder = 'https://api.openai.com/v1（第三方填对应服务商地址，见下方示例）';
    // 若还是新建档案默认填的本地地址，提示用户替换
    if (epInput && (!epInput.value || epInput.value === 'http://localhost:8080')) {
      epInput.placeholder = 'https://api.openai.com/v1（官方可留空；第三方填对应地址，见下方示例）';
    }
  } else {
    if (epLabel) epLabel.textContent = 'Endpoint';
    if (epInput) epInput.placeholder = 'http://localhost:8080';
  }
  // "Detect models" needs a real API — hidden for OAuth-only codex.
  const dw = document.getElementById('preset-detect-wrap');
  if (dw) dw.style.display = p === 'openai_codex' ? 'none' : 'flex';
  resetPresetDetect();
}

function resetPresetDetect() {
  const listEl = document.getElementById('preset-model-list');
  const statusEl = document.getElementById('preset-detect-status');
  if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">勾选模型（可多选）→ 填入模型名，保存时每个勾选模型创建独立档案</div>'; }
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = ''; }
}

async function presetDetectModels() {
  const statusEl = document.getElementById('preset-detect-status');
  const listEl = document.getElementById('preset-model-list');
  const gv = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const provider = gv('preset-provider');
  const endpoint = gv('preset-endpoint');
  if (!endpoint) { if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '请先填写 Endpoint'; } return; }
  const providers = {};
  providers[provider] = { endpoint };
  if (provider === 'openai') {
    const key = gv('preset-openai-key');
    if (!key) { if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '请先填写 API Key'; } return; }
    providers[provider].api_key = key;
  }
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = '检测中…'; }
  if (listEl) { listEl.style.display = 'none'; listEl.innerHTML = ''; }
  try {
    const data = await api('/api/models/test', { method: 'POST', body: JSON.stringify({ llm: { provider, providers } }) });
    if (!data || !data.success || !Array.isArray(data.models) || data.models.length === 0) {
      if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = data?.error || '未获取到模型列表'; }
      return;
    }
    if (statusEl) { statusEl.style.color = 'var(--ok)'; statusEl.textContent = '找到 ' + data.models.length + ' 个模型，可勾选多个（保存时每个勾选模型创建独立档案）'; }
    if (listEl) {
      listEl.style.display = 'block';
      listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">勾选模型（可多选）→ 填入模型名，保存时每个勾选模型创建独立档案</div>';
      const refreshModelInput = function () {
        const modelInput = document.getElementById('preset-model');
        if (!modelInput) return;
        const picked = [];
        listEl.querySelectorAll('.preset-model-check').forEach(function (c) { if (c.checked) picked.push(c.value); });
        modelInput.value = picked.join(', ');
      };
      data.models.forEach(function (m) {
        const id = String(m.id || m.name || '');
        if (!id) return;
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:8px;cursor:pointer;font-size:12px;color:var(--text)';
        row.innerHTML = '<input type="checkbox" class="preset-model-check" value="' + escHtml(id) + '">' + escHtml(id);
        const cb = row.querySelector('input');
        cb.addEventListener('change', refreshModelInput);
        listEl.appendChild(row);
      });
    }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '检测失败: ' + (e.message || e); }
  }
}

function openPresetEditor(id) {
  const editor = document.getElementById('preset-editor');
  const title = document.getElementById('preset-editor-title');
  if (!editor) return;
  presetEditingId = id || null;
  editor.style.display = 'block';
  if (title) title.textContent = id ? '编辑档案' : '新建档案';
  const setV = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = val || ''; };
  setV('preset-id', id || '');
  if (!id) {
    setV('preset-name', '');
    setV('preset-endpoint', 'http://localhost:8080');
    setV('preset-model', '');
    setV('preset-model-path', '');
    setV('preset-mmproj-path', '');
    setV('preset-ctx', '');
    setV('preset-ngl', '99');
    setV('preset-openai-key', '');
    const sel = document.getElementById('preset-provider');
    if (sel) sel.value = 'llama_cpp';
    onPresetProviderChange();
    return;
  }
  // Load preset data for editing
  api('/api/models/presets').then(function (data) {
    const p = (data?.presets || []).find(x => String(x.id) === id);
    if (!p) return;
    setV('preset-name', p.name);
    const psel = document.getElementById('preset-provider');
    if (psel) psel.value = p.provider;
    onPresetProviderChange();
    setV('preset-endpoint', p.endpoint);
    setV('preset-model', p.model);
    if (p.server) {
      setV('preset-model-path', p.server.model_path);
      setV('preset-mmproj-path', p.server.mmproj_path);
      setV('preset-ctx', p.server.ctx_size);
      setV('preset-ngl', p.server.ngl);
    }
  });
}

function closePresetEditor() {
  const editor = document.getElementById('preset-editor');
  if (editor) editor.style.display = 'none';
  presetEditingId = null;
  resetPresetDetect();
}

async function savePreset() {
  const statusEl = document.getElementById('presets-status');
  const gv = id => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
  const provider = gv('preset-provider');
  if (!gv('preset-name')) { if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '请填写档案名称'; } return; }
  const slug = s => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  const shortHash = s => { let h = 0; for (const c of String(s || '')) h = (h * 31 + c.codePointAt(0)) >>> 0; return h.toString(36); };
  // 模型名支持多选（逗号/换行分隔）：勾选多个时每个模型保存为一个独立档案
  const rawModels = gv('preset-model').split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);
  if (!rawModels.length) { if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '请填写模型名'; } return; }
  const baseName = gv('preset-name');
  const baseId = presetEditingId || slug(baseName) || ('preset-' + Date.now());
  const presetsToSave = rawModels.map(function (m) {
    const preset = {
      id: rawModels.length > 1 ? (slug(baseName) || 'preset') + '-' + (slug(m) || shortHash(m)) : baseId,
      name: rawModels.length > 1 ? baseName + ' (' + m + ')' : baseName,
      provider: provider,
      providers: {},
    };
    preset.providers[provider] = { endpoint: gv('preset-endpoint'), model: m };
    if (provider === 'openai') {
      const key = gv('preset-openai-key');
      if (key) preset.providers[provider].api_key = key;
    }
    if (provider === 'llama_cpp') {
      if (!gv('preset-model-path')) return null;
      preset.server = {
        model_path: gv('preset-model-path'),
        mmproj_path: gv('preset-mmproj-path') || undefined,
        ngl: Number(gv('preset-ngl')) || 99,
        ctx_size: Number(gv('preset-ctx')) || undefined, // unset = model's native context
      };
      if (m) preset.server.alias = m;
    }
    return preset;
  }).filter(Boolean);
  if (!presetsToSave.length) { if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = 'llama.cpp 档案必须填写 GGUF 模型文件路径'; } return; }
  try {
    for (const p of presetsToSave) {
      const data = await api('/api/models/presets', { method: 'POST', body: JSON.stringify({ preset: p }) });
      if (!data || !data.success) {
        if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '保存失败: ' + (data?.error || '未知错误'); }
        return;
      }
    }
    if (statusEl) { statusEl.style.color = 'var(--ok)'; statusEl.textContent = '已保存 ' + presetsToSave.length + ' 个档案'; }
    closePresetEditor();
    await loadPresets();
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '保存失败: ' + (e.message || e); }
  }
}

async function deletePreset(id) {
  const statusEl = document.getElementById('presets-status');
  try {
    // If the target is the active preset, switch to another one first
    const list = await api('/api/models/presets');
    const active = String(list?.active_preset || '');
    if (String(id) === active) {
      const others = (list?.presets || []).filter(p => String(p.id) !== String(id));
      if (!others.length) {
        if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '当前只有这一个档案，请先新建其他档案再删除'; }
        return;
      }
      const fallback = others[0];
      const target = (list?.presets || []).find(p => String(p.id) === String(id));
      const activeName = target ? target.name : '当前档案';
      if (!confirm('「' + activeName + '」正在使用，删除前将自动切换到「' + fallback.name + '」，继续？')) return;
      if (statusEl) { statusEl.style.color = 'var(--warn)'; statusEl.textContent = '正在切换到 ' + fallback.name + ' …'; }
      const sw = await api('/api/models/presets/switch', { method: 'POST', body: JSON.stringify({ preset_id: fallback.id }) });
      if (!sw || !sw.success) {
        if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '自动切换失败: ' + (sw?.error || '未知错误'); }
        return;
      }
    }
    const data = await api('/api/models/presets/' + encodeURIComponent(id), { method: 'DELETE' });
    if (data && data.success) {
      if (statusEl) { statusEl.style.color = 'var(--ok)'; statusEl.textContent = '档案已删除'; }
      await loadPresets();
    } else {
      if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '删除失败: ' + (data?.error || '未知错误'); }
    }
  } catch (e) {
    if (statusEl) { statusEl.style.color = 'var(--err)'; statusEl.textContent = '删除失败: ' + (e.message || e); }
  }
}

async function refreshProviderModels() {
  const provider = document.getElementById('settings-llm-provider')?.value || 'ollama';
  const msg = document.getElementById('provider-status-msg');
  if (msg) msg.textContent = 'Loading models…';
  try {
    const llm = buildProviderPayload();
    if (llm.provider !== provider) llm.provider = provider;
    const data = await api('/api/models/test', { method: 'POST', body: JSON.stringify({ llm }) });
    const models = (data?.models || []).map(m => typeof m === 'string' ? m : (m.name || String(m)));
    const selects = ['settings-primary-model'];
    selects.forEach((selId, i) => {
      const sel = document.getElementById(selId);
      if (!sel) return;
      if (i === 0) {
        sel.innerHTML = models.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
        if (models.length) sel.value = models[0];
      }
    });
    if (msg) msg.textContent = models.length ? `找到 ${models.length} 个模型。` : '未找到模型——服务器是否在运行？';
  } catch (e) {
    if (msg) msg.textContent = 'Failed to fetch models.';
  }
}

async function testProviderConnection() {
  const provider = document.getElementById('settings-llm-provider').value;
  const statusIds = { ollama: 'provider-status-msg', llama_cpp: 'provider-status-msg-llamacpp', lm_studio: 'provider-status-msg-lmstudio', openai: 'provider-status-msg-openai', openai_codex: 'codex-oauth-status' };
  const msgId = statusIds[provider] || 'provider-status-msg';
  const msg = document.getElementById(msgId);
  if (msg) msg.textContent = 'Testing…';

  if (provider === 'openai') {
    const ok = await refreshOpenAIModels(false);
    if (msg) msg.textContent = ok ? '? Connected' : (msg.textContent || '? Connection failed');
    return;
  }

  try {
    const llm = buildProviderPayload();
    if (llm.provider !== provider) llm.provider = provider;
    const data = await api('/api/models/test', { method: 'POST', body: JSON.stringify({ llm }) });
    if (msg) msg.textContent = data?.success ? '? Connected' : '? ' + (data?.error || 'Connection failed');
  } catch (e) {
    if (msg) msg.textContent = '? ' + e.message;
  }
}

function updateOpenAIModelDropdown(models) {
  const sel = document.getElementById('settings-openai-model');
  if (!sel) return;
  const current = String(sel.value || '').trim();
  const unique = Array.from(new Set((models || []).filter(Boolean).map(m => String(m).trim()).filter(Boolean)));
  if (!unique.length) return;
  if (current && !unique.includes(current)) unique.unshift(current);
  sel.innerHTML = unique.slice(0, 500).map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  if (current) sel.value = current;
}

async function refreshOpenAIModels(silent = false) {
  const statusEl = document.getElementById('provider-status-msg-openai');
  const apiKey = document.getElementById('settings-openai-key')?.value?.trim() || '';
  if (!apiKey) {
    if (!silent && statusEl) statusEl.textContent = 'Enter API key first.';
    return false;
  }
  if (!silent && statusEl) statusEl.textContent = 'Fetching model list…';
  try {
    const data = await api('/api/openai/models', { method: 'POST', body: JSON.stringify({ api_key: apiKey }) });
    if (!data?.success) {
      if (statusEl) statusEl.textContent = '? ' + (data?.error || 'Failed to fetch models');
      return false;
    }
    const models = (data?.models || []).map(m => typeof m === 'string' ? m : (m.name || String(m)));
    updateOpenAIModelDropdown(models);
    if (statusEl) statusEl.textContent = models.length ? `? ${models.length} model(s) available` : '? Connected';
    return true;
  } catch (e) {
    if (statusEl) statusEl.textContent = '? ' + e.message;
    return false;
  }
}

// Build the llm config object from current UI state
function buildProviderPayload() {
  const provider = document.getElementById('settings-llm-provider')?.value || 'ollama';
  const providers = {};
  providers.ollama    = { endpoint: document.getElementById('settings-ollama-endpoint')?.value  || 'http://localhost:11434', model: document.getElementById('settings-primary-model')?.value || '' };
  providers.llama_cpp = { endpoint: document.getElementById('settings-llamacpp-endpoint')?.value || 'http://localhost:8080',  model: document.getElementById('settings-llamacpp-model')?.value  || '' };
  providers.lm_studio = { endpoint: document.getElementById('settings-lmstudio-endpoint')?.value || 'http://localhost:1234',  model: document.getElementById('settings-lmstudio-model')?.value   || '' };
  providers.openai    = { api_key:  document.getElementById('settings-openai-key')?.value         || '',                       model: document.getElementById('settings-openai-model')?.value      || 'gpt-4o' };
  providers.openai_codex = { model: document.getElementById('settings-codex-model')?.value         || 'gpt-5.3-codex' };
  return { provider, providers };
}

// --- Codex OAuth UI ------------------------------------------------

async function refreshCodexStatus() {
  try {
    const data = await api('/api/auth/openai/status');
    const disc = document.getElementById('codex-disconnected-state');
    const conn = document.getElementById('codex-connected-state');
    const acct = document.getElementById('codex-account-id');
    if (data?.connected) {
      if (disc) disc.style.display = 'none';
      if (conn) conn.style.display = 'block';
      if (acct) acct.textContent = data.account_id ? `Account: ${data.account_id}` : 'Account connected';
    } else {
      if (disc) disc.style.display = 'block';
      if (conn) conn.style.display = 'none';
    }
  } catch {}
}

async function startCodexOAuth() {
  const statusEl = document.getElementById('codex-oauth-status');
  if (statusEl) statusEl.textContent = 'Opening browser…';
  try {
    const data = await api('/api/auth/openai/start', { method: 'POST', body: '{}' });
    if (data?.needsManualPaste) {
      if (statusEl) statusEl.innerHTML = 'Browser did not open. <a href="' + data.authUrl + '" target="_blank">Click here to authorize</a>, then paste the redirect URL below.<br><input id="codex-manual-url" type="text" placeholder="Paste redirect URL here…" style="width:100%;margin-top:6px;padding:6px;border:1px solid var(--line);border-radius:8px;font-size:11px"><button onclick="submitManualCodexUrl()" style="margin-top:4px;font-size:11px;padding:4px 8px;border-radius:6px;border:1px solid var(--line);cursor:pointer">Submit</button>';
    } else if (data?.success) {
      if (statusEl) statusEl.textContent = '';
      await refreshCodexStatus();
    } else {
      if (statusEl) statusEl.textContent = '? ' + (data?.error || 'OAuth failed');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '? ' + e.message;
  }
}

async function submitManualCodexUrl() {
  const url = document.getElementById('codex-manual-url')?.value?.trim();
  if (!url) return;
  const statusEl = document.getElementById('codex-oauth-status');
  if (statusEl) statusEl.textContent = 'Exchanging token…';
  try {
    const data = await api('/api/auth/openai/manual', { method: 'POST', body: JSON.stringify({ url }) });
    if (data?.success) {
      if (statusEl) statusEl.textContent = '';
      await refreshCodexStatus();
    } else {
      if (statusEl) statusEl.textContent = '? ' + (data?.error || 'Failed');
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = '? ' + e.message;
  }
}

async function disconnectCodex() {
  await api('/api/auth/openai/disconnect', { method: 'POST', body: '{}' });
  await refreshCodexStatus();
}

// Legacy alias so any old references still work
async function refreshOllamaModels() { await refreshProviderModels(); }

async function loadAgentSessionContext() {
  try {
    if (!agentSessionId) setAgentSessionId(activeChatSessionId);
    const sid = encodeURIComponent(agentSessionId);
    const data = await api(`/api/agent/session/${sid}`);
    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    set('r-session-mode', data.mode_lock || '-');
    set('r-agent-state', `${data.mode || '-'} / ${lastTurnKind !== '-' ? lastTurnKind : 'n/a'}`);
    set('r-overview-objective', (data.overview_objective || '(none)').slice(0, 56));
    set('r-active-objective', (data.active_objective || '(none)').slice(0, 56));
    const tc = data.task_counts || {};
    const tr = data.turn_counts || {};
    const ec = data.execution_counts || {};
    const useExecutionCounts = Number(ec.total || 0) > 0 || data.current_turn_execution;
    if (useExecutionCounts) {
      const doneExec = Number(ec.done || 0) + Number(ec.repaired || 0);
      set('r-task-counts', `${doneExec}/${ec.total || 0} completed`);
      set('r-turn-counts', `${ec.running || 0} running • ${ec.failed || 0} failed`);
    } else {
      set('r-task-counts', `${tc.done || 0}/${tc.total || 0} done`);
      set('r-turn-counts', `${tr.completed || 0} done • ${tr.open || 0} open`);
    }
    const total = useExecutionCounts ? Number(ec.total || 0) : Number(tc.total || 0);
    const done = useExecutionCounts ? (Number(ec.done || 0) + Number(ec.repaired || 0)) : Number(tc.done || 0);
    const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
    const bar = document.getElementById('r-task-progress-bar');
    if (bar) bar.style.width = `${pct}%`;

    const execPanel = document.getElementById('r-turn-execution');
    if (execPanel) {
      const cur = data.current_turn_execution;
      if (!cur || typeof cur !== 'object') {
        execPanel.innerHTML = '<div style="font-size:11px;color:var(--muted)">暂无执行记录。</div>';
      } else {
        const objective = escHtml(String(cur.objective_raw || '(no objective)').slice(0, 220));
        const status = escHtml(String(cur.status || 'planned'));
        const mode = escHtml(String(cur.mode || 'unknown'));
        const turnKind = escHtml(String(cur.turn_kind || 'unknown'));
        const steps = Array.isArray(cur.steps) ? cur.steps : [];
        const verification = cur.verification && typeof cur.verification === 'object' ? cur.verification : null;
        const trace = cur.decision_trace && typeof cur.decision_trace === 'object' ? cur.decision_trace : null;
        const traceEvents = Array.isArray(trace?.events) ? trace.events : [];
        const stepRows = steps.map((s, idx) => {
          const stepTitle = escHtml(String(s.title || s.type || `Step ${idx + 1}`));
          const stepStatus = escHtml(String(s.status || 'pending'));
          const outputs = s.outputs && typeof s.outputs === 'object'
            ? `<div class="task-meta">${escHtml(JSON.stringify(s.outputs).slice(0, 160))}</div>`
            : '';
          return `
            <div class="task-row">
              <div class="task-top">
                <div class="task-title">${idx + 1}. ${stepTitle}</div>
                <span class="status-chip ${stepStatus}">${stepStatus.replace('_', ' ')}</span>
              </div>
              ${outputs}
            </div>
          `;
        }).join('');
        const verifyHtml = verification
          ? `<div class="task-meta">verify: <strong>${escHtml(String(verification.status || 'pass'))}</strong>${Array.isArray(verification.repairs_applied) && verification.repairs_applied.length ? ` • repairs: ${verification.repairs_applied.length}` : ''}${Array.isArray(verification.errors) && verification.errors.length ? ` • errors: ${verification.errors.length}` : ''}</div>`
          : '<div class="task-meta">verify: (not run)</div>';
        const traceHtml = traceEvents.length
          ? `
            <div class="task-row">
              <div class="task-top">
                <div class="task-title">Decision Trace</div>
                <span class="status-chip done">${traceEvents.length}</span>
              </div>
              ${traceEvents.slice(-10).map((ev) => {
                const stage = escHtml(String(ev?.stage || 'trace'));
                const msg = escHtml(String(ev?.message || '').slice(0, 180));
                return `<div class="task-meta">[${stage}] ${msg}</div>`;
              }).join('')}
            </div>
          `
          : '';
        execPanel.innerHTML = `
          <div class="task-row">
            <div class="task-top">
              <div class="task-title">Current Turn</div>
              <span class="status-chip ${status}">${status.replace('_', ' ')}</span>
            </div>
            <div class="task-meta">${objective}</div>
            <div class="task-meta">mode: <strong>${mode}</strong> • kind: <strong>${turnKind}</strong></div>
            ${verifyHtml}
          </div>
          ${stepRows || '<div style="font-size:11px;color:var(--muted)">No execution steps.</div>'}
          ${traceHtml}
        `;
      }
    }

    const taskList = document.getElementById('r-task-list');
    if (taskList) {
      const tasks = Array.isArray(data.tasks) ? data.tasks : [];
      if (!tasks.length) {
        taskList.innerHTML = '<div style="font-size:11px;color:var(--muted)">暂无任务。</div>';
      } else {
        taskList.innerHTML = tasks.slice(0, 20).map(t => {
          const title = escHtml(String(t.title || '').slice(0, 120));
          const status = escHtml(String(t.status || 'pending'));
          const tool = escHtml(String(t.tool || 'tool'));
          return `
            <div class="task-row">
              <div class="task-top">
                <div class="task-title">${title}</div>
                <span class="status-chip ${status}">${status.replace('_', ' ')}</span>
              </div>
              <div class="task-meta">tool: ${tool}</div>
            </div>
          `;
        }).join('');
      }
    }

    const rt = document.getElementById('r-recent-turns');
    if (rt) {
      const recentExec = Array.isArray(data.recent_turn_executions) ? data.recent_turn_executions : [];
      if (recentExec.length) {
        rt.innerHTML = recentExec.slice(0, 10).map((e, idx) => {
          const status = escHtml(String(e.status || 'planned'));
          const objective = escHtml(String(e.objective_raw || '').slice(0, 120));
          const tools = Array.isArray(e.tool_calls) ? e.tool_calls.length : 0;
          const traceCount = Array.isArray(e?.decision_trace?.events) ? e.decision_trace.events.length : 0;
          const repairs = Array.isArray(e?.verification?.repairs_applied) ? e.verification.repairs_applied.length : 0;
          return `<div style="margin-bottom:6px"><span style="color:var(--muted)">#${idx + 1} [${status}]</span> ${objective || '(objective)'}<div style="font-size:10px;color:var(--muted)">tools: ${tools}${traceCount ? ` • trace: ${traceCount}` : ''}${repairs ? ` • repairs: ${repairs}` : ''}</div></div>`;
        }).join('');
      } else {
        const turns = data.recent_turns || [];
        if (!turns.length) {
          rt.innerHTML = '暂无目标。';
        } else {
          rt.innerHTML = turns.map(t => {
            const kind = escHtml(String(t.kind || 'turn'));
            const status = escHtml(String(t.status || 'open'));
            const text = escHtml(String(t.text || '').slice(0, 120));
            return `<div style="margin-bottom:6px"><span style="color:var(--muted)">[${kind}/${status}]</span> ${text}</div>`;
          }).join('');
        }
      }
    }

    maybeAutoScrollRightColumn(rightColumnAutoFollow && isThinking);
  } catch {
    const rt = document.getElementById('r-recent-turns');
    if (rt) rt.innerHTML = 'Unable to load session context.';
  }
}

function renderLiveStepsPanel() {
  const el = document.getElementById('r-live-steps');
  if (!el) return;
  if (!liveTaskSteps.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted)">No live tool steps.</div>';
    return;
  }
  el.innerHTML = liveTaskSteps.slice(-20).map((s) => {
    const action = escHtml(String(s.action || 'tool'));
    const status = escHtml(String(s.status || 'pending'));
    const stepNum = Number(s.stepNum || 0);
    const meta = s.meta ? `<div class="task-meta">${escHtml(String(s.meta).slice(0, 140))}</div>` : '';
    return `
      <div class="task-row">
        <div class="task-top">
          <div class="task-title">${stepNum ? `Step ${stepNum}: ` : ''}${action}</div>
          <span class="status-chip ${status}">${status.replace('_', ' ')}</span>
        </div>
        ${meta}
      </div>
    `;
  }).join('');
}

function upsertLiveStep(action, stepNum, status, meta = '') {
  const key = `${String(action || '')}:${Number(stepNum || 0)}`;
  const idx = liveTaskSteps.findIndex(s => s.key === key);
  const row = { key, action: String(action || ''), stepNum: Number(stepNum || 0), status: String(status || 'pending'), meta: String(meta || '') };
  if (idx >= 0) liveTaskSteps[idx] = { ...liveTaskSteps[idx], ...row };
  else liveTaskSteps.push(row);
  renderLiveStepsPanel();
}

async function openSettings(tab) {
  document.getElementById('settings-modal').style.display = 'flex';
  setSettingsTab(tab || settingsTab || 'system');
  try {
    const status = await api('/api/status');
    document.getElementById('settings-runtime-model').textContent = status.currentModel || '-';
    loadOrchestrationConfig();
    document.getElementById('settings-runtime-gateway').textContent = status.gateway || '-';
    const providerName = ({ ollama: 'Ollama', llama_cpp: 'llama.cpp', lm_studio: 'LM Studio', openai: 'OpenAI', openai_codex: 'OpenAI Codex' })[status.provider] || status.provider || 'Unknown';
    document.getElementById('settings-runtime-provider-key').textContent = providerName;
    document.getElementById('settings-runtime-provider').textContent = status.providerOnline ? 'Online' : 'Offline';
  } catch {}
  try {
    const paths = await api('/api/settings/paths');
    document.getElementById('settings-workspace-path').value = paths.workspace_path || '';
    document.getElementById('settings-allowed-paths').value = (paths.allowed_paths || []).join('\n');
    document.getElementById('settings-blocked-paths').value = (paths.blocked_paths || []).join('\n');
  } catch {}
  try {
    const s = await api('/api/settings/search');
    document.getElementById('settings-provider').value = s.preferred_provider || 'tavily';
    document.getElementById('settings-search-rigor').value = s.search_rigor || 'verified';
    // Keys are loaded via the Credentials tab — not here
  } catch {}
  try {
    const p = await api('/api/settings/agent');
    document.getElementById('settings-force-web-fresh').checked = p.force_web_for_fresh !== false;
    document.getElementById('settings-memory-fallback').checked = p.memory_fallback_on_search_failure !== false;
    document.getElementById('settings-auto-store-web-facts').checked = p.auto_store_web_facts !== false;
    document.getElementById('settings-nl-tool-router').checked = p.natural_language_tool_router !== false;
    document.getElementById('settings-retrieval-mode').value = p.retrieval_mode || 'standard';
  } catch {}
}

function closeSettings() {
  document.getElementById('settings-modal').style.display = 'none';
}

function ensureAgentMdEditor() {
  if (agentMdEditor || typeof CodeMirror === 'undefined') return;
  const wrap = document.getElementById('agent-md-editor-wrap');
  if (!wrap) return;
  agentMdEditor = CodeMirror(wrap, {
    value: '',
    mode: 'markdown',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentWithTabs: false,
    theme: 'default',
  });
  agentMdEditor.setSize('100%', 240);
}

function getAgentFromForm() {
  const profile = document.getElementById('agent-edit-profile').value.trim();
  const maxStepsRaw = document.getElementById('agent-edit-max-steps').value;
  const maxSteps = Number(maxStepsRaw);
  const spawnAllowlist = (document.getElementById('agent-edit-spawn-allowlist').value || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const agent = {
    id: document.getElementById('agent-edit-id').value.trim(),
    name: document.getElementById('agent-edit-name').value.trim(),
    emoji: document.getElementById('agent-edit-emoji').value.trim(),
    description: document.getElementById('agent-edit-description').value.trim(),
    workspace: document.getElementById('agent-edit-workspace').value.trim(),
    model: document.getElementById('agent-edit-model').value.trim(),
    cronSchedule: document.getElementById('agent-edit-cron').value.trim(),
    minimalPrompt: document.getElementById('agent-edit-minimal').checked,
    default: document.getElementById('agent-edit-default').checked,
    canSpawn: document.getElementById('agent-edit-can-spawn').checked,
    spawnAllowlist,
    tools: {},
  };
  if (profile) agent.tools.profile = profile;
  if (Number.isFinite(maxSteps) && maxSteps > 0) agent.maxSteps = Math.floor(maxSteps);
  if (!agent.tools.profile) delete agent.tools;
  if (!agent.spawnAllowlist.length) delete agent.spawnAllowlist;
  return agent;
}

function setAgentForm(agent) {
  const a = agent || {};
  document.getElementById('agent-edit-id').value = a.id || '';
  document.getElementById('agent-edit-name').value = a.name || '';
  document.getElementById('agent-edit-emoji').value = a.emoji || '';
  document.getElementById('agent-edit-description').value = a.description || '';
  document.getElementById('agent-edit-workspace').value = a.workspace || '';
  document.getElementById('agent-edit-model').value = a.model || '';
  document.getElementById('agent-edit-cron').value = a.cronSchedule || '';
  document.getElementById('agent-edit-max-steps').value = (a.maxSteps || '') + '';
  document.getElementById('agent-edit-default').checked = a.default === true;
  document.getElementById('agent-edit-minimal').checked = a.minimalPrompt === true;
  document.getElementById('agent-edit-can-spawn').checked = a.canSpawn === true;
  document.getElementById('agent-edit-spawn-allowlist').value = Array.isArray(a.spawnAllowlist) ? a.spawnAllowlist.join(',') : '';
  document.getElementById('agent-edit-profile').value = a.tools?.profile || '';
}

function renderAgentsList() {
  const el = document.getElementById('settings-agents-list');
  if (!el) return;
  if (!agentsConfigList.length) {
    el.innerHTML = '<div style="color:var(--muted)">未找到代理。</div>';
    return;
  }
  el.innerHTML = agentsConfigList.map((a) => {
    const selected = a.id === selectedAgentId;
    const lastRun = a.lastRun?.finishedAt ? new Date(a.lastRun.finishedAt).toLocaleString() : 'never';
    const heartbeat = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).toLocaleString() : 'never';
    const badge = a.default ? '<span style="font-size:10px;padding:2px 6px;border-radius:999px;background:var(--sel-bg);color:var(--sel-text);border:1px solid var(--sel-border)">default</span>' : '';
    return `
      <button onclick="selectAgent('${escHtml(a.id)}')" style="text-align:left;border:1px solid ${selected ? 'var(--sel-border)' : 'var(--line)'};border-radius:10px;padding:8px;background:${selected ? 'var(--panel-2)' : 'var(--panel)'};cursor:pointer">
        <div style="display:flex;align-items:center;gap:6px">
          <div style="font-size:15px">${escHtml(a.emoji || '🤖')}</div>
          <div style="font-weight:700;color:var(--text)">${escHtml(a.name || a.id)}</div>
          ${badge}
        </div>
        <div style="margin-top:4px;font-family:'IBM Plex Mono',monospace;color:var(--muted)">${escHtml(a.id)}</div>
        <div style="margin-top:4px;font-size:11px;color:var(--muted)">last run: ${escHtml(lastRun)}</div>
        <div style="font-size:11px;color:var(--muted)">last heartbeat: ${escHtml(heartbeat)}</div>
      </button>
    `;
  }).join('');
}

function findSelectedAgent() {
  return agentsConfigList.find(a => a.id === selectedAgentId) || null;
}

function agentFormNew() {
  selectedAgentId = '';
  setAgentForm({
    id: '',
    name: '',
    emoji: '',
    description: '',
    workspace: '',
    model: '',
    cronSchedule: '',
    maxSteps: '',
    default: false,
    minimalPrompt: true,
    canSpawn: false,
    spawnAllowlist: [],
    tools: {},
  });
  if (agentMdEditor) agentMdEditor.setValue('');
  const mdPath = document.getElementById('agent-md-path');
  if (mdPath) mdPath.textContent = 'Select or save an agent to load AGENTS.md';
  const resultEl = document.getElementById('agent-spawn-result');
  if (resultEl) resultEl.textContent = '';
  renderAgentsList();
}

async function selectAgent(id) {
  selectedAgentId = id;
  const selected = findSelectedAgent();
  setAgentForm(selected);
  renderAgentsList();
  await loadSelectedAgentMd();
  await loadAgentRunHistory();
}

async function loadAgentsTab() {
  ensureAgentMdEditor();
  try {
    const data = await api('/api/agents');
    agentsConfigList = Array.isArray(data?.agents) ? data.agents : [];
    if (!selectedAgentId || !agentsConfigList.some(a => a.id === selectedAgentId)) {
      selectedAgentId = data?.defaultAgentId || agentsConfigList[0]?.id || '';
    }
    renderAgentsList();
    const selected = findSelectedAgent();
    setAgentForm(selected);
    if (selected) {
      await loadSelectedAgentMd();
      await loadAgentRunHistory();
    } else {
      agentFormNew();
    }
  } catch (err) {
    addProcessEntry('error', `Failed to load agents: ${err.message}`);
  }
}

async function saveAgentFromForm() {
  const agent = getAgentFromForm();
  if (!agent.id) {
    alert('Agent ID is required');
    return;
  }
  if (!agent.name) {
    alert('Agent name is required');
    return;
  }
  try {
    const exists = agentsConfigList.some(a => a.id === agent.id);
    const endpoint = exists ? `/api/agents/${encodeURIComponent(agent.id)}` : '/api/agents';
    const method = exists ? 'PUT' : 'POST';
    const data = await api(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent }),
    });
    if (!data?.success) throw new Error(data?.error || 'save failed');
    selectedAgentId = data?.agent?.id || agent.id;
    addProcessEntry('info', `Agent "${selectedAgentId}" saved.`);
    await loadAgentsTab();
  } catch (err) {
    alert(`Failed to save agent: ${err.message}`);
  }
}

async function deleteSelectedAgent() {
  if (!selectedAgentId) return;
  if (!confirm(`Delete agent "${selectedAgentId}"?`)) return;
  try {
    await api(`/api/agents/${encodeURIComponent(selectedAgentId)}`, { method: 'DELETE' });
    addProcessEntry('info', `Agent "${selectedAgentId}" deleted.`);
    selectedAgentId = '';
    await loadAgentsTab();
  } catch (err) {
    alert(`Failed to delete agent: ${err.message}`);
  }
}

async function loadSelectedAgentMd() {
  ensureAgentMdEditor();
  if (!selectedAgentId || !agentMdEditor) return;
  try {
    const data = await api(`/api/agents/${encodeURIComponent(selectedAgentId)}/agents-md`);
    agentMdEditor.setValue(data?.content || '');
    const pathEl = document.getElementById('agent-md-path');
    if (pathEl) pathEl.textContent = data?.path || '';
  } catch (err) {
    addProcessEntry('error', `Failed to load AGENTS.md: ${err.message}`);
  }
}

async function saveSelectedAgentMd() {
  if (!selectedAgentId || !agentMdEditor) return;
  try {
    const content = agentMdEditor.getValue();
    await api(`/api/agents/${encodeURIComponent(selectedAgentId)}/agents-md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    addProcessEntry('final', `Saved AGENTS.md for "${selectedAgentId}".`);
  } catch (err) {
    alert(`Failed to save AGENTS.md: ${err.message}`);
  }
}

async function runSelectedAgentOnce() {
  if (!selectedAgentId) return;
  const task = (document.getElementById('agent-spawn-task').value || '').trim();
  if (!task) {
    alert('Provide a task first.');
    return;
  }
  const out = document.getElementById('agent-spawn-result');
  if (out) out.textContent = 'Running...';
  try {
    const data = await api(`/api/agents/${encodeURIComponent(selectedAgentId)}/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task }),
    });
    const result = data?.result || {};
    if (out) {
      const head = result.success ? `Success (${result.durationMs || 0}ms)` : `Failed: ${result.error || 'unknown error'}`;
      out.textContent = `${head}\n\n${String(result.result || '').slice(0, 2500)}`;
    }
    await loadAgentsTab();
  } catch (err) {
    if (out) out.textContent = `Run failed: ${err.message}`;
  }
}

async function loadAgentRunHistory() {
  const el = document.getElementById('agent-run-history');
  if (!el) return;
  if (!selectedAgentId) { el.innerHTML = ''; return; }
  try {
    const data = await api(`/api/agents/history?agentId=${encodeURIComponent(selectedAgentId)}&limit=12`);
    const rows = Array.isArray(data?.history) ? data.history : [];
    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted)">暂无运行记录。</div>';
      return;
    }
    el.innerHTML = rows.map((r) => {
      const color = r.success ? '#1a6e35' : '#9c1a1a';
      const when = new Date(r.finishedAt || r.startedAt || Date.now()).toLocaleString();
      const label = `${r.trigger || 'manual'} • ${r.durationMs || 0}ms`;
      const preview = String(r.resultPreview || r.error || '').slice(0, 140);
      return `<div style="border:1px solid var(--line);border-radius:8px;padding:6px 8px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <span style="font-weight:700;color:${color}">${r.success ? 'success' : 'failed'}</span>
          <span style="font-size:11px;color:var(--muted)">${escHtml(when)}</span>
        </div>
        <div style="font-size:11px;color:var(--muted)">${escHtml(label)}</div>
        <div style="font-size:11px;color:var(--text);margin-top:2px">${escHtml(preview)}</div>
      </div>`;
    }).join('');
  } catch (err) {
    el.innerHTML = `<div style="color:#9c1a1a">Failed to load history: ${escHtml(err.message)}</div>`;
  }
}

// --- Channels Settings Functions ---------------------------------------
let channelsStatusLoaded = false;

function setChannelStatus(idPrefix, state, message) {
  const dot = document.getElementById(`${idPrefix}-status-dot`);
  const text = document.getElementById(`${idPrefix}-status-text`);
  if (!dot || !text) return;
  if (state === 'ok') {
    dot.style.background = 'var(--ok)';
    text.style.color = 'var(--text)';
  } else if (state === 'warn') {
    dot.style.background = '#f0ad4e';
    text.style.color = '#b87b00';
  } else {
    dot.style.background = '#ccc';
    text.style.color = 'var(--muted)';
  }
  text.textContent = message || 'Not configured';
}

function readChannelPayload(channel) {
  if (channel === 'telegram') {
    const userIdStr = (document.getElementById('settings-tg-userid')?.value || '').trim();
    const allowedUserIds = userIdStr ? userIdStr.split(/[,\s]+/).map(Number).filter(n => !isNaN(n) && n > 0) : [];
    return {
      enabled: !!document.getElementById('settings-tg-enabled')?.checked,
      botToken: (document.getElementById('settings-tg-token')?.value || '').trim(),
      allowedUserIds,
      streamMode: 'full',
    };
  }
  if (channel === 'discord') {
    return {
      enabled: !!document.getElementById('settings-dc-enabled')?.checked,
      botToken: (document.getElementById('settings-dc-token')?.value || '').trim(),
      applicationId: (document.getElementById('settings-dc-appid')?.value || '').trim(),
      guildId: (document.getElementById('settings-dc-guildid')?.value || '').trim(),
      channelId: (document.getElementById('settings-dc-channelid')?.value || '').trim(),
      webhookUrl: (document.getElementById('settings-dc-webhook')?.value || '').trim(),
    };
  }
  return {
    enabled: !!document.getElementById('settings-wa-enabled')?.checked,
    accessToken: (document.getElementById('settings-wa-token')?.value || '').trim(),
    phoneNumberId: (document.getElementById('settings-wa-phoneid')?.value || '').trim(),
    businessAccountId: (document.getElementById('settings-wa-baid')?.value || '').trim(),
    verifyToken: (document.getElementById('settings-wa-verify')?.value || '').trim(),
    webhookSecret: (document.getElementById('settings-wa-secret')?.value || '').trim(),
    testRecipient: (document.getElementById('settings-wa-recipient')?.value || '').trim(),
  };
}

function setButtonBusy(id, busy, busyLabel, normalLabel) {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.disabled = !!busy;
  btn.textContent = busy ? busyLabel : normalLabel;
}

function getSelectedChannelType() {
  return String(document.getElementById('settings-channel-select')?.value || 'telegram');
}

function onChannelTypeChange() {
  const ch = getSelectedChannelType();
  const formMap = {
    telegram: 'channel-form-telegram',
    discord: 'channel-form-discord',
    whatsapp: 'channel-form-whatsapp',
  };
  const guideMap = {
    telegram: 'channel-guide-telegram',
    discord: 'channel-guide-discord',
    whatsapp: 'channel-guide-whatsapp',
  };
  const statusMap = {
    telegram: 'tg-status-bar',
    discord: 'dc-status-bar',
    whatsapp: 'wa-status-bar',
  };
  ['telegram', 'discord', 'whatsapp'].forEach((k) => {
    const form = document.getElementById(formMap[k]);
    const guide = document.getElementById(guideMap[k]);
    const status = document.getElementById(statusMap[k]);
    if (form) form.style.display = (k === ch) ? 'block' : 'none';
    if (guide) guide.style.display = (k === ch) ? 'block' : 'none';
    if (status) status.style.display = (k === ch) ? 'flex' : 'none';
  });
}

async function saveSelectedChannelSettings() {
  await saveChannelSettings(getSelectedChannelType());
}

async function testSelectedChannel() {
  await testChannel(getSelectedChannelType());
}

async function sendSelectedChannelTest() {
  await sendChannelTest(getSelectedChannelType());
}

async function loadChannelsStatus() {
  try {
    const data = await api('/api/channels/status');
    if (!data?.success) return;
    const tg = data.telegram || {};
    const dc = data.discord || {};
    const wa = data.whatsapp || {};

    if (tg.connected && tg.polling) setChannelStatus('tg', 'ok', `Connected as @${tg.username || 'bot'}`);
    else if (tg.hasToken) setChannelStatus('tg', 'warn', 'Token saved, not connected');
    else setChannelStatus('tg', 'off', 'Not configured');

    if (dc.hasToken || dc.hasWebhook) setChannelStatus('dc', 'warn', 'Credentials saved');
    else setChannelStatus('dc', 'off', 'Not configured');

    if (wa.hasAccessToken && wa.phoneNumberId) setChannelStatus('wa', 'warn', 'Credentials saved');
    else setChannelStatus('wa', 'off', 'Not configured');

    if (!channelsStatusLoaded) {
      channelsStatusLoaded = true;
      if (tg.hasToken) document.getElementById('settings-tg-token').placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)';
      if (dc.hasToken) document.getElementById('settings-dc-token').placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)';
      if (wa.hasAccessToken) document.getElementById('settings-wa-token').placeholder = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved)';

      document.getElementById('settings-tg-enabled').checked = !!tg.enabled;
      document.getElementById('settings-tg-userid').value = (tg.allowedUserIds || []).join(', ');

      document.getElementById('settings-dc-enabled').checked = !!dc.enabled;
      document.getElementById('settings-dc-appid').value = dc.applicationId || '';
      document.getElementById('settings-dc-guildid').value = dc.guildId || '';
      document.getElementById('settings-dc-channelid').value = dc.channelId || '';

      document.getElementById('settings-wa-enabled').checked = !!wa.enabled;
      document.getElementById('settings-wa-phoneid').value = wa.phoneNumberId || '';
      document.getElementById('settings-wa-baid').value = wa.businessAccountId || '';
      document.getElementById('settings-wa-recipient').value = wa.testRecipient || '';
    }
    onChannelTypeChange();
  } catch (err) {
    console.error('[Channels] Status load failed:', err);
  }
}

async function saveChannelSettings(channel) {
  const payload = readChannelPayload(channel);
  try {
    const data = await api('/api/channels/config', {
      method: 'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ channels: { [channel]: payload } }),
    });
    if (data?.success) {
      addProcessEntry('final', `${channel} settings saved.`);
      channelsStatusLoaded = false;
      await loadChannelsStatus();
    } else {
      alert('Save failed: ' + (data?.error || 'unknown error'));
    }
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

async function testChannel(channel) {
  const btnId = document.getElementById('channel-test-btn')
    ? 'channel-test-btn'
    : channel === 'telegram' ? 'tg-test-btn' : channel === 'discord' ? 'dc-test-btn' : 'wa-test-btn';
  setButtonBusy(btnId, true, 'Testing...', 'Test');
  try {
    const payload = readChannelPayload(channel);
    const data = await api(`/api/channels/test/${channel}`, {
      method: 'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    if (data?.success) {
      if (channel === 'telegram') setChannelStatus('tg', 'ok', `Valid bot @${data?.bot?.username || 'telegram'}`);
      if (channel === 'discord') setChannelStatus('dc', 'ok', `Valid bot @${data?.bot?.username || 'discord'}`);
      if (channel === 'whatsapp') setChannelStatus('wa', 'ok', `Valid phone ${data?.account?.display_phone_number || data?.account?.id || ''}`.trim());
      addProcessEntry('final', `${channel} connection test passed.`);
    } else {
      alert(`${channel} test failed: ${data?.error || 'unknown error'}`);
    }
  } catch (err) {
    alert(`${channel} test failed: ${err.message}`);
  }
  setButtonBusy(btnId, false, 'Testing...', 'Test');
}

async function sendChannelTest(channel) {
  const btnId = document.getElementById('channel-send-test-btn')
    ? 'channel-send-test-btn'
    : channel === 'telegram' ? 'tg-send-test-btn' : channel === 'discord' ? 'dc-send-test-btn' : 'wa-send-test-btn';
  setButtonBusy(btnId, true, 'Sending...', 'Send Test');
  try {
    const payload = readChannelPayload(channel);
    const data = await api(`/api/channels/send-test/${channel}`, {
      method: 'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(payload),
    });
    if (data?.success) {
      addProcessEntry('final', `Test message sent via ${channel}.`);
    } else {
      alert(`${channel} send-test failed: ${data?.error || 'unknown error'}`);
    }
  } catch (err) {
    alert(`${channel} send-test failed: ${err.message}`);
  }
  setButtonBusy(btnId, false, 'Sending...', 'Send Test');
}

async function saveSettings() {
  const workspace_path = document.getElementById('settings-workspace-path').value.trim();
  const allowed_paths = document.getElementById('settings-allowed-paths').value.split('\n').map(s => s.trim()).filter(Boolean);
  const blocked_paths = document.getElementById('settings-blocked-paths').value.split('\n').map(s => s.trim()).filter(Boolean);
  const payload = {
    preferred_provider: document.getElementById('settings-provider').value,
    search_rigor: document.getElementById('settings-search-rigor').value,
    tavily_api_key: document.getElementById('cred-tavily-key')?.value.trim() || '',
    google_api_key: document.getElementById('cred-google-key')?.value.trim() || '',
    google_cx: document.getElementById('cred-google-cx')?.value.trim() || '',
    brave_api_key: document.getElementById('cred-brave-key')?.value.trim() || '',
  };
  const policyPayload = {
    force_web_for_fresh: document.getElementById('settings-force-web-fresh').checked,
    memory_fallback_on_search_failure: document.getElementById('settings-memory-fallback').checked,
    auto_store_web_facts: document.getElementById('settings-auto-store-web-facts').checked,
    natural_language_tool_router: document.getElementById('settings-nl-tool-router').checked,
    retrieval_mode: document.getElementById('settings-retrieval-mode').value,
  };
  // NOTE: we deliberately do NOT send primary_model / role_models here anymore.
  // Saving the general settings panel used to overwrite models.primary and all
  // three role models with a single value. Model switching now happens through
  // model presets (/api/models/presets/switch), which updates models.primary
  // consistently. Only the Ollama endpoint is synced from this panel.
  const modelPayload = {
    ollama_endpoint: (document.getElementById('settings-ollama-endpoint') || {}).value || 'http://localhost:11434',
  };
  const providerPayload = buildProviderPayload();
  try {
    await api('/api/settings/paths', { method: 'POST', body: JSON.stringify({ workspace_path, allowed_paths, blocked_paths }) });
    await api('/api/settings/search', { method: 'POST', body: JSON.stringify(payload) });
    await api('/api/settings/agent', { method: 'POST', body: JSON.stringify(policyPayload) });
    await api('/api/settings/model', { method: 'POST', body: JSON.stringify(modelPayload) });
    await api('/api/settings/provider', { method: 'POST', body: JSON.stringify({ llm: providerPayload }) });
    await loadSearchSettingsSummary();
    quickSearchRigor = payload.search_rigor || quickSearchRigor;
    updateQuickModeUI();
    addProcessEntry('final', 'Settings saved.');
    closeSettings();
  } catch (err) {
    addProcessEntry('error', `Failed to save settings: ${err.message}`);
  }
}

// Approve a memory suggestion shown in the process log
async function confirmMemory(index) {
  const entry = processLogEntries[index];
  if (!entry || entry.type !== 'memory') return;
  const suggestion = entry.extra || {};
  try {
    addProcessEntry('info', 'Saving memory...');
    const res = await api('/api/memory/confirm', { method: 'POST', body: JSON.stringify(suggestion) });
    if (res && res.ok === false) {
      addProcessEntry('error', `Memory save failed: ${res.error || JSON.stringify(res)}`);
      return;
    }
    processLogEntries[index].type = 'result';
    processLogEntries[index].content = `Saved memory: ${String(entry.content).slice(0,200)}`;
    renderProcessLog();
    addProcessEntry('final', 'Memory persisted.');
  } catch (err) {
    addProcessEntry('error', `Failed to save memory: ${err.message}`);
  }
}

function rejectMemory(index) {
  const entry = processLogEntries[index];
  if (!entry || entry.type !== 'memory') return;
  processLogEntries[index].type = 'warn';
  processLogEntries[index].content = 'Memory suggestion rejected.';
  renderProcessLog();
  addProcessEntry('info', 'Memory suggestion rejected by user.');
}

// ---- Run mission ----
async function runMission() {
  const input = document.getElementById('mission-input');
  const btn = document.getElementById('run-btn');
  const mission = input.value.trim();
  if (!mission) return;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Starting...';

  try {
    const res = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ mission }) });
    if (res.error) {
      log(`Error: ${res.error}`, 'error');
    } else {
      log(`Mission started ? Job ${res.jobId.slice(0, 8)}...`, 'success');
      input.value = '';
      setTimeout(() => selectJob(res.jobId), 500);
    }
  } catch (err) {
    log(`Failed: ${err.message}`, 'error');
  }

  btn.disabled = false;
  btn.innerHTML = '? Run';
}

// ---- Sessions list ----
function renderSessionsList() {
  const el = document.getElementById('jobs-list');
  if (!chatSessions || chatSessions.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无对话。<br>开始新的对话吧。</div>';
    return;
  }
  const sorted = [...chatSessions].sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  el.innerHTML = sorted.map(s => `
    <div class="job-item ${s.id === activeChatSessionId ? 'active' : ''}${s.unread ? ' unread' : ''}" onclick="openSession('${s.id}')">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div class="job-item-title" style="flex:1">${s.unread ? '🔵 ' : ''}${escHtml(s.title || 'New chat')}</div>
        ${sessionsEditMode ? `<button class="sidebar-action" style="padding:3px 8px;font-size:10px" onclick="deleteChatSession('${s.id}', event)">Delete</button>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
        ${s.automated ? '<span class="session-auto-badge">Auto</span>' : ''}
        <span class="badge badge-queued">${(s.history || []).length} msgs</span>
        <span style="color:var(--muted);font-size:10px">${timeAgo(s.updatedAt || s.createdAt)}</span>
      </div>
    </div>
  `).join('');
}

// ---- Select job ----
async function selectJob(jobId) {
  selectedJobId = jobId;
  setMode('chat');
  renderJobsList(allJobs);
  await refreshJobDetail(jobId);
  clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    const job = allJobs.find(j => j.id === jobId);
    if (job && ['planning', 'executing', 'verifying'].includes(job.status)) {
      await refreshJobDetail(jobId);
    } else {
      clearInterval(pollInterval);
    }
  }, 2000);
}

async function refreshJobDetail(jobId) {
  try {
    const data = await api(`/api/jobs/${jobId}`);
    renderJobDetail(data);
  } catch {}
}

function renderJobDetail(data) {
  const { job, tasks, artifacts, state } = data;
  const content = document.getElementById('main-content');
  const isRunning = ['planning','executing','verifying'].includes(job.status);

  content.innerHTML = `
    <div class="job-detail-title">${escHtml(job.title)}</div>
    <div class="job-detail-meta">
      <span class="badge badge-${job.status}">${isRunning ? '<span class="spinner"></span>' : ''}${job.status}</span>
      <span>ID: ${job.id.slice(0, 12)}...</span>
      <span>${timeAgo(job.created_at)}</span>
    </div>

    ${state ? `
    <div class="section-title">Mission</div>
    <div style="color:var(--muted);font-size:12px;line-height:1.7;background:var(--bg2);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:16px">
      ${escHtml(state.mission)}
    </div>` : ''}

    ${tasks && tasks.length > 0 ? `
    <div class="section-title">Tasks (${tasks.length})</div>
    ${tasks.map(t => `
      <div class="task-card">
        <div class="task-card-header">
          <span class="task-card-title">${escHtml(t.title)}</span>
          <span class="badge badge-${t.status}">${t.status}</span>
        </div>
        <div class="task-card-desc">${escHtml(t.description || '')}</div>
        ${t.acceptance_criteria && t.acceptance_criteria.length > 0 ? `
        <div class="task-criteria">
          ${t.acceptance_criteria.map(c => `<div class="task-criteria-item">${escHtml(c)}</div>`).join('')}
        </div>` : ''}
      </div>
    `).join('')}` : `
    <div class="section-title">Tasks</div>
    <div style="color:var(--muted);font-size:12px;padding:20px 0">
      ${isRunning ? '<span class="spinner pulsing"></span> Planning tasks...' : 'No tasks'}
    </div>`}

    ${artifacts && artifacts.length > 0 ? `
    <div class="section-title" style="margin-top:16px">Artifacts (${artifacts.length})</div>
    ${artifacts.map(a => `
      <div class="task-card">
        <div class="task-card-header">
          <span class="task-card-title">${escHtml(a.path || a.type)}</span>
          <span class="badge badge-completed">${a.type}</span>
        </div>
        ${a.content ? `<div class="task-card-desc" style="margin-top:6px">${escHtml(a.content.slice(0, 200))}${a.content.length > 200 ? '...' : ''}</div>` : ''}
      </div>
    `).join('')}` : ''}

    <div id="log-panel">${logLines.map(l => `<div class="log-line ${l.type}">${l.text}</div>`).join('')}</div>
  `;

  const lp = document.getElementById('log-panel');
  if (lp) lp.scrollTop = lp.scrollHeight;
}

// ---- Stats ----
function updateStats(jobs) {
  const totalEl = document.getElementById('r-total');
  const runningEl = document.getElementById('r-running');
  const modeEl = document.getElementById('r-completed');
  if (totalEl) totalEl.textContent = String(chatSessions.length);
  if (runningEl) runningEl.textContent = activeChatSessionId ? '1' : '0';
  if (modeEl) modeEl.textContent = orchestrationEnabled ? 'On' : 'Off';
}

// ---- Approvals ----
async function loadApprovals() {
  try {
    const approvals = await api('/api/approvals');
    const el = document.getElementById('approvals-list');
    if (!approvals || approvals.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-size:11px">No pending approvals</div>';
      return;
    }
    el.innerHTML = approvals.map(a => `
      <div class="approval-card">
        <div class="approval-action">${escHtml(a.action)}</div>
        <div class="approval-reason">${escHtml(a.reason || 'Approval required')}</div>
        <div class="approval-buttons">
          <button class="btn btn-sm btn-green" onclick="resolveApproval('${a.id}','approved')">? Approve</button>
          <button class="btn btn-sm btn-red" onclick="resolveApproval('${a.id}','rejected')">? Reject</button>
        </div>
      </div>
    `).join('');
  } catch {}
}

async function resolveApproval(id, decision) {
  await api(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ decision }) });
  loadApprovals();
}

function fmtPercent(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--%';
  return `${n.toFixed(digits)}%`;
}

function fmtMemoryGb(usedGb, totalGb) {
  const u = Number(usedGb);
  const t = Number(totalGb);
  if (!Number.isFinite(u) || !Number.isFinite(t) || t <= 0) return '-- / -- GB';
  return `${u.toFixed(1)} / ${t.toFixed(1)} GB`;
}

function meterWidth(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return '0%';
  const bounded = Math.max(0, Math.min(100, n));
  return `${bounded}%`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text || '');
}

function setMeter(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.width = meterWidth(pct);
}

let systemStatsFetchInFlight = false;
async function loadSystemStats() {
  if (systemStatsFetchInFlight) return;
  systemStatsFetchInFlight = true;
  try {
    const boot = window.__bootData;
    const stats = (boot && boot.systemStats) || await api('/api/system-stats');
    const cpu = stats?.system?.cpu_percent;
    const ram = stats?.system?.memory_percent;
    const gpu = stats?.gpu?.gpu_util_percent;
    const vram = stats?.gpu?.vram_used_percent;
    const gpuAvailable = !!stats?.gpu?.available;

    setText('quick-system-stats', `CPU ${fmtPercent(cpu)} • RAM ${fmtPercent(ram)} • GPU ${gpuAvailable ? fmtPercent(gpu) : '--%'}`);

    setText('sys-cpu', fmtPercent(cpu));
    setText('sys-ram', fmtPercent(ram));
    setText('sys-gpu', gpuAvailable ? fmtPercent(gpu) : 'N/A');
    setText('sys-vram', gpuAvailable ? fmtPercent(vram) : 'N/A');
    setMeter('sys-cpu-meter', cpu);
    setMeter('sys-ram-meter', ram);
    setMeter('sys-gpu-meter', gpuAvailable ? gpu : 0);
    setMeter('sys-vram-meter', gpuAvailable ? vram : 0);

    const ollamaRunning = !!stats?.ollama_process?.running;
    const ollamaCount = Number(stats?.ollama_process?.process_count || 0);
    const ollamaMemMb = Number(stats?.ollama_process?.total_memory_mb || 0);
    const gatewayRss = Number(stats?.gateway_process?.rss_mb || 0);
    const gpuName = String(stats?.gpu?.name || '').trim();
    const memUsage = fmtMemoryGb(stats?.system?.memory_used_gb, stats?.system?.memory_total_gb);
    const updated = new Date(stats?.timestamp || Date.now()).toLocaleTimeString();
    const activeProvider = stats?.active_provider || 'ollama';
    const activeModel = stats?.active_model || document.getElementById('current-model')?.textContent || '-';
    const isLocalProvider = activeProvider === 'ollama' || activeProvider === 'llama_cpp' || activeProvider === 'lm_studio';

    // Show provider + model in the runtime card
    const providerDisp = (PROVIDER_LABELS[activeProvider] || activeProvider);
    let runtimeLabel;
    if (activeProvider === 'ollama') {
      runtimeLabel = ollamaRunning ? `Ollama • ${activeModel}` : `Ollama offline • ${activeModel}`;
    } else {
      runtimeLabel = `${providerDisp} • ${activeModel}`;
    }
    setText('sys-ollama', runtimeLabel);
    const memPart = isLocalProvider && ollamaMemMb > 0 ? ` • LLM ${ollamaMemMb.toFixed(0)} MB` : '';
    setText(
      'sys-runtime-sub',
      `${memUsage}${memPart} • Gateway ${gatewayRss.toFixed(0)} MB${gpuName ? ` • ${gpuName}` : ''} • ${updated}`
    );
  } catch {
    setText('quick-system-stats', 'CPU --% • RAM --% • GPU --%');
    setText('sys-cpu', '--%');
    setText('sys-ram', '--%');
    setText('sys-gpu', 'N/A');
    setText('sys-vram', 'N/A');
    setText('sys-ollama', 'Stats unavailable');
    setText('sys-runtime-sub', 'Could not fetch system stats right now');
    setMeter('sys-cpu-meter', 0);
    setMeter('sys-ram-meter', 0);
    setMeter('sys-gpu-meter', 0);
    setMeter('sys-vram-meter', 0);
  } finally {
    systemStatsFetchInFlight = false;
  }
}

// ---- Status ----
const PROVIDER_LABELS = {
  ollama: 'Ollama', llama_cpp: 'llama.cpp', lm_studio: 'LM Studio',
  openai: 'OpenAI', openai_codex: 'ChatGPT'
};
async function checkStatus() {
  try {
    const boot = window.__bootData;
    const status = (boot && boot.status) || await api('/api/status');
    const provider = status.provider || 'ollama';
    const providerLabel = PROVIDER_LABELS[provider] || provider;
    const isCloud = provider === 'openai' || provider === 'openai_codex';
    const dot = document.getElementById('ollama-dot');

    // For cloud providers, always show as online if gateway is up
    const backendOnline = isCloud ? true : (status.providerOnline ?? !!status.ollama);
    dot.className = 'dot ' + (backendOnline ? 'online' : 'offline');
    document.getElementById('ollama-status').textContent = backendOnline
      ? `${providerLabel} Online` : `${providerLabel} Offline`;
    const ro = document.getElementById('r-ollama');
    if (ro) {
      ro.textContent = backendOnline ? 'Online' : 'Offline';
      ro.className = 'info-val ' + (backendOnline ? 'green' : 'red');
    }

    const modelName = status.currentModel || '-';
    const rm = document.getElementById('r-model');
    if (rm) rm.textContent = modelName;
    document.getElementById('current-model').textContent = modelName;
    const cmn = document.getElementById('chat-model-name');
    if (cmn) cmn.textContent = modelName;
    const badge = document.getElementById('current-provider-badge');
    if (badge) badge.textContent = isCloud ? providerLabel.toUpperCase() : '';
    const cpn = document.getElementById('chat-provider-name');
    if (cpn) cpn.textContent = providerLabel;
  } catch {
    document.getElementById('ollama-dot').className = 'dot offline';
  }
}

// --- Orchestration Settings -------------------------------------------------

const SECONDARY_MODEL_DEFAULTS = {
  openai_codex: 'gpt-5.3-codex',
  openai:       'gpt-4o',
  ollama:       '',
  llama_cpp:    '',
  lm_studio:    '',
};

const ORCH_STATIC_MODEL_OPTIONS = {
  openai_codex: ['gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2-codex', 'gpt-5.1-codex-mini'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3'],
};

function getSelectOptionValues(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return [];
  return Array.from(sel.options || []).map(o => String(o.value || '').trim()).filter(Boolean);
}

function getDraftModelForProvider(provider) {
  if (provider === 'ollama') {
    return String(document.getElementById('settings-primary-model')?.value || '').trim();
  }
  if (provider === 'llama_cpp') {
    return String(document.getElementById('settings-llamacpp-model')?.value || '').trim();
  }
  if (provider === 'lm_studio') {
    return String(document.getElementById('settings-lmstudio-model')?.value || '').trim();
  }
  if (provider === 'openai') {
    return String(document.getElementById('settings-openai-model')?.value || '').trim();
  }
  if (provider === 'openai_codex') {
    return String(document.getElementById('settings-codex-model')?.value || '').trim();
  }
  return '';
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const v of values || []) {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

async function updateOrchSecondaryModels(preferredModel = '') {
  const provider = document.getElementById('orch-secondary-provider')?.value || '';
  const modelSelect = document.getElementById('orch-secondary-model');
  if (!modelSelect) return;

  if (!provider) {
    modelSelect.innerHTML = '<option value="">— select provider first —</option>';
    modelSelect.value = '';
    return;
  }

  let models = [];
  const draftModel = getDraftModelForProvider(provider);
  if (draftModel) models.push(draftModel);

  if (provider === 'openai') {
    try { await refreshOpenAIModels(true); } catch {}
    models.push(...getSelectOptionValues('settings-openai-model'));
  } else if (provider === 'openai_codex') {
    models.push(...getSelectOptionValues('settings-codex-model'));
  } else if (['ollama', 'llama_cpp', 'lm_studio'].includes(provider)) {
    try {
      const llm = buildProviderPayload();
      llm.provider = provider;
      const data = await api('/api/models/test', { method: 'POST', body: JSON.stringify({ llm }) });
      const detected = (data?.models || []).map(m => typeof m === 'string' ? m : (m.name || String(m)));
      models.push(...detected);
    } catch {}
  }

  models = uniqueStrings([...(ORCH_STATIC_MODEL_OPTIONS[provider] || []), ...models]);
  if (preferredModel && !models.includes(preferredModel)) {
    models.unshift(preferredModel);
  }
  if (!models.length && SECONDARY_MODEL_DEFAULTS[provider]) {
    models.push(SECONDARY_MODEL_DEFAULTS[provider]);
  }

  if (!models.length) {
    modelSelect.innerHTML = '<option value="">— no models detected —</option>';
    modelSelect.value = '';
    return;
  }

  modelSelect.innerHTML = models.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  const selected = preferredModel || modelSelect.value || draftModel || SECONDARY_MODEL_DEFAULTS[provider] || models[0];
  modelSelect.value = models.includes(selected) ? selected : models[0];
}

async function loadOrchestrationConfig() {
  try {
    const cfg = await api('/api/orchestration/config');
    const provEl    = document.getElementById('orch-secondary-provider');
    const failEl    = document.getElementById('orch-fail-threshold');
    const stagEl    = document.getElementById('orch-stagnation');
    const loopEl    = document.getElementById('orch-loop-detect');
    const riskFilesEl = document.getElementById('orch-risk-files');
    const riskOpsEl = document.getElementById('orch-risk-ops');
    const noProgressEl = document.getElementById('orch-no-progress-sec');
    const preflightModeEl = document.getElementById('orch-preflight-mode');
    const allowSecondaryChatEl = document.getElementById('orch-allow-secondary-chat');
    const cooldownEl = document.getElementById('orch-cooldown-rounds');
    const maxAssistTurnEl = document.getElementById('orch-max-assists-turn');
    const maxAssistSessionEl = document.getElementById('orch-max-assists-session');
    const browserCallsEl = document.getElementById('orch-browser-calls-turn');
    const browserItemsEl = document.getElementById('orch-browser-max-items');
    const browserRetriesEl = document.getElementById('orch-browser-forced-retries');
    const preemptEnabledEl = document.getElementById('orch-preempt-enabled');
    const preemptThresholdEl = document.getElementById('orch-preempt-threshold');
    const preemptMaxTurnEl = document.getElementById('orch-preempt-max-turn');
    const preemptMaxSessionEl = document.getElementById('orch-preempt-max-session');
    const fileOpsEnabledEl = document.getElementById('orch-fileops-enabled');
    const fileOpsVerifyCreateEl = document.getElementById('orch-fileops-verify-create');
    const fileOpsCreateLinesEl = document.getElementById('orch-fileops-create-lines');
    const fileOpsCreateCharsEl = document.getElementById('orch-fileops-create-chars');
    const fileOpsEditLinesEl = document.getElementById('orch-fileops-edit-lines');
    const fileOpsEditCharsEl = document.getElementById('orch-fileops-edit-chars');
    const fileOpsEditFilesEl = document.getElementById('orch-fileops-edit-files');
    const fileOpsVerifyLinesEl = document.getElementById('orch-fileops-verify-lines');
    const fileOpsVerifyCharsEl = document.getElementById('orch-fileops-verify-chars');
    const fileOpsWatchdogCyclesEl = document.getElementById('orch-fileops-watchdog-cycles');
    const fileOpsCheckpointingEl = document.getElementById('orch-fileops-checkpointing');
    if (provEl)  provEl.value  = cfg.secondary?.provider || '';
    await updateOrchSecondaryModels(cfg.secondary?.model || '');
    if (failEl)  failEl.value  = String(cfg.triggers?.consecutive_failures ?? 2);
    if (stagEl)  stagEl.value  = String(cfg.triggers?.stagnation_rounds    ?? 3);
    if (loopEl)  loopEl.value  = String(cfg.triggers?.loop_detection       ?? true);
    if (riskFilesEl) riskFilesEl.value = String(cfg.triggers?.risky_files_threshold ?? 6);
    if (riskOpsEl) riskOpsEl.value = String(cfg.triggers?.risky_tool_ops_threshold ?? 220);
    if (noProgressEl) noProgressEl.value = String(cfg.triggers?.no_progress_seconds ?? 90);
    if (preflightModeEl) preflightModeEl.value = String(cfg.preflight?.mode || 'complex_only');
    if (allowSecondaryChatEl) allowSecondaryChatEl.value = String(cfg.preflight?.allow_secondary_chat === true);
    if (cooldownEl) cooldownEl.value = String(cfg.limits?.assist_cooldown_rounds ?? 3);
    if (maxAssistTurnEl) maxAssistTurnEl.value = String(cfg.limits?.max_assists_per_turn ?? 3);
    if (maxAssistSessionEl) maxAssistSessionEl.value = String(cfg.limits?.max_assists_per_session ?? 18);
    if (browserCallsEl) browserCallsEl.value = String(cfg.browser?.max_advisor_calls_per_turn ?? 5);
    if (browserItemsEl) browserItemsEl.value = String(cfg.browser?.max_collected_items ?? 80);
    if (browserRetriesEl) browserRetriesEl.value = String(cfg.browser?.max_forced_retries ?? 2);
    if (preemptEnabledEl) preemptEnabledEl.value = String(cfg.preempt?.enabled === true);
    if (preemptThresholdEl) preemptThresholdEl.value = String(cfg.preempt?.stall_threshold_seconds ?? 45);
    if (preemptMaxTurnEl) preemptMaxTurnEl.value = String(cfg.preempt?.max_preempts_per_turn ?? 1);
    if (preemptMaxSessionEl) preemptMaxSessionEl.value = String(cfg.preempt?.max_preempts_per_session ?? 3);
    if (fileOpsEnabledEl) fileOpsEnabledEl.value = String(cfg.file_ops?.enabled !== false);
    if (fileOpsVerifyCreateEl) fileOpsVerifyCreateEl.value = String(cfg.file_ops?.verify_create_always !== false);
    if (fileOpsCreateLinesEl) fileOpsCreateLinesEl.value = String(cfg.file_ops?.primary_create_max_lines ?? 80);
    if (fileOpsCreateCharsEl) fileOpsCreateCharsEl.value = String(cfg.file_ops?.primary_create_max_chars ?? 3500);
    if (fileOpsEditLinesEl) fileOpsEditLinesEl.value = String(cfg.file_ops?.primary_edit_max_lines ?? 12);
    if (fileOpsEditCharsEl) fileOpsEditCharsEl.value = String(cfg.file_ops?.primary_edit_max_chars ?? 800);
    if (fileOpsEditFilesEl) fileOpsEditFilesEl.value = String(cfg.file_ops?.primary_edit_max_files ?? 1);
    if (fileOpsVerifyLinesEl) fileOpsVerifyLinesEl.value = String(cfg.file_ops?.verify_large_payload_lines ?? 25);
    if (fileOpsVerifyCharsEl) fileOpsVerifyCharsEl.value = String(cfg.file_ops?.verify_large_payload_chars ?? 1200);
    if (fileOpsWatchdogCyclesEl) fileOpsWatchdogCyclesEl.value = String(cfg.file_ops?.watchdog_no_progress_cycles ?? 3);
    if (fileOpsCheckpointingEl) fileOpsCheckpointingEl.value = String(cfg.file_ops?.checkpointing_enabled !== false);
    syncOrchPreemptControls();
    // Check eligibility
    const elig = await api('/api/orchestration/eligible');
    const msg  = document.getElementById('orch-eligibility-msg');
    if (msg) {
      if (elig.eligible) {
        msg.textContent = '? Orchestration eligible — enable the skill in the Skills tab.';
        msg.style.color = 'var(--green, #4ade80)';
      } else {
        msg.textContent = elig.reason || 'Not eligible.';
        msg.style.color = 'var(--muted)';
      }
      msg.style.display = 'block';
    }
  } catch {}
}

async function saveOrchestrationConfig() {
  const provider = document.getElementById('orch-secondary-provider')?.value || '';
  const model    = document.getElementById('orch-secondary-model')?.value    || '';
  const failT    = Number(document.getElementById('orch-fail-threshold')?.value  || 2);
  const stagT    = Number(document.getElementById('orch-stagnation')?.value      || 3);
  const loopD    = document.getElementById('orch-loop-detect')?.value !== 'false';
  const riskFiles = Number(document.getElementById('orch-risk-files')?.value || 6);
  const riskOps = Number(document.getElementById('orch-risk-ops')?.value || 220);
  const noProgressSeconds = Number(document.getElementById('orch-no-progress-sec')?.value || 90);
  const preflightMode = document.getElementById('orch-preflight-mode')?.value || 'complex_only';
  const allowSecondaryChat = document.getElementById('orch-allow-secondary-chat')?.value === 'true';
  const cooldownRounds = Number(document.getElementById('orch-cooldown-rounds')?.value || 3);
  const maxAssistsTurn = Number(document.getElementById('orch-max-assists-turn')?.value || 3);
  const maxAssistsSession = Number(document.getElementById('orch-max-assists-session')?.value || 18);
  const browserCallsPerTurn = Number(document.getElementById('orch-browser-calls-turn')?.value || 5);
  const browserMaxItems = Number(document.getElementById('orch-browser-max-items')?.value || 80);
  const browserForcedRetries = Number(document.getElementById('orch-browser-forced-retries')?.value || 2);
  const preemptEnabled = document.getElementById('orch-preempt-enabled')?.value === 'true';
  const preemptThresholdSec = Number(document.getElementById('orch-preempt-threshold')?.value || 45);
  const preemptMaxTurn = Number(document.getElementById('orch-preempt-max-turn')?.value || 1);
  const preemptMaxSession = Number(document.getElementById('orch-preempt-max-session')?.value || 3);
  const fileOpsEnabled = document.getElementById('orch-fileops-enabled')?.value !== 'false';
  const fileOpsVerifyCreate = document.getElementById('orch-fileops-verify-create')?.value !== 'false';
  const fileOpsCreateLines = Number(document.getElementById('orch-fileops-create-lines')?.value || 80);
  const fileOpsCreateChars = Number(document.getElementById('orch-fileops-create-chars')?.value || 3500);
  const fileOpsEditLines = Number(document.getElementById('orch-fileops-edit-lines')?.value || 12);
  const fileOpsEditChars = Number(document.getElementById('orch-fileops-edit-chars')?.value || 800);
  const fileOpsEditFiles = Number(document.getElementById('orch-fileops-edit-files')?.value || 1);
  const fileOpsVerifyLines = Number(document.getElementById('orch-fileops-verify-lines')?.value || 25);
  const fileOpsVerifyChars = Number(document.getElementById('orch-fileops-verify-chars')?.value || 1200);
  const fileOpsWatchdogCycles = Number(document.getElementById('orch-fileops-watchdog-cycles')?.value || 3);
  const fileOpsCheckpointing = document.getElementById('orch-fileops-checkpointing')?.value !== 'false';
  try {
    await api('/api/orchestration/config', {
      method: 'POST',
      body: JSON.stringify({
        secondary: { provider, model },
        triggers:  {
          consecutive_failures: failT,
          stagnation_rounds: stagT,
          loop_detection: loopD,
          risky_files_threshold: riskFiles,
          risky_tool_ops_threshold: riskOps,
          no_progress_seconds: noProgressSeconds,
        },
        preflight: { mode: preflightMode, allow_secondary_chat: allowSecondaryChat },
        limits: {
          assist_cooldown_rounds: cooldownRounds,
          max_assists_per_turn: maxAssistsTurn,
          max_assists_per_session: maxAssistsSession,
        },
        browser: {
          max_advisor_calls_per_turn: browserCallsPerTurn,
          max_collected_items: browserMaxItems,
          max_forced_retries: browserForcedRetries,
        },
        preempt: {
          enabled: preemptEnabled,
          stall_threshold_seconds: preemptThresholdSec,
          max_preempts_per_turn: preemptMaxTurn,
          max_preempts_per_session: preemptMaxSession,
        },
        file_ops: {
          enabled: fileOpsEnabled,
          primary_create_max_lines: fileOpsCreateLines,
          primary_create_max_chars: fileOpsCreateChars,
          primary_edit_max_lines: fileOpsEditLines,
          primary_edit_max_chars: fileOpsEditChars,
          primary_edit_max_files: fileOpsEditFiles,
          verify_create_always: fileOpsVerifyCreate,
          verify_large_payload_lines: fileOpsVerifyLines,
          verify_large_payload_chars: fileOpsVerifyChars,
          watchdog_no_progress_cycles: fileOpsWatchdogCycles,
          checkpointing_enabled: fileOpsCheckpointing,
        },
      }),
    });
    const msg = document.getElementById('orch-eligibility-msg');
    if (msg) {
      msg.textContent = '? Saved. Now enable the Multi-Agent Orchestrator skill in the Skills tab.';
      msg.style.color = 'var(--green, #4ade80)';
      msg.style.display = 'block';
    }
    loadOrchestrationConfig(); // refresh eligibility
    loadInstalledSkills(); // refresh skill gating state
  } catch (err) {
    alert('Failed to save: ' + (err.message || err));
  }
}

function syncOrchPreemptControls() {
  const provider = document.getElementById('settings-llm-provider')?.value || 'ollama';
  const note = document.getElementById('orch-preempt-note');
  const fields = [
    document.getElementById('orch-preempt-enabled'),
    document.getElementById('orch-preempt-threshold'),
    document.getElementById('orch-preempt-max-turn'),
    document.getElementById('orch-preempt-max-session'),
  ].filter(Boolean);
  const ollamaPrimary = provider === 'ollama';
  fields.forEach(el => { el.disabled = !ollamaPrimary; });
  if (note) note.style.display = ollamaPrimary ? 'none' : 'block';
}

// --- Skill card eligibility rendering ---------------------------------------

function renderSkillEligibility(skills) {
  // Called after skills render — grey out ineligible skill cards
  setTimeout(() => {
    document.querySelectorAll('.skill-card').forEach(card => {
      const skillId = card.dataset.skillId;
      const skill   = skills.find(s => s.id === skillId);
      if (!skill) return;
      if (skill.eligible === false) {
        card.style.opacity = '0.5';
        // Keep card clickable when already enabled so user can still disable it.
        card.style.pointerEvents = skill.enabled ? 'auto' : 'none';
        card.title = skill.eligibleReason || 'Not available';
        const badge = document.createElement('div');
        badge.textContent = skill.eligibleReason || 'Configure secondary model first';
        badge.style = 'font-size:10px;color:var(--muted);margin-top:4px;';
        if (!card.querySelector('.elig-badge')) {
          badge.className = 'elig-badge';
          card.appendChild(badge);
        }
      }
    });
  }, 50);
}

// --- Handle orchestration SSE events ----------------------------------------

function handleOrchestrationEvent(data) {
  const panel =
    document.getElementById('tool-calls-panel')
    || document.getElementById('steps-panel')
    || document.getElementById('current-turn-process')
    || document.getElementById('process-log');
  if (!panel) return;
  const el = document.createElement('div');
  el.style = 'padding:6px 10px;margin:4px 0;background:linear-gradient(135deg,#1a1a2e,#16213e);border-left:3px solid #7c3aed;border-radius:4px;font-size:12px;color:#a78bfa;';
  const modeLabel = data.mode === 'planner' ? 'Planner' : 'Rescue';
  const routeText = data.route ? ` | route=${data.route}` : '';
  const countText = (typeof data.assist_count === 'number' && typeof data.assist_cap === 'number')
    ? ` | assists ${data.assist_count}/${data.assist_cap}`
    : '';
  el.innerHTML = `<strong>Advisor (${modeLabel})</strong><br><span style="color:var(--muted)">Trigger: ${data.reason || data.trigger}${routeText}${countText}</span>`;
  if (data.advice?.next_actions?.length) {
    el.innerHTML += '<br><span style="color:#e2e8f0">? ' + data.advice.next_actions[0] + '</span>';
  }
  if (data.preflight?.quick_plan?.length) {
    el.innerHTML += '<br><span style="color:#e2e8f0">? ' + data.preflight.quick_plan[0] + '</span>';
  }
  panel.appendChild(el);
  panel.scrollTop = panel.scrollHeight;
}

// --- Expose to SSE handler ---------------------------------------------------

if (typeof window !== 'undefined') {
  window._orchEventHandler = handleOrchestrationEvent;
}

// ---- Refresh all ----
async function refreshAll() {
  // Prefetch the aggregated startup payload once; consumers (checkStatus /
  // loadSystemStats / orchestration / search+think settings) reuse it and skip
  // their individual first-round requests. Falls back to per-endpoint fetches
  // when the aggregate is unavailable.
  try {
    const boot = await api('/api/bootstrap');
    window.__bootData = (boot && boot.ok) ? boot : undefined;
  } catch {
    window.__bootData = undefined;
  }
  renderSessionsList();
  updateStats([]);
  loadApprovals();
  checkStatus();
  loadSystemStats();
  loadInstalledSkills();
  loadSearchSettingsSummary();
  updateAgentModeIndicator();
  loadAgentSessionContext();
}

// ---- Log ----
const logLines = [];
function log(text, type = 'log') {
  const ts = new Date().toLocaleTimeString();
  logLines.push({ text: `[${ts}] ${text}`, type });
  if (logLines.length > 100) logLines.shift();
  const lp = document.getElementById('log-panel');
  if (lp) {
    lp.innerHTML = logLines.map(l => `<div class="log-line ${l.type}">${l.text}</div>`).join('');
    lp.scrollTop = lp.scrollHeight;
  }
}

// ---- Helpers ----
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
  return `${Math.floor(diff/86400000)}d ago`;
}

function openOllamaInfo() { window.open('http://localhost:11434','_blank'); }

// ---- Flow templates (one-click process fix) ----
let flowsCache = [];

async function loadFlows() {
  const el = document.getElementById('flows-list');
  el.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:11px"><span class="spinner"></span> Loading...</div>';
  try {
    const data = await api('/api/flows');
    const flows = data.flows || [];
    flowsCache = flows;
    if (flows.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:16px">No flows yet.<br>Drop a JSON template into .smallclaw/flows/</div>';
      return;
    }
    el.innerHTML = flows.map(f => `
      <div class="skill-card" data-flow-id="${escHtml(f.id)}">
        <div class="skill-card-top">
          <div class="skill-card-emoji">⚡</div>
          <div class="skill-card-info">
            <div class="skill-card-name">${escHtml(f.name)}</div>
            <div class="skill-card-desc">${escHtml(f.description || '')}</div>
            <div class="skill-card-desc" style="font-size:10px;opacity:.75">触发词：${escHtml((f.triggers || []).join(' / '))}</div>
          </div>
          <div class="skill-card-actions">
            <button class="skill-mini-btn" onclick="event.stopPropagation();runFlow('${escHtml(f.id)}')" title="运行流程" aria-label="Run flow">▶</button>
            <button class="skill-mini-btn" onclick="event.stopPropagation();editFlow('${escHtml(f.id)}')" title="编辑流程" aria-label="Edit flow">✎</button>
            <button class="skill-remove-btn" onclick="event.stopPropagation();deleteFlow('${escHtml(f.id)}')" title="删除流程" aria-label="Delete flow">✕</button>
          </div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    el.innerHTML = `<div style="padding:12px;color:var(--err);font-size:11px">Error: ${err.message}</div>`;
  }
}

async function runFlow(id) {
  const flow = (flowsCache || []).find(f => f.id === id);
  addProcessEntry('info', `▶ 运行流程「${flow ? flow.name : id}」...`);
  try {
    const res = await fetch('/api/flows/' + encodeURIComponent(id) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: typeof currentSessionId === 'string' && currentSessionId ? currentSessionId : 'default' }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      addProcessEntry('error', `流程运行失败 (${res.status}): ${errText.slice(0, 200)}`);
      return;
    }
    // SSE 格式与主聊天一致：`data: {"type":"done",...}`（事件名在 JSON 的 type 字段，
    // 不是 `event:` 行）。按行解析，与 sendChat 同一套规则。
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let payload;
        try { payload = JSON.parse(line.slice(6)); } catch { continue; }
        if (payload.type === 'done') {
          const reply = typeof payload.reply === 'string' ? payload.reply : '';
          const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
          addProcessEntry('final', '流程完成 ✓');
          addProcessEntry('final', (reply || '').slice(0, 200));
          // 把最终答复与产物卡片渲染到聊天区（与主聊天链路一致）
          if (reply || artifacts.length) {
            chatHistory.push({
              role: 'ai',
              content: reply || '流程完成',
              artifacts,
              steps: [],
              mode: 'flow',
              thinking: '',
              processEntries: [],
            });
            renderChatMessages();
          }
        } else if (payload.type === 'error') {
          addProcessEntry('error', '流程失败: ' + String(payload.message || '').slice(0, 200));
        }
      }
    }
    addProcessEntry('info', '流程运行结束');
  } catch (err) {
    addProcessEntry('error', '流程运行错误: ' + err.message);
  }
}

// ---- Flow template create / edit / delete ----
let editingFlowId = null;

function openCreateFlowModal() {
  editingFlowId = null;
  document.getElementById('flow-modal-title').textContent = 'Create Flow';
  document.getElementById('flow-modal-save-btn').textContent = 'Create Flow';
  document.getElementById('flow-modal-id').value = '';
  document.getElementById('flow-modal-id').disabled = false;
  document.getElementById('flow-modal-name').value = '';
  document.getElementById('flow-modal-triggers').value = '';
  document.getElementById('flow-modal-desc').value = '';
  document.getElementById('flow-modal-skill').value = '';
  document.getElementById('flow-modal-output').value = '';
  document.getElementById('flow-modal-instruction').value = '';
  document.getElementById('flow-modal').style.display = 'flex';
  document.getElementById('flow-modal-name').focus();
}

async function editFlow(id) {
  try {
    const res = await api('/api/flows/' + encodeURIComponent(id));
    if (!res.success) { alert('Flow not found'); return; }
    const f = res.flow;
    editingFlowId = id;
    document.getElementById('flow-modal-title').textContent = 'Edit Flow';
    document.getElementById('flow-modal-save-btn').textContent = 'Save Changes';
    document.getElementById('flow-modal-id').value = f.id || '';
    document.getElementById('flow-modal-id').disabled = true;
    document.getElementById('flow-modal-name').value = f.name || '';
    document.getElementById('flow-modal-triggers').value = (f.triggers || []).join('\n');
    document.getElementById('flow-modal-desc').value = f.description || '';
    document.getElementById('flow-modal-skill').value = f.skill || '';
    document.getElementById('flow-modal-output').value = f.output_note || '';
    document.getElementById('flow-modal-instruction').value = f.instruction || '';
    document.getElementById('flow-modal').style.display = 'flex';
    document.getElementById('flow-modal-name').focus();
  } catch (err) {
    alert('Error loading flow: ' + err.message);
  }
}

function closeFlowModal() {
  document.getElementById('flow-modal').style.display = 'none';
  editingFlowId = null;
}

async function saveFlowFromModal() {
  const name = document.getElementById('flow-modal-name').value.trim();
  const id = document.getElementById('flow-modal-id').value.trim();
  const triggers = document.getElementById('flow-modal-triggers').value.split('\n').map(s => s.trim()).filter(Boolean);
  const description = document.getElementById('flow-modal-desc').value.trim();
  const skill = document.getElementById('flow-modal-skill').value.trim();
  const output_note = document.getElementById('flow-modal-output').value.trim();
  const instruction = document.getElementById('flow-modal-instruction').value.trim();

  if (!name) { alert('Name is required'); return; }
  if (triggers.length === 0) { alert('At least one trigger phrase is required'); return; }
  if (!instruction) { alert('Instruction is required'); return; }

  const btn = document.getElementById('flow-modal-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  const payload = { name, triggers, description, skill, instruction, output_note };
  if (!editingFlowId) payload.id = id;

  try {
    let res;
    if (editingFlowId) {
      res = await api('/api/flows/' + encodeURIComponent(editingFlowId), { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      res = await api('/api/flows', { method: 'POST', body: JSON.stringify(payload) });
    }
    if (res.success) {
      addProcessEntry('info', `流程「${name}」${editingFlowId ? '已更新' : '已创建'}！`);
      closeFlowModal();
      loadFlows();
    } else {
      alert('保存失败: ' + (res.error || 'unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = editingFlowId ? 'Save Changes' : 'Create Flow';
  }
}

async function deleteFlow(id) {
  if (!confirm(`删除流程「${id}」？此操作不可撤销。`)) return;
  try {
    const res = await api('/api/flows/' + encodeURIComponent(id), { method: 'DELETE' });
    if (res.success) {
      addProcessEntry('info', `流程「${id}」已删除。`);
      loadFlows();
    } else {
      alert('删除失败: ' + (res.error || 'unknown error'));
    }
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

// ---- Knowledge base (local RAG) ----
let knowledgeFiles = [];

function renderKnowledgeList() {
  const el = document.getElementById('knowledge-list');
  if (!el) { addProcessEntry('error', 'KB render: #knowledge-list not found'); return; }
  try {
    if (!Array.isArray(knowledgeFiles) || knowledgeFiles.length === 0) {
      el.innerHTML = '<div style="padding:16px;font-size:12px;color:#aeb9cb">知识库为空。<br>点上方「选择文件」或输入工作区文件名入库；<br>也可把 PDF/文档放入 <code style="color:#6ea8fe">knowledge/corpus/</code> 后刷新。</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < knowledgeFiles.length; i++) {
      const f = knowledgeFiles[i];
      const name = String((f && f.name) || '').replace(/"/g, '&quot;');
      const base = name.replace(/\.[^.]+$/, '');
      const chunks = (f && typeof f.chunks === 'number') ? f.chunks : 0;
      const added = (f && f.added_at) ? ' · ' + String(f.added_at) : '';
      // Click the file name to auto-insert an @reference; trash icon deletes, same line as the name
      // NOTE: single-quoted attribute values — JSON.stringify yields double quotes, which would
      // otherwise terminate the onclick attribute early and silently kill the handler.
      html += '<div style="padding:8px 10px;margin-bottom:6px;border:1px solid #3d4656;border-radius:8px;background:#262d39;cursor:pointer" title="点击文件名，自动在聊天中引用" onclick=\'insertKbRef(' + JSON.stringify(base) + ')\'>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<span style="flex:1;min-width:0;font-size:12px;font-weight:600;color:#6ea8fe;word-break:break-all;line-height:1.4;text-decoration:underline;text-underline-offset:2px">' + name + '</span>' +
          '<button onclick=\'event.stopPropagation();removeKnowledgeFile(' + JSON.stringify(name) + ')\' title="从知识库删除" style="flex-shrink:0;background:transparent;border:none;color:#aeb9cb;cursor:pointer;font-size:13px;line-height:1">🗑</button>' +
        '</div>' +
        '<div style="font-size:10px;color:#aeb9cb;margin-top:2px">' + chunks + ' 分块' + added + '</div>' +
      '</div>';
    }
    el.innerHTML = html;
    addProcessEntry('info', 'KB render: ' + knowledgeFiles.length + ' 张文件卡片已渲染');
  } catch (err) {
    el.innerHTML = '<div style="padding:12px;color:#e06d6d;font-size:11px">列表渲染失败: ' + (err && err.message ? err.message : err) + '</div>';
    addProcessEntry('error', 'KB render 异常: ' + (err && err.message ? err.message : err));
  }
}

async function loadKnowledge() {
  // Debounce: multiple triggers within 300ms (startup preload + tab click +
  // @-menu + post-mutation refresh) collapse into one request, avoiding the
  // burst of identical "KB load: API 返回 …" log entries.
  if (kbLoadTimer) clearTimeout(kbLoadTimer);
  kbLoadTimer = setTimeout(() => { void doLoadKnowledge(); }, 300);
}

let kbLoadTimer = null;

async function doLoadKnowledge() {
  const el = document.getElementById('knowledge-list');
  const statusLine = document.getElementById('kb-status-line');
  if (el) el.innerHTML = '<div style="padding:12px;color:#aeb9cb;font-size:11px"><span class="spinner"></span> Loading...</div>';
  try {
    const data = await api('/api/knowledge');
    knowledgeFiles = (data && Array.isArray(data.files)) ? data.files : [];
    const st = (data && data.status) || {};
    if (statusLine) statusLine.textContent = '本地 RAG · ' + (st.files || 0) + ' 文件 / ' + (st.chunks || 0) + ' 分块';
    addProcessEntry('info', 'KB load: API 返回 ' + knowledgeFiles.length + ' 个文件 / ' + (st.chunks || 0) + ' 分块');
    renderKnowledgeList();
  } catch (err) {
    if (el) el.innerHTML = '<div style="padding:12px;color:#e06d6d;font-size:11px">加载知识库失败: ' + (err && err.message ? err.message : err) + '</div>';
    addProcessEntry('error', 'KB load 异常: ' + (err && err.message ? err.message : err));
  }
}

// Preload the KB list once on startup so the panel is never empty, even if the
// sidebar tab is opened later.
setTimeout(loadKnowledge, 300);

async function addKnowledgeFile() {
  const input = document.getElementById('kb-add-input');
  const filename = String(input?.value || '').trim();
  if (!filename) { addProcessEntry('error', '请先输入工作区文件名'); return; }
  addProcessEntry('info', `入库: ${filename} ...`);
  try {
    const res = await api('/api/knowledge/add', { method: 'POST', body: JSON.stringify({ filename }) });
    if (!res.success) {
      addProcessEntry('error', '入库失败: ' + (res.error || 'unknown'));
      return;
    }
    addProcessEntry('final', `✓ 已入库 ${res.name}（${res.chunks} 分块，共 ${res.total_files} 个文件）`);
    input.value = '';
    loadKnowledge();
  } catch (err) {
    addProcessEntry('error', '入库错误: ' + err.message);
  }
}

// Pick a local file → upload to workspace → add to knowledge base.
async function handleKbFilePick(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  const nameEl = document.getElementById('kb-picked-name');
  if (nameEl) nameEl.textContent = '上传中: ' + file.name + ' ...';
  try {
    const res = await fetch('/api/files?name=' + encodeURIComponent(file.name), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    addProcessEntry('info', `已上传 ${data.name}（${data.bytes} 字节），开始入库...`);
    const kb = await api('/api/knowledge/add', { method: 'POST', body: JSON.stringify({ filename: data.name }) });
    if (!kb.success) throw new Error(kb.error || 'unknown');
    addProcessEntry('final', `✓ 已入库 ${kb.name}（${kb.chunks} 分块，共 ${kb.total_files} 个文件）`);
    loadKnowledge();
  } catch (err) {
    addProcessEntry('error', '入库失败: ' + (err && err.message ? err.message : err));
  } finally {
    if (nameEl) nameEl.textContent = '';
    input.value = '';
  }
}

async function removeKnowledgeFile(name) {
  addProcessEntry('info', `从知识库删除: ${name} ...`);
  try {
    const res = await api('/api/knowledge/remove', { method: 'POST', body: JSON.stringify({ name }) });
    if (!res.success) { addProcessEntry('error', '删除失败: ' + (res.error || 'unknown')); return; }
    addProcessEntry('final', `✓ 已删除 ${name}`);
    loadKnowledge();
  } catch (err) {
    addProcessEntry('error', '删除错误: ' + err.message);
  }
}

// ---- Skills management (v2 - local skills system) ----
let skillsCache = [];
let editingSkillId = null;

async function loadInstalledSkills() {
  const el = document.getElementById('skills-list');
  el.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:11px"><span class="spinner"></span> Loading...</div>';
  try {
    const data = await api('/api/skills');
    const skills = data.skills || [];
    skillsCache = skills;
    if (skills.length === 0) {
      el.innerHTML = '<div class="empty-state" style="padding:16px">No skills yet.<br>Click "+ Create" to make one!</div>';
    } else {
      el.innerHTML = skills.map(s => {
        const skillEmoji = (s.emoji === '🧩' || s.emoji === '🦞' || s.emoji === '⚠️') ? s.emoji : '🧩';
        return `
        <div class="skill-card ${s.enabled ? 'enabled' : ''}" data-skill-id="${escHtml(s.id)}" onclick="toggleSkill('${escHtml(s.id)}')">
          <div class="skill-card-top">
            <div class="skill-card-emoji">${escHtml(skillEmoji)}</div>
            <div class="skill-card-info">
              <div class="skill-card-name">${escHtml(s.name)}</div>
              <div class="skill-card-desc">${escHtml(s.description || 'No description')}</div>
            </div>
            <div class="skill-card-actions">
              <button class="skill-mini-btn" onclick="event.stopPropagation();editSkill('${escHtml(s.id)}')" title="Edit" aria-label="Edit skill">✎</button>
              <button class="skill-remove-btn" onclick="event.stopPropagation();deleteSkill('${escHtml(s.id)}')" title="Delete" aria-label="Delete skill">✕</button>
              <div class="skill-card-dot"></div>
            </div>
          </div>
        </div>
      `;
      }).join('');
      renderSkillEligibility(skills);
    }
  } catch (err) {
    el.innerHTML = `<div style="padding:12px;color:var(--err);font-size:11px">Error: ${err.message}</div>`;
  }
}

async function toggleSkill(id) {
  const skillMeta = (skillsCache || []).find(s => s.id === id);
  // Block only when trying to enable an ineligible skill.
  if (skillMeta && skillMeta.eligible === false && !skillMeta.enabled) {
    addProcessEntry('error', skillMeta.eligibleReason || 'This skill is currently unavailable.');
    return;
  }
  try {
    const res = await api(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
    if (!res.success) {
      addProcessEntry('error', res.error || 'Failed to toggle skill.');
      return;
    }
    addProcessEntry('info', `Skill "${res.skill.name}": ${res.skill.enabled ? 'ENABLED' : 'DISABLED'}`);
    loadInstalledSkills();
  } catch (err) {
    addProcessEntry('error', `Failed to toggle skill: ${err.message}`);
  }
}

async function deleteSkill(id) {
  if (!confirm(`Delete skill "${id}"?`)) return;
  try {
    const res = await api(`/api/skills/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.success) {
      addProcessEntry('info', `Skill "${id}" deleted.`);
      loadInstalledSkills();
    } else {
      alert(`Delete failed: ${res.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function openCreateSkillModal() {
  editingSkillId = null;
  document.getElementById('skill-modal-title').textContent = 'Create Skill';
  document.getElementById('skill-modal-save-btn').textContent = 'Create Skill';
  document.getElementById('skill-modal-name').value = '';
  document.getElementById('skill-modal-emoji').value = '';
  document.getElementById('skill-modal-desc').value = '';
  document.getElementById('skill-modal-instructions').value = '';
  document.getElementById('skill-modal').style.display = 'flex';
  document.getElementById('skill-modal-name').focus();
}

async function editSkill(id) {
  try {
    const res = await api(`/api/skills/${encodeURIComponent(id)}`);
    if (!res.success) { alert('Skill not found'); return; }
    const s = res.skill;
    editingSkillId = id;
    document.getElementById('skill-modal-title').textContent = 'Edit Skill';
    document.getElementById('skill-modal-save-btn').textContent = 'Save Changes';
    document.getElementById('skill-modal-name').value = s.name || '';
    document.getElementById('skill-modal-emoji').value = s.emoji || '';
    document.getElementById('skill-modal-desc').value = s.description || '';
    document.getElementById('skill-modal-instructions').value = s.instructions || '';
    document.getElementById('skill-modal').style.display = 'flex';
    document.getElementById('skill-modal-name').focus();
  } catch (err) {
    alert(`Error loading skill: ${err.message}`);
  }
}

function closeSkillModal() {
  document.getElementById('skill-modal').style.display = 'none';
  editingSkillId = null;
}

async function saveSkillFromModal() {
  const name = document.getElementById('skill-modal-name').value.trim();
  const rawEmoji = document.getElementById('skill-modal-emoji').value.trim();
  const emoji = (rawEmoji === '🧩' || rawEmoji === '🦞' || rawEmoji === '⚠️') ? rawEmoji : '🧩';
  const description = document.getElementById('skill-modal-desc').value.trim();
  const instructions = document.getElementById('skill-modal-instructions').value.trim();

  if (!name) { alert('Name is required'); return; }
  if (!instructions) { alert('Instructions are required'); return; }

  const btn = document.getElementById('skill-modal-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    let res;
    if (editingSkillId) {
      // Update existing
      res = await api(`/api/skills/${encodeURIComponent(editingSkillId)}`, {
        method: 'PUT',
        body: JSON.stringify({ name, emoji, description, instructions }),
      });
    } else {
      // Create new
      res = await api('/api/skills', {
        method: 'POST',
        body: JSON.stringify({ name, emoji, description, instructions }),
      });
    }
    if (res.success) {
      addProcessEntry('info', `Skill "${name}" ${editingSkillId ? 'updated' : 'created'}!`);
      closeSkillModal();
      loadInstalledSkills();
    } else {
      alert(`Failed: ${res.error}`);
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = editingSkillId ? 'Save Changes' : 'Create Skill';
  }
}

// ---- Stop Button ----
let currentAbortController = null;

function handleSendStop() {
  if (isThinking) stopGeneration();
  else sendChat();
}

function stopGeneration() {
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
}

function setButtonState(thinking) {
  const sendIcon = document.getElementById('send-icon');
  const stopIcon = document.getElementById('stop-icon');
  const btn = document.getElementById('send-btn');
  if (!btn) return;
  if (thinking) {
    if (sendIcon) sendIcon.style.display = 'none';
    if (stopIcon) stopIcon.style.display = '';
    btn.style.background = 'var(--err)';
    btn.title = 'Stop generation';
  } else {
    if (sendIcon) sendIcon.style.display = '';
    if (stopIcon) stopIcon.style.display = 'none';
    btn.style.background = '';
    btn.title = 'Send';
  }
}

// ---- Canvas Panel ----
let canvasOpen = false;
let canvasTabs = [];
let activeCanvasTabId = null;
let canvasEditor = null;
let canvasEditorInitialized = false;

const CANVAS_LANG_MAP = {
  js:'javascript', ts:'javascript', jsx:'javascript', tsx:'javascript', mjs:'javascript',
  html:'htmlmixed', htm:'htmlmixed',
  css:'css', py:'python', xml:'xml',
  json:'javascript', md:'markdown', txt:'null',
};

function getCanvasLang(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return CANVAS_LANG_MAP[ext] || 'null';
}

function isHtmlFile(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  return ext === 'html' || ext === 'htm';
}

function toggleCanvas() {
  canvasOpen = !canvasOpen;
  const panel = document.getElementById('canvas-panel');
  const btn = document.getElementById('canvas-toggle-btn');
  if (!panel) return;
  if (canvasOpen) {
    panel.style.display = 'flex';
    if (btn) { btn.style.background='var(--sel-bg)'; btn.style.borderColor='var(--sel-border)'; btn.style.color='var(--sel-text)'; }
    if (!canvasEditorInitialized) initCanvasEditor();
    canvasRenderTabs();
  } else {
    panel.style.display = 'none';
    if (btn) { btn.style.background=''; btn.style.borderColor=''; btn.style.color=''; }
  }
}

function initCanvasEditor() {
  canvasEditorInitialized = true;
  const wrap = document.getElementById('canvas-editor-wrap');
  if (!wrap || typeof CodeMirror === 'undefined') return;
  canvasEditor = CodeMirror(wrap, {
    value: '',
    mode: 'htmlmixed',
    lineNumbers: true,
    lineWrapping: true,
    tabSize: 2,
    indentWithTabs: false,
    theme: 'default',
    extraKeys: { 'Ctrl-S': () => canvasSave(), 'Cmd-S': () => canvasSave() },
  });
  canvasEditor.on('change', () => {
    const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
    if (!tab) return;
    tab.content = canvasEditor.getValue();
    if (tab.mode === 'preview') canvasUpdatePreview();
  });
}

function canvasNewFile() {
  const name = prompt('File name:', 'untitled.html');
  if (!name || !name.trim()) return;
  const id = 'ctab_' + Math.random().toString(36).slice(2);
  canvasTabs.push({ id, name: name.trim(), content: '', mode: 'code', language: getCanvasLang(name) });
  canvasOpenTab(id);
}

function canvasOpenTab(id) {
  activeCanvasTabId = id;
  const tab = canvasTabs.find(t => t.id === id);
  if (!tab) return;
  if (canvasEditor) {
    canvasEditor.setValue(tab.content || '');
    canvasEditor.setOption('mode', tab.language || 'null');
    setTimeout(() => canvasEditor.refresh(), 10);
  }
  applyCanvasViewMode(tab.mode || 'code', tab);
  canvasRenderTabs();
}

function canvasCloseTab(id, ev) {
  if (ev) ev.stopPropagation();
  const idx = canvasTabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  canvasTabs.splice(idx, 1);
  if (activeCanvasTabId === id) {
    if (canvasTabs.length > 0) {
      canvasOpenTab(canvasTabs[Math.min(idx, canvasTabs.length - 1)].id);
    } else {
      activeCanvasTabId = null;
      if (canvasEditor) canvasEditor.setValue('');
      applyCanvasViewMode('code', null);
      canvasRenderTabs();
    }
  } else {
    canvasRenderTabs();
  }
}

function setCanvasMode(mode) {
  const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
  if (!tab) return;
  // sync editor -> tab before switching
  if (canvasEditor && tab.mode !== 'preview') tab.content = canvasEditor.getValue();
  tab.mode = mode;
  applyCanvasViewMode(mode, tab);
  canvasRenderTabs();
}

function applyCanvasViewMode(mode, tab) {
  const editorWrap = document.getElementById('canvas-editor-wrap');
  const previewFrame = document.getElementById('canvas-preview-frame');
  const emptyState = document.getElementById('canvas-empty-state');
  const codeModeBtn = document.getElementById('canvas-code-btn');
  const previewModeBtn = document.getElementById('canvas-preview-btn');
  if (!tab) {
    if (editorWrap) editorWrap.style.display = 'none';
    if (previewFrame) previewFrame.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';
  if (mode === 'preview') {
    if (editorWrap) editorWrap.style.display = 'none';
    if (previewFrame) { previewFrame.style.display = 'flex'; previewFrame.style.flex = '1'; }
    if (codeModeBtn) codeModeBtn.classList.remove('active');
    if (previewModeBtn) previewModeBtn.classList.add('active');
    canvasUpdatePreview();
  } else {
    if (editorWrap) { editorWrap.style.display = 'flex'; editorWrap.style.flex = '1'; }
    if (previewFrame) previewFrame.style.display = 'none';
    if (codeModeBtn) codeModeBtn.classList.add('active');
    if (previewModeBtn) previewModeBtn.classList.remove('active');
    if (canvasEditor) setTimeout(() => { canvasEditor.refresh(); canvasEditor.focus(); }, 10);
  }
}

function canvasRenderTabs() {
  const tabsEl = document.getElementById('canvas-tabs');
  if (!tabsEl) return;
  tabsEl.innerHTML = canvasTabs.map(t => `
    <div class="canvas-tab ${t.id === activeCanvasTabId ? 'active' : ''}" onclick="canvasOpenTab('${t.id}')">
      <span>${escHtml(t.name)}</span>
      <button class="canvas-tab-close" onclick="canvasCloseTab('${t.id}', event)" title="Close">×</button>
    </div>
  `).join('') + `<button class="canvas-new-tab" onclick="canvasNewFile()" title="New file">+</button>`;
  const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
  const codeModeBtn = document.getElementById('canvas-code-btn');
  const previewModeBtn = document.getElementById('canvas-preview-btn');
  if (codeModeBtn) codeModeBtn.classList.toggle('active', !tab || tab.mode !== 'preview');
  if (previewModeBtn) previewModeBtn.classList.toggle('active', !!(tab && tab.mode === 'preview'));
}

function canvasUpdatePreview() {
  const frame = document.getElementById('canvas-preview-frame');
  const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
  if (!frame || !tab) return;
  const content = tab.content || '';
  if (!isHtmlFile(tab.name) && !content.trim().startsWith('<')) {
    frame.srcdoc = `<pre style="font-family:monospace;padding:16px;white-space:pre-wrap;word-break:break-word">${content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>`;
    return;
  }
  frame.srcdoc = content;
  frame.onload = () => {
    try {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      doc.body.contentEditable = 'true';
      doc.body.spellcheck = false;
      doc.body.addEventListener('input', () => {
        const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
        tab.content = html;
        // sync back to editor so Code mode shows updated content
        if (canvasEditor && tab.mode !== 'preview') canvasEditor.setValue(html);
      });
    } catch {}
  };
}

function canvasSave() {
  const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
  if (!tab) { addProcessEntry('warn', 'Canvas: no file open to save.'); return; }
  if (canvasEditor && tab.mode !== 'preview') tab.content = canvasEditor.getValue();
  const blob = new Blob([tab.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = tab.name; a.click();
  URL.revokeObjectURL(url);
  addProcessEntry('info', `Canvas: saved ${tab.name}`);
}

function canvasAddToContext() {
  const tab = canvasTabs.find(t => t.id === activeCanvasTabId);
  if (!tab) { addProcessEntry('warn', 'Canvas: no file open.'); return; }
  if (canvasEditor && tab.mode !== 'preview') tab.content = canvasEditor.getValue();
  const ext = tab.name.split('.').pop() || 'txt';
  const block = '```' + ext + '\n' + tab.content + '\n```';
  // Send as a message to the LLM so it enters context
  const prompt = `Here is the contents of my file "${tab.name}" for reference:\n\n${block}\n\nI've loaded this file into context. What would you like me to do with it?`;
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = prompt;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  }
  sendChat();
  addProcessEntry('info', `Canvas: sent ${tab.name} to LLM as context.`);
}

function canvasInitDrop() {
  const panel = document.getElementById('canvas-panel');
  if (!panel) return;
  panel.addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('canvas-drag-over'); });
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('canvas-drag-over'); });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('canvas-drag-over');
    Array.from(e.dataTransfer.files).forEach(canvasLoadFile);
  });
}

function canvasLoadFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const content = ev.target.result;
    const id = 'ctab_' + Math.random().toString(36).slice(2);
    canvasTabs.push({ id, name: file.name, content, mode: 'code', language: getCanvasLang(file.name) });
    if (!canvasOpen) toggleCanvas();
    canvasOpenTab(id);
    addProcessEntry('info', `Canvas: opened ${file.name}`);
  };
  reader.readAsText(file);
}

// ---- Context Pinning ----
const MAX_PINS = 3;
let contextPinMode = false;
let pinnedMessageIndices = new Set();
let confirmedPins = []; // Array of { role, content } sent with each request

function toggleContextPinMode() {
  const pop = document.getElementById('context-pin-popover');
  if (!pop) return;
  const isOpen = pop.classList.contains('open');
  // Close other popovers
  document.getElementById('quick-mode-popover')?.classList.remove('open');
  if (isOpen) {
    cancelContextPin();
  } else {
    contextPinMode = true;
    pop.classList.add('open');
    document.body.classList.add('context-pin-active');
    // Reset selection to currently confirmed pins
    pinnedMessageIndices = new Set();
    for (const pin of confirmedPins) {
      const idx = chatHistory.findIndex(m => m.content === pin.content && m.role === pin.role);
      if (idx >= 0) pinnedMessageIndices.add(idx);
    }
    updatePinUI();
    renderChatMessages();
  }
}

function cancelContextPin() {
  contextPinMode = false;
  pinnedMessageIndices = new Set();
  document.getElementById('context-pin-popover')?.classList.remove('open');
  document.body.classList.remove('context-pin-active');
  renderChatMessages();
}

function confirmContextPin() {
  confirmedPins = [];
  for (const idx of pinnedMessageIndices) {
    const msg = chatHistory[idx];
    if (msg) confirmedPins.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content });
  }
  contextPinMode = false;
  document.getElementById('context-pin-popover')?.classList.remove('open');
  document.body.classList.remove('context-pin-active');
  updatePinBadge();
  renderChatMessages();
  if (confirmedPins.length > 0) {
    addProcessEntry('info', `${confirmedPins.length} message(s) pinned to context.`);
  } else {
    addProcessEntry('info', 'Context pins cleared.');
  }
}

function togglePinMessage(index) {
  if (!contextPinMode) return;
  if (pinnedMessageIndices.has(index)) {
    pinnedMessageIndices.delete(index);
  } else if (pinnedMessageIndices.size < MAX_PINS) {
    pinnedMessageIndices.add(index);
  }
  updatePinUI();
  renderChatMessages();
}

function removePinFromList(index) {
  pinnedMessageIndices.delete(index);
  updatePinUI();
  renderChatMessages();
}

function updatePinUI() {
  const countEl = document.getElementById('context-pin-count');
  const listEl = document.getElementById('context-pin-list');
  if (countEl) countEl.textContent = `${pinnedMessageIndices.size}/${MAX_PINS} 已选中`;
  if (listEl) {
    if (pinnedMessageIndices.size === 0) {
      listEl.innerHTML = '<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px">点击聊天中的消息以选中</div>';
    } else {
      listEl.innerHTML = Array.from(pinnedMessageIndices).map(idx => {
        const msg = chatHistory[idx];
        if (!msg) return '';
        const icon = msg.role === 'user' ? '??' : '??';
        const text = msg.content.slice(0, 60) + (msg.content.length > 60 ? '...' : '');
        return `<div class="pin-card">
          <span>${icon}</span>
          <div class="pin-card-text">${escHtml(text)}</div>
          <button class="pin-card-remove" onclick="removePinFromList(${idx})">&times;</button>
        </div>`;
      }).join('');
    }
  }
}

function updatePinBadge() {
  const label = document.getElementById('context-pin-label');
  if (label) {
    label.textContent = confirmedPins.length > 0 ? `Context (${confirmedPins.length})` : 'Context';
  }
  const btn = document.getElementById('context-pin-btn');
  if (btn) {
    btn.style.borderColor = confirmedPins.length > 0 ? '#86d4a8' : '';
    btn.style.background = confirmedPins.length > 0 ? '#f0faf4' : '';
    btn.style.color = confirmedPins.length > 0 ? '#0a6b3d' : '';
  }
}

function getInitialTheme() {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {}
  return 'light';
}

function applyTheme(theme) {
  const resolved = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.setAttribute('data-theme-state', resolved);
    const title = resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
  }
  try { localStorage.setItem(THEME_KEY, resolved); } catch {}
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ---- Boot ----
document.addEventListener('click', (e) => {
  const pop = document.getElementById('quick-mode-popover');
  const btn = document.getElementById('quick-mode-btn');
  if (!pop || !btn) return;
  if (!pop.contains(e.target) && !btn.contains(e.target)) pop.classList.remove('open');
  // Also close context pin popover
  const pinPop = document.getElementById('context-pin-popover');
  const pinBtn = document.getElementById('context-pin-btn');
  if (pinPop && pinBtn && !pinPop.contains(e.target) && !pinBtn.contains(e.target)) {
    // Don't close if in pin mode and clicking on messages
    if (contextPinMode && e.target.closest && e.target.closest('.msg')) return;
  }
});

// --- SCHEDULER MANAGEMENT ---------------------------------------------------

let schedules = [];
let editingScheduleId = null;

async function refreshSchedules() {
  try {
    const result = await api('/api/schedules');
    if (result.success && Array.isArray(result.schedules)) {
      schedules = result.schedules;
      renderScheduleList();
    }
  } catch (err) {
    console.error('Failed to load schedules:', err);
  }
}

function renderScheduleList() {
  const list = document.getElementById('schedule-list');
  const count = document.getElementById('schedule-count');
  if (!list) return;

  if (schedules.length === 0) {
    list.innerHTML = '<div class="empty-state" style="text-align:center;color:var(--muted);padding:40px 20px">No schedules yet. <strong>+ New Schedule</strong> to get started.</div>';
    if (count) count.textContent = '0 schedules';
    return;
  }

  if (count) count.textContent = `${schedules.length} schedule${schedules.length !== 1 ? 's' : ''}`;

  list.innerHTML = schedules.map(job => {
    const nextRun = job.next_run ? new Date(job.next_run).toLocaleString() : 'Never';
    const lastRun = job.last_run ? new Date(job.last_run).toLocaleString() : 'Never';
    const statusClass = job.status === 'active' ? 'status-active' : job.status === 'paused' ? 'status-paused' : 'status-failed';
    
    const statusText = job.status === 'active' ? '运行中' : job.status === 'paused' ? '已暂停' : job.status === 'failed' ? '失败' : job.status || '未知';

    return `
      <div style="display:flex;align-items:start;justify-content:space-between;gap:12px;padding:12px;background:var(--panel);border:1px solid var(--line);border-radius:10px;cursor:pointer" onclick="editSchedule('${job.id}')">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div style="font-weight:700;font-size:13px">${job.name || '未命名'}</div>
            <span class="${statusClass}" style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:6px;${job.status === 'active' ? 'background:#c8f0c4;color:#0d5c2f' : job.status === 'paused' ? 'background:var(--panel)4d6;color:#7d5700' : 'background:#ffd6d6;color:#8b0000'}">${statusText}</span>
          </div>
          <div style="font-size:12px;color:var(--muted);line-height:1.4;margin-bottom:6px">${job.prompt ? job.prompt.slice(0, 60) + (job.prompt.length > 60 ? '...' : '') : '暂无提示词'}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:11px;color:var(--muted)">
            <div><strong>下次运行：</strong> ${nextRun}</div>
            <div><strong>上次运行：</strong> ${lastRun}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
          <button onclick="event.stopPropagation(); runScheduleNow('${job.id}')" style="border:1px solid var(--line);background:var(--panel-2);color:var(--muted);border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap" title="立即运行">立即运行</button>
          <button onclick="event.stopPropagation(); toggleSchedulePause('${job.id}')" style="border:1px solid var(--line);background:var(--panel-2);color:var(--muted);border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap" title="暂停/恢复">${job.status === 'active' ? '暂停' : '恢复'}</button>
          <button onclick="event.stopPropagation(); deleteSchedule('${job.id}')" style="border:1px solid #ff6b6b;background:#ffe0e0;color:#8b0000;border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap" title="删除">删除</button>
        </div>
      </div>
    `;
  }).join('');
}

function openScheduleCreateModal() {
  editingScheduleId = null;
  document.getElementById('schedule-modal-title').textContent = 'Create Schedule';
  document.getElementById('schedule-save-btn').textContent = 'Create Schedule';
  document.getElementById('schedule-name').value = '';
  document.getElementById('schedule-pattern').value = '';
  document.getElementById('schedule-prompt').value = '';
  document.getElementById('schedule-timezone').value = 'UTC';
  document.getElementById('schedule-channel').value = 'web';
  document.getElementById('schedule-pattern-preview').style.display = 'none';
  document.getElementById('schedule-modal').style.display = 'flex';
}

function editSchedule(jobId) {
  const job = schedules.find(j => j.id === jobId);
  if (!job) return;
  
  editingScheduleId = jobId;
  document.getElementById('schedule-modal-title').textContent = 'Edit Schedule';
  document.getElementById('schedule-save-btn').textContent = 'Save Changes';
  document.getElementById('schedule-name').value = job.name || '';
  document.getElementById('schedule-pattern').value = job.cron || job.run_at || '';
  document.getElementById('schedule-prompt').value = job.prompt || '';
  document.getElementById('schedule-timezone').value = job.timezone || 'UTC';
  document.getElementById('schedule-channel').value = job.delivery_channel || 'web';
  document.getElementById('schedule-pattern-preview').style.display = 'none';
  document.getElementById('schedule-modal').style.display = 'flex';
}

function closeScheduleModal() {
  document.getElementById('schedule-modal').style.display = 'none';
  editingScheduleId = null;
}

async function parseSchedulePattern() {
  const pattern = document.getElementById('schedule-pattern').value.trim();
  const timezone = document.getElementById('schedule-timezone').value;
  if (!pattern) {
    alert('请输入触发规则，例如："daily at 18:00"（每天18点）或 "0 9 * * *"（cron 表达式）');
    return;
  }
  
  try {
    const result = await api('/api/schedules/parse', {
      method: 'POST',
      body: JSON.stringify({ text: pattern, timezone })
    });
    
    const preview = document.getElementById('schedule-pattern-preview');
    if (result.success) {
      preview.textContent = `✓ ${result.preview || result.human_text || 'Valid pattern'}`;
      preview.style.display = 'block';
      preview.style.color = 'var(--muted)';
    } else {
      preview.textContent = `⚠ ${result.error || '格式不正确'}`;
      preview.style.display = 'block';
      preview.style.color = '#ff6b6b';
    }
  } catch (err) {
    document.getElementById('schedule-pattern-preview').textContent = '⚠ 解析失败';
    document.getElementById('schedule-pattern-preview').style.display = 'block';
    document.getElementById('schedule-pattern-preview').style.color = '#ff6b6b';
  }
}

async function saveSchedule() {
  const name = document.getElementById('schedule-name').value.trim();
  const pattern = document.getElementById('schedule-pattern').value.trim();
  const prompt = document.getElementById('schedule-prompt').value.trim();
  const timezone = document.getElementById('schedule-timezone').value;
  const channel = document.getElementById('schedule-channel').value;
  
  if (!name) return alert('请填写任务名称');
  if (!pattern) return alert('请填写触发规则');
  if (!prompt) return alert('请填写任务内容');
  
  const method = editingScheduleId ? 'PUT' : 'POST';
  const path = editingScheduleId ? `/api/schedules/${editingScheduleId}` : '/api/schedules';
  
  try {
    const result = await api(path, {
      method,
      body: JSON.stringify({
        name,
        pattern,
        prompt,
        timezone,
        delivery_channel: channel,
        confirm: true  // Confirmation (as per scheduler rules)
      })
    });
    
    if (result.success) {
      closeScheduleModal();
      await refreshSchedules();
    } else {
      alert('Error: ' + (result.error || 'Unknown error'));
    }
  } catch (err) {
    alert('Failed to save schedule: ' + err.message);
  }
}

async function deleteSchedule(jobId) {
  if (!confirm('Delete this schedule? This action cannot be undone.')) return;
  
  try {
    const result = await api(`/api/schedules/${jobId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: true })
    });
    
    if (result.success) {
      await refreshSchedules();
    } else {
      alert('Error: ' + (result.error || 'Failed to delete'));
    }
  } catch (err) {
    alert('Failed to delete schedule: ' + err.message);
  }
}

async function toggleSchedulePause(jobId) {
  const job = schedules.find(j => j.id === jobId);
  if (!job) return;
  
  const newStatus = job.status === 'active' ? 'paused' : 'active';
  
  try {
    const result = await api(`/api/schedules/${jobId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus })
    });
    
    if (result.success) {
      await refreshSchedules();
    } else {
      alert('Error: ' + (result.error || 'Failed to update'));
    }
  } catch (err) {
    alert('Failed to toggle pause: ' + err.message);
  }
}

async function runScheduleNow(jobId) {
  try {
    const result = await api(`/api/schedules/${jobId}/run`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    
    if (result.success) {
      await refreshSchedules();
      alert('任务已触发，正在运行...');
    } else {
      alert('Error: ' + (result.error || 'Failed to run'));
    }
  } catch (err) {
    alert('Failed to run schedule: ' + err.message);
  }
}

loadChatSessions();
applyTheme(getInitialTheme());
setupProcessAndRightScrollTracking();
updateHeartbeatUI();
connectWS();
refreshAll();
refreshChatModelSwitch(); // fill the always-visible chat-area model switcher
updateQuickModeUI();
updateQueuedPromptUI();
setInterval(checkStatus, 10000);
setInterval(loadSystemStats, 3000);
setInterval(loadApprovals, 5000);
setMode('chat'); // Start in chat mode
canvasInitDrop();
loadPlanState();
try {
  document.addEventListener('selectionchange', function () {
    clearTimeout(window.__selAffordanceTimer);
    window.__selAffordanceTimer = setTimeout(updateSelectionAffordance, 220);
  });
} catch {}

// ---------------------------------------------------------------------------
// BACKGROUND TASKS KANBAN SYSTEM
// ---------------------------------------------------------------------------

let bgtTasks = [];           // all task records from server
let bgtOpenTaskId = null;    // currently open panel task id
let bgtHeartbeatConfig = { enabled: true, interval_minutes: 10 };

function openBgtHeartbeatModal() {
  const modal = document.getElementById('bgt-heartbeat-modal');
  const enabledEl = document.getElementById('bgt-hb-enabled');
  const intervalEl = document.getElementById('bgt-hb-interval');
  if (!modal || !enabledEl || !intervalEl) return;
  enabledEl.checked = !!bgtHeartbeatConfig.enabled;
  intervalEl.value = String(Math.max(1, Number(bgtHeartbeatConfig.interval_minutes) || 10));
  modal.style.display = 'flex';
}

function closeBgtHeartbeatModal() {
  const modal = document.getElementById('bgt-heartbeat-modal');
  if (modal) modal.style.display = 'none';
}

async function saveBgtHeartbeatConfig() {
  const enabledEl = document.getElementById('bgt-hb-enabled');
  const intervalEl = document.getElementById('bgt-hb-interval');
  if (!enabledEl || !intervalEl) return;

  const enabled = !!enabledEl.checked;
  const interval = Math.max(1, Math.min(1440, Number(intervalEl.value) || 10));
  try {
    const data = await api('/api/bg-tasks/heartbeat/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled, interval_minutes: interval }),
    });
    if (data?.success && data.config) {
      bgtHeartbeatConfig = data.config;
      renderBgTasks();
      closeBgtHeartbeatModal();
      bgtToast('心跳已更新', `每 ${interval} 分钟`);
      return;
    }
    bgtToast('心跳更新失败', String(data?.error || '未知错误'));
  } catch (err) {
    bgtToast('心跳更新失败', String(err?.message || err));
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('bgt-heartbeat-modal');
  if (modal && modal.style.display === 'flex') closeBgtHeartbeatModal();
});

document.addEventListener('click', (e) => {
  const modal = document.getElementById('bgt-heartbeat-modal');
  if (!modal || modal.style.display !== 'flex') return;
  if (e.target === modal) closeBgtHeartbeatModal();
});

// --- Columns config ---------------------------------------------------------
const BGT_COLUMNS = [
  { key: 'running',          label: '● 进行中',   empty: '暂无进行中任务', color: 'var(--sel-text)', bg: 'var(--sel-bg)' },
  { key: 'queued',           label: '◷ 排队中',   empty: '暂无排队任务',   color: '#7c4d00', bg: '#fff8e1' },
  { key: 'paused',           label: '‖ 已暂停',   empty: '暂无已暂停任务', color: '#555',    bg: '#f5f5f5' },
  { key: 'stalled',          label: '▲ 卡住',     empty: '暂无卡住任务',   color: '#9c1a1a', bg: '#fff0f0' },
  { key: 'needs_assistance', label: '⚠️ 需要你',  empty: '暂无待处理任务', color: '#6d2d9e', bg: '#f5eeff' },
  { key: 'complete',         label: '✓ 已完成',   empty: '暂无已完成任务', color: '#1a6e35', bg: '#efffea' },
  { key: 'failed',           label: '✕ 失败',     empty: '暂无失败任务',   color: '#9c1a1a', bg: '#fff0f0' },
];

const STATUS_ICON = {
  running: '●',
  queued: '◷',
  paused: '‖',
  stalled: '▲',
  needs_assistance: '⚠️',
  complete: '✓',
  failed: '✕',
};

const STATUS_LABEL = {
  running: '进行中',
  queued: '排队中',
  paused: '已暂停',
  stalled: '卡住',
  needs_assistance: '需要你',
  complete: '已完成',
  failed: '失败',
};

// --- Fetch & Render ----------------------------------------------------------
async function refreshBgTasks() {
  try {
    const data = await api('/api/bg-tasks');
    if (data.success) {
      bgtTasks = data.tasks || [];
      bgtHeartbeatConfig = data.heartbeatConfig || bgtHeartbeatConfig;
    }
  } catch (err) {
    console.error('[BGT] refreshBgTasks error:', err);
  }
  renderBgTasks();
}

function renderBgTasks() {
  const board = document.getElementById('bgt-board');
  if (!board) return;

  // Update count badge
  const countEl = document.getElementById('bgt-count');
  if (countEl) {
    const active = bgtTasks.filter(t => t.status !== 'complete' && t.status !== 'failed').length;
    countEl.textContent = `${active} 个活跃`;
  }

  // Update heartbeat label
  const hbLabel = document.getElementById('bgt-heartbeat-label');
  if (hbLabel) {
    const mins = bgtHeartbeatConfig.interval_minutes || 10;
    const on = bgtHeartbeatConfig.enabled;
    hbLabel.textContent = on ? `• 心跳: 每 ${mins} 分钟` : '• 心跳: 关闭';
    hbLabel.style.color = on ? 'var(--brand)' : 'var(--muted)';
  }

  // Only render non-empty columns
  const byStatus = {};
  for (const col of BGT_COLUMNS) byStatus[col.key] = [];
  for (const t of bgtTasks) {
    if (byStatus[t.status]) byStatus[t.status].push(t);
    else if (byStatus['stalled']) byStatus['stalled'].push(t);
  }

  board.innerHTML = '';
  for (const col of BGT_COLUMNS) {
    const tasks = byStatus[col.key];
    if (tasks.length === 0 && (col.key === 'complete' || col.key === 'failed' || col.key === 'stalled' || col.key === 'needs_assistance')) continue;
    const colEl = document.createElement('div');
    colEl.style.cssText = 'min-width:240px;max-width:280px;flex:0 0 auto;display:flex;flex-direction:column;gap:0;';
    colEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;color:${col.color}">${col.label}</span>
        <span style="font-size:10px;background:${col.bg};color:${col.color};border-radius:999px;padding:1px 8px;font-weight:700">${tasks.length}</span>
      </div>
      <div class="bgt-col-cards" style="display:flex;flex-direction:column;gap:8px;min-height:60px">${tasks.map(t => bgtCardHTML(t, col)).join('')}</div>
    `;
    board.appendChild(colEl);
    if (tasks.length === 0) {
      // Empty placeholder
      colEl.querySelector('.bgt-col-cards').innerHTML = `<div style="text-align:center;padding:20px 8px;color:var(--muted);font-size:11px;border:1.5px dashed var(--line);border-radius:10px">${col.empty}</div>`;
    }
  }

  // If no tasks at all
  if (bgtTasks.length === 0) {
    board.innerHTML = `<div style="text-align:center;padding:60px 24px;color:var(--muted);font-size:13px;flex:1">
      <div style="font-size:36px;margin-bottom:12px">Tasks</div>
      <div style="font-weight:700;margin-bottom:4px">暂无后台任务</div>
      <div style="font-size:12px">在对话中让 SmallClaw 后台执行任务，任务会出现在这里。</div>
    </div>`;
  }
}

function bgtCardHTML(t, col) {
  const mins = Math.round((Date.now() - (t.lastProgressAt || t.startedAt)) / 60000);
  const timeAgo = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins/60)} 小时前`;
  const stepsDone = (t.plan || []).filter(s => s.status === 'done' || s.status === 'skipped').length;
  const totalSteps = (t.plan || []).length;
  const pct = totalSteps > 0 ? Math.round(stepsDone / totalSteps * 100) : 0;
  const currentStep = (t.plan || [])[t.currentStepIndex || 0];
  const channel = t.channel === 'telegram' ? 'Telegram' : '网页端';

  return `
  <div onclick="openBgtPanel('${escHtml(t.id)}')" data-bgt-id="${escHtml(t.id)}" style="
    background:var(--panel);border:1.5px solid var(--line);border-radius:12px;padding:12px 14px;
    cursor:pointer;transition:border-color 0.15s,box-shadow 0.15s;
    ${bgtOpenTaskId === t.id ? 'border-color:var(--brand);box-shadow:0 0 0 2px rgba(90,145,255,0.15);' : ''}
  " onmouseover="this.style.borderColor='var(--brand)'" onmouseout="this.style.borderColor='${bgtOpenTaskId===t.id?'var(--brand)':'var(--line)'}'">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px">
      <span style="font-size:13px;font-weight:700;line-height:1.3;flex:1;min-width:0">${escHtml(t.title || '未命名任务')}</span>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <button
          onclick="event.stopPropagation(); bgtDeleteTask('${escHtml(t.id)}', '${escHtml(t.status)}')"
          title="删除任务"
          style="border:1px solid #fca5a5;background:var(--panel)0f0;color:#9c1a1a;border-radius:7px;padding:1px 6px;font-size:11px;font-weight:700;cursor:pointer"
        >✕</button>
        <span style="font-size:14px;flex-shrink:0">${STATUS_ICON[t.status] || '?'}</span>
      </div>
    </div>
    ${currentStep ? `<div style="font-size:11px;color:var(--muted);margin-bottom:8px;line-height:1.4">步骤 ${(t.currentStepIndex||0)+1}/${totalSteps}: ${escHtml(currentStep.description.slice(0,60))}${currentStep.description.length>60?'…':''}</div>` : ''}
    ${totalSteps > 0 ? `
    <div style="background:var(--line);border-radius:999px;height:3px;margin-bottom:8px;overflow:hidden">
      <div style="background:${col.color};width:${pct}%;height:100%;border-radius:999px;transition:width 0.4s"></div>
    </div>` : ''}
    <div style="display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:10px;color:var(--muted)">${channel} · ${timeAgo}</span>
      ${t.status === 'needs_assistance' ? `<span style="font-size:10px;background:#f5eeff;color:#6d2d9e;border-radius:999px;padding:1px 8px;font-weight:700">需要你</span>` : ''}
      ${t.status === 'paused' ? `<span style="font-size:10px;background:#f5f5f5;color:#555;border-radius:999px;padding:1px 8px;font-weight:700">${t.pauseReason || '已暂停'}</span>` : ''}
    </div>
  </div>`;
}

// --- Side Panel --------------------------------------------------------------
async function openBgtPanel(taskId) {
  bgtOpenTaskId = taskId;
  const panel = document.getElementById('bgt-panel');
  if (panel) panel.style.display = 'flex';
  // Clear chat input when switching tasks
  const chatInput = document.getElementById('bgt-chat-input');
  if (chatInput) { chatInput.value = ''; chatInput.disabled = false; chatInput.style.opacity = ''; }
  await bgtRefreshOpenPanel();
  // Highlight the card
  renderBgTasks();
}

function closeBgtPanel() {
  bgtOpenTaskId = null;
  const panel = document.getElementById('bgt-panel');
  if (panel) panel.style.display = 'none';
  renderBgTasks();
}

async function bgtRefreshOpenPanel() {
  if (!bgtOpenTaskId) return;
  let task;
  try {
    const data = await api(`/api/bg-tasks/${bgtOpenTaskId}`);
    if (data.success) task = data.task;
  } catch {}
  if (!task) { task = bgtTasks.find(t => t.id === bgtOpenTaskId); }
  if (!task) return;

  const titleEl = document.getElementById('bgt-panel-title');
  if (titleEl) titleEl.textContent = task.title || '任务详情';

  const pauseBtn = document.getElementById('bgt-panel-pause');
  if (pauseBtn) {
    if (task.status === 'running') {
      pauseBtn.textContent = '暂停';
      pauseBtn.style.display = '';
    } else if (task.status === 'paused' || task.status === 'queued') {
      pauseBtn.textContent = '继续';
      pauseBtn.style.display = '';
    } else {
      pauseBtn.style.display = 'none';
    }
  }

  const body = document.getElementById('bgt-panel-body');
  if (!body) return;

  const plan = task.plan || [];
  const journal = task.journal || [];
  const stepsDone = plan.filter(s => s.status === 'done' || s.status === 'skipped').length;
  const lastTool = task.lastToolCall || '—';
  const lastToolAt = task.lastToolCallAt ? new Date(task.lastToolCallAt).toLocaleTimeString() : '—';
  const channel = task.channel === 'telegram' ? 'Telegram' : '网页端';
  const startedAt = task.startedAt ? new Date(task.startedAt).toLocaleString() : '—';
  const statusColor = { running:'var(--sel-text)', queued:'#7c4d00', paused:'#555', stalled:'#9c1a1a', needs_assistance:'#6d2d9e', complete:'#1a6e35', failed:'#9c1a1a' };
  const sc = statusColor[task.status] || '#555';

  // Build plan steps HTML
  const stepsHTML = plan.map((step, i) => {
    const icon = step.status === 'done' ? '✓' : step.status === 'failed' ? '✕' : step.status === 'skipped' ? '↷' : i === (task.currentStepIndex || 0) && task.status === 'running' ? '▶' : '○';
    const isCurrent = i === (task.currentStepIndex || 0) && task.status !== 'complete';
    return `<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;border-bottom:1px solid var(--line);${isCurrent?'background:#f0f5ff;margin:0 -8px;padding:7px 8px;border-radius:6px;':''}"
      title="${step.notes ? escHtml(step.notes) : ''}">
      <span style="font-size:14px;flex-shrink:0;line-height:1.4">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:${isCurrent?'700':'500'};color:${isCurrent?'var(--text)':'var(--muted)'}">${escHtml(step.description)}</div>
        ${step.notes ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${escHtml(step.notes.slice(0,120))}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  // Build journal HTML (last 30 entries)
  const recentJournal = journal.slice(-30).reverse();
  const journalHTML = recentJournal.map(entry => {
    const time = new Date(entry.t).toLocaleTimeString();
    const typeColor = { tool_call:'var(--sel-text)', tool_result:'#1a6e35', error:'#9c1a1a', plan_mutation:'#6d2d9e', status_push:'#555', pause:'#7c4d00', resume:'#7c4d00', advisor_decision:'#555', heartbeat:'var(--brand)' };
    const tc = typeColor[entry.type] || '#888';
    return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid var(--line);font-size:11px">
      <span style="color:var(--muted);flex-shrink:0;min-width:52px">${time}</span>
      <span style="color:${tc};flex-shrink:0;font-weight:700;min-width:60px">${entry.type}</span>
      <span style="color:var(--text);flex:1;min-width:0;word-break:break-word">${escHtml(entry.content)}</span>
    </div>`;
  }).join('');

  // Build assistance block outside template literal to avoid backtick nesting issues
  let assistanceHTML = '';
  const taskStatusNorm = String(task.status || '').trim().toLowerCase();
  console.log('[BGT panel] task.status =', JSON.stringify(task.status), 'norm =', taskStatusNorm);
  if (taskStatusNorm === 'needs_assistance' || taskStatusNorm === 'paused' || taskStatusNorm === 'stalled' || taskStatusNorm === 'failed') {
    const lastPause = [...journal].reverse().find(e => e.type === 'pause' || e.type === 'error');
    const lastStatusPush = [...journal].reverse().find(e => e.type === 'status_push' && e.content);
    const pauseMsg = escHtml((lastPause?.content || lastStatusPush?.content || '任务已暂停，等待你的输入。').replace(/^Task paused for assistance:\s*/i, ''));
    const pauseDetail = lastPause?.detail ? escHtml(lastPause.detail.slice(0, 300)) : '';
    const tid = escHtml(task.id);
    assistanceHTML = '<div style="background:#f5eeff;border:1px solid #cba8f5;border-radius:10px;padding:12px 14px;font-size:12px;line-height:1.6;color:#6d2d9e">'
      + '<div style="font-weight:800;margin-bottom:6px">⚠️ 任务需要你的输入</div>'
      + '<div style="color:#3d1a6e;margin-bottom:' + (pauseDetail ? '6px' : '0') + '">' + pauseMsg + '</div>'
      + (pauseDetail ? '<div style="font-size:11px;color:#6d2d9e;opacity:0.8;margin-bottom:4px">' + pauseDetail + '</div>' : '')
      + '</div>'
      + '<div style="border:1px solid #cba8f5;border-radius:10px;overflow:hidden;background:#faf5ff;margin-top:8px">'
      + '<div style="padding:8px 12px;font-size:11px;font-weight:700;color:#6d2d9e;border-bottom:1px solid #e9d8ff">💬 回复给智能体</div>'
      + '<div style="display:flex;gap:8px;padding:8px">'
      + '<textarea id="task-reply-input" rows="2" placeholder="输入你的回复——智能体将看到并继续..." style="flex:1;resize:none;border:1px solid #cba8f5;border-radius:8px;padding:8px;font-size:12px;font-family:inherit;background:var(--panel);color:var(--text)"></textarea>'
      + '<button id="task-reply-send" data-taskid="' + tid + '" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;align-self:flex-end">发送</button>'
      + '</div></div>';
  }

  body.innerHTML = `
    <!-- Status row -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <span style="font-size:11px;background:var(--line);border-radius:999px;padding:2px 10px;font-weight:700;color:${sc}">${STATUS_ICON[task.status]} ${STATUS_LABEL[task.status] || task.status.replace(/_/g,' ')}</span>
      <span style="font-size:11px;color:var(--muted)">${channel}</span>
      <span style="font-size:11px;color:var(--muted)">开始于 ${startedAt}</span>
    </div>

    <!-- Summary if complete -->
    ${task.finalSummary ? `<div style="background:#efffea;border:1px solid #b2dfb2;border-radius:10px;padding:12px 14px;font-size:12px;line-height:1.6;color:#1a6e35">
      <div style="font-weight:800;margin-bottom:4px">✓ 总结</div>
      ${escHtml(task.finalSummary)}
    </div>` : ''}

    <!-- Needs assistance -->
    ${assistanceHTML}

    <!-- Stats row -->
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:100px;background:var(--panel-2);border-radius:10px;padding:10px 12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:2px">进度</div>
        <div style="font-size:18px;font-weight:800">${stepsDone}<span style="font-size:12px;color:var(--muted)">/${plan.length}</span></div>
        <div style="font-size:10px;color:var(--muted)">步骤完成</div>
      </div>
      <div style="flex:1;min-width:100px;background:var(--panel-2);border-radius:10px;padding:10px 12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700;margin-bottom:2px">最近工具</div>
        <div style="font-size:12px;font-weight:700;word-break:break-all">${escHtml(lastTool.slice(0,30))}</div>
        <div style="font-size:10px;color:var(--muted)">${lastToolAt}</div>
      </div>
    </div>

    <!-- Plan steps -->
    ${plan.length > 0 ? `
    <div>
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:8px">执行计划</div>
      <div style="border:1px solid var(--line);border-radius:10px;padding:6px 8px">${stepsHTML}</div>
    </div>` : ''}

    <!-- Process journal -->
    <div>
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:0.05em;color:var(--muted);margin-bottom:6px">进程日志 <span style="font-weight:400;opacity:0.6">(最新在前)</span></div>
      <div style="font-family:monospace;font-size:11px;border:1px solid var(--line);border-radius:10px;padding:6px 8px;max-height:300px;overflow-y:auto">
        ${journalHTML || '<div style="color:var(--muted);padding:8px">暂无记录</div>'}
      </div>
    </div>

    <!-- Delete button -->
    ${(task.status === 'complete' || task.status === 'failed') ? `
    <button onclick="bgtDeleteTask('${escHtml(task.id)}')" style="border:1px solid #fca5a5;background:var(--panel)0f0;color:#9c1a1a;border-radius:8px;padding:6px 14px;font-size:12px;font-weight:700;cursor:pointer;align-self:flex-start">删除</button>` : ''}
  `;

  // Wire up the reply send button via JS (avoids inline onclick escaping issues)
  const sendBtn = document.getElementById('task-reply-send');
  if (sendBtn) {
    sendBtn.addEventListener('click', () => bgtSendReply(sendBtn.dataset.taskid));
  }
  // Also allow Enter (without Shift) in the textarea to send
  const replyInput = document.getElementById('task-reply-input');
  if (replyInput) {
    replyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        bgtSendReply(sendBtn ? sendBtn.dataset.taskid : bgtOpenTaskId);
      }
    });
  }
}

// --- Actions -----------------------------------------------------------------
async function bgtPauseResume() {
  if (!bgtOpenTaskId) return;
  const task = bgtTasks.find(t => t.id === bgtOpenTaskId);
  if (!task) return;
  if (task.status === 'running') {
    // Pause
    try { await api(`/api/bg-tasks/${bgtOpenTaskId}/pause`, { method: 'POST' }); } catch {}
  } else if (task.status === 'paused' || task.status === 'queued') {
    // Resume
    try { await api(`/api/bg-tasks/${bgtOpenTaskId}/resume`, { method: 'POST' }); } catch {}
  }
  await refreshBgTasks();
  await bgtRefreshOpenPanel();
}

async function bgtSendReply(taskId) {
  const input = document.getElementById('task-reply-input');
  if (!input) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  input.disabled = true;
  try {
    const result = await api(`/api/bg-tasks/${taskId}/message`, { method: 'POST', body: JSON.stringify({ message }) });
    if (result.success) {
      // Refresh the panel after a short delay to show the journal update
      setTimeout(() => bgtRefreshOpenPanel(), 800);
    } else {
      alert('发送失败: ' + (result.error || '未知错误'));
    }
  } catch (e) {
    alert('发送消息出错: ' + e.message);
  } finally {
    input.disabled = false;
    input.focus();
  }
}

async function bgtChatSend() {
  const input = document.getElementById('bgt-chat-input');
  if (!input || !bgtOpenTaskId) return;
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  input.disabled = true;
  input.style.opacity = '0.5';
  try {
    const result = await api(`/api/bg-tasks/${bgtOpenTaskId}/message`, { method: 'POST', body: JSON.stringify({ message }) });
    if (result.success) {
      // Show optimistic sent indicator in journal area
      const body = document.getElementById('bgt-panel-body');
      if (body) {
        const sentDiv = document.createElement('div');
        sentDiv.style.cssText = 'background:var(--brand);color:#fff;border-radius:8px;padding:6px 10px;font-size:12px;align-self:flex-end;max-width:80%;word-break:break-word;opacity:0.85';
        sentDiv.textContent = '\u2192 ' + message;
        body.appendChild(sentDiv);
        body.scrollTop = body.scrollHeight;
      }
      // Refresh panel after short delay to show journal update
      setTimeout(() => bgtRefreshOpenPanel(), 1000);
    } else {
      alert('发送失败: ' + (result.error || '未知错误'));
    }
  } catch (e) {
    alert('出错: ' + e.message);
  } finally {
    input.disabled = false;
    input.style.opacity = '';
    input.focus();
  }
}

async function bgtDeleteTask(taskId, status) {
  const isActive = status && status !== 'complete' && status !== 'failed';
  const prompt = isActive
    ? '任务仍在进行中，确定要从看板移除吗？'
    : '确定从看板移除该任务吗？';
  if (!confirm(prompt)) return;
  try { await api(`/api/bg-tasks/${taskId}`, { method: 'DELETE' }); } catch {}
  if (bgtOpenTaskId === taskId) closeBgtPanel();
  await refreshBgTasks();
}

// --- Toast notification -------------------------------------------------------
function bgtToast(title, body) {
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;bottom:24px;right:24px;z-index:9999;background:var(--panel);border:1.5px solid var(--line);border-radius:12px;padding:12px 16px;min-width:240px;max-width:360px;box-shadow:0 4px 24px rgba(0,0,0,0.12);font-family:var(--font)`;
  toast.innerHTML = `<div style="font-size:13px;font-weight:800;margin-bottom:4px">${escHtml(title)}</div>${body ? `<div style="font-size:12px;color:var(--muted);line-height:1.4">${escHtml(body)}</div>` : ''}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}
// --- Integrations Tab ---------------------------------------------------------

let _integTab = 'webhooks';

function setIntegTab(tab) {
  _integTab = tab;
  ['webhooks', 'mcp'].forEach(t => {
    const btn = document.getElementById('itab-' + t);
    const panel = document.getElementById('itab-panel-' + t);
    if (btn) {
      btn.style.background = t === tab ? 'var(--sel-bg)' : 'var(--panel)';
      btn.style.color = t === tab ? 'var(--sel-text)' : 'var(--muted)';
      btn.style.borderColor = t === tab ? 'var(--sel-border)' : 'var(--line)';
    }
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
  });
}

async function loadIntegrationsTab() {
  setIntegTab(_integTab);
  await loadWebhookSettings();
  await loadMCPServers();
}

// --- Webhooks -----------------------------------------------------------------

async function loadWebhookSettings() {
  try {
    const data = await api('/api/settings/hooks');
    const h = data.hooks || {};
    const cb = document.getElementById('wh-enabled');
    const inp = document.getElementById('wh-token');
    const pathInp = document.getElementById('wh-path');
    if (cb) cb.checked = h.enabled === true;
    if (inp) inp.value = h.tokenSet ? '••••••••' : '';
    if (pathInp) pathInp.value = h.path || '/hooks';
    updateWebhookStatus(h.enabled, h.tokenSet);
    updateWebhookUrlDisplay(h.enabled, h.tokenSet, h.path || '/hooks');
  } catch(e) {
    console.warn('loadWebhookSettings:', e);
  }
}

function updateWebhookStatus(enabled, tokenSet) {
  const dot = document.getElementById('wh-status-dot');
  const txt = document.getElementById('wh-status-text');
  if (!dot || !txt) return;
  if (enabled && tokenSet) {
    dot.style.background = '#22c55e';
    txt.textContent = 'Active — endpoint is running';
    txt.style.color = '#166534';
  } else if (!enabled) {
    dot.style.background = '#ccc';
    txt.textContent = 'Disabled';
    txt.style.color = 'var(--muted)';
  } else {
    dot.style.background = '#f59e0b';
    txt.textContent = 'Enabled but no token set';
    txt.style.color = '#92400e';
  }
}

function updateWebhookUrlDisplay(enabled, tokenSet, hookPath) {
  const el = document.getElementById('wh-url-display');
  if (!el) return;
  if (enabled && tokenSet) {
    const origin = window.location.origin || 'http://localhost:18789';
    el.style.display = 'block';
    el.textContent = origin + hookPath + '/agent';
  } else {
    el.style.display = 'none';
  }
}

function generateWebhookToken() {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  const token = Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
  const inp = document.getElementById('wh-token');
  if (inp) { inp.value = token; inp.type = 'text'; setTimeout(() => { inp.type = 'password'; }, 4000); }
}

async function saveWebhookSettings() {
  const enabled = document.getElementById('wh-enabled')?.checked ?? false;
  const rawToken = document.getElementById('wh-token')?.value?.trim() || '';
  const hookPath = document.getElementById('wh-path')?.value?.trim() || '/hooks';
  try {
    const r = await api('/api/settings/hooks', {
      method: 'POST',
      body: JSON.stringify({ enabled, token: rawToken, path: hookPath }),
    });
    if (r.success) {
      await loadWebhookSettings();
      showIntegMsg('? Webhook settings saved — restart gateway to apply', '#166534', '#f0fdf4');
    } else {
      showIntegMsg('Error: ' + (r.error || 'Unknown error'), '#991b1b', '#fef2f2');
    }
  } catch(e) {
    showIntegMsg('Save failed: ' + e.message, '#991b1b', '#fef2f2');
  }
}

async function testWebhookEndpoint() {
  try {
    const r = await api('/api/settings/hooks/test', { method: 'POST' });
    if (r.success) {
      showIntegMsg('? ' + (r.message || 'Endpoint is active'), '#166534', '#f0fdf4');
    } else {
      showIntegMsg('? ' + (r.error || 'Test failed'), '#991b1b', '#fef2f2');
    }
  } catch(e) {
    showIntegMsg('Test failed: ' + e.message, '#991b1b', '#fef2f2');
  }
}

function copyWebhookCurl() {
  const origin = window.location.origin || 'http://localhost:18789';
  const hookPath = document.getElementById('wh-path')?.value?.trim() || '/hooks';
  const curl = `curl -X POST ${origin}${hookPath}/agent \\
  -H "x-smallclaw-token: YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello from webhook", "name": "MyApp", "deliver": true}'`;
  navigator.clipboard?.writeText(curl).then(() => {
    showIntegMsg('cURL example copied to clipboard', '#1e40af', '#eff6ff');
  }).catch(() => {
    showIntegMsg('Could not copy — check browser permissions', '#92400e', '#fffbeb');
  });
}

// --- MCP ---------------------------------------------------------------------

let _mcpEditingId = null;

const MCP_PRESETS = {
  filesystem: { name: 'Filesystem', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-filesystem\nC:\\Users', env: '', description: 'Read/write local files' },
  github:     { name: 'GitHub', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-github', env: 'GITHUB_PERSONAL_ACCESS_TOKEN=', description: 'Repos, PRs, issues' },
  postgres:   { name: 'PostgreSQL', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-postgres\npostgresql://localhost/mydb', env: '', description: 'Query PostgreSQL' },
  sqlite:     { name: 'SQLite', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-sqlite\n--db-path\nC:\\path\\to\\db.sqlite', env: '', description: 'Local database' },
  brave:      { name: 'Brave Search', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-brave-search', env: 'BRAVE_API_KEY=', description: 'Web search' },
  memory:     { name: 'Memory', transport: 'stdio', command: 'npx', args: '-y\n@modelcontextprotocol/server-memory', env: '', description: 'Persistent knowledge store' },
};

async function loadMCPServers() {
  const el = document.getElementById('mcp-server-list');
  if (!el) return;
  try {
    const data = await api('/api/mcp/servers');
    const servers = data.servers || [];
    if (servers.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:8px 0">No MCP servers configured yet.<br>Add one above or click a preset on the right.</div>';
      return;
    }
    el.innerHTML = servers.map(s => {
      const statusColor = s.status === 'connected' ? '#22c55e' : s.status === 'error' ? '#ef4444' : s.status === 'connecting' ? '#f59e0b' : '#9ca3af';
      const statusLabel = s.status === 'connected' ? `Connected · ${s.toolCount} tool${s.toolCount !== 1 ? 's' : ''}` : s.status === 'error' ? 'Error' : s.status === 'connecting' ? 'Connecting…' : 'Disconnected';
      const toolTip = s.toolNames?.length ? s.toolNames.join(', ') : '';
      return `<div style="display:flex;align-items:flex-start;gap:8px;padding:8px;border:1px solid var(--line);border-radius:8px;margin-bottom:6px;background:${s.enabled ? 'var(--panel)' : 'var(--panel-2)'}">
        <div style="padding-top:2px">
          <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0"></div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;color:var(--text)">${escHtml(s.name)} <span style="font-weight:400;color:var(--muted);font-size:11px">(${escHtml(s.id)})</span></div>
          <div style="font-size:11px;color:${statusColor};margin-top:1px" title="${escHtml(toolTip)}">${statusLabel}${s.error ? ` — ${escHtml(s.error.slice(0,60))}` : ''}</div>
          ${toolTip ? `<div style="font-size:10px;color:var(--muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(toolTip)}">${escHtml(toolTip.slice(0,80))}${toolTip.length>80?'…':''}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0">
          ${s.status === 'connected'
            ? `<button onclick="disconnectMCPServer('${s.id}')" style="padding:3px 8px;border:1px solid var(--line);border-radius:5px;background:var(--panel);font-size:10px;cursor:pointer">Disconnect</button>`
            : `<button onclick="connectMCPServer('${s.id}')" style="padding:3px 8px;border:1px solid var(--brand);border-radius:5px;background:var(--panel);color:var(--brand);font-size:10px;font-weight:600;cursor:pointer">Connect</button>`
          }
          <button onclick="editMCPServer('${s.id}')" style="padding:3px 8px;border:1px solid var(--line);border-radius:5px;background:var(--panel);font-size:10px;cursor:pointer">Edit</button>
          <button onclick="deleteMCPServer('${s.id}')" style="padding:3px 8px;border:1px solid #fecaca;border-radius:5px;background:var(--panel);color:#ef4444;font-size:10px;cursor:pointer">?</button>
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    el.innerHTML = `<div style="color:#ef4444">Failed to load: ${escHtml(e.message)}</div>`;
  }
}

function showMCPAddForm(editData) {
  _mcpEditingId = editData?.id || null;
  document.getElementById('mcp-add-form').style.display = 'block';
  document.getElementById('mcp-form-title').textContent = _mcpEditingId ? 'Edit MCP Server' : 'Add MCP Server';
  document.getElementById('mcp-form-msg').textContent = '';

  if (editData) {
    const v = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = val; };
    v('mcp-f-id', editData.id); v('mcp-f-name', editData.name);
    document.getElementById('mcp-f-transport').value = editData.transport || 'stdio';
    onMCPTransportChange();
    v('mcp-f-command', editData.command || '');
    v('mcp-f-args', (editData.args || []).join('\n'));
    v('mcp-f-env', Object.entries(editData.env || {}).map(([k,v]) => `${k}=${v}`).join('\n'));
    v('mcp-f-url', editData.url || '');
    v('mcp-f-headers', Object.entries(editData.headers || {}).map(([k,v]) => `${k}: ${v}`).join('\n'));
    const cb = document.getElementById('mcp-f-enabled');
    if (cb) cb.checked = editData.enabled !== false;
  } else {
    ['mcp-f-id','mcp-f-name','mcp-f-command','mcp-f-args','mcp-f-env','mcp-f-url','mcp-f-headers'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('mcp-f-transport').value = 'stdio';
    onMCPTransportChange();
    const cb = document.getElementById('mcp-f-enabled'); if (cb) cb.checked = true;
  }
  document.getElementById('mcp-f-id').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideMCPAddForm() {
  document.getElementById('mcp-add-form').style.display = 'none';
  _mcpEditingId = null;
}

function onMCPTransportChange() {
  const t = document.getElementById('mcp-f-transport')?.value;
  document.getElementById('mcp-stdio-fields').style.display = t === 'stdio' ? 'block' : 'none';
  document.getElementById('mcp-sse-fields').style.display = t === 'sse' ? 'block' : 'none';
}

function prefillMCPServer(presetKey) {
  const p = MCP_PRESETS[presetKey];
  if (!p) return;
  showMCPAddForm();
  const v = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
  v('mcp-f-id', presetKey);
  v('mcp-f-name', p.name);
  document.getElementById('mcp-f-transport').value = p.transport;
  onMCPTransportChange();
  v('mcp-f-command', p.command || '');
  v('mcp-f-args', p.args || '');
  v('mcp-f-env', p.env || '');
  v('mcp-f-url', p.url || '');
  setIntegTab('mcp');
}

async function saveMCPServer() {
  const id = document.getElementById('mcp-f-id')?.value?.trim();
  const name = document.getElementById('mcp-f-name')?.value?.trim();
  const transport = document.getElementById('mcp-f-transport')?.value || 'stdio';
  const enabled = document.getElementById('mcp-f-enabled')?.checked ?? true;
  const msgEl = document.getElementById('mcp-form-msg');

  if (!id || !name) { if (msgEl) msgEl.textContent = 'ID and Name are required.'; return; }

  const cfg = { id, name, transport, enabled };

  if (transport === 'stdio') {
    cfg.command = document.getElementById('mcp-f-command')?.value?.trim() || '';
    const argsRaw = document.getElementById('mcp-f-args')?.value || '';
    cfg.args = argsRaw.split('\n').map(s => s.trim()).filter(Boolean);
    const envRaw = document.getElementById('mcp-f-env')?.value || '';
    cfg.env = {};
    envRaw.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
      const eq = line.indexOf('='); if (eq > 0) cfg.env[line.slice(0,eq).trim()] = line.slice(eq+1);
    });
  } else {
    cfg.url = document.getElementById('mcp-f-url')?.value?.trim() || '';
    const headersRaw = document.getElementById('mcp-f-headers')?.value || '';
    cfg.headers = {};
    headersRaw.split('\n').map(l => l.trim()).filter(Boolean).forEach(line => {
      const colon = line.indexOf(':'); if (colon > 0) cfg.headers[line.slice(0,colon).trim()] = line.slice(colon+1).trim();
    });
  }

  try {
    const r = await api('/api/mcp/servers', { method: 'POST', body: JSON.stringify(cfg) });
    if (r.success) {
      if (msgEl) msgEl.textContent = '? Saved';
      setTimeout(() => hideMCPAddForm(), 600);
      await loadMCPServers();
      // Auto-connect if enabled
      if (enabled) connectMCPServer(id);
    } else {
      if (msgEl) msgEl.textContent = 'Error: ' + (r.error || 'Unknown');
    }
  } catch(e) {
    if (msgEl) msgEl.textContent = 'Save failed: ' + e.message;
  }
}

async function editMCPServer(id) {
  try {
    const data = await api('/api/mcp/servers');
    const server = (data.servers || []).find(s => s.id === id);
    if (server) showMCPAddForm(server);
  } catch(e) { console.warn('editMCPServer:', e); }
}

async function deleteMCPServer(id) {
  if (!confirm(`Delete MCP server "${id}"?`)) return;
  try {
    await api(`/api/mcp/servers/${id}`, { method: 'DELETE' });
    await loadMCPServers();
  } catch(e) { showIntegMsg('Delete failed: ' + e.message, '#991b1b', '#fef2f2'); }
}

async function connectMCPServer(id) {
  showIntegMsg('Connecting to ' + id + '…', '#1e40af', '#eff6ff');
  try {
    const r = await api(`/api/mcp/servers/${id}/connect`, { method: 'POST' });
    if (r.success) {
      showIntegMsg(`? Connected — ${(r.tools||[]).length} tool(s) available`, '#166534', '#f0fdf4');
    } else {
      showIntegMsg('? Connection failed: ' + (r.error || 'Unknown'), '#991b1b', '#fef2f2');
    }
    await loadMCPServers();
  } catch(e) {
    showIntegMsg('Connect error: ' + e.message, '#991b1b', '#fef2f2');
    await loadMCPServers();
  }
}

async function disconnectMCPServer(id) {
  try {
    await api(`/api/mcp/servers/${id}/disconnect`, { method: 'POST' });
    await loadMCPServers();
    showIntegMsg('Disconnected from ' + id, '#475569', '#f8fafc');
  } catch(e) { showIntegMsg('Disconnect error: ' + e.message, '#991b1b', '#fef2f2'); }
}

// --- Shared helper ------------------------------------------------------------

function showIntegMsg(msg, color, bg) {
  let el = document.getElementById('integ-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'integ-toast';
    el.style.cssText = 'position:fixed;bottom:80px;right:24px;z-index:9999;padding:10px 16px;border-radius:10px;font-size:12px;font-weight:600;max-width:320px;box-shadow:0 4px 16px rgba(0,0,0,0.12);transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.style.background = bg || '#f0fdf4';
  el.style.color = color || '#166534';
  el.style.border = `1px solid ${color || '#166534'}33`;
  el.style.opacity = '1';
  el.textContent = msg;
  clearTimeout(el._timeout);
  el._timeout = setTimeout(() => { el.style.opacity = '0'; }, 3500);
}

// ───────────────────────────────────────────────────────────────────────────
// ERROR RESPONSE SYSTEM — Full JavaScript Implementation
// Handles: show/hide panel, option selection, input rendering,
// credential entry, form submission, WS event binding
// ───────────────────────────────────────────────────────────────────────────

// State
let _errTaskId = null;
let _errTemplate = null;
let _errSelectedAction = null;
let _errCategory = null;
let _errBackdrop = null;

function _getOrCreateErrorBackdrop() {
  if (_errBackdrop) return _errBackdrop;
  _errBackdrop = document.createElement('div');
  _errBackdrop.id = 'error-response-backdrop';
  _errBackdrop.style.cssText = 'position:fixed;inset:0;background:rgba(10,20,40,0.45);z-index:9997;display:none';
  _errBackdrop.addEventListener('click', closeErrorResponse);
  document.body.appendChild(_errBackdrop);
  return _errBackdrop;
}

function showErrorResponsePanel(taskId, category, errorMessage, errorDetail, template) {
  _errTaskId = taskId;
  _errTemplate = template;
  _errSelectedAction = null;
  _errCategory = category;

  // Title & description
  const titleEl = document.getElementById('error-response-title');
  const descEl = document.getElementById('error-response-desc');
  if (titleEl) titleEl.textContent = template?.title || ('\u26a0\ufe0f ' + (category || 'Error').toUpperCase());
  if (descEl) descEl.textContent = template?.description || errorMessage || 'The task needs your help to continue.';

  // Render options
  const optionsEl = document.getElementById('error-response-options');
  if (optionsEl) {
    optionsEl.innerHTML = '';
    const options = template?.options || [
      { id: 'retry_now', label: '\u27f3 Retry Now', icon: '\u27f3' },
      { id: 'skip', label: '\u229a Skip Step', icon: '\u229a' },
      { id: 'cancel', label: '\u2715 Cancel Task', icon: '\u2715', danger: true },
    ];
    options.forEach(opt => {
      const btn = document.createElement('button');
      btn.className = 'error-option-btn' + (opt.danger ? ' danger' : '');
      btn.dataset.actionId = opt.id;
      btn.innerHTML = `<strong>${escHtml(opt.icon || '')} ${escHtml(opt.label)}</strong>${opt.description ? `<br><span style="font-weight:400;opacity:0.75">${escHtml(opt.description)}</span>` : ''}`;
      btn.addEventListener('click', () => selectErrorOption(opt));
      optionsEl.appendChild(btn);
    });
  }

  // Clear inputs
  const inputsEl = document.getElementById('error-response-inputs');
  if (inputsEl) {
    inputsEl.innerHTML = '';
    inputsEl.classList.remove('visible');
  }

  // Reset submit button
  const submitBtn = document.getElementById('error-response-submit-btn');
  if (submitBtn) submitBtn.disabled = true;

  // Show backdrop + panel
  const backdrop = _getOrCreateErrorBackdrop();
  backdrop.style.display = 'block';
  const panel = document.getElementById('error-response-panel');
  if (panel) panel.classList.add('visible');

  // Notification toast
  bgtToast('\u26a0\ufe0f Task needs help', (template?.title || category || 'Error') + ' — see panel');
}

function selectErrorOption(opt) {
  _errSelectedAction = opt.id;

  // Highlight selected
  document.querySelectorAll('.error-option-btn').forEach(b => b.classList.remove('selected'));
  const btn = document.querySelector(`.error-option-btn[data-action-id="${opt.id}"]`);
  if (btn) btn.classList.add('selected');

  // Show input fields if this option requires them
  const inputsEl = document.getElementById('error-response-inputs');
  if (inputsEl) {
    inputsEl.innerHTML = '';
    inputsEl.classList.remove('visible');

    const triggerInputs = opt.triggerInputs || [];
    const allFields = _errTemplate?.requiredInputs || [];
    const fieldsToShow = triggerInputs.length > 0
      ? allFields.filter(f => triggerInputs.includes(f.id))
      : [];

    if (fieldsToShow.length > 0) {
      fieldsToShow.forEach(field => {
        const wrap = document.createElement('div');
        wrap.className = 'input-field';
        const label = document.createElement('label');
        label.textContent = field.label;
        label.setAttribute('for', 'err-input-' + field.id);
        const input = document.createElement('input');
        input.id = 'err-input-' + field.id;
        input.type = field.type || 'text';
        input.placeholder = field.placeholder || '';
        input.dataset.fieldId = field.id;
        if (field.validation === 'digits_only') {
          input.inputMode = 'numeric';
          input.pattern = '[0-9]*';
          input.maxLength = 8;
        }
        wrap.appendChild(label);
        wrap.appendChild(input);
        inputsEl.appendChild(wrap);
      });
      inputsEl.classList.add('visible');
      // Focus first input
      const firstInput = inputsEl.querySelector('input');
      if (firstInput) setTimeout(() => firstInput.focus(), 80);
    }
  }

  // Enable submit unless it's cancel (which submits immediately)
  const submitBtn = document.getElementById('error-response-submit-btn');
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = opt.danger ? 'Cancel Task' : 'Continue';
  }
}

function closeErrorResponse() {
  _errTaskId = null;
  _errTemplate = null;
  _errSelectedAction = null;
  _errCategory = null;

  const backdrop = document.getElementById('error-response-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  const panel = document.getElementById('error-response-panel');
  if (panel) panel.classList.remove('visible');
}

async function submitErrorResponse() {
  if (!_errTaskId || !_errSelectedAction) return;

  const action = _errSelectedAction;
  const category = _errCategory;

  // Collect input values
  const inputs = {};
  document.querySelectorAll('#error-response-inputs input[data-field-id]').forEach(el => {
    if (el.value.trim()) inputs[el.dataset.fieldId] = el.value.trim();
  });

  // Validate required fields for credential action
  if (action === 'credentials') {
    if (!inputs.email) {
      const emailEl = document.getElementById('err-input-email');
      if (emailEl) { emailEl.style.borderColor = 'var(--err)'; emailEl.focus(); }
      return;
    }
    if (!inputs.password) {
      const pwEl = document.getElementById('err-input-password');
      if (pwEl) { pwEl.style.borderColor = 'var(--err)'; pwEl.focus(); }
      return;
    }
  }

  if (action === 'verification_code') {
    if (!inputs.code) {
      const codeEl = document.getElementById('err-input-code');
      if (codeEl) { codeEl.style.borderColor = 'var(--err)'; codeEl.focus(); }
      return;
    }
  }

  // Disable submit to prevent double-send
  const submitBtn = document.getElementById('error-response-submit-btn');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }

  try {
    const resp = await fetch(`/api/bg-tasks/${_errTaskId}/error-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, category, inputs }),
    });
    const data = await resp.json();
    if (data.success) {
      closeErrorResponse();
      if (data.resumed) {
        bgtToast('\u2705 Task resuming', 'Agent is continuing with your response');
        // Refresh the kanban board to show updated status
        if (typeof refreshBgTasks === 'function') setTimeout(refreshBgTasks, 800);
      } else {
        bgtToast('Task cancelled', 'Task has been stopped');
        if (typeof refreshBgTasks === 'function') setTimeout(refreshBgTasks, 400);
      }
    } else {
      bgtToast('\u274c Error', data.error || 'Failed to submit response');
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Continue'; }
    }
  } catch (err) {
    console.error('[ErrorResponse] Submit failed:', err);
    bgtToast('\u274c Network error', 'Could not submit response');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Continue'; }
  }
}

// Hook into the existing WebSocket message handler
// We extend the onmessage handler after the page loads
(function patchWebSocketForErrorResponse() {
  function applyPatch() {
    // Find the ws variable — it’s declared in a closure, so we intercept via MutationObserver
    // Alternative: override addEventListener on WebSocket prototype to intercept messages
    const _origOnMessage = WebSocket.prototype.__defineGetter__
      ? null
      : null; // not needed — use event listener approach below

    // We hook into the document-level custom event that server-v2’s WS handler
    // already dispatches. If that’s not available, we’ll patch the WS directly.
    document.addEventListener('ws:message', handleErrorResponseWsEvent);

    // Also directly patch any open WebSocket connections by overriding WebSocket prototype
    const _OrigWS = window.WebSocket;
    window.WebSocket = function(...args) {
      const ws = new _OrigWS(...args);
      const _origAddEventListener = ws.addEventListener.bind(ws);
      ws.addEventListener = function(type, listener, ...rest) {
        if (type === 'message') {
          const wrappedListener = function(e) {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'task_error_requires_response') {
                handleErrorResponseWsEvent({ detail: msg });
              }
            } catch {}
            return listener.call(this, e);
          };
          return _origAddEventListener('message', wrappedListener, ...rest);
        }
        return _origAddEventListener(type, listener, ...rest);
      };
      // Also patch onmessage setter
      let _onmsgHandler = null;
      Object.defineProperty(ws, 'onmessage', {
        get: () => _onmsgHandler,
        set: (fn) => {
          _onmsgHandler = fn;
          _origAddEventListener('message', (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg.type === 'task_error_requires_response') {
                handleErrorResponseWsEvent({ detail: msg });
              }
            } catch {}
            if (_onmsgHandler) _onmsgHandler.call(ws, e);
          });
        },
        configurable: true,
      });
      return ws;
    };
    // Copy static properties
    Object.assign(window.WebSocket, _OrigWS);
    window.WebSocket.prototype = _OrigWS.prototype;
    window.WebSocket.CONNECTING = _OrigWS.CONNECTING;
    window.WebSocket.OPEN = _OrigWS.OPEN;
    window.WebSocket.CLOSING = _OrigWS.CLOSING;
    window.WebSocket.CLOSED = _OrigWS.CLOSED;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyPatch);
  } else {
    applyPatch();
  }
})();

function handleErrorResponseWsEvent(e) {
  const msg = e.detail || e;
  if (!msg || msg.type !== 'task_error_requires_response') return;
  showErrorResponsePanel(
    msg.taskId,
    msg.errorCategory,
    msg.errorMessage,
    msg.errorDetail,
    msg.template,
  );
}

