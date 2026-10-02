import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { ParseService } from './parse.service.js';
import type { MatFile } from './types.js';

/**
 * 批量解析/加工/定稿作业（LLD-2 DSG-F02-4、LLD-4 DSG-D03-5/6、LLD-5 DSG-A03-9/12/15/16）。
 * 落库时机（二轮裁决）：弹窗登记即 idle 落库（basis_start 弹窗整批快照）；
 * 确认提交 confirming 立即整批复核——不一致删行拒绝（STALE_EVIDENCE，不留作业行），一致 running+basis_commit；
 * 执行中源变化的行提交前二次比对逐行 skipped（不整批拒绝）；全部行终态 → done | stopped。
 */

interface BasisEntry {
  file_id: string;
  content_fingerprint: string; // 活跃 file_parse 稿指纹（加工读取面）
}

export interface BatchRow {
  job_id: string;
  file_id: string;
  result: string;
  error: string | null;
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

@Injectable()
export class BatchService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(@Inject(ParseService) private readonly parse: ParseService) {}

  onModuleInit(): void {
    // A03-9 批量解析：job(kind=parse, running) + 行 pending；行执行由服务层逐行驱动
    registerCommand('material.file.batch_parse', async (client, payload, ctx) => {
      const { projectId, fileIds, basis } = payload as { projectId: string; fileIds: string[]; basis: BasisEntry[] };
      const code = await this.nextJobCode(client, projectId);
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO mat_batch_jobs (id, project_id, code, kind, status, basis_start, created_by)
         VALUES ($1,$2,$3,'parse','running',$4,$5)`,
        [jobId, projectId, code, JSON.stringify(basis), ctx.actorId],
      );
      for (const fileId of fileIds) {
        await client.query('INSERT INTO mat_batch_items (id, job_id, file_id) VALUES ($1,$2,$3)', [
          randomUUID(),
          jobId,
          fileId,
        ]);
      }
      return { jobId, code };
    });

    // 行结果写回 + 作业收尾（全部行终态 → done；stopped 态保持 stopped）
    registerCommand('material.job.row_update', async (client, payload) => {
      const { jobId, fileId, result, error, outputParsedId } = payload as {
        jobId: string;
        fileId: string;
        result: 'succeeded' | 'failed' | 'skipped';
        error?: string;
        outputParsedId?: string;
      };
      await client.query(
        'UPDATE mat_batch_items SET result=$3, error=$4, output_parsed_id=$5, updated_at=now() WHERE job_id=$1 AND file_id=$2',
        [jobId, fileId, result, error ?? null, outputParsedId ?? null],
      );
      return this.finalizeIfDone(client, jobId);
    });

    // A03-12 批量内容定稿：INV-BULK-1 人工确认（confirm:true 由服务层强制）；逐条成功/失败不整批回滚
    registerCommand('material.file.batch_finalize_content', async (client, payload, ctx) => {
      const { projectId, fileIds, basis } = payload as { projectId: string; fileIds: string[]; basis: BasisEntry[] };
      const code = await this.nextJobCode(client, projectId);
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO mat_batch_jobs (id, project_id, code, kind, status, basis_start, confirm_by, confirm_at, created_by)
         VALUES ($1,$2,$3,'content_final','running',$4,$5,now(),$5)`,
        [jobId, projectId, code, JSON.stringify(basis), ctx.actorId],
      );
      const results: Array<{ fileId: string; ok: boolean; reason?: string }> = [];
      for (const fileId of fileIds) {
        const r = await client.query<MatFile>(
          'SELECT * FROM mat_files WHERE id=$1 AND project_id=$2 FOR UPDATE',
          [fileId, projectId],
        );
        const file = r.rows[0];
        let ok = false;
        let reason = '文件不存在';
        // W2-040：加工资格 = file_final 或 content_final（content_final 是 file_final 后继态，倒挂拒绝修掉）
        if (file && file.parse_status !== 'file_final' && file.parse_status !== 'content_final') reason = '非 file_final/content_final 状态';
        // W3-001：已内容定稿不重复定稿（与单条 finalize_content「仅 file_final」同口径）——
        // 否则每次执行静默新落一条 final 内容稿，final 唯一性被破坏
        if (file && file.parse_status === 'content_final') reason = '已内容定稿';
        if (file && file.parse_status === 'file_final') {
          let draft = await client.query<{ id: string }>(
            "SELECT id FROM mat_parsed WHERE file_id=$1 AND kind='content_parse' AND status='draft' ORDER BY created_at DESC LIMIT 1",
            [fileId],
          );
          if (!draft.rows[0]) {
            // 实机走查修复：无内容稿时以最新文件解析稿落 draft（原文定稿语义，与单条 finalize_content 同口径）
            const src = await client.query<{ body_md: string; content_fingerprint: string; folder_id: string | null }>(
              "SELECT body_md, content_fingerprint, folder_id FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
              [fileId],
            );
            const base = src.rows[0];
            if (base) {
              await client.query(
                `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, folder_id, created_by)
                 VALUES ($1,$2,$3,'content_parse',$4,$5,$6,$7)`,
                [randomUUID(), projectId, fileId, base.body_md, base.content_fingerprint, base.folder_id, ctx.actorId],
              );
              draft = await client.query<{ id: string }>(
                "SELECT id FROM mat_parsed WHERE file_id=$1 AND kind='content_parse' AND status='draft' ORDER BY created_at DESC LIMIT 1",
                [fileId],
              );
            }
          }
          if (!draft.rows[0]) {
            reason = '无解析稿，无法生成内容稿';
          } else {
            await client.query("UPDATE mat_files SET parse_status='content_final' WHERE id=$1", [fileId]);
            await client.query(
              "UPDATE mat_parsed SET status='final', updated_at=now(), updated_by=$2 WHERE id=$1",
              [draft.rows[0].id, ctx.actorId],
            );
            ok = true;
          }
        }
        await client.query(
          'INSERT INTO mat_batch_items (id, job_id, file_id, result, error) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), jobId, fileId, ok ? 'succeeded' : 'failed', ok ? null : reason],
        );
        results.push(ok ? { fileId, ok: true } : { fileId, ok: false, reason });
      }
      await client.query("UPDATE mat_batch_jobs SET status='done', updated_at=now() WHERE id=$1", [jobId]);
      return { results };
    });

    // A03-15 创建批量加工作业：弹窗登记即 idle 落库（basis_start 弹窗整批快照）
    registerCommand('material.job.create', async (client, payload, ctx) => {
      const { projectId, processType, fileIds, basis, filter } = payload as {
        projectId: string;
        processType: 'translate' | 'mask' | 'index';
        fileIds: string[];
        basis: BasisEntry[];
        filter?: Record<string, unknown>;
      };
      // #16：body 缺字段 → 400 而非 500（undefined.length 曾是 500 来源）
      if (!Array.isArray(fileIds) || fileIds.length === 0) {
        throw new DomainError('VALIDATION_FAILED', '至少一项加工', 'fileIds');
      }
      const code = await this.nextJobCode(client, projectId);
      const jobId = randomUUID();
      await client.query(
        `INSERT INTO mat_batch_jobs (id, project_id, code, kind, process_type, status, basis_start, filter, created_by)
         VALUES ($1,$2,$3,'process',$4,'idle',$5,$6,$7)`,
        [jobId, projectId, code, processType, JSON.stringify(basis), filter ? JSON.stringify(filter) : null, ctx.actorId],
      );
      for (const fileId of fileIds) {
        await client.query('INSERT INTO mat_batch_items (id, job_id, file_id) VALUES ($1,$2,$3)', [
          randomUUID(),
          jobId,
          fileId,
        ]);
      }
      return { jobId, code };
    });

    // A03-15 确认提交：confirming 立即整批复核——不一致同事务删行拒绝（STALE_EVIDENCE 不留作业行）
    registerCommand('material.job.confirm', async (client, payload, ctx) => {
      const { projectId, jobId, basisNow } = payload as { projectId: string; jobId: string; basisNow: BasisEntry[] };
      const r = await client.query<{ status: string; basis_start: BasisEntry[] }>(
        'SELECT status, basis_start FROM mat_batch_jobs WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [jobId, projectId],
      );
      const job = r.rows[0];
      if (!job) throw new DomainError('NOT_FOUND', '作业不存在', jobId);
      if (job.status !== 'idle') throw new DomainError('INVALID_STATE', `作业当前 ${job.status}，不可确认`, jobId);
      if (!basisEqual(job.basis_start, basisNow)) {
        // 整批拒绝：删行须随事务提交落库（裁决「同事务删除该行，拒绝动作留 audit_log」）——
        // 故此处不抛错（抛出即回滚），改返回 rejected 标记由服务层在提交后抛 STALE_EVIDENCE
        await client.query('DELETE FROM mat_batch_items WHERE job_id=$1', [jobId]);
        await client.query('DELETE FROM mat_batch_jobs WHERE id=$1', [jobId]);
        return { jobId, status: 'rejected', before: job.basis_start, after: basisNow };
      }
      await client.query(
        "UPDATE mat_batch_jobs SET status='running', basis_commit=$2, confirm_by=$3, confirm_at=now(), updated_at=now() WHERE id=$1",
        [jobId, JSON.stringify(basisNow), ctx.actorId],
      );
      return { jobId, status: 'running' };
    });

    // A03-16 停止：running → stopped，后续待处理行 skipped
    registerCommand('material.job.stop', async (client, payload) => {
      const { jobId } = payload as { jobId: string };
      const r = await client.query<{ status: string }>(
        'SELECT status FROM mat_batch_jobs WHERE id=$1 FOR UPDATE',
        [jobId],
      );
      const job = r.rows[0];
      if (!job) throw new DomainError('NOT_FOUND', '作业不存在', jobId);
      if (job.status !== 'running') throw new DomainError('INVALID_STATE', `作业当前 ${job.status}，不可停止`, jobId);
      await client.query("UPDATE mat_batch_jobs SET status='stopped', updated_at=now() WHERE id=$1", [jobId]);
      await client.query("UPDATE mat_batch_items SET result='skipped', updated_at=now() WHERE job_id=$1 AND result='pending'", [jobId]);
      return { status: 'stopped' };
    });

    // 加工行处理：二次比对（执行中源变化逐行 skipped）→ mock 加工 → succeeded/failed；stopped 作业直接 skipped
    registerCommand('material.job.row_process', async (client, payload) => {
      const { projectId, jobId, fileId, params } = payload as {
        projectId: string;
        jobId: string;
        fileId: string;
        params?: Record<string, unknown>;
      };
      const jr = await client.query<{ status: string; process_type: string; basis_commit: BasisEntry[] }>(
        'SELECT status, process_type, basis_commit FROM mat_batch_jobs WHERE id=$1 FOR UPDATE',
        [jobId],
      );
      const job = jr.rows[0];
      if (!job) throw new DomainError('NOT_FOUND', '作业不存在', jobId);
      // 行级作用域：同一 file 可能有多条 item（retry_of 链），一律锁定最新 pending 行处理
      const ir = await client.query<{ id: string }>(
        "SELECT id FROM mat_batch_items WHERE job_id=$1 AND file_id=$2 AND result='pending' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [jobId, fileId],
      );
      const item = ir.rows[0];
      if (!item) throw new DomainError('INVALID_STATE', '无待处理行（已处理或已跳过）', fileId);
      if (job.status === 'stopped') {
        await client.query("UPDATE mat_batch_items SET result='skipped', updated_at=now() WHERE id=$1", [item.id]);
        return this.finalizeIfDone(client, jobId);
      }
      if (job.status !== 'running') throw new DomainError('INVALID_STATE', `作业当前 ${job.status}`, jobId);
      await client.query("UPDATE mat_batch_items SET result='processing', updated_at=now() WHERE id=$1", [item.id]);
      // 提交前二次比对（行级 skipped 口径）
      const fr = await client.query<MatFile>('SELECT * FROM mat_files WHERE id=$1 AND project_id=$2 FOR UPDATE', [fileId, projectId]);
      const file = fr.rows[0];
      const pr = await client.query<{ id: string; content_fingerprint: string }>(
        "SELECT id, content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
        [fileId],
      );
      const parsed = pr.rows[0];
      const basisEntry = job.basis_commit.find((b) => b.file_id === fileId);
      if (!file || !parsed || !basisEntry || parsed.content_fingerprint !== basisEntry.content_fingerprint) {
        await client.query("UPDATE mat_batch_items SET result='skipped', updated_at=now() WHERE id=$1", [item.id]);
        return this.finalizeIfDone(client, jobId);
      }
      // mock 加工：ops 追加（真实加工器 M6 接入）
      const ops = JSON.stringify([{ op: job.process_type, params: params ?? {}, at: new Date().toISOString() }]);
      await client.query(
        "UPDATE mat_parsed SET ops = ops || $2::jsonb, updated_at=now() WHERE id=$1",
        [parsed.id, ops],
      );
      await client.query(
        "UPDATE mat_batch_items SET result='succeeded', output_parsed_id=$2, updated_at=now() WHERE id=$1",
        [item.id, parsed.id],
      );
      return this.finalizeIfDone(client, jobId);
    });

    // A03-16 单条重试：行仍 file_final/content_final（F02-4 v11RetryBulk 前置；W2-040：content_final 为 file_final 后继态同具资格），新行挂 retry_of 链
    registerCommand('material.job.item_retry', async (client, payload) => {
      const { projectId, jobId, fileId } = payload as { projectId: string; jobId: string; fileId: string };
      const jr = await client.query<{ status: string }>('SELECT status FROM mat_batch_jobs WHERE id=$1 FOR UPDATE', [jobId]);
      if (!jr.rows[0]) throw new DomainError('NOT_FOUND', '作业不存在', jobId);
      const fr = await client.query<{ parse_status: string }>(
        'SELECT parse_status FROM mat_files WHERE id=$1 AND project_id=$2',
        [fileId, projectId],
      );
      if (fr.rows[0]?.parse_status !== 'file_final' && fr.rows[0]?.parse_status !== 'content_final') {
        throw new DomainError('INVALID_STATE', '行对应文件须仍为 file_final/content_final 方可重试', fileId);
      }
      const ir = await client.query<{ id: string }>(
        "SELECT id FROM mat_batch_items WHERE job_id=$1 AND file_id=$2 AND result IN ('failed','skipped') ORDER BY created_at DESC LIMIT 1",
        [jobId, fileId],
      );
      if (!ir.rows[0]) throw new DomainError('INVALID_STATE', '无可重试的失败/跳过节', fileId);
      const itemId = randomUUID();
      await client.query(
        "INSERT INTO mat_batch_items (id, job_id, file_id, retry_of) VALUES ($1,$2,$3,$4)",
        [itemId, jobId, fileId, ir.rows[0].id],
      );
      await client.query("UPDATE mat_batch_jobs SET status='running', updated_at=now() WHERE id=$1", [jobId]);
      return { jobId, fileId, status: 'pending' };
    });
  }

  /** A03-9 批量解析：默认仅待解析（onlyPending）；逐条成功/失败，失败停留待解析区并给原因 */
  async batchParse(
    projectId: string,
    fileIds: string[],
    onlyPending: boolean,
    ctx: CommandContext,
    opts: { autoRun?: boolean } = {},
  ): Promise<{ operationId: string; jobId: string | null; accepted: number; rejected: Array<{ fileId: string; reason: string }> }> {
    const rejected: Array<{ fileId: string; reason: string }> = [];
    const accepted: string[] = [];
    const basis: BasisEntry[] = [];
    for (const fileId of fileIds) {
      const r = await query<MatFile>('SELECT * FROM mat_files WHERE id=$1 AND project_id=$2', [fileId, projectId]);
      const f = r.rows[0];
      if (!f) rejected.push({ fileId, reason: 'not_found' });
      else if (f.unsupported) rejected.push({ fileId, reason: 'unsupported' });
      else if (f.ext === 'zip') rejected.push({ fileId, reason: 'archive' });
      else if (f.parse_status !== 'pending' && f.parse_status !== 'failed') {
        rejected.push({ fileId, reason: onlyPending ? 'not_pending' : 'busy' });
      } else {
        accepted.push(fileId);
        basis.push({ file_id: fileId, content_fingerprint: f.content_fingerprint });
      }
    }
    const operationId = `op_bp_${randomBytes(6).toString('hex')}`;
    let jobId: string | null = null;
    if (accepted.length > 0) {
      const r = (await executeCommand('material.file.batch_parse', { projectId, fileIds: accepted, basis }, { ...ctx, projectId })) as { jobId: string };
      jobId = r.jobId;
      if (opts.autoRun !== false) this.runParseBatch(projectId, jobId, accepted, ctx).catch(() => undefined);
    }
    return { operationId, jobId, accepted: accepted.length, rejected };
  }

  /** 批量解析行驱动（削峰 N01-7：逐行串行；真实队列 M6 BullMQ） */
  async runParseBatch(projectId: string, jobId: string, fileIds: string[], ctx: CommandContext): Promise<void> {
    for (const fileId of fileIds) {
      const stopped = await this.jobStatus(jobId);
      if (stopped === 'stopped') {
        await executeCommand('material.job.row_update', { jobId, fileId, result: 'skipped' }, { ...ctx, projectId });
        continue;
      }
      let result: 'succeeded' | 'failed' = 'succeeded';
      let error: string | undefined;
      try {
        const op = (await this.parse.parse(projectId, fileId, ctx, false, { autoRun: false })) as { operationId: string };
        await this.parse.runParse(projectId, fileId, op.operationId, ctx);
        const st = await query<{ parse_status: string }>('SELECT parse_status FROM mat_files WHERE id=$1', [fileId]);
        if (st.rows[0]?.parse_status !== 'parsed') {
          result = 'failed';
          error = '解析未通过';
        }
      } catch (e) {
        result = 'failed';
        error = e instanceof Error ? e.message : String(e);
      }
      await executeCommand('material.job.row_update', { jobId, fileId, result, error }, { ...ctx, projectId });
    }
  }

  /** A03-12 批量内容定稿（confirm 由控制器/本层强制 true——INV-BULK-1 人工确认不变式） */
  async batchFinalizeContent(
    projectId: string,
    fileIds: string[],
    confirm: boolean,
    ctx: CommandContext,
  ): Promise<{ results: Array<{ fileId: string; ok: boolean; reason?: string }> }> {
    if (!confirm) throw new DomainError('VALIDATION_FAILED', '批量定稿必须人工确认（confirm:true）', 'confirm');
    const basis = await this.snapshotBasis(projectId, fileIds);
    return (await executeCommand(
      'material.file.batch_finalize_content',
      { projectId, fileIds, basis },
      { ...ctx, projectId },
    )) as { results: Array<{ fileId: string; ok: boolean; reason?: string }> };
  }

  /** A03-15 创建批量加工作业（弹窗登记，idle） */
  async createJob(
    projectId: string,
    processType: 'translate' | 'mask' | 'index',
    fileIds: string[],
    params: Record<string, unknown> | undefined,
    ctx: CommandContext,
  ): Promise<{ jobId: string; operationId: string; basisFingerprint: string }> {
    // intake 前置：行须 file_final/content_final（F02-4 加工对象；W2-040：content_final 为 file_final 后继态同具资格）
    for (const fileId of fileIds) {
      const r = await query<{ parse_status: string }>('SELECT parse_status FROM mat_files WHERE id=$1 AND project_id=$2', [fileId, projectId]);
      if (r.rows[0]?.parse_status !== 'file_final' && r.rows[0]?.parse_status !== 'content_final') {
        throw new DomainError('INVALID_STATE', `文件 ${fileId} 非 file_final/content_final，不可批量加工`, fileId);
      }
    }
    const basis = await this.snapshotBasis(projectId, fileIds);
    const r = (await executeCommand(
      'material.job.create',
      { projectId, processType, fileIds, basis, filter: params ? { params } : undefined },
      { ...ctx, projectId },
    )) as { jobId: string };
    return {
      jobId: r.jobId,
      operationId: `op_job_${randomBytes(6).toString('hex')}`,
      basisFingerprint: `sha256:${fingerprint(basis as unknown as never)}`,
    };
  }

  /** A03-15 确认提交：整批复核 → running 并异步逐行执行；不一致 STALE_EVIDENCE */
  async confirmJob(
    projectId: string,
    jobId: string,
    ctx: CommandContext,
    opts: { autoRun?: boolean } = {},
  ): Promise<unknown> {
    const items = await query<{ file_id: string }>('SELECT file_id FROM mat_batch_items WHERE job_id=$1', [jobId]);
    const basisNow = await this.snapshotBasis(projectId, items.rows.map((i) => i.file_id));
    const r = (await executeCommand('material.job.confirm', { projectId, jobId, basisNow }, { ...ctx, projectId })) as
      | { jobId: string; status: 'running' }
      | { jobId: string; status: 'rejected'; before: unknown; after: unknown };
    if (r.status === 'rejected') {
      // 删行已随命令事务落库（不留作业行），此处再对外抛拒绝码
      throw new DomainError('STALE_EVIDENCE', '基线快照与弹窗登记不一致，整批拒绝', jobId, {
        before: r.before,
        after: r.after,
      });
    }
    if (opts.autoRun !== false) this.runProcessJob(projectId, jobId, ctx).catch(() => undefined);
    return r;
  }

  /** 加工作业行驱动：逐行 row_process（二次比对/mock 加工/收尾在行命令内） */
  async runProcessJob(projectId: string, jobId: string, ctx: CommandContext): Promise<void> {
    const items = await query<{ file_id: string; result: string }>(
      "SELECT file_id, result FROM mat_batch_items WHERE job_id=$1 AND result='pending' ORDER BY created_at",
      [jobId],
    );
    // W3-002：job 级 filter.params（如 lang）透传入行命令——行级 ops 审计不再丢参数
    const jr = await query<{ filter: { params?: Record<string, unknown> } | null }>(
      'SELECT filter FROM mat_batch_jobs WHERE id=$1', [jobId]);
    const params = jr.rows[0]?.filter?.params;
    for (const item of items.rows) {
      await executeCommand(
        'material.job.row_process',
        { projectId, jobId, fileId: item.file_id, ...(params ? { params } : {}) },
        { ...ctx, projectId },
      );
    }
  }

  async stopJob(projectId: string, jobId: string, ctx: CommandContext): Promise<unknown> {
    return executeCommand('material.job.stop', { jobId }, { ...ctx, projectId });
  }

  /** A03-16 单条重试：202 + 异步行处理 */
  async retryItem(projectId: string, jobId: string, fileId: string, ctx: CommandContext, opts: { autoRun?: boolean } = {}) {
    const r = await executeCommand('material.job.item_retry', { projectId, jobId, fileId }, { ...ctx, projectId });
    if (opts.autoRun !== false) {
      // W3-002：重试行同口径透传 job filter.params
      const jr = await query<{ filter: { params?: Record<string, unknown> } | null }>(
        'SELECT filter FROM mat_batch_jobs WHERE id=$1', [jobId]);
      const params = jr.rows[0]?.filter?.params;
      executeCommand('material.job.row_process', { projectId, jobId, fileId, ...(params ? { params } : {}) }, { ...ctx, projectId }).catch(() => undefined);
    }
    return r;
  }

  /** A03-16 作业查询 */
  async getJob(projectId: string, jobId: string) {
    const j = await query<{ id: string; code: string; kind: string; process_type: string | null; status: string }>(
      'SELECT id, code, kind, process_type, status FROM mat_batch_jobs WHERE id=$1 AND project_id=$2',
      [jobId, projectId],
    );
    const job = j.rows[0];
    if (!job) throw new DomainError('NOT_FOUND', '作业不存在', jobId);
    const items = await query<{ file_id: string; result: string; error: string | null }>(
      'SELECT file_id, result, error FROM mat_batch_items WHERE job_id=$1 ORDER BY created_at',
      [jobId],
    );
    return {
      jobId: job.id,
      code: job.code,
      kind: job.kind,
      processType: job.process_type,
      status: job.status,
      items: items.rows.map((i) => ({ fileId: i.file_id, status: i.result, error: i.error })),
    };
  }

  /** 弹窗/开始时整批快照：逐行 {file_id, 活跃 file_parse 稿指纹}（REQ-111 口径） */
  private async snapshotBasis(projectId: string, fileIds: string[]): Promise<BasisEntry[]> {
    const basis: BasisEntry[] = [];
    for (const fileId of fileIds) {
      const r = await query<{ content_fingerprint: string }>(
        `SELECT p.content_fingerprint FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
         WHERE p.file_id=$1 AND f.project_id=$2 AND p.kind='file_parse' AND p.status != 'discarded'
         ORDER BY p.created_at DESC LIMIT 1`,
        [fileId, projectId],
      );
      basis.push({ file_id: fileId, content_fingerprint: r.rows[0]?.content_fingerprint ?? '' });
    }
    return basis;
  }

  private async jobStatus(jobId: string): Promise<string> {
    const r = await query<{ status: string }>('SELECT status FROM mat_batch_jobs WHERE id=$1', [jobId]);
    return r.rows[0]?.status ?? '';
  }

  /** 全部行终态 → done（stopped 已由 stop 命令落定，不覆盖） */
  private async finalizeIfDone(client: PoolClient, jobId: string): Promise<{ jobStatus: string }> {
    const open = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM mat_batch_items WHERE job_id=$1 AND result IN ('pending','processing')",
      [jobId],
    );
    if (Number(open.rows[0]?.n ?? 0) === 0) {
      await client.query("UPDATE mat_batch_jobs SET status = CASE WHEN status='stopped' THEN 'stopped' ELSE 'done' END, updated_at=now() WHERE id=$1", [jobId]);
    }
    const st = await client.query<{ status: string }>('SELECT status FROM mat_batch_jobs WHERE id=$1', [jobId]);
    return { jobStatus: st.rows[0]?.status ?? '' };
  }

  private async nextJobCode(client: PoolClient, projectId: string): Promise<string> {
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const r = await client.query<{ code: string }>(
      "SELECT code FROM mat_batch_jobs WHERE project_id=$1 AND code ~ '^MJ-[0-9]+$' ORDER BY length(code) DESC, code DESC LIMIT 1",
      [projectId],
    );
    const next = r.rows[0] ? Number(r.rows[0].code.slice(3)) + 1 : 1;
    return `MJ-${String(next).padStart(4, '0')}`;
  }
}

function basisEqual(a: BasisEntry[], b: BasisEntry[]): boolean {
  return sha256(JSON.stringify(a)) === sha256(JSON.stringify(b));
}
