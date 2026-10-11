/** api-auth.ts — gateway auth middleware extracted from server-v2.ts (Phase 5d-2a).
 * Cross-domain middleware used by files/fs/plan/artifacts/approvals/memory/open-path
 * endpoints. Moved here so every route family can import it without pulling
 * server-v2. */
import express from 'express';
import { getConfig } from '../config/config';

// ─── Gateway Auth Middleware ──────────────────────────────────────────────────
// CRIT-03 / CRIT-01 fix: protects approval, memory-confirm, and open-path
// endpoints from unauthenticated access.
//
// Auth strategy (in priority order):
//   1. Bearer token in Authorization header  →  Authorization: Bearer <token>
//   2. X-Gateway-Token header                →  X-Gateway-Token: <token>
//   3. Localhost bypass (127.0.0.1 / ::1)    →  always trusted when no token configured
//
// Token is read from config at request time so it takes effect immediately
// after a config save without requiring a gateway restart.

export function requireGatewayAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const cfg = getConfig().getConfig() as any;
  const configuredToken = String(cfg?.gateway?.auth_token || '').trim();

  // If no token is configured, fall back to localhost-only access.
  if (!configuredToken) {
    const remoteIp = String(
      req.ip ||
      req.socket?.remoteAddress ||
      (req.connection as any)?.remoteAddress ||
      ''
    );
    const isLocalhost =
      remoteIp === '127.0.0.1' ||
      remoteIp === '::1' ||
      remoteIp === '::ffff:127.0.0.1';
    if (isLocalhost) {
      next();
      return;
    }
    res.status(401).json({ error: 'Unauthorized: configure gateway.auth_token to enable remote access to this endpoint.' });
    return;
  }

  // Extract token from Authorization header or X-Gateway-Token header.
  const authHeader = String(req.headers['authorization'] || '');
  const xGatewayToken = String(req.headers['x-gateway-token'] || '');
  let providedToken = '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    providedToken = authHeader.slice('bearer '.length).trim();
  } else if (xGatewayToken) {
    providedToken = xGatewayToken.trim();
  }

  if (!providedToken || providedToken !== configuredToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
