/**
 * server-v2-text.ts — Text-processing helpers extracted verbatim from server-v2.ts.
 *
 * Pure text functions: thinking stripping, reply sanitizing, intent detection.
 * Only logToolCall touches the filesystem (writes the tool_audit.log).
 * Behavior is intentionally unchanged.
 */

import path from 'path';
import fs from 'fs';

// ─── Audit Logger ──────────────────────────────────────────────────────────────

function logToolCall(workspacePath: string, toolName: string, args: any, result: string, error: boolean) {
  try {
    const logPath = path.join(workspacePath, 'tool_audit.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${error ? 'FAIL' : 'OK'} ${toolName}(${JSON.stringify(args).slice(0, 200)}) => ${result.slice(0, 200)}\n`);
  } catch {}
}

// ─── Thinking Stripper ─────────────────────────────────────────────────────────

function separateThinkingFromContent(text: string): { reply: string; thinking: string } {
  if (!text) return { reply: '', thinking: '' };

  let cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();

  if (!cleaned) return { reply: '', thinking: text };

  // Fast-path: if the entire output looks like pure reasoning (starts with common
  // reasoning starters and is very long), treat the whole thing as thinking
  if (cleaned.length > 500 && /^(Okay|Ok,|Let me|First|Hmm|Wait|The user|I need|I should|So,)/i.test(cleaned)) {
    // Try to find the last sentence that looks like a real reply
    const sentences = cleaned.split(/(?<=[.!?])\s+/);
    let lastUseful: string | undefined;
    for (let i = sentences.length - 1; i >= 0; i--) {
      const s = sentences[i];
      if (s.length > 10 && s.length < 200 && !/\b(the user|I need to|I should|let me|wait,|hmm|the rules|the tools|the instructions)\b/i.test(s)) {
        lastUseful = s;
        break;
      }
    }
    if (lastUseful) {
      return { reply: lastUseful.trim(), thinking: cleaned };
    }
    return { reply: '', thinking: cleaned };
  }

  const paragraphs = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const reasoningRE = /\b(the user|the tools|the instructions|I need to|I should|let me|the problem|the question|the answer|looking at|first,|second,|wait,|hmm|the response|the correct|the assistant|check the rules|according to|the file|the current|the plan)\b/i;
  const starterRE = /^(Okay|Ok|Alright|Let me|First|Hmm|So,? |Wait|The user|Looking|I need|I should|Now,? |Since|Given|Based on|Check)/i;

  let lastIdx = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    if (reasoningRE.test(paragraphs[i]) || starterRE.test(paragraphs[i])) lastIdx = i;
  }

  if (lastIdx === -1) return { reply: cleaned, thinking: '' };
  if (lastIdx >= paragraphs.length - 1) {
    const last = paragraphs[paragraphs.length - 1];
    const sentences = last.split(/(?<=[.!?])\s+/);
    for (let i = sentences.length - 1; i >= 0; i--) {
      if (!reasoningRE.test(sentences[i]) && sentences[i].length < 200) {
        return {
          reply: sentences.slice(i).join(' ').trim(),
          thinking: [...paragraphs.slice(0, -1), sentences.slice(0, i).join(' ')].join('\n\n').trim(),
        };
      }
    }
    return { reply: cleaned, thinking: '' };
  }

  const reply = paragraphs.slice(lastIdx + 1).join('\n\n');
  const replyChars = reply.replace(/\s/g, '').length;
  if (replyChars < 10 && cleaned.length > reply.length) {
    return { reply: cleaned, thinking: '' };
  }

  return {
    thinking: paragraphs.slice(0, lastIdx + 1).join('\n\n'),
    reply,
  };
}

function normalizeForDedup(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function isGreetingLikeMessage(text: string): boolean {
  const raw = String(text || '').trim();
  if (!raw || raw.length > 120) return false;
  if (/\b(search|open|read|write|file|code|task|build|fix|debug|run|install|http|www\.|\.com|please|could you|can you)\b/i.test(raw)) {
    return false;
  }
  return /^(hi|hello|hey|yo|sup|howdy|good (morning|afternoon|evening)|hey claw|hello claw|hi claw|hey smallclaw|hello smallclaw|hi smallclaw|how are you|你好|您好|嗨|哈喽|嗨喽|在吗|早上好|上午好|中午好|下午好|晚上好|早安|午安|晚安)[!.?\s]*$/i.test(raw);
}

function sanitizeFinalReply(
  text: string,
  opts: { preflightReason?: string } = {},
): string {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';

  const metaPatterns: RegExp[] = [
    /^\s*No tools (are|were) needed for (this|the) greeting\.?\s*$/i,
    /^\s*Greeting only,\s*no tools needed\.?\s*$/i,
    /^\s*Advisor route selected .*$/i,
    /^\s*\[ADVISOR[^\]]*\]\s*$/i,
    /^\s*\[\/ADVISOR[^\]]*\]\s*$/i,
    /^\s*Understood\.?\s*I will execute this objective.*$/i,
  ];

  const reasonNorm = normalizeForDedup(opts.preflightReason || '');
  const parts = raw
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(Boolean)
    .filter((p) => {
      if (metaPatterns.some(re => re.test(p))) return false;
      if (reasonNorm && normalizeForDedup(p) === reasonNorm) return false;
      return true;
    });

  const deduped: string[] = [];
  let prevNorm = '';
  for (const p of parts) {
    const norm = normalizeForDedup(p);
    if (!norm) continue;
    if (norm === prevNorm) continue;
    deduped.push(p);
    prevNorm = norm;
  }

  return deduped.join('\n\n').trim();
}

function stripExplicitThinkTags(text: string): { cleaned: string; thinking: string } {
  const raw = String(text || '');
  if (!raw) return { cleaned: '', thinking: '' };

  const blocks: string[] = [];
  let cleaned = raw.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, inner) => {
    const t = String(inner || '').trim();
    if (t) blocks.push(t);
    return '';
  });

  // Handle dangling open <think> blocks from partial model outputs.
  const openIdx = cleaned.toLowerCase().lastIndexOf('<think>');
  if (openIdx !== -1) {
    const trailing = cleaned
      .slice(openIdx + '<think>'.length)
      .replace(/<\/think>/gi, '')
      .trim();
    if (trailing) blocks.push(trailing);
    cleaned = cleaned.slice(0, openIdx);
  }

  cleaned = cleaned.replace(/<\/think>/gi, '').trim();
  return { cleaned, thinking: blocks.join('\n\n').trim() };
}

// ─── Intent & request classifiers ──────────────────────────────────────────────

function isExecutionLikeRequest(message: string): boolean {
  const m = String(message || '');
  return /\b(create|build|implement|develop|scaffold|generate|fix|debug|edit|update|refactor|rewrite|patch|setup|configure|calendar|app|component|project|file|folder|directory|workspace|code|desktop|window|screen|mouse|keyboard|clipboard|vs code|vscode)\b/i.test(m);
}

function isBrowserAutomationRequest(message: string): boolean {
  const m = String(message || '');
  const hasBrowserVerb = /\b(open|go to|navigate|visit|browse|click|type|fill|press|submit|log ?in|login|use my computer)\b/i.test(m);
  const hasTarget = /(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/\S*)?/i.test(m)
    || /\b(chatgpt|google|reddit|x\.com|twitter|github|youtube)\b/i.test(m);
  return hasBrowserVerb && hasTarget;
}

function isDesktopAutomationRequest(message: string): boolean {
  const m = String(message || '');
  const hasDesktopVerb = /\b(check|look|see|open|focus|click|type|press|read|copy|paste|use my computer|screenshot)\b/i.test(m);
  const hasDesktopTarget = /\b(desktop|screen|window|app|application|vs code|vscode|terminal|notepad|clipboard|codex)\b/i.test(m);
  const statusAsk = /\b(is|did|has).*\b(done|finished|complete|completed)\b/i.test(m);
  return (hasDesktopVerb && hasDesktopTarget) || (statusAsk && /\b(vs code|vscode|codex)\b/i.test(m));
}

function extractLikelyUrl(message: string): string | null {
  const raw = String(message || '');
  const directUrlMatch = raw.match(/\bhttps?:\/\/[^\s)]+/i);
  const domainMatch = raw.match(/\b(?:www\.)?[a-z0-9][a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i);
  const url = (directUrlMatch?.[0] || domainMatch?.[0] || '').trim();
  if (!url) return null;
  const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return normalized.replace(/["'<>]/g, '');
}

function looksLikeSafetyRefusal(text: string): boolean {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return (
    /disallowed|can't (help|assist|do that|use your computer)|cannot (help|assist|do that|use your computer)|unable to (help|assist|do that)/i.test(s)
    || /i (can't|cannot) (control|operate|use) (your|the) computer/i.test(s)
    || /against (policy|safety)/i.test(s)
  );
}

function looksLikeIntentOnlyReply(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return true;

  const intentPattern = /\b(first[, ]|next[, ]|then[, ]|let me|i(?:'| a)?ll|i will|i'm going to|i can|i should|i need to|before i|to start|we should)\b/i;
  const completionPattern = /\b(done|completed|created|updated|fixed|implemented|finished|here(?:'s| is)|built|saved|wrote|ran|executed)\b/i;
  const questionPattern = /\?$/.test(s) || /\bshould i|want me to|do you want\b/i.test(s);

  if (completionPattern.test(s) || questionPattern) return false;
  return intentPattern.test(s);
}

function hasConcreteCompletion(text: string): boolean {
  const s = String(text || '').trim();
  if (!s) return false;
  return /\b(done|completed|created|updated|fixed|implemented|finished|saved|wrote|executed|here(?:'s| is) (?:the|your)|success(?:fully)?)\b/i.test(s);
}

function isBrowserToolName(name: string): boolean {
  return /^browser_(open|snapshot|click|fill|press_key|wait|scroll|close)$/i.test(String(name || ''));
}

function isDesktopToolName(name: string): boolean {
  return /^desktop_(screenshot|find_window|focus_window|click|drag|wait|type|press_key|get_clipboard|set_clipboard)$/i.test(String(name || ''));
}

function isHighStakesFile(filename: string): boolean {
  const f = String(filename || '').toLowerCase();
  return /(auth|billing|payment|security|secret|token|config|credential|oauth|permission|acl)/.test(f);
}

function requestedFullTemplate(message: string): boolean {
  return /\b(full page|full template|full config|full layout|complete page|entire file|whole file)\b/i
    .test(String(message || ''));
}

/**
 * Detects model-tool-call failures where the model emitted tool-call
 * arguments that the provider could not parse as JSON (common with small /
 * local models on llama.cpp: long payloads truncated or escaping broken).
 * The gateway retries such failures once with a corrective hint instead of
 * surfacing the raw provider error.
 */
function isToolArgParseFailure(err: any): boolean {
  const msg = String(err?.message || err || '');
  return /failed to parse tool call arguments/i.test(msg)
    || (/(tool|arguments)/i.test(msg) && /(json|parse)/i.test(msg) && /invalid/i.test(msg));
}

export {
  logToolCall,
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
  isToolArgParseFailure,
};
