import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { mdToHtml } from '../platform/md-html.js';
import { StorageService } from '../platform/storage.service.js';
import { evaluateUiEvidence, type UiMatrixCell, type UiObserved } from '../platform/ui-score.js';
import { latestBaseline, qof, type GateIssue } from './gate-common.js';
import { devMode, DevWorkspaceService } from './workspace.service.js';

/** 四门评估口径版本（入实质返工指纹；求值逻辑变化才递增——v2=2026-10-19 CI 历史连坐/人工合并依据认账双根修；
 *  v3=2026-10-20 四门诚实化：ui 门 real 工作区真实观察/functional 覆盖率如实/review 门 real 只认真评审证据）。
 *  导出供测试夹具同源构造指纹，防生产/测试两套口径漂移。 */
export const SELFTEST_GATE_RULES_VERSION = 3;

/** 页面接线观察判定（纯函数可单测）：文件缺失→fail；带 msf:prototype-copy 标记=原型静态副本未接线→fail */
export function pageWiredOutcome(html: string | null): 'pass' | 'fail' {
  if (html === null) return 'fail';
  return html.includes('msf:prototype-copy') ? 'fail' : 'pass';
}

/**
 * 开发自测四门 + 报告（A06-14~17；F02-7/F05；REQ-413/414/415/416/417）。
 * mock 口径：四门由执行证据派生（functional=单测证据齐、integration=CI 最新 pass、
 * ui=目录矩阵×视口 evaluateUiEvidence 全 pass 观察、review=ai-review 证据齐）；
 * 单飞（SELFTEST_RUNNING 零写拒绝）；retest 实质返工核验（RETEST_WITHOUT_CHANGE）；
 * 报告不可变（指纹剔除自身字段自重算，篡改 → SELFTEST_REPORT_TAMPERED）。
 */
@Injectable()
export class DevSelftestService {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() @Inject(DevWorkspaceService) private readonly ws?: DevWorkspaceService,
  ) {}

  onModuleInit(): void {
    // A06-14 启动（含 retest 内部分支；门禁 F02-7 devStartSelfTest 前置）
    registerCommand('dev.selftest.start', async (client, payload, ctx) => {
      const { projectId, retestOfReportId, reason } = payload as {
        projectId: string; retestOfReportId?: string; reason?: string;
      };
      const issues = await this.startIssues(client, projectId, retestOfReportId ?? null, reason ?? null);
      if (issues.length > 0) {
        const code = issues[0]!.code;
        if (code === 'RETEST_WITHOUT_CHANGE') {
          throw new DomainError('RETEST_WITHOUT_CHANGE', issues[0]!.message, issues[0]!.target);
        }
        throw new DomainError('GATE_BLOCKED', '自测启动门禁未通过', 'selftest', { issues });
      }
      const build = await client.query<{ id: string; code: string; build_fingerprint: string }>(
        'SELECT * FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      const b = build.rows[0]!;
      const bl = await latestBaseline(client, projectId);
      const basisFp = fingerprint({ build: b.build_fingerprint, baseline: bl?.baseline_fingerprint ?? null });
      const retestOf = retestOfReportId
        ? (await client.query<{ selftest_id: string }>('SELECT selftest_id FROM dev_reports WHERE id=$1', [retestOfReportId])).rows[0]?.selftest_id ?? null
        : null;
      const remediationFp = await this.remediationFingerprint(client, projectId); // 始终记录：复测实质返工比对基准
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_selftests (project_id, build_id, build_fingerprint, gate_function, gate_smoke, gate_ui, gate_review,
           status, basis_fingerprint, retest_of, remediation_fingerprint, started_by)
         VALUES ($1,$2,$3,'{}','{}','{}','{}','running',$4,$5,$6,$7) RETURNING id`,
        [projectId, b.id, b.build_fingerprint, basisFp, retestOf, remediationFp, ctx.actorId]);
      return { selftestId: r.rows[0]!.id, status: 'running', basisFingerprint: `sha256:${basisFp}` };
    });

    // A06-14 复测入口（devRetestSelfTest：针对最近失败报告 + reason 必填 + 实质返工核验）
    registerCommand('dev.selftest.retest', async (client, payload, ctx) => {
      const { projectId, retestOfReportId, reason } = payload as {
        projectId: string; retestOfReportId?: string; reason?: string;
      };
      if (!retestOfReportId) throw new DomainError('VALIDATION_FAILED', '复测须携带 retestOfReportId', 'retestOfReportId');
      const inner = async (): Promise<unknown> => {
        const issues = await this.startIssues(client, projectId, retestOfReportId, reason ?? null);
        if (issues.length > 0) {
          if (issues.some((i) => i.code === 'RETEST_WITHOUT_CHANGE')) {
            throw new DomainError('RETEST_WITHOUT_CHANGE', issues.find((i) => i.code === 'RETEST_WITHOUT_CHANGE')!.message);
          }
          throw new DomainError('GATE_BLOCKED', '复测门禁未通过', 'selftest', { issues });
        }
        const build = await client.query<{ id: string; build_fingerprint: string }>(
          'SELECT * FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
        const bl = await latestBaseline(client, projectId);
        const basisFp = fingerprint({ build: build.rows[0]!.build_fingerprint, baseline: bl?.baseline_fingerprint ?? null });
        const retestOf = (await client.query<{ selftest_id: string }>(
          'SELECT selftest_id FROM dev_reports WHERE id=$1', [retestOfReportId])).rows[0]?.selftest_id ?? null;
        const remediationFp = await this.remediationFingerprint(client, projectId);
        const r = await client.query<{ id: string }>(
          `INSERT INTO dev_selftests (project_id, build_id, build_fingerprint, gate_function, gate_smoke, gate_ui, gate_review,
             status, basis_fingerprint, retest_of, remediation_fingerprint, started_by)
           VALUES ($1,$2,$3,'{}','{}','{}','{}','running',$4,$5,$6,$7) RETURNING id`,
          [projectId, build.rows[0]!.id, build.rows[0]!.build_fingerprint, basisFp, retestOf, remediationFp, ctx.actorId]);
        return { selftestId: r.rows[0]!.id, status: 'running', retestOfReportId };
      };
      return inner();
    });

    // 完成回调（mock 执行器同步完成；真实执行器经 operation 回调，F02-7 完成回调迁移行）
    registerCommand('dev.selftest.complete', async (client, payload, ctx) => {
      const { projectId, selftestId } = payload as { projectId: string; selftestId: string };
      const st = await client.query<{ id: string; build_id: string; build_fingerprint: string; status: string }>(
        'SELECT * FROM dev_selftests WHERE id=$1 AND project_id=$2 FOR UPDATE', [selftestId, projectId]);
      const s = st.rows[0];
      if (!s) throw new DomainError('NOT_FOUND', '自测操作不存在', selftestId);
      if (s.status !== 'running') throw new DomainError('INVALID_STATE', `自测状态 ${s.status} 不可完成`, selftestId);

      // 四门求值
      const functional = await this.gateFunctional(client, projectId);
      const integration = await this.gateIntegration(client, projectId);
      const review = await this.gateReview(client, projectId);
      const ui = await this.gateUi(client, projectId);
      const gates = { functional, integration, ui: { ok: ui.ok, issues: ui.issues }, review };
      const status = functional.ok && integration.ok && ui.ok && review.ok ? 'pass' : 'fail';

      await client.query(
        `UPDATE dev_selftests SET gate_function=$3, gate_smoke=$4, gate_ui=$5, gate_review=$6, status=$7, finished_at=now()
         WHERE id=$1 AND project_id=$2`,
        [selftestId, projectId, JSON.stringify(functional), JSON.stringify(integration),
          JSON.stringify({ ok: ui.ok, issues: ui.issues, defects: ui.defects }), JSON.stringify(review), status]);

      // 逐页×视口明细（append-only）
      for (const cell of ui.cells) {
        await client.query(
          `INSERT INTO dev_selftest_pages (selftest_id, page_code, viewport_code, critical_total, critical_pass,
             general_total, general_pass, severe_deviations, skipped, not_run, passed, evidence_ids)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'[]')`,
          [selftestId, cell.pageId, cell.viewportId, cell.criticalTotal, cell.criticalPass,
            cell.generalTotal, cell.generalPass, cell.severeDeviations, cell.skipped, cell.notRun, cell.passed]);
      }

      // 不可变报告（REQ-417：执行证据自动汇总；指纹剔除自身字段）
      // W2-052：SR- 发号 count+1 属 check-then-act——咨询锁串行化「计数→插入」临界区
      await lockCodeGen(client, `msf:code:selftest:${projectId}`);
      const seq = await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_reports WHERE project_id=$1', [projectId]);
      const code = `SR-${String(Number(seq.rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
      const bl = await latestBaseline(client, projectId);
      const basedOn = { build_fingerprint: s.build_fingerprint, baseline_fingerprint: bl?.baseline_fingerprint ?? null, selftest_basis: selftestId };
      const summary = { gates, pages: ui.pages, cellCount: ui.cells.length };
      const reportFp = fingerprint(JSON.parse(JSON.stringify({ code, selftestId, basedOn, summary, status })));
      const rep = await client.query<{ id: string }>(
        `INSERT INTO dev_reports (project_id, code, selftest_id, based_on, summary, status, report_fingerprint, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [projectId, code, selftestId, JSON.stringify(basedOn), JSON.stringify(summary), status, reportFp, ctx.actorId]);
      return { reportId: rep.rows[0]!.id, code, status, gates };
    });

    // A06-16 导出（md+html 落 MinIO；报告不可变——仅回写 export_object_key 引用，不改内容）
    registerCommand('dev.report.export', async (client, payload) => {
      const { projectId, reportId, objectKey } = payload as { projectId: string; reportId: string; objectKey: string };
      await client.query('UPDATE dev_reports SET export_object_key=$3 WHERE id=$1 AND project_id=$2', [reportId, projectId, objectKey]);
      return { reportId, objectKey };
    });
  }

  // ---------- 命令入口 ----------

  async start(projectId: string, ctx: CommandContext) {
    const r = (await executeCommand('dev.selftest.start', { projectId }, { ...ctx, projectId })) as { selftestId: string };
    const done = (await this.complete(projectId, r.selftestId, ctx)) as Record<string, unknown>;
    return { operationId: `op_st_${r.selftestId.slice(0, 8)}`, ...done };
  }

  async retest(projectId: string, reason: string, ctx: CommandContext) {
    const latest = await query<{ id: string }>(
      'SELECT id FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const r = (await executeCommand('dev.selftest.retest',
      { projectId, retestOfReportId: latest.rows[0]?.id, reason }, { ...ctx, projectId })) as { selftestId: string };
    const done = (await this.complete(projectId, r.selftestId, ctx)) as Record<string, unknown>;
    return { operationId: `op_st_${r.selftestId.slice(0, 8)}`, retestOfReportId: latest.rows[0]?.id, ...done };
  }

  async complete(projectId: string, selftestId: string, ctx: CommandContext) {
    return executeCommand('dev.selftest.complete', { projectId, selftestId }, { ...ctx, projectId });
  }

  async export(projectId: string, reportId: string, format: 'md' | 'html', ctx: CommandContext) {
    const r = await query<{ code: string; summary: { gates: Record<string, { ok: boolean }> }; status: string; based_on: unknown }>(
      'SELECT * FROM dev_reports WHERE id=$1 AND project_id=$2', [reportId, projectId]);
    const rep = r.rows[0];
    if (!rep) throw new DomainError('NOT_FOUND', '报告不存在', reportId);
    const GATE_NAMES: Record<string, string> = { functional: '功能检查', integration: '联调与冒烟', ui: 'UI 符合度', review: '开发审核' };
    const md = `# 开发自测报告 ${rep.code}\n\n- 结论：${rep.status}\n- 依据：${JSON.stringify(rep.based_on)}\n\n` +
      Object.entries(rep.summary.gates).map(([k, g]) => `- ${GATE_NAMES[k] ?? k}：${g.ok ? '通过' : '阻断'}`).join('\n');
    const body = format === 'md' ? md
      : `<!doctype html><html><head><meta charset="utf-8"><title>${rep.code}</title></head><body>${mdToHtml(md)}</body></html>`;
    const objectKey = `exports/${projectId}/report-${rep.code}.${format}`;
    await this.storage.putObject(objectKey, Buffer.from(body, 'utf8'));
    await executeCommand('dev.report.export', { projectId, reportId, format, objectKey }, { ...ctx, projectId });
    return { downloadUrl: await this.storage.presignedGet(objectKey), format };
  }

  // ---------- 查询面 ----------

  /** A06-15 自测门禁（实时求值 §15(b) 闭集） */
  async gate(projectId: string): Promise<{ ok: boolean; issues: GateIssue[]; report: unknown }> {
    const issues = await this.liveIssues(projectId);
    const rep = await query<{ id: string; code: string; status: string }>(
      'SELECT id, code, status FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    return { ok: issues.length === 0 && rep.rows[0]?.status === 'pass', issues, report: rep.rows[0] ?? null };
  }

  /** A06-16 报告列表/详情 */
  async reports(projectId: string) {
    const r = await query(
      'SELECT id, code, status, based_on, report_fingerprint, export_object_key, created_at FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC',
      [projectId]);
    return { items: r.rows };
  }

  async reportDetail(projectId: string, reportId: string) {
    const r = await query('SELECT * FROM dev_reports WHERE id=$1 AND project_id=$2', [reportId, projectId]);
    const rep = r.rows[0] as Record<string, unknown> | undefined;
    if (!rep) throw new DomainError('NOT_FOUND', '报告不存在', reportId);
    const pages = await query(
      'SELECT page_code, viewport_code, critical_total, critical_pass, general_total, general_pass, severe_deviations, skipped, not_run, passed FROM dev_selftest_pages WHERE selftest_id=$1 ORDER BY page_code, viewport_code',
      [rep.selftest_id]);
    // 报告自重算校验（SELFTEST_REPORT_TAMPERED 探测）
    const recomputed = fingerprint(JSON.parse(JSON.stringify({
      code: rep.code, selftestId: rep.selftest_id, basedOn: rep.based_on, summary: rep.summary, status: rep.status,
    })));
    return {
      reportId: rep.id, code: rep.code, status: rep.status, gates: (rep.summary as { gates: unknown }).gates,
      pages: pages.rows, basedOn: rep.based_on,
      fingerprint: `sha256:${String(rep.report_fingerprint)}`, tampered: recomputed !== rep.report_fingerprint,
      immutable: true, createdAt: rep.created_at,
    };
  }

  /** A06-17 双侧对照（两侧不得渲染同一对象：指纹不同源校验） */
  async comparison(projectId: string, pageId: string) {
    const proto = await query<{ content_object_key: string | null; content_fingerprint: string }>(
      `SELECT v.content_object_key, v.content_fingerprint FROM dsg_documents d
       JOIN dsg_versions v ON v.id=COALESCE(d.final_version_id, d.current_version_id)
       WHERE d.project_id=$1 AND d.doc_kind='prototype'`, [projectId]);
    const build = await query<{ ui_artifact_object_key: string; ui_artifact_fingerprint: string }>(
      'SELECT ui_artifact_object_key, ui_artifact_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1',
      [projectId]);
    if (!proto.rows[0]?.content_object_key) throw new DomainError('NOT_FOUND', '原型工件不存在', pageId);
    if (!build.rows[0]) throw new DomainError('NOT_FOUND', '无候选构建 UI 工件', pageId);
    const p = proto.rows[0];
    const b = build.rows[0];
    const distinct = p.content_fingerprint !== b.ui_artifact_fingerprint;
    return {
      // HTML 工件上传未带 Content-Type，签名时覆盖使 iframe 渲染而非下载（差异登记）
      prototypePreviewUrl: `${await this.storage.presignedGet(p.content_object_key!, 300, undefined, 'text/html; charset=utf-8')}#${encodeURIComponent(pageId)}`,
      buildPreviewUrl: await this.storage.presignedGet(b.ui_artifact_object_key, 300, undefined, 'text/html; charset=utf-8'),
      sameObjectGuard: {
        prototypeHtmlFingerprint: `sha256:${p.content_fingerprint}`,
        buildHtmlFingerprint: `sha256:${b.ui_artifact_fingerprint}`,
        distinct,
      },
    };
  }

  // ---------- 内部 ----------

  /** 启动门禁（F02-7 devStartSelfTest 前置；§15(b)/(c) 子码） */
  private async startIssues(client: PoolClient, projectId: string, retestOfReportId: string | null, reason: string | null): Promise<GateIssue[]> {
    const q = qof(client);
    const issues: GateIssue[] = [];
    const build = await q<{ id: string; build_fingerprint: string; status: string }>(
      'SELECT * FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    if (!build.rows[0]) issues.push({ code: 'BUILD_REQUIRED', message: '尚无候选构建（构建前启动被拒）' });
    else if (build.rows[0].status !== 'pass') issues.push({ code: 'BUILD_INVALID', message: '候选构建未通过' });
    const plan = await q<{ snapshot: { taskIds?: string[] } }>(
      "SELECT snapshot FROM dev_plans WHERE project_id=$1 AND state='approved' ORDER BY revision DESC LIMIT 1", [projectId]);
    if (plan.rows[0]) {
      const notDone = await q<{ code: string }>(
        `SELECT code FROM dev_tasks WHERE project_id=$1 AND code = ANY($2) AND col <> 'done'`,
        [projectId, plan.rows[0].snapshot.taskIds ?? []]);
      for (const t of notDone.rows) issues.push({ code: 'TASK_NOT_DONE', message: `${t.code} 尚未合并完成`, target: t.code });
    }
    const running = await q<{ id: string }>(
      "SELECT id FROM dev_selftests WHERE project_id=$1 AND status='running'", [projectId]);
    if (running.rows[0]) issues.push({ code: 'SELFTEST_RUNNING', message: '自测运行中（重复启动零写拒绝）', target: running.rows[0].id });
    const latestReport = await q<{ id: string; status: string; based_on: { build_fingerprint?: string } }>(
      'SELECT id, status, based_on FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const lr = latestReport.rows[0];
    if (!retestOfReportId) {
      if (lr?.status === 'fail') issues.push({ code: 'RETEST_REQUIRED', message: '最近报告 fail，必须走复测入口', target: lr.id });
    } else {
      // 复测：reason 必填 + 实质返工核验（INV-RETEST-1）
      if (!reason?.trim()) issues.push({ code: 'VALIDATION_FAILED', message: '复测理由必填' });
      if (!lr || lr.status !== 'fail' || lr.id !== retestOfReportId) {
        issues.push({ code: 'INVALID_STATE', message: '复测须针对最近失败报告' });
      } else {
        const failedSt = await q<{ remediation_fingerprint: string | null }>(
          'SELECT remediation_fingerprint FROM dev_selftests WHERE id=(SELECT selftest_id FROM dev_reports WHERE id=$1)',
          [lr.id]);
        const remediation = await this.remediationFingerprint(client, projectId);
        if (failedSt.rows[0] && remediation === failedSt.rows[0].remediation_fingerprint) {
          issues.push({ code: 'RETEST_WITHOUT_CHANGE', message: '无实质返工的复测（构建/任务修订/提交集合均未变化）' });
        }
      }
    }
    return issues;
  }

  /** 实质返工派生指纹：当前构建指纹 + 任务修订集合 + 评估口径版本（系统派生，调用方不可填）。
   *  口径版本入指纹：门禁评估逻辑修复本身即实质变化——否则假阳性 fail 报告永远过不了
   *  INV-RETEST-1（构建幂等撞指纹/任务无修订），被冤 run 无任何恢复路径（2026-10-19 run_261 教训）。
   *  纪律：仅当四门求值逻辑（gateIntegration/gateReview/gateUi/gateFunctional）变化时才递增。 */
  private async remediationFingerprint(client: PoolClient | null, projectId: string): Promise<string> {
    const q = qof(client);
    const build = await q<{ build_fingerprint: string }>(
      'SELECT build_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const tasks = await q<{ code: string; rev: number; code_rev: number }>(
      'SELECT code, rev, code_rev FROM dev_tasks WHERE project_id=$1 ORDER BY code', [projectId]);
    return fingerprint({
      gateRules: SELFTEST_GATE_RULES_VERSION,
      build: build.rows[0]?.build_fingerprint ?? null,
      tasks: tasks.rows.map((t) => `${t.code}:${t.rev}:${t.code_rev}`),
    });
  }

  /** 实时门禁（A06-15；转测试门禁透传组复用） */
  async liveIssues(projectId: string): Promise<GateIssue[]> {
    const issues: GateIssue[] = [];
    const running = await query<{ id: string }>(
      "SELECT id FROM dev_selftests WHERE project_id=$1 AND status='running'", [projectId]);
    if (running.rows[0]) issues.push({ code: 'SELFTEST_RUNNING', message: '自测运行中', target: running.rows[0].id });
    const rep = await query<{ id: string; code: string; status: string; based_on: { build_fingerprint?: string; baseline_fingerprint?: string }; report_fingerprint: string; selftest_id: string; summary: unknown }>(
      'SELECT * FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const r = rep.rows[0];
    if (!r || r.status !== 'pass') {
      issues.push({ code: 'SELFTEST_REQUIRED', message: '需要当前通过的开发自测报告' });
      return issues;
    }
    // 报告篡改探测（自重算）
    const recomputed = fingerprint(JSON.parse(JSON.stringify({ code: r.code, selftestId: r.selftest_id, basedOn: r.based_on, summary: r.summary, status: r.status })));
    if (recomputed !== r.report_fingerprint) {
      issues.push({ code: 'SELFTEST_REPORT_TAMPERED', message: '报告对象指纹不符', target: r.code });
    }
    const build = await query<{ build_fingerprint: string }>(
      'SELECT build_fingerprint FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    if (build.rows[0] && build.rows[0].build_fingerprint !== r.based_on.build_fingerprint) {
      issues.push({ code: 'SELFTEST_BUILD_STALE', message: '候选构建已变化', target: r.code });
    }
    const bl = await latestBaseline(null, projectId);
    if (bl && r.based_on.baseline_fingerprint && bl.baseline_fingerprint !== r.based_on.baseline_fingerprint) {
      issues.push({ code: 'SELFTEST_DESIGN_STALE', message: '设计基线已变化', target: r.code });
    }
    return issues;
  }

  // ---------- 四门 mock 求值 ----------

  private async gateFunctional(client: PoolClient, projectId: string) {
    const tasks = await client.query<{ id: string; code: string; acceptance: unknown[] }>(
      "SELECT id, code, acceptance FROM dev_tasks WHERE project_id=$1 AND col='done'", [projectId]);
    const missing: string[] = [];
    for (const t of tasks.rows) {
      const ev = await client.query<{ id: string }>(
        `SELECT seq FROM evd_records WHERE project_id=$1 AND kind='unit' AND payload->>'taskId'=$2 AND (payload->>'pass')::boolean=true LIMIT 1`,
        [projectId, t.id]);
      if (!ev.rows[0]) missing.push(t.code);
    }
    // 覆盖率如实（2026-10-20 诚实化）：取最近一条单测证据的真实采集值；real 沙箱未采集=null（前端显示「未采集」），
    // 旧口径硬编码 85/78 是 mock 残留假数字
    const cov = await client.query<{ line: number | null; branch: number | null }>(
      `SELECT (payload->>'line')::numeric AS line, (payload->>'branch')::numeric AS branch
       FROM evd_records WHERE project_id=$1 AND kind='unit' ORDER BY created_at DESC LIMIT 1`, [projectId]);
    const c = cov.rows[0];
    return { ok: missing.length === 0, missing, coverage: c && c.line !== null ? { line: c.line, branch: c.branch } : null };
  }

  private async gateIntegration(client: PoolClient, projectId: string) {
    // 口径（2026-10-19 根修 run_261 冤案）：CI 评的是「仓库当前代码态」——最近一次报告 pass 即过门；
    // 旧口径要求全部历史 commit_sha 各自最新结论全 pass，返工早期红过的 sha 永久连坐（代码早已修绿）
    const latest = await client.query<{ commit_sha: string; conclusion: string }>(
      'SELECT commit_sha, conclusion FROM dev_ci_reports WHERE project_id=$1 ORDER BY received_at DESC LIMIT 1', [projectId]);
    const cur = latest.rows[0];
    const failed = cur && cur.conclusion !== 'pass' ? [cur] : [];
    return { ok: failed.length === 0, failed, latestSha: cur?.commit_sha ?? null };
  }

  private async gateReview(client: PoolClient, projectId: string) {
    const tasks = await client.query<{ id: string; code: string }>(
      "SELECT id, code FROM dev_tasks WHERE project_id=$1 AND col='done'", [projectId]);
    // real 模式只认真实评审证据（mode='ai'，2026-10-20 诚实化——mock 评审证据在 real 下是假绿）；
    // mock 模式不设 mode 条件（历史/测试证据无 mode 字段兼容）
    const realOnly = devMode() === 'real';
    const missing: string[] = [];
    for (const t of tasks.rows) {
      const ev = await client.query<{ id: string }>(
        `SELECT seq FROM evd_records WHERE project_id=$1 AND kind='ai-review' AND payload->>'taskId'=$2
         AND payload->>'conclusion'='pass' AND ($3::bool = false OR payload->>'mode'='ai') LIMIT 1`,
        [projectId, t.id, realOnly]);
      if (ev.rows[0]) continue;
      // 人工依据合并（manual-checklist/manual-skip/legacy-manual）= 人工已承担评审（依据链深冻结在
      // dev_prs.merge_basis 可查，2026-10-19 根修 run_261：manual-checklist 合并的任务此前永挂缺失）
      const pr = await client.query<{ merge_basis: { type?: string } }>(
        `SELECT merge_basis FROM dev_prs WHERE task_id=$1 AND status='merged' ORDER BY updated_at DESC LIMIT 1`,
        [t.id]);
      const bt = pr.rows[0]?.merge_basis?.type ?? '';
      if (['manual-checklist', 'manual-skip', 'legacy-manual'].includes(bt)) continue;
      missing.push(t.code);
    }
    return { ok: missing.length === 0, missing, reviewer: realOnly ? 'ai-reviewer(real)' : 'mock-reviewer' };
  }

  /** UI 门：mock=目录矩阵×视口 evaluateUiEvidence 全 pass 观察（遗留口径）；
   *  real（2026-10-20 诚实化）=工作区真实观察：每页 public/pages/<code>.html 存在且非原型静态副本
   *  （msf:prototype-copy 标记=AI 未接线兜底）——单视口 'default' 页面级矩阵，不再伪造视口×检查项全绿 */
  private async gateUi(client: PoolClient, projectId: string) {
    const cat = await client.query<{ catalog_version: string }>(
      'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1', [projectId]);
    const catVer = cat.rows[0]?.catalog_version;
    if (!catVer) return { ok: false, issues: [{ code: 'UI_EXPECTED_MATRIX_MISMATCH', message: '无设计目录' }], defects: [], cells: [], pages: [] };
    const items = await client.query<{ item_type: string; code: string }>(
      'SELECT item_type, code FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2', [projectId, catVer]);
    const pages = items.rows.filter((i) => i.item_type === 'page').map((i) => i.code);
    const viewports = items.rows.filter((i) => i.item_type === 'viewport').map((i) => i.code);
    if (devMode() === 'real') {
      const matrix: UiMatrixCell[] = pages.map((p) => ({
        pageId: p, viewportId: 'default',
        criticalItems: [{ id: 'c-page-wired', kind: 'visual' }],
        generalItems: [],
      }));
      const observed: UiObserved[] = [];
      for (const p of pages) {
        const html = this.ws
          ? await this.ws.readFile(projectId, `public/pages/${p}.html`).catch(() => null)
          : null;
        observed.push({ pageId: p, viewportId: 'default', checkId: 'c-page-wired', kind: 'visual', outcome: pageWiredOutcome(html) });
      }
      const r = evaluateUiEvidence(matrix, observed);
      // 失败语义人话化（report 卡直接可读的 message；UI_OBSERVATION_FAIL 等裸码补注）
      r.issues = r.issues.map((i) => ({
        ...i,
        message: `${i.message}（real 观察口径：页面接线版 public/pages/<页码>.html 须存在且非原型静态副本）`,
      }));
      return r;
    }
    const states = items.rows.filter((i) => i.item_type === 'state').map((i) => i.code);
    const matrix: UiMatrixCell[] = [];
    for (const p of pages) {
      for (const v of viewports) {
        matrix.push({
          pageId: p, viewportId: v,
          criticalItems: [{ id: 'c-layout', kind: 'visual' }, { id: 'c-content', kind: 'visual' }],
          generalItems: [
            { id: 'g-visual', kind: 'visual' },
            ...states.map((s) => ({ id: `state-${s}`, kind: 'state', requiredState: true })),
          ],
        });
      }
    }
    const observed: UiObserved[] = matrix.flatMap((c) =>
      [...c.criticalItems, ...c.generalItems].map((d) => ({
        pageId: c.pageId, viewportId: c.viewportId, checkId: d.id, kind: d.kind, outcome: 'pass',
      })));
    return evaluateUiEvidence(matrix, observed);
  }
}
