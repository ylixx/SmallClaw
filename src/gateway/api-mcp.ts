/** api-mcp.ts — MCP server/tool management routes extracted from server-v2.ts
 * (Phase 5d-3). deps: resolveModelTier + isOrchestrationSkillEnabled
 * (composition root); getMCPManager/buildTools/applyToolPolicy are imports. */
import express from 'express';
import { getMCPManager } from './mcp-manager';
import { buildTools, applyToolPolicy } from './tool-registry';

export interface McpRouteDeps {
  resolveModelTier: () => Promise<'small' | 'mid' | 'large'>;
  isOrchestrationSkillEnabled: () => boolean;
}

export function registerMcpRoutes(app: express.Express, deps: McpRouteDeps): void {


// GET /api/mcp/servers — server list with live status. Missing previously:
// the front-end list view fell through to the SPA catch-all and got index.html.
app.get('/api/mcp/servers', (_req, res) => {
  try {
    const mgr = getMCPManager();
    const servers = mgr.getStatus().map((s) => ({ ...s, toolCount: s.tools }));
    res.json({ success: true, servers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/mcp/servers', (req, res) => {
  try {
    const mgr = getMCPManager();
    const cfg = req.body;
    if (!cfg.id || !cfg.name) { res.status(400).json({ success: false, error: 'id and name are required' }); return; }
    if (!cfg.id.match(/^[a-z0-9_-]+$/i)) { res.status(400).json({ success: false, error: 'id must be alphanumeric/underscore/dash only' }); return; }
    mgr.upsertConfig(cfg);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/mcp/servers/:id', (req, res) => {
  try {
    const mgr = getMCPManager();
    const deleted = mgr.deleteConfig(req.params.id);
    res.json({ success: deleted, error: deleted ? undefined : 'Server not found' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});



app.post('/api/mcp/servers/:id/connect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    const result = await mgr.connect(req.params.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});



app.post('/api/mcp/servers/:id/disconnect', async (req, res) => {
  try {
    const mgr = getMCPManager();
    await mgr.disconnect(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});



app.get('/api/mcp/tools', (_req, res) => {
  try {
    const mgr = getMCPManager();
    res.json({ success: true, tools: mgr.getAllTools() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});



app.get('/api/tools', async (req, res) => {
  try {
    const sessionId = String(req.query.sessionId || 'default');
    // Resolve the same merged tier the chat path uses, so the UI tool list
    // matches what is actually injected into the prompt for this model.
    const tier = await deps.resolveModelTier();
    const tools = applyToolPolicy(buildTools(tier, { isOrchestrationSkillEnabled: deps.isOrchestrationSkillEnabled }), sessionId);
    res.json({
      success: true,
      sessionId,
      count: tools.length,
      tools: tools.map((t: any) => String(t?.function?.name || '')).filter(Boolean),
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});
}
