import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError, UPLOAD_FORMATS } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { validateZipPackage } from './zip-check.js';
import { normalizeUploadExt } from './ext.js';
import { StorageService } from '../platform/storage.service.js';
import type { MatUpload, UploadPart } from './types.js';

/**
 * 上传会话（LLD-5 DSG-A03-1/2/3/18，LLD-4 DSG-D03-7）。
 * 限额（统稿裁决 D10）：非 ZIP ≤50MB 直传、>50MB 分片；ZIP ≤30MB（F09-1 步 1，complete 整包复验）。
 * 分片并发：parts 更新在命令事务内 SELECT … FOR UPDATE 行锁 + 重读-合并-写回（A03-2）。
 */

const DIRECT_LIMIT = 50 * 1024 * 1024; // 非 ZIP 直传上限（D10）
const ZIP_LIMIT = 30 * 1024 * 1024; // ZIP 整包上限（F09-1）
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 过期 24h（D03-7 建议值，压测校准）

export interface CreateUploadInput {
  fileName: string;
  size: number;
  mime?: string;
  sha256: string;
  folderId?: string;
  partSize?: number;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

@Injectable()
export class UploadsService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  onModuleInit(): void {
    registerCommand('material.upload.create', async (client, payload, ctx) => {
      const { projectId, input, uploadId, expiresAt } = payload as {
        projectId: string;
        input: CreateUploadInput;
        uploadId: string;
        expiresAt: string;
      };
      await this.lockProject(client, projectId);
      const partSize = input.partSize ?? input.size;
      const partsTotal = Math.max(1, Math.ceil(input.size / partSize));
      await client.query(
        `INSERT INTO mat_uploads
          (id, project_id, upload_id, file_name, mime, declared_size, declared_sha256,
           folder_id, part_size, parts_total, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          projectId,
          uploadId,
          input.fileName,
          input.mime ?? null,
          input.size,
          input.sha256,
          input.folderId ?? null,
          partSize,
          partsTotal,
          expiresAt,
          ctx.actorId,
        ],
      );
      return { uploadId, parts: partsTotal, expiresAt };
    });

    // A03-2：行锁串行化——锁会话行 → 重读 parts → 合并（同分片号覆盖=天然键幂等）→ 写回
    registerCommand('material.upload.part', async (client, payload) => {
      const { uploadId, part } = payload as { uploadId: string; part: UploadPart };
      const row = await this.lockSession(client, uploadId);
      const parts = row.parts.filter((p) => p.part_number !== part.part_number);
      parts.push(part);
      parts.sort((a, b) => a.part_number - b.part_number);
      await client.query('UPDATE mat_uploads SET parts=$2, updated_at=now() WHERE upload_id=$1', [
        uploadId,
        JSON.stringify(parts),
      ]);
      return { uploadId, partNumber: part.part_number, received: part.size_bytes };
    });

    // A03-3：整包验证通过才一次提交（mat_files 写入与会话收口同一事务）
    registerCommand('material.upload.complete', async (client, payload, ctx) => {
      const { projectId, uploadId } = payload as { projectId: string; uploadId: string };
      const session = await this.lockSession(client, uploadId);
      const parts = session.parts;
      if (parts.length !== session.parts_total) {
        throw new DomainError('VALIDATION_FAILED', '分片未传齐，无法完成上传', 'parts');
      }
      for (let i = 0; i < parts.length; i++) {
        if (parts[i]?.part_number !== i + 1) {
          throw new DomainError('VALIDATION_FAILED', `分片不连续：缺第 ${i + 1} 片`, 'parts');
        }
      }
      // 合并：逐分片取回并复核分片哈希，再验整体 SHA-256 与声明一致
      const buffers: Buffer[] = [];
      for (const p of parts) {
        const data = await this.storage.getObject(p.object_key);
        if (sha256(data) !== p.sha256) {
          throw new DomainError('UPLOAD_REJECTED', `分片 ${p.part_number} 哈希不一致`, p.object_key);
        }
        buffers.push(data);
      }
      const merged = Buffer.concat(buffers);
      if (merged.length !== Number(session.declared_size)) {
        throw new DomainError('UPLOAD_REJECTED', '合并大小与声明不一致', session.upload_id);
      }
      const contentFingerprint = sha256(merged);
      if (contentFingerprint !== session.declared_sha256) {
        throw new DomainError('UPLOAD_REJECTED', '整体 SHA-256 与声明不一致', session.upload_id);
      }
      // ZIP：整包执行 F09-1 十五步校验，违规逐项入 details.violations
      const ext = extOf(session.file_name);
      let zipCheck: Record<string, unknown> | null = null;
      if (ext === 'zip') {
        const r = validateZipPackage(merged);
        if (!r.ok) {
          throw new DomainError('UPLOAD_REJECTED', 'ZIP 整包校验未通过', session.file_name, {
            violations: r.violations,
          });
        }
        zipCheck = {
          entries: r.entries.length,
          totalUncompressed: r.totalUncompressed,
          checkedAt: new Date().toISOString(),
        };
      }
      // 内容寻址落库；项目内同内容去重——命中既有 (project_id, object_key) 行则回链不重复建行
      const objectKey = `sha256/${contentFingerprint}`;
      await this.storage.putObject(objectKey, merged);
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM mat_files WHERE project_id=$1 AND object_key=$2',
        [projectId, objectKey],
      );
      let fileId: string;
      if (existing.rows[0]) {
        fileId = existing.rows[0].id;
      } else {
        const code = await this.nextFileCode(client, projectId);
        fileId = randomUUID();
        await client.query(
          `INSERT INTO mat_files
            (id, project_id, code, name, ext, size_bytes, object_key, content_fingerprint,
             source, zip_check, folder_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'upload',$9,$10,$11)`,
          [
            fileId,
            projectId,
            code,
            session.file_name,
            ext,
            merged.length,
            objectKey,
            contentFingerprint,
            zipCheck ? JSON.stringify(zipCheck) : null,
            session.folder_id,
            ctx.actorId,
          ],
        );
      }
      await client.query(
        "UPDATE mat_uploads SET status='completed', file_id=$2, updated_at=now() WHERE upload_id=$1",
        [uploadId, fileId],
      );
      return { fileId, zipCheck };
    });

    // A03-18：显式中止（暂存分片回收在事务提交后由服务层执行）
    registerCommand('material.upload.abort', async (client, payload) => {
      const { uploadId } = payload as { uploadId: string };
      await this.lockSession(client, uploadId);
      await client.query(
        "UPDATE mat_uploads SET status='aborted', updated_at=now() WHERE upload_id=$1",
        [uploadId],
      );
      return { uploadId, status: 'aborted' };
    });
  }

  /** A03-1 创建会话：声明式预校验（格式/大小限额，REQ-102/103） */
  async create(
    projectId: string,
    input: CreateUploadInput,
    ctx: CommandContext,
  ): Promise<{ uploadId: string; parts: number; expiresAt: string }> {
    const ext = extOf(input.fileName);
    if (!ext || !(UPLOAD_FORMATS as readonly string[]).includes(ext)) {
      throw new DomainError('UPLOAD_REJECTED', '文件格式不支持（doc/docx/pdf/xlsx/md/txt/zip）', input.fileName);
    }
    if (!Number.isSafeInteger(input.size) || input.size <= 0) {
      throw new DomainError('VALIDATION_FAILED', '声明大小非法', 'size');
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) {
      throw new DomainError('VALIDATION_FAILED', '声明 SHA-256 非法', 'sha256');
    }
    if (ext === 'zip' && input.size > ZIP_LIMIT) {
      throw new DomainError('UPLOAD_REJECTED', 'ZIP 大小不支持（>30MB）', input.fileName);
    }
    if (input.size > DIRECT_LIMIT) {
      // >50MB 必须分片（D10）
      if (!input.partSize || input.partSize <= 0 || input.partSize >= input.size) {
        throw new DomainError('UPLOAD_REJECTED', '超过 50MB 须分片上传（声明 partSize）', 'partSize');
      }
    } else if (input.partSize !== undefined && (input.partSize <= 0 || input.partSize > input.size)) {
      throw new DomainError('VALIDATION_FAILED', '分片大小非法', 'partSize');
    }
    if (input.folderId) await this.assertFolder(projectId, input.folderId);
    const uploadId = `upl_${randomBytes(12).toString('hex')}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    return (await executeCommand(
      'material.upload.create',
      { projectId, input, uploadId, expiresAt },
      { ...ctx, projectId },
    )) as { uploadId: string; parts: number; expiresAt: string };
  }

  /** A03-2 分片上传：MinIO 暂存先行，元数据经命令事务行锁合并（天然键幂等，重传覆盖） */
  async uploadPart(
    projectId: string,
    uploadId: string,
    partNumber: number,
    body: Buffer,
  ): Promise<{ uploadId: string; partNumber: number; received: number }> {
    if (!Number.isInteger(partNumber) || partNumber < 1) {
      throw new DomainError('VALIDATION_FAILED', '分片号非法', 'partNumber');
    }
    const session = await this.getSession(uploadId);
    this.assertSessionActive(session);
    if (partNumber > session.parts_total) {
      throw new DomainError('VALIDATION_FAILED', '分片号超出声明总数', 'partNumber');
    }
    const expected =
      partNumber < session.parts_total
        ? Number(session.part_size)
        : Number(session.declared_size) - Number(session.part_size) * (session.parts_total - 1);
    if (body.length !== expected) {
      throw new DomainError('VALIDATION_FAILED', `分片大小应为 ${expected} 字节`, 'partNumber');
    }
    const objectKey = `uploads/${uploadId}/${partNumber}`;
    await this.storage.putObject(objectKey, body);
    const part: UploadPart = {
      part_number: partNumber,
      size_bytes: body.length,
      sha256: sha256(body),
      object_key: objectKey,
    };
    return (await executeCommand(
      'material.upload.part',
      { uploadId, part },
      { projectId, actorKind: 'human', actorId: 'local' },
    )) as { uploadId: string; partNumber: number; received: number };
  }

  /** A03-3 完成上传：命令事务内整包验证+一次提交；提交后回收暂存分片 */
  async complete(
    projectId: string,
    uploadId: string,
    ctx: CommandContext,
  ): Promise<{ file: unknown; zipCheck: unknown }> {
    const r = (await executeCommand(
      'material.upload.complete',
      { projectId, uploadId },
      { ...ctx, projectId },
    )) as { fileId: string; zipCheck: unknown };
    await this.storage.removePrefix(`uploads/${uploadId}/`).catch(() => undefined); // 回收失败留待过期清理
    const file = await query('SELECT * FROM mat_files WHERE id=$1', [r.fileId]);
    return { file: file.rows[0], zipCheck: r.zipCheck };
  }

  /** A03-18 中止会话：状态机 uploading→aborted + 回收暂存分片 */
  async abort(projectId: string, uploadId: string, ctx: CommandContext): Promise<unknown> {
    const r = await executeCommand(
      'material.upload.abort',
      { uploadId },
      { ...ctx, projectId },
    );
    await this.storage.removePrefix(`uploads/${uploadId}/`).catch(() => undefined);
    return r;
  }

  async getSession(uploadId: string): Promise<MatUpload> {
    const r = await query<MatUpload>('SELECT * FROM mat_uploads WHERE upload_id=$1', [uploadId]);
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '上传会话不存在', uploadId);
    return row;
  }

  /** 锁会话行（FOR UPDATE 串行化）并校验可写状态；不存在/终态/过期 → 相应拒绝码 */
  private async lockSession(client: PoolClient, uploadId: string): Promise<MatUpload> {
    const r = await client.query<MatUpload>(
      'SELECT * FROM mat_uploads WHERE upload_id=$1 FOR UPDATE',
      [uploadId],
    );
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '上传会话不存在', uploadId);
    this.assertSessionActive(row);
    return row;
  }

  private assertSessionActive(row: MatUpload): void {
    if (row.status !== 'uploading') {
      throw new DomainError('INVALID_STATE', `上传会话已${row.status}`, row.upload_id);
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      throw new DomainError('INVALID_STATE', '上传会话已过期', row.upload_id);
    }
  }

  /** 锁项目行（存在性校验 + F-code 序号串行化） */
  private async lockProject(client: PoolClient, projectId: string): Promise<void> {
    const r = await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '项目不存在', projectId);
  }

  /** 下一业务编号 F-0001（BR-05 永不复用；项目行锁串行化由 lockProject 保证） */
  private async nextFileCode(client: PoolClient, projectId: string): Promise<string> {
    await this.lockProject(client, projectId);
    const r = await client.query<{ code: string }>(
      "SELECT code FROM mat_files WHERE project_id=$1 AND code ~ '^F-[0-9]+$' ORDER BY length(code) DESC, code DESC LIMIT 1",
      [projectId],
    );
    const next = r.rows[0] ? Number(r.rows[0].code.slice(2)) + 1 : 1;
    return `F-${String(next).padStart(4, '0')}`;
  }

  private async assertFolder(projectId: string, folderId: string): Promise<void> {
    const r = await query(
      "SELECT id FROM mat_folder_tree WHERE id=$1 AND project_id=$2 AND tree='original'",
      [folderId, projectId],
    );
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '目标目录不存在', folderId);
  }
}

function extOf(fileName: string): string {
  return normalizeUploadExt(fileName);
}
