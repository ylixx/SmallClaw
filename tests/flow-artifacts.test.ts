/**
 * Unit tests for flow-artifacts.ts — extracting artifacts (created files)
 * from tool results so the SSE done event can carry them to the UI.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { extractFlowArtifacts, FlowArtifact, ToolResultLike } from '../src/gateway/flow-artifacts';

const WS = path.join('C:', 'work');

function tr(name: string, args: any, error = false): ToolResultLike {
  return { name, args, result: `${name} ok`, error };
}

describe('extractFlowArtifacts', () => {
  it('extracts created files from create_file results', () => {
    const out = extractFlowArtifacts([
      tr('create_file', { filename: 'report.html' }),
      tr('list_files', {}),
      tr('doc_read', { filename: 'src.pdf' }),
    ], WS);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('file');
    expect(out[0].title).toBe('report.html');
    expect(out[0].status).toBe('ok');
    expect(out[0].path).toBe(path.join(WS, 'report.html'));
    expect(out[0].files).toEqual(['report.html']);
  });

  it('also accepts write_file and name alias', () => {
    const out = extractFlowArtifacts([
      tr('write_file', { name: 'data.csv' }),
    ], WS);
    expect(out.map((a: FlowArtifact) => a.title)).toEqual(['data.csv']);
  });

  it('deduplicates the same filename across multiple calls', () => {
    // Large-file pattern: skeleton + insert_after appends — filename unchanged
    const out = extractFlowArtifacts([
      tr('create_file', { filename: 'report.html', content: '<html>' }),
      tr('insert_after', { filename: 'report.html' }),
      tr('create_file', { filename: 'report.html', content: '<html>...</html>' }),
    ], WS);
    expect(out).toHaveLength(1);
  });

  it('captures edit tools when the model continues writing the artifact', () => {
    // File already exists → model edits it with replace_lines instead of create_file
    const out = extractFlowArtifacts([
      tr('create_file', { filename: 'flow-artifact-test.txt' }, true),
      tr('replace_lines', { filename: 'flow-artifact-test.txt' }),
    ], WS);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('flow-artifact-test.txt');
  });

  it('skips read/delete tools that do not produce artifacts', () => {
    const out = extractFlowArtifacts([
      tr('read_file', { filename: 'notes.txt' }),
      tr('delete_file', { filename: 'gone.txt' }),
      tr('insert_after', { filename: 'notes.txt' }, true),
    ], WS);
    expect(out).toHaveLength(0);
  });

  it('skips failed calls and non-file tools', () => {
    const out = extractFlowArtifacts([
      tr('create_file', { filename: 'dup.txt' }, true),
      tr('read_file', { filename: 'notes.txt' }),
      tr('delete_file', { filename: 'gone.txt' }),
    ], WS);
    expect(out).toHaveLength(0);
  });

  it('returns [] for undefined input', () => {
    expect(extractFlowArtifacts(undefined, WS)).toEqual([]);
  });
});
