/**
 * flows-manager.ts — lightweight flow-template system ("one-click process fix")
 *
 * Turns recurring multi-step jobs (weekly report, document deep-analysis,
 * data review...) into `.smallclaw/flows/*.json` templates that the agent
 * can run on demand:
 *
 *   1. Chat trigger  — a user message matching a flow's `triggers` makes
 *                      handleChat auto-inject the flow `instruction`, so
 *                      the model follows the fixed process end-to-end.
 *   2. One-click run — POST /api/flows/:id/run executes a flow explicitly.
 *
 * Zero external dependencies: it reuses the existing chat / agent / tool /
 * skill pipeline (skills, doc_ocr, doc_parse_lab, create_file, retries...).
 * Adding a new recurring job = dropping a JSON file into .smallclaw/flows/.
 */

import fs from 'fs';
import path from 'path';

export interface FlowTemplate {
  /** stable id, e.g. "weekly-report" */
  id: string;
  /** human-readable name, e.g. "周报生成" */
  name: string;
  /** phrases that trigger this flow in chat (substring match, lowercased) */
  triggers: string[];
  /** what this flow does in plain language */
  description: string;
  /** optional related skill id (e.g. "analysis-report") */
  skill?: string;
  /** execution spec injected into the model context when the flow runs */
  instruction: string;
  /** deliverable contract shown to the user in the flow list */
  output_note: string;
}

export class FlowsManager {
  private dir: string;
  private cache: FlowTemplate[] | null = null;

  constructor(configDir: string) {
    this.dir = path.join(configDir, 'flows');
  }

  /** Directory the flows live in (for diagnostics / listing) */
  get directory(): string {
    return this.dir;
  }

  /** Reload templates from disk (called on list() if cache is stale). */
  reload(): void {
    this.cache = null;
    this.list();
  }

  list(): FlowTemplate[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.dir)) {
      this.cache = [];
      return this.cache;
    }
    const flows: FlowTemplate[] = [];
    for (const entry of fs.readdirSync(this.dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(this.dir, entry), 'utf-8');
        const parsed = JSON.parse(raw) as Partial<FlowTemplate>;
        if (!parsed.id || !parsed.name || !Array.isArray(parsed.triggers) || !parsed.instruction) {
          console.warn(`[flows] skipping invalid template ${entry}`);
          continue;
        }
        flows.push({
          id: parsed.id,
          name: parsed.name,
          triggers: parsed.triggers.map((t: unknown) => String(t).toLowerCase()),
          description: String(parsed.description || ''),
          skill: parsed.skill || undefined,
          instruction: parsed.instruction,
          output_note: String(parsed.output_note || ''),
        });
      } catch (err: any) {
        console.warn(`[flows] failed to parse ${entry}: ${err?.message || err}`);
      }
    }
    flows.sort((a, b) => a.id.localeCompare(b.id));
    this.cache = flows;
    return flows;
  }

  get(id: string): FlowTemplate | undefined {
    return this.list().find((f) => f.id === id);
  }

  /**
   * Returns the first flow whose trigger phrase appears in the user message.
   * Triggers are designed to be explicit intent phrases ("生成周报", "做深度分析报告"),
   * so substring match is a safe, predictable contract.
   */
  matchTrigger(message: string): FlowTemplate | null {
    const msg = String(message || '').toLowerCase();
    if (!msg) return null;
    for (const flow of this.list()) {
      for (const t of flow.triggers) {
        if (t && msg.includes(t)) return flow;
      }
    }
    return null;
  }
}
