/**
 * AI 自检评审（设计覆盖检测与可交互原型 §1 过度设计侧，需 DB）：
 * 造过度设计候选（设计册含锚点码条目节、无 REQ 回引）→ design.review.selfcheck（mock provider
 * purpose='review' 固定复核意见）→ dsg_reviews 落真实 DR 项（code=DR-<册字母>-<节锚点>、
 * severity='中'、created_by='pi'）；重跑幂等（done 不动/open 刷新）；并发闸 INVALID_STATE；
 * deferred 豁免剔除；人工 conclude 挂 finalize 门禁既有链路回归（open 计数含 pi 项）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from '../req/docs.service.js';
import { MockAiProvider } from '../ai/mock-ai.provider.js';
import type { AiProvider } from '../ai/ai-provider.interface.js';
import { DesignDocsService } from './docs.service.js';
import { ReviewService } from './review.service.js';

// e2e PID 注册表（共享库并行跑，撞 PID=FK 级联整组炸，新增套件先查再占）：
// e1~e9+f0~f9+fa~ff 已占用（registry 总表见 rtm-deferred.e2e.test.ts 顶部）；本套件占 d5。
const PID = '00000000-0000-0000-0000-0000000000d5';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dsg_reviews LIMIT 1');
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

/** 后台跑完成等待（并发闸实态轮询；mock 即时但落库是异步命令事务） */
async function waitIdle(svc: ReviewService, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (!svc.selfcheckRunning) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('自检评审后台跑超时未结束');
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('AI 自检评审 → 真实 DR 项（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  const policy = new PolicyService();
  const reqDocs = new ReqDocsService(policy);
  const docs = new DesignDocsService();
  const svc = new ReviewService(new MockAiProvider());
  resetCommands();
  reqDocs.onModuleInit(); // rtm.rebuild（设计册提交后的反向派生重建依赖）
  docs.onModuleInit(); // design.doc.*（finalize 门禁回归对象）
  svc.onModuleInit(); // design.review.seed/conclude/reopen/selfcheck

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'review-selfcheck') ON CONFLICT (id) DO NOTHING", [PID]);
    await reqDocs.listDocs(PID, CTX); // CRD/PRD 模板自举
    await docs.listDocs(PID, CTX); // 设计八册模板自举（模板无锚点节，天然零候选）
    // PRD：REQ-001（复核输入的 REQ 节摘录来源）
    let dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.saveDraft(PID, 'prd', {
      secId: dp.secs[0]!.id,
      md: ['引言。', '', '## REQ-001 门户页', '', '门户页需求描述。'].join('\n'),
      baseVersion: dp.cur, baseFingerprint: dp.contentFingerprint,
    }, CTX);
    dp = (await reqDocs.getDoc(PID, 'prd')) as unknown as DocView;
    await reqDocs.commit(PID, 'prd', 'PRD v2', dp.cur, CTX);
    // hld：h-3 无 REQ 回引（候选）+ h-4 有回引（非候选）
    let dh = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.saveDraft(PID, 'hld', {
      secId: dh.secs[0]!.id,
      md: ['总体架构。', '',
        '## h-3 缓存层设计', '', '缓存策略与淘汰规则（无需求回引）。', '',
        '## h-4 门户架构', '', '承接：REQ-001 的门户页整体架构。'].join('\n'),
      baseVersion: dh.cur, baseFingerprint: dh.contentFingerprint,
    }, CTX);
    dh = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    await docs.commit(PID, 'hld', 'HLD v2', dh.cur, CTX);
    // mod：o-2 无 REQ 回引（候选——钉八册全扫非只扫 hld）
    let dm = (await docs.getDoc(PID, 'mod')) as unknown as DocView;
    await docs.saveDraft(PID, 'mod', {
      secId: dm.secs[0]!.id,
      md: ['模块划分。', '', '## o-2 额外工具模块', '', '无需求回引的工具模块。'].join('\n'),
      baseVersion: dm.cur, baseFingerprint: dm.contentFingerprint,
    }, CTX);
    dm = (await docs.getDoc(PID, 'mod')) as unknown as DocView;
    await docs.commit(PID, 'mod', 'MOD v2', dm.cur, CTX);
  });

  afterAll(async () => {
    await query('DELETE FROM dsg_reviews WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_pendings WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM dsg_drafts WHERE document_id IN (SELECT id FROM dsg_documents WHERE project_id=$1)', [PID]);
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

  it('候选清单 → selfcheck → 落真实 DR 项（DR-H-h-3/DR-O-o-2，severity=中/doc_kind=册/created_by=pi）', async () => {
    const r = await svc.selfcheck(PID, CTX);
    expect(r.started).toBe(true);
    expect(r.candidates).toEqual(['DR-H-h-3', 'DR-O-o-2']); // h-4 有 REQ 回引不入候选；返回值按码排序
    await waitIdle(svc);
    const rows = await query<{
      code: string; severity: string; doc_kind: string; text: string; status: string; created_by: string;
    }>('SELECT code, severity, doc_kind, text, status, created_by FROM dsg_reviews WHERE project_id=$1 ORDER BY code', [PID]);
    expect(rows.rows).toHaveLength(2);
    const h3 = rows.rows.find((x) => x.code === 'DR-H-h-3')!;
    expect(h3.severity).toBe('中');
    expect(h3.doc_kind).toBe('hld');
    expect(h3.created_by).toBe('pi');
    expect(h3.status).toBe('open');
    // mock purpose='review' 固定复核意见落 text
    expect(h3.text).toContain('疑似过度设计候选 h-3');
    expect(h3.text).toContain('看似无需求依据');
    const o2 = rows.rows.find((x) => x.code === 'DR-O-o-2')!;
    expect(o2.doc_kind).toBe('mod');
    expect(o2.created_by).toBe('pi');
  });

  it('deferred 豁免剔除：dsg 自指行码集从候选清单剔除', async () => {
    await query(
      `INSERT INTO rtm_links (project_id, from_kind, from_code, to_kind, to_code, relation, created_by)
       VALUES ($1,'dsg','h-3','dsg','h-3','deferred','t')`, [PID]);
    try {
      const r = await svc.selfcheck(PID, CTX);
      expect(r.started).toBe(true);
      expect(r.candidates).toEqual(['DR-O-o-2']); // h-3 已豁免
      await waitIdle(svc);
    } finally {
      await query("DELETE FROM rtm_links WHERE project_id=$1 AND from_kind='dsg'", [PID]);
    }
  });

  it('重跑幂等：open 刷新 text（updated_at 落戳）；done 不动', async () => {
    await query("UPDATE dsg_reviews SET text='旧意见' WHERE project_id=$1 AND code='DR-H-h-3'", [PID]);
    await svc.conclude(PID, 'DR-O-o-2', 'pass', '已确认合理', CTX);
    await query("UPDATE dsg_reviews SET text='已结论勿动' WHERE project_id=$1 AND code='DR-O-o-2'", [PID]);
    const r = await svc.selfcheck(PID, CTX);
    expect(r.started).toBe(true);
    expect(r.candidates).toEqual(['DR-H-h-3', 'DR-O-o-2']); // 豁免行已清，两候选回归
    await waitIdle(svc);
    const rows = await query<{ code: string; text: string; status: string; updated_at: string | null }>(
      'SELECT code, text, status, updated_at FROM dsg_reviews WHERE project_id=$1', [PID]);
    const h3 = rows.rows.find((x) => x.code === 'DR-H-h-3')!;
    expect(h3.status).toBe('open');
    expect(h3.text).not.toBe('旧意见');
    expect(h3.text).toContain('看似无需求依据'); // open 刷新为新复核意见
    expect(h3.updated_at).not.toBeNull();
    const o2 = rows.rows.find((x) => x.code === 'DR-O-o-2')!;
    expect(o2.status).toBe('done'); // 已有结论不动
    expect(o2.text).toBe('已结论勿动');
  });

  it('并发闸：在飞时再调 → INVALID_STATE', async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    // 挂起 provider：result 卡在人工闸上，首节复核未完 running 恒真
    const hanging: AiProvider = {
      kind: 'mock',
      async createSession(o) {
        const inner = await new MockAiProvider().createSession(o);
        return {
          sessionId: inner.sessionId,
          steer: (m: string) => inner.steer(m),
          stop: () => inner.stop(),
          stream: (p: string) => {
            const r = inner.stream(p);
            return { deltas: r.deltas, result: gate.then(() => r.result) };
          },
        };
      },
    };
    const svc2 = new ReviewService(hanging); // 不 onModuleInit：命令已注册（重复注册会被拒绝），闸是实例级
    const r = await svc2.selfcheck(PID, CTX);
    expect(r.started).toBe(true);
    await expect(svc2.selfcheck(PID, CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    release();
    await waitIdle(svc2);
  });

  it('finalize 门禁回归：open DR 计数含 pi 项（GATE_BLOCKED），逐条人工结论后放行', async () => {
    const dh = (await docs.getDoc(PID, 'hld')) as unknown as DocView;
    // DR-H-h-3 仍 open（DR-O-o-2 已 done）→ open 计数 1 拦定稿
    await expect(docs.finalize(PID, 'hld', dh.cur, dh.cur, true, false, CTX))
      .rejects.toMatchObject({ code: 'GATE_BLOCKED', message: expect.stringContaining('1 条未决评审项') as unknown as string });
    // 人工三值结论（AI 只提不判：pi 项同样走 design.review.conclude）
    await svc.conclude(PID, 'DR-H-h-3', 'fail', '确认为过度设计，下版移除', CTX);
    const fin = (await docs.finalize(PID, 'hld', dh.cur, dh.cur, true, false, CTX)) as { finalVer: number; openReviews: number };
    expect(fin.finalVer).toBe(dh.cur);
    expect(fin.openReviews).toBe(0);
  });
});
