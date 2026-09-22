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
  // M3 设计域：设计文档八册生命周期（F02-1 同构复用，REQ-301/302）
  'design.doc.import-draft',
  'design.doc.save-html',
  'design.doc.undo',
  'design.doc.redo',
  'design.doc.switch-version',
  'design.doc.commit-version',
  'design.doc.propose-pending',
  'design.doc.accept-pending',
  'design.doc.reject-pending',
  'design.doc.finalize',   // 非策略确认点：人工 confirm + 未决 DR 二次确认（LLD-6 §3.4）
  'design.doc.unlock',
  'design.doc.generate',
  'design.doc.gen_control',
  // M3 设计域：原型四步流水（F02-2；A05-5/6/7/9）
  'design.prototype.plan',
  'design.prototype.generate',
  'design.prototype.check',
  'design.prototype.finalize', // 同名单元既是命令也是策略确认点（7 确认点之一）
  // M3 设计域：目录人工增删（A05-13）与评审结论（A05-3）
  'design.catalog.add-item',
  'design.catalog.remove-item',
  'design.review.seed',
  'design.review.conclude',
  // M4 开发域：任务识别/计划（LLD-3 DSG-C10-2(c) 点式映射；A06-1~7）
  'dev.identify.start',
  'dev.identify.complete',
  'dev.task.save',
  'dev.coverage.confirm',
  'dev.coverage.confirm-all',
  'dev.plan.submit',
  'dev.plan.approve', // 同名单元既是命令也是策略确认点（7 确认点之一）
  // M4 开发域：看板流转与任务循环（F02-5；A06-8）
  'dev.task.start',
  'dev.task.pause',
  'dev.task.resume',
  'dev.task.stop',
  'dev.task.run',
  'dev.task.progress',
  'dev.task.rework', // 评审驳回/影响返工重入（devBeginRework+devConfirmRework）
  'dev.pr.submit',
  'dev.pr.toggle-check',
  'dev.pr.skip',     // 有理由的人工豁免（理由必填，REQ-411）
  'dev.pr.merge',    // 合并依据四类之一深冻结（REQ-411）
  'dev.quality.complete', // 单测证据（mock 执行器，M6 换沙箱 Pi）
  'dev.ai-review.complete',
  // M4 开发域：autopilot（F02-6/F07；A06-10/11）
  'dev.autopilot.approve-start',
  'dev.autopilot.advance',
  'dev.autopilot.pause',
  'dev.autopilot.resume',
  'dev.autopilot.stop',
  'dev.autopilot.takeover',
  'dev.autopilot.block',
  'dev.autopilot.awaiting-transfer',
  // M4 开发域：集成构建/自测/交接（A06-13/14/19）
  'dev.build.start',
  'dev.build.complete',
  'dev.selftest.start',
  'dev.selftest.complete',
  'dev.selftest.retest',
  'dev.selftest.stale',
  'dev.report.export',
  'dev.transfer.handoff', // 策略确认点 dev.transfer（7 确认点之一）
  // M4 开发域：变更影响/失效传播/CI 回传（A06-20/21/22）
  'dev.impact.apply',
  'dev.baseline.confirm',
  'dev.input.observe',
  'dev.ci.callback',
  'dev.ci.webhook-secret.set',
  // M5 测试验收域（C10-2(e)；REQ-501~510）
  'tst.batch.receive',
  'tst.batch.block',
  'tst.batch.unblock',
  'tst.plan.draft',
  'tst.plan.approve', // 策略确认点 test.plan.approve（7 确认点之一）
  'tst.run.execute',
  'tst.run.manual.record',
  'tst.defect.create',
  'tst.defect.confirm',
  'tst.defect.fix-start',
  'tst.defect.mark-fixed', // A07-8（C10-2(e) 之外补，F02-10 迁移表事件，差异登记）
  'tst.defect.link-regression',
  'tst.defect.close',
  'tst.defect.reopen',
  'tst.report.generate',
  'tst.report.finalize', // 策略确认点 test.report.finalize（7 确认点之一）
  'tst.report.export',
  'tst.delivery.authorize', // 策略确认点 test.release（7 确认点之一）
  // M6 AI/执行/集成域（C10-2(f)；REQ-601~615/610）
  'ai.session.create',
  'ai.session.switch',
  'ai.message.send',
  'ai.message.finish', // 消息终态落库（流式结束于事务外，完成写需独立命令；C10-2(f) 之外补，差异登记）
  'ai.message.pause',
  'ai.message.resume',
  'ai.message.stop',
  'ai.tool.invoke', // 注册表校验 + 审计（写动作回调对应域命令入口）
  'ai.prompt.publish',
  'ai.prompt.rollback',
  'ai.model.upsert',
  'ai.model.test',
  'ai.model.route.set',
  'ai.delegate.create',
  'ai.delegate.cancel',
  'ai.target.upsert', // 委派目标注册（C10-2(f) 之外补，LLD-6 §3.8 注册向导所需，差异登记）
  'ai.target.test', // 目标连通测试（失败不入册），差异登记
] as const;
export type CommandName = (typeof COMMANDS)[number];

const set: ReadonlySet<string> = new Set(COMMANDS);
export const isCommand = (s: string): s is CommandName => set.has(s);
