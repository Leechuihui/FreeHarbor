#!/usr/bin/env node
/**
 * quality-gate.mjs — 提交前的质量闸门，防止「跑通了但结果是垃圾」也上线
 *
 * 自动化跑久了必然会遇到上游集体抽风：源全挂、xray 装不上、验证 0 存活。
 * 这些情况脚本大多会 exit 0（verify 有 continue-on-error、export 会回退到
 * TCP-only），于是 CI 全绿、垃圾数据照样 commit 上线，把上一轮的好数据冲掉。
 *
 * 这里在 commit 之前卡一道：
 *   1. 本轮真实验证通过数不得低于绝对下限
 *   2. 不得比上一轮已提交的结果暴跌（防止大面积退化）
 *   3. 退化模式（verify 整轮失败、只剩 TCP 结果）要求更高的绝对条数
 *
 * 不通过则 exit 1，由调用方回滚工作树、保留上一轮线上数据。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 已验证出网的绝对下限。历史正常水位 100~150，取 25 留足上游波动空间
const MIN_OK = Number(process.env.GATE_MIN_OK || 25);
// 相对上一轮允许的最大跌幅（保留 60%）
const MIN_RATIO = Number(process.env.GATE_MIN_RATIO || 0.6);
// 退化模式（只剩 TCP 探测结果）下的绝对下限，门槛更高
const MIN_DEGRADED = Number(process.env.GATE_MIN_DEGRADED || 150);

const degraded = process.argv.includes('--degraded');
// --save：只把本轮结果记为基线，不做校验。由工作流在推送成功后单独调用，
// 保证基线永远等于「真正上线过」的水位，而不是「跑过了但没推上去」的水位。
const saveOnly = process.argv.includes('--save');
const fail = (msg) => {
  console.error(`::error::质量闸门未通过: ${msg}`);
  process.exit(1);
};

async function countOk(path) {
  try {
    const nodes = JSON.parse(await readFile(join(ROOT, path), 'utf8'));
    return nodes.filter((n) => n.verified === 'ok').length;
  } catch {
    return null;
  }
}

async function countTotal(path) {
  // checked.json 是 probe 的产物，没有 verified 字段，只能数总条数
  try {
    const nodes = JSON.parse(await readFile(join(ROOT, path), 'utf8'));
    return Array.isArray(nodes) ? nodes.length : null;
  } catch {
    return null;
  }
}

const BASELINE = join(ROOT, 'data', 'baseline.json');

async function baselineOk() {
  // 基线单独存一个文件，不能直接读 HEAD:data/verified.json ——
  // verify 失败时上游会 rm 掉 verified.json，而它是 git 跟踪的，
  // 删除会被 git add -A 一起提交；之后从 HEAD 读恒为空，
  // 相对跌幅检查就永久失效了（只剩绝对下限）。
  try {
    const raw = await readFile(BASELINE, 'utf8');
    const n = Number(JSON.parse(raw).ok);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0; // 还没有基线（首次运行 / 升级前的历史仓库）
  }
}

async function saveBaseline(ok) {
  // 只由 --save 调用（已推送成功）；退化模式不记，保住「正常水位」这条参照线
  await writeFile(BASELINE, JSON.stringify({ ok, at: new Date().toISOString() }) + '\n');
}

if (saveOnly) {
  // 由工作流在推送成功后调用：此刻数据确实已上线，才值得作为基线
  const ok = await countOk('data/verified.json');
  if (ok === null) fail('data/verified.json 缺失，无法记录基线');
  await saveBaseline(ok);
  console.log(`基线已更新为 ${ok}`);
  process.exit(0);
}

if (degraded) {
  const total = await countTotal('data/checked.json');
  if (total === null) fail('data/checked.json 缺失，本轮没有任何可用节点');
  if (total < MIN_DEGRADED) fail(`退化模式仅有 ${total} 条 TCP 存活，低于下限 ${MIN_DEGRADED}`);
  console.log(`退化模式通过: ${total} 条 TCP 存活 (>= ${MIN_DEGRADED})`);
  process.exit(0);
}

const current = await countOk('data/verified.json');
if (current === null) fail('data/verified.json 缺失，verify 未产出结果');

const base = await baselineOk();

if (current < MIN_OK) fail(`本轮仅 ${current} 条真实出网，低于绝对下限 ${MIN_OK}`);

if (base > 0) {
  const floor = Math.floor(base * MIN_RATIO);
  if (current < floor) fail(`本轮 ${current} 条较上一轮 ${base} 条跌幅过大，低于下限 ${floor}`);
  console.log(`通过: ${current} 条出网 (上一轮 ${base}，下限 ${floor})`);
} else {
  console.log(`通过: ${current} 条出网 (无历史基线，仅校验绝对下限 ${MIN_OK})`);
}

// 这里不写基线：闸门跑在 export 之前，后面还可能失败、不提交。
// 由工作流在 push 成功后调 `--save`，基线才等于真正上线过的水位。

// 注意：本脚本跑在 export 之前，此处 sub/ 还是上一轮的旧产物，
// 只能证明「曾经导出成功」，不能证明本轮。本轮产物由后续的 Verify artifacts 步把关。
