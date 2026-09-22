/** M10 集成适配测试（T6-11，需本机 git；REQ-411/412/712） */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalGitAdapter } from './git.service.js';
import { IdentityAdapterStub, LocalCiAdapter, ReleaseAdapterStub } from './adapters.service.js';

const dir = mkdtempSync(join(tmpdir(), 'msf-git-'));
const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

describe('M10 集成适配（git 本地实现 + CI/Identity/Release 桩）', () => {
  const adapter = new LocalGitAdapter();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('本地仓：branch/commit/diff/merge 基线', async () => {
    git(['init', '-b', 'main']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    writeFileSync(join(dir, 'a.txt'), 'v1\n');
    const c1 = await adapter.commitAll(dir, 'init');
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    expect(await adapter.currentBranch(dir)).toBe('main');
    await adapter.checkout(dir, 'feature', { create: true });
    writeFileSync(join(dir, 'b.txt'), 'feat\n');
    await adapter.commitAll(dir, 'feat');
    const d = await adapter.diff(dir, 'main', 'feature');
    expect(d).toContain('b.txt');
    await adapter.checkout(dir, 'main');
    const m = await adapter.merge(dir, 'feature');
    expect(m.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('合并冲突上抛 GIT_MERGE_CONFLICT（附冲突文件清单）', async () => {
    await adapter.checkout(dir, 'conflict-a', { create: true, base: 'main' });
    writeFileSync(join(dir, 'a.txt'), 'A\n');
    await adapter.commitAll(dir, 'a');
    await adapter.checkout(dir, 'conflict-b', { create: true, base: 'main' });
    writeFileSync(join(dir, 'a.txt'), 'B\n');
    await adapter.commitAll(dir, 'b');
    await expect(adapter.merge(dir, 'conflict-a')).rejects.toMatchObject({ code: 'GIT_MERGE_CONFLICT' });
    git(['merge', '--abort']);
  });

  it('CI 桩：trigger 本地标识；status 恒 unknown（状态不明如实上抛）', async () => {
    const ci = new LocalCiAdapter();
    const t = await ci.trigger('build', 'main');
    expect(t.externalId).toContain('local:build@main');
    expect((await ci.status(t.externalId)).status).toBe('unknown');
  });

  it('Identity/Release 仅接口：IDENTITY_AUTH_FAILED / RELEASE_NOT_IMPLEMENTED', async () => {
    await expect(new IdentityAdapterStub().verifyToken('x'))
      .rejects.toMatchObject({ code: 'IDENTITY_AUTH_FAILED' });
    await expect(new ReleaseAdapterStub().publish('a', 'prod'))
      .rejects.toMatchObject({ code: 'RELEASE_NOT_IMPLEMENTED' });
  });
});
