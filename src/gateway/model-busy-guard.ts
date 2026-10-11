/**
 * model-busy-guard.ts — Model-Busy 并发锁（从 server-v2.ts 抽出，Phase 1.5）
 *
 * 职责：
 *  - 单一模块级单例 `isModelBusy`（布尔），防止 4B 模型在用户聊天进行中
 *    被 cron/heartbeat/task-followup/webhook 并发触发推理。
 *
 * 设计约束（见 docs/server-v2-split-plan.md）：
 *  - 单例必须保持"单一事实来源"：server-v2.ts 不再持有本地
 *    `let isModelBusy`，全部改为引用本模块导出的 accessor，
 *    从而保证搬移前后语义字节级一致（仍是同一个布尔值）。
 *  - 仅读/写一个布尔，无其它状态、无循环依赖；4 个消费方
 *    （CronScheduler/HeartbeatRunner/TelegramChannel/buildWebhookRouter）
 *    仍是叶子模块、不反向依赖 server-v2，由 server-v2 在装配时传入
 *    `getIsModelBusy: getModelBusy`。
 */

let isModelBusy = false;

/** 当前模型是否忙（有聊天/流程在途）。供 4 个外部模块的 getIsModelBusy 闭包读取。 */
export function getModelBusy(): boolean {
  return isModelBusy;
}

/** 置忙/释放忙锁。写端仅在聊天/流程入口与 finally 中出现，语义不变。 */
export function setModelBusy(busy: boolean): void {
  isModelBusy = busy;
}
