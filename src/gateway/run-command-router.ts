/**
 * run-command-router.ts
 *
 * Routing logic for the `run_command` agent tool, extracted from server-v2 so
 * it can be unit-tested without booting the whole gateway.
 *
 * IMPORTANT: run_command is a GUI app launcher, NOT a shell. It accepts a
 * narrow set of forms and returns an empty execCmd for everything else. The
 * rejection message must stay accurate - an inaccurate hint makes small models
 * retry the same rejected command over and over.
 */

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

export const SAFE_COMMANDS: Record<string, string> = isWindows
  ? {
      'chrome': 'start chrome',
      'browser': 'start chrome',
      'firefox': 'start firefox',
      'edge': 'start msedge',
      'notepad': 'start notepad',
      'calc': 'start calc',
      'calculator': 'start calc',
      'explorer': 'start explorer',
      'terminal': 'start cmd',
      'cmd': 'start cmd',
      'powershell': 'start powershell',
      'word': 'start winword',
      'winword': 'start winword',
    }
  : isMac
    ? {
        'chrome': 'open -a "Google Chrome"',
        'browser': 'open',
        'firefox': 'open -a "Firefox"',
        'edge': 'open -a "Microsoft Edge"',
        'notepad': 'open -a "TextEdit"',
        'calc': 'open -a "Calculator"',
        'calculator': 'open -a "Calculator"',
        'explorer': 'open .',
        'terminal': 'open -a "Terminal"',
        'cmd': 'open -a "Terminal"',
        'powershell': 'open -a "Terminal"',
      }
    : {
        'chrome': 'google-chrome',
        'browser': 'xdg-open',
        'firefox': 'firefox',
        'edge': 'microsoft-edge',
        'notepad': 'gedit',
        'calc': 'gnome-calculator',
        'calculator': 'gnome-calculator',
        'explorer': 'xdg-open .',
        'terminal': 'x-terminal-emulator',
        'cmd': 'x-terminal-emulator',
        'powershell': 'pwsh',
      };

export const BLOCKED_PATTERNS = ['del ', 'rm ', 'format', 'shutdown', 'restart', 'rmdir', 'rd /s', 'taskkill', 'reg '];

// Allowlisted apps that may receive a user-supplied argument.
// Deliberately excludes cmd / powershell / terminal: handing an argument to a
// shell binary is equivalent to arbitrary code execution. Browsers are excluded
// too - they have their own dedicated URL branch in resolveRunCommand.
export const ARG_SAFE_COMMANDS: ReadonlySet<string> = isWindows
  ? new Set(['notepad', 'code', 'explorer', 'word', 'winword'])
  : new Set(['notepad', 'code']);

export function quoteShellArg(value: string): string {
  return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

export function buildUrlOpenCommand(url: string): string {
  if (isWindows) return `start "" ${quoteShellArg(url)}`;
  if (isMac) return `open ${quoteShellArg(url)}`;
  return `xdg-open ${quoteShellArg(url)}`;
}

export function buildBrowserLaunchCommand(app: string, url: string): string {
  const appCmd = SAFE_COMMANDS[app] || SAFE_COMMANDS.browser;
  if (isWindows) return `${appCmd} ${quoteShellArg(url)}`;
  if (app === 'browser') return buildUrlOpenCommand(url);
  return `${appCmd} ${quoteShellArg(url)}`;
}

export function hasUriScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(String(value || '').trim());
}

/**
 * Build an actionable "did you mean" hint so the agent can self-correct
 * instead of blindly retrying the same rejected command.
 */
export function suggestRunCommandFix(rawCmd: string): string {
  const trimmed = String(rawCmd || '').trim();
  if (!trimmed) return '';
  // URLs first: "x.com" also looks like a file extension, so checking the file
  // pattern first would wrongly suggest an editor for a web address.
  const urlLike = trimmed.match(/https?:\/\/\S+|www\.\S+/i);
  if (urlLike) return `Did you mean: chrome ${urlLike[0]}`;
  const fileLike = trimmed.match(/[^\s"']+\.[A-Za-z0-9]{1,8}\b/);
  if (fileLike) return `Did you mean: start ${fileLike[0]}`;
  return '';
}

export interface RunCommandResolution {
  /** Command to hand to exec(). Empty string means "rejected". */
  execCmd: string;
  /** Set when the command matched a hard-blocked pattern. */
  blocked?: string;
  /**
   * Local file path (unquoted, possibly relative) that the command opens.
   * Present for app+file / start / open / explorer forms. The caller should
   * verify it exists (resolving relative paths against the workspace) BEFORE
   * exec() — a bad path must never reach the GUI as a popup error.
   */
  targetFile?: string;
}

function stripQuotes(value: string): string {
  const v = String(value || '').trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

/**
 * Resolve a raw run_command string into an executable command.
 * Returns execCmd === '' when the command is not recognised.
 */
export function resolveRunCommand(rawCmdInput: string): RunCommandResolution {
  const rawCmd = String(rawCmdInput || '').trim();
  const cmd = rawCmd.toLowerCase();

  for (const blocked of BLOCKED_PATTERNS) {
    if (cmd.includes(blocked.toLowerCase())) {
      return { execCmd: '', blocked };
    }
  }

  // 1. Allowlisted app, optionally followed by arguments.
  //    Only ARG_SAFE_COMMANDS may take arguments, and every argument is
  //    shell-escaped. Bare app names keep their exact previous behaviour.
  const tokens = rawCmd.split(/\s+/);
  const head = (tokens[0] || '').toLowerCase();
  const rest = tokens.slice(1);
  const base = SAFE_COMMANDS[head];
  if (base && (rest.length === 0 || ARG_SAFE_COMMANDS.has(head))) {
    return {
      execCmd: [base, ...rest.map(quoteShellArg)].join(' '),
      targetFile: rest.length > 0 ? stripQuotes(rest[0]) : undefined,
    };
  }

  // 2. "chrome <url>" or "browser <url>" -> open browser with URL
  if (/^(chrome|browser|firefox|edge)\s+/.test(cmd)) {
    const parts = rawCmd.split(/\s+/);
    const app = parts[0].toLowerCase();
    let url = parts.slice(1).join(' ');
    // Add https:// only when no URI scheme is present.
    // This preserves file://, chrome://, about:, etc.
    if (url && !hasUriScheme(url)) url = 'https://' + url;
    return { execCmd: buildBrowserLaunchCommand(app, url) };
  }

  // 3. URL/URI -> open in default browser
  if (/^(https?:\/\/|file:\/\/|chrome:\/\/|about:|www\.)/.test(cmd)) {
    const url = cmd.startsWith('www.') ? 'https://' + rawCmd : rawCmd;
    return { execCmd: buildUrlOpenCommand(url) };
  }

  // 4. Bare domain like "youtube.com" -> open in browser
  if (/^[a-z0-9-]+\.[a-z]{2,}/.test(cmd) && !cmd.includes(' ')) {
    return { execCmd: buildUrlOpenCommand(`https://${rawCmd}`) };
  }

  // 5. "code <path>" -> VS Code
  if (cmd.startsWith('code ')) {
    return { execCmd: rawCmd, targetFile: stripQuotes(rawCmd.slice(5)) };
  }

  // 6. Windows-only: "start <url>" -> pass through
  if (isWindows && (cmd.startsWith('start http') || cmd.startsWith('start https'))) {
    return { execCmd: rawCmd };
  }

  // 7. Windows-only: "explorer <path>"
  //    (bare "explorer" is already handled by branch 1)
  if (isWindows && cmd.startsWith('explorer ')) {
    return { execCmd: rawCmd, targetFile: stripQuotes(rawCmd.slice(9)) };
  }

  // 8. Windows-only: open a local file with its default app:
  //    "start <file>" / "open <file>" -> `start "" "<path>"`
  //    (URLs are handled earlier; this is for documents, images, etc.)
  if (isWindows) {
    const fileOpen = rawCmd.match(/^(start|open)\s+(.+)$/i);
    if (fileOpen) {
      const target = fileOpen[2].trim();
      // Reject URLs (already covered above) and anything with shell metacharacters.
      // "D:\..." drive paths are not URLs.
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-zA-Z]:[\\/]/.test(target)) {
        return { execCmd: '' };
      }
      if (/[\x00&|<>^%`]/.test(target)) return { execCmd: '' };
      return { execCmd: `start "" ${quoteShellArg(target)}`, targetFile: stripQuotes(target) };
    }
  }

  return { execCmd: '' };
}
