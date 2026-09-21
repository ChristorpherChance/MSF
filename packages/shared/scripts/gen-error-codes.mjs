#!/usr/bin/env node
/**
 * gen-error-codes.mjs — 从 LLD-3 §14/§15 注册表生成错误码 TS 常量（错误码闭集纪律的代码侧落地，LLD-7 DSG-N06-3）
 *
 * 权威源：doc/product-design/LLD-3-类与数据结构.md
 *   §14 = 一级 DomainError 顶级码（ApiError.error.code）
 *   §15 = 二级门禁/缺口子码 issue code（GateResult.issues[].code）
 * 解析规则与 tools/check-codes.mjs 保持一致（同一表格行格式 `| \`CODE\` |`，「已归并」节废止行不导出活跃码）。
 *
 * 用法：node packages/shared/scripts/gen-error-codes.mjs
 * 产出：packages/shared/src/error-codes.ts（生成物，请勿手改）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const LLD3 = join(ROOT, 'doc/product-design/LLD-3-类与数据结构.md');
const OUT = join(ROOT, 'packages/shared/src/error-codes.ts');

const lines = readFileSync(LLD3, 'utf8').split(/\r?\n/);
const h14 = lines.findIndex((l) => /^## 14\./.test(l));
const h16 = lines.findIndex((l) => /^## 16\./.test(l));
if (h14 < 0 || h16 < 0 || h16 <= h14) {
  console.error('无法在 LLD-3 定位 §14~§15 注册表区');
  process.exit(2);
}

const domain = []; // §14
const issue = []; // §15
const seen = new Set();
let heading = '';
let in15 = false;
for (let i = h14; i < h16; i++) {
  const line = lines[i];
  const h2 = /^## (\d+)\./.exec(line);
  if (h2) in15 = h2[1] === '15';
  const h3 = /^###\s+(.+)$/.exec(line);
  if (h3) heading = h3[1];
  const cell = /^\|\s*`([A-Z][A-Z0-9_]{3,})`\s*\|/.exec(line);
  if (!cell) continue;
  if (heading.includes('已归并')) continue; // 「已归并」节整节不导出：废止码弃用、迁移码在 §15 以活跃身份重新注册
  const code = cell[1];
  if (seen.has(code)) {
    console.error(`注册表内部重复注册: ${code}`);
    process.exit(2);
  }
  seen.add(code);
  (in15 ? issue : domain).push(code);
}

const body = `// 本文件由 packages/shared/scripts/gen-error-codes.mjs 生成，请勿手改。
// 权威源：doc/product-design/LLD-3-类与数据结构.md §14（一级 DomainError）/§15（二级 issue code）
// 纪律（LLD-7 DSG-N06-3）：先注册后使用——新增码必须先落 LLD-3 注册表（走 README §5），再运行 pnpm gen:codes。

/** 一级 DomainError 顶级码（§14，${domain.length} 个） */
export const DOMAIN_ERROR_CODES = [
${domain.map((c) => `  '${c}',`).join('\n')}
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

/** 二级门禁/缺口子码 issue code（§15，${issue.length} 个） */
export const ISSUE_CODES = [
${issue.map((c) => `  '${c}',`).join('\n')}
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

const domainSet: ReadonlySet<string> = new Set(DOMAIN_ERROR_CODES);
const issueSet: ReadonlySet<string> = new Set(ISSUE_CODES);
export const isDomainErrorCode = (s: string): s is DomainErrorCode => domainSet.has(s);
export const isIssueCode = (s: string): s is IssueCode => issueSet.has(s);

/** 平台 DomainError：顶级 code 命中 §14 注册表（LLD-3 DSG-C14-2；HTTP 映射见 LLD-5 §1.4） */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly target?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 门禁判定结果（LLD-3 DSG-C15-1 GateResult）：issues[].code 命中 §15 注册表 */
export interface GateIssue {
  code: IssueCode;
  message: string;
  target?: string;
}
export interface GateResult {
  ok: boolean;
  issues: GateIssue[];
}
`;

writeFileSync(OUT, body);
console.log(`已生成 ${OUT}`);
console.log(`§14 DomainError ${domain.length} 个；§15 issue code ${issue.length} 个`);
