#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
resolve_intents.py — 把 storyboard 中的「内容意图(intent)」解析为具体 pattern。

设计原则（见任务书）：
  * 向后兼容：pattern 已写具体名（不在 layout_index）时原样保留。
  * 确定性：不依赖随机数；同分按 pattern 名升序，结果每跑必一致。
  * 不丢字段：候选 text_slots 必须 ⊇ 本页 fields 全部 key，否则淘汰该候选。
  * 扩展即加法：新增版式只改 layout_index.json + patterns.json + 模板。
  * 只依赖标准库。

打分规则（降序；同分按 candidates 声明顺序，确定性）：
  1) 字段兼容（硬条件）：候选 text_slots ⊇ 本页 fields 所有 key，否则淘汰。
  2) 图表承载（硬条件）：本页有 chart/charts → 候选必须有图表槽，否则淘汰。
  3) 表格承载（硬条件）：本页有 table → 候选必须有表格槽，否则淘汰。
  4) 图片匹配：本页有 images → 候选有 image_slots 得 1 分；否则本页无 images → 候选无 image_slots 得 1 分。
  5) 空槽惩罚：本页无图表/表格数据但候选自带图表/表格槽 → 各扣 1 分。
  6) 槽位贴近：-extra_slots（候选槽位数 - 字段数，越小越好）。
  7) 文字超长：字段值超过槽位字数上限（版式级 _limits → TEXT_LIMITS）→ 每超长字段扣 1 分。
  8) 视觉节奏：最近 window 页用过的 pattern 扣 1 分。

失败处理：某 intent 全部候选都不满足硬条件 → 保留原 intent 名、记入顶层
_unresolved_intents，stderr 打 [warn]，不抛异常中断。

用法：
  python resolve_intents.py storyboard.json -l layout_index.json -p patterns.json -o storyboard.resolved.json
  python resolve_intents.py storyboard.json -o -            # 输出到 stdout
"""

import argparse
import json
import os
import re
import sys
from copy import deepcopy

from checks import TEXT_LIMITS


def warn(msg):
    print(f"[warn] {msg}", file=sys.stderr)


def load_json(path):
    """与 render_pptx.py 的 load_json 行为一致：容忍 ```json 代码块/前后缀文字。"""
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end > start:
            return json.loads(raw[start:end + 1])
        raise


def _has_images(page):
    imgs = page.get("images")
    return isinstance(imgs, dict) and len(imgs) > 0


def _has_chart(page):
    return bool(page.get("chart") or page.get("charts"))


def _slot_limit(cand_pat, key):
    """槽位字数上限：版式级 _limits 声明 → checks.TEXT_LIMITS 语义表 → None。"""
    base = re.sub(r"\d+$", "", key)
    p_limits = cand_pat.get("_limits") or {}
    limit = p_limits.get(base) or p_limits.get(base.split("_")[-1])
    if not limit:
        limit = TEXT_LIMITS.get(base) or TEXT_LIMITS.get(base.split("_")[-1])
    return limit


def _score(cand_pat, page, recent_set):
    """返回该候选的得分（越大越好）。硬条件由调用方保证已通过。"""
    fields = page.get("fields") or {}
    fk = set(fields.keys())
    score = 0
    cand_has_img = bool(cand_pat.get("image_slots"))
    # 图片匹配
    if _has_images(page) and cand_has_img:
        score += 1
    elif (not _has_images(page)) and (not cand_has_img):
        score += 1
    # 图表/表格：页面有数据 → 硬条件已淘汰接不住的候选；
    # 页面无数据但候选自带图表/表格槽 → 浪费槽位，扣分
    cand_chart = cand_pat.get("chart_slot") is not None \
        or bool(cand_pat.get("chart_slots"))
    if cand_chart and not _has_chart(page):
        score -= 1
    if cand_pat.get("table_slot") and not page.get("table"):
        score -= 1
    # 槽位贴近：候选槽位数 - 字段数（越小越好）
    extra = len(cand_pat.get("text_slots", {})) - len(fk)
    score += -extra
    # 文字超长：字段值超过槽位语义上限 → 每个超长字段扣 1 分
    for key, val in fields.items():
        if isinstance(val, str) and val:
            limit = _slot_limit(cand_pat, key)
            if limit and len(val) > limit:
                score -= 1
    # 视觉节奏
    if cand_pat.get("_name") in recent_set:
        score -= 1
    return score


def resolve_intents(storyboard, layout_index, patterns, window=2):
    """
    把 storyboard 中的 intent 解析为具体 pattern，返回全新 dict（深拷贝，不改原对象）。

    - 若 page['pattern'] 在 layout_index 中 → 视为 intent，按打分挑一个具体 pattern，
      写入 page['pattern']，原 intent 存入 page['_intent']。
    - 若 page['pattern'] 不在 layout_index（已是具体 pattern 或未知）→ 原样保留。
    - 顶层加 '_unresolved_intents': [(page_no, intent), ...] 记录解析失败的页。
    """
    sb = deepcopy(storyboard)
    pages = sb.get("pages", [])
    unresolved = []
    recent = []  # 已选 pattern 名（按页顺序），用于视觉节奏

    for i, page in enumerate(pages, 1):
        pid = page.get("pattern")
        if pid not in layout_index:
            # 已是具体 pattern 或未知：原样保留（向后兼容）。
            continue

        intent = pid
        candidates = layout_index[intent].get("candidates", [])
        fields = page.get("fields") or {}
        fk = set(fields.keys())
        has_images = _has_images(page)
        has_chart = _has_chart(page)

        eligible = []  # (候选 pattern 名, 在 candidates 中的声明顺序)
        for order, c in enumerate(candidates):
            cp = patterns.get(c)
            if cp is None:
                warn(f"第 {i} 页 intent={intent}: 候选 pattern '{c}' 不在 patterns.json，跳过")
                continue
            cp_slots = set(cp.get("text_slots", {}).keys())
            # 1) 字段兼容（硬条件）
            if not fk.issubset(cp_slots):
                missing = sorted(fk - cp_slots)
                warn(f"第 {i} 页 intent={intent}: 候选 '{c}' 缺少字段 {missing}，淘汰")
                continue
            # 2) 图表承载（硬条件）：页面有图表数据 → 候选必须接得住，防丢数据
            cand_chart = cp.get("chart_slot") is not None \
                or bool(cp.get("chart_slots"))
            if has_chart and not cand_chart:
                warn(f"第 {i} 页 intent={intent}: 候选 '{c}' 无图表槽，"
                     f"页内 chart 数据将丢失，淘汰")
                continue
            # 3) 表格承载（硬条件）：页面有表格数据 → 候选必须接得住
            if page.get("table") and not cp.get("table_slot"):
                warn(f"第 {i} 页 intent={intent}: 候选 '{c}' 无表格槽，"
                     f"页内 table 数据将丢失，淘汰")
                continue
            eligible.append((c, order))

        if not eligible:
            # 全部候选不兼容：保留原 intent 名，记入 _unresolved_intents，不中断。
            warn(f"第 {i} 页 intent={intent}: 无候选版式满足字段/图表/表格承载，保留原 intent 名")
            unresolved.append((i, intent))
            page["_intent"] = intent
            continue

        recent_set = set(recent[-window:]) if window > 0 else set()
        scored = []
        for c, order in eligible:
            cp = dict(patterns[c])
            cp["_name"] = c
            s = _score(cp, page, recent_set)
            scored.append((s, order, c))
        # 降序：得分高者优先；同分按 layout_index 声明顺序（作者偏好），
        # 确定性（声明顺序唯一，无需再按名字兜底）。
        scored.sort(key=lambda x: (-x[0], x[1]))
        best = scored[0][2]
        page["_intent"] = intent
        page["pattern"] = best
        recent.append(best)

    sb["_unresolved_intents"] = unresolved
    return sb


def main():
    ap = argparse.ArgumentParser(
        description="storyboard 中的 intent → 具体 pattern 解析器")
    ap.add_argument("storyboard", help="storyboard.json 路径")
    ap.add_argument("-l", "--layout",
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "layout_index.json"),
                    help="layout_index.json 路径（默认同目录）")
    ap.add_argument("-p", "--patterns",
                    default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "patterns.json"),
                    help="patterns.json 路径（默认同目录）")
    ap.add_argument("-o", "--out", default="-",
                    help="输出路径（- 表示 stdout）")
    args = ap.parse_args()

    storyboard = load_json(args.storyboard)
    li_raw = load_json(args.layout)
    li = {k: v for k, v in li_raw.items() if not k.startswith("_")}
    patterns = load_json(args.patterns)
    patterns = {k: v for k, v in patterns.items() if not k.startswith("_")}

    resolved = resolve_intents(storyboard, li, patterns)

    text = json.dumps(resolved, ensure_ascii=False, indent=2)
    if args.out == "-":
        sys.stdout.write(text + "\n")
    else:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        n_un = len(resolved.get("_unresolved_intents", []))
        print(f"✅ 已解析 {args.out}（{n_un} 个未解析 intent）", file=sys.stderr)


if __name__ == "__main__":
    main()
