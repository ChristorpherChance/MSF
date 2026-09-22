import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError, UPLOAD_FORMATS } from '@msf/shared';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { StorageService } from '../platform/storage.service.js';
import type { MatFile } from './types.js';
import { inflateEntry, validateZipPackage } from './zip-check.js';

/**
 * ZIP 行内解压（LLD-5 DSG-A03-4，REQ-104；LLD-2 F09 后续动作）。
 * 原包保留不删；解压为同名文件夹（双树各建节点、mirror 互指）；
 * 目标同名冲突默认拒绝、可选 rename 自动追加序号；嵌套压缩包不递归解压。
 * 项目内同内容去重（(project_id, object_key) 复合唯一）：命中既有行计 skipped 不重复建行。
 */

export interface ExtractResult {
  folderId: string;
  extracted: number;
  skipped: number;
  renamedTo: string | null;
  operationId: string;
}

@Injectable()
export class ZipExtractService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  onModuleInit(): void {
    registerCommand('material.zip.extract', async (client, payload, ctx) => {
      const { projectId, fileId, onConflict, operationId } = payload as {
        projectId: string;
        fileId: string;
        onConflict: 'reject' | 'rename';
        operationId: string;
      };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.ext !== 'zip') {
        throw new DomainError('INVALID_STATE', '非 ZIP 文件不可行内解压', fileId);
      }
      const prior = await client.query(
        'SELECT 1 FROM mat_files WHERE project_id=$1 AND zip_parent_id=$2 LIMIT 1',
        [projectId, fileId],
      );
      if (prior.rows[0]) {
        throw new DomainError('INVALID_STATE', '该 ZIP 已解压', fileId);
      }
      // 整包复验（complete 已验并存 zip_check；此处以字节现状为准再跑一次十五步）
      const zipBuf = await this.storage.getObject(file.object_key);
      const check = validateZipPackage(zipBuf);
      if (!check.ok) {
        throw new DomainError('UPLOAD_REJECTED', 'ZIP 整包校验未通过', file.name, {
          violations: check.violations,
        });
      }

      // 目标文件夹：与 ZIP 同名（去扩展名），同级冲突默认拒绝、可选重命名追加序号
      const baseName = file.name.replace(/\.zip$/i, '');
      const sibling = await client.query<{ name: string }>(
        `SELECT name FROM mat_folder_tree
         WHERE project_id=$1 AND tree='original' AND parent_id IS NOT DISTINCT FROM $2`,
        [projectId, file.folder_id],
      );
      const taken = new Set(sibling.rows.map((r) => r.name));
      let folderName = baseName;
      let renamedTo: string | null = null;
      if (taken.has(folderName)) {
        if (onConflict !== 'rename') {
          throw new DomainError('INVALID_STATE', `目标文件夹「${baseName}」已存在（可选重命名解压）`, baseName);
        }
        let n = 2;
        while (taken.has(`${baseName} (${n})`)) n++;
        folderName = `${baseName} (${n})`;
        renamedTo = folderName;
      }
      const rootFolderId = await this.createFolderPair(client, projectId, file.folder_id, folderName, ctx);

      // 逐条展开：目录建双树节点，文件内容寻址落 MinIO + mat_files 建行（source=zip_extract）
      // 隐式目录（无目录条目、仅文件路径前缀）同样逐段补建
      const folderByPath = new Map<string, string>([['', rootFolderId]]);
      const ensureFolder = async (path: string): Promise<string> => {
        const hit = folderByPath.get(path);
        if (hit) return hit;
        const segs = path.split('/');
        const parentPath = segs.slice(0, -1).join('/');
        const parentId = await ensureFolder(parentPath);
        const id = await this.createFolderPair(client, projectId, parentId, segs[segs.length - 1] ?? path, ctx);
        folderByPath.set(path, id);
        return id;
      };
      let extracted = 0;
      let skipped = 0;
      for (const entry of check.entries) {
        const segs = entry.path.split('/');
        const parentPath = segs.slice(0, -1).join('/');
        if (entry.isDirectory) {
          await ensureFolder(entry.path);
          continue;
        }
        const content = inflateEntry(zipBuf, entry);
        const { objectKey } = await this.storage.putContentAddressed(content);
        const dup = await client.query(
          'SELECT 1 FROM mat_files WHERE project_id=$1 AND object_key=$2 LIMIT 1',
          [projectId, objectKey],
        );
        if (dup.rows[0]) {
          skipped++; // 项目内同内容去重（DSG-D03-2 object_key 说明）
          continue;
        }
        const name = segs[segs.length - 1] ?? entry.path;
        const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
        const code = await this.nextFileCode(client, projectId);
        await client.query(
          `INSERT INTO mat_files
            (id, project_id, code, name, ext, size_bytes, object_key, content_fingerprint,
             source, zip_parent_id, folder_id, unsupported, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'zip_extract',$9,$10,$11,$12)`,
          [
            randomUUID(),
            projectId,
            code,
            name,
            ext,
            content.length,
            objectKey,
            objectKey.slice('sha256/'.length),
            fileId,
            await ensureFolder(parentPath),
            !(UPLOAD_FORMATS as readonly string[]).includes(ext), // 不支持类型旁路标记（F09 后续动作）
            ctx.actorId,
          ],
        );
        extracted++;
      }
      return { folderId: rootFolderId, extracted, skipped, renamedTo, operationId } satisfies ExtractResult;
    });
  }

  async extract(
    projectId: string,
    fileId: string,
    onConflict: 'reject' | 'rename',
    ctx: CommandContext,
  ): Promise<ExtractResult> {
    return (await executeCommand(
      'material.zip.extract',
      { projectId, fileId, onConflict, operationId: `op_${randomBytes(8).toString('hex')}` },
      { ...ctx, projectId },
    )) as ExtractResult;
  }

  private async lockFile(client: PoolClient, projectId: string, fileId: string): Promise<MatFile> {
    const r = await client.query<MatFile>(
      'SELECT * FROM mat_files WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [fileId, projectId],
    );
    const row = r.rows[0];
    if (!row) throw new DomainError('NOT_FOUND', '文件不存在', fileId);
    return row;
  }

  /** 双树各建一个目录节点并 mirror 互指（REQ-105 一一对应由服务层维护） */
  private async createFolderPair(
    client: PoolClient,
    projectId: string,
    parentId: string | null,
    name: string,
    ctx: CommandContext,
    sortNo = 0,
  ): Promise<string> {
    // 原件树父节点的镜像即解析稿树父节点（根为 NULL 时亦为 NULL——项目根节点对由 T1-07 树服务保证）
    let parsedParentId: string | null = null;
    if (parentId) {
      const p = await client.query<{ mirror_id: string | null }>(
        'SELECT mirror_id FROM mat_folder_tree WHERE id=$1',
        [parentId],
      );
      parsedParentId = p.rows[0]?.mirror_id ?? null;
    }
    const originalId = randomUUID();
    const parsedId = randomUUID();
    // mirror 互指存在 FK 先后序：original 先置 NULL，parsed 落行后回填
    await client.query(
      `INSERT INTO mat_folder_tree (id, project_id, tree, parent_id, name, mirror_id, sort_no, created_by)
       VALUES ($1,$2,'original',$3,$4,NULL,$5,$6)`,
      [originalId, projectId, parentId, name, sortNo, ctx.actorId],
    );
    await client.query(
      `INSERT INTO mat_folder_tree (id, project_id, tree, parent_id, name, mirror_id, sort_no, created_by)
       VALUES ($1,$2,'parsed',$3,$4,$5,$6,$7)`,
      [parsedId, projectId, parsedParentId, name, originalId, sortNo, ctx.actorId],
    );
    await client.query('UPDATE mat_folder_tree SET mirror_id=$2 WHERE id=$1', [originalId, parsedId]);
    return originalId;
  }

  private async nextFileCode(client: PoolClient, projectId: string): Promise<string> {
    await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const r = await client.query<{ code: string }>(
      "SELECT code FROM mat_files WHERE project_id=$1 AND code ~ '^F-[0-9]+$' ORDER BY length(code) DESC, code DESC LIMIT 1",
      [projectId],
    );
    const next = r.rows[0] ? Number(r.rows[0].code.slice(2)) + 1 : 1;
    return `F-${String(next).padStart(4, '0')}`;
  }
}
