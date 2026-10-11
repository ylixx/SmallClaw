/**
 * Phase 0 safety net — gateway BOOT smoke test (OPT-IN, gated by SMALLCLAW_SMOKE=1).
 *
 * This is the "real" end-to-end canary: it spawns the actual gateway entry point
 * as a SEPARATE process (never imported into vitest — see server-v2-integrity.test.ts
 * for why importing it is unsafe), waits for it to serve `/api/status`, asserts a
 * 200, then tears the process tree DOWN.
 *
 * It is DISABLED by default (describe.skipIf) so `npm test` never starts a server
 * and never disturbs the existing suite. Run it explicitly when you want the full
 * boot check during a refactor:
 *
 *     SMALLCLAW_SMOKE=1 npm test
 *   or
 *     npm run smoke
 *
 * It ALSO locks the /api/tools tool list (see the second `it` below) so that the
 * Phase 2 extraction of the tool-registry cannot silently drop/rename tools.
 *
 * PORT DETECTION: server-v2.ts resolves its listen port as
 * `config.gateway.port || process.env.GATEWAY_PORT`, and the shipped config pins
 * `gateway.port` — so an env override is ignored. We therefore DO NOT pick a port;
 * instead we let the gateway bind per config and read the ACTUAL port from its own
 * startup log line ("Web UI: http://127.0.0.1:<port>"), then probe that port.
 *
 * TEARDOWN IS CRITICAL: tsx spawns a child node process, so killing only the tsx
 * parent leaves the server alive (port still LISTENING). We kill by process tree
 * (taskkill /T) AND by port (netstat) as a fallback, so no process is left behind.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const SMOKE = process.env.SMALLCLAW_SMOKE === '1';

function killTree(pid: number): void {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true });
  } catch {
    /* best effort */
  }
}

function killByPort(port: number): void {
  try {
    const out = execFileSync('netstat', ['-ano'], { windowsHide: true }).toString();
    const pids = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.includes(`:${port}`) && /LISTENING/.test(line)) {
        const p = line.trim().split(/\s+/).pop();
        if (p && /^\d+$/.test(p)) pids.add(p);
      }
    }
    for (const p of pids) {
      try {
        execFileSync('taskkill', ['/PID', p, '/F', '/T'], { windowsHide: true });
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* best effort */
  }
}

function detectBoundPort(logPath: string): number {
  try {
    const txt = fs.readFileSync(logPath, 'utf-8');
    const m = txt.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return parseInt(m[1], 10);
  } catch {
    /* not yet */
  }
  // Fallback: read the configured port.
  try {
    const cfg = JSON.parse(fs.readFileSync('.smallclaw/config.json', 'utf-8'));
    if (cfg?.gateway?.port) return cfg.gateway.port;
  } catch {
    /* ignore */
  }
  return 18789;
}

describe.skipIf(!SMOKE)('gateway boot smoke (opt-in: SMALLCLAW_SMOKE=1)', () => {
  let child: ReturnType<typeof spawn> | null = null;
  let port = 0;
  const logPath = path.resolve('logs/smoke-gateway.log');

  beforeAll(async () => {
    if (fs.existsSync(logPath)) fs.rmSync(logPath);
    const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
    const serverEntry = path.resolve('src/gateway/server-v2.ts');

    child = spawn(process.execPath, [tsxCli, serverEntry], {
      shell: false,
      // DO NOT set GATEWAY_PORT — config pins gateway.port and overrides env.
      env: { ...process.env, GATEWAY_HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => fs.appendFileSync(logPath, d));
    child.stderr?.on('data', (d) => fs.appendFileSync(logPath, d));

    // 1) Wait for the gateway to announce its bound port in the startup log.
    const portDeadline = Date.now() + 30_000;
    while (Date.now() < portDeadline) {
      port = detectBoundPort(logPath);
      if (port) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!port) port = 18789; // final fallback

    // 2) Wait for /api/status to return 200.
    const readyDeadline = Date.now() + 60_000;
    while (Date.now() < readyDeadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/status`);
        if (r.status === 200) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`gateway did not become ready on port ${port} within 60s (see ${logPath})`);
  }, 100_000);

  it('serves GET /api/status with HTTP 200', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('exposes the expected tool list via GET /api/tools (Phase 2 lock)', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/tools`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    // Core unconditional file tools must ALWAYS be present — an extraction bug that
    // drops them would break every downstream file operation.
    for (const name of ['read_file', 'list_files', 'grep_content', 'create_file']) {
      expect(body.tools, `missing core tool: ${name}`).toContain(name);
    }
    // Byte-level lock: snapshot the tool-name list so any accidental drop/rename
    // during the tool-registry extraction fails the comparison.
    expect(body.tools).toMatchSnapshot();
  });

  afterAll(() => {
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      killTree(child.pid ?? 0);
    }
    // Fallback: kill anything still bound to the port so nothing lingers.
    killByPort(port);
  });
});
