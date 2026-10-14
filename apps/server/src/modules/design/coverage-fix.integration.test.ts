/**
 * L0C coverage-fix 定向提案落设计册（设计覆盖检测与可交互原型 §1 覆盖侧，需 DB）：
 * 造 L0C_BELOW 缺口（PRD 有 REQ 无任何 DSG 承接）→ design 域 coverage-fix →
 * dsg_pendings 落 hld 提案行（章节含 REQ-nnn 回引锚点；一次调用带全部缺口）→
 * 接受+提交后 deriveLinks 反向派生转绿（幂等：再调 results 空）；req 域表零写入。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from './docs.service.js';
import { DesignGenerateService } from './generate.service.js';

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e6/e9+f0~f9+fa~ff 已占用（registry 总表见 rtm-deferred.e2e.test.ts 顶部）；本套件占 e7/e8。
const PID = '00000000-0000-0000-0000-0000000000e7';
/** 未生成守卫用例专用项目（hld 无文档行 → reason「生成初稿」路径） */
const PID2 = '00000000-0000-0000-0000-0000000000e8';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };
const CTX2 = { projectId: PID2, actorKind: 'human' as const, actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_documents LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

interface DocView {
  cur: number;
  contentFingerprint: string;
  secs: Array<{ id: string; title: string; md: string }>;
}

describe('L0C coverage-fix 落设计册（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  const policy = new PolicyService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const gen = new DesignGenerateService(docs); // 无 AI_PROVIDER → mock 定向产出（离线可测全闭环）
  resetCommands();
  reqDocs.onModuleInit();
  docs.onModuleInit();
  gen.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'l0c-coverage-fix') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // CRD/PRD 模板自举
    await docs.listDocs(PID, CTX); // 设计八册模板自举
    // CRD：R-001 → CR-001 全承接（L0a/L0b 先绿，聚焦 L0C 闭环）
    let dc = (await reqDocs.getDoc(PID, 'crd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'crd', {
      secId: dc.secs[0]!.id,
      md: ['引言。', '', '## CR-001 门户', '', '承接：R-001'].join('\n'),
      baseVersion: dc.cur, baseFingerprint: dc.contentFingerprint,
    }, CTX);
    dc = (await reqDocs.getDoc(PID, 'crd')) as unknown as DocView;
    await reqDocs.commit(PID, 'crd', 'CRD v2', dc.cur, CTX);
    // PRD：REQ-001/REQ-002 承接 CR-001，均无 DSG 承接锚点 → L0C_BELOW ×2（提交同事务派生 rtm_links）
    let dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: dp.secs[0]!.id,
      md: ['引言。', '', '## REQ-001 门户页', '', '承接：CR-001', '', '## REQ-002 检索', '', '承接：CR-001'].join('\n'),
      baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint,
    }, CTX);
    dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD v2', dp.cur, CTX);
    // hld 预置 ## h-5 既有节（顺延编号钉：mock 提案应落 h-6/h-7；正文交叉引用 h-99 不占编号位——
    // 编号只扫 ^## 标题行，全文匹配会虚高最大码→顺延跳空）
    let dh = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.saveDraft(PID, 'hld', {
      secId: dh.secs[0]!.id,
      md: ['总体架构。', '', '## h-5 既有条目', '', '既有设计（正文交叉引用 h-99 不占编号位）。'].join('\n'),
      baseVersion: dh.cur, baseFingerprint: dh.contentFingerprint,
    }, CTX);
    dh = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.commit(PID, 'hld', 'HLD 预置', dh.cur, CTX);
  });

  afterAll(async () => {
    await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_reviews WHERE project_id=$1', [PID]);
    await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_events WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  it('L0C 缺口一次调用落 hld 提案（含 REQ 回引锚点）→ 守卫连撞全拒 → 接受提交转绿幂等；req 域表零写入', async () => {
    // req 域表零写入校验基线（跨域只读纪律：design 域 coverage-fix 不得写 req 侧任何表）
    const cnt = async (sql: string) => Number((await query<{ n: string }>(sql, [PID])).rows[0]!.n);
    const reqPend0 = await cnt('SELECT count(*) AS n FROM req_pendings p JOIN req_documents d ON d.id=p.document_id WHERE d.project_id=$1');
    const reqDraft0 = await cnt('SELECT count(*) AS n FROM req_drafts t JOIN req_documents d ON d.id=t.document_id WHERE d.project_id=$1');
    const rtmHealth0 = await cnt('SELECT count(*) AS n FROM rtm_health WHERE project_id=$1');

    // ①coverage-fix：一次调用带全部缺口 → hld 落 2 条提案（章节含 REQ-nnn 回引锚点）
    const fix = await gen.coverageFixFromGaps(PID, CTX);
    expect(fix.ok).toBe(true);
    expect(fix.results).toHaveLength(1);
    expect(fix.results[0]!.kind).toBe('hld');
    expect(fix.results[0]!.patchCount).toBe(2);
    const patches = (await docs.listPatches(PID, 'hld')) as {
      items: Array<{ patchId: string; status: string; title?: string; new?: string }>;
    };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(2);
    expect(pend.some((p) => p.title?.includes('REQ-001'))).toBe(true);
    expect(pend.some((p) => p.title?.includes('REQ-002'))).toBe(true);
    // 顺延编号钉：预置 h-5（正文交叉引用 h-99 不占位）→ 提案落 h-6/h-7 而非 h-100/h-101
    expect(pend.some((p) => /\bh-6\b/.test(p.title ?? ''))).toBe(true);
    expect(pend.some((p) => /\bh-7\b/.test(p.title ?? ''))).toBe(true);
    // 章节正文含「承接：REQ-nnn」回引锚点（接受提交后 deriveLinks 反向派生的输入）
    expect(pend.every((p) => /承接：REQ-\d{3}/.test(p.new ?? ''))).toBe(true);
    // 落库为 assistant 提案（人工确认后生效的提案语义不变）
    const pb = await query<{ proposed_by: string }>(
      `SELECT p.proposed_by FROM dsg_pendings p JOIN dsg_documents d ON d.id=p.document_id
       WHERE d.project_id=$1 AND d.doc_kind='hld' AND p.status='pending'`, [PID]);
    expect(pb.rows.length).toBe(2);
    expect(pb.rows.every((r) => r.proposed_by === 'assistant')).toBe(true);

    // ②「一次调用带全部缺口」的对偶：提案未处置前再调连撞「有待确认补丁」守卫全拒
    const fix2 = await gen.coverageFixFromGaps(PID, CTX);
    expect(fix2.ok).toBe(false);
    expect(fix2.results[0]!.reason).toContain('待确认补丁');

    // ③req 域表零写入（缺口清单全部 SQL 直读现算）
    expect(await cnt('SELECT count(*) AS n FROM req_pendings p JOIN req_documents d ON d.id=p.document_id WHERE d.project_id=$1')).toBe(reqPend0);
    expect(await cnt('SELECT count(*) AS n FROM req_drafts t JOIN req_documents d ON d.id=t.document_id WHERE d.project_id=$1')).toBe(reqDraft0);
    expect(await cnt('SELECT count(*) AS n FROM rtm_health WHERE project_id=$1')).toBe(rtmHealth0);

    // ④接受全部 → 提交 hld（design commit 自带 rtm.rebuild 反向派生）→ 再调幂等（覆盖转绿）
    for (const p of pend) {
      await docs.acceptPatch(PID, 'hld', p.patchId, CTX);
    }
    const d = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.commit(PID, 'hld', 'HLD 补齐 REQ 承接', d.cur, CTX);
    const fix3 = await gen.coverageFixFromGaps(PID, CTX);
    expect(fix3.ok).toBe(true);
    expect(fix3.results).toHaveLength(0);
  });

  it('未生成守卫：hld 无文档行（未生成初稿）→ ok:false 且 reason 含「生成初稿」，不落补丁', async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'l0c-coverage-fix-empty') ON CONFLICT (id) DO NOTHING", [PID2]);
    try {
      // 只自举 req 域并造 L0C 缺口；设计册不自举（dsg_documents 无 hld 行=未生成初稿态）
      await reqDocs.listDocs(PID2, CTX2);
      let dp = (await reqDocs.getDoc(PID2, 'prd')) as unknown as DocView;
      await reqDocs.saveDraft(PID2, 'prd', {
        secId: dp.secs[0]!.id,
        md: ['引言。', '', '## REQ-001 门户页', '', '承接：CR-001'].join('\n'),
        baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint,
      }, CTX2);
      dp = (await reqDocs.getDoc(PID2, 'prd')) as unknown as DocView;
      await reqDocs.commit(PID2, 'prd', 'PRD v2', dp.cur, CTX2);

      const fix = await gen.coverageFixFromGaps(PID2, CTX2);
      expect(fix.ok).toBe(false);
      expect(fix.results).toHaveLength(1);
      expect(fix.results[0]!.reason).toContain('生成初稿');
      // 守卫失败零产出：dsg_pendings 无落行
      const pend = await query<{ n: string }>(
        `SELECT count(*) AS n FROM dsg_pendings p JOIN dsg_documents d ON d.id=p.document_id WHERE d.project_id=$1`, [PID2]);
      expect(Number(pend.rows[0]!.n)).toBe(0);
    } finally {
      await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID2]);
      await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID2]);
      await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM dsg_documents WHERE project_id=$1', [PID2]);
      await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID2]);
      await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID2]);
      await query('DELETE FROM req_documents WHERE project_id=$1', [PID2]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [PID2]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [PID2]);
      await query('DELETE FROM sys_notifications WHERE project_id=$1', [PID2]);
      await query('DELETE FROM evd_events WHERE project_id=$1', [PID2]);
      await query('DELETE FROM projects WHERE id=$1', [PID2]);
    }
  });
});
