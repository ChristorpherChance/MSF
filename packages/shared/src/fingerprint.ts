/**
 * 规范化指纹工具（LLD-2 DSG-F04-1 权威，R-02-13）：
 * JSONB 规范化 = RFC 8785（JCS）子集 + Unicode NFC 预规范化；
 * 数值按 ECMA-262 最短往返格式；NaN/Infinity/非安全整数拒绝（NORMALIZE_FAILED）。
 * 指纹 = SHA-256(规范化文本)，只对读回后重新规范化的文本计算。
 */
import { createHash } from 'node:crypto';
import { DomainError } from './error-codes.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** JCS 子集序列化（NFC 预规范化；对象键按 UTF-16 码元序排序） */
export function jcsNormalize(value: Json): string {
  return JSON.stringify(jcsValue(value));
}

function jcsValue(value: Json): Json {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.normalize('NFC');
  if (typeof value === 'number') return normNumber(value);
  if (Array.isArray(value)) return value.map(jcsValue);
  if (typeof value === 'object') {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, Json>)[k];
      if (v === undefined) continue; // JCS：undefined 键略去
      out[k.normalize('NFC')] = jcsValue(v as Json);
    }
    return out;
  }
  throw new DomainError('NORMALIZE_FAILED', `不可规范化类型: ${typeof value}`);
}

function normNumber(n: number): number {
  if (!Number.isFinite(n)) {
    throw new DomainError('NORMALIZE_FAILED', `非法数值: ${n}（NaN/Infinity 不入指纹）`);
  }
  if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
    throw new DomainError('NORMALIZE_FAILED', `非安全整数: ${n}`);
  }
  // ECMA-262 最短往返：JSON.stringify(number) 本身即最短往返格式
  return n;
}

/** 内容指纹：SHA-256 十六进制（LLD-2 DSG-F04-1；原型 devHash 对齐） */
export function fingerprint(value: Json): string {
  return createHash('sha256').update(jcsNormalize(value), 'utf8').digest('hex');
}

/** 哈希链追加：newHash = SHA-256(prevHash + '|' + 规范化载荷)（LLD-4 DSG-D11-2 链式追加） */
export function chainHash(prevHash: string | null, payload: Json): string {
  const body = `${prevHash ?? ''}|${jcsNormalize(payload)}`;
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
