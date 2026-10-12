/** server-bootstrap.ts — gateway server lifecycle (http/ws + listen + startup
 * actions + graceful shutdown), extracted from server-v2.ts (Phase 5d-20).
 * Composition-root closures are injected via deps; module-level imports stay
 * here. server.listen runs only inside start(), so vitest importing this
 * module does not bind a port. */
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { getConfig } from '../config/config';
import { setWss, closeWss } from './realtime';
import { setupErrorResponseEndpoint } from './error-response-endpoint-integrated';
import { initCredentialHandler } from '../security/credential-handler';
import { getVerificationFlowManager } from './verification-flow';
import { getErrorAnalyzer } from './error-analyzer';
import { getErrorHistory } from './error-history';
import { getRetryStrategy } from './retry-strategy';
import { getVisualErrorDetector } from './visual-error-detection';
import { getErrorAudit } from '../security/error-audit';
import { getContextInjectionManager } from './context-injection';
import { getMCPManager } from './mcp-manager';
import { logGpuStatus } from './gpu-detector';
import { initializeAgentSchedules, stopAgentSchedules } from '../scheduler';
import { loadWorkspaceHooks } from './hook-loader';
import { hookBus } from './hooks';
import { ensureOfficeCapabilities } from '../tools/office';

export interface ServerLifecycleDeps {
  app: any;
  host: string;
  port: number;
  configDirPath: string;
  skillsManager: { getAll(): any[]; getEnabledSkills(): any[]; persistState(): void };
  cronScheduler: { start(): void; stop(): void; getConfig(): { enabled?: boolean } };
  telegramChannel: { start(): Promise<any>; stop(): void; sendToAllowed(text: string): Promise<any> };
  heartbeatRunner: { start(): void; stop(): void; getConfig(): { intervalMinutes: number } };
  scheduleTaskHeartbeat: () => void;
  loadTaskHeartbeatConfig: () => { interval_minutes: number };
}

export function createServerLifecycle(deps: ServerLifecycleDeps): { server: http.Server; shutdown: (signal: 'SIGINT' | 'SIGTERM') => void } {
// ─── Server ────────────────────────────────────────────────────────────────────

const server = http.createServer(deps.app);
const wsServer = new WebSocketServer({ server, path: '/ws' });
setWss(wsServer);
wsServer.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${deps.host}:${deps.port} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] WebSocket error:', err?.message || err);
  process.exit(1);
});
wsServer.on('connection', (ws: WebSocket) => {
  console.log('[v2] WS connected');
  ws.on('message', (d) => { try { JSON.parse(d.toString()); } catch {} });
  ws.on('close', () => console.log('[v2] WS disconnected'));
});

server.on('error', (err: any) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`[Gateway] Port ${deps.host}:${deps.port} is already in use.`);
    console.error('[Gateway] Another gateway instance is likely already running.');
    console.error('[Gateway] Use one instance only, then open http://127.0.0.1:18789');
    process.exit(1);
    return;
  }
  console.error('[Gateway] HTTP server error:', err?.message || err);
  process.exit(1);
});

// Setup error response endpoint
setupErrorResponseEndpoint(deps.app);

// ─── Initialize Advanced Error Response Systems ────────────────────────────────
const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const credentialHandler = initCredentialHandler(encryptionKey);
const verificationFlowManager = getVerificationFlowManager();
const errorAnalyzer = getErrorAnalyzer();
const errorHistory = getErrorHistory();
const retryStrategy = getRetryStrategy();
const visualErrorDetector = getVisualErrorDetector();
const errorAudit = getErrorAudit(process.env.ERROR_AUDIT_LOG_PATH || path.join(deps.configDirPath, 'logs', 'audit.log'));
const contextInjectionManager = getContextInjectionManager();

console.log('[Server] ✅ Advanced error response systems initialized');
console.log(`[Server] - Credential Handler: ${encryptionKey.substring(0, 8)}...`);
console.log('[Server] - Verification Flow Manager: Ready');
console.log('[Server] - Error Analyzer: Ready');
console.log('[Server] - Error History: Ready');
console.log('[Server] - Retry Strategy: Ready');
console.log('[Server] - Visual Error Detector: Ready');
console.log('[Server] - Error Audit: Ready');
console.log('[Server] - Context Injection Manager: Ready');

server.listen(deps.port, deps.host, () => {
  // Detect GPU hardware once — logs a single clean line, caches result for
  // the lifetime of the process (used by /api/system-stats, no repeated probes).
  logGpuStatus();

  const liveConfig = getConfig().getConfig();
  const searchCfg = (liveConfig as any).search || {};
  // HIGH-03: resolve vault references before checking presence — never log the key value itself
  const cm = getConfig();
  const tavilyKey = cm.resolveSecret(searchCfg.tavily_api_key);
  const googleKey = cm.resolveSecret(searchCfg.google_api_key);
  const hasSearch = tavilyKey ? '✓ Tavily' : googleKey ? '✓ Google' : '✗ None (configure in Settings → Search)';
  console.log(`
╔════════════════════════════════════════════════════════════════╗
║              SmallClaw v2 Gateway (Native Tools)              ║
╠════════════════════════════════════════════════════════════════╣
║  Tasks:   Cron scheduler active, jobs at .smallclaw/cron/     ║
║  Skills: ${String(deps.skillsManager.getAll().length + ' loaded, ' + deps.skillsManager.getEnabledSkills().length + ' enabled').padEnd(49)}║
║  Search:  ${hasSearch.padEnd(49)}║
║  Memory:  SOUL.md + IDENTITY.md + USER.md + MEMORY.md         ║
║                                                               ║
║  Web UI:    http://${deps.host}:${deps.port}                            ║
║  Model:     ${liveConfig.models.primary.padEnd(45)}║
║  Workspace: ${liveConfig.workspace.path.slice(0, 43).padEnd(45)}║
╚════════════════════════════════════════════════════════════════╝
`);
  // Auto-connect enabled MCP servers
  getMCPManager().startEnabledServers().catch(err => console.warn('[MCP] Startup error:', err?.message));

  // Probe the Office helper (Python) in the background so doc_* tools appear
  // in buildTools() as soon as capabilities are known.
  ensureOfficeCapabilities();

  deps.cronScheduler.start();
  console.log('[CronScheduler] Tick loop started — heartbeat:', deps.cronScheduler.getConfig().enabled ? 'ON' : 'OFF');
  initializeAgentSchedules();
  console.log('[Scheduler] Agent cron schedules initialized.');
  deps.heartbeatRunner.start();
  console.log('[HeartbeatRunner] Started — interval:', deps.heartbeatRunner.getConfig().intervalMinutes, 'min');
  deps.telegramChannel.start().then(() => {
    // Check if we just restarted after a self-update
    const selfUpdateStatusFile = path.join(require('os').homedir(), '.smallclaw', 'last_self_update.txt');
    if (fs.existsSync(selfUpdateStatusFile)) {
      try {
        const statusContent = fs.readFileSync(selfUpdateStatusFile, 'utf-8').trim();
        fs.unlinkSync(selfUpdateStatusFile); // consume it — only notify once
        if (statusContent.startsWith('UPDATE_SUCCESS')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `✅ SmallClaw self-update complete!\n\nI ran the update, rebuilt, and have restarted the gateway. I'm back online and up to date.\n\n🕐 Updated at: ${timestamp.trim()}`;
          setTimeout(() => deps.telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update Telegram notification queued.');
        } else if (statusContent.startsWith('UPDATE_FAILED')) {
          const lines = statusContent.split('\n');
          const timestamp = lines[1] || '';
          const msg = `❌ SmallClaw self-update failed.\n\nThe update process encountered an error. Gateway has restarted with the previous version. Check the terminal for details.\n\n🕐 Attempted at: ${timestamp.trim()}`;
          setTimeout(() => deps.telegramChannel.sendToAllowed(msg).catch(() => {}), 3000);
          console.log('[Gateway] Post-update failure Telegram notification queued.');
        }
      } catch (e: any) {
        console.warn('[Gateway] Could not read self-update status file:', e.message);
      }
    }
  }).catch(err => console.error('[Telegram] Start failed:', err.message));
  deps.scheduleTaskHeartbeat();
  console.log('[TaskHeartbeat] Scheduled — interval:', deps.loadTaskHeartbeatConfig().interval_minutes, 'min');

  const bootWorkspace = getConfig().getWorkspacePath() || (getConfig().getConfig() as any).workspace?.path || '';
  if (bootWorkspace) {
    loadWorkspaceHooks(bootWorkspace);
    hookBus
      .fire({ type: 'gateway:startup', workspacePath: bootWorkspace })
      .catch((err: any) => console.warn('[hooks] gateway:startup error:', err?.message || err));
  }
});

let shuttingDown = false;
function gracefulShutdown(signal: 'SIGINT' | 'SIGTERM'): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[Gateway] Shutting down error response systems...');
  try { credentialHandler.stop(); console.log('[Gateway] ✅ Credential handler stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  try { verificationFlowManager.stop(); console.log('[Gateway] ✅ Verification flow stopped'); } catch (e) { console.error('[Gateway] Error:', e); }
  console.log(`[Gateway] Received ${signal}; shutting down...`);
  try { deps.skillsManager.persistState(); } catch {}
  try { deps.telegramChannel.stop(); } catch {}
  try { getMCPManager().disconnectAll(); } catch {}
  try { deps.cronScheduler.stop(); } catch {}
  try { stopAgentSchedules(); } catch {}
  try { deps.heartbeatRunner.stop(); } catch {}
  try { closeWss(); } catch {}
  try {
    server.close(() => process.exit(0));
    const forceExitTimer = setTimeout(() => process.exit(0), 1200) as any;
    if (typeof forceExitTimer?.unref === 'function') forceExitTimer.unref();
  } catch {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  return { server, shutdown: gracefulShutdown };
}
