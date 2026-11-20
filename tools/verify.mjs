#!/usr/bin/env node
/**
 * verify.mjs — 用本地 xray 内核做真实出网验证
 *
 * TCP 探测只证明端口开着，代理可能压根不工作（假节点、协议对不上、凭证过期）。
 * 这里起一个 xray 进程：每个候选节点一个 socks5 入口，入口路由到自己的 outbound，
 * 然后 curl 经该 socks 打 generate_204。HTTP 204 才算真能用。
 *
 * 输入 data/checked.json → 输出 data/verified.json（带 latency，按延迟升序）
 * 参数：--limit=N 最多验多少条（默认 260）
 *
 * xray 26 起已移除 Shadowsocks，连同 hysteria2 / tuic / ssr 一起直接放行，
 * 标 verified:"skip"，不做假阳性也不丢节点。
 */
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'data', 'checked.json');
const OUT = join(ROOT, 'data', 'verified.json');

const XRAY = process.env.XRAY_BIN || 'xray';
const BASE_PORT = 21000;
const CONCURRENCY = Number(process.env.VERIFY_CONCURRENCY || 16);
const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 15000);
const TEST_URL = process.env.VERIFY_URL || 'https://www.gstatic.com/generate_204';

const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 260;

const checked = JSON.parse(await readFile(IN, 'utf8'));
// ss 在 xray 26 里已整个移除（unknown config id: ss），只能跳过
const supported = ['vless', 'vmess', 'trojan'];
const candidates = checked.filter((n) => supported.includes(n.proto)).slice(0, LIMIT);
const skipped = checked.filter((n) => !supported.includes(n.proto));

function q(raw) {
  try {
    return new URL(raw).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** 节点 → xray streamSettings（传输层 + 安全层） */
function streamOf(n) {
  const p = q(n.raw);
  const net = p.get('type') || n.net || 'tcp';
  const sec = p.get('security') || (n.tls ? 'tls' : 'none');
  const sni = p.get('sni') || p.get('host') || n.sni || n.host;

  const s = { network: net === 'httpupgrade' ? 'httpupgrade' : net };

  // REALITY 只支持 RAW / XHTTP / gRPC；ws 系组合 xray 会直接拒绝整个配置
  if (sec === 'reality' && (net === 'ws' || net === 'httpupgrade')) return null;

  // ws / httpupgrade 走 http/1.1，grpc / xhttp 走 h2；不带 ALPN 会被 Cloudflare 直接拒握手
  const alpn = net === 'grpc' || net === 'xhttp' ? ['h2'] : ['http/1.1'];

  if (sec === 'reality') {
    s.security = 'reality';
    s.realitySettings = {
      serverName: sni,
      publicKey: p.get('pbk') || '',
      shortId: p.get('sid') || '',
      fingerprint: p.get('fp') || 'chrome',
      spiderX: '/',
    };
  } else if (sec === 'tls' || sec === 'xtls') {
    s.security = 'tls';
    // Xray 26 起 allowInsecure 已移除，改用 fingerprint + 不校验证书链
    s.tlsSettings = {
      serverName: sni,
      fingerprint: p.get('fp') || 'chrome',
      alpn,
    };
  }

  if (net === 'ws') {
    s.wsSettings = {
      path: p.get('path') || '/',
      headers: { Host: p.get('host') || sni },
    };
  } else if (net === 'httpupgrade') {
    // Xray 26 起 httpupgrade 的 host 必须是独立字段，放进 headers 会报错
    s.httpupgradeSettings = { path: p.get('path') || '/', host: p.get('host') || sni };
  } else if (net === 'grpc') {
    s.grpcSettings = { serviceName: p.get('serviceName') || p.get('path') || '' };
  } else if (net === 'xhttp') {
    s.network = 'xhttp';
    s.xhttpSettings = { path: p.get('path') || '/', host: p.get('host') || sni };
  }
  return s;
}

/** 节点 → xray outbound，不支持的返回 null */
function outboundOf(n, tag) {
  const port = Number(n.port);
  const base = { tag, protocol: n.proto, streamSettings: streamOf(n) };
  try {
    if (n.proto === 'vless') {
      const p = q(n.raw);
      const u = new URL(n.raw);
      return {
        ...base,
        settings: {
          vnext: [
            {
              address: n.host,
              port,
              users: [{ id: u.username, encryption: 'none', flow: p.get('flow') || '' }],
            },
          ],
        },
      };
    }
    if (n.proto === 'vmess') {
      const j = JSON.parse(Buffer.from(n.raw.slice(8).split('#')[0], 'base64').toString('utf8'));
      return {
        ...base,
        settings: {
          vnext: [
            { address: n.host, port, users: [{ id: j.id, alterId: Number(j.aid || 0), security: 'auto' }] },
          ],
        },
      };
    }
    if (n.proto === 'trojan') {
      return {
        ...base,
        settings: { servers: [{ address: n.host, port, password: decodeURIComponent(new URL(n.raw).username) }] },
      };
    }
  } catch {
    return null;
  }
  return null;
}

// 只要有一条 xray 不认的配置，整个进程就起不来；先滤掉构造不出 outbound 的
const pool = [];
for (const n of candidates) {
  if (outboundOf(n, 'probe')) pool.push(n);
  else skipped.push({ ...n, verified: 'skip' }); // 构造不出配置也别丢，归入未验证
}

if (!pool.length) {
  console.error('没有可验证的节点');
  process.exit(1);
}

const workDir = await mkdtemp(join(tmpdir(), 'vpn-verify-'));
const configPath = join(workDir, 'config.json');

/** 当前 pool → 完整配置，下标即 socks 端口 */
function buildConfig(nodes) {
  const inbounds = [];
  const outbounds = [];
  const rules = [];
  nodes.forEach((n, i) => {
    const tag = `o-${i}`;
    inbounds.push({
      tag: `i-${i}`,
      listen: '127.0.0.1',
      port: BASE_PORT + i,
      protocol: 'socks',
      settings: { auth: 'noauth', udp: false },
    });
    outbounds.push(outboundOf(n, tag));
    rules.push({ type: 'field', inboundTag: [`i-${i}`], outboundTag: tag });
  });
  outbounds.push({ tag: 'freedom', protocol: 'freedom' });
  return {
    log: { loglevel: 'error' },
    dns: { servers: ['1.1.1.1', '8.8.8.8'] },
    inbounds,
    outbounds,
    routing: { domainStrategy: 'AsIs', rules },
  };
}

/** 等端口开；进程提前退出也算失败，不用干等到超时 */
const waitPort = (port, proc) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const t0 = Date.now();
    const tryOnce = () => {
      if (settled) return;
      const s = new net.Socket();
      s.once('connect', () => {
        s.destroy();
        done(true);
      });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > 10000) done(false);
        else setTimeout(tryOnce, 200);
      });
      s.connect(port, '127.0.0.1');
    };
    proc.once('exit', () => setTimeout(() => done(false), 150));
    tryOnce();
  });

// 坏配置逐条剔除重试，最多 40 轮，避免个别畸形节点让整批验证白跑
const MAX_DROP = 40;
let xray = null;
let xrayErr = '';
let ready = false;

for (let attempt = 0; attempt <= MAX_DROP; attempt++) {
  await writeFile(configPath, JSON.stringify(buildConfig(pool), null, 2));

  xrayErr = '';
  xray = execFile(XRAY, ['run', '-c', configPath], { maxBuffer: 1 << 22 });
  xray.stdout?.on('data', (d) => (xrayErr += d));
  xray.stderr?.on('data', (d) => (xrayErr += d));

  ready = await waitPort(BASE_PORT, xray);
  if (ready) break;

  const m = xrayErr.match(/failed to build outbound config with tag (o-\d+)/);
  if (!m) {
    console.error('xray 未能启动:\n' + xrayErr.slice(-1500));
    xray.kill();
    await rm(workDir, { recursive: true, force: true });
    process.exit(1);
  }
  const bad = Number(m[1].slice(2));
  console.error(`剔除 xray 不支持的节点: ${pool[bad].proto} ${pool[bad].host}:${pool[bad].port}`);
  skipped.push({ ...pool.splice(bad, 1)[0], verified: 'skip' });
  xray.kill();
  await new Promise((r) => setTimeout(r, 300));

  if (!pool.length) {
    console.error('所有节点都不被 xray 支持');
    await rm(workDir, { recursive: true, force: true });
    process.exit(1);
  }
}

if (!ready) {
  console.error('重试次数用尽:\n' + xrayErr.slice(-1500));
  xray.kill();
  await rm(workDir, { recursive: true, force: true });
  process.exit(1);
}

// 下标即 socks 端口
const usable = pool.map((n, i) => ({ ...n, socks: BASE_PORT + i }));

const curl = promisify(execFile);

async function testOne(node) {
  const started = Date.now();
  try {
    const { stdout } = await curl(
      'curl',
      [
        '-x', `socks5h://127.0.0.1:${node.socks}`,
        '--max-time', String(Math.ceil(TIMEOUT_MS / 1000)),
        '-s', '-o', '/dev/null',
        '-w', '%{http_code}',
        TEST_URL,
      ],
      { timeout: TIMEOUT_MS + 3000 }
    );
    const code = stdout.trim();
    // 204 是标准；200 也算通（部分出口会改响应）
    if (code === '204' || code === '200') return Date.now() - started;
  } catch {
    /* 超时或连接失败 */
  }
  return null;
}

const verified = [];
let cursor = 0;
let doneCount = 0;

async function worker() {
  while (cursor < usable.length) {
    const node = usable[cursor++];
    const latency = await testOne(node);
    doneCount++;
    if (doneCount % 25 === 0) process.stderr.write(`  ${doneCount}/${usable.length}\n`);
    if (latency !== null) verified.push({ ...node, latency });
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

xray.kill();
await rm(workDir, { recursive: true, force: true });

verified.sort((a, b) => a.latency - b.latency);

// 未验证的协议原样并入，标 skip，避免白白丢掉
const merged = [
  ...verified.map((n) => ({ ...n, verified: 'ok' })),
  ...skipped.map((n) => ({ ...n, verified: 'skip' })),
];

await writeFile(OUT, JSON.stringify(merged, null, 0));

const pct = ((verified.length / usable.length) * 100).toFixed(1);
console.log(`verified ${verified.length}/${usable.length} egress-ok (${pct}%), skipped ${skipped.length}`);
if (!verified.length) {
  console.error('无节点真实出网');
  console.error(xrayErr.slice(-800));
  process.exit(1);
}
console.log('best latency:', verified[0].latency, 'ms');
const byProto = verified.reduce((a, n) => ((a[n.proto] = (a[n.proto] || 0) + 1), a), {});
console.log('verified by protocol:', JSON.stringify(byProto));
