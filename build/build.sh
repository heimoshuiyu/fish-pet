#!/usr/bin/env bash
# fish-pet 构建脚本：拼接 head.js（资产）+ logic.js（窗口内 GUI）到插件目录。
set -euo pipefail
cd "$(dirname "$0")"
python3 gen-assets.py
cat head.js logic.js > ../gui-experimental.cjs
node --check ../gui-experimental.cjs
echo "built: $(du -h ../gui-experimental.cjs | cut -f1)"
