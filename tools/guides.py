#!/usr/bin/env python3
"""guides.py — 生成双语使用教程图到 assets/

这些图是静态素材，export.mjs 只清 sub/qr/clients，assets/ 不会被覆盖。
用法：python3 tools/guides.py
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets"
OUT.mkdir(exist_ok=True)

BG = "#0b0e14"
CARD = "#11161d"
LINE = "#21262d"
FG = "#e6edf3"
DIM = "#8b949e"
ACC = "#3fb950"
ACC2 = "#58a6ff"
WARN = "#d29922"

CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
LAT = "/Library/Fonts/Arial Unicode.ttf"

W, H = 1000, 1250

def font(path, size):
    return ImageFont.truetype(path, size)

def wrap(draw, text, f, maxw):
    """按像素宽度折行，CJK 逐字、西文按词"""
    lines, cur = [], ""
    tokens = list(text) if any('\u4e00' <= c <= '\u9fff' for c in text) else text.split(' ')
    sep = "" if tokens and len(tokens[0]) == 1 else " "
    for t in tokens:
        trial = cur + t + sep
        if draw.textlength(trial.rstrip(), font=f) <= maxw:
            cur = trial
        else:
            if cur.strip():
                lines.append(cur.rstrip())
            cur = t + sep
    if cur.strip():
        lines.append(cur.rstrip())
    return lines

def canvas(title, subtitle, brand_lang):
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)
    # 顶部品牌条
    d.rectangle([0, 0, W, 6], fill=ACC)
    d.text((56, 46), "FreeHarbor", font=font(LAT, 30), fill=FG)
    tag = "自由港 · 永久免费" if brand_lang == "zh" else "THE FREE PORT · ALWAYS FREE"
    d.text((56, 88), tag, font=font(CJK if brand_lang == "zh" else LAT, 17), fill=ACC)
    # 标题
    d.text((56, 148), title, font=font(CJK if brand_lang == "zh" else LAT, 46), fill=FG)
    y = 214
    for ln in wrap(d, subtitle, font(CJK if brand_lang == "zh" else LAT, 20), W - 112):
        d.text((56, y), ln, font=font(CJK if brand_lang == "zh" else LAT, 20), fill=DIM)
        y += 32
    return im, d, y + 26

def steps_block(d, y, steps, lang):
    nf = font(LAT, 22)
    tf = font(CJK if lang == "zh" else LAT, 21)
    df = font(CJK if lang == "zh" else LAT, 17)
    for i, (head, body) in enumerate(steps, 1):
        # 序号圆点
        d.ellipse([56, y + 2, 96, y + 42], outline=ACC, width=2)
        tw = d.textlength(str(i), font=nf)
        d.text((76 - tw / 2, y + 8), str(i), font=nf, fill=ACC)
        d.text((116, y + 6), head, font=tf, fill=FG)
        yy = y + 42
        for ln in wrap(d, body, df, W - 172):
            d.text((116, yy), ln, font=df, fill=DIM)
            yy += 26
        y = yy + 26
    return y

def footer(d, y, note, lang):
    y = max(y + 10, H - 190)
    d.line([56, y, W - 56, y], fill=LINE)
    d.rectangle([56, y + 26, 62, y + 150], fill=WARN)
    f = font(CJK if lang == "zh" else LAT, 17)
    yy = y + 30
    for ln in wrap(d, note, f, W - 150):
        d.text((80, yy), ln, font=f, fill=DIM)
        yy += 26
    d.text((56, H - 34), "leechuihui.github.io/vpn", font=font(LAT, 15), fill=DIM)

def save(im, name):
    im.save(OUT / name, optimize=True)
    print("wrote", name)

# ---------- 文案 ----------
ZH = {
    "android": (
        "Android 使用教程",
        "四步连上，全程不到一分钟。",
        [
            ("安装客户端", "到 v2rayNG 的 GitHub Releases 下载最新 APK 并安装。"),
            ("打开本页扫码", "用手机扫页面上的「订阅二维码」，或在客户端右上角 ＋ → 从剪贴板导入。"),
            ("选择节点", "回到列表，挑一个延迟最低的，点右下角圆形按钮连接。"),
            ("授权并上网", "首次连接会弹出 VPN 授权，点「确定」即可。"),
        ],
        "连不上就换一条节点，或等 5 小时后的自动刷新。别用它传敏感数据。",
    ),
    "ios": (
        "iPhone / iPad 使用教程",
        "需要美区 App Store 账号购买 Shadowrocket（约 ¥18）。",
        [
            ("安装 Shadowrocket", "用美区账号在 App Store 搜索并购买下载。"),
            ("扫码添加", "打开本页，用相机扫「订阅二维码」，点弹窗里的「打开」。"),
            ("允许添加配置", "Shadowrocket 会询问是否添加，点「允许」并输入锁屏密码。"),
            ("开启代理", "在列表里选一条延迟低的节点，打开顶部开关。"),
        ],
        "若扫码无反应，改用「添加订阅」粘贴页面上的订阅地址。",
    ),
    "windows": (
        "Windows 使用教程",
        "用 v2rayN，订阅一次即可长期自动更新。",
        [
            ("下载解压", "到 v2rayN 的 GitHub Releases 下载压缩包，解压到任意目录并运行。"),
            ("添加订阅", "菜单「订阅」→「订阅设置」→「添加」，地址栏粘贴页面上的订阅链接。"),
            ("更新订阅", "菜单「订阅」→「更新订阅（不通过代理）」，等待节点列表出现。"),
            ("连接", "选中一个延迟低的节点，托盘图标右键 →「系统代理」→「自动配置系统代理」。"),
        ],
        "首次运行若被 SmartScreen 拦截，点「更多信息」→「仍要运行」。",
    ),
    "mac": (
        "macOS 使用教程",
        "用 Clash Verge Rev，图形界面导入配置。",
        [
            ("安装应用", "到 Clash Verge Rev 的 GitHub Releases 下载 dmg，拖入「应用程序」。"),
            ("导入配置", "打开应用，「配置」→「导入」，粘贴页面上的订阅链接后确认。"),
            ("选择节点", "在「代理」页里选一条延迟低的节点。"),
            ("开启", "回到「首页」，打开「系统代理」开关。"),
        ],
        "首次打开若提示「无法验证开发者」，右键应用 →「打开」即可绕过。",
    ),
}

EN = {
    "android": (
        "Android Guide",
        "Four steps, under a minute.",
        [
            ("Install the client", "Download the latest APK from v2rayNG GitHub Releases and install it."),
            ("Scan from this page", "Scan the subscription QR on this page, or tap + and import from clipboard."),
            ("Pick a node", "Return to the list, choose the lowest latency, tap the round button to connect."),
            ("Allow the VPN", "Approve the VPN prompt on first connect."),
        ],
        "If it fails, switch nodes or wait for the 5-hour refresh. Do not send sensitive data through it.",
    ),
    "ios": (
        "iPhone / iPad Guide",
        "Shadowrocket needs a US App Store account (about $2.99).",
        [
            ("Install Shadowrocket", "Search and buy it in the App Store with a US account."),
            ("Scan to add", "Open this page, scan the subscription QR with the Camera app, tap Open."),
            ("Allow the config", "Shadowrocket asks to add a configuration. Tap Allow and enter your passcode."),
            ("Turn on", "Pick a low-latency node and flip the switch at the top."),
        ],
        "If scanning does nothing, use Add Subscription and paste the subscription URL instead.",
    ),
    "windows": (
        "Windows Guide",
        "Use v2rayN. Subscribe once and it updates itself.",
        [
            ("Download and unzip", "Get the archive from v2rayN GitHub Releases, unzip anywhere and run it."),
            ("Add subscription", "Menu Subscription, Sub settings, Add, then paste the subscription URL."),
            ("Update", "Menu Subscription, Update subscription without proxy, wait for the list."),
            ("Connect", "Select a low-latency node, right-click the tray icon, System proxy, Auto configure."),
        ],
        "If SmartScreen blocks the first run, click More info then Run anyway.",
    ),
    "mac": (
        "macOS Guide",
        "Use Clash Verge Rev with a graphical import.",
        [
            ("Install the app", "Download the dmg from Clash Verge Rev GitHub Releases and drag it to Applications."),
            ("Import profile", "Open the app, Profiles, Import, paste the subscription URL and confirm."),
            ("Pick a node", "Choose a low-latency node on the Proxies page."),
            ("Enable", "Go back to Home and switch on System proxy."),
        ],
        "If macOS says the developer cannot be verified, right-click the app and choose Open.",
    ),
}

for lang, pack in (("zh", ZH), ("en", EN)):
    for key, (title, sub, steps, note) in pack.items():
        im, d, y = canvas(title, sub, lang)
        y = steps_block(d, y, steps, lang)
        footer(d, y, note, lang)
        save(im, f"guide-{key}-{lang}.png")

print("done")
