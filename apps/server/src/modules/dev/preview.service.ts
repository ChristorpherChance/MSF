import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import type { Request } from 'express';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { SandboxService } from '../executor/sandbox.service.js';
import { devRuntimeImage, DevWorkspaceService } from './workspace.service.js';

/**
 * 长驻运行预览（2026-10-18 二期，用户拍板「完整应用形态，前后端整体起，人工可点开玩」）：
 * - 沙箱 runService 长驻容器跑工作区 npm start（同一安全基线：internal 网零出向/只读根/
 *   CapDrop ALL/限额；端口不映射宿主——经本平台鉴权反代 /dev-preview/:pid/* 访问容器 IP）
 * - dev_previews 登记表：每项目至多一个 running（部分唯一索引）；启动=先停旧再起新；
 *   死容器自愈=status 读取时 inspect 对账（不在运行即经命令落 stopped，不留假活）
 * - 反代不转发 Cookie/Authorization（容器内应用永远看不到平台会话）；
 *   平台 API 侧另有 Referer 隔离带（main.ts）挡预览页内脚本直调
 */

const PREVIEW_PORT = 3000;

/** 预览 HTML 根相对引用重写（纯函数可单测）：src/href/action="/x" → "/dev-preview/:pid/x"。
 *  生成应用常写 href="/style.css" 根相对路径——不重写则浏览器解析到平台根 404
 *  （2026-10-19 实机「预览看不了运行结果」根修；Location 头重写在本类 proxy() 内同口径）。
 *  协议相对 //、完整外链、已带 /dev-preview/ 前缀、相对引用一律不动（幂等）。 */
export function rewritePreviewHtml(html: string, projectId: string): string {
  const prefix = `/dev-preview/${projectId}`;
  return html.replace(/\b(src|href|action)="\/(?!\/|dev-preview\/)/g, `$1="${prefix}/`);
}

interface PreviewRow {
  id: string; project_id: string; container_id: string; container_name: string;
  image: string; port: number; ip: string | null; status: string;
  last_error: string | null; started_by: string; started_at: string; stopped_at: string | null;
}

@Injectable()
export class DevPreviewService {
  constructor(
    @Inject(DevWorkspaceService) private readonly ws: DevWorkspaceService,
    @Optional() @Inject(SandboxService) private readonly sandbox?: SandboxService,
  ) {}

  onModuleInit(): void {
    registerCommand('dev.preview.start', async (client, payload, ctx) => {
      const p = payload as { projectId: string; containerId: string; name: string; image: string; ip: string; port: number };
      // 并发双启兜底：唯一索引之外的行内清场（旧 running 一律落 stopped）
      await client.query(
        "UPDATE dev_previews SET status='stopped', stopped_at=now(), last_error='被新预览替换' WHERE project_id=$1 AND status='running'",
        [p.projectId]);
      const r = await client.query<{ id: string }>(
        `INSERT INTO dev_previews (project_id, container_id, container_name, image, port, ip, status, started_by)
         VALUES ($1,$2,$3,$4,$5,$6,'running',$7) RETURNING id`,
        [p.projectId, p.containerId, p.name, p.image, p.port, p.ip, ctx.actorId]);
      return { previewId: r.rows[0]!.id };
    });
    registerCommand('dev.preview.stop', async (client, payload) => {
      const p = payload as { projectId: string; reason?: string };
      const r = await client.query(
        "UPDATE dev_previews SET status='stopped', stopped_at=now(), last_error=$2 WHERE project_id=$1 AND status='running'",
        [p.projectId, p.reason ?? null]);
      return { stopped: r.rowCount ?? 0 };
    });
    registerCommand('dev.preview.fail', async (client, payload, ctx) => {
      const p = payload as { projectId: string; containerId: string; name: string; image: string; error: string };
      await client.query(
        `INSERT INTO dev_previews (project_id, container_id, container_name, image, status, last_error, started_by, stopped_at)
         VALUES ($1,$2,$3,$4,'failed',$5,$6,now())`,
        [p.projectId, p.containerId, p.name, p.image, p.error.slice(0, 500), ctx.actorId]);
      return { recorded: true };
    });
  }

  /** ▶ 启动预览：宿主持依赖安装 → 沙箱起长驻容器 → 健康等待 → 登记。任何一步失败=明确报错+回收 */
  async start(projectId: string, ctx: CommandContext) {
    if (!this.sandbox) throw new DomainError('SANDBOX_INFRA_FAILED', '预览需要沙箱服务（Docker）', projectId);
    if (!(await this.sandbox.available())) {
      throw new DomainError('SANDBOX_INFRA_FAILED', 'Docker 不可用（预览需要沙箱运行环境）', projectId);
    }
    const { dir } = await this.ws.ensure(projectId, ctx);
    if (!this.ws.exists(projectId)) {
      throw new DomainError('VALIDATION_FAILED', '工作区还没有应用代码——先在开发页跑任务让 AI 写码', projectId);
    }
    await this.ws.npmInstall(projectId);
    await this.stop(projectId, ctx, '重起替换').catch(() => undefined);
    const name = `msf-preview-${projectId.slice(0, 8)}`;
    const image = devRuntimeImage();
    const handle = await this.sandbox.runService({
      image, name,
      cmd: ['npm', 'start'],
      env: { PORT: String(PREVIEW_PORT), HOST: '0.0.0.0', HOME: '/tmp', npm_config_cache: '/tmp/.npm' },
      binds: [`${dir}:/work:rw`],
      workdir: '/work',
      limits: { memoryMb: 512, cpu: 1 },
    });
    const ready = await this.waitReady(handle.ip, 30_000);
    if (!ready) {
      const logs = await this.containerLogs(handle.containerId);
      await this.sandbox.stopService(handle.containerId).catch(() => undefined);
      await executeCommand('dev.preview.fail',
        { projectId, containerId: handle.containerId, name, image, error: `健康等待超时/进程退出：${logs.slice(-400)}` },
        { ...ctx, projectId });
      throw new DomainError('SANDBOX_INFRA_FAILED', `预览进程未就绪（30s）：${logs.slice(-300) || '无日志'}`, projectId);
    }
    await executeCommand('dev.preview.start',
      { projectId, containerId: handle.containerId, name, image, ip: handle.ip, port: PREVIEW_PORT },
      { ...ctx, projectId });
    return { url: `/dev-preview/${projectId}/`, ip: handle.ip, port: PREVIEW_PORT };
  }

  /** ■ 停止预览（幂等；无运行中预览=安静成功） */
  async stop(projectId: string, ctx: CommandContext, reason = '人工停止') {
    const row = await this.runningRow(projectId);
    if (row && this.sandbox) {
      await this.sandbox.stopService(row.container_name).catch(() => undefined);
    }
    await executeCommand('dev.preview.stop', { projectId, reason }, { ...ctx, projectId });
    return { stopped: row ? 1 : 0 };
  }

  /** 状态（对账自愈：登记表 running 但容器已死 → 命令落 stopped，不留假活） */
  async status(projectId: string) {
    const row = await this.runningRow(projectId);
    if (!row) {
      const last = await query<PreviewRow>(
        'SELECT * FROM dev_previews WHERE project_id=$1 ORDER BY created_at DESC LIMIT 1', [projectId]);
      return { status: 'stopped' as const, lastError: last.rows[0]?.last_error ?? null, lastStatus: last.rows[0]?.status ?? null };
    }
    const live = this.sandbox ? await this.sandbox.inspectService(row.container_name).catch(() => null) : null;
    if (!live?.running) {
      await executeCommand('dev.preview.stop',
        { projectId, reason: `容器已退出（exit=${live?.exitCode ?? '?'}）` },
        { projectId, actorKind: 'system', actorId: 'preview-reconcile' });
      return { status: 'stopped' as const, lastError: `容器已退出（exit=${live?.exitCode ?? '?'}）`, lastStatus: 'running' };
    }
    return {
      status: 'running' as const, url: `/dev-preview/${projectId}/`,
      ip: live.ip || row.ip, port: row.port, image: row.image,
      startedAt: row.started_at, startedBy: row.started_by,
    };
  }

  /**
   * 反代（鉴权由全局 authMiddleware 承载）：任意方法/路径/查询透传到容器；
   * 剥离 Cookie/Authorization/Host（应用看不到平台会话）；容器不可达 → 对账落停 + 明确错误
   */
  async proxy(projectId: string, tail: string, req: Request): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const row = await this.runningRow(projectId);
    if (!row) throw new DomainError('NOT_FOUND', '没有运行中的预览（先 ▶ 启动预览）', projectId);
    const live = this.sandbox ? await this.sandbox.inspectService(row.container_name).catch(() => null) : null;
    if (!live?.running || !live.ip) {
      await executeCommand('dev.preview.stop', { projectId, reason: '代理时发现容器已退出' },
        { projectId, actorKind: 'system', actorId: 'preview-reconcile' });
      throw new DomainError('SANDBOX_INFRA_FAILED', '预览实例已退出（已自动登记停止，可重新启动）', projectId);
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();
      if (['host', 'cookie', 'authorization', 'referer', 'connection', 'content-length'].includes(key)) continue;
      if (typeof v === 'string') headers[key] = v;
    }
    const method = req.method.toUpperCase();
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const body = ['GET', 'HEAD'].includes(method)
      ? undefined
      : (raw && raw.length > 0 ? new Uint8Array(raw) : (req.body ? new Uint8Array(Buffer.from(JSON.stringify(req.body))) : undefined));
    let up: Response;
    try {
      up = await fetch(`http://${live.ip}:${row.port}${tail}`, {
        method, headers, ...(body ? { body } : {}), redirect: 'manual',
      });
    } catch (e) {
      throw new DomainError('SANDBOX_INFRA_FAILED', `预览实例不可达：${e instanceof Error ? e.message : String(e)}`, projectId);
    }
    const buf = Buffer.from(await up.arrayBuffer());
    const outHeaders: Record<string, string> = {};
    const ct = up.headers.get('content-type');
    if (ct) outHeaders['content-type'] = ct;
    // text/html 根相对资源引用重写到反代前缀下（不重写则 /style.css 解析到平台根 404）
    const outBody = ct?.includes('text/html')
      ? Buffer.from(rewritePreviewHtml(buf.toString('utf8'), projectId), 'utf8')
      : buf;
    const loc = up.headers.get('location');
    if (loc) {
      // 应用内相对/根相对跳转重写到反代前缀下（绝对外链原样）
      outHeaders['location'] = loc.startsWith('/') && !loc.startsWith('//')
        ? `/dev-preview/${projectId}${loc}`
        : loc;
    }
    // 预览 CSP：禁外联（沙箱内网本无出向，双保险）+ 允许内联（生成应用约定内联样式/脚本）
    outHeaders['content-security-policy'] = "default-src 'self' 'unsafe-inline' data: blob:; connect-src 'self'";
    return { status: up.status, headers: outHeaders, body: outBody };
  }

  private async runningRow(projectId: string): Promise<PreviewRow | null> {
    const r = await query<PreviewRow>(
      "SELECT * FROM dev_previews WHERE project_id=$1 AND status='running' ORDER BY created_at DESC LIMIT 1", [projectId]);
    return r.rows[0] ?? null;
  }

  /** 健康等待：容器 IP 根路径 200/3xx/404 任一 HTTP 应答即视为进程已监听（应用首页形态不做假设） */
  private async waitReady(ip: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 1500);
        const r = await fetch(`http://${ip}:${PREVIEW_PORT}/`, { signal: ctl.signal }).finally(() => clearTimeout(timer));
        if (r.status > 0) return true;
      } catch { /* 未就绪，继续等 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async containerLogs(containerId: string): Promise<string> {
    if (!this.sandbox) return '';
    try {
      const docker = (this.sandbox as unknown as { client(): Promise<{ getContainer(id: string): { logs(o: Record<string, unknown>): Promise<Buffer> } }> });
      const c = (await docker.client()).getContainer(containerId);
      const raw = await c.logs({ stdout: true, stderr: true });
      return raw.toString('utf8').slice(-2000);
    } catch {
      return '';
    }
  }
}
