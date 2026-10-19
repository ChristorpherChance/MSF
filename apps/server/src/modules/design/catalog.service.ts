import { Inject, Injectable } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { sha256Text, splitSections, type DocSection } from '../platform/doc-sections.js';
import { DesignDocsService } from './docs.service.js';
import { UI_PAGE_SECTION_RE } from './prototype-pages.js';

/**
 * 原型规划与设计目录（A05-4/5/12/13；REQ-304/312；F02-2 plan 阶段）。
 * 识别口径（mock）：从已定稿 PRD 的 REQ-xxx 章节派生页面条目（一章一页 + 固定骨架页/流程/状态/角色/视口），
 * 追溯引用挂 PRD 章节锚点（rule_text 快照 + ref_fingerprint，供来源审计实时比对）。
 * 人工增删（A05-13）：manual 标记、识别条目不可直删；目录变化 → 新 catalog_version
 * （编辑不自动反映到汇总原型，需 re-plan；finalize 门禁以目录指纹比对强制改后重跑 check）。
 */

/** 目录指纹（code 基口径，S-2 终审修法单点）：条目 id 随目录版本轮换不稳定，code 跨版本稳定；
 *  codes 排序后入指纹防查询序漂移。check 落库/finalize CHECK_STALE 比对/目录查询三面同源。 */
export function catalogFingerprintOf(catalogVersion: string, codes: string[]): string {
  return fingerprint({ catalogVersion, items: [...codes].sort() });
}

/** 来源审计规则集版本（REQ-312 版本化；规则变更即升版） */
export const RULESET_VERSION = 'src-rules-1';

/**
 * re-plan 随行字段（覆盖检测 §2）：派生条目（source≠'manual'）上允许人工修改、
 * 且 re-plan 全量重导时按 type+code 迁移保留的 payload 键。
 * 对照维护：design.catalog.update-item 可改字段清单（title/note/payload.steps/payload.exempt/verified）
 * 中凡落 payload 的键都必须在本常量内，否则 re-plan 丢人工调整。
 * （例外：verified 落 payload.verify，仅人工条目持有——人工条目随行=整 payload 迁移，天然保留，故不入本常量。）
 * 2026-10-17 补齐 title/note：此前只随行 steps/exempt——title/note 可编辑却不随行，
 * re-plan 静默回滚人工改题（且与幂等复用相乘：改题过的目录永远等不出「逐条全同」，
 * 每次 re-plan 都无谓递增版本作废页工件）。用户显式改题=覆盖意图，随行优先于派生值。
 */
const CARRIED_PAYLOAD_KEYS = ['title', 'note', 'steps', 'exempt'] as const;

const FIXED_VIEWPORTS = ['1280', '1440', '1920'];
const FIXED_ROLES = ['visitor', 'user', 'admin'];

/**
 * 条目 payload 指纹·canonical 化（2026-10-17 根修）：PG jsonb 回读重排键序（按键长+字典序），
 * 裸 JSON.stringify 指纹随写入路径漂移——update-item 以 jsonb 回读为基的 merged（steps 前 title 后）
 * vs plan 派生新对象字面量（title 前 steps 后），同内容指纹不同，幂等复用/reconcile 全失效。
 * 统一递归排序键后序列化取指纹：写入路径无关。存量行 content_fingerprint 是旧口径，
 * 比对一律从 payload 现算（不读列），新旧行兼容。
 */
function canonicalPayloadFp(payload: Record<string, unknown>): string {
  const sortVal = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortVal);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, vv]) => [k, sortVal(vv)]),
      );
    }
    return v;
  };
  return sha256Text(JSON.stringify(sortVal(payload)));
}

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
      // 目录版本号在派生比对后按需取（幂等复用不消耗新号——见下「幂等复用」段）

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
        .filter((s) => s.title && UI_PAGE_SECTION_RE.test(s.title));

      // 上一版目录提前加载：ui 派生页码锚定（差异55a）与人工字段随行（W7-002）都要以它为基
      const prevCatVer = await this.currentCatalogVersion(client, projectId);
      let prevItemsAll: CatalogItemRow[] = [];
      if (prevCatVer) {
        const prevItems = await client.query<CatalogItemRow>(
          `SELECT id, item_type, code, payload, required, source, content_fingerprint FROM dsg_catalog_items
           WHERE project_id=$1 AND catalog_version=$2`,
          [projectId, prevCatVer]);
        prevItemsAll = prevItems.rows;
      }

      // 差异55a 根修：ui 派生页以「来源章节锚点」为身份派码（旧口径按文档位次 P-001..——ui 册
      // 页面章节重排/中段插入后位次漂移，旧页 title/note 按 type+code 贴错新页，ui 追溯引用
      // 同挂错章节）。锚点=ui 章节标题（refs anchor 列同口径；DocSection.id 是位置性 id，
      // 重切分即重派，不堪身份）。码分配按种子顺序：
      //   ① payload.uiAnchor 精确命中旧页 → 沿用旧码（人工修订的 title/note 随码贴回正确的页）；
      //   ② 旧版无 uiAnchor 的存量识别页按「标题精确→同位次」认领（本修复上线后首跑迁移：
      //     旧口径位次派码故码序=文档位次，位次认领零改动承接既有目录——码不漂、页工件不作废）；
      //   ③ 新锚点取最小空闲 P-nnn；上一版在用的码一律保留不复用（随行合并只从上一版贴
      //     人工字段，码若被无关新页领走会把旧页修订贴错；更老版本的码随行够不着，复用无害）。
      const prevPages = prevItemsAll.filter((r) => r.item_type === 'page');
      const anchorPool = new Map<string, CatalogItemRow[]>();
      // 迁移认领池：仅旧口径位次码（P-nnn）的识别页——P-HOME 骨架页/人工页不在其列
      // （P-HOME 由固定骨架恒驻，被内容页领走会同码撞车）
      const legacyPool: CatalogItemRow[] = [];
      for (const p of prevPages) {
        const a = p.payload.uiAnchor;
        if (typeof a === 'string' && a) (anchorPool.get(a) ?? anchorPool.set(a, []).get(a)!).push(p);
        else if (p.source !== 'manual' && /^P-\d+$/.test(p.code)) legacyPool.push(p);
      }
      legacyPool.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      const usedCodes = new Set(prevPages.map((p) => p.code));
      const allocCode = (): string => {
        for (let n = 1; ; n++) {
          const c = `P-${String(n).padStart(3, '0')}`;
          if (!usedCodes.has(c)) { usedCodes.add(c); return c; }
        }
      };
      const pageSeeds: Array<{ title: string; reqIds: string[]; uiSec?: DocSection; code?: string }> = uiSecs.length > 0
        ? uiSecs.map((s) => ({
            title: s.title,
            reqIds: [...new Set([...`${s.title}\n${s.md}`.matchAll(/\bREQ-\d{3}\b/g)].map((m) => m[0]))],
            uiSec: s,
          }))
        : reqSecs.map((s) => ({
            title: s.title.replace(/^REQ-\d{3}\s*/, ''),
            reqIds: [(/\bREQ-\d{3}\b/.exec(s.title))![0]],
          }));
      if (uiSecs.length > 0) {
        const legacyClaimed = new Set<string>();
        pageSeeds.forEach((p, i) => {
          const anchor = p.uiSec!.title;
          const exact = anchorPool.get(anchor);
          if (exact && exact.length > 0) {
            p.code = exact.shift()!.code;
          } else {
            const li = legacyPool.findIndex((r) => !legacyClaimed.has(r.code) && r.payload.title === p.title);
            const cand = li >= 0 ? legacyPool[li]! : legacyPool[i]; // 标题精确优先，同位次兜底
            if (cand && !legacyClaimed.has(cand.code)) {
              p.code = cand.code;
              legacyClaimed.add(cand.code);
            } else {
              p.code = allocCode();
            }
          }
          usedCodes.add(p.code);
        });
      }
      // ui 册页面章节 → 页码映射（写 ref_kind='ui' 引用用；码=锚定后的最终码，迁移 0031 起）
      const uiSecByCode = new Map<string, DocSection>();
      for (const p of pageSeeds) {
        if (p.uiSec && p.code) uiSecByCode.set(p.code, p.uiSec);
      }

      interface ItemSeed { type: string; code: string; payload: Record<string, unknown>; required: boolean; source?: string }
      const items: ItemSeed[] = [
        ...pageSeeds.map((p, i) => ({
          type: 'page',
          code: p.code ?? `P-${String(i + 1).padStart(3, '0')}`,
          // uiAnchor 落 payload 作身份键（随目录版本化自包含；不在 update-item 白名单=人工不可改）。
          // 存量目录首跑 re-plan 因多了该键指纹不等会产一次新版本——预期自愈，此后锚点稳定
          payload: { title: p.title, route: `/p${i + 1}`, reqIds: p.reqIds, ...(p.uiSec ? { uiAnchor: p.uiSec.title } : {}) },
          required: true,
        })),
        // 骨架首页非 ui 册章节派生——ui 册驱动口径下预置 exempt，免「页有册无」恒报（人工可经 update-item 改）
        { type: 'page', code: 'P-HOME', payload: { title: '首页', route: '/', reqIds: [], ...(uiSecs.length > 0 ? { exempt: true } : {}) }, required: true },
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
      // 随行扩（覆盖检测 §2）：派生条目（source≠'manual'）上的人工修改字段
      // （payload.steps/exempt——流程步骤编辑/页豁免）也按 type+code 迁移保留，
      // 原口径 re-plan 全量重导把它们静默重置回识别值。
      // ui 派生页的码已被上方锚点稳定化（差异55a）——重排后 type+code 命中的就是同一来源章节
      // 的页，title/note 不再贴错；锚点失配（章节改名/删除）的页按新锚点另立，旧页人工字段随之退役。
      if (prevCatVer) {
        for (const m of prevItemsAll) {
          if (m.source === 'manual') {
            if (!items.some((i) => i.type === m.item_type && i.code === m.code)) {
              items.push({ type: m.item_type, code: m.code, payload: m.payload, required: m.required, source: 'manual' });
            }
            continue;
          }
          const it = items.find((i) => i.type === m.item_type && i.code === m.code);
          if (!it) continue; // 本版不再派生该条目（上游章节已删）
          for (const k of CARRIED_PAYLOAD_KEYS) {
            if (m.payload[k] !== undefined) it.payload[k] = m.payload[k];
          }
        }
      }

      // 幂等复用（2026-10-17 根修「re-plan 后全部页面变未生成、对应性检查 GATE_BLOCKED 拦死」）：
      // 派生结果与当前目录版本逐条全同（type+code+payload 指纹+required+source）→ 不产新目录版本，
      // plan 直接复用现版本。旧口径 re-plan 恒递增 V3-n——页工件按目录版本绑定，无谓递增把全部
      // 页原型判「依据已过期」作废（实机：贪吃蛇项目 V3-4→V3-5 条目零变化、5 页全「未生成」）。
      const prevByKey = new Map(prevItemsAll.map((r) => [`${r.item_type}:${r.code}`, r]));
      const unchanged = prevCatVer !== null
        && prevItemsAll.length === items.length
        && items.every((it) => {
          const old = prevByKey.get(`${it.type}:${it.code}`);
          // 指纹两侧同从 payload 现算（canonical）——存量行 content_fingerprint 是旧口径不可比
          return !!old
            && canonicalPayloadFp(old.payload) === canonicalPayloadFp(it.payload)
            && old.required === it.required
            && old.source === (it.source ?? 'identified');
        });
      let catalogVersion: string;
      const itemIds: string[] = [];
      if (unchanged) {
        catalogVersion = prevCatVer!;
        // refs 原地刷新：条目集不变≠来源内容不变（上游 PRD/ui 册有新提交时快照指纹须随本次规划重锚；
        // item_id 不变审计链连续；来源审计按 ref_fingerprint 实时比对，不刷新会留陈旧信号）
        await client.query(
          `DELETE FROM dsg_catalog_refs WHERE item_id IN
           (SELECT id FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2)`,
          [projectId, catalogVersion]);
        for (const it of items) {
          const id = prevByKey.get(`${it.type}:${it.code}`)!.id;
          itemIds.push(id);
          await this.insertItemRefs(client, id, it, reqSecs, uiSecByCode);
        }
      } else {
        // 目录版本与人工增删共用同一递增序列（V3-n），plan 取下一号
        catalogVersion = await this.nextCatalogVersion(client, projectId);
        for (const it of items) {
          const fp = canonicalPayloadFp(it.payload);
          const r = await client.query<{ id: string }>(
            `INSERT INTO dsg_catalog_items (project_id, catalog_version, item_type, code, payload, required, source, content_fingerprint, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [projectId, catalogVersion, it.type, it.code, JSON.stringify(it.payload), it.required, it.source ?? 'identified', fp, ctx.actorId],
          );
          itemIds.push(r.rows[0]!.id);
          await this.insertItemRefs(client, r.rows[0]!.id, it, reqSecs, uiSecByCode);
        }
      }
      // 页工件 reconcile（同根修）：payload 未变的页工件随行升级到新目录版本（updated_at 保留=uiStale
      // 时间基不破；旧汇总版本 manifest 按 objectKey 不可变不受影响）；已从目录移除的页工件行清除
      // （残留行被门禁判「目录版本已过期」且该页已不在目录=永不可再生，永久卡死检查）；
      // payload 已变的页留在旧版本，门禁「须重新生成并汇总」引导页级重生成。
      // 幂等复用路径同跑：自愈历史孤儿行（本修复前 re-plan 递增作废的存量页工件）。
      await this.reconcilePageArtifacts(client, projectId, catalogVersion);

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
        [projectId, ver, itemType, code, JSON.stringify(itemPayload), canonicalPayloadFp(itemPayload), ctx.actorId],
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
    // A05-13 扩：目录条目字段修订（覆盖检测 §2 豁免落点 + §3 流程步骤编辑）。
    // 可改字段白名单=title/note/payload.steps/payload.exempt/payload.verify（steps/exempt 对照 CARRIED_PAYLOAD_KEYS——
    // 落 payload 的可改键必须在随行清单内，否则 re-plan 丢人工调整；verify 仅人工条目有（随行=整 payload 迁移，
    // 天然保留），故不必进 CARRIED——识别条目带 verify 会被随行过滤丢失，因此白名单闸限制「仅已有 verify 键的条目可改」）；
    // reqIds/route 等识别字段一律拒绝。编辑即产生新目录版本，需 re-plan 后反映到汇总原型
    // （finalize 门禁以目录指纹比对 CHECK_STALE 强制改后重跑 check）。
    registerCommand('design.catalog.update-item', async (client, payload, ctx) => {
      const raw = payload as Record<string, unknown>;
      const { projectId, itemId } = raw as { projectId: string; itemId: string };
      for (const k of Object.keys(raw)) {
        if (k === 'projectId' || k === 'itemId') continue;
        if (k !== 'title' && k !== 'note' && k !== 'steps' && k !== 'exempt' && k !== 'verified') {
          throw new DomainError('VALIDATION_FAILED', `不可修改的字段: ${k}（仅 title/note/steps/exempt/verified 可改）`, k);
        }
      }
      const patch: { title?: string; note?: string; steps?: string[]; exempt?: boolean; verified?: boolean } = {};
      if (raw.title !== undefined) {
        if (typeof raw.title !== 'string' || !raw.title.trim()) {
          throw new DomainError('VALIDATION_FAILED', '条目标题必填', 'title');
        }
        patch.title = raw.title.trim();
      }
      if (raw.note !== undefined) {
        if (typeof raw.note !== 'string') throw new DomainError('VALIDATION_FAILED', '备注须为字符串', 'note');
        patch.note = raw.note;
      }
      if (raw.steps !== undefined) {
        if (!Array.isArray(raw.steps) || raw.steps.some((s) => typeof s !== 'string' || !s.trim())) {
          throw new DomainError('VALIDATION_FAILED', '流程步骤须为非空字符串数组', 'steps');
        }
        patch.steps = raw.steps.map((s) => s.trim());
      }
      if (raw.exempt !== undefined) {
        if (typeof raw.exempt !== 'boolean') throw new DomainError('VALIDATION_FAILED', '豁免标记须为布尔值', 'exempt');
        patch.exempt = raw.exempt;
      }
      if (raw.verified !== undefined) {
        if (typeof raw.verified !== 'boolean') throw new DomainError('VALIDATION_FAILED', '核对标记须为布尔值', 'verified');
        patch.verified = raw.verified;
      }
      if (Object.keys(patch).length === 0) {
        throw new DomainError('VALIDATION_FAILED', '无可更新字段（title/note/steps/exempt/verified 至少一项）', 'title');
      }
      const item = await client.query<CatalogItemRow & { catalog_version: string }>(
        'SELECT * FROM dsg_catalog_items WHERE id=$1 AND project_id=$2', [itemId, projectId]);
      const row = item.rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '目录条目不存在', itemId);
      // T7 Minor 折入：steps 仅 flow 条目可改——其它类型带 steps 一律拒绝（防语义错位/静默吞字段）
      if (raw.steps !== undefined && row.item_type !== 'flow') {
        throw new DomainError('VALIDATION_FAILED', `仅流程（flow）条目可编辑流程步骤（当前条目类型 ${row.item_type}）`, 'steps');
      }
      // W2-052：目录版本递增属 check-then-act——咨询锁串行化「取版本→复制→改」临界区
      await lockCodeGen(client, `msf:code:catalog:${projectId}`);
      // 复制源恒为当前（最新）目录版本——itemId 可能来自旧版本（改即换版，itemId 随版轮换），
      // 从 row.catalog_version 复制会把中间版本上其它条目的修订静默回滚
      const curVer = await this.currentCatalogVersion(client, projectId);
      const cur = await client.query<CatalogItemRow>(
        'SELECT * FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 AND item_type=$3 AND code=$4',
        [projectId, curVer, row.item_type, row.code]);
      const curRow = cur.rows[0];
      if (!curRow) throw new DomainError('NOT_FOUND', '该条目已不在当前目录版本（可能已被重规划移除）', itemId);
      // verified 销项闸：仅 payload 带 verify 键的条目（=人工补录，add-item 落 verify:'manual'）可改核对态——
      // 识别条目本无「需人工核对」语义，放行会在 payload 里生出无来源的 verify 键
      if (raw.verified !== undefined && curRow.payload.verify === undefined) {
        throw new DomainError('VALIDATION_FAILED', '仅人工补录的条目可标记核对（识别条目无「需人工核对」态）', 'verified');
      }
      const ver = await this.nextCatalogVersion(client, projectId);
      // 复制当前版本全部条目到新版本（目录版本化：改=新版本）
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
      // 合并补丁进新版本中该条目的 payload（基线=当前版本行；保留 reqIds/route/verify 等未授权字段原值）；
      // exempt=false 删键而非存 false——豁免口径只看 payload.exempt===true，保持 payload 自包含干净
      const merged: Record<string, unknown> = { ...curRow.payload };
      if (patch.title !== undefined) merged.title = patch.title;
      if (patch.note !== undefined) merged.note = patch.note;
      if (patch.steps !== undefined) merged.steps = patch.steps;
      if (patch.exempt !== undefined) {
        if (patch.exempt) merged.exempt = true;
        else delete merged.exempt;
      }
      // verified 销项（检查报告「需人工核对」→ 已核对）：true 落 'checked' / false 回 'manual'（撤销核对）
      if (patch.verified !== undefined) merged.verify = patch.verified ? 'checked' : 'manual';
      const r = await client.query<{ id: string }>(
        `UPDATE dsg_catalog_items SET payload=$5, content_fingerprint=$6
         WHERE project_id=$1 AND catalog_version=$2 AND item_type=$3 AND code=$4 RETURNING id`,
        [projectId, ver, row.item_type, row.code, JSON.stringify(merged), canonicalPayloadFp(merged)],
      );
      return { itemId: r.rows[0]!.id, catalogVersion: ver };
    });
  }

  /** 单条目追溯引用写入（plan 新插/幂等复用两路共用）：PRD reqIds 锚点 + ui 册页面章节锚点（迁移 0031） */
  private async insertItemRefs(
    client: import('pg').PoolClient,
    itemId: string,
    it: { type: string; code: string; payload: Record<string, unknown> },
    reqSecs: DocSection[],
    uiSecByCode: Map<string, DocSection>,
  ): Promise<void> {
    // REQ 章节来源的页面挂追溯引用（锚点=PRD 章节）
    const reqIds = (it.payload.reqIds as string[] | undefined) ?? [];
    for (const reqCode of reqIds) {
      const sec = reqSecs.find((s) => s.title.includes(reqCode));
      if (sec) {
        await client.query(
          `INSERT INTO dsg_catalog_refs (item_id, ref_kind, doc_kind, section_id, anchor, rule_text, ref_fingerprint, ruleset_version)
           VALUES ($1,'prd','prd',$2,$3,$4,$5,$6)`,
          [itemId, sec.id, sec.title, sec.md.slice(0, 500), sha256Text(sec.md), RULESET_VERSION],
        );
      }
    }
    // ui 册页面章节来源的页面挂 ui 追溯引用（覆盖检测 §2，迁移 0031 起 ref_kind='ui'；
    // section_id/anchor/rule_text 快照+ref_fingerprint 同 prd refs 口径）
    const uiSec = uiSecByCode.get(it.code);
    if (uiSec) {
      await client.query(
        `INSERT INTO dsg_catalog_refs (item_id, ref_kind, doc_kind, section_id, anchor, rule_text, ref_fingerprint, ruleset_version)
         VALUES ($1,'ui','ui',$2,$3,$4,$5,$6)`,
        [itemId, uiSec.id, uiSec.title, uiSec.md.slice(0, 500), sha256Text(uiSec.md), RULESET_VERSION],
      );
    }
  }

  /**
   * 页工件 reconcile（2026-10-17 根修「re-plan/目录编辑后全部页面变未生成」）：
   * 页工件按目录版本绑定，但「目录版本变了」≠「该页内容依据变了」——payload 指纹未变的页，
   * 工件行随行升级到新目录版本（updated_at 保留=uiStale 时间基不破；旧汇总版本 manifest
   * 按 objectKey 不可变不受影响）；已从目录移除的页，工件行清除（残留行被门禁判「目录版本
   * 已过期」且该页已不在目录=永不可再生，永久卡死检查）；payload 已变的页留在旧版本，
   * 门禁「须重新生成并汇总」引导页级重生成。plan/add/remove/update-item 四路共用。
   */
  private async reconcilePageArtifacts(
    client: import('pg').PoolClient,
    projectId: string,
    catalogVersion: string,
  ): Promise<void> {
    const orphans = await client.query<{ page_code: string; catalog_version: string }>(
      'SELECT page_code, catalog_version FROM dsg_prototype_pages WHERE project_id=$1 AND catalog_version<>$2',
      [projectId, catalogVersion]);
    if (orphans.rows.length === 0) return;
    const newPages = await client.query<{ code: string; payload: Record<string, unknown> }>(
      `SELECT code, payload FROM dsg_catalog_items
       WHERE project_id=$1 AND catalog_version=$2 AND item_type='page'`,
      [projectId, catalogVersion]);
    const newFp = new Map(newPages.rows.map((r) => [r.code, canonicalPayloadFp(r.payload)]));
    const oldVers = [...new Set(orphans.rows.map((r) => r.catalog_version))];
    const oldItems = await client.query<{ catalog_version: string; code: string; payload: Record<string, unknown> }>(
      `SELECT catalog_version, code, payload FROM dsg_catalog_items
       WHERE project_id=$1 AND catalog_version = ANY($2) AND item_type='page'`,
      [projectId, oldVers]);
    const oldFp = new Map(oldItems.rows.map((r) => [`${r.catalog_version}:${r.code}`, canonicalPayloadFp(r.payload)]));
    const inherit: string[] = [];
    const drop: string[] = [];
    for (const o of orphans.rows) {
      if (!newFp.has(o.page_code)) { drop.push(o.page_code); continue; }
      if (oldFp.get(`${o.catalog_version}:${o.page_code}`) === newFp.get(o.page_code)) inherit.push(o.page_code);
    }
    if (inherit.length > 0) {
      await client.query(
        'UPDATE dsg_prototype_pages SET catalog_version=$2 WHERE project_id=$1 AND page_code = ANY($3)',
        [projectId, catalogVersion, inherit]);
    }
    if (drop.length > 0) {
      await client.query(
        'DELETE FROM dsg_prototype_pages WHERE project_id=$1 AND page_code = ANY($2)',
        [projectId, drop]);
    }
  }

  /** A05-5 plan 命令入口 */
  async plan(projectId: string, ctx: CommandContext) {
    return executeCommand('design.prototype.plan', { projectId }, { ...ctx, projectId });
  }

  async addItem(projectId: string, input: { itemType: string; code: string; title: string; note?: string }, ctx: CommandContext) {
    // I-1：路径参数兜底在后——body 携带同名 projectId 键不得覆盖路径归属（防跨项目写+审计错位）
    return executeCommand('design.catalog.add-item', { ...input, projectId }, { ...ctx, projectId });
  }

  async removeItem(projectId: string, itemId: string, ctx: CommandContext) {
    return executeCommand('design.catalog.remove-item', { projectId, itemId }, { ...ctx, projectId });
  }

  async updateItem(
    projectId: string,
    itemId: string,
    input: { title?: string; note?: string; steps?: string[]; exempt?: boolean; verified?: boolean },
    ctx: CommandContext,
  ) {
    // I-1：路径参数兜底在后——body 携带 projectId/itemId 键不得覆盖路径归属（防跨项目写+审计错位）
    return executeCommand('design.catalog.update-item', { ...input, projectId, itemId }, { ...ctx, projectId });
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
    const fp = catalogFingerprintOf(ver, items.rows.map((i) => i.code)); // code 基口径（S-2 单点，原 id 基随版本轮换不稳定）
    return { catalogVersion: ver, catalogFingerprint: `sha256:${fp}`, groups };
  }

  /** 当前目录版本+指纹（check 落库与 finalize 门禁 CHECK_STALE 比对同源，S-2 单点） */
  async currentCatalogFingerprint(
    client: import('pg').PoolClient | null,
    projectId: string,
  ): Promise<{ catalogVersion: string; fingerprint: string } | null> {
    const ver = await this.currentCatalogVersion(client, projectId);
    if (!ver) return null;
    const q = client ? client.query.bind(client) : query;
    const items = await q<{ code: string }>(
      'SELECT code FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2', [projectId, ver]);
    return { catalogVersion: ver, fingerprint: catalogFingerprintOf(ver, items.rows.map((r) => r.code)) };
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
      'SELECT catalog_version AS v FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1',
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
