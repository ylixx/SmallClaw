/**
 * lsp-servers — 语言 → 语言服务器命令 发现（对标 QwenPaw 的 _lsp_servers）
 *
 * 设计要点：
 * - languageForFile(): 按扩展名推断 languageId。
 * - detectServerArgv(languageId): 返回启动该语言服务器的 argv，未安装则返回 null。
 * - 优先用 PATH 上已安装的服务；TypeScript/JavaScript 未全局安装时回退到 `npx --yes`
 *   （首次会联网下载，之后走 npm 缓存）；Python 优先 pylsp，否则 pyright-langserver。
 * - 仅探测命令是否存在，不真正启动服务器（启动在 lsp-client 进行）。
 */

import { execSync } from 'child_process';

function hasCommand(name: string): boolean {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execSync(`${cmd} ${name}`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const EXT_TO_LANG: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.swift': 'swift',
  '.kt': 'kotlin',
};

export function languageForFile(absPath: string): string {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  return EXT_TO_LANG[ext] || '';
}

export function displayName(languageId: string): string {
  const map: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go',
    rust: 'Rust', java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', ruby: 'Ruby',
    php: 'PHP', swift: 'Swift', kotlin: 'Kotlin',
  };
  return map[languageId] || languageId;
}

/** 返回该语言的服务器启动 argv，未安装返回 null */
export function detectServerArgv(languageId: string): string[] | null {
  switch (languageId) {
    case 'typescript':
    case 'javascript':
      if (hasCommand('typescript-language-server')) return ['typescript-language-server', '--stdio'];
      // 回退：npx 会按需安装（需要 typescript 依赖，通常项目已带）
      return ['npx', '--yes', 'typescript-language-server', '--stdio'];
    case 'python':
      if (hasCommand('pylsp')) return ['pylsp'];
      // python -m pylsp
      if (hasCommand('python') || hasCommand('python3')) {
        const py = hasCommand('python') ? 'python' : 'python3';
        return [py, '-m', 'pylsp'];
      }
      if (hasCommand('pyright-langserver')) return ['pyright-langserver', '--stdio'];
      return null;
    case 'go':
      return hasCommand('gopls') ? ['gopls'] : null;
    case 'rust':
      return hasCommand('rust-analyzer') ? ['rust-analyzer'] : null;
    default:
      return null;
  }
}
