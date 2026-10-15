#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
render_pptx.py — 把 storyboard.json + 版式库模板渲染成原生可编辑 PPTX。

两阶段：
  1) 在 OOXML(zip) 层把模板中被选中的"单页版式"按 storyboard 顺序复制成新 deck；
  2) 用 python-pptx 按 patterns.json 的槽位映射填文字 / 换图 / 写图表表格 / 写备注。

用法：
  python3 render_pptx.py storyboard.json -o out.pptx
  python3 render_pptx.py storyboard.json -t <模板.pptx> -p <patterns.json> -o out.pptx
  python3 render_pptx.py --list-patterns

默认资产（模板/映射）按 skill 布局（../assets/）与独立布局（./）自动探测。

依赖：python-pptx (pip install python-pptx)
"""

import argparse
import json
import os
import posixpath
import re
import sys
import zipfile
from collections import Counter
from copy import deepcopy

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.oxml.ns import qn

from checks import page_issues, check_chart_spec, TEXT_LIMITS

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_ROOT = os.path.dirname(HERE)


def _default_asset(name):
    """兼容 skill 布局(../assets/)与独立包布局(./ 或 ./assets/)的资产路径探测。"""
    for cand in (os.path.join(SKILL_ROOT, "assets", name),
                 os.path.join(HERE, name),
                 os.path.join(HERE, "assets", name)):
        if os.path.exists(cand):
            return cand
    return os.path.join(SKILL_ROOT, "assets", name)


SLIDE_CT = ("application/vnd.openxmlformats-officedocument"
            ".presentationml.slide+xml")
SLIDE_RT = ("http://schemas.openxmlformats.org/officeDocument"
            "/2006/relationships/slide")

WARNINGS = []


def warn(msg):
    WARNINGS.append(msg)
    print(f"[warn] {msg}", file=sys.stderr)


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = f.read()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        # 网页大模型常把 JSON 包在 ```json 代码块或前后缀文字里，自动提取
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end > start:
            return json.loads(raw[start:end + 1])
        raise


# ---------------------------------------------------------------- 阶段 1
def assemble_deck(template_path, donor_positions, out_path):
    """把模板中 donor_positions(1-based 版式页码, 可重复) 复制成顺序一致的新 deck。"""
    with zipfile.ZipFile(template_path) as z:
        entries = {n: z.read(n) for n in z.namelist()}

    pres = entries["ppt/presentation.xml"].decode("utf-8")
    rels = entries["ppt/_rels/presentation.xml.rels"].decode("utf-8")
    ctypes = entries["[Content_Types].xml"].decode("utf-8")

    # rId -> "slides/slideN.xml"
    rel_map = dict(re.findall(
        r'<Relationship [^>]*Id="(rId\d+)"[^>]*Target="(slides/slide\d+\.xml)"',
        rels))
    order = [rel_map[rid] for rid in re.findall(
        r'<p:sldId [^>]*r:id="(rId\d+)"', pres)]

    donors = []
    for pos in donor_positions:
        if not 1 <= pos <= len(order):
            raise SystemExit(f"模板页码越界: {pos} (模板共 {len(order)} 页)")
        donors.append(order[pos - 1])          # "slides/slideN.xml"

    k = len(donors)
    # 新 slide 部件（沿用 slide1..slideK 命名，rels 逐字复制并剥离 notesSlide）
    new_parts = {}
    for i, donor in enumerate(donors, 1):
        base = os.path.basename(donor)                      # slideN.xml
        src_rels = f"ppt/slides/_rels/{base}.rels"
        new_parts[f"ppt/slides/slide{i}.xml"] = entries[
            f"ppt/slides/{base}"]
        rels_bytes = entries.get(src_rels, b"")
        rels_bytes = re.sub(
            rb'<Relationship [^>]*Type="[^"]*/notesSlide"[^>]*/>', b"",
            rels_bytes)
        new_parts[f"ppt/slides/_rels/slide{i}.xml.rels"] = rels_bytes

    # 图表部件去深拷贝：同一图表被多页复用时，后到者拿到独立副本，
    # 否则 replace_data 会互相覆盖数据。
    part_ct = {m.group(1).lstrip("/"): m.group(2)
               for m in re.finditer(
                   r'<Override PartName="([^"]+)" ContentType="([^"]+)"',
                   ctypes)}
    chart_seen = {}          # 原始 chart 部件名 -> 已分配副本数
    extra_parts = {}
    ct_extra = []

    def clone_with_deps(part_abs, tag):
        """深拷贝一个部件（连同其 _rels 里的依赖），返回新部件绝对名。"""
        dirname, base = posixpath.split(part_abs)
        stem, ext = posixpath.splitext(base)
        new_abs = posixpath.join(dirname, f"{stem}_c{tag}{ext}")
        extra_parts[new_abs] = entries[part_abs]
        if part_abs in part_ct:            # 克隆件需注册 Override
            ct_extra.append(
                f'<Override PartName="/{new_abs}" '
                f'ContentType="{part_ct[part_abs]}"/>')
        rels_abs = posixpath.join(dirname, "_rels", base + ".rels")
        if rels_abs in entries:
            rels_txt = entries[rels_abs].decode("utf-8")

            def repl(m):
                tag_txt = m.group(0)
                if 'TargetMode="External"' in tag_txt:
                    return tag_txt
                tgt = re.search(r'Target="([^"]+)"', tag_txt).group(1)
                dep_abs = posixpath.normpath(posixpath.join(dirname, tgt))
                dep_dir, dep_base = posixpath.split(dep_abs)
                dep_stem, dep_ext = posixpath.splitext(dep_base)
                dep_new = posixpath.join(dep_dir, f"{dep_stem}_c{tag}{dep_ext}")
                if dep_abs in entries:
                    extra_parts[dep_new] = entries[dep_abs]
                    if dep_abs in part_ct:  # 依赖件同样注册 Override
                        ct_extra.append(
                            f'<Override PartName="/{dep_new}" '
                            f'ContentType="{part_ct[dep_abs]}"/>')
                new_tgt = posixpath.join(
                    posixpath.relpath(dep_dir, dirname),
                    f"{dep_stem}_c{tag}{dep_ext}")
                return tag_txt.replace(f'Target="{tgt}"', f'Target="{new_tgt}"')

            rels_txt = re.sub(r"<Relationship [^>]*/>", repl, rels_txt)
            extra_parts[posixpath.join(
                dirname, "_rels", f"{stem}_c{tag}{ext}.rels")] = \
                rels_txt.encode("utf-8")
        return new_abs

    for i in range(1, k + 1):
        rels_name = f"ppt/slides/_rels/slide{i}.xml.rels"
        rels_bytes = new_parts[rels_name]
        rels_txt = rels_bytes.decode("utf-8")

        def repl_slide(m):
            tag_txt = m.group(0)
            if 'relationships/chart"' not in tag_txt:
                return tag_txt
            tgt = re.search(r'Target="([^"]+)"', tag_txt).group(1)
            chart_abs = posixpath.normpath(posixpath.join("ppt/slides", tgt))
            seen = chart_seen.get(chart_abs, 0)
            chart_seen[chart_abs] = seen + 1
            if seen == 0:
                return tag_txt
            new_abs = clone_with_deps(chart_abs, seen)
            new_tgt = posixpath.join(
                posixpath.relpath(posixpath.dirname(new_abs), "ppt/slides"),
                posixpath.basename(new_abs))
            return tag_txt.replace(f'Target="{tgt}"', f'Target="{new_tgt}"')

        rels_txt = re.sub(r"<Relationship [^>]*/>", repl_slide, rels_txt)
        new_parts[rels_name] = rels_txt.encode("utf-8")

    new_parts.update(extra_parts)

    # [Content_Types].xml：清掉旧 slide Override，补新的
    ctypes = re.sub(
        r'<Override PartName="/ppt/slides/slide\d+\.xml"[^>]*/>', "", ctypes)
    adds = "".join(
        f'<Override PartName="/ppt/slides/slide{i}.xml" '
        f'ContentType="{SLIDE_CT}"/>' for i in range(1, k + 1))
    adds += "".join(ct_extra)
    ctypes = ctypes.replace("</Types>", adds + "</Types>")

    # presentation rels：清掉旧 slide 关系，补新关系（rId901+）
    rels = re.sub(
        r'<Relationship [^>]*Type="[^"]*/slide"[^>]*/>', "", rels)
    adds = "".join(
        f'<Relationship Id="rId{900 + i}" Type="{SLIDE_RT}" '
        f'Target="slides/slide{i}.xml"/>' for i in range(1, k + 1))
    rels = rels.replace("</Relationships>", adds + "</Relationships>")

    # presentation.xml：重写 sldIdLst
    lst = "".join(
        f'<p:sldId id="{256 + i}" r:id="rId{900 + i}"/>' for i in range(1, k + 1))
    pres, n = re.subn(r"<p:sldIdLst>.*?</p:sldIdLst>",
                      f"<p:sldIdLst>{lst}</p:sldIdLst>", pres, flags=re.S)
    if n != 1:
        raise SystemExit("presentation.xml 中未找到 sldIdLst")

    # 写出：丢弃全部旧 slide 部件，写入新部件
    drop = re.compile(r"^ppt/slides/slide\d+\.xml$")
    drop_rels = re.compile(r"^ppt/slides/_rels/slide\d+\.xml\.rels$")
    entries["ppt/presentation.xml"] = pres.encode("utf-8")
    entries["ppt/_rels/presentation.xml.rels"] = rels.encode("utf-8")
    entries["[Content_Types].xml"] = ctypes.encode("utf-8")

    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        final = {}
        for name, data in entries.items():
            if drop.match(name) or drop_rels.match(name):
                continue
            final[name] = data
        final.update(new_parts)
        # 裁剪未被引用的媒体素材（未选中的模板页图片），避免输出膨存
        referenced = set()
        for name, data in final.items():
            if not name.endswith(".rels"):
                continue
            base = posixpath.dirname(posixpath.dirname(name))
            for m in re.finditer(rb"<Relationship [^>]*/>", data):
                tag = m.group(0)
                if b'TargetMode="External"' in tag:
                    continue
                t = re.search(rb'Target="([^"]+)"', tag)
                if not t:
                    continue
                tgt = t.group(1).decode("utf-8")
                if tgt.startswith("http"):
                    continue
                referenced.add(posixpath.normpath(posixpath.join(base, tgt)))
        for name in list(final):
            if name.startswith("ppt/media/") and name not in referenced:
                del final[name]
        for name, data in final.items():
            z.writestr(name, data)
    return k


# ---------------------------------------------------------------- 阶段 2
def fill_textframe(tf, value):
    """把文字写进文本框，保留模板首个 run 的字符格式与段落格式。"""
    txBody = tf._txBody
    paras = txBody.findall(qn("a:p"))
    tmpl_pPr = tmpl_rPr = None
    if paras:
        p0 = paras[0]
        pPr = p0.find(qn("a:pPr"))
        if pPr is not None:
            tmpl_pPr = deepcopy(pPr)
        r0 = p0.find(qn("a:r"))
        if r0 is not None:
            rPr = r0.find(qn("a:rPr"))
            if rPr is not None:
                tmpl_rPr = deepcopy(rPr)
    for p in paras:
        txBody.remove(p)

    text = value if isinstance(value, str) else ("" if value is None else str(value))
    lines = text.split("\n") if text else [""]
    for line in lines:
        p = etree.SubElement(txBody, qn("a:p"))
        if tmpl_pPr is not None:
            p.append(deepcopy(tmpl_pPr))
        r = etree.SubElement(p, qn("a:r"))
        if tmpl_rPr is not None:
            r.append(deepcopy(tmpl_rPr))
        t = etree.SubElement(r, qn("a:t"))
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
        t.text = line


def shape_at(slide, idx, pattern_id):
    shapes = list(slide.shapes)
    if not 0 <= idx < len(shapes):
        warn(f"[{pattern_id}] 形状索引 {idx} 越界（该页共 {len(shapes)} 个形状），跳过")
        return None
    return shapes[idx]


def fill_image(slide, shape, path, pattern_id):
    if not os.path.exists(path):
        warn(f"[{pattern_id}] 图片不存在: {path}，保留原占位符")
        return
    try:                                   # 空图片占位符
        shape.insert_picture(path)
        return
    except Exception:
        pass
    blip = shape._element.find(".//" + qn("a:blip"))
    if blip is None:
        warn(f"[{pattern_id}] 形状 {shape.name} 不是图片容器，跳过换图")
        return
    _, rId = slide.part.get_or_add_image_part(path)
    blip.set(qn("r:embed"), rId)


def fill_chart(shape, spec, pattern_id, prefix=""):
    try:
        cats = spec.get("categories") or []
        series = dict(spec.get("series") or {})
        # 长度一致性治理：错配时告警并截断到较短者，避免错位数据静默写入
        for name, vals in list(series.items()):
            if len(vals) != len(cats):
                n = min(len(vals), len(cats))
                warn(f"[{pattern_id}] 图表{prefix}系列 '{name}' 长度 {len(vals)} "
                     f"与 categories 长度 {len(cats)} 不一致，已截断到 {n}")
                series[name] = vals[:n]
        cd = CategoryChartData()
        cd.categories = cats
        for name, vals in series.items():
            cd.add_series(name, vals)
        shape.chart.replace_data(cd)
    except Exception as e:
        warn(f"[{pattern_id}] 图表数据写入失败: {e}")


def fill_table(shape, spec, pattern_id):
    try:
        table = shape.table
        rows = spec["rows"]
        if len(rows) > len(table.rows):
            warn(f"[{pattern_id}] 表格行数不足（模板 {len(table.rows)} 行），多余数据丢弃")
        if rows and max(len(r) for r in rows) > len(table.columns):
            warn(f"[{pattern_id}] 表格列数不足（模板 {len(table.columns)} 列），多余数据丢弃")
        # 先清空整表（避免模板示例数据残留），再写入提供的数据
        for r in range(len(table.rows)):
            for c in range(len(table.columns)):
                val = rows[r][c] if (r < len(rows) and c < len(rows[r])) else ""
                fill_textframe(table.cell(r, c).text_frame, val)
    except Exception as e:
        warn(f"[{pattern_id}] 表格数据写入失败: {e}")


def _fallback_pattern(patterns, page):
    """未知 pattern 时，按字段覆盖与图片槽匹配选一个兜底版式。

    优先"覆盖字段多"，其次"槽位贴近"；返回 pattern id 或 None（无任何可容纳页）。
    """
    fk = set((page.get("fields") or {}).keys())
    has_img = bool(page.get("images"))
    best, best_score = None, None
    for pid, pat in patterns.items():
        slots = set(pat.get("text_slots", {}))
        if has_img and not pat.get("image_slots"):
            continue
        covered = len(fk & slots)
        score = (covered, -abs(len(slots) - len(fk)))
        if best_score is None or score > best_score:
            best, best_score = pid, score
    return best


def render(storyboard, patterns, base_dir, template_path, out_path):
    pages = storyboard["pages"]
    WARNINGS.clear()          # 局部化：每次调用独立收集，重复调用不累积

    # 校验 pattern 与槽位 key（未知 pattern 不中断：兜底替换或跳过）
    skipped = []
    for i, page in enumerate(pages, 1):
        pid = page.get("pattern")
        if pid not in patterns:
            fb = _fallback_pattern(patterns, page)
            if fb:
                warn(f"第 {i} 页 pattern 未知: {pid!r}，已兜底替换为字段兼容版式 '{fb}'")
                page["_intent"] = pid
                page["pattern"] = fb
                pid = fb
            else:
                warn(f"第 {i} 页 pattern 未知: {pid!r} 且无兜底版式，跳过该页")
                skipped.append(page)
                continue
        pat = patterns[pid]
        for msg in page_issues(page, pat):
            warn(f"第 {i} 页 [{pid}] {msg}")

    if skipped:
        pages = [p for p in pages if p not in skipped]
        storyboard = dict(storyboard)
        storyboard["pages"] = pages

    donors = [patterns[p["pattern"]]["slide"] for p in pages]
    assemble_deck(template_path, donors, out_path)

    prs = Presentation(out_path)
    if len(prs.slides) != len(pages):
        raise SystemExit("内部错误：幻灯片数量与 storyboard 不一致")

    for page, slide in zip(pages, prs.slides):
        pid = page["pattern"]
        pat = patterns[pid]
        fields = page.get("fields") or {}

        for key, idx in pat.get("text_slots", {}).items():
            shape = shape_at(slide, idx, pid)
            if shape is None:
                continue
            if not shape.has_text_frame:
                warn(f"[{pid}] 形状 {shape.name} 无文本框（槽位 {key}），跳过")
                continue
            value = fields.get(key) or ""
            fill_textframe(shape.text_frame, value)
            key_base = re.sub(r"\d+$", "", key)
            # 字数上限三级模板无关解析：
            #   ① patterns 版式级 _limits 声明（模板自带规则）→
            #   ② TEXT_LIMITS 语义表（默认模板沉淀，兜底）→
            #   ③ 文本框几何容量估算
            p_limits = pat.get("_limits") or {}
            limit = p_limits.get(key_base) or p_limits.get(key_base.split("_")[-1])
            if not limit:
                limit = (TEXT_LIMITS.get(key_base)
                         or TEXT_LIMITS.get(key_base.split("_")[-1]))
            geom = _estimate_capacity(shape)
            if not limit:
                limit = geom
            if limit and len(value) > limit:
                extra = ""
                if geom and limit != geom and geom < len(value):
                    extra = f"（文本框估算容量约 {geom} 字）"
                warn(f"[{pid}] 槽位 {key} 超长 {len(value)}>{limit} 字，"
                     f"可能溢出版式{extra}: {value[:20]}…")

        for key, idx in pat.get("image_slots", {}).items():
            src = (page.get("images") or {}).get(key)
            if not src:
                continue
            shape = shape_at(slide, idx, pid)
            if shape is None:
                continue
            path = src if os.path.isabs(src) else os.path.join(base_dir, src)
            fill_image(slide, shape, path, pid)

        if page.get("chart") is not None and "chart_slot" in pat:
            shape = shape_at(slide, pat["chart_slot"], pid)
            if shape is not None:
                fill_chart(shape, page["chart"], pid, "chart: ")

        charts = page.get("charts") or {}
        for key, idx in pat.get("chart_slots", {}).items():
            if charts.get(key) is None:
                continue
            shape = shape_at(slide, idx, pid)
            if shape is not None:
                fill_chart(shape, charts[key], pid, f"图表槽位 '{key}': ")

        if page.get("table") is not None and "table_slot" in pat:
            shape = shape_at(slide, pat["table_slot"], pid)
            if shape is not None:
                fill_table(shape, page["table"], pid)

        if page.get("notes"):
            slide.notes_slide.notes_text_frame.text = page["notes"]

    prs.save(out_path)
    return len(pages), list(WARNINGS)


def _estimate_capacity(shape):
    """按文本框真实几何（宽高 + 首段字号）估算可容纳字数。

    参照 GordenPPTSkill compute_capacity 的思路：中文全角字符宽≈字号(pt)，
    行高≈字号×1.3；内部边距留 10% 余量。读不到字号或非文本框（图表/表格/
    图片）返回 None，由调用方回退到 TEXT_LIMITS 语义上限。只用于告警提示，
    不阻断渲染。
    """
    try:
        if shape.has_chart or getattr(shape, "has_table", False):
            return None
        if not shape.has_text_frame:
            return None
        paras = shape.text_frame.paragraphs
        if not paras or not paras[0].runs:
            return None
        font_pt = paras[0].runs[0].font.size
        if font_pt is None or font_pt.pt <= 0:
            return None
        width_pt = shape.width / 12700          # EMU -> pt
        height_pt = shape.height / 12700
        cpl = max(1, int(width_pt / font_pt.pt * 0.95))
        lines = max(1, int(height_pt / (font_pt.pt * 1.3) * 0.9))
        return max(1, cpl * lines)
    except Exception:
        return None


# ================================================================
# 版式多样性优化（原 optimize_layout.py，并入 render 入口）
# ================================================================
DEFAULT_STRUCT = {"cover", "toc", "section", "thanks", "qa", "refs"}


def structural_ids(patterns_raw):
    """结构页 id：优先读 patterns 顶层 _roles 声明（版式库自描述，
    参照 GordenPPTSkill page_roles），没有声明则回退默认硬编码。"""
    roles = patterns_raw.get("_roles") if patterns_raw else None
    if isinstance(roles, dict):
        s = set()
        for v in roles.values():
            if isinstance(v, list):
                s.update(x for x in v if isinstance(x, str))
        if s:
            return s
    return set(DEFAULT_STRUCT)


def build_equiv(patterns, struct_ids):
    """从 patterns.json 自动推导视觉等价候选（扩展即加法）。

    返回 {pattern_id: [候选 pattern_id, ...]}；排除结构页。
    图片/图表/表格承载约束由调用侧 _can_use 叠加。
    """
    items = [(pid, set(pat.get("text_slots", {})))
             for pid, pat in patterns.items() if pid not in struct_ids]
    equiv = {}
    for pid, slots in items:
        cands = []
        for qid, qslots in items:
            if qid == pid:
                continue
            if qslots == slots or (qslots >= slots and len(qslots) - len(slots) <= 1):
                cands.append(qid)
        equiv[pid] = cands
    return equiv


def _compatible(patterns, cand, page):
    """候选版式的 text_slots 必须 ⊇ 本页 fields 全部 key。"""
    fk = set((page.get("fields") or {}).keys())
    slots = set(patterns.get(cand, {}).get("text_slots", {}))
    return fk.issubset(slots)


def _can_use(patterns, cand, page):
    """候选对当前页是否可用：字段兼容 + 图片/图表/表格数据承载约束。"""
    if not _compatible(patterns, cand, page):
        return False
    pat = patterns.get(cand, {})
    # 图片承载：候选有图片槽 → 页面必须有图；页面有图 → 候选必须有图槽（防图被丢弃）
    if pat.get("image_slots") and not (page.get("images") or {}):
        return False
    if (page.get("images") or {}) and not pat.get("image_slots"):
        return False
    has_chart = bool(page.get("chart") or page.get("charts"))
    # 注意 chart_slot 索引可以是 0，不能用 `or` 判断（0 为 falsy）
    cand_chart = pat.get("chart_slot") is not None or bool(pat.get("chart_slots"))
    # 候选需图表数据而页面没有 → 不可选；页面有图表数据而候选接不住 → 不可选
    if cand_chart != has_chart:
        return False
    # 表格同理
    if bool(pat.get("table_slot")) != bool(page.get("table")):
        return False
    return True


def _visual_dup(cand, last, equiv):
    """当前版式与上一页是否视觉重复（含等价族内）。"""
    if cand == last:
        return True
    return last in equiv.get(cand, [])


def optimize(pages, patterns=None, max_repeat=3, struct_ids=None):
    patterns = patterns or {}
    struct_ids = struct_ids if struct_ids is not None else set(DEFAULT_STRUCT)
    equiv = build_equiv(patterns, struct_ids) if patterns else {}
    result = []
    last = None
    freq = Counter()
    for p in pages:
        pat = p["pattern"]
        cand = pat

        # 1) 相邻重复（含等价族内）→ 换等价候选
        alts = equiv.get(cand, [])
        if cand not in struct_ids and alts and _visual_dup(cand, last, equiv):
            for alt in alts:
                if alt != last and _can_use(patterns, alt, p):
                    cand = alt
                    break

        # 2) 全局高频 → 换等价候选（选频次未达上限者）
        if cand not in struct_ids and freq[cand] >= max_repeat:
            for alt in equiv.get(cand, []):
                if freq[alt] < max_repeat and _can_use(patterns, alt, p):
                    cand = alt
                    break

        p2 = dict(p)
        p2["pattern"] = cand
        result.append(p2)
        last = cand
        freq[cand] += 1
    return result


# ================================================================
# 渲染产物质检（原 verify_pptx.py，并入为 verify_storyboard）
# ================================================================
# 模板占位特征词（误报风险高、过于日常化的词不列入）
LEAK_WORDS = [
    "输入相关", "这里可以", "这里输入", "请输入", "这里是标题",
    "输入对应", "点击图片", "输入关键词", "小标题", "20XX",
    "千阳", "广财", "如何更换", "人物姓名", "xxxx",
]


def all_texts(shape_holder, out):
    for sh in shape_holder.shapes:
        if sh.has_text_frame:
            out.append(sh.text_frame.text)
        if getattr(sh, "has_table", False) and sh.has_table:
            for r in range(len(sh.table.rows)):
                for c in range(len(sh.table.columns)):
                    out.append(sh.table.cell(r, c).text_frame.text)


def verify_storyboard(sb, pptx_path, patterns_path=None):
    """storyboard + pptx 对照质检（页数/zip/占位残留/字段对位/图表/表格/notes）。

    返回 0=通过（允许 WARN）/ 1=存在 FAIL。
    """
    errors = warnings = 0
    patterns = None
    leak_words = LEAK_WORDS
    if patterns_path and os.path.exists(patterns_path):
        _raw = load_json(patterns_path)
        # 模板无关性：patterns 顶层 _leak_words 声明本模板占位词，
        # 存在则替换默认列表（换模板只需在 patterns.json 里声明）
        if isinstance(_raw.get("_leak_words"), list) and _raw["_leak_words"]:
            leak_words = [str(w) for w in _raw["_leak_words"]]
        patterns = {k: v for k, v in _raw.items() if not k.startswith("_")}

    with zipfile.ZipFile(pptx_path) as z:
        if z.testzip() is not None:
            errors += 1
            print("  ❌ FAIL: pptx zip 结构损坏")

    prs = Presentation(pptx_path)
    pages = sb["pages"]

    # 1. 页数
    if len(prs.slides) != len(pages):
        errors += 1
        print(f"  ❌ FAIL: 页数不一致: storyboard {len(pages)} 页 vs pptx {len(prs.slides)} 页")
    else:
        print(f"  ✅ 页数一致（{len(pages)} 页）")

    for idx, (page, slide) in enumerate(zip(pages, prs.slides), 1):
        pid = page.get("pattern", "?")
        pat = patterns.get(pid) if patterns else None
        texts = []
        all_texts(slide, texts)

        # 3. 占位残留
        for t in texts:
            for w in leak_words:
                if w in t.lower():
                    errors += 1
                    print(f"  ❌ FAIL: 第{idx}页 [{pid}] 模板占位文字残留: …{t[:24]}…")
                    break

        # 4. 字段对位（有白名单时，未知槽位字段只提示不判 FAIL）
        for k, v in (page.get("fields") or {}).items():
            if v is None or v == "":
                continue
            if pat is not None and k not in pat.get("text_slots", {}):
                warnings += 1
                print(f"  ⚠️ WARN: 第{idx}页 [{pid}] 字段 {k} 不在版式 text_slots 中"
                      f"（输入问题，非产物问题）")
                continue
            if not any(str(v) in t for t in texts):
                errors += 1
                print(f"  ❌ FAIL: 第{idx}页 [{pid}] 字段 {k}={str(v)[:14]!r} 未落到页面")

        # 5. 图表数据
        chart_specs = {}
        if page.get("chart"):
            chart_specs["__single__"] = page["chart"]
        chart_specs.update(page.get("charts") or {})
        if chart_specs:
            # 5a. 数据长度/类型一致性（输入侧把关，直接 FAIL）
            for key, spec in chart_specs.items():
                for issue in check_chart_spec(spec, f"图表 {key} "):
                    errors += 1
                    print(f"  ❌ FAIL: 第{idx}页 [{pid}] {issue}")
            # 5b. 产物侧：渲染出的图表数据应命中 storyboard 期望
            try:
                got = []
                for sh in slide.shapes:
                    if getattr(sh, "has_chart", False) and sh.has_chart:
                        ch = sh.chart
                        got.append(([str(c) for c in ch.plots[0].categories],
                                    {s.name: [round(float(x), 6) for x in s.values]
                                     for s in ch.series}))
                for key, spec in chart_specs.items():
                    # categories 归一化为 str：storyboard 可写数字(如年份 2020)，
                    # PPTX 读回为字符串，全等比较前统一类型避免误报 FAIL
                    want = ([str(c) for c in spec["categories"]],
                            {n: [round(float(x), 6) for x in v]
                             for n, v in spec["series"].items()})
                    if want not in got:
                        errors += 1
                        print(f"  ❌ FAIL: 第{idx}页 [{pid}] 图表 {key} 数据不匹配")
            except Exception as e:
                errors += 1
                print(f"  ❌ FAIL: 第{idx}页 [{pid}] 读取产物图表数据失败: {e}")

        # 6. 表格数据
        if page.get("table"):
            want = [[str(c) for c in row] for row in page["table"]["rows"]]
            matched = False
            for sh in slide.shapes:
                if getattr(sh, "has_table", False) and sh.has_table:
                    t = sh.table
                    got = [[t.cell(r, c).text_frame.text
                            for c in range(len(t.columns))]
                           for r in range(len(t.rows))]
                    if all(got[r][c] == want[r][c]
                           for r in range(len(want))
                           for c in range(len(want[r]))):
                        matched = True
            if not matched:
                errors += 1
                print(f"  ❌ FAIL: 第{idx}页 [{pid}] 表格数据不匹配")

        # 7. notes
        if not page.get("notes"):
            warnings += 1
            print(f"  ⚠️ WARN: 第{idx}页 [{pid}] 无讲稿 notes")

    print(f"\n{'✅ 质检通过' if errors == 0 else '❌ 质检未通过'}"
          f"（{errors} 项失败 / {warnings} 项提醒）")
    return 0 if errors == 0 else 1


def main():
    ap = argparse.ArgumentParser(
        description="storyboard.json + 版式库模板 → PPTX（渲染 + 优化 + 质检三合一）")
    ap.add_argument("storyboard", nargs="?", help="storyboard.json 路径")
    ap.add_argument("-t", "--template",
                    default=_default_asset("template.pptx"),
                    help="版式库模板 pptx（默认 assets/template.pptx）")
    ap.add_argument("-p", "--patterns",
                    default=_default_asset("patterns.json"),
                    help="槽位映射文件（默认 patterns.json）")
    ap.add_argument("-l", "--layout",
                    default=_default_asset("layout_index.json"),
                    help="intent 分类表（默认 layout_index.json，可指向 "
                         "layout_index.wenwei.json 等多模板表）")
    ap.add_argument("-o", "--out", help="输出 pptx 路径")
    ap.add_argument("--list-patterns", action="store_true",
                    help="列出全部版式与槽位后退出")
    ap.add_argument("--optimize", action="store_true",
                    help="渲染前做版式多样性优化（相邻不重复 / 频次上限）")
    ap.add_argument("--max-repeat", type=int, default=3,
                    help="--optimize 时同一内容版式全局最大次数（默认 3）")
    ap.add_argument("--verify", action="store_true",
                    help="渲染后自动质检（存在 FAIL 时退出码 1）")
    ap.add_argument("--verify-only", action="store_true",
                    help="只质检已有产物（-o 指向 pptx，storyboard 对照），不渲染")
    args = ap.parse_args()

    patterns_raw = load_json(args.patterns)
    struct_ids = structural_ids(patterns_raw)
    patterns = {k: v for k, v in patterns_raw.items() if not k.startswith("_")}

    if args.list_patterns:
        for pid, pat in patterns.items():
            keys = ", ".join(pat.get("text_slots", {}))
            imgs = ", ".join(pat.get("image_slots", {}))
            chs = ""
            if pat.get("chart_slot") is not None:
                chs = f"chart@{pat['chart_slot']}"
            if pat.get("chart_slots"):
                chs = ", ".join(f"{k}@{v}" for k, v in pat["chart_slots"].items())
            tbl = f"table@{pat['table_slot']}" if pat.get("table_slot") is not None else ""
            print(f"{pid:<15} 模板第{pat['slide']:>2}页  {pat.get('desc','')}")
            print(f"{'':<15} text: {keys}")
            if imgs:
                print(f"{'':<15} image: {imgs}")
            if chs:
                print(f"{'':<15} chart: {chs}")
            if tbl:
                print(f"{'':<15} table: {tbl}")
        return

    if not args.storyboard or not args.out:
        ap.error("需要 storyboard.json 与 -o 输出路径")

    storyboard = load_json(args.storyboard)

    # 只质检模式：不渲染，直接对照已有产物
    if args.verify_only:
        rc = verify_storyboard(storyboard, args.out, args.patterns)
        sys.exit(rc)

    # 模板无关性：patterns 顶层 _limits（全局槽位字数上限声明）合并进每个版式，
    # 版式级 _limits 优先——换模板只需在 patterns.json 里声明，无需改代码
    _g_limits = patterns_raw.get("_limits") or {}
    if _g_limits:
        for pat in patterns.values():
            pat["_limits"] = {**_g_limits, **pat.get("_limits", {})}

    # 意图层集成（向后兼容）：layout_index.json 存在时，把 storyboard 中的
    # intent 解析为具体 pattern；不存在则行为与原来完全一致。只做最小侵入。
    _li_path = args.layout
    if os.path.exists(_li_path):
        sys.path.insert(0, HERE)
        from resolve_intents import resolve_intents
        _li = {k: v for k, v in load_json(_li_path).items()
               if not k.startswith("_")}
        storyboard = resolve_intents(storyboard, _li, patterns)

    # 版式多样性优化（渲染前，内存中执行，不落中间文件）
    if args.optimize:
        n0 = len(storyboard["pages"])
        storyboard["pages"] = optimize(storyboard["pages"], patterns,
                                       args.max_repeat, struct_ids)
        print(f"✅ 版式优化完成（{n0} 页）")

    base_dir = os.path.dirname(os.path.abspath(args.storyboard))
    n, warnings = render(storyboard, patterns, base_dir, args.template, args.out)
    print(f"✅ 已生成 {args.out}（{n} 页，{len(warnings)} 条警告）")

    # 渲染后质检
    if args.verify:
        rc = verify_storyboard(storyboard, args.out, args.patterns)
        if rc != 0:
            sys.exit(1)


if __name__ == "__main__":
    main()
