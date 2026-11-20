# 🌊 FreeHarbor 自由港 · 永久免费 VPN 节点订阅

[![Live Site](https://img.shields.io/badge/🌐_Live_Site-leechuihui.github.io%2Fvpn-3fb950?style=for-the-badge)](%%PAGES%%)
[![Auto Update](https://img.shields.io/badge/🔄_Auto_Update-every_3h-58a6ff?style=for-the-badge)](https://github.com/Leechuihui/vpn/actions)
[![Verified Nodes](https://img.shields.io/badge/✅_Egress_Verified-xray_core-8b5cf6?style=for-the-badge)](#-tooling)
[![License](https://img.shields.io/badge/📄_Use_at_your_own_risk-MIT-yellow?style=for-the-badge)](#中文--notes)

**FreeHarbor / The Free Port** — 永久免费、自动更新的 VPN 节点订阅站。抓取公开免费节点，经真实出网验证后按延迟排序，生成订阅与二维码；每 3 小时由 GitHub Actions 自动刷新，零服务器成本。

> **English below** ↓ | **英文说明在下方**

**在线页面 / Live page：** %%PAGES%%

> 首次使用需在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**，之后每次刷新会自动发布。

---

## 中文

### 一键订阅

```
%%RAW%%sub/all.txt
```

base64 格式（v2rayN / Shadowrocket 兼容更好）：

```
%%RAW%%sub/all.base64.txt
```

只要最快的一批（前 20 条）：

```
%%RAW%%sub/best.txt
```

### 使用教程（图文）

| 平台 | 教程 |
|---|---|
| Android | ![Android 中文教程](assets/guide-android-zh.png) |
| iPhone / iPad | ![iOS 中文教程](assets/guide-ios-zh.png) |
| Windows | ![Windows 中文教程](assets/guide-windows-zh.png) |
| macOS | ![macOS 中文教程](assets/guide-mac-zh.png) |

### 客户端

| 平台 | 客户端 | 方式 |
|---|---|---|
| Android | [v2rayNG](https://github.com/2dust/v2rayNG/releases/latest) | 扫码 / 订阅 |
| Windows | [v2rayN](https://github.com/2dust/v2rayN/releases/latest) | 订阅 |
| iOS / macOS | [Shadowrocket](https://apps.apple.com/app/shadowrocket/id932747118) | 扫码 |
| 桌面 GUI | [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest) | 导入 [clash.yaml](clients/clash.yaml) |
| 全平台 CLI | [sing-box](https://github.com/SagerNet/sing-box/releases/latest) | 导入 [singbox.json](clients/singbox.json) |

### 当前节点

%%OK_LINE%%
- 最快延迟：**%%FASTEST%% ms**
- 协议分布：%%PROTO_LINE%%
- 更新时间：%%NOW%% UTC

### 工具

五个脚本，纯 Node 标准库 + `qrcode`；教程图由 `tools/guides.py`（Pillow）生成：

```bash
npm install
node tools/fetch.mjs      # 抓取 tools/sources.txt 里的上游源 → data/raw/
node tools/parse.mjs      # 解析、去重、过滤私网/坏端口 → data/nodes.json
node tools/probe.mjs      # TCP 探测存活 → data/checked.json
node tools/verify.mjs     # 经每个节点真实出网 → data/verified.json
node tools/export.mjs     # 生成订阅、二维码、客户端配置、页面、README
python3 tools/guides.py   # 重新生成双语教程图 → assets/
```

要加自己的源，往 `tools/sources.txt` 追加一行 URL 就行，支持明文列表、base64 订阅、Clash YAML 三种格式。

### 说明

节点来自公开免费源，稳定性不保证。通过验证只代表当下这一刻能出网。别拿它传敏感数据。

hysteria2 / tuic / ssr 无法用 xray 验证，Shadowsocks 则是 xray 26 起整个移除，这几类原样保留并排在末尾。

---

## English

**FreeHarbor / The Free Port** — a permanently free, auto-updating VPN node subscription site. Public free nodes are scraped, verified end-to-end through a real connection, sorted by latency, and published as subscriptions and QR codes. GitHub Actions refreshes everything every 3 hours at zero server cost.

**Live page:** %%PAGES%%

> First time only: set Settings → Pages → Source to **GitHub Actions**. Every later refresh publishes itself.

### One-tap subscription

```
%%RAW%%sub/all.txt
```

Base64 format (better compatibility with v2rayN / Shadowrocket):

```
%%RAW%%sub/all.base64.txt
```

Fastest 20 only:

```
%%RAW%%sub/best.txt
```

### Step-by-step guides

| Platform | Guide |
|---|---|
| Android | ![Android guide](assets/guide-android-en.png) |
| iPhone / iPad | ![iOS guide](assets/guide-ios-en.png) |
| Windows | ![Windows guide](assets/guide-windows-en.png) |
| macOS | ![macOS guide](assets/guide-mac-en.png) |

### Clients

| Platform | Client | How |
|---|---|---|
| Android | [v2rayNG](https://github.com/2dust/v2rayNG/releases/latest) | Scan / subscribe |
| Windows | [v2rayN](https://github.com/2dust/v2rayN/releases/latest) | Subscribe |
| iOS / macOS | [Shadowrocket](https://apps.apple.com/app/shadowrocket/id932747118) | Scan |
| Desktop GUI | [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest) | Import [clash.yaml](clients/clash.yaml) |
| CLI, all platforms | [sing-box](https://github.com/SagerNet/sing-box/releases/latest) | Import [singbox.json](clients/singbox.json) |

### Current nodes

%%OK_LINE_EN%%
- Fastest latency: **%%FASTEST%% ms**
- By protocol: %%PROTO_LINE_EN%%
- Updated: %%NOW%% UTC

### Tooling

Five scripts on the Node standard library plus `qrcode`; guide images come from `tools/guides.py` (Pillow):

```bash
npm install
node tools/fetch.mjs      # scrape upstream sources from tools/sources.txt → data/raw/
node tools/parse.mjs      # parse, dedupe, drop private/broken → data/nodes.json
node tools/probe.mjs      # TCP reachability → data/checked.json
node tools/verify.mjs     # real egress check per node → data/verified.json
node tools/export.mjs     # subscriptions, QR codes, client configs, page, README
python3 tools/guides.py   # regenerate bilingual guide images → assets/
```

To add a source, append one URL per line to `tools/sources.txt`. Plain lists, base64 subscriptions and Clash YAML are all accepted.

### Notes

Nodes come from public free sources; stability is not guaranteed. A passed verification only means the node worked at that moment. Do not send sensitive data through them.

hysteria2 / tuic / ssr cannot be verified with xray, and Shadowsocks was removed entirely in xray 26. Those are kept as-is and sorted last.

---

## 🌟 Star History / 星标历史

If this project saved you time, consider giving it a star ⭐ — it helps others find free, verified nodes.

[![Star History Chart](https://api.star-history.com/svg?repos=Leechuihui/vpn&type=Date)](https://star-history.com/#Leechuihui/vpn&Date)

## 🔗 Related / 相关项目

- [v2rayNG](https://github.com/2dust/v2rayNG) · [v2rayN](https://github.com/2dust/v2rayN) — the clients this site's subscriptions are tested with
- [sing-box](https://github.com/SagerNet/sing-box) — universal proxy platform
- [Xray-core](https://github.com/XTLS/Xray-core) — the verification engine behind egress checks
