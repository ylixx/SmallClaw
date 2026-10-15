#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
checks.py — storyboard 页面的共享校验逻辑。

render_pptx.py 用它产生 [warn]（尽量出产物，不中断）；
verify_pptx.py 用它产生 FAIL（质量把关）。
只依赖标准库，可被两个脚本以同目录模块方式导入。

校验项：
  1. 页面字段（fields / images / chart / charts / table）与版式槽位的匹配
  2. 图表数据：categories / series 长度一致性、数值类型
  3. 表格数据：行结构完整性
  4. 占位词残留（模板示例文字未被真实内容替换，参照 GordenPPTSkill 编辑铁律）
"""

# 模板示例占位词：两类。
# SUBSTR = 子串匹配（忽略大小写），如 lorem ipsum 出现在长句里也算残留；
# EXACT  = 整值匹配（strip 后完全相等），如字段值就是"项目名称"——这类词
# 在正文论述中出现（如"项目名称定义见第三章"）是正常内容，不能子串误伤。
SUBSTR_PLACEHOLDERS = [
    "lorem ipsum", "vivamus", "question 1", "question 2", "question 3",
    "question 4", "question 5", "question 6", "question 7", "question 8",
    "key words here", "double click", "click to add", "placeholder",
    "请输入", "单击此处", "双击此处", "此处添加",
    "此处输入", "示例文字", "感谢下载", "稻壳儿", "占位符", "占位文字",
    "待补充内容", "待编辑", "tbd", "todo",
    "[内容]", "[文字]", "[文本]", "[标题]", "[图片]", "[此处]",
]
EXACT_PLACEHOLDERS = {
    "请输入标题", "请输入文本", "项目名称", "项目标题",
}


# 槽位字数上限（语义表，render_pptx 超长告警与 resolve_intents 版式打分共用；
# 优先读 patterns 版式级 _limits 声明，此表兜底。见 PROMPT.md）
TEXT_LIMITS = {
    "title": 16, "t": 16,
    "s": 8, "st": 8, "kw": 8, "lab": 8, "mid": 8,
    "b": 36, "desc": 36, "top": 36, "bot": 36,
    "body": 160, "bio": 80, "caption": 80, "center": 80,
    "en": 40, "d": 6, "pct": 6, "ref": 80, "cap": 12,
    "num": 4, "name": 12, "main": 40, "org": 30, "sub": 40,
    "presenter": 24, "advisor": 24, "source": 16, "table_title": 30,
    "major": 20, "edu": 20, "skill": 20, "work": 20, "honor": 20,
    "contact": 20, "award": 10, "event": 10,
}


def check_placeholder_residue(fields, prefix=""):
    """检查 fields 值中是否残留模板示例占位词，返回问题列表。

    命中 = 字段被提供但值仍是占位示例（AI 漏替换）。子串占位词做
    大小写不敏感的子串匹配；整值占位词要求 strip 后完全相等（避免
    误伤正文论述）。空值跳过（空值由渲染器清空，不算残留）。
    """
    issues = []
    for key, value in (fields or {}).items():
        if value is None or not isinstance(value, str):
            continue
        low = value.lower()
        hit = value.strip() in EXACT_PLACEHOLDERS
        if not hit:
            for word in SUBSTR_PLACEHOLDERS:
                if word in low:
                    hit = True
                    break
        if hit:
            issues.append(
                f"{prefix}槽位 '{key}' 疑似占位词残留: "
                f"{value[:20]}{'…' if len(value) > 20 else ''}")
    return issues


def check_chart_spec(spec, prefix=""):
    """校验单个 chart 数据对象，返回问题列表。"""
    issues = []
    if not isinstance(spec, dict):
        return [f"{prefix}chart 数据不是对象"]
    cats = spec.get("categories")
    series = spec.get("series")
    if not isinstance(cats, list):
        issues.append(f"{prefix}categories 缺失或不是数组")
        cats = []
    if not isinstance(series, dict) or not series:
        issues.append(f"{prefix}series 缺失或不是对象")
        series = series or {}
    for name, vals in series.items():
        if not isinstance(vals, list):
            issues.append(f"{prefix}系列 '{name}' 不是数值数组")
            continue
        if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                   for v in vals):
            issues.append(f"{prefix}系列 '{name}' 含非数值元素")
        if cats and len(vals) != len(cats):
            issues.append(
                f"{prefix}系列 '{name}' 长度 {len(vals)} 与 categories "
                f"长度 {len(cats)} 不一致")
    return issues


def check_table_spec(spec, prefix=""):
    """校验表格数据对象，返回问题列表。"""
    if not isinstance(spec, dict):
        return [f"{prefix}table 数据不是对象"]
    rows = spec.get("rows")
    if not isinstance(rows, list) or not rows:
        return [f"{prefix}rows 缺失或为空"]
    widths = {len(r) for r in rows}
    if len(widths) > 1:
        issues = [f"{prefix}表格各行长度不一致: {sorted(widths)}"]
    else:
        issues = []
    for r, row in enumerate(rows, 1):
        if not isinstance(row, list):
            issues.append(f"{prefix}第 {r} 行不是数组")
    return issues


def page_issues(page, pat):
    """page vs 版式定义(patterns.json 条目) 的完整校验，返回问题列表。

    只做结构性检查（槽位匹配、chart/table 数据），不做字段值长度检查
    （超长告警在 render_pptx 内按 TEXT_LIMITS 做）；占位词残留属内容
    质量问题，两侧都报。
    """
    issues = []
    issues += check_placeholder_residue(page.get("fields") or {}, "字段: ")
    for key in (page.get("fields") or {}):
        if key not in pat.get("text_slots", {}):
            issues.append(f"未知文本槽位 '{key}'，忽略")
    for key in (page.get("images") or {}):
        if key not in pat.get("image_slots", {}):
            issues.append(f"未知图片槽位 '{key}'，忽略")
    if page.get("chart") is not None and "chart_slot" not in pat:
        issues.append("该版式不支持 chart，忽略")
    if page.get("chart") is not None and "chart_slot" in pat \
            and pat.get("chart_native") is not True:
        issues.append("图表槽未标注 chart_native，chart 数据可能无法写入，忽略")
    if page.get("charts") is not None:
        for key, spec in (page.get("charts") or {}).items():
            if key not in pat.get("chart_slots", {}):
                issues.append(f"未知图表槽位 '{key}'，忽略")
                continue
            if pat.get("chart_native") is not True:
                issues.append(f"图表槽位 '{key}' 未标注 chart_native，数据可能无法写入，忽略")
            issues += check_chart_spec(spec, f"图表槽位 '{key}': ")
    if page.get("chart") is not None and "chart_slot" in pat:
        issues += check_chart_spec(page["chart"], "chart: ")
    if page.get("table") is not None and "table_slot" not in pat:
        issues.append("该版式不支持 table，忽略")
    if page.get("table") is not None and "table_slot" in pat:
        issues += check_table_spec(page["table"], "table: ")
    return issues


def page_compat(page, pat):
    """page vs 版式定义 的分级兼容检查（viewer 服务端预计算专用）。

    返回 {"bads": [...], "warns": [...], "ok": bool}
      bads  = 渲染会丢失内容/产生占位的硬问题
              （多余字段、版式接不住的数据、图表/表格数据本身有误）
      warns = 渲染能出但可能不理想（版式需图表/表格/图片数据而页面未提供）

    规则与 page_issues 同源：bads + warns 的内容覆盖 page_issues 的全部
    检查项，只是按严重度分级；viewer 不再各自写一份前端判断。
    """
    bads, warns = [], []
    bads += [f"占位词: {m}" for m in
             check_placeholder_residue(page.get("fields") or {}, "")]
    extra_f = [k for k in (page.get("fields") or {})
               if k not in pat.get("text_slots", {})]
    if extra_f:
        bads.append("缺字段: " + ", ".join(extra_f))
    extra_i = [k for k in (page.get("images") or {})
               if k not in pat.get("image_slots", {})]
    if extra_i:
        bads.append("缺图片槽: " + ", ".join(extra_i))
    if page.get("chart") is not None and "chart_slot" not in pat:
        bads.append("该版式不支持 chart")
    if page.get("chart") is not None and "chart_slot" in pat \
            and pat.get("chart_native") is not True:
        bads.append("图表槽未标注 chart_native，chart 数据可能无法写入")
    if page.get("charts") is not None:
        for key, spec in (page.get("charts") or {}).items():
            if key not in pat.get("chart_slots", {}):
                bads.append(f"未知图表槽位 '{key}'")
                continue
            if pat.get("chart_native") is not True:
                bads.append(f"图表槽位 '{key}' 未标注 chart_native，数据可能无法写入")
            bads += [f"图表槽位 '{key}': {m}"
                     for m in check_chart_spec(spec)]
    if page.get("chart") is not None and "chart_slot" in pat:
        bads += [f"chart: {m}" for m in check_chart_spec(page["chart"])]
    if page.get("table") is not None and "table_slot" not in pat:
        bads.append("该版式不支持 table")
    if page.get("table") is not None and "table_slot" in pat:
        bads += [f"table: {m}" for m in check_table_spec(page["table"])]

    has_chart = page.get("chart") is not None or bool(page.get("charts"))
    if (pat.get("chart_slot") is not None or pat.get("chart_slots")) \
            and not has_chart:
        warns.append("此版式需图表数据(chart)")
    if pat.get("table_slot") is not None and page.get("table") is None:
        warns.append("此版式需表格数据(table)")
    if pat.get("image_slots") and not (page.get("images") or {}):
        warns.append("此版式有图片槽，页面未配图")
    return {"bads": bads, "warns": warns, "ok": not bads and not warns}
