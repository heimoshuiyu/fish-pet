// ---- fish-pet GUI 逻辑 ----
// 移植自 dsh-pet：动画链/物理/掷骰保留 v1；新增多开互撞、双击弹弓、点击池+音效、
// 持久化(声明式 store)、待办、天气、余额六档、鱼会话(碎碎念/对话/梦话)、Panel、Contract、通知开关。
// 通道事实（均已核对源码）：session.prompt/create 走 data 解包；message.list {data,cursor} 带 order:desc；
// attention.notify 点击固定打开 session；Contract id 必须是本插件 id。

const { Plugin, Style, Slot, Panel, Store, Contract } = require("@opencode/plugin/gui");

let Schema = undefined;
try {
  Schema = require("effect").Schema;
} catch {
  /* 旧版本窗口没有 effect：回落内存态，无持久化 */
}

// ---------- 水平命中/碰撞几何（共用）----------
// 画布 16:9 不变、垂向不动；鱼身约占画布宽 33%–35%（200px 画布实测 65–70px）。
// 两侧按 28.5% 内缩 → 有效框 43%：覆盖抽样常规姿态鱼身并留 ~7–9px 容差；.fish-hit 命中区与物理 x 边界同用此比例。
const HIT_X_PCT = 28.5;
const HIT_X = HIT_X_PCT / 100;
const hitXW = (w) => w * (1 - 2 * HIT_X); // 内缩后的有效碰撞宽

const CSS = `
.fish-root{position:fixed;z-index:30;pointer-events:none;user-select:none}
.fish-inner{position:relative;width:var(--fish-w,200px);height:calc(var(--fish-w,200px)*9/16);transform-origin:50% 100%}
.fish-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;filter:url(#fish-alpha-fix)}
.fish-video.fish-front{opacity:1}
.fish-hit{position:absolute;top:0;bottom:0;left:${HIT_X_PCT}%;right:${HIT_X_PCT}%;pointer-events:auto;cursor:grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}
.fish-hit.fish-drag{cursor:grabbing}
.fish-hit.fish-armed{cursor:crosshair}
.fish-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:10px;padding:6px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .25s ease;color:var(--v2-text-text-base,#e8e8e8);background:color-mix(in srgb,var(--v2-background-bg-layer-02,#2c2c2c) 94%,transparent);box-shadow:0 2px 10px rgb(0 0 0 / .25)}
.fish-bubble.fish-show{opacity:1}
.fish-menu{position:fixed;z-index:40;min-width:132px;padding:4px;border-radius:10px;pointer-events:auto;font-size:13px;background:var(--v2-background-bg-layer-02,#2c2c2c);box-shadow:0 8px 28px rgb(0 0 0 / .35)}
.fish-menu button{display:block;width:100%;padding:7px 12px;border:0;border-radius:7px;background:none;color:var(--v2-text-text-base,#e8e8e8);text-align:left;cursor:pointer;font:inherit}
.fish-menu button:hover{background:var(--v2-background-bg-layer-03,#3c3c3c)}
.fish-menu-row{padding:6px 12px;color:var(--v2-text-text-muted,#9a9a9a);font-size:12px;line-height:1.4;white-space:pre-wrap;word-break:break-all}
.fish-menu-row .due{opacity:.8;margin-left:6px}
.fish-chat{display:flex;flex-direction:column;height:100%;min-height:0}
.fish-chat-list{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px}
.fish-row{max-width:86%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.fish-row-fish{align-self:flex-start;background:var(--v2-background-bg-layer-02,#2c2c2c);color:var(--v2-text-text-base,#e8e8e8)}
.fish-row-user{align-self:flex-end;background:var(--v2-action-bg-base,#3d5a80);color:var(--v2-action-text-base,#fff)}
.fish-row-pending{align-self:flex-start;background:var(--v2-background-bg-layer-02,#2c2c2c);color:var(--v2-text-text-muted,#9a9a9a);font-size:12px}
.fish-row-pending .d{display:inline-block;animation:fishdot 1.2s infinite}
.fish-row-pending .d:nth-child(2){animation-delay:.2s}
.fish-row-pending .d:nth-child(3){animation-delay:.4s}
@keyframes fishdot{0%,60%,100%{opacity:.15}30%{opacity:1}}
.fish-chat-composer{display:flex;gap:8px;padding:10px;border-top:1px solid var(--v2-background-bg-layer-03,#3c3c3c)}
.fish-chat-composer input{flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--v2-background-bg-layer-03,#555);background:var(--v2-background-bg-layer-01,#222);color:var(--v2-text-text-base,#e8e8e8);font:inherit;font-size:13px}
.fish-chat-composer input:focus{outline:none;border-color:var(--v2-action-bg-base,#3d5a80)}
.fish-chat-composer button{padding:8px 14px;border:0;border-radius:8px;background:var(--v2-action-bg-base,#3d5a80);color:var(--v2-action-text-base,#fff);cursor:pointer;font:inherit;font-size:13px}
.fish-chat-empty{align-self:center;margin:auto;color:var(--v2-text-text-muted,#888);font-size:12px}
@media (prefers-reduced-motion:reduce){.fish-row-pending .d{animation:none}}
:root[data-motion="reduce"] .fish-row-pending .d{animation:none}
`;

// ---------- i18n：独立语言开关（prefs.lang，zh 默认）；加语言=注册进 LANGS + STR/L10N 各加一块 ----------
const LANGS = ["zh", "en", "ja"];
const LANG_NAMES = { zh: "中文", en: "English", ja: "日本語" };
const STR = {
  zh: {
    status: { thinking: "在忙…", working: "干活中…", result: "整理中…", waiting: "等着你…", success: "搞定啦！", error: "呜…出错了" },
    sleepRefusals: ["我在睡觉，别烦我……", "唔……让我再睡一会儿。", "呼……呼……（装作没听见）"],
    menu: {
      sleep: "睡觉", wake: "起来", addAnother: "再来一只", dismiss: "收起这只", randomMove: "换个动作",
      chat: "开聊", todo: "记一笔待办", balance: "查余额", murmur: "碎碎念一句", nameFish: "起个名字",
      resetBrain: "重置鱼脑", notifyOn: "开完成通知", notifyOff: "关完成通知",
      whisperOn: "开碎碎念", whisperOff: "关碎碎念",
      bigger: "大一点", smaller: "小一点", home: "回原位", lang: "语言", todoList: "待办列表", back: "返回",
    },
    bubbles: {
      chatFallback: "聊天面板在会话侧栏里～", resetDone: "脑清空啦，下次开口重新开始～", resetFailed: "没清成…（稍后再试试）",
      notifyOn: "好，我盯着～", notifyOff: "好，不吵你～",
      sendFailed: "发送失败了…（右键鱼「重置鱼脑」再试）", notReady: "面板还没就绪，稍等一下…",
      replyError: "模型出岔子了…（右键「重置鱼脑」或在会话里换模型）", replyErrorShort: "模型出岔子了…",
      balanceNoKey: "还没给我配余额钥匙～", balanceInvalid: "余额钥匙失效了…（重新配一下？）", balanceFailed: "余额没查到…（网络或上游出岔子）", whisperOn: "好，我会偶尔唠叨～", whisperOff: "好，安静待着～", nameSet: (n) => `以后就叫「${n}」啦～`, nameFailed: "名字没存上…（再试一次？）", maxFish: "最多六只啦！",
      todoDone: "记下啦：", todoCleared: "待办清空啦～", actionFailed: "没存上…（稍后再试试）", langSwitched: "好，说中文～",
    },
    panel: {
      placeholder: "跟鱼说点什么…", send: "发送", emptyNever: "还没开过口～右键鱼「开聊」或直接发消息",
      emptyBlank: "（空空如也）", pending: "🐟 正在琢磨 ", genFailed: "生成失败",
    },
    notify: { success: "搞定啦", error: "出错了" },
    balanceLabels: ["满溢", "叮当", "如常", "皱眉", "告急", "空了"],
    balanceReport: (n) => `DeepSeek 剩 ${n} 元`, balanceCustom: (name, n) => `${name} 剩 ${n}`,
    customName: "自定义", withLabel: (r, l) => `${r}（${l}）`,
    todo: { title: "记一笔待办", placeholder: "要记的事…（可加 @2026-11-20 15:00 / @2h）", clear: "清空待办", empty: "还没有待办～" },
  },
  en: {
    status: { thinking: "Busy…", working: "Working…", result: "Wrapping up…", waiting: "Waiting…", success: "Done!", error: "Oops…" },
    sleepRefusals: ["Zzz… don't bug me…", "Mmm… five more minutes…", "Snore… snore… (pretending not to hear)"],
    menu: {
      sleep: "Sleep", wake: "Wake up", addAnother: "One more fish", dismiss: "Put this one away", randomMove: "Another move",
      chat: "Let's chat", todo: "Add a to-do", balance: "Check balance", murmur: "Say something", nameFish: "Name the fish",
      resetBrain: "Reset brain", notifyOn: "Turn notifications on", notifyOff: "Turn notifications off",
      whisperOn: "Turn muttering on", whisperOff: "Turn muttering off",
      bigger: "Bigger", smaller: "Smaller", home: "Back to spot", lang: "Language", todoList: "To-do list", back: "Back",
    },
    bubbles: {
      chatFallback: "The chat panel lives in the session sidebar~", resetDone: "Brain wiped — fresh start next time~", resetFailed: "Couldn't reset… (try again in a bit)",
      notifyOn: "Okay, I'll keep watch~", notifyOff: "Okay, I'll stay quiet~",
      sendFailed: "Couldn't send… (right-click → Reset brain and retry)", notReady: "Panel not ready yet, one sec…",
      replyError: "Model hiccup… (right-click → Reset brain, or switch model in the session)", replyErrorShort: "Model hiccup…",
      balanceNoKey: "No balance key configured yet~", balanceInvalid: "The balance key stopped working… (reconfigure it?)", balanceFailed: "Couldn't check the balance… (network or upstream hiccup)", whisperOn: "Okay, I'll chatter now and then~", whisperOff: "Okay, staying quiet~", nameSet: (n) => `"${n}" it is~`, nameFailed: "Couldn't save the name… (try again?)", maxFish: "Six fish max!",
      todoDone: "Noted: ", todoCleared: "To-dos cleared~", actionFailed: "Didn't go through… (try again in a bit)", langSwitched: "Okay, English it is~",
    },
    panel: {
      placeholder: "Say something to the fish…", send: "Send", emptyNever: "Haven't spoken yet~ right-click the fish → Let's chat, or just type",
      emptyBlank: "(nothing yet)", pending: "🐟 Thinking ", genFailed: "Generation failed",
    },
    notify: { success: "Done!", error: "Oops…" },
    balanceLabels: ["Full", "Jingling", "Fine", "Frowning", "Low", "Empty"],
    balanceReport: (n) => `DeepSeek ¥${n} left`, balanceCustom: (name, n) => `${name}: ${n} left`,
    customName: "custom", withLabel: (r, l) => `${r} (${l})`,
    todo: { title: "Add a to-do", placeholder: "What to remember… (optional @2026-11-20 15:00 / @2h)", clear: "Clear to-dos", empty: "Nothing on the list yet~" },
  },
  ja: {
    status: { thinking: "考え中…", working: "お仕事中…", result: "まとめ中…", waiting: "待ってるよ…", success: "できた！", error: "うう…エラー" },
    sleepRefusals: ["睡眠中なの…起こさないで…", "んー…あと5分…", "くー…くー…（聞こえてないふり）"],
    menu: {
      sleep: "寝る", wake: "起きる", addAnother: "もう一匹", dismiss: "この子をしまう", randomMove: "別の動き",
      chat: "おしゃべり", todo: "todoを追加", balance: "残高チェック", murmur: "ひとこと", nameFish: "名前をつける",
      resetBrain: "脳をリセット", notifyOn: "通知をつける", notifyOff: "通知をけす",
      whisperOn: "ひとことオン", whisperOff: "ひとことオフ",
      bigger: "大きく", smaller: "小さく", home: "元の場所へ", lang: "言語", todoList: "todoリスト", back: "戻る",
    },
    bubbles: {
      chatFallback: "チャットパネルはセッションのサイドバーにあるよ〜", resetDone: "脳を空にしたよ〜次は最初から〜", resetFailed: "リセットできなかった…（また後で）",
      notifyOn: "うん、見てるよ〜", notifyOff: "うん、静かにするね〜",
      sendFailed: "送信できなかった…（右クリック→脳をリセットしてもう一回）", notReady: "パネルの準備中…ちょっと待ってね…",
      replyError: "モデルがミスしたみたい…（右クリック→脳をリセット、またはセッションでモデル変更）", replyErrorShort: "モデルがミスしたみたい…",
      balanceNoKey: "残高の鍵がまだ設定されてないよ〜", balanceInvalid: "残高の鍵が使えなくなってる…（設定し直す？）", balanceFailed: "残高を確認できなかった…（ネットワークか上流の問題）", whisperOn: "うん、たまに喋るね〜", whisperOff: "うん、静かにしてるね〜", nameSet: (n) => `「${n}」だね〜`, nameFailed: "名前を保存できなかった…（もう一度？）", maxFish: "最大6匹だよ！",
      todoDone: "メモした：", todoCleared: "todoを空にしたよ〜", actionFailed: "保存できなかった…（また後で）", langSwitched: "うん、日本語で〜",
    },
    panel: {
      placeholder: "魚にお話しかけてみて…", send: "送信", emptyNever: "まだお話ししてないよ〜魚を右クリック→おしゃべり、またはそのまま入力してね",
      emptyBlank: "（まだ何もない）", pending: "🐟 考えちゅう ", genFailed: "生成に失敗",
    },
    notify: { success: "できた！", error: "エラー" },
    balanceLabels: ["満杯", "チャリン", "いつも", "心配", "やばい", "空っぽ"],
    balanceReport: (n) => `DeepSeek 残り ¥${n}`, balanceCustom: (name, n) => `${name}: 残り ${n}`,
    customName: "カスタム", withLabel: (r, l) => `${r}（${l}）`,
    todo: { title: "todoを追加", placeholder: "覚えておくこと…（@2026-11-20 15:00 / @2h 可）", clear: "todoを全消し", empty: "todoはまだないよ〜" },
  },
};
// 动画池（gen-assets.py 从 pools.json 注入 head.js；加减动画只改配置文件）
const workClip = (t) => POOLS.work[({ thinking: 0, working: 1, result: 2, waiting: 3, success: 4, error: 5 }[t] ?? 0)];
const WHISPER_MARK = "[[fish-whisper]]";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pick = (pool) => pool[Math.floor(Math.random() * pool.length)];
const reduced = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches ||
  document.documentElement.dataset.motion === "reduce";
const textOf = (m) => {
  if (!m) return "";
  if (m.type === "assistant") return (m.content ?? []).filter((p) => p && p.type === "text").map((p) => p.text).join("");
  return typeof m.text === "string" ? m.text : "";
};


// 窗口用到的 server 契约（对应 rpc.ts：id+events 定订阅 type，methods 定调用名）
const FishStateDef = {
  id: "fish-pet",
  methods: {
    state: { input: { type: "object", additionalProperties: false } },
    focus: { input: { type: "object", additionalProperties: false } },
    whisper: { input: { type: "object", additionalProperties: false } },
    say: { input: { type: "object", additionalProperties: false } },
    name: { input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } },
    todoAdd: { input: { type: "object", additionalProperties: false } },
    todoClear: { input: { type: "object", additionalProperties: false } },
    weather: { input: { type: "object", additionalProperties: false } },
    balance: { input: { type: "object", properties: { force: { type: "boolean" } }, required: ["force"], additionalProperties: false } },
    language: { input: { type: "object", properties: { lang: { enum: ["zh", "en", "ja"] } }, required: ["lang"], additionalProperties: false } },
    settings: { input: { type: "object", additionalProperties: false } },
    resetBrain: { input: { type: "object", additionalProperties: false } },
  },
  events: { state: { schema: { type: "object" } } },
};

function ensureAlphaFix() {
  if (document.getElementById("fish-alpha-fix")) return null;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  const filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
  filter.id = "fish-alpha-fix";
  const transfer = document.createElementNS("http://www.w3.org/2000/svg", "feComponentTransfer");
  const funcA = document.createElementNS("http://www.w3.org/2000/svg", "feFuncA");
  funcA.setAttribute("type", "linear");
  funcA.setAttribute("slope", String(255 / 254));
  funcA.setAttribute("intercept", String(-1 / 255));
  transfer.appendChild(funcA);
  filter.appendChild(transfer);
  svg.appendChild(filter);
  document.body.appendChild(svg);
  return svg;
}

let clickAudio = undefined;
const playClickSound = () => {
  try {
    clickAudio ??= new Audio(CLICK_SOUND);
    clickAudio.currentTime = 0;
    void clickAudio.play().catch(() => {});
  } catch {
    /* 无自动播放权限时静默 */
  }
};

const buildPrefs = () => {
  const INITIAL = { width: 200, positions: [], todos: [], sessionID: undefined, notify: false, whisper: false, lang: "en" };
  if (!Schema || !Store) return { decl: {}, shim: { ...INITIAL, INITIAL } };
  try {
    const Prefs = Schema.Struct({
      width: Schema.Number,
      positions: Schema.Array(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
      todos: Schema.Array(Schema.Struct({ text: Schema.String })),
      sessionID: Schema.optional(Schema.String),
      notify: Schema.optional(Schema.Boolean),
      whisper: Schema.optional(Schema.Boolean),
      lang: Schema.optional(Schema.String),
      // 一次性迁移标记：本地共享偏好（whisper/notify/width）已上推 server settings 权威
      settingsMigrated: Schema.optional(Schema.Boolean),
      whisperLease: Schema.optional(Schema.Struct({ holder: Schema.String, until: Schema.Number })),
    });
    return { decl: { prefs: Store.global(Prefs, INITIAL) }, shim: null };
  } catch {
    return { decl: {}, shim: { ...INITIAL, INITIAL } };
  }
};

module.exports.default = Plugin.define((() => {
  const { decl, shim } = buildPrefs();
  return {
    ...(Object.keys(decl).length ? { stores: decl } : {}),
    setup(ctx) {
      document.querySelectorAll("[data-fish-pet]").forEach((node) => node.remove());
      ctx.add(Style, CSS);
      const alphaSvg = ensureAlphaFix();

      // ---------- 持久化（声明式 store 优先，回落内存） ----------
      const memory = shim ? { ...shim } : null;
      const prefs = shim
        ? {
            get value() {
              return memory;
            },
            update(fn) {
              fn(memory);
            },
          }
        : {
            get value() {
              return ctx.stores.prefs.value;
            },
            update(fn) {
              ctx.stores.prefs.update(fn);
            },
          };

      // ---------- 语言（独立开关，prefs.lang；切换后经 focus 心跳同步给 server）----------
      const lang = () => (LANGS.includes(prefs.value.lang) ? prefs.value.lang : "en");
      const T = () => STR[lang()];

      const shared = {
        dead: false,
        work: null,
        flash: null,
        lastActivity: 0,
        timers: [],
      };
      const fishes = [];
      const later = (fn, ms) => {
        const t = setTimeout(fn, ms);
        shared.timers.push(t);
        return t;
      };
      const every = (fn, ms) => {
        const t = setInterval(fn, ms);
        shared.timers.push(t);
        return t;
      };

      const awakeFishes = () => fishes.filter((w) => !w.f.state.sleeping);
      // 视觉接管闸门：睡着 / 手势中 / 飞行行走 / 回复保护期，低优先级一律不换片
      const fishFree = (f) => !!f && !f.state.sleeping && !f.state.dragging && !f.state.busy && !f.state.replyHold;
      const leadFish = () => {
        const pool = awakeFishes().length ? awakeFishes() : fishes;
        return pool.length ? pick(pool).f : undefined;
      };

      // ---------- 工具：气泡带主鱼选择 ----------
      const bubbleOn = (text, ms) => {
        const f = leadFish();
        f?.bubble(text, ms);
      };

      // =========================================================
      // 单只鱼的引擎（v1 逻辑工厂化 + 点击池/弹弓/互撞/拒绝台词）
      // =========================================================
      function createFish(index, saved) {
        const root = document.createElement("div");
        root.className = "fish-root";
        root.dataset.fishPet = "1";
        const inner = document.createElement("div");
        inner.className = "fish-inner";
        const videoA = document.createElement("video");
        const videoB = document.createElement("video");
        for (const v of [videoA, videoB]) {
          v.className = "fish-video";
          v.muted = true;
          v.playsInline = true;
          v.preload = "auto";
        }
        const hit = document.createElement("div");
        hit.className = "fish-hit";
        const bubbleEl = document.createElement("div");
        bubbleEl.className = "fish-bubble";
        inner.append(videoA, videoB, hit, bubbleEl);
        root.appendChild(inner);

        const videos = [videoA, videoB];
        const stageW = () => inner.offsetWidth || 200;
        const stageH = () => inner.offsetHeight || 112;
        // 水平边界（x 仍为画布左缘）：碰撞框 = 画布内缩 HIT_X（x+w*HIT_X → x+w*(1-HIT_X)），距窗口左右各 m px
        // xMax 不低于 xMin（极窄窗口两界合一贴左墙）：行走/抛墙/nudge 同一语义不倒挂，resize 无需单独兜底
        const xMin = (m) => m - stageW() * HIT_X;
        const xMax = (m) => Math.max(xMin(m), window.innerWidth - m - stageW() * (1 - HIT_X));
        const state = {
          gen: 0,
          front: 0,
          current: null,
          x: saved?.x ?? window.innerWidth - (prefs.value.width + 24) - index * 24,
          y: saved?.y ?? 84 + index * 30,
          facing: "right",
          sleeping: false,
          dragging: false,
          busy: false,
          armed: false,
          raf: 0,
          rollTimer: 0,
          bubbleTimer: 0,
          disarmTimer: 0,
          replyHold: false, // 真实回复（碎碎念/聊天完成）一次性片播放中：低优先级不抢
          replyTimer: 0, // ended 丢失兜底（隐藏页/媒体异常时不留永久锁）
          replyPending: null, // 有界暂存位（拖动中到达 / B 在 A 播放期间到达；聊天优先）
        };

        const applyFacing = () => {
          // 只翻视频：气泡/命中区不随游向镜像（否则气泡文字左右反）
          const t = state.facing === "left" ? "scaleX(-1)" : "";
          videoA.style.transform = t;
          videoB.style.transform = t;
        };
        const setPos = (x, y) => {
          state.x = x;
          state.y = y;
          root.style.left = x + "px";
          root.style.top = y + "px";
        };
        setSizeAll(prefs.value.width);
        function setSizeAll(w) {
          root.style.setProperty("--fish-w", w + "px");
        }
        setPos(state.x, state.y);

        function playClip(name, opts = {}) {
          state.gen++;
          applyFacing(); // 走路的左向素材可能覆写过镜像；新片段开播前回到朝向基线
          const myGen = state.gen;
          const back = videos[state.front ^ 1];
          back.loop = !!opts.loop;
          back.src = ASSETS[name];
          state.current = name;
          let swapped = false;
          const swap = () => {
            if (myGen !== state.gen || swapped) return;
            swapped = true;
            back.classList.add("fish-front");
            videos[state.front].classList.remove("fish-front");
            state.front ^= 1;
            const front = videos[state.front];
            state.videoEl = front; // 回复兜底体检读取 paused/ended 用（ended 监听同一元素）
            if (!document.hidden) front.play().catch(() => {});
            if (!opts.loop && opts.onEnded) {
              front.addEventListener("ended", () => {
                if (myGen === state.gen) opts.onEnded();
              }, { once: true });
            }
          };
          back.addEventListener("canplay", swap, { once: true });
          setTimeout(swap, 900);
        }
        const frontVideo = () => videos[state.front];
        const toIdle = () => playClip(POOLS.names.idle, { loop: true });

        const squash = () => {
          inner.style.transform = "scale(1.12,0.88)";
          setTimeout(() => {
            inner.style.transform = "";
          }, 150);
        };

        const bubble = (text, ms) => {
          bubbleEl.textContent = text;
          bubbleEl.classList.add("fish-show");
          clearTimeout(state.bubbleTimer);
          if (ms) state.bubbleTimer = setTimeout(() => bubbleEl.classList.remove("fish-show"), ms);
        };
        const hideBubble = () => {
          clearTimeout(state.bubbleTimer);
          bubbleEl.classList.remove("fish-show");
        };

        function scheduleRoll(delay) {
          clearTimeout(state.rollTimer);
          state.rollTimer = setTimeout(rollNext, delay ?? 7000 + Math.random() * 8000);
        }
        function rollNext() {
          if (shared.dead) return;
          if (state.sleeping) return; // 睡觉：链由 wake() 重排，这里不续
          if (state.replyHold) return scheduleRoll(4000); // 真实回复播放中：随机动作不抢，短续
          if (state.dragging || state.busy) return scheduleRoll(4000); // 交互中：短续
          if (shared.work || shared.flash) return scheduleRoll(15000); // 工作期：慢续，链不能死
          if (document.hidden || reduced()) return scheduleRoll(30000);
          const W = POOLS.weights;
          const roll = Math.random() * 100;
          if (roll < W.idle) return scheduleRoll();
          if (roll < W.idle + W.turn) {
            state.facing = state.facing === "right" ? "left" : "right";
            applyFacing();
            playClip(POOLS.names.turn, { onEnded: toIdle });
            return scheduleRoll();
          }
          if (roll < W.idle + W.turn + W.move) return walkStep();
          // 分类池按权重抽；带文字的池（noMirror）在被镜像（朝左）时不播
          const cats = POOLS.categories.filter((c) => !(c.noMirror && state.facing === "left"));
          const total = cats.reduce((s, c) => s + c.weight, 0);
          let r = Math.random() * total;
          for (const c of cats) {
            r -= c.weight;
            if (r <= 0) {
              playClip(pick(c.actions), { onEnded: toIdle });
              break;
            }
          }
          scheduleRoll();
        }

        function walkStep() {
          const x0 = state.x;
          const dir = Math.random() < 0.5 ? -1 : 1;
          const x1 = clamp(x0 + dir * (80 + Math.random() * 200), xMin(16), xMax(16));
          if (Math.abs(x1 - x0) < 40) {
            toIdle();
            return scheduleRoll();
          }
          state.busy = true;
          // 朝向跟随移动方向；显示方向 = 素材固有方向 XOR 镜像
          state.facing = dir < 0 ? "left" : "right";
          applyFacing();
          const move = pick(POOLS.moves);
          const clipLeft = !!move && typeof move === "object" && move.left;
          playClip(typeof move === "string" ? move : move.name, {});
          if (clipLeft) {
            const t = dir > 0 ? "scaleX(-1)" : ""; // 左向素材：向右走时镜像翻成向右，向左走时正好原样
            videoA.style.transform = t;
            videoB.style.transform = t;
          }
          const walkGen = state.gen;
          const LEAD = 1.8;
          const TAIL = 2.2;
          const finish = () => {
            cancelAnimationFrame(state.raf);
            state.raf = 0;
            if (state.gen !== walkGen) {
              state.busy = false; // 被打断：归还 busy，打断方负责后续画面
              return;
            }
            setPos(x1, state.y);
            state.busy = false;
            toIdle();
            scheduleRoll();
          };
          const tick = () => {
            if (state.gen !== walkGen) return;
            const v = frontVideo();
            const t = v.currentTime || 0;
            const span = Math.max(0.5, (v.duration || 10) - LEAD - TAIL);
            const p = clamp((t - LEAD) / span, 0, 1);
            setPos(x0 + (x1 - x0) * p, state.y);
            state.raf = requestAnimationFrame(tick);
          };
          state.raf = requestAnimationFrame(tick);
          frontVideo().addEventListener("ended", finish, { once: true });
          setTimeout(finish, 13000);
        }

        // ---------- 甩抛（含互撞）与弹弓 ----------
        function throwFish(vx, vy, slung) {
          state.busy = true;
          const g = 1600;
          const rest = 0.72;
          let x = state.x;
          let y = state.y;
          let last = performance.now();
          const step = (now) => {
            if (shared.dead) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            vy += g * dt;
            x += vx * dt;
            y += vy * dt;
            if (x < xMin(8)) {
              x = xMin(8);
              vx = Math.abs(vx) * rest;
            }
            if (x > xMax(8)) {
              x = xMax(8);
              vx = -Math.abs(vx) * rest;
            }
            if (y < 8) {
              y = 8;
              vy = Math.abs(vy) * rest * 0.5;
            }
            // 互撞：撞到别的鱼，自己反弹，对方被推开一段
            const w = stageW(); // 自宽缓存：帧内不变，中心/反弹方向同用
            for (const other of fishes) {
              if (other.f === api) continue;
              const ox = other.f.state.x;
              const oy = other.f.state.y;
              const ow = other.f.state.stageW();
              // 有符号中心差 dx：overlapX 与水平反弹/推开同一几何（两鱼宽度可不同，不再用画布左缘判向）
              const dx = x + w / 2 - (ox + ow / 2);
              const overlapX = Math.abs(dx) < (hitXW(w) + hitXW(ow)) / 2;
              const overlapY = Math.abs(y - oy) < (stageH() + 80) / 2;
              if (overlapX && overlapY) {
                if (Math.abs(vx) > Math.abs(vy)) {
                  vx = (dx < 0 ? -1 : 1) * Math.abs(vx) * rest;
                  other.f.nudge(dx < 0 ? 14 : -14, 0);
                } else {
                  vy = (y < oy ? -0.4 : 1) * Math.abs(vy) * rest;
                  other.f.nudge(0, y < oy ? -10 : 10);
                }
              }
            }
            const floor = window.innerHeight - stageH() - 8;
            if (y >= floor) {
              y = floor;
              if (Math.abs(vy) > 240) {
                vy = -Math.abs(vy) * rest;
              } else {
                vy = 0;
                vx *= 0.86;
                if (Math.abs(vx) < 24) {
                  state.raf = 0;
                  return land(slung);
                }
              }
            }
            setPos(x, y);
            state.raf = requestAnimationFrame(step);
          };
          state.raf = requestAnimationFrame(step);
        }
        const nudge = (dx, dy) => {
          setPos(clamp(state.x + dx, xMin(8), xMax(8)), clamp(state.y + dy, 8, window.innerHeight - stageH() - 8));
        };
        function land() {
          squash();
          state.busy = false;
          if (state.replyHold) return scheduleRoll(); // 飞行/行走中已开播的回复播完为止：落地不抢，暂存由其 ended 兑现
          if (state.replyPending) {
            // 拖动/飞行期间暂存的真实回复：落地即播，优先于回 idle
            const p = state.replyPending;
            state.replyPending = null;
            playReplyOn(api, p.clip, p.text);
            scheduleRoll();
            return;
          }
          if (!state.sleeping && !shared.work && !shared.flash) toIdle();
          scheduleRoll();
        }

        function disarm() {
          state.armed = false;
          hit.classList.remove("fish-armed");
        }

        hit.addEventListener("pointerdown", (e) => {
          if (e.button === 2) return;
          try { hit.setPointerCapture(e.pointerId); } catch { return; } // capture 失败：状态尚未置位，不进手势，也不打断正在播的回复
          clearReplyHold(api); // 用户手势优先：解除回复保护并清空暂存（回复正文仍在 Fish 面板里）
          state.replyPending = null;
          state.dragging = true;
          state.gen++;
          cancelAnimationFrame(state.raf);
          clearTimeout(state.rollTimer);
          hit.classList.add("fish-drag");
          if (state.sleeping && state.armed) {
            // 弹弓不叫醒，只是拉开
          } else if (!state.sleeping && state.current !== POOLS.names.drag) {
            playClip(POOLS.names.drag, { loop: true });
          }
          const start = { px: e.clientX, py: e.clientY, x: state.x, y: state.y, t: performance.now() };
          const samples = [];
          const move = (ev) => {
            if (state.armed) {
              // 弹弓：鱼不动，拉出瞄准偏移
              // 弹弓：鱼不动，拉出瞄准偏移（朝向翻转在视频层，inner 只管拉伸）
              const dx = ev.clientX - start.px;
              const dy = ev.clientY - start.py;
              inner.style.transform = `translate(${clamp(dx, -80, 80) * 0.15}px, ${clamp(dy, -60, 60) * 0.15}px) scale(.96)`;
              samples.push({ dx, dy });
              return;
            }
            setPos(start.x + (ev.clientX - start.px), start.y + (ev.clientY - start.py));
            samples.push({ t: performance.now(), x: ev.clientX, y: ev.clientY });
            if (samples.length > 6) samples.shift();
          };
          const up = (ev) => {
            hit.removeEventListener("pointermove", move);
            hit.removeEventListener("pointercancel", cancel); // 本手势已终态：摘掉未触发的 cancel，防迟到触发旧闭包
            state.dragging = false;
            hit.classList.remove("fish-drag");
            const dx = ev.clientX - start.px;
            const dy = ev.clientY - start.py;
            if (state.armed) {
              disarm();
              inner.style.transform = ""; // 瞄准偏移还原（朝向翻转在视频层，不受影响）
              const pull = samples[samples.length - 1] ?? { dx, dy };
              const dist = Math.hypot(pull.dx, pull.dy);
              if (dist < 12) return clickPoke();
              if (reduced()) return land();
              playClip(POOLS.names.clickHappy, {});
              throwFish(-(pull.dx / Math.max(dist, 1)) * clamp(dist * 14, 300, 2400), -(pull.dy / Math.max(dist, 1)) * clamp(dist * 14, 300, 2400), true);
              return;
            }
            if (Math.hypot(dx, dy) < 6 && performance.now() - start.t < 300) {
              if (state.sleeping) return wake();
              return clickPoke();
            }
            const s1 = samples[0];
            const s2 = samples[samples.length - 1];
            let vx = 0;
            let vy = 0;
            if (s2 && s1 && s2.t > s1.t) {
              vx = ((s2.x - s1.x) / (s2.t - s1.t)) * 1000;
              vy = ((s2.y - s1.y) / (s2.t - s1.t)) * 1000;
            }
            if (reduced() || (Math.abs(vx) < 90 && Math.abs(vy) < 90)) return land();
            throwFish(vx, vy, false);
          };
          // pointercancel 独立收尾：不走释放（无 click poke、无惯性/弹弓抛出）；
          // armed 安全复位，摘掉本手势监听（含未触发的 once up），恢复状态链。
          // 本手势的 pointerdown 已 cancelAnimationFrame 掐断飞行/行走循环（throwFish/walkStep 置位的
          // busy 遗留给打断方，同 walkStep.finish 的约定）：cancel 不走 land，须显式归还 busy 并归零句柄，
          // 否则 rollNext 永远 4s 短续、工作/状态动画被旧 busy 抑制
          const cancel = () => {
            hit.removeEventListener("pointermove", move);
            hit.removeEventListener("pointerup", up);
            state.dragging = false;
            state.busy = false; // 飞行/行走中抓住后取消：归还打断的 busy
            state.raf = 0; // raf 已在 pointerdown 取消，归零防悬空（与 land()/walkStep.finish 同款）
            hit.classList.remove("fish-drag");
            if (state.armed) {
              clearTimeout(state.disarmTimer);
              disarm();
              inner.style.transform = ""; // 瞄准偏移还原（与正常 armed 释放同款）
            }
            if (state.replyPending) {
              // 手势期间到达的真实回复：取消路径同样兑现，避免暂存悬挂到下一次交互
              const p = state.replyPending;
              state.replyPending = null;
              playReplyOn(api, p.clip, p.text);
            } else if (!state.sleeping && !shared.work && !shared.flash) toIdle();
            scheduleRoll();
          };
          hit.addEventListener("pointermove", move);
          hit.addEventListener("pointerup", up, { once: true });
          hit.addEventListener("pointercancel", cancel, { once: true });
        });

        hit.addEventListener("dblclick", () => {
          if (state.sleeping) return;
          state.armed = true;
          hit.classList.add("fish-armed");
          squash();
          clearTimeout(state.disarmTimer);
          state.disarmTimer = setTimeout(disarm, 6000);
        });

        function clickPoke() {
          squash();
          playClickSound();
          if (state.sleeping) return;
          if (state.replyPending) {
            // 拖动/按压窗口内到达的真实回复：优先于点击装饰动画
            const p = state.replyPending;
            state.replyPending = null;
            playReplyOn(api, p.clip, p.text);
            scheduleRoll();
            return;
          }
          playClip(pick(POOLS.clicks), { onEnded: toIdle });
          scheduleRoll();
        }

        // ---------- 睡觉 ----------
        function goSleep() {
          clearReplyHold(api); // 用户操作：解除回复保护并清空暂存
          state.replyPending = null;
          state.sleeping = true;
          hideBubble();
          playClip(POOLS.sleep[0], { onEnded: () => playClip(POOLS.sleep[1], { loop: true }) });
        }
        function wake() {
          if (!state.sleeping) return;
          state.sleeping = false;
          playClip(POOLS.sleep[2], { onEnded: toIdle });
          scheduleRoll();
        }

        // ---------- 右键菜单 ----------
        const onMenuAway = (e) => {
          if (menu && !menu.contains(e.target)) closeMenu();
        };
        const onMenuKey = (e) => {
          if (e.key === "Escape") closeMenu();
        };
        let menu = null;
        function closeMenu() {
          menu?.remove();
          menu = null;
          document.removeEventListener("pointerdown", onMenuAway, true);
          document.removeEventListener("keydown", onMenuKey, true);
        }
        hit.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          closeMenu();
          menu = document.createElement("div");
          menu.className = "fish-menu";
          const item = (label, fn, keep = false) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.addEventListener("click", () => {
              if (!keep) closeMenu();
              fn();
            });
            menu.appendChild(b);
            return b;
          };
          const buildMain = () => {
          item(state.sleeping ? T().menu.wake : T().menu.sleep, () => (state.sleeping ? wake() : goSleep()));
          item(T().menu.addAnother, () => {
            const fish = addFish();
            if (!fish) return; // 已达 6 只：addFish 已弹 maxFish 气泡
            // 启动鱼由 setup 末尾的挂载循环统一 append；菜单新增的这只就地挂载，否则永不可见
            (fallback ? document.body : fishesHost).appendChild(fish.f.root);
            savePositions();
          });
          if (fishes.length > 1) item(T().menu.dismiss, () => removeFish(api));
          item(T().menu.randomMove, () => {
            if (state.sleeping) return;
            clearReplyHold(api); // 用户显式点播随机动作：真实打断回复片即解除保护
            state.replyPending = null;
            // 与 rollNext 同规则：noMirror 分类（文字池）朝左时不抽，避免文字被镜像
            const cats = POOLS.categories.filter((c) => !(c.noMirror && state.facing === "left"));
            const names = [...cats.flatMap((c) => c.actions), ...POOLS.clicks, ...POOLS.moves.map((m) => (typeof m === "string" ? m : m.name))];
            playClip(pick(names), { onEnded: toIdle });
            scheduleRoll();
          });
          item(T().menu.chat, () => {
            reportFocus();
            try {
              ctx.layout.open?.(`${ctx.id}:chat`, ctx.sessions.current?.());
            } catch {
              bubbleOn(T().bubbles.chatFallback);
            }
          });
          item(T().menu.todo, () => void addTodo());
          item(T().menu.todoList, buildTodoPage, true);
          item(T().menu.balance, () => void runBalance(true));
          item(T().menu.murmur, () => void whisper({ dream: state.sleeping }));
          item(T().menu.nameFish, () => void nameFish());
          item(T().menu.resetBrain, () => {
            // 重置鱼脑：RPC 真成功才报"清空"，失败给三语明确提示，不无条件道贺
            void (async () => {
              try {
                const s = await fishRpc?.resetBrain?.({});
                bubbleOn(s ? T().bubbles.resetDone : T().bubbles.resetFailed, s ? 3500 : 4000);
              } catch {
                bubbleOn(T().bubbles.resetFailed, 4000);
              }
            })();
          });
          // 通知/碎碎念/大小：server settings 权威；气泡只在真实回包（新 server 状态或旧 server 本地回退）后显示
          const settingsOrLocal = (call, fallback, onRealSuccess) => {
            if (call && typeof call.then === "function") {
              void call.then(
                (s) => {
                  if (s && typeof s.whisper === "boolean") {
                    applyState(s);
                    if (onRealSuccess) onRealSuccess();
                  } else fallback();
                },
                () => fallback(),
              );
            } else fallback();
          };
          item(prefs.value.notify ? T().menu.notifyOff : T().menu.notifyOn, () => {
            const next = !prefs.value.notify;
            settingsOrLocal(
              fishRpc?.settings?.({ notify: next }),
              () => {
                prefs.update((d) => {
                  d.notify = next;
                });
                bubbleOn(next ? T().bubbles.notifyOn : T().bubbles.notifyOff);
              },
              () => bubbleOn(next ? T().bubbles.notifyOn : T().bubbles.notifyOff),
            );
          });
          item(prefs.value.whisper === false ? T().menu.whisperOn : T().menu.whisperOff, () => {
            const next = prefs.value.whisper === false; // 当前关 → 打开
            settingsOrLocal(
              fishRpc?.settings?.({ whisper: next }),
              () => {
                prefs.update((d) => {
                  d.whisper = next;
                });
                bubbleOn(next ? T().bubbles.whisperOn : T().bubbles.whisperOff);
                reportFocus(); // 旧 server 兼容：总开关仍走 focus 心跳
              },
              () => bubbleOn(next ? T().bubbles.whisperOn : T().bubbles.whisperOff),
            );
          });
          item(T().menu.lang, buildLangPage, true);
          item(T().menu.bigger, () => {
            const next = clamp(prefs.value.width + 20, 120, 360);
            settingsOrLocal(
              fishRpc?.settings?.({ width: next }),
              () => {
                prefs.update((d) => {
                  d.width = next;
                });
                for (const w of fishes) w.f.setSize(next);
              },
              () => {},
            );
          });
          item(T().menu.smaller, () => {
            const next = clamp(prefs.value.width - 20, 120, 360);
            settingsOrLocal(
              fishRpc?.settings?.({ width: next }),
              () => {
                prefs.update((d) => {
                  d.width = next;
                });
                for (const w of fishes) w.f.setSize(next);
              },
              () => {},
            );
          });
          item(T().menu.home, () => {
            setPos(window.innerWidth - stageW() - 24, 84);
            if (!state.sleeping && !shared.work && !shared.flash) toIdle();
          });
          };
          // 语言选择页：点选后经 language RPC 写入 server 权威（经 state 同步回各窗口）；
          // 旧 server 无该方法时回退本地 prefs（不持久化，下一次权威 lang 会盖回来）
          const buildLangPage = () => {
            menu.replaceChildren();
            item("← " + T().menu.back, buildMain, true);
            for (const code of LANGS) {
              item((code === lang() ? "✓ " : "") + LANG_NAMES[code], () => {
                bubbleOn(STR[code].bubbles.langSwitched, 3000);
                const applyFallback = () => {
                  prefs.update((d) => {
                    d.lang = code;
                  });
                };
                try {
                  const call = fishRpc?.language?.({ lang: code });
                  if (call && typeof call.then === "function") {
                    void call.then(
                      (s) => {
                        if (s) applyState(s);
                        else applyFallback();
                      },
                      () => applyFallback(),
                    );
                  } else applyFallback();
                } catch {
                  applyFallback();
                }
              });
            }
            placeMenu();
          };
          // 待办列表页：server todos 安全投影 + 清空入口（todoClear RPC；列表经 state 回流更新）
          const buildTodoPage = () => {
            menu.replaceChildren();
            item("← " + T().menu.back, buildMain, true);
            if (!serverTodos.length) {
              const row = document.createElement("div");
              row.className = "fish-menu-row";
              row.textContent = T().todo.empty;
              menu.appendChild(row);
            }
            for (const t of serverTodos.slice(0, 20)) {
              const row = document.createElement("div");
              row.className = "fish-menu-row";
              row.textContent = t.text || "";
              if (typeof t.dueAt === "number" && Number.isFinite(t.dueAt)) {
                const due = document.createElement("span");
                due.className = "due";
                const dt = new Date(t.dueAt);
                due.textContent =
                  " @" + (dt.getMonth() + 1) + "-" + dt.getDate() + " " + String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
                row.appendChild(due);
              }
              menu.appendChild(row);
            }
            if (serverTodos.length) {
              item(T().todo.clear, () => {
                closeMenu();
                void (async () => {
                  let s = null;
                  try {
                    s = await fishRpc?.todoClear?.({});
                  } catch {
                    s = null;
                  }
                  if (s) {
                    applyState(s);
                    bubbleOn(T().bubbles.todoCleared, 3000);
                  } else {
                    bubbleOn(T().bubbles.actionFailed, 4000);
                  }
                })();
              });
            }
            placeMenu();
          };
          // 先挂载量出实际尺寸再定位：菜单项数随页面/语言变化，翻页后也要按新尺寸重夹
          const placeMenu = () => {
            const mw = menu.offsetWidth;
            const mh = menu.offsetHeight;
            menu.style.left = clamp(e.clientX, 8, Math.max(8, window.innerWidth - mw - 8)) + "px";
            menu.style.top = clamp(e.clientY, 8, Math.max(8, window.innerHeight - mh - 8)) + "px";
          };
          buildMain();
          document.body.appendChild(menu);
          placeMenu();
          document.addEventListener("pointerdown", onMenuAway, true);
          document.addEventListener("keydown", onMenuKey, true);
        });

        const onVisible = () => {
          const v = frontVideo();
          if (document.hidden) v.pause();
          else if (!shared.dead && !state.sleeping && !reduced()) v.play().catch(() => {});
        };
        document.addEventListener("visibilitychange", onVisible);

        // 窗口缩放：把鱼夹回可视区（位置是视口坐标，缩小窗口会把鱼留在画外）
        const onResize = () => {
          if (state.dragging) return; // 拖拽中不抢：落点自会归位
          setPos(
            clamp(state.x, xMin(0), xMax(0)),
            clamp(state.y, 0, Math.max(0, window.innerHeight - stageH())),
          );
        };
        window.addEventListener("resize", onResize);

        const dispose = () => {
          state.gen++;
          clearTimeout(state.rollTimer);
          clearTimeout(state.bubbleTimer);
          clearTimeout(state.replyTimer);
          cancelAnimationFrame(state.raf);
          closeMenu();
          document.removeEventListener("visibilitychange", onVisible);
          window.removeEventListener("resize", onResize);
          for (const v of videos) {
            v.pause();
            v.removeAttribute("src");
          }
          root.remove();
        };

        const api = {
          state,
          root,
          setSize: setSizeAll,
          nudge,
          bubble,
          hideBubble,
          play: playClip,
          wake,
          dispose,
        };
        // state.stageW 供互撞读取
        state.stageW = stageW;
        applyFacing();
        playClip(POOLS.names.idle, { loop: true });
        scheduleRoll(4000 + Math.random() * 6000);
        return { f: api };
      }

      const addFish = (saved) => {
        if (fishes.length >= 6) return bubbleOn(T().bubbles.maxFish);
        const fish = createFish(fishes.length, saved ?? null);
        fishes.push(fish);
        return fish;
      };
      const removeFish = (api) => {
        const i = fishes.findIndex((f) => f.f === api);
        if (i >= 0) {
          fishes[i].f.dispose();
          fishes.splice(i, 1);
          binds.clear(); // 索引移位：清空绑定，下一拍 state 重绑
        }
      };

      // ---------- 位置持久化（去抖） ----------
      let saveTimer = 0;
      const savePositions = () => {
        clearTimeout(saveTimer);
        saveTimer = later(() => {
          if (shared.dead) return;
          try {
            prefs.update((d) => {
              d.positions = fishes.map((f) => ({ x: Math.round(f.f.state.x), y: Math.round(f.f.state.y) }));
            });
          } catch {
            /* store 不可用时静默 */
          }
        }, 1500);
      };
      every(() => {
        if (!document.hidden) savePositions();
      }, 20000);

      // =========================================================
      // 脑在 server（插件 index.ts）：这里只把已经去抖的档位应用到鱼身。
      // focus 上报兼作观众心跳与情境同步（server 侧没有 message.list，摘要在前端构建）。
      // =========================================================
      let fishSid = null;
      let lastTier = undefined;
      let lastFlash = undefined;
      let lastNoticeAt = 0;
      let serverTodos = []; // server todos 安全投影（列表页展示）
      let fishRpc = null;
      try {
        fishRpc = ctx.client.rpc ? ctx.client.rpc(FishStateDef) : null;
      } catch {
        fishRpc = null;
      }

      // ---------- 共享偏好一次性迁移（本地 → server settings 权威）----------
      // 只上推与内置默认（whisper:false/notify:false/width:200）不同的本地值：多端并存时避免
      // 默认值端覆盖已迁移端；两端都有自定义值则后写胜出（无法避免，见 README）。上推成功
      // （返回带 whisper 布尔 = 新 server）才打本地标记；旧 server/失败不打，下次 boot 重试。
      let settingsMigrating = false;
      const migrateSettings = (s) => {
        if (settingsMigrating) return;
        settingsMigrating = true;
        const local = {};
        if (prefs.value.whisper === true && s.whisper !== true) local.whisper = true;
        if (!!prefs.value.notify === true && s.notify !== true) local.notify = true;
        if (
          typeof prefs.value.width === "number" &&
          prefs.value.width !== 200 &&
          prefs.value.width !== s.width
        ) {
          local.width = clamp(prefs.value.width, 120, 360);
        }
        if (!Object.keys(local).length) {
          // 本地全默认：无需上推，直接完成迁移并开始下行同步
          prefs.update((d) => {
            d.settingsMigrated = true;
          });
          settingsMigrating = false;
          return;
        }
        const call = fishRpc?.settings?.(local);
        if (call && typeof call.then === "function") {
          void call.then(
            (out) => {
              settingsMigrating = false;
              if (out && typeof out.whisper === "boolean") {
                prefs.update((d) => {
                  d.settingsMigrated = true;
                });
                applyState(out);
              } // 旧 server 回形（无 whisper）：不打标记，下次重试
            },
            () => {
              settingsMigrating = false;
            },
          );
        } else {
          settingsMigrating = false; // 旧 client 无方法：下次 boot 重试
        }
      };

      // ---------- 会话鱼粘性绑定：鱼0 永远聚合；鱼1..N 绑运行中会话，绝不轮换 ----------
      // 规则：空闲鱼挑最活跃的无主会话；释放 = max(绑定起+30s, 完成+8s)；
      // 换绑先播 1s waiting 交接；绑定鱼档位切换带 4s 本地驻留；溢出会话归聚合鱼。
      const binds = new Map();
      function syncBindings(list) {
        const running = new Map(list.map((x) => [x.sessionID, x.tier]));
        const now = performance.now();
        for (const [idx, b] of binds) {
          if (!running.has(b.sid)) {
            // 固定截止：只在首次检测到消失时锚定（max(完成+8s, 绑定起+30s)），不随每次 sync 滑动
            if (!b.releasing) b.releasing = Math.max(now + 8000, b.boundAt + 30000);
            if (now > b.releasing) {
              binds.delete(idx);
              const f = fishes[idx]?.f;
              if (f && f.state.replyHold) continue; // 回复播放中：不清回复气泡也不抢片
              if (f && !f.state.sleeping && !f.state.dragging && !f.state.busy) {
                f.hideBubble();
                f.play(POOLS.names.idle, { loop: true });
              }
            }
          }
        }
        const owned = new Set([...binds.values()].map((b) => b.sid));
        for (let i = 1; i < fishes.length; i++) {
          if (binds.has(i)) continue;
          const target = list.find((x) => !owned.has(x.sessionID));
          if (!target) break;
          binds.set(i, { sid: target.sessionID, boundAt: now, handoff: now + 1000, tier: null, tierAt: 0, releasing: 0 });
          owned.add(target.sessionID);
          const f = fishes[i].f;
          if (fishFree(f)) f.play(workClip("waiting"), { loop: true }); // 交接播真实 waiting 素材（旧硬编码 "work-waiting" 不在素材库）
        }
        for (const [idx, b] of binds) {
          const f = fishes[idx]?.f;
          if (!f || now < b.handoff) continue;
          const tier = running.get(b.sid);
          if (tier && tier !== b.tier) {
            if (b.tier !== null && now - b.tierAt < 4000) continue;
            b.tier = tier;
            b.tierAt = now;
            if (fishFree(f)) f.play(workClip(tier), { loop: true });
          }
        }
      }
      const unboundFishes = () => fishes.filter((w, i) => !binds.has(i));

      const playTierAll = (tier) => {
        for (const w of unboundFishes()) {
          const f = w.f;
          if (!fishFree(f)) continue;
          f.play(workClip(tier), { loop: true });
        }
      };
      const petLifeAll = () => {
        for (const w of unboundFishes()) {
          const f = w.f;
          if (f.state.replyHold) continue; // 回复播放中：不抢片也不清回复气泡
          f.hideBubble();
          if (!f.state.sleeping && !f.state.dragging && !f.state.busy) f.play(POOLS.names.idle, { loop: true });
        }
      };
      const notifyFlash = (kind, flashSid, flashAt) => {
        if (!prefs.value.notify) return;
        // 定向：优先用触发庆祝的那个会话；找不到再退回当前路由会话
        let target = ctx.sessions.current?.();
        if (flashSid) {
          for (const s of ctx.sessions.list?.() ?? []) {
            if (s.id === flashSid) {
              target = s;
              break;
            }
          }
        }
        if (!target?.id) return;
        // 去重 id 以"这次庆祝"为唯一维度（flashAt）：同一次事件跨窗口仍相同（第一个窗口赢），
        // 不同次事件不同 id——app 端 claim 把 id 持久化进 localStorage，静态 id 会让通知永久哑火。
        const stamp = flashAt || Math.floor(Date.now() / 10000); // 旧 server 无 flashAt 时按 10s 分桶
        try {
          void ctx.attention?.notify?.({
            title: kind === "success" ? T().notify.success : T().notify.error,
            message: target.server?.data?.session?.get?.(target.id)?.title ?? "fish-pet",
            variant: kind === "success" ? "default" : "error",
            session: { server: target.server.id, id: target.id },
            id: "fish-pet-flash-" + stamp + "-" + (flashSid ?? "global"),
          });
        } catch {
          /* 旧版本无 attention */
        }
      };
      function applyState(s) {
        if (shared.dead || !s) return;
        const prevSid = fishSid;
        fishSid = s.sessionID ?? null; // 重置鱼脑后 server 会发 null：必须跟着清空
        if (prevSid && !fishSid) setFishBusy(false); // 重置即收口：不等完成事件（sid 已失配）
        if (typeof s.name === "string" && s.name) chatTab.title = s.name.slice(0, 16);
        // 语言权威同步：server 的 lang 落到本窗口 prefs（UI/菜单跟随）；prefs 写入不回写 server，无循环
        if (typeof s.lang === "string" && LANGS.includes(s.lang) && s.lang !== prefs.value.lang) {
          prefs.update((d) => {
            d.lang = s.lang;
          });
        }
        // 共享偏好（whisper/notify/width）权威在 server settings：迁移完成后从 state 下行同步；
        // 迁移未完成先做一次性上推，避免 server 默认值无提示覆盖本地已有偏好
        if (typeof s.whisper === "boolean" || typeof s.notify === "boolean" || typeof s.width === "number") {
          if (prefs.value.settingsMigrated) {
            if (typeof s.whisper === "boolean" && s.whisper !== prefs.value.whisper) {
              prefs.update((d) => {
                d.whisper = s.whisper;
              });
            }
            if (typeof s.notify === "boolean" && !!s.notify !== !!prefs.value.notify) {
              prefs.update((d) => {
                d.notify = s.notify;
              });
            }
            if (typeof s.width === "number" && s.width >= 120 && s.width <= 360 && s.width !== prefs.value.width) {
              prefs.update((d) => {
                d.width = s.width;
              });
              for (const w of fishes) w.f.setSize(s.width);
            }
          } else {
            migrateSettings(s);
          }
        }
        if (Array.isArray(s.todos)) serverTodos = s.todos; // 待办安全投影：列表页展示
        if (Array.isArray(s.sessions)) syncBindings(s.sessions);
        if (s.notice && s.notice.at > lastNoticeAt) {
          lastNoticeAt = s.notice.at;
          bubbleLow(s.notice.text, 3000);
          // 绑定该会话的鱼自己庆祝/沮丧（不受全局冷却；聚合鱼不重复）
          const entry = [...binds.entries()].find(([, b]) => b.sid === s.notice.sid);
          const fish = entry ? fishes[entry[0]]?.f : undefined;
          if (fishFree(fish)) {
            fish.play(workClip(s.notice.ok ? "success" : "error"), {});
          }
        }
        if (s.tier !== lastTier) {
          lastTier = s.tier;
          shared.work = s.tier;
          if (s.tier) {
            playTierAll(s.tier);
            bubbleLow(s.tier === "working" && s.tool ? `${T().status[s.tier]} · ${s.tool}` : T().status[s.tier]);
          } else {
            petLifeAll();
          }
        }
        if (s.flash !== lastFlash) {
          lastFlash = s.flash;
          shared.flash = s.flash;
          if (s.flash) {
            for (const w of unboundFishes()) {
              const f = w.f;
              if (f.state.sleeping || f.state.dragging || f.state.replyHold) continue;
              f.play(workClip(s.flash), {});
            }
            bubbleLow(T().status[s.flash], 3000);
            notifyFlash(s.flash, s.flashSid, s.flashAt);
          }
        }
      }
      if (fishRpc) {
        try {
          void fishRpc.state({}).then(applyState, () => {});
          fishRpc.events.on("state", (ev) => applyState(ev.data), { signal: ctx.signal });
        } catch {
          /* 订阅失败：10s focus 的返回值兜底 */
        }
      }

      // ---------- focus 心跳：路由/睡眠变化即报 + 10s 续报 ----------
      function buildDigest() {
        try {
          const cur = ctx.sessions.current?.();
          if (!cur?.id || !cur.server?.data) return "";
          const info = cur.server.data.session.get?.(cur.id);
          const msgs = cur.server.data.session.message.list?.(cur.id) ?? [];
          const lastUser = msgs.findLast?.((m) => m.type === "user");
          const lastAssistant = msgs.findLast?.((m) => m.type === "assistant");
          const clipText = (s) => (s ?? "").replace(/\s+/g, " ").slice(0, 300);
          const parts = [];
          if (info?.title) parts.push(`会话主题：${info.title}`);
          if (lastUser?.text) parts.push(`主人最近在说：${clipText(lastUser.text)}`);
          const at = textOf(lastAssistant);
          if (at) parts.push(`他的助手最近回了：${clipText(at)}`);
          return parts.join("\n");
        } catch {
          return "";
        }
      }
      const sleepingAll = () => fishes.length > 0 && fishes.every((w) => w.f.state.sleeping);
      const whisper = (opts) => {
        try {
          void fishRpc?.whisper?.({ dream: !!(opts && opts.dream) });
        } catch {
          /* server 缺席 */
        }
      };
      const reportFocus = () => {
        if (shared.dead || !fishRpc) return;
        const cur = ctx.sessions.current?.();
        // 防自反馈：路由中的会话就是鱼会话（在会话列表里点开了它）时，摘要读到的会是鱼自己的话，
        // 绝不能当主人情境回传——报空 digest + 无主会话；碎碎念退化为无情境（提示词本就允许为空）。
        // fishSid 尚未同步到本窗口的间隙由 server 侧 focus 的 fishSessionID 防御兜底。
        const onFish = !!(cur?.id && fishSid && cur.id === fishSid);
        const running = [];
        try {
          for (const s of ctx.sessions.list?.() ?? []) {
            // 只报本机 server 的会话：远端 server 的会话这个脑看不见事件，报了就是幻影
            if (s.server?.local && s.server?.data?.session?.status?.(s.id) === "running") running.push(s.id);
          }
        } catch {
          /* 数据层缺席 */
        }
        void fishRpc
          .focus({ sessionID: onFish ? null : (cur?.id ?? null), digest: onFish ? "" : buildDigest(), sleeping: sleepingAll(), running, lang: lang(), whisper: prefs.value.whisper !== false })
          .then(applyState, () => {});
      };
      later(reportFocus, 1500);
      every(reportFocus, 10000);

      // =========================================================
      // 鱼会话：创建/调度在 server；这里只做回复捕获（气泡+点播）与面板流式
      // =========================================================
      // ---------- 真实回复保护：模型回复的一次性片播完为止，低优先级（随机/tier/flash/庆祝/余额/thinking）不抢 ----------
      // 用户手势（pointerdown）与睡/醒仍可打断并清空暂存；ended/兜底/缺素材都解锁，不留永久锁。
      // B 在 A 播放期间不覆盖 A：单一暂存位，直接聊天优先（WHISPER_MARK 前置 user 辨来源），同类保最新。
      const REPLY_FALLBACK_MS = 12000; // ended 丢失兜底：素材实测 ~10s；到期先体检再决定续排或收口
      const REPLY_REARM_MAX = 2; // 可见页「还在播但未播完」最多续排 2 次（36s 上界，容纳启动/解码慢）
      const clearReplyHold = (f) => {
        f.state.replyHold = false;
        clearTimeout(f.state.replyTimer);
        f.state.replyTimer = 0;
      };
      const replyRestore = (f) => {
        // 播完按最新持续态恢复：绑定鱼的自己档位 > 聚合工作档 > 聊天 thinking > idle
        // （flash/庆祝是一次性，过期不补；接下 thinking 所有权让 setFishBusy(false) 能正常收口）
        clearReplyHold(f);
        if (shared.dead || !f || f.state.sleeping || f.state.dragging || f.state.busy) return;
        const idx = fishes.findIndex((w) => w.f === f);
        const b = idx >= 0 ? binds.get(idx) : undefined;
        if (b && b.tier) {
          f.play(workClip(b.tier), { loop: true });
          return;
        }
        if (shared.work) {
          f.play(workClip(shared.work), { loop: true });
          return;
        }
        if (fishBusy) {
          f.play(workClip("thinking"), { loop: true });
          fishClipOwned = true;
          busyFish = f;
          return;
        }
        f.play(POOLS.names.idle, { loop: true });
      };
      const replyDone = (f) => {
        const pending = f.state.replyPending;
        if (pending) {
          f.state.replyPending = null;
          playReplyOn(f, pending.clip, pending.text);
          return;
        }
        replyRestore(f);
      };
      const replyTick = (f, clip, rearm) => {
        // ended 丢失兜底体检：隐藏页（播放器被挂起）/ 前片还在播 = 健康，续排不切；
        // 暂停无进展（canplay 不来/play 失败）或续排超限 = 失效，按完成收口（drain 暂存后恢复），始终有界
        if (f.state.replyHold && f.state.current === clip) {
          const v = f.state.videoEl;
          const healthy = document.hidden || (v && !v.paused && !v.ended);
          if (healthy && (document.hidden || rearm < REPLY_REARM_MAX)) {
            f.state.replyTimer = setTimeout(() => replyTick(f, clip, rearm + 1), REPLY_FALLBACK_MS);
            return;
          }
        }
        replyDone(f);
      };
      const playReplyOn = (f, clip, text) => {
        if (!f) return;
        clearReplyHold(f); // 竞态安全：先清旧保护再开新片
        f.bubble(text, 6000); // 梦话（睡着）/缺素材：至少气泡，原行为
        if (f.state.sleeping) return; // 睡着只弹气泡不加动画（原行为），无锁
        if (!clip || !ASSETS[clip]) return; // 缺素材不伪造成功动画，无锁
        f.state.replyHold = true;
        f.state.replyTimer = setTimeout(() => replyTick(f, clip, 0), REPLY_FALLBACK_MS); // per-fish 单槽，dispose 收口
        f.play(clip, { onEnded: () => replyDone(f) });
      };
      const stashReply = (f, clip, text, isChat) => {
        // 单槽暂存：待播聊天最高（碎碎念不顶掉聊天）；同类保最新
        const p = f.state.replyPending;
        if (p && p.isChat && !isChat) return;
        f.state.replyPending = { clip, text, isChat };
      };
      const bubbleLow = (text, ms) => {
        // 低优先级状态文本（tier/flash/notice/余额/执行错误）：回复气泡展示中不盖
        const f = leadFish();
        if (f?.state.replyHold) return;
        f?.bubble(text, ms);
      };

      const fishReply = async () => {
        if (!fishSid) return;
        try {
          const res = await ctx.client.message.list({ sessionID: fishSid, order: "desc", limit: 8 });
          const msgs = res.data ?? [];
          const ai = msgs.findIndex((m) => m.type === "assistant");
          if (ai < 0) return;
          const msg = msgs[ai];
          if (msg.finish === "error") {
            bubbleLow(T().bubbles.replyError, 5000); // 执行错误：低优先，回复播放中不盖
            for (const view of chatViews) view.refresh?.();
            return;
          }
          const text = textOf(msg).trim();
          if (!text) return;
          const cue = text.match(/\[播放[:：]\s*([^\]]+)\]/);
          const clean = text.replace(/\[播放[:：][^\]]+\]/g, "").trim();
          // 已有消息标记辨别来源：紧邻前置 user 带 WHISPER_MARK 前缀 = 碎碎念，否则 = 直接聊天
          const um = msgs.slice(ai + 1).find((m) => m.type === "user");
          const isChat = !!um && !(um.text ?? "").startsWith(WHISPER_MARK);
          const f = leadFish();
          if (f && cue && !clean) {
            // cue-only：模型只点了动作没给正文——不伪造"……"成功回复、不进保护、不占暂存，
            // 按原点播语义裸放一次（可被抢，ended 回 idle），拖动/飞行/保护期不抢
            if (POOLS.cueMap[cue[1].trim()] && !f.state.replyHold && !f.state.sleeping && !f.state.dragging && !f.state.busy) {
              f.play(POOLS.cueMap[cue[1].trim()], { onEnded: () => { if (!f.state.replyHold) f.play(POOLS.names.idle, { loop: true }); } });
            }
          } else if (f && clean) {
            const clip = (cue && POOLS.cueMap[cue[1].trim()]) || pick(POOLS.whisper); // 无 cue 也要演一段碎碎念动画
            const text60 = clean.slice(0, 60);
            if (f.state.dragging) stashReply(f, clip, text60, isChat); // 拖动中延后，落地/点击即播
            else if (f.state.replyHold) stashReply(f, clip, text60, isChat); // B 勿覆盖 A：待播聊天优先
            else playReplyOn(f, clip, text60);
          }
          for (const view of chatViews) view.refresh?.();
        } catch {
          /* 会话没了：server 会自愈重建 */
        }
      };

      // 面板真流式：面板发送后订阅 text.delta，尾部实时长出
      let streamCtl = null;
      function watchStream(sid) {
        try {
          streamCtl?.abort();
          streamCtl = new AbortController();
          const buf = { text: "" };
          void (async () => {
            try {
              const sub = ctx.client.event.subscribe({
                types: ["session.text.delta"],
                signal: AbortSignal.any([ctx.signal, streamCtl.signal]),
              });
              for await (const ev of sub) {
                if (streamCtl.signal.aborted || shared.dead) break;
                if (!ev.data || ev.data.sessionID !== sid) continue;
                buf.text += ev.data.text ?? "";
                for (const view of chatViews) view.tail?.(buf.text);
              }
            } catch {
              /* 流断开：完成事件兜底 */
            }
          })();
        } catch {
          /* 旧版本 */
        }
      }

      // =========================================================
      // 事件流：工作状态经 server 的 rpc.fish-pet.state 到达；
      // 这里只听鱼会话自身的完成事件（回复捕获与面板收口）
      // =========================================================
      void (async () => {
        try {
          const sub = ctx.client.event.subscribe({
            types: ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"],
            signal: ctx.signal,
          });
          for await (const ev of sub) {
            if (shared.dead) break;
            const sid = ev.data && ev.data.sessionID;
            if (!sid || sid !== fishSid) continue;
            streamCtl?.abort();
            setFishBusy(false);
            if (ev.type === "session.execution.succeeded") void fishReply();
            else if (ev.type === "session.execution.failed") bubbleLow(T().bubbles.replyErrorShort, 4000);
            // interrupted：主人自己掐断的，静默收口
            for (const view of chatViews) view.refresh?.();
          }
        } catch {
          /* 断开：10s focus 的返回值兜底刷新 */
        }
      })();

      // =========================================================
      // 对话面板（Panel）：鱼会话的一个视图
      // =========================================================
      const chatTab = { id: "chat", title: "Fish", pinned: true, fallback: true }; // 空选回退：无存储标签时宿主自动选中鱼聊天，避免侧栏停在 "Select a file to open" 死占位符
      const chatViews = new Set();

      // ---------- 鱼自己"正在回复"的可见状态 ----------
      // 鱼会话不进 server 聚合机（避免鱼对自己的话起反应），这里单独表示：
      // 面板发起 → 鱼 thinking + 面板 pending 行；首个 delta → 流式行顶掉 pending；完成 → 气泡 + 收口。
      let fishBusy = false;
      let fishClipOwned = false;
      let busyFish = null;
      let busyWatchdog = 0;
      const setFishBusy = (on) => {
        if (on && fishBusy) {
          // 已在忙（连发第二条）：只续兜底计时器，不重新认领——避免上一条鱼变成孤儿 thinking
          clearTimeout(busyWatchdog);
          busyWatchdog = later(() => setFishBusy(false), 90000);
          return;
        }
        fishBusy = on;
        for (const v of chatViews) v.setBusy?.(on);
        clearTimeout(busyWatchdog);
        if (on) {
          const f = leadFish();
          if (fishFree(f) && !shared.work && !shared.flash) {
            f.play(workClip("thinking"), { loop: true });
            fishClipOwned = true;
            busyFish = f;
          }
          busyWatchdog = later(() => setFishBusy(false), 90000); // 完成事件丢失时的兜底收口
        } else if (fishClipOwned) {
          fishClipOwned = false;
          const g = busyFish;
          busyFish = null;
          if (fishFree(g) && !shared.work && !shared.flash) {
            g.play(POOLS.names.idle, { loop: true });
          }
        }
      };

      function buildChatView() {
        const wrap = document.createElement("div");
        wrap.className = "fish-chat";
        const list = document.createElement("div");
        list.className = "fish-chat-list";
        const composer = document.createElement("div");
        composer.className = "fish-chat-composer";
        const input = document.createElement("input");
        input.placeholder = T().panel.placeholder;
        const send = document.createElement("button");
        send.textContent = T().panel.send;
        composer.append(input, send);
        wrap.append(list, composer);

        let pendingRow = null;
        const mkPendingRow = () => {
          const row = document.createElement("div");
          row.className = "fish-row fish-row-pending";
          row.append(T().panel.pending);
          for (let i = 0; i < 3; i++) {
            const d = document.createElement("span");
            d.className = "d";
            d.textContent = "·";
            row.appendChild(d);
          }
          return row;
        };
        const ensurePendingRow = () => {
          if (!pendingRow) pendingRow = mkPendingRow();
          if (!pendingRow.isConnected) list.appendChild(pendingRow);
          list.scrollTop = list.scrollHeight;
        };
        const dropPendingRow = () => {
          if (pendingRow) {
            pendingRow.remove();
            pendingRow = null;
          }
        };

        const view = { refresh: async () => {
          const sid = fishSid;
          if (!sid) {
            if (fishBusy) {
              // 会话刚由 server 创建、fishSid 尚未回传：只挂 pending
              dropPendingRow();
              pendingRow = mkPendingRow();
              list.replaceChildren(pendingRow);
              return;
            }
            list.replaceChildren(Object.assign(document.createElement("div"), { className: "fish-chat-empty", textContent: T().panel.emptyNever }));
            return;
          }
          try {
            const res = await ctx.client.message.list({ sessionID: sid, order: "desc", limit: 40 });
            const msgs = (res.data ?? [])
              .filter((m) => (m.type === "user" || m.type === "assistant") && !(m.type === "user" && (m.text ?? "").startsWith(WHISPER_MARK)))
              .reverse();
            list.replaceChildren(
              ...msgs.map((m) => {
                const row = document.createElement("div");
                row.className = "fish-row " + (m.type === "assistant" ? "fish-row-fish" : "fish-row-user");
                if (m.type === "assistant" && m.finish === "error") {
                  row.textContent = "⚠️ " + (m.error?.message ?? T().panel.genFailed);
                } else {
                  row.textContent = textOf(m) || "…";
                }
                return row;
              }),
            );
            if (!msgs.length && !fishBusy) list.replaceChildren(Object.assign(document.createElement("div"), { className: "fish-chat-empty", textContent: T().panel.emptyBlank }));
            liveRow = null;
            if (fishBusy) ensurePendingRow();
            else dropPendingRow();
            list.scrollTop = list.scrollHeight;
          } catch {
            /* 会话被删：显示空态 */
          }
        }, tail: (text) => {
          if (!list.isConnected) return;
          dropPendingRow(); // 首个 delta 到达：流式行顶掉 pending
          if (!liveRow) {
            liveRow = document.createElement("div");
            liveRow.className = "fish-row fish-row-fish";
          }
          liveRow.textContent = text + " ▍";
          if (!liveRow.isConnected) list.appendChild(liveRow);
          list.scrollTop = list.scrollHeight;
        }, setBusy: (on) => {
          send.textContent = on ? "…" : T().panel.send;
          if (on) ensurePendingRow();
          else dropPendingRow();
        } };
        let liveRow = null;
        chatViews.add(view);
        view.refresh();
        const poll = every(() => {
          if (!wrap.isConnected) {
            clearInterval(poll);
            chatViews.delete(view);
            return;
          }
          if (!document.hidden) void view.refresh();
        }, 2500);

        const submit = async () => {
          const text = input.value.trim();
          if (!text) return;
          if (!fishRpc) {
            bubbleOn(T().bubbles.notReady, 3000);
            return;
          }
          input.value = "";
          setFishBusy(true); // 即时反馈：鱼开始想 + 面板挂 pending
          try {
            const s = await fishRpc.say({ text });
            applyState(s);
            if (!s.sessionID) throw new Error("fish session unavailable");
            watchStream(s.sessionID);
            void view.refresh();
          } catch {
            input.value = text; // 找回没发出去的话
            setFishBusy(false);
            bubbleOn(T().bubbles.sendFailed, 4000);
          }
        };
        send.addEventListener("click", () => void submit());
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") void submit();
        });
        return wrap;
      }

      try {
        if (Panel) {
          ctx.add(Panel, {
            id: "chat",
            region: "side",
            list: () => [chatTab],
            render: () => buildChatView(),
          });
        }
      } catch {
        /* 旧版本无 Panel：聊天经原会话窗口使用 */
      }

      // =========================================================
      // 待办 / 起名：server 存储与节奏，前端只负责录入
      // =========================================================
      async function nameFish() {
        try {
          const n = await ctx.dialogs.prompt({ title: T().menu.nameFish, placeholder: lang() === "zh" ? "叫它什么…" : lang() === "ja" ? "なんて呼ぶ？" : "What should we call it?" });
          if (n && n.trim()) {
            // 起名经 name RPC 落 server：只有真实成功才道贺，失败给明确提示（不再对未注册方法假装成功）
            let s = null;
            try {
              s = await fishRpc?.name?.({ name: n.trim() });
            } catch {
              s = null;
            }
            if (s) {
              applyState(s);
              bubbleOn(STR[lang()].bubbles.nameSet(n.trim().slice(0, 24)));
            } else {
              bubbleOn(T().bubbles.nameFailed, 4000);
            }
          }
        } catch {
          /* dialogs 缺席 */
        }
      }
      async function addTodo() {
        try {
          const text = await ctx.dialogs.prompt({ title: T().todo.title, placeholder: T().todo.placeholder });
          if (text && text.trim()) {
            // 真实 RPC 回包才报成功；失败给明确提示（不再 fire-and-forget 乐观道贺）
            let s = null;
            try {
              s = await fishRpc?.todoAdd?.({ text: text.trim() });
            } catch {
              s = null;
            }
            if (s) {
              applyState(s);
              bubbleOn(T().bubbles.todoDone + text.trim().slice(0, 30), 3000);
            } else {
              bubbleOn(T().bubbles.actionFailed, 4000);
            }
          }
        } catch {
          /* dialogs 缺席 */
        }
      }
      // =========================================================
      // 余额六档（server RPC 查询：DeepSeek 凭据链 options → DB 连接 → provider 配置，custom 中转沿用 options）
      // 自动（force=false）未配置/失败静默；手动三态：未配置 / key 失效 / 查询失败。
      // =========================================================
      async function runBalance(force) {
        let out = null;
        try {
          out = await fishRpc?.balance?.({ force: !!force });
        } catch {
          /* server 缺席或旧版无该方法 */
        }
        const rows = out && Array.isArray(out.results) ? out.results : [];
        let worst = -1;
        let report = "";
        let bad = null; // 全失败时区分 unauthorized 与其余错误
        for (const r of rows) {
          if (!r || typeof r.name !== "string") continue;
          if (r.error) {
            bad = bad ?? (r.error === "unauthorized" ? "unauthorized" : "other");
            continue;
          }
          if (typeof r.remaining !== "number" || typeof r.total !== "number" || !(r.total > 0)) continue;
          const pct = clamp(100 * (1 - r.remaining / r.total), 0, 100);
          worst = Math.max(worst, pct);
          report = report
            ? report
            : r.name === "DeepSeek"
              ? T().balanceReport(r.remaining.toFixed(2))
              : T().balanceCustom(r.name || T().customName, r.remaining);
        }
        if (worst < 0) {
          if (!force) return; // 自动模式：未配置/失败静默
          if (bad === "unauthorized") return bubbleLow(T().bubbles.balanceInvalid, 5000); // 失败三态：低优先，回复播放中不盖
          if (bad) return bubbleLow(T().bubbles.balanceFailed, 5000);
          return bubbleLow(T().bubbles.balanceNoKey, 3500);
        }
        const idx = worst >= 100 ? 5 : Math.floor(worst / 20);
        const label = T().balanceLabels[idx];
        for (const f of fishes) {
          if (!f.f.state.sleeping && !f.f.state.replyHold) f.f.play(POOLS.balance[idx], { onEnded: () => f.f.play(POOLS.names.idle, { loop: true }) });
        }
        bubbleLow(T().withLabel(report, label), 5000);
      }
      every(() => {
        if (!shared.dead) void runBalance(false); // 零配置用户也轮询：server 侧无配置时零上游请求
      }, 30 * 60 * 1000);

      // =========================================================
      // 对外 API（窗口内 Contract：说/播/读状态；睡着回拒绝台词）
      try {
        if (Contract) {
          const FishApi = Contract.define("fish-pet");
          ctx.provide(FishApi, {
            say: (text) => {
              const f = leadFish();
              if (!f) return;
              if (f.state.sleeping) return f.bubble(pick(T().sleepRefusals), 3000);
              if (f.state.replyHold) return; // 回复播放中：外部 say 不盖回复气泡
              f.bubble(String(text).slice(0, 60), 5000);
            },
            play: (name) => {
              if (!ASSETS[name]) return false;
              const f = leadFish();
              if (!f || f.state.sleeping || f.state.replyHold) return false; // 回复播放中：contract 点播不抢
              f.play(name, { onEnded: () => f.play(POOLS.names.idle, { loop: true }) });
              return true;
            },
            status: () => ({
              fishCount: fishes.length,
              overlay: false, // 保持既有 Contract.status 返回形状
              sleeping: sleepingAll(),
              work: shared.work,
              sessionID: fishSid,
            }),
          });
        }
      } catch {
        /* Contract 缺席 */
      }

      // ---------- 挂载宿主（Slot 或 body 兜底） ----------
      const fishesHost = document.createElement("div");
      fishesHost.dataset.fishHost = "1";
      let fallback = false;
      try {
        if (!Slot) throw new Error("no slot registry");
        ctx.add(Slot, { at: "window.bottom", order: 100, render: () => fishesHost });
      } catch {
        fallback = true;
      }
      // 鱼的 root 是 position:fixed：Slot 正常时挂在 slot 容器里逃逸到视口，兜底直接挂 body。
      const saved = prefs.value.positions ?? [];
      const count = clamp(saved.length || 1, 1, 6);
      for (let i = 0; i < count; i++) {
        const fish = addFish(saved[i] ?? null);
        (fallback ? document.body : fishesHost).appendChild(fish.f.root);
      }

      return () => {
        shared.dead = true;
        for (const t of shared.timers) {
          clearTimeout(t);
          clearInterval(t);
        }
        for (const f of fishes) f.f.dispose();
        fishesHost.remove();
        if (alphaSvg) alphaSvg.remove();
        chatViews.clear();
      };
    },
  };
})());
