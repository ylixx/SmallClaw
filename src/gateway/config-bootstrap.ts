/**
 * config-bootstrap.ts — 网关启动期配置引导（从 server-v2.ts 抽出，Phase 1）
 *
 * 职责：
 *  - cwd 规范化（保证从任意目录启动时 ~20 个调用点仍能解析到项目根）
 *  - 配置加载、workspace.path 合法性校验
 *  - 配置目录推导、端口/主机推导
 *  - 遗留 telegram 任务元数据修复
 *
 * 设计约束（见拆分方案 §5）：
 *  - 仅依赖叶子模块，不反向 import server-v2.ts，避免循环依赖。
 *  - 不包含任何业务状态；本模块的函数均为启动期一次性副作用或纯计算。
 */

import path from 'path';
import fs from 'fs';
import { getConfig } from '../config/config';
import { listTasks, saveTask } from './task-store';

// Deployment hardening: the gateway may be launched from any directory
// (service manager, launcher script, another machine). Derive the project root
// from __dirname and normalize process.cwd() to it, so the ~20 call sites that
// assume cwd == project root (soul-loader, session, task-store, skills, vault,
// scheduler, ...) keep resolving correctly regardless of where it was launched.
export const PROJECT_ROOT = path.join(__dirname, '..', '..');

export function normalizeCwd(): void {
  try {
    if (path.resolve(process.cwd()) !== path.resolve(PROJECT_ROOT)) {
      const before = process.cwd();
      process.chdir(PROJECT_ROOT);
      console.log(`[v2] normalized cwd: ${before} -> ${PROJECT_ROOT}`);
    }
  } catch (err: any) {
    console.warn(`[v2] failed to normalize cwd: ${err?.message || err}`);
  }
}

export function validateWorkspacePath(config: any): void {
  // Deployment check: if workspace.path points at a location whose parent dir
  // does not exist, the config.json was most likely copied from another machine
  // (absolute path baked in). Warn loudly so it can be fixed on first boot.
  const ws = String((config as any)?.workspace?.path || '').trim();
  if (ws) {
    const parent = path.dirname(ws);
    if (!fs.existsSync(parent)) {
      console.warn(`[v2] WARNING: workspace.path 的父目录不存在: "${parent}"`);
      console.warn(`[v2] WARNING: 产物将写入无效位置。请检查 .smallclaw/config.json 的 workspace.path（可能来自其他机器），或设置环境变量 SMALLCLAW_WORKSPACE_DIR 指向本机工作区。当前 workspace.path=${ws}`);
    }
  }
}

export function getConfigDirPath(): string {
  return getConfig().getConfigDir();
}

export function derivePort(config: any): number {
  return config.gateway.port || (process.env.GATEWAY_PORT ? parseInt(process.env.GATEWAY_PORT, 10) : 18789);
}

export function deriveHost(config: any): string {
  return config.gateway.host || process.env.GATEWAY_HOST || (process.env.DOCKER_CONTAINER ? '0.0.0.0' : '127.0.0.1');
}

export function repairLegacyTaskChannelMetadata(): void {
  try {
    const tasks = listTasks();
    let repaired = 0;
    for (const task of tasks) {
      if (!String(task.sessionId || '').startsWith('telegram_')) continue;
      if (task.channel === 'telegram' && task.telegramChatId) continue;
      task.channel = 'telegram';
      if (!task.telegramChatId) {
        const parsed = Number(String(task.sessionId || '').replace(/^telegram_/, ''));
        if (Number.isFinite(parsed) && parsed > 0) task.telegramChatId = parsed;
      }
      saveTask(task);
      repaired++;
    }
    if (repaired > 0) {
      console.log(`[TaskStore] Repaired ${repaired} legacy task(s) with telegram metadata.`);
    }
  } catch (err: any) {
    console.warn('[TaskStore] Legacy task metadata repair skipped:', err?.message || err);
  }
}
