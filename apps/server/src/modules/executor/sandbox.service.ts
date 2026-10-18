import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';

/**
 * SandboxRunner 沙箱执行器（LLD-1 M09-1/2/4；REQ-803；ADR-8）：
 * - dockerode 直连 Docker（Windows npipe / Unix sock 由 dockerode 默认解析）
 * - 一次性容器：只读根fs + tmpfs /tmp + CapDrop ALL + no-new-privileges + CPU/内存/时长限额
 * - 网络 msf_sandbox（internal:true 无出向；唯一例外 egress-proxy 白名单，compose profile=full）
 * - 镜像清单锚定：env MSF_SANDBOX_IMAGES='[{"tag":"alpine:3.20","digest":"sha256:…"}]'，
 *   不在清单即 SANDBOX_SPEC_INVALID；digest 非空时校验本地解析 digest 一致
 * - 并发配额（进程内，默认 2）超限 SANDBOX_QUOTA_EXCEEDED；超时 kill 抛 EXECUTION_TIMEOUT（附部分日志）
 * - 证据：退出码/日志/环境指纹随结果返回，由调用方（委派/执行编排）经 M11 落 evd_records
 */

export interface SandboxImagePin { tag: string; digest?: string }

export interface SandboxSpec {
  image: string;
  cmd: string[];
  env?: Record<string, string>;
  limits?: { memoryMb?: number; cpu?: number; timeoutMs?: number };
  /** 绑定挂载（开发域真化：工作区目录挂入 /work 等）；元素为 docker Binds 语法 "host:container[:ro|rw]" */
  binds?: string[];
  /** 工作目录（如 /work） */
  workdir?: string;
}

export interface SandboxResult {
  exitCode: number;
  logs: string;
  durationMs: number;
  imageDigest: string;
  /** 环境指纹：sha256(image digest + 限额 + 网络) —— 执行环境同一性证据（M09-4） */
  envFingerprint: string;
}

/** 长驻服务句柄（运行预览二期：沙箱起服务，进程保活，命令退出不销毁——由调用方负责 stop） */
export interface SandboxServiceHandle {
  containerId: string;
  name: string;
  /** 容器在沙箱网络内的 IP（宿主可达；internal 网仅断出向） */
  ip: string;
}

export interface SandboxServiceSpec {
  image: string;
  cmd: string[];
  name: string;
  env?: Record<string, string>;
  binds?: string[];
  workdir?: string;
  limits?: { memoryMb?: number; cpu?: number };
}

const NETWORK = process.env.MSF_SANDBOX_NETWORK ?? 'msf_sandbox';
const MAX_CONCURRENT = Number(process.env.MSF_SANDBOX_CONCURRENCY ?? 2);
const DEFAULT_TIMEOUT_MS = 120_000;

interface ContainerHandle {
  id: string;
  start(): Promise<void>;
  wait(): Promise<{ StatusCode: number }>;
  logs(opts: Record<string, unknown>): Promise<Buffer>;
  kill(): Promise<void>;
  stop?(opts?: Record<string, unknown>): Promise<void>;
  remove(opts?: Record<string, unknown>): Promise<void>;
  inspect(): Promise<{
    State?: { Running?: boolean; ExitCode?: number };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  }>;
}

interface DockerLike {
  listImages(options: { filters: string }): Promise<Array<{ Id: string; RepoDigests: string[] | null }>>;
  createContainer(opts: Record<string, unknown>): Promise<ContainerHandle>;
  getContainer(id: string): ContainerHandle;
  ping(): Promise<unknown>;
}

@Injectable()
export class SandboxService {
  private docker: DockerLike | null = null;
  private running = 0;

  /** dockerode 懒加载（CJS 兼容；无 Docker 环境仅在使用时报错） */
  private async client(): Promise<DockerLike> {
    if (!this.docker) {
      const mod = await import('dockerode');
      const Docker = mod.default;
      this.docker = new Docker() as unknown as DockerLike;
    }
    return this.docker;
  }

  async available(): Promise<boolean> {
    try {
      await (await this.client()).ping();
      return true;
    } catch {
      return false;
    }
  }

  manifest(): SandboxImagePin[] {
    try {
      return JSON.parse(process.env.MSF_SANDBOX_IMAGES ?? '[]') as SandboxImagePin[];
    } catch {
      return [];
    }
  }

  private async resolveImage(docker: DockerLike, image: string): Promise<{ digest: string }> {
    const pin = this.manifest().find((p) => p.tag === image || `${p.tag}@${p.digest}` === image);
    if (!pin) {
      throw new DomainError('SANDBOX_SPEC_INVALID', `镜像不在沙箱清单（tag+digest 锚定）: ${image}`, image);
    }
    const ref = image.includes('@') ? image.split('@')[0]! : image;
    const imgs = await docker.listImages({ filters: JSON.stringify({ reference: [ref] }) });
    const local = imgs[0];
    if (!local) throw new DomainError('SANDBOX_SPEC_INVALID', `镜像未本地化（先 pull）: ${ref}`, image);
    const digest = local.RepoDigests?.[0]?.split('@')[1] ?? local.Id;
    if (pin.digest && digest !== pin.digest && !local.RepoDigests?.[0]?.endsWith(pin.digest)) {
      throw new DomainError('SANDBOX_SPEC_INVALID', `镜像 digest 与清单锚定不一致: ${digest} ≠ ${pin.digest}`, image);
    }
    return { digest };
  }

  async runOnce(spec: SandboxSpec): Promise<SandboxResult> {
    if (!spec.image || !Array.isArray(spec.cmd) || spec.cmd.length === 0) {
      throw new DomainError('SANDBOX_SPEC_INVALID', 'image/cmd 必填且 cmd 非空数组', 'spec');
    }
    if (this.running >= MAX_CONCURRENT) {
      throw new DomainError('SANDBOX_QUOTA_EXCEEDED', `沙箱并发配额 ${MAX_CONCURRENT} 已满`, 'quota');
    }
    const docker = await this.client();
    const { digest } = await this.resolveImage(docker, spec.image);
    const memoryMb = spec.limits?.memoryMb ?? 256;
    const cpu = spec.limits?.cpu ?? 0.5;
    const timeoutMs = spec.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const envFingerprint = createHash('sha256')
      .update(JSON.stringify({ digest, memoryMb, cpu, network: NETWORK, readonly: true }))
      .digest('hex');

    const container = await docker.createContainer({
      Image: spec.image,
      Cmd: spec.cmd,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
      HostConfig: {
        NetworkMode: NETWORK,
        Memory: memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(cpu * 1e9),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
        ...(spec.binds?.length ? { Binds: spec.binds } : {}),
      },
    });
    this.running += 1;
    const t0 = Date.now();
    let timedOut = false;
    try {
      await container.start();
      const timer = setTimeout(() => {
        timedOut = true;
        void container.kill().catch(() => undefined);
      }, timeoutMs);
      let statusCode: number;
      try {
        statusCode = (await container.wait()).StatusCode;
      } finally {
        clearTimeout(timer);
      }
      const raw = await container.logs({ stdout: true, stderr: true });
      const logs = demux(raw);
      if (timedOut) {
        throw new DomainError('EXECUTION_TIMEOUT', `沙箱执行超时（${timeoutMs}ms），已终止`, spec.image, {
          partialLogs: logs.slice(-2000), envFingerprint,
        });
      }
      return { exitCode: statusCode, logs, durationMs: Date.now() - t0, imageDigest: digest, envFingerprint };
    } finally {
      this.running -= 1;
      await container.remove({ force: true }).catch(() => undefined);
    }
  }

  /**
   * 长驻服务（运行预览二期）：与 runOnce 同一安全基线（internal 网/只读根/CapDrop ALL/
   * no-new-privileges/限额），差异=不等待退出、不自动销毁、不占 runOnce 并发配额；
   * 同名容器先清后建（幂等重起）。调用方负责 stopService 回收。
   */
  async runService(spec: SandboxServiceSpec): Promise<SandboxServiceHandle> {
    const docker = await this.client();
    const { digest } = await this.resolveImage(docker, spec.image);
    const memoryMb = spec.limits?.memoryMb ?? 512;
    const cpu = spec.limits?.cpu ?? 1;
    // 幂等：同名残留（进程重启后句柄丢失）先强制回收
    const stale = docker.getContainer(spec.name);
    const staleInfo = await stale.inspect().catch(() => null);
    if (staleInfo) await stale.remove({ force: true }).catch(() => undefined);
    const container = await docker.createContainer({
      Image: spec.image,
      name: spec.name,
      Cmd: spec.cmd,
      Env: Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`),
      ...(spec.workdir ? { WorkingDir: spec.workdir } : {}),
      Labels: { 'msf.kind': 'preview', 'msf.image.digest': digest },
      HostConfig: {
        NetworkMode: NETWORK,
        Memory: memoryMb * 1024 * 1024,
        NanoCpus: Math.floor(cpu * 1e9),
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,nosuid,size=128m' },
        AutoRemove: false,
        ...(spec.binds?.length ? { Binds: spec.binds } : {}),
      },
    });
    await container.start();
    const info = await container.inspect();
    const ip = info.NetworkSettings?.Networks?.[NETWORK]?.IPAddress ?? '';
    if (!ip) {
      await container.remove({ force: true }).catch(() => undefined);
      throw new DomainError('SANDBOX_INFRA_FAILED', '长驻容器未取到沙箱网络 IP', spec.name);
    }
    return { containerId: container.id, name: spec.name, ip };
  }

  /** 长驻容器实时状态（死容器自愈判定用）；不存在 → null */
  async inspectService(containerIdOrName: string): Promise<{ running: boolean; exitCode: number | null; ip: string } | null> {
    const docker = await this.client();
    const c = docker.getContainer(containerIdOrName);
    const info = await c.inspect().catch(() => null);
    if (!info) return null;
    return {
      running: info.State?.Running === true,
      exitCode: info.State?.ExitCode ?? null,
      ip: info.NetworkSettings?.Networks?.[NETWORK]?.IPAddress ?? '',
    };
  }

  /** 回收长驻容器（幂等：不存在即成功） */
  async stopService(containerIdOrName: string): Promise<void> {
    const docker = await this.client();
    const c = docker.getContainer(containerIdOrName);
    await c.remove({ force: true }).catch(() => undefined);
  }
}

/** dockerode logs 多路复用帧（8B 头/帧）解包；TTY 镜像直接为原文 */
function demux(raw: Buffer): string {
  const out: Buffer[] = [];
  let i = 0;
  while (i + 8 <= raw.length) {
    const size = raw.readUInt32BE(i + 4);
    if (i + 8 + size > raw.length) break;
    out.push(raw.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return (out.length ? Buffer.concat(out) : raw).toString('utf8');
}
