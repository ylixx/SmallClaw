/** api-settings.ts — provider/model preset/OAuth/webhook settings routes
 * extracted from server-v2.ts (Phase 5d-4). All dependencies are imports;
 * no deps injection needed. */
import express from 'express';
import fs from 'fs';
import { getConfig } from '../config/config';
import { getVault } from '../security/vault';
import { getProvider, resetProvider, buildProviderForLLM } from '../providers/factory';
import { startOAuthFlow, isConnected, clearTokens, loadTokens, exchangeManualCodeFromPending } from '../auth/openai-oauth';
import { LlamaServerManager } from './llama-server-manager';
import { getConfigDirPath } from './config-bootstrap';


export function getSearchSettingsPayload() {
  const cm = getConfig();
  const cfg = (cm.getConfig() as any).search || {};
  // Resolve then mask — never send actual key values to the browser.
  // Returns '••••••••' if a key is present (vault or plaintext), '' if not set.
  const maskIfSet = (val: string | undefined): string => {
    if (!val) return '';
    const resolved = cm.resolveSecret(val);
    return resolved ? '••••••••' : '';
  };
  return {
    preferred_provider: cfg.preferred_provider || 'tavily',
    search_rigor: cfg.search_rigor || 'verified',
    tavily_api_key: maskIfSet(cfg.tavily_api_key),
    google_api_key: maskIfSet(cfg.google_api_key),
    google_cx: cfg.google_cx || '',   // CSE ID is not a secret
    brave_api_key: maskIfSet(cfg.brave_api_key),
  };
}
export function getThinkSettingsPayload() {
  try {
    const cfg = getConfig().getConfig() as any;
    const activeId = String(cfg.llm?.active_preset || '').trim();
    const preset = cfg.llm?.presets?.[activeId] || {};
    const t = preset.think;
    let enabled = false;
    let level: 'low' | 'medium' | 'high' = 'medium';
    if (t === true || t === 'high') { enabled = true; level = 'high'; }
    else if (t === 'medium') { enabled = true; level = 'medium'; }
    else if (t === 'low') { enabled = true; level = 'low'; }
    return { success: true, active_preset: activeId, enabled, level };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}


const CONFIG_DIR_PATH = getConfigDirPath();

export function registerSettingsRoutes(app: express.Express): void {
// ─── Provider / Model Settings API ───────────────────────────────────────────
// Used by the Settings → Models tab to read/write provider config and
// trigger the OpenAI OAuth flow.


function sanitizeLLMConfig(llm: any): any {
  if (!llm || typeof llm !== 'object') return llm;
  const copy = JSON.parse(JSON.stringify(llm));
  const codexModel = copy?.providers?.openai_codex?.model;
  if (typeof codexModel === 'string' && codexModel.trim() === 'codex-davinci-002') {
    copy.providers.openai_codex.model = 'gpt-4o';
  }
  return copy;
}

// HIGH-02 fix: redact all api_key / token fields before sending to the UI.
// Vault references ("vault:...") and env references ("env:...") are also masked
// so neither the vault key name nor the env var name leaks to the browser.
const SENSITIVE_KEY_PATTERNS = /api[_-]?key|apikey|token|secret|password|passwd|credential/i;

function redactConfigForUI(obj: any, depth = 0): any {
  if (depth > 8 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(v => redactConfigForUI(v, depth + 1));
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_PATTERNS.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = '••••••••';
    } else {
      out[k] = redactConfigForUI(v, depth + 1);
    }
  }
  return out;
}

// GET /api/settings/provider  — return active provider config (keys redacted)
app.get('/api/settings/provider', (_req, res) => {
  const raw = getConfig().getConfig() as any;
  const llmRaw = raw.llm || {
    provider: 'ollama',
    providers: { ollama: { endpoint: raw.ollama?.endpoint || 'http://localhost:11434', model: raw.models?.primary || 'qwen3:4b' } },
  };
  const llm = redactConfigForUI(sanitizeLLMConfig(llmRaw));
  res.json({ success: true, llm });
});

// POST /api/settings/provider  — update provider config
app.post('/api/settings/provider', (req, res) => {
  try {
    const llm = sanitizeLLMConfig(req.body?.llm);
    if (!llm?.provider) { res.status(400).json({ success: false, error: 'Missing llm.provider' }); return; }
    const configManager = getConfig();
    const current = (configManager.getConfig() as any)?.llm || {};
    // Merge with the current llm node and explicitly keep presets: the generic
    // settings panel does not manage model presets and must not clobber them
    // (config-level updateConfig also guards this).
    const merged = { ...current, ...llm, presets: current.presets };
    // Consistency: if the active preset's provider no longer matches the newly
    // saved provider, the user has manually diverged from the preset — clear
    // active_preset (switching via a preset restores both fields together).
    let activePreset = String(current.active_preset || '');
    if (activePreset) {
      const ap = current.presets?.[activePreset];
      if (!ap || ap.provider !== merged.provider) activePreset = '';
    }
    merged.active_preset = activePreset;
    configManager.updateConfig({ llm: merged } as any);
    resetProvider();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/models/test  — test connectivity for the active (or a given) provider
app.post('/api/models/test', async (req, res) => {
  try {
    const llmOverride = req.body?.llm ? sanitizeLLMConfig(req.body.llm) : null;
    const provider = llmOverride ? buildProviderForLLM(llmOverride) : getProvider();
    const ok = await provider.testConnection();
    const models = ok ? await provider.listModels() : [];
    res.json({ success: ok, models, error: ok ? undefined : 'Could not connect' });
  } catch (err: any) {
    res.json({ success: false, models: [], error: err.message });
  }
});

// ─── Model presets (multi-model switching) ──────────────────────────────────────

/** The masked value the UI shows for secrets — treated as "unchanged" on save. */
const PRESET_MASK = '••••••••';

function getPresetsState(): { llm: any; presets: Record<string, any>; active: string } {
  const cfg = getConfig().getConfig() as any;
  const llm = cfg.llm || {};
  return { llm, presets: llm.presets || {}, active: String(llm.active_preset || '') };
}

function presetSummary(preset: any, active: boolean): any {
  const prov = preset?.providers?.[preset?.provider] || {};
  const out: any = {
    id: preset?.id,
    name: preset?.name,
    provider: preset?.provider,
    model: String(prov?.model || ''),
    endpoint: String(prov?.endpoint || ''),
    active,
    builtin: !!preset?.builtin,
  };
  if (preset?.provider === 'llama_cpp' && preset?.server) {
    out.server = {
      model_path: preset.server.model_path,
      mmproj_path: preset.server.mmproj_path || '',
      alias: preset.server.alias || '',
      ngl: preset.server.ngl ?? 99,
      ctx_size: preset.server.ctx_size, // unset → model's native context (follows the model)
    };
  }
  return out;
}

/** Strip masked secrets so they never overwrite real keys on save. */
function sanitizePresetForSave(preset: any): any {
  const copy = JSON.parse(JSON.stringify(preset || {}));
  const prov = copy.providers?.[copy.provider];
  if (prov && typeof prov === 'object') {
    for (const k of Object.keys(prov)) {
      if (SENSITIVE_KEY_PATTERNS.test(k) && prov[k] === PRESET_MASK) delete prov[k];
    }
  }
  return copy;
}

// GET /api/models/presets — list all presets + the active one
app.get('/api/models/presets', (_req, res) => {
  const { presets, active } = getPresetsState();
  const list = Object.values(presets).map((p: any) => presetSummary(p, p?.id === active));
  res.json({ success: true, presets: list, active_preset: active });
});

// POST /api/models/presets — create or update a preset
app.post('/api/models/presets', (req, res) => {
  try {
    const raw = sanitizePresetForSave(req.body?.preset);
    if (!raw || typeof raw !== 'object') { res.status(400).json({ success: false, error: 'preset object required' }); return; }
    const id = String(raw.id || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
    if (!id) { res.status(400).json({ success: false, error: 'preset.id required (a-z0-9_-)' }); return; }
    if (!raw.name || !raw.provider) { res.status(400).json({ success: false, error: 'preset.name and preset.provider required' }); return; }

    const { llm } = getPresetsState();
    const presets = { ...(llm.presets || {}) };
    const existing = presets[id] || {};
    presets[id] = { ...existing, ...raw, id, builtin: !!existing.builtin }; // builtin flag preserved
    const updatedLlm = { ...llm, presets };
    getConfig().updateConfig({ llm: updatedLlm } as any);
    res.json({ success: true, preset: presetSummary(presets[id], id === llm.active_preset) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/models/presets/:id — remove a non-builtin, non-active preset
app.delete('/api/models/presets/:id', (req, res) => {
  try {
    const id = String(req.params?.id || '').trim();
    const { llm, presets, active } = getPresetsState();
    const target = presets[id];
    if (!target) { res.status(404).json({ success: false, error: 'Preset not found' }); return; }
    if (target.builtin) { res.status(400).json({ success: false, error: 'Built-in presets cannot be deleted' }); return; }
    if (id === active) { res.status(400).json({ success: false, error: 'Switch away from the active preset before deleting it' }); return; }
    const next = { ...presets };
    delete next[id];
    const updatedLlm = { ...llm, presets: next };
    getConfig().updateConfig({ llm: updatedLlm } as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/models/presets/switch — activate a preset (restarts llama-server if needed)
app.post('/api/models/presets/switch', async (req, res) => {
  const presetId = String(req.body?.preset_id || '').trim();
  const { llm, presets } = getPresetsState();
  const preset = presets[presetId];
  if (!preset) { res.status(404).json({ success: false, error: 'Preset not found' }); return; }

  try {
    // 1) Persist: switch provider + merge this preset's provider config (others untouched)
    const mergedProviders = { ...(llm.providers || {}) };
    for (const [k, v] of Object.entries(preset.providers || {})) {
      // Per-field merge: if the preset doesn't carry an api key, keep the one
      // already configured (vault ref or plaintext) instead of dropping it.
      const prev = mergedProviders[k] || {};
      mergedProviders[k] = Object.assign({}, prev, v);
    }
    const updatedLlm = { ...llm, provider: preset.provider, active_preset: presetId, providers: mergedProviders };
    // Sync models.primary — reactor uses it to detect small models (native
    // tool-call channel on/off). Use the preset's model name so the regex works.
    // Keep existing models.roles untouched (shallow merge would drop them).
    const cfgNow = getConfig().getConfig() as any;
    const primaryModel = String(preset.providers?.[preset.provider]?.model || preset.id || '');
    // Keep orchestration.secondary following the newly activated preset so the
    // advisor and the UI never show a stale hard-coded model.
    const orchNow = cfgNow.orchestration;
    const nextPatch: any = {
      llm: updatedLlm,
      models: { ...(cfgNow.models || {}), primary: primaryModel },
    };
    if (orchNow?.secondary) {
      nextPatch.orchestration = {
        ...orchNow,
        secondary: { provider: preset.provider, model: primaryModel },
      };
    }
    getConfig().updateConfig(nextPatch as any);
    resetProvider();

    // 2) llama.cpp presets need a server restart to load the new weights
    if (preset.provider === 'llama_cpp') {
      const endpoint = preset.providers?.llama_cpp?.endpoint || 'http://localhost:8080';
      const mgr = new LlamaServerManager(endpoint);
      const result = await mgr.switch(preset.server);
      res.json({ success: result.ok, preset_id: presetId, restart_ms: result.restartMs, error: result.ok ? undefined : 'llama-server did not become ready in time' });
      return;
    }

    res.json({ success: true, preset_id: presetId, restart_ms: 0 });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/openai/status  — is the user connected via OAuth?
app.get('/api/auth/openai/status', (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  const connected = isConnected(configDir);
  const tokens    = connected ? loadTokens(configDir) : null;
  res.json({ connected, account_id: tokens?.account_id || null, expires_at: tokens?.expires_at || null });
});

// POST /api/auth/openai/start  — kick off OAuth flow (opens browser)
app.post('/api/auth/openai/start', async (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  try {
    const result = await startOAuthFlow(configDir);
    if (result.needsManualPaste) {
      res.json({ success: false, needsManualPaste: true, authUrl: result.authUrl });
    } else {
      res.json(result);
    }
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/manual  — manual paste fallback token exchange
app.post('/api/auth/openai/manual', async (req, res) => {
  const configDir = CONFIG_DIR_PATH;
  const redirectedUrl = String(req.body?.url || '').trim();
  if (!redirectedUrl) {
    res.status(400).json({ success: false, error: 'Missing redirect URL' });
    return;
  }
  try {
    const result = await exchangeManualCodeFromPending(configDir, redirectedUrl);
    res.json(result);
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/auth/openai/disconnect  — revoke stored tokens
app.post('/api/auth/openai/disconnect', (_req, res) => {
  const configDir = CONFIG_DIR_PATH;
  clearTokens(configDir);
  res.json({ success: true });
});

// ─── Webhook Settings API ────────────────────────────────────────────────────

app.get('/api/settings/hooks', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).hooks || {};
  res.json({
    success: true,
    hooks: {
      enabled: cfg.enabled === true,
      token: cfg.token ? '••••••••' : '',           // never return the real token
      tokenSet: !!cfg.token,
      path: cfg.path || '/hooks',
    },
  });
});

app.post('/api/settings/hooks', (req, res) => {
  try {
    const { enabled, token, path: hookPath } = req.body || {};
    const current = (getConfig().getConfig() as any).hooks || {};
    const updated = {
      enabled: enabled === true,
      // If the user sent the masked placeholder, keep the existing token
      token: token && token !== '••••••••' ? String(token).trim() : (current.token || ''),
      path: hookPath ? String(hookPath).trim() : (current.path || '/hooks'),
    };
    getConfig().updateConfig({ hooks: updated } as any);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings/hooks/test', async (req, res) => {
  try {
    const cfg = (getConfig().getConfig() as any).hooks || {};
    if (!cfg.enabled) { res.json({ success: false, error: 'Webhooks are disabled' }); return; }
    if (!cfg.token)   { res.json({ success: false, error: 'No token configured' }); return; }
    res.json({ success: true, message: 'Webhook endpoint is active', path: cfg.path || '/hooks' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ─── Settings API ────────────────────────────────────────────────────────────────



app.get('/api/settings/search', (_req, res) => {
  res.json(getSearchSettingsPayload());
});

app.post('/api/settings/search', (req, res) => {
  const { preferred_provider, search_rigor, tavily_api_key, google_api_key, google_cx, brave_api_key } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  // Only write a key field if the user actually entered a new value.
  // '••••••••' means "leave existing vault entry alone".
  const isNew = (v: any) => v !== undefined && v !== '' && v !== '••••••••';
  const newSearch = {
    ...((current.search || {})),
    ...(preferred_provider !== undefined && { preferred_provider }),
    ...(search_rigor !== undefined && { search_rigor }),
    ...(isNew(tavily_api_key) && { tavily_api_key }),
    ...(isNew(google_api_key) && { google_api_key }),
    ...(google_cx !== undefined && { google_cx }),
    ...(isNew(brave_api_key) && { brave_api_key }),
  };
  cm.updateConfig({ search: newSearch } as any);
  // migrateSecretsToVault() runs inside updateConfig → saveConfig, so any
  // plaintext key just entered is automatically encrypted and replaced with
  // a "vault:<key>" reference before hitting disk.
  res.json({ success: true });
});

// GET /api/credentials/status — list which vault keys are currently stored (names only, no values)
app.get('/api/credentials/status', (_req, res) => {
  try {
    const vault = getVault();
    res.json({ success: true, keys: vault.keys() });
  } catch (err: any) {
    res.json({ success: false, keys: [], error: err.message });
  }
});

// GET /api/credentials/audit — return last N lines of vault-audit.log (scrubbed)
app.get('/api/credentials/audit', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  try {
    const auditPath = path.join(process.cwd(), '.smallclaw', 'vault', 'vault-audit.log');
    if (!fs.existsSync(auditPath)) { res.json({ success: true, lines: [] }); return; }
    const raw = fs.readFileSync(auditPath, 'utf-8');
    const lines = raw.split('\n').filter((l: string) => l.trim());
    res.json({ success: true, lines: lines.slice(-40) });
  } catch (err: any) {
    res.json({ success: false, lines: [], error: err.message });
  }
});

app.get('/api/settings/paths', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    workspace_path: (cfg as any).workspace?.path || '',
    allowed_paths: (cfg as any).tools?.permissions?.files?.allowed_paths || [],
    blocked_paths: (cfg as any).tools?.permissions?.files?.blocked_paths || [],
  });
});

app.post('/api/settings/paths', (req, res) => {
  const { workspace_path, allowed_paths, blocked_paths } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const tools = {
    ...current.tools,
    permissions: {
      ...current.tools?.permissions,
      files: {
        ...(current.tools?.permissions?.files || {}),
        ...(Array.isArray(allowed_paths) && { allowed_paths }),
        ...(Array.isArray(blocked_paths) && { blocked_paths }),
      },
    },
  };
  const workspacePath = typeof workspace_path === 'string' ? workspace_path.trim() : '';
  if (workspacePath) {
    try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
  }
  cm.updateConfig({
    tools,
    ...(workspacePath ? { workspace: { ...(current.workspace || {}), path: workspacePath } } : {}),
  } as any);
  res.json({ success: true });
});

app.get('/api/settings/agent', (_req, res) => {
  const cfg = (getConfig().getConfig() as any).agent_policy || {};
  res.json({
    force_web_for_fresh: cfg.force_web_for_fresh !== false,
    memory_fallback_on_search_failure: cfg.memory_fallback_on_search_failure !== false,
    auto_store_web_facts: cfg.auto_store_web_facts !== false,
    natural_language_tool_router: cfg.natural_language_tool_router !== false,
    retrieval_mode: cfg.retrieval_mode || 'standard',
  });
});

app.post('/api/settings/agent', (req, res) => {
  const { force_web_for_fresh, memory_fallback_on_search_failure, auto_store_web_facts, natural_language_tool_router, retrieval_mode } = req.body;
  const cm = getConfig();
  const current = cm.getConfig() as any;
  const newPolicy = {
    ...(current.agent_policy || {}),
    ...(force_web_for_fresh !== undefined && { force_web_for_fresh }),
    ...(memory_fallback_on_search_failure !== undefined && { memory_fallback_on_search_failure }),
    ...(auto_store_web_facts !== undefined && { auto_store_web_facts }),
    ...(natural_language_tool_router !== undefined && { natural_language_tool_router }),
    ...(retrieval_mode !== undefined && { retrieval_mode }),
  };
  cm.updateConfig({ agent_policy: newPolicy } as any);
  res.json({ success: true });
});

// ─── Model / Ollama Settings API ──────────────────────────────────────────────────

app.get('/api/settings/model', (_req, res) => {
  const cfg = getConfig().getConfig();
  res.json({
    primary: cfg.models.primary,
    roles: cfg.models.roles,
    ollama_endpoint: (cfg as any).ollama?.endpoint || 'http://localhost:11434',
  });
});

app.post('/api/settings/model', (req, res) => {
  const { primary, roles, ollama_endpoint } = req.body;
  const cm = getConfig();
  const current = cm.getConfig();
  if (primary || roles) {
    cm.updateConfig({
      models: {
        primary: primary || current.models.primary,
        roles: { ...current.models.roles, ...(roles || {}) },
      }
    });
  }
  if (ollama_endpoint) {
    cm.updateConfig({
      ollama: { ...(current as any).ollama, endpoint: ollama_endpoint }
    } as any);
  }
  res.json({ success: true, model: getConfig().getConfig().models.primary });
});

// GET /api/settings/think — active model preset's thinking (think) config


app.get('/api/settings/think', (_req, res) => {
  res.json(getThinkSettingsPayload());
});

// POST /api/settings/think — set think for the active preset (takes effect
// immediately: handleChat reads the preset's think on every turn).
app.post('/api/settings/think', (req, res) => {
  try {
    const { enabled, level } = req.body || {};
    const cm = getConfig();
    const cfg = cm.getConfig() as any;
    const activeId = String(cfg.llm?.active_preset || '').trim();
    if (!activeId) { res.json({ success: false, error: 'no active preset' }); return; }
    const presets = { ...(cfg.llm?.presets || {}) };
    const preset = { ...(presets[activeId] || {}) };
    if (enabled) {
      const lvl = level === 'low' || level === 'high' ? level : 'medium';
      preset.think = lvl;
    } else {
      preset.think = false;
    }
    presets[activeId] = preset;
    cm.updateConfig({ llm: { ...(cfg.llm || {}), presets } } as any);
    res.json({ success: true, active_preset: activeId, enabled: !!enabled, level: enabled ? (preset.think || 'medium') : false });
  } catch (err: any) {
    res.json({ success: false, error: err?.message || String(err) });
  }
});
}
