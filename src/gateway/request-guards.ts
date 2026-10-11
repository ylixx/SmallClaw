/**
 * request-guards.ts — 请求守卫（从 server-v2.ts 抽出，Phase 1）
 *
 * 当前承载：
 *  - 重复失败熔断（Repeated-failure circuit breaker）：同一工具用相同参数
 *    连续失败 N 次后，停止循环并要求模型改变策略，避免小模型在同一报错上
 *    空耗剩余步数。
 *
 * 设计约束（见拆分方案 §5）：
 *  - 仅依赖本模块内部状态，不反向 import server-v2.ts，避免循环依赖。
 *  - 模块级 `toolFailureTracker` 为按 sessionId 的私有 Map，仅经
 *    `noteToolFailure` 访问，迁移前后行为一致。
 *
 * 注意：Model-Busy 守卫（`let isModelBusy` 模块级可变单例，跨 11 处读写 +
 * 4 个闭包访问器）耦合度高，属高风险抽取项，已刻意留待后续独立谨慎处理，
 * 不在本次 Phase 1 范围内。
 */

// ── Repeated-failure circuit breaker ─────────────────────────────────────────
// A small model that gets a vague error tends to retry the same call verbatim.
// After N identical failures, stop the loop and say so explicitly instead of
// letting it burn the remaining steps on the same rejected call.
const TOOL_FAILURE_LIMIT = 3;
const toolFailureTracker = new Map<string, { key: string; count: number }>();

function toolFailureKey(name: string, args: any): string {
  let serialized = '?';
  try {
    serialized = JSON.stringify(args ?? {});
  } catch {
    /* unserializable args - fall back to name-only matching */
  }
  return `${name}:${serialized}`;
}

export function noteToolFailure(sessionId: string, name: string, args: any): string | null {
  const key = toolFailureKey(name, args);
  if (toolFailureTracker.size > 500) toolFailureTracker.clear();
  const prev = toolFailureTracker.get(sessionId);
  const count = prev && prev.key === key ? prev.count + 1 : 1;
  toolFailureTracker.set(sessionId, { key, count });
  if (count < TOOL_FAILURE_LIMIT) return null;
  toolFailureTracker.delete(sessionId);
  return [
    `Stop - "${name}" has now failed ${TOOL_FAILURE_LIMIT} times with identical arguments.`,
    'Calling it again the same way will fail again. Instead:',
    '  - re-read the error message and change the arguments,',
    '  - switch to a different tool that can do this,',
    '  - or report what is blocked to the user and ask how to proceed.',
  ].join('\n');
}

// 工具调用成功后清除该会话的失败计数，避免一次成功前的失败持续阻断。
// 对应 server-v2.ts executeTool 成功分支里原先直接访问 toolFailureTracker 的逻辑。
export function resetToolFailure(sessionId: string): void {
  toolFailureTracker.delete(sessionId);
}
