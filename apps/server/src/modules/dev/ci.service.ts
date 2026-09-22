import { Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pool, query } from '../../db/pool.js';
import { appendAudit } from '../evidence/audit.service.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { decryptText, encryptText } from '../platform/crypto.service.js';
import { sha256 } from './gate-common.js';

/**
 * CI 回传与 webhook secret（A06-21/22；REQ-407/710/712、BR-11）。
 * - secret 只写不读：AES-256-GCM 密文落 sys_webhook_secrets，掩码回显；轮换即失效。
 * - 回传 HMAC-SHA256（<timestamp>.<rawBody>，±5min）；X-MSF-Delivery 投递幂等（重复返回首个回执）；
 *   conclusion unknown 如实落库；taskCodes 不匹配不拒收（matched=false）；签名失败记审计不落业务行。
 */
@Injectable()
export class DevCiService {
  onModuleInit(): void {
    registerCommand('dev.ci.webhook-secret.set', async (client, payload, ctx) => {
      const { projectId, secret } = payload as { projectId: string; secret: string };
      if (typeof secret !== 'string' || secret.length < 32 || !/[a-z]/i.test(secret) || !/\d/.test(secret)) {
        throw new DomainError('VALIDATION_FAILED', '密钥须 ≥32 字符且含字母与数字（高熵）', 'secret');
      }
      const hint = `${secret.slice(0, 6)}…${secret.slice(-4)}`;
      const enc = encryptText(secret);
      const existing = await client.query<{ id: string; secret_hint: string }>(
        "SELECT id, secret_hint FROM sys_webhook_secrets WHERE project_id=$1 AND provider='ci' FOR UPDATE", [projectId]);
      if (existing.rows[0]) {
        await client.query(
          'UPDATE sys_webhook_secrets SET secret_enc=$3, secret_hint=$4, rotated_at=now(), updated_by=$5, updated_at=now() WHERE id=$1 AND project_id=$2',
          [existing.rows[0].id, projectId, enc, hint, ctx.actorId]);
      } else {
        await client.query(
          "INSERT INTO sys_webhook_secrets (project_id, provider, secret_enc, secret_hint, created_by) VALUES ($1,'ci',$2,$3,$4)",
          [projectId, enc, hint, ctx.actorId]);
      }
      return { enabled: true, secretMasked: hint, rotatedAt: new Date().toISOString(), previousHint: existing.rows[0]?.secret_hint ?? null };
    });

    registerCommand('dev.ci.callback', async (client, payload) => {
      const { projectId, deliveryId, provider, commitSha, prRef, taskCodes, conclusion, detailsUrl } = payload as {
        projectId: string; deliveryId: string; provider: string; commitSha: string; prRef?: string;
        taskCodes: string[]; conclusion: string; detailsUrl?: string;
      };
      if (!['pass', 'fail', 'unknown'].includes(conclusion)) {
        throw new DomainError('VALIDATION_FAILED', 'conclusion 枚举 pass|fail|unknown（状态不明如实传 unknown）', 'conclusion');
      }
      // 投递幂等：重复投递返回首个回执
      const dup = await client.query<{ id: string }>(
        'SELECT id FROM dev_ci_reports WHERE project_id=$1 AND delivery_id=$2', [projectId, deliveryId]);
      if (dup.rows[0]) return { receiptId: `cir_${dup.rows[0].id.slice(0, 8)}`, deliveryId, deduplicated: true };
      const known = await client.query<{ code: string }>(
        'SELECT code FROM dev_tasks WHERE project_id=$1 AND code = ANY($2)', [projectId, taskCodes ?? []]);
      const matched = (taskCodes ?? []).length > 0 && known.rows.length === (taskCodes ?? []).length;
      const payloadSummary = { provider, commitSha, prRef: prRef ?? null, taskCodes, conclusion, detailsUrl: detailsUrl ?? null };
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_ci_reports (project_id, delivery_id, provider, commit_sha, pr_ref, task_codes, matched, conclusion, payload, payload_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [projectId, deliveryId, provider, commitSha, prRef ?? null, JSON.stringify(taskCodes ?? []), matched,
          conclusion, JSON.stringify(payloadSummary), sha256(fingerprint(payloadSummary))]);
      return { receiptId: `cir_${r.rows[0]!.id.slice(0, 8)}`, deliveryId, matched, deduplicated: false };
    });
  }

  /** A06-22 登记/轮换（人工命令） */
  async setSecret(projectId: string, secret: string, ctx: CommandContext) {
    return executeCommand('dev.ci.webhook-secret.set', { projectId, secret }, { ...ctx, projectId });
  }

  /** A06-21 回传入口：HMAC 校验（失败记审计不落业务行）→ 命令落库 */
  async callback(
    projectId: string, rawBody: Buffer,
    headers: { timestamp?: string | undefined; signature?: string | undefined; delivery?: string | undefined },
    ctx: CommandContext,
  ) {
    const reject = async (why: string): Promise<never> => {
      // 签名失败尝试记 audit_log、不落业务表（REQ-706）
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await appendAudit(client, {
          projectId, actorKind: 'system', actorId: 'ci-webhook',
          command: 'dev.ci.callback', payload: { rejected: true, reason: why, deliveryId: headers.delivery ?? null },
        });
        await client.query('COMMIT');
      } catch { await client.query('ROLLBACK'); } finally { client.release(); }
      throw new DomainError('UNAUTHENTICATED', `CI 回传校验失败：${why}`, 'ci');
    };
    const ts = Number(headers.timestamp);
    if (!headers.timestamp || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return reject('时间戳缺失或偏差超 ±5 分钟');
    }
    if (!headers.signature?.startsWith('sha256=')) return reject('签名缺失/格式非法');
    if (!headers.delivery) throw new DomainError('VALIDATION_FAILED', '缺 X-MSF-Delivery 投递 ID', 'X-MSF-Delivery');
    const sec = await query<{ secret_enc: Buffer }>(
      "SELECT secret_enc FROM sys_webhook_secrets WHERE project_id=$1 AND provider='ci'", [projectId]);
    if (!sec.rows[0]) throw new DomainError('NOT_FOUND', '项目不存在或未启用 CI 回传', projectId);
    const expected = createHmac('sha256', decryptText(sec.rows[0].secret_enc))
      .update(`${headers.timestamp}.`).update(rawBody).digest('hex');
    const got = headers.signature.slice('sha256='.length);
    const a = Buffer.from(expected); const b = Buffer.from(got);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reject('签名校验失败');
    let body: Record<string, unknown>;
    try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
    catch { throw new DomainError('VALIDATION_FAILED', '载荷非 JSON', 'body'); }
    return executeCommand('dev.ci.callback', {
      projectId, deliveryId: headers.delivery,
      provider: body.provider, commitSha: body.commitSha, prRef: body.prRef,
      taskCodes: body.taskCodes, conclusion: body.conclusion, detailsUrl: body.detailsUrl,
    }, { ...ctx, projectId });
  }

  /** webhook 设置状态（掩码回显；只写不读） */
  async secretStatus(projectId: string) {
    const r = await query<{ secret_hint: string; rotated_at: string }>(
      "SELECT secret_hint, rotated_at FROM sys_webhook_secrets WHERE project_id=$1 AND provider='ci'", [projectId]);
    return r.rows[0]
      ? { enabled: true, secretMasked: r.rows[0].secret_hint, rotatedAt: r.rows[0].rotated_at }
      : { enabled: false };
  }
}
