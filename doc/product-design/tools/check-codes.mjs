#!/usr/bin/env node
/**
 * check-codes.mjs — 错误码两级制闭集校验（2026-09-20 波次 0 评审整改 / 统稿裁决 R-01）
 *
 * 用法：
 *   node doc/product-design/tools/check-codes.mjs
 *   （可在任意工作目录运行；文档路径以本脚本所在位置为基准解析）
 *
 * 规则：
 *   - 一级注册表 = LLD-3 §14（DSG-C14-2，DomainError 顶级错误码，活跃码）
 *   - 二级注册表 = LLD-3 §15（DSG-C15-1，门禁/缺口子码 issue code，活跃码）
 *   - DSG-C14-3「已归并与已迁移码」表 = 废止码：出现在任何被扫文档中即违规
 *   - 扫描范围：LLD-1/LLD-2/LLD-5 全文，LLD-3 的 §14~§15 注册表区之外部分，
 *     以及 PRD/CRD/HLD/LLD-4/LLD-6/LLD-7/RTM（各文件「修订记录」章节除外——
 *     修订记录允许引用历史码值以说明归并去向）
 *   - 不扫描《统稿裁决记录.md》（归并映射的权威记录处，合法引用废止码）
 *   - 提取 UPPER_SNAKE 候选码（长度≥4，不含连字符标识符片段与行号/颜色字面量）；
 *     候选码必须命中活跃注册表，否则违规（退出码 1）
 *
 * 退出码：0 = 零违规；1 = 存在表外码或废止码被使用
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..');
const LLD3 = 'LLD-3-类与数据结构.md';

// 非码 token 白名单（一律不视为错误码，按类注释维护；新增需说明理由）
const NON_CODE = new Set([
  // 协议/格式/技术名词
  'HTML', 'HTTP', 'HTTPS', 'REST', 'JSON', 'JSONB', 'JSONL', 'CSRF', 'SSRF',
  'OIDC', 'LDAP', 'RBAC', 'ASCII', 'ISO8601', 'SHA256', 'UUID', 'ULID',
  'CRC32', 'DEFLATE', 'STORE', 'ZIP64', 'EOCD', 'YOLO', 'CRUD',
  // HTTP/SQL 动词与关键字（LLD-4 DDL、LLD-5 端点表）
  'POST', 'PATCH', 'DELETE', 'UPDATE', 'INSERT', 'SELECT', 'WHERE', 'FROM',
  'JOIN', 'LIMIT', 'NULL', 'DEFAULT', 'UNIQUE', 'CHECK', 'BEFORE', 'RAISE',
  'EXCEPTION', 'TRUNCATE', 'DESC', 'APPEND_ONLY', 'BRIN', 'HOME',
  // 文档/散文词/文件名
  'README', 'CONTRIBUTING', 'UPPER_SNAKE', 'STOPPED', 'VERIFY',
  // 原型事实源标识符（非本平台码值；仅允许出现在「原型出处」语境，靠评审约束）
  'AGENT_TOOLS', 'NAV_MAP', 'NAV_KEYS', 'DEV_ACTION_REGISTRY', 'DEV_RUNTIME',
  'V17_TASKS', 'V17_CATALOG', 'V17_DEV_ACTIONS', 'V18_ACTIONS',
  'V19_DESIGN_CATALOG', 'V19_UI_ACCEPTANCE_RULES', 'V19_RUNTIME', 'V19_TEST_HOOKS',
  'DEV_EVENT_UNKNOWN', 'DEV_STATE_OWNER_INVALID', 'SPEC_WRITE_SCOPE',
  'WRITE_SCOPE_ACTIVE', 'SERVICE_ACTION_BY_UI_COMMAND', 'ST_LABEL', 'DESIGN_PRE',
  'PROTO', 'MZIP', 'CREF', 'RCPT', 'DETAIL_FACETS', 'DSG_DEFS',
  // 族简写：`LAST_TRANSITION_*` 指代 LLD-3 §14(j) 已实名注册的 8 码族
  'LAST_TRANSITION_',
]);

const SCAN_FILES = [
  'LLD-1-模块设计.md', 'LLD-2-算法与流程.md', 'LLD-5-API接口.md',
  LLD3, // 仅扫 §14~§15 注册表区之外
  'PRD.md', 'CRD.md', 'HLD.md', 'RTM.md',
  'LLD-4-数据库设计.md', 'LLD-6-UI设计.md', 'LLD-7-非功能规则.md',
];

// 候选码：UPPER_SNAKE，≥4 字符；排除连字符标识符片段（INV-BULK-1、DESIGN-BL-3）
const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Z][A-Z0-9_]{3,}(?![A-Za-z0-9_-])/g;
const isLineRef = (t) => /^L\d+$/.test(t);          // 原型行号引用 L8910
const isHexLiteral = (t) => /^[A-F0-9]{4,}$/.test(t); // 颜色/掩码字面量

function readLines(name) {
  return readFileSync(join(DOCS, name), 'utf8').split(/\r?\n/);
}

// ---- 解析 LLD-3 注册表区（§14~§15） ----
const lld3 = readLines(LLD3);
const h14 = lld3.findIndex((l) => /^## 14\./.test(l));
const h16 = lld3.findIndex((l) => /^## 16\./.test(l));
if (h14 < 0 || h16 < 0 || h16 <= h14) {
  console.error('无法在 LLD-3 定位 §14~§15 注册表区');
  process.exit(2);
}

const active = new Map();   // code → '§14' | '§15'
const deprecated = new Map(); // code → 去向描述
let heading = '';
let in15 = false;
for (let i = h14; i < h16; i++) {
  const line = lld3[i];
  const h2 = /^## (\d+)\./.exec(line);
  if (h2) in15 = h2[1] === '15';
  const h3 = /^###\s+(.+)$/.exec(line);
  if (h3) heading = h3[1];
  const cell = /^\|\s*`([A-Z][A-Z0-9_]{3,})`\s*\|/.exec(line);
  if (!cell) continue;
  const code = cell[1];
  if (heading.includes('已归并')) {
    // 仅「废止（同义归并/拆分）」禁止使用；「迁移（层级调整）」码在 §15 仍活跃
    if (line.includes('废止')) deprecated.set(code, line.slice(0, 120));
  } else {
    if (active.has(code)) {
      console.error(`注册表内部重复注册: ${code}（${active.get(code)} 与 ${in15 ? '§15' : '§14'}）`);
      process.exit(2);
    }
    active.set(code, in15 ? '§15' : '§14');
  }
}

// ---- 扫描 ----
const violations = [];
function scanFile(name) {
  const lines = readLines(name);
  // 跳过「修订记录」章节（允许引用历史码值）
  const changelogIdx = lines.findIndex((l) => /^##\s*\d*\.?\s*修订记录/.test(l));
  const end = changelogIdx >= 0 ? changelogIdx : lines.length;
  for (let i = 0; i < end; i++) {
    if (name === LLD3 && i >= h14 && i < h16) continue; // 注册表区不扫
    const line = lines[i];
    for (const m of line.matchAll(TOKEN_RE)) {
      const tok = m[0];
      if (isLineRef(tok) || isHexLiteral(tok) || NON_CODE.has(tok)) continue;
      if (deprecated.has(tok)) {
        violations.push(`${name}:${i + 1}  废止/已迁移码仍被使用: ${tok}`);
      } else if (!active.has(tok)) {
        violations.push(`${name}:${i + 1}  未注册码: ${tok}    | ${line.trim().slice(0, 100)}`);
      }
    }
  }
}
for (const f of SCAN_FILES) scanFile(f);

// ---- 汇总 ----
const n14 = [...active.values()].filter((v) => v === '§14').length;
const n15 = [...active.values()].filter((v) => v === '§15').length;
console.log(`注册表：§14 DomainError 活跃码 ${n14} 个；§15 issue code 活跃码 ${n15} 个；废止/迁移保留码 ${deprecated.size} 个`);
if (violations.length) {
  console.log(`\n违规 ${violations.length} 处：`);
  for (const v of violations) console.log('  ' + v);
  process.exit(1);
}
console.log('闭集校验通过：扫描范围内无表外码、无废止码引用（0 违规）');
