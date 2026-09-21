import { Controller, Get } from '@nestjs/common';
import Redis from 'ioredis';
import * as Minio from 'minio';
import { config } from '../../config.js';
import { query } from '../../db/pool.js';

async function pingRedis(): Promise<string> {
  const client = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await client.connect();
  const pong = await client.ping();
  client.disconnect();
  return pong;
}

/** 健康检查：DB/Redis/MinIO 三连通（T0-13） */
@Controller('health')
export class HealthController {
  @Get()
  async check() {
    const [db, redis, minio] = await Promise.allSettled([
      query('SELECT 1'),
      pingRedis(),
      new Minio.Client({
        endPoint: config.minio.endPoint,
        port: config.minio.port,
        useSSL: false,
        accessKey: config.minio.accessKey,
        secretKey: config.minio.secretKey,
      }).listBuckets(),
    ]);
    const status = {
      db: db.status === 'fulfilled',
      redis: redis.status === 'fulfilled',
      minio: minio.status === 'fulfilled',
    };
    return { ok: status.db && status.redis && status.minio, ...status };
  }
}
