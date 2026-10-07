/**
 * openai-compat-adapter.ts
 * Implements the OpenAI /v1/chat/completions protocol.
 * Used by: llama.cpp, LM Studio, OpenAI (API key).
 *
 * llama.cpp default:  http://localhost:8080
 * LM Studio default:  http://localhost:1234
 * OpenAI:             https://api.openai.com
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResult, GenerateOptions, GenerateResult, ModelInfo, ProviderID } from './LLMProvider';
import { contentToString } from './content-utils';

export interface OpenAICompatConfig {
  endpoint: string;
  /** Static Bearer token (API key). Leave undefined for OAuth-managed tokens. */
  apiKey?: string;
  /** Called just before each request to get a fresh token (OAuth providers). */
  getToken?: () => Promise<string>;
  providerId: ProviderID;
}

export class OpenAICompatAdapter implements LLMProvider {
  readonly id: ProviderID;
  private config: OpenAICompatConfig;

  constructor(config: OpenAICompatConfig) {
    this.id = config.providerId;
    this.config = config;
  }

  private async getAuthHeader(): Promise<string | null> {
    if (this.config.getToken) {
      const token = await this.config.getToken();
      return `Bearer ${token}`;
    }
    if (this.config.apiKey) {
      return `Bearer ${this.config.apiKey}`;
    }
    return null;
  }

  private apiPath(suffix: string): string {
    // OpenAI-compatible services differ in base layout:
    //   - "https://host"             → "https://host/v1/chat/completions" (OpenAI default)
    //   - "https://host/v1"          → "https://host/v1/chat/completions"
    //   - "https://host/api/paas/v4" → "https://host/api/paas/v4/chat/completions" (Zhipu GLM)
    // If the configured endpoint already carries a version segment, use it as-is
    // and drop the version prefix from the path; otherwise append the full path.
    const base = this.config.endpoint.replace(/\/+$/, '');
    const hasVersionSegment = /\/v\d+$/i.test(base);
    return hasVersionSegment ? base + suffix.replace(/^\/v\d+/, '') : base + suffix;
  }

  private async post(path: string, body: object): Promise<any> {
    // Chat against a remote OpenAI-compatible service can occasionally stall
    // (server-side load / cold routing). Use a generous timeout and retry once
    // on timeouts / network errors — HTTP error responses are NOT retried.
    const MAX_ATTEMPTS = 2;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const auth = await this.getAuthHeader();
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (auth) headers['Authorization'] = auth;

        const url = this.apiPath(path);
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw new Error(`${this.id} API error ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.json();
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || err || '');
        const retryable = /aborted due to timeout|fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|temporary redirect/i.test(msg);
        if (!retryable || attempt === MAX_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    throw lastErr;
  }

  private async get(path: string): Promise<any> {
    const auth = await this.getAuthHeader();
    const headers: Record<string, string> = {};
    if (auth) headers['Authorization'] = auth;

    const url = this.apiPath(path);
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`${this.id} API error ${response.status}`);
    return response.json();
  }

  async chat(messages: ChatMessage[], model: string, options?: ChatOptions): Promise<ChatResult> {
    // OpenAI Codex OAuth requires a specific system prompt to validate CLI authorization
    let finalMessages = messages;
    if (this.id === 'openai_codex') {
      const CODEX_SYSTEM = 'You are Codex, based on GPT-5. You are running as a coding agent in the Codex CLI on a user\'s local machine.';
      const hasSystem = messages.length > 0 && messages[0].role === 'system';
      const systemContent = hasSystem ? contentToString(messages[0].content) : '';
      if (!hasSystem) {
        finalMessages = [{ role: 'system', content: CODEX_SYSTEM }, ...messages];
      } else if (!systemContent.includes('Codex')) {
        const mergedSystem = systemContent ? `${CODEX_SYSTEM}\n\n${systemContent}` : CODEX_SYSTEM;
        finalMessages = [{ role: 'system', content: mergedSystem }, ...messages.slice(1)];
      }
    }
    const body: any = {
      model,
      messages: finalMessages,
      temperature: options?.temperature ?? 0.25,
      max_tokens: options?.max_tokens ?? 512,
      stream: false,
    };
    if (Array.isArray(options?.tools) && options!.tools!.length) {
      body.tools = options!.tools;
      body.tool_choice = 'auto';
    }

    const data = await this.post('/v1/chat/completions', body);
    const choice = data.choices?.[0];
    const message: ChatMessage = {
      role: 'assistant',
      content: choice?.message?.content ?? '',
      tool_calls: choice?.message?.tool_calls,
    };
    // Pass usage through (llama-server & OpenAI-compat backends report
    // prompt/completion token counts) so callers can compute tokens/sec.
    return { message, usage: data?.usage };
  }

  async generate(prompt: string, model: string, options?: GenerateOptions): Promise<GenerateResult> {
    // OpenAI-compat servers don't have a /completions generate endpoint equivalent
    // so we wrap as a chat call with system + user message.
    const messages: ChatMessage[] = [];
    if (options?.system) messages.push({ role: 'system', content: options.system });
    messages.push({ role: 'user', content: prompt });

    const body: any = {
      model,
      messages,
      temperature: options?.temperature ?? 0.3,
      max_tokens: options?.max_tokens ?? 512,
      stream: false,
    };
    if (options?.format === 'json') {
      body.response_format = { type: 'json_object' };
    }

    const data = await this.post('/v1/chat/completions', body);
    const content = data.choices?.[0]?.message?.content ?? '';
    return { response: contentToString(content) };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const data = await this.get('/v1/models');
      return (data.data || []).map((m: any) => ({ name: m.id }));
    } catch {
      return [];
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.get('/v1/models');
      return true;
    } catch {
      return false;
    }
  }
}
