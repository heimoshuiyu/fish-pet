import type { Rpc } from "@opencode/plugin/rpc"

/**
 * fish-pet 的窗口契约：server 是脑（状态机/碎碎念/待办/天气），前端只做展示。
 * 前端 focus 上报兼作心跳与情境同步（server 侧没有 message.list，摘要由前端构建）。
 * state 事件在每次脑状态变化时推送，wire type 为 rpc.fish-pet.state。
 */

const state = {
  type: "object",
  properties: {
    tier: { anyOf: [{ enum: ["thinking", "working", "result", "waiting"] }, { type: "null" }] },
    flash: { anyOf: [{ enum: ["success", "error"] }, { type: "null" }] },
    // 触发全量庆祝的会话（通知定向用）；合并批次无单一归属时为 null
    flashSid: { type: ["string", "null"] },
    // 该次庆祝的发起时刻：通知去重 id 的唯一维度（app 端 claim 持久化 id，静态 id 会永久哑火）
    flashAt: { anyOf: [{ type: "number" }, { type: "null" }] },
    sessionID: { type: ["string", "null"] },
    // 宠物名字（server 存储，注入提示词）
    name: { type: ["string", "null"] },
    // 语言权威（server 持久化并经 state 同步全端；focus 心带的 lang 不再覆盖它）
    lang: { type: "string" },
    // 共享偏好权威（server 持久化并经 state 同步全端；focus 心带的 whisper 不再覆盖总开关）
    whisper: { type: "boolean" },
    notify: { type: "boolean" },
    width: { type: "number" },
    // 最近 90s 工具调用折叠成的一句话（工作气泡展示）
    tool: { type: ["string", "null"] },
    // 后台完成的气泡（server 组稿、队列合并），at 单调递增供前端判新
    notice: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            text: { type: "string" },
            sid: { type: ["string", "null"] },
            ok: { type: "boolean" },
            at: { type: "number" },
          },
          required: ["text", "sid", "ok", "at"],
          additionalProperties: false,
        },
      ],
    },
    // 运行中会话及其派生档（按最近活跃降序，供前端把会话鱼粘性绑定上去）
    sessions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          tier: { enum: ["thinking", "working", "result"] },
        },
        required: ["sessionID", "tier"],
        additionalProperties: false,
      },
    },
    // 待办安全投影（用户录入文本+截止，无内部字段；供窗口/overlay 列表展示）
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          dueAt: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
        required: ["text", "dueAt"],
        additionalProperties: false,
      },
    },
  },
  required: ["tier", "flash", "flashSid", "flashAt", "sessionID", "name", "lang", "whisper", "notify", "width", "tool", "notice", "sessions", "todos"],
  additionalProperties: false,
} as const

const empty = { type: "object", additionalProperties: false } as const

export const FishState = {
  id: "fish-pet",
  methods: {
    state: { input: empty, output: state },
    focus: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: ["string", "null"] },
          digest: { type: "string" },
          sleeping: { type: "boolean" },
          running: { type: "array", items: { type: "string" } },
          lang: { type: "string" },
          // wire 兼容保留：不再作为碎碎念总开关来源（权威是 server settings.whisper）
          whisper: { type: "boolean" },
        },
        required: ["sessionID", "digest", "sleeping", "running"],
        additionalProperties: false,
      },
      output: state,
    },
    whisper: {
      input: { type: "object", properties: { dream: { type: "boolean" } }, required: ["dream"], additionalProperties: false },
      output: state,
    },
    say: {
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      output: state,
    },
    name: {
      input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      output: state,
    },
    language: {
      // 显式设置全端语言（唯一权威写入点；非法值被 server 忽略）
      input: { type: "object", properties: { lang: { enum: ["zh", "en", "ja"] } }, required: ["lang"], additionalProperties: false },
      output: state,
    },
    settings: {
      // 共享偏好唯一写入点：至少一项（全空被拒），字段类型由 schema 限定，width 合法域 120–360；原子拒绝非法
      input: {
        type: "object",
        properties: {
          whisper: { type: "boolean" },
          notify: { type: "boolean" },
          width: { type: "number", minimum: 120, maximum: 360 },
        },
        anyOf: [{ required: ["whisper"] }, { required: ["notify"] }, { required: ["width"] }],
        additionalProperties: false,
      },
      output: state,
    },
    presence: {
      // 桌外 overlay 观众心跳：只报睡眠态；server 只用它刷新桌外在场与睡眠，不覆盖窗口 focus 的任何字段
      input: {
        type: "object",
        properties: { sleeping: { type: "boolean" } },
        required: ["sleeping"],
        additionalProperties: false,
      },
      output: state,
    },
    balance: {
      input: { type: "object", properties: { force: { type: "boolean" } }, required: ["force"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          // 快照时间（epoch ms）；0 = 无配置/查询未发生，不缓存
          at: { type: "number" },
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                // DeepSeek 官方条目固定名 "DeepSeek"；custom 用配置名，未命名为空串
                name: { type: "string" },
                remaining: { anyOf: [{ type: "number" }, { type: "null" }] },
                total: { anyOf: [{ type: "number" }, { type: "null" }] },
                // 精简错误码：unauthorized=key 失效 / timeout=15s 超时 / upstream=HTTP 或解析失败；不含密钥来源信息
                error: { anyOf: [{ enum: ["unauthorized", "timeout", "upstream"] }, { type: "null" }] },
              },
              required: ["name", "remaining", "total", "error"],
              additionalProperties: false,
            },
          },
        },
        required: ["at", "results"],
        additionalProperties: false,
      },
    },
    todoAdd: {
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      output: state,
    },
    todoClear: { input: empty, output: state },
    resetBrain: { input: empty, output: state },
  },
  events: { state: { schema: state } },
} as const satisfies Rpc.PortableDefinition
