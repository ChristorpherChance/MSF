import { Inject, Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { StorageService } from '../platform/storage.service.js';

/**
 * 导出 html 用迷你渲染器（marked@18 纯 ESM 与 CJS 产物/vitest 均不兼容，M2 从简）：
 * 覆盖本域文档实际用到的语法（#/## 标题、- 列表、段落、**粗体**、`代码`）；先转义防注入。
 */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  let inList = false;
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (/^##\s+/.test(t)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${inline(t.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^#\s+/.test(t)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h1>${inline(t.replace(/^#\s+/, ''))}</h1>`);
    } else if (/^-\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(t.replace(/^-\s+/, ''))}</li>`);
    } else if (t === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

/**
 * 文档导出（A04-13；REQ-203）：md+html 本期，pdf 后续扩展。
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

  async export(projectId: string, kind: string, v: number, format: 'md' | 'html', ctx: CommandContext) {
    const r = await query<{ id: string; content: string; content_fingerprint: string }>(
      `SELECT v.* FROM req_versions v JOIN req_documents d ON d.id=v.document_id
       WHERE d.project_id=$1 AND d.doc_kind=$2 AND v.version_no=$3`,
      [projectId, kind, v],
    );
    const ver = r.rows[0];
    if (!ver) throw new DomainError('NOT_FOUND', '版本不存在', `${kind} v${v}`);
    if (format !== 'md' && format !== 'html') {
      throw new DomainError('VALIDATION_FAILED', '导出格式本期支持 md/html', 'format');
    }
    const body =
      format === 'md'
        ? ver.content
        : `<!doctype html><html><head><meta charset="utf-8"><title>${kind.toUpperCase()} v${v}</title></head><body>${mdToHtml(ver.content)}</body></html>`;
    const objectKey = `exports/${projectId}/${ver.id}.${format}`;
    await this.storage.putObject(objectKey, Buffer.from(body, 'utf8'));
    await executeCommand('req.doc.export', { projectId, kind, v, versionId: ver.id, format }, { ...ctx, projectId });
    return {
      operationId: `op_exp_${ver.id.slice(0, 8)}`,
      format,
      downloadUrl: await this.storage.presignedGet(objectKey),
    };
  }
}
