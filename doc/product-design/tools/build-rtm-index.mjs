#!/usr/bin/env node
/**
 * build-rtm-index.mjs — RTM 反向索引生成器（2026-09-20 波次 2 评审整改 / 评审报告 P2-5）
 *
 * 用途：解析 `RTM.md` §3 正向主矩阵，生成反向索引，替代人工检索做变更影响分析（README §5-3）：
 *   - req：REQ/BR 编号 → 矩阵行号（需求变更下钻入口）
 *   - dsg：DSG 条目号 → 引用它的 REQ/BR 及行号清单（设计变更上溯入口）
 *   - cr ：CR 编号 → §3.10 行号
 * 输出：`tools/rtm-index.json`（机器可读，键序确定）+ stdout 统计摘要。
 *
 * 纪律：本索引为派生产物，**随涉及追溯的提交在同一次提交内刷新**（RTM 变更后重跑本脚本）。
 *
 * 用法：
 *   node doc/product-design/tools/build-rtm-index.mjs
 *   （可在任意工作目录运行；路径以本脚本所在位置为基准解析）
 *
 * 解析口径：
 *   - 仅扫描首列为 `REQ-xxx` / `BR-xx` / `CR-xx` 的表格行（§3 各分节矩阵）；
 *   - DSG 引用识别 `DSG-<册字母><章节段>(-<条目段>)`，支持 `A04-2/3/6` 连写展开与
 *     `N02-1~12` 区间展开（同前缀数字区间）；`DSG-M00~M13` 类跨册区间不展开，按基条目登记；
 *   - 退出码：0 = 正常；2 = RTM.md 不可读或无矩阵行。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const RTM = join(DOCS, 'RTM.md');
const OUT = join(DOCS, 'tools', 'rtm-index.json');

let lines;
try {
  lines = readFileSync(RTM, 'utf8').split(/\r?\n/);
} catch (e) {
  console.error(`无法读取 RTM.md：${e.message}`);
  process.exit(2);
}

const req = {};            // REQ-xxx / BR-xx → 行号
const cr = {};             // CR-xx → 行号
const dsg = new Map();     // DSG 条目 → [{ ref, line }]
const warnings = [];

// 展开一段 DSG 引用串为条目号数组，如 "DSG-A04-2/3/6" → [DSG-A04-2, DSG-A04-3, DSG-A04-6]
// 支持区间 "DSG-N02-1~12" → DSG-N02-1 … DSG-N02-12
function expandDsg(token) {
  const m = /^DSG-([A-Z]\d{1,2})(?:-(\d+)((?:[~/]\d+)*))?$/.exec(token);
  if (!m) return [];
  const [, base, first, rest = ''] = [m[0], m[1], m[2], m[3]];
  if (first === undefined) return [`DSG-${base}`];
  const nums = [Number(first)];
  for (const part of rest.match(/[~/]\d+/g) || []) {
    nums.push(Number(part.slice(1)));
  }
  // 区间 "a~b"：若恰含一个 ~ 且 b>a，展开为闭区间
  if (/~\d+/.test(rest) && nums.length === 2 && nums[1] > nums[0]) {
    const [a, b] = nums;
    return Array.from({ length: b - a + 1 }, (_, i) => `DSG-${base}-${a + i}`);
  }
  return nums.map((n) => `DSG-${base}-${n}`);
}

// 从行文本提取全部 DSG 引用（含连写/区间，先抽原始 token 再展开）
function extractDsgRefs(text) {
  const out = [];
  // token：DSG-Xnn 后可带 -n、再带任意 /n 或 ~n 续写
  const re = /DSG-[A-Z]\d{1,2}(?:-\d+(?:[~/]\d+)*)?/g;
  for (const m of text.matchAll(re)) out.push(...expandDsg(m[0]));
  return out;
}

let matrixRows = 0;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const row = /^\|\s*(REQ-\d{3}|BR-\d{2}|CR-\d{2})\s*\|/.exec(line);
  if (!row) continue;
  matrixRows++;
  const id = row[1];
  const lineNo = i + 1;
  if (id.startsWith('CR-')) {
    if (cr[id] !== undefined) warnings.push(`CR 编号重复登记：${id}（行 ${cr[id]} 与 ${lineNo}）`);
    cr[id] = lineNo;
    continue;
  }
  if (req[id] !== undefined) warnings.push(`REQ/BR 编号重复登记：${id}（行 ${req[id]} 与 ${lineNo}）`);
  req[id] = lineNo;
  const refs = extractDsgRefs(line);
  if (refs.length === 0) warnings.push(`${id}（行 ${lineNo}）未引用任何 DSG 条目——需确认是否有豁免说明`);
  for (const d of refs) {
    if (!dsg.has(d)) dsg.set(d, []);
    const bucket = dsg.get(d);
    if (!bucket.some((e) => e.ref === id && e.line === lineNo)) bucket.push({ ref: id, line: lineNo });
  }
}

if (matrixRows === 0) {
  console.error('RTM.md 中未找到任何矩阵行（| REQ-/BR-/CR- 开头）');
  process.exit(2);
}

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const dsgSorted = Object.fromEntries(
  [...dsg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v]),
);

const index = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: 'RTM.md（§3 正向主矩阵）',
  note: '派生产物，随涉及追溯的提交刷新：node doc/product-design/tools/build-rtm-index.mjs',
  req: sortObj(req),
  cr: sortObj(cr),
  dsg: dsgSorted,
};
writeFileSync(OUT, JSON.stringify(index, null, 2) + '\n', 'utf8');

const nReq = Object.keys(req).filter((k) => k.startsWith('REQ-')).length;
const nBr = Object.keys(req).filter((k) => k.startsWith('BR-')).length;
console.log(`反向索引已生成：${OUT}`);
console.log(`矩阵行：REQ ${nReq} 条 / BR ${nBr} 条 / CR ${Object.keys(cr).length} 条（合计 ${matrixRows} 行）`);
console.log(`反向索引覆盖 DSG 条目 ${dsg.size} 个`);
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 处：`);
  for (const w of warnings) console.log('  ' + w);
} else {
  console.log('自检：无重复登记、无零引用矩阵行');
}
