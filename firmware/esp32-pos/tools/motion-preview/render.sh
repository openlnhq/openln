#!/usr/bin/env bash
# Render RIC motion previews (MP4 + key-frame stills) from the real scene code.
# usage: render.sh <TFT_eSPI dir> <out dir> [scenario ...]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FW="$(cd "$HERE/../.." && pwd)"
TFT="$1"; OUT="$2"; shift 2
SCEN=("$@"); [ ${#SCEN[@]} -eq 0 ] && SCEN=(receive send stall card-issue card-wipe provision connect update receive-big)
mkdir -p "$OUT"
BIN="$OUT/ric-preview"
g++ -std=c++17 -O2 -I "$FW/src" -I "$TFT" "$HERE/preview.cpp" "$FW/src/motion/Scenes.cpp" -o "$BIN"
for s in "${SCEN[@]}"; do
  "$BIN" "$s" | ffmpeg -loglevel error -y -f rawvideo -pix_fmt rgb24 -s 320x240 -r 30 -i - \
    -vf "scale=640:480:flags=neighbor" -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p "$OUT/$s.mp4"
  echo "rendered $OUT/$s.mp4"
done
