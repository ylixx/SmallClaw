/**
 * view_media — 查看/检视媒体文件（对标 QwenPaw 的 view_media）
 *
 * 设计要点：
 * - 模型本身多模态可直接读图，但缺少一个"检视媒体文件元数据"的专用工具：这个工具补上它。
 * - 校验路径在 workspace 边界内（复用 files.ts 的 isPathAllowed），只读不写。
 * - 返回：路径、大小、MIME、类型分类；对图片（png/jpg/gif/webp/bmp）无依赖解析宽高。
 * - 可选 include_base64：小图（默认 <2MB）附带 base64，便于无法走 Read 的场景直接传给模型。
 * - 视频/音频仅返回容器格式与大小（深度元数据需 ffmpeg，超出范围）。
 */

import fs from 'fs';
import path from 'path';
import { ToolResult } from '../types.js';
import { isPathAllowed } from './files.js';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf',
};

function imageDimensions(buf: Buffer, ext: string): { width?: number; height?: number } {
  try {
    if (ext === '.png') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (ext === '.gif') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (ext === '.bmp') {
      return { width: buf.readUInt32LE(18), height: buf.readUInt32LE(22) };
    }
    if (ext === '.jpg' || ext === '.jpeg') {
      let off = 2;
      while (off < buf.length - 9) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        const len = buf.readUInt16BE(off + 2);
        off += 2 + len;
      }
    }
    if (ext === '.webp') {
      if (buf.toString('ascii', 12, 16) === 'VP8X' && buf.length > 26) {
        const w = (buf.readUInt32LE(24) & 0xffffff) + 1;
        const h = (buf.readUInt32LE(27) & 0xffffff) + 1;
        return { width: w, height: h };
      }
    }
  } catch { /* ignore */ }
  return {};
}

export async function executeViewMedia(args: { path: string; include_base64?: boolean }): Promise<ToolResult> {
  const rawPath = args?.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return { success: false, error: 'Missing or invalid "path".' };
  }
  const resolved = path.resolve(String(rawPath));
  const perm = isPathAllowed(resolved);
  if (!perm.allowed) {
    return { success: false, error: `Path not allowed: ${perm.reason || 'outside workspace'}` };
  }
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File not found: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    return { success: false, error: `Not a regular file: ${resolved}` };
  }

  const ext = path.extname(resolved).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio' : 'other';

  const head = Buffer.alloc(64);
  const fd = fs.openSync(resolved, 'r');
  try { fs.readSync(fd, head, 0, 64, 0); } finally { fs.closeSync(fd); }

  const dims = type === 'image' ? imageDimensions(head, ext) : {};

  const data: any = {
    path: rawPath,
    abs_path: resolved,
    size_bytes: stat.size,
    mime,
    type,
    ...dims,
  };

  if (args.include_base64 && type === 'image' && stat.size <= 2 * 1024 * 1024) {
    const b64 = fs.readFileSync(resolved).toString('base64');
    data.base64 = `data:${mime};base64,${b64}`;
  }

  return {
    success: true,
    data,
    stdout: JSON.stringify(data, null, 2),
  };
}

export const viewMediaTool = {
  name: 'view_media',
  description: 'Inspect a media file (image/video/audio) in the workspace: returns path, size, MIME type, ' +
    'and image dimensions (width/height) parsed without external dependencies. ' +
    'Set include_base64=true for small images (<2MB) to get an inline data-URI the model can read directly. ' +
    'Read-only; path must be within the workspace.',
  execute: executeViewMedia,
  schema: {
    path: 'string (required) - Path to the media file (relative to workspace or absolute within it).',
    include_base64: 'boolean (optional, default false) - For small images, also return an inline base64 data-URI.',
  },
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the media file.' },
      include_base64: { type: 'boolean', description: 'Also return inline base64 for small images.' },
    },
    required: ['path'],
    additionalProperties: true,
  },
};
