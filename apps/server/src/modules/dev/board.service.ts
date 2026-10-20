import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PoolClient } from 'pg';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { SandboxService } from '../executor/sandbox.service.js';
import { liveBaselineFingerprint, sha256, type GateIssue } from './gate-common.js';
import { DevCodegenService } from './codegen.service.js';
import { devMode, DevWorkspaceService } from './workspace.service.js';
import { AI_PROVIDER, type AiProvider } from '../ai/ai-provider.interface.js';

const execFileP = promisify(execFile);

/** AI 评审系统 prompt（代码内置）：任务规格+提交 diff → 严格 JSON 结论（只评不判 merged，人工/授权链收口） */
const AI_REVIEW_SYSTEM = `你是软件工厂的独立代码评审器（评审者≠作者）。输入=任务规格（目标/验收）与该任务最近一次代码提交的 diff。产出严格 JSON：
{"verdict":"pass|fail","comment":"一句话评审意见（fail=必须说清阻断点：…；pass=可合并理由：…）"}
纪律：只评本提交相对任务规格的符合性、明显缺陷与约定违反（如根相对路径/外网依赖）；comment 一句话说清依据。`;

/** 评审 LLM 看门狗（design review 同构）：上游静默挂起不吊死 autopilot tick */
const AI_REVIEW_WATCHDOG_MS = 10 * 60_000;

/**
 * 看板流转与单任务开发循环（F02-5；A06-8；REQ-405/407/408/411）。
 * 看板列 queue/ing/review/done；阻塞是标记不是列。
 * 执行器两态（2026-10-18 开发域真化，MSF_DEV_MODE=real 开真）：
 * - mock：task.run=编码完成（prog=100）；quality.complete=单测+CI 证据（确定性 payload）
 * - real：task.run=AI 真写码（DevCodegenService 异步，complete 命令收尾 prog=100）；
 *   quality.complete=沙箱真跑 npm test（退出码即结论，日志/环境指纹/gitSha 入证据）
 * 合并依据四类之一深冻结（REQ-411）：manual-checklist/manual-skip/autopilot-authorization/legacy-manual。
 */

interface TaskRow {
  id: string; project_id: string; code: string; col: string; run_status: string; prog: number;
  rev: number; code_rev: number; deps: string[]; write_scopes: string[]; batch_no: number | null;
  asg_type: string; owner: string; blocked: boolean;
}

export const MERGE_BASIS_TYPES = ['manual-checklist', 'manual-skip', 'autopilot-authorization', 'legacy-manual'] as const;

@Injectable()
export class DevBoardService {
  /** 真化依赖全可选注入：测试直接 new DevBoardService() 走 mock 路径（零破坏）；real 模式缺依赖=明确报错 */
  constructor(
    @Optional() @Inject(DevCodegenService) private readonly codegen?: DevCodegenService,
    @Optional() @Inject(SandboxService) private readonly sandbox?: SandboxService,
    @Optional() @Inject(DevWorkspaceService) private readonly ws?: DevWorkspaceService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  onModuleInit(): void {
    // task.start（devStartGate 实时求值，F02-5 迁移行前置全量）
    registerCommand('dev.task.start', async (client, payload) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      const t = await this.lockTask(client, projectId, taskId);
      const issues = await this.startGateIssues(client, projectId, t, false);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '开始门禁未通过', taskId, { issues });
      await client.query(
        "UPDATE dev_tasks SET col='ing', run_status=$3, updated_by='system', updated_at=now() WHERE id=$1 AND project_id=$2",
        [taskId, projectId, t.asg_type === 'human' ? 'manual' : 'running']);
      return { id: taskId, col: 'ing' };
    });

    registerCommand('dev.task.resume', async (client, payload) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing' || !['paused', 'stopped'].includes(t.run_status)) {
        throw new DomainError('INVALID_STATE', '仅进行中且已暂停/停止的任务可继续', taskId);
      }
      // 恢复重过 devStartGate 实时求值（F02-5 task.resume）
      const issues = await this.startGateIssues(client, projectId, t, true);
      if (issues.length > 0) throw new DomainError('GATE_BLOCKED', '恢复门禁未通过', taskId, { issues });
      await client.query(
        "UPDATE dev_tasks SET run_status=$3, updated_at=now() WHERE id=$1 AND project_id=$2",
        [taskId, projectId, t.asg_type === 'human' ? 'manual' : 'running']);
      return { id: taskId, runStatus: 'running' };
    });

    registerCommand('dev.task.pause', async (client, payload) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing' || t.run_status !== 'running') throw new DomainError('INVALID_STATE', '仅运行中任务可暂停', taskId);
      await client.query("UPDATE dev_tasks SET run_status='paused', updated_at=now() WHERE id=$1", [taskId]);
      return { id: taskId, runStatus: 'paused' };
    });

    registerCommand('dev.task.stop', async (client, payload) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing' || !['running', 'paused'].includes(t.run_status)) {
        throw new DomainError('INVALID_STATE', '仅运行中/已暂停任务可停止', taskId);
      }
      // 旋转运行中操作 opToken 并标 cancelled（归属本任务的 running 操作）
      await client.query(
        "UPDATE dev_operations SET status='cancelled', updated_at=now() WHERE project_id=$1 AND status='running' AND action='dev.task.run' AND receipt->>'taskId'=$2",
        [projectId, taskId]);
      await client.query("UPDATE dev_tasks SET run_status='stopped', updated_at=now() WHERE id=$1", [taskId]);
      return { id: taskId, runStatus: 'stopped' };
    });

    // 编码执行（mock=prog=100；real=AI 写码起步标记 prog=10，真收尾在 dev.task.run.complete）
    registerCommand('dev.task.run', async (client, payload) => {
      const { projectId, taskId, mode } = payload as { projectId: string; taskId: string; mode?: string };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing' || !['running', 'manual'].includes(t.run_status)) {
        throw new DomainError('INVALID_STATE', '任务须在进行中且运行态才可执行编码', taskId);
      }
      if (mode === 'real') {
        // 真化：起步标记（阻塞标记随重试解除——上一轮失败留下的 blocked 在此清掉）
        await client.query('UPDATE dev_tasks SET prog=10, blocked=false, blocked_reason=NULL, updated_at=now() WHERE id=$1', [taskId]);
        return { id: taskId, prog: 10, codegen: 'started' };
      }
      await client.query('UPDATE dev_tasks SET prog=100, updated_at=now() WHERE id=$1', [taskId]);
      return { id: taskId, prog: 100 };
    });

    // 人工进度推进（human 任务）
    registerCommand('dev.task.progress', async (client, payload) => {
      const { projectId, taskId, prog } = payload as { projectId: string; taskId: string; prog: number };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing') throw new DomainError('INVALID_STATE', '任务不在进行中', taskId);
      const next = Math.max(0, Math.min(100, Math.round(prog)));
      await client.query('UPDATE dev_tasks SET prog=$3, updated_at=now() WHERE id=$1 AND project_id=$2', [taskId, projectId, next]);
      return { id: taskId, prog: next };
    });

    // pr.submit（codeRev+1；生成 PR(review，checklist 全未勾)；col=review；清空旧证据语义由 codeRev 隔离承载）
    registerCommand('dev.pr.submit', async (client, payload, ctx) => {
      const { projectId, taskId } = payload as { projectId: string; taskId: string };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'ing' || t.prog !== 100) {
        throw new DomainError('INVALID_STATE', '提交评审须进行中且进度 100%', taskId);
      }
      const newRev = t.code_rev + 1;
      // 旧 PR 转历史只读（PR_STALE 语义由 status='stale' 承载）
      await client.query("UPDATE dev_prs SET status='stale', updated_at=now() WHERE task_id=$1 AND status IN ('review','changes')", [taskId]);
      await client.query(
        `INSERT INTO dev_prs (project_id, task_id, code_rev, pr_ref, status, checklist, created_by)
         VALUES ($1,$2,$3,$4,'review','{"acceptance":false,"standards":false,"design":false}',$5)`,
        [projectId, taskId, newRev, `PR-${t.code}-r${newRev}`, ctx.actorId]);
      await client.query("UPDATE dev_tasks SET code_rev=$3, col='review', updated_at=now() WHERE id=$1 AND project_id=$2",
        [taskId, projectId, newRev]);
      return { id: taskId, col: 'review', codeRev: newRev, prRef: `PR-${t.code}-r${newRev}` };
    });

    // 人工 checklist 勾选（仅 review 态 PR；自动结果不可勾选由操作者身份保证——autopilot 合并不走本命令）
    registerCommand('dev.pr.toggle-check', async (client, payload) => {
      const { projectId, taskId, key, checked } = payload as { projectId: string; taskId: string; key: string; checked: boolean };
      if (!['acceptance', 'standards', 'design'].includes(key)) {
        throw new DomainError('VALIDATION_FAILED', 'checklist 键闭集 acceptance/standards/design', key);
      }
      const pr = await this.lockCurrentPr(client, projectId, taskId);
      const checklist = { ...(pr.checklist as Record<string, boolean>), [key]: !!checked };
      await client.query('UPDATE dev_prs SET checklist=$3, updated_at=now() WHERE id=$1 AND project_id=$2',
        [pr.id, projectId, JSON.stringify(checklist)]);
      return { prRef: pr.pr_ref, checklist };
    });

    // 有理由的人工豁免（doPrSkip；理由必填）
    registerCommand('dev.pr.skip', async (client, payload) => {
      const { projectId, taskId, reason } = payload as { projectId: string; taskId: string; reason?: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '豁免理由必填', 'reason');
      const pr = await this.lockCurrentPr(client, projectId, taskId);
      await client.query(
        "UPDATE dev_prs SET checklist=jsonb_set(checklist,'{skipped}','true'), updated_at=now() WHERE id=$1", [pr.id]);
      return { prRef: pr.pr_ref, skipped: true, reason };
    });

    // quality.complete（mock=确定性单测+CI 证据；real=沙箱真跑 npm test 的真实结论，事务外执行结果随 payload 登记）
    registerCommand('dev.quality.complete', async (client, payload) => {
      const { projectId, taskId, real } = payload as {
        projectId: string; taskId: string;
        real?: { exitCode: number; logsTail: string; envFingerprint: string; durationMs: number; gitSha: string | null };
      };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'review') throw new DomainError('INVALID_STATE', '单测/CI 在评审列执行（先提交评审）', taskId);
      const commit = sha256(`${taskId}:${t.code_rev}`);
      if (real) {
        const pass = real.exitCode === 0;
        await appendEvidence(client, {
          projectId, kind: 'unit',
          payload: {
            taskId, taskRev: t.rev, codeRev: t.code_rev, mode: 'sandbox',
            pass, exitCode: real.exitCode, durationMs: real.durationMs,
            envFingerprint: real.envFingerprint, gitSha: real.gitSha,
            line: null, branch: null, threshold: { line: 80, branch: 70 },
            logsTail: real.logsTail.slice(-3000), commitId: commit,
            note: '沙箱真实执行 npm test（退出码即结论；覆盖率采集后续补）',
          },
        });
        await client.query(
          `INSERT INTO dev_ci_reports (project_id, delivery_id, provider, commit_sha, pr_ref, task_codes, matched, conclusion, payload, payload_fingerprint)
           VALUES ($1,$2,'sandbox-local',$3,$4,$5,true,$6,$7,$8)`,
          [projectId, randomUUID(), commit, `PR-${t.code}-r${t.code_rev}`, JSON.stringify([t.code]),
            pass ? 'pass' : 'fail',
            JSON.stringify({ runner: 'sandbox', exitCode: real.exitCode, gitSha: real.gitSha, envFingerprint: real.envFingerprint, logsTail: real.logsTail.slice(-2000) }),
            sha256(`ci:${commit}:${real.exitCode}:${real.gitSha ?? ''}`)]);
        return { id: taskId, codeRev: t.code_rev, unit: pass ? 'pass' : 'fail', ci: pass ? 'pass' : 'fail', commitId: commit, mode: 'sandbox' };
      }
      await appendEvidence(client, {
        projectId, kind: 'unit',
        payload: { taskId, taskRev: t.rev, codeRev: t.code_rev, line: 85, branch: 78, threshold: { line: 80, branch: 70 }, pass: true, commitId: commit },
      });
      await client.query(
        `INSERT INTO dev_ci_reports (project_id, delivery_id, provider, commit_sha, pr_ref, task_codes, matched, conclusion, payload, payload_fingerprint)
         VALUES ($1,$2,'mock-local',$3,$4,$5,true,'pass',$6,$7)`,
        [projectId, randomUUID(), commit, `PR-${t.code}-r${t.code_rev}`, JSON.stringify([t.code]),
          JSON.stringify({ runner: 'mock', conclusion: 'pass' }), sha256(`ci:${commit}`)]);
      return { id: taskId, codeRev: t.code_rev, unit: 'pass', ci: 'pass', commitId: commit };
    });

    // ai-review.complete（独立 AI 评审：评审者 ≠ owner；real 模式 payload.real 带真实评审结论，
    // 事务外 LLM 已在 service 层完成——嵌套 LLM 绝不进命令事务；mock 路径如实标 mode='mock'）
    registerCommand('dev.ai-review.complete', async (client, payload) => {
      const { projectId, taskId, real } = payload as {
        projectId: string; taskId: string;
        real?: { conclusion: 'pass' | 'fail'; note: string; diffStat: string | null };
      };
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'review') throw new DomainError('INVALID_STATE', '任务不在待评审', taskId);
      if (real) {
        await appendEvidence(client, {
          projectId, kind: 'ai-review',
          payload: {
            taskId, codeRev: t.code_rev, reviewer: 'ai-reviewer', owner: t.owner,
            conclusion: real.conclusion, note: real.note, mode: 'ai', diffStat: real.diffStat,
          },
        });
        return { id: taskId, review: real.conclusion, reviewer: 'ai-reviewer', mode: 'ai' };
      }
      await appendEvidence(client, {
        projectId, kind: 'ai-review',
        payload: { taskId, codeRev: t.code_rev, reviewer: 'mock-reviewer', owner: t.owner, conclusion: 'pass', note: 'mock 独立评审（非真实评审，real 模式不计入自测评审门）', mode: 'mock' },
      });
      return { id: taskId, review: 'pass', reviewer: 'mock-reviewer', mode: 'mock' };
    });

    // pr.merge（自动门禁 + 人工 checklist 全勾或有理由豁免；合并依据四类之一深冻结，REQ-411）
    registerCommand('dev.pr.merge', async (client, payload, ctx) => {
      const { projectId, taskId, basisType, skipReason, authorizationId } = payload as {
        projectId: string; taskId: string; basisType: string; skipReason?: string; authorizationId?: string;
      };
      if (!MERGE_BASIS_TYPES.includes(basisType as (typeof MERGE_BASIS_TYPES)[number])) {
        throw new DomainError('VALIDATION_FAILED', '合并依据须为四类之一', 'basisType');
      }
      const t = await this.lockTask(client, projectId, taskId);
      if (t.col !== 'review') throw new DomainError('INVALID_STATE', '任务不在待评审', taskId);
      const pr = await this.lockCurrentPr(client, projectId, taskId);
      if (pr.status === 'stale') throw new DomainError('GATE_BLOCKED', '历史 PR 只读不可合并', pr.pr_ref, { issues: [{ code: 'PR_STALE', message: '历史 PR 只读' }] });
      // 自动门禁：单测+CI 对当前 codeRev 有效且达标
      const autoIssues = await this.autoGateIssues(client, projectId, t);
      if (autoIssues.length > 0) throw new DomainError('GATE_BLOCKED', '合并自动门禁未通过', taskId, { issues: autoIssues });
      // 依据校验
      const checklist = pr.checklist as Record<string, boolean>;
      const basis: Record<string, unknown> = { type: basisType, by: ctx.actorId, at: new Date().toISOString() };
      if (basisType === 'manual-checklist') {
        if (!checklist.acceptance || !checklist.standards || !checklist.design) {
          throw new DomainError('GATE_BLOCKED', '人工 checklist 未全勾', taskId, { issues: [{ code: 'QUALITY_INVALID', message: '人工 checklist 未全勾' }] });
        }
        basis.checklist = { ...checklist };
      } else if (basisType === 'manual-skip') {
        if (!skipReason?.trim() && !checklist.skipped) {
          throw new DomainError('VALIDATION_FAILED', '人工豁免须有理由（skipReason 或 pr.skip 登记）', 'skipReason');
        }
        basis.reason = skipReason ?? '经 dev.pr.skip 登记';
      } else if (basisType === 'autopilot-authorization') {
        if (!authorizationId) throw new DomainError('VALIDATION_FAILED', '缺授权 ID', 'authorizationId');
        const auth = await client.query<{ status: string; scope: Record<string, unknown>; task_ids: Array<{ code: string; rev: number }> }>(
          'SELECT * FROM dev_authorizations WHERE project_id=$1 AND authorization_id=$2', [projectId, authorizationId]);
        const a = auth.rows[0];
        if (!a || a.status !== 'active' || a.scope.merge !== true ||
            !a.task_ids.some((x) => x.code === t.code && x.rev === t.rev)) {
          throw new DomainError('GATE_BLOCKED', '授权不覆盖该任务当前修订或已失效', taskId, { issues: [{ code: 'TASK_NOT_APPROVED', message: '授权不覆盖/修订不一致' }] });
        }
        basis.authorizationId = authorizationId;
      }
      const commitId = sha256(`${taskId}:${t.code_rev}`);
      await client.query(
        "UPDATE dev_prs SET status='merged', merge_basis=$3, commit_id=$4, updated_at=now() WHERE id=$1 AND project_id=$2",
        [pr.id, projectId, JSON.stringify(basis), commitId]);
      await client.query(
        "UPDATE dev_tasks SET col='done', run_status='merged', updated_at=now() WHERE id=$1 AND project_id=$2",
        [taskId, projectId]);
      return { id: taskId, col: 'done', merged: true, basis };
    });

    // task.rework（评审驳回/人工返工/缺陷驱动返工重入；计划失效需重新批准，F02-5）
    registerCommand('dev.task.rework', async (client, payload, ctx) => {
      const { projectId, taskId, reason } = payload as { projectId: string; taskId: string; reason?: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '返工理由必填', 'reason');
      const t = await this.lockTask(client, projectId, taskId);
      // W2-017：done（含 merged）任务允许缺陷驱动返工——merged PR 保留为历史，任务 rev++ 重入 queue（REQ-507 链路）
      if (!['ing', 'review', 'done'].includes(t.col)) throw new DomainError('INVALID_STATE', '仅进行中/待评审/已完成任务可返工', taskId);
      await client.query("UPDATE dev_prs SET status='stale', updated_at=now() WHERE task_id=$1 AND status IN ('review','changes')", [taskId]);
      await client.query(
        `UPDATE dev_tasks SET rev=rev+1, code_rev=code_rev+1, col='queue', prog=0, run_status='rework',
           blocked=false, blocked_reason=NULL, updated_by=$3, updated_at=now() WHERE id=$1 AND project_id=$2`,
        [taskId, projectId, ctx.actorId]);
      // 计划失效（F04-4：返工→需重新核对覆盖并重新批准计划）
      await client.query(
        "UPDATE dev_plans SET state='invalidated', invalidated_reason=$2 WHERE project_id=$1 AND state='approved'",
        [projectId, `task.rework: ${reason}`]);
      return { id: taskId, col: 'queue', rework: true };
    });
  }

  // ---------- 命令入口 ----------

  async transition(projectId: string, taskId: string, to: string, note: string | undefined, ctx: CommandContext) {
    const map: Record<string, string> = {
      ing: 'dev.task.start', review: 'dev.pr.submit', pause: 'dev.task.pause',
      resume: 'dev.task.resume', stop: 'dev.task.stop', rework: 'dev.task.rework',
    };
    const cmd = map[to];
    if (!cmd) throw new DomainError('VALIDATION_FAILED', `不支持的目标动作 ${to}`, 'to');
    return executeCommand(cmd, { projectId, taskId, reason: note }, { ...ctx, projectId });
  }

  async run(projectId: string, taskId: string, ctx: CommandContext) {
    if (devMode() === 'real') {
      if (!this.codegen) throw new DomainError('SANDBOX_INFRA_FAILED', '真化模式缺写码执行器（DI 未装配）', taskId);
      return this.codegen.run(projectId, taskId, ctx);
    }
    return executeCommand('dev.task.run', { projectId, taskId }, { ...ctx, projectId });
  }

  async progress(projectId: string, taskId: string, prog: number, ctx: CommandContext) {
    return executeCommand('dev.task.progress', { projectId, taskId, prog }, { ...ctx, projectId });
  }

  async toggleCheck(projectId: string, taskId: string, key: string, checked: boolean, ctx: CommandContext) {
    return executeCommand('dev.pr.toggle-check', { projectId, taskId, key, checked }, { ...ctx, projectId });
  }

  async skip(projectId: string, taskId: string, reason: string, ctx: CommandContext) {
    return executeCommand('dev.pr.skip', { projectId, taskId, reason }, { ...ctx, projectId });
  }

  async quality(projectId: string, taskId: string, ctx: CommandContext) {
    if (devMode() === 'real') {
      if (!this.sandbox || !this.ws) throw new DomainError('SANDBOX_INFRA_FAILED', '真化模式缺沙箱/工作区服务（DI 未装配）', taskId);
      // 事务外真跑：宿主持依赖安装 + 沙箱 npm test；结果随命令 payload 登记（不静默降级）
      await this.ws.ensure(projectId, ctx);
      await this.ws.npmInstall(projectId);
      const r = await this.ws.runInWorkspace(this.sandbox, projectId, ['npm', 'test'], { timeoutMs: 300_000 });
      return executeCommand('dev.quality.complete', {
        projectId, taskId,
        real: { exitCode: r.exitCode, logsTail: r.logs.slice(-3000), envFingerprint: r.envFingerprint, durationMs: r.durationMs, gitSha: r.gitSha },
      }, { ...ctx, projectId });
    }
    return executeCommand('dev.quality.complete', { projectId, taskId }, { ...ctx, projectId });
  }

  async aiReview(projectId: string, taskId: string, ctx: CommandContext) {
    if (devMode() === 'real' && this.ai?.kind === 'pi') {
      // real 模式真评审（事务外 LLM）：结论随命令 payload 登记，不静默降级——
      // AI 评审执行失败=结论 fail 如实落证据（评审门红，人工可改走 checklist 合并兜底）
      const real = await this.runRealReview(projectId, taskId).catch((e) => ({
        conclusion: 'fail' as const,
        note: `AI 评审执行失败：${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`,
        diffStat: null,
      }));
      return executeCommand('dev.ai-review.complete', { projectId, taskId, real }, { ...ctx, projectId });
    }
    return executeCommand('dev.ai-review.complete', { projectId, taskId }, { ...ctx, projectId });
  }

  /** real 模式 AI 真评审：任务规格 + 最近 codegen 提交 diff → 严格 JSON 结论（10min 看门狗防静默挂起） */
  private async runRealReview(projectId: string, taskId: string): Promise<{ conclusion: 'pass' | 'fail'; note: string; diffStat: string | null }> {
    const tr = await query<{ code: string; title: string; goal: string | null; acceptance: unknown[] }>(
      'SELECT code, title, goal, acceptance FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
    const t = tr.rows[0];
    const ev = await query<{ payload: { commit?: string | null } }>(
      `SELECT payload FROM evd_records WHERE project_id=$1 AND kind='codegen' AND payload->>'taskId'=$2
       AND payload->>'commit' IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [projectId, taskId]);
    const commit = ev.rows[0]?.payload?.commit ?? null;
    let diffStat: string | null = null;
    let patch = '';
    if (commit && this.ws) {
      const dir = this.ws.dir(projectId);
      diffStat = (await execFileP('git', ['-C', dir, 'show', '--stat', '--format=', commit]).catch(() => null))?.stdout?.trim() ?? null;
      patch = (await execFileP('git', ['-C', dir, 'show', '--format=', commit]).catch(() => null))?.stdout ?? '';
    }
    const session = await this.ai!.createSession({ projectId, purpose: 'review' });
    const prompt = `${AI_REVIEW_SYSTEM}\n\n【任务】${t?.code} ${t?.title}\n目标：${t?.goal ?? '—'}\n验收条件：${(t?.acceptance ?? []).map((a) => String(typeof a === 'object' && a !== null ? (a as Record<string, unknown>).item ?? JSON.stringify(a) : a)).join('；') || '—'}\n【提交 diff 统计】\n${diffStat ?? '（无提交记录）'}\n【补丁（截断 12KB）】\n${patch.slice(0, 12_000)}`;
    const { deltas, result } = session.stream(prompt);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { session.stop(); } catch { /* 不遮蔽主错 */ }
        reject(new Error('AI 评审超时（10 分钟无终态）'));
      }, AI_REVIEW_WATCHDOG_MS);
      timer.unref?.();
    });
    const text = await Promise.race([
      (async () => { let s = ''; for await (const d of deltas) s += d; await result.catch(() => null); return s; })(),
      timeout,
    ]).finally(() => { if (timer) clearTimeout(timer); });
    return { ...parseAiReview(text), diffStat };
  }

  async merge(projectId: string, taskId: string, basisType: string, skipReason: string | undefined, authorizationId: string | undefined, ctx: CommandContext) {
    return executeCommand('dev.pr.merge', { projectId, taskId, basisType, skipReason, authorizationId }, { ...ctx, projectId });
  }

  /** A06-8 门禁预览（开始按钮 disabled+title 原因） */
  async startGate(projectId: string, taskId: string): Promise<{ ok: boolean; issues: GateIssue[] }> {
    const t = await query(
      'SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
    if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
    const issues = await this.startGateIssues(null, projectId, t.rows[0] as unknown as TaskRow, false);
    return { ok: issues.length === 0, issues };
  }

  // ---------- 内部 ----------

  private async lockTask(client: PoolClient, projectId: string, taskId: string): Promise<TaskRow> {
    const r = await client.query('SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE', [taskId, projectId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
    return r.rows[0] as TaskRow;
  }

  private async lockCurrentPr(client: PoolClient, projectId: string, taskId: string) {
    const r = await client.query<{ id: string; pr_ref: string; status: string; checklist: unknown }>(
      "SELECT * FROM dev_prs WHERE project_id=$1 AND task_id=$2 AND status IN ('review','changes') ORDER BY code_rev DESC LIMIT 1 FOR UPDATE",
      [projectId, taskId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '无进行中 PR（先提交评审）', taskId);
    return r.rows[0];
  }

  /** devStartGate 摘要（F02-5 task.start/resume 前置；§15(d) 子码闭集） */
  private async startGateIssues(client: PoolClient | null, projectId: string, t: TaskRow, resume: boolean): Promise<GateIssue[]> {
    const q = client ? client.query.bind(client) : query;
    const issues: GateIssue[] = [];
    if (!resume && t.col !== 'queue') return [{ code: 'INVALID_STATE', message: '仅排队任务可开始', target: t.code }];
    // 计划门禁：存在 approved 计划且任务在批准快照内、基线实时一致
    const plan = await q<{ id: string; snapshot: { taskIds?: string[] }; baseline_fingerprint: string }>(
      "SELECT * FROM dev_plans WHERE project_id=$1 AND state='approved' ORDER BY revision DESC LIMIT 1", [projectId]);
    const p = plan.rows[0];
    if (!p) {
      issues.push({ code: 'PLAN_REQUIRED', message: '无已批准计划' });
    } else {
      if (!(p.snapshot.taskIds ?? []).includes(t.code)) {
        issues.push({ code: 'TASK_NOT_APPROVED', message: `任务 ${t.code} 不在批准计划快照内`, target: t.code });
      }
      const live = await liveBaselineFingerprint(client, projectId);
      if (live !== p.baseline_fingerprint) issues.push({ code: 'BASELINE_STALE', message: '计划依据基线已失效' });
    }
    // 依赖与更早批次全部 done
    if (t.deps.length > 0) {
      const dep = await q<{ code: string; col: string }>(
        "SELECT code, col FROM dev_tasks WHERE project_id=$1 AND code = ANY($2)", [projectId, t.deps]);
      for (const d of dep.rows) {
        if (d.col !== 'done') issues.push({ code: 'DEPENDENCY_NOT_DONE', message: `依赖任务 ${d.code} 未完成`, target: d.code });
      }
    }
    if (t.batch_no !== null) {
      const earlier = await q<{ code: string }>(
        `SELECT code FROM dev_tasks WHERE project_id=$1 AND batch_no IS NOT NULL AND batch_no < $2 AND col <> 'done'
         AND archived=false AND excluded=false`, [projectId, t.batch_no]);
      for (const e of earlier.rows) {
        issues.push({ code: 'BATCH_NOT_DONE', message: `更早批次任务 ${e.code} 未完成`, target: e.code });
      }
    }
    // 写入范围冲突（与进行中任务）
    if (t.write_scopes.length > 0) {
      const ing = await q<{ code: string; write_scopes: string[] }>(
        "SELECT code, write_scopes FROM dev_tasks WHERE project_id=$1 AND col='ing' AND id <> $2", [projectId, t.id]);
      for (const o of ing.rows) {
        const overlap = t.write_scopes.filter((s) => o.write_scopes.includes(s));
        if (overlap.length > 0) {
          issues.push({ code: 'WRITE_SCOPE_CONFLICT', message: `与进行中任务 ${o.code} 写入范围冲突：${overlap.join(',')}`, target: o.code });
        }
      }
    }
    // 开放影响单
    const impacts = await q<{ code: string }>(
      "SELECT code FROM dev_impacts WHERE project_id=$1 AND status='pending-assessment'", [projectId]);
    for (const im of impacts.rows) {
      issues.push({ code: 'IMPACT_OPEN', message: `存在未处置影响单 ${im.code}`, target: im.code });
    }
    return issues;
  }

  /** 合并自动门禁：单测证据 + CI 最新结论（对当前 codeRev/commit） */
  private async autoGateIssues(client: PoolClient, projectId: string, t: TaskRow): Promise<GateIssue[]> {
    const issues: GateIssue[] = [];
    const unit = await client.query<{ id: string }>(
      `SELECT seq FROM evd_records WHERE project_id=$1 AND kind='unit'
       AND payload->>'taskId'=$2 AND payload->>'codeRev'=$3 AND (payload->>'pass')::boolean=true
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, t.id, String(t.code_rev)]);
    if (!unit.rows[0]) issues.push({ code: 'QUALITY_INVALID', message: '当前代码修订无达标单测证据', target: t.code });
    const commit = sha256(`${t.id}:${t.code_rev}`);
    const ci = await client.query<{ conclusion: string }>(
      `SELECT conclusion FROM dev_ci_reports WHERE project_id=$1 AND commit_sha=$2 ORDER BY received_at DESC LIMIT 1`,
      [projectId, commit]);
    if (!ci.rows[0] || ci.rows[0].conclusion !== 'pass') {
      issues.push({ code: 'CI_INVALID', message: 'CI 证据无效/未通过', target: t.code });
    }
    return issues;
  }
}

/** AI 评审输出容错抽取（围栏优先 → 大括号兜底 → 原文截断；垃圾 verdict 落 fail 宁严不宽）。导出供单测钉口径 */
export function parseAiReview(text: string): { conclusion: 'pass' | 'fail'; note: string } {
  let raw = /```json\s*\n([\s\S]*?)```/.exec(text)?.[1]?.trim() ?? '';
  if (!raw) raw = /```json\s*\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? '';
  if (!raw) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) raw = text.slice(i, j + 1);
  }
  if (raw) {
    try {
      const j = JSON.parse(raw) as { verdict?: unknown; comment?: unknown };
      if (typeof j.comment === 'string' && j.comment.trim()) {
        return { conclusion: j.verdict === 'pass' ? 'pass' : 'fail', note: j.comment.trim().slice(0, 500) };
      }
    } catch { /* 落原文兜底 */ }
  }
  return { conclusion: 'fail', note: `评审输出无法解析（宁严不宽）：${text.trim().slice(0, 200) || '空输出'}` };
}
