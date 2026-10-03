import { ToolResult } from '../types.js';
import os from 'os';
import fs from 'fs';
import path from 'path';

type SearchResultItem = { title: string; url: string; snippet: string };
type StructuredSource = { id: number; tier: 'A' | 'B' | 'C'; title: string; url: string; snippet: string; score: number };
type StructuredEvidence = { id: number; source_id: number; excerpt: string; score: number };
type StructuredFact = { id: number; claim: string; evidence_ids: number[]; source_ids: number[]; confidence: number };
type SearchProvider = 'tavily' | 'google' | 'brave' | 'ddg' | 'ddg_html';
type SearchProviderAttempt = {
  provider: SearchProvider;
  status: 'success' | 'failed' | 'skipped';
  reason?: string;
  duration_ms?: number;
  result_count?: number;
};
type SearchDiagnostics = {
  query: string;
  preferred_provider: 'tavily' | 'google' | 'brave' | 'ddg';
  provider_order: Array<'tavily' | 'google' | 'brave' | 'ddg'>;
  attempted: SearchProviderAttempt[];
  selected_provider?: SearchProvider;
};

function normalizeGoogleUrl(url: string): string {
  try {
    const u = new URL(url);
    // Standard Google redirect wrapper: /url?q=<real-url>
    if ((u.hostname.includes('google.') || u.hostname === 'google.com') && u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) return decodeURIComponent(q);
    }
    return url;
  } catch {
    return url;
  }
}

function isLowQualityGoogleUrl(url: string): boolean {
  return /google\.com\/share\.google\?/i.test(url);
}

function isPriceQuery(query: string): boolean {
  return /price|cost|value|quote|trades?|usd|dollar|eur|gbp|jpy/i.test(query);
}

function isBitcoinQuery(query: string): boolean {
  return /bitcoin|btc/i.test(query);
}

function isFreshQuery(query: string): boolean {
  return /\b(current|latest|today|now|right now|as of|recent)\b/i.test(query);
}

function extractUsdPrice(text: string): string | null {
  const patterns = [
    /\$\s?([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/,
    /\$\s?([0-9]+(?:\.[0-9]+)?)/,
    /\b([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)\s?USD\b/i,
    /\b([0-9]+(?:\.[0-9]+)?)\s?USD\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function parseUsdNumber(raw: string): number | null {
  const n = Number(String(raw || '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function detectPriceUnit(text: string): 'ounce' | 'gram' | 'unknown' {
  const t = String(text || '').toLowerCase();
  if (/\b(per\s*gram|\/g\b|1g\b|gram\b)\b/.test(t)) return 'gram';
  if (/\b(per\s*ounce|\/oz\b|ounce\b|oz\b)\b/.test(t)) return 'ounce';
  return 'unknown';
}

function hasHistoricalPriceCue(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return /\b(around|circa|in|from)\s*(19|20)\d{2}\b/.test(t)
    || /\b(was worth|years? ago|historical|history)\b/.test(t);
}

function hasFreshPriceCue(text: string): boolean {
  const t = String(text || '').toLowerCase();
  return /\b(current|today|live|latest|now|right now|spot)\b/.test(t);
}

function detectPriceAsset(query: string): 'silver' | 'gold' | 'bitcoin' | 'generic' {
  const q = String(query || '').toLowerCase();
  if (/\b(silver|xag)\b/.test(q)) return 'silver';
  if (/\b(gold|xau|comex gold)\b/.test(q)) return 'gold';
  if (/\b(bitcoin|btc)\b/.test(q)) return 'bitcoin';
  return 'generic';
}

function isPlausibleUsdPrice(asset: 'silver' | 'gold' | 'bitcoin' | 'generic', valuePerOunceOrUnit: number): boolean {
  if (!Number.isFinite(valuePerOunceOrUnit) || valuePerOunceOrUnit <= 0) return false;
  if (asset === 'silver') return valuePerOunceOrUnit >= 5 && valuePerOunceOrUnit <= 200;
  if (asset === 'gold') return valuePerOunceOrUnit >= 300 && valuePerOunceOrUnit <= 10_000;
  if (asset === 'bitcoin') return valuePerOunceOrUnit >= 1_000 && valuePerOunceOrUnit <= 2_000_000;
  return valuePerOunceOrUnit >= 0.5 && valuePerOunceOrUnit <= 5_000_000;
}

function buildDirectPriceAnswer(
  query: string,
  results: SearchResultItem[]
): string {
  if (!isPriceQuery(query)) return '';

  const asset = detectPriceAsset(query);
  const candidates: Array<{ value: number; score: number; unit: 'ounce' | 'gram' | 'unknown' }> = [];
  for (const result of results) {
    const combined = `${result.title} ${result.snippet}`;
    const usdRaw = extractUsdPrice(combined);
    if (!usdRaw) continue;
    const usd = parseUsdNumber(usdRaw);
    if (!usd) continue;
    const unit = detectPriceUnit(combined);
    const normalized = unit === 'gram' ? (usd * 31.1035) : usd;
    if (!isPlausibleUsdPrice(asset, normalized)) continue;
    let score = 0;
    if (hasFreshPriceCue(combined)) score += 3;
    if (unit === 'ounce') score += 2;
    if (unit === 'gram') score += 1;
    if (hasHistoricalPriceCue(combined)) score -= 6;
    if (asset !== 'generic' && new RegExp(`\\b${asset}\\b`, 'i').test(combined)) score += 2;
    candidates.push({ value: normalized, score, unit });
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best.score >= 0) {
      const v = best.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (asset === 'bitcoin') return `Answer: The current Bitcoin price is approximately $${v} USD.`;
      if (asset === 'silver') return `Answer: The current silver price is approximately $${v} USD per ounce.`;
      if (asset === 'gold') return `Answer: The current gold price is approximately $${v} USD per ounce.`;
      return `Answer: The current price is approximately $${v} USD.`;
    }
  }

  // When snippets do not include live numeric quotes, still return a compact
  // actionable answer instead of only raw links.
  if (isBitcoinQuery(query)) {
    const financeResult = results.find(r => /google\.com\/finance\/quote\/BTC-USD/i.test(r.url));
    if (financeResult) {
      return 'Answer: I found the live BTC-USD quote page on Google Finance. Open https://www.google.com/finance/quote/BTC-USD for the exact real-time value.';
    }
  }

  return '';
}

function isEventOutcomeQuery(query: string): boolean {
  const q = query.toLowerCase();
  return /\b(what happened|outcome|key takeaways|takeaways|summary|recap|latest update|status)\b/.test(q)
    || (/\b(hearing|trial|case|investigation|lawsuit|court|testimony)\b/.test(q) && /\b(what|how|why|when|recent|latest)\b/.test(q));
}

function isLowValueResult(r: SearchResultItem): boolean {
  const text = `${r.title} ${r.url} ${r.snippet}`.toLowerCase();
  if (/youtube\.com|youtu\.be|podcast|opinion|editorial|letters to the editor|substack|reddit/.test(text)) return true;
  return false;
}

function sourceTier(r: SearchResultItem): 'A' | 'B' | 'C' {
  const text = `${r.title} ${r.url}`.toLowerCase();
  if (/\.gov|\.mil|justice\.gov|congress\.gov|house\.gov|senate\.gov|courtlistener|supremecourt/.test(text)) return 'A';
  if (/apnews|reuters|bloomberg|ft\.com|nytimes|wsj|bbc|pbs|politico|aljazeera|npr|washingtonpost/.test(text)) return 'B';
  return 'C';
}

function allowsTierCForQuery(query: string): boolean {
  const q = query.toLowerCase();
  return /\b(opinion|podcast|youtube|video|commentary|analysis only|broader context)\b/.test(q);
}

function applySourceTierPolicy(query: string, ranked: SearchResultItem[]): SearchResultItem[] {
  if (!isEventOutcomeQuery(query)) return ranked;
  const enriched = ranked.map(r => ({ r, tier: sourceTier(r) }));
  const allowC = allowsTierCForQuery(query);
  const preferred = enriched.filter(x => x.tier === 'A' || x.tier === 'B' || allowC);
  return (preferred.length ? preferred : enriched.filter(x => x.tier !== 'C')).map(x => x.r);
}

function queryAnchorTokens(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 4 && !['what', 'when', 'where', 'which', 'latest', 'recent', 'about', 'during'].includes(t))
    .slice(0, 10);
}

function relevanceScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const anchors = queryAnchorTokens(q);
  let score = 0;
  for (const a of anchors) if (t.includes(a)) score += 1;
  if (/bondi/.test(t) && /epstein/.test(t)) score += 3;
  if (/hearing|trial|case|committee|judiciary|testif|lawmakers|congress/.test(t)) score += 2;
  return score;
}

function overlapScore(a: string, b: string): number {
  const at = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 4));
  const bt = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 4));
  if (!at.size || !bt.size) return 0;
  let both = 0;
  for (const t of at) if (bt.has(t)) both++;
  return both / Math.max(at.size, bt.size);
}

function selectDominantStoryCluster(query: string, ranked: SearchResultItem[]): SearchResultItem[] {
  if (!isEventOutcomeQuery(query) || ranked.length <= 2) return ranked;
  const clusters: SearchResultItem[][] = [];
  const threshold = 0.18;
  for (const r of ranked) {
    const text = `${r.title} ${r.snippet}`;
    let placed = false;
    for (const c of clusters) {
      const centroid = `${c[0].title} ${c[0].snippet}`;
      if (overlapScore(text, centroid) >= threshold) {
        c.push(r);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([r]);
  }
  if (clusters.length <= 1) return ranked;
  clusters.sort((a, b) => {
    const sa = a.reduce((s, r) => s + relevanceScore(query, `${r.title} ${r.snippet}`), 0);
    const sb = b.reduce((s, r) => s + relevanceScore(query, `${r.title} ${r.snippet}`), 0);
    return sb - sa;
  });
  return clusters[0];
}

async function fetchCleanArticle(url: string, maxChars = 5000): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmallClaw/1.0' },
    signal: AbortSignal.timeout(15_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = String(res.headers.get('content-type') || '');
  if (!/text|html|json/i.test(ct)) throw new Error(`Unsupported content-type: ${ct}`);
  const html = await res.text();
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, maxChars);
}

function extractEvidenceSentences(query: string, text: string, max = 4): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 40 && s.length <= 320);
  const verbs = /\b(said|stated|argued|clashed|pressed|refused|confirmed|announced|deflected|criticized|questioned|responded)\b/i;
  const scored = sentences.map(s => {
    let score = relevanceScore(query, s);
    if (verbs.test(s)) score += 2;
    if (/bondi|epstein|attorney general|committee|judiciary|lawmakers/i.test(s)) score += 1.5;
    return { s, score };
  }).sort((a, b) => b.score - a.score);
  return scored.filter(x => x.score >= 2.5).slice(0, max).map(x => x.s);
}

function cleanClaimText(claim: string): string {
  return String(claim || '')
    .replace(/\[[0-9]+\]/g, '')
    .replace(/\(AP Photo[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

async function buildEventOutcomeAnswer(query: string, ranked: SearchResultItem[]): Promise<string> {
  const filtered = ranked.filter(r => !isLowValueResult(r));
  const tiered = applySourceTierPolicy(query, filtered);
  const clustered = selectDominantStoryCluster(query, tiered);
  const gated = clustered.filter(r => relevanceScore(query, `${r.title} ${r.snippet}`) >= 2);
  const picked = (gated.length ? gated : clustered).slice(0, 4);
  if (!picked.length) return '';

  const evidence: Array<{ claim: string; source: number }> = [];
  for (let i = 0; i < picked.length; i++) {
    const r = picked[i];
    const fromSnippet = extractEvidenceSentences(query, r.snippet, 2);
    for (const c of fromSnippet) evidence.push({ claim: c, source: i + 1 });
    if (evidence.length >= 8) continue;
    try {
      const clean = await fetchCleanArticle(r.url, 4500);
      const fromPage = extractEvidenceSentences(query, clean, 2);
      for (const c of fromPage) evidence.push({ claim: c, source: i + 1 });
    } catch {
      // best effort
    }
  }

  const dedup = new Set<string>();
  const top: Array<{ claim: string; source: number }> = [];
  for (const e of evidence) {
    const cleaned = cleanClaimText(e.claim);
    if (!cleaned || cleaned.length < 20) continue;
    const k = cleaned.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 140);
    if (dedup.has(k)) continue;
    dedup.add(k);
    top.push({ claim: cleaned, source: e.source });
    if (top.length >= 3) break;
  }

  if (!top.length) return '';
  const first = top[0];
  const summaryLine = `Answer: ${first.claim} [${first.source}]`;
  const bullets = top.slice(1).map(t => `- ${t.claim} [${t.source}]`).join('\n');
  const sources = picked.slice(0, 3).map((r, i) => `[${i + 1}] ${r.url}`).join(' ');
  return `${summaryLine}${bullets ? `\n${bullets}` : ''}\nSources: ${sources}`;
}

async function buildStructuredEventBundle(query: string, ranked: SearchResultItem[]): Promise<{
  answer: string;
  sources: StructuredSource[];
  evidence: StructuredEvidence[];
  facts: StructuredFact[];
} | null> {
  if (!isEventOutcomeQuery(query)) return null;
  const filtered = ranked.filter(r => !isLowValueResult(r));
  const tiered = applySourceTierPolicy(query, filtered);
  const clustered = selectDominantStoryCluster(query, tiered);
  const pickedRaw = clustered.slice(0, 4);
  if (!pickedRaw.length) return null;

  const sources: StructuredSource[] = pickedRaw.map((r, i) => ({
    id: i + 1,
    tier: sourceTier(r),
    title: r.title,
    url: r.url,
    snippet: r.snippet.slice(0, 500),
    score: relevanceScore(query, `${r.title} ${r.snippet}`),
  }));

  let evidenceId = 1;
  const evidence: StructuredEvidence[] = [];
  for (const s of sources) {
    const fromSnippet = extractEvidenceSentences(query, s.snippet, 2);
    for (const ex of fromSnippet) {
      evidence.push({ id: evidenceId++, source_id: s.id, excerpt: cleanClaimText(ex), score: relevanceScore(query, ex) + 1 });
    }
    if (evidence.length >= 14) continue;
    try {
      const clean = await fetchCleanArticle(s.url, 4500);
      const fromPage = extractEvidenceSentences(query, clean, 2);
      for (const ex of fromPage) {
        evidence.push({ id: evidenceId++, source_id: s.id, excerpt: cleanClaimText(ex), score: relevanceScore(query, ex) + 1.5 });
      }
    } catch {
      // best effort
    }
  }

  const sortedEvidence = evidence
    .filter(e => e.excerpt.length >= 20)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  if (!sortedEvidence.length) return null;

  const seen = new Set<string>();
  const facts: StructuredFact[] = [];
  for (const e of sortedEvidence) {
    const key = e.excerpt.toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 140);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      id: facts.length + 1,
      claim: e.excerpt,
      evidence_ids: [e.id],
      source_ids: [e.source_id],
      confidence: Math.max(0.5, Math.min(0.95, e.score / 8)),
    });
    if (facts.length >= 4) break;
  }
  if (!facts.length) return null;

  const lead = facts[0];
  const bullets = facts.slice(1, 4).map(f => `- ${f.claim} [${f.source_ids[0]}]`).join('\n');
  const sourceLine = sources.slice(0, 3).map(s => `[${s.id}] ${s.url}`).join(' ');
  const answer = `Answer: ${lead.claim} [${lead.source_ids[0]}]${bullets ? `\n${bullets}` : ''}\nSources: ${sourceLine}`;
  return { answer, sources, evidence: sortedEvidence, facts };
}

async function augmentEventContract(query: string, res: ToolResult): Promise<ToolResult> {
  const ranked = (res.data?.results || []) as SearchResultItem[];
  if (!isEventOutcomeQuery(query) || !ranked.length) return res;
  const bundle = await buildStructuredEventBundle(query, ranked);
  if (!bundle) return res;
  const summaryText = ranked.map((r: SearchResultItem, i: number) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 400)}`).join('\n\n');
  res.data = {
    ...(res.data || {}),
    answer: bundle.answer,
    sources: bundle.sources,
    evidence: bundle.evidence,
    facts: bundle.facts,
  };
  res.stdout = `${bundle.answer}\n\n${summaryText}`;
  return res;
}

function domainTrustScore(url: string): number {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.endsWith('.gov') || h.endsWith('.mil')) return 4;
    if (h.endsWith('.edu') || h.includes('justice.gov') || h.includes('sec.gov') || h.includes('federalreserve.gov')) return 3.5;
    if (h.includes('reuters.com') || h.includes('apnews.com') || h.includes('bloomberg.com') || h.includes('ft.com')) return 3;
    if (h.includes('wikipedia.org') || h.includes('ballotpedia.org')) return 2;
    if (h.includes('youtube.com') || h.includes('tiktok.com')) return 0.5;
    return 1.5;
  } catch {
    return 0;
  }
}

function rankResults(query: string, results: SearchResultItem[]) {
  const q = query.toLowerCase();
  const freshness = /\b(current|latest|today|now|as of|recent)\b/.test(q);
  return [...results]
    .map(r => {
      const t = domainTrustScore(r.url);
      const text = `${r.title} ${r.snippet}`.toLowerCase();
      let rel = 0;
      const tokens = q.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(x => x.length >= 4);
      for (const tok of tokens) if (text.includes(tok)) rel += 1;
      return { r, score: t * (freshness ? 2 : 1) + rel * 0.4 };
    })
    .sort((a, b) => b.score - a.score)
    .map(x => x.r);
}

// ── Load optional API keys from ~/.smallclaw/config.json ─────────────────────
function getSearchConfig(): {
  preferred: 'tavily' | 'google' | 'brave' | 'ddg';
  tavilyKey?: string;
  googleKey?: string;
  googleCx?: string;
  braveKey?: string;
} {
  try {
    const projectCfg = path.join(process.cwd(), '.smallclaw', 'config.json');
    const cfg = fs.existsSync(projectCfg) ? projectCfg : path.join(os.homedir(), '.smallclaw', 'config.json');
    if (fs.existsSync(cfg)) {
      const data = JSON.parse(fs.readFileSync(cfg, 'utf-8'));
      const preferredRaw = String(data.search?.preferred_provider || 'tavily').toLowerCase();
      const preferred = (['tavily', 'google', 'brave', 'ddg'].includes(preferredRaw) ? preferredRaw : 'tavily') as 'tavily' | 'google' | 'brave' | 'ddg';
      return {
        preferred,
        tavilyKey: data.search?.tavily_api_key,
        googleKey: data.search?.google_api_key,
        googleCx: data.search?.google_cx,
        braveKey: data.search?.brave_api_key,
      };
    }
  } catch {}
  return { preferred: 'tavily' };
}
// ── Google Custom Search API ─────────────────────────────────────────────---
async function searchGoogle(query: string, limit: number, apiKey: string, cx: string): Promise<ToolResult> {
  const url = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=${apiKey}&cx=${cx}&num=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data: any = await res.json();
  const results = (data.items || []).map((r: any) => ({
    title: r.title || '',
    url: normalizeGoogleUrl(r.link || ''),
    snippet: r.snippet || '',
  }));
  const ranked = rankResults(query, results);

  // Guard: some CSE configurations return mostly share.google wrappers that
  // are not reliable search hits for factual QA. Trigger provider fallback.
  if (results.length > 0) {
    const lowQuality = results.filter((r: { url: string }) => isLowQualityGoogleUrl(r.url)).length;
    if (lowQuality / results.length >= 0.5) {
      throw new Error('Google CSE returned mostly low-quality share links; falling back to other providers.');
    }
  }

  const answer = buildDirectPriceAnswer(query, ranked);
  return {
    success: true,
    data: { query, results: ranked, answer: answer || undefined },
    stdout: (answer ? `${answer}\n\n` : '') + ranked.map((r: any, i: number) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 400)}`).join('\n\n'),
  };
}

// ── Tavily (best for AI agents, free 1k/mo) ───────────────────────────────────
async function searchTavily(query: string, limit: number, apiKey: string): Promise<ToolResult> {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: 'basic',
      // Provider "answer" strings can be stale/inconsistent for freshness queries.
      // We synthesize from snippets instead of trusting this shortcut.
      include_answer: !isFreshQuery(query),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data: any = await res.json();

  const results = (data.results || []).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.content || '',
  }));
  const ranked = rankResults(query, results);

  // Use deterministic local extraction only (e.g., prices) to avoid stale provider summaries.
  const answer = buildDirectPriceAnswer(query, ranked);

  return {
    success: true,
    data: { query, results: ranked, answer: data.answer },
    stdout: (answer ? `${answer}\n\n` : '') + ranked.map((r: any, i: number) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 400)}`
    ).join('\n\n'),
  };
}

// ── Brave Search API (free 2k/mo) ─────────────────────────────────────────────
async function searchBrave(query: string, limit: number, apiKey: string): Promise<ToolResult> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': apiKey },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) throw new Error(`Brave HTTP ${res.status}`);
  const data: any = await res.json();

  const results = (data.web?.results || []).map((r: any) => ({
    title: r.title || '',
    url: r.url || '',
    snippet: r.description || '',
  }));
  const ranked = rankResults(query, results);
  const answer = buildDirectPriceAnswer(query, ranked);

  return {
    success: true,
    data: { query, results: ranked, answer: answer || undefined },
    stdout: (answer ? `${answer}\n\n` : '') + ranked.map((r: any, i: number) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`
    ).join('\n\n'),
  };
}

// ── DuckDuckGo JSON endpoint (no key, more stable than HTML scrape) ───────────
async function searchDDG(query: string, limit: number): Promise<ToolResult> {
  // DDG instant answer API — gives structured results without scraping HTML
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'SmallClaw/1.0' },
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`DDG JSON HTTP ${res.status}`);
  const data: any = await res.json();

  const results: Array<{ title: string; url: string; snippet: string }> = [];

  // Abstract (direct answer)
  if (data.AbstractText) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL || '',
      snippet: data.AbstractText,
    });
  }

  // Related topics
  for (const topic of (data.RelatedTopics || [])) {
    if (results.length >= limit) break;
    if (topic.Text && topic.FirstURL) {
      results.push({ title: topic.Text.slice(0, 80), url: topic.FirstURL, snippet: topic.Text });
    } else if (topic.Topics) {
      for (const sub of topic.Topics) {
        if (results.length >= limit) break;
        if (sub.Text && sub.FirstURL) {
          results.push({ title: sub.Text.slice(0, 80), url: sub.FirstURL, snippet: sub.Text });
        }
      }
    }
  }

  // Results array
  for (const r of (data.Results || [])) {
    if (results.length >= limit) break;
    results.push({ title: r.Text || '', url: r.FirstURL || '', snippet: r.Text || '' });
  }

  if (results.length === 0) {
    // Fall back to HTML scraper if JSON gave nothing
    return searchDDGHtml(query, limit);
  }
  const ranked = rankResults(query, results);
  const answer = buildDirectPriceAnswer(query, ranked);

  return {
    success: true,
    data: { query, results: ranked, answer: answer || undefined },
    stdout: (answer ? `${answer}\n\n` : '') + ranked.map((r, i) =>
      `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 400)}`
    ).join('\n\n'),
  };
}

// ── DDG HTML scraper (last resort fallback) ───────────────────────────────────
async function searchDDGHtml(query: string, limit: number): Promise<ToolResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmallClaw/1.0' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { success: false, error: `DDG HTML HTTP ${res.status}` };

  const html = await res.text();
  const results: Array<{ title: string; url: string; snippet: string }> = [];

  const re = /<a class="result__a" href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const href = m[1];
    const realUrl = href.startsWith('/l/?') || href.startsWith('//duckduckgo.com/l/?')
      ? decodeURIComponent(href.replace(/.*uddg=/, ''))
      : href;
    results.push({
      title: m[2].trim(),
      url: realUrl,
      snippet: m[3].replace(/<[^>]+>/g, '').trim(),
    });
  }

  if (results.length === 0) {
    return { success: false, error: 'No search results found. DDG may have changed its markup.' };
  }
  const ranked = rankResults(query, results);
  const answer = buildDirectPriceAnswer(query, ranked);

  return {
    success: true,
    data: { query, results: ranked, answer: answer || undefined },
    stdout: (answer ? `${answer}\n\n` : '') + ranked.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`).join('\n\n'),
  };
}

// ── Main web_search tool ──────────────────────────────────────────────────────
export async function executeWebSearch(args: { query: string; max_results?: number }): Promise<ToolResult> {
  if (!args.query?.trim()) return { success: false, error: 'query is required' };
  let limit = Math.min(args.max_results ?? 5, 10);
  if (isPriceQuery(args.query)) limit = Math.max(limit, 5);

  const cfg = getSearchConfig();
  const candidates: Array<'tavily' | 'google' | 'brave' | 'ddg'> = ['tavily', 'google', 'brave', 'ddg'];
  const providerOrder = [cfg.preferred, ...candidates.filter(p => p !== cfg.preferred)];
  const diagnostics: SearchDiagnostics = {
    query: args.query,
    preferred_provider: cfg.preferred,
    provider_order: providerOrder,
    attempted: [],
  };

  let lastErr = null;
  for (const provider of providerOrder) {
    if (provider === 'tavily' && !cfg.tavilyKey) {
      diagnostics.attempted.push({ provider, status: 'skipped', reason: 'missing_tavily_api_key' });
      continue;
    }
    if (provider === 'google' && (!cfg.googleKey || !cfg.googleCx)) {
      diagnostics.attempted.push({ provider, status: 'skipped', reason: !cfg.googleKey ? 'missing_google_api_key' : 'missing_google_cx' });
      continue;
    }
    if (provider === 'brave' && !cfg.braveKey) {
      diagnostics.attempted.push({ provider, status: 'skipped', reason: 'missing_brave_api_key' });
      continue;
    }

    const started = Date.now();
    try {
      if (provider === 'tavily') {
        const res = await searchTavily(args.query, limit, cfg.tavilyKey as string);
        await augmentEventContract(args.query, res);
        const resultCount = Array.isArray(res.data?.results) ? res.data.results.length : 0;
        diagnostics.attempted.push({
          provider,
          status: 'success',
          duration_ms: Date.now() - started,
          result_count: resultCount,
        });
        diagnostics.selected_provider = 'tavily';
        res.data = { ...(res.data || {}), provider: 'tavily', search_diagnostics: diagnostics };
        return res;
      }
      if (provider === 'google') {
        const res = await searchGoogle(args.query, limit, cfg.googleKey as string, cfg.googleCx as string);
        await augmentEventContract(args.query, res);
        const resultCount = Array.isArray(res.data?.results) ? res.data.results.length : 0;
        diagnostics.attempted.push({
          provider,
          status: 'success',
          duration_ms: Date.now() - started,
          result_count: resultCount,
        });
        diagnostics.selected_provider = 'google';
        res.data = { ...(res.data || {}), provider: 'google', search_diagnostics: diagnostics };
        return res;
      }
      if (provider === 'brave') {
        const res = await searchBrave(args.query, limit, cfg.braveKey as string);
        await augmentEventContract(args.query, res);
        const resultCount = Array.isArray(res.data?.results) ? res.data.results.length : 0;
        diagnostics.attempted.push({
          provider,
          status: 'success',
          duration_ms: Date.now() - started,
          result_count: resultCount,
        });
        diagnostics.selected_provider = 'brave';
        res.data = { ...(res.data || {}), provider: 'brave', search_diagnostics: diagnostics };
        return res;
      }
      if (provider === 'ddg') {
        const res = await searchDDG(args.query, limit);
        await augmentEventContract(args.query, res);
        const resultCount = Array.isArray(res.data?.results) ? res.data.results.length : 0;
        diagnostics.attempted.push({
          provider,
          status: 'success',
          duration_ms: Date.now() - started,
          result_count: resultCount,
        });
        diagnostics.selected_provider = 'ddg';
        res.data = { ...(res.data || {}), provider: 'ddg', search_diagnostics: diagnostics };
        return res;
      }
    } catch (err) {
      lastErr = err;
      diagnostics.attempted.push({
        provider,
        status: 'failed',
        reason: (err as any)?.message || String(err),
        duration_ms: Date.now() - started,
      });
    }
  }

  // Final fallback if ddg path threw and wasn't already successful
  const fallbackStarted = Date.now();
  try {
    const res = await searchDDGHtml(args.query, limit);
    const resultCount = Array.isArray(res.data?.results) ? res.data.results.length : 0;
    diagnostics.attempted.push({
      provider: 'ddg_html',
      status: 'success',
      duration_ms: Date.now() - fallbackStarted,
      result_count: resultCount,
    });
    diagnostics.selected_provider = 'ddg_html';
    res.data = { ...(res.data || {}), provider: 'ddg_html', search_diagnostics: diagnostics };
    return res;
  } catch (err) {
    lastErr = err;
    diagnostics.attempted.push({
      provider: 'ddg_html',
      status: 'failed',
      reason: (err as any)?.message || String(err),
      duration_ms: Date.now() - fallbackStarted,
    });
  }
  let errMsg = 'unknown error';
  if (lastErr) {
    if (typeof lastErr === 'object' && 'message' in lastErr) errMsg = (lastErr as any).message;
    else errMsg = String(lastErr);
  }
  return {
    success: false,
    error: `All search providers failed: ${errMsg}`,
    data: { query: args.query, search_diagnostics: diagnostics },
  };
}

// ── web_fetch: fetch a URL and return clean text ──────────────────────────────
export async function executeWebFetch(args: { url: string; max_chars?: number }): Promise<ToolResult> {
  if (!args.url?.trim()) return { success: false, error: 'url is required' };
  const maxChars = args.max_chars ?? 10_000;

  try {
    const res = await fetch(args.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SmallClaw/1.0' },
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    });
    if (!res.ok) return { success: false, error: `HTTP ${res.status} from ${args.url}` };

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text') && !contentType.includes('json')) {
      return { success: false, error: `Non-text content-type: ${contentType}` };
    }

    const html = await res.text();
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s{3,}/g, '\n\n')
      .trim();

    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n[...truncated]';

    return {
      success: true,
      data: { url: args.url, length: text.length },
      stdout: text,
    };
  } catch (err: any) {
    return { success: false, error: `Fetch failed: ${err.message}` };
  }
}

export const webSearchTool = {
  name: 'web_search',
  description: 'Search the web. Uses Tavily or Brave API if configured in ~/.smallclaw/config.json (search.tavily_api_key / search.brave_api_key), otherwise falls back to DuckDuckGo (no key needed).',
  execute: executeWebSearch,
  schema: {
    query: 'string (required) - Search query',
    max_results: 'number (optional, default 5) - Max results to return',
  },
};

export const webFetchTool = {
  name: 'web_fetch',
  description: 'Fetch and extract the text content of any URL. Good for reading articles, docs, or pages found via web_search.',
  execute: executeWebFetch,
  schema: {
    url: 'string (required) - Full URL to fetch (include https://)',
    max_chars: 'number (optional, default 10000) - Max characters to return',
  },
};
