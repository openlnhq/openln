#!/usr/bin/env python3
"""Extract every <script> block from artifacts/web/index.html and node --check it.

Usage: python3 scripts/diag/check-index-scripts.py [path/to/index.html]
"""
import re, subprocess, sys, tempfile, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
target = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'artifacts/web/index.html'
html = target.read_text()
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
