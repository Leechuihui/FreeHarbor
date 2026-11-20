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

// 已验证出网的全量保留；未验证的才受 TOP_N 名额和同 host 两条的限制，
// 免得名额先被垫底的未验证节点占满
const picked = checked.filter((n) => n.verified === 'ok');
const perHost = new Map();
for (const n of picked) perHost.set(n.host, (perHost.get(n.host) || 0) + 1);

for (const n of checked) {
  if (n.verified === 'ok') continue;
  if (picked.length >= TOP_N) break;
  const c = perHost.get(n.host) || 0;
  if (c >= 2) continue;
  perHost.set(n.host, c + 1);
  picked.push(n);
}

if (!picked.length) {
  console.error('没有可用节点可导出');
  process.exit(1);
}

/** 重命名：协议-延迟ms-序号，并重建 URI 的 #fragment */
function rename(node, i) {
  // 未验证 / 连不通的节点没有 latency，别拼出 undefinedms
  const lat = node.latency === undefined ? '-' : `${node.latency}ms`;
  const name = `${node.proto.toUpperCase()}-${lat}-${String(i + 1).padStart(3, '0')}`;
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
          <td data-status="${n.verified === 'ok' ? 'ok' : 'skip'}"><span class="${n.verified === 'ok' ? 'ok' : 'skip'}">${n.verified === 'ok' ? '已出网' : '未验证'}</span></td>
          <td><button class="qr-btn" data-qr="qr/node-${String(i + 1).padStart(3, '0')}.png">二维码</button></td>
        </tr>`
).join('\n');

// ---------- 页面 / README（模板在 tools/_page.part.html 与 tools/_readme.part.md）----------
// 部件文件是纯文本 + %%占位符%%，改双语文案直接编辑部件，不用碰本文件。
const htmlTpl = await readFile(join(ROOT, 'tools', '_page.part.html'), 'utf8');
const readmeTpl = await readFile(join(ROOT, 'tools', '_readme.part.md'), 'utf8');

const rowsQ = new Map();
for (const n of nodes) rowsQ.set(n.raw.split('#')[0], n);

const okText = hasVerify ? '已验证出网' : '节点';
const subs = {
  OK_COUNT: okCount,
  STAT_OK_KEY: hasVerify ? 'statOk' : 'statNodes',
  STAT_OK_TEXT: okText,
  FASTEST: fastest.latency,
  SKIP_COUNT: skipCount,
  SKIP_HIDDEN: hasVerify ? '' : 'hidden',
  HIDE_WHEN_NO_VERIFY: hasVerify ? '' : 'hidden',
  HIDE_WHEN_VERIFY: hasVerify ? 'hidden' : '',
  PROTO_COUNT: protos.length,
  NOW_UTC: new Date().toISOString().slice(0, 16).replace('T', ' '),
  QR_N: Math.min(QR_N, nodes.length),
  RAW,
  OWNER,
  REPO,
  PAGES,
  OK_LINE_EN: hasVerify
    ? '- Verified online: **' + okCount + '**\n- Unverified (unsupported protocol / unreachable / over the quota): **' + skipCount + '**'
    : '- Nodes: **' + okCount + '**',
  PROTO_LINE_EN: protos.map((p) => p + ' ' + nodes.filter((n) => n.proto === p).length).join(' · '),
};

function fill(tpl) {
  let out = tpl;
  for (const [k, v] of Object.entries(subs)) out = out.replaceAll('%%' + k + '%%', v);
  return out;
}

const html = fill(htmlTpl).replaceAll('%%ROWS%%', rows);
await writeFile(join(ROOT, 'index.html'), html);

// ---------- README ----------
const readme = fill(readmeTpl)
  .replaceAll('%%OK_LINE%%', hasVerify
    ? '- 已验证出网：**' + okCount + '**\n- 未验证（协议不支持 / 连不通 / 超出验证名额）：**' + skipCount + '**'
    : '- 节点数：**' + okCount + '**')
  .replaceAll('%%FASTEST%%', fastest.latency)
  .replaceAll('%%PROTO_LINE%%', protos.map((p) => p + ' ' + nodes.filter((n) => n.proto === p).length).join(' · '))
  .replaceAll('%%NOW%%', new Date().toISOString().replace('T', ' ').slice(0, 19));
await writeFile(join(ROOT, 'README.md'), readme);

console.log(`exported ${nodes.length} nodes (source: ${source}), ${protos.length} protocols, QR ${Math.min(QR_N, nodes.length)}`);
console.log('files: sub/* qr/* clients/* index.html README.md');
