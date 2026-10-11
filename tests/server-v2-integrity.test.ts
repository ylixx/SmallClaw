/**
 * Phase 0 safety net — server-v2 integrity guard (ALWAYS ON, SAFE).
 *
 * WHY THIS DOES NOT IMPORT server-v2.ts:
 * server-v2.ts performs import-time side effects — it calls `server.listen()` at
 * module top-level (line ~10711) and reads config at module load (line ~231),
 * so importing it inside vitest would actually start the HTTP server and bind a
 * port. That is unsafe for a unit-test context and would leave a lingering
 * process. Instead we guard the giant module's public surface with:
 *   (a) static symbol assertions on the SOURCE TEXT (no execution), and
 *   (b) real imports of the three already-extracted, side-effect-free helpers.
 *
 * The heavy lifting for extraction safety is `npm run typecheck` (tsc --noEmit),
 * which catches broken imports/exports across all 14 dependents. This file is a
 * fast always-on tripwire for the most load-bearing symbols, so a bad extraction
 * is caught immediately in `npm test`.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  separateThinkingFromContent,
  sanitizeFinalReply,
  isExecutionLikeRequest,
  mergeOptimizationTier,
  tierFromContextWindow,
} from '../src/gateway/server-v2-text';
import {
  resolveRunCommand,
  quoteShellArg,
  buildUrlOpenCommand,
} from '../src/gateway/run-command-router';

const SRC = fs.readFileSync(path.resolve('src/gateway/server-v2.ts'), 'utf-8');

describe('server-v2.ts public surface (static guard, no execution)', () => {
  it('wires the chat loop via createChatHandler (composition root)', () => {
    // Phase 5c-2: handleChat moved out of server-v2.ts into chat-handler.ts.
    // The gateway now composes it here, closing over the six singletons.
    expect(/const handleChat = createChatHandler\(\{/.test(SRC)).toBe(true);
  });

  it('still exports the app/server module surface', () => {
    // The public surface other modules import (e.g. cli/index.ts, multi-agent.ts).
    expect(/export\s*\{\s*app,\s*server\s*\}\s*;/.test(SRC)).toBe(true);
  });
});

describe('extracted helper modules keep their exports (real imports)', () => {
  it('server-v2-text exports intact', () => {
    expect(typeof separateThinkingFromContent).toBe('function');
    expect(typeof sanitizeFinalReply).toBe('function');
    expect(typeof isExecutionLikeRequest).toBe('function');
    expect(typeof mergeOptimizationTier).toBe('function');
    expect(typeof tierFromContextWindow).toBe('function');
  });

  it('run-command-router exports intact', () => {
    expect(typeof resolveRunCommand).toBe('function');
    expect(typeof quoteShellArg).toBe('function');
    expect(typeof buildUrlOpenCommand).toBe('function');
  });
});
