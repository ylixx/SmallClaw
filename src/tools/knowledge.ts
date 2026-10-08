// STUB: 上游仓库缺少此模块，这里提供最小空实现以让 tsc 通过构建。
// 所有 knowledge_* 工具在运行时会返回 ok:false，不影响其他工具。
// 若后续上游补上真实实现，可直接覆盖本文件。

export function getKnowledgeToolDefinitions(_knowledgeDir?: string): any[] {
  return [];
}

export const KNOWLEDGE_TOOL_NAMES: string[] = [];

export interface KnowledgeOutcome {
  ok: boolean;
  error?: string;
  results?: any[];
  chunks?: string[];
  name?: string;
  files?: any[];
  total_files?: number;
  removed?: boolean;
}

export async function executeKnowledgeTool(
  _name: string,
  _args: any,
  _kbDir?: string,
): Promise<KnowledgeOutcome> {
  return { ok: false, error: 'knowledge module not implemented (stub)' };
}
