import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { renderExport, type ExportFormat } from '../platform/doc-export.js';
import { StorageService } from '../platform/storage.service.js';

export type { ExportFormat };

/**
 * 文档导出（A04-13；REQ-203）：md/html/docx/pdf 四格式（L1 扩展）。
 * 版本内容字节不可变 → 导出对象按 (versionId, format) 内容寻址复用；响应带签名下载 URL。
 */
@Injectable()
export class ReqExportService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  onModuleInit(): void {
    // 导出登记命令（审计留痕）；对象写入在命令外幂等（内容寻址覆盖同字节）
    registerCommand('req.doc.export', async (client, payload, ctx) => {
      const { versionId, format } = payload as { versionId: string; format: string };
      await client.query(
        'SELECT 1 FROM req_versions WHERE id=$1', [versionId],
      );
      return { versionId, format, by: ctx.actorId };
    });
  }

  async export(projectId: string, kind: string, v: number, format: ExportFormat, ctx: CommandContext) {
    const r = await query<{ id: string; content: string; content_fingerprint: string }>(
      `SELECT v.* FROM req_versions v JOIN req_documents d ON d.id=v.document_id
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
    await executeCommand('req.doc.export', { projectId, kind, v, versionId: ver.id, format }, { ...ctx, projectId });
    return {
      operationId: `op_exp_${ver.id.slice(0, 8)}`,
      format,
      downloadUrl: await this.storage.presignedGet(objectKey, 300, `${kind.toUpperCase()}-v${v}.${format}`),
    };
  }
}
