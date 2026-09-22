import { describe, expect, it } from 'vitest';
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
