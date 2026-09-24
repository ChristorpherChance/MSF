#!/usr/bin/env node
/**
 * 台账 #16 举一反三专项扫描（一次性排查工具，非 CI 门槛）：
 * 对每个 registerCommand handler，提取 `= payload as { ... }` 解构字段，
 * 找出字段的「成员调用」用法（x.foo(...) / x.length / x.trim() 等），
 * 若首次成员调用之前 handler 体内没有对该字段的守卫（同行含字段名且含 if/throw/?./!/typeof/Array.isArray），
 * 则报告为疑似「body 缺字段 → 500」裸调用。
 * 启发式，有误报；人工复核后处置。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('../../../apps/server/src/modules', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const METHOD_CALL = /\b([a-zA-Z_$][\w$]*)\s*\.\s*(?:length|trim|replace|map|filter|join|split|slice|includes|toUpperCase|toLowerCase|push|forEach|find|some|every|padStart|startsWith|endsWith|match|sort|keys|values|entries)\b/g;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p;
  }
}

/** 从 start 处（'{' 的索引）找配对右括号，返回块文本 */
function blockAt(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return src.slice(start);
}

const findings = [];
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  let idx = 0;
  while ((idx = src.indexOf('registerCommand(', idx)) !== -1) {
    const nameM = /registerCommand\(\s*'([^']+)'/.exec(src.slice(idx, idx + 200));
    const cmd = nameM ? nameM[1] : '?';
    // handler 箭头函数体起始 '{'
    const arrowIdx = src.indexOf('=>', idx);
    if (arrowIdx === -1) { idx += 16; continue; }
    const braceIdx = src.indexOf('{', arrowIdx);
    if (braceIdx === -1 || braceIdx > arrowIdx + 200) { idx += 16; continue; }
    const body = blockAt(src, braceIdx);
    idx = braceIdx + body.length;

    const dm = /=\s*payload\s+as\s*\{([^}]+)\}/s.exec(body);
    if (!dm) continue;
    const fields = dm[1].split(/[,;]/).map((s) => s.split(':')[0].trim()).filter((s) => /^[a-zA-Z_$][\w$]*$/.test(s));
    if (!fields.length) continue;

    for (const f of fields) {
      METHOD_CALL.lastIndex = 0;
      let m;
      while ((m = METHOD_CALL.exec(body))) {
        if (m[1] !== f) continue;
        const before = body.slice(0, m.index);
        // 守卫判定：字段名出现在含守卫关键字的行/短上下文中
        const guarded = new RegExp(
          `(?:if|throw|\\?\\.|!|typeof|Array\\.isArray|&&|\\|\\||\\?)[^;\\n]{0,120}\\b${f}\\b|\\b${f}\\b[^;\\n]{0,120}(?:\\?\\.|typeof|Array\\.isArray|===\\s*undefined|!==\\s*undefined)`,
        ).test(before);
        // 非可选字段判定：payload as 类型注记里该字段带 '?' 则视为可空已自觉
        const optional = new RegExp(`\\b${f}\\s*\\?\\s*:`).test(dm[1]);
        if (!guarded && !optional) {
          const line = src.slice(0, idx - body.length + m.index).split('\n').length;
          const snippet = body.slice(m.index, m.index + 60).split('\n')[0];
          findings.push({ rel, line, cmd, field: f, snippet });
        }
        break; // 每字段只报首次裸调用
      }
    }
  }
}

console.log(`疑似裸调用 ${findings.length} 处：`);
for (const f of findings) console.log(`  ${f.rel}:${f.line}  [${f.cmd}]  ${f.field}  →  ${f.snippet}`);
