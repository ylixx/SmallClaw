/** api-flows.ts — flow template CRUD + explicit run routes extracted from
 * server-v2.ts (Phase 5d-7). deps: chat loop singletons (handleChat/addMessage);
 * flowsManager/flow-integration + realtime SSE + busy guard are imports. */
import express from 'express';
import { flowsManager, buildFlowDonePayload, createFlow, updateFlow, deleteFlow } from './flow-integration';
import { createSSESender } from './realtime';
import { getModelBusy, setModelBusy } from './model-busy-guard';

export interface FlowRouteDeps {
  handleChat: (...args: any[]) => Promise<any>;
  addMessage: (sessionId: string, msg: any, opts?: any) => any;
}

export function registerFlowRoutes(app: express.Express, deps: FlowRouteDeps): void {
// ─── Flow templates + run ────────────────────────────────────────────────



// POST /api/flows — create a flow template (persisted to .smallclaw/flows/)
app.post('/api/flows', createFlow);



// POST /api/flows — create a flow template (persisted to .smallclaw/flows/)
app.post('/api/flows', createFlow);



// DELETE /api/flows/:id — remove a flow template
app.delete('/api/flows/:id', deleteFlow);



// DELETE /api/flows/:id — remove a flow template
app.delete('/api/flows/:id', deleteFlow);



// DELETE /api/flows/:id — remove a flow template
app.delete('/api/flows/:id', deleteFlow);



// POST /api/flows/:id/run — execute a flow explicitly (SSE stream, same
// pipeline as /api/chat: agent loop + tools + skills + retries)
app.post('/api/flows/:id/run', async (req, res) => {
  const flow = flowsManager.get(String(req.params.id || ''));
  if (!flow) { res.status(404).json({ success: false, error: 'Flow not found' }); return; }
  const sessionId = String(req.body?.sessionId || 'default');
  const extra = String(req.body?.message || '').trim();

  if (getModelBusy()) {
    res.status(429).json({ success: false, error: 'Model is busy, try again in a moment' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendSSE = createSSESender(res);
  const heartbeat = setInterval(() => sendSSE('heartbeat', { state: 'processing' }), 5000);
  setModelBusy(true);
  const abortSignal = { aborted: false };
  let requestCompleted = false;
  res.on('close', () => {
    if (!requestCompleted && !abortSignal.aborted) {
      abortSignal.aborted = true;
      console.log(`[v2] Flow run aborted — session ${sessionId}, flow ${flow.id}`);
    }
  });

  try {
    const message =
      `请执行流程「${flow.name}」并交付产物。${extra ? `\n用户补充要求：${extra}` : ''}\n\n【执行规范】\n${flow.instruction}`;
    console.log(`[v2] FLOW RUN: ${flow.id} (${flow.name}) session=${sessionId}`);
    const result = await deps.handleChat(
      message,
      sessionId,
      sendSSE,
      undefined,
      abortSignal,
      undefined,
      undefined,
      'interactive',
      true, // suppressFlowTrigger — instruction already injected
    );
    requestCompleted = true;
    if (!abortSignal.aborted) {
      deps.addMessage(sessionId, { role: 'assistant', content: result.text, timestamp: Date.now() });
      sendSSE('final', { text: result.text });
      sendSSE('done', buildFlowDonePayload(result));
    }
  } catch (err: any) {
    requestCompleted = true;
    console.error('[v2] Flow run error:', err?.message || err);
    if (!abortSignal.aborted) sendSSE('error', { message: String(err?.message || err) });
  } finally {
    clearInterval(heartbeat);
    setModelBusy(false);
  }
});


}
