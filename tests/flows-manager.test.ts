/**
 * Unit tests for flows-manager.ts — lightweight flow-template system.
 * Uses a temp dir so no project state is touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { FlowsManager, FlowTemplate } from '../src/gateway/flows-manager';

let tmpDir: string;
let flowsDir: string;
let mgr: FlowsManager;

function writeFlow(id: string, partial: Partial<FlowTemplate> = {}): void {
  const flow: FlowTemplate = {
    id,
    name: partial.name || id,
    triggers: partial.triggers || [id],
    description: partial.description || '',
    skill: partial.skill,
    instruction: partial.instruction || `执行 ${id} 流程`,
    output_note: partial.output_note || '',
  };
  fs.writeFileSync(path.join(flowsDir, `${id}.json`), JSON.stringify(flow, null, 2), 'utf-8');
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallclaw-flows-'));
  flowsDir = path.join(tmpDir, 'flows');
  fs.mkdirSync(flowsDir, { recursive: true });
  mgr = new FlowsManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('FlowsManager', () => {
  it('loads valid templates from the flows directory', () => {
    writeFlow('weekly-report', { triggers: ['生成周报', '周报'] });
    writeFlow('doc-analysis', { name: '深度分析', skill: 'analysis-report' });
    const flows = mgr.list();
    expect(flows).toHaveLength(2);
    expect(flows.map((f) => f.id).sort()).toEqual(['doc-analysis', 'weekly-report']);
    expect(flows.find((f) => f.id === 'doc-analysis')?.skill).toBe('analysis-report');
  });

  it('skips invalid / broken templates without crashing', () => {
    writeFlow('ok-flow', {});
    fs.writeFileSync(path.join(flowsDir, 'broken.json'), '{not json', 'utf-8');
    fs.writeFileSync(path.join(flowsDir, 'missing-fields.json'), JSON.stringify({ name: 'no id' }), 'utf-8');
    fs.writeFileSync(path.join(flowsDir, 'not-a-flow.txt'), 'hello', 'utf-8');
    const flows = mgr.list();
    expect(flows).toHaveLength(1);
    expect(flows[0].id).toBe('ok-flow');
  });

  it('matches triggers by substring (case-insensitive)', () => {
    writeFlow('weekly-report', { triggers: ['生成周报', '周报'] });
    expect(mgr.matchTrigger('帮我生成周报')).not.toBeNull();
    expect(mgr.matchTrigger('这周有什么安排？')).toBeNull();
    expect(mgr.matchTrigger('')).toBeNull();
  });

  it('returns the first matching flow in id order', () => {
    writeFlow('a-flow', { triggers: ['分析'] });
    writeFlow('b-flow', { triggers: ['深度分析'] });
    const hit = mgr.matchTrigger('做深度分析报告');
    expect(hit?.id).toBe('a-flow'); // both match ('分析' ⊂ '深度分析'), id order first
  });

  it('get() returns a flow by id', () => {
    writeFlow('weekly-report', {});
    expect(mgr.get('weekly-report')?.id).toBe('weekly-report');
    expect(mgr.get('nope')).toBeUndefined();
  });

  it('picks up newly added templates automatically (no reload needed)', () => {
    writeFlow('first', {});
    expect(mgr.list()).toHaveLength(1);
    writeFlow('second', {});
    expect(mgr.list()).toHaveLength(2); // fingerprint scan invalidated the cache
  });

  it('reload() force-refreshes from disk', () => {
    writeFlow('first', {});
    expect(mgr.list()).toHaveLength(1);
    writeFlow('second', {});
    expect(mgr.list()).toHaveLength(2);
    mgr.reload();
    expect(mgr.list()).toHaveLength(2);
  });
});
