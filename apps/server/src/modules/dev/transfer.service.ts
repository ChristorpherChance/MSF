import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { latestBaseline, sha256, type GateIssue } from './gate-common.js';
import { DevSelftestService } from './selftest.service.js';

/**
 * 转测试交接（A06-18/19；REQ-418）：仅当前有效且合格报告可交接；
 * 人工确认（策略点 dev.transfer）后原子交接：旋转运行令牌、消费授权、run=transferred、
 * 追加 dev_transfer（handoff_fingerprint 幂等，测试侧接收键 REQ-501）。
 */
@Injectable()
export class DevTransferService {
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(DevSelftestService) private readonly selftest: DevSelftestService,
  ) {}

  onModuleInit(): void {
    registerCommand('dev.transfer.handoff', async (client, payload, ctx) => {
      const { projectId, reportId, reportFingerprint, confirm } = payload as {
        projectId: string; reportId: string; reportFingerprint: string; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'dev.transfer');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '转测试确认点为人工模式，AI 通道不可调用', 'dev.transfer');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '转测试须人工确认（confirm:true）', 'confirm');
      const issues = await this.gateIssues(client, projectId);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '转测试门禁未通过', 'dev.transfer', { issues });
      const rep = await client.query<{ id: string; code: string; status: string; report_fingerprint: string; based_on: { build_fingerprint?: string } }>(
        'SELECT * FROM dev_reports WHERE id=$1 AND project_id=$2', [reportId, projectId]);
      const r = rep.rows[0];
      if (!r || r.status !== 'pass' || `sha256:${r.report_fingerprint}` !== reportFingerprint) {
        throw new DomainError('STALE_EVIDENCE', '报告身份不符（非当前有效合格报告）', reportId);
      }
      const build = await client.query<{ id: string; build_fingerprint: string }>(
        'SELECT * FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      const bl = await latestBaseline(client, projectId);
      const handoffFp = sha256(fingerprint({
        build: build.rows[0]!.build_fingerprint, report: r.report_fingerprint, baseline: bl?.baseline_fingerprint ?? null,
      }));
      // 幂等接收键：同交接指纹直接返回既有回执（UNIQUE 兜底）
      const dup = await client.query<{ id: string }>(
        'SELECT id FROM dev_transfer WHERE handoff_fingerprint=$1', [handoffFp]);
      if (dup.rows[0]) return { handoffId: dup.rows[0].id, deduplicated: true };
      // 原子交接：旋转令牌 + 消费授权 + run 终态化
      const newToken = randomUUID();
      const run = await client.query<{ id: string; run_id: string; authorization_id: string; status: string }>(
        "SELECT * FROM dev_runs WHERE project_id=$1 AND status='awaiting-transfer' ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [projectId]);
      let authConsumed: string | null = null;
      if (run.rows[0]) {
        await client.query("UPDATE dev_runs SET status='transferred', run_token=$2, updated_at=now() WHERE id=$1",
          [run.rows[0].id, newToken]);
        await client.query("UPDATE dev_authorizations SET status='consumed', updated_at=now() WHERE project_id=$1 AND authorization_id=$2",
          [projectId, run.rows[0].authorization_id]);
        authConsumed = run.rows[0].authorization_id;
      }
      const t = await client.query<{ id: string }>(
        `INSERT INTO dev_transfer (project_id, build_id, build_fingerprint, report_id, report_fingerprint,
           handoff_fingerprint, token_rotated, authorization_consumed, confirmed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [projectId, build.rows[0]!.id, build.rows[0]!.build_fingerprint, reportId, r.report_fingerprint,
          handoffFp, newToken, authConsumed, ctx.actorId]);
      return {
        handoffId: t.rows[0]!.id, tokenRotated: true,
        batchCandidate: {
          buildFingerprint: `sha256:${build.rows[0]!.build_fingerprint}`,
          designBaselineFingerprint: bl ? `sha256:${bl.baseline_fingerprint}` : null,
          selftestReportFingerprint: `sha256:${r.report_fingerprint}`,
        },
      };
    });
  }

  async transfer(projectId: string, reportId: string, reportFingerprint: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('dev.transfer.handoff', { projectId, reportId, reportFingerprint, confirm }, { ...ctx, projectId });
  }

  /** A06-18 转测试门禁（§15(c) 闭集 + §15(b) 透传组） */
  async gate(projectId: string): Promise<{ ok: boolean; issues: GateIssue[] }> {
    const issues = await this.gateIssues(null, projectId);
    return { ok: issues.length === 0, issues };
  }

  private async gateIssues(client: PoolClient | null, projectId: string): Promise<GateIssue[]> {
    const q = (client ? client.query.bind(client) : query) as <T = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    const issues: GateIssue[] = [];
    // §15(c)：任务/质量/CI/构建/影响/autopilot
    const plan = await q<{ snapshot: { taskIds?: string[] } }>(
      "SELECT snapshot FROM dev_plans WHERE project_id=$1 AND state='approved' ORDER BY revision DESC LIMIT 1", [projectId]);
    if (plan.rows[0]) {
      const notDone = await q<{ code: string }>(
        `SELECT code FROM dev_tasks WHERE project_id=$1 AND code = ANY($2) AND col <> 'done'`,
        [projectId, plan.rows[0].snapshot.taskIds ?? []]);
      for (const t of notDone.rows) {
        issues.push({ code: 'TASK_NOT_DONE', message: `${t.code} 尚未合并完成`, target: t.code });
      }
    }
    const build = await q<{ code: string; status: string }>(
      'SELECT code, status FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const b = build.rows[0];
    if (!b) issues.push({ code: 'BUILD_INVALID', message: '无候选构建' });
    else if (b.status !== 'pass') issues.push({ code: 'BUILD_INVALID', message: '候选构建未通过', target: b.code });
    const impacts = await q<{ code: string }>(
      "SELECT code FROM dev_impacts WHERE project_id=$1 AND status='pending-assessment'", [projectId]);
    for (const im of impacts.rows) {
      issues.push({ code: 'IMPACT_OPEN', message: `存在未处置影响单 ${im.code}`, target: im.code });
    }
    const run = await q<{ run_id: string; status: string }>(
      "SELECT run_id, status FROM dev_runs WHERE project_id=$1 AND status NOT IN ('stopped','transferred') ORDER BY created_at DESC LIMIT 1",
      [projectId]);
    const rr = run.rows[0];
    if (rr && rr.status !== 'awaiting-transfer') {
      issues.push({ code: 'AUTO_NOT_AWAITING_TRANSFER', message: 'autopilot 运行未停在「待人工转测试」', target: rr.run_id });
    }
    // 透传 A06-15 自测组（含 QUALITY/CI 由四门证据承载）
    issues.push(...await this.selftest.liveIssues(projectId));
    return issues;
  }
}
