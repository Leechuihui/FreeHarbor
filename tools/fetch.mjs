#!/usr/bin/env node
/**
 * fetch.mjs — 抓取上游免费节点源，原样落到 data/raw/
 *
 * 上游有三种格式：
 *   1. 明文节点列表（每行一个 ss:// vmess:// ...）
 *   2. 整段 base64 订阅
 *   3. Clash YAML（proxies: [...]）
 * 这里只负责"拿到并归一化成明文行"，格式解析交给 parse.mjs。
 * 单个源失败不中断整体。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const TIMEOUT_MS = 25_000;
const UA = 'v2rayN/6.31 clash-verge/1.7.7';

/** base64 → utf8，容忍 URL-safe 与缺失 padding；不是 base64 就返回 null */
function tryB64(s) {
  const t = s.trim().replace(/\s+/g, '');
  if (!/^[A-Za-z0-9_\-+/=]+$/.test(t) || t.length < 32) return null;
  try {
    const out = Buffer.from(t.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    // 解出来必须是可见文本且含协议头，否则视为误判
    if (!/^(ss|vmess|vless|trojan|hysteria2?|hy2|tuic):\/\//m.test(out)) return null;
    if (/[\u0000-\u0008\u000e-\u001f]/.test(out.slice(0, 512))) return null;
    return out;
  } catch {
    return null;
  }
}

/** Clash YAML → 协议 URI。只做够用的字段映射，不求覆盖全部。 */
function clashToUris(yamlText) {
  const out = [];
  const lines = yamlText.split(/\r?\n/);
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const { type, name, server, port } = cur;
    const ps = encodeURIComponent(name || `${server}:${port}`);
    try {
      if (type === 'ss' && cur.cipher && cur.password) {
        const userinfo = Buffer.from(`${cur.cipher}:${cur.password}`).toString('base64url');
        out.push(`ss://${userinfo}@${server}:${port}#${ps}`);
      } else if (type === 'trojan' && cur.password) {
        const q = new URLSearchParams({ security: 'tls', sni: cur.sni || server, allowInsecure: '1' });
        out.push(`trojan://${encodeURIComponent(cur.password)}@${server}:${port}?${q}#${ps}`);
      } else if (type === 'vless' && cur.uuid) {
        const q = new URLSearchParams({ encryption: 'none', security: 'tls', sni: cur.sni || server, allowInsecure: '1' });
        out.push(`vless://${cur.uuid}@${server}:${port}?${q}#${ps}`);
      } else if (type === 'vmess' && cur.uuid) {
        const o = { v: '2', ps: name || '', add: server, port: String(port), id: cur.uuid, aid: '0', net: 'ws', type: 'none', host: cur.sni || server, path: '/', tls: 'tls' };
        out.push(`vmess://${Buffer.from(JSON.stringify(o)).toString('base64')}`);
      }
    } catch { /* 单条坏掉不影响 */ }
    cur = null;
  };

  for (const line of lines) {
    const m = line.match(/^\s*-\s+\{?\s*(?:name|ps)\s*:\s*["']?([^"',}]+)/);
    const t = line.match(/^\s*-\s+\{?.*\btype\s*:\s*["']?([a-z0-9-]+)/i);
    if (line.match(/^\s*-\s/) && (m || t)) {
      flush();
      cur = { type: (t?.[1] || '').toLowerCase(), name: m?.[1]?.trim() };
      if (!cur.type) { cur = null; continue; }
      continue;
    }
    if (!cur) continue;
    const kv = (key, dst = key) => {
      const r = line.match(new RegExp(`\\b${key}\\s*:\\s*["']?([^"'#,}]+)`, 'i'));
      if (r) cur[dst] = r[1].trim();
    };
    kv('server', 'server'); kv('port', 'port'); kv('cipher');
    kv('password'); kv('uuid'); kv('sni');
    kv('servername', 'sni');
    const p = line.match(/\bport\s*:\s*(\d+)/i);
    if (p) cur.port = p[1];
  }
  flush();
  return out;
}

async function fetchOne(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** 任意上游响应 → 明文 URI 行数组 */
function normalize(body) {
  if (/^\s*(proxies|proxy-providers)\s*:/m.test(body)) return clashToUris(body);
  const decoded = tryB64(body);
  const text = decoded ?? body;
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^(ss|ssr|vmess|vless|trojan|hysteria2?|hy2|tuic):\/\//i.test(l));
}

const urls = (await readFile(join(ROOT, 'tools', 'sources.txt'), 'utf8'))
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

await mkdir(RAW, { recursive: true });

let ok = 0;
let total = 0;
const report = [];

await Promise.all(
  urls.map(async (url, i) => {
    const tag = new URL(url).hostname + '-' + i;
    try {
      const body = await fetchOne(url);
      const lines = normalize(body);
      if (!lines.length) throw new Error('no nodes');
      await writeFile(join(RAW, `${tag}.txt`), lines.join('\n') + '\n');
      ok++;
      total += lines.length;
      report.push(`  ok   ${String(lines.length).padStart(5)}  ${tag}`);
    } catch (e) {
      report.push(`  FAIL         -  ${tag}  (${e.message})`);
    }
  })
);

console.log(`fetched ${ok}/${urls.length} sources, ${total} raw lines`);
console.log(report.sort().join('\n'));
if (!ok) {
  console.error('所有源都失败');
  process.exit(1);
}
