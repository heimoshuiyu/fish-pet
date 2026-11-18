# fish-pet 🐟

OpenCode V2 桌面宠物插件：一条跟随会话状态的大肥鱼（吃白饭、碎碎念、看你干活、庆祝/沮丧），
窗口内渲染，移植自 DSH 的 dsh-pet（大肥鱼）。双半架构：server 是脑，窗口只做展示。

## 安装

```bash
opencode plugin add opencode-fish-pet
```

或 opencode.json：

```jsonc
"plugins": [
  "opencode-fish-pet",
  // 可选：余额六档（BYO key，每 30 分钟自查一次）
  { "package": "opencode-fish-pet", "options": { "balance": {
      "deepseek": { "apiKey": "sk-…", "total": 50 },
      "custom": [ { "name": "中转站", "url": "https://…/balance", "headers": { "Authorization": "Bearer …" }, "path": "data.remaining", "total": 100 } ]
  } } }
]
```

注意：
- 需要 OpenCode ≥ 2.0；GUI 插件通道为 experimental，宿主大版本升级后可能要求更新本插件
- 桌面/Web 窗口可见；TUI 端无鱼（GUI 插件不进终端，属预期）
- 鱼的碎碎念/对话会创建一个普通 OpenCode 会话（标题 🐟 fish-pet 对话），走你自己配置的模型计费
- 右键鱼有菜单：睡觉/起来、再来一只、收起这只、换个动作、开聊、记一笔待办、查天气、查余额、
  碎碎念一句、重置鱼脑、开关完成通知、大一点/小一点、回原位（共 14 项）；
  桌面端 `Settings → Extensions → Plugins` 可关

## 行为速览

- 工作状态机：聚合所有运行中会话（thinking/working/result），250ms 采样、1.2s 稳定、4s 驻留
- 完成庆祝：前台会话收官全量庆祝，后台完成冒气泡不抢动画；子代理完成静默
- 碎碎念：每 5 分钟随口一句（10 分钟内无观众心跳则沉默）；睡觉时说梦话
- 多开：可养多条鱼，鱼 0 演聚合状态，其余各绑一个运行中会话
- 面板聊天：Fish 标签页可直接对话，发送即有"正在琢磨"反馈、逐字流式回复

## 包结构

| 文件 | 角色 |
|---|---|
| `index.ts` | server 脑（入口 `.`） |
| `rpc.ts` | server ↔ 窗口的 JSON-Schema 契约（入口 `./rpc`，`state`/`focus`/`whisper`/`say`/`todo*`/`weather`/`resetBrain`） |
| `gui-experimental.cjs` | 前端渲染器 bundle（入口 `./gui-experimental`，CJS，7.4MB 含内嵌资产）；窗口跑 default export，`main` 导出不存在=不做桌面悬浮，属预期 |

源码、资产管线与开发循环见仓库：<https://github.com/heimoshuiyu/fish-pet>（`DEVELOPMENT.md`）。

## 致谢与素材条款

- 社区作品，与 OpenCode / DeepSeek Harness 无关联
- 动画链/物理等部分代码与 27 段动画、音效源自 dsh-pet（PC2005-cloud）：代码 MIT（LICENSE 内已保留其版权行）；
  **素材禁止商用**，公开渠道分发须署名 https://github.com/PC2005-cloud/dsh-pet
  —— 本包据此标注 `SEE LICENSE IN LICENSE`（代码 MIT + 素材条款，详见 LICENSE）
