/**
 * 共享枚举常量——与 LLD-4 数据库 CHECK 约束一一对应（表与枚举以 LLD-4 为权威，统稿裁决记录首部）。
 * 修改枚举 = 变更数据库约束 → 走 doc/product-design/README.md §5 变更流程。
 */

/** 文档生命周期基态（LLD-2 DSG-F02-1；pending-review 为正交标记 pend.length>0，不是第四基态） */
export const DOC_BASE_STATES = ['clean', 'dirty', 'finalized'] as const;
export type DocBaseState = (typeof DOC_BASE_STATES)[number];

/** 批次七值状态机（LLD-2 DSG-F02-8） */
export const BATCH_STATUSES = [
  'received',
  'planned',
  'approved',
  'executing',
  'reported',
  'released',
  'blocked',
] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** 缺陷五态（PRD REQ-506 权威；reopened 为事件回 confirmed，非状态） */
export const DEFECT_STATUSES = [
  'new',
  'confirmed',
  'fixing',
  'pending_regression',
  'closed',
] as const;
export type DefectStatus = (typeof DEFECT_STATUSES)[number];

/** 看板四列（LLD-4 DSG-D06-1 dev_tasks.col；blocked/blocked_reason 为独立标记列） */
export const BOARD_COLUMNS = ['queue', 'ing', 'review', 'done'] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** 批量加工作业五态（LLD-2 DSG-F02-4 权威；rejected 取消——确认复核失败不留作业行） */
export const MAT_BATCH_JOB_STATUSES = ['idle', 'confirming', 'running', 'done', 'stopped'] as const;
export type MatBatchJobStatus = (typeof MAT_BATCH_JOB_STATUSES)[number];

/** 异步操作落库六值（LLD-4 DSG-D06-3；DSG-F01-2 的 done→succeeded，stale/superseded→stale） */
export const DEV_OPERATION_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
] as const;
export type DevOperationStatus = (typeof DEV_OPERATION_STATUSES)[number];

/** 委派状态六值（LLD-4 权威；failed_timeout 独立，R-03-3） */
export const DELEGATION_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'failed_timeout',
  'cancelled',
] as const;
export type DelegationStatus = (typeof DELEGATION_STATUSES)[number];

/** Actor 五值（LLD-3 DSG-C01-3 权威，R-02-6） */
export const ACTOR_KINDS = ['human', 'assistant', 'sub-agent', 'autopilot', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** RTM 追溯关系五值（LLD-4 DSG-D04-5 权威，R-03-2） */
export const RTM_RELATIONS = ['refines', 'implements', 'verifies', 'deferred', 'dropped'] as const;
export type RtmRelation = (typeof RTM_RELATIONS)[number];

/** 资料来源三值（LLD-3 DSG-C03-1，R-03-16） */
export const MATERIAL_SOURCES = ['upload', 'zip_extract', 'inline_extract'] as const;
export type MaterialSource = (typeof MATERIAL_SOURCES)[number];

/** 上传会话状态机（LLD-4 DSG-D03-7） */
export const UPLOAD_SESSION_STATUSES = ['uploading', 'completed', 'aborted', 'expired'] as const;
export type UploadSessionStatus = (typeof UPLOAD_SESSION_STATUSES)[number];

/** 确认点七值小写点式闭集（BR-06/统稿裁决 A6 权威；LLD-4 policy_gates.gate_key CHECK） */
export const POLICY_GATE_KEYS = [
  'req.doc.finalize',
  'design.prototype.finalize',
  'dev.plan.approve',
  'dev.transfer',
  'test.plan.approve',
  'test.report.finalize',
  'test.release',
] as const;
export type PolicyGateKey = (typeof POLICY_GATE_KEYS)[number];

/** 自测四门（PRD REQ-413 权威显示名；gates 键名不变，R-02-7/R-03-8） */
export const SELFTEST_GATE_KEYS = ['functional', 'integration', 'ui', 'review'] as const;
export type SelftestGateKey = (typeof SELFTEST_GATE_KEYS)[number];
export const SELFTEST_GATE_NAMES: Record<SelftestGateKey, string> = {
  functional: '功能检查',
  integration: '联调与冒烟',
  ui: 'UI 符合度',
  review: '开发审核',
};

/** 资料解析状态机六态（LLD-2 DSG-F02-3 / REQ-107 权威；LLD-4 mat_files.parse_status CHECK） */
export const MAT_PARSE_STATUSES = [
  'pending',
  'parsing',
  'parsed',
  'failed',
  'file_final',
  'content_final',
] as const;
export type MatParseStatus = (typeof MAT_PARSE_STATUSES)[number];

/** 解析稿类型两值（LLD-4 DSG-D03-3 mat_parsed.kind CHECK） */
export const MAT_PARSED_KINDS = ['file_parse', 'content_parse'] as const;
export type MatParsedKind = (typeof MAT_PARSED_KINDS)[number];

/** 解析稿状态三值（LLD-4 DSG-D03-3；discarded=解析行删除业务标记，非软删 D19） */
export const MAT_PARSED_STATUSES = ['draft', 'final', 'discarded'] as const;
export type MatParsedStatus = (typeof MAT_PARSED_STATUSES)[number];

/** 双目录树标识（LLD-4 DSG-D03-4 mat_folder_tree.tree CHECK） */
export const MAT_TREE_KINDS = ['original', 'parsed'] as const;
export type MatTreeKind = (typeof MAT_TREE_KINDS)[number];

/** 上传文件封闭六格式（PRD REQ-102 唯一来源；LLD-7 N02-6 白名单） */
export const UPLOAD_FORMATS = ['doc', 'pdf', 'xlsx', 'md', 'txt', 'zip'] as const;
export type UploadFormat = (typeof UPLOAD_FORMATS)[number];
