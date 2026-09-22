import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';

const execFileP = promisify(execFile);

/**
 * M10 Git 适配器（LLD-1 M10-1；REQ-411/412）：
 * 接口抽象 + 本地 git CLI 实现。合并冲突上抛 GIT_MERGE_CONFLICT（不静默续跑）。
 * 远程 provider（Gitea/GitHub）经同一接口后置适配；本期仅本地实现。
 */
export interface GitAdapter {
  /** 当前分支名 */
  currentBranch(cwd: string): Promise<string>;
  /** 创建/切换分支（base 可选） */
  checkout(cwd: string, branch: string, opts?: { create?: boolean; base?: string }): Promise<void>;
  /** 提交工作区全部变更，返回 commit sha */
  commitAll(cwd: string, message: string): Promise<string>;
  /** merge --no-ff；冲突抛 GIT_MERGE_CONFLICT（details.conflicts=冲突文件清单） */
  merge(cwd: string, branch: string): Promise<{ sha: string }>;
  /** 两 refs 间 diff 摘要（name-status） */
  diff(cwd: string, from: string, to: string): Promise<string>;
  /** HEAD sha */
  head(cwd: string): Promise<string>;
}

@Injectable()
export class LocalGitAdapter implements GitAdapter {
  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
      const out = `${err.stdout ?? ''} ${err.stderr ?? ''} ${err.message ?? ''}`;
      if (args[0] === 'merge' && /CONFLICT|Automatic merge failed/i.test(out)) {
        const conflicts = await this.git(cwd, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
        throw new DomainError('GIT_MERGE_CONFLICT', `合并冲突：${args[1]}`, args[1], {
          conflicts: conflicts.split('\n').filter(Boolean),
        });
      }
      throw new DomainError('VALIDATION_FAILED', `git ${args[0]} 失败: ${err.stderr ?? err.message}`, args[0]);
    }
  }

  async currentBranch(cwd: string): Promise<string> {
    return this.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async checkout(cwd: string, branch: string, opts?: { create?: boolean; base?: string }): Promise<void> {
    if (opts?.create) {
      await this.git(cwd, ['checkout', '-b', branch, ...(opts.base ? [opts.base] : [])]);
    } else {
      await this.git(cwd, ['checkout', branch]);
    }
  }

  async commitAll(cwd: string, message: string): Promise<string> {
    await this.git(cwd, ['add', '-A']);
    await this.git(cwd, ['commit', '-m', message, '--allow-empty']);
    return this.head(cwd);
  }

  async merge(cwd: string, branch: string): Promise<{ sha: string }> {
    await this.git(cwd, ['merge', '--no-ff', branch, '-m', `merge: ${branch}`]);
    return { sha: await this.head(cwd) };
  }

  async diff(cwd: string, from: string, to: string): Promise<string> {
    return this.git(cwd, ['diff', '--name-status', from, to]);
  }

  async head(cwd: string): Promise<string> {
    return this.git(cwd, ['rev-parse', 'HEAD']);
  }
}
