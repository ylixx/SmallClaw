#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ppt_build.py — markdown outline -> storyboard -> ppt-kit render -> pptx.

Used by doc_write's pptx outline op (via office_helper._render_via_pptkit) to
produce beautiful pptx using the ppt-kit storyboard + 49-layout template, instead
of the simple Doubao-style outline renderer.

Usage:
  python ppt_build.py --markdown-file <md> --out <pptx> --render <render_pptx.py>
                     [--title T] [--author A]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile


def parse_outline(md):
    """# title -> cover; ## page + - bullet -> content pages."""
    lines = md.splitlines()
    title = None
    pages = []
    cur = None
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        if s.startswith('# ') and title is None:
            title = s[2:].strip()
            continue
        if s.startswith('## '):
            cur = {'title': s[3:].strip(), 'bullets': []}
            pages.append(cur)
            continue
        if s.startswith('#'):
            if cur is None:
                cur = {'title': s.lstrip('#').strip(), 'bullets': []}
                pages.append(cur)
            continue
        if s.startswith('- ') or s.startswith('* '):
            if cur is not None:
                cur['bullets'].append(s[2:].strip())
            continue
        # ignore '---' and free text lines
    return title, pages


def split_bullet(b):
    for sep in ('：', ': ', ':', '——', ' - '):
        if sep in b:
            i = b.index(sep)
            return b[:i].strip(), b[i + len(sep):].strip()
    return '', b


def build_storyboard(title, pages, author):
    sb = {'title': title or '演示文稿', 'pages': []}
    for p in pages:
        t = p['title']
        bullets = p['bullets']
        tlow = t.lower()
        if any(k in tlow for k in ['谢谢', '感谢', 'thank', 'thanks']):
            sb['pages'].append({'pattern': 'thanks', 'fields': {'main': t}})
            continue
        n = len(bullets)
        if n == 0:
            sb['pages'].append({'pattern': 'text-2', 'fields': {'title': t}})
        elif n <= 2:
            f = {'title': t}
            for i, b in enumerate(bullets[:2]):
                s, bd = split_bullet(b)
                f['s%d' % (i + 1)] = s
                f['b%d' % (i + 1)] = bd
            sb['pages'].append({'pattern': 'text-2', 'fields': f})
        elif n == 3:
            f = {'title': t}
            for i, b in enumerate(bullets[:3]):
                s, bd = split_bullet(b)
                f['s%d' % (i + 1)] = s
                f['b%d' % (i + 1)] = bd
            sb['pages'].append({'pattern': 'text-3', 'fields': f})
        else:
            f = {'title': t}
            for i, b in enumerate(bullets[:4]):
                s, bd = split_bullet(b)
                f['s%d' % (i + 1)] = s
                f['b%d' % (i + 1)] = bd
            sb['pages'].append({'pattern': 'text-4', 'fields': f})
    if title:
        sb['pages'].insert(0, {'pattern': 'cover', 'fields': {'title': title, 'presenter': author or ''}})
    return sb


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--markdown-file', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--render', required=True, help='path to ppt-kit render_pptx.py')
    ap.add_argument('--title', default='')
    ap.add_argument('--author', default='')
    args = ap.parse_args()

    md = open(args.markdown_file, encoding='utf-8').read()
    title, pages = parse_outline(md)
    if args.title:
        title = args.title
    sb = build_storyboard(title, pages, args.author)

    tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
    json.dump(sb, tmp, ensure_ascii=False)
    tmp.close()

    render_abs = os.path.abspath(args.render)
    render_dir = os.path.dirname(render_abs)
    out_abs = os.path.abspath(args.out)
    proc = subprocess.run(
        [sys.executable, render_abs, os.path.abspath(tmp.name), '-o', out_abs, '--optimize'],
        cwd=render_dir, capture_output=True, text=True, timeout=180,
    )
    ok = os.path.isfile(out_abs)
    try:
        os.unlink(tmp.name)
    except Exception:
        pass

    warnings = []
    for line in (proc.stderr or '').splitlines():
        if '[warn]' in line or 'WARN' in line:
            warnings.append(line.strip())
    err_detail = ''
    if not ok:
        err_detail = (proc.stderr or proc.stdout or '')[-800:]
    print(json.dumps({
        'success': ok,
        'path': args.out,
        'pages': len(sb['pages']),
        'warnings': warnings,
        'render_tail': (proc.stdout or '')[-400:],
        'error_detail': err_detail,
    }, ensure_ascii=False))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
