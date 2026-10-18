/** 开发域真化一期集成测试（2026-10-18；需 DB；沙箱=假注入，AI=mock provider 走确定性脚手架）：
 *  ① AI 写码全链：task.run(real) → 异步脚手架落盘+git 提交 → complete 收尾 prog=100 + codegen 证据
 *  ② quality real：沙箱退出码即 unit 证据/CI 结论（pass 与 fail 两径）
 *  ③ 构建 real：exec 随命令登记（gitSha 入指纹，失败落 fail 行+build 证据）
 *  ④ 预览全链：start（健康等待命中本地桩服务）→ status running → proxy 透传 → stop；
 *     死容器对账自愈（inspect 不在运行 → status 自动落 stopped） */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import { MockAiProvider } from '../ai/mock-ai.provider.js';
import { StorageService } from '../platform/storage.service.js';
import type { SandboxService } from '../executor/sandbox.service.js';
import { DevWorkspaceService } from './workspace.service.js';
import { DevCodegenService } from './codegen.service.js';
import { DevBoardService } from './board.service.js';
import { DevBuildService } from './build.service.js';
import { DevPreviewService } from './preview.service.js';

const PID = '00000000-0000-0000-0000-0000000000f4';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };
const BL_ID = '00000000-0000-0000-0000-00000000b1f4';

async function infraUp(): Promise<boolean> {
  try {
    await query('SELECT 1 FROM dev_tasks LIMIT 1');
    await new StorageService().ensureBucket();
    return true;
  } catch {
    return false;
  }
}

const waitFor = async (fn: () => Promise<boolean>, ms = 30000): Promise<void> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('waitFor 超时');
};

describe('开发域真化（集成，需 DB+MinIO）', async () => {
  const up = await infraUp();
  if (!up) {
    it.skip('postgres/minio 未就绪', () => {});
    return;
  }

  // ---- 环境：real 模式 + 临时工作区根 ----
  const wsRoot = mkdtempSync(join(tmpdir(), 'msf-ws-it-'));
  const OLD_ENV = { ...process.env };
  process.env.MSF_DEV_MODE = 'real';
  process.env.MSF_WORKSPACES_ROOT = wsRoot;

  // ---- 假沙箱（runOnce 退出码可控；runService 指向本地桩 HTTP 服务） ----
  let nextExit = 0;
  let stubUp = false;
  let stub: Server | null = null;
  const fakeSandbox = {
    available: async () => true,
    runOnce: async () => ({
      exitCode: nextExit, logs: 'fake sandbox logs tail', durationMs: 3,
      imageDigest: 'sha256:fake', envFingerprint: 'fake-env-fp',
    }),
    runService: async (spec: { name: string }) => ({ containerId: 'fake-cid', name: spec.name, ip: '127.0.0.1' }),
    inspectService: async () => ({ running: stubUp, exitCode: stubUp ? null : 1, ip: '127.0.0.1' }),
    stopService: async () => { stubUp = false; },
  } as unknown as SandboxService;

  const ws = new DevWorkspaceService();
  const codegen = new DevCodegenService(ws, new MockAiProvider());
  const board = new DevBoardService(codegen, fakeSandbox, ws);
  const build = new DevBuildService(new StorageService(), fakeSandbox, ws);
  const preview = new DevPreviewService(ws, fakeSandbox);

  resetCommands();
  ws.onModuleInit();
  codegen.onModuleInit();
  board.onModuleInit();
  build.onModuleInit();
  preview.onModuleInit();

  let taskId = '';

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'dev-real-it') ON CONFLICT (id) DO NOTHING", [PID]);
    // 任务（进行中+运行态，直接进 run 入口）
    const t = await query<{ id: string }>(
      `INSERT INTO dev_tasks (project_id, code, title, kind, owner, asg_type, goal, deliverables, write_scopes, quality, col, run_status, created_by)
       VALUES ($1,'T-901','页面实现：首页','frontend','ai','agent','实现首页','["src/pages/P-001/index.ts"]','["src/pages/P-001"]','{}','ing','running','it') RETURNING id`,
      [PID]);
    taskId = t.rows[0]!.id;
    // 构建门禁所需：基线 + 批准计划（快照含 T-901）+ 任务 done 化在 build 用例前做
    await query(
      `INSERT INTO dsg_baselines (id, project_id, code, finalization_id, items, baseline_fingerprint, confirmed_by)
       VALUES ($1,$2,'BL-IT-1','fin-it','[]',$3,'it') ON CONFLICT DO NOTHING`,
      [BL_ID, PID, 'a'.repeat(64)]);
    await query(
      `INSERT INTO dev_plans (project_id, revision, state, snapshot, coverage_report, baseline_id, baseline_fingerprint, plan_fingerprint, approved_by, approved_at)
       VALUES ($1,1,'approved','{"taskIds":["T-901"]}','{}',$2,$3,$4,'it',now())`,
      [PID, BL_ID, 'a'.repeat(64), 'b'.repeat(64)]);
    // 本地桩 HTTP 服务（预览健康等待/反代目标；3000 与 PREVIEW_PORT 约定一致）
    stub = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`stub:${req.url}`);
    });
    await new Promise<void>((res, rej) => {
      stub!.once('error', rej);
      stub!.listen(3000, '127.0.0.1', () => res());
    });
    stubUp = true;
  });

  afterAll(async () => {
    stub?.close();
    await query('DELETE FROM dev_previews WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_ci_reports WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_builds WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_plans WHERE project_id=$1', [PID]);
    await query('DELETE FROM dev_tasks WHERE project_id=$1', [PID]);
    await query('DELETE FROM dsg_baselines WHERE project_id=$1', [PID]);
    await query('DELETE FROM evd_records WHERE project_id=$1', [PID]);
    await query('DELETE FROM audit_log WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    rmSync(wsRoot, { recursive: true, force: true });
    process.env = { ...OLD_ENV };
    await pool.end();
  });

  it('① AI 写码全链：run(real) 起步 prog=10 → 异步落盘+git 提交 → 收尾 prog=100 + codegen 证据', async () => {
    const r = await board.run(PID, taskId, CTX) as { prog: number; codegen?: string };
    expect(r.prog).toBe(10);
    expect(r.codegen).toBe('started');
    await waitFor(async () => {
      const t = await query<{ prog: number }>('SELECT prog FROM dev_tasks WHERE id=$1', [taskId]);
      return t.rows[0]?.prog === 100;
    });
    // 工作区实物：脚手架文件落盘 + git 提交
    const files = await ws.listFiles(PID);
    expect(files).toContain('package.json');
    expect(files).toContain('server/index.js');
    expect(files).toContain('src/pages/P-001/index.ts');
    const log = await ws.gitLog(PID);
    expect(log.some((c) => c.message.includes('feat(T-901)'))).toBe(true);
    // codegen 证据（mode=deterministic：mock provider 如实标注，不冒充 AI）
    const ev = await query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM evd_records WHERE project_id=$1 AND kind='codegen' ORDER BY created_at DESC LIMIT 1", [PID]);
    expect(ev.rows[0]?.payload.ok).toBe(true);
    expect(ev.rows[0]?.payload.mode).toBe('deterministic');
    expect((ev.rows[0]?.payload.files as string[]).length).toBeGreaterThan(0);
  });

  it('② quality real：沙箱退出码即 unit 证据与 CI 结论（pass/fail 两径）', async () => {
    await query("UPDATE dev_tasks SET col='review', code_rev=1 WHERE id=$1", [taskId]);
    nextExit = 0;
    const ok = await board.quality(PID, taskId, CTX) as { unit: string; mode?: string };
    expect(ok.unit).toBe('pass');
    expect(ok.mode).toBe('sandbox');
    const ev = await query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM evd_records WHERE project_id=$1 AND kind='unit' ORDER BY created_at DESC LIMIT 1", [PID]);
    expect(ev.rows[0]?.payload.mode).toBe('sandbox');
    expect(ev.rows[0]?.payload.exitCode).toBe(0);
    const ci = await query<{ provider: string; conclusion: string }>(
      'SELECT provider, conclusion FROM dev_ci_reports WHERE project_id=$1 ORDER BY received_at DESC LIMIT 1', [PID]);
    expect(ci.rows[0]?.provider).toBe('sandbox-local');
    expect(ci.rows[0]?.conclusion).toBe('pass');
    // fail 径：退出码非零照实落
    nextExit = 2;
    const bad = await board.quality(PID, taskId, CTX) as { unit: string };
    expect(bad.unit).toBe('fail');
    const ev2 = await query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM evd_records WHERE project_id=$1 AND kind='unit' ORDER BY created_at DESC LIMIT 1", [PID]);
    expect(ev2.rows[0]?.payload.pass).toBe(false);
  });

  it('③ 构建 real：exec 随命令登记（status 照实 + gitSha 入指纹 + build 证据行）', async () => {
    await query("UPDATE dev_tasks SET col='done', run_status='merged' WHERE id=$1", [taskId]);
    nextExit = 0;
    const r = await build.run(PID, CTX) as { buildId: string };
    expect(r.buildId).toMatch(/^B-/);
    const b = await query<{ status: string; source_manifest: Record<string, unknown> }>(
      'SELECT status, source_manifest FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [PID]);
    expect(b.rows[0]?.status).toBe('pass');
    const exec = (b.rows[0]?.source_manifest as { exec?: { runner?: string; gitSha?: string } }).exec;
    expect(exec?.runner).toBe('sandbox');
    expect(typeof exec?.gitSha).toBe('string'); // 真 git HEAD
    const ev = await query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM evd_records WHERE project_id=$1 AND kind='build' ORDER BY created_at DESC LIMIT 1", [PID]);
    expect(ev.rows[0]?.payload.status).toBe('pass');
    // fail 径：新提交（写个文件）后构建失败落 fail 行
    await ws.writeFile(PID, 'break.txt', 'x');
    await ws.commitAll(ws.dir(PID), 'chore: break marker');
    nextExit = 1;
    await build.run(PID, CTX);
    const b2 = await query<{ status: string }>(
      'SELECT status FROM dev_builds WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [PID]);
    expect(b2.rows[0]?.status).toBe('fail');
  });

  it('④ 预览全链：start→status running→proxy 透传→stop；死容器对账自愈', async () => {
    const s = await preview.start(PID, CTX) as { url: string };
    expect(s.url).toBe(`/dev-preview/${PID}/`);
    const st = await preview.status(PID) as { status: string; url?: string };
    expect(st.status).toBe('running');
    expect(st.url).toBe(`/dev-preview/${PID}/`);
    // 反代透传（假 req：GET 无 body）
    const fakeReq = { method: 'GET', headers: { 'x-custom': 'v' } } as never;
    const resp = await preview.proxy(PID, '/hello?q=1', fakeReq as never);
    expect(resp.status).toBe(200);
    expect(resp.body.toString('utf8')).toBe('stub:/hello?q=1');
    // 停止
    await preview.stop(PID, CTX);
    const st2 = await preview.status(PID) as { status: string };
    expect(st2.status).toBe('stopped');
    // 对账自愈：手工把行拨回 running 但容器（桩）已死 → status 自动落 stopped
    await query("UPDATE dev_previews SET status='running', stopped_at=NULL WHERE project_id=$1", [PID]);
    const st3 = await preview.status(PID) as { status: string };
    expect(st3.status).toBe('stopped');
  });
});
