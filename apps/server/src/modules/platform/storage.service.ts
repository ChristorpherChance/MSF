import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import * as Minio from 'minio';
import { config } from '../../config.js';

/**
 * 对象存储接线（LLD-4 DSG-D01-5）：大体积内容一律落 MinIO，DB 只存 object_key + 指纹。
 * 内容寻址：key = `sha256/<hex>`——同内容必同 key，项目内同内容去重、跨项目天然共享一份
 * （唯一性收窄为 (project_id, object_key) 复合唯一的原因见 DSG-D03-2 object_key 字段说明）。
 * 分片暂存前缀：`uploads/<uploadId>/`（DSG-D03-7），complete/abort 后整前缀回收。
 */
@Injectable()
export class StorageService {
  private readonly client: Minio.Client;
  private readonly bucket = config.minio.bucket;

  constructor() {
    this.client = new Minio.Client({
      endPoint: config.minio.endPoint,
      port: config.minio.port,
      useSSL: false,
      accessKey: config.minio.accessKey,
      secretKey: config.minio.secretKey,
    });
  }

  async ensureBucket(): Promise<void> {
    if (!(await this.client.bucketExists(this.bucket))) {
      await this.client.makeBucket(this.bucket);
    }
  }

  /** 内容寻址写入：返回 object_key（`sha256/<hex>`）与字节数 */
  async putContentAddressed(data: Buffer): Promise<{ objectKey: string; size: number }> {
    const hex = createHash('sha256').update(data).digest('hex');
    const objectKey = `sha256/${hex}`;
    await this.ensureBucket();
    await this.client.putObject(this.bucket, objectKey, data, data.length);
    return { objectKey, size: data.length };
  }

  /** 按显式 key 写入（分片暂存等非内容寻址场景） */
  async putObject(objectKey: string, data: Buffer): Promise<void> {
    await this.ensureBucket();
    await this.client.putObject(this.bucket, objectKey, data, data.length);
  }

  async getObject(objectKey: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, objectKey);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  async removeObject(objectKey: string): Promise<void> {
    await this.client.removeObject(this.bucket, objectKey);
  }

  /** 回收整前缀对象（上传会话 complete/abort/expire 清分片，DSG-D03-7） */
  async removePrefix(prefix: string): Promise<void> {
    const objects: string[] = [];
    const stream = this.client.listObjectsV2(this.bucket, prefix, true);
    for await (const obj of stream as AsyncIterable<{ name: string }>) {
      objects.push(obj.name);
    }
    if (objects.length > 0) await this.client.removeObjects(this.bucket, objects);
  }

  /**
   * 短时签名直链（A03-7 source 视图，REQ-113）。
   * downloadName：附 response-content-disposition（RFC 5987 编码，支持中文文件名），浏览器下载落盘为该名。
   */
  async presignedGet(objectKey: string, expirySeconds = 300, downloadName?: string): Promise<string> {
    const respHeaders = downloadName
      ? { 'response-content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
      : undefined;
    return this.client.presignedGetObject(this.bucket, objectKey, expirySeconds, respHeaders);
  }
}
