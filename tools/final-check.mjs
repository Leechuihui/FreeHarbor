#!/usr/bin/env node
/** final-check.mjs — 从权威 blob 拉取线上 index.html 核验双语要素 */
import { writeFile } from 'node:fs/promises';

const T = process.argv[2];
if (!T) throw new Error('usage: final-check.mjs <TOKEN>');

const headers = { Authorization: 'Bearer ' + T, Accept: 'application/vnd.github+json' };
const meta = await fetch('https://api.github.com/repos/Leechuihui/FreeHarbor/contents/index.html?ref=main', { headers }).then((r) => r.json());
const blob = await fetch('https://api.github.com/repos/Leechuihui/FreeHarbor/git/blobs/' + meta.sha, { headers }).then((r) => r.json());
const html = Buffer.from(blob.content, 'base64').toString('utf8');
await writeFile('/tmp/final_page.html', html);

const checks = {
  FreeHarbor: html.includes('FreeHarbor'),
  zhBadge: html.includes('永久免费'),
  enBadge: html.includes('ALWAYS FREE'),
  zhDict: html.includes("tagline: 'GitHub 自动抓取"),
  enDict: html.includes("tagline: 'Auto-scraped on GitHub"),
  langButtons: html.includes('btn-zh') && html.includes('btn-en'),
  guideImgs: (html.match(/guide-img/g) || []).length,
  dataEnZh: (html.match(/data-en=/g) || []).length + '/' + (html.match(/data-zh=/g) || []).length,
  statusMap: html.includes('var STATUS'),
  localStorage: html.includes('fh-lang'),
  langDetect: html.includes('navigator.language'),
};
console.log(JSON.stringify(checks, null, 2));
