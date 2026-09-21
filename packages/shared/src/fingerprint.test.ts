import { describe, expect, it } from 'vitest';
import { chainHash, fingerprint, jcsNormalize } from './fingerprint.js';
import { DomainError } from './error-codes.js';

describe('jcsNormalize（LLD-2 F04-1 / R-02-13）', () => {
  it('对象键按码元序排序、NFC 预规范化', () => {
    expect(jcsNormalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // NFC：组合字符序列与预组合字符视为等同
    expect(jcsNormalize({ s: 'é' })).toBe(jcsNormalize({ s: 'é' }));
  });

  it('数组保序、undefined 键略去', () => {
    expect(jcsNormalize({ a: [3, 1, 2], skip: undefined } as never)).toBe('{"a":[3,1,2]}');
  });

  it('NaN/Infinity 拒绝 NORMALIZE_FAILED', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      try {
        jcsNormalize({ n: bad });
        expect.unreachable('应当拒绝');
      } catch (e) {
        expect(e).toBeInstanceOf(DomainError);
        expect((e as DomainError).code).toBe('NORMALIZE_FAILED');
      }
    }
  });

  it('非安全整数拒绝', () => {
    try {
      jcsNormalize({ n: 2 ** 53 });
      expect.unreachable('应当拒绝');
    } catch (e) {
      expect((e as DomainError).code).toBe('NORMALIZE_FAILED');
    }
    expect(jcsNormalize({ n: Number.MAX_SAFE_INTEGER })).toContain('9007199254740991');
  });

  it('数值最短往返格式', () => {
    expect(jcsNormalize({ n: 0.1 })).toBe('{"n":0.1}');
    expect(jcsNormalize({ n: 1.5e-7 })).toBe('{"n":1.5e-7}');
  });
});

describe('fingerprint / chainHash', () => {
  it('同语义对象指纹稳定', () => {
    expect(fingerprint({ b: 1, a: 2 })).toBe(fingerprint({ a: 2, b: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('哈希链：同前序同载荷同链值；空前序可起链', () => {
    const h1 = chainHash(null, { op: 'a' });
    const h2 = chainHash(h1, { op: 'b' });
    expect(h2).toBe(chainHash(h1, { op: 'b' }));
    expect(h2).not.toBe(chainHash(null, { op: 'b' }));
  });
});
