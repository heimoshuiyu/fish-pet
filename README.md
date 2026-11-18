# fish-pet 🐟

OpenCode V2 桌面宠物插件：一条跟随会话状态的大肥鱼（吃白饭、碎碎念、看你干活、庆祝/沮丧），
窗口内渲染，移植自 DSH 的 dsh-pet（大肥鱼）。双半架构：server 是脑，窗口只做展示。

## 文件

| 文件 | 角色 |
|---|---|
| `index.ts` | server 脑：会话事件 → 工作状态机（250ms 采样 / 1.2s 稳定 / 4s 驻留）、碎碎念（单点 + 10min 观众门控）、完成庆祝与后台气泡、待办、天气、鱼会话（普通 OpenCode session，随当前会话模型创建） |
| `rpc.ts` | server ↔ 窗口的 JSON-Schema 契约（`state`/`focus`/`whisper`/`say`/`todo*`/`weather`/`resetBrain` + `state` 事件） |
| `gui-experimental.cjs` | 前端渲染器 bundle（CJS，7.4MB 含内嵌资产）。窗口跑 default export；`main` 导出不存在=不做桌面悬浮，属预期 |
| `package.json` | `{"private": true}` 是防误发 npm 的保险栓，发布时再改形状 |

## build/ —— GUI 源码与资产管线

- `logic.js`：GUI 逻辑源（改这里，不要改 cjs）
- `gen-assets.py` + `assets/`：27 段 480×270 VP9-alpha webm + 鸭子音效 → base64 常量 `head.js`（脚本目录自包含）
- `build.sh`：拼接 head.js + logic.js → 写入插件目录，`node --check` 校验；桌面端经 `plugin.updated` 热重载
- `surgery-v4.py` / `tail-extract.cjs`：v4 迁移期的一次性工具，留档

## 开发循环

本仓库是源，live 部署目标是 `~/.config/opencode/plugins/fish-pet/`（auto-discovery）：

```bash
# server 侧改动：改 index.ts / rpc.ts 后同步过去，server 热重载
cp index.ts rpc.ts ~/.config/opencode/plugins/fish-pet/

# GUI 侧改动：改 build/logic.js 后构建（build.sh 自动写入部署目标并热重载）
bash build/build.sh
```

## ⚠️ 素材许可

27 段动画与音效源自 dsh-pet（CC-BY-NC）。**个人使用 OK；公开分发前必须**：
换自产素材（`gen-assets.py` 管线可复用），或整包按 CC-BY-NC-4.0 发布并署名 dsh-pet 原作者。
本仓库因此建为 private；转 public / 发 npm 前先做这个决定。

## 发布（尚未执行，已调研）

标准路径：npm 包（exports `.` + `./rpc` + `./gui-experimental`，`files` 带上三者）→
用户 `opencode plugin add fish-pet` 一行装完；或 Git 私发
`opencode plugin add 'git+https://github.com/heimoshuiyu/fish-pet.git'`（figma 同款模式，绕开资产许可问题）。
版本声明建议 `peerDependencies: { "@opencode/plugin": ">=2.0.0 <3" }`；README 需注明
GUI 通道为 experimental、TUI 端无鱼、鱼会话走用户自己的模型计费。
