#!/usr/bin/env bash
# 把 dsh-pet 的全部动画素材重编码进 fish-pet（480x270 VP9-alpha，与既有 27 段同配方）。
# alpha 保真的关键：解码侧必须强制 libvpx-vp9 + yuva420p，否则 alpha 静默丢失。
# 排除 baifan 小游戏 5 段（未移植玩法）。
set -uo pipefail
SRC="$HOME/.dsh/profiles/web/node_modules/dsh-pet/assets/webm"
OUT="$HOME/fish-pet/build/assets-full"
mkdir -p "$OUT"
skip="(开心小跑|侧身急躁跑|期待开饭|吃饭·碗饭|吃饭团)"
ok=0; fail=0
for f in "$SRC"/*.webm; do
  base=$(basename "$f" .webm)
  if [[ "$base" =~ $skip ]]; then continue; fi
  [ -s "$OUT/$base.webm" ] && continue
  if ffmpeg -y -loglevel error -i "$f" \
      -c:v libvpx-vp9 -vf "scale=480:270,format=yuva420p" -r 24 \
      -c:v libvpx-vp9 -crf 42 -b:v 0 -row-mt 1 -an \
      "$OUT/$base.webm"; then
    ok=$((ok+1))
  else
    echo "FAIL: $base" >> "$OUT/.failures"
    fail=$((fail+1))
  fi
done
echo "encoded=$ok failed=$fail total_in=$(ls "$OUT"/*.webm 2>/dev/null | wc -l)"
du -sh "$OUT"
