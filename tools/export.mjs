#!/usr/bin/env node
/**
 * export.mjs — 从 data/checked.json 生成全部产物
 *
 * 产出：
 *   sub/all.txt          明文订阅（全部存活节点，按延迟排序）
 *   sub/all.base64.txt   base64 订阅（v2rayN / Shadowrocket 通用导入格式）
 *   sub/best.txt         最快 20 条
 *   sub/<proto>.txt      按协议拆分
 *   qr/*.png             每条节点一个二维码 + 订阅总码 + 单节点聚合页用码
 *   clients/clash.yaml   Clash / Mihomo 配置
 *   clients/singbox.json Sing-box 配置
 *   index.html           静态落地页（GitHub Pages）
 *   README.md            仓库首页说明
 *
 * 节点名统一重排成「协议-延迟-序号」，去上游广告，同 host 去重。
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import * as yaml from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = process.env.REPO_OWNER || 'Leechuihui';
const REPO = process.env.REPO_NAME || 'vpn';
const PAGES = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/`;

const TOP_N = 200;
const QR_N = 60;

// 优先用真实验证过的节点（能出网），没有再退回 TCP 探测结果
let source = 'checked';
let checked;
try {
  checked = JSON.parse(await readFile(join(ROOT, 'data', 'verified.json'), 'utf8'));
  source = 'verified';
} catch {
  checked = JSON.parse(await readFile(join(ROOT, 'data', 'checked.json'), 'utf8'));
}
// verified.json 里 ok 的排前面（已按延迟升序），skip 的垫底
checked.sort((a, b) => (a.verified === 'ok' ? 0 : 1) - (b.verified === 'ok' ? 0 : 1));

// 同一 host 只留最快的两条，避免整页节点全在同一个机房
const perHost = new Map();
const picked = [];
for (const n of checked) {
  const c = perHost.get(n.host) || 0;
  if (c >= 2) continue;
  perHost.set(n.host, c + 1);
  picked.push(n);
  if (picked.length >= TOP_N) break;
}

if (!picked.length) {
  console.error('没有可用节点可导出');
  process.exit(1);
}

/** 重命名：协议-延迟ms-序号，并重建 URI 的 #fragment */
function rename(node, i) {
  const name = `${node.proto.toUpperCase()}-${node.latency}ms-${String(i + 1).padStart(3, '0')}`;
  const raw = node.raw.includes('#') ? node.raw.slice(0, node.raw.indexOf('#')) : node.raw;
  return { ...node, name, uri: `${raw}#${encodeURIComponent(name)}` };
}

const nodes = picked.map(rename);

for (const dir of ['sub', 'qr', 'clients']) {
  await rm(join(ROOT, dir), { recursive: true, force: true });
  await mkdir(join(ROOT, dir), { recursive: true });
}

// ---------- 订阅文件 ----------
const allTxt = nodes.map((n) => n.uri).join('\n') + '\n';
await writeFile(join(ROOT, 'sub', 'all.txt'), allTxt);
await writeFile(
  join(ROOT, 'sub', 'all.base64.txt'),
  Buffer.from(allTxt).toString('base64') + '\n'
);
await writeFile(join(ROOT, 'sub', 'best.txt'), nodes.slice(0, 20).map((n) => n.uri).join('\n') + '\n');

const protos = [...new Set(nodes.map((n) => n.proto))];
const hasVerify = source === 'verified';
// 没有验证结果时，全部节点都是「节点」；有验证结果时只数真正出网的
const okCount = hasVerify ? nodes.filter((n) => n.verified === 'ok').length : nodes.length;
const skipCount = nodes.length - okCount;
const fastest = hasVerify ? nodes.find((n) => n.verified === 'ok') || nodes[0] : nodes[0];
for (const p of protos) {
  const list = nodes.filter((n) => n.proto === p);
  await writeFile(join(ROOT, 'sub', `${p}.txt`), list.map((n) => n.uri).join('\n') + '\n');
}

// ---------- 二维码 ----------
const QR_OPT = { width: 320, margin: 1, errorCorrectionLevel: 'M' };

async function qr(file, text) {
  await QRCode.toFile(join(ROOT, 'qr', file), text, QR_OPT);
}

await qr('subscribe-all.png', RAW + 'sub/all.txt');
await qr('subscribe-base64.png', RAW + 'sub/all.base64.txt');
await qr('subscribe-best.png', RAW + 'sub/best.txt');
await qr('pages.png', PAGES);

for (let i = 0; i < Math.min(QR_N, nodes.length); i++) {
  await qr(`node-${String(i + 1).padStart(3, '0')}.png`, nodes[i].uri);
}

// ---------- Clash / Mihomo ----------
const clashProxies = nodes.map((n) => {
  const base = { name: n.name, server: n.host, port: Number(n.port) };
  const sni = n.sni && n.sni !== n.host ? n.sni : undefined;
  switch (n.proto) {
    case 'ss': {
      const body = n.raw.slice(5).split('#')[0].split('@')[0];
      const ui = body.includes(':') ? body : Buffer.from(body, 'base64').toString('utf8');
      const idx = ui.indexOf(':');
      return { ...base, type: 'ss', cipher: ui.slice(0, idx), password: ui.slice(idx + 1), udp: true };
    }
    case 'vmess': {
      const j = JSON.parse(Buffer.from(n.raw.slice(8).split('#')[0], 'base64').toString('utf8'));
      return {
        ...base,
        type: 'vmess',
        uuid: j.id,
        alterId: Number(j.aid || 0),
        cipher: 'auto',
        tls: j.tls === 'tls',
        servername: sni,
        network: j.net || 'tcp',
        'ws-opts': j.net === 'ws' ? { path: j.path || '/', headers: { Host: j.host || n.host } } : undefined,
        udp: true,
      };
    }
    case 'vless': {
      const q = new URL(n.raw).searchParams;
      return {
        ...base,
        type: 'vless',
        uuid: q.get('id') || new URL(n.raw).username,
        tls: n.tls,
        servername: sni,
        flow: q.get('flow') || undefined,
        'reality-opts': q.get('security') === 'reality'
          ? { 'public-key': q.get('pbk'), 'short-id': q.get('sid') || '' }
          : undefined,
        'client-fingerprint': q.get('fp') || 'chrome',
        network: q.get('type') || 'tcp',
        udp: true,
      };
    }
    case 'trojan':
      return {
        ...base,
        type: 'trojan',
        password: decodeURIComponent(new URL(n.raw).username),
        sni: sni || n.host,
        skipCertVerify: true,
        udp: true,
      };
    case 'hysteria2': {
      const u = new URL(n.raw.replace(/^hy2:\/\//, 'hysteria2://'));
      return { ...base, type: 'hysteria2', password: decodeURIComponent(u.username || ''), sni: sni || n.host, skipCertVerify: true };
    }
    default:
      return null;
  }
}).filter(Boolean);

/** 递归剔除 undefined，js-yaml 对 undefined 会输出 null 占位 */
function prune(v) {
  if (Array.isArray(v)) return v.map(prune);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      out[k] = prune(val);
    }
    return out;
  }
  return v;
}

const clashDoc = {
  'mixed-port': 7890,
  'allow-lan': true,
  mode: 'rule',
  'log-level': 'info',
  ipv6: false,
  proxies: clashProxies.map(prune),
  'proxy-groups': [
    {
      name: '自动选择',
      type: 'url-test',
      url: 'http://www.gstatic.com/generate_204',
      interval: 300,
      tolerance: 50,
      proxies: clashProxies.map((p) => p.name),
    },
    {
      name: '手动选择',
      type: 'select',
      proxies: ['自动选择', ...clashProxies.map((p) => p.name)],
    },
  ],
  rules: ['GEOIP,CN,DIRECT', 'MATCH,自动选择'],
};

const clashHeader =
  '# 由 tools/export.mjs 自动生成，勿手改\n' +
  `# 节点数：${clashProxies.length}　更新：${new Date().toISOString()}\n` +
  `# 订阅地址：${RAW}sub/all.txt\n\n`;

const clash = clashHeader + yaml.dump(clashDoc, { lineWidth: 200, noRefs: true });
await writeFile(join(ROOT, 'clients', 'clash.yaml'), clash);

// ---------- Sing-box ----------
const singbox = {
  log: { level: 'info' },
  dns: { servers: [{ tag: 'cf', address: 'https://1.1.1.1/dns-query' }] },
  inbounds: [
    { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 7890 },
  ],
  outbounds: [
    ...nodes.map((n) => {
      const sni = n.sni && n.sni !== n.host ? n.sni : undefined;
      switch (n.proto) {
        case 'vless': {
          const q = new URL(n.raw).searchParams;
          return {
            type: 'vless', tag: n.name, server: n.host, server_port: Number(n.port),
            uuid: q.get('id') || new URL(n.raw).username, flow: q.get('flow') || undefined,
            tls: {
              enabled: true,
              server_name: sni || n.host,
              insecure: true,
              utls: { enabled: true, fingerprint: q.get('fp') || 'chrome' },
              reality: q.get('security') === 'reality'
                ? { enabled: true, public_key: q.get('pbk'), short_id: q.get('sid') || '' }
                : undefined,
            },
          };
        }
        case 'vmess': {
          const j = JSON.parse(Buffer.from(n.raw.slice(8).split('#')[0], 'base64').toString('utf8'));
          return {
            type: 'vmess', tag: n.name, server: n.host, server_port: Number(n.port),
            uuid: j.id, security: 'auto', alter_id: Number(j.aid || 0),
            transport: j.net === 'ws' ? { type: 'ws', path: j.path || '/', headers: { Host: j.host || n.host } } : undefined,
            tls: j.tls === 'tls' ? { enabled: true, server_name: j.sni || n.host, insecure: true } : undefined,
          };
        }
        case 'trojan':
          return {
            type: 'trojan', tag: n.name, server: n.host, server_port: Number(n.port),
            password: decodeURIComponent(new URL(n.raw).username),
            tls: { enabled: true, server_name: sni || n.host, insecure: true },
          };
        case 'hysteria2': {
          const u = new URL(n.raw.replace(/^hy2:\/\//, 'hysteria2://'));
          return {
            type: 'hysteria2', tag: n.name, server: n.host, server_port: Number(n.port),
            password: decodeURIComponent(u.username || ''),
            tls: { enabled: true, server_name: sni || n.host, insecure: true },
          };
        }
        case 'ss':
          return {
            type: 'shadowsocks', tag: n.name, server: n.host, server_port: Number(n.port),
            method: Buffer.from(n.raw.slice(5).split('@')[0], 'base64').toString('utf8').split(':')[0],
            password: Buffer.from(n.raw.slice(5).split('@')[0], 'base64').toString('utf8').split(':').slice(1).join(':'),
          };
        default:
          return null;
      }
    }).filter(Boolean),
    { type: 'direct', tag: 'direct' },
  ],
  route: { final: nodes[0].name, auto_detect_interface: true },
};
await writeFile(join(ROOT, 'clients', 'singbox.json'), JSON.stringify(singbox, null, 2));

// ---------- 页面 ----------
const rows = nodes.slice(0, QR_N).map(
  (n, i) => `        <tr>
          <td class="idx">${String(i + 1).padStart(3, '0')}</td>
          <td><span class="tag ${n.proto}">${n.proto}</span></td>
          <td class="host">${n.host}:${n.port}</td>
          <td class="lat">${n.verified === 'ok' ? `${n.latency} ms` : '—'}</td>
          <td>${n.verified === 'ok' ? '<span class="ok">已出网</span>' : '<span class="skip">未验证</span>'}</td>
          <td><button class="qr-btn" data-qr="qr/node-${String(i + 1).padStart(3, '0')}.png">二维码</button></td>
        </tr>`
).join('\n');

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>免费 VPN 节点 · ${OWNER}</title>
<meta name="description" content="自动更新的免费 VPN 节点订阅，扫码即连。支持 v2rayN、v2rayNG、Shadowrocket、Clash、Sing-box。">
<style>
  :root { --bg:#0b0e14; --fg:#e6edf3; --dim:#8b949e; --line:#21262d; --acc:#3fb950; --acc2:#58a6ff; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing:-.02em; }
  h2 { font-size: 17px; margin: 40px 0 12px; padding-bottom:8px; border-bottom:1px solid var(--line); }
  .sub { color:var(--dim); margin:0 0 24px; font-size:14px; }
  .stat { display:flex; gap:10px; flex-wrap:wrap; margin:20px 0; }
  .stat div { background:#11161d; border:1px solid var(--line); border-radius:8px; padding:10px 14px; font-size:13px; }
  .stat b { color:var(--acc); font-size:18px; display:block; }
  .qrgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; }
  .qrcard { background:#fff; border-radius:10px; padding:14px; text-align:center; }
  .qrcard img { width:100%; height:auto; image-rendering:pixelated; }
  .qrcard p { color:#111; font-size:12px; margin:8px 0 0; font-weight:600; }
  .qrcard small { color:#555; font-size:11px; display:block; }
  .url { background:#11161d; border:1px solid var(--line); border-radius:6px; padding:10px 12px;
         font-family:ui-monospace,Menlo,monospace; font-size:12px; word-break:break-all; color:var(--acc2); }
  a { color:var(--acc2); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-weight:500; font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .idx { color:var(--dim); font-family:ui-monospace,monospace; }
  .host { font-family:ui-monospace,monospace; font-size:12px; color:var(--dim); }
  .lat { color:var(--acc); font-variant-numeric:tabular-nums; }
  .tag { font-size:11px; padding:1px 7px; border-radius:20px; background:#1f6feb22; color:var(--acc2); text-transform:uppercase; }
  .tag.ss { background:#3fb95022; color:var(--acc); }
  .tag.trojan { background:#db6d2822; color:#db6d28; }
  .tag.hysteria2 { background:#a371f722; color:#a371f7; }
  .ok { color:var(--acc); font-size:11px; }
  .skip { color:#d29922; font-size:11px; }
  .qr-btn { background:#21262d; color:var(--fg); border:1px solid var(--line); border-radius:6px;
            padding:4px 10px; font-size:12px; cursor:pointer; }
  .qr-btn:hover { background:#30363d; }
  .steps { padding-left:20px; color:var(--dim); }
  .steps li { margin:6px 0; }
  .steps b { color:var(--fg); }
  .warn { border-left:3px solid #d29922; padding:8px 14px; color:var(--dim); font-size:13px; background:#d2992211; }
  #modal { position:fixed; inset:0; background:#000c; display:none; align-items:center; justify-content:center; padding:20px; z-index:9; }
  #modal.on { display:flex; }
  #modal .box { background:#fff; border-radius:12px; padding:16px; text-align:center; max-width:340px; }
  #modal img { width:100%; }
  footer { margin-top:60px; color:var(--dim); font-size:12px; border-top:1px solid var(--line); padding-top:16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>免费 VPN 节点</h1>
  <p class="sub">GitHub 自动抓取 · 每 3 小时刷新 · 扫码即连，无需注册</p>

  <div class="stat">
    <div><b>${okCount}</b>${hasVerify ? '已验证出网' : '节点'}</div>
    <div><b>${fastest.latency} ms</b>最快延迟</div>
    ${hasVerify ? `<div><b>${skipCount}</b>未验证</div>` : ''}
    <div><b>${protos.length}</b>协议类型</div>
    <div><b>${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</b>更新时间</div>
  </div>

  <h2>① 一键订阅（推荐）</h2>
  <p class="sub">在客户端里「添加订阅」后填下面地址，节点自动同步，不用手动换。</p>
  <div class="qrgrid">
    <div class="qrcard">
      <img src="qr/subscribe-all.png" alt="订阅二维码">
      <p>扫码导入订阅</p><small>v2rayN / v2rayNG / Shadowrocket</small>
    </div>
    <div class="qrcard">
      <img src="qr/subscribe-base64.png" alt="base64 订阅二维码">
      <p>Base64 订阅</p><small>兼容性更好的导入格式</small>
    </div>
    <div class="qrcard">
      <img src="qr/subscribe-best.png" alt="精选订阅二维码">
      <p>只取前 20 条</p><small>延迟最低的一批，列表更短</small>
    </div>
    <div class="qrcard">
      <img src="qr/pages.png" alt="本页二维码">
      <p>本页地址</p><small>手机扫码打开，直接复制订阅</small>
    </div>
  </div>
  <p style="margin-top:14px"></p>
  <div class="url">${RAW}sub/all.txt</div>
  <p style="margin-top:10px"></p>
  <div class="url">${RAW}sub/all.base64.txt</div>
  <p style="margin-top:10px"></p>
  <div class="url">${RAW}sub/best.txt</div>

  <h2>② 直接扫节点（不装订阅）</h2>
  <p class="sub">扫一条连一条。前 ${Math.min(QR_N, nodes.length)} 条按延迟从低到高排列。</p>
  <table>
    <thead><tr><th>#</th><th>协议</th><th>地址</th><th>延迟</th><th>状态</th><th></th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>

  <h2>③ 客户端下载</h2>
  <ul class="steps">
    <li><b>Android</b> — <a href="https://github.com/2dust/v2rayNG/releases/latest">v2rayNG</a>，装好后点右上角 ＋ → 从剪贴板导入 / 扫二维码</li>
    <li><b>Windows</b> — <a href="https://github.com/2dust/v2rayN/releases/latest">v2rayN</a>，解压运行，订阅 → 订阅设置 → 添加</li>
    <li><b>iOS / macOS</b> — <a href="https://apps.apple.com/app/shadowrocket/id932747118">Shadowrocket</a>（美区 App Store，付费 ¥18），扫码即加</li>
    <li><b>macOS / Windows / Linux 图形界面</b> — <a href="https://github.com/clash-verge-rev/clash-verge-rev/releases/latest">Clash Verge Rev</a>，配置 → 导入</li>
    <li><b>全平台命令行</b> — <a href="https://github.com/SagerNet/sing-box/releases/latest">sing-box</a>，用本仓库 <a href="clients/singbox.json">singbox.json</a></li>
  </ul>
  <p class="sub">仓库内已备好 <a href="clients/clash.yaml">Clash 配置</a> 和 <a href="clients/singbox.json">Sing-box 配置</a>，下载后直接导入。</p>

  <h2>说明</h2>
  <p class="warn">节点来自公开免费源，稳定性不由本项目保证。连不上就换一条，或者等下次刷新。别拿它传敏感数据。</p>
  <ul class="steps">
    ${hasVerify ? `<li>节点已用本地 xray 内核真实出网验证（经节点请求 <code>generate_204</code> 返回 204 才算可用），不是只看端口通不通</li>
    <li>Shadowsocks 自 xray 26 起整个移除，连同 hysteria2 / tuic / ssr 无法验证，原样保留并排在列表末尾</li>` : '<li>本轮没有跑出网验证，仅按 TCP 探测结果排序；能连上不等于一定能出网</li>'}
    <li>自动更新由 GitHub Actions 每 3 小时跑一次，无服务器成本</li>
    <li>同一 host 最多保留 2 条，避免整页节点挤在一个机房</li>
  </ul>

  <footer>
    ${OWNER} · <a href="https://github.com/${OWNER}/${REPO}">仓库源码</a> · <a href="${PAGES}">${PAGES}</a> · 节点解析、探测、二维码全部本地生成，无第三方 API
  </footer>
</div>

<div id="modal"><div class="box"><img id="modal-img" alt=""><p style="color:#111;font-size:12px;margin-top:8px">用客户端扫码添加</p></div></div>
<script>
  const modal = document.getElementById('modal');
  const img = document.getElementById('modal-img');
  document.querySelectorAll('.qr-btn').forEach((b) => {
    b.onclick = () => { img.src = b.dataset.qr; modal.classList.add('on'); };
  });
  modal.onclick = () => modal.classList.remove('on');
</script>
</body>
</html>
`;
await writeFile(join(ROOT, 'index.html'), html);

// ---------- README ----------
const readme = `# 免费 VPN 节点

自动抓取公开免费节点，探测存活，按延迟排序，生成订阅和二维码。每 3 小时由 GitHub Actions 刷新一次。

**在线页面：** ${PAGES}

> 首次使用需在仓库 Settings → Pages 里把 Source 设为 **GitHub Actions**，之后每次刷新会自动发布。

## 一键订阅

\`\`\`
${RAW}sub/all.txt
\`\`\`

base64 格式（v2rayN / Shadowrocket 兼容更好）：

\`\`\`
${RAW}sub/all.base64.txt
\`\`\`

只要最快的一批（前 20 条）：

\`\`\`
${RAW}sub/best.txt
\`\`\`

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

${hasVerify ? `- 已验证出网：**${okCount}**\n- 未验证（协议不支持）：**${skipCount}**` : `- 节点数：**${okCount}**`}
- 最快延迟：**${fastest.latency} ms**
- 协议分布：${protos.map((p) => `${p} ${nodes.filter((n) => n.proto === p).length}`).join(' · ')}
- 更新时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC

## 工具

五个脚本，纯 Node 标准库 + \`qrcode\`，无第三方 API：

\`\`\`bash
npm install
node tools/fetch.mjs      # 抓取 tools/sources.txt 里的上游源 → data/raw/
node tools/parse.mjs      # 解析、去重、过滤私网/坏端口 → data/nodes.json
node tools/probe.mjs      # TCP 探测存活 → data/checked.json
node tools/verify.mjs     # 经每个节点真实出网 → data/verified.json
node tools/export.mjs     # 生成订阅、二维码、客户端配置、页面、README
\`\`\`

要加自己的源，往 \`tools/sources.txt\` 追加一行 URL 就行，支持明文列表、base64 订阅、Clash YAML 三种格式。

## 说明

节点来自公开免费源，稳定性不保证。通过验证只代表当下这一刻能出网。别拿它传敏感数据。

hysteria2 / tuic / ssr 无法用 xray 验证，Shadowsocks 则是 xray 26 起整个移除，这几类原样保留并排在末尾。
`;
await writeFile(join(ROOT, 'README.md'), readme);

console.log(`exported ${nodes.length} nodes (source: ${source}), ${protos.length} protocols, QR ${Math.min(QR_N, nodes.length)}`);
console.log('files: sub/* qr/* clients/* index.html README.md');
