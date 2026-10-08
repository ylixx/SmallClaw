#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
knowledge_helper.py — SmallClaw knowledge base (RAG) backend.

Zero new dependencies: PDF via pymupdf (already installed), Office files via
stdlib zipfile+xml, plain text read directly. Indexing is local BM25 over
character n-grams (Chinese) + words (Latin/digits) so it works fully offline.

Protocol (same as office_helper.py):
    one JSON payload on stdin -> one JSON document on stdout
    ops: status | add | search | list | remove | clear
"""
import sys
import os
import json
import re
import math
import zipfile
import time
import shutil
import xml.etree.ElementTree as ET

try:
    import pymupdf  # type: ignore
except Exception:
    pymupdf = None

DEFAULT_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'knowledge')
INDEX_FILE = 'index.json'
SUPPORTED = ('.pdf', '.docx', '.xlsx', '.pptx', '.txt', '.md', '.html', '.htm', '.csv', '.tsv', '.json', '.log')

CHUNK_SIZE = 600
CHUNK_OVERLAP = 80

# ── tokenization ────────────────────────────────────────────────────────────
_LATIN_RE = re.compile(r'[a-zA-Z0-9]+')
_CJK_RE = re.compile(r'[\u4e00-\u9fff]+')

STOP_WORDS = {
    '的', '了', '和', '是', '在', '我', '有', '与', '就', '不', '都', '一', '个',
    '也', '这', '那', '上', '下', '中', '里', '你', '他', '她', '它', '我们', '你们',
    '他们', '会', '要', '能', '可', '对', '从', '到', '把', '被', '让', '给', '等',
    '之', '其', '所', '而', '但', '及', '或', '于', '以', '并', '又', '再', '还',
    '为', '为', '因', '由', '向', '按', '按', '过', '啊', '吧', '呢', '吗', '哦',
    '这个', '那个', '这些', '那些', '什么', '怎么', '为什么', '如何', '进行', '通过',
    'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with',
    'is', 'are', 'was', 'were', 'be', 'been', 'this', 'that', 'it', 'as', 'by',
    'from', 'about', 'into', 'over', 'after', 'before', 'not', 'no', 'yes',
}

def tokenize(text):
    """Return a list of indexable terms (case-lowered)."""
    terms = []
    for m in _LATIN_RE.finditer(text):
        w = m.group().lower()
        if len(w) > 1 and w not in STOP_WORDS:
            terms.append(w)
    for m in _CJK_RE.finditer(text):
        seg = m.group()
        if len(seg) == 1:
            if seg not in STOP_WORDS:
                terms.append(seg)
        else:
            for i in range(len(seg) - 1):
                terms.append(seg[i:i + 2])
    return terms

# ── document extraction (zero new deps) ─────────────────────────────────────
_XMLNS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
          'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

def _extract_docx(path):
    with zipfile.ZipFile(path) as z:
        xml = z.read('word/document.xml').decode('utf-8', 'ignore')
    root = ET.fromstring(xml)
    parts = []
    for para in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
        texts = [t.text or '' for t in para.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')]
        line = ''.join(texts).strip()
        if line:
            parts.append(line)
    return '\n'.join(parts)

def _extract_xlsx(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if 'xl/sharedStrings.xml' in z.namelist():
            sroot = ET.fromstring(z.read('xl/sharedStrings.xml').decode('utf-8', 'ignore'))
            ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
            for si in sroot.iter(ns + 'si'):
                shared.append(''.join(t.text or '' for t in si.iter(ns + 't')))
        rows = []
        for sheet_name in z.namelist():
            if not re.match(r'xl/worksheets/sheet\d+\.xml$', sheet_name):
                continue
            sroot = ET.fromstring(z.read(sheet_name).decode('utf-8', 'ignore'))
            ns = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
            for row in sroot.iter(ns + 'row'):
                cells = []
                for c in row.iter(ns + 'c'):
                    v = c.find(ns + 'v')
                    if v is None or not v.text:
                        continue
                    if c.get('t') == 's':
                        idx = int(v.text)
                        cells.append(shared[idx] if idx < len(shared) else '')
                    else:
                        cells.append(v.text)
                line = ' | '.join(x for x in cells if x).strip()
                if line:
                    rows.append(line)
        return '\n'.join(rows)

def _extract_pptx(path):
    with zipfile.ZipFile(path) as z:
        texts = []
        for slide in sorted((n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)),
                            key=lambda n: int(re.search(r'\d+', n).group())):
            root = ET.fromstring(z.read(slide).decode('utf-8', 'ignore'))
            lines = []
            for para in root.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}p'):
                t = ''.join(r.text or '' for r in para.iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')).strip()
                if t:
                    lines.append(t)
            if lines:
                texts.append(' / '.join(lines))
        return '\n'.join(texts)

def _extract_pdf(path):
    if pymupdf is None:
        return None, 'pymupdf not available'
    doc = pymupdf.open(path)
    pages = []
    for i, page in enumerate(doc):
        txt = page.get_text('text').strip()
        pages.append(txt if txt else f'[page {i + 1}: no extractable text]')
    doc.close()
    return '\n'.join(pages), None

def extract_document(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.pdf':
        text, err = _extract_pdf(path)
        return text, err
    if ext == '.docx':
        try:
            return _extract_docx(path), None
        except Exception as e:
            return None, f'docx parse failed: {e}'
    if ext == '.xlsx':
        try:
            return _extract_xlsx(path), None
        except Exception as e:
            return None, f'xlsx parse failed: {e}'
    if ext == '.pptx':
        try:
            return _extract_pptx(path), None
        except Exception as e:
            return None, f'pptx parse failed: {e}'
    if ext in ('.txt', '.md', '.html', '.htm', '.csv', '.tsv', '.json', '.log'):
        try:
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                return f.read(), None
        except Exception as e:
            return None, f'read failed: {e}'
    return None, f'unsupported extension: {ext}'

# ── chunking ────────────────────────────────────────────────────────────────
def chunk_text(text, size=CHUNK_SIZE, overlap=CHUNK_OVERLAP):
    paras = [p.strip() for p in re.split(r'\n+', text) if p.strip()]
    chunks = []
    buf = ''
    for p in paras:
        if buf and len(buf) + len(p) + 1 > size:
            chunks.append(buf)
            buf = buf[-overlap:] if len(buf) > overlap else ''
        buf = (buf + '\n' + p) if buf else p
        while len(buf) > size * 2:
            chunks.append(buf[:size])
            buf = buf[size - overlap:]
    if buf.strip():
        chunks.append(buf)
    return [c.strip() for c in chunks if c.strip()]

# ── index persistence ───────────────────────────────────────────────────────
def _index_path(root):
    return os.path.join(root, 'index', INDEX_FILE)

def load_index(root):
    p = _index_path(root)
    if os.path.exists(p):
        try:
            with open(p, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            pass
    return {'version': 1, 'docs': [], 'index': {}}

def save_index(root, idx):
    os.makedirs(os.path.join(root, 'index'), exist_ok=True)
    tmp = _index_path(root) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False)
    os.replace(tmp, _index_path(root))

def corpus_path(root, name):
    return os.path.join(root, 'corpus', name)

# ── BM25 scoring ────────────────────────────────────────────────────────────
def _bm25_stats(idx):
    n = len(idx.get('docs', []))
    if n == 0:
        return n, 0
    avg = sum(len(d.get('chunks', [])) for d in idx['docs']) / n
    return n, avg

def search_index(idx, query, top_k=5):
    q_terms = tokenize(query)
    if not q_terms or not idx.get('docs'):
        return []
    ndocs, avgdl = _bm25_stats(idx)
    k1, b = 1.5, 0.75
    # df per term across chunks (each chunk treated as a document for scoring)
    df = {}
    for term, postings in idx.get('index', {}).items():
        df[term] = len(postings)
    nd = sum(len(d.get('chunks', [])) for d in idx['docs'])
    if nd == 0:
        return []
    idf = {}
    for term in set(q_terms):
        f = df.get(term, 0)
        idf[term] = math.log(1 + (nd - f + 0.5) / (f + 0.5))
    # per-chunk score
    chunk_scores = {}
    for term in set(q_terms):
        for post in idx.get('index', {}).get(term, []):
            d = post['d']
            doc = idx['docs'][d]
            dl = len(doc.get('chunks', []))
            c = post['c']  # single chunk index per posting
            if c >= dl:
                continue
            key = (d, c)
            tf = chunk_scores.get(key, {}).get('tf', 0) + 1
            s0 = chunk_scores.get(key, {}).get('s', 0)
            chunk_scores[key] = {'tf': tf, 's': s0}
    results = []
    for (d, c), v in chunk_scores.items():
        doc = idx['docs'][d]
        chunks = doc.get('chunks', [])
        if c >= len(chunks):
            continue
        dl = len(chunks)
        tf = v['tf']
        score = 0.0
        for term in set(q_terms):
            if term in idx.get('index', {}) and any(p['d'] == d and c == p['c'] for p in idx['index'][term]):
                score += idf.get(term, 0) * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / max(avgdl, 1)))
        results.append({
            'score': round(score, 3),
            'file': doc['name'],
            'added_at': doc.get('added_at', ''),
            'chunk_idx': c,
            'text': chunks[c][:1200],
        })
    results.sort(key=lambda r: r['score'], reverse=True)
    return results[:top_k]

# ── ops ─────────────────────────────────────────────────────────────────────
def op_status(root):
    idx = load_index(root)
    total_chunks = sum(len(d.get('chunks', [])) for d in idx.get('docs', []))
    return {'ok': True, 'knowledge_dir': root,
            'files': len(idx.get('docs', [])), 'chunks': total_chunks,
            'terms': len(idx.get('index', {})),
            'supported': list(SUPPORTED)}

def op_add(root, path, name_hint=None):
    if not path or not os.path.exists(path):
        return {'ok': False, 'error': f'path not found: {path}'}
    text, err = extract_document(path)
    if err:
        return {'ok': False, 'error': err}
    if not text or not text.strip():
        return {'ok': False, 'error': 'no extractable text (scanned PDF? try OCR first)'}
    name = name_hint or os.path.basename(path)
    chunks = chunk_text(text)
    idx = load_index(root)
    # remove existing doc with same name (re-add = update)
    idx['docs'] = [d for d in idx['docs'] if d['name'] != name]
    # rebuild term index incrementally: simplest robust path = full rebuild
    doc_entry = {'name': name, 'added_at': time.strftime('%Y-%m-%d %H:%M:%S'),
                 'chunks': chunks, 'source_path': path}
    idx['docs'].append(doc_entry)
    # rebuild inverted index
    inv = {}
    for d, doc in enumerate(idx['docs']):
        for c, ch in enumerate(doc.get('chunks', [])):
            for term in set(tokenize(ch)):
                inv.setdefault(term, []).append({'d': d, 'c': c})
    idx['index'] = inv
    os.makedirs(os.path.join(root, 'corpus'), exist_ok=True)
    try:
        shutil.copy2(path, corpus_path(root, name))
    except Exception:
        pass  # corpus copy is best-effort; index still works
    save_index(root, idx)
    return {'ok': True, 'name': name, 'chunks': len(chunks),
            'total_files': len(idx['docs']), 'total_chunks': sum(len(x.get('chunks', [])) for x in idx['docs']),
            'terms': len(inv), 'note': 'index rebuilt'}

def op_search(root, query, top_k=5):
    idx = load_index(root)
    results = search_index(idx, query, top_k)
    return {'ok': True, 'query': query, 'results': results}

def op_list(root):
    idx = load_index(root)
    docs = [{'name': d['name'], 'added_at': d.get('added_at', ''),
             'chunks': len(d.get('chunks', [])), 'source_path': d.get('source_path', '')}
            for d in idx.get('docs', [])]
    return {'ok': True, 'files': docs}

def op_remove(root, name):
    idx = load_index(root)
    before = len(idx['docs'])
    idx['docs'] = [d for d in idx['docs'] if d['name'] != name]
    if len(idx['docs']) == before:
        return {'ok': False, 'error': f'not found: {name}'}
    inv = {}
    for d, doc in enumerate(idx['docs']):
        for c, ch in enumerate(doc.get('chunks', [])):
            for term in set(tokenize(ch)):
                inv.setdefault(term, []).append({'d': d, 'c': c})
    idx['index'] = inv
    save_index(root, idx)
    cp = corpus_path(root, name)
    if os.path.exists(cp):
        try:
            os.remove(cp)
        except Exception:
            pass
    return {'ok': True, 'removed': name, 'total_files': len(idx['docs'])}

def op_get(root, name, max_chunks=10):
    """Return chunks of one stored file by (fuzzy) name — used by @-references."""
    idx = load_index(root)
    target = None
    for d in idx.get('docs', []):
        dname = d.get('name', '')
        if name == dname or dname.startswith(name) or name in dname:
            target = d
            break
    if target is None:
        return {'ok': False, 'error': f'not found: {name}'}
    chunks = target.get('chunks', [])
    return {'ok': True, 'name': target['name'],
            'chunks': chunks[:max_chunks], 'total_chunks': len(chunks)}

def op_clear(root):
    shutil.rmtree(os.path.join(root, 'index'), ignore_errors=True)
    shutil.rmtree(os.path.join(root, 'corpus'), ignore_errors=True)
    save_index(root, {'version': 1, 'docs': [], 'index': {}})
    return {'ok': True, 'message': 'knowledge base cleared'}

def main():
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            print(json.dumps({'ok': False, 'error': 'empty payload'}))
            return
        payload = json.loads(raw)
        op = payload.get('op', '')
        root = payload.get('knowledge_dir') or DEFAULT_ROOT
        root = os.path.abspath(root)
        if op == 'status':
            out = op_status(root)
        elif op == 'add':
            out = op_add(root, payload.get('path') or '', payload.get('name'))
        elif op == 'search':
            out = op_search(root, payload.get('query', ''), int(payload.get('top_k', 5)))
        elif op == 'list':
            out = op_list(root)
        elif op == 'get':
            out = op_get(root, payload.get('name', ''), int(payload.get('max_chunks', 10)))
        elif op == 'remove':
            out = op_remove(root, payload.get('name', ''))
        elif op == 'clear':
            out = op_clear(root)
        else:
            out = {'ok': False, 'error': f'unknown op: {op}'}
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}))

if __name__ == '__main__':
    main()
