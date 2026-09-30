import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { StorageService } from '../platform/storage.service.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { assertNotBlocked, lockBatch, nextCode, sha256hex, type BatchRow } from './test-common.js';

/**
 * 批次接收/快照/阻断/恢复（A07-1/2/13/14；F02-8；REQ-501/502）。
 * 接收校验链：交接存在 → 报告 pass → 三指纹（构建/报告/基线）与实时一致 → 幂等接收（handoff_fingerprint UNIQUE）。
 * 阻断/恢复产通知行+领域事件（M7 回销 M5 差异⑤：替代纯审计承载，BR-10）。
 */
@Injectable()
export class TstBatchesService {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(NotificationsService) private readonly notices: NotificationsService,
  ) {}

  onModuleInit(): void {
    // A07-1 批次接收（幂等）
    registerCommand('tst.batch.receive', async (client, payload, ctx) => {
      const { projectId, handoffId, buildFingerprint, selftestReportFingerprint, designBaselineFingerprint, environment } =
        payload as {
          projectId: string; handoffId: string; buildFingerprint: string;
          selftestReportFingerprint: string; designBaselineFingerprint: string;
          environment: Record<string, unknown>;
        };
      // 入参兜底：缺交接凭据不得误报「交接不存在」（实机走查修复，同 #16 口径）
      if (typeof handoffId !== 'string' || !handoffId) {
        throw new DomainError('VALIDATION_FAILED', '交接标识缺失（handoffId）', 'handoffId');
      }
      // 交接存在性（跨域 SQL 直读 dev 表，边界纪律允许）
      const ho = await client.query<{
        id: string; build_id: string; build_fingerprint: string; report_id: string; report_fingerprint: string;
        handoff_fingerprint: string;
      }>('SELECT * FROM dev_transfer WHERE id=$1 AND project_id=$2', [handoffId, projectId]);
      const h = ho.rows[0];
      if (!h) throw new DomainError('HANDOFF_INVALID', '交接不存在', handoffId);
      // W2-036：三指纹同为必填（缺失时 strip(undefined) 会裸 500）；校验置于交接存在性之后（不抢 HANDOFF_INVALID 语义）
      for (const [k, v] of [['buildFingerprint', buildFingerprint], ['selftestReportFingerprint', selftestReportFingerprint], ['designBaselineFingerprint', designBaselineFingerprint]] as const) {
        if (typeof v !== 'string' || !v) throw new DomainError('VALIDATION_FAILED', `${k} 缺失（三指纹复核必填）`, k);
      }
      const strip = (s: string) => s.replace(/^sha256:/, '');
      // 报告当前合格（REQ-501）
      const rep = await client.query<{ status: string }>('SELECT status FROM dev_reports WHERE id=$1', [h.report_id]);
      if (rep.rows[0]?.status !== 'pass') {
        throw new DomainError('GATE_BLOCKED', '开发自测结论非当前合格（pass）', handoffId,
          { issues: [{ code: 'SELFTEST_REQUIRED', message: '自测报告非 pass' }] });
      }
      // 构建当前候选一致 + 三指纹复核
      const curBuild = await client.query<{ build_fingerprint: string }>(
        'SELECT build_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      if (curBuild.rows[0]?.build_fingerprint !== h.build_fingerprint || strip(buildFingerprint) !== h.build_fingerprint) {
        throw new DomainError('STALE_EVIDENCE', '构建指纹与交接/当前候选不一致', handoffId);
      }
      if (strip(selftestReportFingerprint) !== h.report_fingerprint) {
        throw new DomainError('STALE_EVIDENCE', '自测报告指纹与交接不一致', handoffId);
      }
      const bl = await client.query<{ id: string; baseline_fingerprint: string }>(
        'SELECT id, baseline_fingerprint FROM dsg_baselines WHERE project_id=$1 ORDER BY confirmed_at DESC LIMIT 1', [projectId]);
      if (!bl.rows[0] || strip(designBaselineFingerprint) !== bl.rows[0].baseline_fingerprint) {
        throw new DomainError('STALE_EVIDENCE', '设计基线指纹与当前有效基线不一致', handoffId);
      }
      // 幂等接收：同交接指纹返回既有批次
      const dup = await client.query<{ id: string; code: string; created_at: string }>(
        'SELECT id, code, created_at FROM tst_batches WHERE handoff_fingerprint=$1', [h.handoff_fingerprint]);
      if (dup.rows[0]) {
        return { batchId: dup.rows[0].code, status: 'received', deduplicated: true, receivedAt: dup.rows[0].created_at };
      }
      // 验收条款快照：当前设计目录流程/页面
      const cat = await client.query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY catalog_version DESC LIMIT 1', [projectId]);
      const items = cat.rows[0]
        ? await client.query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
            'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY code',
            [projectId, cat.rows[0].catalog_version])
        : { rows: [] as Array<{ item_type: string; code: string; payload: Record<string, unknown> }> };
      const acceptanceTerms = {
        catalogVersion: cat.rows[0]?.catalog_version ?? null,
        flows: items.rows.filter((i) => i.item_type === 'flow').map((i) => ({ code: i.code, payload: i.payload })),
        pages: items.rows.filter((i) => i.item_type === 'page').map((i) => i.code),
      };
      const envFp = sha256hex(fingerprint(JSON.parse(JSON.stringify(environment ?? {}))));
      const code = await nextCode(client, 'tst_batches', 'project_id=$1', [projectId], 'TB');
      const buildSnap = { build_id: h.build_id, build_fingerprint: h.build_fingerprint };
      const reportSnap = { report_id: h.report_id, report_fingerprint: h.report_fingerprint, status: 'pass' };
      const baselineSnap = { baseline_id: bl.rows[0]!.id, baseline_fingerprint: bl.rows[0]!.baseline_fingerprint };
      await client.query(
        `INSERT INTO tst_batches (project_id, code, handoff_fingerprint, handoff, build_snapshot, dev_report_snapshot,
           baseline_snapshot, acceptance_terms, environment, environment_fingerprint, received_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [projectId, code, h.handoff_fingerprint, JSON.stringify({ handoffId: h.id, handoffFingerprint: h.handoff_fingerprint }),
          JSON.stringify(buildSnap), JSON.stringify(reportSnap), JSON.stringify(baselineSnap),
          JSON.stringify(acceptanceTerms), JSON.stringify(environment ?? {}), envFp, ctx.actorId]);
      const snapFp = fingerprint(JSON.parse(JSON.stringify(
        { build: buildSnap, report: reportSnap, baseline: baselineSnap, terms: acceptanceTerms, env: envFp })));
      return { batchId: code, status: 'received', snapshotFingerprint: `sha256:${snapFp}`, receivedAt: new Date().toISOString(), deduplicated: false };
    });

    // A07-13 批次阻断（人工中止；received/released/已 blocked 拒绝）
    registerCommand('tst.batch.block', async (client, payload) => {
      const { projectId, batchId, reason } = payload as { projectId: string; batchId: string; reason?: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '阻断理由必填', 'reason');
      const b = await lockBatch(client, projectId, batchId);
      if (!['planned', 'approved', 'executing', 'reported'].includes(b.status)) {
        throw new DomainError('INVALID_STATE', `批次状态 ${b.status} 不可阻断（received 未起步 / released 已终态 / blocked 已阻断）`, batchId);
      }
      await client.query(
        "UPDATE tst_batches SET status='blocked', previous_status=$3, blocked_reason=$4 WHERE id=$1 AND project_id=$2",
        [b.id, projectId, b.status, reason]);
      // 通知行+领域事件由外层 block() 在命令提交后产（同项目全员通知，SSE notice.created）
      return { batchId, status: 'blocked', previousStatus: b.status, blockedAt: new Date().toISOString() };
    });

    // A07-14 批次恢复（理由必填 + 快照身份实时复核）
    registerCommand('tst.batch.unblock', async (client, payload) => {
      const { projectId, batchId, reason } = payload as { projectId: string; batchId: string; reason?: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '恢复理由必填', 'reason');
      const b = await lockBatch(client, projectId, batchId);
      if (b.status !== 'blocked') throw new DomainError('INVALID_STATE', '仅阻断态批次可恢复', batchId);
      // 快照各身份与实时重算一致：构建仍为当前候选、基线仍当前有效、报告仍合格
      const curBuild = await client.query<{ build_fingerprint: string }>(
        'SELECT build_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      const bl = await client.query<{ baseline_fingerprint: string }>(
        'SELECT baseline_fingerprint FROM dsg_baselines WHERE project_id=$1 ORDER BY confirmed_at DESC LIMIT 1', [projectId]);
      const rep = await client.query<{ status: string; report_fingerprint: string }>(
        'SELECT status, report_fingerprint FROM dev_reports WHERE id=$1', [b.dev_report_snapshot.report_id]);
      const mismatch =
        curBuild.rows[0]?.build_fingerprint !== b.build_snapshot.build_fingerprint ||
        bl.rows[0]?.baseline_fingerprint !== b.baseline_snapshot.baseline_fingerprint ||
        rep.rows[0]?.status !== 'pass' ||
        rep.rows[0]?.report_fingerprint !== b.dev_report_snapshot.report_fingerprint;
      if (mismatch) {
        throw new DomainError('STALE_EVIDENCE', '批次快照身份与实时重算不一致，须以新构建走新批次', batchId);
      }
      await client.query(
        'UPDATE tst_batches SET status=$3, previous_status=NULL, blocked_reason=NULL WHERE id=$1 AND project_id=$2',
        [b.id, projectId, b.previous_status ?? 'received']);
      return { batchId, status: b.previous_status ?? 'received', restoredFrom: 'blocked', restoredAt: new Date().toISOString() };
    });
  }

  // ---------- 命令入口 ----------

  async receive(
    projectId: string,
    body: { handoffId: string; buildFingerprint: string; selftestReportFingerprint: string; designBaselineFingerprint: string; environment: Record<string, unknown> },
    ctx: CommandContext,
  ) {
    return executeCommand('tst.batch.receive', { projectId, ...body }, { ...ctx, projectId });
  }

  async block(projectId: string, batchId: string, reason: string, ctx: CommandContext) {
    const r = await executeCommand('tst.batch.block', { projectId, batchId, reason }, { ...ctx, projectId });
    await this.notices.emit({ ...ctx, projectId }, {
      type: 'tst.batch.blocked', eventKind: 'batch.blocked', link: '/test',
      text: `批次 ${batchId} 已阻断：${reason}`,
    });
    return r;
  }

  async unblock(projectId: string, batchId: string, reason: string, ctx: CommandContext) {
    const r = (await executeCommand('tst.batch.unblock', { projectId, batchId, reason }, { ...ctx, projectId })) as { status: string };
    await this.notices.emit({ ...ctx, projectId }, {
      type: 'tst.batch.unblocked', eventKind: 'batch.unblocked', link: '/test',
      text: `批次 ${batchId} 已恢复为 ${r.status}：${reason}`,
    });
    return r;
  }

  // ---------- 查询面 ----------

  /** A07-2 批次列表（current=最新接收） */
  async list(projectId: string) {
    const r = await query(
      `SELECT code, status, environment, environment_fingerprint, received_by, received_at, blocked_reason, previous_status,
              build_snapshot->>'build_id' AS build_id
       FROM tst_batches WHERE project_id=$1 ORDER BY received_at DESC`, [projectId]);
    return {
      items: r.rows.map((b: Record<string, unknown>, i: number) => ({
        batchId: b.code, status: b.status, current: i === 0, buildId: b.build_id ?? null,
        environment: b.environment, environmentFingerprint: `sha256:${String(b.environment_fingerprint)}`,
        receivedBy: b.received_by, receivedAt: b.received_at,
        blockedReason: b.blocked_reason ?? null, previousStatus: b.previous_status ?? null,
      })),
    };
  }

  /** A07-2 批次详情（含不可变快照全文） */
  async detail(projectId: string, batchId: string) {
    const r = await query<BatchRow>(
      'SELECT * FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', batchId);
    const b = r.rows[0];
    const plans = await query(
      'SELECT code, version_no, state, has_manual_walkthrough, created_at FROM tst_plans WHERE batch_id=$1 ORDER BY version_no', [b.id]);
    const runs = await query(
      'SELECT code, conclusion, is_simulated, created_at FROM tst_runs WHERE batch_id=$1 ORDER BY created_at DESC', [b.id]);
    return {
      batchId: b.code, status: b.status, immutable: true,
      blockedReason: b.blocked_reason, previousStatus: b.previous_status,
      snapshot: {
        handoff: b.handoff, build: b.build_snapshot, devReport: b.dev_report_snapshot,
        designBaseline: b.baseline_snapshot, acceptanceTerms: b.acceptance_terms,
        environment: b.environment, environmentFingerprint: `sha256:${b.environment_fingerprint}`,
      },
      receivedBy: b.received_by, receivedAt: b.received_at,
      plans: plans.rows, runs: runs.rows,
    };
  }

  /** A07-2 快照导出（JSON 落 MinIO + 签名 URL） */
  async export(projectId: string, batchId: string, ctx: CommandContext) {
    const det = await this.detail(projectId, batchId);
    const objectKey = `exports/${projectId}/batch-${batchId}-snapshot.json`;
    await this.storage.putObject(objectKey, Buffer.from(JSON.stringify(det.snapshot, null, 2), 'utf8'));
    void ctx;
    return { downloadUrl: await this.storage.presignedGet(objectKey), batchId };
  }

  /** 待接收交接清单（跨域 SQL 直读 dev_transfer；已接收按 handoff_fingerprint 归并剔除，供 UI 接收入口） */
  async pendingHandoffs(projectId: string) {
    const r = await query(
      `SELECT t.id, t.build_fingerprint, t.report_fingerprint, t.created_at,
              b.code AS build_code, rep.code AS report_code, rep.status AS report_status
       FROM dev_transfer t
       JOIN dev_builds b ON b.id=t.build_id
       JOIN dev_reports rep ON rep.id=t.report_id
       WHERE t.project_id=$1
         AND NOT EXISTS (SELECT 1 FROM tst_batches tb WHERE tb.handoff_fingerprint=t.handoff_fingerprint)
       ORDER BY t.created_at DESC`, [projectId]);
    return {
      items: r.rows.map((h: Record<string, unknown>) => ({
        handoffId: h.id, buildCode: h.build_code, reportCode: h.report_code, reportStatus: h.report_status,
        buildFingerprint: `sha256:${String(h.build_fingerprint)}`,
        selftestReportFingerprint: `sha256:${String(h.report_fingerprint)}`,
        createdAt: h.created_at,
      })),
    };
  }
}

export { assertNotBlocked };
