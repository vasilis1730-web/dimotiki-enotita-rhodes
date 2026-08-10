from pathlib import Path
import re
import subprocess
import sys
import tempfile

FILES = ['index.html', 'aftepistasia.html', 'ack.html']
SCRIPT_RE = re.compile(r'<script(?P<attrs>[^>]*)>(?P<body>.*?)</script\s*>', re.I | re.S)

failed = False
for filename in FILES:
    text = Path(filename).read_text(encoding='utf-8')
    count = 0
    for match in SCRIPT_RE.finditer(text):
        attrs = match.group('attrs') or ''
        if re.search(r'\bsrc\s*=', attrs, re.I):
            continue
        body = match.group('body')
        if not body.strip():
            continue
        count += 1
        start_line = text.count('\n', 0, match.start('body')) + 1
        suffix = '.mjs' if re.search(r'type\s*=\s*["\']module["\']', attrs, re.I) else '.js'
        with tempfile.NamedTemporaryFile('w', suffix=suffix, encoding='utf-8', delete=False) as f:
            f.write(body)
            temp_path = f.name
        p = subprocess.run(['node', '--check', temp_path], text=True, capture_output=True)
        if p.returncode != 0:
            failed = True
            print(f'\nERROR {filename}: inline script #{count}, HTML body starts at line {start_line}')
            print(p.stderr or p.stdout)
        else:
            print(f'PASS {filename}: inline script #{count} (starts line {start_line})')
    if count == 0:
        print(f'WARN {filename}: no inline scripts found')

if failed:
    sys.exit(1)
print('HTML_INLINE_JS_SYNTAX_PASS')
