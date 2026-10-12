import { describe, it, expect } from 'vitest';
import { detectAnalysisScenario, buildScenarioContext } from '../src/gateway/scenario-tuned-prompt';

describe('detectAnalysisScenario', () => {
  it('hits analysis/summary requests with material object', () => {
    expect(detectAnalysisScenario('整理工作区里的文档，总结各文件要点')).toBe(true);
    expect(detectAnalysisScenario('分析这份材料的数据')).toBe(true);
    expect(detectAnalysisScenario('提炼报告里的关键信息')).toBe(true);
    expect(detectAnalysisScenario('对比这两个表格的指标')).toBe(true);
    expect(detectAnalysisScenario('汇总聊天记录的要点')).toBe(true);
  });

  it('misses plain chat / greeting / verb-only', () => {
    expect(detectAnalysisScenario('你好')).toBe(false);
    expect(detectAnalysisScenario('总结一下你的看法')).toBe(false);
    expect(detectAnalysisScenario('谢谢')).toBe(false);
    expect(detectAnalysisScenario('好的，继续')).toBe(false);
  });

  it('misses empty input', () => {
    expect(detectAnalysisScenario('')).toBe(false);
    expect(detectAnalysisScenario('   ')).toBe(false);
  });
});

describe('buildScenarioContext', () => {
  it('produces a compact block under 300 chars', () => {
    const ctx = buildScenarioContext('整理工作区里的文档');
    expect(ctx).toContain('SCENARIO');
    expect(ctx.length).toBeLessThan(300);
  });
});
