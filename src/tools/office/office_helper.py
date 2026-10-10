#!/usr/bin/env python3
"""SmallClaw office helper.

Protocol: Node writes one JSON payload to stdin, helper writes ONE JSON document
to stdout. Nothing else is ever written to stdout (diagnostics go to stderr).

Payload: {"op": "capabilities"|"inspect"|"read"|"write", ...}
Response: {"ok": true, "data": {...}} | {"ok": false, "error": "...", "detail": ...}
"""

import copy
import csv
import json
import os
import re
import shutil
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

MAX_FILE_BYTES = 120 * 1024 * 1024
DEFAULT_PREVIEW_ROWS = 50
MAX_OPS = 200
XLSX_CHART_TYPES = ("bar", "line", "pie", "area", "scatter")


class OfficeError(Exception):
    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()


# ─── Format detection ─────────────────────────────────────────────────────────

XLSX_EXT = {".xlsx", ".xlsm"}
DOCX_EXT = {".docx"}
PPTX_EXT = {".pptx"}
PDF_EXT = {".pdf"}
CSV_EXT = {".csv", ".tsv"}
TEXT_EXT = {".txt", ".md", ".json", ".log", ".html", ".htm"}

UNSUPPORTED_EXT = {
    ".xls": "legacy .xls is not supported - convert with doc_convert to .xlsx first",
    ".doc": "legacy .doc is not supported - convert with doc_convert to .docx first",
    ".ppt": "legacy .ppt is not supported - convert with doc_convert to .pptx first",
    ".odt": "OpenDocument text is not supported for editing - convert with doc_convert to .docx first",
    ".ods": "OpenDocument sheets is not supported for editing - convert with doc_convert to .xlsx first",
    ".odp": "OpenDocument slides is not supported for editing - convert with doc_convert to .pptx first",
    ".rtf": "RTF is not supported for editing - convert with doc_convert to .docx first",
}


def detect_format(path):
    ext = os.path.splitext(str(path or ""))[1].lower()
    if ext in XLSX_EXT:
        return "xlsx"
    if ext in DOCX_EXT:
        return "docx"
    if ext in PPTX_EXT:
        return "pptx"
    if ext in PDF_EXT:
        return "pdf"
    if ext in CSV_EXT:
        return "csv"
    # TEXT_EXT was defined but never matched here, so .md/.txt/.json/.log/.html
    # fell through to the "Unsupported document type" error - whose message
    # listed "md" as supported. That contradiction made agents retry in a loop.
    if ext in TEXT_EXT:
        return "text"
    if ext in UNSUPPORTED_EXT:
        raise OfficeError(UNSUPPORTED_EXT[ext])
    raise OfficeError(
        "Unsupported document type '%s'. Supported: xlsx, docx, pptx, pdf, csv, txt, md, json, log, html." % ext
    )


def check_readable(path):
    if not path:
        raise OfficeError("path is required")
    if not os.path.isfile(path):
        raise OfficeError("File not found: %s" % path)
    size = os.path.getsize(path)
    if size > MAX_FILE_BYTES:
        raise OfficeError("File too large (%.1f MB, limit %.0f MB)" % (size / 1048576.0, MAX_FILE_BYTES / 1048576.0))
    return size


def check_writable_source(path):
    """Validate a write target. Returns True when the file already exists,
    False when the writer should create a brand new document."""
    if not path or "\0" in str(path):
        raise OfficeError("path is required")
    path = str(path)
    parent = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(parent):
        raise OfficeError("Folder does not exist: %s" % parent)
    if os.path.isdir(path):
        raise OfficeError("Path is a folder, not a file: %s" % path)
    if os.path.isfile(path):
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            raise OfficeError("File too large (%.1f MB, limit %.0f MB)" % (size / 1048576.0, MAX_FILE_BYTES / 1048576.0))
        return True
    return False


# ─── Markdown helpers ─────────────────────────────────────────────────────────

def md_escape(value):
    text = "" if value is None else str(value)
    return text.replace("|", "\\|").replace("\n", "<br>")


def md_table(headers, rows, row_limit=DEFAULT_PREVIEW_ROWS):
    out = ["| " + " | ".join(md_escape(h) for h in headers) + " |"]
    out.append("|" + "|".join("---" for _ in headers) + "|")
    shown = rows[:row_limit]
    for row in shown:
        out.append("| " + " | ".join(md_escape(c) for c in row) + " |")
    if len(rows) > row_limit:
        out.append("")
        out.append("_... %d more row(s) omitted (preview limit %d) ..._" % (len(rows) - row_limit, row_limit))
    return "\n".join(out)


def clip(value, limit=400):
    text = "" if value is None else str(value)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def value_repr(value):
    if value is None:
        return ""
    if isinstance(value, float) and value == int(value):
        return str(int(value))
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def cell_ref(col_index, row_index):
    from openpyxl.utils import get_column_letter
    return "%s%d" % (get_column_letter(col_index), row_index)


# ─── XLSX ─────────────────────────────────────────────────────────────────────

def _load_xlsx_values(path):
    import openpyxl
    return openpyxl.load_workbook(path, data_only=True)


def _load_xlsx_edit(path):
    import openpyxl
    return openpyxl.load_workbook(path)


def parse_sheet_ref(target, default_sheet=None):
    """Returns (sheet_name, min_col, min_row, max_col, max_row) with None bounds when unspecified."""
    from openpyxl.utils import range_boundaries, column_index_from_string, coordinate_to_tuple

    raw = str(target or "").strip()
    if not raw:
        return default_sheet, None, None, None, None

    sheet = default_sheet
    body = raw
    if "!" in raw:
        sheet, body = raw.split("!", 1)
        sheet = sheet.strip().strip("'").strip('"')
    body = body.replace("$", "").strip()
    if not body:
        return sheet, None, None, None, None

    if ":" in body:
        left, right = body.split(":", 1)
        min_col, min_row, max_col, max_row = range_boundaries("%s:%s" % (left, right))
        return sheet, min_col, min_row, max_col, max_row

    row, col = coordinate_to_tuple(body)
    return sheet, col, row, col, row


def _sheet_or_default(wb, sheet_name, prefer_values_wb=None):
    source = prefer_values_wb or wb
    if sheet_name:
        if sheet_name in source.sheetnames:
            return sheet_name
        raise OfficeError(
            "Worksheet '%s' not found. Available: %s" % (sheet_name, ", ".join(source.sheetnames))
        )
    return source.sheetnames[0]


def xlsx_inspect(path):
    wb = _load_xlsx_values(path)
    sheets = []
    for ws in wb.worksheets:
        headers = []
        for cell in ws[1][:20] if ws.max_row >= 1 else []:
            headers.append(value_repr(cell.value))
        sheets.append(
            {
                "name": ws.title,
                "dims": ws.calculate_dimension(),
                "max_row": ws.max_row or 0,
                "max_column": ws.max_column or 0,
                "headers": headers,
                "merged": len(getattr(ws, "merged_cells", []).ranges or []),
                "charts": len(getattr(ws, "_charts", []) or []),
            }
        )
    lines = ["Workbook: %d sheet(s)" % len(sheets)]
    for s in sheets:
        lines.append(
            "- `%s` | %s | %d rows x %d cols%s"
            % (
                s["name"],
                s["dims"],
                s["max_row"],
                s["max_column"],
                (" | merged:%d" % s["merged"]) if s["merged"] else "",
            )
        )
        if s["headers"]:
            pairs = [[chr(65 + i) if i < 26 else "col" + str(i + 1), h] for i, h in enumerate(s["headers"]) if h != ""]
            lines.append("  headers: " + ", ".join("`%s` %s" % (p[0], md_escape(p[1])) for p in pairs) if pairs else "  headers: (empty)")
    return {"format": "xlsx", "path": path, "sheets": sheets, "text": "\n".join(lines), "markdown": "\n".join(lines)}


def xlsx_read(path, target=None, stats=False, row_limit=DEFAULT_PREVIEW_ROWS):
    wb_v = _load_xlsx_values(path)
    sheet, min_col, min_row, max_col, max_row = parse_sheet_ref(target, wb_v.sheetnames[0])
    sheet = _sheet_or_default(wb_v, sheet)
    ws = wb_v[sheet]

    if min_col is None:
        min_col, min_row = 1, 1
        max_col, max_row = ws.max_column or 1, ws.max_row or 1
    if max_col is None:
        max_col, max_row = min_col, min_row
    max_col = min(max_col, ws.max_column or min_col)
    max_row = min(max_row, ws.max_row or min_row)
    if max_col < min_col or max_row < min_row:
        raise OfficeError("Range is empty or outside the sheet (%s!%s)" % (sheet, target or "used range"))

    grid = []
    for r in range(min_row, max_row + 1):
        row_vals = []
        for c in range(min_col, max_col + 1):
            row_vals.append(value_repr(ws.cell(row=r, column=c).value))
        grid.append(row_vals)

    headers = ["row"] + [cell_ref(c, min_row) for c in range(min_col, max_col + 1)]
    rows = []
    for idx, row_vals in enumerate(grid):
        rows.append([str(min_row + idx)] + row_vals)

    header_row_used = min_row
    range_label = "%s:%s" % (cell_ref(min_col, min_row), cell_ref(max_col, max_row))
    table = md_table(headers, rows, row_limit=row_limit)
    parts = [
        "**%s!%s** - %d row(s) x %d column(s), header row %d"
        % (sheet, range_label, len(grid), max_col - min_col + 1, header_row_used),
        "",
        table,
    ]

    stats_out = None
    if stats:
        stats_out = []
        for offset, c in enumerate(range(min_col, max_col + 1)):
            label = cell_ref(c, header_row_used)
            values = [grid[i][offset] for i in range(len(grid))]
            numeric = []
            for v in values[1:]:
                try:
                    numeric.append(float(str(v).replace(",", "")))
                except Exception:
                    pass
            non_empty = sum(1 for v in values[1:] if str(v).strip() != "")
            entry = {"column": label, "header": values[0], "non_empty": non_empty, "numeric": len(numeric)}
            if numeric:
                entry.update(
                    {
                        "min": min(numeric),
                        "max": max(numeric),
                        "sum": sum(numeric),
                        "avg": round(sum(numeric) / len(numeric), 4),
                    }
                )
            stats_out.append(entry)
        if stats_out:
            parts.append("")
            parts.append("### Column stats")
            parts.append(
                md_table(
                    ["column", "header", "non-empty", "numeric", "min", "max", "sum", "avg"],
                    [
                        [
                            e["column"],
                            e.get("header", ""),
                            e["non_empty"],
                            e["numeric"],
                            e.get("min", ""),
                            e.get("max", ""),
                            e.get("sum", ""),
                            e.get("avg", ""),
                        ]
                        for e in stats_out
                    ],
                    row_limit=60,
                )
            )

    return {
        "format": "xlsx",
        "sheet": sheet,
        "range": "%s:%s" % (cell_ref(min_col, min_row), cell_ref(max_col, max_row)),
        "rows": len(grid),
        "columns": max_col - min_col + 1,
        "stats": stats_out,
        "markdown": "\n".join(parts),
        "text": "\n".join(parts),
    }


def xlsx_range_preview(ws_values, sheet, min_col, min_row, values, row_limit=DEFAULT_PREVIEW_ROWS):
    """Build a before/after markdown table for a cell write."""
    n_rows = len(values)
    n_cols = max(len(r) for r in values) if values else 0
    headers = ["row"] + [cell_ref(min_col + c, min_row) for c in range(n_cols)]
    rows = []
    changed = 0
    for i, row_vals in enumerate(values):
        r = min_row + i
        line = [str(r)]
        for c in range(n_cols):
            new = row_vals[c] if c < len(row_vals) else None
            old = ws_values.cell(row=r, column=min_col + c).value if ws_values else None
            old_s, new_s = value_repr(old), value_repr(new)
            if old_s != new_s:
                changed += 1
                line.append("`%s` → **`%s`**" % (old_s or "∅", new_s or "∅"))
            else:
                line.append(old_s)
        rows.append(line)
    header = "**工作表 `%s` · 区域 `%s`** — %d 列 × %d 行，%d 格将变更" % (
        sheet,
        "%s:%s" % (cell_ref(min_col, min_row), cell_ref(min_col + n_cols - 1, min_row + n_rows - 1)),
        n_cols,
        n_rows,
        changed,
    )
    return header + "\n\n" + md_table(headers, rows, row_limit=row_limit), changed


# ─── DOCX ─────────────────────────────────────────────────────────────────────

def docx_inspect(path):
    from docx import Document

    doc = Document(path)
    headings = []
    for idx, p in enumerate(doc.paragraphs):
        style = p.style.name if p.style is not None else ""
        if style.lower().startswith("heading") or style.lower() == "title":
            headings.append({"index": idx, "style": style, "text": clip(p.text, 160)})
    tables = []
    for idx, t in enumerate(doc.tables):
        tables.append({"index": idx, "rows": len(t.rows), "cols": len(t.columns)})

    lines = ["Document: %d paragraph(s), %d table(s), %d section(s)" % (len(doc.paragraphs), len(doc.tables), len(doc.sections))]
    lines.append("")
    lines.append("### Outline")
    if headings:
        for h in headings:
            lines.append("- `#%d` [%s] %s" % (h["index"], h["style"], h["text"] or "(empty)"))
    else:
        lines.append("- (no headings)")
    if tables:
        lines.append("")
        lines.append("### Tables")
        for t in tables:
            lines.append("- `#T%d` - %d rows x %d cols" % (t["index"], t["rows"], t["cols"]))
    return {
        "format": "docx",
        "path": path,
        "paragraphs": len(doc.paragraphs),
        "tables": tables,
        "outline": headings,
        "markdown": "\n".join(lines),
        "text": "\n".join(lines),
    }


def docx_read(path, target=None, limit=200):
    from docx import Document

    doc = Document(path)
    lines = []
    start = 0
    if target:
        start = max(0, int(target))
    end = min(len(doc.paragraphs), start + max(1, int(limit)))
    for idx in range(start, end):
        p = doc.paragraphs[idx]
        style = p.style.name if p.style is not None else ""
        lines.append("`#%d` **[%s]** %s" % (idx, style, clip(p.text, 600) or "_empty_"))
    for t_idx, t in enumerate(doc.tables):
        lines.append("")
        lines.append("### Table `#T%d` (%d x %d)" % (t_idx, len(t.rows), len(t.columns)))
        grid = [[value_repr(cell.text) for cell in row.cells] for row in t.rows]
        if grid:
            headers = ["row"] + ["C%d" % (i + 1) for i in range(len(grid[0]))]
            body = [[str(i)] + row for i, row in enumerate(grid)]
            lines.append(md_table(headers, body))
    if not lines:
        lines.append("(document is empty)")
    return {
        "format": "docx",
        "path": path,
        "paragraph_range": [start, end],
        "paragraph_total": len(doc.paragraphs),
        "markdown": "\n".join(lines),
        "text": "\n".join(lines),
    }


def text_read(path, target=None, limit=200):
    """Read a plain-text document (.md/.txt/.json/.log/.html) with line numbers."""
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    lines = raw.split("\n")
    start = max(0, int(target)) if target else 0
    end = min(len(lines), start + max(1, int(limit)))
    body = "\n".join(
        "%d: %s" % (start + idx + 1, line) for idx, line in enumerate(lines[start:end])
    )
    if not body:
        body = "(file is empty)"
    return {
        "format": "text",
        "path": path,
        "line_range": [start, end],
        "line_total": len(lines),
        "markdown": body,
        "text": body,
    }


def text_inspect(path, preview_lines=20):
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        raw = fh.read()
    lines = raw.split("\n")
    preview = "\n".join(lines[:preview_lines])
    return {
        "format": "text",
        "path": path,
        "line_total": len(lines),
        "char_total": len(raw),
        "markdown": preview,
        "text": preview,
    }


def _capture_run_font(paragraph):
    if not paragraph.runs:
        return None
    run = paragraph.runs[0]
    font = run.font
    captured = {}
    try:
        captured["name"] = font.name
        captured["size"] = font.size
        captured["bold"] = font.bold
        captured["italic"] = font.italic
        captured["underline"] = font.underline
        if font.color is not None and font.color.type is not None:
            try:
                captured["rgb"] = font.color.rgb
            except Exception:
                pass
    except Exception:
        return None
    return captured


def _apply_run_font(paragraph, captured):
    if not captured:
        return
    for run in paragraph.runs:
        try:
            if captured.get("name"):
                run.font.name = captured["name"]
            if captured.get("size"):
                run.font.size = captured["size"]
            if captured.get("bold") is not None:
                run.font.bold = captured["bold"]
            if captured.get("italic") is not None:
                run.font.italic = captured["italic"]
            if captured.get("underline") is not None:
                run.font.underline = captured["underline"]
            if captured.get("rgb") is not None:
                run.font.color.rgb = captured["rgb"]
        except Exception:
            pass


def _docx_paragraph_preview(doc, index, new_text, style=None):
    if index < 0 or index >= len(doc.paragraphs):
        raise OfficeError(
            "Paragraph `#%d` does not exist (document has %d paragraph(s))." % (index, len(doc.paragraphs))
        )
    p = doc.paragraphs[index]
    old = clip(p.text, 400)
    style_name = style or (p.style.name if p.style is not None else "")
    head = "**`#%d` [%s]**" % (index, style_name)
    if old == clip(new_text, 400):
        body = "- 内容无变化：%s" % (old or "(empty)")
    else:
        body = "- 旧：%s\n- 新：%s" % (old or "(empty)", clip(new_text, 400) or "(empty)")
    return head + "\n" + body


# ─── PPTX ─────────────────────────────────────────────────────────────────────

EMU_PER_INCH = 914400


def _inches(value):
    if value is None:
        return None
    try:
        return round(float(value) / EMU_PER_INCH, 2)
    except Exception:
        return None


def _shape_anchor(slide_no, shape):
    return "第 %d 页 · 形状 `#%s` \"%s\"" % (slide_no, shape.shape_id, shape.name)


def _shape_pos(shape):
    x, y, w, h = _inches(shape.left), _inches(shape.top), _inches(shape.width), _inches(shape.height)
    if x is None:
        return "(position n/a)"
    return "@ (%.2fin, %.2fin) %.2f x %.2fin" % (x or 0, y or 0, w or 0, h or 0)


def pptx_inspect(path):
    from pptx import Presentation

    prs = Presentation(path)
    slides = []
    for i, slide in enumerate(prs.slides, start=1):
        shapes = []
        for shape in slide.shapes:
            entry = {
                "id": shape.shape_id,
                "name": shape.name,
                "type": type(shape).__name__,
                "x": _inches(shape.left),
                "y": _inches(shape.top),
                "w": _inches(shape.width),
                "h": _inches(shape.height),
                "text": clip(shape.text_frame.text, 120) if getattr(shape, "has_text_frame", False) else "",
                "table": bool(getattr(shape, "has_table", False)),
                "placeholder": shape.is_placeholder,
            }
            if shape.is_placeholder:
                try:
                    entry["placeholder_idx"] = shape.placeholder_format.idx
                except Exception:
                    pass
            shapes.append(entry)
        layout = slide.slide_layout.name if slide.slide_layout is not None else ""
        slides.append({"index": i, "layout": layout, "shapes": shapes})

    lines = ["Presentation: %d slide(s), %.2f x %.2f in" % (len(slides), _inches(prs.slide_width) or 0, _inches(prs.slide_height) or 0)]
    for s in slides:
        lines.append("")
        lines.append("### Slide %d  (layout: `%s`)" % (s["index"], s["layout"]))
        for sh in s["shapes"]:
            lines.append(
                "- `#%s` %s %s %s%s%s"
                % (
                    sh["id"],
                    sh["name"],
                    sh["type"],
                    "@ (%.2fin, %.2fin) %.2fx%.2fin" % (sh["x"] or 0, sh["y"] or 0, sh["w"] or 0, sh["h"] or 0),
                    " [TABLE]" if sh["table"] else "",
                    " [placeholder]" if sh["placeholder"] else "",
                )
            )
            if sh["text"]:
                lines.append("    text: %s" % sh["text"])
    return {
        "format": "pptx",
        "path": path,
        "slide_count": len(slides),
        "slide_size": {"w": _inches(prs.slide_width), "h": _inches(prs.slide_height)},
        "slides": slides,
        "markdown": "\n".join(lines),
        "text": "\n".join(lines),
    }


def pptx_read(path, target=None, limit=6):
    from pptx import Presentation

    prs = Presentation(path)
    wanted = None
    if target not in (None, ""):
        try:
            wanted = int(str(target).strip().lstrip("#"))
        except Exception:
            raise OfficeError("pptx target must be a slide number, e.g. '3'")
    lines = []
    for i, slide in enumerate(prs.slides, start=1):
        if wanted is not None and i != wanted:
            continue
        lines.append("### Slide %d" % i)
        for shape in slide.shapes:
            if getattr(shape, "has_text_frame", False):
                text = clip(shape.text_frame.text, 1200)
                lines.append("- `%s` %s %s" % (shape.shape_id, shape.name, _shape_pos(shape)))
                if text:
                    lines.append("    %s" % text.replace("\n", "\n    "))
            if getattr(shape, "has_table", False):
                table = shape.table
                grid = [[value_repr(c.text) for c in row.cells] for row in table.rows]
                lines.append("- `%s` %s [TABLE %dx%d] %s" % (shape.shape_id, shape.name, len(grid), len(grid[0]) if grid else 0, _shape_pos(shape)))
                if grid:
                    headers = ["row"] + ["C%d" % (n + 1) for n in range(len(grid[0]))]
                    lines.append("  " + md_table(headers, [[str(n)] + r for n, r in enumerate(grid)]).replace("\n", "\n  "))
        lines.append("")
        if wanted is None and i >= limit:
            lines.append("_... more slides omitted - use target=<slide number> ..._")
            break
    if not lines:
        lines.append("(no slides)")
    return {"format": "pptx", "path": path, "markdown": "\n".join(lines), "text": "\n".join(lines)}


def find_shape(slide, ref):
    """ref: '#5' or a shape name."""
    raw = str(ref or "").strip()
    if not raw:
        raise OfficeError("shape is required (e.g. '#5' or shape name)")
    if raw.startswith("#"):
        wanted = raw[1:]
        for shape in slide.shapes:
            if str(shape.shape_id) == wanted:
                return shape
        available = ["#%s (%s)" % (s.shape_id, s.name) for s in slide.shapes]
        raise OfficeError("Shape `#%s` not found on this slide." % wanted, detail={"available": available})
    for shape in slide.shapes:
        if shape.name == raw:
            return shape
    available = ["#%s (%s)" % (s.shape_id, s.name) for s in slide.shapes]
    raise OfficeError("Shape named '%s' not found on this slide." % raw, detail={"available": available})


def get_slide(prs, slide_no):
    if slide_no < 1 or slide_no > len(prs.slides._sldIdLst):
        raise OfficeError("Slide %d does not exist (presentation has %d slide(s))." % (slide_no, len(prs.slides._sldIdLst)))
    return prs.slides[slide_no - 1]


def _capture_ppt_font(shape):
    try:
        tf = shape.text_frame
        if not tf.paragraphs or not tf.paragraphs[0].runs:
            return None
        run = tf.paragraphs[0].runs[0]
        font = run.font
        captured = {"size": font.size, "bold": font.bold, "italic": font.italic, "name": font.name}
        try:
            captured["rgb"] = font.color.rgb if font.color is not None and font.color.type is not None else None
        except Exception:
            captured["rgb"] = None
        return captured
    except Exception:
        return None


def set_shape_text(shape, text, font=None):
    tf = shape.text_frame
    lines = str(text if text is not None else "").split("\n")
    try:
        tf.clear()
    except Exception:
        tf.text = ""
        lines = []
    if not lines:
        lines = [""]
    tf.paragraphs[0].text = lines[0]
    for extra in lines[1:]:
        paragraph = tf.add_paragraph()
        paragraph.text = extra
    if font:
        for paragraph in tf.paragraphs:
            _apply_run_font(
                paragraph,
                {
                    "size": font.get("size"),
                    "bold": font.get("bold"),
                    "italic": font.get("italic"),
                    "name": font.get("name"),
                    "rgb": font.get("rgb"),
                },
            )


# ─── PDF / CSV / TEXT ─────────────────────────────────────────────────────────

def pdf_read(path, target=None, limit=5000):
    from pypdf import PdfReader

    reader = PdfReader(path)
    total = len(reader.pages)
    wanted = None
    if target not in (None, ""):
        try:
            wanted = int(str(target).strip().lower().replace("page", "").strip())
        except Exception:
            raise OfficeError("pdf target must be a page number, e.g. '3'")
    pages = []
    for i, page in enumerate(reader.pages, start=1):
        if wanted is not None and i != wanted:
            continue
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        pages.append({"page": i, "text": text})
    if not pages:
        raise OfficeError("No such page (document has %d page(s))." % total)
    parts = []
    for p in pages:
        parts.append("### Page %d / %d" % (p["page"], total))
        parts.append(p["text"].strip() or "_(no extractable text - this may be a scanned PDF; use OCR)_")
        parts.append("")
    joined = "\n".join(parts)
    if len(joined) > limit:
        joined = joined[:limit] + "\n...[truncated]"
    return {"format": "pdf", "path": path, "pages": total, "markdown": joined, "text": joined}


def pdf_scanned_pages(path, threshold=50):
    """Return page numbers whose text layer is empty/near-empty (scanned pages)."""
    from pypdf import PdfReader
    reader = PdfReader(path)
    scanned = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if len(text.strip()) < threshold:
            scanned.append(i)
    return scanned


def pdf_ocr_pages(path, pages=None, dpi=300):
    """OCR scanned pages of a PDF with RapidOCR. pages: 'auto' (default, detect scanned),
    a comma list like '2,3,5', or 'all'."""
    try:
        import pymupdf  # PyMuPDF >= 1.28 (import fitz prints a deprecation warning to stdout)
    except ImportError:
        try:
            import fitz as pymupdf
        except ImportError:
            raise OfficeError("OCR requires PyMuPDF (pip install pymupdf)")
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        raise OfficeError("OCR requires rapidocr-onnxruntime (pip install rapidocr-onnxruntime)")

    total = 0
    try:
        doc = pymupdf.open(path)
        total = len(doc)
    except Exception as exc:
        raise OfficeError("Cannot open PDF for OCR: %s" % exc)

    sel = str(pages or "auto").strip().lower()
    if sel in ("", "auto"):
        wanted = pdf_scanned_pages(path)
        if not wanted:
            doc.close()
            raise OfficeError("No scanned pages detected - every page has extractable text; pass pages='all' to force OCR.")
    elif sel == "all":
        wanted = list(range(1, total + 1))
    else:
        wanted = []
        for part in sel.replace("page", "").split(","):
            part = part.strip()
            if not part:
                continue
            try:
                n = int(part)
            except ValueError:
                doc.close()
                raise OfficeError("pages must be numbers like '2,3,5', 'all' or 'auto'")
            if n < 1 or n > total:
                doc.close()
                raise OfficeError("page %d out of range (document has %d pages)" % (n, total))
            wanted.append(n)
        wanted = sorted(set(wanted))

    engine = RapidOCR()
    results = []
    import tempfile
    for n in wanted:
        page = doc[n - 1]
        pix = page.get_pixmap(matrix=pymupdf.Matrix(dpi / 72.0, dpi / 72.0))
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tmp_path = tf.name
        try:
            pix.save(tmp_path)
            res, _ = engine(tmp_path)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        lines = [text for _, text, _ in (res or [])] if res else []
        results.append({"page": n, "text": "\n".join(lines)})
    doc.close()

    parts = []
    for r in results:
        parts.append("### Page %d / %d (OCR)" % (r["page"], total))
        parts.append(r["text"].strip() or "_(OCR returned no text on this page)_")
        parts.append("")
    joined = "\n".join(parts)
    return {
        "format": "pdf",
        "path": path,
        "pages": total,
        "ocr_pages": [r["page"] for r in results],
        "markdown": joined,
        "text": joined,
    }


def parse_lab_report(path):
    """Parse a hospital lab report PDF into structured JSON (patient, dated batches, abnormal items)."""
    try:
        import medical.lab_parser as lp
    except ImportError:
        parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if parent not in sys.path:
            sys.path.insert(0, parent)
        import medical.lab_parser as lp
    data = lp.parse_pdf(path)
    # compact markdown summary for the calling model
    lines = []
    p = data.get("patient", {})
    lines.append("**患者：** %s / %s / %s岁 / 病历号 %s" % (
        p.get("name") or "?", p.get("sex") or "?", p.get("age") or "?", p.get("history_no") or "?"))
    lines.append("**时间线（%d 个检查日，%d 个批次，%d 项检验）：** %s" % (
        len(data.get("dates", [])), data.get("batch_count", 0), data.get("item_count", 0),
        "、".join(data.get("dates", []))))
    abn = data.get("abnormal", [])
    if abn:
        lines.append("**异常项目（%d 项）：**" % len(abn))
        for a in abn:
            lines.append("- %s %s = %s %s（参考 %s）→ %s" % (
                a["date"], a["name"], a["value"], a["unit"], a["ref"], "偏高" if a["flag"] == "high" else "偏低"))
    else:
        lines.append("（未发现异常项目）")
    return {
        "format": "lab_json",
        "path": path,
        "patient": p,
        "dates": data.get("dates", []),
        "batch_count": data.get("batch_count", 0),
        "item_count": data.get("item_count", 0),
        "batches": data.get("batches", []),
        "abnormal": abn,
        "markdown": "\n".join(lines),
        "text": "\n".join(lines),
    }


def csv_inspect(path):
    delimiter = "\t" if os.path.splitext(path)[1].lower() == ".tsv" else ","
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        reader = csv.reader(fh, delimiter=delimiter)
        rows = [row for row in reader]
    headers = rows[0] if rows else []
    lines = ["CSV: %d row(s) x %d column(s)" % (len(rows), len(headers) if rows else 0)]
    if headers:
        lines.append(md_table(["col", "header"], [[chr(65 + i) if i < 26 else i + 1, h] for i, h in enumerate(headers)]))
    return {"format": "csv", "path": path, "rows": len(rows), "markdown": "\n".join(lines), "text": "\n".join(lines)}


def csv_read(path, target=None, limit=200):
    delimiter = "\t" if os.path.splitext(path)[1].lower() == ".tsv" else ","
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh, delimiter=delimiter))
    if not rows:
        return {"format": "csv", "path": path, "markdown": "(empty file)", "text": "(empty file)"}
    start = 0
    if target:
        start = max(0, int(target))
    slice_ = rows[start:start + max(1, int(limit))]
    ncols = max(len(r) for r in slice_)
    padded = [list(r) + [""] * (ncols - len(r)) for r in slice_]
    headers = ["row"] + ["C%d" % (i + 1) for i in range(ncols)]
    body = [[str(start + i)] + row for i, row in enumerate(padded)]
    md = md_table(headers, body)
    return {"format": "csv", "path": path, "markdown": md, "text": md}


# ─── Operations ───────────────────────────────────────────────────────────────

def op_capabilities():
    caps = {"python": sys.version.split()[0], "formats": {}, "libs": {}}
    for name in ("openpyxl", "docx", "pptx", "pypdf", "matplotlib", "pymupdf", "rapidocr_onnxruntime"):
        try:
            __import__(name)
            caps["libs"][name] = True
        except Exception as exc:
            caps["libs"][name] = str(exc)
    caps["formats"]["xlsx"] = caps["libs"].get("openpyxl") is True
    caps["formats"]["docx"] = caps["libs"].get("docx") is True
    caps["formats"]["pptx"] = caps["libs"].get("pptx") is True
    caps["formats"]["pdf"] = caps["libs"].get("pypdf") is True
    caps["formats"]["csv"] = True
    caps["formats"]["chart"] = caps["libs"].get("matplotlib") is True
    caps["formats"]["ocr"] = caps["libs"].get("pymupdf") is True and caps["libs"].get("rapidocr_onnxruntime") is True
    caps["formats"]["create"] = True
    caps["soffice"] = _find_soffice()
    caps["formats"]["convert"] = bool(caps["soffice"])
    caps["ready"] = any(caps["formats"].values())
    return caps


def op_inspect(payload):
    path = payload.get("path")
    check_readable(path)
    fmt = detect_format(path)
    if fmt == "xlsx":
        return xlsx_inspect(path)
    if fmt == "docx":
        return docx_inspect(path)
    if fmt == "pptx":
        return pptx_inspect(path)
    if fmt == "pdf":
        return pdf_read(path, payload.get("target"))
    if fmt == "csv":
        return csv_inspect(path)
    if fmt == "text":
        return text_inspect(path)
    raise OfficeError("Unsupported format: %s" % fmt)


def op_read(payload):
    path = payload.get("path")
    check_readable(path)
    fmt = detect_format(path)
    if fmt == "xlsx":
        return xlsx_read(path, payload.get("target"), bool(payload.get("stats")), int(payload.get("row_limit") or DEFAULT_PREVIEW_ROWS))
    if fmt == "docx":
        return docx_read(path, payload.get("target"), int(payload.get("limit") or 200))
    if fmt == "pptx":
        return pptx_read(path, payload.get("target"))
    if fmt == "pdf":
        return pdf_read(path, payload.get("target"))
    if fmt == "csv":
        return csv_read(path, payload.get("target"), int(payload.get("limit") or 200))
    if fmt == "text":
        return text_read(path, payload.get("target"), int(payload.get("limit") or 200))
    raise OfficeError("Unsupported format: %s" % fmt)


# ─── Pivot (数据透视/分组汇总) ───────────────────────────────────────────────

def op_pivot(payload):
    """按一列分组，对若干值列做 sum/avg/count/min/max 聚合，输出 Markdown 汇总表。"""
    path = payload.get("path")
    check_readable(path)
    ext = os.path.splitext(str(path))[1].lower()
    if ext == ".csv":
        import csv as _csv

        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            rows = list(_csv.reader(fh))
    elif ext == ".xlsx":
        wb = _load_xlsx_values(path)
        sheet = _sheet_or_default(wb, payload.get("sheet"))
        ws = wb[sheet]
        rows = [
            [ws.cell(row=r, column=c).value for c in range(1, (ws.max_column or 1) + 1)]
            for r in range(1, (ws.max_row or 1) + 1)
        ]
    else:
        raise OfficeError("pivot supports .xlsx and .csv only (got %s)" % ext)
    rows = [r for r in rows if any(str(c or "").strip() != "" for c in r)]
    if not rows:
        raise OfficeError("data is empty")
    header = [str(h or "").strip() for h in rows[0]]
    data = rows[1:]

    group = str(payload.get("group") or "").strip()
    value_cols = payload.get("values") or []
    agg = str(payload.get("agg") or "sum").strip().lower()
    if agg not in ("sum", "avg", "count", "min", "max"):
        raise OfficeError("agg must be one of: sum, avg, count, min, max")
    if not group:
        raise OfficeError("pivot requires 'group' (column name to group by)")
    if not value_cols:
        raise OfficeError("pivot requires 'values' (list of value column names)")

    def resolve_col(name):
        name = str(name or "").strip()
        # 列字母：A, B, ..., Z, AA...
        if re.fullmatch(r"[A-Za-z]{1,3}", name):
            col = 0
            for ch in name.upper():
                col = col * 26 + (ord(ch) - 64)
            if 1 <= col <= len(header):
                return col - 1
        # 表头精确匹配
        for i, h in enumerate(header):
            if h == name:
                return i
        # 1-based 数字下标
        try:
            i = int(name) - 1
            if 0 <= i < len(header):
                return i
        except Exception:
            pass
        raise OfficeError("column '%s' not found. Available: %s" % (name, ", ".join(header) or "(无表头)"))

    gi = resolve_col(group)
    vi = [resolve_col(v) for v in value_cols]

    from collections import OrderedDict

    groups = OrderedDict()
    for row in data:
        gkey = str(row[gi] if gi < len(row) else "").strip() or "(空)"
        if gkey not in groups:
            groups[gkey] = [[] for _ in vi]
        for k, i in enumerate(vi):
            v = row[i] if i < len(row) else None
            try:
                groups[gkey][k].append(float(str(v).replace(",", "").strip()))
            except Exception:
                groups[gkey][k].append(None)

    agg_label = {"sum": "合计", "avg": "平均", "count": "计数", "min": "最小", "max": "最大"}.get(agg, agg)
    out_rows = []
    for gkey, colvals in groups.items():
        line = [gkey]
        for vals in colvals:
            numeric = [v for v in vals if v is not None]
            if agg == "count":
                line.append(len(vals))
            elif agg == "min":
                line.append(round(min(numeric), 4) if numeric else None)
            elif agg == "max":
                line.append(round(max(numeric), 4) if numeric else None)
            elif agg == "avg":
                line.append(round(sum(numeric) / len(numeric), 4) if numeric else None)
            else:
                line.append(round(sum(numeric), 4) if numeric else None)
        out_rows.append(line)

    headers = [header[gi]] + ["%s(%s)" % (agg_label, header[i]) for i in vi]
    md = md_table(headers, out_rows)
    return {
        "format": ext.lstrip("."),
        "group": header[gi],
        "agg": agg,
        "groups": len(out_rows),
        "markdown": "**数据透视 · 按 `%s` 分组 · %s**\n\n%s" % (header[gi], agg_label, md),
    }


# ─── Markdown parsing (docx content / pptx outline) ──────────────────────────

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
BULLET_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
ORDERED_RE = re.compile(r"^\s*\d+[.)]\s+(.*)$")
IMAGE_MD_RE = re.compile(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$")
HR_RE = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")


def parse_markdown_blocks(text):
    """Markdown -> [{"type": heading|paragraph|list|table|image, ...}]."""
    blocks = []
    para = []
    bullets = []

    def flush_para():
        if para:
            blocks.append({"type": "paragraph", "text": " ".join(para).strip()})
            del para[:]

    def flush_bullets():
        if bullets:
            blocks.append({"type": "list", "items": list(bullets)})
            del bullets[:]

    def flush_all():
        flush_para()
        flush_bullets()

    lines = str(text or "").replace("\r", "").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        m = HEADING_RE.match(line)
        if m:
            flush_all()
            blocks.append({"type": "heading", "level": len(m.group(1)), "text": m.group(2).strip().strip("#").strip()})
            i += 1
            continue
        if HR_RE.match(line):
            flush_all()
            i += 1
            continue
        if line.lstrip().startswith("|"):
            flush_all()
            rows = []
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                rows.append(cells)
                i += 1
            if len(rows) >= 2 and all(all(re.match(r"^:?-+:?$", c) for c in r) for r in rows[1:2]):
                header, body = rows[0], rows[2:]
            else:
                header, body = rows[0], rows[1:]
            width = len(header)
            body = [r[:width] + [""] * (width - len(r)) for r in body]
            blocks.append({"type": "table", "rows": [header] + body})
            continue
        img = IMAGE_MD_RE.match(line.strip())
        if img:
            flush_all()
            blocks.append({"type": "image", "alt": img.group(1), "path": img.group(2).strip()})
            i += 1
            continue
        bullet = BULLET_RE.match(line) or ORDERED_RE.match(line)
        if bullet:
            flush_para()
            bullets.append(bullet.group(1).strip())
            i += 1
            continue
        if not line.strip():
            flush_all()
            i += 1
            continue
        flush_bullets()
        para.append(line.strip())
        i += 1
    flush_all()
    return blocks


def blocks_to_markdown(blocks):
    out = []
    for block in blocks:
        kind = block.get("type")
        if kind == "heading":
            out.append("#" * min(int(block.get("level") or 1), 6) + " " + str(block.get("text") or ""))
            out.append("")
        elif kind == "paragraph":
            out.append(str(block.get("text") or ""))
            out.append("")
        elif kind == "list":
            for item in block.get("items") or []:
                out.append("- " + str(item))
            out.append("")
        elif kind == "table":
            rows = block.get("rows") or []
            if not rows:
                continue
            width = len(rows[0])
            out.append("| " + " | ".join(md_escape(c) for c in rows[0]) + " |")
            out.append("|" + "---|" * width)
            for row in rows[1:]:
                padded = list(row)[:width] + [""] * (width - len(row))
                out.append("| " + " | ".join(md_escape(c) for c in padded) + " |")
            out.append("")
        elif kind == "image":
            out.append("![%s](%s)" % (block.get("alt") or "", block.get("path") or ""))
            out.append("")
    return "\n".join(out).rstrip()


def _add_md_runs(paragraph, text):
    for part in re.split(r"(\*\*[^*]+\*\*)", str(text or "")):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        else:
            paragraph.add_run(part)


def _append_markdown_blocks(doc, blocks):
    for block in blocks:
        kind = block.get("type")
        if kind == "heading":
            level = min(int(block.get("level") or 1), 9)
            try:
                paragraph = doc.add_paragraph(style="Heading %d" % level)
            except Exception:
                paragraph = doc.add_paragraph()
            _add_md_runs(paragraph, block.get("text"))
        elif kind == "paragraph":
            _add_md_runs(doc.add_paragraph(), block.get("text"))
        elif kind == "list":
            for item in block.get("items") or []:
                try:
                    paragraph = doc.add_paragraph(style="List Bullet")
                except Exception:
                    paragraph = doc.add_paragraph()
                _add_md_runs(paragraph, item)
        elif kind == "table":
            rows = block.get("rows") or []
            if not rows:
                continue
            width = max(len(r) for r in rows)
            table = doc.add_table(rows=len(rows), cols=width)
            try:
                table.style = "Table Grid"
            except Exception:
                pass
            for r, row in enumerate(rows):
                for c in range(width):
                    value = row[c] if c < len(row) else ""
                    table.cell(r, c).text = "" if value is None else str(value)
        elif kind == "image":
            path = str(block.get("path") or "")
            if path and os.path.isfile(path):
                try:
                    doc.add_picture(path)
                except Exception:
                    doc.add_paragraph("[%s]" % path)


def parse_outline_slides(text):
    """Markdown outline -> [{"kind": title|content, "title": str, "bullets": [..]}]."""
    slides = []
    current = {}
    pending_break = False

    def new_slide(kind, title):
        nonlocal current, pending_break
        current = {"kind": kind, "title": title, "bullets": []}
        slides.append(current)
        pending_break = False

    for raw in str(text or "").replace("\r", "").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        if HR_RE.match(line):
            if current:
                pending_break = True
            continue
        m = HEADING_RE.match(line)
        if m:
            level = len(m.group(1))
            title = m.group(2).strip().strip("#").strip()
            if level == 1 and not slides:
                new_slide("title", title)
            else:
                new_slide("content", title)
            continue
        bullet = BULLET_RE.match(line) or ORDERED_RE.match(line)
        if bullet:
            if not current or pending_break:
                new_slide("content", "")
            current["bullets"].append(bullet.group(1).strip())
            continue
        if not current or pending_break:
            new_slide("title" if not slides else "content", line.strip())
        elif not current["title"]:
            current["title"] = line.strip()
        else:
            current["bullets"].append(line.strip())
    return slides


def outline_to_markdown(slides):
    out = []
    for i, slide in enumerate(slides, start=1):
        kind = "标题页" if slide.get("kind") == "title" else "内容页"
        out.append("**%d. [%s] %s**" % (i, kind, slide.get("title") or "(无标题)"))
        for item in slide.get("bullets") or []:
            out.append("- %s" % item)
        out.append("")
    return "\n".join(out).rstrip()


def _append_outline_slides(prs, slides, accent="2C5F8A"):
    """Append slides from an outline with built-in styling:
    标题页 = 深色主视觉（大标题 + 副标题）；内容页 = 品牌色标题 + 深灰正文。"""
    from pptx.util import Inches as PptxInches, Pt as PptxPt
    from pptx.dml.color import RGBColor

    layouts = list(prs.slide_layouts)
    blank = layouts[6] if len(layouts) > 6 else layouts[0]
    content_layout = layouts[1] if len(layouts) > 1 else layouts[0]
    accent_rgb = RGBColor.from_string(accent)
    dark = RGBColor.from_string("1F3864")
    white = RGBColor.from_string("FFFFFF")
    sub_rgb = RGBColor.from_string("B8C4D9")
    body_rgb = RGBColor.from_string("333333")

    for slide_spec in slides:
        is_title = slide_spec.get("kind") == "title"
        title = slide_spec.get("title") or "演示文稿"
        bullets = slide_spec.get("bullets") or []
        if is_title:
            slide = prs.slides.add_slide(blank)
            try:
                slide.background.fill.solid()
                slide.background.fill.fore_color.rgb = dark
            except Exception:
                pass
            tb = slide.shapes.add_textbox(PptxInches(0.8), PptxInches(2.0), PptxInches(8.4), PptxInches(1.8))
            tf = tb.text_frame
            tf.word_wrap = True
            tf.text = title
            p = tf.paragraphs[0]
            p.font.size = PptxPt(40)
            p.font.bold = True
            p.font.color.rgb = white
            if bullets:
                sub = tf.add_paragraph()
                sub.text = bullets[0]
                sub.font.size = PptxPt(18)
                sub.font.color.rgb = sub_rgb
        else:
            slide = prs.slides.add_slide(content_layout)
            for shape in slide.placeholders:
                try:
                    idx = shape.placeholder_format.idx
                except Exception:
                    continue
                if idx == 0 and title:
                    set_shape_text(shape, title, font={"size": PptxPt(28), "bold": True, "rgb": accent_rgb})
                elif idx == 1 and bullets:
                    set_shape_text(shape, "\n".join(bullets), font={"size": PptxPt(18), "rgb": body_rgb})
    return prs


# ─── Write planning ───────────────────────────────────────────────────────────

def _op_error(op, message, detail=None):
    return {"ok": False, "op": op.get("op", "?"), "error": message, "detail": detail}


def _plan_xlsx(ops, path, out_path=None, created=False):
    """Returns (plans, mutator) where mutator() applies everything."""
    import openpyxl  # noqa: F401 - ensures the library is importable before planning
    from openpyxl.utils import get_column_letter

    if created:
        # Two independent empty workbooks: one for previews, one that gets written.
        state = {"wb_values": openpyxl.Workbook(), "wb_edit": openpyxl.Workbook(), "plans": [], "planned_sheets": set()}
    else:
        state = {"wb_values": _load_xlsx_values(path), "wb_edit": _load_xlsx_edit(path), "plans": [], "planned_sheets": set()}
    plans = state["plans"]

    def sheet_exists(name):
        return name in state["wb_edit"].sheetnames or name in state["planned_sheets"]

    for op in ops:
        kind = str(op.get("op") or "").strip()
        try:
            if kind in ("cells", "rows"):
                sheet_name = op.get("sheet") or None
                if kind == "rows":
                    at = str(op.get("at") or "").strip().replace("$", "")
                    if not at:
                        raise OfficeError("rows op requires 'at' (e.g. 'A20')")
                    sheet_name, min_col, min_row, _, _ = parse_sheet_ref(at, sheet_name)
                    values = op.get("values")
                    if not isinstance(values, list) or not values:
                        raise OfficeError("rows op requires a non-empty 'values' array of arrays")
                    # 小模型容错：扁平数组按单列多行处理
                    if all(not isinstance(r, list) for r in values):
                        values = [[r] for r in values]
                    values = [r if isinstance(r, list) else [r] for r in values]
                else:
                    ref = str(op.get("ref") or "").strip().replace("$", "")
                    if not ref:
                        raise OfficeError("cells op requires 'ref' (e.g. 'B2' or 'B2:D10')")
                    sheet_name, min_col, min_row, max_col, max_row = parse_sheet_ref(ref, sheet_name)
                    values = op.get("values")
                    if not isinstance(values, list) or not values:
                        raise OfficeError("cells op requires a non-empty 'values' array of arrays")
                    # 小模型容错：values 常写成扁平数组 ["a","b"]。
                    # 若引用是单行多列（如 A1:B1）→ 视为一行；否则视为单列多行。
                    if all(not isinstance(r, list) for r in values):
                        if max_col is not None and max_col > min_col and max_col - min_col + 1 == len(values):
                            values = [values]
                        else:
                            values = [[r] for r in values]
                    values = [r if isinstance(r, list) else [r] for r in values]
                    if max_col is None:
                        max_col = min_col
                        max_row = min_row
                    width = max_col - min_col + 1
                    height = max_row - min_row + 1
                    if len(values) > 1 and len(values) != height:
                        raise OfficeError(
                            "ref %s is %d row(s) but values has %d row(s)" % (ref, height, len(values))
                        )
                    if len(values[0]) > 1 and len(values[0]) != width:
                        raise OfficeError(
                            "ref %s is %d column(s) but values row has %d value(s)" % (ref, width, len(values[0]))
                        )
                    if len(values) == 1 and height > 1 and len(values[0]) == width:
                        values = [list(values[0]) for _ in range(height)]
                    elif len(values) == height and len(values[0]) == 1 and width > 1:
                        values = [[row[0]] for row in values]

                # 小模型容错：新建文件默认工作表名是 "Sheet"（非 "Sheet1"），
                # 模型常猜错名字导致 "Worksheet not found"。新建且只有一个
                # 工作表时，自动归一为用户指定的任意名字 → 默认表。
                if sheet_name and sheet_name not in state["wb_values"].sheetnames:
                    if created and len(state["wb_edit"].sheetnames) == 1:
                        sheet_name = state["wb_edit"].sheetnames[0]
                sheet_name = _sheet_or_default(state["wb_values"], sheet_name, state["wb_values"])
                if not sheet_exists(sheet_name):
                    if created and len(state["wb_edit"].sheetnames) == 1:
                        sheet_name = state["wb_edit"].sheetnames[0]
                    else:
                        raise OfficeError("Worksheet '%s' not found. Available: %s" % (sheet_name, ", ".join(state["wb_edit"].sheetnames)))
                md, changed = xlsx_range_preview(
                    state["wb_values"][sheet_name], sheet_name, min_col, min_row, values
                )
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "%s!%s" % (sheet_name, cell_ref(min_col, min_row)),
                        "markdown": md,
                        "changed": changed,
                        "_apply": {
                            "sheet": sheet_name,
                            "min_col": min_col,
                            "min_row": min_row,
                            "values": values,
                        },
                    }
                )
            elif kind == "add_sheet":
                name = str(op.get("name") or "").strip()
                if not name:
                    raise OfficeError("add_sheet requires 'name'")
                if name in state["wb_edit"].sheetnames:
                    raise OfficeError("Worksheet '%s' already exists" % name)
                plans.append({"ok": True, "op": kind, "target": name, "markdown": "**新增工作表** `%s`" % name, "_apply": {"name": name}})
                state["planned_sheets"].add(name)
                # Mirror it so later ops in the same call can target the new sheet.
                if name not in state["wb_values"].sheetnames:
                    state["wb_values"].create_sheet(title=name)
            elif kind == "formula":
                ref = str(op.get("ref") or "").strip().replace("$", "")
                formula = str(op.get("formula") or "").strip()
                if not ref or not formula:
                    raise OfficeError("formula op requires 'ref' (e.g. 'D2') and 'formula' (e.g. '=SUM(B2:B10)')")
                sheet_name, f_min_col, f_min_row, _, _ = parse_sheet_ref(ref, op.get("sheet"))
                # 小模型容错：新建文件默认表名归一
                if sheet_name and sheet_name not in state["wb_values"].sheetnames:
                    if created and len(state["wb_edit"].sheetnames) == 1:
                        sheet_name = state["wb_edit"].sheetnames[0]
                sheet_name = _sheet_or_default(state["wb_values"], sheet_name, state["wb_values"])
                if not sheet_exists(sheet_name):
                    if created and len(state["wb_edit"].sheetnames) == 1:
                        sheet_name = state["wb_edit"].sheetnames[0]
                    else:
                        raise OfficeError("Worksheet '%s' not found. Available: %s" % (sheet_name, ", ".join(state["wb_edit"].sheetnames)))
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "%s!%s" % (sheet_name, ref),
                        "markdown": "**工作表 `%s` · `%s` ← 公式 `%s`**" % (sheet_name, ref, formula),
                        "changed": 1,
                        "_apply": {"sheet": sheet_name, "row": f_min_row, "col": f_min_col, "formula": formula},
                    }
                )
            elif kind == "chart":
                ctype = str(op.get("type") or "bar").strip().lower()
                if ctype not in XLSX_CHART_TYPES:
                    raise OfficeError("chart type must be one of: %s" % ", ".join(XLSX_CHART_TYPES))
                rng = str(op.get("range") or op.get("data_range") or "").strip().replace("$", "")
                if not rng:
                    raise OfficeError("chart op requires 'range' (e.g. 'A1:B8')")
                sheet_name = _sheet_or_default(state["wb_values"], op.get("sheet"), state["wb_values"])
                sheet_name, min_col, min_row, max_col, max_row = parse_sheet_ref(rng, sheet_name)
                sheet_name = _sheet_or_default(state["wb_values"], sheet_name, state["wb_values"])
                if not sheet_exists(sheet_name):
                    raise OfficeError(
                        "Worksheet '%s' not found. Available: %s" % (sheet_name, ", ".join(state["wb_edit"].sheetnames))
                    )
                if max_col is None:
                    max_col, max_row = min_col, min_row
                if max_row - min_row < 1 or max_col - min_col < 1:
                    raise OfficeError("chart range %s must be at least 2x2 (header row + labels column)" % rng)
                anchor = str(op.get("anchor") or "").strip().replace("$", "")
                if not anchor:
                    anchor = "%s%d" % (get_column_letter(max_col + 2), min_row)
                title = str(op.get("title") or "")
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "%s!%s" % (sheet_name, rng),
                        "markdown": "**新增图表**（%s）\n- 数据区：`%s!%s`\n- 标题：%s\n- 放置位置：`%s`"
                        % (ctype, sheet_name, rng, title or "(无)", anchor),
                        "_apply": {
                            "sheet": sheet_name,
                            "type": ctype,
                            "min_col": min_col,
                            "min_row": min_row,
                            "max_col": max_col,
                            "max_row": max_row,
                            "anchor": anchor,
                            "title": title,
                        },
                    }
                )
            else:
                raise OfficeError(
                    "Unsupported xlsx op '%s'. Supported: cells, rows, add_sheet, chart, formula" % kind
                )
        except OfficeError as exc:
            plans.append(_op_error(op, str(exc), getattr(exc, "detail", None)))

    def apply():
        wb = state["wb_edit"]
        for plan in plans:
            if not plan.get("ok"):
                continue
            spec = plan["_apply"]
            if plan["op"] in ("cells", "rows"):
                ws = wb[spec["sheet"]]
                for i, row_vals in enumerate(spec["values"]):
                    for j, value in enumerate(row_vals):
                        ws.cell(row=spec["min_row"] + i, column=spec["min_col"] + j, value=value)
            elif plan["op"] == "formula":
                ws = wb[spec["sheet"]]
                ws.cell(row=spec["row"], column=spec["col"]).value = spec["formula"]
            elif plan["op"] == "add_sheet":
                wb.create_sheet(title=spec["name"])
            elif plan["op"] == "chart":
                _add_xlsx_chart(wb, wb[spec["sheet"]], spec)
        if created:
            _drop_unused_default_sheet(wb, plans)
        tmp = path + ".tmp-%d" % os.getpid()
        wb.save(tmp)
        os.replace(tmp, out_path or path)

    return plans, apply


def _drop_unused_default_sheet(wb, plans):
    """A freshly created workbook ships an empty default sheet - drop it when
    every op targeted sheets that were added explicitly."""
    if len(wb.sheetnames) < 2:
        return
    used = set()
    for plan in plans:
        if not plan.get("ok"):
            continue
        if plan["op"] in ("cells", "rows", "chart", "formula"):
            used.add(plan["_apply"]["sheet"])
        elif plan["op"] == "add_sheet":
            used.add(plan["_apply"]["name"])
    for name in list(wb.sheetnames):
        if name not in used:
            try:
                ws = wb[name]
                if not ws._cells.values() or all(cell.value is None for cell in ws._cells.values()):
                    wb.remove(ws)
            except Exception:
                pass


def _add_xlsx_chart(wb, ws, spec):
    from openpyxl.chart import AreaChart, BarChart, LineChart, PieChart, Reference, ScatterChart

    ctype = spec["type"]
    min_col, min_row = spec["min_col"], spec["min_row"]
    max_col, max_row = spec["max_col"], spec["max_row"]
    # Column A = categories, columns B.. = one series each (row 1 = series title).
    data = Reference(ws, min_col=min_col + 1, min_row=min_row, max_row=max_row, max_col=max_col)
    cats = Reference(ws, min_col=min_col, min_row=min_row + 1, max_row=max_row)
    if ctype == "bar":
        chart = BarChart()
    elif ctype == "line":
        chart = LineChart()
    elif ctype == "area":
        chart = AreaChart()
    elif ctype == "scatter":
        chart = ScatterChart()
    else:
        chart = PieChart()
    if ctype == "pie":
        chart.add_data(Reference(ws, min_col=min_col + 1, min_row=min_row, max_row=max_row), titles_from_data=True)
    else:
        chart.add_data(data, titles_from_data=True)
    chart.set_categories(cats)
    if spec.get("title"):
        chart.title = spec["title"]
    if ctype not in ("pie", "scatter"):
        chart.x_axis = chart.x_axis
        chart.y_axis.title = None
    chart.height = 7.5
    chart.width = 14
    ws.add_chart(chart, spec["anchor"])


def _plan_docx(ops, path, out_path=None, created=False):
    from docx import Document

    doc = Document(path) if os.path.isfile(path) else Document()
    plans = []

    for op in ops:
        kind = str(op.get("op") or "").strip()
        try:
            if kind in ("replace", "heading"):
                at = str(op.get("at") or "").strip()
                if at in ("#append", "#end"):
                    text = str(op.get("text") or "")
                    if kind == "heading":
                        level = int(op.get("level") or 1)
                        if level < 1 or level > 9:
                            raise OfficeError("heading level must be 1-9")
                        plans.append(
                            {
                                "ok": True,
                                "op": kind,
                                "target": "#append",
                                "markdown": "**在文档末尾追加标题**\n- 层级：H%d\n- 内容：%s" % (level, clip(text, 600) or "(empty)"),
                                "_apply": {"text": text, "style": "Heading %d" % level, "mode": "append_heading"},
                            }
                        )
                    else:
                        plans.append(
                            {
                                "ok": True,
                                "op": kind,
                                "target": "#append",
                                "markdown": "**在文档末尾追加段落**\n- 内容：%s" % (clip(text, 600) or "(empty)"),
                                "_apply": {"text": text, "mode": "append"},
                            }
                        )
                    continue
                if not at.startswith("#") or at.startswith("#T"):
                    raise OfficeError("docx '%s' op requires at='#<paragraph index>' or at='#append' (e.g. '#12')" % kind)
                index = int(at[1:])
                if kind == "heading":
                    level = int(op.get("level") or 1)
                    if level < 1 or level > 9:
                        raise OfficeError("heading level must be 1-9")
                    text = str(op.get("text") or "")
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "#%d" % index,
                            "markdown": _docx_paragraph_preview(doc, index, text, style="Heading %d" % level),
                            "_apply": {"index": index, "text": text, "style": "Heading %d" % level, "mode": "heading"},
                        }
                    )
                else:
                    text = str(op.get("text") or "")
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "#%d" % index,
                            "markdown": _docx_paragraph_preview(doc, index, text),
                            "_apply": {"index": index, "text": text, "mode": "replace"},
                        }
                    )
            elif kind == "insert":
                after = str(op.get("after") or "").strip()
                if after in ("#append", "#end"):
                    text = str(op.get("text") or "")
                    style = op.get("style")
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "#append",
                            "markdown": "**在文档末尾追加段落**\n- 内容：%s\n- 样式：%s" % (clip(text, 600) or "(empty)", style or "(默认)"),
                            "_apply": {"text": text, "style": style, "mode": "append"},
                        }
                    )
                    continue
                if not after.startswith("#") or after.startswith("#T"):
                    raise OfficeError("docx insert requires after='#<paragraph index>' or after='#append'")
                index = int(after[1:])
                if index < 0 or index >= len(doc.paragraphs):
                    raise OfficeError("Paragraph `#%d` does not exist (document has %d)." % (index, len(doc.paragraphs)))
                text = str(op.get("text") or "")
                style = op.get("style")
                lines = [
                    "**插入到 `#%d` 之后**" % index,
                    "- 位置上文：%s" % (clip(doc.paragraphs[index].text, 200) or "(empty)"),
                    "- 插入内容：%s" % clip(text, 400),
                    "- 样式：%s" % (style or "(沿用默认)"),
                ]
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "#%d+1" % index,
                        "markdown": "\n".join(lines),
                        "_apply": {"index": index, "text": text, "style": style, "mode": "insert"},
                    }
                )
            elif kind == "table":
                at = str(op.get("at") or "").strip()
                if not at.startswith("#T"):
                    raise OfficeError("docx table op requires at='#T<table index>'")
                t_index = int(at[2:])
                if t_index < 0 or t_index >= len(doc.tables):
                    raise OfficeError("Table `#T%d` does not exist (document has %d table(s))." % (t_index, len(doc.tables)))
                table = doc.tables[t_index]
                r = int(op.get("r"))
                c = int(op.get("c"))
                if r < 0 or r >= len(table.rows) or c < 0 or c >= len(table.columns):
                    raise OfficeError(
                        "Cell R%dC%d out of range (table is %dx%d)." % (r, c, len(table.rows), len(table.columns))
                    )
                text = str(op.get("text") or "")
                old = table.cell(r, c).text
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "#T%d R%dC%d" % (t_index, r, c),
                        "markdown": "**表格 `#T%d` 单元格 R%dC%d**\n- 旧：%s\n- 新：%s"
                        % (t_index, r, c, clip(old, 300) or "(empty)", clip(text, 300) or "(empty)"),
                        "_apply": {"t": t_index, "r": r, "c": c, "text": text, "mode": "table"},
                    }
                )
            elif kind == "add_table":
                rows = op.get("rows")
                if not isinstance(rows, list) or not rows:
                    raise OfficeError("add_table requires a non-empty 'rows' array of arrays")
                rows = [r if isinstance(r, list) else [r] for r in rows]
                if len(rows) > 60:
                    raise OfficeError("add_table supports at most 60 rows (got %d)" % len(rows))
                width = len(rows[0])
                if width < 1 or width > 20:
                    raise OfficeError("add_table needs 1-20 columns per row (row 0 has %d)" % width)
                for i, row in enumerate(rows):
                    if len(row) != width:
                        raise OfficeError("row %d has %d cells but row 0 has %d" % (i, len(row), width))
                header = rows[0]
                body = rows[1:]
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "#T%d(new)" % len(doc.tables),
                        "markdown": "**在文档末尾追加表格**（%d 行 × %d 列）\n\n%s"
                        % (len(rows), width, md_table([str(h) for h in header], [[str(c) for c in r] for r in body])),
                        "_apply": {"rows": rows, "mode": "add_table"},
                    }
                )
            elif kind == "add_image":
                image_path = str(op.get("image") or op.get("file") or "")
                if not image_path or not os.path.isfile(image_path):
                    raise OfficeError("add_image requires an existing 'image' path (got: %s)" % (image_path or "empty"))
                width = op.get("width")
                width = float(width) if width not in (None, "") else None
                if width is not None and width <= 0:
                    raise OfficeError("width must be positive (inches)")
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "#append",
                        "markdown": "**在文档末尾插入图片**\n- 文件：`%s`\n- 宽度：%s" % (image_path, ("%.2f in" % width) if width else "自动"),
                        "_apply": {"image": image_path, "width": width, "mode": "add_image"},
                    }
                )
            elif kind == "content":
                text = str(op.get("markdown") or op.get("text") or "")
                if not text.strip():
                    raise OfficeError("content requires a non-empty 'markdown' string")
                blocks = parse_markdown_blocks(text)
                if not blocks:
                    raise OfficeError("content markdown produced no blocks")
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "#append x%d" % len(blocks),
                        "markdown": "**按 Markdown 追加内容（解析后）**\n\n" + blocks_to_markdown(blocks),
                        "_apply": {"blocks": blocks, "mode": "content"},
                    }
                )
            else:
                raise OfficeError(
                    "Unsupported docx op '%s'. Supported: replace, insert, heading, table, add_table, add_image, content"
                    % kind
                )
        except OfficeError as exc:
            plans.append(_op_error(op, str(exc), getattr(exc, "detail", None)))

    def apply():
        for plan in plans:
            if not plan.get("ok"):
                continue
            spec = plan["_apply"]
            mode = spec["mode"]
            if mode == "replace":
                paragraph = doc.paragraphs[spec["index"]]
                font = _capture_run_font(paragraph)
                paragraph.text = spec["text"]
                _apply_run_font(paragraph, font)
            elif mode == "heading":
                paragraph = doc.paragraphs[spec["index"]]
                font = _capture_run_font(paragraph)
                paragraph.style = spec["style"]
                paragraph.text = spec["text"]
                _apply_run_font(paragraph, font)
            elif mode == "insert":
                index = spec["index"]
                if index + 1 < len(doc.paragraphs):
                    created = doc.paragraphs[index + 1].insert_paragraph_before(spec["text"], style=spec["style"])
                    _apply_run_font(created, _capture_run_font(doc.paragraphs[index]))
                else:
                    created = doc.add_paragraph(spec["text"], style=spec["style"])
            elif mode == "table":
                doc.tables[spec["t"]].cell(spec["r"], spec["c"]).text = spec["text"]
            elif mode == "append_heading":
                doc.add_paragraph(spec["text"], style=spec["style"])
            elif mode == "append":
                doc.add_paragraph(spec["text"], style=spec.get("style"))
            elif mode == "add_table":
                rows = spec["rows"]
                table = doc.add_table(rows=len(rows), cols=len(rows[0]))
                try:
                    table.style = "Table Grid"
                except Exception:
                    pass
                for r, row in enumerate(rows):
                    for c, value in enumerate(row):
                        table.cell(r, c).text = "" if value is None else str(value)
            elif mode == "add_image":
                from docx.shared import Inches as DocxInches

                if spec.get("width"):
                    doc.add_picture(spec["image"], width=DocxInches(spec["width"]))
                else:
                    doc.add_picture(spec["image"])
            elif mode == "content":
                _append_markdown_blocks(doc, spec["blocks"])
        tmp = path + ".tmp-%d" % os.getpid()
        doc.save(tmp)
        os.replace(tmp, out_path or path)

    return plans, apply


def _plan_pptx(ops, path, out_path, created=False):
    from pptx import Presentation
    from pptx.util import Inches as PptxInches, Pt

    prs = Presentation(path) if os.path.isfile(path) else Presentation()
    plans = []

    for op in ops:
        kind = str(op.get("op") or "").strip()
        try:
            if kind in ("set_text", "title", "table", "image", "delete_shape"):
                slide_no = int(op.get("slide"))
                slide = get_slide(prs, slide_no)
                ref = op.get("shape")
                if kind == "title" and not ref:
                    ref = None
                if ref:
                    shape = find_shape(slide, ref)
                elif kind == "title":
                    shape = None
                    for candidate in slide.shapes:
                        if candidate.is_placeholder and candidate.placeholder_format.idx == 0:
                            shape = candidate
                            break
                    if shape is None:
                        raise OfficeError(
                            "Slide %d has no title placeholder." % slide_no,
                            detail={"available": ["#%s (%s)" % (s.shape_id, s.name) for s in slide.shapes]},
                        )
                else:
                    raise OfficeError("pptx '%s' op requires shape ('#5' or shape name)" % kind)

                if kind == "set_text":
                    text = str(op.get("text") or "")
                    if not getattr(shape, "has_text_frame", False):
                        raise OfficeError("Shape #%s has no text frame." % shape.shape_id)
                    old = clip(shape.text_frame.text, 400)
                    md = "%s %s\n- 旧：%s\n- 新：%s" % (
                        _shape_anchor(slide_no, shape),
                        _shape_pos(shape),
                        old or "(empty)",
                        clip(text, 400) or "(empty)",
                    )
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "slide%d#%s" % (slide_no, shape.shape_id),
                            "markdown": md,
                            "_apply": {"slide": slide_no, "shape": shape.shape_id, "text": text, "mode": "set_text"},
                        }
                    )
                elif kind == "title":
                    text = str(op.get("text") or "")
                    old = clip(shape.text_frame.text, 400) if getattr(shape, "has_text_frame", False) else ""
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "slide%d#%s" % (slide_no, shape.shape_id),
                            "markdown": "**第 %d 页标题** `#%s`\n- 旧：%s\n- 新：%s"
                            % (slide_no, shape.shape_id, old or "(empty)", clip(text, 400) or "(empty)"),
                            "_apply": {"slide": slide_no, "shape": shape.shape_id, "text": text, "mode": "set_text"},
                        }
                    )
                elif kind == "table":
                    if not getattr(shape, "has_table", False):
                        raise OfficeError("Shape #%s is not a table." % shape.shape_id)
                    table = shape.table
                    r = int(op.get("r"))
                    c = int(op.get("c"))
                    if r < 0 or r >= len(table.rows) or c < 0 or c >= len(table.columns):
                        raise OfficeError(
                            "Cell R%dC%d out of range (table is %dx%d on slide %d)." % (r, c, len(table.rows), len(table.columns), slide_no)
                        )
                    text = str(op.get("text") or "")
                    old = table.cell(r, c).text
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "slide%d#%s R%dC%d" % (slide_no, shape.shape_id, r, c),
                            "markdown": "%s [TABLE]\n- 单元格 R%dC%d\n- 旧：%s\n- 新：%s"
                            % (_shape_anchor(slide_no, shape), r, c, clip(old, 300) or "(empty)", clip(text, 300) or "(empty)"),
                            "_apply": {"slide": slide_no, "shape": shape.shape_id, "r": r, "c": c, "text": text, "mode": "table"},
                        }
                    )
                elif kind == "image":
                    image_path = str(op.get("file") or "")
                    if not image_path or not os.path.isfile(image_path):
                        raise OfficeError("image op requires an existing 'file' path")
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "slide%d#%s" % (slide_no, shape.shape_id),
                            "markdown": "%s %s\n- 用图片替换：%s" % (_shape_anchor(slide_no, shape), _shape_pos(shape), image_path),
                            "_apply": {"slide": slide_no, "shape": shape.shape_id, "file": image_path, "mode": "image"},
                        }
                    )
                elif kind == "delete_shape":
                    plans.append(
                        {
                            "ok": True,
                            "op": kind,
                            "target": "slide%d#%s" % (slide_no, shape.shape_id),
                            "markdown": "%s %s\n- 将被删除" % (_shape_anchor(slide_no, shape), _shape_pos(shape)),
                            "_apply": {"slide": slide_no, "shape": shape.shape_id, "mode": "delete_shape"},
                        }
                    )
            elif kind == "textbox":
                slide_no = int(op.get("slide"))
                slide = get_slide(prs, slide_no)
                for key in ("x", "y", "w", "h"):
                    if op.get(key) is None:
                        raise OfficeError("textbox op requires numeric '%s' (inches)" % key)
                x, y, w, h = float(op.get("x")), float(op.get("y")), float(op.get("w")), float(op.get("h"))
                text = str(op.get("text") or "")
                size = op.get("size")
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "slide%d@new" % slide_no,
                        "markdown": "**第 %d 页新增文本框** @ (%.2fin, %.2fin) %.2f x %.2fin%s\n- 内容：%s"
                        % (
                            slide_no,
                            x,
                            y,
                            w,
                            h,
                            ("，字号 %spt" % size) if size else "",
                            clip(text, 600) or "(empty)",
                        ),
                        "_apply": {
                            "slide": slide_no,
                            "x": x,
                            "y": y,
                            "w": w,
                            "h": h,
                            "text": text,
                            "size": size,
                            "bold": op.get("bold"),
                            "align": op.get("align"),
                            "mode": "textbox",
                        },
                    }
                )
            elif kind == "add_slide":
                layout_name = op.get("layout")
                layout = None
                for candidate in prs.slide_layouts:
                    if layout_name and candidate.name == layout_name:
                        layout = candidate
                        break
                if layout is None:
                    layout = prs.slide_layouts[1] if len(prs.slide_layouts) > 1 else prs.slide_layouts[0]
                title = str(op.get("title") or "")
                bullets = [str(b) for b in (op.get("bullets") or [])]
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "slide%d(new)" % (len(prs.slides._sldIdLst) + 1),
                        "markdown": "**新增幻灯片**（layout `%s`）\n- 标题：%s\n- 要点：%s"
                        % (layout.name, title or "(empty)", "；".join(bullets) if bullets else "(none)"),
                        "_apply": {"layout": layout.name, "title": title, "bullets": bullets, "mode": "add_slide"},
                    }
                )
            elif kind == "outline":
                text = str(op.get("markdown") or op.get("text") or "")
                if not text.strip():
                    raise OfficeError("outline requires a non-empty 'markdown' string")
                slides = parse_outline_slides(text)
                if not slides:
                    raise OfficeError("outline markdown produced no slides")
                plans.append(
                    {
                        "ok": True,
                        "op": kind,
                        "target": "%d slide(s)" % len(slides),
                        "markdown": "**按大纲生成幻灯片（%d 页）**\n\n%s" % (len(slides), outline_to_markdown(slides)),
                        "_apply": {"slides": slides, "mode": "outline"},
                    }
                )
            else:
                raise OfficeError(
                    "Unsupported pptx op '%s'. Supported: set_text, title, textbox, table, image, delete_shape, add_slide, outline"
                    % kind
                )
        except OfficeError as exc:
            plans.append(_op_error(op, str(exc), getattr(exc, "detail", None)))

    def apply():
        for plan in plans:
            if not plan.get("ok"):
                continue
            spec = plan["_apply"]
            mode = spec["mode"]
            if mode in ("set_text", "table", "image", "delete_shape"):
                slide = get_slide(prs, spec["slide"])
                shape = None
                for candidate in slide.shapes:
                    if str(candidate.shape_id) == str(spec["shape"]):
                        shape = candidate
                        break
                if shape is None:
                    raise OfficeError("Shape #%s disappeared during apply." % spec["shape"])
                if mode == "set_text":
                    font = _capture_ppt_font(shape)
                    set_shape_text(shape, spec["text"], font=font)
                elif mode == "table":
                    shape.table.cell(spec["r"], spec["c"]).text = spec["text"]
                elif mode == "image":
                    with open(spec["file"], "rb") as fh:
                        blob = fh.read()
                    from io import BytesIO

                    slide.shapes.add_picture(BytesIO(blob), shape.left, shape.top, shape.width, shape.height)
                    sp = shape._element
                    sp.getparent().remove(sp)
                elif mode == "delete_shape":
                    sp = shape._element
                    sp.getparent().remove(sp)
            elif mode == "textbox":
                slide = get_slide(prs, spec["slide"])
                box = slide.shapes.add_textbox(
                    PptxInches(spec["x"]), PptxInches(spec["y"]), PptxInches(spec["w"]), PptxInches(spec["h"])
                )
                tf = box.text_frame
                tf.word_wrap = True
                lines = spec["text"].split("\n")
                tf.paragraphs[0].text = lines[0]
                for extra in lines[1:]:
                    tf.add_paragraph().text = extra
                if spec.get("size"):
                    for paragraph in tf.paragraphs:
                        for run in paragraph.runs:
                            run.font.size = Pt(int(spec["size"]))
                if spec.get("bold") is not None:
                    for paragraph in tf.paragraphs:
                        for run in paragraph.runs:
                            run.font.bold = bool(spec["bold"])
            elif mode == "add_slide":
                layout = None
                for candidate in prs.slide_layouts:
                    if candidate.name == spec["layout"]:
                        layout = candidate
                        break
                if layout is None:
                    layout = prs.slide_layouts[0]
                slide = prs.slides.add_slide(layout)
                for shape in slide.placeholders:
                    try:
                        idx = shape.placeholder_format.idx
                    except Exception:
                        continue
                    if idx == 0 and spec["title"]:
                        set_shape_text(shape, spec["title"])
                    elif idx == 1 and spec["bullets"]:
                        set_shape_text(shape, "\n".join(spec["bullets"]))
            elif mode == "outline":
                _append_outline_slides(prs, spec["slides"])
        tmp = path + ".tmp-%d" % os.getpid()
        prs.save(tmp)
        os.replace(tmp, out_path or path)

    return plans, apply


def _backup(path):
    base, ext = os.path.splitext(path)
    backup_path = base + ".bak" + ext
    try:
        shutil.copy2(path, backup_path)
        return backup_path
    except Exception:
        return None


def op_write(payload):
    path = payload.get("path")
    created = not check_writable_source(path)
    fmt = detect_format(path)
    if fmt not in ("xlsx", "docx", "pptx"):
        raise OfficeError(
            "Writing is supported for xlsx, docx and pptx only (got '.%s'). For pdf/csv/txt use doc_convert or the normal text tools."
            % os.path.splitext(path)[1].lstrip(".")
        )

    ops = payload.get("ops")
    if not isinstance(ops, list) or not ops:
        raise OfficeError("ops must be a non-empty array")
    if len(ops) > MAX_OPS:
        raise OfficeError("Too many ops (%d, limit %d)" % (len(ops), MAX_OPS))

    mode = str(payload.get("mode") or "preview").strip().lower()
    if mode not in ("preview", "apply"):
        raise OfficeError("mode must be 'preview' or 'apply' (got '%s')" % mode)
    out_path = payload.get("out")
    if out_path:
        out_ext = os.path.splitext(out_path)[1].lower()
        if out_ext != os.path.splitext(path)[1].lower():
            raise OfficeError("out must keep the same extension as the source (use doc_convert to change format)")
    do_backup = bool(payload.get("backup", True))

    if fmt == "xlsx":
        plans, apply = _plan_xlsx(ops, path, out_path, created=created)
    elif fmt == "docx":
        plans, apply = _plan_docx(ops, path, out_path, created=created)
    else:
        plans, apply = _plan_pptx(ops, path, out_path, created=created)

    failed = [p for p in plans if not p.get("ok")]
    result = {
        "format": fmt,
        "mode": mode,
        "path": path,
        "out": out_path or path,
        "created": created,
        "total": len(plans),
        "ok": len(plans) - len(failed),
        "failed": len(failed),
        "plans": [
            {k: v for k, v in plan.items() if not k.startswith("_")}
            for plan in plans
        ],
    }
    if failed:
        parts = ["### ❌ %d / %d 个操作无法执行（未写入文件）" % (len(failed), len(plans)), ""]
        for i, plan in enumerate(plans, start=1):
            if plan.get("ok"):
                continue
            parts.append("**%d. op %s** — %s" % (i, plan.get("op", "?"), plan.get("error", "")))
        result["markdown"] = "\n".join(parts).rstrip()
        result["applied"] = False
        return result

    if mode == "preview":
        head = "### 新建文件预览（尚未写入）" if created else "### 写入预览（尚未写入文件）"
        parts = [head, ""]
        if created:
            parts.append("_`%s` 不存在，将新建该文件。_" % path)
            parts.append("")
        for i, plan in enumerate(plans, start=1):
            parts.append("**%d. op `%s` → `%s`**" % (i, plan["op"], plan.get("target", "")))
            parts.append(plan.get("markdown", ""))
            parts.append("")
        result["markdown"] = "\n".join(parts).rstrip()
        result["applied"] = False
        return result

    backup_path = _backup(path) if do_backup and not out_path and not created and os.path.isfile(path) else None
    try:
        apply()
    except OfficeError as exc:
        raise OfficeError(str(exc), getattr(exc, "detail", None))
    except Exception as exc:
        raise OfficeError("Apply failed: %s" % exc, traceback.format_exc().splitlines()[-3:])
    result["applied"] = True
    result["backup"] = backup_path
    written = out_path or path
    verb = "已创建" if created else "已写入"
    parts = ["### %s `%s`" % (verb, written), ""]
    for i, plan in enumerate(plans, start=1):
        parts.append("**%d. op `%s` → `%s`**" % (i, plan["op"], plan.get("target", "")))
        parts.append(plan.get("markdown", ""))
        parts.append("")
    if backup_path:
        parts.append("_原文件已备份为 `%s`_" % backup_path)
    result["markdown"] = "\n".join(parts).rstrip()
    return result


# ─── Convert ──────────────────────────────────────────────────────────────────

CONVERT_TARGETS = ("pdf", "docx", "xlsx", "pptx", "txt", "csv", "html")
CONVERT_SOURCES = {
    ".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".markdown", ".html", ".htm",
    ".xls", ".xlsx", ".xlsm", ".ods", ".csv", ".tsv",
    ".ppt", ".pptx", ".odp", ".pdf",
}


def _find_soffice():
    env = os.environ.get("SMALLCLAW_SOFFICE")
    if env and os.path.isfile(env):
        return env
    for name in ("soffice.com", "soffice.exe", "soffice"):
        found = shutil.which(name)
        if found:
            return found
    if os.name == "nt":
        roots = [os.environ.get("ProgramFiles") or "", os.environ.get("ProgramFiles(x86)") or "", "C:\\Program Files"]
        for root in roots:
            if not root:
                continue
            for rel in ("LibreOffice\\program\\soffice.com", "LibreOffice\\program\\soffice.exe"):
                cand = os.path.join(root, rel)
                if os.path.isfile(cand):
                    return cand
    return None


def _soffice_profile_dir():
    base = os.path.join(os.environ.get("TEMP") or os.path.gettempdir(), "smallclaw-lo")
    os.makedirs(base, exist_ok=True)
    return os.path.join(base, "profile-%d" % os.getpid())


def _run_soffice(soffice, args, timeout=180):
    import subprocess

    creationflags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    try:
        proc = subprocess.run(
            [soffice] + args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            creationflags=creationflags,
        )
    except subprocess.TimeoutExpired:
        raise OfficeError("Conversion timed out after %ds" % timeout)
    out = ((proc.stdout or b"") + b"\n" + (proc.stderr or b"")).decode("utf-8", "replace").strip()
    return proc.returncode, out


def _markdown_to_html(text):
    try:
        import markdown

        return markdown.markdown(text, extensions=["tables", "fenced_code"])
    except Exception:
        return "<pre>%s</pre>" % text.replace("&", "&amp;").replace("<", "&lt;")


def op_convert(payload):
    src = payload.get("path")
    check_readable(src)
    ext = os.path.splitext(str(src))[1].lower()
    if ext not in CONVERT_SOURCES:
        raise OfficeError("Cannot convert '%s' files. Supported sources: %s" % (ext, ", ".join(sorted(CONVERT_SOURCES))))

    to = str(payload.get("to") or "").strip().lower().lstrip(".")
    if to == "md":
        to = "markdown_target_unsupported"
    if to not in CONVERT_TARGETS:
        raise OfficeError(
            "Unsupported conversion target '%s'. Supported: %s" % (to, ", ".join(CONVERT_TARGETS))
        )
    if ext == ".%s" % to:
        raise OfficeError("Source is already %s" % to)

    out = payload.get("out")
    if out:
        out_ext = os.path.splitext(str(out))[1].lower().lstrip(".")
        if out_ext != to:
            raise OfficeError("out must end with '.%s'" % to)
    else:
        out = os.path.splitext(src)[0] + "." + to

    workdir = os.path.dirname(os.path.abspath(str(out))) or "."
    if not os.path.isdir(workdir):
        raise OfficeError("Output directory does not exist: %s" % workdir)

    # Fast paths that do not need LibreOffice.
    if ext == ".pdf" and to == "txt":
        from pypdf import PdfReader

        reader = PdfReader(src)
        text = "\n\n".join((page.extract_text() or "") for page in reader.pages)
        with open(out, "w", encoding="utf-8", errors="replace") as fh:
            fh.write(text)
        return _convert_result(src, out, to, "pypdf")

    if ext in (".md", ".markdown") and to == "txt":
        with open(src, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(raw)
        return _convert_result(src, out, to, "copy")

    # Markdown -> docx without LibreOffice. The soffice route (md -> html ->
    # soffice) fails on machines where LibreOffice cannot load its own filters
    # ("no export filter ... found"), and python-docx is already required here,
    # so build the document directly instead of shelling out.
    if ext in (".md", ".markdown") and to == "docx":
        from docx import Document

        with open(src, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
        blocks = parse_markdown_blocks(raw)
        doc = Document()
        if blocks:
            _append_markdown_blocks(doc, blocks)
        else:
            for line in raw.split("\n"):
                doc.add_paragraph(line)
        tmp = out + ".tmp-%d" % os.getpid()
        doc.save(tmp)
        os.replace(tmp, out)
        return _convert_result(src, out, to, "python-docx")

    soffice = _find_soffice()
    if not soffice:
        raise OfficeError("LibreOffice (soffice) not found. Install LibreOffice or set SMALLCLAW_SOFFICE.")

    source_for_soffice = src
    if ext in (".md", ".markdown"):
        with open(src, "r", encoding="utf-8", errors="replace") as fh:
            html = _markdown_to_html(fh.read())
        tmp_html = src + ".smallclaw-convert.html"
        with open(tmp_html, "w", encoding="utf-8") as fh:
            fh.write(html)
        source_for_soffice = tmp_html
    else:
        tmp_html = None

    tmp_out_dir = os.path.join(workdir, ".smallclaw-convert-%d" % os.getpid())
    os.makedirs(tmp_out_dir, exist_ok=True)
    profile = _soffice_profile_dir()
    try:
        rc, log = _run_soffice(
            soffice,
            [
                "-env:UserInstallation=file:///" + profile.replace("\\", "/"),
                "--headless",
                "--norestore",
                "--nolockcheck",
                "--convert-to",
                to,
                "--outdir",
                tmp_out_dir,
                source_for_soffice,
            ],
        )
        stem = os.path.splitext(os.path.basename(source_for_soffice))[0]
        produced = os.path.join(tmp_out_dir, stem + "." + to)
        if not os.path.isfile(produced):
            produced = None
            for entry in os.listdir(tmp_out_dir):
                if entry.lower().endswith("." + to):
                    produced = os.path.join(tmp_out_dir, entry)
                    break
        if not produced:
            raise OfficeError(
                "LibreOffice did not produce a .%s file (exit %s). Do NOT retry this conversion - "
                "it will fail identically because this is a local LibreOffice installation problem, "
                "not a problem with the source file. Options: repair/reinstall LibreOffice (or set "
                "SMALLCLAW_SOFFICE), pick a different target format, or leave the source as-is. "
                "(.md -> .docx no longer uses LibreOffice, so that one works regardless.)" % (to, rc),
                detail=log[-800:] or None,
            )
        os.replace(produced, out)
    finally:
        if tmp_html and os.path.isfile(tmp_html):
            try:
                os.remove(tmp_html)
            except Exception:
                pass
        try:
            shutil.rmtree(tmp_out_dir, ignore_errors=True)
            shutil.rmtree(profile, ignore_errors=True)
        except Exception:
            pass

    return _convert_result(src, out, to, "libreoffice")


def _convert_result(src, out, to, engine):
    try:
        size = os.path.getsize(out)
    except Exception:
        size = 0
    return {
        "format": to,
        "source": src,
        "out": out,
        "bytes": size,
        "engine": engine,
        "markdown": "### 已转换\n- 源：%s\n- 目标：%s（%s，%.1f KB）" % (src, out, to, size / 1024.0),
        "text": "%s -> %s" % (src, out),
    }


# ─── Standalone chart (PNG) ───────────────────────────────────────────────────

CHART_SIZE_DEFAULTS = {
    "a4": (1654, 1169),
    "1080x1920": (1080, 1920),
    "1080x1080": (1080, 1080),
    "1920x1080": (1920, 1080),
    "1200x400": (1200, 400),
}


def _setup_matplotlib():
    try:
        import matplotlib
    except Exception as exc:
        raise OfficeError("matplotlib is not installed - run: pip install matplotlib (%s)" % exc)
    matplotlib.use("Agg")
    try:
        from matplotlib import font_manager, rcParams

        preferred = (
            "Microsoft YaHei", "SimHei", "PingFang SC", "Noto Sans CJK SC",
            "Source Han Sans SC", "WenQuanYi Zen Hei", "Arial Unicode MS",
        )
        available = {f.name for f in font_manager.fontManager.ttflist}
        for name in preferred:
            if name in available:
                rcParams["font.sans-serif"] = [name]
                rcParams["font.family"] = "sans-serif"
                break
        rcParams["axes.unicode_minus"] = False
    except Exception:
        pass
    return matplotlib


def _chart_rows(payload):
    data = payload.get("data")
    if isinstance(data, list) and data:
        rows = [r if isinstance(r, list) else [r] for r in data]
        return [[("" if c is None else c) for c in row] for row in rows]

    path = payload.get("path")
    if not path:
        raise OfficeError("chart needs 'data' (array of rows) or 'path' (xlsx/csv file)")
    check_readable(path)
    fmt = detect_format(path)
    if fmt == "xlsx":
        wb = _load_xlsx_values(path)
        target = str(payload.get("range") or "").strip().replace("$", "")
        sheet = payload.get("sheet")
        if target:
            sheet, min_col, min_row, max_col, max_row = parse_sheet_ref(target, sheet)
            sheet = _sheet_or_default(wb, sheet, wb)
            if sheet not in wb.sheetnames:
                raise OfficeError("Worksheet '%s' not found. Available: %s" % (sheet, ", ".join(wb.sheetnames)))
            ws = wb[sheet]
            if max_col is None:
                max_col, max_row = ws.max_column, ws.max_row
            rows = [
                [ws.cell(row=r, column=c).value for c in range(min_col, max_col + 1)]
                for r in range(min_row, max_row + 1)
            ]
        else:
            ws = wb[wb.sheetnames[0]]
            rows = [list(row) for row in ws.iter_rows(values_only=True)]
        rows = [r for r in rows if any(v not in (None, "") for v in r)]
        if not rows:
            raise OfficeError("No data found in %s" % path)
        return [[("" if c is None else c) for c in row] for row in rows[:501]]
    if fmt == "csv":
        with open(path, "r", encoding="utf-8", errors="replace", newline="") as fh:
            rows = [row for row in csv.reader(fh)]
        rows = [r for r in rows if any(v.strip() for v in r)]
        if not rows:
            raise OfficeError("No data found in %s" % path)
        return rows[:501]
    raise OfficeError("chart source must be .xlsx or .csv (got '.%s')" % os.path.splitext(path)[1].lstrip("."))


def _numeric_series(rows):
    headers = [str(c) if c not in (None, "") else "" for c in rows[0]]
    labels = [("" if r[0] is None else str(r[0])) for r in rows[1:]]
    series = []
    skipped = []
    for col in range(1, len(headers)):
        values = []
        ok = True
        for row in rows[1:]:
            raw = row[col] if col < len(row) else None
            if raw in (None, ""):
                values.append(0.0)
                continue
            try:
                values.append(float(raw))
            except (TypeError, ValueError):
                ok = False
                break
        if ok:
            series.append((headers[col] or ("列%d" % (col + 1)), values))
        else:
            skipped.append(headers[col] or ("列%d" % (col + 1)))
    if not series:
        raise OfficeError(
            "No numeric column found to plot. Numeric columns start at column B (headers: %s)."
            % ", ".join(h for h in headers[1:] if h)
        )
    return labels, series, skipped


def op_chart(payload):
    ctype = str(payload.get("type") or "bar").strip().lower()
    if ctype not in XLSX_CHART_TYPES:
        raise OfficeError("chart type must be one of: %s" % ", ".join(XLSX_CHART_TYPES))
    _setup_matplotlib()
    import matplotlib.pyplot as plt

    rows = _chart_rows(payload)
    if len(rows) < 2:
        raise OfficeError("chart needs a header row plus at least one data row")
    labels, series, skipped = _numeric_series(rows)

    title = str(payload.get("title") or "").strip()
    xlabel = str(payload.get("xlabel") or "").strip()
    ylabel = str(payload.get("ylabel") or "").strip()
    size = str(payload.get("size") or "").strip().lower()
    if size in CHART_SIZE_DEFAULTS:
        width, height = CHART_SIZE_DEFAULTS[size]
    else:
        try:
            width = int(payload.get("width") or 1200)
            height = int(payload.get("height") or 700)
        except (TypeError, ValueError):
            width, height = 1200, 700
    width = max(320, min(width, 4000))
    height = max(240, min(height, 4000))

    out = str(payload.get("out") or "").strip()
    if not out:
        src_path = str(payload.get("path") or "")
        base = os.path.dirname(os.path.abspath(src_path)) if src_path else os.getcwd()
        out = os.path.join(base, "chart-%d-%d.png" % (os.getpid(), int(payload.get("nonce") or 0)))
    out = os.path.abspath(out)
    if not out.lower().endswith(".png"):
        out += ".png"
    out_dir = os.path.dirname(out)
    if not os.path.isdir(out_dir):
        raise OfficeError("Output folder does not exist: %s" % out_dir)

    fig = plt.figure(figsize=(width / 100.0, height / 100.0), dpi=100)
    ax = fig.add_subplot(111)
    x = list(range(len(labels)))

    if ctype == "pie":
        name, values = series[0]
        safe = [v if v > 0 else 0 for v in values]
        if not any(safe):
            raise OfficeError("pie chart needs at least one positive value")
        ax.pie(safe, labels=labels, autopct="%1.1f%%", startangle=90, counterclock=False)
        ax.axis("equal")
        if not title:
            title = name
    else:
        for name, values in series:
            if ctype == "bar":
                ax.bar(x, values, label=name)
            elif ctype == "line":
                ax.plot(x, values, marker="o", linewidth=2, label=name, markersize=4)
            elif ctype == "area":
                ax.stackplot(x, values, label=name, alpha=0.7)
            else:  # scatter
                ax.scatter(x, values, label=name, s=28)
        ax.set_xticks(x)
        long_labels = any(len(str(l)) > 6 for l in labels)
        ax.set_xticklabels(labels, rotation=30 if long_labels else 0, ha="right" if long_labels else "center")
        ax.grid(True, linestyle="--", alpha=0.4)
        ax.legend(loc="best", fontsize=9)
        if xlabel:
            ax.set_xlabel(xlabel)
        if ylabel:
            ax.set_ylabel(ylabel)

    if title:
        ax.set_title(title)
    fig.tight_layout()
    fig.savefig(out, format="png", facecolor="white")
    plt.close(fig)

    try:
        size_bytes = os.path.getsize(out)
    except Exception:
        size_bytes = 0

    result = {
        "ok": True,
        "type": ctype,
        "path": out,
        "bytes": size_bytes,
        "title": title,
        "rows": len(labels),
        "series": [name for name, _ in series],
        "markdown": "### 已生成图表\n- 类型：%s\n- 文件：`%s`（%.1f KB）\n- 数据行：%d\n- 系列：%s%s"
        % (
            ctype,
            out,
            size_bytes / 1024.0,
            len(labels),
            "、".join(name for name, _ in series),
            ("\n- 跳过非数值列：%s" % "、".join(skipped)) if skipped else "",
        ),
    }

    embed = str(payload.get("embed") or "").strip()
    if embed:
        _embed_chart(embed, out, title)
        result["embed"] = embed
        result["markdown"] += "\n- 已插入：`%s`" % embed
    return result


def _embed_chart(target, image_path, title=""):
    if not os.path.isfile(target):
        raise OfficeError("embed target not found: %s" % target)
    ext = os.path.splitext(target)[1].lower()
    if ext == ".docx":
        from docx import Document
        from docx.shared import Inches as DocxInches

        doc = Document(target)
        if title:
            doc.add_paragraph(title)
        doc.add_picture(image_path, width=DocxInches(6.2))
        doc.save(target)
        return
    if ext == ".pptx":
        from pptx import Presentation
        from pptx.util import Inches as PptxInches

        prs = Presentation(target)
        layouts = list(prs.slide_layouts)
        layout = layouts[6] if len(layouts) > 6 else (layouts[5] if len(layouts) > 5 else layouts[0])
        slide = prs.slides.add_slide(layout)
        sw = prs.slide_width
        sh = prs.slide_height
        pic = slide.shapes.add_picture(image_path, 0, 0)
        scale = min(float(sw) / pic.width, float(sh) / pic.height)
        pic.width = int(pic.width * scale)
        pic.height = int(pic.height * scale)
        pic.left = int((float(sw) - pic.width) / 2)
        pic.top = int((float(sh) - pic.height) / 2)
        if title:
            box = slide.shapes.add_textbox(PptxInches(0.4), PptxInches(0.2), PptxInches(9), PptxInches(0.7))
            box.text_frame.text = title
        prs.save(target)
        return
    raise OfficeError("embed target must be .docx or .pptx (got '.%s')" % ext.lstrip("."))


# ─── Dispatch ─────────────────────────────────────────────────────────────────

# ─── Batch ops ─────────────────────────────────────────────────────────────────

def _parse_page_groups(spec):
    """'1-3,5,8-10' -> [(1,3),(5,5),(8,10)]."""
    groups = []
    for part in str(spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-", 1)
            try:
                groups.append((int(a), int(b)))
            except Exception:
                raise OfficeError("Invalid page range '%s' (expected like '1-3,5')" % part)
        else:
            try:
                n = int(part)
            except Exception:
                raise OfficeError("Invalid page number '%s'" % part)
            groups.append((n, n))
    return groups


def op_batch(payload):
    """批量处理：merge_pdf 合并 / split_pdf 拆分 / convert_all 批量转换。"""
    action = str(payload.get("action") or "").strip()

    if action == "merge_pdf":
        files = payload.get("files") or []
        out = payload.get("out")
        if not files:
            raise OfficeError("merge_pdf requires 'files' (list of PDF paths)")
        if not out:
            raise OfficeError("merge_pdf requires 'out' (output PDF path)")
        try:
            import pymupdf
        except Exception:
            import fitz as pymupdf

        merged = pymupdf.open()
        for f in files:
            check_readable(f)
            if os.path.splitext(str(f))[1].lower() != ".pdf":
                raise OfficeError("merge_pdf only supports PDF inputs: %s" % f)
            doc = fitz.open(f)
            merged.insert_pdf(doc)
            doc.close()
        page_count = merged.page_count
        merged.save(out)
        merged.close()
        return {"action": "merge_pdf", "out": out, "pages": page_count}

    if action == "split_pdf":
        src = payload.get("path")
        check_readable(src)
        out_dir = payload.get("out_dir") or os.path.dirname(os.path.abspath(src))
        pages = payload.get("pages")
        if not pages:
            raise OfficeError("split_pdf requires 'pages' (e.g. '1-3,5' or '2' for every 2 pages)")
        try:
            import pymupdf
        except Exception:
            import fitz as pymupdf

        doc = pymupdf.open(src)
        total = doc.page_count
        groups = _parse_page_groups(pages)
        results = []
        stem = os.path.splitext(os.path.basename(src))[0]
        if len(groups) == 1 and groups[0][0] == groups[0][1] and "," not in str(pages):
            every = groups[0][0]
            for start in range(0, total, every):
                end = min(start + every - 1, total - 1)
                out = os.path.join(out_dir, "%s_p%02d-%02d.pdf" % (stem, start + 1, end + 1))
                part = pymupdf.open()
                part.insert_pdf(doc, from_page=start, to_page=end)
                part.save(out)
                part.close()
                results.append({"pages": "%d-%d" % (start + 1, end + 1), "out": out})
        else:
            for (a, b) in groups:
                if a < 1 or b > total:
                    raise OfficeError("Page range %d-%d out of bounds (document has %d pages)" % (a, b, total))
                out = os.path.join(out_dir, "%s_p%02d-%02d.pdf" % (stem, a, b))
                part = pymupdf.open()
                part.insert_pdf(doc, from_page=a - 1, to_page=b - 1)
                part.save(out)
                part.close()
                results.append({"pages": "%d-%d" % (a, b), "out": out})
        doc.close()
        return {"action": "split_pdf", "parts": results}

    if action == "convert_all":
        base = payload.get("dir") or payload.get("path")
        if not base or not os.path.isdir(base):
            raise OfficeError("convert_all requires 'dir' (existing directory path)")
        to = str(payload.get("to") or "").strip().lower().lstrip(".")
        only = str(payload.get("ext") or "").strip().lower()
        if only and not only.startswith("."):
            only = "." + only
        if to not in CONVERT_TARGETS:
            raise OfficeError("Unsupported target '%s'. Supported: %s" % (to, ", ".join(CONVERT_TARGETS)))
        results = []
        for name in sorted(os.listdir(base)):
            fpath = os.path.join(base, name)
            if not os.path.isfile(fpath):
                continue
            ext = os.path.splitext(name)[1].lower()
            if only and ext != only:
                continue
            if ext not in CONVERT_SOURCES or ext == ".%s" % to:
                continue
            try:
                res = op_convert({"path": fpath, "to": to})
                results.append({"file": name, "ok": True, "out": res.get("out")})
            except Exception as exc:
                results.append({"file": name, "ok": False, "error": str(exc)})
        return {
            "action": "convert_all",
            "total": len(results),
            "ok": sum(1 for r in results if r["ok"]),
            "results": results,
        }

    raise OfficeError("Unknown batch action '%s'. Supported: merge_pdf, split_pdf, convert_all" % action)


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        emit({"ok": False, "error": "Invalid JSON payload: %s" % exc})
        return 2
    if not isinstance(payload, dict):
        emit({"ok": False, "error": "Payload must be a JSON object"})
        return 2

    op = str(payload.get("op") or "").strip()
    try:
        if op == "capabilities":
            data = op_capabilities()
        elif op == "inspect":
            data = op_inspect(payload)
        elif op == "read":
            data = op_read(payload)
        elif op == "pivot":
            data = op_pivot(payload)
        elif op == "ocr":
            data = pdf_ocr_pages(payload.get("path"), payload.get("pages"))
        elif op == "parse_lab":
            data = parse_lab_report(payload.get("path"))
        elif op == "write":
            data = op_write(payload)
        elif op == "convert":
            data = op_convert(payload)
        elif op == "chart":
            data = op_chart(payload)
        elif op == "batch":
            data = op_batch(payload)
        else:
            raise OfficeError("Unknown op '%s'. Expected: capabilities, inspect, read, pivot, write, convert, chart, batch, ocr, parse_lab" % op)
        emit({"ok": True, "data": data})
        return 0
    except OfficeError as exc:
        emit({"ok": False, "error": str(exc), "detail": getattr(exc, "detail", None)})
        return 1
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "detail": traceback.format_exc()[-1200:]})
        return 3


if __name__ == "__main__":
    sys.exit(main())
