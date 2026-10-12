/** api-kb.ts — Knowledge base REST routes, extracted from server-v2.ts
 * (Phase 5d-17). KNOWLEDGE_DIR now lives in config-bootstrap (single source). */
import express from 'express';
import { getConfig } from '../config/config';
import { KNOWLEDGE_DIR } from './config-bootstrap';
import { executeKnowledgeTool } from '../tools/knowledge';
import { resolveToolFilePath } from './chat-execution';

export function registerKbRoutes(app: express.Express): void {
// ─── Knowledge base REST (web UI management) ────────────────────────────────
// GET    /api/knowledge          — list + status
// POST   /api/knowledge/add      — { filename } relative to workspace (or path)
// POST   /api/knowledge/remove   — { name }
app.get('/api/knowledge', async (_req, res) => {
  try {
    const [listOut, statusOut] = await Promise.all([
      executeKnowledgeTool('knowledge_list', {}, KNOWLEDGE_DIR),
      executeKnowledgeTool('knowledge_status', {}, KNOWLEDGE_DIR),
    ]);
    res.json({ success: true, files: listOut.files || [], status: statusOut });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/knowledge/add', async (req, res) => {
  try {
    const raw = String(req.body?.filename || req.body?.path || '').trim();
    if (!raw) { res.status(400).json({ success: false, error: 'filename required' }); return; }
    const workspacePath = getConfig().getWorkspacePath();
    const resolved = resolveToolFilePath(workspacePath, raw);
    if (!resolved.ok) { res.status(403).json({ success: false, error: resolved.error }); return; }
    const outcome = await executeKnowledgeTool('knowledge_add', { path: resolved.path }, KNOWLEDGE_DIR);
    res.json({ success: !!outcome.ok, ...(outcome.ok ? { name: outcome.name, chunks: outcome.chunks, total_files: outcome.total_files } : { error: outcome.error }) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/knowledge/remove', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) { res.status(400).json({ success: false, error: 'name required' }); return; }
    const outcome = await executeKnowledgeTool('knowledge_remove', { name }, KNOWLEDGE_DIR);
    res.json({ success: !!outcome.ok, ...(outcome.ok ? { removed: outcome.removed } : { error: outcome.error }) });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});
}
