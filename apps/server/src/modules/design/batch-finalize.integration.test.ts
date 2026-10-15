/**
 * 批量定稿（2026-10-16 用户拍板，除 hld 外详细七册一键定稿，需 DB）：
 * ①正常路径：七册已定稿+fin_ 证据留痕、hld 不在批量范围（保持未定稿）；
 * ②逐册独立：有未提交修改/已定稿的册跳过并带人话原因，不拖垮其它册；
 * ③未决评审项门禁：项目级 open DR 未豁免时逐册 GATE_BLOCKED 原因跳过，allowOpenReviews=true 放行；
 * ④无内容册（未自举项目）：七册全跳过「无内容」。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { DesignDocsService } from './docs.service.js';

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e9+f0~f9+fa~ff+d1~d7 已占用（registry 总表见 rtm-deferred.e2e.test.ts 顶部）；本套件占 d8/d9。
const PID = '00000000-0000-0000-0000-0000000000d8';
/** 无内容册用例专用项目（不自举设计文档行 → 七册全「无内容」） */
const PID2 = '00000000-0000-0000-0000-0000000000d9';
const CTX = { projectId: PID, actorKind: 'human' as const, actorId: 'local' };
const CTX2 = { projectId: PID2, actorKind: 'human' as const, actorId: 'local' };
const SEVEN = ['mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'] as const;

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

/** 提交一册真实内容（模板自举 v1 → 存草稿 → 提交 v2） */
async function commitBook(docs: DesignDocsService, kind: (typeof SEVEN)[number], mark: string) {
  let d = (await docs.getDoc(PID, kind)) as unknown as DocView;
  await docs.saveDraft(PID, kind, {
    secId: d.secs[0]!.id,
    md: `引言。${mark}`,
    baseVersion: d.cur,
    baseFingerprint: d.contentFingerprint,
  }, CTX);
  d = (await docs.getDoc(PID, kind)) as unknown as DocView;
  await docs.commit(PID, kind, `${kind} 提交`, d.cur, CTX);
}

describe('批量定稿（除 hld 外七册，集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  const docs = new DesignDocsService();
  resetCommands();
  docs.onModuleInit();
  // HEAD 版 docs.commit 同事务触发 rtm.rebuild 派生（处理器注册在 req 域 docs.service）——须起 req 侧命令注册
  const reqDocs = new ReqDocsService(new PolicyService());
  reqDocs.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'batch-finalize') ON CONFLICT (id) DO NOTHING", [PID]);
    await query("INSERT INTO projects (id, name) VALUES ($1, 'batch-finalize-empty') ON CONFLICT (id) DO NOTHING", [PID2]);
    await docs.listDocs(PID, CTX); // 八册模板自举（各册落 v1 骨架）
    // 七册各提交 v2（真实内容）；hld 也提交 v2 但不应被批量定稿触碰
    for (const k of SEVEN) await commitBook(docs, k, `（${k} 内容）`);
    let h = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.saveDraft(PID, 'hld', {
      secId: h.secs[0]!.id, md: '总体架构。（hld 不走批量）',
      baseVersion: h.cur, baseFingerprint: h.contentFingerprint,
    }, CTX);
    h = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.commit(PID, 'hld', 'HLD 提交', h.cur, CTX);
  });

  afterAll(async () => {
    for (const p of [PID, PID2]) {
      await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [p]);
      await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [p]);
      await query('DELETE FROM dsg_reviews WHERE project_id=$1', [p]);
      await query('UPDATE dsg_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [p]);
      await query('DELETE FROM dsg_versions WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [p]);
      await query('DELETE FROM dsg_documents WHERE project_id=$1', [p]);
      await query('DELETE FROM rtm_links WHERE project_id=$1', [p]);
      await query('DELETE FROM rtm_health WHERE project_id=$1', [p]);
      await query('DELETE FROM sys_notifications WHERE project_id=$1', [p]);
      await query('DELETE FROM evd_events WHERE project_id=$1', [p]);
      await query('DELETE FROM evd_records WHERE project_id=$1', [p]);
      await query('DELETE FROM projects WHERE id=$1', [p]);
    }
    await pool.end();
  });

  it('① 正常路径：七册全定稿+逐册 fin_ 证据、hld 不在批量范围；② 已定稿册幂等跳过', async () => {
    const r = await docs.finalizeAll(PID, true, false, CTX);
    expect(r.skipped).toEqual([]);
    expect(r.finalized.map((f) => f.kind).sort()).toEqual([...SEVEN].sort());
    for (const f of r.finalized) {
      expect(f.v).toBe(2);
      expect(f.finalizationId).toMatch(/^fin_\d+$/);
    }
    // 逐册证据留痕（append-only evd_records kind='finalize'）
    const fin = await query<{ n: string }>(
      "SELECT count(*) AS n FROM evd_records WHERE project_id=$1 AND kind='finalize'", [PID]);
    expect(Number(fin.rows[0]!.n)).toBe(7);
    // hld 不在批量范围（已提交 v2 但未定稿）
    const hld = await query<{ final_version_id: string | null }>(
      "SELECT final_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='hld'", [PID]);
    expect(hld.rows[0]!.final_version_id).toBeNull();
    // ② 幂等：再跑一次，七册全部「已定稿」跳过，零新增证据
    const r2 = await docs.finalizeAll(PID, true, false, CTX);
    expect(r2.finalized).toEqual([]);
    expect(r2.skipped).toHaveLength(7);
    for (const s of r2.skipped) expect(s.reason).toContain('已定稿');
    const fin2 = await query<{ n: string }>(
      "SELECT count(*) AS n FROM evd_records WHERE project_id=$1 AND kind='finalize'", [PID]);
    expect(Number(fin2.rows[0]!.n)).toBe(7);
  });

  it('③ 逐册独立：未提交修改册跳过带原因、其它册照常定稿（用新批次解锁重验）', async () => {
    // 解锁 mod/ui 两册再造混合场景：mod 留未提交草稿（modified=true），ui 干净
    await docs.unlock(PID, 'mod', CTX);
    await docs.unlock(PID, 'ui', CTX);
    const m = (await docs.getDoc(PID, 'mod')) as unknown as DocView;
    await docs.saveDraft(PID, 'mod', {
      secId: m.secs[0]!.id, md: '引言。mod 改了但没提交',
      baseVersion: m.cur, baseFingerprint: m.contentFingerprint,
    }, CTX);
    const r = await docs.finalizeAll(PID, true, false, CTX);
    const byKind = new Map(r.skipped.map((s) => [s.kind, s.reason]));
    expect(r.finalized.map((f) => f.kind)).toEqual(['ui']); // ui 解锁后重定稿
    expect(byKind.get('mod')).toContain('未提交修改');
    expect(byKind.get('alg')).toContain('已定稿'); // 其余五册幂等跳过
  });

  it('④ 未决评审项门禁：无豁免全跳过带 GATE_BLOCKED 原因；allowOpenReviews=true 放行', async () => {
    // mod 先补齐一次可定稿状态（③里已解锁未定稿，此处只需提交未提交的草稿——再 unlock 会撞「文档未定稿」）
    const m = (await docs.getDoc(PID, 'mod')) as unknown as DocView;
    await docs.commit(PID, 'mod', 'mod 补齐提交', m.cur, CTX);
    await query(
      "INSERT INTO dsg_reviews (project_id, code, severity, doc_kind, text, created_by) VALUES ($1,'DR-T-D8','中','mod','批量定稿门禁测试项','test')",
      [PID]);
    const blocked = await docs.finalizeAll(PID, true, false, CTX);
    expect(blocked.finalized).toEqual([]);
    expect(blocked.skipped.find((s) => s.kind === 'mod')?.reason).toContain('未决评审项');
    const ok = await docs.finalizeAll(PID, true, true, CTX);
    expect(ok.finalized.map((f) => f.kind)).toEqual(['mod']);
  });

  it('⑤ 无内容项目：七册全跳过「无内容」，零报错', async () => {
    const r = await docs.finalizeAll(PID2, true, false, CTX2);
    expect(r.finalized).toEqual([]);
    expect(r.skipped).toHaveLength(7);
    for (const s of r.skipped) expect(s.reason).toContain('无内容');
  });
});
