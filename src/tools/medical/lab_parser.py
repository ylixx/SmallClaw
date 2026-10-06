# lab_parser.py — parse hospital lab report text (extracted from PDF) into structured JSON.
# Prototype for SmallClaw medical pipeline. Reads a PDF path from argv or stdin JSON {"path": ...},
# extracts text via pypdf, parses per-page lab tables, groups by date, flags abnormal items.
import sys, os, re, json

UNIT_TOKENS = re.compile(r'^(ng/mL|pg/ml|pg/mL|mmol/L|umol/L|μmol/L|U/L|g/L|mg/L|mOsm/L|mS/cm|cells/uL|/ul|/HP|/LP|%|U/ml|ng/ml|mg/dl|mL/min|fL|pg|ug/L|ng|mmol|mol|IU/L|mIU/mL|mm3|10\^9/L|10\^12/L|S|mM)$', re.I)
REF_TOKENS = re.compile(r'^[↑↓≤≥]?<?>?[\d.]+(?:\s*[-~—–]\s*[\d.]+)?$')
VAL_TOKENS = re.compile(r'^[+-]?\d[\d.,]*(?:[eE][+-]?\d+)?$')
ARROW = re.compile(r'^[↑↓]$')
HEADER_RE = re.compile(r'代\s*号|项\s*目\s*名\s*称|结\s*果|参\s*考|单\s*位')
DATE_RE = re.compile(r'(\d{4}[/-]\d{2}[/-]\d{2})')

def clean(s):
    return re.sub(r'\s+', ' ', str(s or '')).strip()

def parse_ref(ref_str):
    """Normalize reference range text into (lo, hi) or None."""
    t = ref_str.strip()
    if not t or t in ('-', '--'):
        return None
    if t.startswith('<') or t.startswith('≤'):
        try:
            return (None, float(re.sub(r'[<≤\s]', '', t)))
        except ValueError:
            return None
    if t.startswith('>') or t.startswith('≥'):
        try:
            return (float(re.sub(r'[>≥\s]', '', t)), None)
        except ValueError:
            return None
    m = re.match(r'([\d.]+)\s*[-~—–]\s*([\d.]+)', t)
    if m:
        return (float(m.group(1)), float(m.group(2)))
    try:
        v = float(t)
        return (v, v)
    except ValueError:
        return None

def parse_value(val_str):
    t = re.sub(r'[↑↓\s]', '', str(val_str or ''))
    try:
        return float(t)
    except ValueError:
        return None

def judge_flag(value_str, ref_str):
    """↑↓ markers in the extracted text are the primary signal; numeric comparison as fallback."""
    if '↑' in value_str or '↑' in ref_str:
        return 'high'
    if '↓' in value_str or '↓' in ref_str:
        return 'low'
    v = parse_value(value_str)
    r = parse_ref(ref_str)
    if v is not None and r:
        lo, hi = r
        if lo is not None and hi is not None:
            if v < lo: return 'low'
            if v > hi: return 'high'
        elif hi is not None and v > hi:
            return 'high'
        elif lo is not None and v < lo:
            return 'low'
    return 'normal'

def parse_page_items(lines):
    """Parse table rows from a single page's text lines."""
    items = []
    in_table = False
    for raw in lines:
        line = clean(raw)
        if not line:
            continue
        if HEADER_RE.search(line) and ('代' in line or '项目' in line):
            in_table = True
            continue
        if not in_table:
            continue
        # stop at obvious non-table lines
        if line.startswith('申请项目') or line.startswith('第') or line.startswith('血 脂') or line.startswith('C V D'):
            continue
        m = re.match(r'^(\d+)\s+(.+)$', line)
        if not m:
            continue
        num = m.group(1)
        rest = m.group(2)
        toks = rest.split(' ')
        # strip blank tokens
        toks = [t for t in toks if t]
        if len(toks) < 3:
            continue
        unit = ''
        ref = ''
        value = ''
        arrow = ''
        i = len(toks) - 1
        if UNIT_TOKENS.match(toks[i]):
            unit = toks[i]; i -= 1
        if i >= 0 and REF_TOKENS.match(toks[i]):
            ref = toks[i]; i -= 1
        # standalone arrow between value and ref: "3.03 ↓ 3.5-5.3" or "13.0 ↑ 9.8-12.5"
        if i >= 0 and ARROW.match(toks[i]):
            arrow = toks[i]; i -= 1
        if i >= 0 and VAL_TOKENS.match(toks[i]):
            value = toks[i]; i -= 1
        if not value and i >= 0 and ARROW.match(toks[i]):
            # arrow before value with no ref: "0.150 ↓" style
            arrow = toks[i]; i -= 1
            if i >= 0 and VAL_TOKENS.match(toks[i]):
                value = toks[i]; i -= 1
        if not value:
            continue  # not a data row we can parse
        name = ' '.join(toks[:i + 1])
        # name may start with the code abbreviation or a ☆ prefix
        if arrow:
            flag = 'high' if arrow == '↑' else 'low'
        else:
            flag = judge_flag(value, ref)
        items.append({
            'code': num,
            'name': name,
            'value': value,
            'ref': ref,
            'unit': unit,
            'flag': flag,
        })
    return items

def parse_pdf(path):
    """Extract text per page with pypdf, then parse patient info + batches."""
    try:
        from pypdf import PdfReader
    except ImportError:
        from PyPDF2 import PdfReader
    reader = PdfReader(path)
    pages = []
    for p in reader.pages:
        try:
            pages.append(p.extract_text() or '')
        except Exception:
            pages.append('')
    return parse_text('\n'.join(f'### PAGE {i+1}\n{t}' for i, t in enumerate(pages)))

def parse_text(full_text):
    result = {
        'patient': {},
        'batches': [],
        'dates': [],
    }
    sections = re.split(r'### PAGE (\d+)', full_text)
    # sections: ['', '1', text1, '2', text2, ...]
    for i in range(1, len(sections), 2):
        page_no = int(sections[i])
        body = sections[i + 1] if i + 1 < len(sections) else ''
        lines = body.split('\n')
        # patient header info: PDF text has spaces between CJK chars ("冯 家 勤") - strip all spaces first
        compact = re.sub(r'\s+', '', body)
        name_m = re.search(r'姓名[:：](.+?)(?=性别[:：])', compact)
        if name_m and not result['patient'].get('name'):
            result['patient']['name'] = name_m.group(1)
        sex_m = re.search(r'性别[:：]([男女])', compact)
        if sex_m and not result['patient'].get('sex'):
            result['patient']['sex'] = sex_m.group(1)
        age_m = re.search(r'年龄[:：](\d+)岁', compact)
        if age_m and not result['patient'].get('age'):
            result['patient']['age'] = age_m.group(1)
        no_m = re.search(r'病历号[:：](\d+)', compact)
        if no_m and not result['patient'].get('history_no'):
            result['patient']['history_no'] = no_m.group(1)
        dept_m = re.search(r'科室[:：]([^※]+?)(?=申请|标本|病床|样本号|临床)', compact)
        spec_m = re.search(r'标本类型\s*[:：]\s*([^\s]+)', body)
        recv_m = re.search(r'接收时间\s*[:：]\s*(\d{4}[/-]\d{2}[/-]\d{2})', body)
        items = parse_page_items(lines)
        if not items:
            continue
        batch = {
            'page': page_no,
            'date': recv_m.group(1).replace('-', '/') if recv_m else None,
            'department': dept_m.group(1) if dept_m else None,
            'specimen': spec_m.group(1) if spec_m else None,
            'items': items,
        }
        result['batches'].append(batch)
        if batch['date'] and batch['date'] not in result['dates']:
            result['dates'].append(batch['date'])
    # sort batches by date
    result['batches'].sort(key=lambda b: (b['date'] or '9999', b['page']))
    result['dates'] = sorted(result['dates'])
    # abnormal summary
    abnormal = []
    for b in result['batches']:
        for it in b['items']:
            if it['flag'] != 'normal':
                abnormal.append({
                    'date': b['date'],
                    'name': it['name'],
                    'value': it['value'],
                    'ref': it['ref'],
                    'unit': it['unit'],
                    'flag': it['flag'],
                })
    result['abnormal'] = abnormal
    result['batch_count'] = len(result['batches'])
    result['item_count'] = sum(len(b['items']) for b in result['batches'])
    return result

if __name__ == '__main__':
    path = None
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        path = sys.argv[1]
    else:
        try:
            payload = json.loads(sys.stdin.read() or '{}')
            path = payload.get('path')
        except Exception:
            path = None
    if not path:
        sys.stderr.write('usage: python lab_parser.py <pdf-path>\n')
        sys.exit(2)
    data = parse_pdf(path)
    print(json.dumps(data, ensure_ascii=False, indent=1))
