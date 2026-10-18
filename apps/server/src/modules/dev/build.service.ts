import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError, fingerprint } from '@msf/shared';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query } from '../../db/pool.js';
import { lockCodeGen } from '../../db/seq.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { StorageService } from '../platform/storage.service.js';
import { SandboxService } from '../executor/sandbox.service.js';
import { sha256 } from './gate-common.js';
import { devMode, DevWorkspaceService } from './workspace.service.js';

/**
 * 集成构建（A06-13；REQ-412）：全任务合并后候选构建 + 独立 UI 工件。
 * 两态（2026-10-18 开发域真化，MSF_DEV_MODE=real 开真）：
 * - mock：UI 工件由任务交付物清单确定性生成（禁止复制原型 HTML——source_manifest 记源哈希集合，
 *   指纹与原型工件必然不同源，A06-17 sameObjectGuard 消费）
 * - real：工作区真实构建——宿主持依赖安装（--ignore-scripts）+ 沙箱 npm run build，
 *   退出码即 status（pass/fail 照实落 dev_builds），日志/环境指纹/gitSha 入 evidence 与 source_manifest；
 *   构建指纹并入 gitSha（新提交必产新构建行，不被幂等命中吞掉）
 */
@Injectable()
export class DevBuildService {
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() @Inject(SandboxService) private readonly sandbox?: SandboxService,
    @Optional() @Inject(DevWorkspaceService) private readonly ws?: DevWorkspaceService,
  ) {}

  onModuleInit(): void {
    registerCommand('dev.build.complete', async (client, payload, ctx) => {
      const { projectId, exec } = payload as {
        projectId: string;
        /** real 模式：事务外沙箱构建结果（退出码/日志尾/环境指纹/gitSha） */
        exec?: { exitCode: number; logsTail: string; envFingerprint: string; durationMs: number; gitSha: string | null; cmd: string; skipped?: boolean };
      };
      const plan = await client.query<{ id: string; revision: number; snapshot: { taskIds?: string[] }; baseline_fingerprint: string }>(
        "SELECT * FROM dev_plans WHERE project_id=$1 AND state='approved' ORDER BY revision DESC LIMIT 1", [projectId]);
      const p = plan.rows[0];
      if (!p) throw new DomainError('GATE_BLOCKED', '无已批准计划', 'dev.build', { issues: [{ code: 'PLAN_REQUIRED', message: '无已批准计划' }] });
      const notDone = await client.query<{ code: string }>(
        `SELECT code FROM dev_tasks WHERE project_id=$1 AND code = ANY($2) AND col <> 'done'`,
        [projectId, p.snapshot.taskIds ?? []]);
      if (notDone.rows.length > 0) {
        throw new DomainError('GATE_BLOCKED', '存在未合并完成任务', 'dev.build', {
          issues: notDone.rows.map((t) => ({ code: 'TASK_NOT_DONE', message: `${t.code} 尚未合并完成`, target: t.code })),
        });
      }
      const merged = await client.query<{ task_id: string; pr_ref: string; commit_id: string }>(
        "SELECT task_id, pr_ref, commit_id FROM dev_prs WHERE project_id=$1 AND status='merged' ORDER BY pr_ref", [projectId]);
      // W2-052：B- 发号 count+1 属 check-then-act——咨询锁串行化「计数→插入」临界区
      await lockCodeGen(client, `msf:code:build:${projectId}`);
      const seq = await client.query<{ n: string }>('SELECT count(*) AS n FROM dev_builds WHERE project_id=$1', [projectId]);
      const code = `B-${String(Number(seq.rows[0]?.n ?? 0) + 1).padStart(4, '0')}`;
      const commitRefs = merged.rows.map((m) => ({ prRef: m.pr_ref, commitId: m.commit_id }));
      const tasks = await client.query<{ code: string; title: string; deliverables: string[] }>(
        'SELECT code, title, deliverables FROM dev_tasks WHERE project_id=$1 ORDER BY code', [projectId]);
      // 独立 UI 工件：由任务交付物派生（与原型 HTML 不同源）
      const uiHtml = buildUiArtifact(tasks.rows);
      const sourceManifest: Record<string, unknown> = {
        statement: 'build-from-task-deliverables (not prototype copy)',
        sources: tasks.rows.map((t) => ({ task: t.code, hash: sha256(JSON.stringify(t.deliverables)) })),
      };
      const buildStatus = exec ? (exec.exitCode === 0 ? 'pass' : 'fail') : 'pass';
      if (exec) {
        sourceManifest.exec = {
          runner: 'sandbox', cmd: exec.cmd, exitCode: exec.exitCode, skipped: exec.skipped ?? false,
          gitSha: exec.gitSha, envFingerprint: exec.envFingerprint, durationMs: exec.durationMs,
        };
      }
      const buildFp = sha256(fingerprint({ projectId, planRevision: p.revision, commitRefs, uiHtml, gitSha: exec?.gitSha ?? null, buildStatus }));
      const uiFp = sha256(uiHtml);
      // 幂等命中：输入（计划修订+合并提交集+UI 工件）未变时返回既有构建，
      // 不得撞 build_fingerprint 唯一约束裸 500（实机走查修复 #19；与存储层内容寻址幂等同口径）
      const dup = await client.query<{ id: string; code: string }>(
        'SELECT id, code FROM dev_builds WHERE project_id=$1 AND build_fingerprint=$2', [projectId, buildFp]);
      if (dup.rows[0]) {
        return { buildId: dup.rows[0].code, id: dup.rows[0].id, buildFingerprint: `sha256:${buildFp}`, uiHtml, idempotent: true };
      }
      const prev = await client.query<{ id: string }>(
        'SELECT id FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_builds (project_id, code, plan_revision, commit_refs, artifact_object_key, ui_artifact_object_key,
           build_fingerprint, ui_artifact_fingerprint, source_manifest, status, supersedes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [projectId, code, p.revision, JSON.stringify(commitRefs),
          `build/${projectId}/${code}.json`, `build/${projectId}/${code}-ui.html`,
          buildFp, uiFp, JSON.stringify(sourceManifest), buildStatus, prev.rows[0]?.id ?? null, ctx.actorId],
      );
      // real 构建证据行（退出码/日志尾/环境指纹/gitSha——append-only）
      if (exec) {
        await appendEvidence(client, {
          projectId, kind: 'build',
          payload: {
            buildCode: code, status: buildStatus, cmd: exec.cmd, exitCode: exec.exitCode,
            skipped: exec.skipped ?? false, gitSha: exec.gitSha, envFingerprint: exec.envFingerprint,
            durationMs: exec.durationMs, logsTail: exec.logsTail.slice(-3000),
          },
        });
      }
      return { buildId: code, id: r.rows[0]!.id, buildFingerprint: `sha256:${buildFp}`, uiHtml, buildStatus };
    });
  }

  /** A06-13 build:run（mock 同步完成；real=事务外沙箱真构建 → 登记） */
  async run(projectId: string, ctx: CommandContext) {
    let exec: { exitCode: number; logsTail: string; envFingerprint: string; durationMs: number; gitSha: string | null; cmd: string; skipped?: boolean } | undefined;
    if (devMode() === 'real') {
      if (!this.sandbox || !this.ws) throw new DomainError('SANDBOX_INFRA_FAILED', '真化模式缺沙箱/工作区服务（DI 未装配）', projectId);
      await this.ws.ensure(projectId, ctx);
      const dir = this.ws.dir(projectId);
      // 无 build 脚本=纯静态/免构建应用，记 skipped 直过（约定允许 scripts.build 省略）
      let hasBuild = false;
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        hasBuild = typeof pkg.scripts?.build === 'string';
      } catch { hasBuild = false; }
      if (hasBuild) {
        await this.ws.npmInstall(projectId);
        const r = await this.ws.runInWorkspace(this.sandbox, projectId, ['npm', 'run', 'build'], { timeoutMs: 600_000, memoryMb: 2048 });
        exec = { exitCode: r.exitCode, logsTail: r.logs.slice(-4000), envFingerprint: r.envFingerprint, durationMs: r.durationMs, gitSha: r.gitSha, cmd: 'npm run build' };
      } else {
        const gitSha = await this.ws.commitAll(dir, 'chore: pre-build checkpoint').catch(() => null);
        exec = { exitCode: 0, logsTail: 'no build script — skipped', envFingerprint: 'host-skip', durationMs: 0, gitSha, cmd: '(none)', skipped: true };
      }
    }
    const r = (await executeCommand('dev.build.complete', { projectId, ...(exec ? { exec } : {}) }, { ...ctx, projectId })) as {
      buildId: string; id: string; buildFingerprint: string; uiHtml: string; buildStatus?: string;
    };
    // 对象写在命令后（版本行已登记；内容寻址幂等）
    await this.storage.putObject(`build/${projectId}/${r.buildId}-ui.html`, Buffer.from(r.uiHtml, 'utf8'));
    await this.storage.putObject(`build/${projectId}/${r.buildId}.json`,
      Buffer.from(JSON.stringify({ buildId: r.buildId, fingerprint: r.buildFingerprint }), 'utf8'));
    return { operationId: `op_bd_${r.id.slice(0, 8)}`, buildId: r.buildId, buildFingerprint: r.buildFingerprint };
  }

  /** A06-13 查询当前构建 */
  async current(projectId: string) {
    const r = await query(
      'SELECT * FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
    const b = r.rows[0] as Record<string, unknown> | undefined;
    if (!b) return { build: null };
    return {
      build: {
        buildId: b.code, status: b.status, buildFingerprint: `sha256:${String(b.build_fingerprint)}`,
        commits: b.commit_refs, planRevision: b.plan_revision,
        uiArtifact: { htmlFingerprint: `sha256:${String(b.ui_artifact_fingerprint)}`, independent: true },
        sourceManifest: b.source_manifest, createdAt: b.created_at,
      },
    };
  }
}

/** mock 独立 UI 工件：任务交付物驱动的实现页（与原型 HTML 结构性不同源，REQ-412） */
function buildUiArtifact(tasks: Array<{ code: string; title: string; deliverables: string[] }>): string {
  const rows = tasks
    .map((t) => `<li data-task="${t.code}"><strong>${t.title}</strong> — ${(t.deliverables ?? []).join(', ')}</li>`)
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>候选构建 UI 工件</title></head>
<body data-build-artifact="msf">
<h1>实现预览（构建产物，非原型复制）</h1>
<ul>
${rows}
</ul>
</body></html>`;
}
