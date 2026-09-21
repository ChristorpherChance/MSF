import type { PoolClient } from 'pg';
import { chainHash, DomainError, type ActorKind } from '@msf/shared';

export interface AuditEntry {
  projectId: string | null;
  actorKind: ActorKind;
  actorId: string;
  command: string;
  payload: unknown;
}

/**
 * 审计追加（LLD-4 DSG-D11-1/2）：append-only + 哈希链。
 * 链尾读取「ORDER BY seq DESC LIMIT 1 FOR UPDATE」（R-03-13：不假设 seq-1 存在，bigserial 回滚留空洞）；
 * UNIQUE(prev_hash) 并发分叉兜底——冲突即重读链尾重试（D11-2 冲突回滚+幂等重试，上限 3 次）。
 * 审计失败=整体回滚（调用方在同一事务内）：审计失败零写（LLD-1 DSG-M00-1）。
 */
export async function appendAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const tail = await client.query<{ hash: string }>(
      'SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE',
    );
    const prevHash = tail.rows[0]?.hash ?? null;
    const hash = chainHash(prevHash, {
      projectId: entry.projectId,
      actorKind: entry.actorKind,
      actorId: entry.actorId,
      command: entry.command,
      payload: entry.payload as never,
      prevHash,
    });
    try {
      await client.query(
        'INSERT INTO audit_log (project_id, actor_kind, actor_id, command, payload, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          entry.projectId,
          entry.actorKind,
          entry.actorId,
          entry.command,
          JSON.stringify(entry.payload),
          prevHash,
          hash,
        ],
      );
      return;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e; // 非并发冲突错误原样抛出，不重试
      if (attempt === 2) {
        throw new DomainError('AUDIT_WRITE_FAILED', '审计哈希链追加冲突重试耗尽');
      }
    }
  }
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505';
}
