import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { deriveLinks, computeHealth } from '../platform/rtm-health.js';
import { DesignDocsService } from './docs.service.js';
import { CatalogService } from './catalog.service.js';

/**
 * 原型四步流水（F02-2 状态机；A05-6/7/8/9/10/11；REQ-305~310）。
 * mock 口径：生成=目录驱动 HTML（data-page/data-state 标记）落 MinIO + manifest 入 dsg_versions；
 * 检查=静态解析 HTML 标记比对目录（真实渲染 DOM 核查随 M6 执行器增强；manual 条目标 unverified 不静默）；
 * 定稿事务顺序按 F02-2 强制序（先置 finalized 再取定稿后快照追加基线）。
 * 基线 append-only：失效由查询时实时比对判定（LLD-4 §14），不写回。
 */

export interface GateIssue { code: string; message: string; target?: string | undefined }

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class PrototypeService {
  constructor(
    @Inject(DesignDocsService) private readonly docs: DesignDocsService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  onModuleInit(): void {
    // A05-6 生成：门禁 PLAN_REQUIRED/PLAN_STALE/PROTOTYPE_DIRTY/PROTOTYPE_FINALIZED；HTML+manifest 落库
    registerCommand('design.prototype.generate', async (client, payload, ctx) => {
      const { projectId, planId, planFingerprint } = payload as {
        projectId: string; planId: string; planFingerprint: string;
      };
      const issues = await this.gateIssues(client, projectId, 'generate');
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '原型生成门禁未通过', 'prototype', { issues });
      const plan = await client.query<{ id: string; plan_fingerprint: string; catalog_version: string }>(
        'SELECT * FROM dsg_plans WHERE id=$1 AND project_id=$2', [planId, projectId]);
      if (!plan.rows[0]) throw new DomainError('NOT_FOUND', '规划不存在', planId);
      if (plan.rows[0].plan_fingerprint !== planFingerprint.replace(/^sha256:/, '')) {
        throw new DomainError('VERSION_CONFLICT', '规划指纹不一致（存在并发变更）', planId);
      }
      const doc = await this.ensurePrototypeDoc(client, projectId, ctx);
      const items = await client.query<{ item_type: string; code: string; payload: Record<string, unknown>; required: boolean }>(
        'SELECT item_type, code, payload, required FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY item_type, code',
        [projectId, plan.rows[0].catalog_version],
      );
      const { html, manifest } = buildPrototype(items.rows);
      const max = await client.query<{ v: number | null }>(
        'SELECT max(version_no) AS v FROM dsg_versions WHERE document_id=$1', [doc.id]);
      const vno = (max.rows[0]?.v ?? 0) + 1;
      const manifestStr = JSON.stringify(manifest);
      const objectKey = `prototype/${projectId}/${doc.id}-v${vno}.html`;
      const contentFp = sha256(`${doc.id}:${sha256(html)}:${sha256(manifestStr)}`);
      const up = await this.docs.upstreamFingerprint(client, projectId, 'prd');
      const r = await client.query<{ id: string }>(
        `INSERT INTO dsg_versions (document_id, version_no, content, content_object_key, content_fingerprint, governing_fingerprint, refs, note, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'[]','原型生成（目录驱动 mock）',$7) RETURNING id`,
        [doc.id, vno, manifestStr, objectKey, contentFp, up.fingerprint ?? sha256('none'), ctx.actorId],
      );
      await client.query(
        'UPDATE dsg_documents SET current_version_id=$2, modified=false, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, r.rows[0]!.id, ctx.actorId],
      );
      // HTML 对象写在命令外不幂等（对象键内容寻址由 versionId 唯一性保证，此处同事务外不可行——记录 key 由服务层落对象）
      return { prototypeVersionId: r.rows[0]!.id, v: vno, objectKey, htmlBytes: html.length };
    });

    // A05-7 检查：门禁 CHECK 前置（PLAN_REQUIRED/PROTOTYPE_REQUIRED/PROTOTYPE_DIRTY）；报告 append-only
    registerCommand('design.prototype.check', async (client, payload, ctx) => {
      const { projectId, prototypeVersionId } = payload as { projectId: string; prototypeVersionId: string };
      const issues0 = await this.gateIssues(client, projectId, 'check');
      if (issues0.length > 0) throw new DomainError('GATE_BLOCKED', '原型检查门禁未通过', 'prototype', { issues: issues0 });
      const ver = await client.query<{ id: string; content: string; content_object_key: string | null }>(
        'SELECT * FROM dsg_versions WHERE id=$1', [prototypeVersionId]);
      if (!ver.rows[0]) throw new DomainError('NOT_FOUND', '原型版本不存在', prototypeVersionId);
      const catVer = await this.catalog.currentCatalogVersion(client, projectId);
      const items = await client.query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
        'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2',
        [projectId, catVer],
      );
      const html = ver.rows[0].content_object_key
        ? (await this.storage.getObject(ver.rows[0].content_object_key)).toString('utf8')
        : '';
      const { issues, unverified } = checkPrototype(html, items.rows);
      const run = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM dsg_prototype_checks WHERE project_id=$1', [projectId]);
      const catFp = fingerprint({ catalogVersion: catVer, items: items.rows.map((i) => i.code) });
      const r = await client.query<{ id: string }>(
        `INSERT INTO dsg_prototype_checks (project_id, run_no, catalog_fingerprint, prototype_version_id, issues, auto_fixable, unverified, passed, created_by)
         VALUES ($1,$2,$3,$4,$5,'[]',$6,$7,$8) RETURNING id`,
        [projectId, Number(run.rows[0]?.n ?? 0) + 1, catFp, prototypeVersionId,
          JSON.stringify(issues), JSON.stringify(unverified), issues.length === 0, ctx.actorId],
      );
      return { reportId: r.rows[0]!.id, status: issues.length === 0 ? 'pass' : 'fail', issues, unverified };
    });

    // A05-9 共同定稿（策略确认点 design.prototype.finalize；F02-2 强制事务顺序）
    registerCommand('design.prototype.finalize', async (client, payload, ctx) => {
      const { projectId, prototypeVersionId, checkReportId, confirm } = payload as {
        projectId: string; prototypeVersionId: string; checkReportId: string; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'design.prototype.finalize');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '原型定稿确认点为人工模式，AI 通道不可调用', 'design.prototype.finalize');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '共同定稿须人工确认（confirm:true）', 'confirm');
      const issues = await this.gateIssues(client, projectId, 'finalize');
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '原型定稿门禁未通过', 'prototype', { issues });
      // F02-2 强制序：报告存在且 pass + 报告被检版本=当前版本（CHECK_STALE 由门禁覆盖，此处兜底断言）
      const report = await client.query<{ passed: boolean; prototype_version_id: string }>(
        'SELECT passed, prototype_version_id FROM dsg_prototype_checks WHERE id=$1 AND project_id=$2 ORDER BY run_no DESC',
        [checkReportId, projectId]);
      if (!report.rows[0]?.passed || report.rows[0].prototype_version_id !== prototypeVersionId) {
        throw new DomainError('GATE_BLOCKED', '检查报告与当前原型版本不一致', 'prototype', { issues: [{ code: 'CHECK_STALE', message: '报告与版本不一致' }] });
      }
      const doc = await client.query<{ id: string; current_version_id: string | null; modified: boolean }>(
        "SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype' FOR UPDATE", [projectId]);
      const d = doc.rows[0]!;
      if (d.current_version_id !== prototypeVersionId) {
        throw new DomainError('GATE_BLOCKED', '原型内容在检查后已变化', 'prototype', { issues: [{ code: 'PROTOTYPE_DIRTY', message: '原型已修改' }] });
      }
      // ① 先置 finalized + finalizationId
      const finSeq = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM evd_records WHERE kind='finalize' AND payload->>'documentId'=$1", [d.id]);
      const finalizationId = `fin_${Number(finSeq.rows[0]?.n ?? 0) + 1}`;
      await client.query('UPDATE dsg_documents SET final_version_id=$2, updated_by=$3, updated_at=now() WHERE id=$1',
        [d.id, prototypeVersionId, ctx.actorId]);
      // ② 定稿后快照 → ③ 追加基线（工件版本组合+指纹，不复制内容）
      const items = await this.baselineItems(client, projectId, prototypeVersionId);
      const blFp = fingerprint({ items });
      const codeSeq = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM dsg_baselines WHERE project_id=$1', [projectId]);
      const code = `BL-${String(Number(codeSeq.rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
      const bl = await client.query<{ id: string }>(
        `INSERT INTO dsg_baselines (project_id, code, finalization_id, items, baseline_fingerprint, valid, confirmed_by)
         VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING id`,
        [projectId, code, finalizationId, JSON.stringify(items), blFp, ctx.actorId],
      );
      // ④ 证据行
      await appendEvidence(client, {
        projectId,
        kind: 'finalize',
        payload: { documentId: d.id, kind: 'prototype', finalizationId, baselineId: bl.rows[0]!.id, baselineFingerprint: blFp, by: ctx.actorId },
      });
      return { baselineId: bl.rows[0]!.id, code, fingerprint: `sha256:${blFp}`, finalizationId };
    });

    // S6（V1.3 上传通道）：人工上传 HTML 初稿入库为新版本（source 记 manual-upload；接受同一套对应性检查）
    registerCommand('design.prototype.upload', async (client, payload, ctx) => {
      const { projectId, html, note } = payload as { projectId: string; html: string; note?: string };
      if (!html?.trim()) throw new DomainError('VALIDATION_FAILED', '上传 HTML 内容为空', 'html');
      if (Buffer.byteLength(html, 'utf8') > 5 * 1024 * 1024) {
        throw new DomainError('VALIDATION_FAILED', 'HTML 初稿过大（>5MB）', 'html');
      }
      const doc = await this.ensurePrototypeDoc(client, projectId, ctx);
      const max = await client.query<{ v: number | null }>(
        'SELECT max(version_no) AS v FROM dsg_versions WHERE document_id=$1', [doc.id]);
      const vno = (max.rows[0]?.v ?? 0) + 1;
      const manifestStr = JSON.stringify({ generatedBy: 'manual-upload', note: note ?? null });
      const objectKey = `prototype/${projectId}/${doc.id}-v${vno}.html`;
      const contentFp = sha256(`${doc.id}:${sha256(html)}:${sha256(manifestStr)}`);
      const up = await this.docs.upstreamFingerprint(client, projectId, 'prd');
      const r = await client.query<{ id: string }>(
        `INSERT INTO dsg_versions (document_id, version_no, content, content_object_key, content_fingerprint, governing_fingerprint, refs, note, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'[]',$7,$8) RETURNING id`,
        [doc.id, vno, manifestStr, objectKey, contentFp, up.fingerprint ?? sha256('none'),
          `人工上传 HTML 初稿${note ? `：${note}` : ''}`, ctx.actorId],
      );
      await client.query(
        'UPDATE dsg_documents SET current_version_id=$2, modified=false, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, r.rows[0]!.id, ctx.actorId],
      );
      return { prototypeVersionId: r.rows[0]!.id, v: vno, objectKey };
    });
  }

  // ---------- 命令入口薄封装 ----------

  async generate(projectId: string, planId: string, planFingerprint: string, ctx: CommandContext) {
    const r = (await executeCommand('design.prototype.generate',
      { projectId, planId, planFingerprint }, { ...ctx, projectId })) as {
      prototypeVersionId: string; v: number; objectKey: string; htmlBytes: number;
    };
    // 命令登记版本后写 HTML 对象（catalog 版本行不可变 → 重建确定性一致；对象写失败残留版本指向缺失对象，预览端报错可见）
    await this.writePrototypeObject(projectId, planId, r.objectKey);
    return r;
  }

  async check(projectId: string, prototypeVersionId: string, ctx: CommandContext) {
    return executeCommand('design.prototype.check', { projectId, prototypeVersionId }, { ...ctx, projectId });
  }

  async finalize(projectId: string, prototypeVersionId: string, checkReportId: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('design.prototype.finalize', { projectId, prototypeVersionId, checkReportId, confirm }, { ...ctx, projectId });
  }

  /** S6 上传通道：登记版本（同事务）后写对象（与 generate 同序：先登记后落对象） */
  async upload(projectId: string, html: string, note: string | undefined, ctx: CommandContext) {
    const r = (await executeCommand('design.prototype.upload',
      { projectId, html, note }, { ...ctx, projectId })) as { prototypeVersionId: string; v: number; objectKey: string };
    await this.storage.putObject(r.objectKey, Buffer.from(html, 'utf8'));
    return r;
  }

  /** S7 原型版本列表（旧版预览弹窗数据源；finalized=当前定稿指针命中） */
  async versions(projectId: string) {
    const doc = await query<{ id: string; final_version_id: string | null }>(
      "SELECT id, final_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'", [projectId]);
    if (!doc.rows[0]) return { items: [] };
    const r = await query<{ id: string; version_no: number; note: string | null; created_at: string }>(
      'SELECT id, version_no, note, created_at FROM dsg_versions WHERE document_id=$1 ORDER BY version_no DESC',
      [doc.rows[0].id]);
    return {
      items: r.rows.map((x) => ({
        versionId: x.id, v: x.version_no, note: x.note, at: x.created_at,
        finalized: x.id === doc.rows[0]!.final_version_id,
      })),
    };
  }

  /** 生成命令内部产出 HTML——对象存储写入由命令返回 objectKey 后在此处完成（保证同事务登记先于对象写） */
  async writePrototypeObject(projectId: string, planId: string, objectKey: string): Promise<void> {
    const plan = await query<{ catalog_version: string }>('SELECT catalog_version FROM dsg_plans WHERE id=$1', [planId]);
    const items = await query<{ item_type: string; code: string; payload: Record<string, unknown>; required: boolean }>(
      'SELECT item_type, code, payload, required FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY item_type, code',
      [projectId, plan.rows[0]!.catalog_version],
    );
    const { html } = buildPrototype(items.rows);
    await this.storage.putObject(objectKey, Buffer.from(html, 'utf8'));
  }

  // ---------- 查询面 ----------

  /** 原型工作台状态（F02-2 状态派生：plan/plan-ready/generated/ready/finalized/stale） */
  async status(projectId: string): Promise<unknown> {
    const plan = await query<{ id: string; plan_fingerprint: string; governing_fingerprint: string; complete: boolean; catalog_version: string; created_at: string }>(
      'SELECT * FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
    const doc = await query<{ id: string; current_version_id: string | null; final_version_id: string | null; modified: boolean }>(
      "SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'", [projectId]);
    const checks = await query<{ id: string; run_no: number; passed: boolean; prototype_version_id: string; catalog_fingerprint: string; issues: unknown; unverified: unknown; created_at: string }>(
      'SELECT * FROM dsg_prototype_checks WHERE project_id=$1 ORDER BY run_no DESC LIMIT 1', [projectId]);
    const d = doc.rows[0];
    const latestPlan = plan.rows[0] ?? null;
    const latestCheck = checks.rows[0] ?? null;
    let status = 'idle';
    if (latestPlan) status = latestPlan.complete ? 'plan-ready' : 'failed';
    if (d?.current_version_id) status = 'generated';
    if (latestCheck && latestCheck.prototype_version_id === d?.current_version_id) {
      status = latestCheck.passed ? 'ready' : 'generated';
    }
    if (d?.final_version_id && d.final_version_id === d.current_version_id) status = 'finalized';
    // stale 退化（F02-2：不写状态，门禁实时比对）
    const up = await this.docs.upstreamFingerprint(null, projectId, 'prd');
    const planStale = latestPlan && up.ok && latestPlan.governing_fingerprint !== up.fingerprint;
    if (planStale && status !== 'idle') status = 'stale';
    return {
      status,
      plan: latestPlan && {
        planId: latestPlan.id, complete: latestPlan.complete,
        fingerprint: `sha256:${latestPlan.plan_fingerprint}`,
        catalogVersion: latestPlan.catalog_version,
        stale: !!planStale,
      },
      prototype: d && {
        docId: d.id, currentVersionId: d.current_version_id, finalized: status === 'finalized', modified: d.modified,
      },
      latestCheck: latestCheck && {
        reportId: latestCheck.id, runNo: latestCheck.run_no, passed: latestCheck.passed,
        prototypeVersionId: latestCheck.prototype_version_id,
        issues: latestCheck.issues, unverified: latestCheck.unverified,
      },
    };
  }

  /** A05-8 预览：签名 URL + 指纹（iframe 隔离由前端 sandbox 属性承载；独立子域为部署项）；v 指定版本号（S7 旧版预览） */
  async preview(projectId: string, pageId: string, v?: number): Promise<unknown> {
    const doc = await query<{ current_version_id: string | null }>(
      "SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'", [projectId]);
    if (!doc.rows[0]) throw new DomainError('NOT_FOUND', '原型尚未生成', pageId);
    let verId = doc.rows[0].current_version_id;
    if (v !== undefined) {
      const vv = await query<{ id: string }>(
        'SELECT id FROM dsg_versions WHERE document_id=(SELECT id FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2) AND version_no=$3',
        [projectId, 'prototype', v]);
      if (!vv.rows[0]) throw new DomainError('NOT_FOUND', '原型版本不存在', `v${v}`);
      verId = vv.rows[0].id;
    }
    if (!verId) throw new DomainError('NOT_FOUND', '原型尚未生成', pageId);
    const ver = await query<{ content_object_key: string | null; content_fingerprint: string }>(
      'SELECT * FROM dsg_versions WHERE id=$1', [verId]);
    if (!ver.rows[0]?.content_object_key) throw new DomainError('NOT_FOUND', '原型工件不存在', pageId);
    return {
      previewUrl: `${await this.storage.presignedGet(ver.rows[0].content_object_key)}#${encodeURIComponent(pageId)}`,
      htmlFingerprint: `sha256:${ver.rows[0].content_fingerprint}`,
      sandbox: { iframe: true, csp: "default-src 'none'" },
    };
  }

  /** A05-10 门禁求值（实时，不缓存） */
  async gates(projectId: string, action: 'generate' | 'check' | 'finalize' | 'develop'): Promise<unknown> {
    const issues = await this.gateIssues(null, projectId, action);
    return { ok: issues.length === 0, issues };
  }

  /** A05-11 基线查询（valid 实时比对，不写回 append-only 行） */
  async baselines(projectId: string): Promise<unknown> {
    const rows = await query<{
      id: string; code: string; items: Array<{ artifact: string; version_id: string; fingerprint: string }>;
      baseline_fingerprint: string; valid: boolean; confirmed_by: string; confirmed_at: string;
    }>('SELECT * FROM dsg_baselines WHERE project_id=$1 ORDER BY confirmed_at DESC', [projectId]);
    const items = await Promise.all(rows.rows.map(async (b) => {
      const live = await this.baselineItems(null, projectId, b.items.find((i) => i.artifact === 'PROTOTYPE')?.version_id ?? '');
      const liveFp = fingerprint({ items: live });
      const stale = liveFp !== b.baseline_fingerprint;
      return {
        baselineId: b.id, code: b.code, fingerprint: `sha256:${b.baseline_fingerprint}`,
        current: rows.rows[0]?.id === b.id,
        valid: b.valid && !stale,
        staleReason: stale ? '上游定稿或原型内容已变化（实时比对不符）' : null,
        confirmedBy: b.confirmed_by, confirmedAt: b.confirmed_at,
        items: b.items,
      };
    }));
    return { items };
  }

  // ---------- 内部 ----------

  /** 门禁实时求值（A05-10 issue code 闭集 §15(a)；develop 含 L0C_BELOW 逐条，§15(e)） */
  private async gateIssues(client: PoolClient | null, projectId: string, action: string): Promise<GateIssue[]> {
    const q = client ? client.query.bind(client) : query;
    const issues: GateIssue[] = [];
    const plan = await q<{ id: string; governing_fingerprint: string; complete: boolean }>(
      'SELECT * FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
    const latestPlan = plan.rows[0] ?? null;
    const doc = await q<{ id: string; current_version_id: string | null; final_version_id: string | null; modified: boolean }>(
      "SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'", [projectId]);
    const d = doc.rows[0] ?? null;

    if (action === 'generate') {
      if (!latestPlan) issues.push({ code: 'PLAN_REQUIRED', message: '尚无原型规划，先执行规划' });
      else if (!latestPlan.complete) issues.push({ code: 'PLAN_REQUIRED', message: '规划不完整' });
      if (latestPlan) {
        const up = await this.docs.upstreamFingerprint(client, projectId, 'prd');
        if (!up.ok || latestPlan.governing_fingerprint !== up.fingerprint) {
          issues.push({ code: 'PLAN_STALE', message: '规划依据（上游定稿）已变化，须重新规划' });
        }
      }
      if (d?.modified) issues.push({ code: 'PROTOTYPE_DIRTY', message: '原型已修改未定稿，先处理', target: d.id });
      if (d?.final_version_id && d.final_version_id === d.current_version_id) {
        issues.push({ code: 'PROTOTYPE_FINALIZED', message: '原型已定稿，重新生成须先解除定稿', target: d.id });
      }
    }
    if (action === 'check') {
      if (!latestPlan) issues.push({ code: 'PLAN_REQUIRED', message: '尚无原型规划' });
      if (!d?.current_version_id) issues.push({ code: 'PROTOTYPE_REQUIRED', message: '原型尚未生成' });
      if (d?.modified) issues.push({ code: 'PROTOTYPE_DIRTY', message: '原型已修改，须重新生成后再检查', target: d.id });
    }
    if (action === 'finalize') {
      if (!d?.current_version_id) issues.push({ code: 'PROTOTYPE_REQUIRED', message: '原型尚未生成' });
      const chk = await q<{ passed: boolean; prototype_version_id: string }>(
        'SELECT passed, prototype_version_id FROM dsg_prototype_checks WHERE project_id=$1 ORDER BY run_no DESC LIMIT 1',
        [projectId]);
      const latestCheck = chk.rows[0] ?? null;
      if (!latestCheck) issues.push({ code: 'CHECK_REQUIRED', message: '尚无检查报告' });
      else {
        if (!latestCheck.passed) issues.push({ code: 'CHECK_REQUIRED', message: '最近检查未通过', target: undefined });
        if (d && latestCheck.prototype_version_id !== d.current_version_id) {
          issues.push({ code: 'CHECK_STALE', message: '检查报告依据的原型版本已过期' });
        }
      }
      if (d?.modified) issues.push({ code: 'PROTOTYPE_DIRTY', message: '原型已修改未定稿', target: d.id });
    }
    if (action === 'develop') {
      // 基线有效 + RTM L0c=100%（REQ-310；复用 platform F06 实算）
      const bl = await this.baselines(projectId);
      const current = (bl as { items: Array<{ current: boolean; valid: boolean; code: string }> }).items.find((b) => b.current);
      if (!current) issues.push({ code: 'BASELINE_REQUIRED', message: '尚无设计基线' });
      else if (!current.valid) issues.push({ code: 'BASELINE_STALE', message: '共同设计基线已过期', target: current.code });
      const docsR = await q<{ doc_kind: string; content: string | null }>(
        `SELECT d.doc_kind, v.content FROM req_documents d
         LEFT JOIN req_versions v ON v.id=d.current_version_id WHERE d.project_id=$1`, [projectId]);
      const crd = docsR.rows.find((x) => x.doc_kind === 'crd')?.content ?? '';
      const prd = docsR.rows.find((x) => x.doc_kind === 'prd')?.content ?? '';
      const { nodes } = deriveLinks(crd, prd);
      const links = await q<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>(
        'SELECT from_kind, from_code, to_kind, to_code, relation FROM rtm_links WHERE project_id=$1', [projectId]);
      const h = computeHealth(nodes, links.rows);
      if (h.l0c < 1) {
        for (const g of h.gaps.filter((x) => x.code === 'L0C_BELOW')) {
          issues.push({ code: 'L0C_BELOW', message: `REQ→DSG 无承接锚点：${g.target}`, target: g.target });
        }
        if (h.gaps.every((x) => x.code !== 'L0C_BELOW')) {
          issues.push({ code: 'RTM_HEALTH', message: `L0c=${(h.l0c * 100).toFixed(1)}% < 100%` });
        }
      }
    }
    return issues;
  }

  /** 定稿/比对共用的基线工件清单（PRD/HLD/原型 当前定稿或当前版本指纹组合） */
  private async baselineItems(client: PoolClient | null, projectId: string, prototypeVersionId: string) {
    const q = client ? client.query.bind(client) : query;
    const items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null; required: boolean }> = [];
    const sources: Array<{ artifact: string; domain: 'req' | 'dsg'; kind: string; finalOnly: boolean }> = [
      { artifact: 'PRD', domain: 'req', kind: 'prd', finalOnly: true },
      { artifact: 'HLD', domain: 'dsg', kind: 'hld', finalOnly: false },
    ];
    for (const s of sources) {
      const table = s.domain === 'req' ? 'req_documents' : 'dsg_documents';
      const vtable = s.domain === 'req' ? 'req_versions' : 'dsg_versions';
      const r = await q<{ id: string; fp: string }>(
        `SELECT v.id, v.content_fingerprint AS fp FROM ${table} d
         JOIN ${vtable} v ON v.id = ${s.finalOnly ? 'd.final_version_id' : 'COALESCE(d.final_version_id, d.current_version_id)'}
         WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, s.kind]);
      items.push({
        artifact: s.artifact,
        version_id: r.rows[0]?.id ?? null,
        fingerprint: r.rows[0]?.fp ?? null,
        required: s.finalOnly,
      });
    }
    let protoFp: string | null = null;
    if (prototypeVersionId) {
      const r = await q<{ fp: string }>('SELECT content_fingerprint AS fp FROM dsg_versions WHERE id=$1', [prototypeVersionId]);
      protoFp = r.rows[0]?.fp ?? null;
    }
    items.push({ artifact: 'PROTOTYPE', version_id: prototypeVersionId || null, fingerprint: protoFp, required: true });
    return items;
  }

  /** 原型文档行（doc_kind='prototype'，首用时建） */
  private async ensurePrototypeDoc(client: PoolClient, projectId: string, ctx: CommandContext) {
    const r = await client.query<{ id: string }>(
      "SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype' FOR UPDATE", [projectId]);
    if (r.rows[0]) return r.rows[0];
    const ins = await client.query<{ id: string }>(
      `INSERT INTO dsg_documents (project_id, doc_kind, name, chapter_prefix, created_by)
       VALUES ($1,'prototype','客户原型','p',$2) RETURNING *`,
      [projectId, ctx.actorId],
    );
    return ins.rows[0]!;
  }
}

/** mock 原型生成：目录页面×状态 → 带 data-page/data-state 标记的 HTML（检查据此静态比对） */
function buildPrototype(items: Array<{ item_type: string; code: string; payload: Record<string, unknown> }>) {
  const pages = items.filter((i) => i.item_type === 'page');
  const states = items.filter((i) => i.item_type === 'state');
  const body = pages.map((p) => {
    const title = (p.payload.title as string) ?? p.code;
    const statesHtml = states.map((s) =>
      `    <section data-page="${p.code}" data-state="${s.code}"><h2>${title} · ${(s.payload.title as string) ?? s.code}</h2><p>（mock 原型内容，M6 真接后由 AI 生成完整交互）</p></section>`,
    ).join('\n');
    return `  <div data-page-block="${p.code}">\n${statesHtml}\n  </div>`;
  }).join('\n');
  // S3（DSG-U04-2）：选页选态协议——postMessage {type:'v19-prototype-select',pageId,stateId}
  // 与 location.hash（#pageId/stateId）双通道，切换不重载 iframe
  const navScript = `<script>
(function(){
  function show(pageId,stateId){
    document.querySelectorAll('[data-page-block]').forEach(function(b){b.style.display=b.getAttribute('data-page-block')===pageId?'':'none';});
    document.querySelectorAll('section[data-page]').forEach(function(s){
      s.style.display=(s.getAttribute('data-page')===pageId&&(!stateId||s.getAttribute('data-state')===stateId))?'':'none';
    });
  }
  window.prototypeNavigate=show;
  window.addEventListener('message',function(e){var d=e.data||{};if(d.type==='v19-prototype-select')show(d.pageId,d.stateId);});
  var h=(location.hash||'').replace(/^#/,'').split('/');
  if(h[0])show(decodeURIComponent(h[0]),h[1]?decodeURIComponent(h[1]):null);
})();
</script>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>客户原型（mock）</title>
<style>body{font:14px/1.6 sans-serif;margin:16px}nav{margin-bottom:12px}section{padding:8px 0}</style></head>
<body data-prototype="msf">
<nav>${pages.map((p) => `<a href="#${p.code}">${(p.payload.title as string) ?? p.code}</a>`).join(' | ')}</nav>
${body}
${navScript}
</body></html>`;
  const manifest = {
    pages: pages.map((p) => ({ code: p.code, title: (p.payload.title as string) ?? p.code })),
    states: states.map((s) => ({ code: s.code, title: (s.payload.title as string) ?? s.code })),
    generatedBy: 'mock',
  };
  return { html, manifest };
}

/** mock 检查：HTML 标记 vs 目录（缺失=issue；manual 条目=unverified 需人工，REQ-306/311） */
function checkPrototype(
  html: string,
  items: Array<{ item_type: string; code: string; payload: Record<string, unknown> }>,
): { issues: Array<{ code: string; message: string; target: string }>; unverified: Array<{ code: string; message: string; target: string }> } {
  const issues: Array<{ code: string; message: string; target: string }> = [];
  const unverified: Array<{ code: string; message: string; target: string }> = [];
  for (const it of items) {
    if (it.item_type === 'page' && !html.includes(`data-page-block="${it.code}"`)) {
      issues.push({ code: 'PAGE_MISSING', message: `页面 ${it.code} 未在原型中渲染`, target: it.code });
    }
    if (it.item_type === 'state') {
      for (const p of items.filter((x) => x.item_type === 'page')) {
        if (!html.includes(`data-page="${p.code}" data-state="${it.code}"`)) {
          issues.push({ code: 'STATE_MISSING', message: `页面 ${p.code} 缺状态 ${it.code}`, target: `${p.code}/${it.code}` });
        }
      }
    }
    if (it.payload.verify === 'manual') {
      unverified.push({ code: 'SOURCE_SEMANTIC_UNVERIFIED', message: `人工补充条目 ${it.code} 需人工核对`, target: it.code });
    }
  }
  return { issues, unverified };
}
