/**
 * tool-registry.ts — 工具描述压缩与模型档位判定（从 server-v2.ts 抽出）
 *
 * 职责（Phase 2a，本轮仅搬这 3 个零耦合纯函数）：
 *  - getModelTier():         根据配置 / 模型 ID 推断模型档位（small | mid | large）
 *  - compactToolDescription(): 取描述首句并截断，用于小模型档位的紧凑化
 *  - applyToolCompactness():  按档位压缩 tool 定义的描述与参数，降低 token 占用
 *
 * 设计约束（见 docs/server-v2-split-plan.md）：
 *  - 本模块不依赖 server-v2 的运行时状态，仅依赖 `import type` 类型与 config 叶子模块，
 *    彻底杜绝循环依赖（server-v2 → tool-registry 单向）。
 *  - buildTools() 因依赖 5 个工具构建器（其中 3 个在 server-v2 内部），留待后续子步骤处理，
 *    不在本轮搬移。
 */

// 仅类型依赖：import type 在编译期被擦除，不会在运行时形成 server-v2 ↔ tool-registry 循环。
import type { ModelTier } from './server-v2';

/**
 * 根据配置或模型 ID 推断模型档位。任何异常均兜底返回 'large'。
 * 通过 require 直接读取 config 叶子模块，避免依赖 server-v2 顶层单例。
 */
export function getModelTier(): ModelTier {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConfig } = require('../config/config.js');
    const cfg = getConfig().getConfig()?.models || {};
    const explicit = String(cfg.tier || '').trim().toLowerCase();
    if (explicit === 'small' || explicit === 'mid' || explicit === 'large') return explicit;
    const modelId = String(cfg.primary || '').toLowerCase();
    if (/[:\-_](0\.5|1|1\.5|2|3|4)b/.test(modelId)) return 'small';
    if (/[:\-_](5|6|7|8|9)b/.test(modelId)) return 'mid';
    return 'large';
  } catch {
    return 'large';
  }
}

/** 取描述首句并截断，用于小模型档位的紧凑化。 */
function compactToolDescription(desc: string, limit = 180): string {
  const trimmed = String(desc || '').trim();
  if (!trimmed) return '';
  const firstSentence = trimmed.split(/(?<=[。.!?])\s+|\n/)[0] || trimmed;
  return firstSentence.slice(0, limit);
}

/**
 * 按档位压缩 tool 定义的描述与参数说明，降低 token 占用。
 * 返回新数组，不修改入参。
 */
export function applyToolCompactness(defs: any[], tier: ModelTier): any[] {
  const descLimit = tier === 'small' ? 180 : 300;
  const paramLimit = tier === 'small' ? 60 : 120;
  return defs.map((d: any) => {
    if (!d?.function) return d;
    const f = d.function;
    const clone = { ...d, function: { ...f } };
    clone.function.description = f.shortDescription || compactToolDescription(f.description || '', descLimit);
    delete clone.function.shortDescription;
    const props = clone.function.parameters?.properties;
    if (props && typeof props === 'object') {
      clone.function.parameters = {
        ...clone.function.parameters,
        properties: Object.fromEntries(
          Object.entries(props).map(([k, v]: [string, any]) => {
            if (!v || typeof v !== 'object') return [k, v];
            const { description, ...rest } = v;
            if (typeof description === 'string') rest.description = description.slice(0, paramLimit);
            return [k, { ...rest }];
          })
        ),
      };
    }
    return clone;
  });
}
