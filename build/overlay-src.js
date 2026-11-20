// ---- fish-pet 桌外 overlay 页源（build 时拼进 bundle，main() 运行期组装成 HTML）----
// 形态：三段字符串常量（页面 CSS / 页面 JS / preload JS）+ 一个纯组装函数。
// 页面 JS 是 sandbox 页里的普通脚本：只依赖注入的 JSON 数据块与 preload 暴露的 window.fishIpc，
// 不 require、不访问 Node/Electron 主进程对象；凭据与 RPC 全部留在 main。
// 素材：即时子集（idle/turn/sleep/clicks/work/whisper/balance/cueMap）嵌 HTML；完整 109 段由 main
// 经 fish-pet:asset 通道按需推送（页内缓存），避免 36MB 整包重解析与 main 侧大字符串复制。
// 字符串内不出现反引号与 "${"，保证模板字面量安全包裹。

const FISH_OVERLAY_PAGE_CSS = String.raw`
html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden;font-family:system-ui,sans-serif}
body{-webkit-app-region:drag}
.fish-root{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);user-select:none;-webkit-user-select:none}
.fish-inner{position:relative;width:240px;height:135px;transform-origin:50% 100%}
.fish-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0;transition:opacity .16s ease;filter:url(#fish-alpha-fix)}
.fish-video.fish-front{opacity:1}
.fish-hit{position:absolute;inset:0;pointer-events:auto;cursor:grab;touch-action:none;-webkit-app-region:no-drag;-webkit-user-select:none;-webkit-touch-callout:none}
.fish-bubble{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:10px;padding:6px 12px;border-radius:12px;font-size:13px;line-height:1.4;white-space:normal;width:max-content;max-width:330px;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s ease;color:#e8e8e8;background:rgba(44,44,44,.94);box-shadow:0 2px 10px rgba(0,0,0,.25);-webkit-app-region:no-drag}
.fish-bubble.fish-show{opacity:1}
.fish-menu{position:fixed;z-index:40;min-width:132px;max-width:250px;max-height:228px;overflow-y:auto;padding:4px;border-radius:10px;pointer-events:auto;font-size:13px;background:#2c2c2c;box-shadow:0 8px 28px rgba(0,0,0,.35);-webkit-app-region:no-drag}
.fish-menu button{display:block;width:100%;padding:7px 12px;border:0;border-radius:7px;background:none;color:#e8e8e8;text-align:left;cursor:pointer;font:inherit}
.fish-menu button:hover{background:#3c3c3c}
.fish-menu-row{padding:6px 12px;color:#c8c8c8;font-size:12px;line-height:1.4;word-break:break-all}
.fish-menu-row .due{color:#9a9a9a;margin-left:6px}
.fish-menu-input{display:block;width:90%;margin:6px auto;padding:7px 10px;border-radius:7px;border:1px solid #555;background:#222;color:#e8e8e8;font:inherit;font-size:13px}
.fish-menu-input:focus{outline:none;border-color:#3d5a80}
@media (prefers-reduced-motion:reduce){.fish-video{transition:none}}
`;

// 页内文案（三语）：状态标签、完整菜单、气泡反馈。余额整串由 main 组好再推。
const FISH_OVERLAY_PAGE_STR = {
  zh: {
    status: { thinking: "在忙…", working: "干活中…", result: "整理中…", waiting: "等着你…", success: "搞定啦！", error: "呜…出错了" },
    menu: {
      sleep: "睡觉", wake: "起来", randomMove: "换个动作", chat: "开聊", todoAdd: "记一笔待办",
      todoList: "待办列表", todoClear: "清空待办", murmur: "碎碎念一句", balance: "查余额", nameFish: "起个名字",
      resetBrain: "重置鱼脑", notifyOn: "开完成通知", notifyOff: "关完成通知", whisperOn: "开碎碎念", whisperOff: "关碎碎念",
      bigger: "大一点", smaller: "小一点", lang: "语言", back: "返回", ok: "记下", quit: "退出宠物",
    },
    bubbles: {
      chatFallback: "聊天面板在会话侧栏里～", replyErrorShort: "模型出岔子了…",
      sleepRefusals: ["我在睡觉，别烦我……", "唔……让我再睡一会儿。", "呼……呼……（装作没听见）"],
      nameSet: "以后就叫「{n}」啦～", nameFailed: "名字没存上…（再试一次？）",
      resetDone: "脑清空啦，下次开口重新开始～", resetFailed: "没清成…（稍后再试试）",
      notifyOn: "好，我盯着～", notifyOff: "好，不吵你～", whisperOn: "好，我会偶尔唠叨～", whisperOff: "好，安静待着～",
      todoDone: "记下啦：", todoClearDone: "待办清空啦～", todoEmpty: "还没有待办～",
      actionFailed: "没存上…（稍后再试试）", promptNoWindow: "没找到能打字的窗口…（先开一个 OpenCode 窗口？）",
    },
    todo: { title: "记一笔待办", placeholder: "要记的事…（可加 @2h）" },
    name: { title: "起个名字", placeholder: "叫它什么…" },
  },
  en: {
    status: { thinking: "Busy…", working: "Working…", result: "Wrapping up…", waiting: "Waiting…", success: "Done!", error: "Oops…" },
    menu: {
      sleep: "Sleep", wake: "Wake up", randomMove: "Another move", chat: "Let's chat", todoAdd: "Add a to-do",
      todoList: "To-do list", todoClear: "Clear to-dos", murmur: "Say something", balance: "Check balance", nameFish: "Name the fish",
      resetBrain: "Reset brain", notifyOn: "Turn notifications on", notifyOff: "Turn notifications off", whisperOn: "Turn muttering on", whisperOff: "Turn muttering off",
      bigger: "Bigger", smaller: "Smaller", lang: "Language", back: "Back", ok: "Save", quit: "Quit pet",
    },
    bubbles: {
      chatFallback: "The chat panel lives in the session sidebar~", replyErrorShort: "Model hiccup…",
      sleepRefusals: ["Zzz… don't bug me…", "Mmm… five more minutes…", "Snore… snore… (pretending not to hear)"],
      nameSet: '"{n}" it is~', nameFailed: "The name didn't stick… (try again?)",
      resetDone: "Brain wiped — fresh start next time~", resetFailed: "Couldn't reset… (try again in a bit)",
      notifyOn: "Okay, I'll keep watch~", notifyOff: "Okay, I'll stay quiet~", whisperOn: "Okay, I'll chatter now and then~", whisperOff: "Okay, staying quiet~",
      todoDone: "Noted: ", todoClearDone: "To-dos cleared~", todoEmpty: "Nothing on the list yet~",
      actionFailed: "Didn't go through… (try again in a bit)", promptNoWindow: "No window to type in… (open an OpenCode window first?)",
    },
    todo: { title: "Add a to-do", placeholder: "What to remember… (optional @2h)" },
    name: { title: "Name the fish", placeholder: "What should we call it?" },
  },
  ja: {
    status: { thinking: "考え中…", working: "お仕事中…", result: "まとめ中…", waiting: "待ってるよ…", success: "できた！", error: "うう…エラー" },
    menu: {
      sleep: "寝る", wake: "起きる", randomMove: "別の動き", chat: "おしゃべり", todoAdd: "todoを追加",
      todoList: "todoリスト", todoClear: "todoを全消し", murmur: "ひとこと", balance: "残高チェック", nameFish: "名前をつける",
      resetBrain: "脳をリセット", notifyOn: "通知をつける", notifyOff: "通知をけす", whisperOn: "ひとことオン", whisperOff: "ひとことオフ",
      bigger: "大きく", smaller: "小さく", lang: "言語", back: "戻る", ok: "メモ", quit: "ペットをやめる",
    },
    bubbles: {
      chatFallback: "チャットパネルはセッションのサイドバーにあるよ〜", replyErrorShort: "モデルがミスしたみたい…",
      sleepRefusals: ["睡眠中なの…起こさないで…", "んー…あと5分…", "くー…くー…（聞こえてないふり）"],
      nameSet: "「{n}」だね〜", nameFailed: "名前が保存されなかった…（もう一度？）",
      resetDone: "脳を空にしたよ〜次は最初から〜", resetFailed: "リセットできなかった…（また後で）",
      notifyOn: "うん、見てるよ〜", notifyOff: "うん、静かにするね〜", whisperOn: "うん、たまに喋るね〜", whisperOff: "うん、静かにしてるね〜",
      todoDone: "メモした：", todoClearDone: "todoを空にしたよ〜", todoEmpty: "todoはまだないよ〜",
      actionFailed: "保存できなかった…（また後で）", promptNoWindow: "タイプできる窓がないよ…（先に OpenCode の窓を開く？）",
    },
    todo: { title: "todoを追加", placeholder: "覚えておくこと…（@2h 可）" },
    name: { title: "名前をつける", placeholder: "なんて呼ぶ？" },
  },
};
const FISH_OVERLAY_LANG_NAMES = { zh: "中文", en: "English", ja: "日本語" };

// 页面脚本：单鱼舞台（双 video 换源 + gen 防竞态，与窗口版同机制）+ 睡觉链 + 自主随机 roll +
// 完整菜单（睡觉/动作/开聊/待办列表与录入/碎碎念/余额/起名/重置/通知与总开关/大小/语言）+
// 状态应用（tier/flash/notice/murmur/balance/chatBusy/contract/开关与尺寸）。
// 拖拽：Linux/Wayland 交给 WM（body app-region:drag + Sway $mod）；win32 由页内 pointer capture
// 跟踪并经受限 IPC 发位移量，main 用 setPosition 移动（win32 下可靠）。不涉及甩出/重力。
const FISH_OVERLAY_PAGE_JS = String.raw`
"use strict";
(function () {
  var D = JSON.parse(document.getElementById("fish-data").textContent);
  var POOLS = D.pools, A = D.assets, STR = D.str, SND = D.sound;
  var lang = typeof D.lang === "string" && STR[D.lang] ? D.lang : "en";
  var T = function () { return STR[lang] || STR.en; };
  window.__fishPokes = 0;

  // alpha 修正滤镜（与窗口版同款：把近透明的 VP9 边缘拉成完全透明）
  if (!document.getElementById("fish-alpha-fix")) {
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", "0"); svg.setAttribute("height", "0");
    svg.style.position = "absolute";
    var filter = document.createElementNS("http://www.w3.org/2000/svg", "filter");
    filter.id = "fish-alpha-fix";
    var transfer = document.createElementNS("http://www.w3.org/2000/svg", "feComponentTransfer");
    var funcA = document.createElementNS("http://www.w3.org/2000/svg", "feFuncA");
    funcA.setAttribute("type", "linear");
    funcA.setAttribute("slope", String(255 / 254));
    funcA.setAttribute("intercept", String(-1 / 255));
    transfer.appendChild(funcA); filter.appendChild(transfer); svg.appendChild(filter);
    document.body.appendChild(svg);
  }

  var root = document.createElement("div"); root.className = "fish-root";
  var inner = document.createElement("div"); inner.className = "fish-inner";
  var videoA = document.createElement("video"), videoB = document.createElement("video");
  var videos = [videoA, videoB];
  for (var vi = 0; vi < videos.length; vi++) {
    videos[vi].className = "fish-video"; videos[vi].muted = true; videos[vi].playsInline = true; videos[vi].preload = "auto";
  }
  var hit = document.createElement("div"); hit.className = "fish-hit";
  var bubbleEl = document.createElement("div"); bubbleEl.className = "fish-bubble";
  inner.append(videoA, videoB, hit, bubbleEl);
  root.appendChild(inner);
  document.body.appendChild(root);

  var front = 0, gen = 0, bubbleTimer = 0, rollTimer = 0, facing = "right";
  var S = {
    tier: null, flash: null, sleeping: false, chatBusy: false,
    whisper: true, notify: false, width: 200, todos: [],
    lastNoticeAt: 0, lastMurmurAt: 0, lastBalanceAt: 0, lastChatFailAt: 0,
    lastContractAt: 0, lastNameAt: 0, lastResetAt: 0, lastActionAt: 0,
  };

  function bubble(text, ms) {
    bubbleEl.textContent = String(text == null ? "" : text);
    bubbleEl.classList.add("fish-show");
    clampBubble();
    clearTimeout(bubbleTimer);
    if (ms) bubbleTimer = setTimeout(function () { bubbleEl.classList.remove("fish-show"); }, ms);
  }
  function hideBubble() { clearTimeout(bubbleTimer); bubbleEl.classList.remove("fish-show"); }
  // 多行气泡在「高舞台 + 固定 240 高窗」下会顶出窗沿被裁：装订前先量高度，
  // 顶部余量不足 4px 时把气泡沿舞台下移（最多贴到鱼头前），保证整条气泡留在窗内。
  function clampBubble() {
    bubbleEl.style.bottom = ""; // 回到 CSS 基线（bottom:100% + margin 10）再量
    var h = inner.offsetHeight || 0;
    var bh = bubbleEl.offsetHeight || 0;
    if (!bh) return;
    var top = window.innerHeight - 20 - h - bh; // 气泡顶缘页面 y：窗高-根底10-气泡间距10-舞台高-气泡高
    // 不够放时改用 px 装订：注意 margin-bottom:10 仍会生效，因此目标值多扣 10（顶缘留 4px 余量）
    if (top < 4) bubbleEl.style.bottom = Math.max(0, window.innerHeight - 24 - bh) + "px";
  }

  function applyFacing() {
    var t = facing === "left" ? "scaleX(-1)" : "";
    videos[0].style.transform = t;
    videos[1].style.transform = t;
  }
  function setSize(w) {
    var c = Math.max(120, Math.min(320, Math.round(w) || 200)); // 桌外窗固定 360 宽：舞台封顶 320
    inner.style.width = c + "px";
    inner.style.height = Math.round(c * 9 / 16) + "px";
    clampBubble(); // 舞台变高时，已显示的气泡可能需要重新装订
  }

  function play(name, opts) {
    opts = opts || {};
    if (!A[name]) { tryRequestAsset(name); return false; } // 未缓存：向 main 请求，本轮落空下轮 roll 重试
    gen++;
    var myGen = gen;
    var back = videos[front ^ 1];
    back.loop = !!opts.loop;
    back.src = A[name];
    window.__fishClip = name;
    var swapped = false;
    var swap = function () {
      if (myGen !== gen || swapped) return;
      swapped = true;
      back.classList.add("fish-front");
      videos[front].classList.remove("fish-front");
      front ^= 1;
      var f = videos[front];
      f.play().catch(function () {});
      if (!opts.loop && opts.onEnded) {
        f.addEventListener("ended", function () { if (myGen === gen) opts.onEnded(); }, { once: true });
      }
    };
    back.addEventListener("canplay", swap, { once: true });
    setTimeout(swap, 900);
    return true;
  }
  var workClip = function (t) { return POOLS.work[({ thinking: 0, working: 1, result: 2, waiting: 3, success: 4, error: 5 })[t] || 0]; };
  var stateClip = function () { return S.tier ? workClip(S.tier) : POOLS.names.idle; };
  var toState = function () { if (!S.sleeping) play(stateClip(), { loop: true }); };
  var pick = function (pool) { return pool[Math.floor(Math.random() * pool.length)]; };

  // ---- 素材按需通道：roll/点播可命中尚未预热的片段，请求后由 onAsset 缓存 ----
  var pendingAssets = {};
  function tryRequestAsset(name) {
    if (!name || A[name] || pendingAssets[name]) return;
    pendingAssets[name] = true;
    try { fishIpc.send("asset", name); } catch (e) {}
  }

  // ---- 自主随机动作（窗口版 rollNext 同规则；move 无位移物理并入 idle；noMirror 朝左不抽文字池）----
  function scheduleRoll(delay) {
    clearTimeout(rollTimer);
    rollTimer = setTimeout(rollNext, delay == null ? 7000 + Math.random() * 8000 : delay);
  }
  function rollNext() {
    if (S.sleeping) return; // 睡觉链由 wake() 重排
    if (dragActive) return scheduleRoll(15000); // Windows 拖动期间不让随机动作抢拖拽片
    if (S.chatBusy || S.tier || S.flash) return scheduleRoll(15000); // 会话/工作期：链不能死，慢续
    var W = POOLS.weights;
    var roll = Math.random() * 100;
    var idleW = W.idle + (W.move || 0); // move 并入 idle：桌外无行走物理
    if (roll < idleW) return scheduleRoll();
    if (roll < idleW + W.turn) {
      facing = facing === "right" ? "left" : "right";
      applyFacing();
      play(POOLS.names.turn, { onEnded: toState });
      return scheduleRoll();
    }
    var cats = POOLS.categories.filter(function (c) { return !(c.noMirror && facing === "left"); });
    var total = 0;
    for (var i = 0; i < cats.length; i++) total += cats[i].weight;
    var r = Math.random() * total;
    for (var j = 0; j < cats.length; j++) {
      r -= cats[j].weight;
      if (r <= 0) { play(pick(cats[j].actions), { onEnded: toState }); break; }
    }
    scheduleRoll();
  }

  // ---- 点击：睡着先叫醒（窗口版同规则）；音效+点击池 ----
  function squash() {
    inner.style.transform = "scale(1.12,0.88)";
    setTimeout(function () { inner.style.transform = ""; }, 150);
  }
  var clickAudio = null;
  function poke() {
    squash();
    window.__fishPokes++;
    try {
      clickAudio = clickAudio || new Audio(SND);
      clickAudio.currentTime = 0;
      clickAudio.play().catch(function () {});
    } catch (e) {}
    play(pick(POOLS.clicks), { onEnded: toState });
  }

  // ---- win32 拖动：renderer 只报手势（dragStart/dragEnd/dragCancel），位移零 IPC ----
  // main 以 screen.getCursorScreenPoint() 为锚全程 DIP 跟随 + 惯性物理（mixed DPI 安全）。
  // 页面保留 pointer capture、5px 点击阈值与释放点 poke；拖动视觉片本地播；
  // 落地由 main 经固定白名单通道 fish-pet:motion {kind:"land"} 通知 squash/toState。
  // endDrag 幂等：统一摘除 move/up/cancel/lostpointercapture 四监听并 release capture。
  var dragEnabled = D.drag === true; // main 注入：仅 win32 为 true
  var dragActive = false;
  var dragMoved = false;
  var dragStartX = 0, dragStartY = 0;
  var dragPointerId = 0;
  var DRAG_THRESHOLD = 5;
  var reduced = function () { return matchMedia("(prefers-reduced-motion: reduce)").matches; };
  function endDrag(kind) {
    if (!dragActive) return; // 幂等：up→lostpointercapture 等重复终态直接返回
    dragActive = false;
    hit.removeEventListener("pointermove", dragMove);
    hit.removeEventListener("pointerup", dragUp);
    hit.removeEventListener("pointercancel", dragCancel);
    hit.removeEventListener("lostpointercapture", dragLost);
    try { hit.releasePointerCapture(dragPointerId); } catch (e) {}
    if (kind === "cancel") {
      try { fishIpc.send("dragCancel"); } catch (e) {}
      toState(); // 收摊：回状态片（main 不飞、也不再发 land）
    } else if (kind === "click") {
      // 手势分类归页面：单击显式上报 'click'，main 仅收摊不 land（不打断 poke 视觉）
      try { fishIpc.send("dragEnd", "click"); } catch (e) {}
      poke();
    } else {
      // 拖动释放（boolean reduced）：main 以速度门判飞/落；mixed DPI 下即便 main 侧状态缺失，
      // 非 click 的 dragEnd 也必须换来 land，页面才能收掉 drag 片
      try { fishIpc.send("dragEnd", reduced()); } catch (e) {}
    }
  }
  function dragMove(e) {
    if (!dragActive) return;
    // 只判阈值（screen 系不受窗口移动影响）；不发任何位移；首次过阈值才播拖拽片，单击不闪帧
    if (!dragMoved && Math.abs(e.screenX - dragStartX) + Math.abs(e.screenY - dragStartY) >= DRAG_THRESHOLD) {
      dragMoved = true;
      if (POOLS.names.drag) play(POOLS.names.drag, { loop: true });
    }
  }
  function dragUp() {
    endDrag(dragMoved ? "release" : "click");
  }
  function dragCancel() { endDrag("cancel"); }
  function dragLost() { endDrag("cancel"); }
  function startDrag(e) {
    dragActive = true;
    dragMoved = false;
    dragStartX = e.screenX;
    dragStartY = e.screenY;
    dragPointerId = e.pointerId;
    try { hit.setPointerCapture(e.pointerId); } catch (ex) { dragActive = false; return; }
    try { fishIpc.send("dragStart"); } catch (ex) {}
    hit.addEventListener("pointermove", dragMove);
    hit.addEventListener("pointerup", dragUp);
    hit.addEventListener("pointercancel", dragCancel);
    hit.addEventListener("lostpointercapture", dragLost);
  }

  hit.addEventListener("pointerdown", function (e) {
    if (e.button === 2) return;
    closeMenu();
    // win32：按下进入跟踪，释放点决定 poke/拖动；睡着照旧唤醒不跟踪；非 win32 原行为不变
    if (dragEnabled && !S.sleeping) return startDrag(e);
    if (S.sleeping) return wake();
    poke();
  });

  // ---- 睡觉链：睡觉-开始 → 睡觉-循环；起来 → 回状态片。睡眠是桌外身体的唯一来源， ----
  // ---- 经 cmd sleep 通知 main → presence 心跳 → server 梦话门控（Web focus 抢不走） ----
  function goSleep() {
    if (S.sleeping) return;
    S.sleeping = true;
    hideBubble();
    play(POOLS.sleep[0], { onEnded: function () { if (S.sleeping) play(POOLS.sleep[1], { loop: true }); } });
    try { fishIpc.send("sleep", true); } catch (e) {}
  }
  function wake() {
    if (!S.sleeping) return;
    S.sleeping = false;
    play(POOLS.sleep[2], { onEnded: toState });
    scheduleRoll(4000 + Math.random() * 4000);
    try { fishIpc.send("sleep", false); } catch (e) {}
  }

  // ---- 右键菜单：主页/语言页/待办列表页/待办录入页/起名页 ----
  var menu = null;
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    document.removeEventListener("pointerdown", onMenuAway, true);
  }
  var onMenuAway = function (e) { if (menu && !menu.contains(e.target)) closeMenu(); };
  function appendItem(label, fn, cls) {
    var b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener("click", fn);
    menu.appendChild(b);
    return b;
  }
  function appendRow(text, due) {
    var d = document.createElement("div");
    d.className = "fish-menu-row";
    d.textContent = String(text || "");
    if (due) {
      var s = document.createElement("span");
      s.className = "due";
      var dt = new Date(due);
      s.textContent = "@" + (dt.getMonth() + 1) + "-" + dt.getDate() + " " + String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      d.appendChild(s);
    }
    menu.appendChild(d);
    return d;
  }
  function placeMenu(e) {
    var mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, e.clientX)) + "px";
    menu.style.top = Math.max(8, Math.min(window.innerHeight - mh - 8, e.clientY - mh)) + "px";
  }
  function buildMainPage(e) {
    menu.replaceChildren();
    appendItem(S.sleeping ? T().menu.wake : T().menu.sleep, function () { closeMenu(); if (S.sleeping) wake(); else goSleep(); });
    appendItem(T().menu.randomMove, function () {
      closeMenu();
      if (S.sleeping) return;
      var cats = POOLS.categories.filter(function (c) { return !(c.noMirror && facing === "left"); });
      var names = [];
      for (var i = 0; i < cats.length; i++) names = names.concat(cats[i].actions);
      names = names.concat(POOLS.clicks);
      play(pick(names), { onEnded: toState });
      scheduleRoll();
    });
    appendItem(T().menu.chat, function () { closeMenu(); try { fishIpc.send("chat"); } catch (err) {} });
    // 文本录入不在不可聚焦小窗内收键盘：路由到聚焦 OpenCode 窗口的宿主 dialog，结果经 Ipc 回 main
    appendItem(T().menu.todoAdd, function () { closeMenu(); try { fishIpc.send("todoAdd"); } catch (err) {} });
    appendItem(T().menu.todoList, function () { buildTodoListPage(e); });
    appendItem(T().menu.murmur, function () { closeMenu(); try { fishIpc.send("murmur"); } catch (err) {} });
    appendItem(T().menu.balance, function () { closeMenu(); try { fishIpc.send("balance"); } catch (err) {} });
    appendItem(T().menu.nameFish, function () { closeMenu(); try { fishIpc.send("name"); } catch (err) {} });
    appendItem(T().menu.resetBrain, function () {
      closeMenu();
      try { fishIpc.send("reset"); } catch (err) {}
    });
    // 开关改发真实 next 值；气泡只在 actionResult 真实回包后显示
    appendItem(S.notify ? T().menu.notifyOff : T().menu.notifyOn, function () {
      closeMenu();
      try { fishIpc.send("notify", !S.notify); } catch (err) {}
    });
    appendItem(S.whisper === false ? T().menu.whisperOn : T().menu.whisperOff, function () {
      closeMenu();
      try { fishIpc.send("murmurGate", S.whisper === false); } catch (err) {}
    });
    // 大一点：舞台视觉封顶 320（与 setSize 同钳制）——已达上限直接不给可点的无效入口
    var cw = Math.max(120, Math.min(320, Math.round(S.width) || 200));
    if (cw < 320) appendItem(T().menu.bigger, function () { closeMenu(); try { fishIpc.send("bigger"); } catch (err) {} });
    appendItem(T().menu.smaller, function () { closeMenu(); try { fishIpc.send("smaller"); } catch (err) {} });
    appendItem(T().menu.quit, function () { closeMenu(); try { fishIpc.send("quit"); } catch (err) {} });
    appendItem(T().menu.lang, function () { buildLangPage(e); });
    placeMenu(e);
  }
  function buildLangPage(e) {
    menu.replaceChildren();
    appendItem("← " + T().menu.back, function () { buildMainPage(e); });
    for (var i = 0; i < D.langs.length; i++) {
      (function (code) {
        appendItem((code === lang ? "✓ " : "") + (D.langNames[code] || code), function () {
          closeMenu();
          try { fishIpc.send("lang", code); } catch (err) {}
        });
      })(D.langs[i]);
    }
    placeMenu(e);
  }
  function buildTodoListPage(e) {
    menu.replaceChildren();
    appendItem("← " + T().menu.back, function () { buildMainPage(e); });
    if (!S.todos.length) appendRow(T().bubbles.todoEmpty);
    for (var i = 0; i < S.todos.length; i++) appendRow(S.todos[i].text, S.todos[i].dueAt);
    if (S.todos.length) {
      appendItem(T().menu.todoClear, function () {
        closeMenu();
        try { fishIpc.send("todoClear"); } catch (err) {}
      });
    }
    placeMenu(e);
  }
  hit.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    closeMenu();
    menu = document.createElement("div"); menu.className = "fish-menu";
    document.body.appendChild(menu);
    buildMainPage(e);
    document.addEventListener("pointerdown", onMenuAway, true);
  });

  // ---- 状态应用：tier/flash 先落地，一次性通道最后播；睡觉时只留气泡不打断睡觉链；
  // 拖动中同理只更新数据与气泡，播片/toState 不抢 names.drag 循环片（land 后按最新状态恢复） ----
  function apply(s) {
    if (!s) return;
    if (typeof s.lang === "string" && STR[s.lang]) lang = s.lang;
    if (typeof s.whisper === "boolean") S.whisper = s.whisper;
    window.__fishWhisper = S.whisper;
    if (typeof s.notify === "boolean") S.notify = s.notify;
    if (typeof s.width === "number" && s.width !== S.width) { S.width = s.width; setSize(s.width); }
    if (Array.isArray(s.todos)) S.todos = s.todos;
    if (s.tier !== S.tier) {
      S.tier = s.tier;
      if (s.tier) {
        if (!S.sleeping && !dragActive) play(workClip(s.tier), { loop: true });
        bubble(s.tier === "working" && s.tool ? T().status[s.tier] + " · " + s.tool : T().status[s.tier]);
      } else {
        if (!S.sleeping && !dragActive) toState();
        if (!s.chatBusy) hideBubble();
      }
    }
    if (s.flash !== S.flash) {
      S.flash = s.flash;
      if (s.flash) {
        if (!S.sleeping && !dragActive) play(workClip(s.flash), { onEnded: toState });
        bubble(T().status[s.flash], 3000);
      } else if (!S.sleeping && !dragActive) toState();
    }
    if (s.chatBusy !== S.chatBusy) {
      S.chatBusy = !!s.chatBusy;
      if (S.chatBusy) {
        if (!S.tier && !S.flash && !S.sleeping && !dragActive) play(workClip("thinking"), { loop: true });
      } else if (!S.sleeping && !dragActive) toState();
    }
    if (s.notice && s.notice.at > S.lastNoticeAt) { S.lastNoticeAt = s.notice.at; bubble(s.notice.text, 3200); }
    if (s.chatFail && s.chatFail.at > S.lastChatFailAt) { S.lastChatFailAt = s.chatFail.at; bubble(T().bubbles.chatFallback, 3500); }
    if (s.murmur && s.murmur.at > S.lastMurmurAt) {
      S.lastMurmurAt = s.murmur.at;
      if (s.murmur.error) bubble(T().bubbles.replyErrorShort, 4000);
      else {
        bubble((s.murmur.text || "……").slice(0, 60) || "……", 6000);
        var cue = (s.murmur.cue && A[s.murmur.cue]) ? s.murmur.cue : pick(POOLS.whisper);
        if (!S.sleeping && !dragActive) play(cue, { onEnded: toState });
      }
    }
    if (s.balance && s.balance.at > S.lastBalanceAt) {
      S.lastBalanceAt = s.balance.at;
      bubble(s.balance.text, 5000);
      var bi = Math.max(0, Math.min(5, s.balance.idx | 0));
      if (!S.sleeping && !dragActive && A[POOLS.balance[bi]]) play(POOLS.balance[bi], { onEnded: toState });
    }
    if (s.contractSay && s.contractSay.at > S.lastContractAt) {
      S.lastContractAt = s.contractSay.at;
      if (S.sleeping) bubble(pick(T().bubbles.sleepRefusals), 3000);
      else bubble(String(s.contractSay.text || "").slice(0, 60), 5000);
    }
    if (s.contractPlay && s.contractPlay.at > S.lastContractAt) {
      S.lastContractAt = s.contractPlay.at;
      if (!S.sleeping && !dragActive && A[s.contractPlay.name]) play(s.contractPlay.name, { onEnded: toState });
    }
    if (s.nameResult && s.nameResult.at > S.lastNameAt) {
      S.lastNameAt = s.nameResult.at;
      bubble(s.nameResult.ok ? T().bubbles.nameSet.replace("{n}", s.nameResult.name || "?") : T().bubbles.nameFailed, 4000);
    }
    if (s.resetResult && s.resetResult.at > S.lastResetAt) {
      S.lastResetAt = s.resetResult.at;
      bubble(s.resetResult.ok ? T().bubbles.resetDone : T().bubbles.resetFailed, s.resetResult.ok ? 3500 : 4000);
    }
    // 统一 actionResult：todo/开关只在真实 RPC 回包后给反馈，失败明确提示（无乐观假成功）
    if (s.actionResult && s.actionResult.at > S.lastActionAt) {
      S.lastActionAt = s.actionResult.at;
      var ar = s.actionResult;
      if (!ar.ok) {
        bubble(ar.kind === "prompt" ? T().bubbles.promptNoWindow : T().bubbles.actionFailed, 4000);
      } else if (ar.kind === "todoAdd") {
        bubble(T().bubbles.todoDone + String(ar.value || "").slice(0, 30), 3000);
      } else if (ar.kind === "todoClear") {
        bubble(T().bubbles.todoClearDone, 3000);
      } else if (ar.kind === "notify") {
        bubble(ar.value ? T().bubbles.notifyOn : T().bubbles.notifyOff);
      } else if (ar.kind === "whisper") {
        bubble(ar.value ? T().bubbles.whisperOn : T().bubbles.whisperOff);
      }
      // width 成功无声（视觉即反馈），失败走 actionFailed 已在上面
    }
  }

  applyFacing();
  setSize(D.width || 200);
  toState();
  scheduleRoll(4000 + Math.random() * 6000);
  if (window.fishIpc) {
    fishIpc.onState(apply);
    if (fishIpc.onAsset) {
      fishIpc.onAsset(function (a) {
        if (a && typeof a.name === "string" && typeof a.data === "string") {
          A[a.name] = a.data;
          delete pendingAssets[a.name];
        }
      });
    }
    if (fishIpc.onMotion) {
      // win32 惯性落点（慢释放 settle 与物理落地同走 land）：squash + 回状态片
      fishIpc.onMotion(function (mo) {
        if (mo && mo.kind === "land") { squash(); toState(); }
      });
    }
  }
})();
`;

// preload（sandbox 只允许 require("electron") 的 contextBridge/ipcRenderer）：
// 页面可收 state / asset 推送，可发白名单 cmd；value 放宽为 string(≤200 无控制字符)/boolean/number，
// 语义与长度边界由 main 逐 cmd 校验；<> 在文本值中合法（页面渲染走 textContent，无 XSS 面）。
const FISH_OVERLAY_PRELOAD_JS = String.raw`
"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("fishIpc", {
  onState: function (cb) {
    ipcRenderer.on("fish-pet:state", function (_e, s) { cb(s); });
  },
  onAsset: function (cb) {
    ipcRenderer.on("fish-pet:asset", function (_e, a) { cb(a); });
  },
  onMotion: function (cb) {
    // 固定白名单通道：main 仅推 {kind:"land"} 一类手势终态通知，不开放通用 IPC
    ipcRenderer.on("fish-pet:motion", function (_e, mo) { cb(mo); });
  },
  send: function (cmd, value) {
    if (typeof cmd !== "string" || !/^[a-zA-Z]+$/.test(cmd)) return; // cmd 白名单含大写（todoAdd/murmurGate）；语义由 main 逐 cmd 校验
    if (value !== undefined) {
      if (typeof value === "string") {
        if (value.length > 200 || /[\x00-\x1f]/.test(value)) return; // 只拦控制字符/超长：中文 asset 名合法；drag 等格式由 main 逐 cmd 严格校验
      } else if (typeof value === "boolean") {
        /* ok */
      } else if (typeof value === "number") {
        if (!Number.isFinite(value)) return;
      } else return;
    }
    ipcRenderer.send("fish-pet:cmd", { cmd: cmd, value: value });
  },
});
`;

// 组装 overlay HTML：即时子集（idle/turn/sleep/clicks/work/whisper/balance/cueMap）嵌数据块，
// 完整包剩余素材由 main 经 fish-pet:asset 预热推送（页内缓存，roll 未命中时也会按需请求）。
// 纯函数：离线测试用同一入口生成同一份 HTML。
function composeOverlayHtml(assets, pools, clickSound, initialLang, initialWidth, initialDrag) {
  const need = [];
  const add = (name) => {
    if (typeof name === "string" && name && assets[name] && !need.includes(name)) need.push(name);
  };
  add(pools.names && pools.names.idle);
  add(pools.names && pools.names.turn);
  add(pools.names && pools.names.drag); // win32 拖动视觉片随子集嵌入
  (pools.sleep || []).forEach(add);
  (pools.clicks || []).forEach(add);
  (pools.work || []).forEach(add);
  (pools.whisper || []).forEach(add);
  (pools.balance || []).forEach(add);
  Object.values(pools.cueMap || {}).forEach(add);
  const subset = {};
  for (const name of need) subset[name] = assets[name];
  const data = {
    pools: {
      names: { idle: pools.names && pools.names.idle, turn: pools.names && pools.names.turn, drag: pools.names && pools.names.drag },
      clicks: pools.clicks || [],
      work: pools.work || [],
      whisper: pools.whisper || [],
      balance: pools.balance || [],
      sleep: pools.sleep || [],
      weights: pools.weights || { idle: 10, turn: 5, move: 5 },
      categories: pools.categories || [],
    },
    assets: subset,
    sound: clickSound,
    str: FISH_OVERLAY_PAGE_STR,
    lang: FISH_OVERLAY_PAGE_STR[initialLang] ? initialLang : "en",
    langs: ["zh", "en", "ja"],
    langNames: FISH_OVERLAY_LANG_NAMES,
    width: typeof initialWidth === "number" ? initialWidth : 200,
    drag: initialDrag === true,
  };
  const json = JSON.stringify(data).replace(/<\//g, "<\\/");
  return {
    html:
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      FISH_OVERLAY_PAGE_CSS +
      '</style></head><body><script type="application/json" id="fish-data">' +
      json +
      "</script><script>" +
      FISH_OVERLAY_PAGE_JS +
      "</script></body></html>",
    clips: need,
  };
}
