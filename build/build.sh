#!/usr/bin/env bash
# fish-pet 构建脚本：重新拼接 head.js(资产) + overlay-src.js(桌外页源) + logic.js(逻辑) 到插件目录。
# 改 logic.js 后跑本脚本即可，桌面端经 plugin.updated 热重载，无需重启。
set -euo pipefail
cd "$(dirname "$0")"
python3 gen-assets.py
cat head.js overlay-src.js logic.js > ../gui-experimental.cjs
node --check ../gui-experimental.cjs
echo "built: $(du -h ../gui-experimental.cjs | cut -f1)"
