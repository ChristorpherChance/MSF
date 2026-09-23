import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { NotificationsService } from './notifications.service.js';
import { StorageService } from './storage.service.js';

/**
 * 备份导出（A10-4；REQ-708/804；D11-3/4）：
 * - scope=project：项目拥有的各域行（project_id 维度）逻辑导出为 per-table JSON；
 *   includeEvidence 追加 audit_log/evd_records/evd_events 项目行
 * - 包=单 JSON（tables + manifest），manifest 含每表行数与 sha256（BR-01 内容指纹身份）
 * - 落 MinIO `backups/<projectId>/<ts>.json`，完成通知含签名下载 URL（1h）
 * - 恢复演练（N03）由 scripts/m7-backup-restore-drill.mjs 承载
 * 密钥类列（ai_models.api_key_enc 等）一律不导出。
 */

/** 导出表白名单：project_id 维度的业务表（密钥列在列级剔除） */
const TABLES: Array<{ table: string; omitCols?: string[] }> = [
  { table: 'mat_folder_tree' }, { table: 'mat_files' }, { table: 'mat_parsed' }, { table: 'mat_uploads' },
  { table: 'mat_batch_jobs' },
  { table: 'req_documents' },
  { table: 'rtm_links' }, { table: 'rtm_health' },
  { table: 'dsg_documents' },
  { table: 'dsg_baselines' }, { table: 'dsg_plans' }, { table: 'dsg_catalog_items' },
  { table: 'dsg_prototype_checks' }, { table: 'dsg_reviews' },
  { table: 'dev_plans' }, { table: 'dev_tasks' }, { table: 'dev_operations' }, { table: 'dev_builds' },
  { table: 'dev_selftests' }, { table: 'dev_transfer' }, { table: 'dev_ci_reports' },
  { table: 'dev_authorizations' }, { table: 'dev_runs' }, { table: 'dev_impacts' },
  { table: 'dev_prs' }, { table: 'dev_reports' },
  { table: 'tst_batches' }, { table: 'tst_runs' }, { table: 'tst_defects' },
  { table: 'ai_sessions' }, { table: 'ai_usage' }, { table: 'ai_delegations' },
  // ai_models / ai_prompt_versions 为系统级登记（无 project_id），不随项目备份导出；
  // 密钥列 api_key_enc 本就只写不读（N02-3）
  { table: 'policy_gates' }, { table: 'policy_gate_events' }, { table: 'sys_notifications' },
];
/**
 * 无 project_id 的子表：经父链归属导出。
 * join=FROM 子句（别名 c 为子表本体），ref=携带 project_id 的别名。
 */
const CHILD_TABLES: Array<{ table: string; join: string; ref?: string }> = [
  { table: 'mat_batch_items', join: 'mat_batch_jobs p ON p.id = c.job_id' },
  { table: 'req_doc_refs', join: 'req_documents p ON p.id = c.document_id' },
  { table: 'req_drafts', join: 'req_documents p ON p.id = c.document_id' },
  { table: 'req_versions', join: 'req_documents p ON p.id = c.document_id' },
  { table: 'req_pendings', join: 'req_documents p ON p.id = c.document_id' },
  { table: 'dsg_drafts', join: 'dsg_documents p ON p.id = c.document_id' },
  { table: 'dsg_versions', join: 'dsg_documents p ON p.id = c.document_id' },
  { table: 'dsg_pendings', join: 'dsg_documents p ON p.id = c.document_id' },
  { table: 'dsg_catalog_refs', join: 'dsg_catalog_items p ON p.id = c.item_id' },
  { table: 'dev_selftest_pages', join: 'dev_selftests p ON p.id = c.selftest_id' },
  { table: 'tst_plans', join: 'tst_batches p ON p.id = c.batch_id' },
  { table: 'tst_cases', join: 'tst_plans p ON p.id = c.plan_id JOIN tst_batches b ON b.id = p.batch_id', ref: 'b' },
  { table: 'tst_case_runs', join: 'tst_runs p ON p.id = c.run_id' },
  { table: 'tst_reports', join: 'tst_batches p ON p.id = c.batch_id' },
  { table: 'tst_decisions', join: 'tst_batches p ON p.id = c.batch_id' },
  { table: 'ai_messages', join: 'ai_sessions p ON p.id = c.session_id' },
  { table: 'ai_tool_calls', join: 'ai_sessions p ON p.id = c.session_id' },
];
const EVIDENCE_TABLES = ['audit_log', 'evd_records', 'evd_events'];

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

@Injectable()
export class BackupsService {
  constructor(
    private readonly storage: StorageService,
    private readonly notices: NotificationsService,
  ) {}

  onModuleInit(): void {
    // 登记备份操作（审计留痕；产物写 MinIO 在事务外，完成后通知）
    registerCommand('system.backup.export', async (client, payload, ctx) => {
      const p = payload as { operationId: string; scope: string; includeEvidence: boolean };
      await client.query(
        `INSERT INTO evd_events (project_id, kind, payload, actor_kind, actor_id)
         VALUES ($1,'backup.exported',$2,$3,$4)`,
        [ctx.projectId, JSON.stringify({ operationId: p.operationId, scope: p.scope, includeEvidence: p.includeEvidence }), ctx.actorKind, ctx.actorId]);
      return { operationId: p.operationId };
    });
  }

  /** A10-4：202 + operationId；同步执行（单进程自托管，导出量小），完成后通知含签名 URL */
  async export(
    projectId: string,
    input: { scope?: string; includeEvidence?: boolean },
    ctx: CommandContext,
  ): Promise<{ operationId: string }> {
    const pj = await query('SELECT id FROM projects WHERE id=$1', [projectId]);
    if (!pj.rows[0]) throw new DomainError('NOT_FOUND', '项目不存在', projectId);
    if (input.scope !== undefined && input.scope !== 'project') {
      throw new DomainError('VALIDATION_FAILED', 'scope 本期仅支持 project', 'scope');
    }
    const operationId = `op_bak_${randomBytes(6).toString('hex')}`;
    await executeCommand('system.backup.export', {
      operationId, scope: 'project', includeEvidence: input.includeEvidence ?? true,
    }, { ...ctx, projectId });
    // 事务提交后执行导出（产物在 MinIO，非库内状态；失败补失败通知）
    void this.run(operationId, projectId, input.includeEvidence ?? true, ctx).catch(async (e) => {
      await this.notices.emit({ ...ctx, projectId }, {
        type: 'backup.failed', text: `备份导出失败：${e instanceof Error ? e.message : String(e)}`,
      }).catch(() => undefined);
    });
    return { operationId };
  }

  private async run(operationId: string, projectId: string, includeEvidence: boolean, ctx: CommandContext): Promise<void> {
    const tables: Record<string, unknown[]> = {};
    const manifest: Array<{ table: string; rows: number; sha256: string }> = [];
    const dump = async (table: string, omitCols: string[] = []) => {
      const r = await query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY 1`, [projectId]);
      const rows = r.rows.map((row) => {
        const o = { ...row } as Record<string, unknown>;
        for (const c of omitCols) delete o[c];
        return o;
      });
      tables[table] = rows;
      manifest.push({ table, rows: rows.length, sha256: sha256(JSON.stringify(rows)) });
    };
    /** 子表经父链归属导出（无 project_id 列；白名单内常量拼接，非外部输入） */
    const dumpChild = async (c: { table: string; join: string; ref?: string }) => {
      const r = await query(
        `SELECT c.* FROM ${c.table} c JOIN ${c.join} WHERE ${c.ref ?? 'p'}.project_id=$1 ORDER BY 1`,
        [projectId]);
      tables[c.table] = r.rows;
      manifest.push({ table: c.table, rows: r.rows.length, sha256: sha256(JSON.stringify(r.rows)) });
    };
    for (const t of TABLES) await dump(t.table, t.omitCols);
    for (const c of CHILD_TABLES) await dumpChild(c);
    if (includeEvidence) for (const t of EVIDENCE_TABLES) await dump(t);

    // MinIO 工件清单（内容寻址对象的对象键即 sha256，BR-01）
    const artifacts: Array<{ objectKey: string; sizeBytes: number }> = [];
    const objs = await query<{ object_key: string; size_bytes: string }>(
      'SELECT DISTINCT object_key, size_bytes FROM mat_files WHERE project_id=$1', [projectId]);
    artifacts.push(...objs.rows.map((o) => ({ objectKey: o.object_key, sizeBytes: Number(o.size_bytes) })));

    const bundle = {
      format: 'msf-backup/v1', operationId, projectId, exportedAt: new Date().toISOString(),
      manifest, artifacts, tables,
    };
    const body = Buffer.from(JSON.stringify(bundle));
    const key = `backups/${projectId}/${operationId}.json`;
    await this.storage.putObject(key, body);
    const url = await this.storage.presignedGet(key, 3600);
    await this.notices.emit({ ...ctx, projectId }, {
      type: 'backup.completed', eventKind: 'backup.completed',
      text: `备份导出完成：${manifest.length} 表 ${manifest.reduce((a, m) => a + m.rows, 0)} 行，下载：${url}`,
    });
  }
}
