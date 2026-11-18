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
  },
  required: ["tier", "flash", "flashSid", "flashAt", "sessionID", "name", "tool", "notice", "sessions"],
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
          // 碎碎念总开关（缺省/true=开；false 时 server 定时碎碎念与梦话静默，手动不受影响）
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
    todoAdd: {
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
      output: state,
    },
    todoClear: { input: empty, output: state },
    resetBrain: { input: empty, output: state },
  },
  events: { state: { schema: state } },
} as const satisfies Rpc.PortableDefinition
