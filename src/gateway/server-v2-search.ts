/**
 * server-v2-search.ts — Search & web-fetch providers, extracted verbatim from server-v2.ts.
 *
 * Pure functions: they depend only on getConfig and the global fetch API.
 * Behavior is intentionally unchanged — including the small-model adaptations:
 * results are truncated to ~3000 chars ("plenty for a 4B model") and the top
 * result is auto-fetched with the same waterfall (Tavily → Google → DuckDuckGo).
 */

import { getConfig } from '../config/config';

// ─── Search Providers ─────────────────────────────────────────────────────────

async function tavilySearch(query: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'basic' }),
    });
    if (!response.ok) {
      const err = await response.text();
      return `Tavily search failed (${response.status}): ${err.slice(0, 200)}`;
    }
    const data = await response.json() as any;
    const results = (data.results || []).slice(0, 5).map((r: any, i: number) =>
      `[${i + 1}] ${r.title || 'No title'}\n${r.content?.slice(0, 200) || r.snippet || ''}\nURL: ${r.url || ''}`
    );
    if (!results.length) return `No results found for "${query}".`;
    let output = results.join('\n\n');
    const topUrl = (data.results || [])[0]?.url;
    if (topUrl) {
      console.log(`[v2] TAVILY AUTO-FETCH: ${topUrl.slice(0, 80)}`);
      const pageContent = await webFetch(topUrl);
      if (!pageContent.startsWith('Fetch failed') && !pageContent.startsWith('Fetch error') && !pageContent.startsWith('Fetch timed') && !pageContent.startsWith('Page fetched but very little')) {
        output += '\n\n─── TOP RESULT FULL CONTENT ───\n' + pageContent;
      }
    }
    output += '\n\nOther URLs above can be read with web_fetch if needed.';
    return output;
  } catch (err: any) {
    return `Tavily search error: ${err.message}`;
  }
}

async function googleSearch(query: string): Promise<string> {
  const searchCfg = (getConfig().getConfig() as any).search || {};
  const GOOGLE_API_KEY = (searchCfg.google_api_key || '').trim();
  const GOOGLE_CX = (searchCfg.google_cx || '').trim();
  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    return 'Google search not configured. Add google_api_key and google_cx in Settings → Search.';
  }

  try {
    const encoded = encodeURIComponent(query);
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encoded}&num=5`;
    const response = await fetch(url);

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[v2] Google Search error: ${response.status} ${errText.slice(0, 200)}`);
      return `Search failed (${response.status}). Try again later.`;
    }

    const data = await response.json() as any;
    const items = data.items || [];

    if (items.length === 0) {
      return `No results found for "${query}".`;
    }

    const results = items.slice(0, 5).map((item: any, i: number) => {
      const title = item.title || 'No title';
      const snippet = item.snippet || 'No description';
      const link = item.link || '';
      return `[${i + 1}] ${title}\n${snippet}\nURL: ${link}`;
    });

    let output = results.join('\n\n');

    const topUrl = items[0]?.link;
    if (topUrl) {
      console.log(`[v2] AUTO-FETCH: Fetching top result: ${topUrl.slice(0, 80)}`);
      const pageContent = await webFetch(topUrl);
      if (!pageContent.startsWith('Fetch failed') && !pageContent.startsWith('Fetch error') && !pageContent.startsWith('Fetch timed') && !pageContent.startsWith('Page fetched but very little')) {
        output += '\n\n─── TOP RESULT FULL CONTENT ───\n' + pageContent;
      }
    }

    output += '\n\nOther URLs above can be read with web_fetch if needed.';
    return output;
  } catch (err: any) {
    console.error(`[v2] Google Search error:`, err.message);
    return `Search error: ${err.message}`;
  }
}

async function duckDuckGoSearch(query: string): Promise<string> {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    const html = await webFetch(url);
    return html.startsWith('Content from') ? html : `No DDG results for "${query}".`;
  } catch (err: any) {
    return `DuckDuckGo search error: ${err.message}`;
  }
}

// Unified search router — picks provider based on config
async function webSearch(query: string): Promise<string> {
  const searchCfg = (getConfig().getConfig() as any).search || {};
  const provider = searchCfg.preferred_provider || 'google';
  const tavilyKey = searchCfg.tavily_api_key || '';
  console.log(`[v2] webSearch via ${provider}: ${query.slice(0, 80)}`);

  if (provider === 'tavily' && tavilyKey) {
    return tavilySearch(query, tavilyKey);
  }
  if (provider === 'google') {
    return googleSearch(query);
  }
  if (provider === 'ddg' || provider === 'duckduckgo') {
    return duckDuckGoSearch(query);
  }
  // Fallback: try tavily if key exists, then google, then ddg
  if (tavilyKey) return tavilySearch(query, tavilyKey);
  const googleResult = await googleSearch(query);
  if (!googleResult.includes('not configured')) return googleResult;
  return duckDuckGoSearch(query);
}

// ─── Web Fetch (full page content) ─────────────────────────────────────────────

async function webFetch(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return `Fetch failed (${response.status} ${response.statusText})`;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
      return `Non-text content type: ${contentType}. Cannot extract text.`;
    }

    const html = await response.text();

    // Strip HTML to plain text — remove scripts, styles, tags, then clean whitespace
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    // Truncate to fit in context — ~3000 chars is plenty for a 4B model
    const maxChars = 3000;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars) + '\n\n...(truncated — page had ' + text.length + ' chars total)';
    }

    if (text.length < 50) {
      return `Page fetched but very little text content extracted. The page may be JavaScript-heavy (SPA). Try using browser_open instead.`;
    }

    return `Content from ${url}:\n\n${text}`;
  } catch (err: any) {
    if (err.name === 'AbortError') return 'Fetch timed out after 15s.';
    return `Fetch error: ${err.message}`;
  }
}

export { tavilySearch, googleSearch, duckDuckGoSearch, webSearch, webFetch };
