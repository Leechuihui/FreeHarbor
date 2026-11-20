#!/usr/bin/env node
/**
 * probe.mjs — 对 data/nodes.json 里的节点做 TCP 连通性探测，按延迟排序
 *
 * 只测 TCP 握手。TCP 通不代表能出网（可能有假节点/挂羊头的），
 * 但 TCP 不通的一定不能用，这层过滤能把 4911 条里的大半垃圾砍掉。
 *
 * 输出 data/checked.json，含 latency 字段，按延迟升序。
 * 参数：--limit=N 最多测多少条（默认 1200，按节点新鲜度随机抽样）
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN = join(ROOT, 'data', 'nodes.json');
const OUT = join(ROOT, 'data', 'checked.json');

const CONCURRENCY = 64;
const TIMEOUT_MS = 2500;
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : 1200;

const nodes = JSON.parse(await readFile(IN, 'utf8'));

// 打散后截断，避免上游靠前的源垄断全部名额
for (let i = nodes.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
}
const sample = nodes.slice(0, LIMIT);

function probe(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    let done = false;
    const finish = (latency) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(latency);
    };
    sock.setTimeout(TIMEOUT_MS);
    sock.once('connect', () => finish(Date.now() - started));
    sock.once('timeout', () => finish(null));
    sock.once('error', () => finish(null));
    sock.connect(Number(port), host);
  });
}

const alive = [];
let idx = 0;
let doneCount = 0;

async function worker() {
  while (idx < sample.length) {
    const node = sample[idx++];
    const latency = await probe(node.host, node.port);
    doneCount++;
    if (doneCount % 100 === 0) process.stderr.write(`  ${doneCount}/${sample.length}\n`);
    if (latency !== null) alive.push({ ...node, latency });
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

alive.sort((a, b) => a.latency - b.latency);
await writeFile(OUT, JSON.stringify(alive, null, 0));

const pct = ((alive.length / sample.length) * 100).toFixed(1);
console.log(`probed ${sample.length}, alive ${alive.length} (${pct}%)`);
if (!alive.length) {
  console.error('零存活节点');
  process.exit(1);
}
const byProto = alive.reduce((a, n) => ((a[n.proto] = (a[n.proto] || 0) + 1), a), {});
console.log('alive by protocol:', JSON.stringify(byProto));
console.log('best latency:', alive[0].latency, 'ms');
