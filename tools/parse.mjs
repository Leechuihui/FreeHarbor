#!/usr/bin/env node
/**
 * parse.mjs — 解析 data/raw/ 下所有协议 URI，归一化 + 去重 + 过滤垃圾
 *
 * 输出 data/nodes.json：
 *   [{ proto, host, port, id, sni, net, tls, name, raw }]
 *
 * id 是去重键：同协议 + 同 host:port + 同凭证 视为同一节点。
 * 上游列表大量注水（假 IP、私网地址、缺字段、重复），这里全清掉。
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dec, fragmentOf } from './util.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// 可被覆盖，方便测试拿 fixture 驱动
const RAW = process.env.PARSE_RAW_DIR || join(ROOT, 'data', 'raw');
const OUT = process.env.PARSE_OUT || join(ROOT, 'data', 'nodes.json');

const PROTO_OK = new Set(['ss', 'ssr', 'vmess', 'vless', 'trojan', 'hysteria2', 'hy2', 'tuic']);
const PRIVATE_RE =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

const isHost = (h) =>
  !!h &&
  h.length <= 253 &&
  (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(h));

const isPort = (p) => /^\d{1,5}$/.test(p) && +p >= 1 && +p <= 65535;

/** 只保留 ASCII 可打印，去掉上游塞进来的 emoji/广告/换行 */
function cleanName(s, fallback) {
  let n = (s || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length > 42) n = n.slice(0, 42).trim();
  return n || fallback;
}

function qs(u) {
  try {
    return new URL(u).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** 各协议解析器：返回归一化对象或 null */
const parsers = {
  ss(raw) {
    const body = raw.slice(5).split('#')[0];
    const [userinfo, hostport] = body.includes('@')
      ? [body.slice(0, body.lastIndexOf('@')), body.slice(body.lastIndexOf('@') + 1)]
      : [null, body];
    let host, port;
    if (hostport.includes('?')) {
      const [hp, q] = hostport.split('?');
      const p = new URLSearchParams(q);
      host = p.get('host') || hp.slice(0, hp.lastIndexOf(':'));
      port = p.get('port') || hp.slice(hp.lastIndexOf(':') + 1);
    } else {
      host = hostport.slice(0, hostport.lastIndexOf(':'));
      port = hostport.slice(hostport.lastIndexOf(':') + 1);
    }
    host = host?.replace(/^\[|\]$/g, '');
    // userinfo 可以是明文 cipher:pass 或 base64
    let ui = userinfo;
    if (ui && !ui.includes(':')) {
      try {
        ui = Buffer.from(ui.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      } catch {
        return null;
      }
    }
    if (!ui?.includes(':')) return null;
    return { proto: 'ss', host, port, id: `ss|${host}|${port}|${ui}`, net: 'tcp', tls: false };
  },

  ssr(raw) {
    const dec = Buffer.from(raw.slice(6), 'base64').toString('utf8');
    const parts = dec.split(':');
    if (parts.length < 6) return null;
    const [host, port, , , , pass] = parts;
    return { proto: 'ssr', host, port, id: `ssr|${host}|${port}|${pass}`, net: 'tcp', tls: false };
  },

  vmess(raw) {
    let j;
    try {
      j = JSON.parse(Buffer.from(raw.slice(8), 'base64').toString('utf8'));
    } catch {
      return null;
    }
    const host = String(j.add || '').replace(/^\[|\]$/g, '');
    const port = String(j.port || '');
    const id = j.id;
    if (!id) return null;
    return {
      proto: 'vmess',
      host,
      port,
      id: `vmess|${host}|${port}|${id}`,
      sni: j.sni || j.host || '',
      net: j.net || 'tcp',
      tls: j.tls === 'tls',
    };
  },

  vless(raw) {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const id = u.username;
    if (!id) return null;
    const q = u.searchParams;
    const sec = q.get('security') || 'none';
    return {
      proto: 'vless',
      host,
      port: u.port || '443',
      id: `vless|${host}|${u.port}|${id}|${sec}`,
      sni: q.get('sni') || q.get('host') || '',
      net: q.get('type') || 'tcp',
      tls: sec === 'tls' || sec === 'reality',
    };
  },

  trojan(raw) {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const pw = u.username;
    if (!pw) return null;
    return {
      proto: 'trojan',
      host,
      port: u.port || '443',
      id: `trojan|${host}|${u.port}|${pw}`,
      sni: u.searchParams.get('sni') || '',
      net: u.searchParams.get('type') || 'tcp',
      tls: true,
    };
  },

  hysteria2(raw) {
    const u = new URL(raw.replace(/^hy2:\/\//, 'hysteria2://'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return {
      proto: 'hysteria2',
      host,
      port: u.port || '443',
      id: `hysteria2|${host}|${u.port}|${u.username || ''}`,
      sni: u.searchParams.get('sni') || '',
      net: 'quic',
      tls: true,
    };
  },

  tuic(raw) {
    const u = new URL(raw);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return {
      proto: 'tuic',
      host,
      port: u.port || '443',
      id: `tuic|${host}|${u.port}|${u.username || ''}`,
      sni: u.searchParams.get('sni') || '',
      net: 'quic',
      tls: true,
    };
  },
};

const seen = new Map();
const stats = { in: 0, badProto: 0, badHost: 0, badPort: 0, priv: 0, dup: 0, ok: 0 };

const files = (await readdir(RAW).catch(() => [])).filter((f) => f.endsWith('.txt'));

for (const file of files) {
  const text = await readFile(join(RAW, file), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    stats.in++;
    const proto = raw.slice(0, raw.indexOf(':')).toLowerCase();
    const key = proto === 'hy2' ? 'hysteria2' : proto;
    if (!PROTO_OK.has(proto)) {
      stats.badProto++;
      continue;
    }
    let node = null;
    try {
      node = parsers[key]?.(raw) ?? null;
    } catch {
      node = null;
    }
    if (!node) {
      stats.badHost++;
      continue;
    }
    if (!isHost(node.host)) {
      stats.badHost++;
      continue;
    }
    if (PRIVATE_RE.test(node.host)) {
      stats.priv++;
      continue;
    }
    if (!isPort(String(node.port))) {
      stats.badPort++;
      continue;
    }
    if (seen.has(node.id)) {
      stats.dup++;
      continue;
    }
    // 上游 fragment 常带坏转义（#%V2raySaman），dec 解不动就退回原文
    const hash = dec(fragmentOf(raw));
    node.name = cleanName(hash, `${node.host}:${node.port}`);
    node.raw = raw;
    seen.set(node.id, node);
    stats.ok++;
  }
}

const nodes = [...seen.values()];
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(nodes, null, 0));

const byProto = nodes.reduce((a, n) => ((a[n.proto] = (a[n.proto] || 0) + 1), a), {});
console.log(
  `parsed ${stats.ok} unique nodes from ${stats.in} lines ` +
    `(dup ${stats.dup}, badHost ${stats.badHost}, priv ${stats.priv}, badPort ${stats.badPort}, badProto ${stats.badProto})`
);
console.log('by protocol:', JSON.stringify(byProto));
if (!nodes.length) {
  console.error('解析后无可用节点');
  process.exit(1);
}
