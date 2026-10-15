import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import fsSync from 'fs';
import { getAgentById, ensureAgentWorkspace } from '../config/config.js';
import { getOllamaClient } from './ollama-client.js';
import { Reactor } from './reactor.js';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  const out = await execFileAsync('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 } as any);
  return { stdout: String((out as any)?.stdout || ''), stderr: String((out as any)?.stderr || '') };
}

/**
 * Create an isolated git worktree for a sub-agent (fork).
 * Returns the worktree path + branch so file changes are isolated and mergeable.
 * If the agent workspace is not inside a git repo, returns ok:false.
 */
export async function createForkWorktree(
  agentWorkspace: string,
  agentId: string,
): Promise<{ ok: true; worktreePath: string; branch: string; repoRoot: string } | { ok: false; error: string }> {
  try {
    const { stdout: repoRootRaw } = await git(['rev-parse', '--show-toplevel'], agentWorkspace);
    const repoRoot = repoRootRaw.trim();
    if (!repoRoot) {
      return { ok: false, error: 'fork 需要 git 仓库：agent workspace 不在任何 git repo 内（可 git init 后重试，或不加 fork）' };
    }
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const branch = `spawn/${agentId}-${stamp}`;
    const worktreePath = path.join(os.tmpdir(), `smallclaw-fork-${agentId}-${stamp}`);
    await git(['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], repoRoot);
    if (!fsSync.existsSync(worktreePath)) {
      return { ok: false, error: 'git worktree 创建后目录不存在' };
    }
    return { ok: true, worktreePath, branch, repoRoot };
  } catch (err: any) {
    return { ok: false, error: `创建 fork worktree 失败: ${String(err?.stderr || err?.message || err).slice(0, 200)}` };
  }
}

/** Remove a fork worktree and its branch (best-effort, used on failure/cleanup). */
export async function removeForkWorktree(
  worktreePath: string,
  repoRoot: string,
  branch?: string,
): Promise<void> {
  try { await git(['worktree', 'remove', '--force', worktreePath], repoRoot); } catch { /* ignore */ }
  if (branch) {
    try { await git(['branch', '-D', branch], repoRoot); } catch { /* ignore */ }
  }
}

export interface SpawnOptions {
  /** ID of the agent to run */
  agentId: string;
  /** The task/mission to give the agent */
  task: string;
  /** Timeout in ms. Default: 120000 (2 min) */
  timeoutMs?: number;
  /** Max reactor steps. Overrides agent.maxSteps */
  maxSteps?: number;
  /** Extra context injected into the task prompt */
  context?: string;
  /** Called on each reactor step (for streaming to UI) */
  onStep?: (step: any) => void;
  /** Restrict the named tools this sub-agent may see + call (narrowed scope). */
  allowedTools?: string[];
  /** Isolate the sub-agent's file changes in a throwaway git worktree. */
  fork?: boolean;
}

export interface SpawnResult {
  agentId: string;
  agentName: string;
  success: boolean;
  result: string;
  error?: string;
  durationMs: number;
  stepCount?: number;
  /** Present when fork isolation was used. */
  fork?: { worktreePath: string; branch: string; mergeHint: string };
}

/**
 * Spawns a sub-agent run in isolation.
 *
 * - Loads the agent definition from config
 * - Resolves + ensures the agent's workspace exists
 * - Builds a Reactor with the agent's workspace as context
 * - Runs the task with minimal prompt mode (unless agent.minimalPrompt=false)
 * - Returns the result
 *
 * The parent agent's session history is NOT shared with the sub-agent.
 * The sub-agent writes any outputs to its own workspace.
 */
export async function spawnAgent(options: SpawnOptions): Promise<SpawnResult> {
  const startMs = Date.now();
  const agent = getAgentById(options.agentId);

  if (!agent) {
    return {
      agentId: options.agentId,
      agentName: options.agentId,
      success: false,
      result: '',
      error: `Agent "${options.agentId}" not found in config. Check your agents array.`,
      durationMs: Date.now() - startMs,
    };
  }

  const baseWorkspace = ensureAgentWorkspace(agent);
  const maxSteps = options.maxSteps ?? agent.maxSteps ?? 8;
  const promptMode = agent.minimalPrompt === false ? 'full' : 'minimal';

  // Fork isolation: run in a throwaway git worktree so file changes are isolated.
  let workspacePath = baseWorkspace;
  let forkInfo: { worktreePath: string; branch: string; repoRoot: string } | null = null;
  if (options.fork === true) {
    const fk = await createForkWorktree(baseWorkspace, agent.id);
    if (!fk.ok) {
      return {
        agentId: agent.id,
        agentName: agent.name,
        success: false,
        result: '',
        error: fk.error,
        durationMs: Date.now() - startMs,
      };
    }
    forkInfo = { worktreePath: fk.worktreePath, branch: fk.branch, repoRoot: fk.repoRoot };
    workspacePath = fk.worktreePath;
  }

  // Build the task message - include context if provided
  const taskMessage = options.context
    ? `${options.task}\n\n[Context from orchestrator]\n${options.context}`
    : options.task;

  // Build the reactor with the agent's model (if overridden)
  // For now we use the global ollama client - model override via env or
  // a future per-agent reactor config.
  const ollama = getOllamaClient();
  const reactor = new Reactor(ollama, maxSteps);

  let stepCount = 0;
  const timeoutMs = options.timeoutMs ?? 120000;

  try {
    const resultText = await Promise.race<string>([
      reactor.run(taskMessage, {
        role: 'executor',
        promptMode,
        workspacePath, // each agent gets its own (optionally forked) workspace
        maxSteps,
        allowedTools: options.allowedTools,
        onStep: (step) => {
          stepCount++;
          options.onStep?.(step);
        },
      }),
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error(`Sub-agent timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);

    return {
      agentId: agent.id,
      agentName: agent.name,
      success: true,
      result: resultText,
      durationMs: Date.now() - startMs,
      stepCount,
      fork: forkInfo
        ? {
            worktreePath: forkInfo.worktreePath,
            branch: forkInfo.branch,
            mergeHint: `改动在独立 worktree：${forkInfo.worktreePath}（分支 ${forkInfo.branch}）。审阅后合并：git -C "${forkInfo.repoRoot}" merge ${forkInfo.branch}；丢弃：git worktree remove --force "${forkInfo.worktreePath}" && git branch -D ${forkInfo.branch}`,
          }
        : undefined,
    };
  } catch (err: any) {
    // On failure, clean up the throwaway worktree so it doesn't leak.
    if (forkInfo) {
      await removeForkWorktree(forkInfo.worktreePath, forkInfo.repoRoot, forkInfo.branch);
    }
    return {
      agentId: agent.id,
      agentName: agent.name,
      success: false,
      result: '',
      error: String(err?.message ?? err),
      durationMs: Date.now() - startMs,
      stepCount,
    };
  }
}

/**
 * Spawns multiple agents in parallel and waits for all results.
 * Use this when tasks are independent (research + write simultaneously).
 */
export async function spawnAgentsParallel(
  tasks: Array<Omit<SpawnOptions, 'onStep'>>,
  onResult?: (result: SpawnResult) => void,
): Promise<SpawnResult[]> {
  const results = await Promise.allSettled(
    tasks.map(t => spawnAgent(t).then((r) => { onResult?.(r); return r; })),
  );
  return results.map(r =>
    r.status === 'fulfilled' ? r.value : {
      agentId: 'unknown',
      agentName: 'unknown',
      success: false,
      result: '',
      error: String((r as any).reason?.message ?? r),
      durationMs: 0,
    });
}

/**
 * Batch spawn with a concurrency cap (default 3). Preserves input order in the
 * returned results. Each task carries its own allowedTools/fork/maxSteps.
 */
export async function spawnAgentsBatch(
  tasks: Array<Omit<SpawnOptions, 'onStep'>>,
  concurrency: number = 3,
  onResult?: (result: SpawnResult) => void,
): Promise<SpawnResult[]> {
  const limit = Math.min(Math.max(Math.floor(concurrency) || 1, 1), 8);
  const results: SpawnResult[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      const r = await spawnAgent(tasks[i]);
      results[i] = r;
      onResult?.(r);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
  return results;
}

/**
 * Spawns multiple agents sequentially, passing each result to the next.
 * Use this for pipeline workflows: research -> write -> review.
 */
export async function spawnAgentsPipeline(
  stages: Array<{
    agentId: string;
    taskBuilder: (previousResult: string) => string;
    maxSteps?: number;
  }>,
): Promise<SpawnResult[]> {
  const results: SpawnResult[] = [];
  let lastResult = '';

  for (const stage of stages) {
    const task = stage.taskBuilder(lastResult);
    const result = await spawnAgent({
      agentId: stage.agentId,
      task,
      maxSteps: stage.maxSteps,
      context: lastResult ? `Previous stage output:\n${lastResult}` : undefined,
    });
    results.push(result);
    lastResult = result.result;
    if (!result.success) break; // stop pipeline on failure
  }

  return results;
}
