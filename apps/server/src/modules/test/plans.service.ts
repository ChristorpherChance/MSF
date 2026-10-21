import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { assertNotBlocked, lockBatch, nextCode, qof } from './test-common.js';

/**
 * 测试计划：起草/批准（A07-3；REQ-503）。
 * 起草=目录流程派生自动用例 + 强制人工走查；批准走策略点 test.plan.approve，
 * 追加新版本（previousId 链），用例随批准冻结复制。
 */
@Injectable()
export class TstPlansService {
  constructor(@Inject(PolicyService) private readonly policy: PolicyService) {}

  onModuleInit(): void {
    registerCommand('tst.plan.draft', async (client, payload, ctx) => {
      const { projectId, batchId } = payload as { projectId: string; batchId: string };
      const b = await lockBatch(client, projectId, batchId);
      assertNotBlocked(b);
      if (!['received', 'planned'].includes(b.status)) {
        throw new DomainError('INVALID_STATE', `批次状态 ${b.status} 不可起草计划`, batchId);
      }
      const terms = b.acceptance_terms as {
        flows?: Array<{ code: string; payload: { title?: string; steps?: string[]; reqIds?: string[] } }>;
      };
      const flows = terms.flows ?? [];
      // W2-014：deferred/dropped 语义=本期暂缓——起草时关联条目全暂缓的流程/步骤不进入本期测试范围
      const defRows = await client.query<{ from_code: string }>(
        "SELECT from_code FROM rtm_links WHERE project_id=$1 AND relation IN ('deferred','dropped')",
        [projectId]);
      const deferred = new Set(defRows.rows.map((r) => r.from_code));
      const reqCodesOf = (text: string) => [...text.matchAll(/\bREQ-\d{3}\b/g)].map((m) => m[0]);
      const allDeferred = (codes: string[]) => codes.length > 0 && codes.every((c) => deferred.has(c));
      const skippedDeferred: string[] = [];
      interface CaseSpec { code: string; title: string; flowId: string | null; mode: 'auto' | 'manual'; priority: string; steps: Array<{ action: string; expected: string }> }
      const specs: CaseSpec[] = [];
      let n = 0;
      for (const f of flows) {
        if (allDeferred(f.payload.reqIds ?? [])) {
          skippedDeferred.push(`${f.code}（${(f.payload.reqIds ?? []).join('、')}）`);
          continue;
        }
        const steps = (f.payload.steps ?? []).filter((st) => {
          if (allDeferred(reqCodesOf(st))) {
            skippedDeferred.push(`${f.code} 步骤「${st.slice(0, 30)}」（${reqCodesOf(st).join('、')}）`);
            return false;
          }
          return true;
        });
        for (const st of steps) {
          n++;
          specs.push({
            code: `AT-${String(n).padStart(3, '0')}`, title: `${f.payload.title ?? f.code}：${st}`,
            flowId: f.code, mode: 'auto', priority: 'P1',
            steps: [{ action: st, expected: '按目录流程定义通过' }],
          });
        }
      }
      // 页面一致性用例（2026-10-21 通过标准机制）：批次快照 passCriteria「每原型页 × 六维」
      // 逐维人工核对——原型一致是首要通过标准（P0 必测），缺陷可定位到维度
      const passCriteria = (b.acceptance_terms as {
        passCriteria?: { dimensions?: Array<{ key: string; name: string; hint: string }>; pages?: Array<{ code: string; title: string }> };
      }).passCriteria;
      for (const pg of passCriteria?.pages ?? []) {
        n++;
        specs.push({
          code: `AT-${String(n).padStart(3, '0')}`,
          title: `页面一致：${pg.title}（${pg.code}）`,
          flowId: null, mode: 'manual', priority: 'P0',
          steps: (passCriteria?.dimensions ?? []).map((d) => ({
            action: `【${d.name}】${d.hint}`, expected: `${pg.code} 与定稿原型完全一致`,
          })),
        });
      }
      // 强制至少一条人工走查（REQ-503 硬条件）
      specs.push({
        code: 'AT-MANUAL', title: '人工走查：关键路径端到端', flowId: null, mode: 'manual', priority: 'P1',
        steps: [{ action: '按验收条款人工走查关键路径', expected: '无阻断问题' }],
      });
      const code = await nextCode(client, 'tst_plans', 'batch_id=$1', [b.id], 'TP');
      const ver = await client.query<{ v: number | null }>('SELECT max(version_no) AS v FROM tst_plans WHERE batch_id=$1', [b.id]);
      const plan = await client.query<{ id: string }>(
        `INSERT INTO tst_plans (batch_id, code, version_no, scope, has_manual_walkthrough, created_by)
         VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,
        [b.id, code, (ver.rows[0]?.v ?? 0) + 1, JSON.stringify(specs.map((s) => ({ code: s.code, mode: s.mode, required: true }))), ctx.actorId]);
      for (const s of specs) {
        const contentHash = fingerprint({ title: s.title, flowId: s.flowId, steps: s.steps, mode: s.mode });
        await client.query(
          `INSERT INTO tst_cases (plan_id, code, title, flow_id, priority, mode, must_run, steps, content_hash, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`,
          [plan.rows[0]!.id, s.code, s.title, s.flowId, s.priority, s.mode, JSON.stringify(s.steps), contentHash, ctx.actorId]);
      }
      if (b.status === 'received') {
        await client.query("UPDATE tst_batches SET status='planned' WHERE id=$1", [b.id]);
      }
      return {
        planId: code, status: 'draft',
        cases: specs.map((s) => ({ id: s.code, flowId: s.flowId, mode: s.mode === 'auto' ? 'automatic' : 'manual', required: true })),
        skippedDeferred,
      };
    });

    registerCommand('tst.plan.approve', async (client, payload, ctx) => {
      const { projectId, batchId, planId, confirm } = payload as {
        projectId: string; batchId: string; planId: string; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'test.plan.approve');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '计划批准确认点为人工模式，AI 通道不可调用', 'test.plan.approve');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '计划批准须人工确认（confirm:true）', 'confirm');
      const b = await lockBatch(client, projectId, batchId);
      assertNotBlocked(b);
      const p = await client.query<{ id: string; state: string; version_no: number }>(
        'SELECT * FROM tst_plans WHERE batch_id=$1 AND code=$2 FOR UPDATE', [b.id, planId]);
      if (!p.rows[0]) throw new DomainError('NOT_FOUND', '计划不存在', planId);
      if (p.rows[0].state !== 'draft') throw new DomainError('INVALID_STATE', '仅草稿计划可批准', planId);
      // 追加新版本（previousId 链）：草稿保留，批准行为新行
      const code = await nextCode(client, 'tst_plans', 'batch_id=$1', [b.id], 'TP');
      const scope = await client.query<{ scope: unknown; has_manual_walkthrough: boolean }>(
        'SELECT scope, has_manual_walkthrough FROM tst_plans WHERE id=$1', [p.rows[0].id]);
      const approved = await client.query<{ id: string }>(
        `INSERT INTO tst_plans (batch_id, code, version_no, scope, has_manual_walkthrough, state, previous_id, approved_by, approved_at, created_by)
         VALUES ($1,$2,$3,$4,$5,'approved',$6,$7,now(),$7) RETURNING id`,
        [b.id, code, p.rows[0].version_no + 1, JSON.stringify(scope.rows[0]!.scope),
          scope.rows[0]!.has_manual_walkthrough, p.rows[0].id, ctx.actorId]);
      // 用例随批准冻结复制（content_hash 不变，供回归同版校验）
      await client.query(
        `INSERT INTO tst_cases (plan_id, code, title, flow_id, req_codes, priority, mode, must_run, steps, content_hash, created_by)
         SELECT $1, code, title, flow_id, req_codes, priority, mode, must_run, steps, content_hash, $2
         FROM tst_cases WHERE plan_id=$3`,
        [approved.rows[0]!.id, ctx.actorId, p.rows[0].id]);
      await client.query("UPDATE tst_batches SET status='approved' WHERE id=$1", [b.id]);
      return { planId: code, status: 'approved', previousId: planId };
    });
  }

  // ---------- 命令入口 ----------

  async draft(projectId: string, batchId: string, ctx: CommandContext) {
    return executeCommand('tst.plan.draft', { projectId, batchId }, { ...ctx, projectId });
  }

  async approve(projectId: string, batchId: string, planId: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('tst.plan.approve', { projectId, batchId, planId, confirm }, { ...ctx, projectId });
  }

  // ---------- 查询面 ----------

  /** 批次当前计划（最新 approved 优先，否则最新 draft）+ 用例行 */
  async current(projectId: string, batchId: string) {
    const b = await qof(null)<{ id: string }>(
      'SELECT id FROM tst_batches WHERE project_id=$1 AND code=$2', [projectId, batchId]);
    if (!b.rows[0]) throw new DomainError('NOT_FOUND', '批次不存在', batchId);
    const p = await query(
      `SELECT * FROM tst_plans WHERE batch_id=$1
       ORDER BY (state='approved') DESC, version_no DESC LIMIT 1`, [b.rows[0].id]);
    if (!p.rows[0]) return { plan: null, cases: [] };
    const plan = p.rows[0] as Record<string, unknown>;
    const cases = await query(
      'SELECT id, code, title, flow_id, priority, mode, must_run, steps, content_hash FROM tst_cases WHERE plan_id=$1 ORDER BY code',
      [plan.id]);
    return {
      plan: {
        planId: plan.code, state: plan.state, versionNo: plan.version_no,
        hasManualWalkthrough: plan.has_manual_walkthrough,
        approvedBy: plan.approved_by ?? null, approvedAt: plan.approved_at ?? null,
      },
      cases: cases.rows.map((c: Record<string, unknown>) => ({
        caseId: c.id, code: c.code, title: c.title, flowId: c.flow_id,
        priority: c.priority, mode: c.mode, mustRun: c.must_run, steps: c.steps,
        contentHash: c.content_hash,
      })),
    };
  }
}
