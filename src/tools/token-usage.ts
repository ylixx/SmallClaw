/**
 * token-usage — 报告当前进程累计的 LLM token 用量（对标 QwenPaw 的 get_token_usage）
 *
 * 设计要点：
 * - 数据来自 token-stats.ts 的进程内累加器，由 chat-handler 在每轮 LLM 调用拿到 usage 时累加。
 * - 返回 prompt/completion/total tokens 与调用次数；可带 reset=true 清零（用于分段统计）。
 * - 纯只读（除非显式 reset）；进程重启即归零，语义为"本次运行用量"。
 */

import { ToolResult } from '../types.js';
import { getTokenStats, resetTokenStats } from './token-stats.js';

export async function executeTokenUsage(args: { reset?: boolean } = {}): Promise<ToolResult> {
  if (args?.reset === true) {
    const before = getTokenStats();
    resetTokenStats();
    return {
      success: true,
      data: { reset: true, previous: before },
      stdout: `Token usage counter reset. Previous total: ${before.total_tokens} tokens over ${before.calls} calls.`,
    };
  }
  const s = getTokenStats();
  return {
    success: true,
    data: s,
    stdout: JSON.stringify(s, null, 2),
  };
}

export const tokenUsageTool = {
  name: 'get_token_usage',
  description: 'Report cumulative LLM token usage for this run: prompt_tokens, completion_tokens, ' +
    'total_tokens, and LLM call count. Set reset=true to zero the counter (useful for segment measurement). ' +
    'Read-only unless reset is requested. Note: counter starts at process launch and resets on restart.',
  execute: executeTokenUsage,
  schema: {
    reset: 'boolean (optional, default false) - Zero the usage counter and return the previous totals.',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      reset: { type: 'boolean', description: 'Zero the counter and return previous totals.' },
    },
    additionalProperties: true,
  },
};
