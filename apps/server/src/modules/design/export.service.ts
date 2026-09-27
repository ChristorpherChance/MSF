import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { renderExport, type ExportFormat } from '../platform/doc-export.js';
import { StorageService } from '../platform/storage.service.js';

/**
 * 设计册导出（L1 立项：对齐原型 dlPopover 三格式 + 审计留痕；此前仅前端 Blob md 无留痕）。
 * 与 req.doc.export 同构：版本内容不可变 → (versionId, format) 内容寻址复用。
 */
@Injectable()
export class DesignExportService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  onModuleInit(): void {
    registerCommand('design.doc.export', async (client, payload, ctx) => {
      const { versionId, format } = payload as { versionId: string; format: string };
      await client.query('SELECT 1 FROM dsg_versions WHERE id=$1', [versionId]);
      return { versionId, format, by: ctx.actorId };
    });
  }

  async export(projectId: string, kind: string, v: number, format: ExportFormat, ctx: CommandContext) {
    const r = await query<{ id: string; content: string; doc_title: string }>(
      `SELECT v.*, d.name AS doc_title FROM dsg_versions v JOIN dsg_documents d ON d.id=v.document_id
       WHERE d.project_id=$1 AND d.doc_kind=$2 AND v.version_no=$3`,
      [projectId, kind, v],
    );
    const ver = r.rows[0];
    if (!ver) throw new DomainError('NOT_FOUND', '版本不存在', `${kind} v${v}`);
    if (!['md', 'html', 'docx', 'pdf'].includes(format)) {
      throw new DomainError('VALIDATION_FAILED', '导出格式支持 md/html/docx/pdf', 'format');
    }
    const body = await renderExport(ver.content, format, `${kind.toUpperCase()} v${v}`);
    const objectKey = `exports/${projectId}/${ver.id}.${format}`;
    await this.storage.putObject(objectKey, body);
    await executeCommand('design.doc.export', { projectId, kind, v, versionId: ver.id, format }, { ...ctx, projectId });
    return {
      operationId: `op_exp_${ver.id.slice(0, 8)}`,
      format,
      downloadUrl: await this.storage.presignedGet(objectKey, 300, `${ver.doc_title || kind.toUpperCase()}-v${v}.${format}`),
    };
  }
}
