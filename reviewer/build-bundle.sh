#!/usr/bin/env bash
# Build the reviewer static bundle from the production app + reviewer overrides.
# Reviewer-only transforms; production index.html is never modified.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

OUT=reviewer-build
rm -rf "$OUT"; mkdir -p "$OUT"

# 1. reviewer Supabase config — ONLY the reviewer project (production absent)
cat > "$OUT/supabase.js" <<'EOF'
var SUPABASE_URL = 'https://abmmyjnhhxgyqspycecz.supabase.co';
var SUPABASE_ANON_KEY = 'sb_publishable_ifcCNox-wvTd0Z1Zz-CZxw_1_NIY7Fv';
EOF

cp cases.json "$OUT/cases.json"
cp vercel.json "$OUT/vercel.json"
cp reviewer/client/reviewer-gate.js "$OUT/reviewer-gate.js"

# 2. transform index.html -> reviewer-build/index.html
python3 - <<'PY'
src = open('index.html').read()

def once(s, a, b, label):
    assert src_count(s, a) == 1, label + ' anchor count != 1 (' + str(src_count(s,a)) + ')'
    return s.replace(a, b, 1)
def src_count(s, a): return s.count(a)

# (a) load the gate in <head>, right after supabase.js, BEFORE the app inline script
a = '<script src="supabase.js"></script>'
assert src.count(a) == 1
src = src.replace(a, a + '\n<script src="reviewer-gate.js"></script>', 1)

# (b) GATE-FIRST: the app's bottom init() now hands off to the gate
a = '\n  init();\n</script>'
assert src.count(a) == 1, 'init() call anchor not found'
src = src.replace(a, '\n  if (window.__reviewerGate) { window.__reviewerGate(init); } else { init(); }\n</script>', 1)

# (c) REMOVE ADMIN: delete the Admin View tab button
a = '        <button class="mode-btn" id="btn-admin" onclick="switchToView(\'admin\')">Admin View</button>\n'
assert src.count(a) == 1, 'btn-admin anchor not found'
src = src.replace(a, '', 1)

# (d) REMOVE ADMIN: make admin unreachable even if switchToView is called
a = '  function switchToView(mode) { setViewMode(mode); }'
assert src.count(a) == 1, 'switchToView anchor not found'
src = src.replace(a, "  function switchToView(mode) { if (mode === 'admin') return; setViewMode(mode); }", 1)

open('reviewer-build/index.html','w').write(src)
print('reviewer-build/index.html written')
print('  gate tag:', '<script src="reviewer-gate.js"></script>' in src)
print('  gate-first handoff:', 'window.__reviewerGate(init)' in src)
print('  btn-admin removed:', 'id="btn-admin"' not in src)
print('  switchToView guarded:', "if (mode === 'admin') return" in src)
PY

echo "=== isolation: reviewer URL present, production URL absent ==="
grep -rl abmmyjnhhxgyqspycecz "$OUT" | sed 's/^/  reviewer URL in: /'
grep -rl lmrmteaclszgsvrfjnsg "$OUT" && { echo "!! PROD URL LEAK"; exit 1; } || echo "  production URL: ABSENT"
echo "=== bundle ==="; ls -la "$OUT"
