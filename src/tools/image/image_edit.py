#!/usr/bin/env python3
"""SmallClaw image edit helper (PIL, fully offline).

Protocol: one JSON payload on stdin -> one JSON document on stdout.
Payload: {"action": "cutout"|"compress"|"watermark", ...}
Response: {"ok": true, "data": {...}} | {"ok": false, "error": "..."}
"""
import json
import os
import sys
import traceback

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str))
    sys.stdout.flush()


def _open(src):
    from PIL import Image

    img = Image.open(src)
    img.load()
    if img.mode not in ("RGBA", "RGB", "LA", "L"):
        img = img.convert("RGBA")
    return img


def _save(img, out, quality=90):
    from PIL import Image

    ext = os.path.splitext(str(out))[1].lower()
    fmt = {"jpg": "JPEG", "jpeg": "JPEG", "png": "PNG", "webp": "WEBP", "bmp": "BMP"}.get(ext.lstrip("."), None)
    if fmt is None:
        fmt = "PNG" if img.mode == "RGBA" else "JPEG"
        out = os.path.splitext(out)[0] + (".png" if fmt == "PNG" else ".jpg")
    kwargs = {}
    if fmt in ("JPEG", "WEBP"):
        kwargs["quality"] = quality
        if fmt == "WEBP":
            kwargs["method"] = 6
    if fmt == "PNG" and img.mode == "RGBA":
        img.save(out, format="PNG", optimize=True)
    else:
        img.save(out, format=fmt, **kwargs)
    return out


def op_cutout(payload):
    """纯色/近均匀背景移除 -> 透明 PNG。"""
    src = payload.get("path") or payload.get("filename")
    if not src or not os.path.isfile(src):
        raise ValueError("cutout requires an existing image path")
    out = payload.get("out")
    if not out:
        out = os.path.splitext(src)[0] + "_cutout.png"
    color = payload.get("color")  # 可选: "ffffff" 或 "#ffffff"，缺省自动取四角平均色
    threshold = int(payload.get("threshold") or 40)

    from PIL import Image

    img = _open(src).convert("RGBA")
    px = img.load()
    w, h = img.size

    def parse_color(c):
        c = str(c).strip().lstrip("#")
        if len(c) == 6:
            return tuple(int(c[i : i + 2], 16) for i in (0, 2, 4))
        if len(c) == 3:
            return tuple(int(ch * 2, 16) for ch in c)
        raise ValueError("color must be like 'ffffff'")

    if color:
        bg = parse_color(color)
    else:
        # 四角 + 边缘中点取样，取众数平均色
        samples = []
        for x, y in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w // 2, 2), (w // 2, h - 3), (2, h // 2), (w - 3, h // 2)]:
            try:
                r, g, b = px[x, y][:3]
                samples.append((r, g, b))
            except Exception:
                pass
        if not samples:
            raise ValueError("cannot sample background color")
        bg = tuple(round(sum(ch[i] for ch in samples) / len(samples)) for i in range(3))

    # 计算每个像素与背景的色差，接近背景 -> 透明；边缘轻微羽化
    import math

    thr = float(threshold)
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            dist = math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2)
            if dist < thr:
                px[x, y] = (r, g, b, 0)
            elif dist < thr * 1.6:
                alpha = int(a * (1.0 - (dist - thr) / (thr * 0.6)))
                px[x, y] = (r, g, b, max(0, min(255, alpha)))

    # 裁剪到内容边界（可选）
    if payload.get("trim"):
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)

    final = _save(img, out, 100)
    return {"action": "cutout", "background": bg, "out": final, "size": img.size}


def op_compress(payload):
    """压缩：quality（质量）或 target_kb（目标体积，自动寻优）或 max_dim（最大边长）。"""
    src = payload.get("path") or payload.get("filename")
    if not src or not os.path.isfile(src):
        raise ValueError("compress requires an existing image path")
    out = payload.get("out")
    if not out:
        out = os.path.splitext(src)[0] + "_compressed.jpg"
    quality = int(payload.get("quality") or 80)
    target_kb = payload.get("target_kb")
    max_dim = payload.get("max_dim")

    img = _open(src)
    if max_dim:
        md = int(max_dim)
        w, h = img.size
        scale = min(1.0, md / max(w, h))
        if scale < 1.0:
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), 3)  # LANCZOS

    if target_kb:
        target_bytes = int(target_kb) * 1024
        # 先尝试 85，再按结果二分调整质量
        lo, hi = 20, 95
        best_q, best_bytes = quality, None
        from PIL import Image
        import io

        def size_at(q):
            buf = io.BytesIO()
            if img.mode == "RGBA":
                img.save(buf, format="PNG", optimize=True)
            else:
                img.save(buf, format="JPEG", quality=q)
            return len(buf.getvalue())

        cur = size_at(best_q)
        if cur > target_bytes:
            while lo <= hi:
                mid = (lo + hi) // 2
                b = size_at(mid)
                if b <= target_bytes:
                    best_q, best_bytes = mid, b
                    lo = mid + 1
                else:
                    hi = mid - 1
            quality = best_q if best_q else quality
        else:
            quality = best_q
            best_bytes = cur

    final = _save(img, out, quality)
    return {"action": "compress", "quality": quality, "out": final, "size": img.size}


def op_watermark(payload):
    """水印：text 文字水印（size/opacity/position）或 image 图片水印（opacity/position）。"""
    src = payload.get("path") or payload.get("filename")
    if not src or not os.path.isfile(src):
        raise ValueError("watermark requires an existing image path")
    out = payload.get("out")
    if not out:
        out = os.path.splitext(src)[0] + "_watermarked.png"
    text = payload.get("text")
    mark_img = payload.get("image")
    opacity = float(payload.get("opacity") or 0.35)
    position = str(payload.get("position") or "bottom-right").lower()

    from PIL import Image, ImageDraw, ImageFont

    img = _open(src).convert("RGBA")
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    W, H = img.size

    def place(w, h, pad=24):
        p = position.replace("-", "")
        if p.startswith("top") and p.endswith("left"):
            return pad, pad
        if p.startswith("top") and p.endswith("right"):
            return W - w - pad, pad
        if p.startswith("bottom") and p.endswith("left"):
            return pad, H - h - pad
        if p.startswith("bottom") and p.endswith("right"):
            return W - w - pad, H - h - pad
        if p.startswith("center"):
            return (W - w) // 2, (H - h) // 2
        if p.startswith("top"):
            return (W - w) // 2, pad
        if p.startswith("bottom"):
            return (W - w) // 2, H - h - pad
        if p.startswith("left"):
            return pad, (H - h) // 2
        if p.startswith("right"):
            return W - w - pad, (H - h) // 2
        return W - w - pad, H - h - pad

    if mark_img:
        mark = _open(mark_img).convert("RGBA")
        max_w = max(1, int(W * float(payload.get("max_width") or 0.3)))
        if mark.width > max_w:
            ratio = max_w / mark.width
            mark = mark.resize((max_w, max(1, int(mark.height * ratio))), 3)
        mark.putalpha(int(255 * opacity))
        mw, mh = mark.size
        x, y = place(mw, mh)
        overlay.paste(mark, (x, y), mark)
    elif text:
        size = int(payload.get("size") or max(16, W // 18))
        try:
            font = ImageFont.truetype("arial.ttf", size)
        except Exception:
            try:
                font = ImageFont.truetype("msyh.ttc", size)
            except Exception:
                font = ImageFont.load_default()
        color = payload.get("color") or "ffffff"
        draw.text((0, 0), text, font=font, fill=(255, 255, 255, int(255 * opacity)))
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x, y = place(tw, th)
        draw.text((x, y), text, font=font, fill=(255, 255, 255, int(255 * opacity)))
    else:
        raise ValueError("watermark requires 'text' or 'image'")

    result = Image.alpha_composite(img, overlay)
    final = _save(result, out, 100)
    return {"action": "watermark", "out": final, "size": result.size}


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        emit({"ok": False, "error": "Invalid JSON payload: %s" % exc})
        return 2
    if not isinstance(payload, dict):
        emit({"ok": False, "error": "Payload must be a JSON object"})
        return 2
    action = str(payload.get("action") or "").strip()
    try:
        if action == "cutout":
            data = op_cutout(payload)
        elif action == "compress":
            data = op_compress(payload)
        elif action == "watermark":
            data = op_watermark(payload)
        else:
            raise ValueError("Unknown action '%s'. Supported: cutout, compress, watermark" % action)
        emit({"ok": True, "data": data})
        return 0
    except Exception as exc:
        emit({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc), "detail": traceback.format_exc()[-1000:]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
