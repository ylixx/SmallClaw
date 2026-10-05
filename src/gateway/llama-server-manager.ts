/**
 * llama-server-manager.ts
 *
 * Switches the local llama.cpp backend between model presets.
 *
 * llama-server is a single-process, single-model server: switching models
 * means killing the process on the endpoint port and starting a new one with
 * the preset's launch parameters (model path, mmproj, ctx, offload...).
 * Model load takes ~30-60s for a 4-30B quantized GGUF; the caller should
 * surface this wait to the user.
 *
 * Only used when a preset's provider is 'llama_cpp'. Ollama / LM Studio /
 * OpenAI providers are switched by config + resetProvider() alone.
 */

import { spawn } from 'child_process';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import type { ModelPresetServer } from '../types';

const execAsync = promisify(exec);

function parsePort(endpoint: string): number {
  try {
    const u = new URL(String(endpoint || '').replace(/\/$/, ''));
    return Number(u.port) || 8080;
  } catch {
    const m = String(endpoint || '').match(/:(\d+)\/?$/);
    return m ? Number(m[1]) || 8080 : 8080;
  }
}

function log(...args: any[]): void {
  console.log('[LlamaServerManager]', ...args);
}

export class LlamaServerManager {
  private endpoint: string;
  private port: number;
  private readyTimeoutMs: number;

  constructor(endpoint: string, readyTimeoutMs = 150000) {
    this.endpoint = String(endpoint || 'http://localhost:8080').replace(/\/$/, '');
    this.port = parsePort(this.endpoint);
    this.readyTimeoutMs = readyTimeoutMs;
  }

  /** Is something answering /health on the endpoint right now? */
  async isAlive(): Promise<boolean> {
    try {
      const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Find the PID listening on our port (Windows netstat). */
  private async findPidOnPort(): Promise<number | null> {
    try {
      const { stdout } = await execAsync('netstat -ano');
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.trim().match(/TCP\s+[\d.]+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m && Number(m[1]) === this.port) return Number(m[2]);
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Stop whatever is listening on the port. Prefers an exact PID lookup so we
   * do not accidentally kill an unrelated llama-server.exe (e.g. Ollama's
   * runner process).
   */
  async kill(): Promise<boolean> {
    if (!(await this.isAlive()) && (await this.findPidOnPort()) === null) {
      log('Nothing running on port', this.port, '— nothing to kill.');
      return true;
    }
    const pid = await this.findPidOnPort();
    if (pid) {
      log(`Killing PID ${pid} on port ${this.port}...`);
      await execAsync(`taskkill /F /PID ${pid} /T`).catch(() => {});
    } else {
      log(`No PID found on port ${this.port}; falling back to taskkill llama-server.exe`);
      await execAsync('taskkill /F /IM llama-server.exe /T').catch(() => {});
    }
    // Wait for the port to go dark (max 10s)
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if ((await this.findPidOnPort()) === null && !(await this.isAlive())) {
        log('Port cleared.');
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    log('WARN: port did not clear within 10s.');
    return false;
  }

  /**
   * Start llama-server detached with the preset's parameters.
   * stdout/stderr are appended to logs/llama-server.log.
   */
  async start(server: ModelPresetServer): Promise<void> {
    const modelPath = String(server.model_path || '').trim();
    if (!modelPath) throw new Error('preset.server.model_path is required for llama_cpp presets');
    if (!fs.existsSync(modelPath)) throw new Error(`Model file not found: ${modelPath}`);
    if (server.mmproj_path && !fs.existsSync(server.mmproj_path)) {
      log('WARN: mmproj not found, continuing WITHOUT image support:', server.mmproj_path);
    }

    const args: string[] = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '-ngl', String(server.ngl ?? 99),
      '--ctx-size', String(server.ctx_size ?? 49152),
      '--cache-type-k', 'q8_0',
      '--cache-type-v', 'q8_0',
      '--reasoning', 'off', // REQUIRED for Qwen3: otherwise it emits only thinking
    ];
    if (server.mmproj_path) args.push('--mmproj', server.mmproj_path);
    if (server.alias) args.push('--alias', server.alias);

    // Logs land next to the gateway logs.
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = fs.openSync(path.join(logDir, 'llama-server.log'), 'a');

    log('Starting llama-server:', args.join(' '));
    const child = spawn('llama-server', args, {
      detached: true,
      stdio: ['ignore', logFile, logFile],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(logFile);
  }

  /** Wait until /health responds (model fully loaded). */
  async waitReady(timeoutMs?: number): Promise<boolean> {
    const deadline = Date.now() + (timeoutMs ?? this.readyTimeoutMs);
    let lastErr = '';
    while (Date.now() < deadline) {
      if (await this.isAlive()) return true;
      lastErr = `not ready after ${Date.now() > deadline - 5000 ? 'almost timeout' : 'waiting'}`;
      await new Promise(r => setTimeout(r, 2000));
    }
    log('WARN: llama-server did not become ready in time.');
    void lastErr;
    return false;
  }

  /** Full switch: kill current server, start the preset's, wait until ready. */
  async switch(server: ModelPresetServer): Promise<{ ok: boolean; restartMs: number }> {
    const t0 = Date.now();
    if (await this.isAlive()) {
      log('Current llama-server is up — killing it first.');
      await this.kill();
    }
    try {
      await this.start(server);
    } catch (err: any) {
      log('ERROR starting llama-server:', err?.message || err);
      return { ok: false, restartMs: Date.now() - t0 };
    }
    const ready = await this.waitReady();
    log(ready ? 'Switch OK.' : 'Switch FAILED — server not ready.');
    return { ok: ready, restartMs: Date.now() - t0 };
  }
}
