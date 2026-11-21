#!/usr/bin/env node
/**
 * test-export.mjs — export.mjs 的冒烟测试
 *
 * export.mjs 用自身位置推导 ROOT，所以这里把 tools/ 拷进临时根目录、
 * 链接 node_modules，再喂一份 fixture 的 verified.json，让它在临时目录里
 * 完整跑一遍。真实 sub/ qr/ clients/ 不受影响。
 *
 * 重点守两件事：
 *   1. 畸形百分号转义的用户名（trojan 密码 pa%Vss）不再炸，且原样保留；
 *   2. 产物齐全、YAML/JSON 可解析、模板占位符全部被替换。
 */
import { mkdtemp, mkdir, cp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const yaml = require('js-yaml');
const run = promisify(execFile);

const work = await mkdtemp(join(tmpdir(), 'export-test-'));
try {
  await cp(join(ROOT, 'tools'), join(work, 'tools'), { recursive: true });
  await mkdir(join(work, 'data'), { recursive: true });
  // ESM 不认 NODE_PATH，直接链到真实依赖目录
  await symlink(join(ROOT, 'node_modules'), join(work, 'node_modules'), 'dir');

  const fixture = [
    {
      proto: 'vless', host: '1.2.3.4', port: '443', sni: 'a.example', net: 'tcp', tls: true,
      raw: 'vless://11111111-1111-1111-1111-111111111111@1.2.3.4:443?security=reality&pbk=abc&sid=00&fp=chrome#%V2raySaman',
      latency: 120, verified: 'ok',
    },
    {
      proto: 'vmess', host: '5.6.7.8', port: '8443', sni: '', net: 'ws', tls: true,
      raw: 'vmess://' + Buffer.from(JSON.stringify({ v: '2', add: '5.6.7.8', port: '8443', id: '22222222-2222-2222-2222-222222222222', aid: '0', net: 'ws', tls: 'tls' })).toString('base64'),
      latency: 210, verified: 'ok',
    },
    {
      // 坏转义密码：以前 decodeURIComponent 直接抛
      proto: 'trojan', host: '9.9.9.9', port: '443', sni: '', net: 'tcp', tls: true,
      raw: 'trojan://pa%Vss@9.9.9.9:443?security=tls#TrojanNode',
      latency: 300, verified: 'ok',
    },
    {
      proto: 'ss', host: '51.52.53.54', port: '8388', sni: '', net: 'tcp', tls: false,
      raw: 'ss://YWVzLTI1Ni1nY206cGFzcw@51.52.53.54:8388#Basic',
      latency: 400, verified: 'ok',
    },
    {
      proto: 'hysteria2', host: '7.8.9.10', port: '443', sni: '', net: 'quic', tls: true,
      raw: 'hysteria2://pw%Vbad@7.8.9.10:443?sni=h.example#Hy2',
      latency: 500, verified: 'ok',
    },
  ];
  await writeFile(join(work, 'data', 'verified.json'), JSON.stringify(fixture));

  let stdout = '';
  try {
    ({ stdout } = await run(process.execPath, [join(work, 'tools', 'export.mjs')], { cwd: work }));
  } catch (e) {
    console.error('export.mjs 崩了：');
    console.error(e.stderr || e.message);
    process.exit(1);
  }

  const fail = [];
  const check = (ok, msg) => {
    if (!ok) fail.push(msg);
  };

  const allTxt = await readFile(join(work, 'sub', 'all.txt'), 'utf8');
  const uris = allTxt.split('\n').filter(Boolean);
  check(uris.length === fixture.length, `订阅条数应为 ${fixture.length}，实际 ${uris.length}`);
  check(/VLESS-120ms-001/.test(allTxt), '节点名未按「协议-延迟-序号」重排');

  const clash = yaml.load(await readFile(join(work, 'clients', 'clash.yaml'), 'utf8'));
  check(clash.proxies.length === fixture.length, `clash 代理数不对：${clash.proxies.length}`);
  const trojan = clash.proxies.find((p) => p.type === 'trojan');
  check(trojan?.password === 'pa%Vss', `坏转义密码应原样保留，实际 ${JSON.stringify(trojan?.password)}`);
  const hy2 = clash.proxies.find((p) => p.type === 'hysteria2');
  check(hy2?.password === 'pw%Vbad', `hy2 坏转义密码应原样保留，实际 ${JSON.stringify(hy2?.password)}`);
  check(new Set(clash.proxies.map((p) => p.name)).size === clash.proxies.length, 'clash 代理名有重复');

  const singbox = JSON.parse(await readFile(join(work, 'clients', 'singbox.json'), 'utf8'));
  check(Array.isArray(singbox.outbounds), 'singbox outbounds 不是数组');

  const html = await readFile(join(work, 'index.html'), 'utf8');
  const readme = await readFile(join(work, 'README.md'), 'utf8');
  check(!/%%[A-Z_]+%%/.test(html), 'index.html 还有没替换的占位符');
  check(!/%%[A-Z_]+%%/.test(readme), 'README.md 还有没替换的占位符');

  const qrs = (await readdir(join(work, 'qr'))).filter((f) => f.endsWith('.png'));
  check(qrs.length >= fixture.length, `二维码数量不对：${qrs.length}`);

  if (fail.length) {
    console.error('失败：');
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
  }
  console.log(`export 冒烟测试通过（${uris.length} 条，${qrs.length} 张码）`);
  console.log(stdout.trim().split('\n')[0]);
} finally {
  await rm(work, { recursive: true, force: true });
}
