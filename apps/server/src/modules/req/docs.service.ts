import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { applyPatch, joinSections, sha256Text, splitSections, type EditPatch } from '../platform/doc-sections.js';
import { deriveLinks, computeHealth, scanOverdesign } from '../platform/rtm-health.js';
import { designContents } from '../platform/doc-contents.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { reqPrdStale } from '../platform/upstream-stale.js';

/**
 * 需求文档生命周期核（LLD-2 DSG-F02-1 权威状态机；REQ-203/204/205/209/210、BR-05/12）。
 * 全部写操作命令化；发布前不变式（INV-DOC-1~6）在命令提交前断言，违反即整体回滚。
 * 乐观锁口径：baseVersion（当前版本号）+ baseFingerprint（当前有效内容指纹）双重校验（REQ-210）。
 */

const UNDO_LIMIT = 30; // 原型 snapDesign 上限沿用（F02-1 命令化覆盖注）

const TEMPLATES: Record<string, string> = {
  crd: '# 客户需求文档（CRD）\n\n（待生成：参考资料内容定稿后由 AI 生成初稿，或直接编辑。）',
  prd: '# 产品需求文档（PRD）\n\n（待生成：CRD 定稿后由 AI 生成初稿，或直接编辑。）',
};

interface DocRow {
  id: string;
  project_id: string;
  doc_kind: 'crd' | 'prd';
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
  created_at: Date;
}

@Injectable()
export class ReqDocsService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    // 可选：集成测试直 new 单参构造；运行期由 Nest 注入（联动通知 SSE 补推用，缺席仅不推流不影响落库）
    @Inject(NotificationsService) private readonly notices?: NotificationsService,
  ) {}

  onModuleInit(): void {
    // #15：反向派生后设计册提交也是派生输入——开放冪等重建命令供设计域经命令总线调用（跨域禁令下不走 import）
    registerCommand('rtm.rebuild', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      await this.rebuildRtmLinks(client, projectId, ctx);
      return { rebuilt: true };
    });
    registerCommand('doc.import-draft', async (client, payload, ctx) => {
      const { projectId, kind, content, note } = payload as {
        projectId: string; kind: 'crd' | 'prd'; content: string; note?: string;
      };
      const doc = await this.ensureDoc(client, projectId, kind, ctx);
      const v = await this.appendVersion(client, doc, content, note ?? '初始模板', ctx);
      await client.query(
        'UPDATE req_documents SET current_version_id=$2, modified=false, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, v.id, ctx.actorId],
      );
      return { docId: doc.id, v: v.version_no };
    });

    // F02-1 save-html：非定稿；内容有变化否则 NO_CHANGE；乐观锁；入 undo 栈清 redo
    registerCommand('doc.save-html', async (client, payload, ctx) => {
      const { projectId, kind, secId, md, baseVersion, baseFingerprint } = payload as {
        projectId: string; kind: 'crd' | 'prd'; secId: string; md: string;
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
      // W2-026 防呆：非文首节（s0 为文首/全文口，允许整篇替换式写入）保存的内容不得携带节标题，
      // 否则写回后重切分出重复章节（实机已发生 CR-100×2）
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

    // 编辑态增节：在 secId 节下方插入新节（title 必填、不得带 ## 前缀；写草稿自带 undo 栈）
    registerCommand('doc.section.add', async (client, payload, ctx) => {
      const { projectId, kind, secId, title, md, baseVersion, baseFingerprint } = payload as {
        projectId: string; kind: 'crd' | 'prd'; secId: string; title: string; md?: string;
        baseVersion: number; baseFingerprint: string;
      };
      const t = (title ?? '').trim().replace(/^#+\s*/, '');
      if (!t) throw new DomainError('VALIDATION_FAILED', '章节标题不能为空', secId);
      if (/^#{2,6}\s/m.test(md ?? '')) {
        throw new DomainError('VALIDATION_FAILED', '新增章节的内容不得包含章节标题（## 及更深）', secId);
      }
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      const effective = draft?.content ?? cur?.content ?? '';
      this.assertLock(baseVersion, baseFingerprint, cur, effective);
      const secs = splitSections(effective);
      const si = secs.findIndex((s) => s.id === secId);
      if (si < 0) throw new DomainError('NOT_FOUND', '章节不存在', secId);
      const next = [...secs.slice(0, si + 1), { id: `s${si + 1}`, title: t, md: (md ?? '').trim() }, ...secs.slice(si + 1)];
      const content = joinSections(next);
      await this.writeDraft(client, doc, cur, draft, content, ctx);
      await this.assertInvariants(client, doc.id);
      return { modified: true, title: t, contentFingerprint: `sha256:${sha256Text(content)}` };
    });

    // 编辑态删节：整节移除（s0 文首不可删——清空请用编辑；至少保留一节；写草稿自带 undo 栈）
    registerCommand('doc.section.del', async (client, payload, ctx) => {
      const { projectId, kind, secId, baseVersion, baseFingerprint } = payload as {
        projectId: string; kind: 'crd' | 'prd'; secId: string;
        baseVersion: number; baseFingerprint: string;
      };
      if (secId === 's0') {
        throw new DomainError('VALIDATION_FAILED', '文首部分不可删除（如需清空请直接编辑其内容）', secId);
      }
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const cur = await this.currentVersion(client, doc);
      const draft = await this.loadDraft(client, doc.id);
      const effective = draft?.content ?? cur?.content ?? '';
      this.assertLock(baseVersion, baseFingerprint, cur, effective);
      const secs = splitSections(effective);
      const si = secs.findIndex((s) => s.id === secId);
      if (si < 0) throw new DomainError('NOT_FOUND', '章节不存在', secId);
      if (secs.length <= 2) { // s0 之外仅剩一节时删除即清空全文
        throw new DomainError('VALIDATION_FAILED', '文档至少保留一个章节', secId);
      }
      const removed = secs[si]!;
      const next = [...secs.slice(0, si), ...secs.slice(si + 1)];
      const content = joinSections(next);
      if (content === effective) throw new DomainError('NO_CHANGE', '内容无变化', secId);
      await this.writeDraft(client, doc, cur, draft, content, ctx);
      await this.assertInvariants(client, doc.id);
      return { modified: true, removedTitle: removed.title, contentFingerprint: `sha256:${sha256Text(content)}` };
    });

    registerCommand('doc.undo', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: 'crd' | 'prd' };
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
        // 撤回到基点：草稿消亡回 clean（modified 按草稿是否存在重算，F02-1 undo 行）
        // W2-024：草稿存续期间接受的补丁未随版本提交消费，回转 pending（否则内容蒸发无恢复入口）
        await client.query(
          `UPDATE req_pendings SET status='pending', decided_by=NULL, decided_at=NULL, reason=NULL
           WHERE document_id=$1 AND status='accepted' AND decided_at >= $2`,
          [doc.id, draft.created_at],
        );
        await client.query('DELETE FROM req_drafts WHERE id=$1', [draft.id]);
        await client.query('UPDATE req_documents SET modified=false, updated_at=now() WHERE id=$1', [doc.id]);
        await this.assertInvariants(client, doc.id);
        // W2-025：栈随草稿消亡，undo/redo 均不可用（如实返回，不再谎称 canRedo）
        return { canUndo: false, canRedo: false };
      }
      await client.query('UPDATE req_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_at=now() WHERE id=$1',
        [draft.id, top, JSON.stringify(undo), JSON.stringify(redo)]);
      await this.assertInvariants(client, doc.id);
      return { canUndo: undo.length > 0, canRedo: true };
    });

    registerCommand('doc.redo', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: 'crd' | 'prd' };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const draft = await this.requireDraft(client, doc.id);
      const redo = [...draft.redo_stack];
      const top = redo.pop();
      if (top === undefined) throw new DomainError('UNDO_STACK_EMPTY', 'redo 栈为空', doc.id);
      const undo = [...draft.undo_stack, draft.content].slice(-UNDO_LIMIT);
      await client.query('UPDATE req_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_at=now() WHERE id=$1',
        [draft.id, top, JSON.stringify(undo), JSON.stringify(redo)]);
      await this.assertInvariants(client, doc.id);
      return { canUndo: true, canRedo: redo.length > 0 };
    });

    // commit-version：modified 且 pend 为空；追加 v=max+1（字节不可变、编号不复用）；同事务 RTM 派生重建
    registerCommand('doc.commit-version', async (client, payload, ctx) => {
      const { projectId, kind, note, baseVersion } = payload as {
        projectId: string; kind: 'crd' | 'prd'; note?: string; baseVersion: number;
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
      await client.query('DELETE FROM req_drafts WHERE id=$1', [draft.id]);
      await client.query(
        'UPDATE req_documents SET current_version_id=$2, modified=false, lock_owner=NULL, lock_at=NULL, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, v.id, ctx.actorId],
      );
      await this.rebuildRtmLinks(client, projectId, ctx);
      // 上游变更联动（2026-10-05 拍板）：提交即提醒下游「内容可能滞后」——
      // CRD 提交→PRD 滞后检查；PRD 提交→设计八册滞后检查（同事务落通知+事件，提交后包装层补推 SSE）。
      // 滞后判定与 upstream-stale.ts 同口径：下游有已提交版本且上游新版本更晚；通知仅提示不改数据
      let noticeId: string | undefined;
      if (kind === 'crd') {
        const down = await client.query<{ v: number; at: string }>(
          `SELECT dv.version_no AS v, dv.submitted_at AS at
           FROM req_documents d JOIN req_versions dv ON dv.id = d.current_version_id
           WHERE d.project_id=$1 AND d.doc_kind='prd'`, [projectId]);
        const prd = down.rows[0];
        if (prd && new Date(v.submitted_at) > new Date(prd.at)) {
          const n = await client.query<{ id: string }>(
            `INSERT INTO sys_notifications (project_id, user_id, type, text, link)
             VALUES ($1,NULL,'req.upstream.changed',$2,'/req?tab=prd') RETURNING id`,
            [projectId, `CRD 已提交 v${v.version_no}：PRD 仍停留在 v${prd.v}，内容可能滞后，建议复核并跟随修订（RTM 锚点链已随本次提交重建）`]);
          noticeId = n.rows[0]!.id;
          await client.query(
            'INSERT INTO evd_events (project_id, kind, payload, actor_kind, actor_id) VALUES ($1,$2,$3,$4,$5)',
            [projectId, 'req.upstream.changed', JSON.stringify({ upstream: 'crd', upstreamVersionNo: v.version_no, downstream: 'prd', downstreamVersionNo: prd.v, noticeId }), ctx.actorKind, ctx.actorId]);
        }
      } else {
        const staleBooks = await client.query<{ kind: string; v: number }>(
          `SELECT d.doc_kind AS kind, dv.version_no AS v
           FROM dsg_documents d JOIN dsg_versions dv ON dv.id = d.current_version_id
           WHERE d.project_id=$1 AND d.doc_kind != 'prototype' AND dv.submitted_at < $2`,
          [projectId, v.submitted_at]);
        if (staleBooks.rows.length > 0) {
          const kinds = staleBooks.rows.map((b) => b.kind).join('/');
          const n = await client.query<{ id: string }>(
            `INSERT INTO sys_notifications (project_id, user_id, type, text, link)
             VALUES ($1,NULL,'req.upstream.changed',$2,'/design') RETURNING id`,
            [projectId, `PRD 已提交 v${v.version_no}：${staleBooks.rows.length} 册设计文档（${kinds}）内容可能滞后，建议复核（RTM 派生链将随各册提交重建）`]);
          noticeId = n.rows[0]!.id;
          await client.query(
            'INSERT INTO evd_events (project_id, kind, payload, actor_kind, actor_id) VALUES ($1,$2,$3,$4,$5)',
            [projectId, 'req.upstream.changed', JSON.stringify({ upstream: 'prd', upstreamVersionNo: v.version_no, downstream: 'design', staleKinds: staleBooks.rows.map((b) => b.kind), noticeId }), ctx.actorKind, ctx.actorId]);
        }
      }
      await this.assertInvariants(client, doc.id);
      return {
        v: v.version_no, versionFingerprint: `sha256:${v.content_fingerprint}`, at: v.submitted_at,
        ...(noticeId ? { noticeId } : {}),
      };
    });

    // switch-version：仅移动 cur 指针；前置 !modified 且 pend 为空
    registerCommand('doc.switch-version', async (client, payload) => {
      const { projectId, kind, v } = payload as { projectId: string; kind: 'crd' | 'prd'; v: number };
      const doc = await this.lockDoc(client, projectId, kind);
      if (doc.modified) throw new DomainError('INVALID_STATE', '有未提交修改，须先提交或放弃', doc.id);
      await this.assertNoPendings(client, doc.id);
      const ver = await client.query<VersionRow>(
        'SELECT * FROM req_versions WHERE document_id=$1 AND version_no=$2', [doc.id, v]);
      if (!ver.rows[0]) throw new DomainError('NOT_FOUND', '版本不存在', String(v));
      await client.query('UPDATE req_documents SET current_version_id=$2, updated_at=now() WHERE id=$1',
        [doc.id, ver.rows[0].id]);
      return { cur: v };
    });

    // req.doc.finalize：经策略确认点（默认人工）；PRD 定稿挂 RTM 健康度门禁（L0a≥0.95 且 L0b=1）
    registerCommand('req.doc.finalize', async (client, payload, ctx) => {
      const { projectId, kind, v, baseVersion, confirm } = payload as {
        projectId: string; kind: 'crd' | 'prd'; v: number; baseVersion: number; confirm?: boolean;
      };
      const gate = await this.policy.evaluate(projectId, 'req.doc.finalize');
      if (gate.mode === 'manual' && ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', '定稿确认点为人工模式，AI 通道不可调用', 'req.doc.finalize');
      }
      if (!confirm) throw new DomainError('VALIDATION_FAILED', '定稿须人工确认（confirm:true）', 'confirm');
      const doc = await this.lockDoc(client, projectId, kind);
      const cur = await this.currentVersion(client, doc);
      if (!cur || cur.version_no !== v || cur.version_no !== baseVersion) {
        throw new DomainError('VERSION_CONFLICT', '定稿目标版本与当前版本不一致', doc.id);
      }
      if (doc.final_version_id === cur.id) {
        throw new DomainError('INVALID_STATE', '当前版本已定稿', doc.id);
      }
      if (doc.modified) throw new DomainError('INVALID_STATE', '有未提交修改，不可定稿', doc.id);
      // 空模板闸（2026-10-22 全链实测实抓，与设计域同口径）：初始模板未覆盖不可定稿
      if ((cur.content ?? '').includes('（待生成')) {
        throw new DomainError('INVALID_STATE', '内容仍是初始模板（未生成/未编辑），不可定稿', doc.id);
      }
      await this.assertNoPendings(client, doc.id);
      if (kind === 'prd') {
        // 领域附加门禁：RTM 健康度实时重算（F06-7 不用缓存值放行）+ 度量留痕
        const health = await this.measureHealth(client, projectId, ctx);
        if (!health.ok) {
          throw new DomainError('GATE_BLOCKED', 'RTM 健康度门禁未通过（L0a≥0.95 且 L0b=1）', 'rtm', {
            issues: health.gaps,
          });
        }
      }
      await client.query('UPDATE req_documents SET final_version_id=$2, updated_by=$3, updated_at=now() WHERE id=$1',
        [doc.id, cur.id, ctx.actorId]);
      // W2-052：fin_ 发号按文档维度串行化（count+1 属 check-then-act）
      await lockCodeGen(client, `msf:code:fin:${doc.id}`);
      const finSeq = await client.query<{ n: string }>(
        "SELECT count(*) AS n FROM evd_records WHERE kind='finalize' AND payload->>'documentId'=$1", [doc.id]);
      const finalizationId = `fin_${Number(finSeq.rows[0]?.n ?? 0) + 1}`;
      // 定稿证据行（D04-2 注：定稿不 UPDATE 版本行，追加 evd_records(kind='finalize') + 指针）
      await appendEvidence(client, {
        projectId,
        kind: 'finalize',
        payload: { documentId: doc.id, kind, v, finalizationId, contentFingerprint: cur.content_fingerprint, by: ctx.actorId },
      });
      return {
        finalVer: v,
        finalizationId,
        finalFingerprint: `sha256:${cur.content_fingerprint}`,
        policy: { point: 'req.doc.finalize', mode: gate.mode },
      };
    });

    // doc.unlock：解除定稿（下游失效传播随 M3 接入，本期留审计）
    registerCommand('doc.unlock', async (client, payload, ctx) => {
      const { projectId, kind } = payload as { projectId: string; kind: 'crd' | 'prd' };
      const doc = await this.lockDoc(client, projectId, kind);
      if (!doc.final_version_id) throw new DomainError('INVALID_STATE', '文档未定稿', doc.id);
      await client.query('UPDATE req_documents SET final_version_id=NULL, updated_by=$2, updated_at=now() WHERE id=$1',
        [doc.id, ctx.actorId]);
      return { unlocked: true };
    });

    // 待确认补丁（REQ-205）：AI 提案不直接落稿；propose 前置无现存 pend + 目标指纹匹配
    registerCommand('doc.propose-pending', async (client, payload) => {
      const { projectId, kind, patches, targetFingerprint, proposedBy } = payload as {
        projectId: string; kind: 'crd' | 'prd'; patches: EditPatch[];
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
      // seq = 批内序号（0 起）：created_at 单事务同值，ORDER BY created_at, seq 需次序键（T16 实机抓修）
      for (const [seq, patch] of patches.entries()) {
        const r = await client.query<{ id: string }>(
          'INSERT INTO req_pendings (document_id, patch, target_fingerprint, proposed_by, seq) VALUES ($1,$2,$3,$4,$5) RETURNING id',
          [doc.id, JSON.stringify(patch), targetFingerprint, proposedBy, seq],
        );
        ids.push(r.rows[0]!.id);
      }
      return { patchIds: ids };
    });

    // accept-pending：from 文本仍在当前内容（否则保留 pend 并拒绝 PATCH_BASE_STALE）；走 save 同路径入 undo 栈
    // newText 覆盖=「改后接受」（人工编辑提案新文后并入，payload 随命令审计留痕）；del 补丁无新文不接受覆盖
    registerCommand('doc.accept-pending', async (client, payload, ctx) => {
      const { projectId, kind, patchId, reason, newText } = payload as { projectId: string; kind: 'crd' | 'prd'; patchId: string; reason?: string; newText?: string };
      const doc = await this.lockDoc(client, projectId, kind);
      this.assertEditable(doc, ctx);
      const p = await client.query<{ id: string; patch: EditPatch; status: string }>(
        "SELECT * FROM req_pendings WHERE id=$1 AND document_id=$2 FOR UPDATE", [patchId, doc.id]);
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
        "UPDATE req_pendings SET status='accepted', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1",
        [patchId, ctx.actorId, [reason?.trim(), newText !== undefined ? '改后接受' : null].filter(Boolean).join('；') || null],
      );
      await this.assertInvariants(client, doc.id);
      return { patchId, applied: true };
    });

    registerCommand('doc.reject-pending', async (client, payload, ctx) => {
      const { projectId, kind, patchId, reason } = payload as { projectId: string; kind: 'crd' | 'prd'; patchId: string; reason?: string };
      const doc = await this.lockDoc(client, projectId, kind);
      const p = await client.query<{ status: string }>(
        "SELECT status FROM req_pendings WHERE id=$1 AND document_id=$2 FOR UPDATE", [patchId, doc.id]);
      if (p.rows[0]?.status !== 'pending') throw new DomainError('INVALID_STATE', '补丁非待确认状态', patchId);
      await client.query(
        "UPDATE req_pendings SET status='rejected', decided_by=$2, decided_at=now(), reason=$3 WHERE id=$1",
        [patchId, ctx.actorId, reason?.trim() || null],
      );
      return { patchId, applied: false };
    });

    // 参考关联（REQ-114）：仅 content_final 资料的 content_parse final 行可挂接
    registerCommand('doc.add-reference', async (client, payload, ctx) => {
      const { projectId, kind, fileId } = payload as { projectId: string; kind: 'crd' | 'prd'; fileId: string };
      const doc = await this.lockOrCreateDoc(client, projectId, kind, ctx); // #3：未打开过文档也可挂参考
      const ref = await client.query<{ id: string; content_fingerprint: string }>(
        `SELECT p.id, p.content_fingerprint FROM mat_parsed p
         JOIN mat_files f ON f.id = p.file_id
         WHERE f.id=$1 AND f.project_id=$2 AND f.parse_status='content_final'
           AND p.kind='content_parse' AND p.status='final'`,
        [fileId, projectId],
      );
      const row = ref.rows[0];
      if (!row) throw new DomainError('REFERENCE_NOT_FINAL', '参考输入须为已定稿（content_final）资料', fileId);
      await client.query(
        'INSERT INTO req_doc_refs (document_id, parsed_id, content_fingerprint, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [doc.id, row.id, row.content_fingerprint, ctx.actorId],
      );
      // W2-019：回填 mat_parsed.referenced_by（资料删除守卫读此列；挂接即建立引用关系）
      await client.query(
        `UPDATE mat_parsed SET referenced_by = COALESCE(referenced_by::jsonb, '[]'::jsonb) || $2::jsonb
         WHERE id=$1 AND NOT (COALESCE(referenced_by::jsonb,'[]'::jsonb) @> $2::jsonb)`,
        [row.id, JSON.stringify([{ kind: 'req-doc', id: doc.id, docKind: kind }])],
      );
      return { docId: doc.id, parsedId: row.id };
    });

    registerCommand('doc.remove-reference', async (client, payload) => {
      const { projectId, kind, fileId } = payload as { projectId: string; kind: 'crd' | 'prd'; fileId: string };
      const doc = await this.lockDoc(client, projectId, kind);
      await client.query(
        `DELETE FROM req_doc_refs WHERE document_id=$1 AND parsed_id IN (
           SELECT p.id FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
           WHERE f.id=$2 AND p.kind='content_parse' AND p.status='final')`,
        [doc.id, fileId],
      );
      // W2-019：同步回收 referenced_by（守卫读空表才放行删除，移除挂接必须同步清引用）
      await client.query(
        `UPDATE mat_parsed SET referenced_by = COALESCE((
           SELECT jsonb_agg(elem) FROM jsonb_array_elements(referenced_by::jsonb) elem
           WHERE NOT (elem->>'kind' = 'req-doc' AND elem->>'id' = $2)
         ), '[]'::jsonb)
         WHERE file_id=$1 AND kind='content_parse' AND status='final'`,
        [fileId, doc.id],
      );
      return { docId: doc.id, removed: fileId };
    });
  }

  // ---------- 查询面（纯读，不经 CommandBus） ----------

  /** A04-1 文档列表（首次访问自动建 crd/prd 各一份 + 模板 v1） */
  async listDocs(projectId: string, ctx: CommandContext): Promise<unknown> {
    for (const kind of ['crd', 'prd'] as const) {
      // W7-001：provisioning 判定从「文档行不存在」放宽到「文档行不存在或无基点版本」——
      // 先挂参考（addReference 的 lockOrCreateDoc 只建行不建版本）再首访列表时，
      // 旧口径会跳过模板 v1，导致 accept-pending/save-html 全部 409「文档无基点版本」死锁
      const r = await query<{ id: string }>(
        'SELECT id FROM req_documents WHERE project_id=$1 AND doc_kind=$2 AND current_version_id IS NOT NULL',
        [projectId, kind]);
      if (!r.rows[0]) {
        await executeCommand('doc.import-draft', { projectId, kind, content: TEMPLATES[kind] }, { ...ctx, projectId });
      }
    }
    const docs = await query<DocRow & { cur: number | null; finalv: number | null; pend: string }>(
      `SELECT d.*, cv.version_no AS cur, fv.version_no AS finalv,
              (SELECT count(*) FROM req_pendings p WHERE p.document_id=d.id AND p.status='pending') AS pend
       FROM req_documents d
       LEFT JOIN req_versions cv ON cv.id=d.current_version_id
       LEFT JOIN req_versions fv ON fv.id=d.final_version_id
       WHERE d.project_id=$1 ORDER BY d.doc_kind`,
      [projectId],
    );
    // 上游变更联动：PRD 挂「CRD 已变·待复核」派生标记（upstream-stale.ts 口径；CRD 恒 false）
    const prdStale = docs.rows.some((d) => d.doc_kind === 'prd' && d.cur !== null)
      ? await reqPrdStale(projectId)
      : { stale: false } as const;
    return {
      items: docs.rows.map((d) => ({
        id: d.id,
        kind: d.doc_kind.toUpperCase(),
        cur: d.cur ?? 0,
        finalVer: d.finalv ?? 0,
        finalized: !!d.final_version_id && d.final_version_id === d.current_version_id,
        modified: d.modified,
        pendingCount: Number(d.pend),
        version: d.cur ?? 0,
        ...(d.doc_kind === 'prd'
          ? { upstreamStale: prdStale.stale, ...('upstreamVersionNo' in prdStale ? { upstreamVersionNo: prdStale.upstreamVersionNo } : {}) }
          : {}),
      })),
    };
  }

  /** A04-2 文档详情（草稿视图；?v=n 查看历史版本只读） */
  async getDoc(projectId: string, kind: string, v?: number): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const cur = await this.currentVersion(null, doc);
    const draft = await this.loadDraft(null, doc.id);
    let secsContent = draft?.content ?? cur?.content ?? '';
    let viewing: number | null = null;
    if (v !== undefined && cur && v !== cur.version_no) {
      const ver = await query<VersionRow>(
        'SELECT * FROM req_versions WHERE document_id=$1 AND version_no=$2', [doc.id, v]);
      if (!ver.rows[0]) throw new DomainError('NOT_FOUND', '版本不存在', String(v));
      secsContent = ver.rows[0].content;
      viewing = v;
    }
    const refs = await query<{ parsed_id: string; content_fingerprint: string; name: string; file_id: string }>(
      `SELECT r.parsed_id, r.content_fingerprint, f.name, f.id AS file_id
       FROM req_doc_refs r JOIN mat_parsed p ON p.id=r.parsed_id JOIN mat_files f ON f.id=p.file_id
       WHERE r.document_id=$1 ORDER BY r.created_at`,
      [doc.id],
    );
    const pendings = await query<{ id: string; patch: EditPatch }>(
      "SELECT id, patch FROM req_pendings WHERE document_id=$1 AND status='pending' ORDER BY created_at, seq",
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
        ? (await query<{ version_no: number }>('SELECT version_no FROM req_versions WHERE id=$1', [doc.final_version_id])).rows[0]?.version_no ?? 0
        : 0,
      modified: doc.modified,
      genState: doc.gen_state,
      // 上游变更联动：PRD 打开时告知「CRD 已变·待复核」（DocPanel h1 徽标；upstream-stale.ts 口径）
      ...(kind === 'prd' ? await reqPrdStale(projectId).then((s) => ({
        upstreamStale: s.stale,
        ...(s.upstreamVersionNo !== undefined ? { upstreamVersionNo: s.upstreamVersionNo } : {}),
      })) : {}),
      secs,
      refs: refs.rows.map((r) => ({ fileId: r.file_id, name: r.name, fingerprint: `sha256:${r.content_fingerprint}` })),
      version: cur?.version_no ?? 0,
      contentFingerprint: `sha256:${effectiveFp}`,
      // W2-025：undo/redo 按钮态依栈实态（栈随草稿消亡，消亡后双不可用）
      canUndo: (draft?.undo_stack.length ?? 0) > 0,
      canRedo: (draft?.redo_stack.length ?? 0) > 0,
    };
  }

  /** A04-9 版本列表（历史只读） */
  async listVersions(projectId: string, kind: string): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const r = await query<VersionRow>(
      'SELECT * FROM req_versions WHERE document_id=$1 ORDER BY version_no DESC', [doc.id]);
    return {
      items: r.rows.map((x) => ({
        v: x.version_no,
        note: x.note,
        at: x.submitted_at,
        by: x.submitted_by,
        finalized: doc.final_version_id === x.id,
        readonly: true,
      })),
    };
  }

  /** A04-10 补丁查询（L2：含处置理由留痕） */
  async listPatches(projectId: string, kind: string): Promise<unknown> {
    const doc = await this.getDocRow(projectId, kind);
    const r = await query<{ id: string; patch: EditPatch; status: string; proposed_by: string; reason: string | null }>(
      'SELECT id, patch, status, proposed_by, reason FROM req_pendings WHERE document_id=$1 ORDER BY created_at, seq',
      [doc.id],
    );
    return {
      items: r.rows.map((x) => ({
        patchId: x.id,
        secId: x.patch.secId,
        type: x.patch.type,
        title: x.patch.title,
        old: x.patch.old,
        new: x.patch.new,
        status: x.status,
        source: x.proposed_by === 'assistant' ? 'ai' : x.proposed_by,
        reason: x.reason,
      })),
    };
  }

  // ---------- 命令入口（服务层薄封装） ----------

  async saveDraft(projectId: string, kind: 'crd' | 'prd', input: { secId: string; md: string; baseVersion: number; baseFingerprint: string }, ctx: CommandContext) {
    return executeCommand('doc.save-html', { projectId, kind, ...input }, { ...ctx, projectId });
  }
  /** 编辑态增节：在 secId 节下方插入（W-用户反馈：编辑态无法新增章节） */
  async addSection(projectId: string, kind: 'crd' | 'prd', input: { secId: string; title: string; md?: string; baseVersion: number; baseFingerprint: string }, ctx: CommandContext) {
    return executeCommand('doc.section.add', { projectId, kind, ...input }, { ...ctx, projectId });
  }
  /** 编辑态删节：整节移除（s0 文首不可删；至少保留一节） */
  async delSection(projectId: string, kind: 'crd' | 'prd', input: { secId: string; baseVersion: number; baseFingerprint: string }, ctx: CommandContext) {
    return executeCommand('doc.section.del', { projectId, kind, ...input }, { ...ctx, projectId });
  }
  async undo(projectId: string, kind: 'crd' | 'prd', ctx: CommandContext) {
    return executeCommand('doc.undo', { projectId, kind }, { ...ctx, projectId });
  }
  async redo(projectId: string, kind: 'crd' | 'prd', ctx: CommandContext) {
    return executeCommand('doc.redo', { projectId, kind }, { ...ctx, projectId });
  }
  async commit(projectId: string, kind: 'crd' | 'prd', note: string, baseVersion: number, ctx: CommandContext) {
    const r = await executeCommand('doc.commit-version', { projectId, kind, note, baseVersion }, { ...ctx, projectId }) as { noticeId?: string };
    // W2-033 口径：通知行在命令事务内落库，提交后补推 SSE
    if (r.noticeId) await this.notices?.pushExisting(r.noticeId);
    return r;
  }
  async switchVersion(projectId: string, kind: 'crd' | 'prd', v: number, ctx: CommandContext) {
    return executeCommand('doc.switch-version', { projectId, kind, v }, { ...ctx, projectId });
  }
  async finalize(projectId: string, kind: 'crd' | 'prd', v: number, baseVersion: number, confirm: boolean, ctx: CommandContext) {
    return executeCommand('req.doc.finalize', { projectId, kind, v, baseVersion, confirm }, { ...ctx, projectId });
  }
  async unlock(projectId: string, kind: 'crd' | 'prd', ctx: CommandContext) {
    return executeCommand('doc.unlock', { projectId, kind }, { ...ctx, projectId });
  }
  async acceptPatch(projectId: string, kind: 'crd' | 'prd', patchId: string, ctx: CommandContext, reason?: string, newText?: string) {
    return executeCommand('doc.accept-pending', {
      projectId, kind, patchId,
      ...(reason !== undefined ? { reason } : {}),
      ...(newText !== undefined ? { newText } : {}),
    }, { ...ctx, projectId });
  }
  async rejectPatch(projectId: string, kind: 'crd' | 'prd', patchId: string, ctx: CommandContext, reason?: string) {
    return executeCommand('doc.reject-pending', { projectId, kind, patchId, ...(reason !== undefined ? { reason } : {}) }, { ...ctx, projectId });
  }
  async addReference(projectId: string, kind: 'crd' | 'prd', fileId: string, ctx: CommandContext) {
    return executeCommand('doc.add-reference', { projectId, kind, fileId }, { ...ctx, projectId });
  }
  async removeReference(projectId: string, kind: 'crd' | 'prd', fileId: string, ctx: CommandContext) {
    return executeCommand('doc.remove-reference', { projectId, kind, fileId }, { ...ctx, projectId });
  }

  // ---------- 内部 ----------

  /** 首次建文档（ensure 供 import-draft 命令内用） */
  private async ensureDoc(client: PoolClient, projectId: string, kind: string, ctx: CommandContext): Promise<DocRow> {
    const r = await client.query<DocRow>(
      'SELECT * FROM req_documents WHERE project_id=$1 AND doc_kind=$2 FOR UPDATE', [projectId, kind]);
    if (r.rows[0]) return r.rows[0];
    const ins = await client.query<DocRow>(
      'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,$3) RETURNING *',
      [projectId, kind, ctx.actorId],
    );
    return ins.rows[0]!;
  }

  private async lockDoc(client: PoolClient, projectId: string, kind: string): Promise<DocRow> {
    const r = await client.query<DocRow>(
      'SELECT * FROM req_documents WHERE project_id=$1 AND doc_kind=$2 FOR UPDATE', [projectId, kind]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '文档不存在', kind);
    return r.rows[0];
  }

  /** #3：写路径不依赖 GET 懒建——无文档行先冪等 provisioning 再锁（D04-1 UNIQUE(project_id, doc_kind)） */
  private async lockOrCreateDoc(client: PoolClient, projectId: string, kind: string, ctx: CommandContext): Promise<DocRow> {
    await client.query(
      'INSERT INTO req_documents (project_id, doc_kind, created_by) VALUES ($1,$2,$3) ON CONFLICT (project_id, doc_kind) DO NOTHING',
      [projectId, kind, ctx.actorId],
    );
    return this.lockDoc(client, projectId, kind);
  }

  private async getDocRow(projectId: string, kind: string): Promise<DocRow> {
    const r = await query<DocRow>(
      'SELECT * FROM req_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, kind]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '文档不存在', kind);
    return r.rows[0];
  }

  private async currentVersion(client: PoolClient | null, doc: DocRow): Promise<VersionRow | null> {
    if (!doc.current_version_id) return null;
    const q = client ? client.query.bind(client) : query;
    const r = await q<VersionRow>('SELECT * FROM req_versions WHERE id=$1', [doc.current_version_id]);
    return r.rows[0] ?? null;
  }

  private async loadDraft(client: PoolClient | null, docId: string): Promise<DraftRow | null> {
    const q = client ? client.query.bind(client) : query;
    const r = await q<DraftRow>('SELECT * FROM req_drafts WHERE document_id=$1', [docId]);
    return r.rows[0] ?? null;
  }

  private async requireDraft(client: PoolClient, docId: string): Promise<DraftRow> {
    const d = await this.loadDraft(client, docId);
    if (!d) throw new DomainError('INVALID_STATE', '无工作草稿', docId);
    return d;
  }

  /** 定稿态一切内容命令拒绝（VERSION_LOCKED）；单写者锁（REQ-210/BR-12） */
  private assertEditable(doc: DocRow, ctx: CommandContext): void {
    if (doc.final_version_id && doc.final_version_id === doc.current_version_id) {
      throw new DomainError('VERSION_LOCKED', '已定稿文档不可原地修改（修改=新草稿→新版本）', doc.id);
    }
    if (doc.lock_owner && doc.lock_owner !== ctx.actorId) {
      throw new DomainError('VERSION_CONFLICT', `文档由 ${doc.lock_owner} 编辑中`, doc.id);
    }
  }

  /** 乐观锁：版本号 + 有效内容指纹双重校验（REQ-210；baseFingerprint 前缀 sha256: 可选） */
  private assertLock(baseVersion: number, baseFingerprint: string, cur: VersionRow | null, effective: string): void {
    if ((cur?.version_no ?? 0) !== baseVersion) {
      throw new DomainError('VERSION_CONFLICT', '版本号已变化，请刷新后重试', String(baseVersion));
    }
    const fp = baseFingerprint.replace(/^sha256:/, '');
    if (fp !== sha256Text(effective)) {
      throw new DomainError('VERSION_CONFLICT', '内容指纹不一致，存在并发修改', 'contentFingerprint');
    }
  }

  /** 草稿基点校验（DRAFT_BASE_MISMATCH）+ 写草稿（undo 入栈/清 redo/单写者锁/modified） */
  private async writeDraft(
    client: PoolClient,
    doc: DocRow,
    cur: VersionRow | null,
    draft: DraftRow | null,
    content: string,
    ctx: CommandContext,
  ): Promise<void> {
    if (!cur) throw new DomainError('INVALID_STATE', '文档无基点版本', doc.id);
    const effective = draft?.content ?? cur.content;
    if (draft) {
      const base = await client.query<VersionRow>('SELECT * FROM req_versions WHERE id=$1', [draft.base_version_id]);
      if (!base.rows[0] || base.rows[0].content_fingerprint !== draft.base_content_fingerprint) {
        throw new DomainError('DRAFT_BASE_MISMATCH', '草稿基点版本指纹不符', doc.id);
      }
      const undo = [...draft.undo_stack, effective].slice(-UNDO_LIMIT);
      await client.query(
        'UPDATE req_drafts SET content=$2, undo_stack=$3, redo_stack=$4, updated_by=$5, updated_at=now() WHERE id=$1',
        [draft.id, content, JSON.stringify(undo), '[]', ctx.actorId],
      );
    } else {
      await client.query(
        `INSERT INTO req_drafts (document_id, base_version_id, base_content_fingerprint, content, undo_stack, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [doc.id, cur.id, cur.content_fingerprint, content, JSON.stringify([cur.content]), ctx.actorId],
      );
    }
    await client.query(
      'UPDATE req_documents SET modified=true, lock_owner=$2, lock_at=now(), updated_by=$2, updated_at=now() WHERE id=$1',
      [doc.id, ctx.actorId],
    );
  }

  /** 追加不可变版本（v=max+1；governing_fingerprint=参考集合+上游 CRD 定稿指纹，BR-02） */
  private async appendVersion(
    client: PoolClient,
    doc: DocRow,
    content: string,
    note: string,
    ctx: CommandContext,
  ): Promise<VersionRow> {
    const max = await client.query<{ v: number | null }>(
      'SELECT max(version_no) AS v FROM req_versions WHERE document_id=$1', [doc.id]);
    const vno = (max.rows[0]?.v ?? 0) + 1;
    const refs = await client.query<{ parsed_id: string; content_fingerprint: string }>(
      'SELECT parsed_id, content_fingerprint FROM req_doc_refs WHERE document_id=$1 ORDER BY created_at', [doc.id]);
    let upstream: string | null = null;
    if (doc.doc_kind === 'prd') {
      const crd = await client.query<{ content_fingerprint: string }>(
        `SELECT v.content_fingerprint FROM req_documents d JOIN req_versions v ON v.id=d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind='crd'`, [doc.project_id]);
      upstream = crd.rows[0]?.content_fingerprint ?? null;
    }
    const governing = fingerprint({
      refs: refs.rows.map((r) => ({ parsedId: r.parsed_id, fp: r.content_fingerprint })),
      upstreamCrd: upstream,
    });
    const r = await client.query<VersionRow>(
      `INSERT INTO req_versions (document_id, version_no, content, content_fingerprint, governing_fingerprint, refs, note, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [doc.id, vno, content, sha256Text(content), governing,
        JSON.stringify(refs.rows.map((x) => ({ parsedId: x.parsed_id, fingerprint: `sha256:${x.content_fingerprint}` }))),
        note, ctx.actorId],
    );
    return r.rows[0]!;
  }

  private async assertNoPendings(client: PoolClient, docId: string): Promise<void> {
    const r = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM req_pendings WHERE document_id=$1 AND status='pending'", [docId]);
    if (Number(r.rows[0]?.n ?? 0) > 0) {
      throw new DomainError('INVALID_STATE', '存在待确认补丁，须先逐条处理', docId);
    }
  }

  /**
   * RTM 派生链重建（commit 同事务）：按两文档当前提交版本内容重扫锚点，
   * 删旧派生行（refines/implements）插新行；人工标记行（deferred/dropped 自指）不动。
   */
  private async rebuildRtmLinks(client: PoolClient, projectId: string, ctx: CommandContext): Promise<void> {
    const docs = await client.query<{ doc_kind: string; content: string | null }>(
      `SELECT d.doc_kind, v.content FROM req_documents d
       LEFT JOIN req_versions v ON v.id=d.current_version_id WHERE d.project_id=$1`, [projectId]);
    const crd = docs.rows.find((d) => d.doc_kind === 'crd')?.content ?? '';
    const prd = docs.rows.find((d) => d.doc_kind === 'prd')?.content ?? '';
    const { links } = deriveLinks(crd, prd, await designContents(client, projectId));
    await client.query(
      "DELETE FROM rtm_links WHERE project_id=$1 AND relation IN ('refines','implements')", [projectId]);
    for (const l of links) {
      await client.query(
        `INSERT INTO rtm_links (project_id, from_kind, from_code, to_kind, to_code, relation, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [projectId, l.fromKind, l.fromCode, l.toKind, l.toCode, l.relation, ctx.actorId],
      );
    }
  }

  /** F06 实时重算 + rtm_health 度量留痕（append-only）；返回健康度结果 */
  private async measureHealth(client: PoolClient, projectId: string, ctx: CommandContext) {
    const health = await this.computeLiveHealth(client, projectId);
    await client.query(
      `INSERT INTO rtm_health (project_id, l0a, l0b, l0c, l0d, deferred_items, gaps, passed, basis_fingerprint, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [projectId, health.l0a, health.l0b, health.l0c, health.l0d,
        JSON.stringify(health.deferredItems), JSON.stringify(health.gaps), health.ok,
        health.basisFingerprint, ctx.actorId],
    );
    return health;
  }

  /** 两文档当前提交版本全文（RTM 派生与导出的公共输入） */
  async currentContents(client: PoolClient | null, projectId: string): Promise<{ crd: string; prd: string }> {
    const q = client ? client.query.bind(client) : query;
    const docs = await q<{ doc_kind: string; content: string | null }>(
      `SELECT d.doc_kind, v.content FROM req_documents d
       LEFT JOIN req_versions v ON v.id=d.current_version_id WHERE d.project_id=$1`, [projectId]);
    return {
      crd: docs.rows.find((d) => d.doc_kind === 'crd')?.content ?? '',
      prd: docs.rows.find((d) => d.doc_kind === 'prd')?.content ?? '',
    };
  }

  /**
   * 实时健康度（F06-7 实算不用缓存值）：节点集从当前提交版本内容重扫（含未被承接的孤立节点），
   * 链与 deferred 标记取 rtm_links 当前全集。
   * W2-029 盲区显性化：R 层权威=CRD 承接锚点（规格如此，分母不变）——但内容定稿参考资料中的
   * 诉求编码（FR-/NFR-/R- 形）若未在 CRD 出现即「漏承接隐身」（不进分母、L0a 虚高），
   * 此类编码以 warning 显性列出（告警不阻断，引导人工核对回补）。
   * 反向指针：design/generate.service.ts l0cGaps 为本函数缺口段的同族镜像（platform 纯函数+SQL 直读，
   * req 域零写入），改 gaps 口径（缺口码/分母/deferred 处理）须同步。
   */
  async computeLiveHealth(client: PoolClient | null, projectId: string) {
    const { crd, prd } = await this.currentContents(client, projectId);
    const designDocs = await designContents(client, projectId);
    const { nodes } = deriveLinks(crd, prd, designDocs);
    const q = client ? client.query.bind(client) : query;
    const links = await q<{ from_kind: string; from_code: string; to_kind: string; to_code: string; relation: string }>(
      'SELECT from_kind, from_code, to_kind, to_code, relation FROM rtm_links WHERE project_id=$1', [projectId]);
    const health = computeHealth(nodes, links.rows);
    // 过度设计反向筛查（设计覆盖检测与可交互原型 §1）：设计册内容跨域 SQL 直读（designContents 同口径），
    // 逐册扫「无 REQ 回引的锚点条目节」入候选；exempted=deferred/dropped 自指行中 from_kind='dsg'
    // 的码集（人工豁免、理由必填；候选剔除在呈现层，服务端原样返回两边）
    const overdesign = {
      candidates: designDocs.flatMap((d) => scanOverdesign(d.book, d.content)),
      exempted: [...new Set(
        links.rows
          .filter((l) => (l.relation === 'deferred' || l.relation === 'dropped') && l.from_kind === 'dsg')
          .map((l) => l.from_code),
      )].sort(),
    };
    // 盲区扫描：全部内容定稿参考资料的诉求编码 vs CRD 全文
    const refs = await q<{ body_md: string }>(
      `SELECT p.body_md FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
       WHERE f.project_id=$1 AND p.kind='content_parse' AND p.status='final'`, [projectId]);
    if (refs.rows.length > 0 && crd) {
      const missing = new Set<string>();
      for (const r of refs.rows) {
        for (const m of r.body_md.matchAll(/\b(?:FR|NFR|R)-\d{2,3}\b/g)) {
          if (!crd.includes(m[0])) missing.add(m[0]);
        }
      }
      if (missing.size > 0) {
        const list = [...missing].sort();
        health.warnings.push(
          `参考资料诉求码 ${list.length} 个未在 CRD 出现（${list.slice(0, 8).join('、')}${list.length > 8 ? ' 等' : ''}）——` +
          'R 层以 CRD 承接锚点为权威，漏承接不计入 L0a 分母（不告警即隐身），请核对是否漏写承接章节',
        );
      }
    }
    return { ...health, overdesign };
  }

  /** INV-DOC 发布前不变式断言（违反即抛错 → 命令整体回滚） */
  private async assertInvariants(client: PoolClient, docId: string): Promise<void> {
    const d = await client.query<DocRow & { draftId: string | null }>(
      `SELECT d.*, (SELECT id FROM req_drafts WHERE document_id=d.id) AS "draftId"
       FROM req_documents d WHERE d.id=$1`, [docId]);
    const doc = d.rows[0]!;
    // INV-DOC-4：draft===null ⟺ modified===false
    if ((doc.draftId === null) !== (doc.modified === false)) {
      throw new DomainError('INTERNAL', 'INV-DOC-4 违反：draft 与 modified 不一致', docId);
    }
    // INV-DOC-6a：版本号唯一连续（UNIQUE 约束兜底，此处断言无断号）
    const vs = await client.query<{ version_no: number }>(
      'SELECT version_no FROM req_versions WHERE document_id=$1 ORDER BY version_no', [docId]);
    vs.rows.forEach((row, i) => {
      if (row.version_no !== i + 1) throw new DomainError('INTERNAL', 'INV-DOC-6a 违反：版本号断链', docId);
    });
  }
}
