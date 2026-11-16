#!/usr/bin/env python3
"""Inline src/js/*.js into one self-contained dist/index.html (for sharing)."""
import re, pathlib
root = pathlib.Path(__file__).parent
src = (root / 'src' / 'index.html').read_text()
def inline(m):
    js = (root / 'src' / m.group(1)).read_text()
    return '<script>\n' + js + '\n</script>'
out = re.sub(r'<script src="([^"]+)"></script>', inline, src)
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist' / 'index.html').write_text(out)
print('wrote', root / 'dist' / 'index.html', len(out), 'bytes')
# Convenience copy at the top level: double-click index.html to play in a browser.
(root / 'index.html').write_text(out)
