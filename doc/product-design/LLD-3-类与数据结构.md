# 软件工厂（MSF）低层设计 · LLD-3 类与数据结构

> 版本：V1.0-draft · 2026-09-20 · 状态：草稿，待评审
> 上游：`PRD.md`（REQ/BR）、`HLD.md`（DSG-M01~M13、ADR-3/4/5）；下游：`LLD-4-数据库设计.md`（表结构/索引）、`LLD-5-API接口.md`（端点规格）、`LLD-2-算法与流程.md`（状态机与命令事务流程）。
> 事实源：`../msf-prototype.html`（V1.11）`const S`、`DEV_ACTION_REGISTRY`、`S.design/S.proto/S.dev/S.test` 挂接段，以及 `../design-catalog.json`、`../task-specs.json`、`../source-acceptance-rules.json`、`../verified-ui-certificate.json`、`../customer-state-kernel.js`、`../material-bulk.js`、`../chat-reference.js`、`../原型写事务重设计.md`。
> 编号规则：条目 `DSG-C<章>-<序>`，每条反向引用至少一条 REQ/BR；RTM 双向追溯见 `RTM.md`。

## 1. 总则与公共原语

### DSG-C01-1 命名与语言约定（承接 REQ-807、HLD ADR-1）

- 全栈 TypeScript。后端 NestJS 视角：领域实体以 `interface`（纯数据，可 JSON 序列化）表达；含行为的封装用 `class`（聚合根/服务）表达，本册只规定数据形状与不变式，行为流程在 LLD-2。
- 所有领域实体字段用 camelCase；DB 列名 snake_case，映射在 LLD-4 逐表展开，本册只给出**表名**。
- 所有 ID 为字符串；项目内人类可读编号沿用原型形态并统一前缀（M5）：任务 `T-201`、用例 `TC-001`、批次 `TB-001`、计划 `TP-001`、运行 `TR-001`、验收报告 `AR-001`、交付决定 `AD-001`、缺陷 `DF-001`、自测报告 `SR-001`、构建 `B-001`、命令收据 `RCPT-001`，作为 `code` 字段与内部 UUID 主键并存。
- 时间一律 ISO-8601 UTC 字符串（`string`），DB 存 `timestamptz`。
- 每实体带 `projectId`（跨项目隔离，承接 REQ-101「每项目独立」）与 `createdBy/updatedBy` 操作者字段（REQ-707 预留，不允许留空，BR-08）。

### DSG-C01-2 公共标量类型（承接 BR-01、BR-02、BR-08、BR-13）

```ts
type Id = string;                 // 内部主键（ULID/UUID）
type Code = string;               // 人类可读编号，如 'T-201'
type IsoTime = string;            // ISO-8601 UTC
type Sha256 = string;             // 64 位小写十六进制；原型 devHash(FNV) 的正式实现（HLD ADR-2）
type Fingerprint = Sha256;        // 规范化序列化（key 排序、剔除时间戳/readiness 字段）后的 SHA-256
type Json = unknown;              // JSONB 载荷
```

规范化规则（HLD ADR-4）：对象 key 字典序递归排序、数组保序、剔除 `at/updatedAt` 等时间戳与 readiness 字段后再哈希；对应原型 `devStableString/devHash`（msf-prototype.html L4717-4718）与 RH `canonical/hash`（runtime-hardening.js L5-6）。

### DSG-C01-3 审计操作者 Actor（承接 REQ-706、REQ-707、BR-08、BR-13）

```ts
type ActorKind = 'human' | 'assistant' | 'sub-agent' | 'autopilot' | 'system';
interface Actor {
  id: Id;                      // 账号或虚拟执行者 ID
  kind: ActorKind;
  displayName: string;
  /** 虚拟执行者时的归属身份：autopilot 为 runId+runToken+authorizationId 三元组（BR-13） */
  attribution?: AutopilotAttribution;   // 见 DSG-C12-4
  /** 异步操作时的操作身份四元组（BR-08），见 DSG-C12-3 */
  operation?: OperationIdentity;
}
```

不变式：任何写命令、审计条目、证据记录的 `actor` 不允许为 null；`kind='autopilot'` 时 `attribution` 必填。表映射：`sys_users`（本期单行本地默认身份；REQ-707 扩展为完整账号表）。

## 2. 平台通用域（projects/sys_/evd_）

### DSG-C02-1 Project（承接 REQ-701、REQ-702）

```ts
type ProjectStage = 0 | 1 | 2 | 3 | 4;   // 资料/需求/设计/开发/测试（原型 stage）
interface Project {
  id: Id;
  code: Code;                  // 原型 'pj1'
  name: string; icon: string; desc: string;
  owner: Id;                   // → sys_users
  createdAt: IsoTime;
  stage: ProjectStage;         // 当前推进到的阶段（派生自各域门禁，冗余存储）
  costTotal: number;           // 累计成本（由 ai_usage 汇总，REQ-612）
  isSample: boolean;           // 示例数据隔离标记（BR-15）
}
```

字段说明：`isSample=true` 的项目数据与真实项目物理/逻辑隔离，不作为任何真实门禁依据（BR-15）。
不变式：`stage` 只能由阶段门禁求值结果驱动变更，不允许直接写。
表映射：`projects`。

### DSG-C02-2 Fingerprint 值对象（双层，承接 BR-01、BR-02、HLD ADR-4）

```ts
interface FingerprintPair {
  /** 治理输入指纹：上游工件版本组合（artifactId+versionId+finalizationId+hash 列表）的哈希 */
  governing: Fingerprint;
  /** 内容指纹：本工件规范化内容的哈希；readiness（待办数、modified 标记、未读数）不进入 */
  content: Fingerprint;
}
```

不变式：①`content` 变化 ⟹ 工件身份变化，引用方按指纹校验失效（BR-01）；②readiness 变化不得改变 `content`（人工定稿不让刚定的基线立即过期，BR-02）；③二者独立计算独立比对。不落独立表，作为各工件/证据表的 `governing_fingerprint`/`content_fingerprint` 列（LLD-4）。

### DSG-C02-3 EvidenceRef（承接 BR-03、BR-11、REQ-505、HLD ADR-5）

```ts
type EvidenceKind = 'screenshot' | 'log' | 'file' | 'dom-dump' | 'ci-report' | 'ut-report'
                  | 'review-record' | 'manual-record' | 'export';
interface EvidenceRef {
  id: Id;
  kind: EvidenceKind;
  /** 大体积内容存对象存储，key = 内容哈希（内容寻址）；本字段即该哈希 */
  contentHash: Sha256;
  objectKey: string;            // MinIO key
  mediaType: string;
  sizeBytes: number;
  simulated: boolean;           // 任何模拟执行产生的证据必须 true（BR-11）
  capturedAt: IsoTime;
  capturedBy: Actor;
  sourceRunId?: string;         // 产生该证据的运行（CaseRun/SelfTestRun/Delegation）
}
```

不变式：`simulated=false` 的证据必须能回溯到真实执行运行记录；证据对象只增不改（append-only）。
表映射：`evd_records`（append-only，DB 角色禁 UPDATE/DELETE）。

### DSG-C02-4 AuditEntry（承接 REQ-706、BR-04、HLD ADR-3/5）

```ts
interface AuditEntry {
  eventId: Code;                // 'AUD-N'（原型 devAudit）
  projectId: Id;
  actor: Actor;                 // 不允许为空
  action: string;               // 命令名（§10 封闭枚举）
  target: string;               // 目标工件/资源标识
  beforeRevision?: number;      // 原型 beforeRev/afterRev
  afterRevision?: number;
  reason: string;
  runId?: string;               // 关联自动运行
  inputFingerprint?: Fingerprint; // 命令输入指纹（命令审计复核用）
  prevHash: Sha256;             // 审计链：上一条审计的内容哈希（HLD ADR-5）
  recordHash: Sha256;           // 本条内容哈希：SHA256(prevHash ‖ canonical(除本字段外全字段))，审计链独立于证据链（双链）
  at: IsoTime;
}
```

不变式：append-only + 哈希链；**审计写入失败则业务命令整体回滚，业务零写**（BR-04）。
表映射：`audit_log`（append-only）。

### DSG-C02-5 Notification 与 DomainEvent 存储壳（承接 REQ-703）

```ts
interface Notification {
  id: Id; projectId: Id; at: IsoTime; text: string;
  type: string;                 // 事件类型，同 §10.3
  unread: boolean;              // readiness，不进任何内容指纹（BR-02）
  linkRoute?: string;           // 跳转路由
}
```

表映射：`sys_notifications`。事件本体见 §10.3，存 `evd_events`（append-only）。

## 3. 资料域（mat_）

### DSG-C03-1 MaterialFile（承接 REQ-102、REQ-107、REQ-108、REQ-109）

```ts
type MaterialStatus =
  | 'pending' | 'parsing' | 'parsed' | 'failed'   // 文件解析状态机（REQ-107）
  | 'file_final'                                // 文件级定稿（REQ-108）
  | 'content_final';                            // 内容级定稿（REQ-109，需求参考门禁的唯一合法状态，REQ-114）
interface MaterialFile {
  id: Id; projectId: Id;
  name: string;                 // 原始文件名（UTF-8，ZIP 上传经 REQ-103 校验）
  mediaType: string; sizeBytes: number;
  objectKey: string;            // 原件对象存储 key；原件永久保留（REQ-102）
  contentHash: Sha256;          // 原件内容哈希
  uploadedAt: IsoTime; uploadedBy: Id; source: 'upload' | 'zip_extract' | 'inline_extract';  // 来源枚举以 LLD-4 DSG-D03-2 为权威（二轮评审对齐：zip_extract=ZIP 整包、inline_extract=行内解压）
  status: MaterialStatus;
  folderId: Id;                 // → mat_folder_tree（原件树节点，REQ-105）
  /** 解析稿（ParsedContent）指针；解析产物不覆盖原件（REQ-105/109） */
  parsedId?: Id;
  ops: string[];                // 已做加工操作名（翻译/脱敏/索引…，REQ-111）
  attachments: { name: string; byOp: string; evidenceId?: Id }[];
  failReason?: string;          // failed 时必填
  archive: boolean;             // 行内解压后的归档标记（REQ-104：原包保留不删）
  unsupported: boolean;         // 类型不可解析旁路标记：原件保留、不参与解析流转（落库 mat_files.unsupported）
}
```

不变式：①`status` 迁移仅允许 `pending→parsing→parsed|failed`，`failed→parsing`（重试），`parsed→file_final→content_final`；反向迁移仅允许 `file_final→parsed`（解锁文件定稿）、`content_final→file_final`（解锁内容定稿）、`parsed→pending`（删除解析稿且删除守卫通过）——与 LLD-2 DSG-F02-3 迁移表逐条对应；`unsupported`/`archive` 为旁路标记，与状态机正交、不构成迁移；定稿后不再出现在「待解析」过滤（REQ-108）。②原件对象不可变；删除解析行不删原件（REQ-109）。③`status='content_final'` 且属当前项目才可进入需求参考输入（REQ-114）。
表映射：`mat_files`（元数据，可更新 status）；原件字节在对象存储。

### DSG-C03-2 ParsedContent（承接 REQ-105、REQ-109、REQ-113）

```ts
interface ParsedContent {
  id: Id; fileId: Id; projectId: Id;
  mdPath: string;               // 解析稿树内路径（原型 mdPath）
  fileMd?: string;              // 文件级解析 Markdown
  contentMd?: string;           // 内容级整理 Markdown（content_final 的依据）
  contentResults: { kind: string; md: string; at: IsoTime }[];  // 加工产物行（可独立删除，REQ-109）
  contentFingerprint: Fingerprint;  // 内容指纹：引用门禁与批量作业基线比对用（REQ-115）
  folderId: Id;                 // → mat_folder_tree（解析稿树，与原件树一一对应，REQ-105）
  version: number;              // 乐观锁版本（BR-12）
}
```

不变式：编辑三态（预览/编辑/源码）只改 `contentMd` 草稿区，提交时版本 +1；有下游依赖（被文档 refs 引用）时删除需守卫原因（REQ-109）。
表映射：`mat_parsed`。

### DSG-C03-3 FolderNode（承接 REQ-104、REQ-105、REQ-106）

```ts
interface FolderNode {
  id: Id; projectId: Id;
  tree: 'original' | 'parsed';  // 双目录树（REQ-105）
  parentId?: Id; name: string; path: string;   // path 经 NFC 规范化、禁 .. 与非法字符（REQ-103 同规则）
  zipFileId?: Id;               // 行内解压来源包（REQ-104：解压为同名文件夹，原包保留）
  createdAt: IsoTime;
}
```

不变式：同一棵树内路径唯一（大小写不敏感，原型 `names.add(key.toLowerCase())`）；原件树只增不改。树的选择/折叠态为客户端会话态（REQ-106），不入库、不进指纹。
表映射：`mat_folder_tree`。

### DSG-C03-4 BatchJob（含 basisSnapshot，承接 REQ-110、REQ-111、REQ-112、BR-12）

```ts
type BulkOp = 'translate' | 'mask' | 'index';           // 内置加工（REQ-111）
type BatchRowStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'skipped';
type BatchJobStatus = 'idle' | 'confirming' | 'running' | 'done' | 'stopped';  // 作业级状态机五态（LLD-2 DSG-F02-4）
interface BatchJob {
  id: Id; projectId: Id;
  kind: 'parse' | 'process' | 'content_final';          // 批量解析/批量加工/批量定稿
  status: BatchJobStatus;               // 作业级五态承载字段（落库 mat_batch_jobs.status，LLD-4 DSG-D03-5 已对齐本枚举）
  options: { ops: BulkOp[]; language?: string };        // 原型 v11StartBulk options
  /** 基线快照（REQ-111 新口径）：弹窗打开时整批快照；点击开始时整批复核，不一致整批中止；
      执行中逐行提交前再比对，变化行 skipped 跳过、不阻塞整批 */
  basisSnapshot: { fileId: Id; basis: Fingerprint }[];
  rows: { fileId: Id; name: string; status: BatchRowStatus; detail?: string; base: Fingerprint }[];  // 行级状态落 mat_batch_items.result（LLD-4 DSG-D03-6）
  stopRequested: boolean;               // running 内的停止标记（停止后续行，已提交行不回滚）
  startedAt: IsoTime; finishedAt?: IsoTime; startedBy: Actor;
}
```

不变式：①弹窗打开整批快照、开始时整批复核（不一致整批中止），执行中变化行逐行跳过（原型 `basis()` 比对，REQ-111 新口径）；②批量内容定稿必须人工确认（REQ-112）；③作业归属单一项目，项目切换即停止（原型 openProject 守卫）。
表映射：`mat_batch_jobs` + `mat_batch_items`。

### DSG-C03-5 ParseTask（承接 REQ-107、REQ-110）

```ts
interface ParseTask {
  id: Id; projectId: Id; fileId: Id;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;              // 失败可重试（REQ-107）
  errorCode?: string; errorMessage?: string;
  startedAt?: IsoTime; finishedAt?: IsoTime;
  /** 解析执行可委派外部目标（REQ-610），记录委派回执 */
  delegationId?: Id;            // → ai_delegations
}
```

不变式：同一 `fileId` 同时至多一个非终态 ParseTask；每次状态流转写审计（REQ-107 留痕）。
表映射：不单设表——解析执行以 `mat_batch_jobs`（kind='parse'，单文件解析即单条目作业）+ `mat_batch_items`（重试链 `retry_of`）承载；委派回执引用 `ai_delegations`。

## 4. 需求域（req_）

### DSG-C04-1 ReqDocument（承接 REQ-201、REQ-202、REQ-203、REQ-209、REQ-210）

```ts
type ReqDocKind = 'crd' | 'prd';   // RTM 由 RtmLink 承载（REQ-207）
type DocGenState = 'idle' | 'generating' | 'paused' | 'done' | 'failed';
interface ReqDocument {
  id: Id; projectId: Id; kind: ReqDocKind;
  currentVersion: number;       // 原型 cur
  finalized: boolean; finalVersion?: number;   // 原型 finalized/finalVer；**指针见文档行**（req_documents.final_version_id，BR-03）：定稿不落版本行，定稿 = 追加 evd_records(kind='finalize') + 移动该指针（M2）
  refFileIds: Id[];             // 已定稿资料引用（REQ-114 门禁过滤后）；落库为关联表 req_doc_refs（M8）
  uploadRefNames: string[];     // 阶段内补充 md（原型 upRefs）
  genState: DocGenState;        // 落库列 req_documents.gen_state（M8）
  lockVersion: number;          // 乐观锁：并发提交按服务端版本拒绝（REQ-210、BR-12）
}
```

不变式：草稿、提交、定稿是三个独立动作（REQ-203）；已定稿文档不可原地修改，修改 = 基于定稿产生新草稿（REQ-209）；同一文档同一时刻一个写者（REQ-210）。
表映射：`req_documents` + `req_doc_refs`（参考关联）。

### DSG-C04-2 DocVersion（不可变，承接 REQ-203、REQ-209、BR-03、BR-05）

```ts
interface DocSection { id: string; title: string; md: string; }   // 原型 secs
interface DocVersion {
  id: Id; documentId: Id;
  v: number;                    // 文档内单调递增，不复用（BR-05）
  sections: DocSection[];
  note: string; by: Actor; at: IsoTime;
  contentFingerprint: Fingerprint;          // sections 规范化哈希（BR-01）
  /** 生成输入快照：参考文件身份 + CRD 定稿身份（REQ-115；原型 v.inputSnapshot） */
  inputSnapshot?: { materials: { fileId: Id; contentFingerprint: Fingerprint }[]; crdRef?: ArtifactRef };
}
```

不变式：已提交版本字节不可变（BR-03/REQ-209：历史版本不得被后续草稿改写）；历史版本只读；版本号不复用；绝不重建或谎称修复已丢失历史（BR-05）；**版本行永不 UPDATE**——定稿不落在版本行上，见 DSG-C04-1（M2）。
表映射：`req_versions`（append-only）。

### DSG-C04-3 Draft（承接 REQ-203、REQ-204、REQ-209、BR-05）

```ts
interface Draft {
  id: Id; documentId: Id;
  baseVersion: number;                   // 基于哪个已提交版本
  baseContentFingerprint: Fingerprint;   // 基线内容指纹（BR-05 不变式判定锚）
  sections: DocSection[];                // 工作副本（单一工作草稿，无跨版本 stash）
  modified: boolean;                     // ⟺ fingerprint(sections) ≠ baseContentFingerprint
  undoDepth: number;                     // undo/redo 栈仅存服务端会话或客户端（REQ-204，对称转换）
}
```

不变式（BR-05 发布不变式的一部分，完整清单见 §13）：`modified ⟺ 内容指纹偏离 baseContentFingerprint`；切换版本前 `modified=false` 且待确认补丁为空（原型 switch-version 收紧规则）；undo/redo 对称。
表映射：`req_drafts`（每文档至多一行，BR-12 单写者）。

### DSG-C04-4 PendingPatch（承接 REQ-205、REQ-613）

```ts
interface PendingPatch {
  id: Id; documentId: Id;
  targetSectionId: string;
  oldText: string; newText: string;      // 最小补丁，禁止重写全文（原型 edit_patch 纪律）
  proposedBy: Actor;                     // 通常为 assistant
  /** 提案绑定的版本与内容身份：迟到提案拒绝（原型 propose-pending 绑定项目+当前版本/内容） */
  baseVersion: number; baseContentFingerprint: Fingerprint;
  status: 'pending' | 'accepted' | 'rejected' | 'stale';
  decidedBy?: Actor; decidedAt?: IsoTime;
}
```

不变式：AI 提案不直接落稿，必须人工逐条接受/拒绝（REQ-205、BR-06）；接受时要求 `oldText` 在当前内容中精确匹配，不匹配整条命令失败（原型 accept-pending）；基线指纹变化 → `stale`。
表映射：`req_pendings`。

### DSG-C04-5 RtmLink（承接 REQ-207）

```ts
type RtmNodeKind = 'R' | 'CR' | 'REQ' | 'DSG';
interface RtmLink {
  id: Id; projectId: Id;
  fromKind: RtmNodeKind; fromId: string;   // 如 'CR-003'
  toKind: RtmNodeKind; toId: string;       // 如 'REQ-005'
  /** 关系枚举以落库为准（LLD-4 DSG-D04-5）；deferred/dropped = 显式推迟/放弃（原型 rtmDeferred），
      不计入 L0a/L0b/L0c 分母、计入 L0d，标记/取消记审计 */
  relation: 'refines' | 'implements' | 'verifies' | 'deferred' | 'dropped';
}
```

不变式：deferred 不以独立布尔字段表达，一律以 `relation` 取值表达（二轮评审裁决）；deferred 明细（理由/操作者/时刻）随健康度快照落 `rtm_health.deferred_items`（DSG-C04-6）。
表映射：`rtm_links`。

### DSG-C04-6 RtmHealth（承接 REQ-208）

```ts
interface RtmHealth {
  projectId: Id;
  l0a: number;    // R→CR 承接率：分母=active R（deferred 不计入，与 L0b/L0c 同构，二轮评审裁决），分子=被 CR 条目承接的 R；门禁 ≥ 0.95；active R 为 0 时记 1 并告警「无 R 可核对」
  l0b: number;    // CR→REQ 承接率：分母=active CR 条目（deferred 不计入），分子=被 REQ 承接；门禁 = 1；active CR 为 0 时记 1 并告警「无 CR 可核对」
  l0c: number;    // REQ→DSG 锚点覆盖率：分母=active REQ 总数（deferred 不计入），分子=有至少一个 DSG 条目承接的 REQ 数；active REQ 为 0 时记 1 并告警；开发入口门禁要求 = 1（REQ-310）
  l0d: number;    // deferred 计数：显式推迟的 CR/REQ 数，信息性指标，不进入任何门禁公式（不允许借 deferred 藏缺口）
  deferredItems: { nodeId: string; reason?: string; by?: Actor }[];  // deferred 明细（标记/取消须记审计）
  gaps: { reqId: string; missing: ('CR' | 'REQ' | 'DSG' | 'downstream')[]; detail: string }[];
  computedAt: IsoTime; basisFingerprint: Fingerprint;   // 计算所依据的文档版本组合指纹
}
```

不变式：`l0a≥0.95 && l0b=1` 才允许进入设计阶段；`l0c=1` 为开发入口门禁条件之一（REQ-310）；`l0d` 仅展示不进门禁；不达标必须列出具体缺口（REQ-208）；健康度为派生值，输入指纹变化即重算。四指标权威定义见 PRD REQ-208（2026-09-20 波次 1-3 修订口径）。
表映射：派生快照 `rtm_health`（可重算；作为门禁证据时求值留痕追加 `policy_gate_events`）。

## 5. 设计域（dsg_）

### DSG-C05-1 DesignDoc（承接 REQ-301、REQ-302、REQ-303）

```ts
type DesignDocKey = 'h' | 'o' | 'g' | 'k' | 'd' | 'a' | 'u' | 'n';
// 设计册前缀权威（M7）：h=概要 HLD；o=模块 LLD-1；g=算法与流程 LLD-2；k=类与数据结构 LLD-3；
// d=数据库 LLD-4；a=API LLD-5；u=UI LLD-6；n=非功能 LLD-7。落库为 dsg_documents.chapter_prefix。
interface DesignDoc {
  id: Id; projectId: Id; key: DesignDocKey;
  group: 'outline' | 'detail';           // HLD / 七册 LLD（REQ-301）
  name: string;
  currentVersion: number; finalized: boolean; finalVersion?: number;
  finalizationSeq: number;               // 原型 _finalizationSeq：再定稿批次号（影响基线身份）
  review: { id: Code; severity: '高' | '中' | '低'; docKey: DesignDocKey; text: string; status: 'open' | 'done' }[];  // DR 系列（REQ-303）
}
```

复用 `DocVersion`/`Draft`/`PendingPatch` 结构（REQ-302 复用 REQ-203 版本体系）；实现上设计册版本行落 `dsg_versions`（append-only），草稿落 `dsg_drafts`。不变式同 DSG-C04-2/3/4。
表映射：`dsg_documents`、`dsg_versions`（append-only）、`dsg_drafts`、`dsg_reviews`。

### DSG-C05-2 DesignCatalog（承接 REQ-304、REQ-312；事实源 design-catalog.json）

```ts
interface DocAnchorRef { docKey: DesignDocKey; sectionId: string; anchor: string; rule: string; }
interface CatalogRequirement { id: string; title: string; uiApplicable: boolean; sourceRefs: string[]; }
interface CatalogPage {
  id: string;                 // 'P-PUB-HOME'
  title: string; route: string; area: string;   // area 决定适用视口集
  roles: string[]; reqIds: string[];
  hldRefs: string[]; lldRefs: DocAnchorRef[];   // 可追溯到具体文档章节（REQ-304）
  taskIds: string[];          // 反查承接任务（REQ-310）
  states: CatalogState[]; controls: CatalogControl[]; fields: CatalogField[];
}
interface CatalogState { id: string; title: string; required: boolean; expected: string; }
interface CatalogControl {
  id: string; label: string; type: string;      // 原型 data-prototype-control / data-prototype-type
  expected: string; action: string; targetPageId?: string;
}
interface CatalogField { id: string; label: string; type: string; required: boolean; expected: string; }
interface CatalogFlow {
  id: string;                 // 'F-001'
  title: string; roles: string[]; reqIds: string[];
  steps: { pageId: string; action: string; expected: string }[];
}
interface ViewportProfile {
  id: string;                 // 'public-desktop' / 'public-tablet' / 'public-mobile' / 'cms-desktop'
  area: string; minWidth?: number; maxWidth?: number;
  sourceRef: { docKey: DesignDocKey; sectionId: string; rule: string };
  applicabilityReason: string;
}
interface NonUiCoverageItem { id: string; description: string; hldRefs: string[]; lldRefs: DocAnchorRef[]; requirementIds: string[]; }
interface UiConformanceGate { generalVisualComplianceMin: number; /* 0.95 */ criticalItemsMin: number; /* 1 */ measurement: string; criticalItems: string[]; }
interface DesignCatalog {
  id: Id; projectId: Id;
  catalogVersion: string;                    // 原型 'V1.9-draft-2'，规则集版本化（REQ-312）
  requirements: CatalogRequirement[];
  pages: CatalogPage[]; flows: CatalogFlow[];
  nonUiCoverage: NonUiCoverageItem[];
  viewportProfiles: ViewportProfile[];
  statusDisplayMapping: Json;                // 规范化存储态 ↔ 工作流视图态映射（catalog.statusDisplayMapping）
  uiConformanceGate: UiConformanceGate;
  contentFingerprint: Fingerprint;
  /** 与已批准来源文档的双向审计结论（REQ-312；规则集版本化，事实源 source-acceptance-rules.json）；issues[].code 取值闭集见 §15(h) */
  sourceAudit?: { rulesVersion: string; ok: boolean; issues: { code: string; message: string; target: string; sourceRefs: string[] }[] };
}
```

不变式：目录从已定稿 PRD/HLD/LLD 建立（REQ-304）；上游删除、锚点内容不符均判审计失败（REQ-312）；目录身份参与设计基线治理指纹（BR-02）。
表映射：`dsg_catalog_items`（条目化存储，含 catalog_version 版本列）+ `dsg_catalog_refs`（条目→章节锚点追溯引用）。

### DSG-C05-3 PrototypeCheck（承接 REQ-306、REQ-311）

```ts
type CheckIssueCode = string;   // 取值闭集见 §15(g) 原型检查组（如 PAGE_MISSING/STATE_MISSING；事实源原型 inspect/designAudit）
interface PrototypeIssue {
  issueId: Code; code: CheckIssueCode; severity: 'blocking' | 'major' | 'minor';
  target: string; message: string; sourceRefs: DocAnchorRef[];
  humanRequired: boolean;       // 无法识别的条款标「未验证/需人工」，不静默忽略（REQ-306）
}
interface PrototypeCheck {
  id: Id; projectId: Id; reportId: Code;
  /** 检查对象身份：原型版本 + HTML/manifest 指纹（BR-01） */
  prototypeVersion: number; htmlFingerprint: Fingerprint; manifestFingerprint: Fingerprint;
  /** 检查依据身份：目录指纹 + 来源审计规则版本 */
  catalogFingerprint: Fingerprint; rulesVersion: string;
  gates: { catalog: boolean; traceability: boolean; semantics: boolean; interaction: boolean };  // 原型四门 gates
  issues: PrototypeIssue[];
  status: 'pass' | 'fail';
  at: IsoTime; operation: OperationIdentity;   // 异步检查操作身份（BR-08）
}
```

不变式：检查报告对「原型指纹 × 目录指纹 × 规则版本」组合有效，任一变化即失效（BR-07）；自动修复仅限有明确依据的差异，未知矛盾保留为 `humanRequired`（REQ-311）。
表映射：`dsg_prototype_checks`（append-only）。

### DSG-C05-4 DesignBaseline（承接 REQ-308、REQ-309、REQ-310、BR-01/02/07）

```ts
interface BaselineItem extends ArtifactRef {   // artifactId+versionId+finalizationId+fingerprint
  label: string; required: boolean; status?: string;   // '未引用' 等（原型 baseline.items）
}
interface DesignBaseline {
  id: Id; projectId: Id;
  baselineId: Code;             // 'BL-...'
  finalizationId: Code;         // 定稿批次 'FIN-N'
  items: BaselineItem[];        // PRD/HLD/七册/PROTO 版本组合（不复制内容，只存身份）
  governingFingerprint: Fingerprint;  // items 组合指纹（BR-02 治理层）
  contentFingerprint: Fingerprint;    // 原型输出内容指纹（HTML+manifest，BR-02 内容层）
  /** 冻结的 UI 验收分母：页面×适用视口矩阵（REQ-414 分母不可缩小，BR-09） */
  uiAcceptance: { matrix: UiAcceptanceCell[] };
  valid: boolean;               // 指针性结论；真正有效性 = 实时重算比对（BR-03）
  confirmedAt: IsoTime; confirmedBy: Actor;   // 共同定稿必须人工（REQ-308、BR-06）
}
interface UiAcceptanceCell {
  pageId: string; viewportId: string;
  expectedCriticalCheckIds: string[]; expectedGeneralCheckIds: string[];
  checkDefinitions: { checkId: string; kind: 'critical' | 'general'; sourceRefs: string[] }[];
}
```

不变式：①必需页面/流程/状态缺失或关键冲突时阻断定稿（REQ-308）；②上游或原型内容变化后旧基线自动失效，需重新检查与定稿（REQ-309、BR-07）；③基线有效才可进入开发准备（REQ-310）；④`valid` 字段只是指针，有效性证据 = 当前实时指纹比对（BR-03）。
表映射：`dsg_baselines`（append-only）；当前有效基线指针存 `projects` 行（BR-03：指针不是有效性证据）。

## 6. 开发域（dev_）

### DSG-C06-1 DevTask（承接 REQ-401、REQ-402、REQ-405；事实源 task-specs.json、V17_TASKS）

```ts
type TaskKind = 'frontend' | 'backend' | 'common' | 'integration';
type BoardCol = 'queue' | 'ing' | 'review' | 'done';   // 看板流转（REQ-405）；阻塞是标记不是列（A4）
interface QualityTarget {
  line: number; branch: number;                    // 单测行/分支覆盖率目标
  scenarios: { type: 'normal' | 'boundary' | 'exception'; applicable: boolean; case: string; expected: string; pass: string }[];
}
interface DevTask {
  id: Id; projectId: Id; code: Code;              // 'T-201'
  title: string; kind: TaskKind;
  owner: string; ownerType: 'human' | 'agent';    // 原型 asg/asgType
  goal: string; scope: string; boundary: string;
  sourceIds: string[];                            // 承接的目录来源 'SRC-001'（可反查设计项，REQ-401/403）
  inputArtifactIds: string[];                     // 声明依赖的输入工件（resolveTaskInputs）
  work: string[]; inputs: string[]; deliverables: string[];
  acceptance: string[];                           // 验收标准（≥3 条可测）
  quality: QualityTarget; qualityRev: number;
  deps: Code[];                                   // 任务依赖
  writeScopes: string[];                          // 代码写入范围（仓库内相对路径、禁上跳；冲突可检出 REQ-402）
  batch?: number; effort?: string;
  rev: number; codeRev: number;                   // 规格修订号 / 代码修订号
  col: BoardCol; prog: number;
  blocked: boolean; blockedReason?: string;           // 阻塞标记（A4：非看板列）
  coverage: { itemId: string; status: 'pending' | 'confirmed'; catalogRev: number; taskRev: number }[];
  evidence: { unit?: EvidenceRef & { evidenceId: Code }; ci?: EvidenceRef & { evidenceId: Code } };
  pr?: { id: Code; commitId: string; headRevision: number; status: string };
  archived: boolean; excluded: boolean;           // 延期排除（保留历史，原型 devApplyDefer）
}
```

不变式：`writeScopes` 非空且为合法仓内相对路径；与运行中任务的写入范围冲突必须检出（原型 SPEC_WRITE_SCOPE / WRITE_SCOPE_ACTIVE，注册表码 `WRITE_SCOPE_CONFLICT`）；`excluded` 任务保留历史不物理删除。
表映射：`dev_tasks`（coverage 为 JSONB 列）；单测/CI 证据不落本表——CI 结论落 `dev_ci_reports`（LLD-4 DSG-D06-9，按 commit 取最新匹配行），单测证据经 `evd_records` 引用（DSG-C02-3）。

### DSG-C06-2 DevPlan（承接 REQ-403、REQ-404、REQ-420）

```ts
type PlanState = 'draft' | 'submitted' | 'approved' | 'invalidated';
interface PlanSnapshot {
  snapshotId: Code; revision: number;
  taskIds: Code[]; taskRevisions: Record<Code, number>;
  fingerprint: Fingerprint;            // 计划内容指纹（BR-01）
  submittedAt?: IsoTime; approvedBy?: Actor; approvedAt?: IsoTime;
}
interface DevPlan {
  id: Id; projectId: Id;
  revision: number;                    // 任何输入失效 +1（原型 devInvalidate）
  state: PlanState;
  submitted?: PlanSnapshot; approved?: PlanSnapshot;
  history: PlanSnapshot[];             // 只增
  suggestions: { id: Code; state: 'pending' | 'accepted' | 'rejected'; sourceFingerprint: Fingerprint; task: Partial<DevTask>; reason: string }[];
  deferred: Record<string, { approved: boolean; reason: string; actor: Actor; at: IsoTime; catalogRev: number; excludedTaskIds: Code[] }>;
}
```

不变式：计划提交后由**人工**批准才进入执行，批准后快照固定（REQ-404）；上游输入变化 → `revision+1`、状态降级、运行中操作置 `cancelled`（REQ-420、原型 devInvalidate）；批准绑定当时基线与计划指纹。
表映射：`dev_plans`（append-only 修订行；`suggestions`/`deferred` 为 JSONB 列，M8）。

### DSG-C06-3 DevOperation（命令+收据+效果 ledger，承接 REQ-408、REQ-410、BR-04/08/14）

```ts
type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';   // 异步操作状态六值（M4；二轮评审补 'stale'，与 LLD-4 DSG-D06-3/LLD-5 A10-7 一致）：stale=操作过期/被取代，承接 LLD-2 DSG-F01-2 权威枚举中 stale（输入已变化被淘汰）与 superseded（被同 scope 新操作取代）的落库合并值
interface DevOperation {
  /** 操作身份四元组（BR-08）：operationId(runId)+opToken+action+owner */
  operationId: Code;                   // 原型 runId，如 'IDENT-1'
  opToken: string;                     // 启动时签发；失效时旋转（追加 -stale- 后缀语义由新令牌替代）
  action: string;                      // dispatchAction：identify/quality/build/selftest…
  owner: string;                       // 'design-human' / 'autopilot' / actor id
  projectId: Id; kind: string;
  /** 启动时锁定的依据指纹：回调提交前逐项重验（原型 devExecuteOperationValid 等） */
  sourceFingerprint: Fingerprint; inputFingerprint: Fingerprint; baselineKey: string;
  taskRev?: number; snapshot?: Json;   // quality 操作快照（codeRev/qualityRev/prId/commitId/headRevision）
  buildInputsFingerprint?: Fingerprint;
  status: OperationStatus;             // 晚到/失效回调不落成状态：严格零写（BR-08）；运行作废以 failed/cancelled/stale 终结并留痕
  errorCode?: string; errorMessage?: string;
  startedAt: IsoTime; finishedAt?: IsoTime;
  autopilotAuthorizationId?: Code;     // 归属 autopilot 时填（BR-13）
}
interface EffectLedgerEntry {
  effectId: Code; operationId: Code;
  kind: string;                        // ui.render / notify / timer / observe-dev-input…
  status: 'pending' | 'running' | 'done' | 'failed' | 'stale';   // BR-14
  payload: Json; attempts: number; lastError?: string;
}
```

不变式：①回调提交前重验实时指纹与父运行身份，晚到/失效回调严格零写（BR-08、REQ-410）；②效果逐条 `pending→running→done/failed/stale`，重启后幂等补记，完成/过期项不重放（BR-14）；③`operation.start.failed` 也是一条命令（启动失败要落审计）。
表映射：`dev_operations`、`sys_effects`。

### DSG-C06-4 DevBuild（承接 REQ-412、BR-01）

```ts
interface UiArtifact {
  artifactId: Code;                    // buildId+'-UI'
  objectKey: string;                   // HTML 存对象存储（原型内嵌字符串的真实化，README S6）
  htmlFingerprint: Fingerprint;
  implementationManifest: Json;        // 页面/状态/控件/字段观察清单 + sourceTaskRevisions
  manifestFingerprint: Fingerprint;
}
interface DevBuild {
  id: Id; projectId: Id; buildId: Code;              // 'B-<序>'（M5）
  planSnapshotId: Code; baselineKey: string; sourceFingerprint: Fingerprint;
  commits: { sha: string; msg: string; by: string; at: IsoTime }[];
  codeRevisions: Record<Code, number>; taskRevisions: Record<Code, number>;
  uiArtifact?: UiArtifact;             // 独立 UI 工件，禁止复制原型 HTML 冒充（REQ-412）
  evidenceIndex: Record<string, Code>; // 任务→证据 ID 索引
  status: 'building' | 'pass' | 'fail';
  buildFingerprint: Fingerprint;       // 原型 devBuildFingerprint 全要素哈希
  createdAt: IsoTime;
}
```

不变式：同一 `buildId` 收据不可变（原型 BUILD_RECEIPT_IMMUTABLE）；构建身份变化只能产生新构建记录（BUILD_RECEIPT_REPLACEMENT_INVALID）；全任务 `col='done'` 且 PR 已合并才可构建（mergedReady）。
表映射：`dev_builds`（append-only）+ 工件对象存储。

### DSG-C06-5 SelfTestRun 与 UiPageScore（承接 REQ-413、REQ-414、REQ-415、REQ-416、BR-09；事实源 v19EvaluateUiEvidence、verified-ui-certificate.json）

```ts
type CheckOutcome = 'pass' | 'fail' | 'skipped' | 'not-run';   // 'unknown' 一律不算已测（BR-09）
interface UiCheckScore {
  checkId: string; pageId: string; viewportId: string;
  kind: 'critical' | 'general'; status: CheckOutcome; sourceRefs: string[];
}
interface UiViewportScore {
  viewportId: string;
  critical: { passed: number; total: number; ratio: number };
  general: { passed: number; total: number; ratio: number };
  severeDeviationCount: number;                 // 关键项非 pass 数
  requiredStateIds: string[]; testedStateIds: string[];
  checks: UiCheckScore[];
  status: 'pass' | 'fail';                      // 关键 100% 且一般 ≥95% 且必测状态全测且无 skip/not-run/unknown
}
interface UiPageScore {
  pageId: string; applicableViewportIds: string[];
  viewports: UiViewportScore[];                 // 逐页面×逐适用视口（REQ-414）
  critical: { passed: number; total: number; ratio: number };
  general: { passed: number; total: number; ratio: number };
  severeDeviationCount: number;
  requiredStateIds: string[]; testedStateIds: string[];
  status: 'pass' | 'fail';                      // 全部适用视口 pass 才 pass
}
type SelfTestGate = 'functional' | 'integration' | 'ui' | 'review';   // 四门（REQ-413）gates 键 → 原型显示名（全系统一以原型显示名为准）：functional=功能检查、integration=联调与冒烟、ui=UI 符合度、review=开发审核
interface SelfTestRun {
  id: Id; projectId: Id; reportId: Code;        // 'SR-<序>'（M5）
  status: 'pass' | 'fail';
  basedOn: Json;                                // 启动时操作快照（构建指纹、基线、计划快照）
  buildFingerprint: Fingerprint;
  operation: OperationIdentity & { authorizationId?: Code; autopilotRunId?: Code };
  gates: Record<SelfTestGate, { ok: boolean; issues: { code: string; message: string; target?: string }[] }>;
  ui: { ok: boolean; issues: { code: string; message: string; target?: string }[]; pages: UiPageScore[] };
  defects: { defectId: Code; checkId: string; pageId: string; viewportId: string; severity: 'critical' | 'major'; message: string }[];
  /** 自测对照工件（REQ-415）：原型与实现两份 HTML 各自指纹，禁止渲染同一对象（BR-11） */
  comparisonArtifacts?: { prototypeHtmlFingerprint: Fingerprint; buildHtmlFingerprint: Fingerprint };
  certificateRef?: { version: string; sha256: Sha256 };   // 外部验证证书引用（verified-ui-certificate.json）
  reportFingerprint: Fingerprint;               // 报告自身内容指纹（除本字段外全量哈希）
  retestOf?: Code; retestReason?: string;       // 复测必须带实质变化与理由（REQ-416）
  at: IsoTime;
}
```

不变式：①构建前启动被拒绝（devCanStartSelfTest）；②同一失败构建无实质返工不得复测（RETEST_WITHOUT_CHANGE）；③expected matrix 不是当前基线完整集合即 `UI_EXPECTED_MATRIX_MISMATCH`；④空分母不产生 100%（ratio 分母为 0 → 判 fail/issue，BR-09）。
表映射：`dev_selftests`（append-only）+ `dev_selftest_pages`（UI 逐页×逐视口评分明细，append-only）。

### DSG-C06-6 DevReport（承接 REQ-417、BR-03）

即 `SelfTestRun` 的定稿视图：报告由执行证据自动汇总，不要求重复填报（REQ-417）。独立实体理由：报告可导出（Markdown/HTML，本期；pdf 后续——统稿 D-22），导出文件本身作为 EvidenceRef 入对象存储；历史报告不可改写。

```ts
interface DevReport {
  runId: Id;                        // → dev_selftests（唯一来源）
  reportId: Code; reportFingerprint: Fingerprint;
  exportEvidenceId?: Id;            // 导出文件证据
  current: boolean;                 // currentReportId 指针（BR-03：指针不是有效性证据）
}
```

表映射：`dev_reports`（append-only；`current` 指针在项目行上）。

### DSG-C06-7 TransferReceipt（承接 REQ-418、REQ-501）

```ts
interface TransferReceipt {
  id: Id; projectId: Id; handoffId: Code;        // 'HANDOFF-...'
  actor: Actor; at: IsoTime;
  planSnapshotId: Code; planRevision: number;
  baseline: DesignBaseline;                      // 深冻结副本（BR-03）
  buildId: Code; build: DevBuild;
  delivered: Code[]; deliveredTasks: { id: Code; title: string; kind: TaskKind; owner: string; taskRev: number; codeRev: number; commitId: string }[];
  evidenceIndex: Record<string, Code>;
  changeEvents: Json[]; dispositions: Json[];    // 变更影响链随交接
  knownIssues: { sourceId: string; type: 'approved-deferral'; reason: string; approvedBy: string; approvedAt: IsoTime }[];
  selftest: { reportId: Code; reportFingerprint: Fingerprint; status: 'pass'; basedOn: Json; gates: Json; defects: Json[] };
  designBaselineId: Code;
  handoffFingerprint: Fingerprint;               // 原型 devHash(handoff)，幂等接收键（REQ-501）
  /** 原子交接令牌（REQ-418）：旋转运行令牌、消费授权 */
  consumedAuthorizationId?: Code; rotatedRunToken?: string;
}
```

不变式：仅**当前有效且合格**的自测报告可转测试（devTransferGate + devSelfTestGate）；交接为单条命令原子提交；接收侧按 `handoffFingerprint` 幂等（重复接收不产生重复批次）。
表映射：`dev_transfer`（append-only）。

## 7. 测试验收域（tst_）

### DSG-C07-1 TestBatch（承接 REQ-501、REQ-502）

```ts
interface TestBatch {
  id: Id; projectId: Id; code: Code;              // 'TB-001'
  handoff: TransferReceipt;                       // 不可变快照（REQ-502）
  handoffFingerprint: Fingerprint;                // 幂等键
  build: DevBuild;                                // 构建身份冻结随批次
  developmentReport: { reportId: Code; status: 'pass' };  // 自测合格结论引用
  designBaselineRef: ArtifactRef;
  environment: string;                            // 环境指纹描述
  receivedAt: IsoTime; receivedBy: Actor;
}
```

不变式：批次 = 构建身份+设计基线+验收条款+环境指纹的不可变快照；新构建 = 新批次，不覆盖旧批次（REQ-502）；接收前校验构建指纹与自测结论（REQ-501）。
表映射：`tst_batches`（append-only）。

### DSG-C07-2 TestPlan（承接 REQ-503）

```ts
interface TestPlan {
  id: Id; projectId: Id; batchId: Id; code: Code;  // 'TP-<序>'
  cases: TestCase[];
  status: 'draft' | 'approved';
  previousId?: Code;                              // 批准产生新行，历史保留（原型 acceptanceApprovePlan）
  createdAt: IsoTime; approvedAt?: IsoTime; approvedBy?: Actor;   // 人工批准（BR-06）
  versionFingerprint: Fingerprint;                // 批准后范围与版本固定
}
```

不变式：从设计目录流程起草 + 至少一条人工走查（REQ-503）；批准后版本与范围固定；删除失败用例不能变绿（用例集合随批准冻结）。
表映射：`tst_plans`（append-only）。

### DSG-C07-3 TestCase（承接 REQ-503、REQ-504）

```ts
interface TestCase {
  id: Id; planId: Id; code: Code;                 // 'AT-001' / 'TC-001'
  title: string; flowId?: string;                 // 源自设计目录流程
  requirements: string[];                         // 关联 REQ
  steps: { action: string; expected: string }[];
  mode: 'auto' | 'manual'; required: boolean;        // 必测 not-run 保留在分母（REQ-504）
  priority?: 'P0' | 'P1' | 'P2';
}
```

表映射：`tst_cases`（含 `mode` 列，M8）。

### DSG-C07-4 TestRun 与 CaseRun（两级执行模型，承接 REQ-504、REQ-505、BR-09/11）

```ts
type CaseResult = 'pass' | 'fail' | 'blocked' | 'not-run' | 'not-applicable';
interface TestRun {
  // 运行级：一轮执行（覆盖计划内多条用例）；每次执行产生新记录，不改写旧记录
  id: Id; projectId: Id; batchId: Id; planId: Id; code: Code;   // 'TR-<序>'（M5）
  environment: string;
  simulated: boolean;                  // 模拟执行必须显式标注（REQ-505、BR-11）
  conclusion: 'pass' | 'fail';         // 运行级结论（由用例级结果按 BR-09 汇总）
  previousRunId?: Code;                // 重跑链：指向上一轮运行（previous_run_id）
  at: IsoTime;
}
interface CaseRun {
  // 用例级：单个用例在本轮运行中的结果
  id: Id; runId: Id; caseId: Id;
  mode: 'auto' | 'manual';
  status: CaseResult;
  evidenceIds: Id[];                   // → evd_records，每条结果必须附证据（REQ-505）
  note: string; actor: Actor; at: IsoTime;
}
```

不变式：**不适用 ≠ 通过**；`not-run/not-applicable/blocked` 一律不计通过且必测项保留在分母；零用例不得通过（REQ-504、BR-09）。
表映射：`tst_runs`（运行级，append-only）+ `tst_case_runs`（用例级，append-only）。

### DSG-C07-5 Defect（状态机，承接 REQ-506、REQ-507）

```ts
type DefectStatus = 'new' | 'confirmed' | 'fixing' | 'pending_regression' | 'closed';
type DefectSeverity = 'P0' | 'P1' | 'P2' | 'P3';   // P0 阻断/P1 严重/P2 一般/P3 轻微；原型「高/中/低」映射 P1/P2/P3（A1）
interface Defect {
  id: Id; projectId: Id; batchId: Id; runId: Id; caseId: Id; code: Code;   // 'DF-<序>'（M5）
  title: string; severity: DefectSeverity;        // 确认时定级（原型 acceptanceSaveDefect）
  evidence: string; requirements: string[];
  status: DefectStatus;
  assignee?: string;
  /** 回归证据：新批次 + 新构建 + 相同版本用例 + 通过记录（原型 regressionEvidence） */
  regression?: { batchId: Id; buildId: Code; buildFingerprint: Fingerprint; runId: Id; caseId: Id; resultFingerprint: Fingerprint };
  events: { type: 'created' | 'confirmed' | 'fix-started' | 'regression.link' | 'closed' | 'reopened';
            actor: Actor; at: IsoTime; reason?: string; severity?: DefectSeverity; evidence?: Json }[];
}
```

状态机五态：`new → confirmed → fixing → pending_regression → closed`；**重开不是状态而是事件**：回归失败产生 `reopened` 事件，缺陷回到 `confirmed`（不是 fixing）（A1）。不变式：**开发侧只能标记 pending_regression，关闭必须测试侧人工确认**（REQ-506）；关闭时实时重算回归证据指纹，不匹配拒绝（原型 acceptanceCloseDefect）；跨阶段返工链路 缺陷→新构建→新批次→回归（REQ-507）。
表映射：`tst_defects`（`events` 为 JSONB 事件流，明细同步 `audit_log`）。

### DSG-C07-6 TestReport（承接 REQ-508、BR-03）

```ts
interface TestReport {
  id: Id; projectId: Id; batchId: Id; code: Code;        // 'AR-<序>'（M5）
  basis: { batchId: Id; planId: Id; runId: Id; defectIds: Id[] };
  basisFingerprint: Fingerprint;        // 原型 reportBasis 哈希；执行或缺陷变化即失配需重新汇总
  conclusion: 'pass' | 'fail';          // 可定稿为「不通过」（REQ-508）
  issues: string[]; results: CaseRun[];
  status: 'draft' | 'finalized';
  finalizedBy?: Actor; finalizedAt?: IsoTime;
  previousReportId?: Code;
  simulated: boolean;
}
```

不变式：定稿 ≠ 放行（REQ-508）；报告历史不可改写（BR-03）；`basisFingerprint` 与实时基础不一致时禁止定稿/放行（原型 acceptanceFinalizeReport 校验）。
表映射：`tst_reports`（append-only）。

### DSG-C07-7 ReleaseDecision（承接 REQ-509、REQ-510、REQ-712）

```ts
interface ReleaseDecision {
  id: Id; projectId: Id; batchId: Id; reportId: Id; code: Code;   // 'AD-<序>'（M5）
  type: 'release' | 'conditional_release' | 'reject';
  /** 条件放行的豁免清单：仅明确列举的中低等级问题；P0/P1、必测未执行、证据失真不可豁免（REQ-509） */
  waivers: { issueRef: string; severity: 'P2' | 'P3'; reason: string; approvedBy: Actor }[];
  reportFingerprint: Fingerprint;
  actor: Actor; at: IsoTime;
}
```

不变式：决定为不可变工件，随报告与批次身份保存（REQ-510）；豁免项 severity 仅 P2/P3；放行前置 = 当前有效定稿报告且结论 pass（或条件放行策略求值通过，REQ-711 策略引擎）；放行通过的批次+证据包构成 REQ-712 发布适配接口的唯一输入形态。
表映射：`tst_decisions`（append-only）。

## 8. AI 编排域（ai_）

> **Pi SDK 运行时映射注（REQ-615，2026-09-20 用户决策）**：本章实体均为**平台持久层实体**，不因引入 Pi SDK 而推翻；Pi 侧为运行时映射——`AiSession` ↔ Pi `SessionManager`（JSONL 会话树，fork/branch、自动压缩）、`ToolCall` ↔ Pi AgentTool 调用事件（pi-agent-core turn/message 事件流）、`ModelConfig` ↔ Pi `ModelRegistry`（多供应商模型注册与会话内切换）、`UsageRecord` ↔ 从 Pi 消息结果提取的 Usage（token/成本原始数据，平台汇总落库）。平台实体保留审计、门禁、指纹等自有字段；Pi 运行态（会话树 JSONL 等）不作为平台证据来源，证据仍以 M11 登记为准。

### DSG-C08-1 AiSession（承接 REQ-601、REQ-602）

```ts
interface AiSession {
  id: Id; projectId: Id;
  ctx: string;                       // 页面上下文：material/req/design/dev/test（REQ-601 上下文感知）
  name: string;
  createdAt: IsoTime; createdBy: Id;
  modelId?: Id; thinkLevel?: ThinkLevel;   // 会话级覆盖，缺省用助手默认
  /** 树形引用：会话分支（fork/branch）由 Pi SessionManager 的 JSONL 会话树承载（REQ-615 扩展）；
      平台侧仅存父会话/分支点引用，不复制会话内容；JSONL 运行态不作为平台证据来源 */
  treeRef?: { parentSessionId?: Id; branchPointMessageSeq?: number };
}
type ThinkLevel = 'low' | 'mid' | 'high';  // 思考强度（REQ-604，原型 thinkLevel）
```

表映射：`ai_sessions`。

### DSG-C08-2 AiMessage（承接 REQ-603）

```ts
interface AiMessage {
  id: Id; sessionId: Id; seq: number;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  /** 流式状态：停止后不残留半截状态（REQ-603）；completed/done 后不可变；failed=模型/网络失败终态（LLD-2 DSG-F02-12），不产生版本记录；
      `paused` 为运行时缓冲层状态，不落 ai_messages.status（落库枚举 streaming/done/stopped/failed 见 LLD-4 DSG-D08-2） */
  stream: { state: 'streaming' | 'paused' | 'stopped' | 'failed' | 'done'; tokensSoFar: number };
  toolCallId?: Id;
  taskCards?: { name: string; status: string }[];   // 章节级 Task（原型 msgs[].tasks）
  modelId?: Id; promptVersionId?: Id; inputFingerprint?: Fingerprint;  // 生成记录提示词版本+输入指纹（HLD ADR-6）
  at: IsoTime;
}
```

表映射：`ai_messages`。

### DSG-C08-3 ToolCall（承接 REQ-605）

```ts
interface ToolCall {
  id: Id; sessionId: Id; messageId?: Id;
  name: string;                      // 注册表内工具名（AGENT_TOOLS / registerTool）
  args: Json;                        // 参数经注册表 schema 校验
  status: 'running' | 'done' | 'failed' | 'denied';
  detail: string;                    // 原型 tool.detail：耗时/tokens/命中摘要
  durationMs?: number; tokens?: number;
  auditId?: Code;                    // 写类工具必须产生审计（REQ-706）
  at: IsoTime;
}
```

不变式：未注册工具拒绝执行；定稿/放行类接口对 AI 通道技术上不可达（REQ-613、HLD ADR-6）。
表映射：`ai_tool_calls`。

### DSG-C08-4 PromptVersion（承接 REQ-609）

```ts
interface PromptVersion {
  id: Id; projectId?: Id;                   // 空 = 全局默认
  owner: { kind: 'assistant' | 'agent'; agentId?: string };   // 全局助手基底/叠加版本，或子 Agent
  name: string; text: string;
  current: boolean;                          // 每个 owner 至多一个 current
  seq: number;                               // 版本号，可回滚（REQ-609）
  createdAt: IsoTime; createdBy: Actor;
}
```

表映射：`ai_prompt_versions`（append-only + current 指针）。

### DSG-C08-5 ModelConfig（承接 REQ-611）

```ts
interface ModelConfig {
  id: Id; name: string; provider: string;
  enabled: boolean; conn: 'ok' | 'fail' | 'untested';
  keyRef: string;                  // 密钥加密存储引用，永不回显明文（HLD §6；原型只存掩码 key）
  baseUrl: string; supportsThinking: boolean; contextWindow: number;
  routes: { purpose: 'planning' | 'generation' | 'review' | 'parse' | 'default'; }[];  // 按用途路由（REQ-611）
}
```

表映射：`ai_models`（密钥密文列见 LLD-4/LLD-7）。

### DSG-C08-6 UsageRecord（承接 REQ-612、README S9）

```ts
interface UsageRecord {
  id: Id; projectId: Id; modelId: Id;
  purpose: string;                  // 生成/精修/翻译/评审…
  promptTokens: number; completionTokens: number;
  durationMs: number;
  cost: number; currency: string;   // 按模型价目表估算
  sessionId?: Id; delegationId?: Id;
  at: IsoTime;
}
```

表映射：`ai_usage`（append-only）。

### DSG-C08-7 Delegation（承接 REQ-610、REQ-803）

```ts
type DelegationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_timeout' | 'cancelled';   // 委派状态六值，落库以 LLD-4 DSG-D08-7 为权威（二轮评审裁决）：failed_timeout 为独立超时终态，不再以 failed + errorMessage 表达
interface DelegationTarget {        // 注册式目标（原型 targets；真实化为适配器配置）
  id: string;                       // 'pi_native' / 'claude_code' / 'codex_cli'
  name: string; desc: string;
  capabilities: string[];           // 'parse.pdf' / 'codegen' …
  status: 'available' | 'unconfigured' | 'disabled';
  adapterKind: 'local-cli' | 'remote-agent' | 'builtin';
}
interface Delegation {
  id: Id; projectId: Id; code: Code;         // 'd1'
  targetId: string; task: string;
  status: DelegationStatus;
  cost?: number; durationMs?: number;
  evidenceIds: Id[];                // 产出经证据通道回传（HLD ADR-8）
  startedAt?: IsoTime; finishedAt?: IsoTime; createdBy: Actor;
}
```

表映射：`ai_delegation_targets`（注册式目标，M8）、`ai_delegations`。

## 9. 策略与平台管理域（sys_）

### DSG-C09-1 PolicyGate（承接 REQ-711、BR-06、HLD ADR-7）

```ts
type GatePoint =              // 放行确认点全集 7 点（A6，小写点式）
  | 'req.doc.finalize'            // 需求文档定稿
  | 'design.prototype.finalize'   // 原型定稿（共同基线）
  | 'dev.plan.approve'            // 计划批准
  | 'dev.transfer'                // 转测试
  | 'test.plan.approve'           // 测试计划批准
  | 'test.report.finalize'        // 报告定稿
  | 'test.release';               // 报告放行/交付决定
interface PolicyGate {
  id: Id; projectId: Id; point: GatePoint;
  mode: 'manual' | 'auto';            // 默认全部 manual（BR-06）
  /** auto 模式前置条件集：结构化检查项（证据有效、BR-07/09 满足…） */
  preconditions: { check: string; params: Json }[];
  switchedBy?: Actor; switchedAt?: IsoTime; switchReason?: string;   // 模式切换本身是 manual 命令
}
interface PolicyGateEval {            // 每次求值留痕（REQ-711）
  id: Id; gateId: Id; at: IsoTime;
  mode: 'manual' | 'auto';
  inputFingerprint: Fingerprint;      // 求值时刻证据指纹
  result: 'passed' | 'blocked';
  failures: { check: string; code: string; message: string }[];   // failures[].code 取值闭集见 §15（二级 issue code）
  actor: Actor;                       // manual 时为确认人；auto 时为 system + 授权链
}
```

不变式：AI 在 manual 策略下永不可替代（BR-06）；auto 放行仍受 BR-07/BR-09 约束，证据不满足同样阻断；每次自动放行逐次留痕。
表映射：`policy_gates`、`policy_gate_events`（append-only）。

### DSG-C09-2 Setting（承接 REQ-705）

```ts
interface Setting {
  id: Id; projectId?: Id;            // 空 = 实例级
  scope: 'system' | 'prompts' | 'models' | 'agents' | 'project';
  key: string; value: Json;
  secret: boolean;                   // true 时 value 为密文引用（REQ-710、HLD §6）
  updatedAt: IsoTime; updatedBy: Actor;
}
```

表映射：`sys_settings`。

## 10. 命令与事件类型

### DSG-C10-1 命令总线类型（承接 REQ-408、BR-04、HLD ADR-3）

所有写操作 = 封闭命令枚举中的一条，统一管线 `鉴权 → 幂等检查 → prepare（纯计算）→ publish（单 DB 事务：业务写入+事件追加+审计追加）→ flush（效果入队幂等）`。未知命令拒绝（注册表码 `COMMAND_UNKNOWN`，原型 `DEV_EVENT_UNKNOWN`）。

```ts
interface CommandEnvelope<T extends string = string, P = unknown> {
  type: T;                    // 封闭枚举，见 C10-2
  payload: P;
  actor: Actor;               // 含操作身份/归属（BR-08/13）
  idempotencyKey: string;
  expectedRevision?: number;  // 乐观锁（REQ-210、BR-12）
  clientAt: IsoTime;
}
interface CommandReceipt {
  commandId: Code; committed: boolean;   // 命令收据编号 'RCPT-<序>'（M5）
  committedIdentity?: Fingerprint;      // 提交后的工件内容身份
  presentationPending?: boolean;        // UI 效果待呈现（原型写事务重设计 §19）
  effects: EffectLedgerEntry[];         // 逐效果收据
  errorCode?: string;
}
```

### DSG-C10-2 命令枚举（按域分组；承接 REQ-408、REQ-205、REQ-409、BR-04）

**(a) 文档内容 12 命令**（需求/设计/原型共用；事实源《原型写事务重设计.md》命令表）：

```ts
type DocContentCommand =
  | 'doc.save-html' | 'doc.undo' | 'doc.redo'
  | 'doc.switch-version'        // 前置：modified=false 且 pending 为空，否则零写拒绝
  | 'doc.commit-version'
  | 'doc.accept-pending' | 'doc.reject-pending'
  | 'doc.propose-pending'       // AI 提案入待确认，不直接落稿
  | 'doc.import-draft'
  | 'doc.unlock'                // 解除定稿 readiness，触发下游输入失效观察（BR-07）
  | 'doc.add-reference' | 'doc.remove-reference';
```

Payload 例：`doc.save-html` → `{ documentId: Id; html?: string; sections?: DocSection[] }`；`doc.accept-pending` → `{ documentId: Id; patchId: Id }`；`doc.propose-pending` → `{ documentId: Id; patch: Omit<PendingPatch,'id'|'status'>; operation: OperationIdentity }`。

**(b) 原型操作命令**（REQ-305/306/308；原型 `prototype.*` 事务）：

```ts
type PrototypeCommand =
  | 'prototype.plan.start' | 'prototype.plan.complete' | 'prototype.plan.stale'
  | 'prototype.generate.start' | 'prototype.generate.complete' | 'prototype.generate.stale'
  | 'prototype.check.start' | 'prototype.check.complete' | 'prototype.check.stale'
  | 'prototype.start.recover'              // 启动失败恢复
  | 'prototype.finalize'                   // 人工共同定稿（经 PolicyGate）
  | 'prototype.content.*';                 // 即 (a) 组命令作用于原型工作副本
```

**(c) 开发域命令**（事实源 `V17_DEV_ACTIONS` + `V18_ACTIONS` + V19 增补，即原型 `DEV_ACTION_REGISTRY` 全集）：

```ts
type DevCommand =
  // 计划与目录覆盖（REQ-401/403/404/419）
  | 'devCreateTask' | 'devSaveTask' | 'devSplitTask' | 'devDoMerge'
  | 'devRejectSuggestion' | 'devAdoptSuggestion' | 'devAdoptAll' | 'devImproveTasks' | 'devSchedule'
  | 'devSubmitPlan' | 'devApprovePlan'
  | 'devConfirmCoverageItem' | 'devConfirmAllCoverage' | 'devApplyDefer' | 'devUndefer'
  | 'devApplyImpact' | 'devConfirmBaseline' | 'devConfirmRework'
  | 'identify.start' | 'identify.complete' | 'identify.stale'
  | 'input.observe' | 'input.reconcile'          // 上游输入失效观察（REQ-420）
  // 任务执行（REQ-405/407）
  | 'devStart' | 'devPauseTask' | 'devResumeTask' | 'devStopTask' | 'devBumpProg' | 'devSubmitReview'
  | 'task.run' | 'task.progress' | 'task.run.invalidate'
  // 质量 / PR（REQ-407/411）
  | 'quality.start' | 'quality.complete' | 'quality.stale'
  | 'runTaskUt' | 'prToggleCheck' | 'doPrSkip' | 'prMerge' | 'pr.merge.basis'   // 合并依据四类之一（REQ-411）
  | 'ci.callback.receive'                            // 外部 CI 回传接收（LLD-5 A06-21；投递 ID 幂等，落 dev_ci_reports，LLD-4 DSG-D06-9）
  // 构建（REQ-412）
  | 'build.start' | 'build.complete' | 'build.stale' | 'build.ui.attach' | 'runIntegrationBuild'
  // autopilot（REQ-409/410，V18）
  | 'autopilot.init' | 'prepare.start' | 'prepare.complete' | 'prepare.stale' | 'prepare.start.failed' | 'prepare.revise'
  | 'autopilot.approve.start' | 'autopilot.advance' | 'autopilot.pause' | 'autopilot.resume'
  | 'autopilot.stop' | 'autopilot.takeover' | 'autopilot.mode.set' | 'autopilot.block'
  | 'autopilot.awaiting-transfer' | 'autopilot.start.failed' | 'autopilot.rework' | 'autopilot.merge'
  | 'ai-review.start' | 'ai-review.complete' | 'ai-review.stale' | 'ai-review.start.failed'
  // 开发自测（REQ-413/416，V19）
  | 'selftest.init' | 'selftest.start' | 'selftest.complete' | 'selftest.stale' | 'selftest.start.failed'
  // 交接与通用
  | 'test.handoff' | 'operation.start.failed' | 'project.leave';
```

**(d) 资料域命令**（REQ-102~115）：

```ts
type MaterialCommand =
  | 'material.upload' | 'material.zip.commit'       // ZIP 整包验证通过才一次提交（REQ-103）
  | 'material.upload.create' | 'material.upload.part'       // 分片上传会话发起/分片登记（LLD-5 A03-1/A03-2，落 mat_uploads，LLD-4 DSG-D03-7）
  | 'material.upload.complete' | 'material.upload.abort'   // 完成合并（含 ZIP 整包校验）/显式中止（LLD-5 A03-3/A03-18）
  | 'material.zip.extract'                          // 行内解压（REQ-104）
  | 'material.parse.start' | 'material.parse.retry'
  | 'material.file.finalize' | 'material.content.finalize'
  | 'material.parsed.delete'                        // 带下游依赖守卫（REQ-109）
  | 'material.bulk.start' | 'material.bulk.stop' | 'material.bulk.retry' | 'material.bulk.finalize'
  | 'material.reference.attach' | 'material.reference.detach';
```

**(e) 测试验收域命令**（REQ-501~510；原型 acceptance 系列函数在真实产品一律命令化）：

```ts
type TestCommand =
  | 'batch.receive'                       // 幂等（handoffFingerprint）
  | 'plan.draft' | 'plan.approve'
  | 'run.execute' | 'run.manual.record'   // 人工结论不由自动执行代填
  | 'defect.create' | 'defect.confirm' | 'defect.fix-start'
  | 'defect.link-regression' | 'defect.close' | 'defect.reopen'
  | 'report.generate' | 'report.finalize'
  | 'delivery.authorize'                  // 经 PolicyGate（test.release）
  | 'batch.block' | 'batch.unblock';      // 批次异常阻断（异常终态）与人工恢复（LLD-2 F02-8）
```

**(f) AI 与平台命令**（REQ-601~614、REQ-701~711）：

```ts
type AiCommand =
  | 'ai.session.create' | 'ai.session.switch'
  | 'ai.message.send' | 'ai.message.pause' | 'ai.message.resume' | 'ai.message.stop'
  | 'ai.tool.invoke'                      // 注册表校验 + 审计
  | 'ai.prompt.publish' | 'ai.prompt.rollback'
  | 'ai.model.upsert' | 'ai.model.test' | 'ai.model.route.set'
  | 'ai.delegate.create' | 'ai.delegate.cancel';
type SysCommand =
  | 'project.create' | 'project.update' | 'project.open' | 'project.leave'
  | 'policy.switch'                       // manual↔auto，本身永远 manual（REQ-711）
  | 'setting.update' | 'notification.read'
  | 'rtm.deferred.mark' | 'rtm.deferred.unmark';
```

### DSG-C10-3 领域事件类型（append-only 事件表载荷；承接 REQ-703、REQ-706）

事件表 `evd_events`（append-only），载荷：

```ts
interface DomainEvent<T = Json> {
  eventId: Code; projectId: Id;
  type: string;                  // 见下
  payload: T;
  actor: Actor; at: IsoTime;
  commandId?: Code;              // 产生本事件的命令
  fingerprint?: Fingerprint;     // 相关工件内容身份
}
type DomainEventType =
  | 'artifact.version' | 'artifact.final'               // 原型 S.events 类型
  | 'stage.material' | 'stage.req' | 'stage.design' | 'stage.dev' | 'stage.test'
  | 'material.parsed' | 'material.finalized' | 'material.bulk.done'
  | 'req.version.committed' | 'req.doc.finalized' | 'rtm.health.changed'
  | 'design.catalog.built' | 'design.prototype.generated' | 'design.prototype.checked' | 'design.baseline.confirmed'
  | 'baseline.change' | 'plan.invalidate' | 'dev.task.moved' | 'dev.pr.merged' | 'dev.build.completed'
  | 'dev.selftest.completed' | 'dev.transfer.confirmed'
  | 'test.batch.received' | 'test.run.completed' | 'test.defect.changed' | 'test.report.finalized' | 'test.delivery.decided'
  | 'ai.message.completed' | 'ai.tool.invoked' | 'ai.delegation.finished'
  | 'policy.switched' | 'policy.auto-released';
```

不变式：事件只追加；事件产生失败 = 命令失败（BR-04 同事务）；通知（Notification）由事件派生，是 readiness 不是证据。

## 11. DTO 与 API 载荷

### DSG-C11-1 DTO 命名规范（承接 REQ-803、HLD DSG-M02；端点明细在 LLD-5）

- 请求：`<资源><动作>Request`（如 `DocCommitRequest`、`BatchReceiveRequest`）；查询：`<资源>Query`；响应：`<资源>Response` / `<资源>DetailResponse`。
- 写操作统一走命令端点，载荷即 `CommandEnvelope`；响应统一 `CommandReceipt`（DSG-C10-1）。
- 门禁类响应统一：

```ts
interface GateResult {
  ok: boolean;
  issues: { code: string; message: string; target?: string }[];   // 缺口必须具体（REQ-208/702）；code 取值闭集见 §15（二级 issue code）
  fingerprint?: Fingerprint;   // 求值所依据的实时指纹
}
```

- 列表统一 `Page<T> = { items: T[]; total: number; cursor?: string }`（REQ-801/802 分页）。

### DSG-C11-2 代表 DTO 示例（承接 REQ-202、REQ-418、REQ-501、REQ-414）

```ts
// 文档提交（REQ-203/209）
interface DocCommitRequest { documentId: Id; note: string; expectedLockVersion: number; }
interface DocVersionResponse extends DocVersion { readonly: true; }

// 转测试确认（REQ-418，经 PolicyGate dev.transfer）
interface DevTransferConfirmRequest { projectId: Id; confirmNote: string; }
interface DevTransferConfirmResponse { receipt: TransferReceipt; gate: GateResult; }

// 批次接收（REQ-501，幂等）
interface BatchReceiveRequest { projectId: Id; }
interface BatchReceiveResponse { batch: TestBatch; alreadyExisted: boolean; }

// UI 符合度查询（REQ-414）
interface UiScoreResponse { runId: Code; ok: boolean; pages: UiPageScore[]; defects: SelfTestRun['defects']; }

// 错误响应（§14 错误体系的传输形态）
interface ApiError { code: string; message: string; details?: Json; retryable: boolean; traceId: string; }
```

## 12. 关键值对象

### DSG-C12-1 指纹与规范化（承接 BR-01、BR-02）

见 DSG-C01-2/C02-2。补充约定：指纹计算输入必须剔除时间戳与 readiness 字段；引用方存「被引用指纹」，查询门禁时实时比对（HLD ADR-4）；工件内容哈希同时作为对象存储 key（内容寻址）；规范化序列化规则（键序/数值最短往返格式/Unicode NFC 预规范化/JSONB 往返警示）以 LLD-2 DSG-F04-1 为权威，本册不另立。

### DSG-C12-2 版本号策略（承接 REQ-203、BR-05）

文档/计划/目录版本号 = 各自容器内单调递增整数，**不复用**；再定稿产生新的 `finalizationSeq`/批次号（原型 `_finalizationSeq`）；`currentXxxId`/`finalVersion` 只是指针（BR-03）。计划用 `revision`（失效即 +1）+ `snapshotId` 双层。

### DSG-C12-3 操作身份四元组（承接 BR-08、REQ-410）

```ts
interface OperationIdentity {
  operationId: string;   // runId
  opToken: string;       // 启动签发；内容写入使其旋转失效（原型 opToken+='-stale-' 语义）
  action: string;        // dispatchAction
  owner: string;         // 'design-human' | 'autopilot' | actorId
}
```

规则：回调提交前重验 ①操作仍 `running` ②opToken 匹配 ③实时指纹与启动快照一致（原型 `designPrototypeOperationValid`/`devExecuteOperationValid`）；任一不符 → stale 登记 + 严格零写。

### DSG-C12-4 autopilot 归属三元组（承接 BR-13、REQ-409/410）

```ts
interface AutopilotAttribution {
  runId: string; runToken: string; authorizationId: string;
}
```

配套授权结构（原型 `autopilot.approve.start` 构造）：

```ts
interface AutopilotAuthorization {
  authorizationId: Code; idempotencyKey: string; status: 'active' | 'consumed' | 'revoked';
  preparationRevisionId: string; preparationFingerprint: Fingerprint;
  planSnapshotId: Code; planFingerprint: Fingerprint;
  baselineKey: string; inputFingerprint: Fingerprint;
  taskIds: Code[]; taskRevisions: Record<Code, number>;
  acceptedProposalIds: string[]; coverageDecisionIds: string[];
  qualityTargets: Record<Code, { line: number; branch: number; scenarioTypes: string[] }>;
  scope: { development: boolean; unitCi: boolean; aiReview: boolean; merge: boolean; integrationBuild: boolean; transferToTest: boolean };  // 转测试恒 false：停在待人工（REQ-409）
  approvedBy: Actor; approvedAt: IsoTime;
}
```

规则：人工操作身份独立于 autopilot；暂停/停止/接管只影响当前运行拥有的操作（REQ-410）；授权被消费（转测试）或吊销后，持旧 `runToken` 的一切回调零写。

### DSG-C12-5 ArtifactRef（承接 BR-01、BR-03、REQ-309）

```ts
interface ArtifactRef {
  artifactId: string;      // 'PRD' | 'HLD' | 'MOD'… | 'PROTO' | 具体资源 id
  versionId: string; finalizationId: string;
  fingerprint: Fingerprint;
}
```

跨域引用一律用 ArtifactRef，不复制内容（HLD §3 模块间规则）。

## 13. 不变式清单（跨实体，可执行断言风格）

> 断言以 `assert <编号>: <谓词>` 书写，在命令 publish 前置/后置校验与 LLD-2 流程中引用。

### DSG-C13-1 发布不变式（BR-05；REQ-203/209/210）

```
assert INV-DOC-1: draft.baseVersion ∈ document.versions.map(v=>v.v)
assert INV-DOC-2: draft.modified ⟺ fingerprint(draft.sections) ≠ draft.baseContentFingerprint
assert INV-DOC-3: ∀v ∈ versions: 已提交版本字节不可变（内容寻址指纹校验一致）
assert INV-DOC-4: 每次发布操作恰好追加 0 或 1 条版本记录；版本号不复用
assert INV-DOC-5: 单一工作草稿：每文档至多一行 req_drafts；switch-version 前置 modified=false ∧ pending=∅
assert INV-DOC-6: 已丢失的历史版本绝不重建或谎称修复（BR-05），拆三条机器可验子句：
  INV-DOC-6a 版本链连续：∀文档 versions 的 v 构成 1..N 连续正整数序列（缺号即断链证据）
  INV-DOC-6b 断链处置：启动一致性校验检出断链/指纹不等 → 服务拒绝开放并告警（LLD-7 DSG-N03-4），
             禁止以补写既有 v 的方式「修复」
  INV-DOC-6c 恢复只追加：恢复与补记路径（LLD-2 DSG-F03-4）对版本历史表无 UPDATE、
             无指向既有 v 的 INSERT
```

### DSG-C13-2 不可变约束（BR-03；REQ-417/502/508/510）

```
assert INV-IMM-1: append-only 表无 UPDATE/DELETE 执行路径（DB 角色强制）；
                  append-only 表清单以 LLD-4 §D01-4 为唯一维护点（本册不复制清单）
assert INV-IMM-2: currentXxxId / valid / finalized 均为指针或 readiness，不作为有效性证据；
                  有效性 = 实时指纹重算比对（HLD ADR-4/5）
                  验证方式：【审】静态扫描门禁/放行判定路径，不得仅以指针字段作为通过依据；
                  【测】篡改用例——令指针指向已失效对象，门禁必须实时重算指纹并拒绝放行
assert INV-IMM-3: 哈希链：∀audit[i]: audit[i].prevHash = hash(audit[i-1])
```

### DSG-C13-3 评分约束（BR-09；REQ-414/504）

```
assert INV-SCORE-1: 视口通过 ⟺ critical.ratio=1 ∧ general.ratio≥0.95 ∧ 必测状态全测
                    ∧ ¬∃check.status ∈ {skipped, not-run}；
                    status 取值闭集 = {pass, fail, skipped, not-run}——闭集外结果（原型 unknown）
                    不是合法 status，一律记 issue `UI_OUTCOME_UNKNOWN` 且按不通过计
                    （与 LLD-2 DSG-F05-2 伪代码一致，消除「unknown 既被禁止又可能存在」的矛盾）
assert INV-SCORE-2: 页面通过 ⟺ 全部适用视口通过；不以跨页/跨视口平均掩盖单项不达标
assert INV-SCORE-3: 分母 = 基线冻结 matrix（expectedCritical/GeneralCheckIds）；
                    观察证据缺项→not-run、多项→UI_CHECK_EXTRA、定义不符→UI_CHECK_DEFINITION_MISMATCH
assert INV-SCORE-4: 空分母不产生 100%（total=0 → 记录 issue，不得判 pass）
assert INV-SCORE-5: 用例执行：not-applicable ≠ pass；必测 not-run 保留在分母；零用例不得通过
```

### DSG-C13-4 其他跨实体不变式（BR-01/02/04/07/08/11/12/13/14、REQ-111/416/506）

```
assert INV-FP-1: 引用方存储的 ArtifactRef.fingerprint ≠ 被引用方实时指纹 ⟹ 引用失效（stale），禁止放行
assert INV-FP-2: readiness 字段（modified、unread、待办数）不参与任何内容指纹（BR-02）
assert INV-TX-1: 审计或事件追加失败 ⟹ 命令整体回滚，业务零写、UI 不显示成功（BR-04）
assert INV-ASYNC-1: 回调提交前 OperationIdentity 四元组与实时指纹重验失败 ⟹ 严格零写（BR-08）
assert INV-EVID-1: 对照比较两侧指纹必须不同来源对象（REQ-415/BR-11）；
                   simulated=true 的证据不得充作真实执行结论
assert INV-BULK-1: 批量作业弹窗打开时整批快照、点击开始时整批复核（不一致整批中止）；
                   执行中变化行逐行跳过（skipped），不阻塞整批提交（REQ-111/BR-12）
assert INV-RETEST-1: 复测要求 buildFingerprint 或任务/提交实质变化，否则 RETEST_WITHOUT_CHANGE（REQ-416）
assert INV-DEFECT-1: defect.close 仅测试侧人工且回归证据指纹实时匹配（REQ-506）
assert INV-AUTO-1: autopilot 操作必带 AutopilotAttribution；授权 scope.transferToTest 恒 false（REQ-409）
assert INV-EFFECT-1: 效果 ledger 每项恰好终结于 done/failed/stale 之一；重启补记幂等（BR-14）
```

## 14. 错误类型体系（一级：DomainError）

### DSG-C14-1 错误码风格、两级制边界与类层次（承接 REQ-408、REQ-706、BR-04、REQ-803）

错误码风格统一：**UPPER_SNAKE、无域前缀**（如 `GATE_BLOCKED`、`STALE_EVIDENCE`、`RETEST_WITHOUT_CHANGE`、`AUDIT_WRITE_FAILED`、`VERSION_CONFLICT`），避免与 REQ-/DSG- 编号撞名。

**两级制边界（2026-09-20 波次 0 评审裁决 R-01，见《统稿裁决记录》）**：

- **一级 = DomainError（业务错误码）**：命令/Provider 失败与统一错误响应 `ApiError.error.code`（DSG-C11-2、LLD-5 DSG-A01-4）的**顶级错误码**；一次失败响应恰好一个顶级码，并映射唯一 HTTP 状态。注册表 = 本节 DSG-C14-2，全库唯一。
- **二级 = 门禁/缺口子码（issue code）**：**不单独作为 `error.code` 返回**，仅作为结构化明细出现——门禁求值 `GateResult.issues[].code`（DSG-C11-1）与 423 响应 `error.details.issues[].code`（LLD-5 DSG-A11-4）、原型检查/来源审计报告 `issues[].code`、上传校验 `error.details.violations[].code`、autopilot 运行 `blocker.code`。注册表 = §15，全库唯一。
- 两级闭集**互不重叠**：一个码值只在一级注册。门禁阻断时顶级码恒为 `GATE_BLOCKED`（或更具体的一级码，如 `STALE_EVIDENCE`），具体缺口用二级码逐项表达；二级码不映射 HTTP 状态。
- LLD-1/LLD-2/LLD-5 等各处只引用两级注册表，不再自定前缀码；闭集由脚本 `tools/check-codes.mjs` 强制校验（LLD-7 DSG-N06-3），新增码值必须先注册后使用。

```ts
abstract class DomainError extends Error {
  abstract readonly code: string;        // UPPER_SNAKE，无域前缀，取值见 DSG-C14-2 注册表
  readonly httpStatus: number;           // 传输层映射（LLD-5）
  readonly retryable: boolean = false;
  readonly details?: Json;               // 门禁阻断时含 issues[]（二级码，§15）
}
class MaterialError extends DomainError {}    // 资料域
class RequirementError extends DomainError {} // 需求域
class DesignError extends DomainError {}      // 设计域
class DevError extends DomainError {}         // 开发域
class TestError extends DomainError {}        // 测试验收域
class AiError extends DomainError {}          // AI 编排域
class EvidenceError extends DomainError {}    // 证据/审计域
class PolicyError extends DomainError {}      // 策略门禁域
class SystemError extends DomainError {}      // 平台/命令事务横切
```

### DSG-C14-2 DomainError 注册表（一级码全集，按域分组；事实源原型错误字符串）

**(a) 平台/命令事务横切**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `COMMAND_UNKNOWN` | 命令不在封闭注册表 | 400 | 命令总线收到未知 type（LLD-2 F03-1；原型 DevStore.transact 的 DEV_EVENT_UNKNOWN） |
| `DIRECT_WRITE_DENIED` | 绕过命令直写领域状态 | 403 | DevStore directWrite 守卫（REQ-408/BR-04） |
| `STATE_OWNER_INVALID` | 状态归属项目错误 | 403 | transact 项目归属校验（原型 DEV_STATE_OWNER_INVALID） |
| `VERSION_CONFLICT` | 乐观锁版本冲突（含 publish 阶段身份失配） | 409 | `If-Match`/`baseVersion`/expectedRevision 不符（LLD-5 A01-3、REQ-210、BR-12） |
| `IDEMPOTENCY_CONFLICT` | 同 Idempotency-Key/命令号不同载荷 | 409 | 幂等检查（LLD-5 A01-3） |
| `AUDIT_WRITE_FAILED` | 审计写入失败 → 命令整体回滚，业务零写 | 500 | publish 事务（BR-04、HLD ADR-3） |
| `FINGERPRINT_MISMATCH` | 引用指纹失配（stale） | 409 | 引用方存指纹 vs 实时指纹比对（BR-01/07、HLD ADR-4） |
| `STALE_EVIDENCE` | 证据/依据已失效（上游内容变化） | 409（门禁语境 423） | 门禁求值、回调提交前重验、基线/参考快照比对（BR-07/08、LLD-5 A03-15/A06-19 等） |
| `OPERATION_STALE` | 异步操作 token 失效/晚到回调（严格零写） | 409 | 回调身份重验（LLD-5 A06-11/A11-2、BR-08/13） |
| `OPERATION_START_FAILED` | 异步操作启动失败（也落一条命令审计） | 500 | operation.start.failed（REQ-410） |
| `PREPARED_TAMPERED` | prepare 产物/冻结快照被篡改 | 409 | publish 复核 preparedFingerprint（LLD-2 F03-1/F02-1） |
| `INVARIANT_VIOLATION` | 发布前不变式断言失败 → 整命令回滚 | 500 | §13 各 INV 断言（BR-04/05） |
| `RUN_OWNERSHIP_MISMATCH` | 回调不归属当前运行 → 零写并审计 | 409 | autopilot 运行归属校验（LLD-1 M06、BR-13） |
| `VALIDATION_FAILED` | 请求体/参数/枚举/配置项校验失败 | 400 | 通用（LLD-5 A01-4；含设置项非法、结果枚举非法） |
| `INVALID_STATE` | 状态机非法流转/前置状态不满足 | 422 | 通用（LLD-5 A01-4；任务/解析/ZIP/缺陷/执行/流各状态机共用） |
| `UNAUTHENTICATED` | 未认证/凭证无效 | 401 | 鉴权中间件（LLD-5 A01-2） |
| `FORBIDDEN` | 已认证但无权限/项目越界 | 403 | 鉴权与项目隔离（LLD-5 A01-1/2；项目越界缺口子码见 §15 `PROJECT_SCOPE`） |
| `NOT_FOUND` | 资源不存在 | 404 | 通用（含 executionId 不存在） |
| `RATE_LIMITED` | 限流（含委派并发上限） | 429 | LLD-5 A01-4、A08-8 |
| `INTERNAL` | 未分类服务端错误 | 500 | 兜底（LLD-5 A01-4） |
| `CHANNEL_ERROR` | SSE 通道建立/续传失败 | 500 | M02 SseGateway |
| `BACKUP_FAILED` | 备份导出失败 | 500 | M13 BackupService（REQ-708） |

**(b) 资料域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `UPLOAD_REJECTED` | 上传/ZIP 安全校验失败，逐项违规见 `details.violations[]`（子码 §15(j)） | 400 | 上传会话创建/ZIP 整包校验（LLD-5 A03-1/A03-3，REQ-102/103；含文件类型不支持、配额超限） |
| `PARSE_FAILED` | 解析失败（含重试超限） | 422 | material.parse.start/retry（REQ-107） |
| `REFERENCE_NOT_FINAL` | 引用资料未定稿（非 content_final） | 422 | 需求/设计生成与 AI 上下文装配的参考门禁（REQ-114、LLD-5 A04-4/A08-3） |
| `REFERENCE_STALE` | 生成期间参考内容/参考基线变化，拒绝提交 | 409 | 生成提交前参考指纹复核（REQ-115、LLD-5 A04-4/A08-3） |

**(c) 需求/设计文档域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `DRAFT_BASE_MISMATCH` | 草稿基点指纹不符 | 409 | 读草稿重验 baseContentFingerprint（原型 readPrototypeWorking） |
| `PATCH_BASE_STALE` | 待确认补丁基线已变化/目标文本不再精确匹配 | 409 | doc.propose-pending / doc.accept-pending（REQ-205） |
| `VERSION_LOCKED` | 已定稿文档原地修改 | 409 | 对 finalized 文档的写命令（REQ-209） |
| `VERSION_IMMUTABLE` | 写已提交历史版本 | 409 | 历史版本只读守卫（REQ-209、BR-05） |
| `DRAFT_ALREADY_EXISTS` | 单文档工作草稿已存在（单一草稿不变式） | 409 | createDraft（INV-DOC-5） |
| `UNDO_STACK_EMPTY` | undo/redo 栈为空 | 422 | doc.undo / doc.redo（REQ-204） |
| `NO_CHANGE` | 保存内容与现状无差异 | 422 | doc.save-html 无变化拒绝（LLD-2 F02-1） |
| `RTM_LINK_DANGLING` | 追踪链边指向不存在的条目 | 422 | upsertRtmLink/removeRtmLink（REQ-207） |
| `AI_BASIS_INVALID` | AI 提案时身份不齐备（项目/版本/指纹不匹配） | 409 | doc.propose-pending 前置（LLD-2 F02-1） |
| `AI_RESULT_STALE` | AI 产出依据已过期 | 409 | 同上 |

**(d) 设计域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `FIX_WITHOUT_BASIS` | 无明确依据的自动修复 | 422 | 原型检查自动修复守卫（REQ-311；转入「需人工」） |

**(e) 开发域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `WRITE_SCOPE_CONFLICT` | 写入范围非法或与运行中任务冲突 | 409 | devStart/任务保存（原型 SPEC_WRITE_SCOPE/WRITE_SCOPE_ACTIVE，REQ-402） |
| `BUILD_RECEIPT_IMMUTABLE` | 同 buildId 构建收据被改 | 409 | 构建收据校验（REQ-412） |
| `BUILD_RECEIPT_REPLACEMENT_INVALID` | 构建身份变化未产生新构建记录 | 409 | 同上 |
| `RETEST_WITHOUT_CHANGE` | 无实质返工的复测 | 409 | selftest 复测校验（REQ-416、LLD-5 A06-14） |
| `MERGE_WITHOUT_BASIS` | PR 合并缺少四类依据之一 | 422 | pr.merge 守卫（REQ-411） |
| `AUTOPILOT_MANUAL_REVIEW_MUTATION` | 自动路径改写人工评审项 → 事务回滚 | 500 | autopilot 合并事务内核验（LLD-2 F07-2） |

**(f) 测试验收域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `REGRESSION_EVIDENCE_MISMATCH` | 关闭缺陷时回归证据指纹实时重算不匹配 | 409 | defect.close（REQ-506） |
| `DEFECT_CLOSE_DENIED` | 非测试侧人工确认关闭缺陷 | 403 | defect.close 角色校验（REQ-506） |
| `REPORT_BASIS_MISMATCH` | 报告基线指纹与实时基础不一致/报告前置不满足，禁止定稿/放行 | 409 | report.finalize / delivery.authorize（REQ-508） |
| `WAIVER_NOT_ALLOWED` | 豁免项为 P0/P1、必测未执行或证据失真 | 422 | 条件放行策略求值（REQ-509、LLD-5 A07-11） |
| `EVIDENCE_REQUIRED` | 执行/结论缺少必需证据（含证据不足） | 422 | 人工执行录入、缺陷关联（REQ-505、LLD-5 A07-5/A07-9） |
| `ZERO_CASES_FORBIDDEN` | 零用例不得通过 | 422 | 用例执行入口（REQ-504、LLD-5 A07-4） |
| `HANDOFF_INVALID` | 交接令牌/指纹不符 | 409 | 批次接收（LLD-5 A07-1、REQ-501） |
| `DUPLICATE_RECEIPT` | 幂等命中：重复接收返回首个回执，不产生重复批次 | —（返回 200 原回执） | 批次接收幂等（LLD-5 A07-1） |
| `BATCH_IMMUTABLE` | 写批次不可变快照 | 409 | 批次快照守卫（BR-03） |

**(g) AI 编排域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `TOOL_UNREGISTERED` | 工具未注册 | 400 | ai.tool.invoke 注册表校验（REQ-605） |
| `TOOL_DENIED` | 工具调用被拒绝（含定稿/放行类接口对 AI 通道不可达） | 403 | 同上（REQ-613、HLD ADR-6） |
| `TOOL_ARGS_INVALID` | 工具参数不合法 | 400 | ToolBridge 包装层参数校验（REQ-605） |
| `DELEGATION_TARGET_UNAVAILABLE` | 委派目标未配置/被禁用/引用非法 | 422 | ai.delegate.create（REQ-610） |
| `MODEL_UNAVAILABLE` | 模型不可用/无可用模型（按路由降级或失败留痕，不伪造输出） | 503 | 模型路由与流式生成（LLD-5 A08-3、REQ-611/614） |
| `MODEL_RATE_LIMITED` | 模型供应商限流 → 退避重试并如实计量 | 429 | 模型 Provider 适配（REQ-612） |
| `PROMPT_VERSION_INVALID` | 提示词版本不存在/不可回滚 | 409 | 提示词版本管理（REQ-609） |

**(h) 证据与策略域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `EVIDENCE_SIMULATED` | 模拟证据充作真实执行结论 | 422 | 证据门禁校验（BR-11、REQ-415/505） |
| `GATE_BLOCKED` | 门禁求值未通过（缺口明细 `details.issues[]` 为二级码，§15） | 423 | 全部确认点/阶段准入门禁（REQ-711、BR-06、LLD-5 A11-4） |
| `POLICY_MANUAL_REQUIRED` | 该确认点为 manual 策略，AI/自动通道不可达 | 403 | 自动/AI 通道触碰人工确认点或策略切换命令（BR-06、REQ-613、LLD-5 A09-3） |
| `AUTHORIZATION_FAILED` | 授权签发/消费失败 | 403 | M12 AuthorizationService（BR-13） |
| `NORMALIZE_FAILED` | 规范化序列化失败 | 500 | M11 FingerprintService（BR-01） |
| `CHAIN_BROKEN` | 哈希链断裂 → 告警并冻结相关放行 | 500 | M11 证据链校验（INV-IMM-3） |
| `BLOB_STORE_FAILED` | 对象存储故障 → 写路径失败而非降级 | 500 | M11 内容寻址存储（HLD ADR-5） |

**(i) 执行器与集成适配域**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `SANDBOX_SPEC_INVALID` | 沙箱执行规格非法 | 400 | M09 runSandbox（REQ-803） |
| `SANDBOX_QUOTA_EXCEEDED` | 沙箱配额超限 | 429 | 同上（LLD-7 N02-4 限额） |
| `SANDBOX_INFRA_FAILED` | 沙箱基础设施失败（可重试，与原执行区分登记） | 503 | 同上 |
| `EXECUTION_TIMEOUT` | 执行超时（失败证据如实登记） | 500 | M09 执行限额（BR-11） |
| `RESOURCE_LIMIT_EXCEEDED` | 执行资源限额触顶 | 500 | 同上 |
| `GIT_MERGE_CONFLICT` | Git 合并冲突（原样上抛走失败纪律） | 409 | M10 GitAdapter（REQ-411） |
| `CI_STATUS_UNKNOWN` | CI 状态不明 → 标未知而非猜测 | 502 | M10 CiAdapter（BR-11） |
| `NETWORK_ERROR` | 出向调用网络失败 | 502 | M10 各适配器 |
| `IDENTITY_AUTH_FAILED` | 外部身份源认证失败（预留） | 401 | M10 IdentityAdapter（REQ-707） |
| `RELEASE_NOT_IMPLEMENTED` | 发布适配器本期未实现（预留接口） | 501 | M10 ReleaseAdapter（REQ-712） |

**(j) 客户工件 CMS 模板（生成工件内置行为规格；事实源 `customer-state-kernel.js` 的 validate/转移表）**

| 错误码 | 含义 | HTTP 状态 | 使用方/产生场景 |
| --- | --- | --- | --- |
| `UNKNOWN_STATUS_WORKFLOW_PAIR` | 状态对不属于内置转移表 | 422 | CMS 内容校验（LLD-2 F02-11） |
| `ALLOWED_ACTIONS_MISMATCH` | allowedActions 与状态对定义不一致 | 422 | 同上 |
| `ACTOR_NOT_AUTHORIZED` | 操作者角色与动作角色不匹配 | 403 | 三角色转移表（LLD-2 F02-11） |
| `ACTION_NOT_ALLOWED` | 动作不在当前 allowedActions | 422 | 同上 |
| `ACTION_UNKNOWN` | 未知动作 | 400 | 同上 |
| `EVENT_TIME_REQUIRED` | 缺事件时间 | 400 | 同上 |
| `REASON_INVALID` | reason 非字符串 | 400 | 同上 |
| `LAST_TRANSITION_REQUIRED` | lastTransition 缺失 | 422 | lastTransition 校验（LLD-2 F02-11） |
| `LAST_TRANSITION_FIELD_UNKNOWN` | lastTransition 含表外字段 | 422 | 同上 |
| `LAST_TRANSITION_ACTION_INVALID` | 动作不属于该对可达来源 | 422 | 同上 |
| `LAST_TRANSITION_ACTOR_INVALID` | 动作角色不匹配 | 422 | 同上 |
| `LAST_TRANSITION_AT_REQUIRED` | 时间不在档 | 422 | 同上 |
| `LAST_TRANSITION_REASON_INVALID` | reason 字段非法 | 422 | 同上 |
| `LAST_TRANSITION_PAIR_MISMATCH` | lastTransition 与状态对不自洽 | 422 | 同上 |
| `LAST_TRANSITION_OBJECT_REQUIRED` | lastTransition 非对象 | 422 | 同上 |

不变式：错误码一旦发布不复用不改义；废止/迁移码保留在 DSG-C14-3 不删除、不再使用；错误响应统一 `ApiError`（DSG-C11-2）；`retryable=true` 仅限幂等命令可安全重试的瞬态错误。

### DSG-C14-3 已归并与已迁移码（废止保留，不删除；2026-09-20 波次 0 评审整改）

下表为两级制整改的同义码归并与层级迁移记录。下列码值**禁止继续使用**；新代码/新文档一律使用「去向」列的权威码；既有文档引用已全部回改。

| 旧码 | 处置 | 去向（权威码） | 说明 |
| --- | --- | --- | --- |
| `UNKNOWN_COMMAND` | 废止（同义归并） | `COMMAND_UNKNOWN` | 「未知命令」同义码三并一 |
| `COMMAND_UNSUPPORTED` | 废止（同义归并） | `COMMAND_UNKNOWN` | 同上 |
| `GATE_DENIED` | 废止（同义归并） | `GATE_BLOCKED` | 门禁阻断同义码 |
| `MANUAL_REQUIRED` | 废止（同义归并） | `POLICY_MANUAL_REQUIRED` | 人工确认点同义码 |
| `MODE_SWITCH_DENIED` | 废止（同义归并） | `POLICY_MANUAL_REQUIRED` | 策略切换非人工调用，同一语义 |
| `OPTIMISTIC_LOCK_CONFLICT` | 废止（同义归并） | `VERSION_CONFLICT` | 乐观锁冲突同义码 |
| `PUBLISH_CONFLICT` | 废止（同义归并） | `VERSION_CONFLICT` | publish 阶段身份失配，同一语义 |
| `COMMAND_ID_CONFLICT` | 废止（同义归并） | `IDEMPOTENCY_CONFLICT` | 命令/收据号冲突，同一语义 |
| `SNAPSHOT_TAMPERED` | 废止（同义归并） | `PREPARED_TAMPERED` | 快照/制备产物篡改，同一语义 |
| `BULK_BASELINE_CONFLICT` | 废止（同义归并） | `STALE_EVIDENCE` | 批量作业基线快照失配，失效传播同一语义 |
| `UPSTREAM_STALE` | 废止（同义归并） | `STALE_EVIDENCE` | 上游失效传播，同一语义 |
| `SOURCE_STALE` | 废止（同义归并） | `STALE_EVIDENCE` | 目录来源指纹漂移，同一语义 |
| `CATALOG_STALE` | 废止（同义归并） | `STALE_EVIDENCE` | 目录过期，同一语义 |
| `SUBJECT_STALE` | 废止（同义归并） | `STALE_EVIDENCE` | 门禁求值对象指纹漂移，同一语义 |
| `CALLBACK_IDENTITY_INVALID` | 废止（同义归并） | `OPERATION_STALE` | 回调身份不全/晚到，同一语义（严格零写） |
| `SETTING_INVALID` | 废止（同义归并） | `VALIDATION_FAILED` | 非法配置项，参数校验同一语义 |
| `RESULT_ENUM_INVALID` | 废止（同义归并） | `VALIDATION_FAILED` | 结果枚举非法，参数校验同一语义 |
| `AUTH_FAILED` | 废止（同义拆分） | `UNAUTHENTICATED` / `FORBIDDEN` | 按 401/403 语义拆分到两个权威码 |
| `STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 状态机非法流转同义码族归一 |
| `TASK_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `PARSE_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `ZIP_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `DEFECT_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `EXECUTION_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `STREAM_STATE_INVALID` | 废止（同义归并） | `INVALID_STATE` | 同上 |
| `EXECUTION_NOT_FOUND` | 废止（同义归并） | `NOT_FOUND` | 资源不存在同一语义 |
| `FILE_TYPE_UNSUPPORTED` | 废止（同义归并） | `UPLOAD_REJECTED` | 上传校验失败同一语义 |
| `UPLOAD_QUOTA_EXCEEDED` | 废止（同义归并） | `UPLOAD_REJECTED` | 同上 |
| `REFERENCE_BASELINE_STALE` | 废止（同义归并） | `REFERENCE_STALE` | 参考基线失效，同一语义 |
| `PATCH_STALE` | 废止（同义归并） | `PATCH_BASE_STALE` | 补丁基线失效，同一语义 |
| `PENDING_TARGET_MISMATCH` | 废止（同义归并） | `PATCH_BASE_STALE` | 补丁目标文本不再匹配，同一语义 |
| `CONTEXT_DENIED` | 废止（同义归并） | `REFERENCE_NOT_FINAL` | 引用未过定稿门禁，同一语义 |
| `NO_MODEL_AVAILABLE` | 废止（同义归并） | `MODEL_UNAVAILABLE` | 模型不可用同义码 |
| `DELEGATE_TARGET_INVALID` | 废止（同义归并） | `DELEGATION_TARGET_UNAVAILABLE` | 委派目标非法/不可用同义码 |
| `DELEGATE_TARGET_UNAVAILABLE` | 废止（同义归并） | `DELEGATION_TARGET_UNAVAILABLE` | 同上 |
| `CLOSE_DENIED` | 废止（同义归并） | `DEFECT_CLOSE_DENIED` | 缺陷关闭角色约束，同一语义 |
| `REPORT_PRECONDITION_FAILED` | 废止（同义归并） | `REPORT_BASIS_MISMATCH` | 报告前置/基线不符，同一语义 |
| `EXEMPTION_DENIED` | 废止（同义归并） | `WAIVER_NOT_ALLOWED` | 豁免越界同义码 |
| `EVIDENCE_INSUFFICIENT` | 废止（同义归并） | `EVIDENCE_REQUIRED` | 证据不足/缺失，同一语义 |
| `TRANSFER_GATE_BLOCKED` | 废止（同义归并） | `GATE_BLOCKED` | 门禁阻断一律用顶级 `GATE_BLOCKED` + §15 缺口子码表达 |
| `BUILD_PRECONDITION_FAILED` | 废止（同义归并） | `GATE_BLOCKED` | 同上 |
| `SELFTEST_PRECONDITION_FAILED` | 废止（同义归并） | `GATE_BLOCKED` | 同上 |
| `DELETE_GUARD_BLOCKED` | 废止（同义归并） | `GATE_BLOCKED` | 同上（缺口子码 `DEPENDENCY_EXISTS`） |
| `RTM_HEALTH_UNMET` | 废止（同义归并） | `GATE_BLOCKED` | 同上（缺口子码 `RTM_HEALTH`/`L0A_BELOW`） |
| `SOURCE_ANCHOR_MISMATCH` | 废止（同义归并） | `SOURCE_SEMANTIC_UNVERIFIED`（§15(h)） | 锚点内容不符，同一语义 |
| `SELFTEST_BUSY` | 废止（同义归并） | `SELFTEST_RUNNING`（§15(b)） | 自测运行中同义码 |
| `SELFTEST_REQUIRED` | 迁移（层级调整） | §15(b)，码值不变 | 实为门禁缺口子码，不作为顶级 error.code |
| `SELFTEST_RUNNING` | 迁移（层级调整） | §15(b)，码值不变 | 同上 |
| `ZIP_ENCRYPTED` | 迁移（层级调整） | §15(j)，码值不变 | 实为 `UPLOAD_REJECTED` 的违规子码 |
| `ZIP_ZIP64` | 迁移（层级调整） | §15(j)，码值不变 | 同上 |
| `ZIP_MULTI_VOLUME` | 迁移（层级调整） | §15(j)，码值不变 | 同上 |
| `ZIP_PATH_TRAVERSAL` | 迁移（层级调整） | §15(j)，码值不变 | 同上 |
| `ZIP_ENTRY_OVERLAP` | 迁移（层级调整） | §15(j)，码值不变 | 同上 |
| `ZIP_LIMIT_EXCEEDED` | 迁移（层级调整） | §15(j)，码值不变 | 同上 |
| `UI_EXPECTED_MATRIX_MISMATCH` | 迁移（层级调整） | §15(i)，码值不变 | 实为 UI 评分结果 issue 子码 |
| `UI_CHECK_MISSING` | 迁移（层级调整） | §15(i)，码值不变 | 同上 |
| `UI_CHECK_EXTRA` | 迁移（层级调整） | §15(i)，码值不变 | 同上 |
| `UI_CHECK_DEFINITION_MISMATCH` | 迁移（层级调整） | §15(i)，码值不变 | 同上 |
| `UI_OUTCOME_UNKNOWN` | 迁移（层级调整） | §15(i)，码值不变 | 同上 |

## 15. 门禁与缺口子码注册表（二级：issue code）

### DSG-C15-1 issue code 注册表（二级码全集，按产生面分组；承接 REQ-208、REQ-418、REQ-711、BR-07、BR-10）

**边界定义（与 §14 互斥，见 DSG-C14-1）**：二级码**不作为** `ApiError.error.code` 顶级返回、**不映射** HTTP 状态；仅出现在结构化明细中——门禁求值 `GateResult.issues[].code` 与 423 `error.details.issues[].code`（LLD-5 DSG-A11-4）、原型检查/来源审计报告 `issues[].code`、上传校验 `error.details.violations[].code`、autopilot 运行 `blocker.code`。LLD-5 各门禁端点的「issue code 枚举」是本表相应组的子集引用；新增子码必须先在本表注册。

**(a) 设计原型门禁（`designPrototypeGate`；LLD-2 DSG-F02-2、LLD-5 DSG-A05-10）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `PROJECT_MISMATCH` | 项目归属不符 | A05-10 issues |
| `PLAN_REQUIRED` | 尚无原型规划（未规划直接生成） | A05-10 issues |
| `PLAN_STALE` | 规划依据已过期（governing 变化） | A05-10 issues、F02-2 |
| `PROTOTYPE_REQUIRED` | 原型不存在 | A05-10 issues |
| `PROTOTYPE_DIRTY` | 原型有未提交修改/待确认补丁 | A05-10 issues、F02-1/F02-2 |
| `PROTOTYPE_FINALIZED` | 已定稿原型收到内容写命令 | A05-10 issues、F02-1/F02-2 |
| `CHECK_REQUIRED` | 尚无（当前）检查报告 | A05-10 issues |
| `CHECK_STALE` | 检查报告已过期（内容/依据变化） | A05-10 issues、F02-2 |
| `BASELINE_REQUIRED` | 尚无共同设计基线 | A05-10 issues |
| `BASELINE_STALE` | 共同设计基线已过期 | A05-10 issues、F02-2、A06-1 |

**(b) 开发自测门禁（`devSelfTestGate` 与自测启动门禁；LLD-2 DSG-F02-7、LLD-5 DSG-A06-14/A06-15、A09-2）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `SELFTEST_REQUIRED` | 需要当前通过的开发自测报告 | A06-15/A09-2 issues |
| `SELFTEST_RUNNING` | 自测运行中（重复启动零写拒绝） | A06-15 issues、F02-7 |
| `SELFTEST_REPORT_TAMPERED` | 报告对象被改/自重算指纹不符 | A06-15 issues、F02-7 |
| `SELFTEST_BUILD_STALE` | 候选构建已变化 | A06-15 issues |
| `SELFTEST_DESIGN_STALE` | 设计基线已变化 | A06-15 issues |
| `SELFTEST_UI_SET_STALE` | UI 验收矩阵集合已变化 | A06-15 issues |
| `SELFTEST_INPUT_STALE` | 报告/操作依据不是当前事实（亦作 autopilot 阻断码） | F02-7、F04-4 |
| `RETEST_REQUIRED` | 最近报告 fail，必须走复测入口 | F02-7 |
| `BUILD_REQUIRED` | 尚无候选构建（构建前启动被拒） | A06-14 启动门禁 |
| `BUILD_INVALID` | 候选构建无效/检查未通过 | A06-14 启动门禁、A06-18 issues |

**(c) 转测试门禁（`devTransferGate`；LLD-5 DSG-A06-18/A06-19、LLD-2 F07-3）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `PROJECT_SCOPE` | 项目越界/归属不符 | A06-18 issues、A01-1 项目隔离（403 时 `FORBIDDEN` 的缺口子码） |
| `TASK_NOT_DONE` | 任务未合并完成 | A06-18 issues |
| `QUALITY_INVALID` | 质量证据无效/不达标 | A06-18 issues |
| `CI_INVALID` | CI 证据无效/未通过 | A06-18 issues |
| `IMPACT_OPEN` | 存在未处置的变更影响单 | A06-18 issues |
| `AUTO_NOT_AWAITING_TRANSFER` | autopilot 运行未停在「待人工转测试」 | A06-18 issues |
| `TRANSFER_SCOPE_INVALID` | 授权 scope 含转测试或授权非 active | F07-3 |
| （透传组） | `SELFTEST_*` 与 `BUILD_INVALID` 自 (b) 组透传 | A06-18 issues |

**(d) 任务开始门禁（`devStartGate`；LLD-2 DSG-F02-5）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `DEPENDENCY_NOT_DONE` | 依赖任务未完成 | F02-5 异常路径 |
| `BATCH_NOT_DONE` | 更早批次任务未完成 | F02-5 异常路径 |
| `TASK_NOT_APPROVED` | 任务不在批准计划快照内 | F02-5 异常路径 |
| `PR_STALE` | 历史 PR 只读，不可改不可合并 | F02-5 异常路径 |

**(e) RTM 健康度门禁（阶段准入/`rtmHealth`；LLD-5 DSG-A02-4/A04-12、LLD-2 DSG-F06-1）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `RTM_HEALTH` | RTM 健康度未达标（汇总级） | A02-4 stages issues |
| `L0A_BELOW` | L0a = R→CR 承接率 < 0.95，target 指向未覆盖 R | A04-12 gaps |
| `L0C_BELOW` | L0c = REQ→DSG 锚点覆盖率 < 1（分母=active REQ），target 逐条指向未承接 REQ | develop 门禁 issues（LLD-2 DSG-F06-1、LLD-5 DSG-A05-10 action=develop）、A04-12 gaps |

**(f) 删除守卫（`material.parsed.delete`；LLD-5 DSG-A03-14、REQ-109）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `DEPENDENCY_EXISTS` | 存在下游依赖（target 列依赖清单） | A03-14 details.issues |

**(g) 原型检查报告（`PrototypeCheck.issues[].code`，DSG-C05-3；事实源原型 inspect/designAudit）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `PAGE_MISSING` | 目录要求页面缺失 | 检查报告 issues |
| `STATE_MISSING` | 页面要求状态缺失 | 同上 |
| `FIELD_MISSING` | 字段缺失 | 同上 |
| `CONTROL_MISSING` | 控件缺失 | 同上 |
| `PAGE_UNAPPROVED` | 页面未获批准 | 同上 |
| `CONTROL_INERT` | 控件无行为（惰性） | 同上 |
| `CONTROL_SEMANTIC_MISMATCH` | 控件语义与目录期望不符 | 同上 |
| `CONTROL_INSTANCE_SET_MISMATCH` | 控件实例集合与目录不符 | 同上 |
| `FIELD_CONSTRAINT_MISMATCH` | 字段约束与目录期望不符 | 同上 |

**(h) 来源审计（`DesignCatalog.sourceAudit.issues[].code`，DSG-C05-2；LLD-2 DSG-F08、LLD-5 DSG-A05-12）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `SOURCE_DOCUMENT_SET_UNVERIFIED` | 上游文档集合与规则期望不一致 | F08 正向检查 |
| `SOURCE_NOT_READY` | 上游文档未定稿或有未提交/待确认内容 | 同上 |
| `SOURCE_VERSION_UNVERIFIED` | 上游版本未核对 | 同上 |
| `SOURCE_SECTION_MISSING` | 规则章节锚点在实际文档中非恰好一条 | 同上 |
| `SOURCE_SEMANTIC_UNVERIFIED` | 锚点标题/正文规范化哈希不符 | 同上、A05-12 issues |
| `SOURCE_UNVERIFIED` | 实际多出规则外条款（需人工核对） | 同上 |
| `SOURCE_REQUIREMENT_UNVERIFIED` | 需求编号集合双向不对应 | 同上 |
| `SOURCE_REFERENCE_MISSING` | 目录引用不指向当前真实章节 | F08 反向检查 |
| `CATALOG_SEMANTIC_UNVERIFIED` | 目录整体指纹不等于规则登记指纹 | 同上 |
| `STATUS_SOURCE_CONFLICT` | 状态显示映射与来源语义冲突 | F02-11 判定基准 |

**(i) UI 符合度评分（`v19EvaluateUiEvidence` 结果 issues；LLD-2 DSG-F05、INV-SCORE-3）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `UI_EXPECTED_MATRIX_MISMATCH` | 期望矩阵非当前基线完整集合 | F05 评分 issues |
| `UI_CRITICAL_EMPTY` | 关键项集合为空（分母非法） | 同上 |
| `UI_GENERAL_EMPTY` | 一般项集合为空（分母非法） | 同上 |
| `UI_OBSERVED_IDENTITY_INVALID` | 证据行缺 pageId/viewportId/checkId | 同上 |
| `UI_CHECK_DUPLICATE` | 同一键证据重复 | 同上 |
| `UI_CHECK_MISSING` | 观察证据缺项（→ not-run 判定） | 同上 |
| `UI_CHECK_EXTRA` | 观察证据多出基线外检查项 | 同上 |
| `UI_CHECK_KIND_MISMATCH` | 证据 kind 与分母定义不符 | 同上 |
| `UI_CHECK_DEFINITION_MISMATCH` | 检查定义与基线不符 | 同上 |
| `UI_OUTCOME_UNKNOWN` | 结果未知（unknown 不算已测，按不通过计） | 同上 |

**(j) 上传/ZIP 违规子码（`UPLOAD_REJECTED` 的 `details.violations[].code`；LLD-5 DSG-A03-3、LLD-2 DSG-F09、REQ-103）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `ZIP_ENCRYPTED` | ZIP 加密拒绝 | A03-3 violations |
| `ZIP_ZIP64` | ZIP64 拒绝 | 同上 |
| `ZIP_MULTI_VOLUME` | 多卷 ZIP 拒绝 | 同上 |
| `ZIP_PATH_TRAVERSAL` | 路径穿越（`..`/绝对路径/非法字符） | 同上 |
| `ZIP_ENTRY_OVERLAP` | 包内同名/重叠条目 | 同上 |
| `ZIP_LIMIT_EXCEEDED` | ZIP 超限（30MB/100 项/单文件 10MB/总展开 25MB） | 同上 |
| `ZIP_FORMAT_INVALID` | 包格式非法（EOCD/中央目录损坏等） | 同上 |
| `ZIP_CRC_MISMATCH` | 内容长度/CRC32 校验不符 | 同上 |

**(k) autopilot 运行阻断码（`run.blocker.code`；LLD-2 DSG-F02-6/F07-4）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `RUNNER_START_FAILED` | runner 启动失败（可恢复） | F02-6 异常路径、F07-4 白名单 |
| `HUMAN_TASK_REQUIRED` | 派发遇人工任务（可恢复） | F02-6、F07-1 |
| `SELFTEST_START_FAILED` | 自测启动失败（可恢复，幂等补记） | F02-6、F02-7 |
| `SELFTEST_FAILED` | 自测未通过 | F02-6、F07-1 |
| `DISPATCH_NO_PROGRESS` | 同状态同身份重复派发（防空转） | F07-2/F07-4 |

**(l) 失效传播通用子码（LLD-2 DSG-F04-4）**

| 子码 | 含义 | 出现于 |
| --- | --- | --- |
| `INPUT_CHANGED` | 输入已变化（通用失效 issue） | F04-4 门禁 issue |

不变式：二级码一旦发布不复用不改义；废止标「已废止」保留不删除；各组取值在 LLD-5 端点处以「issue code 枚举」引用本表，不得另立码值。

## 16. 待澄清

> 下列 C-1~C-7 均已在 2026-09-20 统稿裁决（见 `统稿裁决记录.md`），逐条回销。

- **C-1 LLD-4 表前缀体系**：✅ 已裁决（A2）。表名唯一事实源 = LLD-4 复数表名（含注册例外 projects/rtm_links/rtm_health/audit_log/policy_gates/policy_gate_events），本册全部表映射已对齐；append-only 的 DB 层强制方式见 LLD-4 §D11-1。
- **C-2 RtmHealth L0c 语义**：✅ 已裁决（A7 初裁，2026-09-20 波次 1-3 修订口径）。l0a=R→CR 承接率≥0.95、l0b=CR→REQ 承接率=1（分母为 active CR）、l0c=REQ→DSG 锚点覆盖率（分母为 active REQ，开发入口门禁要求 =1）、l0d=deferred 计数（信息性，不进门禁公式），见 DSG-C04-6。
- **C-3 真实用例执行器形态**：✅ 已裁决（D4）。自动执行器属 M09 沙箱规格之一（浏览器自动化容器）；CaseRun.evidenceIds 证据最小集 = 执行日志 + 关键截图 + 断言结果。
- **C-4 UiArtifact 存储粒度**：✅ 已裁决（D15）。每构建一个工件包（manifest + 全量 HTML/资源），MinIO 内容寻址整体存储。
- **C-5 Actor 与 RBAC 扩展形态**：✅ 已裁决（D16）。本期本地默认身份 + 最简口令登录页；RBAC 扩展期再拆分，`sys_users`/操作者字段结构不变、不留空。
- **C-6 Setting 加密**：✅ 已裁决（M9/D22）。主密钥走环境变量主密钥（见 LLD-7 N02-3），轮换策略在 LLD-7 安全册定义；本册只约定密文引用形态。
- **C-7 原型 `S.design.prototype` 与 `S.proto` 的表划分**：✅ 已裁决（M9）。原型 HTML 版本复用通用版本表：`dsg_documents`/`dsg_versions`（`doc_kind='prototype'`），HTML 大体积内容入对象存储。

## 17. 修订记录

| 日期 | 条目 | 变更 |
| --- | --- | --- |
| 2026-09-20 | 全部 | 初稿（自原型 V1.11 事实源逆向：S/dev/selftest/acceptance 结构、DEV_ACTION_REGISTRY、design-catalog.json、task-specs.json、verified-ui-certificate.json、写事务重设计 12 命令） |
| 2026-09-20 | 全册 | 统稿修订（依据《统稿裁决记录》）：表映射全量对齐 LLD-4 权威表名（A2，含 req_doc_refs/ai_delegation_targets 等 M8 缺口）；§14 错误码注册表定稿为 UPPER_SNAKE 无域前缀全集（A3）；Defect 五态+reopened 事件+P0~P3（A1）；BoardCol 四列+blocked 标记（A4）；TestRun/CaseRun 两级模型（A5）；GatePoint 七点小写点式（A6）；RtmHealth l0a/l0b/l0c 对齐（A7）；枚举对齐 M4；业务编号 TB/TP/TR/AR/AD/DF/SR-/B-/RCPT-（M5）；INV-IMM-1 改引用 LLD-4 §D01-4（M6）；设计册前缀 h/o/g/k/d/a/u/n（M7）；审计双链 recordHash（M3）；定稿不落版本行指针标注（M2）；条目编号补零两位（L1）；§16 待澄清 1~7 全部回销（M9） |
| 2026-09-20 | §14、§15（新增）、DSG-C05-2/C05-3/C09-1/C11-1 | 波次 0 评审整改（裁决 R-01）：错误码改两级制——§14 收敛为 DomainError（一级码）唯一注册表（91 码，补 HTTP 状态与使用方列），新增 §15 门禁与缺口子码（issue code，二级）注册表（77 码）；同义码 24 组（46 个旧码）归并、13 码层级迁移，旧码入 DSG-C14-3 废止/迁移表保留不删；GateResult/PolicyGateEval/sourceAudit/CheckIssueCode 声明子码闭集见 §15；原「§15 待澄清」「§16 修订记录」顺延为 §16/§17 |
| 2026-09-20 | §8（AI 编排域） | 用户决策落地（PRD REQ-615）：章首补 Pi SDK 运行时映射注——AiSession↔Pi SessionManager（JSONL 会话树）、ToolCall↔Pi AgentTool 调用事件、ModelConfig↔Pi ModelRegistry、UsageRecord↔pi-ai 计量事件；实体本身不推翻，注明「平台持久层实体，Pi 侧为运行时映射」 |
| 2026-09-20 | §8 DSG-C08-1 | 用户决策扩展落地（PRD REQ-615 接入面扩展）：AiSession 补 fork/branch 注——会话分支由 Pi SessionManager 的 JSONL 会话树承载，平台侧仅存树形引用（`treeRef`：父会话/分支点），不复制会话内容；JSONL 运行态不作为平台证据来源 |
| 2026-09-20 | DSG-C03-1、DSG-C04-5/C04-6、DSG-C10-2(e)、§15(e)、§16 C-2 | 波次 1 评审整改：C03-1 不变式①补反向迁移条款（解锁/删除解析稿，与 LLD-2 F02-3 逐条互洽）并新增 `unsupported` 承载字段；C04-6 RtmHealth 改四指标——`l0c` 改义为 REQ→DSG 锚点覆盖率（开发入口门禁 =1）、新增 `l0d`=deferred 计数（信息性不进门禁），权威 PRD REQ-208 波次 1-3 口径，C04-5 旁注 L0c→L0d；C10-2(e) 补 `batch.block`/`batch.unblock` 命令（承接 F02-8 blocked 进入/恢复路径）；§15(e) `RTM_HEALTH` 补 develop 门禁出现面；§16 C-2 回销记录同步新口径 |
| 2026-09-20 | DSG-C03-4、DSG-C04-6、DSG-C06-5、DSG-C06-6、DSG-C08-2、DSG-C12-1、DSG-C13-1/2/3/4、§15(e)、§8 章首注、§16 | 波次 2 评审整改（E 组）：§15(e) 补注册 `L0C_BELOW`（与 `L0A_BELOW` 对称，develop 门禁 L0c 缺口专用子码，`RTM_HEALTH` 回归汇总级）；不变式可执行性 3 处——INV-DOC-6 拆 6a/6b/6c 机器可验子句（版本链连续/断链处置/恢复只追加）、INV-IMM-2 补验证方式（静态扫描+篡改测试）、INV-SCORE-1 消解 unknown 矛盾（status 闭集 {pass,fail,skipped,not-run}，闭集外记 `UI_OUTCOME_UNKNOWN` 按不通过计）；C06-6 导出格式 md/json→md+html（统稿 D-22，pdf 后续）；C04-6 补 l0a/l0b 空分母条款（分母为 0 记 1 并告警）；C06-5 SelfTestGate 补 gates 键→原型显示名映射（functional=功能检查、integration=联调与冒烟、ui=UI 符合度、review=开发审核）；C08-2 流式状态补 `failed` 终态（对齐 LLD-2 F02-12 与 LLD-4 ai_messages 落库枚举）；C03-4 按 REQ-111 新口径回改 basisSnapshot（弹窗整批快照+开始整批复核+执行中变化行跳过）并补作业级五态承载字段 `status`（INV-BULK-1 同步改述）；C12-1 声明规范化序列化以 LLD-2 DSG-F04-1 为权威（RFC 8785 JCS 子集+NFC）；§8 章首注 UsageRecord 改「从 Pi 消息结果提取 Usage」口径；§16 待澄清编号统一 C-<n> 制式 |
| 2026-09-21 | DSG-C01-2、DSG-C03-1、DSG-C03-4、DSG-C04-5、DSG-C04-6、DSG-C06-1、DSG-C06-3、DSG-C08-2、DSG-C08-7、DSG-C10-2(c)(d) | 二轮评审整改：C04-6/LLD-2 F06-1 L0a 分母统一为 active R（deferred 不计入，与 L0b/L0c 同构，裁决）；C06-3 OperationStatus 补 `stale` 为六值（与 LLD-4 DSG-D06-3/LLD-5 A10-7 一致，承接 F01-2 stale/superseded 落库合并值）；C04-5 RtmLink 以 DB 为准（裁决）——relation 枚举改 `'refines'|'implements'|'verifies'|'deferred'|'dropped'`，删除独立 `deferred: boolean` 字段（deferred 以关系取值表达，明细随 rtm_health.deferred_items）；C08-7 DelegationStatus 以 LLD-4 六值为准（裁决）——改 `queued/running/succeeded/failed/failed_timeout/cancelled`，删「超时以 failed+errorMessage 记录」注；C08-2 补 `paused` 界定（运行时缓冲层状态，不落 ai_messages.status）；C03-1 source 枚举对齐 LLD-4 DSG-D03-2（`upload|zip_extract|inline_extract`）；C06-1 删 dev_tasks evidence JSONB 列误注（LLD-4 实无该列，改注 CI 结论落 dev_ci_reports、单测证据经 evd_records）；C03-4 删「LLD-4 DSG-D03-5 枚举待同步对齐」过期注（实际已对齐）并补行级落库列名 mat_batch_items.result；C10-2(d) 补上传会话生命周期命令 4 条（material.upload.create/part/complete/abort，对应 LLD-5 A03-1/2/3/18）、C10-2(c) 补 `ci.callback.receive`（LLD-5 A06-21），命令闭集审计链闭环；C01-2 原型出处行号重刷（devStableString/devHash L4717-4718，删不存在的 K()/H() 引用） |
