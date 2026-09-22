/**
 * 命令注册表（封闭枚举，LLD-7 N06-3 四件套之一：先注册后使用）。
 * 命令名小写点式，域前缀对齐 LLD-3 DSG-C10-2 分组。
 * M0 仅注册基座命令；各领域命令随里程碑追加（新增命令=注册+审计映射+效果定义+自动化测试）。
 */
export const COMMANDS = [
  'platform.project.create',
  'platform.project.update',
  'platform.project.archive',
  'policy.gate.set_mode',
  'health.ping', // M0 冒烟用，无副作用
  // M1 资料域：上传会话（LLD-5 DSG-A03-1/2/3/18）
  'material.upload.create',
  'material.upload.part',
  'material.upload.complete',
  'material.upload.abort',
  // M1 资料域：ZIP 行内解压（DSG-A03-4）
  'material.zip.extract',
  // M1 资料域：解析状态机与定稿（DSG-A03-8/10/11/12/13/14，F02-3）
  'material.file.parse_start',
  'material.file.parse_finish',
  'material.file.finalize_file',
  'material.file.unfinalize_file',
  'material.file.finalize_content',
  'material.parsed.save_draft',
  'material.parsed.delete_row',
  // M1 资料域：批量解析/加工/定稿作业（DSG-A03-9/12/15/16，F02-4）
  'material.file.batch_parse',
  'material.file.batch_finalize_content',
  'material.job.create',
  'material.job.confirm',
  'material.job.stop',
  'material.job.row_process',
  'material.job.row_update',
  'material.job.item_retry',
  // M2 需求域：文档生命周期（LLD-3 DSG-C10-2(b)，F02-1 状态机迁移一一对应）
  'doc.save-html',
  'doc.undo',
  'doc.redo',
  'doc.switch-version',
  'doc.commit-version',
  'doc.propose-pending',
  'doc.accept-pending',
  'doc.reject-pending',
  'doc.import-draft',
  'doc.unlock',
  'doc.add-reference',
  'doc.remove-reference',
  'req.doc.finalize', // 同名单元既是命令也是策略确认点（LLD-3 C09-1）
  'req.doc.generate',
  'req.doc.gen_control',
  'req.doc.export',
  'rtm.deferred.mark',
  'rtm.deferred.unmark',
] as const;
export type CommandName = (typeof COMMANDS)[number];

const set: ReadonlySet<string> = new Set(COMMANDS);
export const isCommand = (s: string): s is CommandName => set.has(s);
