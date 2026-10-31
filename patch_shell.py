#!/usr/bin/env python3
"""usage: patch_shell.py <repo>/web/shell.html  — inlines fast_touch.js (idempotent)."""
import sys, os
p = sys.argv[1]
js = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fast_touch.js'), encoding='utf-8').read()
s = open(p, encoding='utf-8').read()
if 'ps2_fast_touch' not in s:
    i = s.rindex('</body>')
    s = s[:i] + '<script>\n' + js + '\n</script>\n' + s[i:]
    open(p, 'w', encoding='utf-8').write(s)
print('shell patched')
