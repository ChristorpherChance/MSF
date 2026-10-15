import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { StorageService } from '../platform/storage.service.js';
import { deriveLinks, computeHealth } from '../platform/rtm-health.js';
import { designContents } from '../platform/doc-contents.js';
import { splitSections } from '../platform/doc-sections.js';
import { DesignDocsService } from './docs.service.js';
import { CatalogService } from './catalog.service.js';
import {
  classifyDataNavTarget,
  composePrototype,
  extractDataNavTargets,
  extractPageParts,
  parseFlowStepRef,
  UI_PAGE_SECTION_RE,
  type AssemblePageInput,
} from './prototype-pages.js';

/**
 * 原型四步流水（F02-2 状态机；A05-6/7/8/9/10/11；REQ-305~310）。
 * mock 口径：生成=目录驱动 HTML（data-page/data-state 标记）落 MinIO + manifest 入 dsg_versions；
 * 检查=静态解析 HTML 标记比对目录（真实渲染 DOM 核查随 M6 执行器增强；manual 条目标 unverified 不静默）；
 * 定稿事务顺序按 F02-2 强制序（先置 finalized 再取定稿后快照追加基线）。
 * 基线 append-only：失效由查询时实时比对判定（LLD-4 §14），不写回。
 */

export interface GateIssue { code: string; message: string; target?: string | undefined }

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** 预览签发 content-type 覆盖（HTML 对象上传未带 Content-Type，签名时覆盖使浏览器渲染，差异登记） */
const PROTO_HTML_CT = 'text/html; charset=utf-8';

@Injectable()
export class PrototypeService {
  constructor(
    @Inject(DesignDocsService) private readonly docs: DesignDocsService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PolicyService) private readonly policy: PolicyService,
  ) {}

  onModuleInit(): void {
    // A05-6 生成（汇总）：门禁 PLAN_REQUIRED/PLAN_STALE/PROTOTYPE_DIRTY/PROTOTYPE_FINALIZED；
    // HTML+manifest 由服务层命令外拼装（dsg_prototype_pages 工作工件 + 占位回落），命令只登记版本（upload 先例）
    registerCommand('design.prototype.generate', async (client, payload, ctx) => {
      const { projectId, planId, planFingerprint, html, manifest } = payload as {
        projectId: string; planId: string; planFingerprint: string;
        html: string; manifest: { pages?: Array<{ placeholder?: boolean }> };
      };
      const issues = await this.gateIssues(client, projectId, 'generate');
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '原型生成门禁未通过', 'prototype', { issues });
      const plan = await client.query<{ id: string; plan_fingerprint: string; catalog_version: string }>(
        'SELECT * FROM dsg_plans WHERE id=$1 AND project_id=$2', [planId, projectId]);
      if (!plan.rows[0]) throw new DomainError('NOT_FOUND', '规划不存在', planId);
      // #16：body 缺字段 → 400 而非 500
      if (typeof planFingerprint !== 'string' || !planFingerprint.trim()) {
        throw new DomainError('VALIDATION_FAILED', '规划指纹必填', 'planFingerprint');
      }
      if (plan.rows[0].plan_fingerprint !== planFingerprint.replace(/^sha256:/, '')) {
        throw new DomainError('VERSION_CONFLICT', '规划指纹不一致（存在并发变更）', planId);
      }
      if (typeof html !== 'string' || !html.trim()) {
        throw new DomainError('VALIDATION_FAILED', '汇总 HTML 必填', 'html');
      }
      const doc = await this.ensurePrototypeDoc(client, projectId, ctx);
      const max = await client.query<{ v: number | null }>(
        'SELECT max(version_no) AS v FROM dsg_versions WHERE document_id=$1', [doc.id]);
      const vno = (max.rows[0]?.v ?? 0) + 1;
      const manifestStr = JSON.stringify(manifest);
      const objectKey = `prototype/${projectId}/${doc.id}-v${vno}.html`;
      const contentFp = sha256(`${doc.id}:${sha256(html)}:${sha256(manifestStr)}`);
      const up = await this.docs.upstreamFingerprint(client, projectId, 'prd');
      const pageN = (manifest.pages ?? []).filter((p) => !p.placeholder).length;
      const phN = (manifest.pages ?? []).filter((p) => p.placeholder).length;
      const r = await client.query<{ id: string }>(
        `INSERT INTO dsg_versions (document_id, version_no, content, content_object_key, content_fingerprint, governing_fingerprint, refs, note, submitted_by)
         VALUES ($1,$2,$3,$4,$5,$6,'[]',$7,$8) RETURNING id`,
        [doc.id, vno, manifestStr, objectKey, contentFp, up.fingerprint ?? sha256('none'),
          `原型汇总（页原型 ${pageN} + 占位 ${phN}）`, ctx.actorId],
      );
      await client.query(
        'UPDATE dsg_documents SET current_version_id=$2, modified=false, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, r.rows[0]!.id, ctx.actorId],
      );
      // 汇总 HTML 对象写在命令外不幂等（对象键由 versionId 唯一性保证；服务层先登记后落对象）
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
      // 双向一致性输入（覆盖检测 §2）：refs+ui 册现行版本页面章节；全版无 ui refs=旧目录口径不检（判别式）
      const uiRefs = await client.query<{ code: string; section_id: string | null; anchor: string | null }>(
        `SELECT i.code, r.section_id, r.anchor FROM dsg_catalog_refs r
         JOIN dsg_catalog_items i ON i.id=r.item_id
         WHERE i.project_id=$1 AND i.catalog_version=$2 AND r.ref_kind='ui' AND i.item_type='page'`,
        [projectId, catVer]);
      const uiDoc = await client.query<{ content: string }>(
        `SELECT v.content FROM dsg_documents d JOIN dsg_versions v ON v.id=d.current_version_id
         WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
      const uiInput: UiConsistencyInput = {
        hasUiRefs: uiRefs.rows.length > 0,
        refsByCode: new Map(uiRefs.rows.map((x) => [x.code, { sectionId: x.section_id, anchor: x.anchor }])),
        uiPageSecs: splitSections(uiDoc.rows[0]?.content ?? '')
          .filter((s) => s.title && UI_PAGE_SECTION_RE.test(s.title))
          .map((s) => ({ id: s.id, title: s.title })),
      };
      const { issues, unverified } = checkPrototype(html, items.rows, uiInput);
      // I-1：时间基滞后并入报告（不拦 check）——滞后页与双向检出同报，用户据 UI_SECTION_UNMAPPED 判 re-plan。
      // S-1 终审修法：滞后判定传页行归属的 plan 锁定目录版本（页行 catalog_version 恒为 plan 锁定版——
      // 目录一经 add/remove/update-item 编辑 current≠plan，传 catVer 会让 pageUiLagIssues 内版本不等
      // 全 continue 空转，「报告与门禁两张皮」），与 status()/finalize 门禁单点同口径。
      const latestPlan = await client.query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
      for (const x of await this.pageUiLagIssues(client, projectId, latestPlan.rows[0]?.catalog_version ?? '')) {
        issues.push({ code: x.code, message: x.message, target: x.target ?? '' });
      }
      // W2-052：run_no 发号 count+1 属 check-then-act——咨询锁串行化「计数→插入」临界区
      await lockCodeGen(client, `msf:code:proto-check:${projectId}`);
      const run = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM dsg_prototype_checks WHERE project_id=$1', [projectId]);
      // S-2：目录指纹走 CatalogService 单点（code 基口径，finalize 门禁 CHECK_STALE 比对同源）
      const catFpNow = await this.catalog.currentCatalogFingerprint(client, projectId);
      const catFp = catFpNow?.fingerprint ?? fingerprint({ catalogVersion: catVer, items: [] });
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
      // ① 先置 finalized + finalizationId（W2-052：fin_ 发号按文档维度串行化）
      await lockCodeGen(client, `msf:code:fin:${d.id}`);
      const finSeq = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM evd_records WHERE kind='finalize' AND payload->>'documentId'=$1", [d.id]);
      const finalizationId = `fin_${Number(finSeq.rows[0]?.n ?? 0) + 1}`;
      await client.query('UPDATE dsg_documents SET final_version_id=$2, updated_by=$3, updated_at=now() WHERE id=$1',
        [d.id, prototypeVersionId, ctx.actorId]);
      // ② 定稿后快照 → ③ 追加基线（工件版本组合+指纹，不复制内容）
      const items = await this.baselineItems(client, projectId);
      const blFp = fingerprint({ items });
      // W2-052：BL- 发号与 dev.baseline.confirm 共用 dsg_baselines——同键串行（msf:code:baseline:<pid>）
      await lockCodeGen(client, `msf:code:baseline:${projectId}`);
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

    // W7-003 原型解除定稿（spec：⋯ 菜单「解锁定稿」；此前 generate 门禁提示「须先解除定稿」但无任何解锁通道，
    // 定稿后永远无法再生成，迭代循环断裂）。解锁后 final_version_id 落空 → 基线条目实时比对失效（不写回），
    // 下游 develop 门禁随之拦住，与 design.doc.unlock 同口径。
    registerCommand('design.prototype.unlock', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      const r = await client.query<{ id: string; final_version_id: string | null }>(
        "SELECT id, final_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype' FOR UPDATE",
        [projectId]);
      const doc = r.rows[0];
      if (!doc) throw new DomainError('NOT_FOUND', '原型尚未生成', 'prototype');
      if (!doc.final_version_id) throw new DomainError('INVALID_STATE', '原型未定稿', doc.id);
      await client.query('UPDATE dsg_documents SET final_version_id=NULL, updated_by=$2, updated_at=now() WHERE id=$1',
        [doc.id, ctx.actorId]);
      return { unlocked: true };
    });
  }

  // ---------- 命令入口薄封装 ----------

  /**
   * 汇总生成：命令外拼装（plan 目录条目 + dsg_prototype_pages 工作工件 + 占位回落）→ 命令登记版本 → 落对象。
   * 竞态说明：汇总读页行期间某页刚好完成 → 本次 manifest 漏它，无数据损坏——check/finalize 门禁的
   * 页滞后实时比对会亮 PROTOTYPE_DIRTY 提示重新汇总。
   */
  async generate(projectId: string, planId: string, planFingerprint: string, ctx: CommandContext) {
    const plan = await query<{ catalog_version: string }>('SELECT catalog_version FROM dsg_plans WHERE id=$1', [planId]);
    if (!plan.rows[0]) throw new DomainError('NOT_FOUND', '规划不存在', planId);
    const catalogVersion = plan.rows[0].catalog_version;
    const items = await query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
      'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY item_type, code',
      [projectId, catalogVersion],
    );
    // 仅汇总与当前 plan 同目录版本的页工件（旧目录版本生成的页视为未生成，占位回落）
    const rows = await query<{ page_code: string; object_key: string; html_fingerprint: string; source: string }>(
      'SELECT page_code, object_key, html_fingerprint, source FROM dsg_prototype_pages WHERE project_id=$1 AND catalog_version=$2',
      [projectId, catalogVersion],
    );
    const warnings: string[] = [];
    const assembled: AssemblePageInput[] = [];
    for (const r of rows.rows) {
      try {
        const html = (await this.storage.getObject(r.object_key)).toString('utf8');
        const parts = extractPageParts(html);
        if (!parts) { warnings.push(`页面 ${r.page_code} 工件缺封装标记，已回落占位`); continue; }
        assembled.push({ code: r.page_code, parts, objectKey: r.object_key, fingerprint: r.html_fingerprint, source: r.source });
      } catch {
        // 页行存在但对象缺失（历史 putObject 失败残留）：回落占位不阻断汇总
        warnings.push(`页面 ${r.page_code} 工件对象缺失，已回落占位`);
      }
    }
    const { html, manifest } = composePrototype(items.rows, assembled, warnings);
    const r = (await executeCommand('design.prototype.generate',
      { projectId, planId, planFingerprint, html, manifest }, { ...ctx, projectId })) as {
      prototypeVersionId: string; v: number; objectKey: string; htmlBytes: number;
    };
    // 先登记后落对象（对象写失败残留版本指向缺失对象，预览端报错可见）
    await this.storage.putObject(r.objectKey, Buffer.from(html, 'utf8'));
    return r;
  }

  async check(projectId: string, prototypeVersionId: string, ctx: CommandContext) {
    return executeCommand('design.prototype.check', { projectId, prototypeVersionId }, { ...ctx, projectId });
  }

  async finalize(projectId: string, prototypeVersionId: string, checkReportId: string, confirm: boolean, ctx: CommandContext) {
    return executeCommand('design.prototype.finalize', { projectId, prototypeVersionId, checkReportId, confirm }, { ...ctx, projectId });
  }

  /** W7-003 原型解除定稿（人工操作，命令留痕） */
  async unlock(projectId: string, ctx: CommandContext) {
    return executeCommand('design.prototype.unlock', { projectId }, { ...ctx, projectId });
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
    // 页级原型工作态（差异登记）：none=未生成 / pending=已生成待汇总 / assembled=已入当前汇总版本
    let pages: Array<{
      code: string; title: string; state: 'none' | 'pending' | 'assembled'; source?: string;
      reqIds: string[]; uiRef: { sectionId: string | null; anchor: string | null } | null; uiStale: boolean;
    }> = [];
    if (latestPlan) {
      const pageItems = await query<{ code: string; payload: Record<string, unknown> }>(
        "SELECT code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 AND item_type='page' ORDER BY code",
        [projectId, latestPlan.catalog_version]);
      const rows = await query<{ page_code: string; html_fingerprint: string; source: string; updated_at: string }>(
        'SELECT page_code, html_fingerprint, source, updated_at FROM dsg_prototype_pages WHERE project_id=$1 AND catalog_version=$2',
        [projectId, latestPlan.catalog_version]);
      // 时间基滞后（覆盖检测 §2 C1 修法）：页 updated_at < 其依据 ui 册当前版本 submitted_at → 「依据已变更」；
      // 页重生成 updated_at 刷新即自动解脏（upstream-stale.ts 先例，零新增快照列）。
      // M-3：与 pageUiLagIssues 是同一条判定规则（两处互指，改须同步）
      const uiRefs = await query<{ code: string; section_id: string | null; anchor: string | null }>(
        `SELECT i.code, r.section_id, r.anchor FROM dsg_catalog_refs r
         JOIN dsg_catalog_items i ON i.id=r.item_id
         WHERE i.project_id=$1 AND i.catalog_version=$2 AND r.ref_kind='ui' AND i.item_type='page'`,
        [projectId, latestPlan.catalog_version]);
      const uiRefByCode = new Map(uiRefs.rows.map((x) => [x.code, { sectionId: x.section_id, anchor: x.anchor }]));
      const uiCur = await query<{ at: string }>(
        `SELECT v.submitted_at AS at FROM dsg_documents d JOIN dsg_versions v ON v.id=d.current_version_id
         WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
      const uiAt = uiCur.rows[0]?.at ?? null;
      const recorded = d?.current_version_id ? await this.manifestFingerprints(null, d.current_version_id) : new Map<string, string>();
      pages = pageItems.rows.map((pi) => {
        const row = rows.rows.find((r) => r.page_code === pi.code);
        const title = (pi.payload.title as string) ?? pi.code;
        const reqIds = (pi.payload.reqIds as string[] | undefined) ?? [];
        const uiRef = uiRefByCode.get(pi.code) ?? null;
        const uiStale = !!(uiRef && row && uiAt && new Date(row.updated_at) < new Date(uiAt));
        if (!row) return { code: pi.code, title, state: 'none' as const, reqIds, uiRef, uiStale: false };
        return {
          code: pi.code, title, source: row.source, reqIds, uiRef, uiStale,
          state: (recorded.get(pi.code) === row.html_fingerprint ? 'assembled' : 'pending') as 'assembled' | 'pending',
        };
      });
    }
    const pagesStale = pages.some((p) => p.state === 'pending');
    const uiStalePages = pages.filter((p) => p.uiStale).map((p) => p.code);
    return {
      status,
      pages,
      pagesStale,
      uiStalePages,
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

  /** A05-8 预览：页级工作工件优先（最新生成含未汇总，内容寻址直签）→ 汇总版本整份+#hash 回落；v 指定旧版（S7） */
  async preview(projectId: string, pageId: string, v?: number): Promise<unknown> {
    // 单页分流：最新 plan 目录版本下有页工件 → 直签单页对象（不带 hash；生成契约含同一套选态协议）
    if (v === undefined) {
      const plan = await query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
      if (plan.rows[0]) {
        const row = await query<{ object_key: string; html_fingerprint: string }>(
          'SELECT object_key, html_fingerprint FROM dsg_prototype_pages WHERE project_id=$1 AND page_code=$2 AND catalog_version=$3',
          [projectId, pageId, plan.rows[0].catalog_version]);
        if (row.rows[0]) {
          return {
            previewUrl: await this.storage.presignedGet(row.rows[0].object_key, 300, undefined, PROTO_HTML_CT),
            htmlFingerprint: `sha256:${row.rows[0].html_fingerprint}`,
            sandbox: { iframe: true, csp: "default-src 'none'" },
          };
        }
      }
    }
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
      previewUrl: `${await this.storage.presignedGet(ver.rows[0].content_object_key, 300, undefined, PROTO_HTML_CT)}#${encodeURIComponent(pageId)}`,
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
      const live = await this.baselineItems(null, projectId);
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
    const plan = await q<{ id: string; governing_fingerprint: string; complete: boolean; catalog_version: string }>(
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
      // 页滞后实时比对（页重生成不产生新版本，CHECK_STALE 抓不到——纯 DB 比对，复用 PROTOTYPE_DIRTY）。
      // I-1：时间基滞后（pageUiLagIssues）对 check 不拦——降级为 check 报告内 issue（见该命令处并入）；
      // 此处只推硬漂移（指纹/目录版本）。
      if (latestPlan && d?.current_version_id) {
        issues.push(...await this.pageDriftIssues(client, projectId, latestPlan.catalog_version, d.current_version_id));
      }
    }
    if (action === 'finalize') {
      if (!d?.current_version_id) issues.push({ code: 'PROTOTYPE_REQUIRED', message: '原型尚未生成' });
      const chk = await q<{ passed: boolean; prototype_version_id: string; catalog_fingerprint: string }>(
        'SELECT passed, prototype_version_id, catalog_fingerprint FROM dsg_prototype_checks WHERE project_id=$1 ORDER BY run_no DESC LIMIT 1',
        [projectId]);
      const latestCheck = chk.rows[0] ?? null;
      if (!latestCheck) issues.push({ code: 'CHECK_REQUIRED', message: '尚无检查报告' });
      else {
        if (!latestCheck.passed) issues.push({ code: 'CHECK_REQUIRED', message: '最近检查未通过', target: undefined });
        if (d && latestCheck.prototype_version_id !== d.current_version_id) {
          issues.push({ code: 'CHECK_STALE', message: '检查报告依据的原型版本已过期' });
        }
        // S-2 终审修法：目录编辑（add/remove/update-item 即产新目录版本）后最近报告目录指纹失配 →
        // CHECK_STALE 强制重跑 check（flow 引用等新校验必须覆盖最新目录，堵「改后不重跑直接定稿」）。
        // 指纹 code 基口径（catalogFingerprintOf 单点）——条目 id 随目录版本轮换不稳定。
        const catNow = await this.catalog.currentCatalogFingerprint(client, projectId);
        if (catNow && latestCheck.catalog_fingerprint !== catNow.fingerprint) {
          issues.push({ code: 'CHECK_STALE', message: '目录在最近检查后已经编辑（新目录版本），须重新执行检查' });
        }
      }
      if (d?.modified) issues.push({ code: 'PROTOTYPE_DIRTY', message: '原型已修改未定稿', target: d.id });
      // 页滞后实时比对（定稿一个滞后汇总会冻结错误基线，必须拦）。
      // I-1：finalize 保留时间基滞后硬门禁（pageUiLagIssues 并列；check 动作已降级为报告内 issue）。
      if (latestPlan && d?.current_version_id) {
        issues.push(...await this.pageDriftIssues(client, projectId, latestPlan.catalog_version, d.current_version_id));
        issues.push(...await this.pageUiLagIssues(client, projectId, latestPlan.catalog_version));
      }
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
      const { nodes } = deriveLinks(crd, prd, await designContents(null, projectId));
      const links = await q<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>(
        'SELECT from_kind, from_code, to_kind, to_code, relation FROM rtm_links WHERE project_id=$1', [projectId]);
      const h = computeHealth(nodes, links.rows);
      if (h.l0c < 1) {
        for (const g of h.gaps.filter((x) => x.code === 'L0C_BELOW')) {
          issues.push({ code: 'L0C_BELOW', message: g.message, target: g.target });
        }
        if (h.gaps.every((x) => x.code !== 'L0C_BELOW')) {
          issues.push({ code: 'RTM_HEALTH', message: `L0c=${(h.l0c * 100).toFixed(1)}% < 100%` });
        }
      }
    }
    return issues;
  }

  /** 汇总版本 manifest 记录的页指纹（code → fingerprint；无 manifest/无页字段回落空 Map） */
  private async manifestFingerprints(
    client: PoolClient | null,
    versionId: string,
  ): Promise<Map<string, string>> {
    const q = client ? client.query.bind(client) : query;
    const ver = await q<{ content: string }>('SELECT content FROM dsg_versions WHERE id=$1', [versionId]);
    try {
      const manifest = JSON.parse(ver.rows[0]?.content ?? '{}') as {
        pages?: Array<{ code: string; fingerprint?: string }>;
      };
      return new Map((manifest.pages ?? []).filter((p) => p.fingerprint).map((p) => [p.code, p.fingerprint!]));
    } catch {
      return new Map();
    }
  }

  /**
   * 页滞后实时比对·硬门禁部分（F02-2 失效由查询时判定、不写回 的同口径；纯 DB，不读 MinIO）：
   * 页行指纹 ≠ 当前汇总版本 manifest 记录 → 页已更新未汇总；页行 catalog_version ≠ plan 锁定版本 → 依据已过期。
   * 时间基滞后不在这里——见 pageUiLagIssues（I-1：对 check 降级为报告内 issue，仅 finalize 硬门禁）。
   */
  private async pageDriftIssues(
    client: PoolClient | null,
    projectId: string,
    planCatalogVersion: string,
    currentVersionId: string,
  ): Promise<GateIssue[]> {
    const q = client ? client.query.bind(client) : query;
    const recorded = await this.manifestFingerprints(client, currentVersionId);
    const rows = await q<{ page_code: string; html_fingerprint: string; catalog_version: string }>(
      'SELECT page_code, html_fingerprint, catalog_version FROM dsg_prototype_pages WHERE project_id=$1',
      [projectId]);
    const issues: GateIssue[] = [];
    for (const r of rows.rows) {
      if (r.catalog_version !== planCatalogVersion) {
        issues.push({ code: 'PROTOTYPE_DIRTY', message: `页面 ${r.page_code} 原型依据的目录版本已过期，须重新生成并汇总`, target: r.page_code });
      } else if (recorded.get(r.page_code) !== r.html_fingerprint) {
        issues.push({ code: 'PROTOTYPE_DIRTY', message: `页面 ${r.page_code} 原型已更新未汇总，须重新汇总生成`, target: r.page_code });
      }
    }
    return issues;
  }

  /**
   * 时间基滞后（覆盖检测 §2 C1 修法）：页 updated_at < 其依据 ui 册当前版本 submitted_at → 滞后，
   * 页重生成 updated_at 刷新即自动解脏（upstream-stale.ts 先例，零新增快照列）。
   * M-3：判定规则与 status() 的 uiStale/uiStalePages 派生是同一条（两处互指，改须同步）。
   * I-1 评审修法：check 动作降级为报告内 issue（PROTOTYPE_DIRTY 出报告但不 GATE_BLOCKED 拦截——
   * ui 册变更后用户能先跑出 check 报告看到 UI_SECTION_UNMAPPED 这类「该 re-plan」的信号，
   * 而非被逼先烧 N 次页重生成）；finalize 保留硬门禁（定稿冻结错误基线必须拦）。
   */
  private async pageUiLagIssues(
    client: PoolClient | null,
    projectId: string,
    planCatalogVersion: string,
  ): Promise<GateIssue[]> {
    const q = client ? client.query.bind(client) : query;
    // 仅本目录版本且有 ui ref 的页参与（旧目录无 ui refs 不适用，判别式同双向检查）
    const uiRefs = await q<{ code: string; anchor: string | null }>(
      `SELECT i.code, r.anchor FROM dsg_catalog_refs r
       JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version=$2 AND r.ref_kind='ui' AND i.item_type='page'`,
      [projectId, planCatalogVersion]);
    if (uiRefs.rows.length === 0) return [];
    const uiCur = await q<{ at: string }>(
      `SELECT v.submitted_at AS at FROM dsg_documents d JOIN dsg_versions v ON v.id=d.current_version_id
       WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
    const uiAt = uiCur.rows[0]?.at ?? null;
    if (!uiAt) return [];
    const anchorByCode = new Map(uiRefs.rows.map((x) => [x.code, x.anchor]));
    const rows = await q<{ page_code: string; catalog_version: string; updated_at: string }>(
      'SELECT page_code, catalog_version, updated_at FROM dsg_prototype_pages WHERE project_id=$1',
      [projectId]);
    const issues: GateIssue[] = [];
    for (const r of rows.rows) {
      if (r.catalog_version !== planCatalogVersion) continue; // 目录版本过期由 pageDriftIssues 硬门禁单独报
      const anchor = anchorByCode.get(r.page_code);
      if (anchor === undefined) continue;
      if (new Date(r.updated_at) < new Date(uiAt)) {
        issues.push({ code: 'PROTOTYPE_DIRTY', message: `页面 ${r.page_code} 依据的 ui 册「${anchor ?? ''}」已变更（ui 册有新提交），须重新生成该页`, target: r.page_code });
      }
    }
    return issues;
  }

  /** 定稿/比对共用的基线工件清单（PRD/HLD/原型 三工件均 finalOnly——任一解锁即基线实时失效） */
  private async baselineItems(client: PoolClient | null, projectId: string) {
    const q = client ? client.query.bind(client) : query;
    const items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null; required: boolean }> = [];
    // W3-005：HLD 同取 final_version_id（finalOnly）——基线工件须为定稿态；解锁后 final 丢失 →
    // 条目 version/fingerprint 落空 → 实时比对失效（此前 COALESCE 回退 current 掩盖解锁态，与解锁 modal 承诺不符）。
    // 注：required 标志独立于 finalOnly（HLD required:false 为既有口径，改它会 invalidate 全部存量基线指纹）
    // W7-003：PROTOTYPE 同改 finalOnly——此前按「基线行内冻结版本 id」取指纹，原型解锁后基线仍假性有效，
    // 与 spec「原型 UI 已解锁，旧开发依据立即失效」及 dev 域 gate-common liveBaselineItems 口径冲突。
    const sources: Array<{ artifact: string; domain: 'req' | 'dsg'; kind: string; required: boolean }> = [
      { artifact: 'PRD', domain: 'req', kind: 'prd', required: true },
      { artifact: 'HLD', domain: 'dsg', kind: 'hld', required: false },
      { artifact: 'PROTOTYPE', domain: 'dsg', kind: 'prototype', required: true },
    ];
    for (const s of sources) {
      const table = s.domain === 'req' ? 'req_documents' : 'dsg_documents';
      const vtable = s.domain === 'req' ? 'req_versions' : 'dsg_versions';
      const r = await q<{ id: string; fp: string }>(
        `SELECT v.id, v.content_fingerprint AS fp FROM ${table} d
         JOIN ${vtable} v ON v.id = d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, s.kind]);
      items.push({
        artifact: s.artifact,
        version_id: r.rows[0]?.id ?? null,
        fingerprint: r.rows[0]?.fp ?? null,
        required: s.required,
      });
    }
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

/** mock 原型生成已退役：页级生成见 prototype-pages.ts（buildMockPage），汇总拼装见 composePrototype */

/**
 * 双向一致性输入（覆盖检测 §2；issue 码 UI_SECTION_UNMAPPED/PAGE_UI_UNMAPPED 只进
 * dsg_prototype_checks.issues jsonb，同 PAGE_MISSING/STATE_MISSING 先例，不入 DomainError 闭集）。
 * 新旧目录判别式：hasUiRefs=false（该目录版本无任何 ref_kind='ui' 行）→ 双向检查整体不检。
 */
export interface UiConsistencyInput {
  hasUiRefs: boolean;
  /** 页码 → ui 册章节引用快照（plan 时写入） */
  refsByCode: Map<string, { sectionId: string | null; anchor: string | null }>;
  /** ui 册现行版本的「页面/界面」章节 */
  uiPageSecs: Array<{ id: string; title: string }>;
}

/**
 * 对应性检查：HTML 标记 vs 目录（缺失=issue；manual 条目=unverified 需人工，REQ-306/311）。
 * 汇总产物（composePrototype）与人工上传共用本函数；页级单元测试复用，故导出。
 * 注意：`data-page="X" data-state="Y"` 为定序 includes 匹配——生成契约钉死属性序。
 * 覆盖检测 §3：data-nav 目标存在性（DATA_NAV_TARGET_MISSING）+ flow 引用页面/状态存在性
 * （FLOW_REF_MISSING）——issue 码只进 dsg_prototype_checks.issues jsonb（PAGE_MISSING/STATE_MISSING
 * 先例），不入 DomainError/GateIssue 闭集。兼容口径（I3）：旧版汇总无 data-nav 自然零命中；
 * 旧格式 flow steps（REQ 章节标题字符串）不匹配引用模式按「未声明引用」不校验。
 */
export function checkPrototype(
  html: string,
  items: Array<{ item_type: string; code: string; payload: Record<string, unknown> }>,
  ui?: UiConsistencyInput,
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
  // 双向一致性（覆盖检测 §2）：仅当本目录版本存在 ref_kind='ui' 行时检（refs 未声明≠缺失）
  if (ui?.hasUiRefs) {
    const pageItems = items.filter((i) => i.item_type === 'page');
    // 册有页无：ui 册页面章节无目录页承接。匹配键=锚点标题（splitSections 的节 id 是位置序，
    // 册内增删节后新章节会继承旧节 id——按 id 匹配会把「新章节」误判成「已被旧 ref 承接」）。
    // M-6 同名章节 edge：ui 册两个页面章节同名时，一个 ref 命中即两者都算被承接（保守不重复报；
    // 同名章节本就应合并，属源文档质量问题而非对应缺口）
    for (const sec of ui.uiPageSecs) {
      const covered = pageItems.some((p) => ui.refsByCode.get(p.code)?.anchor === sec.title);
      if (!covered) {
        issues.push({ code: 'UI_SECTION_UNMAPPED', message: `ui 册页面章节「${sec.title}」无对应目录页（重新识别规划或人工补充条目）`, target: sec.title });
      }
    }
    // 页有册无：目录页无 ui ref 且未人工豁免（payload.exempt，设置通道=design.catalog.update-item）
    for (const p of pageItems) {
      if (ui.refsByCode.has(p.code) || p.payload.exempt === true) continue;
      issues.push({ code: 'PAGE_UI_UNMAPPED', message: `目录页 ${p.code} 无 ui 册章节承接（骨架/通用页可人工豁免）`, target: p.code });
    }
  }
  // 覆盖检测 §3：data-nav 目标存在性（旧版汇总无 data-nav 自然零命中——旧产物永久可预览不受新校验影响）。
  // T7 Minor：与 findDataNavProblem 共用 classifyDataNavTarget 分类器（防单边漂移）；check 收全部，页级校验取首条。
  const pageCodes = new Set(items.filter((i) => i.item_type === 'page').map((i) => i.code));
  const stateCodes = new Set(items.filter((i) => i.item_type === 'state').map((i) => i.code));
  for (const raw of extractDataNavTargets(html)) {
    const verdict = classifyDataNavTarget(raw, pageCodes, stateCodes);
    if (verdict === 'ok') continue;
    if (verdict === 'bad-format') {
      issues.push({ code: 'DATA_NAV_TARGET_MISSING', message: `原型内 data-nav 属性格式非法（须 "#页码" 或 "#页码/状态"）：${raw}`, target: raw });
    } else {
      issues.push({ code: 'DATA_NAV_TARGET_MISSING', message: `原型内 data-nav 目标「${raw}」不在目录页面/状态集内`, target: raw });
    }
  }
  // 覆盖检测 §3：flow 引用页面/状态存在性。旧格式 steps（REQ 章节标题字符串）不匹配引用模式 →
  // 按「未声明引用」不校验（兼容口径 I3）；新格式步骤（P-xxx[/ST-xxx]）逐条校验。
  for (const f of items.filter((i) => i.item_type === 'flow')) {
    const steps = (f.payload.steps as string[] | undefined) ?? [];
    for (const s of steps) {
      const ref = parseFlowStepRef(s);
      if (!ref) continue;
      if (!pageCodes.has(ref.page)) {
        issues.push({ code: 'FLOW_REF_MISSING', message: `流程 ${f.code} 步骤「${s}」引用的页面 ${ref.page} 不存在（编辑流程步骤或重新规划）`, target: f.code });
      } else if (ref.state && !stateCodes.has(ref.state)) {
        issues.push({ code: 'FLOW_REF_MISSING', message: `流程 ${f.code} 步骤「${s}」引用的状态 ${ref.state} 不存在（编辑流程步骤或重新规划）`, target: f.code });
      }
    }
  }
  return { issues, unverified };
}
