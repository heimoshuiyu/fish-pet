#!/usr/bin/env bash
# fish-pet 构建脚本：重新拼接 head.js(资产) + logic.js(逻辑) 到插件目录。
# 改 logic.js 后跑本脚本即可，桌面端经 plugin.updated 热重载，无需重启。
set -euo pipefail
cd "$(dirname "$0")"
python3 gen-assets.py
cat head.js logic.js > ~/.config/opencode/plugins/fish-pet/gui-experimental.cjs
node --check ~/.config/opencode/plugins/fish-pet/gui-experimental.cjs
echo "built: $(du -h ~/.config/opencode/plugins/fish-pet/gui-experimental.cjs | cut -f1)"
