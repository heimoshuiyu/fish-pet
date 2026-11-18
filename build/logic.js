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

const CSS = `
.fish-root{position:fixed;z-index:30;pointer-events:none;user-select:none}
.fish-inner{position:relative;width:var(--fish-w,200px);height:calc(var(--fish-w,200px)*9/16);transform-origin:50% 100%}
.fish-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .16s ease;filter:url(#fish-alpha-fix)}
.fish-video.fish-front{opacity:1}
.fish-hit{position:absolute;inset:0;pointer-events:auto;cursor:grab;z-index:1;touch-action:none;-webkit-user-select:none;-webkit-touch-callout:none}
.fish-hit.fish-drag{cursor:grabbing}
.fish-hit.fish-armed{cursor:crosshair}
.fish-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:10px;padding:6px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .25s ease;color:var(--v2-text-text-base,#e8e8e8);background:color-mix(in srgb,var(--v2-background-bg-layer-02,#2c2c2c) 94%,transparent);box-shadow:0 2px 10px rgb(0 0 0 / .25)}
.fish-bubble.fish-show{opacity:1}
.fish-menu{position:fixed;z-index:40;min-width:132px;padding:4px;border-radius:10px;pointer-events:auto;font-size:13px;background:var(--v2-background-bg-layer-02,#2c2c2c);box-shadow:0 8px 28px rgb(0 0 0 / .35)}
.fish-menu button{display:block;width:100%;padding:7px 12px;border:0;border-radius:7px;background:none;color:var(--v2-text-text-base,#e8e8e8);text-align:left;cursor:pointer;font:inherit}
.fish-menu button:hover{background:var(--v2-background-bg-layer-03,#3c3c3c)}
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
@media (prefers-reduced-motion:reduce){.fish-video{transition:none}.fish-row-pending .d{animation:none}}
:root[data-motion="reduce"] .fish-video{transition:none}
:root[data-motion="reduce"] .fish-row-pending .d{animation:none}
`;

const STATUS_TEXT = {
  thinking: "在忙…",
  working: "干活中…",
  result: "整理中…",
  waiting: "等着你…",
  success: "搞定啦！",
  error: "呜…出错了",
};
const FLAVOR = ["flavor-scared", "flavor-code", "flavor-eat"];
const CLICKS = ["click", "click-happy", "click-shy", "click-tsundere", "click-tickle"];
const WEIGHTS = { idle: 55, turn: 12, move: 13, flavor: 20 };
const SLEEP_REFUSALS = ["我在睡觉，别烦我……", "唔……让我再睡一会儿。", "呼……呼……（装作没听见）"];
const PERSONA = "你是主人桌面上的一只吃白饭的蓝色大肥鱼（Q版小女仆形象），温柔乖巧带点俏皮，爱碎碎念。";
const WHISPER_MARK = "[[fish-whisper]]";
const CUE_MAP = { 写代码: "flavor-code", 吃白饭: "flavor-eat", 被吓一跳: "flavor-scared", 魔方: "walk", 睡觉: "sleep-start" };
const WMO_TEXT = {
  0: "晴", 1: "基本晴", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇",
  51: "毛毛雨", 53: "细雨", 55: "密雨", 61: "小雨", 63: "中雨", 65: "大雨",
  71: "小雪", 73: "中雪", 75: "大雪", 80: "阵雨", 81: "阵雨", 82: "强阵雨", 95: "雷暴", 96: "雷暴+冰雹", 99: "雷暴+冰雹",
};

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


// server 脑契约的纯 JS 拷贝（与插件目录 rpc.ts 同形：id+events 定订阅 type，methods 定调用名）
const FishStateDef = {
  id: "fish-pet",
  methods: {
    state: { input: { type: "object", additionalProperties: false } },
    focus: { input: { type: "object", additionalProperties: false } },
    whisper: { input: { type: "object", additionalProperties: false } },
    say: { input: { type: "object", additionalProperties: false } },
    todoAdd: { input: { type: "object", additionalProperties: false } },
    todoClear: { input: { type: "object", additionalProperties: false } },
    weather: { input: { type: "object", additionalProperties: false } },
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
  const INITIAL = { width: 200, positions: [], todos: [], sessionID: undefined, notify: false };
  if (!Schema || !Store) return { decl: {}, shim: { ...INITIAL, INITIAL } };
  try {
    const Prefs = Schema.Struct({
      width: Schema.Number,
      positions: Schema.Array(Schema.Struct({ x: Schema.Number, y: Schema.Number })),
      todos: Schema.Array(Schema.Struct({ text: Schema.String })),
      sessionID: Schema.optional(Schema.String),
      notify: Schema.optional(Schema.Boolean),
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
        const toIdle = () => playClip("idle", { loop: true });

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
          if (state.dragging || state.busy) return scheduleRoll(4000); // 交互中：短续
          if (shared.work || shared.flash) return scheduleRoll(15000); // 工作期：慢续，链不能死
          if (document.hidden || reduced()) return scheduleRoll(30000);
          const roll = Math.random() * 100;
          if (roll < WEIGHTS.idle) return scheduleRoll();
          if (roll < WEIGHTS.idle + WEIGHTS.turn) {
            state.facing = state.facing === "right" ? "left" : "right";
            applyFacing();
            playClip("turn", { onEnded: toIdle });
            return scheduleRoll();
          }
          if (roll < WEIGHTS.idle + WEIGHTS.turn + WEIGHTS.move) return walkStep();
          playClip(pick(FLAVOR), { onEnded: toIdle });
          scheduleRoll();
        }

        function walkStep() {
          const x0 = state.x;
          const dir = Math.random() < 0.5 ? -1 : 1;
          const x1 = clamp(x0 + dir * (80 + Math.random() * 200), 16, window.innerWidth - stageW() - 16);
          if (Math.abs(x1 - x0) < 40) {
            toIdle();
            return scheduleRoll();
          }
          state.busy = true;
          playClip("walk", {});
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
            if (x < 8) {
              x = 8;
              vx = Math.abs(vx) * rest;
            }
            if (x > window.innerWidth - stageW() - 8) {
              x = window.innerWidth - stageW() - 8;
              vx = -Math.abs(vx) * rest;
            }
            if (y < 8) {
              y = 8;
              vy = Math.abs(vy) * rest * 0.5;
            }
            // 互撞：撞到别的鱼，自己反弹，对方被推开一段
            for (const other of fishes) {
              if (other.f === api) continue;
              const ox = other.f.state.x;
              const oy = other.f.state.y;
              const overlapX = Math.abs(x - ox) < (stageW() + other.f.state.stageW()) / 2;
              const overlapY = Math.abs(y - oy) < (stageH() + 80) / 2;
              if (overlapX && overlapY) {
                if (Math.abs(vx) > Math.abs(vy)) {
                  vx = (x < ox ? -1 : 1) * Math.abs(vx) * rest;
                  other.f.nudge(x < ox ? 14 : -14, 0);
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
          setPos(clamp(state.x + dx, 8, window.innerWidth - stageW() - 8), clamp(state.y + dy, 8, window.innerHeight - stageH() - 8));
        };
        function land() {
          squash();
          state.busy = false;
          if (!state.sleeping && !shared.work && !shared.flash) toIdle();
          scheduleRoll();
        }

        function disarm() {
          state.armed = false;
          hit.classList.remove("fish-armed");
        }

        hit.addEventListener("pointerdown", (e) => {
          if (e.button === 2) return;
          hit.setPointerCapture(e.pointerId);
          state.dragging = true;
          state.gen++;
          cancelAnimationFrame(state.raf);
          clearTimeout(state.rollTimer);
          hit.classList.add("fish-drag");
          if (state.sleeping && state.armed) {
            // 弹弓不叫醒，只是拉开
          } else if (!state.sleeping && state.current !== "drag") {
            playClip("drag", { loop: true });
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
              playClip("click-happy", {});
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
          hit.addEventListener("pointermove", move);
          hit.addEventListener("pointerup", up, { once: true });
          hit.addEventListener("pointercancel", up, { once: true });
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
          playClip(pick(CLICKS), { onEnded: toIdle });
          scheduleRoll();
        }

        // ---------- 睡觉 ----------
        function goSleep() {
          state.sleeping = true;
          hideBubble();
          playClip("sleep-start", { onEnded: () => playClip("sleep-loop", { loop: true }) });
        }
        function wake() {
          if (!state.sleeping) return;
          state.sleeping = false;
          playClip("sleep-end", { onEnded: toIdle });
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
          const item = (label, fn) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.addEventListener("click", () => {
              closeMenu();
              fn();
            });
            menu.appendChild(b);
          };
          item(state.sleeping ? "起来" : "睡觉", () => (state.sleeping ? wake() : goSleep()));
          item("再来一只", () => addFish());
          if (fishes.length > 1) item("收起这只", () => removeFish(api));
          item("换个动作", () => {
            if (state.sleeping) return;
            const names = Object.keys(ASSETS).filter((n) => !n.startsWith("sleep") && !n.startsWith("balance"));
            playClip(pick(names), { onEnded: toIdle });
            scheduleRoll();
          });
          item("开聊", () => {
            reportFocus();
            try {
              ctx.layout.open?.(`${ctx.id}:chat`, ctx.sessions.current?.());
            } catch {
              bubbleOn("聊天面板在会话侧栏里～");
            }
          });
          item("记一笔待办", () => void addTodo());
          item("查天气", () => void fetchWeather(true));
          item("查余额", () => void runBalance(true));
          item("碎碎念一句", () => void whisper({ dream: state.sleeping }));
          item("重置鱼脑", () => {
            void fishRpc?.resetBrain?.({});
            bubbleOn("脑清空啦，下次开口重新开始～", 3500);
          });
          item(prefs.value.notify ? "关完成通知" : "开完成通知", () => {
            prefs.update((d) => {
              d.notify = !d.notify;
            });
            bubbleOn(prefs.value.notify ? "好，我盯着～" : "好，不吵你～");
          });
          item("大一点", () => {
            prefs.update((d) => {
              d.width = clamp(d.width + 20, 120, 360);
            });
            for (const w of fishes) w.f.setSize(prefs.value.width);
          });
          item("小一点", () => {
            prefs.update((d) => {
              d.width = clamp(d.width - 20, 120, 360);
            });
            for (const w of fishes) w.f.setSize(prefs.value.width);
          });
          item("回原位", () => {
            setPos(window.innerWidth - stageW() - 24, 84);
            if (!state.sleeping && !shared.work && !shared.flash) toIdle();
          });
          menu.style.left = clamp(e.clientX, 8, window.innerWidth - 150) + "px";
          menu.style.top = clamp(e.clientY, 8, window.innerHeight - 380) + "px";
          document.body.appendChild(menu);
          document.addEventListener("pointerdown", onMenuAway, true);
          document.addEventListener("keydown", onMenuKey, true);
        });

        const onVisible = () => {
          const v = frontVideo();
          if (document.hidden) v.pause();
          else if (!shared.dead && !state.sleeping && !reduced()) v.play().catch(() => {});
        };
        document.addEventListener("visibilitychange", onVisible);

        const dispose = () => {
          state.gen++;
          clearTimeout(state.rollTimer);
          clearTimeout(state.bubbleTimer);
          cancelAnimationFrame(state.raf);
          closeMenu();
          document.removeEventListener("visibilitychange", onVisible);
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
        playClip("idle", { loop: true });
        scheduleRoll(4000 + Math.random() * 6000);
        return { f: api };
      }

      const addFish = (saved) => {
        if (fishes.length >= 6) return bubbleOn("最多六只啦！");
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
      let lastWeather = undefined;
      let lastNoticeAt = 0;
      let stateTodos = [];
      let fishRpc = null;
      try {
        fishRpc = ctx.client.rpc ? ctx.client.rpc(FishStateDef) : null;
      } catch {
        fishRpc = null;
      }

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
              if (f && !f.state.sleeping && !f.state.dragging && !f.state.busy) {
                f.hideBubble();
                f.play("idle", { loop: true });
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
          if (!f.state.sleeping && !f.state.dragging && !f.state.busy) f.play("work-waiting", { loop: true });
        }
        for (const [idx, b] of binds) {
          const f = fishes[idx]?.f;
          if (!f || now < b.handoff) continue;
          const tier = running.get(b.sid);
          if (tier && tier !== b.tier) {
            if (b.tier !== null && now - b.tierAt < 4000) continue;
            b.tier = tier;
            b.tierAt = now;
            if (!f.state.sleeping && !f.state.dragging && !f.state.busy) f.play("work-" + tier, { loop: true });
          }
        }
      }
      const unboundFishes = () => fishes.filter((w, i) => !binds.has(i));

      const playTierAll = (tier) => {
        for (const w of unboundFishes()) {
          const f = w.f;
          if (f.state.sleeping || f.state.dragging || f.state.busy) continue;
          f.play("work-" + tier, { loop: true });
        }
      };
      const petLifeAll = () => {
        for (const w of unboundFishes()) {
          const f = w.f;
          f.hideBubble();
          if (!f.state.sleeping && !f.state.dragging && !f.state.busy) f.play("idle", { loop: true });
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
            title: kind === "success" ? "搞定啦" : "出错了",
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
        if (Array.isArray(s.todos)) stateTodos = s.todos;
        if (Array.isArray(s.sessions)) syncBindings(s.sessions);
        if (s.notice && s.notice.at > lastNoticeAt) {
          lastNoticeAt = s.notice.at;
          bubbleOn(s.notice.text, 3000);
          // 绑定该会话的鱼自己庆祝/沮丧（不受全局冷却；聚合鱼不重复）
          const entry = [...binds.entries()].find(([, b]) => b.sid === s.notice.sid);
          const fish = entry ? fishes[entry[0]]?.f : undefined;
          if (fish && !fish.state.sleeping && !fish.state.dragging && !fish.state.busy) {
            fish.play("work-" + (s.notice.ok ? "success" : "error"), {});
          }
        }
        if (s.tier !== lastTier) {
          lastTier = s.tier;
          shared.work = s.tier;
          if (s.tier) {
            playTierAll(s.tier);
            bubbleOn(STATUS_TEXT[s.tier]);
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
              if (f.state.sleeping || f.state.dragging) continue;
              f.play("work-" + s.flash, {});
            }
            bubbleOn(STATUS_TEXT[s.flash], 3000);
            notifyFlash(s.flash, s.flashSid, s.flashAt);
          }
        }
        if (s.weather !== undefined && s.weather !== lastWeather) {
          lastWeather = s.weather;
          if (s.weather) bubbleOn("📍" + s.weather, 5000);
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
          .focus({ sessionID: cur?.id ?? null, digest: buildDigest(), sleeping: sleepingAll(), running })
          .then(applyState, () => {});
      };
      later(reportFocus, 1500);
      every(reportFocus, 10000);

      // =========================================================
      // 鱼会话：创建/调度在 server；这里只做回复捕获（气泡+点播）与面板流式
      // =========================================================
      const fishReply = async () => {
        if (!fishSid) return;
        try {
          const res = await ctx.client.message.list({ sessionID: fishSid, order: "desc", limit: 8 });
          const msg = (res.data ?? []).find((m) => m.type === "assistant");
          if (!msg) return;
          if (msg.finish === "error") {
            bubbleOn("模型出岔子了…（右键「重置鱼脑」或在会话里换模型）", 5000);
            for (const view of chatViews) view.refresh?.();
            return;
          }
          const text = textOf(msg).trim();
          if (!text) return;
          const cue = text.match(/\[播放[:：]\s*([^\]]+)\]/);
          const clean = text.replace(/\[播放[:：][^\]]+\]/g, "").trim();
          const f = leadFish();
          if (f) {
            f.bubble(clean.slice(0, 60) || "……", 6000);
            const clip = cue && CUE_MAP[cue[1].trim()];
            if (clip && ASSETS[clip] && !f.state.sleeping) f.play(clip, { onEnded: () => f.play("idle", { loop: true }) });
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
            else if (ev.type === "session.execution.failed") bubbleOn("模型出岔子了…", 4000);
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
      const chatTab = { id: "chat", title: "Fish", pinned: true };
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
          if (f && !f.state.sleeping && !f.state.dragging && !f.state.busy && !shared.work && !shared.flash) {
            f.play("work-thinking", { loop: true });
            fishClipOwned = true;
            busyFish = f;
          }
          busyWatchdog = later(() => setFishBusy(false), 90000); // 完成事件丢失时的兜底收口
        } else if (fishClipOwned) {
          fishClipOwned = false;
          const g = busyFish;
          busyFish = null;
          if (g && !g.state.sleeping && !g.state.dragging && !g.state.busy && !shared.work && !shared.flash) {
            g.play("idle", { loop: true });
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
        input.placeholder = "跟鱼说点什么…";
        const send = document.createElement("button");
        send.textContent = "发送";
        composer.append(input, send);
        wrap.append(list, composer);

        let pendingRow = null;
        const mkPendingRow = () => {
          const row = document.createElement("div");
          row.className = "fish-row fish-row-pending";
          row.append("🐟 正在琢磨 ");
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
            list.replaceChildren(Object.assign(document.createElement("div"), { className: "fish-chat-empty", textContent: "还没开过口～右键鱼「开聊」或直接发消息" }));
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
                  row.textContent = "⚠️ " + (m.error?.message ?? "生成失败");
                } else {
                  row.textContent = textOf(m).slice(0, 500) || "…";
                }
                return row;
              }),
            );
            if (!msgs.length && !fishBusy) list.replaceChildren(Object.assign(document.createElement("div"), { className: "fish-chat-empty", textContent: "（空空如也）" }));
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
          liveRow.textContent = text.slice(-500) + " ▍";
          if (!liveRow.isConnected) list.appendChild(liveRow);
          list.scrollTop = list.scrollHeight;
        }, setBusy: (on) => {
          send.textContent = on ? "…" : "发送";
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
            bubbleOn("面板还没就绪，稍等一下…", 3000);
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
            bubbleOn("发送失败了…（右键鱼「重置鱼脑」再试）", 4000);
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
      // 待办：存 server（跟着 state 走），前端只负责录入与提醒气泡
      // =========================================================
      async function addTodo() {
        try {
          const text = await ctx.dialogs.prompt({ title: "记一笔待办", placeholder: "要记的事…" });
          if (text && text.trim()) {
            void fishRpc?.todoAdd?.({ text: text.trim() });
            bubbleOn("记下啦：" + text.trim().slice(0, 30), 3000);
          }
        } catch {
          /* dialogs 缺席 */
        }
      }
      every(() => {
        if (shared.dead || !stateTodos.length) return;
        leadFish()?.bubble("别忘了：" + pick(stateTodos).slice(0, 30), 4000);
      }, 10 * 60 * 1000);

      // =========================================================
      // 天气：server 侧查（免 key、无 CSP 顾虑），文案经 state 推送
      // =========================================================
      function fetchWeather() {
        void fishRpc?.weather?.({}).catch(() => bubbleOn("天气查不到啦…", 3000));
      }

      // =========================================================
      // 余额六档（options.balance BYO key：deepseek / custom 列表）
      // =========================================================
      function dig(obj, path) {
        return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
      }
      async function runBalance(force) {
        const conf = (ctx.options && ctx.options.balance) || {};
        let worst = -1;
        let report = "";
        try {
          if (conf.deepseek?.apiKey) {
            const res = await fetch("https://api.deepseek.com/user/balance", {
              headers: { Authorization: "Bearer " + conf.deepseek.apiKey },
            });
            const body = await res.json();
            const remaining = Number(body?.balance_infos?.[0]?.total_balance ?? NaN);
            if (!Number.isNaN(remaining)) {
              const total = conf.deepseek.total ?? 50;
              const pct = clamp(100 * (1 - remaining / total), 0, 100);
              worst = Math.max(worst, pct);
              report = `DeepSeek 剩 ${remaining.toFixed(2)} 元`;
            }
          }
          const customs = Array.isArray(conf.custom) ? conf.custom : [];
          for (const c of customs) {
            if (!c?.url) continue;
            const res = await fetch(c.url, { headers: c.headers ?? {} });
            const body = await res.json();
            const remaining = Number(dig(body, c.path ?? ""));
            if (!Number.isNaN(remaining)) {
              const total = c.total ?? 100;
              const pct = clamp(100 * (1 - remaining / total), 0, 100);
              worst = Math.max(worst, pct);
              report = report ? report : `${c.name ?? "自定义"} 剩 ${remaining}`;
            }
          }
        } catch {
          /* 查询失败按无数据处理 */
        }
        if (worst < 0) return bubbleOn("还没给我配余额钥匙～", 3500);
        const idx = worst >= 100 ? 5 : Math.floor(worst / 20);
        const label = ["满溢", "叮当", "如常", "皱眉", "告急", "空了"][idx];
        for (const f of fishes) {
          if (!f.f.state.sleeping) f.f.play("balance-" + idx, { onEnded: () => f.f.play("idle", { loop: true }) });
        }
        bubbleOn(`${report}（${label}）`, 5000);
      }
      every(() => {
        if (!shared.dead && (ctx.options && ctx.options.balance)) void runBalance(false);
      }, 30 * 60 * 1000);

      // =========================================================
      // 对外 API（窗口内 Contract：说/播/读状态；睡着回拒绝台词）
      // =========================================================
      try {
        if (Contract) {
          const FishApi = Contract.define("fish-pet");
          ctx.provide(FishApi, {
            say: (text) => {
              const f = leadFish();
              if (!f) return;
              if (f.state.sleeping) return f.bubble(pick(SLEEP_REFUSALS), 3000);
              f.bubble(String(text).slice(0, 60), 5000);
            },
            play: (name) => {
              if (!ASSETS[name]) return false;
              const f = leadFish();
              if (!f || f.state.sleeping) return false;
              f.play(name, { onEnded: () => f.play("idle", { loop: true }) });
              return true;
            },
            status: () => ({
              fishCount: fishes.length,
              sleeping: fishes.every((f) => f.f.state.sleeping),
              work: shared.work,
              sessionID: fishSid,
            }),
          });
        }
      } catch {
        /* Contract 缺席 */
      }

      // ---------- 启动 ----------
      const saved = prefs.value.positions ?? [];
      const count = clamp(saved.length || 1, 1, 6);
      for (let i = 0; i < count; i++) addFish(saved[i] ?? null);

      // ---------- 挂载 ----------
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
      for (const w of fishes) (fallback ? document.body : fishesHost).appendChild(w.f.root);

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
