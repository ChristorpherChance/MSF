import { Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { applyPatch, joinSections, sha256Text, splitSections, type EditPatch } from '../platform/doc-sections.js';
import { designBooksStale } from '../platform/upstream-stale.js';

/**
 * 设计文档八册生命周期（F02-1 同构复用，任务分解 M3 注①/③；REQ-301/302/209/210）。
 * 与需求域差异：doc_kind 八册（hld/mod/alg/cls/db/api/ui/nfr，章节前缀 h/o/g/k/d/a/u/n）；
 * 定稿不在 7 确认点内——人工 confirm + 未决评审项二次确认（allowOpenReviews，仍要定稿记审计）；
 * 无 RTM 派生/健康度门禁（RTM 锚点在需求域文档内容中，M2 已实算）。
 */

const UNDO_LIMIT = 30;

/** 册定义（A05-1：概要 h + 详细 o/g/k/d/a/u/n） */
export const DESIGN_BOOKS = [
  { kind: 'hld', prefix: 'h', name: '概要设计说明书' },
  { kind: 'mod', prefix: 'o', name: '模块设计' },
  { kind: 'alg', prefix: 'g', name: '算法与流程' },
  { kind: 'cls', prefix: 'k', name: '类与数据结构' },
  { kind: 'db', prefix: 'd', name: '数据库设计' },
  { kind: 'api', prefix: 'a', name: 'API 接口' },
  { kind: 'ui', prefix: 'u', name: 'UI 设计' },
  { kind: 'nfr', prefix: 'n', name: '非功能规则' },
] as const;

export type DesignKind = (typeof DESIGN_BOOKS)[number]['kind'];

const TEMPLATE = (name: string, prefix: string) =>
  `# ${name}\n\n（待生成：上游定稿后由 AI 生成初稿，或直接编辑。章节前缀 ${prefix}-*）`;

interface DocRow {
  id: string;
  project_id: string;
  doc_kind: string;
  current_version_id: string | null;
  final_version_id: string | null;
  modified: boolean;
  gen_state: string;
  lock_owner: string | null;
}

interface VersionRow {
  id: string;
  version_no: number;
  content: string;
  content_fingerprint: string;
  submitted_by: string;
  submitted_at: string;
  note: string | null;
}

interface DraftRow {
  id: string;
  base_version_id: string;
  base_content_fingerprint: string;
  content: string;
  undo_stack: string[];
  redo_stack: string[];
}

@Injectable()
export class DesignDocsService {
  onModuleInit(): void {
    registerCommand('design.doc.import-draft', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: DesignKind };
      const doc = await this.ensureDoc(client, projectId, kind, ctx);
      const book = DESIGN_BOOKS.find((b) => b.kind === kind)!;
      const v = await this.appendVersion(client, doc, TEMPLATE(book.name, book.prefix), '初始模板', ctx);
      await client.query(
        'UPDATE dsg_documents SET current_version_id=$2, modified=false, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, v.id, ctx.actorId],
      );
      return { docId: doc.id, v: v.version_no };
    });

    registerCommand('design.doc.save-html', async (client, payload, ctx) => {
      const { projectId, kind, secId, md, baseVersion, baseFingerprint } = payload as {
        projectId: string; kind: DesignKind; secId: string; md: string;
        baseVersion: number; baseFingerprint: string;
      };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      const effective = draft?.content ?? cur?.content ?? '';
      this.assertLock(baseVersion, baseFingerprint, cur, effective);
      const secs = splitSections(effective);
      const si = secs.findIndex((s) => s.id === secId);
      if (si < 0) throw new DomainError('NOT_FOUND', '章节不存在', secId);
      // W2-026 防呆（与 req 域同口径）：非文首节保存的内容不得携带节标题，防重切分出重复章节
      if (si > 0 && /^#{2,6}\s/m.test(md)) {
        throw new DomainError('VALIDATION_FAILED', '单节保存的内容不得包含章节标题（## 及更深）；请逐节编辑提交', secId);
      }
      const next = secs.map((s, i) => (i === si ? { ...s, md } : s));
      const content = joinSections(next);
      if (content === effective) throw new DomainError('NO_CHANGE', '内容无变化', secId);
      await this.writeDraft(client, doc, cur, draft, content, ctx);
      await this.assertInvariants(client, doc.id);
      return { modified: true, contentFingerprint: `sha256:${sha256Text(content)}` };
    });

    registerCommand('design.doc.undo', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: DesignKind };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const draft = await this.requireDraft(client, doc.id);
      const undo = [...draft.undo_stack];
      const top = undo.pop();
      if (top === undefined) throw new DomainError('UNDO_STACK_EMPTY', 'undo 栈为空', doc.id);
      if (top === draft.content) throw new DomainError('NO_CHANGE', '栈顶与当前内容相同', doc.id);
      const cur = await this.currentVersion(client, doc);
      const redo = [...draft.redo_stack, draft.content].slice(-UNDO_LIMIT);
      if (undo.length === 0 && cur && top === cur.content) {
        await client.query('DELETE FROM dsg_drafts WHERE id=$1', [draft.id]);
        await client.query('UPDATE dsg_documents SET modified=false, updated_at=now() WHERE id=$1', [doc.id]);
        await this.assertInvariants(client, doc.id);
        return { canUndo: false, canRedo: true };
      }
      await client.query('UPDATE dsg_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_at=now() WHERE id=$1',
        [draft.id, top, JSON.stringify(undo), JSON.stringify(redo)]);
      await this.assertInvariants(client, doc.id);
      return { canUndo: undo.length > 0, canRedo: true };
    });

    registerCommand('design.doc.redo', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: DesignKind };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const draft = await this.requireDraft(client, doc.id);
      const redo = [...draft.redo_stack];
      const top = redo.pop();
      if (top === undefined) throw new DomainError('UNDO_STACK_EMPTY', 'redo 栈为空', doc.id);
      const undo = [...draft.undo_stack, draft.content].slice(-UNDO_LIMIT);
      await client.query('UPDATE dsg_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_at=now() WHERE id=$1',
        [draft.id, top, JSON.stringify(undo), JSON.stringify(redo)]);
      await this.assertInvariants(client, doc.id);
      return { canUndo: true, canRedo: redo.length > 0 };
    });

    registerCommand('design.doc.commit-version', async (client, payload, ctx) => {
      const { projectId, kind, note, baseVersion } = payload as {
        projectId: string; kind: DesignKind; note?: string; baseVersion: number;
      };
      const doc = await this.lockDoc(client, projectId, kind);
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      if (!draft) throw new DomainError('INVALID_STATE', '无未提交修改', doc.id);
      if ((cur?.version_no ?? 0) !== baseVersion) {
        throw new DomainError('VERSION_CONFLICT', '版本号已变化，请刷新后重试', doc.id);
      }
      await this.assertNoPendings(client, doc.id);
      const v = await this.appendVersion(client, doc, draft.content, note ?? '', ctx);
      await client.query('DELETE FROM dsg_drafts WHERE id=$1', [draft.id]);
      await client.query(
        'UPDATE dsg_documents SET current_version_id=$2, modified=false, lock_owner=NULL, lock_at=NULL, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, v.id, ctx.actorId],
      );
      await this.assertInvariants(client, doc.id);
      return { v: v.version_no, versionFingerprint: `sha256:${v.content_fingerprint}`, at: v.submitted_at };
    });

    registerCommand('design.doc.switch-version', async (client, payload) => {
      const { projectId, kind, v } = payload as { projectId: string; kind: DesignKind; v: number };
      const doc = await this.lockDoc(client, projectId, kind);
      if (doc.modified) throw new DomainError('INVALID_STATE', '有未提交修改，须先提交或放弃', doc.id);
      await this.assertNoPendings(client, doc.id);
      const ver = await client.query<VersionRow>(
        'SELECT * FROM dsg_versions WHERE document_id=$1 AND version_no=$2', [doc.id, v]);
      if (!ver.rows[0]) throw new DomainError('NOT_FOUND', '版本不存在', String(v));
      await client.query('UPDATE dsg_documents SET current_version_id=$2, updated_at=now() WHERE id=$1',
        [doc.id, ver.rows[0].id]);
      return { cur: v };
    });

    // 设计册定稿（非策略确认点）：人工 confirm；未决评审项须显式二次确认（allowOpenReviews，记审计）
    registerCommand('design.doc.finalize', async (client, payload, ctx) => {
      const { projectId, kind, v, baseVersion, confirm, allowOpenReviews } = payload as {
        projectId: string; kind: DesignKind; v: number; baseVersion: number;
        confirm?: boolean; allowOpenReviews?: boolean;
      };
      if (ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '定稿为人工动作', 'design.doc.finalize');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '定稿须人工确认（confirm:true）', 'confirm');
      const doc = await this.lockDoc(client, projectId, kind);
      const cur = await this.currentVersion(client, doc);
      if (!cur || cur.version_no !== v || cur.version_no !== baseVersion) {
        throw new DomainError('VERSION_CONFLICT', '定稿目标版本与当前版本不一致', doc.id);
      }
      if (doc.final_version_id === cur.id) throw new DomainError('INVALID_STATE', '当前版本已定稿', doc.id);
      if (doc.modified) throw new DomainError('INVALID_STATE', '有未提交修改，不可定稿', doc.id);
      // 空模板闸（2026-10-22 全链实测实抓）：provisioning 骨架（「（待生成…」标记）未被生成覆盖
      // 时定稿=把空册钉成基线，下游目录/原型/开发链全线空转——定稿前置拒绝，引导先生成或编辑
      if ((cur.content ?? '').includes('（待生成')) {
        throw new DomainError('INVALID_STATE', '内容仍是初始模板（未生成/未编辑），不可定稿', doc.id);
      }
      await this.assertNoPendings(client, doc.id);
      const open = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM dsg_reviews WHERE project_id=$1 AND status='open'", [projectId]);
      const openCount = Number(open.rows[0]?.n ?? 0);
      if (openCount > 0 && !allowOpenReviews) {
        throw new DomainError('GATE_BLOCKED', `存在 ${openCount} 条未决评审项，须逐条结论或显式二次确认`, 'dsg_reviews');
      }
      await client.query('UPDATE dsg_documents SET final_version_id=$2, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, cur.id, ctx.actorId]);
      // W2-052：fin_ 发号按文档维度串行化（count+1 属 check-then-act）
      await lockCodeGen(client, `msf:code:fin:${doc.id}`);
      const finSeq = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM evd_records WHERE kind='finalize' AND payload->>'documentId'=$1", [doc.id]);
      const finalizationId = `fin_${Number(finSeq.rows[0]?.n ?? 0) + 1}`;
      await appendEvidence(client, {
        projectId,
        kind: 'finalize',
        payload: {
          documentId: doc.id, kind, v, finalizationId,
          contentFingerprint: cur.content_fingerprint, by: ctx.actorId,
          allowOpenReviews: openCount > 0 ? true : undefined, openReviews: openCount,
        },
      });
      return { finalVer: v, finalizationId, finalFingerprint: `sha256:${cur.content_fingerprint}`, openReviews: openCount };
    });

    registerCommand('design.doc.unlock', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: DesignKind };
      const doc = await this.lockDoc(client, projectId, kind);
      if (!doc.final_version_id) throw new DomainError('INVALID_STATE', '文档未定稿', doc.id);
      await client.query('UPDATE dsg_documents SET final_version_id=NULL, updated_by=$2, updated_at=now() WHERE id=$1',
        [doc.id, ctx.actorId]);
      return { unlocked: true };
    });

    registerCommand('design.doc.propose-pending', async (client, payload) => {
      const { projectId, kind, patches, targetFingerprint, proposedBy } = payload as {
        projectId: string; kind: DesignKind; patches: EditPatch[];
        targetFingerprint: string; proposedBy: string;
      };
      const doc = await this.lockDoc(client, projectId, kind);
      if (doc.final_version_id && doc.final_version_id === doc.current_version_id) {
        throw new DomainError('VERSION_LOCKED', '已定稿文档不可提补丁', doc.id);
      }
      await this.assertNoPendings(client, doc.id);
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      const effective = draft?.content ?? cur?.content ?? '';
      if (targetFingerprint !== sha256Text(effective)) {
        throw new DomainError('PATCH_BASE_STALE', '补丁目标指纹与当前内容不一致', doc.id);
      }
      const ids: string[] = [];
      // seq = 批内序号（0 起）：created_at 单事务同值，与需求域同构（T16 实机抓修）
      for (const [seq, patch] of patches.entries()) {
        const r = await client.query<{ id: string }>(
          'INSERT INTO dsg_pendings (document_id, patch, target_fingerprint, proposed_by, seq) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [doc.id, JSON.stringify(patch), targetFingerprint, proposedBy, seq],
        );
        ids.push(r.rows[0]!.id);
      }
      return { patchIds: ids };
    });

    registerCommand('design.doc.accept-pending', async (client, payload, ctx) => {
      // 需求阶段模式推广（条目 12 同治）：reason/newText 与 req 域同口径——改后接受覆盖提案新文、留痕记「改后接受」
      const { projectId, kind, patchId, reason, newText } = payload as {
        projectId: string; kind: DesignKind; patchId: string; reason?: string; newText?: string;
      };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const p = await client.query<{ id: string; patch: EditPatch; status: string }>(
        'SELECT * FROM dsg_pendings WHERE id=$1 AND document_id=$2 FOR UPDATE', [patchId, doc.id]);
      const row = p.rows[0];
      if (!row || row.status !== 'pending') throw new DomainError('INVALID_STATE', '补丁非待确认状态', patchId);
      let patch = row.patch;
      if (newText !== undefined) {
        if (patch.type === 'del') throw new DomainError('VALIDATION_FAILED', '删除补丁无新文，不接受改后接受', patchId);
        if (!newText.trim()) throw new DomainError('VALIDATION_FAILED', '改后接受的新文不能为空', patchId);
        patch = { ...patch, new: newText };
      }
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      const effective = draft?.content ?? cur?.content ?? '';
      const applied = applyPatch(splitSections(effective), patch);
      if (!applied) {
        throw new DomainError('PATCH_BASE_STALE', '补丁定位文本已不在当前内容中，补丁保留待处理', patchId);
      }
      const content = joinSections(applied);
      if (content !== effective) await this.writeDraft(client, doc, cur, draft, content, ctx);
      await client.query(
        "UPDATE dsg_pendings SET status='accepted', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1",
        [patchId, ctx.actorId, [reason?.trim(), newText !== undefined ? '改后接受' : null].filter(Boolean).join('；') || null],
      );
      await this.assertInvariants(client, doc.id);
      return { patchId, applied: true };
    });

    registerCommand('design.doc.reject-pending', async (client, payload, ctx) => {
      // 需求阶段模式推广：拒绝理由落库留痕（与 req 域同口径；dsg_pendings.reason 迁移 0026）
      const { projectId, kind, patchId, reason } = payload as { projectId: string; kind: DesignKind; patchId: string; reason?: string };
      const doc = await this.lockDoc(client, projectId, kind);
      const p = await client.query<{ status: string }>(
        'SELECT status FROM dsg_pendings WHERE id=$1 AND document_id=$2 FOR UPDATE', [patchId, doc.id]);
      if (p.rows[0]?.status !== 'pending') throw new DomainError('INVALID_STATE', '补丁非待确认状态', patchId);
      await client.query(
        "UPDATE dsg_pendings SET status='rejected', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1",
        [patchId, ctx.actorId, reason?.trim() || null],
      );
      return { patchId, applied: false };
    });
  }

  // ---------- 查询面 ----------

  /** A05-1 八册列表（首次访问自举模板 v1） */
  async listDocs(projectId: string, ctx: CommandContext): Promise<unknown> {
    for (const book of DESIGN_BOOKS) {
      const r = await query(
        'SELECT id FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, book.kind]);
      if (!r.rows[0]) {
        await executeCommand('design.doc.import-draft', { projectId, kind: book.kind }, { ...ctx, projectId });
      }
    }
    const docs = await query<DocRow & { cur: number | null; finalv: number | null; pend: string }>(
      `SELECT d.*, cv.version_no AS cur, fv.version_no AS finalv,
              (SELECT count(*) FROM dsg_pendings p WHERE p.document_id=d.id AND p.status='pending') AS pend
       FROM dsg_documents d
       LEFT JOIN dsg_versions cv ON cv.id=d.current_version_id
       LEFT JOIN dsg_versions fv ON fv.id=d.final_version_id
       WHERE d.project_id=$1 AND d.doc_kind != 'prototype'
       ORDER BY d.doc_kind='hld' DESC, d.doc_kind`,
      [projectId],
    );
    // 上游变更联动：各册挂「PRD 已变·待复核」派生标记（upstream-stale.ts 口径，一次查询全册映射）
    const staleMap = await designBooksStale(projectId);
    return {
      items: docs.rows.map((d) => {
        const book = DESIGN_BOOKS.find((b) => b.kind === d.doc_kind)!;
        const st = staleMap[d.doc_kind];
        return {
          id: d.id,
          kind: d.doc_kind,
          book: book.prefix,
          title: book.name,
          cur: d.cur ?? 0,
          finalVer: d.finalv ?? 0,
          finalized: !!d.final_version_id && d.final_version_id === d.current_version_id,
          modified: d.modified,
          pendingCount: Number(d.pend),
          ...(st ? { upstreamStale: st.stale, ...(st.upstreamVersionNo !== undefined ? { upstreamVersionNo: st.upstreamVersionNo } : {}) } : {}),
        };
      }),
    };
  }

  /** 文档详情（同需求域 A04-2 口径；?v=n 历史只读） */
  async getDoc(projectId: string, kind: string, v?: number): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const cur = await this.currentVersion(null, doc);
    const draft = await this.loadDraft(null, doc.id);
    let secsContent = draft?.content ?? cur?.content ?? '';
    let viewing: number | null = null;
    if (v !== undefined && cur && v !== cur.version_no) {
      const ver = await query<VersionRow>(
        'SELECT * FROM dsg_versions WHERE document_id=$1 AND version_no=$2', [doc.id, v]);
      if (!ver.rows[0]) throw new DomainError('NOT_FOUND', '版本不存在', String(v));
      secsContent = ver.rows[0].content;
      viewing = v;
    }
    const pendings = await query<{ id: string; patch: EditPatch }>(
      "SELECT id, patch FROM dsg_pendings WHERE document_id=$1 AND status='pending' ORDER BY created_at, seq",
      [doc.id],
    );
    const secs = splitSections(secsContent).map((s) => ({
      ...s,
      pending: pendings.rows.find((p) => p.patch.secId === s.id)?.id ?? null,
    }));
    const effectiveFp = sha256Text(draft?.content ?? cur?.content ?? '');
    return {
      id: doc.id,
      kind: doc.doc_kind,
      cur: cur?.version_no ?? 0,
      viewing,
      finalized: !!doc.final_version_id && doc.final_version_id === doc.current_version_id,
      finalVer: doc.final_version_id
        ? (await query<{ version_no: number }>('SELECT version_no FROM dsg_versions WHERE id=$1', [doc.final_version_id])).rows[0]?.version_no ?? 0
        : 0,
      modified: doc.modified,
      genState: doc.gen_state,
      // 上游变更联动：本册「PRD 已变·待复核」派生标记（页面 h1 徽标；upstream-stale.ts 口径）
      ...(await designBooksStale(projectId).then((m) => {
        const st = m[doc.doc_kind];
        return st ? { upstreamStale: st.stale, ...(st.upstreamVersionNo !== undefined ? { upstreamVersionNo: st.upstreamVersionNo } : {}) } : {};
      })),
      secs,
      version: cur?.version_no ?? 0,
      contentFingerprint: `sha256:${effectiveFp}`,
      // W2-025：undo/redo 按钮态依栈实态（与需求域同口径）
      canUndo: (draft?.undo_stack.length ?? 0) > 0,
      canRedo: (draft?.redo_stack.length ?? 0) > 0,
    };
  }

  async listVersions(projectId: string, kind: string): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const r = await query<VersionRow>(
      'SELECT * FROM dsg_versions WHERE document_id=$1 ORDER BY version_no DESC', [doc.id]);
    return {
      items: r.rows.map((x) => ({
        v: x.version_no, note: x.note, at: x.submitted_at, by: x.submitted_by,
        finalized: doc.final_version_id === x.id, readonly: true,
      })),
    };
  }

  async listPatches(projectId: string, kind: string): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const r = await query<{ id: string; patch: EditPatch; status: string; proposed_by: string }>(
      'SELECT id, patch, status, proposed_by FROM dsg_pendings WHERE document_id=$1 ORDER BY created_at, seq', [doc.id]);
    return {
      items: r.rows.map((x) => ({
        patchId: x.id, secId: x.patch.secId, type: x.patch.type, title: x.patch.title,
        old: x.patch.old, new: x.patch.new, status: x.status,
        source: x.proposed_by === 'assistant' ? 'ai' : x.proposed_by,
      })),
    };
  }

  /** 未决评审项计数（自检评审页签角标 + 定稿二次确认） */
  async openReviewCount(projectId: string): Promise<number> {
    const r = await query<{ n: string }>(
      "SELECT count(*) AS n FROM dsg_reviews WHERE project_id=$1 AND status='open'", [projectId]);
    return Number(r.rows[0]?.n ?? 0);
  }

  /** 上游定稿指纹（governing 消费链 PRD→HLD→LLD，REQ-302 门禁；T3-03 生成/规划共用） */
  async upstreamFingerprint(client: PoolClient | null, projectId: string, upto: 'prd' | 'hld'): Promise<{ ok: boolean; fingerprint: string | null; missing: string[] }> {
    const q = client ? client.query.bind(client) : query;
    const need: Array<{ domain: string; kind: string }> = upto === 'prd'
      ? [{ domain: 'req', kind: 'prd' }]
      : [{ domain: 'req', kind: 'prd' }, { domain: 'dsg', kind: 'hld' }];
    const fps: Record<string, string | null> = {};
    const missing: string[] = [];
    for (const n of need) {
      const table = n.domain === 'req' ? 'req_documents' : 'dsg_documents';
      const vtable = n.domain === 'req' ? 'req_versions' : 'dsg_versions';
      const r = await q<{ fp: string | null }>(
        `SELECT v.content_fingerprint AS fp FROM ${table} d JOIN ${vtable} v ON v.id=d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, n.kind]);
      fps[n.kind] = r.rows[0]?.fp ?? null;
      if (!r.rows[0]?.fp) missing.push(n.kind.toUpperCase());
    }
    if (missing.length > 0) return { ok: false, fingerprint: null, missing };
    return { ok: true, fingerprint: fingerprint(fps), missing: [] };
  }

  // ---------- 命令入口薄封装 ----------

  async saveDraft(projectId: string, kind: DesignKind, input: { secId: string; md: string; baseVersion: number; baseFingerprint: string }, ctx: CommandContext) {
    return executeCommand('design.doc.save-html', { projectId, kind, ...input }, { ...ctx, projectId });
  }
  async undo(projectId: string, kind: DesignKind, ctx: CommandContext) {
    return executeCommand('design.doc.undo', { projectId, kind }, { ...ctx, projectId });
  }
  async redo(projectId: string, kind: DesignKind, ctx: CommandContext) {
    return executeCommand('design.doc.redo', { projectId, kind }, { ...ctx, projectId });
  }
  async commit(projectId: string, kind: DesignKind, note: string, baseVersion: number, ctx: CommandContext) {
    const r = await executeCommand('design.doc.commit-version', { projectId, kind, note, baseVersion }, { ...ctx, projectId });
    // #15：设计册正文是 RTM 反向派生输入，提交后冪等重建派生链（独立事务；失败仅致门禁保守拦截，可重试自愈）
    await executeCommand('rtm.rebuild', { projectId }, { ...ctx, projectId });
    return r;
  }
  async switchVersion(projectId: string, kind: DesignKind, v: number, ctx: CommandContext) {
    return executeCommand('design.doc.switch-version', { projectId, kind, v }, { ...ctx, projectId });
  }
  async finalize(projectId: string, kind: DesignKind, v: number, baseVersion: number, confirm: boolean, allowOpenReviews: boolean, ctx: CommandContext) {
    return executeCommand('design.doc.finalize', { projectId, kind, v, baseVersion, confirm, allowOpenReviews }, { ...ctx, projectId });
  }

  /** 批量定稿（2026-10-16 用户拍板）：详细七册（mod/alg/cls/db/api/ui/nfr——hld 概要先单走，消费链上游）——
   *  逐册独立调 design.doc.finalize 命令（每册独立事务+独立审计留痕），失败跳过并列原因不拖垮整批；
   *  编排层不注册新命令（per-book 命令即留痕）；confirm/allowOpenReviews 透传到每册（人工确认点语义不变）。 */
  async finalizeAll(projectId: string, confirm: boolean, allowOpenReviews: boolean, ctx: CommandContext) {
    const finalized: Array<{ kind: DesignKind; v: number; finalizationId: string }> = [];
    const skipped: Array<{ kind: DesignKind; reason: string }> = [];
    for (const b of DESIGN_BOOKS.filter((x) => x.kind !== 'hld')) {
      try {
        const d = await query<DocRow>('SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, b.kind]);
        const doc = d.rows[0];
        const cur = doc ? await this.currentVersion(null, doc) : null;
        if (!doc || !cur) { skipped.push({ kind: b.kind, reason: '无内容（未生成）' }); continue; }
        if (doc.final_version_id !== null && doc.final_version_id === doc.current_version_id) {
          skipped.push({ kind: b.kind, reason: '当前版本已定稿' });
          continue;
        }
        const r = (await this.finalize(projectId, b.kind, cur.version_no, cur.version_no, confirm, allowOpenReviews, ctx)) as { finalVer: number; finalizationId: string };
        finalized.push({ kind: b.kind, v: r.finalVer, finalizationId: r.finalizationId });
      } catch (e) {
        if (e instanceof DomainError) {
          skipped.push({ kind: b.kind, reason: e.message });
        } else {
          console.error(`[design] 批量定稿 ${b.kind} 册内部错误`, e);
          skipped.push({ kind: b.kind, reason: '内部错误（详见服务日志）' });
        }
      }
    }
    return { finalized, skipped };
  }
  async unlock(projectId: string, kind: DesignKind, ctx: CommandContext) {
    return executeCommand('design.doc.unlock', { projectId, kind }, { ...ctx, projectId });
  }
  async acceptPatch(projectId: string, kind: DesignKind, patchId: string, ctx: CommandContext, reason?: string, newText?: string) {
    return executeCommand('design.doc.accept-pending', {
      projectId, kind, patchId,
      ...(reason !== undefined ? { reason } : {}),
      ...(newText !== undefined ? { newText } : {}),
    }, { ...ctx, projectId });
  }
  async rejectPatch(projectId: string, kind: DesignKind, patchId: string, ctx: CommandContext, reason?: string) {
    return executeCommand('design.doc.reject-pending', { projectId, kind, patchId, ...(reason !== undefined ? { reason } : {}) }, { ...ctx, projectId });
  }

  // ---------- 内部 ----------

  private async ensureDoc(client: PoolClient, projectId: string, kind: DesignKind, ctx: CommandContext): Promise<DocRow> {
    const r = await client.query<DocRow>(
      'SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2 FOR UPDATE', [projectId, kind]);
    if (r.rows[0]) return r.rows[0];
    const book = DESIGN_BOOKS.find((b) => b.kind === kind)!;
    const ins = await client.query<DocRow>(
      'INSERT INTO dsg_documents (project_id, doc_kind, name, chapter_prefix, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [projectId, kind, book.name, book.prefix, ctx.actorId],
    );
    return ins.rows[0]!;
  }

  private async lockDoc(client: PoolClient, projectId: string, kind: string): Promise<DocRow> {
    const r = await client.query<DocRow>(
      'SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2 FOR UPDATE', [projectId, kind]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '文档不存在', kind);
    return r.rows[0]!;
  }

  private async getDocRow(projectId: string, kind: string): Promise<DocRow> {
    const r = await query<DocRow>(
      'SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, kind]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '文档不存在', kind);
    return r.rows[0]!;
  }

  private async currentVersion(client: PoolClient | null, doc: DocRow): Promise<VersionRow | null> {
    if (!doc.current_version_id) return null;
    const q = client ? client.query.bind(client) : query;
    const r = await q<VersionRow>('SELECT * FROM dsg_versions WHERE id=$1', [doc.current_version_id]);
    return r.rows[0] ?? null;
  }

  private async loadDraft(client: PoolClient | null, docId: string): Promise<DraftRow | null> {
    const q = client ? client.query.bind(client) : query;
    const r = await q<DraftRow>('SELECT * FROM dsg_drafts WHERE document_id=$1', [docId]);
    return r.rows[0] ?? null;
  }

  private async requireDraft(client: PoolClient, docId: string): Promise<DraftRow> {
    const d = await this.loadDraft(client, docId);
    if (!d) throw new DomainError('INVALID_STATE', '无工作草稿', docId);
    return d;
  }

  private assertEditable(doc: DocRow, ctx: CommandContext): void {
    if (doc.final_version_id && doc.final_version_id === doc.current_version_id) {
      throw new DomainError('VERSION_LOCKED', '已定稿文档不可原地修改（修改=新草稿→新版本）', doc.id);
    }
    if (doc.lock_owner && doc.lock_owner !== ctx.actorId) {
      throw new DomainError('VERSION_CONFLICT', `文档由 ${doc.lock_owner} 编辑中`, doc.id);
    }
  }

  private assertLock(baseVersion: number, baseFingerprint: string, cur: VersionRow | null, effective: string): void {
    if ((cur?.version_no ?? 0) !== baseVersion) {
      throw new DomainError('VERSION_CONFLICT', '版本号已变化，请刷新后重试', String(baseVersion));
    }
    const fp = baseFingerprint.replace(/^sha256:/, '');
    if (fp !== sha256Text(effective)) {
      throw new DomainError('VERSION_CONFLICT', '内容指纹不一致，存在并发修改', 'contentFingerprint');
    }
  }

  private async writeDraft(
    client: PoolClient, doc: DocRow, cur: VersionRow | null, draft: DraftRow | null, content: string, ctx: CommandContext,
  ): Promise<void> {
    if (!cur) throw new DomainError('INVALID_STATE', '文档无基点版本', doc.id);
    const effective = draft?.content ?? cur.content;
    if (draft) {
      const base = await client.query<VersionRow>('SELECT * FROM dsg_versions WHERE id=$1', [draft.base_version_id]);
      if (!base.rows[0] || base.rows[0].content_fingerprint !== draft.base_content_fingerprint) {
        throw new DomainError('DRAFT_BASE_MISMATCH', '草稿基点版本指纹不符', doc.id);
      }
      const undo = [...draft.undo_stack, effective].slice(-UNDO_LIMIT);
      await client.query(
        'UPDATE dsg_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_by=$5, updated_at=now() WHERE id=$1',
        [draft.id, content, JSON.stringify(undo), '[]', ctx.actorId],
      );
    } else {
      await client.query(
        `INSERT INTO dsg_drafts (document_id, base_version_id, base_content_fingerprint, content, undo_stack, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [doc.id, cur.id, cur.content_fingerprint, content, JSON.stringify([cur.content]), ctx.actorId],
      );
    }
    await client.query(
      'UPDATE dsg_documents SET modified=true, lock_owner=$2, lock_at=now(), updated_by=$2, updated_at=now() WHERE id=$1',
      [doc.id, ctx.actorId],
    );
  }

  /** 追加不可变版本（v=max+1；governing=上游定稿组合指纹，BR-02） */
  private async appendVersion(
    client: PoolClient, doc: DocRow, content: string, note: string, ctx: CommandContext,
  ): Promise<VersionRow> {
    const max = await client.query<{ v: number | null }>(
      'SELECT max(version_no) AS v FROM dsg_versions WHERE document_id=$1', [doc.id]);
    const vno = (max.rows[0]?.v ?? 0) + 1;
    const up = await this.upstreamFingerprint(client, doc.project_id, doc.doc_kind === 'hld' ? 'prd' : 'hld');
    const governing = fingerprint({
      prd: (doc.doc_kind === 'hld' ? up.fingerprint : undefined) ?? null,
      upstream: up.fingerprint,
      scope: doc.doc_kind,
    });
    const r = await client.query<VersionRow>(
      `INSERT INTO dsg_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, refs, note, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [doc.id, vno, content, sha256Text(content), governing, '[]', note, ctx.actorId],
    );
    return r.rows[0]!;
  }

  private async assertNoPendings(client: PoolClient, docId: string): Promise<void> {
    const r = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM dsg_pendings WHERE document_id=$1 AND status='pending'", [docId]);
    if (Number(r.rows[0]?.n ?? 0) > 0) {
      throw new DomainError('INVALID_STATE', '存在待确认补丁，须先逐条处理', docId);
    }
  }

  private async assertInvariants(client: PoolClient, docId: string): Promise<void> {
    const d = await client.query<DocRow & { draftId: string | null }>(
      `SELECT d.*, (SELECT id FROM dsg_drafts WHERE document_id=d.id) AS "draftId"
       FROM dsg_documents d WHERE d.id=$1`, [docId]);
    const doc = d.rows[0]!;
    if ((doc.draftId === null) !== (doc.modified === false)) {
      throw new DomainError('INTERNAL', 'INV-DOC-4 违反：draft 与 modified 不一致', docId);
    }
    const vs = await client.query<{ version_no: number }>(
      'SELECT version_no FROM dsg_versions WHERE document_id=$1 ORDER BY version_no', [docId]);
    vs.rows.forEach((row, i) => {
      if (row.version_no !== i + 1) throw new DomainError('INTERNAL', 'INV-DOC-6a 违反：版本号断链', docId);
    });
  }
}
