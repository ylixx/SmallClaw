/**
 * token-stats — 会话级 token 用量累加器（支撑 get_token_usage 工具）
 *
 * 设计要点：
 * - 进程内单例，累计 prompt/completion/total tokens 与 LLM 调用次数。
 * - 由各 LLM 调用点在拿到 usage 时调用 addUsage() 累加（见 chat-handler.ts）。
 * - get_token_usage 工具读取此处的快照返回。
 * - 不依赖任何外部存储；进程重启归零（符合"本次运行用量"语义）。
 */

export interface TokenStats {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
  /** 最近一次累加的时间戳（ms） */
  last_update: number | null;
}

const state: TokenStats = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  calls: 0,
  last_update: null,
};

export function addUsage(promptTokens: number, completionTokens: number): void {
  const p = Number(promptTokens) || 0;
  const c = Number(completionTokens) || 0;
  if (p <= 0 && c <= 0) return;
  state.prompt_tokens += p;
  state.completion_tokens += c;
  state.total_tokens += p + c;
  state.calls += 1;
  state.last_update = Date.now();
}

export function getTokenStats(): TokenStats {
  return { ...state };
}

export function resetTokenStats(): void {
  state.prompt_tokens = 0;
  state.completion_tokens = 0;
  state.total_tokens = 0;
  state.calls = 0;
  state.last_update = null;
}
