# 免费 VPN 节点

自动抓取公开免费节点，探测存活，按延迟排序，生成订阅和二维码。每 3 小时由 GitHub Actions 刷新一次。

**在线页面：** https://leechuihui.github.io/vpn/

> 首次使用需在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**，之后每次刷新会自动发布。

## 一键订阅

```
https://raw.githubusercontent.com/Leechuihui/vpn/main/sub/all.txt
```

base64 格式（v2rayN / Shadowrocket 兼容更好）：

```
https://raw.githubusercontent.com/Leechuihui/vpn/main/sub/all.base64.txt
```

只要最快的一批（前 20 条）：

```
https://raw.githubusercontent.com/Leechuihui/vpn/main/sub/best.txt
```

<p align="center">
  <img src="qr/subscribe-all.png" width="240" alt="订阅二维码">
</p>

## 客户端

| 平台 | 客户端 | 方式 |
|---|---|---|
| Android | [v2rayNG](https://github.com/2dust/v2rayNG/releases/latest) | 扫码 / 订阅 |
| Windows | [v2rayN](https://github.com/2dust/v2rayN/releases/latest) | 订阅 |
| iOS / macOS | [Shadowrocket](https://apps.apple.com/app/shadowrocket/id932747118) | 扫码 |
| 桌面 GUI | [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest) | 导入 [clash.yaml](clients/clash.yaml) |
| 全平台 CLI | [sing-box](https://github.com/SagerNet/sing-box/releases/latest) | 导入 [singbox.json](clients/singbox.json) |

## 当前节点

- 已验证出网：**36**
- 未验证（协议不支持 / 连不通 / 超出验证名额）：**164**
- 最快延迟：**165 ms**
- 协议分布：vmess 10 · vless 125 · trojan 15 · ss 50
- 更新时间：2026-11-20 18:27:57 UTC

## 工具

五个脚本，纯 Node 标准库 + `qrcode`，无第三方 API：

```bash
npm install
node tools/fetch.mjs      # 抓取 tools/sources.txt 里的上游源 → data/raw/
node tools/parse.mjs      # 解析、去重、过滤私网/坏端口 → data/nodes.json
node tools/probe.mjs      # TCP 探测存活 → data/checked.json
node tools/verify.mjs     # 经每个节点真实出网 → data/verified.json
node tools/export.mjs     # 生成订阅、二维码、客户端配置、页面、README
```

要加自己的源，往 `tools/sources.txt` 追加一行 URL 就行，支持明文列表、base64 订阅、Clash YAML 三种格式。

## 说明

节点来自公开免费源，稳定性不保证。通过验证只代表当下这一刻能出网。别拿它传敏感数据。

hysteria2 / tuic / ssr 无法用 xray 验证，Shadowsocks 则是 xray 26 起整个移除，这几类原样保留并排在末尾。
