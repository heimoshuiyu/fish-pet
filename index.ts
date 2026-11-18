import type { Plugin } from "@opencode/plugin/promise/plugin"
import { FishState } from "./rpc"

/**
 * fish-pet server 半侧：机制全部在这，前端只做展示。
 * - 状态机 v3：事件只更新电平；候选稳定→最小驻留→切换；庆祝/沮丧原子不可打断、单槽合并、冷却降级气泡文案
 *   （动画不打断的判定在脑里完成，前端收到的是已经去抖的 tier/flash）
 * - 碎碎念单点：每个 server 一份调度；只在「最近 10 分钟有前端心跳」时开口（观众门控）
 * - 情境摘要由前端 focus 上报携带（server 侧没有 message.list）
 * - 鱼会话：一个 server 一条鱼命，sessionID 持久化在插件 storage
 */

const T = {
  TICK: 250,
  STABLE: 1200,
  HOLD_WORKING: 2500,
  TAIL_THINKING: 3000,
  RESULT_MAX: 4000,
  DWELL: 4000,
  FORCE_AFTER: 3000,
  ATOMIC: 6500,
  CELEBRATE_CD: 20000,
  DEDUP: 2000,
  QUIET_WAITING: 9000,
  AUDIENCE_TTL: 10 * 60 * 1000,
  WHISPER_EVERY: 5 * 60 * 1000,
}

const PERSONA =
  "你是主人桌面上的一只吃白饭的蓝色大肥鱼（Q版小女仆形象），温柔乖巧带点俏皮，爱碎碎念。"
const WHISPER_MARK = "[[fish-whisper]]"
const CUES = "写代码、吃白饭、被吓一跳、魔方、睡觉"
const CUE_MAP: Record<string, string> = {
  写代码: "flavor-code",
  吃白饭: "flavor-eat",
  被吓一跳: "flavor-scared",
  魔方: "walk",
  睡觉: "sleep-start",
}

interface Sig {
  toolOpen: number
  lastDelta: number
  lastToolEnd: number
}

const WORK_TYPES = new Set([
  "session.reasoning.delta",
  "session.text.delta",
  "session.tool.input.started",
  "session.tool.success",
  "session.tool.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
])

const trim = (text: string, max: number) => (text ?? "").replace(/\s+/g, " ").slice(0, max)

export default {
  id: "fish-pet",
  async setup(context) {
    const controller = new AbortController()

    // ---------- 恢复持久状态 ----------
    const storedSession = (await context.storage.get("session").catch(() => undefined)) as { id?: string } | undefined
    let fishSessionID = storedSession?.id ?? undefined
    const storedTodos = (await context.storage.get("todos").catch(() => undefined)) as string[] | undefined
    let todos = Array.isArray(storedTodos) ? storedTodos : []
    let weatherText: string | null = null
    // ---------- 后台完成气泡队列（≤3 合并；全量庆祝走 flash 不进这里）----------
    let notice: { text: string; sid: string | null; ok: boolean; at: number } | null = null
    const noticeQueue: { text: string; sid: string; ok: boolean }[] = []
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    const pumpNotice = () => {
      if (notice || !noticeQueue.length || controller.signal.aborted) return
      const next = noticeQueue.shift()
      if (noticeQueue.length) next.text = `${next.text}（还有 ${noticeQueue.length} 个）`
      noticeQueue.length = 0
      notice = { ...next, at: Date.now() }
      emit()
      noticeTimer = setTimeout(() => {
        notice = null
        emit()
        pumpNotice()
      }, 3200)
    }

    // ---------- 机器状态 ----------
    const sig = new Map<string, Sig>()
    const running = new Set<string>()
    let curTier: string | null = null
    let clipStart = 0
    let cand: string | null = null
    let candSince = 0
    let pending: string | null = null
    let atomic: { kind: "success" | "error"; start: number; sid?: string } | null = null
    let gapUntil = 0
    let nextBatch: "success" | "error" | null = null
    let lastCelebrate = 0
    let lastAnyActivity = 0
    let whisperCount = 0
    const doneDedup = new Map<string, number>()
    const reportedAt = new Map<string, number>()
    let focus: { sessionID: string | null; digest: string; sleeping: boolean; at: number } | null = null

    const nowMs = () => performance.now()

    const snapshot = () => ({
      tier: curTier,
      flash: atomic ? atomic.kind : null,
      flashSid: atomic ? (atomic.sid ?? null) : null,
      flashAt: atomic ? atomic.start : null,
      sessionID: fishSessionID ?? null,
      todos,
      weather: weatherText,
      notice,
      sessions: runningSessionTiers(),
    })
    function runningSessionTiers() {
      const now = nowMs()
      const rows: { sessionID: string; tier: string; at: number }[] = []
      for (const sid of running) {
        const s = sig.get(sid)
        rows.push({
          sessionID: sid,
          tier: derived(sid, now) ?? "thinking",
          at: Math.max(s?.lastDelta ?? 0, s?.lastToolEnd ?? 0),
        })
      }
      return rows
        .sort((a, b) => b.at - a.at)
        .slice(0, 8)
        .map(({ sessionID, tier }) => ({ sessionID, tier }))
    }
    let lastEmit = ""

    const registration = await context.rpc.register(FishState, {
      state: async () => snapshot(),
      focus: async (input) => {
        focus = {
          sessionID: input.sessionID ?? null,
          digest: String(input.digest ?? "").slice(0, 2000),
          sleeping: !!input.sleeping,
          at: Date.now(),
        }
        // 对账：前端看得见全部运行中会话；补上插件加载前已开始的，并记最近上报时间供 tick 清鬼
        for (const sid of Array.isArray(input.running) ? input.running : []) {
          if (typeof sid !== "string" || sid === fishSessionID) continue
          reportedAt.set(sid, Date.now())
          if (!running.has(sid)) {
            running.add(sid)
            if (!sig.has(sid)) sig.set(sid, { toolOpen: 0, lastDelta: 0, lastToolEnd: 0 })
          }
        }
        return snapshot()
      },
      whisper: async (input) => {
        void runWhisper({ dream: !!input.dream, manual: true })
        return snapshot()
      },
      say: async (input) => {
        const text = trim(String(input.text ?? ""), 500)
        if (!text) return snapshot()
        // 面板聊天：没有会话就现建（空态承诺"直接发消息"）。
        // 新会话首条带人格引导（WHISPER_MARK 前缀 → 面板隐藏这条内部消息）；
        // 已有会话发原文，人格已在历史里。
        const fresh = !fishSessionID
        const sid = await ensureFishSession()
        if (!sid) return snapshot()
        const body = fresh
          ? [
              WHISPER_MARK,
              PERSONA,
              `主人对你说了下面这句话，用鱼的口吻直接回答主人（50 字以内）。想配动作就在末尾加 [播放:动作名]，可用动作：${CUES}。不要用任何工具、不要读文件，只输出回答本身。`,
              `主人说：${text}`,
            ].join("\n\n")
          : text
        await context.session.prompt({ sessionID: sid, text: body })
        return snapshot()
      },
      todoAdd: async (input) => {
        const text = trim(String(input.text ?? ""), 80)
        if (text) {
          todos = [...todos, text].slice(-20)
          await context.storage.set("todos", todos).catch(() => {})
          emit()
        }
        return snapshot()
      },
      todoClear: async () => {
        todos = []
        await context.storage.set("todos", todos).catch(() => {})
        emit()
        return snapshot()
      },
      weather: async () => {
        void refreshWeather()
        return snapshot()
      },
      resetBrain: async () => {
        brainGen++ // 在途 whisper 的失败重建让位给重置
        if (fishSessionID) {
          await context.session.remove({ sessionID: fishSessionID }).catch(() => {})
        }
        fishSessionID = undefined
        await context.storage.set("session", {}).catch(() => {})
        emit()
        return snapshot()
      },
    })

    function emit() {
      const value = JSON.stringify(snapshot())
      if (value === lastEmit) return
      lastEmit = value
      void registration.events.emit("state", snapshot()).catch(() => {})
    }

    // ---------- 状态机 v3（与前端版同款数字）----------
    const derived = (sid: string, now: number): string | null => {
      const s = sig.get(sid)
      if (!s) return null
      if (s.toolOpen > 0 || now - s.lastToolEnd < T.HOLD_WORKING) return "working"
      if (now - s.lastDelta < T.TAIL_THINKING) return "thinking"
      if (now - s.lastToolEnd < T.RESULT_MAX) return "result"
      return null
    }
    const computeTarget = (now: number): string | null => {
      let best: string | null = null
      for (const sid of running) {
        const d = derived(sid, now)
        if (d === "working") return "working"
        if (d === "thinking") best = "thinking"
        else if (d === "result" && best !== "thinking") best = "result"
      }
      if (best) return best
      if (running.size) {
        if (lastAnyActivity && now - lastAnyActivity > T.QUIET_WAITING) return "waiting"
        return "thinking"
      }
      return null
    }
    function onCompletion(sid: string, ok: boolean, now: number) {
      if (now - (doneDedup.get(sid) ?? -1e9) < T.DEDUP) return
      doneDedup.set(sid, now)
      const full = (focus?.sessionID && sid === focus.sessionID) || running.size === 0
      if (full && !atomic && now >= gapUntil && now - lastCelebrate >= T.CELEBRATE_CD) {
        atomic = { kind: ok ? "success" : "error", start: now, sid }
        lastCelebrate = now
        emit()
      } else if (atomic) {
        nextBatch = ok ? (nextBatch === "error" ? "error" : "success") : "error"
      } else {
        // 非全量完成：气泡（不打断主动画）；子代理会话静默；绑定该会话的前端鱼自行庆祝
        void (async () => {
          const info = await context.session.get({ sessionID: sid }).catch(() => undefined)
          if (info?.parentID) return // subagent 完成：机器照常聚合，但不进气泡
          queueNotice(sid, ok, info?.title)
        })()
      }
    }

    async function queueNotice(sid: string, ok: boolean, title?: string) {
      const text = (ok ? "✓ " : "✗ ") + (trim(title ?? "", 18) || (await context.session.get({ sessionID: sid }).catch(() => undefined))?.title?.slice(0, 18) || "一个会话")
      if (noticeQueue.length < 3) noticeQueue.push({ text, sid, ok })
      pumpNotice()
    }

    const tickTimer = setInterval(() => {
      if (controller.signal.aborted) return
      const now = nowMs()
      for (const sid of [...sig.keys()]) if (!running.has(sid)) sig.delete(sid)
      // 鬼清理（按会话粒度）：长期无上报且无活动的"运行中"是误报/残影
      for (const sid of [...running]) {
        const reported = Date.now() - (reportedAt.get(sid) ?? 0)
        const s = sig.get(sid)
        const idle = !s || now - Math.max(s.lastDelta, s.lastToolEnd) > 60000
        if (reported > 120000 && idle) running.delete(sid)
      }
      // 去重表瘦身：doneDedup 只要 2s 窗口，reportedAt 只要 2 分钟窗口
      for (const [sid, at] of doneDedup) if (Date.now() - at > 60000) doneDedup.delete(sid)
      for (const [sid, at] of reportedAt) if (Date.now() - at > 120000) reportedAt.delete(sid)
      const target = computeTarget(now)

      if (atomic) {
        if (now - atomic.start < T.ATOMIC) return
        atomic = null
        gapUntil = now + 1000
        curTier = null
        clipStart = now
        emit()
        return
      }
      if (now < gapUntil) return
      if (nextBatch) {
        const kind = nextBatch
        nextBatch = null
        atomic = { kind, start: now }
        lastCelebrate = now
        emit()
        return
      }

      if (target !== cand) {
        cand = target
        candSince = now
        pending = null
      }
      if (cand === null) {
        if (curTier !== null) {
          curTier = null
          emit()
        }
        return
      }
      if (now - candSince >= T.STABLE) pending = cand
      if (!pending || pending === curTier) return

      if (curTier === null) {
        curTier = pending
        pending = null
        clipStart = now
        emit()
        return
      }
      const played = now - clipStart
      if (played < T.DWELL) return
      if (now - candSince - T.STABLE >= T.FORCE_AFTER) {
        curTier = pending
        pending = null
        clipStart = now
        emit()
      }
    }, T.TICK)
    // 每拍兜底 emit：sessions（绑定数据）与 notice 的变化不依赖机器切换，
    // JSON 去重让无变化时零开销，有变化时 250ms 内必达前端。
    const emitTick = setInterval(() => {
      if (controller.signal.aborted) return
      emit()
    }, T.TICK)

    // ---------- 事件订阅：世界状态的唯一入口 ----------
    void (async () => {
      for await (const event of context.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) return
        if (!WORK_TYPES.has(event.type)) continue
        const data = event.data as { sessionID?: string } | undefined
        const sid = data?.sessionID
        if (!sid || sid === fishSessionID) continue
        const now = nowMs()
        switch (event.type) {
          case "session.reasoning.delta":
          case "session.text.delta": {
            const s = sig.get(sid) ?? { toolOpen: 0, lastDelta: 0, lastToolEnd: 0 }
            s.lastDelta = now
            sig.set(sid, s)
            lastAnyActivity = now
            break
          }
          case "session.tool.input.started": {
            const s = sig.get(sid) ?? { toolOpen: 0, lastDelta: 0, lastToolEnd: 0 }
            s.toolOpen++
            sig.set(sid, s)
            lastAnyActivity = now
            break
          }
          case "session.tool.success":
          case "session.tool.failed": {
            const s = sig.get(sid)
            if (s) {
              s.toolOpen = Math.max(0, s.toolOpen - 1)
              s.lastToolEnd = now
            }
            lastAnyActivity = now
            break
          }
          case "session.execution.started":
            running.add(sid)
            lastAnyActivity = now
            break
          case "session.execution.succeeded":
            running.delete(sid)
            onCompletion(sid, true, now)
            break
          case "session.execution.failed":
            running.delete(sid)
            onCompletion(sid, false, now)
            break
          case "session.execution.interrupted":
            running.delete(sid)
            break
        }
      }
    })().catch(() => {})

    // ---------- 碎碎念：单点 + 观众门控 + 重置栅栏 ----------
    let brainGen = 0
    let ensureInFlight: Promise<string | undefined> | undefined
    async function ensureFishSession(): Promise<string | undefined> {
      if (fishSessionID) return fishSessionID
      if (ensureInFlight) return ensureInFlight
      ensureInFlight = (async () => {
        let model: { id: string; providerID: string; variant?: string } | undefined
        if (focus?.sessionID) {
          const info = await context.session.get({ sessionID: focus.sessionID }).catch(() => undefined)
          model = info?.model as { id: string; providerID: string; variant?: string } | undefined
        }
        const info = await context.session
          .create({ title: "🐟 fish-pet 对话", ...(model?.id && model.providerID ? { model } : {}) })
          .catch(() => undefined)
        if (info?.id) {
          fishSessionID = info.id
          await context.storage.set("session", { id: fishSessionID }).catch(() => {})
          emit()
          return fishSessionID
        }
        return undefined
      })()
      try {
        return await ensureInFlight
      } finally {
        ensureInFlight = undefined
      }
    }

    async function runWhisper(opts: { dream: boolean; manual?: boolean }) {
      if (!opts.manual) {
        // 定时碎碎念需要观众：最近 AUDIENCE_TTL 内有前端心跳才开口
        if (!focus || Date.now() - focus.at > T.AUDIENCE_TTL) return
      }
      const sid = await ensureFishSession()
      if (!sid) return
      const gen = brainGen // 重置栅栏：resetBrain 之后的在途失败不再重建
      const digest = opts.dream || !focus ? "" : focus.digest
      const text = [
        WHISPER_MARK,
        PERSONA,
        opts.dream
          ? "你正在睡觉，半梦半醒地嘟囔一句梦话（15 字以内，可以不着边际）。"
          : `主人正在忙自己的事，你看着他桌面的会话情境随口碎碎念一句（20 字以内）。${
              digest ? `当前情境（可能为空）：\n${digest}\n` : ""
            }`,
        `想配一个动作就在末尾加 [播放:动作名]，可用动作：${CUES}。不要用任何工具、不要读文件，只输出这句话本身。`,
      ]
        .filter(Boolean)
        .join("\n\n")
      await context.session.prompt({ sessionID: sid, text }).catch(async () => {
        // 会话失效：清掉重建一次（除非刚被重置鱼脑）
        if (gen !== brainGen) return
        fishSessionID = undefined
        await context.storage.set("session", {}).catch(() => {})
        const fresh = await ensureFishSession()
        if (fresh && gen === brainGen) await context.session.prompt({ sessionID: fresh, text }).catch(() => {})
      })
    }

    const whisperTimer = setInterval(() => {
      if (controller.signal.aborted) return
      whisperCount++
      const audience = !!focus && Date.now() - focus.at <= T.AUDIENCE_TTL
      if (!audience) return
      if (focus?.sleeping && whisperCount % 2 === 1) return // 全睡时隔拍说梦话
      void runWhisper({ dream: !!focus?.sleeping })
    }, T.WHISPER_EVERY)

    // ---------- 天气（免 key：ipwho.is + Open-Meteo，server 侧无 CSP）----------
    async function refreshWeather() {
      try {
        const geo = await (await fetch("https://ipwho.is/")).json()
        if (!geo || geo.success === false) throw new Error("geo")
        const meteo = await (
          await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}&current_weather=true`,
          )
        ).json()
        const w = meteo.current_weather
        weatherText = `${geo.city ?? geo.ip} ${Math.round(w.temperature)}°C`
        emit()
      } catch {
        weatherText = null
        emit()
      }
    }

    // ---------- 待办提醒节奏由前端展示层决定；这里只保证数据 ----------
    void emit()

    return () => {
      clearInterval(tickTimer)
      clearInterval(emitTick)
      clearInterval(whisperTimer)
      if (noticeTimer) clearTimeout(noticeTimer)
      controller.abort()
    }
  },
} satisfies Plugin
