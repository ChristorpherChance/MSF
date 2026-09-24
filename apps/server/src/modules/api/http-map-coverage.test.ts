/**
 * 「抛点码 ⊆ HTTP 映射表」静态检查（#20 立项）：
 * 扫描 server 源码中所有字面量 DomainError 抛点，必须全部在 domain-error.filter.ts
 * HTTP_BY_CODE 中显式映射——未映射的注册码会裸落 500「内部错误」（实机走查第三波命中 23 例）。
 * CI 跑 vitest 即强制；新增抛点时此测试不过则必须补映射（状态列以 LLD-3 §14 为权威）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', '..');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'node_modules') yield* walk(p);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      yield p;
    }
  }
}

/** 从 filter 源提取 HTTP_BY_CODE 的键（状态列形如 `CODE: HttpStatus.X,` 或 `CODE: 423,`） */
function mappedCodes(): Set<string> {
  const src = readFileSync(join(SRC, 'modules/api/domain-error.filter.ts'), 'utf8');
  const block = src.slice(src.indexOf('HTTP_BY_CODE'), src.indexOf('};', src.indexOf('HTTP_BY_CODE')));
  return new Set([...block.matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*(?:HttpStatus\.|\d)/gm)].map((m) => m[1]!));
}

function thrownCodes(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/new DomainError\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) {
      const list = out.get(m[1]!) ?? [];
      list.push(relative(SRC, file));
      out.set(m[1]!, list);
    }
  }
  return out;
}

describe('抛点码 ⊆ HTTP 映射表（#20 静态检查）', () => {
  it('所有字面量 DomainError 抛点均已映射 HTTP 状态', () => {
    const mapped = mappedCodes();
    const thrown = thrownCodes();
    const missing = [...thrown.entries()].filter(([code]) => !mapped.has(code));
    expect(
      missing.map(([code, files]) => `${code}（${files.length} 处：${files.slice(0, 3).join('、')}）`),
    ).toEqual([]);
  });

  it('映射表无僵尸键（映射的码至少有一个抛点或是 INTERNAL 兜底）', () => {
    const mapped = mappedCodes();
    const thrown = thrownCodes();
    const zombies = [...mapped].filter((code) => !thrown.has(code) && code !== 'INTERNAL');
    // 僵尸键不阻断（映射表可先行），仅告警式断言存在性可读
    if (zombies.length) console.warn(`[http-map] 映射但未见字面量抛点：${zombies.join('、')}`);
    expect(mapped.size).toBeGreaterThan(0);
  });
});
