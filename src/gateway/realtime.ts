/**
 * realtime.ts — SSE/WS broadcast helpers extracted from server-v2.ts.
 *
 * Owns the module-level `wss` singleton and the two pure broadcast helpers:
 *   - `broadcastWS(data)`   pushes JSON frames to every OPEN WebSocket client
 *     (cron ticks, task heartbeats, subagent spawns, boot greeting, …);
 *   - `createSSESender(res)` builds the SSE writer used by chat/flow endpoints.
 *
 * `wss` is assigned once at gateway startup via `setWss` — server-v2 keeps the
 * WebSocketServer construction and `/ws` connection wiring as its composition
 * root duty. This module owns only the live reference, so `broadcastWS` always
 * sees the same instance (a second copy would silently break broadcasts).
 */
import type { WebSocketServer } from 'ws';
import type { Response } from 'express';

// Module-level live singleton: assigned once at gateway startup, read by
// broadcastWS (cron ticks, task heartbeats) after startup.
let wss: WebSocketServer | undefined;

export function setWss(server: WebSocketServer): void {
  wss = server;
}

export function closeWss(): void {
  try { if (wss) wss.close(); } catch {}
}

// ─── WebSocket Broadcast ───────────────────────────────────────────────────────
// wss is assigned after server creation below; broadcastWS is only ever called
// after startup (by cron ticks), so the late assignment is safe.

export function broadcastWS(data: object): void {
  if (!wss) return;
  const msg = JSON.stringify(data);
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1) { // OPEN
      try { client.send(msg); } catch {}
    }
  });
}

// ─── SSE sender ────────────────────────────────────────────────────────────────

export function createSSESender(res: Response): (event: string, data: any) => void {
  return (type: string, data: any) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch {} };
}
