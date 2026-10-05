/**
 * Unit tests for run-command-router.ts — the run_command GUI launcher router.
 * Covers the failure modes seen in real agent sessions: blocked-pattern
 * false positives on "word/winword <file>", default-app file opening,
 * allowlist apps with arguments, and shell-metachar rejection.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveRunCommand,
  suggestRunCommandFix,
  BLOCKED_PATTERNS,
} from '../src/gateway/run-command-router';

describe('blocked patterns (no false positives)', () => {
  it('does not flag "word <file>" as unsafe "rd"', () => {
    const r = resolveRunCommand('word FULLPLAN.docx');
    expect(r.blocked).toBeUndefined();
    expect(r.execCmd).toBe('start winword "FULLPLAN.docx"');
  });
  it('does not flag "winword <file>"', () => {
    const r = resolveRunCommand('winword fullplan.docx');
    expect(r.blocked).toBeUndefined();
    expect(r.execCmd).toBe('start winword "fullplan.docx"');
  });
  it('still blocks recursive directory delete', () => {
    expect(resolveRunCommand('rd /s /q C:\\temp').blocked).toBeTruthy();
    expect(resolveRunCommand('rmdir /s x').blocked).toBeTruthy();
  });
  it('still blocks destructive patterns', () => {
    expect(resolveRunCommand('del /f C:\\x').blocked).toBeTruthy();
    expect(resolveRunCommand('format C:').blocked).toBeTruthy();
  });
});

describe('open file with default app (start <file> / open <file>)', () => {
  it('start <file> opens with default app', () => {
    const r = resolveRunCommand('start FULLPLAN.docx');
    expect(r.execCmd).toBe('start "" "FULLPLAN.docx"');
    expect(r.targetFile).toBe('FULLPLAN.docx');
  });
  it('open <file> maps to default app on Windows', () => {
    const r = resolveRunCommand('open report.docx');
    expect(r.execCmd).toBe('start "" "report.docx"');
    expect(r.targetFile).toBe('report.docx');
  });
  it('supports paths with directories', () => {
    expect(resolveRunCommand('start D:\\docs\\plan.docx').execCmd).toBe('start "" "D:\\docs\\plan.docx"');
  });
  it('word/winword/notepad/code expose targetFile', () => {
    expect(resolveRunCommand('word FULLPLAN.docx').targetFile).toBe('FULLPLAN.docx');
    expect(resolveRunCommand('winword fullplan.docx').targetFile).toBe('fullplan.docx');
    expect(resolveRunCommand('notepad "FULLPLAN.docx"').targetFile).toBe('FULLPLAN.docx');
    expect(resolveRunCommand('code D:\\proj\\plan.docx').targetFile).toBe('D:\\proj\\plan.docx');
  });
  it('xlsx/pptx/pdf all route to default app opening', () => {
    expect(resolveRunCommand('start budget.xlsx').execCmd).toBe('start "" "budget.xlsx"');
    expect(resolveRunCommand('open deck.pptx').execCmd).toBe('start "" "deck.pptx"');
    expect(resolveRunCommand('start manual.pdf').execCmd).toBe('start "" "manual.pdf"');
  });
  it('excel / powerpoint launch Office apps with files', () => {
    expect(resolveRunCommand('excel FULLPLAN.xlsx').execCmd).toBe('start excel "FULLPLAN.xlsx"');
    expect(resolveRunCommand('excel').execCmd).toBe('start excel');
    expect(resolveRunCommand('powerpoint new-deck.pptx').execCmd).toBe('start powerpnt "new-deck.pptx"');
    expect(resolveRunCommand('powerpnt').execCmd).toBe('start powerpnt');
  });
  it('rejects shell metacharacters in the target', () => {
    expect(resolveRunCommand('start a&calc.exe').execCmd).toBe('');
    expect(resolveRunCommand('open x|cmd').execCmd).toBe('');
  });
  it('refuses to start executable extensions (arbitrary code execution)', () => {
    for (const ext of ['bat', 'exe', 'ps1', 'vbs', 'msi', 'cmd', 'reg', 'lnk', 'scr']) {
      const r = resolveRunCommand(`start run.${ext}`);
      expect(r.execCmd).toBe('');
      expect(r.blocked).toContain(ext);
    }
    // non-executable documents still open normally
    expect(resolveRunCommand('start plan.pdf').execCmd).toBe('start "" "plan.pdf"');
    expect(resolveRunCommand('start data.csv').execCmd).toBe('start "" "data.csv"');
  });
  it('does not hijack URLs (start http handled by URL branch)', () => {
    const r = resolveRunCommand('start https://example.com');
    expect(r.execCmd).not.toBe('');
    expect(r.execCmd).toContain('example.com');
  });
});

describe('allowlist apps', () => {
  it('bare word / winword launch Word', () => {
    expect(resolveRunCommand('winword').execCmd).toBe('start winword');
    expect(resolveRunCommand('word').execCmd).toBe('start winword');
  });
  it('notepad with argument is accepted (ARG_SAFE_COMMANDS)', () => {
    expect(resolveRunCommand('notepad "FULLPLAN.docx"').execCmd).toBe('start notepad "\\"FULLPLAN.docx\\""');
  });
  it('chrome <url> builds browser launch', () => {
    expect(resolveRunCommand('chrome youtube.com').execCmd).toBe('start chrome "https://youtube.com"');
  });
  it('rejects unknown app with args', () => {
    expect(resolveRunCommand('sublime plan.txt').execCmd).toBe('');
  });
});

describe('suggestRunCommandFix', () => {
  it('suggests default-app open for a file-like command', () => {
    expect(suggestRunCommandFix('open FULLPLAN.docx')).toContain('start FULLPLAN.docx');
  });
  it('suggests chrome for a URL-like command', () => {
    expect(suggestRunCommandFix('go to https://example.com')).toContain('chrome https://example.com');
  });
});

describe('BLOCKED_PATTERNS list sanity', () => {
  it('contains no bare "rd " pattern (caused word/winword false positives)', () => {
    expect(BLOCKED_PATTERNS).not.toContain('rd ');
    expect(BLOCKED_PATTERNS).toContain('rd /s');
  });
});
