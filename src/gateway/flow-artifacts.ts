/**
 * flow-artifacts.ts — 从工具执行结果里提取“产物文件”，供 SSE done 事件
 * 携带 artifacts 字段，前端据此渲染产物卡片（renderArtifacts）。
 */
import path from 'path';

export interface ToolResultLike {
  name: string;
  args: any;
  result: string;
  error: boolean;
}

/** UI 产物卡片字段（与 web-ui renderArtifacts 对齐） */
export interface FlowArtifact {
  type: string;
  title: string;
  status: string;
  path?: string;
  files?: string[];
}

/** 写文件类工具：成功执行即表示工作区有一个（新写或更新）的产物文件 */
const FILE_WRITE_TOOLS = new Set([
  'create_file',
  'write_file',
  'replace_lines',
  'insert_after',
  'find_replace',
  'append_line',
]);

/**
 * 从工具结果里提取产物文件：
 * - create_file / write_file 明确创建新文件；
 * - replace_lines / insert_after 等编辑类工具在 flow 场景里通常是对
 *   正在生成的产物文件（大文件 skeleton + 分步追加）做后续写入。
 * 同一文件去重。
 */
export function extractFlowArtifacts(toolResults: ToolResultLike[] | undefined, ws: string): FlowArtifact[] {
  const files = new Map<string, string>();
  for (const tr of (toolResults || [])) {
    const name = String(tr.name || '');
    if (!FILE_WRITE_TOOLS.has(name)) continue;
    if (tr.error) continue;
    const fn = String(tr.args?.filename || tr.args?.name || '').trim();
    if (!fn || files.has(fn)) continue;
    files.set(fn, path.join(ws, fn));
  }
  const out: FlowArtifact[] = [];
  for (const [fn, p] of files) {
    out.push({ type: 'file', title: fn, status: 'ok', path: p, files: [fn] });
  }
  return out;
}
