/**
 * Behavioural checks for the run_command router.
 *
 * Run with:  npx tsx tests/run-command-router.check.ts
 *
 * Part 1 = REGRESSION: cases that already worked before the change must keep
 *          producing the exact same command string.
 * Part 2 = NEW: allowlisted apps may now take an escaped argument.
 * Part 3 = SECURITY: shells must never receive arguments (that would be
 *          arbitrary code execution), and blocked patterns stay blocked.
 */

import {
  resolveRunCommand,
  suggestRunCommandFix,
} from '../src/gateway/run-command-router';

let pass = 0;
let fail = 0;

function check(desc: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    pass++;
    console.log(`  PASS  ${desc}`);
  } else {
    fail++;
    console.log(`  FAIL  ${desc}`);
    console.log(`          expected: ${JSON.stringify(expected)}`);
    console.log(`          actual:   ${JSON.stringify(actual)}`);
  }
}

function cmd(input: string): string {
  return resolveRunCommand(input).execCmd;
}

function blocked(input: string): string | undefined {
  return resolveRunCommand(input).blocked;
}

const isWindows = process.platform === 'win32';
console.log(`\nplatform: ${process.platform}${isWindows ? '' : ' (URL/app cases below are Windows expectations)'}\n`);

if (!isWindows) {
  console.log('!! This check script asserts Windows command strings. Skipping.\n');
  process.exit(0);
}

console.log('--- 1. REGRESSION: unchanged behaviour ---');
check('bare notepad', cmd('notepad'), 'start notepad');
check('bare chrome', cmd('chrome'), 'start chrome');
check('bare calc', cmd('calc'), 'start calc');
check('bare calculator alias', cmd('calculator'), 'start calc');
check('bare powershell', cmd('powershell'), 'start powershell');
check('bare cmd', cmd('cmd'), 'start cmd');
check('bare terminal', cmd('terminal'), 'start cmd');
check('case-insensitive app', cmd('Notepad'), 'start notepad');
check('chrome + bare domain', cmd('chrome youtube.com'), 'start chrome "https://youtube.com"');
check('chrome + https url', cmd('chrome https://x.com'), 'start chrome "https://x.com"');
check('firefox + url', cmd('firefox a.com'), 'start firefox "https://a.com"');
check('https url', cmd('https://example.com'), 'start "" "https://example.com"');
check('file:// url', cmd('file:///C:/a.html'), 'start "" "file:///C:/a.html"');
check('www. url', cmd('www.example.com'), 'start "" "https://www.example.com"');
check('bare domain', cmd('youtube.com'), 'start "" "https://youtube.com"');
check('code + path', cmd('code D:\\project'), 'code D:\\project');
check('start + https', cmd('start https://x.com'), 'start https://x.com');

console.log('\n--- 2. NEW: allowlisted app + escaped argument ---');
check('notepad + file', cmd('notepad index.html'), 'start notepad "index.html"');
check('notepad + absolute path', cmd('notepad C:\\tmp\\a.txt'), 'start notepad "C:\\tmp\\a.txt"');
check('code + file still works', cmd('code index.html'), 'code index.html');

console.log('\n--- 3. SECURITY: shells must not take arguments ---');
check('powershell with args rejected', cmd('powershell Get-Process'), '');
check('cmd with args rejected', cmd('cmd /c dir'), '');
check('terminal with args rejected', cmd('terminal echo hi'), '');
check('powershell -c rejected', cmd('powershell -c "rm x"'), '');
check('blocked: rm', blocked('rm foo.txt'), 'rm ');
check('blocked: del', blocked('del a.txt'), 'del ');
check('blocked: taskkill', blocked('taskkill /f /im x.exe'), 'taskkill');
check('blocked: format', blocked('format C:'), 'format');
check('blocked command yields no execCmd', cmd('rm foo.txt'), '');

console.log('\n--- 4. Argument escaping (no command injection) ---');
const injected = cmd('notepad a" & calc');
check('ampersand is quoted, not executed', injected.includes('"&"'), true);
check('injected payload stays inside start notepad', injected.startsWith('start notepad '), true);

console.log('\n--- 5. Rejection message is actionable (P1b) ---');
check('start <file> still rejected', cmd('start index.html'), '');
check('suggests code for a file path', suggestRunCommandFix('start index.html'), 'Did you mean: code index.html');
check('suggests code for bare file', suggestRunCommandFix('report.pdf'), 'Did you mean: code report.pdf');
check('suggests chrome for a url', suggestRunCommandFix('https://x.com'), 'Did you mean: chrome https://x.com');
check('no bogus suggestion for junk', suggestRunCommandFix('asdf'), '');
const rejected = resolveRunCommand('start index.html');
check('rejected command has no execCmd', rejected.execCmd, '');

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
