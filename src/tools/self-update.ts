/**
 * self-update.ts — SmallClaw Self-Update Tool
 *
 * Allows the AI to trigger a self-update of SmallClaw via a Telegram message
 * or chat command. The tool:
 *   1. Launches self-update.bat detached (so the current gateway can exit)
 *   2. Returns a "starting update" message immediately
 *   3. After the update completes, the restarted gateway sends a Telegram
 *      confirmation message (handled in server-v2.ts startup logic)
 *
 * The AI should tell the user "I'm starting the update now — I'll go offline
 * briefly and message you when I'm back!" before calling this tool.
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { ToolResult } from '../types.js';

// Resolve the SmallClaw root (two levels up from dist/tools/ or src/tools/)
function resolveSmallClawRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export async function executeSelfUpdate(): Promise<ToolResult> {
  const root = resolveSmallClawRoot();
  const batPath = path.join(root, 'self-update.bat');

  if (!fs.existsSync(batPath)) {
    return {
      success: false,
      error: `self-update.bat not found at: ${batPath}. Make sure SmallClaw is properly installed.`,
    };
  }

  // Write a "pending" marker so the restart knows an update was triggered
  // (will be replaced by self-update.bat with SUCCESS or FAILED)
  try {
    const statusDir = path.join(require('os').homedir(), '.smallclaw');
    if (!fs.existsSync(statusDir)) fs.mkdirSync(statusDir, { recursive: true });
    // Don't write yet — self-update.bat will write the final status itself
  } catch {}

  try {
    // Spawn detached so this process can exit cleanly while update runs
    const child = spawn('cmd.exe', ['/c', batPath], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: false, // Show the terminal window so user can see progress
    });
    child.unref(); // Don't keep the Node.js event loop alive for this child

    return {
      success: true,
      stdout: [
        '🦞 Self-update initiated!',
        '',
        'SmallClaw is now:',
        '  1. Pulling the latest code',
        '  2. Rebuilding',
        '  3. Restarting the gateway',
        '',
        'The gateway will go offline briefly (~30-60 seconds).',
        'You will receive a Telegram message when the update is complete.',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to launch self-update: ${err.message}`,
    };
  }
}

export const selfUpdateTool = {
  name: 'self_update',
  description:
    'Trigger a SmallClaw self-update. Pulls latest code, rebuilds, and restarts the gateway. ' +
    'A Telegram message is sent when the update is complete. ' +
    'IMPORTANT: Before calling this tool, tell the user you are starting the update and will message them when back online.',
  execute: executeSelfUpdate,
  schema: {
    // No arguments needed
  },
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
};
