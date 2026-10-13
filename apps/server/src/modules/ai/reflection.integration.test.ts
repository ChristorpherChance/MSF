/** 反思执行器集成测试（Task 5，需 DB；设计 §3/§4）：mock 反思通道全链——
 *  手动 run：ai_reflections 落行（trigger='manual'）+ 提案版本直插（is_current=false/created_by='reflection'，
 *  绕开 publish 首版强制）+ proposals[0].status='pending'；
 *  并发闸：在飞再 run 抛 INVALID_STATE；
 *  提案处置：adopt=is_current 翻转（旧版摘新版挂）+状态 adopted；reject=版本行保留+状态 rejected；重复处置 INVALID_STATE；
 *  调度判定：空表到期但零新消息不跑、窗口有消息即跑、3 天前行未到期、8 天前行到期 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { executeCommand, resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { MockAiProvider } from './mock-ai.provider.js';
import { AiPromptsService } from './prompts.service.js';
import { ReflectionService, SYS_CTX } from './reflection.service.js';

const PID = '00000000-0000-0000-0000-0000000000a9';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

interface ReflectionRow {
  id: string; trigger: string; window_start: string; window_end: string;
  stats: Record<string, unknown>; report: string;
  proposals: Array<{ agentKey: string; versionNo: number; summary: string; status: string }>;
  model_id: string | null; created_at: string;
}

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM ai_reflections LIMIT 1');
    await query('SELECT 1 FROM ai_prompt_versions LIMIT 1');
    await query('SELECT 1 FROM ai_messages LIMIT 1');
    return true;
  } catch {
    return false;
  }
}

describe('Agent 反思执行器（集成，需 DB）', async () => {
  if (!(await infraUp())) {
    it.skip('postgres 未就绪', () => {});
    return;
  }
  resetCommands();
  new AiPromptsService().onModuleInit(); // ai.prompt.publish（adopt 用例铺旧当前版用）
  const notices = new NotificationsService();
  notices.onModuleInit(); // system.notification.emit（报告通知落库）
  const svc = new ReflectionService(new MockAiProvider(), notices);
  svc.onModuleInit(); // ai.reflect.run / ai.reflect.proposal.resolve 注册 + 调度器（unref 不吊进程）

  // 项目行（ai_sessions 外键）
  await query(
    `INSERT INTO projects (id, name, created_by) VALUES ($1,'reflection-t','t')
     ON CONFLICT (id) DO NOTHING`, [PID]);

  // 共享库护栏：快照 req 键既有版本行 id 与 ai_reflections 全表，套件新建的行跑完逐条清；
  // req 的 is_current 快照恢复（adopt 用例会翻转）；通知行按类型+时间窗清
  const suiteStart = new Date();
  const preReqVersionIds = new Set(
    (await query<{ id: string }>('SELECT id FROM ai_prompt_versions WHERE agent_key=$1', ['req'])).rows.map((r) => r.id));
  const snapshotCurrent = (await query<{ id: string }>(
    "SELECT id FROM ai_prompt_versions WHERE agent_key='req' AND is_current", [])).rows.map((r) => r.id);
  const createdReflectionIds: string[] = [];
  const restoreReflections = async (rows: ReflectionRow[]) => {
    for (const r of rows) {
      await query(
        `INSERT INTO ai_reflections (id, trigger, window_start, window_end, stats, report, proposals, model_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
        [r.id, r.trigger, r.window_start, r.window_end, JSON.stringify(r.stats), r.report,
         JSON.stringify(r.proposals), r.model_id, r.created_at]);
    }
  };

  afterAll(async () => {
    await query('DELETE FROM ai_messages WHERE session_id IN (SELECT id FROM ai_sessions WHERE project_id=$1)', [PID]);
    await query('DELETE FROM ai_sessions WHERE project_id=$1', [PID]);
    if (createdReflectionIds.length > 0) {
      await query('DELETE FROM ai_reflections WHERE id = ANY($1::uuid[])', [createdReflectionIds]);
    }
    try {
      await query('DELETE FROM ai_prompt_versions WHERE agent_key=$1 AND NOT (id = ANY($2::uuid[]))',
        ['req', [...preReqVersionIds]]);
    } finally {
      if (snapshotCurrent.length > 0) {
        await query('UPDATE ai_prompt_versions SET is_current=true WHERE id = ANY($1::uuid[])', [snapshotCurrent]);
      }
    }
    await query("DELETE FROM sys_notifications WHERE type='ai.reflection.done' AND created_at >= $1", [suiteStart.toISOString()]);
    svc.onModuleDestroy();
    await pool.end();
  });

  /** 最近一次 run 的反思行 + 登记清理 id */
  const lastReflection = async (id: string): Promise<ReflectionRow> => {
    createdReflectionIds.push(id);
    const r = await query<ReflectionRow>('SELECT * FROM ai_reflections WHERE id=$1', [id]);
    return r.rows[0]!;
  };

  it('手动 run：ai_reflections 落行 + 提案版本直插（is_current=false、created_by=reflection）+ proposals pending + 通知落库', async () => {
    const { reflectionId } = await svc.run('manual', SYS_CTX);
    const ref = await lastReflection(reflectionId);
    expect(ref.trigger).toBe('manual');
    expect(ref.report).toContain('反思报告');
    // stats 取样分组键在场（计数内容随共享库实况，不钉数值）
    for (const k of ['messagesByAgent', 'pendings', 'toolCalls', 'usage', 'rejectedHistory', 'samples']) {
      expect(ref.stats).toHaveProperty(k);
    }
    expect(Array.isArray(ref.proposals)).toBe(true);
    expect(ref.proposals).toHaveLength(1);
    expect(ref.proposals[0]).toMatchObject({ agentKey: 'req', status: 'pending' });
    expect(Number.isInteger(ref.proposals[0]!.versionNo)).toBe(true);
    // 提案版本行：直插、非生效、reflection 署名（C1：不经 publish 首版强制）
    const ver = await query<{ is_current: boolean; created_by: string; base_prompt: string; name: string }>(
      'SELECT is_current, created_by, base_prompt, name FROM ai_prompt_versions WHERE agent_key=$1 AND version_no=$2',
      ['req', ref.proposals[0]!.versionNo]);
    expect(ver.rows[0]).toMatchObject({ is_current: false, created_by: 'reflection' });
    expect(ver.rows[0]!.base_prompt).toContain('反思修订版');
    expect(ver.rows[0]!.name).toContain('反思改进');
    // 通知钩子：报告落库后全员通知（user_id NULL、link 设置页）
    const n = await query<{ text: string; link: string; user_id: string | null }>(
      "SELECT text, link, user_id FROM sys_notifications WHERE type='ai.reflection.done' AND created_at >= $1 ORDER BY created_at DESC LIMIT 1",
      [suiteStart.toISOString()]);
    expect(n.rows[0]?.text).toContain('1 条 Agent 改进提案待审');
    expect(n.rows[0]?.link).toBe('/settings');
    expect(n.rows[0]?.user_id).toBeNull();
  });

  it('并发闸：在飞时再 run 抛 INVALID_STATE，首个正常完成', async () => {
    const p1 = svc.run('manual', SYS_CTX); // running 标志在首个 await 前置位——第二场同步即被闸
    await expect(svc.run('manual', SYS_CTX)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const { reflectionId } = await p1;
    const ref = await lastReflection(reflectionId);
    expect(ref.proposals).toHaveLength(1);
  });

  it('提案处置 adopt：is_current 先摘后挂 + proposals 状态 adopted + 重复处置拒绝', async () => {
    // 铺一个用户当前版（被摘对象；首版强制 is_current=true）
    const pub = (await executeCommand('ai.prompt.publish', {
      agentKey: 'req', agentGroup: '需求', basePrompt: 'REQ-EXISTING-CURRENT 既有生效版',
    }, CTX)) as { id: string; version_no: number };
    expect((await query<{ is_current: boolean }>(
      'SELECT is_current FROM ai_prompt_versions WHERE id=$1', [pub.id])).rows[0]!.is_current).toBe(true);

    const { reflectionId } = await svc.run('manual', SYS_CTX);
    const ref = await lastReflection(reflectionId);
    const proposal = ref.proposals[0]!;
    const res = (await svc.resolveProposal(
      { reflectionId, agentKey: 'req', versionNo: proposal.versionNo, decision: 'adopt' }, SYS_CTX,
    )) as { status: string };
    expect(res.status).toBe('adopted');
    // 新版挂、旧版摘
    expect((await query<{ is_current: boolean }>(
      'SELECT is_current FROM ai_prompt_versions WHERE agent_key=$1 AND version_no=$2',
      ['req', proposal.versionNo])).rows[0]!.is_current).toBe(true);
    expect((await query<{ is_current: boolean }>(
      'SELECT is_current FROM ai_prompt_versions WHERE id=$1', [pub.id])).rows[0]!.is_current).toBe(false);
    // proposals 状态回写
    const after = await query<ReflectionRow>('SELECT proposals FROM ai_reflections WHERE id=$1', [reflectionId]);
    expect(after.rows[0]!.proposals[0]!.status).toBe('adopted');
    // 幂等闸：非 pending 态重复处置拒绝
    await expect(svc.resolveProposal(
      { reflectionId, agentKey: 'req', versionNo: proposal.versionNo, decision: 'reject' }, SYS_CTX,
    )).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('提案处置 reject：版本行保留（仍非生效）+ proposals 状态 rejected', async () => {
    const { reflectionId } = await svc.run('manual', SYS_CTX);
    const ref = await lastReflection(reflectionId);
    const proposal = ref.proposals[0]!;
    const res = (await svc.resolveProposal(
      { reflectionId, agentKey: 'req', versionNo: proposal.versionNo, decision: 'reject' }, SYS_CTX,
    )) as { status: string };
    expect(res.status).toBe('rejected');
    const ver = await query<{ is_current: boolean }>(
      'SELECT is_current FROM ai_prompt_versions WHERE agent_key=$1 AND version_no=$2',
      ['req', proposal.versionNo]);
    expect(ver.rows).toHaveLength(1); // 版本行保留（审计可追溯）
    expect(ver.rows[0]!.is_current).toBe(false);
    const after = await query<ReflectionRow>('SELECT proposals FROM ai_reflections WHERE id=$1', [reflectionId]);
    expect(after.rows[0]!.proposals[0]!.status).toBe('rejected');
    // 场次/提案定位校验：不存在 → NOT_FOUND
    await expect(svc.resolveProposal(
      { reflectionId: randomUUID(), agentKey: 'req', versionNo: 1, decision: 'adopt' }, SYS_CTX,
    )).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('调度判定：空表到期但零新消息不跑；窗口有消息即跑；3 天前行未到期；8 天前行到期', async () => {
    // 自包含快照：清空 ai_reflections 跑判定，finally 原样回插（含本套件前面场次）
    const saved = (await query<ReflectionRow>('SELECT * FROM ai_reflections')).rows;
    await query('DELETE FROM ai_reflections');
    try {
      // 空表=到期；零新消息分支用未来 now 钉死（窗口 [now-7d, now] 全在未来，共享库也不可能有消息）→ 不跑
      const future = new Date(Date.now() + 8 * 86400_000);
      expect(await svc.shouldRun(future)).toBe(false);
      // 造一条窗口内消息（真实 now 窗口）→ 到期即跑
      const sid = randomUUID();
      await query(
        `INSERT INTO ai_sessions (id, project_id, code, ctx, name, created_by)
         VALUES ($1,$2,'ss_reflect_probe','req','反思调度探测','t')`, [sid, PID]);
      await query(
        `INSERT INTO ai_messages (session_id, role, content) VALUES ($1,'user','调度探测消息')`, [sid]);
      expect(await svc.shouldRun()).toBe(true);
      // 3 天前已跑过 → 未到期
      await query(
        `INSERT INTO ai_reflections (trigger, window_start, window_end, report, created_at)
         VALUES ('scheduled', now()-interval '10 days', now()-interval '3 days', '历史场次', now()-interval '3 days')`);
      expect(await svc.shouldRun()).toBe(false);
      // 8 天前 → 到期
      await query("UPDATE ai_reflections SET created_at = now() - interval '8 days'");
      expect(await svc.shouldRun()).toBe(true);
    } finally {
      await query('DELETE FROM ai_reflections');
      await restoreReflections(saved);
    }
  });
});
