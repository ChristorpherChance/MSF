import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { sha256Text, splitSections } from '../platform/doc-sections.js';
import { DesignDocsService } from './docs.service.js';

/**
 * 原型规划与设计目录（A05-4/5/12/13；REQ-304/312；F02-2 plan 阶段）。
 * 识别口径（mock）：从已定稿 PRD 的 REQ-xxx 章节派生页面条目（一章一页 + 固定骨架页/流程/状态/角色/视口），
 * 追溯引用挂 PRD 章节锚点（rule_text 快照 + ref_fingerprint，供来源审计实时比对）。
 * 人工增删（A05-13）：manual 标记、识别条目不可直删；目录变化 → 新 catalog_version → 旧规划 PLAN_STALE。
 */

/** 来源审计规则集版本（REQ-312 版本化；规则变更即升版） */
export const RULESET_VERSION = 'src-rules-1';

const FIXED_VIEWPORTS = ['1280', '1440', '1920'];
const FIXED_ROLES = ['visitor', 'user', 'admin'];

interface CatalogItemRow {
  id: string;
  item_type: string;
  code: string;
  payload: Record<string, unknown>;
  required: boolean;
  source: 'identified' | 'manual';
  content_fingerprint: string;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DesignDocsService) private readonly docs: DesignDocsService) {}

  onModuleInit(): void {
    // design.prototype.plan：门禁=PRD 已定稿；登记规划快照（目录+追溯+governing 指纹）
    registerCommand('design.prototype.plan', async (client, payload, ctx) => {
      const { projectId } = payload as { projectId: string };
      const up = await this.docs.upstreamFingerprint(client, projectId, 'prd');
      if (!up.ok) {
        throw new DomainError('GATE_BLOCKED', `原型规划前置：${up.missing.join('、')} 已定稿`, up.missing[0]);
      }
      const governing = up.fingerprint!;
      // W2-052：plan_no 计数与目录版本 V3-n 递增同属 check-then-act——同键串行化整个临界区
      await lockCodeGen(client, `msf:code:catalog:${projectId}`);
      const planNo = await client.query<{ n: string }>(
        'SELECT count(*) AS n FROM dsg_plans WHERE project_id=$1', [projectId]);
      // 目录版本与人工增删共用同一递增序列（V3-n），plan 取下一号
      const catalogVersion = await this.nextCatalogVersion(client, projectId);

      // mock 识别：PRD 定稿内容的 REQ-xxx 章节 → 页面条目 + 追溯引用
      const prd = await client.query<{ content: string }>(
        `SELECT v.content FROM req_documents d JOIN req_versions v ON v.id=d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind='prd'`, [projectId]);
      const secs = splitSections(prd.rows[0]?.content ?? '');
      const reqSecs = secs.filter((s) => /\bREQ-\d{3}\b/.test(s.title));

      // U-019：页面粒度优先锚已定稿 UI 册的页面清单章节（标题含「页面/界面」的章节），
      // 页面数随 UI 册设计口径而非 REQ 条数；UI 册未定稿或无页面章节时回退「PRD 一章一页」
      const uiDoc = await client.query<{ content: string }>(
        `SELECT v.content FROM dsg_documents d JOIN dsg_versions v ON v.id=d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
      const uiSecs = splitSections(uiDoc.rows[0]?.content ?? '')
        .filter((s) => s.title && /(页面|界面|页\s*$)/.test(s.title));
      const pageSeeds: Array<{ title: string; reqIds: string[] }> = uiSecs.length > 0
        ? uiSecs.map((s) => ({
            title: s.title,
            reqIds: [...new Set([...`${s.title}\n${s.md}`.matchAll(/\bREQ-\d{3}\b/g)].map((m) => m[0]))],
          }))
        : reqSecs.map((s) => ({
            title: s.title.replace(/^REQ-\d{3}\s*/, ''),
            reqIds: [(/\bREQ-\d{3}\b/.exec(s.title))![0]],
          }));

      interface ItemSeed { type: string; code: string; payload: Record<string, unknown>; required: boolean; source?: string }
      const items: ItemSeed[] = [
        ...pageSeeds.map((p, i) => ({
          type: 'page',
          code: `P-${String(i + 1).padStart(3, '0')}`,
          payload: { title: p.title, route: `/p${i + 1}`, reqIds: p.reqIds },
          required: true,
        })),
        { type: 'page', code: 'P-HOME', payload: { title: '首页', route: '/', reqIds: [] }, required: true },
        { type: 'flow', code: 'F-001', payload: { title: '主流程', steps: reqSecs.map((s) => s.title) }, required: true },
        { type: 'state', code: 'ST-default', payload: { title: '默认态' }, required: true },
        { type: 'state', code: 'ST-empty', payload: { title: '空态' }, required: false },
        ...FIXED_ROLES.map((r) => ({ type: 'role', code: r, payload: { title: r }, required: false })),
        ...FIXED_VIEWPORTS.map((v) => ({ type: 'viewport', code: `vp-${v}`, payload: { width: Number(v) }, required: false })),
      ];

      // W7-002：人工增项随行——重新规划不得丢 source='manual' 条目
      // （旧口径 plan 全量重导派生项，人工加的页面/流程在 re-plan 后静默消失，
      //   检查报告因计划与生成同源而照样 pass，用户意图被静默吞掉）。
      // 按 type+code 去重：同码以派生（identified）口径为准。
      const prevCatVer = await this.currentCatalogVersion(client, projectId);
      if (prevCatVer) {
        const manual = await client.query<{ item_type: string; code: string; payload: Record<string, unknown>; required: boolean }>(
          `SELECT item_type, code, payload, required FROM dsg_catalog_items
           WHERE project_id=$1 AND catalog_version=$2 AND source='manual'`,
          [projectId, prevCatVer]);
        for (const m of manual.rows) {
          if (!items.some((i) => i.type === m.item_type && i.code === m.code)) {
            items.push({ type: m.item_type, code: m.code, payload: m.payload, required: m.required, source: 'manual' });
          }
        }
      }

      const itemIds: string[] = [];
      for (const it of items) {
        const fp = sha256Text(JSON.stringify(it.payload));
        const r = await client.query<{ id: string }>(
          `INSERT INTO dsg_catalog_items (project_id, catalog_version, item_type, code, payload, required, source, content_fingerprint, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [projectId, catalogVersion, it.type, it.code, JSON.stringify(it.payload), it.required, it.source ?? 'identified', fp, ctx.actorId],
        );
        itemIds.push(r.rows[0]!.id);
        // REQ 章节来源的页面挂追溯引用（锚点=PRD 章节）
        const reqIds = (it.payload.reqIds as string[] | undefined) ?? [];
        for (const reqCode of reqIds) {
          const sec = reqSecs.find((s) => s.title.includes(reqCode));
          if (sec) {
            await client.query(
              `INSERT INTO dsg_catalog_refs (item_id, ref_kind, doc_kind, section_id, anchor, rule_text, ref_fingerprint, ruleset_version)
               VALUES ($1,'prd','prd',$2,$3,$4,$5,$6)`,
              [r.rows[0]!.id, sec.id, sec.title, sec.md.slice(0, 500), sha256Text(sec.md), RULESET_VERSION],
            );
          }
        }
      }

      const catFp = fingerprint({ catalogVersion, items: itemIds });
      const snapshot = { catalogVersion, itemCount: items.length, items: items.map((i) => ({ type: i.type, code: i.code })) };
      const planFp = fingerprint({ catalogVersion, governing, snapshot });
      const plan = await client.query<{ id: string; plan_no: number }>(
        `INSERT INTO dsg_plans (project_id, plan_no, catalog_version, catalog_fingerprint, governing_fingerprint, snapshot, complete, plan_fingerprint, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id, plan_no`,
        [projectId, Number(planNo.rows[0]?.n ?? 0) + 1, catalogVersion, catFp, governing, JSON.stringify(snapshot), planFp, ctx.actorId],
      );
      return {
        planId: plan.rows[0]!.id,
        complete: true,
        basedOn: { governingFingerprint: `sha256:${governing}` },
        fingerprint: `sha256:${planFp}`,
      };
    });

    // A05-13 人工补充目录条目（source=manual；catalog_version 递增）
    registerCommand('design.catalog.add-item', async (client, payload, ctx) => {
      const { projectId, itemType, code, title, note } = payload as {
        projectId: string; itemType: string; code: string; title: string; note?: string;
      };
      if (!title?.trim()) throw new DomainError('VALIDATION_FAILED', '条目标题必填', 'title');
      // W2-052：目录版本递增属 check-then-act——咨询锁串行化「取版本→复制→插入」临界区
      await lockCodeGen(client, `msf:code:catalog:${projectId}`);
      const ver = await this.nextCatalogVersion(client, projectId);
      const curVer = await this.currentCatalogVersion(client, projectId);
      // 复制上一版全部条目到新版本（目录版本化：增删=新版本）
      await client.query(
        `INSERT INTO dsg_catalog_items (project_id, catalog_version, item_type, code, payload, required, source, content_fingerprint, created_by)
         SELECT project_id, $2, item_type, code, payload, required, source, content_fingerprint, $3
         FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$4`,
        [projectId, ver, ctx.actorId, curVer],
      );
      // 追溯引用随行迁移到新版本条目（按 type+code 对齐；REQ-312 审计链不断）
      await client.query(
        `INSERT INTO dsg_catalog_refs (item_id, ref_kind, doc_kind, section_id, anchor, rule_text, ref_fingerprint, ruleset_version)
         SELECT n.id, r.ref_kind, r.doc_kind, r.section_id, r.anchor, r.rule_text, r.ref_fingerprint, r.ruleset_version
         FROM dsg_catalog_refs r
         JOIN dsg_catalog_items o ON o.id=r.item_id
         JOIN dsg_catalog_items n ON n.project_id=o.project_id AND n.catalog_version=$2
           AND n.item_type=o.item_type AND n.code=o.code
         WHERE o.project_id=$1 AND o.catalog_version=$3`,
        [projectId, ver, curVer],
      );
      const itemPayload = { title, note: note ?? '', verify: 'manual' };
      const r = await client.query<{ id: string }>(
        `INSERT INTO dsg_catalog_items (project_id, catalog_version, item_type, code, payload, required, source, content_fingerprint, created_by)
         VALUES ($1,$2,$3,$4,$5,false,'manual',$6,$7) RETURNING id`,
        [projectId, ver, itemType, code, JSON.stringify(itemPayload), sha256Text(JSON.stringify(itemPayload)), ctx.actorId],
      );
      return { itemId: r.rows[0]!.id, source: 'manual', catalogVersion: ver };
    });

    registerCommand('design.catalog.remove-item', async (client, payload, ctx) => {
      const { projectId, itemId } = payload as { projectId: string; itemId: string };
      const item = await client.query<CatalogItemRow & { catalog_version: string }>(
        'SELECT * FROM dsg_catalog_items WHERE id=$1 AND project_id=$2', [itemId, projectId]);
      const row = item.rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '目录条目不存在', itemId);
      if (row.source !== 'manual') {
        throw new DomainError('INVALID_STATE', '识别条目须走来源文档修订→重新识别路径，不可直删', itemId);
      }
      // W2-052：目录版本递增属 check-then-act——咨询锁串行化「取版本→复制」临界区
      await lockCodeGen(client, `msf:code:catalog:${projectId}`);
      const ver = await this.nextCatalogVersion(client, projectId);
      await client.query(
        `INSERT INTO dsg_catalog_items (project_id, catalog_version, item_type, code, payload, required, source, content_fingerprint, created_by)
         SELECT project_id, $2, item_type, code, payload, required, source, content_fingerprint, $3
         FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$4 AND id!=$5`,
        [projectId, ver, ctx.actorId, row.catalog_version, itemId],
      );
      // 追溯引用随行迁移（被删条目的引用一并消失）
      await client.query(
        `INSERT INTO dsg_catalog_refs (item_id, ref_kind, doc_kind, section_id, anchor, rule_text, ref_fingerprint, ruleset_version)
         SELECT n.id, r.ref_kind, r.doc_kind, r.section_id, r.anchor, r.rule_text, r.ref_fingerprint, r.ruleset_version
         FROM dsg_catalog_refs r
         JOIN dsg_catalog_items o ON o.id=r.item_id
         JOIN dsg_catalog_items n ON n.project_id=o.project_id AND n.catalog_version=$2
           AND n.item_type=o.item_type AND n.code=o.code
         WHERE o.project_id=$1 AND o.catalog_version=$3`,
        [projectId, ver, row.catalog_version],
      );
      return { removed: itemId, catalogVersion: ver };
    });
  }

  /** A05-5 plan 命令入口 */
  async plan(projectId: string, ctx: CommandContext) {
    return executeCommand('design.prototype.plan', { projectId }, { ...ctx, projectId });
  }

  async addItem(projectId: string, input: { itemType: string; code: string; title: string; note?: string }, ctx: CommandContext) {
    return executeCommand('design.catalog.add-item', { projectId, ...input }, { ...ctx, projectId });
  }

  async removeItem(projectId: string, itemId: string, ctx: CommandContext) {
    return executeCommand('design.catalog.remove-item', { projectId, itemId }, { ...ctx, projectId });
  }

  /** A05-4 目录查询（最新版本分组；L8：条目带追溯锚点 anchors——「每项可追溯到具体文档章节锚点」） */
  async getCatalog(projectId: string): Promise<unknown> {
    const ver = await this.currentCatalogVersion(null, projectId);
    if (!ver) return { catalogVersion: null, catalogFingerprint: null, groups: {} };
    const items = await query<CatalogItemRow>(
      'SELECT * FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY item_type, code',
      [projectId, ver],
    );
    const refs = await query<{ item_id: string; ref_kind: string; doc_kind: string | null; section_id: string | null; anchor: string | null }>(
      `SELECT r.item_id, r.ref_kind, r.doc_kind, r.section_id, r.anchor FROM dsg_catalog_refs r
       JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version=$2 ORDER BY r.ref_kind, r.doc_kind, r.section_id`,
      [projectId, ver],
    );
    const anchorsByItem = new Map<string, Array<{ refKind: string; docKind: string | null; sectionId: string | null; anchor: string | null }>>();
    for (const r of refs.rows) {
      (anchorsByItem.get(r.item_id) ?? anchorsByItem.set(r.item_id, []).get(r.item_id)!).push({
        refKind: r.ref_kind, docKind: r.doc_kind, sectionId: r.section_id, anchor: r.anchor,
      });
    }
    const groups: Record<string, unknown[]> = {};
    for (const it of items.rows) {
      (groups[it.item_type] ??= []).push({
        itemId: it.id, code: it.code, payload: it.payload, required: it.required, source: it.source,
        anchors: anchorsByItem.get(it.id) ?? [],
      });
    }
    const fp = fingerprint({ catalogVersion: ver, items: items.rows.map((i) => i.id) });
    return { catalogVersion: ver, catalogFingerprint: `sha256:${fp}`, groups };
  }

  /** A05-12 来源审计：refs 锚点指纹 vs 现行定稿文档内容实时比对（REQ-312 双向） */
  async sourceAudit(projectId: string): Promise<unknown> {
    const refs = await query<{
      id: string; item_id: string; code: string; doc_kind: string | null; section_id: string | null;
      anchor: string | null; rule_text: string | null; ref_fingerprint: string;
    }>(
      `SELECT r.*, i.code FROM dsg_catalog_refs r
       JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version=$2`,
      [projectId, (await this.currentCatalogVersion(null, projectId)) ?? ''],
    );
    const issues: Array<{ code: string; target: string; message: string }> = [];
    for (const ref of refs.rows) {
      const table = ref.doc_kind === 'prd' || ref.doc_kind === 'crd' ? 'req' : 'dsg';
      const r = await query<{ content: string }>(
        `SELECT v.content FROM ${table}_documents d JOIN ${table}_versions v ON v.id=d.final_version_id
         WHERE d.project_id=$1 AND d.doc_kind=$2`,
        [projectId, ref.doc_kind],
      );
      const content = r.rows[0]?.content;
      if (!content) {
        issues.push({ code: 'SOURCE_SEMANTIC_UNVERIFIED', target: ref.code, message: `来源文档 ${ref.doc_kind} 无定稿版本（上游删除或未定稿）` });
        continue;
      }
      const sec = splitSections(content).find((s) => s.id === ref.section_id || s.title === ref.section_id);
      if (!sec) {
        issues.push({ code: 'SOURCE_SEMANTIC_UNVERIFIED', target: ref.code, message: `锚点 ${ref.anchor ?? ref.section_id} 已不存在` });
        continue;
      }
      if (sha256Text(sec.md) !== ref.ref_fingerprint) {
        issues.push({ code: 'SOURCE_SEMANTIC_UNVERIFIED', target: ref.code, message: `锚点 ${ref.anchor ?? ref.section_id} 内容已变化（与建立时快照不符）` });
      }
    }
    return { rulesVersion: RULESET_VERSION, ok: issues.length === 0, issues };
  }

  /** 当前（最新）目录版本 */
  async currentCatalogVersion(client: import('pg').PoolClient | null, projectId: string): Promise<string | null> {
    const q = client ? client.query.bind(client) : query;
    const r = await q<{ v: string }>(
      'SELECT catalog_version AS v FROM dsg_catalog_items WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1',
      [projectId]);
    return r.rows[0]?.v ?? null;
  }

  private async nextCatalogVersion(client: import('pg').PoolClient, projectId: string): Promise<string> {
    const cur = await this.currentCatalogVersion(client, projectId);
    if (!cur) return 'V3-1';
    const n = Number(cur.replace('V3-', '')) || 0;
    return `V3-${n + 1}`;
  }
}
