#!/usr/bin/env node
/**
 * test-parse.mjs — parse.mjs 的回归测试
 *
 * 上游经常塞畸形百分号转义（`#%V2raySaman`、`pa%Vss`）。以前 parse.mjs
 * 直接 decodeURIComponent 整串，碰到就抛 URIError，整轮 update 挂在 Parse。
 * 这里用 fixture 驱动，断言坏转义不再打断解析、好转义仍然被解出来。
 */
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

const work = await mkdtemp(join(tmpdir(), 'parse-test-'));
const raw = join(work, 'raw');
await mkdir(raw, { recursive: true });

const lines = [
  // 坏转义 fragment：曾经直接抛 URIError
  'vless://11111111-1111-1111-1111-111111111111@1.2.3.4:443?security=reality&pbk=abc#%V2raySaman',
  // 好转义 fragment：%20 应当被解成空格（cleanName 只留 ASCII）
  'vless://22222222-2222-2222-2222-222222222222@5.6.7.8:8443?security=tls#Hong%20Kong',
  // 坏转义用户名：trojan 密码
  'trojan://pa%Vss@9.9.9.9:443?security=tls#TrojanNode',
  // 普通节点，作为对照
  'ss://YWVzLTI1Ni1nY206cGFzcw@51.52.53.54:8388#Basic',
  // 私网地址应被丢弃
  'ss://YWVzLTI1Ni1nY206cGFzcw@192.168.1.1:8388#Private',
];

await writeFile(join(raw, 'fixture.txt'), lines.join('\n') + '\n');

const out = join(work, 'nodes.json');
let stderr = '';
try {
  await run(process.execPath, [join(ROOT, 'tools', 'parse.mjs')], {
    env: { ...process.env, PARSE_RAW_DIR: raw, PARSE_OUT: out },
  });
} catch (e) {
  console.error('parse.mjs 崩了：');
  console.error(e.stderr || e.message);
  await rm(work, { recursive: true, force: true });
  process.exit(1);
}

const nodes = JSON.parse(await readFile(out, 'utf8'));
await rm(work, { recursive: true, force: true });

const fail = [];
const check = (ok, msg) => {
  if (!ok) fail.push(msg);
};

check(nodes.length === 4, `应当解析出 4 条（私网被丢弃），实际 ${nodes.length}`);

const badFrag = nodes.find((n) => n.host === '1.2.3.4');
check(!!badFrag, '坏转义 fragment 的节点被整条丢掉了');
check(badFrag?.name === '%V2raySaman', `坏转义应原样保留，实际 ${JSON.stringify(badFrag?.name)}`);

const zh = nodes.find((n) => n.host === '5.6.7.8');
check(!!zh, '好转义 fragment 的节点丢了');
check(zh?.name === 'Hong Kong', `好转义应被解出，实际 ${JSON.stringify(zh?.name)}`);

const trojan = nodes.find((n) => n.host === '9.9.9.9');
check(!!trojan, '坏转义用户名的 trojan 节点被丢掉了');

check(!nodes.some((n) => n.host === '192.168.1.1'), '私网节点没被过滤');

if (fail.length) {
  console.error('失败：');
  for (const f of fail) console.error('  - ' + f);
  process.exit(1);
}
console.log(`parse 回归测试通过（${nodes.length} 条）`);
