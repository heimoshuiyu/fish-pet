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

const WHISPER_MARK = "[[fish-whisper]]"
const CUES = "写代码、吃白饭、被吓一跳、魔方、睡觉"
const CUE_MAP: Record<string, string> = {
  写代码: "flavor-code",
  吃白饭: "flavor-eat",
  被吓一跳: "flavor-scared",
  魔方: "walk",
  睡觉: "sleep-start",
}

// 语言模板表：加语言 = 加一项并注册（动作 tag 保持中文 [播放:写代码]，客户端 CUE_MAP 解析不动）
const L10N = {
  zh: {
    persona: "你是主人桌面上的一只吃白饭的蓝色大肥鱼（Q版小女仆形象），温柔乖巧带点俏皮，爱碎碎念。",
    dream: "你正在睡觉，半梦半醒地嘟囔一句梦话（15 字以内，可以不着边际）。",
    murmur: (digest: string) => `主人正在忙自己的事，你看着他桌面的会话情境随口碎碎念一句（20 字以内）。${digest ? `当前情境（可能为空）：\n${digest}\n` : ""}`,
    cue: `想配一个动作就在末尾加 [播放:动作名]，可用动作：${CUES}。不要用任何工具、不要读文件，只输出这句话本身。`,
    sayFresh: `主人对你说了下面这句话，用鱼的口吻直接回答主人（50 字以内）。想配动作就在末尾加 [播放:动作名]，可用动作：${CUES}。不要用任何工具、不要读文件，只输出回答本身。`,
    sayLead: "主人说：",
    more: (n: number) => `（还有 ${n} 个）`,
    title: "🐟 fish-pet 对话",
  },
  en: {
    persona: "You are a chubby blue freeloader pet fish (chibi-maid look) living on your owner's desktop — gentle, sweet, a little playful, and prone to muttering.",
    dream: "You're asleep, half-dreaming — mumble one dreamy line (within 10 words, nonsense is fine).",
    murmur: (digest: string) => `Your owner is busy at their desk. Watching their session context, mutter one casual line (within 12 words).${digest ? `\nCurrent context (may be empty):\n${digest}\n` : ""}`,
    cue: `To add an action, end with [播放:action]; actions: ${CUES}. No tools, no file reading — output only the line itself.`,
    sayFresh: `Your owner said the line below to you. Answer them directly in your fish persona (within 30 words). To add an action, end with [播放:action]; actions: ${CUES}. No tools, no file reading — output only the answer.`,
    sayLead: "Owner said: ",
    more: (n: number) => ` (+${n} more)`,
    title: "🐟 fish-pet chat",
  },
  ja: {
    persona: "あなたはご主人様のデスクトップに住み着く、タダ飯を食う青い太った魚（ちびメイド風）。優しくて素直、少しいたずらで、ひとりごとが多い。",
    dream: "寝ています。半分夢うつつで寝言をひとこと（15字以内、でたらめでもOK）。",
    murmur: (digest: string) => `ご主人様が作業中です。そのデスクトップの様子を見て、ひとことつぶやいて（20字以内）。${digest ? `今の状況（空かも）：\n${digest}\n` : ""}`,
    cue: `動きを付けたいなら末尾に [播放:動作名] を追加、動作：${CUES}。ツールは使わず、ファイルも読まず、そのひとことだけを出力。`,
    sayFresh: `ご主人様が下の一言をあなたに話しかけました。魚の口調で直接答えて（50字以内）。動きを付けるなら末尾に [播放:動作名]、動作：${CUES}。ツール不使用、ファイル不読込、答えだけを出力。`,
    sayLead: "ご主人様：",
    more: (n: number) => `（ほか ${n} 件）`,
    title: "🐟 fish-pet おしゃべり",
  },
}
type FishLang = keyof typeof L10N


// ---------- 时间背景（移植自 dsh-pet 的 MIT 实现，浓缩为三语；农历走 ICU，不可用则优雅退化）----------
const DAY_MS = 86_400_000
type Lang3 = 0 | 1 | 2 // zh / en / ja 列索引
const TIME_SLOTS: ReadonlyArray<readonly [number, string, string, string]> = [
  [23, "深夜", "late night", "深夜"], [19, "晚上", "evening", "夜"], [17, "傍晚", "dusk", "夕方"],
  [13, "下午", "afternoon", "午後"], [11, "中午", "midday", "昼"], [9, "上午", "late morning", "午前"],
  [7, "早上", "morning", "朝"], [5, "清晨", "early morning", "早朝"], [0, "凌晨", "small hours", "未明"],
]
const WEEKDAYS3: ReadonlyArray<readonly [string, string, string]> = [
  ["星期日", "Sunday", "日曜日"], ["星期一", "Monday", "月曜日"], ["星期二", "Tuesday", "火曜日"],
  ["星期三", "Wednesday", "水曜日"], ["星期四", "Thursday", "木曜日"], ["星期五", "Friday", "金曜日"],
  ["星期六", "Saturday", "土曜日"],
]
type Fest = { kind: "solar" | "lunar" | "lunarEve"; key?: string; zh: string; en: string; ja: string; span?: number; ahead?: number; after?: number }
const FESTIVALS: readonly Fest[] = [
  { kind: "solar", key: "2-14", zh: "情人节", en: "Valentine's Day", ja: "バレンタイン", after: 0 },
  { kind: "solar", key: "12-31", zh: "跨年夜", en: "New Year's Eve", ja: "大晦日", after: 0 },
  { kind: "solar", key: "4-1", zh: "愚人节", en: "April Fools' Day", ja: "エイプリルフール", after: 0 },
  { kind: "solar", key: "5-4", zh: "青年节", en: "Youth Day", ja: "青年節", ahead: 0, after: 0 },
  { kind: "lunarEve", zh: "除夕", en: "Lunar New Year's Eve", ja: "旧暦の大晦日", ahead: 1, after: 0 },
  { kind: "lunar", key: "1-15", zh: "元宵节", en: "Lantern Festival", ja: "小正月" },
  { kind: "lunar", key: "1-1", zh: "春节", en: "Spring Festival", ja: "春節", span: 15 },
  { kind: "lunar", key: "8-15", zh: "中秋节", en: "Mid-Autumn Festival", ja: "中秋節", span: 3, after: 2 },
  { kind: "solar", key: "10-1", zh: "国庆节", en: "National Day", ja: "国慶節", span: 7 },
  { kind: "solar", key: "1-1", zh: "元旦", en: "New Year's Day", ja: "元日", span: 3 },
  { kind: "lunar", key: "5-5", zh: "端午节", en: "Dragon Boat Festival", ja: "端午節", span: 3 },
  { kind: "solar", key: "4-4", zh: "清明节", en: "Qingming Festival", ja: "清明節", span: 3, ahead: 1 },
  { kind: "solar", key: "5-1", zh: "劳动节", en: "Labor Day", ja: "メーデー", span: 3 },
  { kind: "solar", key: "6-1", zh: "儿童节", en: "Children's Day", ja: "こどもの日" },
  { kind: "lunar", key: "7-7", zh: "七夕", en: "Qixi Festival", ja: "七夕" },
  { kind: "lunar", key: "7-15", zh: "中元节", en: "Ghost Festival", ja: "中元節" },
  { kind: "lunar", key: "2-2", zh: "龙抬头", en: "Longtaitou Festival", ja: "龍抬頭" },
  { kind: "lunar", key: "9-9", zh: "重阳节", en: "Double Ninth Festival", ja: "重陽節" },
  { kind: "lunar", key: "12-8", zh: "腊八节", en: "Laba Festival", ja: "臘八節" },
  { kind: "lunar", key: "12-23", zh: "小年", en: "Little New Year", ja: "小年" },
  { kind: "season", key: "1-20|2-18", zh: "寒假", en: "winter break", ja: "冬休み" },
  { kind: "season", key: "7-1|8-29", zh: "暑假", en: "summer break", ja: "夏休み" },
  { kind: "solar", key: "3-8", zh: "妇女节", en: "Women's Day", ja: "女性の日" },
  { kind: "solar", key: "9-10", zh: "教师节", en: "Teachers' Day", ja: "教師の日" },
  { kind: "solar", key: "7-1", zh: "建党节", en: "CPC Founding Day", ja: "建党節" },
  { kind: "solar", key: "8-1", zh: "建军节", en: "Army Day", ja: "建軍節" },
  { kind: "solar", key: "10-31", zh: "万圣夜", en: "Halloween", ja: "ハロウィン" },
  { kind: "solar", key: "12-24", zh: "平安夜", en: "Christmas Eve", ja: "クリスマスイブ", after: 0 },
  { kind: "solar", key: "12-25", zh: "圣诞节", en: "Christmas", ja: "クリスマス" },
]
const WMO3: Record<number, readonly [string, string, string]> = {
  0: ["晴", "clear", "晴れ"], 1: ["基本晴", "mainly clear", "おおむね晴"], 2: ["多云", "partly cloudy", "晴時々曇"],
  3: ["阴", "overcast", "曇り"], 45: ["雾", "fog", "霧"], 48: ["雾凇", "rime fog", "霧氷"],
  51: ["毛毛雨", "light drizzle", "霧雨"], 53: ["细雨", "drizzle", "小雨"], 55: ["密雨", "dense drizzle", "雨"],
  61: ["小雨", "light rain", "小雨"], 63: ["中雨", "rain", "雨"], 65: ["大雨", "heavy rain", "大雨"],
  71: ["小雪", "light snow", "小雪"], 73: ["中雪", "snow", "雪"], 75: ["大雪", "heavy snow", "大雪"],
  80: ["阵雨", "showers", "にわか雨"], 81: ["阵雨", "showers", "にわか雨"], 82: ["强阵雨", "heavy showers", "激しい雨"],
  95: ["雷暴", "thunderstorm", "雷雨"], 96: ["雷暴冰雹", "thunderstorm with hail", "雷雨ひょう"], 99: ["雷暴冰雹", "thunderstorm with hail", "雷雨ひょう"],
}

let lunarFmt: Intl.DateTimeFormat | null | undefined
function getLunarFmt(): Intl.DateTimeFormat | undefined {
  if (lunarFmt === null) return undefined
  if (!lunarFmt) {
    const fmt = new Intl.DateTimeFormat("en-u-ca-chinese", { month: "numeric", day: "numeric", year: "numeric" })
    lunarFmt = fmt.resolvedOptions().calendar === "chinese" ? fmt : null
  }
  return lunarFmt ?? undefined
}
function lunarPartsOf(date: Date): { month: number; day: number } | undefined {
  const fmt = getLunarFmt()
  if (!fmt) return undefined
  const parts = fmt.formatToParts(date)
  const raw = (t: string) => parts.find((p) => p.type === t)?.value
  const rm = raw("month"), rd = raw("day"), ry = raw("relatedYear") ?? raw("year")
  if (!rm || !rd || !ry) return undefined
  const month = Number.parseInt(rm, 10), day = Number.parseInt(rd, 10), year = Number.parseInt(ry, 10)
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return undefined
  const g = date.getFullYear()
  if (year !== g && year !== g - 1) return undefined
  return { month: /bis/i.test(rm) ? -month : month, day }
}
function isLunarEve(date: Date): boolean {
  const t = lunarPartsOf(date)
  if (!t || t.month !== 12) return false
  const n = lunarPartsOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1))
  return Boolean(n && n.month === 1 && n.day === 1)
}
function dayOfYear(date: Date): number {
  return (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / DAY_MS
}
function dayOfYearOf(year: number, md: string): number {
  const [m, d] = md.split("-").map(Number)
  return (Date.UTC(year, (m ?? 1) - 1, d ?? 1) - Date.UTC(year, 0, 1)) / DAY_MS
}
const festName = (f: Fest, li: Lang3) => (li === 1 ? f.en : li === 2 ? f.ja : f.zh)

/** 节日/假期从句（三语措辞；一天只出优先级最高的一个）。 */
function holidayClause(date: Date, li: Lang3): string {
  let best: { clause: string; priority: number } | undefined
  const keep = (c: { clause: string; priority: number } | undefined) => {
    if (c && (!best || c.priority < best.priority)) best = c
  }
  const phrase = (f: Fest, delta: number): string => {
    const name = festName(f, li)
    const span = f.span ?? 1
    if (delta > 0) {
      if (delta === 1) return li === 1 ? `tomorrow is ${name}` : li === 2 ? `明日は${name}` : `明天就是${name}`
      return li === 1 ? `${name} is coming (${delta} days)` : li === 2 ? `もうすぐ${name}` : `快要过${name}了`
    }
    if (delta === 0) return li === 1 ? `today is ${name}` : li === 2 ? `今日は${name}` : `今天是${name}`
    const daysIn = -delta
    if (daysIn < span) {
      if (span - daysIn === 1) return li === 1 ? `last day of the ${name} break` : li === 2 ? `${name}の休みも今日で最後` : `${name}假期最后一天了`
      return li === 1 ? `the ${name} break is on` : li === 2 ? `まだ${name}の休み中` : `还在${name}假期里`
    }
    const rest = daysIn - span
    if (rest <= 1) return li === 1 ? `${name} just ended` : li === 2 ? `${name}が終わったばかり` : `${name}刚过完`
    return li === 1 ? `${name} ended a while ago` : li === 2 ? `${name}はもう終わった` : `${name}这么快就过完了`
  }
  const candidate = (f: Fest, delta: number, priority: number) => {
    const ahead = f.ahead ?? 3, span = f.span ?? 1, after = f.after ?? 3
    const daysIn = -delta
    if (delta > 0 && delta > ahead) return
    if (delta < 0 && daysIn >= span + after) return
    keep({ clause: phrase(f, delta), priority })
  }
  for (let delta = -18; delta <= 3; delta++) {
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta)
    FESTIVALS.forEach((f, priority) => {
      if (f.kind === "solar") {
        if (f.key === `${day.getMonth() + 1}-${day.getDate()}`) candidate(f, delta, priority)
      } else if (f.kind === "lunar") {
        const lp = lunarPartsOf(day)
        if (lp && lp.month > 0 && f.key === `${lp.month}-${lp.day}`) candidate(f, delta, priority)
      } else if (f.kind === "lunarEve") {
        if (isLunarEve(day)) candidate(f, delta, priority)
      }
    })
  }
  // 假期区间（寒暑假）
  const year = date.getFullYear()
  const today = dayOfYear(date)
  FESTIVALS.forEach((f, priority) => {
    if (f.kind !== "season" || !f.key) return
    const [fromMd, toMd] = f.key.split("|")
    const from = dayOfYearOf(year, fromMd), to = dayOfYearOf(year, toMd)
    const name = festName(f, li)
    if (today < from) {
      const ah = from - today
      if (ah <= 3) keep({ clause: ah === 1 ? (li === 1 ? `tomorrow the ${name} starts` : li === 2 ? `明日から${name}` : `明天就放${name}了`) : (li === 1 ? `${name} is starting soon` : li === 2 ? `もうすぐ${name}` : `快要放${name}了`), priority })
    } else if (today <= to) {
      if (today === from) keep({ clause: li === 1 ? `the ${name} has started` : li === 2 ? `${name}が始まった` : `${name}开始了`, priority })
      else if (to - today < 3) keep({ clause: li === 1 ? `${name} is ending soon` : li === 2 ? `${name}も終わりに近い` : `${name}快结束了`, priority })
      else keep({ clause: li === 1 ? `${name} is on` : li === 2 ? `${name}の真っ最中` : `正在放${name}`, priority })
    } else if (today - to - 1 < 3) {
      keep({ clause: li === 1 ? `${name} just ended` : li === 2 ? `${name}が終わったばかり` : `${name}刚结束`, priority })
    }
  })
  return best ? best.clause : ""
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


// ---------- server 侧三语文案（名字行 / 时间背景 / 工具折叠 / 待办提醒）----------
interface EnvFacts {
  city?: string
  region?: string
  code?: number
  temperatureC?: number
  apparentC?: number
  humidity?: number
  windKph?: number
  at: number
}
const numText = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const S10N: Record<FishLang, {
  nameLine: (n: string) => string
  timeContext: (now: Date, env: EnvFacts | null) => string
  toolNames: Record<string, string>
  toolJoin: string
  todoDue: (text: string, overdue: boolean) => string
}> = {
  zh: {
    nameLine: (n) => `你的名字是「${n}」。`,
    timeContext: (now, env) => {
      const d = now.getDay(), h = now.getHours()
      const slot = TIME_SLOTS.find(([s]) => h >= s)?.[1] ?? "凌晨"
      const dayKind = d === 0 || d === 6 ? "周末" : "工作日"
      const holiday = holidayClause(now, 0)
      let envLine = "，外面的天气这次没查到，主人问起就说不知道、别编"
      if (env) {
        const sum = (env.code !== undefined && WMO3[env.code]?.[0]) ?? "天气不明"
        const place = env.city ? `你在${env.city}（按网络粗估，不一定准），` : ""
        envLine = `，${place}外面${sum}` +
          (env.temperatureC !== undefined ? `，气温 ${numText(env.temperatureC)}°C` : "") +
          (env.apparentC !== undefined ? `，体感 ${numText(env.apparentC)}°C` : "") +
          (env.humidity !== undefined ? `，湿度 ${Math.round(env.humidity)}%` : "") +
          (env.windKph !== undefined ? `，风速 ${numText(env.windKph)} km/h` : "")
      }
      return `【当下】现在是${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${WEEKDAYS3[d]?.[0] ?? "星期"} ${String(h).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}，${slot}，${dayKind}${holiday ? "，" + holiday : ""}${envLine}。这只是背景，不必刻意报时，也别句句都提节日或天气——多数时候正常说话就好，真贴切时才顺口带一句。`
    },
    toolNames: { bash: "跑命令", shell: "跑命令", read: "读文件", edit: "改文件", write: "写文件", grep: "搜代码", glob: "找文件", task: "派任务", todowrite: "记待办", webfetch: "读网页", list: "列目录" },
    toolJoin: "、",
    todoDue: (t, overdue) => (overdue ? `‼️ 逾期：${t}` : `⏰ 待办：${t}`),
  },
  en: {
    nameLine: (n) => `Your name is "${n}".`,
    timeContext: (now, env) => {
      const d = now.getDay(), h = now.getHours()
      const slot = TIME_SLOTS.find(([s]) => h >= s)?.[2] ?? "small hours"
      const dayKind = d === 0 || d === 6 ? "the weekend" : "a workday"
      const holiday = holidayClause(now, 1)
      let envLine = ". No weather data this time — if asked, say you don't know; don't make one up"
      if (env) {
        const sum = (env.code !== undefined && WMO3[env.code]?.[1]) ?? "weather unknown"
        const place = env.city ? ` in ${env.city}${env.region ? ", " + env.region : ""} (rough IP estimate, may be off)` : ""
        envLine = `${place}: outside it's ${sum}` +
          (env.temperatureC !== undefined ? `, ${numText(env.temperatureC)}°C` : "") +
          (env.apparentC !== undefined ? `, feels like ${numText(env.apparentC)}°C` : "") +
          (env.humidity !== undefined ? `, humidity ${Math.round(env.humidity)}%` : "") +
          (env.windKph !== undefined ? `, wind ${numText(env.windKph)} km/h` : "")
      }
      const hm = `${((h + 11) % 12) + 1}:${String(now.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`
      return `[Now] It's ${WEEKDAYS3[d]?.[1] ?? ""}, ${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}, ${hm}, ${slot} on ${dayKind}${holiday ? ", " + holiday : ""}${envLine}. Background only — don't report the time, and mention holidays or weather only when it truly fits.`
    },
    toolNames: { bash: "running commands", shell: "running commands", read: "reading files", edit: "editing files", write: "writing files", grep: "searching code", glob: "finding files", task: "spawning tasks", todowrite: "updating todos", webfetch: "fetching pages", list: "listing files" },
    toolJoin: ", ",
    todoDue: (t, overdue) => (overdue ? `‼️ Overdue: ${t}` : `⏰ To-do: ${t}`),
  },
  ja: {
    nameLine: (n) => `あなたの名前は「${n}」。`,
    timeContext: (now, env) => {
      const d = now.getDay(), h = now.getHours()
      const slot = TIME_SLOTS.find(([s]) => h >= s)?.[3] ?? "未明"
      const dayKind = d === 0 || d === 6 ? "週末" : "平日"
      const holiday = holidayClause(now, 2)
      let envLine = "。今回は天気が取れていない。聞かれたら知らないと答えて、捏造しないで"
      if (env) {
        const sum = (env.code !== undefined && WMO3[env.code]?.[2]) ?? "天気不明"
        const place = env.city ? `${env.city}（IP 推定、当たってないかも）で` : ""
        envLine = `。${place}外は${sum}` +
          (env.temperatureC !== undefined ? `、気温 ${numText(env.temperatureC)}°C` : "") +
          (env.apparentC !== undefined ? `、体感 ${numText(env.apparentC)}°C` : "") +
          (env.humidity !== undefined ? `、湿度 ${Math.round(env.humidity)}%` : "") +
          (env.windKph !== undefined ? `、風速 ${numText(env.windKph)} km/h` : "")
      }
      return `【今】${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日${WEEKDAYS3[d]?.[2] ?? ""} ${String(h).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}、${slot}、${dayKind}${holiday ? "、" + holiday : ""}${envLine}。これは背景情報なので、わざわざ時刻を報告したり毎回祝日や天気に触れたりしないで、本当に合うときだけさりげなく。`
    },
    toolNames: { bash: "コマンド実行", shell: "コマンド実行", read: "ファイル読み取り", edit: "ファイル編集", write: "ファイル書き込み", grep: "コード検索", glob: "ファイル検索", task: "タスク派遣", todowrite: "todo更新", webfetch: "ページ取得", list: "一覧取得" },
    toolJoin: "・",
    todoDue: (t, overdue) => (overdue ? `‼️ 期限切れ：${t}` : `⏰ todo：${t}`),
  },
}

// ---------- 待办节奏（移植 dsh-pet policy：越近越密、逾期一周停）----------
const TODO_AHEAD_STEPS: ReadonlyArray<readonly [number, number]> = [
  [3 * DAY_MS, DAY_MS], [DAY_MS, 12 * 3600e3], [6 * 3600e3, 4 * 3600e3], [3600e3, 3600e3], [15 * 60e3, 20 * 60e3], [0, 5 * 60e3],
]
const TODO_AHEAD_START = 7 * DAY_MS
const TODO_OVERDUE_STOP = 7 * DAY_MS
function reminderIntervalMs(remainingMs: number): number {
  if (remainingMs <= 0) {
    const overdue = -remainingMs
    if (overdue >= TODO_OVERDUE_STOP) return Number.POSITIVE_INFINITY
    return overdue >= DAY_MS ? 6 * 3600e3 : 30 * 60e3
  }
  if (remainingMs > TODO_AHEAD_START) return Number.POSITIVE_INFINITY
  for (const [minRemaining, interval] of TODO_AHEAD_STEPS) if (remainingMs >= minRemaining) return interval
  return 5 * 60e3
}
interface Todo {
  text: string
  dueAt: number | null
  createdAt: number
  lastRemindedAt: number | null
}
function nextReminderAt(todo: Todo, now: number): number | null {
  if (todo.dueAt === null) return null
  const intervalNow = reminderIntervalMs(todo.dueAt - now)
  if (!Number.isFinite(intervalNow)) return null
  if (todo.lastRemindedAt !== null) return todo.lastRemindedAt + intervalNow
  const remainingAtCreation = todo.dueAt - todo.createdAt
  if (remainingAtCreation > TODO_AHEAD_START) return todo.createdAt + intervalNow
  const intervalAtCreation = reminderIntervalMs(remainingAtCreation)
  const step = Math.min(Number.isFinite(intervalAtCreation) ? intervalAtCreation : 0, Math.max(0, remainingAtCreation))
  return todo.createdAt + step
}
/** 待办输入的 @ 截尾解析：YYYY-MM-DD[ HH:MM] | HH:MM | Nh/Nd/Nm */
function parseDue(input: string): { text: string; dueAt: number | null } {
  const m = input.match(/^(.*?)\s*@\s*(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2})?|\d{1,2}:\d{2}|\d+(?:[mhd]))$/)
  if (!m) return { text: input, dueAt: null }
  const spec = m[2]
  const now = new Date()
  let due: number | null = null
  const md = spec.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/)
  if (md) {
    const d = new Date(+md[1], +md[2] - 1, +md[3], md[4] ? +md[4] : 9, md[5] ? +md[5] : 0)
    if (!Number.isNaN(d.getTime())) due = d.getTime()
  } else if (/^\d{1,2}:\d{2}$/.test(spec)) {
    const [h, mi] = spec.split(":").map(Number)
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    due = d.getTime()
  } else {
    const rel = spec.match(/^(\d+)([mhd])$/)
    if (rel) due = Date.now() + (+rel[1] * (rel[2] === "d" ? 86400 : rel[2] === "h" ? 3600 : 60)) * 1000
  }
  if (due === null) return { text: input, dueAt: null }
  return { text: m[1].trim(), dueAt: due }
}

export default {
  id: "fish-pet",
  async setup(context) {
    const controller = new AbortController()

    // ---------- 恢复持久状态 ----------
    const storedSession = (await context.storage.get("session").catch(() => undefined)) as { id?: string } | undefined
    let fishSessionID = storedSession?.id ?? undefined
    const storedTodos = (await context.storage.get("todos").catch(() => undefined)) as unknown[] | undefined
    let todos: Todo[] = (Array.isArray(storedTodos) ? storedTodos : []).map((t) =>
      typeof t === "string"
        ? { text: t, dueAt: null, createdAt: Date.now(), lastRemindedAt: null }
        : (t as Todo),
    )
    const storedName = (await context.storage.get("name").catch(() => undefined)) as { name?: string } | undefined
    let petName: string | null = typeof storedName?.name === "string" && storedName.name.trim() ? storedName.name.trim() : null
    let envFacts: EnvFacts | null = null
    // ---------- 后台完成气泡队列（≤3 合并；全量庆祝走 flash 不进这里）----------
    let notice: { text: string; sid: string | null; ok: boolean; at: number } | null = null
    const noticeQueue: { text: string; sid: string; ok: boolean }[] = []
    let noticeTimer: ReturnType<typeof setTimeout> | undefined
    const pumpNotice = () => {
      if (notice || !noticeQueue.length || controller.signal.aborted) return
      const next = noticeQueue.shift()
      if (noticeQueue.length) next.text += L10N[slang()].more(noticeQueue.length)
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
    let focus: { sessionID: string | null; digest: string; sleeping: boolean; lang: string; whisper: boolean; at: number } | null = null
    // 语言（独立开关，随 focus 心跳到达）：影响碎碎念/对话提示词、完成气泡后缀、会话标题
    const slang = (): FishLang => (focus && focus.lang in L10N ? (focus.lang as FishLang) : "en")

    const nowMs = () => performance.now()

    const snapshot = () => ({
      tier: curTier,
      flash: atomic ? atomic.kind : null,
      flashSid: atomic ? (atomic.sid ?? null) : null,
      flashAt: atomic ? atomic.start : null,
      sessionID: fishSessionID ?? null,
      name: petName,
      tool: toolLine(),
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
        // 防自反馈：前端路由到了鱼会话（fishSid 尚未同步到前端时前端拦不住）——此时摘要就是鱼自己的话，
        // 不能当主人情境。按 fishSessionID 判定并清空 sessionID/digest；心跳/观众/开关语义照常。
        const selfFocus = !!input.sessionID && input.sessionID === fishSessionID
        focus = {
          sessionID: selfFocus ? null : (input.sessionID ?? null),
          digest: selfFocus ? "" : String(input.digest ?? "").slice(0, 2000),
          sleeping: !!input.sleeping,
          lang: typeof input.lang === "string" ? input.lang : "en",
          whisper: input.whisper !== false,
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
        const L = L10N[slang()]
        const S = S10N[slang()]
        const head = [L.persona, petName ? S.nameLine(petName) : ""].filter(Boolean).join("\n")
        const body = fresh
          ? [WHISPER_MARK, head, L.sayFresh, S.timeContext(new Date(), envFacts), `${L.sayLead}${text}`].filter(Boolean).join("\n\n")
          : text
        await context.session.prompt({ sessionID: sid, text: body })
        return snapshot()
      },
      todoAdd: async (input) => {
        const parsed = parseDue(trim(String(input.text ?? ""), 120))
        if (parsed.text) {
          todos = [...todos, { text: parsed.text.slice(0, 80), dueAt: parsed.dueAt, createdAt: Date.now(), lastRemindedAt: null }].slice(-20)
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
      name: async (input) => {
        const n = trim(String(input.name ?? ""), 24)
        petName = n || null
        await context.storage.set("name", { name: petName ?? "" }).catch(() => {})
        emit()
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

    // 工具折叠：最近 90s 内各会话的工具调用（name+次数）折成一句话进 state.tool
    const toolStats = new Map<string, { name: string; at: number }[]>()
    function toolLine(): string | null {
      const now = nowMs()
      let sidBest: string | null = null
      let latest = -Infinity
      for (const [sid, list] of toolStats) {
        const last = list.length ? list[list.length - 1].at : -Infinity
        if (last > latest) {
          latest = last
          sidBest = sid
        }
      }
      if (!sidBest || now - latest > 90_000) return null
      const list = (toolStats.get(sidBest) ?? []).filter((e) => now - e.at <= 90_000)
      if (!list.length) return null
      const L = S10N[slang()]
      const counts = new Map<string, number>()
      for (const e of list) counts.set(e.name, (counts.get(e.name) ?? 0) + 1)
      const parts = [...counts.entries()].slice(0, 3).map(([n, c]) => {
        const d = L.toolNames[n] ?? n
        return c > 1 ? `${d}×${c}` : d
      })
      return parts.join(L.toolJoin)
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
      // 工具折叠窗口衰减
      for (const [sid, list] of toolStats) {
        const kept = list.filter((e) => now - e.at <= 90_000)
        if (kept.length) toolStats.set(sid, kept)
        else toolStats.delete(sid)
      }
      // 待办提醒（每拍最多一条，越近越密；进 notice 气泡不打断主动画）
      const nowMsReal = Date.now()
      let dueTodo: Todo | null = null
      let dueAt = Infinity
      for (const t of todos) {
        const at = nextReminderAt(t, nowMsReal)
        if (at !== null && at <= nowMsReal && at < dueAt) {
          dueTodo = t
          dueAt = at
        }
      }
      if (dueTodo) {
        dueTodo.lastRemindedAt = nowMsReal
        void context.storage.set("todos", todos).catch(() => {})
        if (noticeQueue.length < 3) {
          noticeQueue.push({ text: S10N[slang()].todoDue(dueTodo.text, dueTodo.dueAt !== null && dueTodo.dueAt < nowMsReal), sid: "", ok: true })
          pumpNotice()
        }
      }
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
            const name = (event.data as { name?: string } | undefined)?.name
            if (typeof name === "string" && name) {
              const list = toolStats.get(sid) ?? []
              list.push({ name, at: now })
              toolStats.set(sid, list.slice(-30))
              emit()
            }
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
          .create({ title: L10N[slang()].title, ...(model?.id && model.providerID ? { model } : {}) })
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
      const L = L10N[slang()]
      const S = S10N[slang()]
      const head = [L.persona, petName ? S.nameLine(petName) : ""].filter(Boolean).join("\n")
      if (!envFacts || Date.now() - envFacts.at > 3600e3) void refreshEnv() // 陈旧就后台补一拍
      const text = [WHISPER_MARK, head, opts.dream ? L.dream : L.murmur(digest), S.timeContext(new Date(), envFacts), L.cue]
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
      if (focus?.whisper === false) return // 碎碎念总开关：关了就静默（含梦话；菜单手动触发不受影响）
      if (focus?.sleeping && whisperCount % 2 === 1) return // 全睡时隔拍说梦话
      void runWhisper({ dream: !!focus?.sleeping })
    }, T.WHISPER_EVERY)

    // ---------- 环境事实（免 key：ipwho.is + Open-Meteo；只喂碎碎念/对话提示词，不再作为独立功能）----------
    async function refreshEnv() {
      try {
        const geo = await (await fetch("https://ipwho.is/")).json()
        if (!geo || geo.success === false) throw new Error("geo")
        const meteo = await (
          await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
              `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&timezone=auto`,
          )
        ).json()
        const c = meteo.current
        envFacts = {
          city: typeof geo.city === "string" ? geo.city : undefined,
          region: typeof geo.region === "string" ? geo.region : undefined,
          code: typeof c?.weather_code === "number" ? c.weather_code : undefined,
          temperatureC: typeof c?.temperature_2m === "number" ? c.temperature_2m : undefined,
          apparentC: typeof c?.apparent_temperature === "number" ? c.apparent_temperature : undefined,
          humidity: typeof c?.relative_humidity_2m === "number" ? c.relative_humidity_2m : undefined,
          windKph: typeof c?.wind_speed_10m === "number" ? c.wind_speed_10m : undefined,
          at: Date.now(),
        }
      } catch {
        if (!envFacts || Date.now() - envFacts.at > 6 * 3600e3) envFacts = null
      }
    }
    void refreshEnv()
    const envTimer = setInterval(() => {
      if (!controller.signal.aborted) void refreshEnv()
    }, 30 * 60e3)

    void emit()

    return () => {
      clearInterval(tickTimer)
      clearInterval(emitTick)
      clearInterval(whisperTimer)
      clearInterval(envTimer)
      if (noticeTimer) clearTimeout(noticeTimer)
      controller.abort()
    }
  },
} satisfies Plugin
