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
  private lastScanSig = '';

  constructor(configDir: string) {
    this.dir = path.join(configDir, 'flows');
  }

  /** Directory the flows live in (for diagnostics / listing) */
  get directory(): string {
    return this.dir;
  }

  /**
   * Invalidate the cache automatically when any *.json template is added,
   * removed or modified — so editing a flow file takes effect immediately
   * without a gateway restart. The fingerprint (name+mtime+size per file)
   * also catches same-millisecond writes.
   */
  private scan(): void {
    let sig = '';
    try {
      for (const entry of fs.readdirSync(this.dir).sort()) {
        if (!entry.endsWith('.json')) continue;
        const st = fs.statSync(path.join(this.dir, entry));
        sig += entry + ':' + st.mtimeMs + ':' + st.size + ';';
      }
    } catch {
      sig = ''; // directory missing → treat as empty
    }
    if (sig !== this.lastScanSig) {
      this.lastScanSig = sig;
      this.cache = null;
    }
  }

  /** Reload templates from disk (called on list() if cache is stale). */
  reload(): void {
    this.cache = null;
    this.list();
  }

  list(): FlowTemplate[] {
    this.scan();
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

  // ─── Write-side helpers (create / update / remove) ───────────────────────

  private validateInput(data: any): { ok: boolean; error?: string } {
    const d = data && typeof data === 'object' ? data : {};
    if (!String(d.name || '').trim()) return { ok: false, error: 'Name is required' };
    if (!Array.isArray(d.triggers) || d.triggers.length === 0) {
      return { ok: false, error: 'At least one trigger phrase is required' };
    }
    if (!String(d.instruction || '').trim()) return { ok: false, error: 'Instruction is required' };
    return { ok: true };
  }

  private sanitizeId(raw: string): string {
    return String(raw || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private writeFile(flow: FlowTemplate): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    const target = path.join(this.dir, `${flow.id}.json`);
    fs.writeFileSync(target, JSON.stringify(flow, null, 2), 'utf-8');
    this.cache = null; // invalidate so the next list() rescans immediately
  }

  /**
   * Create a new flow template and persist it to disk. Takes effect
   * immediately (no gateway restart). id is sanitized and defaults to a
   * slug of the name when not provided.
   */
  create(data: any): FlowTemplate {
    const check = this.validateInput(data);
    if (!check.ok) throw new Error(check.error || 'Invalid flow input');
    const id = this.sanitizeId(data.id || String(data.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    if (!id) throw new Error('Invalid flow ID');
    const flow: FlowTemplate = {
      id,
      name: String(data.name || '').trim(),
      triggers: (data.triggers || []).map((t: any) => String(t || '').trim().toLowerCase()).filter(Boolean),
      description: String(data.description || '').trim(),
      skill: String(data.skill || '').trim() || undefined,
      instruction: String(data.instruction || '').trim(),
      output_note: String(data.output_note || '').trim(),
    };
    if (flow.triggers.length === 0) throw new Error('At least one trigger phrase is required');
    this.writeFile(flow);
    console.log(`[flows] Created: ${flow.name} (${flow.id})`);
    return flow;
  }

  /** Update an existing flow template in place. Returns null when unknown. */
  update(id: string, data: any): FlowTemplate | null {
    const existing = this.get(id);
    if (!existing) return null;
    const merged: any = {
      id: existing.id,
      name: data.name !== undefined ? data.name : existing.name,
      triggers: data.triggers !== undefined ? data.triggers : existing.triggers,
      description: data.description !== undefined ? data.description : (existing.description || ''),
      skill: data.skill !== undefined ? data.skill : (existing.skill || ''),
      instruction: data.instruction !== undefined ? data.instruction : existing.instruction,
      output_note: data.output_note !== undefined ? data.output_note : (existing.output_note || ''),
    };
    const check = this.validateInput(merged);
    if (!check.ok) throw new Error(check.error || 'Invalid flow input');
    const flow: FlowTemplate = {
      id: existing.id,
      name: String(merged.name || '').trim(),
      triggers: (merged.triggers || []).map((t: any) => String(t || '').trim().toLowerCase()).filter(Boolean),
      description: String(merged.description || '').trim(),
      skill: String(merged.skill || '').trim() || undefined,
      instruction: String(merged.instruction || '').trim(),
      output_note: String(merged.output_note || '').trim(),
    };
    if (flow.triggers.length === 0) throw new Error('At least one trigger phrase is required');
    this.writeFile(flow);
    console.log(`[flows] Updated: ${flow.name} (${flow.id})`);
    return flow;
  }

  /** Delete a flow template by id. Returns false when unknown. */
  remove(id: string): boolean {
    const target = path.join(this.dir, `${String(id || '').trim()}.json`);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { force: true });
    this.cache = null;
    console.log(`[flows] Deleted: ${id}`);
    return true;
  }
}
