import { describe, expect, it } from 'vitest';
import { isRetryableStreamCut } from './stream-pipeline.js';

/** 断流重试分类器（2026-10-09 公网实机抓修：上游偶发 closed before response.completed，重试即过） */
describe('isRetryableStreamCut', () => {
  it('命中传输层断流各形态', () => {
    expect(isRetryableStreamCut('stream error: stream disconnected before completion: stream closed before response.completed')).toBe(true);
    expect(isRetryableStreamCut('fetch failed')).toBe(true);
    expect(isRetryableStreamCut('connect ECONNRESET 10.0.0.1:443')).toBe(true);
    expect(isRetryableStreamCut('socket hang up')).toBe(true);
    expect(isRetryableStreamCut('premature close')).toBe(true);
    expect(isRetryableStreamCut('request timed out after 300s')).toBe(true);
  });

  it('限流/鉴权/配额不重试（重试无意义且放大成本）', () => {
    expect(isRetryableStreamCut('429 Too Many Requests')).toBe(false);
    expect(isRetryableStreamCut('rate limit exceeded')).toBe(false);
    expect(isRetryableStreamCut('401 Invalid API key')).toBe(false);
    expect(isRetryableStreamCut('403 Forbidden')).toBe(false);
    expect(isRetryableStreamCut('quota exhausted')).toBe(false);
  });

  it('内容/契约类错误不算断流（走契约修正通道）', () => {
    expect(isRetryableStreamCut('生成产物不符合页面契约')).toBe(false);
    expect(isRetryableStreamCut('Unexpected token in JSON')).toBe(false);
  });
});
