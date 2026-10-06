/**
 * Unit tests for knowledge/index.ts — tool wiring only (no Python spawn,
 * so the suite stays hermetic and CI-safe).
 */
import { describe, it, expect } from 'vitest';
import { KNOWLEDGE_TOOL_NAMES, getKnowledgeToolDefinitions } from '../src/tools/knowledge';

describe('knowledge tool wiring', () => {
  it('exports the expected tool names', () => {
    expect(KNOWLEDGE_TOOL_NAMES).toEqual([
      'knowledge_add',
      'knowledge_search',
      'knowledge_list',
      'knowledge_status',
      'knowledge_remove',
    ]);
  });

  it('builds OpenAI-style function definitions', () => {
    const defs = getKnowledgeToolDefinitions('E:/kb');
    expect(defs).toHaveLength(5);
    for (const def of defs) {
      expect(def.type).toBe('function');
      expect(def.function.name).toMatch(/^knowledge_/);
      expect(def.function.parameters.type).toBe('object');
      expect(def._meta).toEqual({ kb: true, dir: 'E:/kb' });
    }
    const search = defs.find((d) => d.function.name === 'knowledge_search');
    expect(search.function.parameters.required).toEqual(['query']);
  });

  it('names in the whitelist set match the definitions', () => {
    const defNames = getKnowledgeToolDefinitions('E:/kb').map((d) => d.function.name);
    expect([...KNOWLEDGE_TOOL_NAMES].sort()).toEqual([...defNames].sort());
  });
});
