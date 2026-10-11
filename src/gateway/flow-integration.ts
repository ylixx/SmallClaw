/**
 * flow-integration.ts — flow template management + done-payload assembly,
 * extracted from server-v2.ts (Phase 4).
 *
 * server-v2 keeps the Express route registration (composition-root duty) but
 * delegates the handler bodies here. `flowsManager` is exported as the single
 * live instance so `handleChat`'s `flowsManager.matchTrigger()` (still in
 * server-v2 until Phase 5) shares the same object — a second copy would make
 * flow auto-trigger silently diverge.
 */
import type { Request, Response } from 'express';
import { FlowsManager } from './flows-manager';
import { getConfigDirPath } from './config-bootstrap';
import { extractFlowArtifacts } from './flow-artifacts';
import { getConfig } from '../config/config';

const CONFIG_DIR_PATH = getConfigDirPath();

// Live singleton shared with server-v2 (handleChat still calls
// flowsManager.matchTrigger there until Phase 5 moves it).
export const flowsManager = new FlowsManager(CONFIG_DIR_PATH);

// Done-event payload shared by /api/flows/:id/run and /api/chat (byte-identical
// assembly, previously duplicated inline at both endpoints).
export function buildFlowDonePayload(result: any, workspacePath?: string) {
  return {
    reply: result.text,
    mode: result.type,
    sections: [{ type: result.type === 'execute' ? 'tool_results' : 'text', content: result.text }],
    thinking: result.thinking,
    results: result.toolResults,
    artifacts: extractFlowArtifacts(result.toolResults, workspacePath || getConfig().getWorkspacePath()),
  };
}

// ─── Flow template handlers (thin passthroughs) ──────────────────────────────

export function listFlows(_req: Request, res: Response): void {
  const flows = flowsManager.list();
  res.json({
    success: true,
    count: flows.length,
    flows: flows.map((f) => ({
      id: f.id,
      name: f.name,
      triggers: f.triggers,
      description: f.description,
      skill: f.skill || null,
      output_note: f.output_note,
    })),
  });
}

export function getFlowById(req: Request, res: Response): void {
  const flow = flowsManager.get(String(req.params.id));
  if (!flow) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
  res.json({ success: true, flow });
}

export function createFlow(req: Request, res: Response): void {
  try {
    const flow = flowsManager.create(req.body || {});
    res.json({ success: true, flow });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function updateFlow(req: Request, res: Response): void {
  try {
    const flow = flowsManager.update(String(req.params.id), req.body || {});
    if (!flow) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
    res.json({ success: true, flow });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message });
  }
}

export function deleteFlow(req: Request, res: Response): void {
  const removed = flowsManager.remove(String(req.params.id));
  if (!removed) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
  res.json({ success: true });
}
