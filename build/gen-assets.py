#!/usr/bin/env python3
"""fish-pet asset generator: 27 curated VP9-alpha webm + duck click sound -> base64 data URI constants (head.js)."""
import base64, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "head.js")
CLIPS = ["idle","turn","drag","walk","click","click-happy","click-shy","click-tsundere","click-tickle",
         "work-thinking","work-working","work-result","work-waiting","work-success","work-error",
         "sleep-start","sleep-loop","sleep-end","flavor-scared","flavor-code","flavor-eat",
         "balance-0","balance-1","balance-2","balance-3","balance-4","balance-5"]

parts = []
total = 0
for name in CLIPS:
    path = os.path.join(SRC, name + ".webm")
    raw = open(path, "rb").read()
    total += len(raw)
    parts.append(f'  "{name}": "data:video/webm;base64,{base64.b64encode(raw).decode()}"')

sound = base64.b64encode(open(os.path.join(SRC, "click-duck.wav"), "rb").read()).decode()

with open(OUT, "w") as f:
    f.write('"use strict";\n')
    f.write("// fish-pet —— 窗口内大肥鱼桌宠（port 自 dsh-pet；素材源自 dsh-pet，禁止商用；公开分发须署名 https://github.com/PC2005-cloud/dsh-pet，详见 LICENSE）\n")
    f.write("// 形态：GUI-only 渲染器插件（Style + Slot window.bottom + 裸 DOM 兜底），无 main 导出、不声明 os\n")
    f.write("// 资产：27 段 480x270 VP9-alpha WebM 重编码（libvpx 解码保 alpha，CRF 42）\n\n")
    f.write("const ASSETS = {\n" + ",\n".join(parts) + "\n};\n\n")
    f.write(f'const CLICK_SOUND = "data:audio/wav;base64,{sound}";\n\n')

print(f"head.js written: {len(CLIPS)} clips + sound, raw {total/1048576:.2f} MB")
