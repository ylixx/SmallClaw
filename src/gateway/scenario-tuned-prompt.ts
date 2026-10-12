/**
 * scenario-tuned-prompt.ts — 场景专用精简 system（Phase 7a）。
 * 面向本地 2-9B 小模型的核心场景：材料数据分析 / 整理 / 总结 / 提炼。
 * 命中场景时用 <300 字的精简 system 替换完整 personality 注入
 * （IDENTITY/USER/SOUL/TODAY_NOTES/记忆片段等），减少 prompt tokens、
 * 避免记忆注入干扰当前任务。
 */

// 场景动词：用户要求对材料做分析/整理/总结/提炼类处理
const SCENARIO_VERBS =
  /(整理|总结|提炼|汇总|归纳|分析|统计|对比|概括|摘要|提取|归类|分类|盘点|梳理|筛选|清洗|合并|拆分|排序|去重)/i;

// 场景对象：材料/数据/文档类名词
const SCENARIO_OBJECTS =
  /(材料|数据|文件|文档|报告|表格|内容|信息|要点|记录|资料|清单|列表|周报|月报|日报|台账|纪要|聊天记录|对话记录|指标|数值|结果|图表|附件|PDF|Excel|Word|表)/i;

// 闲聊排除：问候/寒暄/无材料对象的请求不触发场景
const CHAT_ONLY =
  /^(你好|您好|hi|hello|嗨|在吗|谢谢|感谢|再见|拜拜|好的|嗯|ok|没事了|先休息|继续|好的，|来|请)/i;

/** 检测是否为"材料数据分析/整理/总结/提炼"场景 */
export function detectAnalysisScenario(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  if (CHAT_ONLY.test(text)) return false;
  // 需要动词 + 对象同时命中；单动词（如"总结一下你的看法"）不触发，避免误伤闲聊
  return SCENARIO_VERBS.test(text) && SCENARIO_OBJECTS.test(text);
}

/**
 * 场景专用精简 system（中文，<300 字）。
 * 只包含：场景定位 + 工作方式 4 条 + 工具提示 + 结束语。
 */
export function buildScenarioContext(message: string): string {
  const block = [
    '[SCENARIO: 材料数据分析整理] 对材料做分析/整理/总结/提炼。',
    '做法：',
    '1. list_files 拿全清单，只读关键 3-5 个文件，勿逐个读完；',
    '2. 忠实原文提取数据与要点，不编造缺失值；',
    '3. 用表格/列表呈现结果，数字保留单位口径；',
    '4. 得出主要结论立即停止调用工具并输出，勿继续读文件；',
    '5. 工具调用上限 10 次，超出直接输出已有结论；',
    '6. 不确定处标注"待确认"。工具限文件/表格类。',
  ].join('\n');
  void message;
  return `\n\n${block}`;
}
