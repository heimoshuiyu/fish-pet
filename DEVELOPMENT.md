# fish-pet 开发指南（仓库内部文档，不进 npm 包）

## build/ —— GUI 源码与资产管线

- `logic.js`：GUI 逻辑源（改这里，不要改 cjs）
- `pools.json`：动画池配置（idle/turn/move 权重、五个分类池、点击/工作/余额/睡觉/碎碎念事件池、cue 映射）——加减动画只改这里
- `gen-assets.py` + `assets/`：按 pools.json 把全部 webm + 鸭子音效 base64 成 head.js（ASSETS + POOLS 常量）；引用缺文件=构建失败
- `encode-all.sh`：从 dsh-pet 安装包批量重编码全部素材（480×270 VP9-alpha，保 alpha 配方）到 assets/；首次全量入库时用过
- `build.sh`：拼接 head.js + logic.js → 写到仓库根 `gui-experimental.cjs`，`node --check` 校验；本机跑 npm 版，生效走发布 + `opencode plugin update`
- `surgery-v4.py` / `tail-extract.cjs`：v4 迁移期的一次性工具，留档

## 开发循环

> 当前本机跑的是 **npm 安装版**（`opencode plugin add opencode-fish-pet`，装在 `~/.cache/opencode/npm/`），
> 本地开发副本已挪到 `.live-backup/fish-pet-pre-npm`（不能留在 plugins/ 目录里——同名 id 会双开冲突）。
> 恢复本地开发：把备份拷回 `~/.config/opencode/plugins/fish-pet/` 并从 opencode.json 删掉
> `"opencode-fish-pet"` 条目；发新版则改完直接 `npm publish`（绕 2FA 的粒度令牌在本机 ~/.npmrc，90 天有效）。

本仓库是源，live 部署目标是 `~/.config/opencode/plugins/fish-pet/`（auto-discovery）：

```bash
# server 侧改动：改 index.ts / rpc.ts / package.json 后同步过去，server 热重载
cp index.ts rpc.ts package.json ~/.config/opencode/plugins/fish-pet/

# GUI 侧改动：改 build/logic.js 后构建（产物进仓库根，发布后 update 生效）
bash build/build.sh
```

npm 安装形态（`~/.cache/opencode/npm/…`）的用户不走上面的 cp 流程；升级靠发新版 +
`opencode plugin update`。发布流程：

1. `npm publish --dry-run` 核对 tarball（files 白名单：index.ts / rpc.ts /
   gui-experimental.cjs / README.md / LICENSE，共 6 文件）
2. `npm publish`；随后 commit + push 本仓库
3. 验证：`opencode plugin add opencode-fish-pet` 装一遍实测（官方要求 test the
   installed package，不是只测 workspace 副本）
