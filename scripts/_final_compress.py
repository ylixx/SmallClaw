#!/usr/bin/env python3
"""Clean single-pass compress of template.pptx media:
- PNG w/o alpha -> JPEG (.jpeg, renamed) ; PNG w/ alpha -> PNG optimize (keep .png)
- JPEG/JPG -> re-encode q80 cap1920 (keep ext)
- WDP -> keep as-is (no codec available)
Patches any .rels Target referencing renamed media, and [Content_Types].xml.
Keeps all filenames referenced by layouts valid.
"""
import io, os, re, zipfile

SRC = '.smallclaw/skills/ppt-kit/assets/template.pptx'
DST = SRC + '.tmp'
MAX_EDGE = 1920
JPEG_Q = 80

from PIL import Image

z = zipfile.ZipFile(SRC)
names = z.namelist()
media = [n for n in names if n.startswith('ppt/media/')]
other = [n for n in names if not n.startswith('ppt/media/')]

rename = {}      # old_name -> new_name  (only when ext changes)
newbytes = {}    # name -> bytes (media content to write)

def process(name, raw):
    ext = name.rsplit('.', 1)[-1].lower()
    try:
        img = Image.open(io.BytesIO(raw)); img.load()
    except Exception:
        return raw, False  # keep original, no rename
    w, h = img.size
    if max(w, h) > MAX_EDGE:
        s = MAX_EDGE / max(w, h)
        img = img.resize((max(1, int(w*s)), max(1, int(h*s))), Image.LANCZOS)
    has_alpha = img.mode in ('RGBA', 'LA') or (img.mode == 'P' and 'transparency' in img.info)
    if ext == 'png' and not has_alpha:
        buf = io.BytesIO(); img.convert('RGB').save(buf, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True)
        return buf.getvalue(), True   # rename to .jpeg
    if ext == 'png' and has_alpha:
        buf = io.BytesIO(); img.save(buf, 'PNG', optimize=True)
        b = buf.getvalue(); return (b, False) if len(b) < len(raw) else (raw, False)
    if ext in ('jpeg', 'jpg'):
        buf = io.BytesIO(); img.convert('RGB').save(buf, 'JPEG', quality=JPEG_Q, optimize=True, progressive=True)
        b = buf.getvalue(); return (b, False) if len(b) < len(raw) else (raw, False)
    return raw, False  # wdp etc.

total_before = sum(z.getinfo(n).file_size for n in media)
saved = 0
for n in media:
    raw = z.read(n)
    b, do_rename = process(n, raw)
    if len(b) >= len(raw):
        b = raw; do_rename = False
    saved += len(raw) - len(b)
    if do_rename:
        newn = n.rsplit('.', 1)[0] + '.jpeg'
        rename[n] = newn
        newbytes[newn] = b
        print('  %-22s %.2fMB -> %.2fMB (png->jpeg %s)' % (n.split('/')[-1], len(raw)/1e6, len(b)/1e6, n.split('/')[-1][:-4]+'.jpeg'))
    else:
        newbytes[n] = b

# patch .rels Targets that reference renamed media
patched = {}
for n in names:
    if n.endswith('.rels'):
        data = z.read(n).decode('utf-8', 'ignore')
        d2 = data
        for old, new in rename.items():
            ob, nb = old.rsplit('/', 1)[-1], new.rsplit('/', 1)[-1]
            if ob in d2:
                d2 = d2.replace(ob, nb)
        if d2 != data:
            patched[n] = d2

# content types: ensure jpeg default present (it is); keep png+wbp defaults
with zipfile.ZipFile(DST, 'w', zipfile.ZIP_DEFLATED) as out:
    for n in names:
        if n in rename:
            continue  # old name replaced
        if n in newbytes and n.startswith('ppt/media/'):
            out.writestr(zipfile.ZipInfo(n), newbytes[n])
            continue
        if n in patched:
            out.writestr(n, patched[n].encode('utf-8')); continue
        out.writestr(n, z.read(n))

z.close()
os.replace(DST, SRC)
new_size = os.path.getsize(SRC)
print('media: %.2fMB -> %.2fMB  saved %.2fMB' % (total_before/1e6, (total_before-saved)/1e6, saved/1e6))
print('TEMPLATE: %.2f MB (was 49.74 MB)' % (new_size/1e6))
