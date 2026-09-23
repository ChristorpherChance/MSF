import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError, type MatParseStatus } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { StorageService } from '../platform/storage.service.js';
import { AiParseEngine } from './parse-engine.js';
import type { MatFile, MatParsed, ParseEngine } from './types.js';

/**
 * 解析状态机（LLD-2 DSG-F02-3，REQ-107/108/109；LLD-5 DSG-A03-8/10/11/12/13/14）。
 * 全部状态迁移经命令事务；重试/解锁/删除留痕（mat_files.audit_trail 摘要 + audit_log 明细）。
 * 解析执行：AI 引擎实接（AiParseEngine：本地抽取 + 「解析」用途模型整理，未配路由时原文兜底）；
 * 202 + operationId 异步完成；SSE parse.* 进度事件随集成里程碑接线（任务板 T1-20 收口）。
 */

/** mock 引擎：md/txt 直通，doc/pdf/xlsx 产桩稿；内容含 PARSE_FAIL 标记即失败（测试注入点） */
export class MockParseEngine implements ParseEngine {
  async parse(file: MatFile, content: Buffer): Promise<string> {
    if (content.includes('PARSE_FAIL')) throw new Error('mock 解析失败（注入）');
    if (file.ext === 'md' || file.ext === 'txt') return content.toString('utf8');
    return `# ${file.name}\n\n> mock 解析稿（真实解析器随 M6 接入）`;
  }
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

@Injectable()
export class ParseService {
  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() @Inject(AiParseEngine) aiEngine?: AiParseEngine,
  ) {
    // 生产 wiring：AI 引擎优先（module 注册时）；测试 new ParseService(storage) 保持 mock
    if (aiEngine) this.engine = aiEngine;
  }

  /** 解析引擎（默认 mock；测试可替换为失败注入桩；生产经 module 注入 AiParseEngine） */
  engine: ParseEngine = new MockParseEngine();

  onModuleInit(): void {
    // A03-8/10 解析开始：pending|failed 且非 archive(zip)/unsupported → parsing
    registerCommand('material.file.parse_start', async (client, payload, ctx) => {
      const { projectId, fileId, operationId, retry } = payload as {
        projectId: string;
        fileId: string;
        operationId: string;
        retry: boolean;
      };
      const file = await this.lockFile(client, projectId, fileId);
      if (retry && file.parse_status !== 'failed') {
        throw new DomainError('INVALID_STATE', '仅 failed 状态可重试解析', fileId);
      }
      if (!retry && file.parse_status !== 'pending' && file.parse_status !== 'failed') {
        throw new DomainError('INVALID_STATE', `当前状态 ${file.parse_status} 不可解析`, fileId);
      }
      if (file.unsupported || file.ext === 'zip') {
        throw new DomainError('INVALID_STATE', '不支持类型/ZIP 原包不参与解析流转', fileId);
      }
      await this.appendTrail(client, file, {
        op: retry ? 'retry_parse' : 'parse',
        at: new Date().toISOString(),
        by: ctx.actorId,
        operationId,
      });
      await client.query(
        "UPDATE mat_files SET parse_status='parsing', parse_error=NULL WHERE id=$1",
        [fileId],
      );
      return { operationId, status: 'parsing' };
    });

    // 解析完成：parsing → parsed|failed（成功落 mat_parsed 文件解析稿，挂解析稿树镜像目录）
    registerCommand('material.file.parse_finish', async (client, payload, ctx) => {
      const { projectId, fileId, operationId, ok, bodyMd, error } = payload as {
        projectId: string;
        fileId: string;
        operationId: string;
        ok: boolean;
        bodyMd?: string;
        error?: string;
      };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.parse_status !== 'parsing') {
        throw new DomainError('INVALID_STATE', '文件不在解析中（epoch 失配，本次写入作废）', fileId);
      }
      if (ok && bodyMd !== undefined) {
        let parsedFolderId: string | null = null;
        if (file.folder_id) {
          const m = await client.query<{ mirror_id: string | null }>(
            'SELECT mirror_id FROM mat_folder_tree WHERE id=$1',
            [file.folder_id],
          );
          parsedFolderId = m.rows[0]?.mirror_id ?? null;
        }
        // 同一文件仅一份活跃 file_parse 稿：旧稿置 discarded 再插新稿（重试覆盖语义）
        await client.query(
          "UPDATE mat_parsed SET status='discarded', updated_at=now(), updated_by=$2 WHERE file_id=$1 AND kind='file_parse' AND status != 'discarded'",
          [fileId, ctx.actorId],
        );
        await client.query(
          `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, folder_id, created_by)
           VALUES ($1,$2,$3,'file_parse',$4,$5,$6,$7)`,
          [randomUUID(), projectId, fileId, bodyMd, sha256(bodyMd), parsedFolderId, ctx.actorId],
        );
        await client.query("UPDATE mat_files SET parse_status='parsed' WHERE id=$1", [fileId]);
      } else {
        await client.query("UPDATE mat_files SET parse_status='failed', parse_error=$2 WHERE id=$1", [
          fileId,
          error ?? '解析失败',
        ]);
      }
      await this.appendTrail(client, file, {
        op: 'parse_finish',
        at: new Date().toISOString(),
        by: ctx.actorId,
        operationId,
        result: ok ? 'ok' : 'failed',
      });
      return { fileId, status: ok ? 'parsed' : 'failed' };
    });

    // A03-11 文件定稿：parsed → file_final（人工；定稿后不参与待解析过滤，REQ-108）
    registerCommand('material.file.finalize_file', async (client, payload, ctx) => {
      const { projectId, fileId } = payload as { projectId: string; fileId: string };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.parse_status !== 'parsed') {
        throw new DomainError('INVALID_STATE', '仅 parsed 状态可文件定稿', fileId);
      }
      await client.query(
        "UPDATE mat_files SET parse_status='file_final', finalized_by=$2, finalized_at=now() WHERE id=$1",
        [fileId, ctx.actorId],
      );
      await this.appendTrail(client, file, { op: 'finalize_file', at: new Date().toISOString(), by: ctx.actorId });
      return { id: fileId, status: 'file_final' };
    });

    // A03-11 解锁文件定稿：file_final → parsed（引用门禁立即重判，F02-3 解锁行）
    registerCommand('material.file.unfinalize_file', async (client, payload, ctx) => {
      const { projectId, fileId } = payload as { projectId: string; fileId: string };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.parse_status !== 'file_final') {
        throw new DomainError('INVALID_STATE', '仅 file_final 状态可解锁', fileId);
      }
      await client.query(
        "UPDATE mat_files SET parse_status='parsed', finalized_by=NULL, finalized_at=NULL WHERE id=$1",
        [fileId],
      );
      await this.appendTrail(client, file, { op: 'unfinalize_file', at: new Date().toISOString(), by: ctx.actorId });
      return { id: fileId, status: 'parsed' };
    });

    // A03-12 内容定稿：file_final → content_final（成为合法参考输入，REQ-114）
    // 实机走查修复：contentMd 提供时同事务先保存内容稿（一键定稿）；
    // 无内容稿时自动以最新文件解析稿落 draft（原文定稿语义），「内容稿未保存」不再阻断
    registerCommand('material.file.finalize_content', async (client, payload, ctx) => {
      const { projectId, fileId, contentMd } = payload as {
        projectId: string; fileId: string; contentMd?: string;
      };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.parse_status !== 'file_final') {
        throw new DomainError('INVALID_STATE', '仅 file_final 状态可内容定稿', fileId);
      }
      if (contentMd !== undefined) {
        await this.upsertContentDraft(client, projectId, file, contentMd, ctx.actorId);
      } else {
        await this.ensureContentDraft(client, projectId, file, ctx.actorId);
      }
      await client.query("UPDATE mat_files SET parse_status='content_final' WHERE id=$1", [fileId]);
      await client.query(
        "UPDATE mat_parsed SET status='final', updated_at=now(), updated_by=$2 WHERE file_id=$1 AND kind='content_parse' AND status='draft'",
        [fileId, ctx.actorId],
      );
      await this.appendTrail(client, file, { op: 'finalize_content', at: new Date().toISOString(), by: ctx.actorId });
      return { id: fileId, status: 'content_final' };
    });

    // A03-13 内容稿编辑保存（三态保存端点；baseFingerprint 乐观锁兜底，REQ-113/BR-12）
    registerCommand('material.parsed.save_draft', async (client, payload, ctx) => {
      const { projectId, fileId, contentMd, baseFingerprint } = payload as {
        projectId: string;
        fileId: string;
        contentMd: string;
        baseFingerprint: string | null;
      };
      const file = await this.lockFile(client, projectId, fileId);
      if (file.parse_status === 'pending' || file.parse_status === 'parsing' || file.parse_status === 'failed') {
        throw new DomainError('INVALID_STATE', `当前状态 ${file.parse_status} 不可编辑内容稿`, fileId);
      }
      const cur = await client.query<MatParsed>(
        "SELECT * FROM mat_parsed WHERE file_id=$1 AND kind='content_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
        [fileId],
      );
      const row = cur.rows[0];
      if (row) {
        if (baseFingerprint !== `sha256:${row.content_fingerprint}`) {
          throw new DomainError('VERSION_CONFLICT', '内容稿已被他人修改，请刷新后重试', fileId);
        }
      } else {
        // 首存：base 须为当前文件解析稿指纹（无解析稿则须空 base）
        const base = await client.query<MatParsed>(
          "SELECT content_fingerprint FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
          [fileId],
        );
        const expected = base.rows[0] ? `sha256:${base.rows[0].content_fingerprint}` : null;
        if (baseFingerprint !== expected) {
          throw new DomainError('VERSION_CONFLICT', '基线指纹不一致，请刷新后重试', fileId);
        }
      }
      const fingerprint = await this.upsertContentDraft(client, projectId, file, contentMd, ctx.actorId);
      return { contentFingerprint: `sha256:${fingerprint}` };
    });

    // A03-14 解析行删除（守卫：parsed 态且无加工/附件/引用依赖；理由必填；原件不动，REQ-109/D19）
    registerCommand('material.parsed.delete_row', async (client, payload, ctx) => {
      const { projectId, rowId, reason } = payload as { projectId: string; rowId: string; reason: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '删除理由必填', 'reason');
      const r = await client.query<MatParsed & { parse_status: MatParseStatus }>(
        `SELECT p.*, f.parse_status FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
         WHERE p.id=$1 AND p.project_id=$2 FOR UPDATE OF p`,
        [rowId, projectId],
      );
      const row = r.rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '解析行不存在', rowId);
      const issues: Array<{ code: 'DEPENDENCY_EXISTS'; message: string; target: string }> = [];
      if (row.parse_status !== 'parsed') {
        issues.push({ code: 'DEPENDENCY_EXISTS', message: '文件非 parsed 态（已定稿/流转中）', target: row.file_id });
      }
      if (Array.isArray(row.ops) && row.ops.length > 0) {
        issues.push({ code: 'DEPENDENCY_EXISTS', message: '存在内容加工操作依赖', target: row.file_id });
      }
      if (Array.isArray(row.attachments) && row.attachments.length > 0) {
        issues.push({ code: 'DEPENDENCY_EXISTS', message: '存在加工附件依赖', target: row.file_id });
      }
      if (Array.isArray(row.referenced_by) && row.referenced_by.length > 0) {
        issues.push({ code: 'DEPENDENCY_EXISTS', message: '存在需求引用依赖', target: row.file_id });
      }
      if (issues.length > 0) {
        throw new DomainError('GATE_BLOCKED', '删除守卫：存在下游依赖', rowId, { issues });
      }
      await client.query(
        "UPDATE mat_parsed SET status='discarded', delete_guard=$2, updated_by=$3, updated_at=now() WHERE id=$1",
        [rowId, JSON.stringify({ reason, deletedBy: ctx.actorId, at: new Date().toISOString() }), ctx.actorId],
      );
      await client.query("UPDATE mat_files SET parse_status='pending' WHERE id=$1", [row.file_id]);
      const file = await this.lockFile(client, projectId, row.file_id);
      await this.appendTrail(client, file, {
        op: 'delete_parsed',
        at: new Date().toISOString(),
        by: ctx.actorId,
        reason,
      });
      return { deleted: true };
    });

    // 文件双向同步删除（LLD-6 §3.2 delFile L2263：原文件+解析稿+ZIP 子件一并移除；
    // 引用守卫：解析稿被需求/会话引用 → GATE_BLOCKED 明示；理由必填；解析稿业务态 discarded、原件行删除）
    registerCommand('material.file.delete', async (client, payload, ctx) => {
      const { projectId, fileId, reason } = payload as { projectId: string; fileId: string; reason: string };
      if (!reason?.trim()) throw new DomainError('VALIDATION_FAILED', '删除理由必填', 'reason');
      await this.lockFile(client, projectId, fileId); // 行锁 + 存在性校验（NOT_FOUND）
      // ZIP 子件随行
      const children = await client.query<{ id: string }>(
        'SELECT id FROM mat_files WHERE zip_parent_id=$1', [fileId]);
      const ids = [fileId, ...children.rows.map((c) => c.id)];
      // 引用守卫：解析稿 referenced_by 或 ai_sessions.refs 命中（跨域 SQL 直读，不 import）
      const parsed = await client.query<{ id: string; referenced_by: unknown }>(
        'SELECT id, referenced_by FROM mat_parsed WHERE file_id = ANY($1::uuid[])', [ids]);
      const issues: Array<{ code: 'DEPENDENCY_EXISTS'; message: string; target: string }> = [];
      for (const p of parsed.rows) {
        if (Array.isArray(p.referenced_by) && p.referenced_by.length > 0) {
          issues.push({ code: 'DEPENDENCY_EXISTS', message: '解析稿存在需求引用依赖', target: p.id });
        }
      }
      const parsedIds = parsed.rows.map((p) => p.id);
      if (parsedIds.length > 0) {
        const refs = await client.query<{ id: string }>(
          `SELECT id FROM ai_sessions WHERE project_id=$1
             AND EXISTS (SELECT 1 FROM jsonb_array_elements(refs) e WHERE e->>'parsed_id' = ANY($2::text[]))`,
          [projectId, parsedIds]);
        for (const r of refs.rows) {
          issues.push({ code: 'DEPENDENCY_EXISTS', message: 'AI 会话引用依赖', target: r.id });
        }
      }
      if (issues.length > 0) {
        throw new DomainError('GATE_BLOCKED', '删除守卫：存在下游引用，请先解除引用', fileId, { issues });
      }
      // 批量加工作业留痕（mat_batch_items 行保留不物理删）：file_id 解挂留史，不再拦截删除（实机走查修复）
      await client.query('UPDATE mat_batch_items SET file_id=NULL WHERE file_id = ANY($1::uuid[])', [ids]);
      const now = new Date().toISOString();
      await client.query(
        "UPDATE mat_parsed SET status='discarded', delete_guard=$2, updated_by=$3, updated_at=now() WHERE file_id = ANY($1::uuid[])",
        [ids, JSON.stringify({ reason, deletedBy: ctx.actorId, at: now, withFile: true }), ctx.actorId],
      );
      // 上传会话留痕（行保留不物理删）：file_id 解挂
      await client.query('UPDATE mat_uploads SET file_id=NULL WHERE file_id = ANY($1::uuid[])', [ids]);
      await client.query('DELETE FROM mat_files WHERE zip_parent_id=$1', [fileId]);
      await client.query('DELETE FROM mat_files WHERE id=$1', [fileId]);
      return { deleted: fileId, children: children.rows.length, parsedDiscarded: parsed.rows.length };
    });
  }

  /** A03-8 单个解析：202 + operationId；mock 引擎异步完成（SSE parse.* 随集成里程碑接线） */
  async parse(
    projectId: string,
    fileId: string,
    ctx: CommandContext,
    retry = false,
    opts: { autoRun?: boolean } = {},
  ) {
    const operationId = `op_parse_${randomBytes(6).toString('hex')}`;
    const started = await executeCommand(
      'material.file.parse_start',
      { projectId, fileId, operationId, retry },
      { ...ctx, projectId },
    );
    // autoRun=false 供测试确定性驱动（手动 runParse）；生产默认 fire-and-forget
    if (opts.autoRun !== false) this.runParse(projectId, fileId, operationId, ctx).catch(() => undefined);
    return started;
  }

  /** 解析执行（异步）：引擎产出 → parse_finish 命令；测试可 await 本方法拿到终态 */
  async runParse(projectId: string, fileId: string, operationId: string, ctx: CommandContext): Promise<void> {
    const r = await query<MatFile>('SELECT * FROM mat_files WHERE id=$1', [fileId]);
    const file = r.rows[0];
    if (!file) return;
    let ok = true;
    let bodyMd: string | undefined;
    let error: string | undefined;
    try {
      const content = await this.storage.getObject(file.object_key);
      bodyMd = await this.engine.parse(file, content);
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    await executeCommand(
      'material.file.parse_finish',
      { projectId, fileId, operationId, ok, bodyMd, error },
      { ...ctx, projectId, actorKind: 'system', actorId: 'parse-engine' },
    );
  }

  async finalizeFile(projectId: string, fileId: string, ctx: CommandContext): Promise<unknown> {
    return executeCommand('material.file.finalize_file', { projectId, fileId }, { ...ctx, projectId });
  }

  async unfinalizeFile(projectId: string, fileId: string, ctx: CommandContext): Promise<unknown> {
    return executeCommand('material.file.unfinalize_file', { projectId, fileId }, { ...ctx, projectId });
  }

  async finalizeContent(projectId: string, fileId: string, ctx: CommandContext, contentMd?: string): Promise<unknown> {
    return executeCommand(
      'material.file.finalize_content',
      contentMd !== undefined ? { projectId, fileId, contentMd } : { projectId, fileId },
      { ...ctx, projectId },
    );
  }

  async saveDraft(
    projectId: string,
    fileId: string,
    contentMd: string,
    baseFingerprint: string | null,
    ctx: CommandContext,
  ): Promise<unknown> {
    return executeCommand(
      'material.parsed.save_draft',
      { projectId, fileId, contentMd, baseFingerprint },
      { ...ctx, projectId },
    );
  }

  async deleteRow(projectId: string, rowId: string, reason: string, ctx: CommandContext): Promise<unknown> {
    return executeCommand('material.parsed.delete_row', { projectId, rowId, reason }, { ...ctx, projectId });
  }

  /** 文件双向同步删除（LLD-6 §3.2 delFile；引用守卫 GATE_BLOCKED） */
  async deleteFile(projectId: string, fileId: string, reason: string, ctx: CommandContext): Promise<unknown> {
    return executeCommand('material.file.delete', { projectId, fileId, reason }, { ...ctx, projectId });
  }

  /** 内容稿 upsert（save_draft 与 finalize_content 共用；final 稿不可改写） */
  private async upsertContentDraft(
    client: PoolClient, projectId: string, file: MatFile, contentMd: string, actorId: string,
  ): Promise<string> {
    const cur = await client.query<MatParsed>(
      "SELECT * FROM mat_parsed WHERE file_id=$1 AND kind='content_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
      [file.id],
    );
    const row = cur.rows[0];
    const fingerprint = sha256(contentMd);
    if (row) {
      if (row.status === 'final') {
        throw new DomainError('INVALID_STATE', '内容已定稿，不可再改写内容稿', file.id);
      }
      await client.query(
        'UPDATE mat_parsed SET body_md=$2, content_fingerprint=$3, updated_by=$4, updated_at=now() WHERE id=$1',
        [row.id, contentMd, fingerprint, actorId],
      );
    } else {
      const folderId = await this.parsedMirrorFolder(client, file);
      await client.query(
        `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, folder_id, created_by)
         VALUES ($1,$2,$3,'content_parse',$4,$5,$6,$7)`,
        [randomUUID(), projectId, file.id, contentMd, fingerprint, folderId, actorId],
      );
    }
    return fingerprint;
  }

  /** 无内容稿时以最新文件解析稿落 draft（原文定稿语义；无解析稿则不可定稿） */
  private async ensureContentDraft(
    client: PoolClient, projectId: string, file: MatFile, actorId: string,
  ): Promise<void> {
    const cur = await client.query(
      "SELECT 1 FROM mat_parsed WHERE file_id=$1 AND kind='content_parse' AND status != 'discarded' LIMIT 1",
      [file.id],
    );
    if (cur.rows[0]) return;
    const src = await client.query<MatParsed>(
      "SELECT * FROM mat_parsed WHERE file_id=$1 AND kind='file_parse' AND status != 'discarded' ORDER BY created_at DESC LIMIT 1",
      [file.id],
    );
    const base = src.rows[0];
    if (!base) throw new DomainError('INVALID_STATE', '无解析稿，无法生成内容稿', file.id);
    const folderId = await this.parsedMirrorFolder(client, file);
    await client.query(
      `INSERT INTO mat_parsed (id, project_id, file_id, kind, body_md, content_fingerprint, folder_id, created_by)
       VALUES ($1,$2,$3,'content_parse',$4,$5,$6,$7)`,
      [randomUUID(), projectId, file.id, base.body_md, base.content_fingerprint, folderId, actorId],
    );
  }

  /** 原件目录 → 解析稿树镜像目录 id */
  private async parsedMirrorFolder(client: PoolClient, file: MatFile): Promise<string | null> {
    if (!file.folder_id) return null;
    const m = await client.query<{ mirror_id: string | null }>(
      'SELECT mirror_id FROM mat_folder_tree WHERE id=$1',
      [file.folder_id],
    );
    return m.rows[0]?.mirror_id ?? null;
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

  /** 状态流转留痕摘要（REQ-107 全量留痕；明细在 audit_log 同事务） */
  private async appendTrail(client: PoolClient, file: MatFile, entry: Record<string, unknown>): Promise<void> {
    const trail = Array.isArray(file.audit_trail) ? file.audit_trail : [];
    trail.push(entry);
    await client.query('UPDATE mat_files SET audit_trail=$2 WHERE id=$1', [file.id, JSON.stringify(trail)]);
  }
}
