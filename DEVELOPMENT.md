# fish-pet 开发指南（仓库内部文档，不进 npm 包）

## build/ —— GUI 源码与资产管线

- `logic.js`：GUI 逻辑源（改这里，不要改 cjs）
- `gen-assets.py` + `assets/`：27 段 480×270 VP9-alpha webm + 鸭子音效 → base64 常量 `head.js`（脚本目录自包含）
- `build.sh`：拼接 head.js + logic.js → 写入插件目录，`node --check` 校验；桌面端经 `plugin.updated` 热重载
- `surgery-v4.py` / `tail-extract.cjs`：v4 迁移期的一次性工具，留档

## 开发循环

本仓库是源，live 部署目标是 `~/.config/opencode/plugins/fish-pet/`（auto-discovery）：

```bash
# server 侧改动：改 index.ts / rpc.ts / package.json 后同步过去，server 热重载
cp index.ts rpc.ts package.json ~/.config/opencode/plugins/fish-pet/

# GUI 侧改动：改 build/logic.js 后构建（build.sh 自动写入部署目标并热重载）
bash build/build.sh
```

npm 安装形态（`~/.cache/opencode/npm/…`）的用户不走上面的 cp 流程；升级靠发新版 +
`opencode plugin update`。发布流程：

1. `npm publish --dry-run` 核对 tarball（files 白名单：index.ts / rpc.ts /
   gui-experimental.cjs / README.md / LICENSE，共 6 文件）
2. `npm publish`；随后 commit + push 本仓库
3. 验证：`opencode plugin add opencode-fish-pet` 装一遍实测（官方要求 test the
   installed package，不是只测 workspace 副本）
