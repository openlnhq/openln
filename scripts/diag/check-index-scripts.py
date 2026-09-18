#!/usr/bin/env python3
"""Extract every <script> block from artifacts/web/index.html and node --check it."""
import re, subprocess, sys, tempfile, pathlib
html = pathlib.Path('/home/kongzi/openln/artifacts/web/index.html').read_text()
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', html, re.S)
bad = 0
for i, b in enumerate(blocks):
    if not b.strip():
        continue
    with tempfile.NamedTemporaryFile('w', suffix='.mjs', delete=False) as f:
        f.write(b); path = f.name
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    if r.returncode != 0:
        bad += 1; print(f'block {i}: SYNTAX ERROR\n{r.stderr[:600]}')
print(f'{len(blocks)} script blocks, {bad} with errors')
sys.exit(1 if bad else 0)
