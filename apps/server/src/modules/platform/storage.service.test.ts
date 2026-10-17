import { describe, expect, it, afterEach } from 'vitest';
import { StorageService } from '../platform/storage.service.js';

/**
 * 对象存储接线验证（T1-02）：内容寻址读写 + 前缀回收。
 * 集成测试：需本地 MinIO（compose 起 msf-minio-1）；不可达时整体跳过（CI 之 service 容器内必跑）。
 */
async function reachable(): Promise<boolean> {
  try {
    const s = new StorageService();
    await s.ensureBucket();
    return true;
  } catch {
    return false;
  }
}

describe('StorageService（MinIO 内容寻址）', async () => {
  const ok = await reachable();
  const svc = new StorageService();

  it.skipIf(!ok)('同内容必同 key（内容寻址），读写回环一致', async () => {
    const data = Buffer.from('msf-material-存储回环');
    const a = await svc.putContentAddressed(data);
    const b = await svc.putContentAddressed(data);
    expect(a.objectKey).toBe(b.objectKey);
    expect(a.objectKey).toMatch(/^sha256\/[0-9a-f]{64}$/);
    expect(a.size).toBe(data.length);
    const back = await svc.getObject(a.objectKey);
    expect(back.equals(data)).toBe(true);
    await svc.removeObject(a.objectKey);
  });

  it.skipIf(!ok)('removePrefix 回收整前缀（分片暂存清理路径）', async () => {
    const prefix = `uploads/test-${Date.now()}/`;
    await svc.putObject(`${prefix}1.part`, Buffer.from('a'));
    await svc.putObject(`${prefix}2.part`, Buffer.from('b'));
    await svc.removePrefix(prefix);
    await expect(svc.getObject(`${prefix}1.part`)).rejects.toThrow();
  });
});

/** MSF_FILES_PROXY=1 时代理 URL 形态 + 缺省行为不变（差异登记条目 35 增补，2026-10-08 公网部署根修） */
describe('StorageService.presignedGet 代理分支（代理分支纯本地拼装，无需 MinIO）', async () => {
  const svc = new StorageService();
  const ok = await reachable();
  afterEach(() => { delete process.env.MSF_FILES_PROXY; });

  it('MSF_FILES_PROXY=1 时返回相对代理 URL（带 dl/ct 透传）', async () => {
    process.env.MSF_FILES_PROXY = '1';
    const url = await svc.presignedGet('sha256/abc123', 300, '原型.html', 'text/html');
    expect(url.startsWith('/api/v1/files?')).toBe(true);
    expect(url).toContain(`key=${encodeURIComponent('sha256/abc123')}`);
    expect(url).toContain(`dl=${encodeURIComponent('原型.html')}`);
    expect(url).toContain(`ct=${encodeURIComponent('text/html')}`);
  });

  it('MSF_FILES_PROXY=1 且无 dl/ct 时仅带 key', async () => {
    process.env.MSF_FILES_PROXY = '1';
    const url = await svc.presignedGet('sha256/def456');
    expect(url).toBe(`/api/v1/files?key=${encodeURIComponent('sha256/def456')}`);
  });

  // 直签分支 minio SDK 需回源查 bucket region，MinIO 不可达时跳过（与上面集成段同口径）
  it.skipIf(!ok)('未设 MSF_FILES_PROXY 时仍签 MinIO 直链（行为不变）', async () => {
    const url = await svc.presignedGet('sha256/abc123');
    expect(url.startsWith('/api/v1/files')).toBe(false);
    // key 编码形态随 minio SDK 版本而定（8.x 直出字面斜杠）——解码后断言与编码无关
    expect(decodeURIComponent(url)).toContain('sha256/abc123');
  });
});
