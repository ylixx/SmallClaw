/**
 * Unit tests for server-v2-text.ts — the text-processing helpers extracted
 * from server-v2.ts. These pure functions power thinking stripping, reply
 * sanitizing and intent classification for small-model outputs.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {
  separateThinkingFromContent,
  normalizeForDedup,
  isGreetingLikeMessage,
  sanitizeFinalReply,
  stripExplicitThinkTags,
  isExecutionLikeRequest,
  isBrowserAutomationRequest,
  isDesktopAutomationRequest,
  extractLikelyUrl,
  looksLikeSafetyRefusal,
  looksLikeIntentOnlyReply,
  hasConcreteCompletion,
  isBrowserToolName,
  isDesktopToolName,
  isHighStakesFile,
  requestedFullTemplate,
  logToolCall,
  isToolArgParseFailure,
} from '../src/gateway/server-v2-text';

describe('separateThinkingFromContent', () => {
  it('strips explicit think blocks and returns the reply', () => {
    const out = separateThinkingFromContent('<think>let me check the rules</think>Here is the answer.');
    expect(out.reply).toBe('Here is the answer.');
    // Short explicit-think output is returned as-is; thinking is only split out
    // for long reasoning-heavy outputs.
    expect(out.thinking).toBe('');
  });

  it('returns empty reply when everything is thinking', () => {
    const out = separateThinkingFromContent('<think>only reasoning here</think>');
    expect(out.reply).toBe('');
    expect(out.thinking.length).toBeGreaterThan(0);
  });

  it('handles empty input', () => {
    expect(separateThinkingFromContent('')).toEqual({ reply: '', thinking: '' });
  });
});

describe('stripExplicitThinkTags', () => {
  it('handles dangling open think tag from partial output', () => {
    const out = stripExplicitThinkTags('answer here <think>model cut off');
    expect(out.cleaned).toBe('answer here');
    expect(out.thinking).toBe('model cut off');
  });
});

describe('normalizeForDedup', () => {
  it('lowercases and removes non-alphanumeric chars', () => {
    expect(normalizeForDedup('Hello, World! 123')).toBe('helloworld123');
  });
});

describe('sanitizeFinalReply', () => {
  it('removes meta lines and dedups repeated paragraphs', () => {
    const out = sanitizeFinalReply('No tools are needed for this greeting.\n\nhello world\n\nhello world');
    expect(out).toBe('hello world');
  });

  it('drops paragraphs matching the preflight reason', () => {
    const out = sanitizeFinalReply('first paragraph\n\nreason text here', { preflightReason: 'reason text here' });
    expect(out).not.toContain('reason text here');
  });
});

describe('isGreetingLikeMessage', () => {
  it('detects simple greetings', () => {
    expect(isGreetingLikeMessage('hi')).toBe(true);
    expect(isGreetingLikeMessage('hey claw')).toBe(true);
    expect(isGreetingLikeMessage('how are you')).toBe(true);
  });
  it('rejects task-like messages', () => {
    expect(isGreetingLikeMessage('search the web for x')).toBe(false);
    expect(isGreetingLikeMessage('write a file')).toBe(false);
  });
});

describe('intent classifiers', () => {
  it('isExecutionLikeRequest detects build/edit phrasing', () => {
    expect(isExecutionLikeRequest('create a new file')).toBe(true);
    expect(isExecutionLikeRequest('what is the weather?')).toBe(false);
  });
  it('isBrowserAutomationRequest requires verb + target', () => {
    expect(isBrowserAutomationRequest('go to https://example.com')).toBe(true);
    expect(isBrowserAutomationRequest('hello there')).toBe(false);
  });
  it('isDesktopAutomationRequest detects desktop targets', () => {
    expect(isDesktopAutomationRequest('open notepad')).toBe(true);
    expect(isDesktopAutomationRequest('what time is it')).toBe(false);
  });
});

describe('extractLikelyUrl', () => {
  it('extracts direct URLs and bare domains', () => {
    expect(extractLikelyUrl('check https://example.com/page now')).toBe('https://example.com/page');
    expect(extractLikelyUrl('look at example.com')).toBe('https://example.com');
  });
  it('returns null when no URL present', () => {
    expect(extractLikelyUrl('nothing here')).toBeNull();
  });
});

describe('reply quality guards', () => {
  it('looksLikeSafetyRefusal flags refusal phrasing', () => {
    expect(looksLikeSafetyRefusal("I can't help with that")).toBe(true);
    expect(looksLikeSafetyRefusal('here is the result')).toBe(false);
  });
  it('looksLikeIntentOnlyReply flags intent-only text', () => {
    expect(looksLikeIntentOnlyReply('let me fix that for you')).toBe(true);
    expect(looksLikeIntentOnlyReply('done, file created')).toBe(false);
  });
  it('hasConcreteCompletion detects completion language', () => {
    expect(hasConcreteCompletion('I created the file')).toBe(true);
    expect(hasConcreteCompletion('thinking about it')).toBe(false);
  });
});

describe('tool-name & file guards', () => {
  it('recognizes browser/desktop tool names', () => {
    expect(isBrowserToolName('browser_click')).toBe(true);
    expect(isBrowserToolName('browser_fly')).toBe(false);
    expect(isDesktopToolName('desktop_type')).toBe(true);
  });
  it('isHighStakesFile flags sensitive filenames', () => {
    expect(isHighStakesFile('config.json')).toBe(true);
    expect(isHighStakesFile('note.txt')).toBe(false);
  });
  it('requestedFullTemplate detects full-page asks', () => {
    expect(requestedFullTemplate('build me a full page layout')).toBe(true);
  });
});

describe('logToolCall', () => {
  it('appends an audit line to the workspace log', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smallclaw-test-'));
    logToolCall(dir, 'read_file', { path: 'x.txt' }, 'ok', false);
    const content = fs.readFileSync(path.join(dir, 'tool_audit.log'), 'utf-8');
    expect(content).toContain('read_file');
    expect(content).toContain('OK');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('isToolArgParseFailure', () => {
  it('flags llama.cpp tool-call argument parse errors', () => {
    expect(isToolArgParseFailure(new Error('Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error at line 1, column 11269: syntax error while parsing value - invalid string: mi'))).toBe(true);
    expect(isToolArgParseFailure({ message: 'llama_cpp API error 500: tool call arguments invalid JSON' })).toBe(true);
  });
  it('does not flag unrelated errors', () => {
    expect(isToolArgParseFailure(new Error('openai API error 429: rate limit exceeded'))).toBe(false);
    expect(isToolArgParseFailure(new Error('network timeout'))).toBe(false);
    expect(isToolArgParseFailure(null)).toBe(false);
  });
});
