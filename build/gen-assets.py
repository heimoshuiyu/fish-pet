#!/usr/bin/env python3
"""fish-pet asset generator: pools.json 驱动，把 assets/ 里全部引用到的 webm + 鸭子音效
base64 进 head.js（ASSETS + POOLS 两个常量）。引用缺文件 = 构建失败（不出残包）。"""
import base64, json, os, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "head.js")

with open(os.path.join(ROOT, "pools.json"), encoding="utf-8") as f:
    pools = json.load(f)

clips = set()
clips |= set(pools["names"].values())
clips |= {m["name"] if isinstance(m, dict) else m for m in pools["moves"]}
clips |= set(pools["clicks"])
clips |= set(pools["whisper"])
clips |= set(pools["work"])
clips |= set(pools["balance"])
clips |= set(pools["sleep"])
clips |= set(pools["cueMap"].values())
for cat in pools["categories"]:
    clips |= set(cat["actions"])

missing = sorted(f"{name}.webm" for name in clips if not os.path.exists(os.path.join(SRC, name + ".webm")))
if missing:
    print(f"MISSING {len(missing)} assets: {', '.join(missing[:8])}{'…' if len(missing) > 8 else ''}", file=sys.stderr)
    sys.exit(1)

parts = []
total = 0
for name in sorted(clips):
    raw = open(os.path.join(SRC, name + ".webm"), "rb").read()
    total += len(raw)
    parts.append(f'  "{name}": "data:video/webm;base64,{base64.b64encode(raw).decode()}"')

sound = base64.b64encode(open(os.path.join(SRC, "click-duck.wav"), "rb").read()).decode()

with open(OUT, "w", encoding="utf-8") as f:
    f.write('"use strict";\n')
    f.write("// fish-pet —— 窗口内大肥鱼桌宠（port 自 dsh-pet；素材源自 dsh-pet，禁止商用；公开分发须署名 https://github.com/PC2005-cloud/dsh-pet，详见 LICENSE）\n")
    f.write("// 形态：GUI-only 渲染器插件（Style + Slot window.bottom + 裸 DOM 兜底），无 main 导出、不声明 os\n")
    f.write(f"// 资产：{len(clips)} 段 480x270 VP9-alpha WebM 重编码（libvpx 解码保 alpha，CRF 42）；动画池配置见 build/pools.json\n\n")
    f.write("const ASSETS = {\n" + ",\n".join(parts) + "\n};\n\n")
    f.write(f"const POOLS = {json.dumps(pools, ensure_ascii=False, separators=(',', ':'))};\n\n")
    f.write(f'const CLICK_SOUND = "data:audio/wav;base64,{sound}";\n\n')

print(f"head.js written: {len(clips)} clips + sound, raw {total/1048576:.2f} MB")
