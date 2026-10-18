import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import type { SandboxResult, SandboxService, SandboxSpec } from '../executor/sandbox.service.js';

/**
 * 开发工作区（2026-10-18 开发域真化一期，用户拍板「开发测试阶段真走一遍」）：
 * - 每项目一个真实工作区目录 MSF_WORKSPACES_ROOT/<projectId>/（git 仓），
 *   AI 写码产物落真文件、逐任务 git commit（代码仓面板/预览/构建/测试全部同源）
 * - devMode()：MSF_DEV_MODE=real 开真化（默认 mock——单测/CI 与本地开发零依赖 Docker/模型）；
 *   真化下沙箱不可用/模型不真接 = 明确报错，不静默降级（REQ-610 同纪律）
 * - 宿主持依赖安装（沙箱网 internal 无出向，装不了包）：npm install --ignore-scripts
 *   （AI 产物的 postinstall 不得在宿主执行）；容器平台与宿主同为 linux/x86_64 故可复用
 */

const execFileP = promisify(execFile);

export type DevMode = 'mock' | 'real';
export function devMode(): DevMode {
  return process.env.MSF_DEV_MODE === 'real' ? 'real' : 'mock';
}

/** 真化构建/测试/预览所用运行时镜像（须在 MSF_SANDBOX_IMAGES 清单内锚定） */
export function devRuntimeImage(): string {
  return process.env.MSF_DEV_IMAGE ?? 'node:22-bookworm-slim';
}

export function workspacesRoot(): string {
  return resolve(process.env.MSF_WORKSPACES_ROOT ?? join(process.cwd(), 'var/workspaces'));
}

export interface WorkspaceExecResult extends SandboxResult {
  /** 执行时工作区 git HEAD（证据锚定代码实物） */
  gitSha: string | null;
}

@Injectable()
export class DevWorkspaceService {
  onModuleInit(): void {
    // 登记命令（fs/git 副作用在事务外完成后，本命令只留痕——与「对象先写后登记」同口径）
    registerCommand('dev.workspace.ensure', async (_client, payload) => {
      const { projectId, dir, gitSha } = payload as { projectId: string; dir: string; gitSha: string | null };
      return { projectId, dir, gitSha };
    });
  }

  /** 工作区目录（含路径收编校验：projectId 必须是 uuid 形态，防路径上跳） */
  dir(projectId: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new DomainError('VALIDATION_FAILED', 'projectId 形态非法', projectId);
    }
    const dir = join(workspacesRoot(), projectId);
    if (!resolve(dir).startsWith(resolve(workspacesRoot()) + sep)) {
      throw new DomainError('VALIDATION_FAILED', '工作区路径越界', projectId);
    }
    return dir;
  }

  exists(projectId: string): boolean {
    try {
      return existsSync(join(this.dir(projectId), 'package.json'));
    } catch {
      return false;
    }
  }

  /** 确保工作区存在（幂等）：目录 + git init + 首提交；登记 dev.workspace.ensure */
  async ensure(projectId: string, ctx: CommandContext): Promise<{ dir: string; gitSha: string | null }> {
    const dir = this.dir(projectId);
    await mkdir(dir, { recursive: true });
    if (!existsSync(join(dir, '.git'))) {
      await writeFile(join(dir, 'README.md'), `# 项目工作区\n\n本目录由 MSF 开发域真化维护：AI 写码逐任务提交，构建/测试/预览同源。\n`, 'utf8');
      await writeFile(join(dir, '.gitignore'), 'node_modules/\ndata/\n/tmp/\n', 'utf8');
      await this.git(dir, ['init', '-q']);
    }
    const gitSha = await this.commitAll(dir, 'chore: workspace ensure');
    await executeCommand('dev.workspace.ensure', { projectId, dir, gitSha }, { ...ctx, projectId });
    return { dir, gitSha };
  }

  /** git 全量提交（无变更=返回当前 HEAD，不产生空提交以外的副作用） */
  async commitAll(dir: string, message: string): Promise<string | null> {
    await this.git(dir, ['add', '-A']);
    const status = await this.git(dir, ['status', '--porcelain']);
    if (status.trim()) {
      await this.git(dir, ['-c', 'user.email=msf-dev@local', '-c', 'user.name=msf-codegen', 'commit', '-q', '-m', message]);
    }
    const head = await this.git(dir, ['rev-parse', 'HEAD']).catch(() => '');
    return head.trim() || null;
  }

  /** 宿主依赖安装（--ignore-scripts：AI 产物脚本不在宿主执行；无 package.json=跳过） */
  async npmInstall(projectId: string): Promise<{ installed: boolean; logsTail: string }> {
    const dir = this.dir(projectId);
    if (!existsSync(join(dir, 'package.json'))) return { installed: false, logsTail: 'no package.json' };
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      const { stdout, stderr } = await execFileP(
        npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
        { cwd: dir, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      );
      return { installed: true, logsTail: `${stdout}\n${stderr}`.slice(-2000) };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      throw new DomainError(
        'SANDBOX_INFRA_FAILED',
        `宿主依赖安装失败：${`${err.stdout ?? ''}\n${err.stderr ?? ''}`.slice(-800) || err.message}`,
        projectId,
      );
    }
  }

  /** 沙箱内执行（工作区挂 /work 可写；HOME/npm 缓存指 tmpfs，免写只读根） */
  async runInWorkspace(
    sandbox: SandboxService, projectId: string, cmd: string[], opts?: { timeoutMs?: number; memoryMb?: number },
  ): Promise<WorkspaceExecResult> {
    const dir = this.dir(projectId);
    const gitSha = (await this.git(dir, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
    const spec: SandboxSpec = {
      image: devRuntimeImage(),
      cmd,
      workdir: '/work',
      binds: [`${dir}:/work:rw`],
      env: { HOME: '/tmp', npm_config_cache: '/tmp/.npm', CI: 'true' },
      limits: { timeoutMs: opts?.timeoutMs ?? 300_000, memoryMb: opts?.memoryMb ?? 1024, cpu: 1 },
    };
    const r = await sandbox.runOnce(spec);
    return { ...r, gitSha };
  }

  /** 工作区文件清单（git ls-files 口径；无 git=空） */
  async listFiles(projectId: string): Promise<string[]> {
    const dir = this.dir(projectId);
    if (!existsSync(join(dir, '.git'))) return [];
    const out = await this.git(dir, ['ls-files']).catch(() => '');
    return out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 500);
  }

  /** 读文件（收编校验 + 256KB 上限） */
  async readFile(projectId: string, rel: string): Promise<string> {
    const dir = this.dir(projectId);
    const full = this.contained(dir, rel);
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) throw new DomainError('NOT_FOUND', '文件不存在', rel);
    if (st.size > 256 * 1024) throw new DomainError('VALIDATION_FAILED', '文件过大（>256KB）', rel);
    return readFile(full, 'utf8');
  }

  /** 写文件（AI 产物落盘唯一入口：收编校验 + .git/node_modules 禁区 + 256KB 上限） */
  async writeFile(projectId: string, rel: string, content: string): Promise<void> {
    if (Buffer.byteLength(content, 'utf8') > 256 * 1024) {
      throw new DomainError('VALIDATION_FAILED', '单文件过大（>256KB）', rel);
    }
    const dir = this.dir(projectId);
    const full = this.contained(dir, rel);
    if (rel === '.git' || rel.startsWith('.git/') || rel === 'node_modules' || rel.startsWith('node_modules/')) {
      throw new DomainError('VALIDATION_FAILED', '禁写区（.git/node_modules）', rel);
    }
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }

  /** 最近提交（代码仓面板真实化） */
  async gitLog(projectId: string, limit = 30): Promise<Array<{ sha: string; message: string; at: string }>> {
    const dir = this.dir(projectId);
    if (!existsSync(join(dir, '.git'))) return [];
    const out = await this.git(dir, ['log', `-${limit}`, '--format=%H%x1f%ad%x1f%s', '--date=iso']).catch(() => '');
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, at, ...msg] = line.split('\x1f');
      return { sha: sha ?? '', at: at ?? '', message: msg.join('\x1f') };
    });
  }

  /** 目录列举（代码仓面板树降级用；node_modules/.git 不入） */
  async listDir(projectId: string): Promise<string[]> {
    const files = await this.listFiles(projectId);
    if (files.length > 0) return files;
    // 无 git 时的兜底：浅扫两层
    const dir = this.dir(projectId);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    const walk = async (base: string, depth: number): Promise<void> => {
      if (depth > 3 || out.length > 500) return;
      const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name === 'node_modules' || e.name === '.git') continue;
        const full = join(base, e.name);
        const rel = full.slice(dir.length + 1).split(sep).join('/');
        if (e.isDirectory()) await walk(full, depth + 1);
        else out.push(rel);
      }
    };
    await walk(dir, 1);
    return out;
  }

  private contained(dir: string, rel: string): string {
    if (!rel || rel.startsWith('/') || rel.includes('..') || /[<>:"|?*]/.test(rel)) {
      throw new DomainError('VALIDATION_FAILED', '路径非法（须为仓库内相对路径）', rel);
    }
    const full = resolve(join(dir, rel));
    if (!full.startsWith(resolve(dir) + sep)) {
      throw new DomainError('VALIDATION_FAILED', '路径越界', rel);
    }
    return full;
  }

  private async git(dir: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileP('git', args, { cwd: dir, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      const err = e as { stderr?: string; message?: string };
      throw new DomainError('SANDBOX_INFRA_FAILED', `git ${args[0]} 失败：${(err.stderr ?? err.message ?? '').slice(-400)}`, dir);
    }
  }
}
