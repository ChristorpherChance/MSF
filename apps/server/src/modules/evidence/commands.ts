/**
 * 命令注册表（封闭枚举，LLD-7 N06-3 四件套之一：先注册后使用）。
 * 命令名小写点式，域前缀对齐 LLD-3 DSG-C10-2 分组。
 * M0 仅注册基座命令；各领域命令随里程碑追加（新增命令=注册+审计映射+效果定义+自动化测试）。
 */
export const COMMANDS = [
  'platform.project.create',
  'platform.project.update',
  'platform.project.archive',
  'platform.stage_gates.snapshot', // 阶段准入求值快照（变化驱动：仅与存量不同才写，D03-1）
  'policy.gate.set_mode',
  'policy.gate.set_preconditions', // 前置条件编辑（LLD-6 §3.9 放行策略卡；差异登记）
  // M7 平台补齐（M13：A02-6/A10-1/2/3/4；REQ-703/705/706/708）
  'system.settings.set', // 设置变更（D10-4 注：记 audit_log）
  'template_set.create', // 模板套件：新建/克隆（全局可复用）
  'template_set.rename', // 模板套件：重命名/改描述
  'template_set.delete', // 模板套件：删除（级联解绑：绑定项目/kind 级指定自动回退默认，同事事务）
  'template_set.update_item', // 模板套件：保存 kind 条目（validateTemplate 专业度闸）
  'template_set.delete_item', // 模板套件：删除 kind 条目（回退代码默认）
  'template_set.bind', // 模板套件：项目绑定/解绑活动套件
  'template_set.bind_kind', // 模板套件：项目×文档类别级指定（📄 模板弹窗换源）
  'template_refresh.start', // ⇄ 模板重排：批量任务启动（内存任务注册表，同项目并发闸 INVALID_STATE）
  'template_refresh.stop',  // ⇄ 模板重排：停止剩余（当前册跑完，剩余标 skipped）
  'system.notification.emit', // 通知产生（写路径副作用；BR-10 失败定位）
  'system.notification.read',
  'system.notification.read_all',
  'evidence.event.emit', // 领域事件流 append（D09-3；与 audit_log 分工）
  'system.backup.export', // 备份导出（A10-4；含 MinIO 工件清单+SHA-256 清单）
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
  'material.file.delete', // 文件双向同步删除（原文件+解析稿+ZIP 子件；引用守卫；DSG-U07-2，差异登记）
  'material.folder.delete', // 空目录删除（双树镜像同行；实机走查补充，差异登记）
  'material.folder.create', // 新建目录（双树镜像同建行；U-012 地毯式使用补充，差异登记）
  'material.folder.rename', // 重命名目录（双树镜像同行；U-012 地毯式使用补充，差异登记）
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
  'doc.section.add', // 编辑态增节（写草稿自带 undo 栈）
  'doc.section.del', // 编辑态删节（s0 不可删；至少保留一节）
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
  'rtm.rebuild', // #15：设计册提交版本后重建派生链（反向派生输入变了；冪等重扫重插）
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
  'design.doc.export', // L1：设计册导出留痕（md/html/docx/pdf，与 req.doc.export 同构）
  // M3 设计域：原型四步流水（F02-2；A05-5/6/7/9）
  'design.prototype.plan',
  'design.prototype.generate',
  'design.prototype.check',
  'design.prototype.finalize', // 同名单元既是命令也是策略确认点（7 确认点之一）
  'design.prototype.upload', // 人工上传 HTML 初稿入库（V1.3 上传通道；同一套检查），差异登记
  'design.prototype.unlock', // W7-003：原型解除定稿（spec「⋯ 菜单解锁定稿」；解锁后基线实时失效，可重新生成）
  'design.prototype.page_generate', // 页级 UI 原型生成 upsert（单页 AI 生成→MinIO 内容寻址→索引行；AI 在命令外），差异登记
  'design.prototype.page_propose', // 对话提案登记（0032：dock design.proto.propose_page 产物 pending 行；AI 在命令外），差异登记
  'design.prototype.page_proposal_decide', // 提案处置（accept=提案提升为页工件行/discard；FOR UPDATE+门禁+审计），差异登记
  'design.prototype.theme_set', // AI 按项目类型定制主题令牌落 plan（0033；WHERE theme IS NULL 首写胜出），差异登记
  // M3 设计域：目录人工增删（A05-13）与评审结论（A05-3）
  'design.catalog.add-item',
  'design.catalog.remove-item',
  'design.catalog.update-item', // 条目字段修订（title/note/steps/exempt；改即新目录版本），差异登记 45
  'design.review.seed',
  'design.review.conclude',
  'design.review.reopen', // 已解决项重新打开（S8 分组表操作），差异登记
  'design.review.selfcheck', // AI 自检评审单条 DR 落项（设计覆盖检测 §1：逐节一条命令事务=进度可轮询，幂等 upsert）
  // M4 开发域：任务识别/计划（LLD-3 DSG-C10-2(c) 点式映射；A06-1~7）
  'dev.identify.start',
  'dev.identify.complete',
  'dev.task.save',
  'dev.task.create', // 人工新建草稿任务（原型 newDevTask/devCreateTask），差异登记
  'dev.task.improve', // 批量补齐缺失/不可执行规格字段（原型 devImproveTasks），差异登记
  'dev.plan.schedule', // 依赖拓扑编排批次+写入范围冲突串行（原型 devSchedule/devDependencyPlan），差异登记
  'dev.coverage.confirm',
  'dev.coverage.confirm-all',
  'dev.plan.submit',
  'dev.plan.prepare', // 准备快照：draft 修订 + 建议生成（原型 devPreparePlan，LLD-5 无对应端点），差异登记
  'dev.plan.suggestion.resolve', // 逐条处置建议并追加新草稿修订（原型 devRevisePreparation，LLD-5 无对应端点），差异登记
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
  'tst.evidence.attach', // 用例执行证据附件上传（T4），差异登记
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
  'ai.session.set-model', // 会话级模型切换（DSG-U02-4 #model-sel；C10-2(f) 之外补，差异登记）
  'ai.message.send',
  'ai.message.finish', // 消息终态落库（流式结束于事务外，完成写需独立命令；C10-2(f) 之外补，差异登记）
  'ai.message.pause',
  'ai.message.resume',
  'ai.message.stop',
  'ai.tool.invoke', // 注册表校验 + 审计（写动作回调对应域命令入口）
  'ai.prompt.publish',
  'ai.prompt.rollback',
  'ai.prompt.rename', // Prompt 版本重命名（LLD-6 §3.9 pver-row ✏；C10-2(f) 之外补，差异登记）
  'ai.prompt.delete', // Prompt 历史版本删除（当前生效版拒绝；差异登记）
  'ai.reflect.run',               // 🪞 Agent 反思：执行+落库（取样/LLM 在事务外，落库写在事务内）
  'ai.reflect.proposal.resolve',  // 🪞 反思提案处置（采用=is_current 翻转 / 拒绝=状态回写）
  'ai.session.rename', // dock ⋯ 菜单会话重命名（DSG-U02-4；差异登记）
  'ai.session.delete', // dock ⋯ 菜单会话删除（消息随行，ai_usage 留账；差异登记）
  'ai.model.upsert',
  'ai.model.test',
  'ai.model.route.set',
  'ai.delegate.create',
  'ai.delegate.cancel',
  'ai.delegate.transition', // 运行态迁移（queued→running→终态；执行器内部用，晚到回调零写；C10-2(f) 之外补，差异登记）
  'ai.target.upsert', // 委派目标注册（C10-2(f) 之外补，LLD-6 §3.8 注册向导所需，差异登记）
  'ai.target.test', // 目标连通测试（失败不入册），差异登记
  'ai.usage.record', // 文档生成等无消息载体的用量落账（REQ-612；C10-2(f) 之外补，差异登记）
] as const;
export type CommandName = (typeof COMMANDS)[number];

const set: ReadonlySet<string> = new Set(COMMANDS);
export const isCommand = (s: string): s is CommandName => set.has(s);
