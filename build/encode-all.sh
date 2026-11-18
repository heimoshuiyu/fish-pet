#!/usr/bin/env bash
# 把 dsh-pet 的全部动画素材重编码进 fish-pet（480x270 VP9-alpha）。
# alpha 保真的两个关键（2026-11-18 黑框事故复盘）：
#   1. 解码端必须强制 libvpx-vp9（-i 之前！）——默认解码器会静默丢掉 WebM 侧通道 alpha；
#   2. 每个产物硬校验：强制解码解一帧必须是 rgba，否则判失败。
# 排除 baifan 小游戏 5 段（未移植玩法）。
set -uo pipefail
SRC="$HOME/.dsh/profiles/web/node_modules/dsh-pet/assets/webm"
OUT="$HOME/fish-pet/build/assets"
mkdir -p "$OUT"
skip="(开心小跑|侧身急躁跑|期待开饭|吃饭·碗饭|吃饭团)"
ok=0; fail=0
for f in "$SRC"/*.webm; do
  base=$(basename "$f" .webm)
  if [[ "$base" =~ $skip ]]; then continue; fi
  [ -s "$OUT/$base.webm" ] && [ -s "$OUT/$base.ok" ] && continue
  if ffmpeg -y -loglevel error -c:v libvpx-vp9 -i "$f" \
      -vf "scale=480:270,format=yuva420p" -r 24 \
      -c:v libvpx-vp9 -crf 42 -b:v 0 -row-mt 1 -an \
      "$OUT/$base.webm"; then
    # alpha 硬校验：强制解码解一帧，pix_fmt 必须 rgba
    if ffmpeg -y -loglevel error -c:v libvpx-vp9 -i "$OUT/$base.webm" -frames:v 1 "/tmp/opencode/alpha-check.png" \
      && [ "$(ffprobe -v error -show_entries stream=pix_fmt -of csv=p=0 /tmp/opencode/alpha-check.png)" = "rgba" ]; then
      touch "$OUT/$base.ok"
      ok=$((ok+1))
    else
      echo "ALPHA-FAIL: $base" >> "$OUT/.failures"
      rm -f "$OUT/$base.webm"
      fail=$((fail+1))
    fi
  else
    echo "ENCODE-FAIL: $base" >> "$OUT/.failures"
    fail=$((fail+1))
  fi
done
echo "encoded=$ok failed=$fail verified=$(ls "$OUT"/*.ok 2>/dev/null | wc -l)"
du -sh "$OUT"
