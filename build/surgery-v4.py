#!/usr/bin/env python3
"""v4 拼接手术（修正版）：先在原文件上算好全部 span，再一次拼接，防嵌合体。"""
LOGIC = "/tmp/opencode/fish-pet-work/logic.js"
BAK = "/tmp/opencode/fish-pet-work/logic.js.bak-v3"
WORK = "/tmp/opencode/fish-pet-work/"

src = open(BAK).read()
lines = src.split("\n")

def banner_open(marker, search_from=0):
    """marker 注释行的上一个 ===== 行（banner 开边界）。"""
    idx = next(i for i in range(search_from, len(lines)) if marker in lines[i])
    assert "=" * 30 in lines[idx - 1], f"banner missing for {marker!r}: {lines[idx-1]!r}"
    return idx - 1

# (起始 marker, 结束 marker(其 banner 开边界，不含), 替换内容文件) —— 顺序无关：span 全部基于原文件
spans = []
pairs = [
    ("// 工作状态机 v3", "// 鱼会话：创建", "section-brain.js"),
    ("// 鱼会话：创建", "// 事件流：工作状态", "section-fish.js"),
    ("// 事件流：工作状态", "// 对话面板（Panel）", "section-events.js"),
    ("// 待办", "// 天气（ipwho.is", "section-todo.js"),
    ("// 天气（ipwho.is", "// 余额六档", "section-weather.js"),
]
cursor = 0
for m1, m2, fname in pairs:
    start = banner_open(m1, cursor)
    end = banner_open(m2, start + 1)
    spans.append((start, end, open(WORK + fname).read().rstrip("\n")))
    cursor = end

out = []
pos = 0
for start, end, content in spans:
    out.extend(lines[pos:start])
    out.extend(content.split("\n"))
    out.append("")
    pos = end
out.extend(lines[pos:])
src = "\n".join(out)

# 菜单「重置鱼脑」改走 RPC
src = src.replace(
    """          item("重置鱼脑", async () => {
            const sid = prefs.value.sessionID;
            if (sid) {
              try {
                await ctx.client.session.remove?.({ sessionID: sid });
              } catch {
                /* 会话已不存在 */
              }
            }
            prefs.update((d) => {
              d.sessionID = undefined;
            });
            bubbleOn("脑清空啦，下次开口重新开始～", 3500);
          });""",
    """          item("重置鱼脑", () => {
            void fishRpc?.resetBrain?.({});
            bubbleOn("脑清空啦，下次开口重新开始～", 3500);
          });""",
)
assert "resetBrain" in src, "reset-brain menu patch failed"

# 面板 submit 改用 fishSid
src = src.replace(
    """        const submit = async () => {
          const text = input.value.trim();
          if (!text) return;
          input.value = "";
          let sid = prefs.value.sessionID;
          if (!sid) sid = await ensureSession();
          if (!sid) return;
          try {
            await ctx.client.session.prompt({ sessionID: sid, text });
            watchStream(sid);
            void view.refresh();
          } catch {
            prefs.update((d) => {
              d.sessionID = undefined;
            });
          }
        };""",
    """        const submit = async () => {
          const text = input.value.trim();
          if (!text) return;
          input.value = "";
          if (!fishSid) {
            void view.refresh();
            bubbleOn("鱼还没开过口～右键它「碎碎念一句」先叫醒它", 4000);
            return;
          }
          try {
            await ctx.client.session.prompt({ sessionID: fishSid, text });
            watchStream(fishSid);
            void view.refresh();
          } catch {
            void fishRpc?.state?.({}).then(applyState, () => {});
          }
        };""",
)
assert "先叫醒它" in src, "submit patch failed"

# 残余会话 id 读取指向 fishSid（panel refresh / Contract status / shared.fishSid）
src = src.replace("const sid = prefs.value.sessionID;", "const sid = fishSid;")
src = src.replace("sessionID: prefs.value.sessionID ?? null", "sessionID: fishSid")
src = src.replace("        fishSid: () => prefs.value.sessionID,\n", "")

# 模块级：server 契约的纯 JS 拷贝
CONTRACT = """
// server 脑契约的纯 JS 拷贝（与插件目录 rpc.ts 同形：id+events 定订阅 type，methods 定调用名）
const FishStateDef = {
  id: "fish-pet",
  methods: {
    state: { input: { type: "object", additionalProperties: false } },
    focus: { input: { type: "object", additionalProperties: false } },
    whisper: { input: { type: "object", additionalProperties: false } },
    todoAdd: { input: { type: "object", additionalProperties: false } },
    todoClear: { input: { type: "object", additionalProperties: false } },
    weather: { input: { type: "object", additionalProperties: false } },
    resetBrain: { input: { type: "object", additionalProperties: false } },
  },
  events: { state: { schema: { type: "object" } } },
};
"""
src = src.replace("function ensureAlphaFix() {", CONTRACT + "\nfunction ensureAlphaFix() {", 1)

open(LOGIC, "w").write(src)

# 校验：旧机制符号应清零
import re
leftovers = [l for l in src.split("\n") if re.search(r"setWork|clearWork\(\)|hasLease|ensureSession\(\)|prefs\.value\.sessionID|const T = \{", l)]
print("lines:", len(src.split("\n")), "| leftovers:", len(leftovers))
for l in leftovers[:8]:
    print("  LEFT:", l.strip()[:90])
