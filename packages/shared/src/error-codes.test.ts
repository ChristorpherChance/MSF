import { describe, expect, it } from 'vitest';
import {
  DOMAIN_ERROR_CODES,
  DomainError,
  ISSUE_CODES,
  isDomainErrorCode,
  isIssueCode,
} from './error-codes.js';

describe('错误码注册表（LLD-3 §14/§15 生成物）', () => {
  it('数量与注册表一致（91/78）', () => {
    expect(DOMAIN_ERROR_CODES.length).toBe(91);
    expect(ISSUE_CODES.length).toBe(78);
  });

  it('判定函数闭集行为', () => {
    expect(isDomainErrorCode('COMMAND_UNKNOWN')).toBe(true);
    expect(isIssueCode('L0C_BELOW')).toBe(true);
    expect(isDomainErrorCode('NOT_A_CODE')).toBe(false);
    expect(isIssueCode('COMMAND_UNKNOWN')).toBe(false); // 一级码不在二级表
  });

  it('DomainError 携带 code/message/target', () => {
    const e = new DomainError('NOT_FOUND', '缺失', 'x');
    expect(e.code).toBe('NOT_FOUND');
    expect(e.message).toBe('缺失');
    expect(e.target).toBe('x');
    expect(e.name).toBe('DomainError');
  });
});
