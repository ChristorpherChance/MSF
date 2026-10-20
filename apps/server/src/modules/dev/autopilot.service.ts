import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { randomUUID } from 'node:crypto';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { liveBaselineFingerprint } from './gate-common.js';
import { DevBoardService } from './board.service.js';
import { DevBuildService } from './build.service.js';
import { DevSelftestService } from './selftest.service.js';

/** mock runner 节奏（测试置 0；M6 换 BullMQ delayed job 链，D-11） */
export const devAutopilotTiming = { tickDelayMs: 15 };

// SELFTEST_FAILED（2026-10-19 起可恢复）：自测红须先人工处置（重跑自测出新报告），
// resume 时核验最新报告非 fail 才放行——「人工处置链」=重跑自测而非绕过门禁
// 2026-10-21：DISPATCH_NO_PROGRESS 入白名单——派发失败的处置动作=解除门禁缺口（处置影响单/重识别/修复派发逻辑）
// 或重批计划，之后 resume 重 tick 是正规恢复路径（仍不过会再阻断，无绕过风险）
const RECOVERABLE_BLOCKERS = new Set(['RUNNER_START_FAILED', 'HUMAN_TASK_REQUIRED', 'SELFTEST_START_FAILED', 'SELFTEST_FAILED', 'TASK_BLOCKED', 'AI_REVIEW_FAILED', 'DISPATCH_NO_PROGRESS', 'UNIT_FAILED']);

/** L6 运行阶段枚举（原型 v18AutoStatusHtml phases 映射：dispatch/development/quality/ai-review/merge/build/awaiting-transfer；selftest 为真实管线扩展档——原型模拟未建模项目自测阶段） */
const RUN_PHASES = new Set(['dispatch', 'development', 'quality', 'ai-review', 'merge', 'build', 'selftest', 'awaiting-transfer']);

interface RunRow {
  id: string; run_id: string; run_token: string; plan_id: string; plan_fingerprint: string;
  authorization_id: string; status: string; phase: string | null; blocker: { code: string; message: string; taskId?: string; category: string } | null;
}

/**
 * autopilot 自动主线（A06-10~12；F02-6/F07；REQ-409/410、BR-13）。
 * - approve.start 同事务：复核展示指纹 → 签发授权（scope 深冻结 transferToTest:false）→ 创建 run+runToken。
 * - tick 决策次序 ①token/status → ②授权/输入/计划重验 → ③运行中操作等待 → ④首个未完成任务派发（一 tick 一动作）
 *   → ⑤全完成查构建 → ⑥自测（人工自测只等待不认领；失败无实质修复不空转） → ⑦合格 → awaiting-transfer 停 runner。
 * - pause/stop/takeover 先旋转 runToken（晚到回调严格零写 OPERATION_STALE），仅取消本运行拥有的 running 操作。
 * - 派发动作各自走命令事务（独立审计）；本服务只做编排（v18DispatchAction 同构）。
 */
@Injectable()
export class DevAutopilotService {
  private readonly runners = new Map<string, boolean>();

  constructor(
    @Inject(DevBoardService) private readonly board: DevBoardService,
    @Inject(DevBuildService) private readonly build: DevBuildService,
    @Inject(DevSelftestService) private readonly selftest: DevSelftestService,
  ) {}

  /** 进程重启 runner 恢复（2026-10-21：runner 是进程内替身，systemctl 重启/部署后
   *  status='running' 的 run 静默死亡——界面永远「自动执行中」且占未终态位锁死新启动；
   *  引导时扫描 running 运行逐个 kickRunner 续 tick；blocked/paused 等人工态不动） */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const rows = await query<{ project_id: string; run_id: string }>(
        "SELECT project_id, run_id FROM dev_runs WHERE status='running'");
      for (const r of rows.rows) {
        this.kickRunner(r.project_id, r.run_id, { projectId: r.project_id, actorKind: 'autopilot', actorId: `autopilot:${r.run_id}` });
      }
      if (rows.rows.length > 0) console.warn(`[autopilot] 进程重启恢复 ${rows.rows.length} 个 running 运行的 runner`);
    } catch (e) {
      console.error('[autopilot] runner 恢复扫描失败（不阻断启动）', e);
    }
  }

  onModuleInit(): void {
    // A06-10 批准并启动（同事务：复核 → 授权 → run）
    registerCommand('dev.autopilot.approve-start', async (client, payload, ctx) => {
      const { projectId, displayedRevisionId, displayedFingerprint } = payload as {
        projectId: string; displayedRevisionId: string; displayedFingerprint: string;
      };
      // 人工硬约束（F07-3：7 确认点冻结枚举之外，批准启动永不可由 AI 通道触发）
      if (ctx.actorKind !== 'human') {
        throw new DomainError('POLICY_MANUAL_REQUIRED', 'autopilot 批准启动须人工操作', 'dev.autopilot.approve-start');
      }
      // 入参兜底：缺展示修订/指纹不得裸 TypeError 落 500（实机走查修复，同 #16 口径）
      if (typeof displayedRevisionId !== 'string' || !displayedRevisionId) {
        throw new DomainError('VALIDATION_FAILED', '展示的计划修订号缺失（displayedRevisionId）', 'displayedRevisionId');
      }
      if (typeof displayedFingerprint !== 'string' || !displayedFingerprint) {
        throw new DomainError('VALIDATION_FAILED', '展示的计划指纹缺失（displayedFingerprint）', 'displayedFingerprint');
      }
      const revNo = Number(displayedRevisionId.replace(/^plan-r/, ''));
      const plan = await client.query<{ id: string; state: string; plan_fingerprint: string; baseline_fingerprint: string; snapshot: { taskIds?: string[] } }>(
        'SELECT * FROM dev_plans WHERE project_id=$1 AND revision=$2 FOR UPDATE', [projectId, revNo]);
      const p = plan.rows[0];
      if (!p || p.state !== 'approved') throw new DomainError('INVALID_STATE', '计划未批准', displayedRevisionId);
      if (p.plan_fingerprint !== displayedFingerprint.replace(/^sha256:/, '')) {
        throw new DomainError('STALE_EVIDENCE', '展示的修订/指纹与服务端不一致', displayedRevisionId);
      }
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== p.baseline_fingerprint) throw new DomainError('STALE_EVIDENCE', '基线已变化', displayedRevisionId);
      const active = await client.query<{ run_id: string }>(
        "SELECT run_id FROM dev_runs WHERE project_id=$1 AND status NOT IN ('stopped','transferred')", [projectId]);
      if (active.rows[0]) throw new DomainError('INVALID_STATE', '存在未终态运行', active.rows[0].run_id);
      const seqA = await client.query<{ n: string }>("SELECT nextval('dev_auth_seq') AS n");
      const authId = `auth_${Number(seqA.rows[0]!.n)}`;
      const tasks = await client.query<{ code: string; rev: number }>(
        'SELECT code, rev FROM dev_tasks WHERE project_id=$1 AND code = ANY($2)', [projectId, p.snapshot.taskIds ?? []]);
      // scope 深冻结：transferToTest 永 false（F07-3 自动放行上限）
      const scope = { development: true, unitCi: true, aiReview: true, merge: true, integrationBuild: true, transferToTest: false };
      await client.query(
        `INSERT INTO dev_authorizations (project_id, authorization_id, plan_id, scope, task_ids, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'active',$6)`,
        [projectId, authId, p.id, JSON.stringify(scope), JSON.stringify(tasks.rows), ctx.actorId]);
      const seqR = await client.query<{ n: string }>("SELECT nextval('dev_run_seq') AS n");
      const runId = `run_${Number(seqR.rows[0]!.n)}`;
      const runToken = randomUUID();
      await client.query(
        `INSERT INTO dev_runs (project_id, run_id, run_token, plan_id, plan_fingerprint, authorization_id, status, phase, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,'running','dispatch',$7)`,
        [projectId, runId, runToken, p.id, p.plan_fingerprint, authId, ctx.actorId]);
      return { runId, runToken, authorizationId: authId, status: 'running', operationId: `op_ap_${runId}` };
    });

    // A06-11 控制：先旋转 runToken，再仅取消本运行归属的 running 操作；stop 另撤销授权
    const control = async (client: import('pg').PoolClient, projectId: string, action: 'paused' | 'stopped' | 'taken-over') => {
      // 2026-10-21：awaiting-transfer 纳入可控制态——该态 runner 已停（无并发 tick），
      // 唯一出口本是「转测试」；但任务池重识别/自测死路场景旧 run 永远转不出去，
      // 项目被「存在未终态运行」永锁。人工 stop（放弃本轮转测试）是正规逃生门。
      const run = await client.query<RunRow>(
        "SELECT * FROM dev_runs WHERE project_id=$1 AND status IN ('running','blocked','paused','taken-over','awaiting-transfer') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [projectId]);
      const r = run.rows[0];
      if (!r) throw new DomainError('INVALID_STATE', '无可控制的运行', projectId);
      // 等待转测试态仅可 stop（放弃本轮转测试）——pause/takeover 语义不成立（runner 本就已停）
      if (r.status === 'awaiting-transfer' && action !== 'stopped') {
        throw new DomainError('INVALID_STATE', '等待转测试态仅可停止（放弃本轮）或走转测试确认', r.run_id);
      }
      const newToken = randomUUID();
      const cancelled = await client.query<{ n: string }>(
        `WITH upd AS (UPDATE dev_operations SET status='cancelled', updated_at=now()
           WHERE project_id=$1 AND run_id=$2 AND token=$3 AND status='running' RETURNING 1)
         SELECT count(*) AS n FROM upd`, [projectId, r.run_id, r.run_token]);
      await client.query('UPDATE dev_runs SET run_token=$3, status=$4, updated_at=now() WHERE id=$1 AND project_id=$2',
        [r.id, projectId, newToken, action]);
      if (action === 'stopped') {
        await client.query("UPDATE dev_authorizations SET status='revoked', updated_at=now() WHERE project_id=$1 AND authorization_id=$2",
          [projectId, r.authorization_id]);
      }
      return { runId: r.run_id, status: action, cancelledOperations: Number(cancelled.rows[0]?.n ?? 0) };
    };
    registerCommand('dev.autopilot.pause', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      return control(client, projectId, 'paused');
    });
    registerCommand('dev.autopilot.stop', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      return control(client, projectId, 'stopped');
    });
    registerCommand('dev.autopilot.takeover', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      return control(client, projectId, 'taken-over');
    });

    // resume（可恢复阻断码白名单 + 重验授权/输入/计划；新 token）
    registerCommand('dev.autopilot.resume', async (client, payload) => {
      const { projectId } = payload as { projectId: string };
      const run = await client.query<RunRow>(
        "SELECT * FROM dev_runs WHERE project_id=$1 AND status IN ('paused','blocked','taken-over') ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
        [projectId]);
      const r = run.rows[0];
      if (!r) throw new DomainError('INVALID_STATE', '无可恢复的运行', projectId);
      if (r.status === 'blocked' && !RECOVERABLE_BLOCKERS.has(r.blocker?.code ?? '')) {
        throw new DomainError('INVALID_STATE', `阻断码 ${r.blocker?.code ?? ''} 不可直接恢复，须经人工处置链`, r.run_id);
      }
      // SELFTEST_FAILED 恢复前置：最新自测报告不得仍 fail（处置动作=重跑自测，报告翻绿/在跑才放行）
      if (r.blocker?.code === 'SELFTEST_FAILED') {
        const rep = await client.query<{ status: string; code: string }>(
          'SELECT status, code FROM dev_reports WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
        if (!rep.rows[0] || rep.rows[0].status === 'fail') {
          throw new DomainError('INVALID_STATE', '自测报告仍未通过——请先在「开发自测」重跑自测（处置完成再恢复）', r.run_id);
        }
      }
      const auth = await client.query<{ status: string }>(
        'SELECT status FROM dev_authorizations WHERE project_id=$1 AND authorization_id=$2', [projectId, r.authorization_id]);
      if (auth.rows[0]?.status !== 'active') throw new DomainError('INVALID_STATE', '授权已失效', r.authorization_id);
      const plan = await client.query<{ plan_fingerprint: string; baseline_fingerprint: string; state: string }>(
        'SELECT * FROM dev_plans WHERE id=$1', [r.plan_id]);
      if (plan.rows[0]?.state !== 'approved' || plan.rows[0].plan_fingerprint !== r.plan_fingerprint) {
        throw new DomainError('STALE_EVIDENCE', '计划已变化，须重新准备', r.run_id);
      }
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== plan.rows[0].baseline_fingerprint) throw new DomainError('STALE_EVIDENCE', '基线已变化', r.run_id);
      const newToken = randomUUID();
      await client.query("UPDATE dev_runs SET run_token=$3, status='running', blocker=NULL, updated_at=now() WHERE id=$1 AND project_id=$2",
        [r.id, projectId, newToken]);
      return { runId: r.run_id, status: 'running' };
    });

    // 阻断（旋转 token + blocker + 停 runner；F07-4 生成「需你处理」由 status 查询承载）
    registerCommand('dev.autopilot.block', async (client, payload) => {
      const { projectId, runId, blocker } = payload as {
        projectId: string; runId: string; blocker: { code: string; message: string; taskId?: string; category: string };
      };
      const run = await client.query<RunRow>(
        'SELECT * FROM dev_runs WHERE project_id=$1 AND run_id=$2 FOR UPDATE', [projectId, runId]);
      if (!run.rows[0]) throw new DomainError('NOT_FOUND', '运行不存在', runId);
      await client.query(
        "UPDATE dev_runs SET run_token=$3, status='blocked', blocker=$4, updated_at=now() WHERE id=$1 AND project_id=$2",
        [run.rows[0].id, projectId, randomUUID(), JSON.stringify(blocker)]);
      return { runId, status: 'blocked', blocker };
    });

    // 原子写 awaiting-transfer（⑦；停在此态等人工——autopilot 永不自行转测试）
    registerCommand('dev.autopilot.awaiting-transfer', async (client, payload) => {
      const { projectId, runId } = payload as { projectId: string; runId: string };
      await client.query(
        "UPDATE dev_runs SET status='awaiting-transfer', phase='awaiting-transfer', updated_at=now() WHERE project_id=$1 AND run_id=$2 AND status='running'",
        [projectId, runId]);
      return { runId, status: 'awaiting-transfer' };
    });

    // 派发回执登记（审计链：每派发 tick 一条）+ L6 阶段推进随回执落库（phase 闭集校验）
    registerCommand('dev.autopilot.advance', async (client, payload) => {
      const { projectId, runId, phase } = payload as { projectId?: string; runId?: string; phase?: string };
      if (projectId && runId && phase !== undefined) {
        if (!RUN_PHASES.has(phase)) throw new DomainError('VALIDATION_FAILED', '未知运行阶段', phase);
        await client.query(
          "UPDATE dev_runs SET phase=$3, updated_at=now() WHERE project_id=$1 AND run_id=$2 AND status='running'",
          [projectId, runId, phase]);
      }
      return { receipt: payload };
    });
  }

  // ---------- 命令入口与编排 ----------

  async approveStart(projectId: string, displayedRevisionId: string, displayedFingerprint: string, ctx: CommandContext) {
    const r = (await executeCommand('dev.autopilot.approve-start',
      { projectId, displayedRevisionId, displayedFingerprint }, { ...ctx, projectId })) as { runId: string };
    this.kickRunner(projectId, r.runId, ctx);
    return r;
  }

  async control(projectId: string, action: 'pause' | 'stop' | 'takeover' | 'resume', ctx: CommandContext) {
    const cmd = { pause: 'dev.autopilot.pause', stop: 'dev.autopilot.stop', takeover: 'dev.autopilot.takeover', resume: 'dev.autopilot.resume' }[action];
    if (action !== 'resume') this.runners.delete(projectId); // 停 runner 循环
    const r = await executeCommand(cmd, { projectId }, { ...ctx, projectId });
    if (action === 'resume') {
      const st = (await this.status(projectId)) as { run: { runId: string } | null };
      if (st.run) this.kickRunner(projectId, st.run.runId, ctx);
    }
    return r;
  }

  /** A06-12 状态查询 */
  async status(projectId: string) {
    const run = await query<RunRow & { created_at: string }>(
      'SELECT * FROM dev_runs WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const r = run.rows[0];
    if (!r) return { run: null, authorization: null };
    const auth = await query<{ authorization_id: string; status: string; scope: unknown; plan_id: string }>(
      'SELECT * FROM dev_authorizations WHERE project_id=$1 AND authorization_id=$2', [projectId, r.authorization_id]);
    return {
      run: { runId: r.run_id, status: r.status, phase: r.phase ?? 'dispatch', currentAction: '', blocker: r.blocker },
      authorization: auth.rows[0]
        ? { authorizationId: auth.rows[0].authorization_id, status: auth.rows[0].status, scope: auth.rows[0].scope }
        : null,
    };
  }

  /** 晚到回调严格零写（BR-08/REQ-410）：token 双不匹配 → OPERATION_STALE，不产生任何写 */
  async lateCallback(projectId: string, operationId: string, token: string) {
    const op = await query<{ token: string; status: string }>(
      'SELECT token, status FROM dev_operations WHERE project_id=$1 AND operation_id=$2', [projectId, operationId]);
    if (!op.rows[0] || op.rows[0].token !== token || op.rows[0].status !== 'running') {
      throw new DomainError('OPERATION_STALE', '回调身份不符（晚到/失效），严格零写', operationId);
    }
    return { ok: true };
  }

  /** mock runner：每 tickDelayMs 触发一次 tick 直到终态/被停（D-11 BullMQ 链的进程内替身）
   *  U-026：tick 失败不得静默空转——记日志，持续 >10s 无进展落 DISPATCH_NO_PROGRESS 阻断（可被「需你处理」看见） */
  private readonly tickFailures = new Map<string, { first: number; count: number }>();

  private kickRunner(projectId: string, runId: string, ctx: CommandContext): void {
    if (this.runners.get(projectId)) return;
    this.runners.set(projectId, true);
    const loop = async (): Promise<void> => {
      if (!this.runners.get(projectId)) return;
      let done = false;
      try {
        done = await this.tick(projectId, runId, ctx);
        this.tickFailures.delete(projectId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const f = this.tickFailures.get(projectId) ?? { first: Date.now(), count: 0 };
        f.count += 1;
        this.tickFailures.set(projectId, f);
        if (f.count === 1 || f.count % 200 === 0) {
          console.error(`[autopilot] tick 失败 run=${runId} 连续第 ${f.count} 次: ${msg}`);
        }
        if (Date.now() - f.first > 10_000) {
          this.tickFailures.delete(projectId);
          await this.block(projectId, runId, { code: 'DISPATCH_NO_PROGRESS', message: `派发持续失败：${msg}`, category: 'control' }, ctx)
            .catch((be) => console.error('[autopilot] 阻断落库失败', be));
          done = true;
        }
      }
      if (done) { this.runners.delete(projectId); return; }
      setTimeout(() => void loop(), devAutopilotTiming.tickDelayMs);
    };
    setTimeout(() => void loop(), devAutopilotTiming.tickDelayMs);
  }

  /** 单次 tick（决策次序①~⑦，一次至多一个派发动作）；返回 true=已到终态 */
  async tick(projectId: string, runId: string, ctx: CommandContext): Promise<boolean> {
    const autoCtx: CommandContext = { projectId, actorKind: 'autopilot', actorId: `autopilot:${runId}` };
    // ① runToken/status
    const run = await query<RunRow>('SELECT * FROM dev_runs WHERE project_id=$1 AND run_id=$2', [projectId, runId]);
    const r = run.rows[0];
    if (!r || r.status !== 'running') return true;
    // ② 授权/计划/输入重验
    const auth = await query<{ status: string }>(
      'SELECT status FROM dev_authorizations WHERE project_id=$1 AND authorization_id=$2', [projectId, r.authorization_id]);
    const plan = await query<{ state: string; plan_fingerprint: string; baseline_fingerprint: string; snapshot: { taskIds?: string[] } }>(
      'SELECT * FROM dev_plans WHERE id=$1', [r.plan_id]);
    const p = plan.rows[0];
    const live = await liveBaselineFingerprint(null, projectId);
    if (auth.rows[0]?.status !== 'active' || !p || p.state !== 'approved' || p.plan_fingerprint !== r.plan_fingerprint || live !== p.baseline_fingerprint) {
      await this.block(projectId, runId, { code: 'SELFTEST_INPUT_STALE', message: '授权/计划/输入已变化', category: 'gate' }, ctx);
      await query("UPDATE dev_authorizations SET status='revoked', updated_at=now() WHERE project_id=$1 AND authorization_id=$2", [projectId, r.authorization_id]);
      return true;
    }
    // ④ 首个未完成任务（批次序派发：快照定成员资格、编排定执行次序——2026-10-21 根修：
    // 旧口径按计划快照数组序，提交端乱序（如 SQL string_agg 无序）会把高批次页面排在基座前，
    // 开始门禁 BATCH_NOT_DONE 反复拒绝 → DISPATCH_NO_PROGRESS 冤案）；一 tick 一动作
    const taskIds = p.snapshot.taskIds ?? [];
    const tasks = await query<{ id: string; code: string; col: string; prog: number; asg_type: string; code_rev: number; blocked: boolean; run_status: string; blocked_reason: string | null; batch_no: number | null }>(
      'SELECT id, code, col, prog, asg_type, code_rev, blocked, run_status, blocked_reason, batch_no FROM dev_tasks WHERE project_id=$1 AND code = ANY($2)', [projectId, taskIds]);
    const next = tasks.rows
      .filter((t) => t.col !== 'done')
      .sort((a, b) => (a.batch_no ?? 9999) - (b.batch_no ?? 9999) || a.code.localeCompare(b.code))[0];
    if (next) {
      if (next.asg_type === 'human') {
        await this.block(projectId, runId, { code: 'HUMAN_TASK_REQUIRED', message: `任务 ${next.code} 需人工承接`, taskId: next.id, category: 'control' }, ctx);
        return true;
      }
      // 卡死断点根修（2026-10-20）：ing 列但执行器已败（blocked/stopped，如 AI 写码失败）——
      // 旧口径 else 静默等待，runner 无限空转、界面永远「自动执行中」；落可恢复阻断，人工处置后 resume
      if (next.col === 'ing' && (next.blocked || next.run_status === 'stopped')) {
        await this.block(projectId, runId, {
          code: 'TASK_BLOCKED',
          message: `任务 ${next.code} 执行中断：${next.blocked_reason ?? '已停止'}——处置后点「继续」`,
          taskId: next.id, category: 'control',
        }, ctx);
        return true;
      }
      let phase: string; // L6：本次派发动作对应的真实阶段（随 advance 回执落库）
      if (next.col === 'queue') {
        await this.board.transition(projectId, next.id, 'ing', undefined, autoCtx);
        await this.board.run(projectId, next.id, autoCtx); // mock 编码完成 prog=100
        phase = 'development';
      } else if (next.col === 'ing' && next.prog === 100) {
        await this.board.transition(projectId, next.id, 'review', undefined, autoCtx);
        phase = 'quality';
      } else if (next.col === 'review') {
        // 质量 → AI 评审 → 合并（证据缺失才补；防空转由证据已存在判定承载）
        // 证据须匹配当前代码修订（与合并自动门禁同口径；旧 codeRev 证据不算数）
        const unitLatest = await query<{ pass: boolean | null }>(
          `SELECT (payload->>'pass')::boolean AS pass FROM evd_records WHERE project_id=$1 AND kind='unit' AND payload->>'taskId'=$2
           AND payload->>'codeRev'=$3 ORDER BY created_at DESC LIMIT 1`,
          [projectId, next.id, String(next.code_rev)]);
        if (unitLatest.rows.length === 0) {
          await this.board.quality(projectId, next.id, autoCtx);
          phase = 'quality';
        } else if (unitLatest.rows[0]!.pass === false) {
          // 单测红自动返工（2026-10-21 根修「评审态空转」：旧口径最新证据红也每 tick 重跑 quality，
          // 同一份代码测一万次还是红——T-031 实锤 2 秒一条 fail 证据无限刷屏）：
          // 轻量重开发 review→queue（codegen 反馈回路注入失败日志重写）；strike=失败的代码修订轮数
          // （distinct codeRev——同一代码被空转 bug 重复测试的 fail 不重复计），满 3 轮阻断待人工
          const fails = await query<{ n: string }>(
            `SELECT count(DISTINCT payload->>'codeRev') AS n FROM evd_records WHERE project_id=$1 AND kind='unit' AND payload->>'taskId'=$2
             AND (payload->>'pass')::boolean=false`,
            [projectId, next.id]);
          if (Number(fails.rows[0]!.n) >= 3) {
            await this.block(projectId, runId, {
              code: 'UNIT_FAILED', message: `任务 ${next.code} 沙箱单测连续 ${fails.rows[0]!.n} 轮代码修订不通过——人工处置（返工/修测试/人工合并）后点「继续」`,
              taskId: next.id, category: 'quality',
            }, ctx);
            return true;
          }
          await this.board.redevelop(projectId, next.id, autoCtx);
          phase = 'development';
        } else {
          const hasReview = await query<{ conclusion: string | null }>(
            `SELECT payload->>'conclusion' AS conclusion FROM evd_records WHERE project_id=$1 AND kind='ai-review' AND payload->>'taskId'=$2
             AND payload->>'codeRev'=$3 ORDER BY created_at DESC LIMIT 1`,
            [projectId, next.id, String(next.code_rev)]);
          if (hasReview.rows.length === 0) {
            await this.board.aiReview(projectId, next.id, autoCtx);
            phase = 'ai-review';
          } else if (hasReview.rows[0]!.conclusion === 'fail') {
            // AI 真评审红（2026-10-20 real 真评审配套）：不带着红评审自动合并——阻断待人工
            // （处置=返工重写码 或 人工核对后 checklist 合并兜底，评审意见在任务证据里）
            await this.block(projectId, runId, {
              code: 'AI_REVIEW_FAILED', message: `任务 ${next.code} AI 评审不通过——返工或人工合并处置后点「继续」`,
              taskId: next.id, category: 'quality',
            }, ctx);
            return true;
          } else {
            await this.board.merge(projectId, next.id, 'autopilot-authorization', undefined, r.authorization_id, autoCtx);
            phase = 'merge';
          }
        }
      } else {
        return false; // 中间态（ing 未完成等）：等待下个 tick，不写阶段
      }
      await executeCommand('dev.autopilot.advance', { projectId, runId, dispatched: next.code, phase }, autoCtx);
      return false;
    }
    // ⑤ 集成构建（缺则派发，仅一次）
    const buildCur = (await this.build.current(projectId)) as { build: { planRevision: number } | null };
    const planRev = await query<{ revision: number }>('SELECT revision FROM dev_plans WHERE id=$1', [r.plan_id]);
    if (!buildCur.build || buildCur.build.planRevision !== planRev.rows[0]!.revision) {
      await this.build.run(projectId, autoCtx);
      await executeCommand('dev.autopilot.advance', { projectId, runId, phase: 'build' }, autoCtx);
      return false;
    }
    // ⑥ 自测（人工 running 只等待；失败无实质修复不空转）
    const gate = await this.selftest.gate(projectId);
    if (gate.ok) {
      // ⑦ 合格 → awaiting-transfer
      await executeCommand('dev.autopilot.awaiting-transfer', { projectId, runId }, autoCtx);
      return true;
    }
    const latestReport = (gate as { report: { status: string } | null }).report;
    const running = gate.issues.some((i) => i.code === 'SELFTEST_RUNNING');
    if (running) return false; // 人工自测进行中：只等待不认领
    if (latestReport?.status === 'fail') {
      // 无实质返工 → 阻断不空转（DISPATCH_NO_PROGRESS 防护由 remediation 核验承载）
      await this.block(projectId, runId, { code: 'SELFTEST_FAILED', message: '自测未通过，待人工返工', category: 'quality' }, ctx);
      return true;
    }
    if (gate.issues.some((i) => i.code === 'SELFTEST_REQUIRED' || i.code === 'SELFTEST_BUILD_STALE' || i.code === 'SELFTEST_DESIGN_STALE')) {
      // W2-013：新构建/新基线使旧报告过期（STALE）时同样自动开启新一轮自测，不再静默空转
      await this.selftest.start(projectId, autoCtx);
      await executeCommand('dev.autopilot.advance', { projectId, runId, phase: 'selftest' }, autoCtx);
      return false;
    }
    return false;
  }

  private async block(projectId: string, runId: string, blocker: { code: string; message: string; taskId?: string; category: string }, ctx: CommandContext) {
    await executeCommand('dev.autopilot.block', { projectId, runId, blocker }, { ...ctx, projectId });
  }
}
