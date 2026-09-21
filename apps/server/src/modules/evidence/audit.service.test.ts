import { describe, expect, it } from 'vitest';
import { DomainError } from '@msf/shared';
import type { PoolClient } from 'pg';
import { appendAudit } from './audit.service.js';

/** 假 client：链尾查询固定返回 null，INSERT 前 N 次抛 23505 唯一冲突 */
function fakeClient(failTimes: number): PoolClient {
  let inserts = 0;
  return {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT hash')) return { rows: [] };
      if (sql.startsWith('INSERT')) {
        inserts++;
        if (inserts <= failTimes) {
          const e = new Error('duplicate key') as Error & { code: string };
          e.code = '23505';
          throw e;
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  } as unknown as PoolClient;
}

const entry = {
  projectId: null,
  actorKind: 'human' as const,
  actorId: 't',
  command: 'health.ping',
  payload: {},
};

describe('appendAudit 并发分叉兜底（D11-2）', () => {
  it('唯一冲突后重读链尾重试成功', async () => {
    await expect(appendAudit(fakeClient(2), entry)).resolves.toBeUndefined();
  });

  it('冲突重试耗尽 → AUDIT_WRITE_FAILED', async () => {
    try {
      await appendAudit(fakeClient(3), entry);
      expect.unreachable('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe('AUDIT_WRITE_FAILED');
    }
  });

  it('非唯一冲突错误不重试直接抛', async () => {
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith('INSERT')) throw new Error('connection lost');
        return { rows: [] };
      },
    } as unknown as PoolClient;
    await expect(appendAudit(client, entry)).rejects.toThrowError('connection lost');
  });
});
