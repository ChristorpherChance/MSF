/** 沙箱执行器集成测试（T6-10，需 Docker + msf_sandbox 网 + alpine:3.20 本地化；M09-1/2/4、REQ-803） */
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxService } from './sandbox.service.js';

const PIN = { tag: 'alpine:3.20', digest: 'sha256:bf8527eb54c3680e728d5b4b383a8ba730d72dae7236fbc8dff97ed6b224a731' };

describe('SandboxRunner 沙箱执行器（集成，需 Docker）', async () => {
  const sandbox = new SandboxService();
  process.env.MSF_SANDBOX_IMAGES = JSON.stringify([PIN]);
  if (!(await sandbox.available())) {
    it.skip('docker 未就绪', () => {});
    return;
  }
  afterAll(() => { delete process.env.MSF_SANDBOX_IMAGES; });

  it('非清单镜像拒绝 SANDBOX_SPEC_INVALID', async () => {
    await expect(sandbox.runOnce({ image: 'alpine:3.19', cmd: ['true'] }))
      .rejects.toMatchObject({ code: 'SANDBOX_SPEC_INVALID' });
  });

  it('一次性容器执行：退出码/日志/环境指纹/镜像 digest 回传', async () => {
    const r = await sandbox.runOnce({ image: PIN.tag, cmd: ['sh', '-c', 'echo hello-sandbox'] });
    expect(r.exitCode).toBe(0);
    expect(r.logs).toContain('hello-sandbox');
    expect(r.imageDigest).toBe(PIN.digest);
    expect(r.envFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('出向负向：非白名单域名容器内不可达（sandbox 网 internal 无出向）', async () => {
    const r = await sandbox.runOnce({
      image: PIN.tag,
      cmd: ['wget', '-T', '3', '-q', '-O', '-', 'http://example.com/'],
      limits: { timeoutMs: 15000 },
    });
    expect(r.exitCode).not.toBe(0); // 网络不可达，wget 非零退出
  }, 30000);

  it('限额：只读根fs 写 / 拒绝；tmpfs /tmp 可写', async () => {
    const r = await sandbox.runOnce({
      image: PIN.tag, cmd: ['sh', '-c', 'touch /x 2>/dev/null; echo root=$?; touch /tmp/y; echo tmp=$?'],
    });
    expect(r.logs).toContain('root=1');
    expect(r.logs).toContain('tmp=0');
  });

  it('超时 kill → EXECUTION_TIMEOUT（附部分日志与指纹）', async () => {
    await expect(sandbox.runOnce({
      image: PIN.tag, cmd: ['sleep', '30'], limits: { timeoutMs: 1000 },
    })).rejects.toMatchObject({ code: 'EXECUTION_TIMEOUT' });
  }, 15000);

  it('并发配额：两长在跑时第三个 SANDBOX_QUOTA_EXCEEDED', async () => {
    const p1 = sandbox.runOnce({ image: PIN.tag, cmd: ['sleep', '5'] });
    const p2 = sandbox.runOnce({ image: PIN.tag, cmd: ['sleep', '5'] });
    // 等两个容器进入 running 计数
    await new Promise((r) => setTimeout(r, 500));
    await expect(sandbox.runOnce({ image: PIN.tag, cmd: ['true'] }))
      .rejects.toMatchObject({ code: 'SANDBOX_QUOTA_EXCEEDED' });
    await expect(p1).resolves.toMatchObject({ exitCode: 0 });
    await expect(p2).resolves.toMatchObject({ exitCode: 0 });
  }, 20000);
});
