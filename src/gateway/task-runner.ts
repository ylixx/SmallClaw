/**
 * task-runner.ts - Multi-Step Task Execution Engine
 * 
 * Sliding context window architecture:
 * - Each step gets: goal + compressed journal + current state + tools
 * - Journal keeps last N steps as bullet summaries
 * - Full state only for the CURRENT step (not history)
 * - Model picks ONE action per turn
 * 
 * This enables 20-30 step workflows on a 4B model with 8K context.
 */

import { getOllamaClient } from '../agents/ollama-client';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface TaskTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      required: string[];
      properties: Record<string, any>;
    };
  };
}

export interface JournalEntry {
  step: number;
  action: string;       // e.g. "browser_click({ref: 3})"
  result: string;       // e.g. "Clicked 'Submit' → redirected to dashboard"
  timestamp: number;
}

export interface TaskState {
  id: string;
  goal: string;
  status: 'running' | 'complete' | 'failed' | 'paused';
  currentStep: number;
  maxSteps: number;
  journal: JournalEntry[];
  currentState: string;  // current page/environment snapshot
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export interface TaskStepResult {
  action: string;
  args: any;
  result: string;
  error: boolean;
}

export type ToolExecutor = (name: string, args: any) => Promise<{ result: string; error: boolean; newState?: string }>;
export type ProgressCallback = (event: string, data: any) => void;

// ─── Configuration ─────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 25;
const JOURNAL_WINDOW = 8;      // keep last N journal entries in full
const JOURNAL_SUMMARY_MAX = 5; // summarize earlier entries into N bullet points

// ─── Task Runner ───────────────────────────────────────────────────────────────

export class TaskRunner {
  private state: TaskState;
  private tools: TaskTool[];
  private executor: ToolExecutor;
  private onProgress: ProgressCallback;
  private systemContext: string;

  constructor(options: {
    goal: string;
    tools: TaskTool[];
    executor: ToolExecutor;
    onProgress: ProgressCallback;
    systemContext?: string;  // personality, soul, etc.
    maxSteps?: number;
    initialState?: string;
  }) {
    this.state = {
      id: `task_${Date.now()}`,
      goal: options.goal,
      status: 'running',
      currentStep: 0,
      maxSteps: options.maxSteps || DEFAULT_MAX_STEPS,
      journal: [],
      currentState: options.initialState || 'No state yet. Start by taking an action.',
      startedAt: Date.now(),
    };
    this.tools = options.tools;
    this.executor = options.executor;
    this.onProgress = options.onProgress;
    this.systemContext = options.systemContext || '';
  }

  getState(): TaskState {
    return { ...this.state };
  }

  /**
   * Run the task to completion (or max steps).
   * Returns the final task state.
   */
  async run(): Promise<TaskState> {
    const ollama = getOllamaClient();

    this.onProgress('task_start', { goal: this.state.goal, maxSteps: this.state.maxSteps });
    console.log(`\n[TASK] ── Starting: "${this.state.goal}" (max ${this.state.maxSteps} steps) ──`);

    while (this.state.status === 'running' && this.state.currentStep < this.state.maxSteps) {
      this.state.currentStep++;
      const step = this.state.currentStep;

      this.onProgress('task_step', { step, maxSteps: this.state.maxSteps });
      console.log(`[TASK] Step ${step}/${this.state.maxSteps}`);

      // Build the compact prompt
      const messages = this.buildStepMessages();

      // Call model
      let response: any;
      try {
        const result = await ollama.chatWithThinking(messages, 'executor', {
          tools: this.tools,
          temperature: 0.2,     // low temp for task execution
          num_ctx: 8192,
          num_predict: 2048,
          think: false,
        });
        response = result.message;

        if (result.thinking) {
          console.log(`[TASK] Think: ${result.thinking.slice(0, 100)}...`);
        }
      } catch (err: any) {
        console.error(`[TASK] Model error at step ${step}:`, err.message);
        this.state.status = 'failed';
        this.state.error = err.message;
        break;
      }

      // Check for tool calls
      const toolCalls = response.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        // Model responded with text — check if it's declaring completion
        const text = (response.content || '').trim();
        console.log(`[TASK] Model text: ${text.slice(0, 150)}`);

        if (this.isTaskComplete(text)) {
          this.state.status = 'complete';
          this.state.completedAt = Date.now();
          this.addJournal('TASK_COMPLETE', text);
          this.onProgress('task_complete', { message: text, steps: step });
          console.log(`[TASK] ✅ Complete at step ${step}: ${text.slice(0, 100)}`);
          break;
        }

        if (this.isTaskFailed(text)) {
          this.state.status = 'failed';
          this.state.error = text;
          this.addJournal('TASK_FAILED', text);
          this.onProgress('task_failed', { message: text, steps: step });
          console.log(`[TASK] ❌ Failed at step ${step}: ${text.slice(0, 100)}`);
          break;
        }

        // Model just talked — nudge it to take action
        this.addJournal('model_response', text);
        console.log(`[TASK] Model spoke without acting, nudging...`);
        continue;
      }

      // Execute FIRST tool call (one action per step)
      const call = toolCalls[0];
      const toolName = call.function?.name || 'unknown';
      const toolArgs = call.function?.arguments || {};
      const actionStr = `${toolName}(${JSON.stringify(toolArgs).slice(0, 100)})`;

      console.log(`[TASK] Action: ${actionStr}`);
      this.onProgress('task_action', { step, action: toolName, args: toolArgs });

      try {
        const { result, error, newState } = await this.executor(toolName, toolArgs);

        // Update current state if the executor provides a new one
        if (newState) {
          this.state.currentState = newState;
        }

        // Compress into journal entry
        const summary = error
          ? `❌ ${toolName}: ${result.slice(0, 150)}`
          : `✅ ${toolName}: ${result.slice(0, 150)}`;

        this.addJournal(actionStr, summary);

        this.onProgress('task_result', {
          step, action: toolName, result: result.slice(0, 300), error,
        });

        console.log(error
          ? `[TASK] ❌ ${result.slice(0, 100)}`
          : `[TASK] ✅ ${result.slice(0, 100)}`);

        // If there were additional tool calls, log them but don't execute
        if (toolCalls.length > 1) {
          console.log(`[TASK] (${toolCalls.length - 1} additional tool calls ignored — one per step)`);
        }
      } catch (err: any) {
        const errMsg = `Execution error: ${err.message}`;
        this.addJournal(actionStr, `❌ ${errMsg}`);
        console.error(`[TASK] Execution error:`, err.message);
        // Don't fail the whole task on one error — let model recover
      }
    }

    // Check if we hit max steps
    if (this.state.status === 'running') {
      this.state.status = 'paused';
      this.state.error = `Reached max steps (${this.state.maxSteps})`;
      this.onProgress('task_paused', {
        message: `Reached ${this.state.maxSteps} steps without completing.`,
        journal: this.state.journal.map(j => j.result),
      });
      console.log(`[TASK] ⚠️ Paused at max steps (${this.state.maxSteps})`);
    }

    return this.state;
  }

  // ─── Prompt Building ───────────────────────────────────────────────────────

  private buildStepMessages(): any[] {
    const messages: any[] = [];

    // System prompt — compact, focused on task execution
    messages.push({
      role: 'system',
      content: `You are completing a multi-step task. Pick ONE action per turn.

RULES:
1. Take exactly ONE action per turn using the available tools.
2. After each action, you'll see the result and can take the next action.
3. When the task is fully complete, respond with text starting with "TASK_COMPLETE:" followed by a summary.
4. If the task cannot be completed, respond with "TASK_FAILED:" and explain why.
5. Do NOT explain your reasoning. Just pick the next action.
6. Use the CURRENT STATE to decide what to do next — don't guess from memory.
${this.systemContext ? '\n' + this.systemContext : ''}`,
    });

    // Task goal
    messages.push({
      role: 'user',
      content: this.buildTaskPrompt(),
    });

    return messages;
  }

  private buildTaskPrompt(): string {
    const parts: string[] = [];

    // Goal
    parts.push(`TASK: ${this.state.goal}`);
    parts.push(`PROGRESS: Step ${this.state.currentStep} of ${this.state.maxSteps}`);

    // Journal — compressed
    if (this.state.journal.length > 0) {
      parts.push('');
      parts.push('COMPLETED STEPS:');

      const journal = this.state.journal;

      if (journal.length <= JOURNAL_WINDOW) {
        // All entries fit in the window
        for (const entry of journal) {
          parts.push(`  ${entry.step}. ${entry.result}`);
        }
      } else {
        // Summarize older entries, keep recent ones in full
        const oldEntries = journal.slice(0, journal.length - JOURNAL_WINDOW);
        const recentEntries = journal.slice(journal.length - JOURNAL_WINDOW);

        // Ultra-compact summary of old steps
        const summaryCount = Math.min(oldEntries.length, JOURNAL_SUMMARY_MAX);
        parts.push(`  [Steps 1-${oldEntries.length}: ${summaryCount} key actions]`);
        // Pick evenly spaced entries from old ones
        const stride = Math.max(1, Math.floor(oldEntries.length / summaryCount));
        for (let i = 0; i < oldEntries.length; i += stride) {
          if (parts.length - 4 < summaryCount) { // rough limit
            const e = oldEntries[i];
            parts.push(`  ${e.step}. ${e.result.slice(0, 80)}`);
          }
        }

        parts.push('  ...');
        parts.push('  [Recent steps:]');
        for (const entry of recentEntries) {
          parts.push(`  ${entry.step}. ${entry.result}`);
        }
      }
    }

    // Current state — this gets the most context budget
    parts.push('');
    parts.push('CURRENT STATE:');
    // Trim state to ~2000 chars to leave room
    const stateTrimmed = this.state.currentState.length > 2000
      ? this.state.currentState.slice(0, 2000) + '\n...(truncated)'
      : this.state.currentState;
    parts.push(stateTrimmed);

    parts.push('');
    parts.push('What is the next action? Pick ONE tool call.');

    return parts.join('\n');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private addJournal(action: string, result: string) {
    this.state.journal.push({
      step: this.state.currentStep,
      action,
      result,
      timestamp: Date.now(),
    });
  }

  private isTaskComplete(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('task_complete') ||
           lower.includes('task complete') ||
           lower.includes('successfully completed') ||
           (lower.includes('done') && lower.includes('all steps'));
  }

  private isTaskFailed(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes('task_failed') ||
           lower.includes('task failed') ||
           lower.includes('cannot complete') ||
           lower.includes('unable to complete');
  }
}

// ─── Convenience: Run a one-shot task ──────────────────────────────────────────

export async function runTask(options: {
  goal: string;
  tools: TaskTool[];
  executor: ToolExecutor;
  onProgress: ProgressCallback;
  systemContext?: string;
  maxSteps?: number;
  initialState?: string;
}): Promise<TaskState> {
  const runner = new TaskRunner(options);
  return runner.run();
}
