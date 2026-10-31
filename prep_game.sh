#!/usr/bin/env bash
# usage: ./prep_game.sh <path to ps2-web-recomp repo> <game.chd|.iso|.cue> <short name>
# CHD -> ISO -> recompile -> WebAssembly build -> ../fast_build/ (fast.html + ps2web.*)
set -euo pipefail
REPO=$(cd "$1" && pwd); SRC=$(realpath "$2"); NAME=${3:-game}
HERE=$(cd "$(dirname "$0")" && pwd); OUT="$HERE"   # outputs land next to index.html (one flat root)
INPUT="$SRC"; mkdir -p "$HERE/_disc"
if [[ "${SRC,,}" == *.chd ]]; then
  command -v chdman >/dev/null || { echo "chdman missing (install mame-tools / MAME)"; exit 1; }
  if chdman extractdvd -i "$SRC" -o "$HERE/_disc/$NAME.iso" -f; then INPUT="$HERE/_disc/$NAME.iso"
  else chdman extractcd -i "$SRC" -o "$HERE/_disc/$NAME.cue" -ob "$HERE/_disc/$NAME.bin" -f; INPUT="$HERE/_disc/$NAME.cue"; fi
fi
python3 "$HERE/patch_shell.py" "$REPO/web/shell.html"
"$REPO/scripts/port.sh" "$NAME" "$INPUT"
B="$REPO/build/web-$NAME"
cp "$B/ps2web.js" "$B/ps2web.wasm" "$OUT/"; cp "$B"/ps2web.data "$OUT/" 2>/dev/null || true
cp "$B/ps2web.html" "$OUT/fast.html"
echo
echo "Done. Test locally (serves page + disc with Range support):"
echo "  python3 $REPO/scripts/serve.py $B $REPO/games/$NAME/disc.iso   ->  http://localhost:8620/"
