# 软件工厂（MSF）需求追踪矩阵（RTM）

> 版本：V1.0-draft · 2026-09-20 · 状态：草稿，待评审
> 规则依据：`README.md` §3（追溯规则）与 §5（变更管理规则）。
> 范围：CRD 全部 25 条 CR（R←CR 层见 `CRD.md`）+ PRD 全部 103 条 REQ（REQ-101~115 / 201~210 / 301~312 / 401~420 / 501~511 / 601~615 / 701~712 / 801~808）+ 15 条 BR（BR-01~15），正向映射到 HLD（DSG-M00~M13、ADR-1~9）与 LLD-1~7（DSG-M/F/C/D/A/U/N 系列条目）。追溯链：R ← CR ← REQ ← DSG。
> 节点类型差异登记：本体系 DSG 设计节点为 h/o/g/k/d/a/u/n 共 8 类（统稿 M7）；原型（`../msf-prototype.html` V1.11，L817 `DSG_DEFS` 节点卡定义表）的追溯节点卡为 9 类，另含 **P=原型 UI 节点（DSG-P）**。原型 P 节点为原型期过渡态锚点，产品化后原型 UI 工件由 DSG-U（LLD-6 界面设计册）承接，故本矩阵不另立 P 节点。

## 1. 使用说明（如何用本矩阵做变更影响分析，对应 README §5）

1. **需求变更下钻**：变更某条 REQ/BR 时，先在 §3 主矩阵该行「承接设计」列取出全部 DSG 条目，逐一打开对应章节确认「需改 / 不受影响」，结论记入 PRD 该条目的修订记录；PRD、设计册、本矩阵三者的修改必须在**同一次提交**内完成（README §5-1/§5-3）。
2. **设计变更上溯**：改动某个 DSG 条目前，在 §3 中反向检索该条目号，得到其承接的全部 REQ/BR，评估变更是否破坏需求语义；若 DSG 条目不再能回溯任何 REQ/BR，须按 README §2.2 标注 `补充设计` 并登记到 §4。反向检索脚本化：运行 `node doc/product-design/tools/build-rtm-index.mjs` 由本矩阵生成「REQ→行号 / DSG→行号 / CR→行号」反向索引（输出 `tools/rtm-index.json` 并打印统计），随涉及追溯的提交在**同一次提交**内刷新。
3. **原型行为对照**：每条需求的「原型出处」列给出原型函数/契约条款，三方可互查（需求 ↔ 设计 ↔ 原型行为，README §3-4）。
4. **区间引用展开**：设计册中 `REQ-101~115` 这类区间引用在本矩阵中已**逐条展开计入**，不再依赖读者自行展开。
5. **每次变更后执行自检**（README §5-7）：(a) 每个 REQ/BR 有下游承接或豁免说明；(b) 每个 DSG 有上游 REQ/BR；(c) 无悬空编号引用；(d) 无重复编号。本矩阵 §4/§5/§6 即当前自检结果。

## 2. 覆盖状态图例

- ✅ 已承接：至少一个 DSG 条目显式引用（含区间展开）该 REQ/BR，「承接设计」列给出册名+条目号+章节主题。
- ⬜ 非设计途径承接：规则由流程纪律/运营手段承接，无设计条目（本版无此类条目）。
- ❌ 缺口：无任何 DSG 条目引用（本版无此类条目）。

## 3. 正向主矩阵（REQ/BR → DSG）

### 3.1 资料库（REQ-1xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-101 | 项目资料库 | P0 | `stage-material / viewMaterial` | HLD DSG-M03 资料域服务；LLD-1 DSG-M03；LLD-4 DSG-D03-3 `mat_parsed`（两工作面 kind）；LLD-5 DSG-A03-6 文件列表；LLD-6 DSG-U02-3 三栏工作模式 / DSG-U03-2 资料页 | ✅ |
| REQ-102 | 文件上传 | P0 | `mockUpload/doUpload` | HLD DSG-M03；LLD-3 DSG-C03-1 MaterialFile（objectKey 原件永久保留）；LLD-4 DSG-D01-5 对象存储分工 / DSG-D03-2 `mat_files` / DSG-D03-7 `mat_uploads` 分片上传会话；LLD-5 DSG-A03-1~3 上传会话/分片/完成 / DSG-A03-18 中止上传会话（:abort）；LLD-7 DSG-N02-6 其他文件类型安全（支持格式=封闭六格式枚举 doc/pdf/xlsx/md/txt/zip，以 PRD REQ-102 为唯一来源）/ DSG-N07-3 | ✅ |
| REQ-103 | ZIP 安全上传 | P0 | `material-zip.js / MaterialZip.read` | HLD DSG-M03；LLD-2 DSG-F09-1 ZIP 校验顺序与全部拒绝条件；LLD-4 DSG-D03-2（zip_check）/ DSG-D03-7（declared_sha256 整包验证原则落库）/ DSG-D10-4（限额配置化）/ DSG-D11-3（回读校验）；LLD-5 DSG-A03-1 / DSG-A03-3（整包校验提交）；LLD-7 DSG-N02-5 ZIP 全集服务端复验 | ✅ |
| REQ-104 | ZIP 行内解压 | P1 | `material-folders.js / v11Extract` | LLD-2 DSG-F09-1 后续动作（同名冲突拒绝/可重命名）；LLD-3 DSG-C03-3 FolderNode（zipFileId）；LLD-4 DSG-D03-2（source=inline_extract）/ DSG-D03-4；LLD-5 DSG-A03-4 | ✅ |
| REQ-105 | 原件/解析稿双目录 | P0 | `material-folders.js` | LLD-3 DSG-C03-1 / DSG-C03-2 ParsedContent / DSG-C03-3 FolderNode（双树）；LLD-4 DSG-D03-2 / DSG-D03-3 / DSG-D03-4 `mat_folder_tree`；LLD-5 DSG-A03-5 双目录树查询 / DSG-A03-7；LLD-7 DSG-N07-3 | ✅ |
| REQ-106 | 目录树交互 | P1 | `material-folders.js / S.materialFolders` | LLD-3 DSG-C03-3（选择/折叠态为客户端会话态）；LLD-4 DSG-D00 S→表映射 / DSG-D03-4；LLD-5 DSG-A03-5；LLD-7 DSG-N01-4 虚拟滚动与树懒加载 | ✅ |
| REQ-107 | 文件解析状态机 | P0 | `retryParse / batchParse` | LLD-2 DSG-F02-3 资料解析状态机；LLD-3 DSG-C03-1 / DSG-C03-5 ParseTask（重试、留痕）；LLD-4 DSG-D03-2（parse_status、audit_trail）；LLD-5 DSG-A03-6 / A03-8 / A03-10 | ✅ |
| REQ-108 | 文件定稿 | P0 | `finalFile` | LLD-2 DSG-F02-3（确认对话框快照复核）；LLD-3 DSG-C03-1（file_final）；LLD-4 DSG-D03-2（finalized_by/at）；LLD-5 DSG-A03-11 文件定稿/解锁定稿 | ✅ |
| REQ-109 | 内容解析与定稿 | P0 | `finalContent / deleteReason` | LLD-2 DSG-F02-3；LLD-3 DSG-C03-1 / DSG-C03-2（contentResults 可独立删除、删除守卫）；LLD-4 DSG-D03-3（delete_guard）；LLD-5 DSG-A03-12 / A03-14 解析行删除（GATE_BLOCKED+DEPENDENCY_EXISTS） | ✅ |
| REQ-110 | 批量解析 | P1 | `v11Parse / batchParse` | LLD-3 DSG-C03-4 BatchJob / DSG-C03-5 ParseTask；LLD-4 DSG-D03-5 / DSG-D03-6 `mat_batch_items`；LLD-5 DSG-A03-9 批量解析；LLD-7 DSG-N01-7 批量作业削峰与隔离 | ✅ |
| REQ-111 | 批量加工 | P1 | `material-bulk.js / basis()` | LLD-2 DSG-F02-4 批量加工作业状态机；LLD-3 DSG-C03-4（basisSnapshot：弹窗打开记整批基线快照、开始时整批复核（不一致整批中止）、执行中变化行逐行跳过）/ DSG-C13-4 INV-BULK-1；LLD-4 DSG-D03-5 / DSG-D03-6；LLD-5 DSG-A03-15 / A03-16；LLD-7 DSG-N01-7 / DSG-N07-3 脱敏适用规则 | ✅ |
| REQ-112 | 批量定稿 | P1 | `v11BulkContentFinal` | LLD-2 DSG-F02-3（逐条可查）/ DSG-F02-4；LLD-3 DSG-C03-4（人工确认不变式）；LLD-4 DSG-D03-5（confirm_by/at）；LLD-5 DSG-A03-12 批量内容定稿 | ✅ |
| REQ-113 | 内容稿编辑 | P1 | `material-polish.js / v11Guard` | LLD-3 DSG-C03-2（三态只改草稿区，提交版本+1）；LLD-4 DSG-D03-3（编辑三态落库）；LLD-5 DSG-A03-13 内容稿编辑保存 | ✅ |
| REQ-114 | 需求参考输入门禁 | P0 | `chat-reference.js / v11RequirementInputs` | HLD DSG-M03 / DSG-M08；LLD-1 DSG-M03 ReferenceGate；LLD-3 DSG-C03-1（content_final 唯一合法态）/ DSG-C04-1（refFileIds）；LLD-4 DSG-D03-3（referenced_by）/ DSG-D04-2（refs 快照）/ DSG-D04-7 `req_doc_refs`；LLD-5 DSG-A03-17 参考输入清单 / DSG-A04-4；LLD-7 DSG-N07-3 | ✅ |
| REQ-115 | 参考基线校验 | P0 | `chat-reference.js` | HLD DSG-M03 / DSG-M08；LLD-1 DSG-M03；LLD-3 DSG-C04-2 DocVersion（inputSnapshot）；LLD-4 DSG-D04-2（governing_fingerprint）/ DSG-D04-7；LLD-5 DSG-A03-17 / DSG-A04-4（REFERENCE_STALE）/ DSG-A01-4 错误码 | ✅ |

### 3.2 需求管理（REQ-2xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-201 | CRD/PRD/RTM 三工作面 | P0 | `stage-req / viewReq` | HLD DSG-M04；LLD-1 DSG-M04；LLD-3 DSG-C04-1 ReqDocument；LLD-4 DSG-D04-1 `req_documents`；LLD-5 DSG-A04-1 / A04-2；LLD-6 DSG-U02-3 / DSG-U03-3 需求页 | ✅ |
| REQ-202 | 文档 AI 生成 | P0 | `streamReply/tickStream` | LLD-2 DSG-F02-12 流式生成控制状态机；LLD-3 DSG-C04-1 / DSG-C11-2 DTO；LLD-4 DSG-D04-2；LLD-5 DSG-A04-4（SSE 生成）/ A04-5（暂停/继续/停止）/ DSG-A01-6 / DSG-A11-3 SSE；LLD-7 DSG-N01-2 | ✅ |
| REQ-203 | 文档版本体系 | P0 | `switchVer/commitVer/finalizeDoc` | LLD-2 DSG-F02-1 文档生命周期状态机；LLD-3 DSG-C04-1/2/3、DSG-C12-2 版本号策略、DSG-C13-1；LLD-4 DSG-D04-2 `req_versions` / DSG-D04-3 `req_drafts` / DSG-D05-3 / DSG-D12 专题；LLD-5 DSG-A04-2/3/6/7/9/13 | ✅ |
| REQ-204 | 编辑撤销/重做 | P1 | `docUndo/docRedo` | LLD-2 DSG-F02-1（undo 栈上限 30）；LLD-3 DSG-C04-3 Draft（undoDepth）；LLD-4 DSG-D04-3 / DSG-D05-3 / DSG-D12；LLD-5 DSG-A04-8 | ✅ |
| REQ-205 | 待确认补丁 | P0 | `acceptPend/rejectPend` | LLD-2 DSG-F02-1（propose-pending 命令）；LLD-3 DSG-C04-4 PendingPatch / DSG-C10-2 / DSG-C14-2（PATCH_BASE_STALE）；LLD-4 DSG-D04-4 `req_pendings`；LLD-5 DSG-A04-4 / A04-10 / DSG-A01-6（doc.patch.proposed） | ✅ |
| REQ-206 | 目录同步 | P2 | `bindTocSync` | LLD-6 DSG-U01-5 基础组件清单（点名承接：需求页组件含 REQ-206 目录同步联动）；LLD-6 DSG-U03-3 需求页（目录与正文滚动联动、点击跳转）；行为实质规格在 LLD-6 DSG-U02-3（目录栏 `.toc-col` 联动，`bindTocSync` L784）；区间承接：HLD DSG-M01/M04、LLD-1 DSG-M04、LLD-5 DSG-A04（REQ-201~210 区间） | ✅ |
| REQ-207 | RTM 追踪矩阵 | P0 | `rtmHtml` | LLD-2 DSG-F06-1（追踪链 R→CR→REQ→DSG）；LLD-3 DSG-C04-5 RtmLink；LLD-4 DSG-D00 / DSG-D04-5 `rtm_links`；LLD-5 DSG-A04-11 RTM 查询 | ✅ |
| REQ-208 | 需求健康度门禁 | P0 | `rtmHealth / rtmL0c` | LLD-2 DSG-F06-1（L0a/L0b/L0c/L0d 权威计算与门禁，含空分母条款：分母为 0 记 1 并告警）；LLD-3 DSG-C04-6 RtmHealth；LLD-4 DSG-D04-5 / DSG-D04-6（gaps 缺口清单）；LLD-5 DSG-A04-12 / DSG-A02-4 / DSG-A11-4；LLD-6 DSG-U06-24（RTM 页 L0d deferred 计数独立 KPI 卡差异登记） | ✅ |
| REQ-209 | 定稿不可原地改 | P0 | `原型写事务/草稿与历史版本重设计` | LLD-2 DSG-F02-1（历史版本只增不改）；LLD-3 DSG-C04-1/2/3、DSG-C13-1、DSG-C14-2（VERSION_LOCKED）；LLD-4 DSG-D04-1/2/3、DSG-D11-1 append-only、DSG-D12；LLD-5 DSG-A04-3 / A04-6 | ✅ |
| REQ-210 | 并发编辑冲突 | P0 | `新增: 多用户真实化` | LLD-2 DSG-F02-1 异常路径（VERSION_CONFLICT）；LLD-3 DSG-C04-1（lockVersion）/ DSG-C10-1（expectedRevision）/ DSG-C14-2（VERSION_CONFLICT）；LLD-4 DSG-D04-1（lock_owner）/ DSG-D05-1 / DSG-D12-6；LLD-5 DSG-A01-3（If-Match/409）/ DSG-A04-3；LLD-6 DSG-U06-14 并发冲突提示；注：乐观锁机制首期内建、不随 REQ-707 多用户扩展推迟（版本号本期即 BR-05/幂等判定载体，推迟将返工） | ✅ |

### 3.3 设计（REQ-3xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-301 | 概要设计 + 七册详细设计 | P0 | `stage-design / DESIGN_PRE` | HLD DSG-M05；LLD-1 DSG-M05；LLD-3 DSG-C05-1 DesignDoc（group: outline/detail）；LLD-4 DSG-D05-1 `dsg_documents`（八册+prototype）/ DSG-D05-2；LLD-5 DSG-A05-1 八册列表；LLD-6 DSG-U02-3 / DSG-U03-4 设计页 | ✅ |
| REQ-302 | 设计文档 AI 生成 | P0 | `viewDesign` | LLD-3 DSG-C05-1（复用 REQ-203 版本体系）；LLD-4 DSG-D05-1（chapter_prefix h/o/g/k/d/a/u/n）/ DSG-D05-2 / DSG-D05-3；LLD-5 DSG-A05-1 / DSG-A05-2 生成（SSE） | ✅ |
| REQ-303 | 设计评审 | P1 | `designReviewHtml` | LLD-3 DSG-C05-1（review DR 系列）；LLD-4 DSG-D00 / DSG-D05-8 `dsg_reviews`；LLD-5 DSG-A05-3 | ✅ |
| REQ-304 | 原型识别 | P0 | `designPlanPrototype / V19_DESIGN_CATALOG` | LLD-2 DSG-F02-2（区间 REQ-304~310）/ DSG-F02-11；LLD-3 DSG-C05-2 DesignCatalog；LLD-4 DSG-D05-4 `dsg_catalog_items` / DSG-D05-5 `dsg_catalog_refs`；LLD-5 DSG-A05-4 / A05-5 / A05-13（人工增删带标记） | ✅ |
| REQ-305 | 原型生成 | P0 | `designGeneratePrototype` | LLD-2 DSG-F02-2（区间）/ DSG-F02-11（目录驱动工件行为规格）；LLD-3 DSG-C10-2（prototype.* 命令）；LLD-4 DSG-D05-4；LLD-5 DSG-A05-6 | ✅ |
| REQ-306 | 原型检查 | P0 | `designCheckPrototype / designAudit` | LLD-2 DSG-F02-2（区间）；LLD-3 DSG-C05-3 PrototypeCheck（humanRequired 不静默忽略）；LLD-4 DSG-D05-6 `dsg_prototype_checks`；LLD-5 DSG-A05-7；LLD-6 DSG-U03-4 | ✅ |
| REQ-307 | 原型预览 | P0 | `designSelectPrototypePage` | LLD-5 DSG-A05-8 预览工件地址（iframe 隔离+独立子域+CSP）/ DSG-A11-5 预览子域 TLS（内部 CA/自签泛域名证书）；LLD-6 DSG-U04-1 隔离 iframe 预览 / DSG-U04-2 页面/状态/视口切换；LLD-7 DSG-N02-11 / DSG-N05-2 | ✅ |
| REQ-308 | 共同定稿 | P0 | `designFinalizePrototypeBaseline` | LLD-2 DSG-F02-2（定稿门禁与基线追加）；LLD-3 DSG-C05-4 DesignBaseline（必需项缺失阻断）/ DSG-C10-2；LLD-4 DSG-D05-4（required）/ DSG-D05-6 / DSG-D05-7；LLD-5 DSG-A05-9；LLD-6 DSG-U03-4 | ✅ |
| REQ-309 | 设计基线 | P0 | `designPrototypeGate / 契约§3-6` | LLD-2 DSG-F02-2 / DSG-F04-4 失效传播；LLD-3 DSG-C05-4（指纹组合不复制内容）/ DSG-C12-5 ArtifactRef；LLD-4 DSG-D05-2 / DSG-D05-7 `dsg_baselines` / DSG-D14；LLD-5 DSG-A05-9/10/11 | ✅ |
| REQ-310 | 设计→开发承接 | P0 | `designPrototypeGate('develop') / devGate` | LLD-2 DSG-F02-2（区间）；LLD-3 DSG-C05-2（taskIds 反查）/ DSG-C05-4（基线有效才进开发）；LLD-4 DSG-D05-5 / DSG-D05-7 / DSG-D06-1（source_ids）；LLD-5 DSG-A05-10/11 / DSG-A06-1 | ✅ |
| REQ-311 | 自动修复边界 | P0 | `契约§2` | LLD-2 DSG-F08-1（判定纪律：未知语义记 humanRequired）；LLD-3 DSG-C05-3（自动修复仅限有依据差异）；LLD-4 DSG-D05-6（auto_fixable 清单） | ✅ |
| REQ-312 | 来源审计 | P1 | `V19-SOURCE-4 / source-acceptance-rules.json` | LLD-2 DSG-F08-1 正反向追溯审计算法；LLD-3 DSG-C05-2（规则集版本化）；LLD-4 DSG-D05-5（rule_text/ref_fingerprint/ruleset_version）；LLD-5 DSG-A05-12 | ✅ |

### 3.4 开发（REQ-4xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-401 | 任务识别 | P0 | `devIdentify / V17_CATALOG` | LLD-2 DSG-F07-1（区间 REQ-401~404）；LLD-3 DSG-C06-1 DevTask；LLD-4 DSG-D06-1 `dev_tasks`；LLD-5 DSG-A06-1（BASELINE_STALE 门禁）/ A06-2 | ✅ |
| REQ-402 | 任务规格 | P0 | `task-specs.json / V17_TASKS` | LLD-3 DSG-C06-1（kind/scope/writeScopes/quality）/ DSG-C14-2（WRITE_SCOPE_CONFLICT）；LLD-4 DSG-D06-1（work/acceptance/quality/write_scopes）；LLD-5 DSG-A06-2/3/4 | ✅ |
| REQ-403 | 计划覆盖检查 | P0 | `devCoverageCheck` | LLD-2 DSG-F07-1（区间）；LLD-3 DSG-C06-1（sourceIds）/ DSG-C06-2 DevPlan；LLD-4 DSG-D06-1（coverage）/ DSG-D06-2（coverage_report）；LLD-5 DSG-A06-5 | ✅ |
| REQ-404 | 计划批准 | P0 | `devSubmitPlan/devApprovePlan` | LLD-2 DSG-F07-1（区间）；LLD-3 DSG-C06-2（批准后快照固定）；LLD-4 DSG-D06-2（approved_by/at，经 policy_gates）；LLD-5 DSG-A06-6 / A06-7（人工批准+指纹复核） | ✅ |
| REQ-405 | 执行看板 | P0 | `.devBoard` | LLD-2 DSG-F02-5 看板状态机（四列 queue/ing/review/done=排队/进行中/待评审/完成；阻塞为标记非列，A4）；LLD-3 DSG-C06-1（BoardCol）；LLD-4 DSG-D06-1（col）；LLD-5 DSG-A06-8 / DSG-A01-6（task.transitioned） | ✅ |
| REQ-406 | 代码仓视图 | P1 | `stage-dev / 代码仓` | LLD-5 DSG-A06-9 代码仓视图；区间承接：HLD DSG-M06、LLD-1 DSG-M06、LLD-6 DSG-U03-5（REQ-401~420 区间） | ✅ |
| REQ-407 | 单任务开发循环 | P0 | `commitDevAction` | HLD DSG-M09 / DSG-M10；LLD-1 DSG-M09 / DSG-M10；LLD-2 DSG-F02-5（编码→单测→CI→评审→合并证据链）；LLD-5 DSG-A06-8（完成列证据校验）；LLD-7 DSG-N02-4 沙箱执行隔离 | ✅ |
| REQ-408 | 命令事务 | P0 | `DEV_ACTION_REGISTRY / devAudit` | HLD ADR-3；LLD-2 DSG-F03-1 三阶段管线；LLD-3 DSG-C06-3 DevOperation / DSG-C10-1 命令总线 / DSG-C10-2 命令枚举 / DSG-C14-1/2（DIRECT_WRITE_DENIED）；LLD-4 DSG-D06-3 / DSG-D10-1 `sys_commands` / DSG-D13 专题；LLD-7 DSG-N03-1 | ✅ |
| REQ-409 | autopilot 自动主线 | P0 | `devApproveAndRun / devAutopilotTick` | LLD-2 DSG-F02-6 autopilot 运行状态机 / DSG-F07-1 主流程 / DSG-F07-3 自动放行范围上限（停在待人工转测试）；LLD-3 DSG-C10-2 / DSG-C12-4（scope.transferToTest 恒 false）/ DSG-C13-4 INV-AUTO-1；LLD-4 DSG-D06-2/3；LLD-5 DSG-A06-10 / A06-12 | ✅ |
| REQ-410 | 暂停/停止/接管 | P0 | `devAutoPause/devAutoTakeover` | LLD-2 DSG-F01-2 四元组身份 / DSG-F02-6 / DSG-F07-2 归属 token 校验；LLD-3 DSG-C06-3 / DSG-C12-3 / DSG-C12-4（晚到回调零写）/ DSG-C14-2（OPERATION_START_FAILED）；LLD-4 DSG-D06-3 / DSG-D13-5；LLD-5 DSG-A06-11（OPERATION_STALE）/ A06-12 | ✅ |
| REQ-411 | 合并依据 | P0 | `devResolveMergeBasis / attachBasis` | HLD DSG-M10；LLD-1 DSG-M10；LLD-2 DSG-F02-5（pr.merge 生成深冻结 mergeBasis，四类之一）；LLD-3 DSG-C10-2（pr.merge.basis）；LLD-4 DSG-D06-3（authorization_id） | ✅ |
| REQ-412 | 集成构建 | P0 | `v19BuildCandidateHTML / devInspectBuildUiArtifact` | HLD DSG-M09 / DSG-M10；LLD-1 DSG-M09 / DSG-M10；LLD-2 DSG-F07-1；LLD-3 DSG-C06-4 DevBuild（禁复制原型 HTML）/ DSG-C14-2（BUILD_RECEIPT_IMMUTABLE）；LLD-4 DSG-D01-5 / DSG-D06-4 `dev_builds`；LLD-5 DSG-A06-13；LLD-7 DSG-N02-4 | ✅ |
| REQ-413 | 开发自测 | P0 | `devStartSelfTest / devCanStartSelfTest` | LLD-2 DSG-F02-7 自测运行状态机 / DSG-F07-1；LLD-3 DSG-C06-5（四门，构建前启动拒绝）/ DSG-C15-1（SELFTEST_REQUIRED，§15(b) 门禁子码）；LLD-4 DSG-D06-5 `dev_selftests`；LLD-5 DSG-A06-14/15/16 | ✅ |
| REQ-414 | UI 符合度评分 | P0 | `v19EvaluateUiEvidence / V19_UI_ACCEPTANCE_RULES` | LLD-2 DSG-F05-1 评分与分母规则 / DSG-F05-2 聚合判定伪代码；LLD-3 DSG-C06-5 UiPageScore / DSG-C11-2 / DSG-C13-3 / DSG-C15-1（UI_EXPECTED_MATRIX_MISMATCH，§15(i) 评分子码）；LLD-4 DSG-D06-5 / DSG-D06-6 逐页明细；LLD-5 DSG-A06-15/16；LLD-6 DSG-U05-3（移动视口独立呈现） | ✅ |
| REQ-415 | 自测对照 | P1 | `devOpenUiComparison` | LLD-3 DSG-C06-5（对照工件双指纹）/ DSG-C13-4 INV-EVID-1 / DSG-C14-2（EVIDENCE_SIMULATED）；LLD-5 DSG-A06-17（两指纹不同源校验）；LLD-6 DSG-U04-3 双侧对照弹窗；LLD-7 DSG-N02-11 | ✅ |
| REQ-416 | 失败与复测 | P0 | `devRetestSelfTest` | LLD-2 DSG-F02-5 / DSG-F02-7 / DSG-F07-4（「需你处理」生成）；LLD-3 DSG-C06-5（retestOf/retestReason）/ DSG-C13-4 INV-RETEST-1 / DSG-C14-2（RETEST_WITHOUT_CHANGE）；LLD-4 DSG-D06-5（build_fingerprint 比对）；LLD-5 DSG-A01-4 / DSG-A06-14；LLD-6 DSG-U07-3 | ✅ |
| REQ-417 | 自测报告 | P0 | `devExportSelfTestReport / v19MakeSelfTestReport` | LLD-2 DSG-F02-7；LLD-3 DSG-C06-6 DevReport（证据自动汇总、可导出）/ DSG-C13-2；LLD-4 DSG-D06-7 `dev_reports` / DSG-D11-1；LLD-5 DSG-A06-16 | ✅ |
| REQ-418 | 转测试 | P0 | `devTransferGate` | LLD-2 DSG-F07-1 / DSG-F07-3；LLD-3 DSG-C06-7 TransferReceipt（原子交接令牌）/ DSG-C11-2；LLD-4 DSG-D06-3（token 旋转）/ DSG-D06-7 / DSG-D06-8 `dev_transfer` / DSG-D14；LLD-5 DSG-A06-18/19 / DSG-A11-4 | ✅ |
| REQ-419 | 变更管理 | P1 | `impactTrigger / devConfirmBaseline` | LLD-2 DSG-F02-5（devApplyImpact）；LLD-3 DSG-C10-2（计划与目录覆盖命令组）；LLD-4 DSG-D05-7（reconfirmed_of 基线重确认链）；LLD-5 DSG-A06-20；LLD-6 DSG-U03-4（再定稿触发影响分析） | ✅ |
| REQ-420 | 输入失效传播 | P0 | `devInvalidate / retire` | LLD-2 DSG-F04-4 失效传播算法；LLD-3 DSG-C06-2（revision+1 降级）/ DSG-C10-2（input.observe/reconcile）；LLD-4 DSG-D06-1（input_artifacts）/ DSG-D06-2 / DSG-D06-5（stale）/ DSG-D14-4（失效传播写入）；LLD-5 DSG-A06-20 | ✅ |

### 3.5 测试验收（REQ-5xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-501 | 批次接收 | P0 | `acceptanceReceive` | LLD-2 DSG-F02-8 验收批次状态机；LLD-3 DSG-C06-7 / DSG-C07-1 TestBatch / DSG-C11-2；LLD-4 DSG-D06-8 / DSG-D07-1（handoff_fingerprint 幂等键）/ DSG-D14；LLD-5 DSG-A07-1；LLD-7 DSG-N03-3（重试幂等不产生重复批次） | ✅ |
| REQ-502 | 批次不可变快照 | P0 | `acceptance-workbench.js / S.test.acceptance.batches` | LLD-2 DSG-F02-8（新构建=新批次）；LLD-3 DSG-C07-1 / DSG-C13-2；LLD-4 DSG-D06-4（supersedes 不覆盖）/ DSG-D07-1 `tst_batches`；LLD-5 DSG-A07-1/2 / DSG-A07-13/A07-14（批次阻断/恢复） | ✅ |
| REQ-503 | 测试计划 | P0 | `acceptanceDraftPlan / acceptanceApprovePlan` | LLD-2 DSG-F02-9；LLD-3 DSG-C07-2 TestPlan / DSG-C07-3 TestCase；LLD-4 DSG-D07-2（has_manual_walkthrough 硬条件）/ DSG-D07-3（删除失败用例被拒绝）；LLD-5 DSG-A07-3 | ✅ |
| REQ-504 | 用例执行 | P0 | `acceptanceRun` | LLD-2 DSG-F02-9 用例执行状态机；LLD-3 DSG-C07-3（must_run 保留分母）/ DSG-C07-4 TestRun/CaseRun / DSG-C13-3；LLD-4 DSG-D07-3/4/5；LLD-5 DSG-A01-4（ZERO_CASES_FORBIDDEN）/ DSG-A07-4/5；LLD-6 DSG-U06-10 / DSG-U06-19（not-applicable 枚举差异登记） | ✅ |
| REQ-505 | 执行证据 | P0 | `acceptanceRun / 契约§8` | LLD-2 DSG-F02-9；LLD-3 DSG-C02-3 EvidenceRef（simulated 标注）/ DSG-C07-4 / DSG-C14-2；LLD-4 DSG-D07-4/5（is_simulated/evidence_ids）；LLD-5 DSG-A07-4/5（EVIDENCE_REQUIRED）；LLD-7 DSG-N03-7（故障注入产出强制标模拟） | ✅ |
| REQ-506 | 缺陷闭环 | P0 | `acceptanceCreateDefect→…→Close` | LLD-2 DSG-F02-10 缺陷状态机（五态+reopened 事件，回归证据四要素）；LLD-3 DSG-C07-5 Defect / DSG-C13-4 INV-DEFECT-1 / DSG-C14-2（REGRESSION_EVIDENCE_MISMATCH / DEFECT_CLOSE_DENIED）；LLD-4 DSG-D07-6 `tst_defects` / DSG-D09-3（reopened 事件流）；LLD-5 DSG-A07-6/7/8/9 | ✅ |
| REQ-507 | 跨阶段返工 | P0 | `acceptance-rework-probe` | LLD-2 DSG-F02-10；LLD-3 DSG-C07-5（缺陷→新构建→新批次→回归链路）；LLD-4 DSG-D07-6；LLD-5 DSG-A07-8/9；LLD-6 DSG-U07-3 | ✅ |
| REQ-508 | 验收报告 | P0 | `acceptanceGenerateReport / FinalizeReport` | LLD-3 DSG-C07-6 TestReport（可定稿「不通过」，定稿≠放行）/ DSG-C13-2 / DSG-C14-2（REPORT_BASIS_MISMATCH）；LLD-4 DSG-D07-7 `tst_reports` / DSG-D11-1；LLD-5 DSG-A07-10/12 | ✅ |
| REQ-509 | 条件放行 | P0 | `acceptanceRelease` | LLD-3 DSG-C07-7（豁免仅 P2/P3）/ DSG-C14-2（WAIVER_NOT_ALLOWED）；LLD-4 DSG-D07-3（priority）/ DSG-D07-6（severity P0~P3）/ DSG-D07-8（exemptions）；LLD-5 DSG-A01-4 / DSG-A07-11；LLD-6 DSG-U06-20（差异登记：条件放行系对原型 `acceptanceRelease` 无豁免通道的已裁决放宽，豁免逐项列举入交付决定工件并留痕，P0/P1/必测未执行/证据失真不可豁免） | ✅ |
| REQ-510 | 交付决定 | P0 | `decisions` | LLD-3 DSG-C07-7 ReleaseDecision（不可变工件）/ DSG-C13-2；LLD-4 DSG-D07-8 `tst_decisions`；LLD-5 DSG-A07-11/12 / DSG-A07-13/14（批次 blocked 态拒绝含放行在内的一切推进命令） | ✅ |
| REQ-511 | 验收工作台 | P0 | `viewTest（V19 验收工作台）` | 区间承接：HLD DSG-M01/M07、LLD-1 DSG-M07、LLD-5 DSG-A07（REQ-501~511 区间）；LLD-6 DSG-U03-6 测试验收页（四页签工作台：提测与计划/用例与执行/缺陷与回归/报告与交付）；LLD-5 DSG-A07-13/14 批次阻断/恢复端点（batch.block/unblock，批次条状态流转入口） | ✅ |

### 3.6 AI 助手与多 Agent 编排（REQ-6xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-601 | 全局 AI 助手 | P0 | `chatDockHtml / keydown F1` | LLD-3 DSG-C08-1 AiSession（ctx 上下文感知）；LLD-4 DSG-D08-1 `ai_sessions`；LLD-5 DSG-A08-1/3；LLD-6 DSG-U02-4 助手 dock / DSG-U02-6 快捷键（F1）/ DSG-U05-2 开合布局；LLD-7 DSG-N05-2；判定句（PRD 波次 2）：任一一级页面 F1 可开合、dock 头部上下文 chip 随路由即时更新 | ✅ |
| REQ-602 | 会话管理 | P1 | `sessions` | LLD-3 DSG-C08-1；LLD-4 DSG-D08-1；LLD-5 DSG-A08-1（创建/列表/切换）/ DSG-A08-2（历史）；LLD-6 DSG-U02-4 | ✅ |
| REQ-603 | 流式输出与控制 | P0 | `streamReply/tickStream` | LLD-2 DSG-F02-12 流式生成控制状态机；LLD-3 DSG-C08-2 AiMessage（停止不留半截）；LLD-4 DSG-D08-2 `ai_messages`；LLD-5 DSG-A04-5 / DSG-A08-3/4 / DSG-A01-6 / DSG-A11-3；LLD-7 DSG-N01-2 / DSG-N05-3（SSE 降级） | ✅ |
| REQ-604 | 思考强度 | P2 | `思考强度` | LLD-3 DSG-C08-1（ThinkLevel）；LLD-4 DSG-D08-1（think_level）；LLD-5 DSG-A08-3；LLD-6 DSG-U02-4（三档选择）/ DSG-U03-9 | ✅ |
| REQ-605 | 工具注册表 | P0 | `AGENT_TOOLS / registerTool` | LLD-3 DSG-C08-3 ToolCall（未注册拒绝、写类工具必审计）/ DSG-C14-2（TOOL_UNREGISTERED）；LLD-4 DSG-D08-3 `ai_tool_calls`；LLD-5 DSG-A08-5 | ✅ |
| REQ-606 | 导航能力 | P1 | `NAV_MAP / NAV_KEYS` | HLD DSG-M01（路由契约供 M08 导航工具按名跳转）；LLD-4 DSG-D08-3；LLD-5 DSG-A08-5（NAV_MAP） | ✅ |
| REQ-607 | 下一步建议 | P1 | `nextStepRules` | LLD-5 DSG-A08-6 下一步建议；区间承接：HLD DSG-M08、LLD-1 DSG-M08（REQ-601~614 区间） | ✅ |
| REQ-608 | 上下文引用 | P0 | `chat-reference.js` | LLD-4 DSG-D08-1（refs 引用快照）/ DSG-D08-2（input_fingerprint）；LLD-5 DSG-A04-4 / DSG-A08-3（受 REQ-114/115 门禁）；LLD-7 DSG-N07-4 | ✅ |
| REQ-609 | 多 Agent 管理 | P1 | `agents / prompt vers` | LLD-3 DSG-C08-4 PromptVersion（可回滚）；LLD-4 DSG-D08-2（prompt_version_id）/ DSG-D08-4 `ai_prompt_versions`；LLD-5 DSG-A08-7；LLD-6 DSG-U03-9 | ✅ |
| REQ-610 | 委派执行 | P1 | `viewDelegate / targets` | HLD DSG-M09 / DSG-M10；LLD-1 DSG-M09；LLD-3 DSG-C03-5（解析可委派）/ DSG-C08-7 Delegation / DSG-C14-2（DELEGATION_TARGET_UNAVAILABLE）；LLD-4 DSG-D08-7 `ai_delegations` / DSG-D08-8 目标注册；LLD-5 DSG-A08-8；LLD-6 DSG-U03-8 委派页 / DSG-U06-11 / DSG-U06-18（委派注册向导与并发上限差异登记）；LLD-7 DSG-N02-4 | ✅ |
| REQ-611 | 模型管理 | P0 | `models m1-m4` | HLD §2（编排层抽象 Provider SDK）/ DSG-M10；LLD-3 DSG-C08-5 ModelConfig（按用途路由）；LLD-4 DSG-D08-2（model_id）/ DSG-D08-5 `ai_models`（routes）；LLD-5 DSG-A08-9；LLD-6 DSG-U03-9；LLD-7 DSG-N02-3 | ✅ |
| REQ-612 | 成本统计 | P1 | `usage` | LLD-3 DSG-C02-1（costTotal）/ DSG-C08-6 UsageRecord（Usage 从消息结果提取落库、非独立事件流；自定义模型 cost 由平台 price_table 兜底）；LLD-4 DSG-D08-5（price_table）/ DSG-D08-6 `ai_usage`；LLD-5 DSG-A08-10；LLD-6 DSG-U02-4（用量条）/ DSG-U06-12；LLD-7 DSG-N04-4（按模型/用途分维度指标） | ✅ |
| REQ-613 | AI 行为边界 | P0 | `方案§3/§4` | HLD ADR-6（AI 通道技术上无法调用定稿/放行人工分支）；LLD-1 DSG-M00-3 红线 3 / DSG-M08；LLD-3 DSG-C04-4 / DSG-C08-3 / DSG-C14-2（TOOL_DENIED / POLICY_MANUAL_REQUIRED）；LLD-4 DSG-D04-4 / DSG-D08-3（denied 留痕）；LLD-5 DSG-A09-3 | ✅ |
| REQ-614 | 编排层抽象 | P0 | `decideMock → AI 编排层` | HLD ADR-2 / ADR-6；LLD-1 DSG-M00-3 / DSG-M08；LLD-4 DSG-D08-2/3；LLD-5 DSG-A08-3/9；LLD-7 DSG-N07-4 | ✅ |
| REQ-615 | AI 后台基于 Pi SDK | P0 | `新增: 2026-09-20 用户决策；原型委派目标 pi_native 为先导` | PRD REQ-609~615；HLD §2 技术选型「AI 接入」/ ADR-6（Pi SDK+平台强制层分层）/ ADR-8（委派 pi RPC）；LLD-1 DSG-M08-1/3/4/5（PiAiGateway/AgentRuntime/SessionStore/ToolBridge/UsageCollector）、DSG-M09-1/4；LLD-2 DSG-F02-12（实现载体注）；LLD-3 §8（Pi 运行时映射注）；LLD-5 DSG-A08（实现载体注） | ✅ |

### 3.7 平台通用（REQ-7xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-701 | 项目管理 | P0 | `viewProjects / projModal` | HLD DSG-M13；LLD-1 DSG-M13；LLD-3 DSG-C02-1 Project；LLD-4 DSG-D03-1 `projects`（只归档不可删除，D17）；LLD-5 DSG-A02-1/2/3 / DSG-A10；LLD-6 DSG-U03-1 项目列表页 | ✅ |
| REQ-702 | 阶段导航与准入 | P0 | `topbarHtml / devProjectOk` | LLD-3 DSG-C02-1 / DSG-C11-1（issues 缺口具体化）；LLD-4 DSG-D03-1（stage_gates 求值快照）/ DSG-D04-6；LLD-5 DSG-A01-1 / DSG-A02-4 阶段准入查询 / DSG-A04-12 / DSG-A11-4；LLD-6 DSG-U02-1 应用骨架 / DSG-U02-2 一级列/二级列与五阶段导航（阶段钮永远可点、缺口由一级列 ⛔ 角标+页内门禁横幅明示）/ DSG-U06-21（移除 pill 置灰虚构描述差异登记）/ DSG-U06-25（顶栏→左侧三栏差异登记） | ✅ |
| REQ-703 | 通知与事件 | P1 | `notices / events` | LLD-3 DSG-C02-5 Notification/DomainEvent / DSG-C10-3；LLD-4 DSG-D09-3 `evd_events` / DSG-D10-5 `sys_notifications`；LLD-5 DSG-A01-6（notice.created）/ DSG-A02-6 / DSG-A10-2 / DSG-A11-3；LLD-6 DSG-U02-2（铃铛+抽屉）/ DSG-U03-7 / DSG-U07-1 / DSG-U06-16（通知 popover→抽屉差异登记） | ✅ |
| REQ-704 | 任务中心 | P1 | `viewTasks` | LLD-1 DSG-M13（只读聚合）；LLD-4 DSG-D00（`sys_tasks_view` 跨域只读视图）；LLD-5 DSG-A02-5；LLD-6 DSG-U03-7 任务中心页；判定句（PRD 波次 2）：列表计数=各阶段已产生 Task 总数、行可跳回所属阶段会话 | ✅ |
| REQ-705 | 设置 | P1 | `viewSettings` | LLD-3 DSG-C09-2 Setting；LLD-4 DSG-D08-4 / DSG-D10-4 `sys_settings`；LLD-5 DSG-A10-1；LLD-6 DSG-U03-9 设置页 / DSG-U06-17（设置页新增放行策略/审计/备份三组差异登记） | ✅ |
| REQ-706 | 审计日志 | P0 | `devAudit` | HLD DSG-M11；LLD-2 DSG-F03-1 / DSG-F03-3（审计失败零写路径）；LLD-3 DSG-C01-3 Actor / DSG-C02-4 AuditEntry / DSG-C10-3 / DSG-C14-1；LLD-4 DSG-D01-3 / DSG-D09-1 `evd_records` / DSG-D09-2 `audit_log` / DSG-D10-1；LLD-5 DSG-A01-3 / DSG-A05-13 / DSG-A10-3（只读导出，无改删端点）/ DSG-A11-1；LLD-6 DSG-U07-2 / DSG-U06-17（审计查询入口差异登记）；LLD-7 DSG-N02-1 / DSG-N02-12 / DSG-N04-1/3 / DSG-N07-2 | ✅ |
| REQ-707 | 账号与权限（后续扩展） | P2 | `新增: 自托管真实化，分期扩展` | HLD DSG-M02 / ADR-9；LLD-1 DSG-M02 / DSG-M10；LLD-3 DSG-C01-1（操作者字段不留空）/ DSG-C01-3；LLD-4 DSG-D01-3 / DSG-D10-3 `sys_users`；LLD-5 DSG-A01-2（本地默认身份注入）/ DSG-A10-5；LLD-6 DSG-U03 权限态说明 / DSG-U06-1 登录页 / DSG-U06-6；LLD-7 DSG-N02-1；注（2026-10-10 差异回补，登记条目 35）：公网部署加装 env 门控简易登录——MSF_AUTH_USER+MSF_AUTH_PASS 双 env 同时设置才启用（未设置=本地开发零鉴权、行为完全不变），HMAC-SHA256 签名 cookie（HttpOnly+SameSite=Lax、无状态 7 天），/api/** 无有效 cookie 恒 401 UNAUTHENTICATED（豁免 login/whoami/health），登录限流双闸（同 IP 错 5 次锁 10 分钟+全局 30 次/10 分钟）；属本期「本地账号最简形态」的部署期门控口径（用户 2026-10-08 拍板，裁决见统稿裁决记录 R-05），扩展期项（OIDC/LDAP、RBAC、会话鉴权强化）不变 | ✅ |
| REQ-708 | 备份与导出 | P1 | `新增: 持久化配套` | HLD DSG-M11 / DSG-M13 / §6（PG dump+MinIO 版本化桶）；LLD-1 DSG-M11 / DSG-M13；LLD-4 DSG-D07-7（报告导出）/ DSG-D09-1 / DSG-D11-3 / DSG-D11-4 证据包导出格式；LLD-5 DSG-A10-4；LLD-6 DSG-U06-8 / DSG-U06-17（备份入口差异登记）；LLD-7 DSG-N03-5/6 / DSG-N08-2 | ✅ |
| REQ-709 | 客户工件多语言 | P1 | `客户模板 i18n / data-i18n` | LLD-1 DSG-M13（设置面配置入口）；LLD-2 DSG-F02-11 客户工件 CMS 内容状态机；LLD-6 DSG-U01-1 / DSG-U04-4 预览内容与多语言 / DSG-U07-4 | ✅ |
| REQ-710 | 自托管部署 | P0 | `新增: 产品形态` | HLD §1 形态（六服务 Compose，含 egress-proxy）/ §6 部署与安全边界；LLD-1 DSG-M13；LLD-3 DSG-C09-2（secret 密文引用）；LLD-4 DSG-D01-1（单 schema）/ DSG-D08-5（api_key_enc）；LLD-5 DSG-A10-1；LLD-7 DSG-N02-2/3 / DSG-N07-4 数据不出内网 / DSG-N08-3 | ✅ |
| REQ-711 | 放行策略引擎 | P0 | `新增: 人工放行自动化就绪` | HLD DSG-M12 / ADR-7；LLD-1 DSG-M00-3 红线 4 / DSG-M12；LLD-2 DSG-F10-1 策略模型与求值 / DSG-F10-2 切换授权；LLD-3 DSG-C09-1 PolicyGate / DSG-C14-2（GATE_BLOCKED）；LLD-4 DSG-D07-8 / DSG-D10-6 `policy_gates` / DSG-D10-7 `policy_gate_events`；LLD-5 DSG-A01-4（POLICY_MANUAL_REQUIRED）/ DSG-A04-7 / A05-9 / A06-7 / A06-19 / A07-11 / DSG-A09-1/2/3 | ✅ |
| REQ-712 | 生产发布扩展点 | P2 | `新增: 后续扩展预留` | HLD §1（预留接口）/ DSG-M10 / ADR-9（ReleaseAdapter）；LLD-1 DSG-M07（getReleasePackage 数据形态）/ DSG-M10（ReleaseAdapter）；LLD-3 DSG-C07-7（放行批次+证据包为唯一输入形态）；LLD-4 DSG-D07-8（decision_fingerprint 消费单元）/ DSG-D11-4 证据包格式 / DSG-D06-9 `dev_ci_reports`（CI webhook 回传落库，append-only）/ DSG-D10-8 `sys_webhook_secrets`（项目级 webhook 密钥）；LLD-5 DSG-A06-21 CI 回传 webhook（HMAC-SHA256 签名+投递幂等，REQ-712 预留接口的 CI 入口）/ DSG-A06-22 webhook secret 登记（只写不读）；LLD-6 DSG-U06-6（入口置灰可见） | ✅ |

### 3.8 非功能需求（REQ-8xx）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-801 | 性能 | P1 | `新增: 产品化`（PRD §6 承诺） | HLD §7；LLD-3 DSG-C11-1（Page\<T\> 分页）；LLD-4 DSG-D15 / DSG-D15-1 规模估算 / DSG-D15-2 索引策略；LLD-5 DSG-A01-5 分页约定；LLD-6 DSG-U06-2/3；LLD-7 DSG-N01-1~7 全节（首 token 按模型档位分档：本地 ≤3s/云端 ≤8s 为目标值，链路开销 <500ms 与 >10s 等待提示为承诺值）/ DSG-N05-3 / DSG-N08-1 | ✅ |
| REQ-802 | 并发与规模 | P1 | `新增: 产品化` | HLD §7；LLD-1 DSG-M02（幂等防重）；LLD-3 DSG-C11-1；LLD-4 DSG-D15 / DSG-D15-1 / DSG-D15-2；LLD-5 DSG-A01-5；LLD-7 DSG-N01-1/3/4/7 / DSG-N08-1/2/3 | ✅ |
| REQ-803 | 安全 | P0 | `新增: 产品化` | HLD ADR-6 / ADR-8（沙箱编排选型：默认 docker.sock+最小权限补偿，DinD 为加固选项）/ §6（`egress-proxy` 部署单元=沙箱出向唯一通道）；LLD-1 DSG-M02 / DSG-M09（沙箱出向经 egress-proxy、密钥会话级临时注入）/ DSG-M10；LLD-3 DSG-C08-7 / DSG-C11-1 / DSG-C14-1；LLD-4 DSG-D08-5/7/8 / DSG-D10-3；LLD-5 DSG-A01-2 / DSG-A11-5 预览子域 TLS（预览面与主站会话 Cookie 域隔离）；LLD-6 DSG-U04-1 / DSG-U06-1/5；LLD-7 DSG-N02-1~12 全节（鉴权/传输/密钥/沙箱/上传/XSS/CSRF/注入/SSRF/预览隔离/审计不可抵赖；DSG-N02-4 沙箱出向例外与编排选型引用） | ✅ |
| REQ-804 | 可靠性 | P0 | `新增: 产品化` | HLD §7；LLD-2 DSG-F03-4 效果 ledger 幂等补记；LLD-4 DSG-D10-2 / DSG-D11-2（每日链校验）/ DSG-D13；LLD-5 DSG-A10-4 / DSG-A10-6 健康检查；LLD-6 DSG-U06-3；LLD-7 DSG-N03-1~7 全节 / DSG-N04-5 | ✅ |
| REQ-805 | 可观测性 | P1 | `新增: 产品化` | HLD §7 / ADR-2（故障注入配套）；LLD-1 DSG-M11；LLD-4 DSG-D09-2 / DSG-D11-2；LLD-5 DSG-A10-3 / DSG-A10-6；LLD-7 DSG-N04-1~5 全节 / DSG-N08-2 | ✅ |
| REQ-806 | 兼容性 | P1 | `新增: 产品化` | HLD DSG-M01 / §7；LLD-6 DSG-U01-1/2/3/6 / DSG-U02-1/5/6 / DSG-U05-1~4（三档视口+助手开合+移动视口+兼容矩阵）/ DSG-U07-4；LLD-7 DSG-N05-1/2/3 | ✅ |
| REQ-807 | 可维护性 | P1 | `新增: 产品化` | HLD ADR-1；LLD-3 DSG-C01-1 命名与语言约定；LLD-4 DSG-D01-1 命名规范；LLD-6 DSG-U01-4 令牌补丁层归并；LLD-7 DSG-N06-1 模块边界检查 / DSG-N06-2 覆盖率目标 / DSG-N06-3 命令注册纪律 | ✅ |
| REQ-808 | 数据保留 | P2 | `新增: 产品化` | LLD-4 DSG-D02（归档不删证据，REQ-808 优先）/ DSG-D03-1 / DSG-D15 / DSG-D15-2（保留分区预留）；LLD-7 DSG-N07-1 证据默认永久保留 / DSG-N07-2 可配置保留策略 / DSG-N07-3；LLD-6 DSG-U06-22（项目「删除」改「归档」差异登记） | ✅ |

### 3.9 核心业务规则（BR-01~15，全部 P0）

| 编号 | 名称 | 优先级 | 原型出处 | 承接设计（册+条目） | 覆盖状态 |
| --- | --- | --- | --- | --- | --- |
| BR-01 | 内容指纹身份 | P0 | `契约§3 / devHash` | HLD DSG-M11 / ADR-4；LLD-1 DSG-M11；LLD-2 DSG-F01-1 / DSG-F04-1/2；LLD-3 DSG-C01-2 / DSG-C02-2 Fingerprint / DSG-C12-1 / DSG-C13-4；LLD-4 DSG-D03-3 / DSG-D04-2 / DSG-D05-2 / DSG-D06-4 / DSG-D09-1 / DSG-D11-2 / DSG-D14 | ✅ |
| BR-02 | 双层指纹 | P0 | `契约§3` | HLD ADR-4；LLD-2 DSG-F04-1 / DSG-F04-3 双层指纹分离规则；LLD-3 DSG-C01-2 / DSG-C02-2 / DSG-C12-1；LLD-4 DSG-D04-1/2 / DSG-D05-1/2 / DSG-D14（readiness 不进指纹） | ✅ |
| BR-03 | 不可变证据 | P0 | `契约§2/§4` | HLD DSG-M11 / ADR-5；LLD-1 DSG-M00-3 红线 6 / DSG-M11；LLD-3 DSG-C02-3 EvidenceRef / DSG-C04-2 / DSG-C06-6 / DSG-C07-6 / DSG-C12-5 / DSG-C13-2；LLD-4 DSG-D01-2/4 / DSG-D09-1/3 / DSG-D11-1/2/4；LLD-7 DSG-N06-1 / DSG-N07-1 | ✅ |
| BR-04 | 封闭命令与原子事务 | P0 | `契约§5 / preparePrototypeCommand` | HLD ADR-3；LLD-1 DSG-M00-1 / DSG-M00-2 / DSG-M00-3 红线 2；LLD-2 DSG-F03-1/2/3；LLD-3 DSG-C02-4 / DSG-C10-1/2 / DSG-C13-4 INV-TX-1 / DSG-C14-1/2；LLD-4 DSG-D09-2 / DSG-D10-1/2 / DSG-D13；LLD-5 DSG-A01-1/3/4 / DSG-A10-3 / DSG-A11-1；LLD-7 DSG-N02-8 / DSG-N03-1 | ✅ |
| BR-05 | 草稿与历史分离 | P0 | `原型草稿与历史版本重设计` | LLD-2 DSG-F02-1（含发布前不变式）；LLD-3 DSG-C04-2/3 / DSG-C12-2 / DSG-C13-1；LLD-4 DSG-D00 / DSG-D01-2/4 / DSG-D04-2/3 / DSG-D05-2/3 / DSG-D12 专题；LLD-5 DSG-A04-3/6/8；LLD-6 DSG-U02-7；LLD-7 DSG-N03-4（绝不重建丢失历史） | ✅ |
| BR-06 | 人工确认点（可自动化就绪） | P0 | `方案§2/§4` | HLD DSG-M12 / ADR-7；LLD-1 DSG-M12；LLD-2 DSG-F07-3 / DSG-F10-1/2（7 点全集注册表）；LLD-3 DSG-C04-4 / DSG-C05-4 / DSG-C07-2 / DSG-C09-1 / DSG-C14-2（POLICY_MANUAL_REQUIRED）；LLD-4 DSG-D04-2 / DSG-D05-6 / DSG-D06-8 / DSG-D07-2/8 / DSG-D10-6/7；LLD-5 DSG-A09 全章 / DSG-A04-7 / A05-9 / A06-7 / A06-19 / A07-11；LLD-6 DSG-U06-9 / DSG-U07-2 / DSG-U06-17（放行策略配置入口差异登记） | ✅ |
| BR-07 | 门禁与失效传播 | P0 | `契约§4.1 / devInvalidate` | HLD ADR-4；LLD-2 DSG-F02-2 / DSG-F04-4 / DSG-F10-2（auto 立即回到阻断态）；LLD-3 DSG-C04-4 / DSG-C05-3/4 / DSG-C13-4；LLD-4 DSG-D02 / DSG-D04-4/5/7 / DSG-D05-6/7 / DSG-D06-2 / DSG-D13-4 / DSG-D14；LLD-5 DSG-A01-4/6 / DSG-A02-4 / DSG-A05-10 / DSG-A06-15/19 / DSG-A09-2 / DSG-A11-4；LLD-7 DSG-N01-6（禁脏读门禁误判） | ✅ |
| BR-08 | 异步操作身份 | P0 | `契约§4.1` | LLD-2 DSG-F01-2 四元组身份 / DSG-F07-2；LLD-3 DSG-C01-2/3 / DSG-C06-3 / DSG-C12-3 / DSG-C13-4 INV-ASYNC-1；LLD-4 DSG-D01-3 / DSG-D06-3 / DSG-D09-1/2/3 / DSG-D10-3 / DSG-D13-5；LLD-5 DSG-A01-2（网关剥离伪造头）/ DSG-A01-6 / DSG-A10-7 / DSG-A11-2/3；LLD-6 DSG-U06-13；LLD-7 DSG-N02-12 / DSG-N03-4 / DSG-N04-2 | ✅ |
| BR-09 | 通过语义 | P0 | `V19_UI_ACCEPTANCE_RULES / ui-scoring` | LLD-2 DSG-F02-9 / DSG-F05-1/2 / DSG-F10-1；LLD-3 DSG-C05-4（冻结分母）/ DSG-C06-5 / DSG-C13-3 / DSG-C15-1（UI_OUTCOME_UNKNOWN，§15(i) 评分子码）；LLD-4 DSG-D06-5/6 / DSG-D07-3/4/5；LLD-5 DSG-A06-16 / DSG-A07-4 / DSG-A09-2；LLD-7 DSG-N06-2 | ✅ |
| BR-10 | 失败纪律 | P0 | `契约§8-10` | LLD-2 DSG-F02-7 / DSG-F07-2（DISPATCH_NO_PROGRESS 防空转）/ DSG-F07-4；LLD-4 DSG-D06-5 / DSG-D07-4（previous_run_id 重跑链）；LLD-5 DSG-A06-8 / DSG-A11-4（issues.target 定位）；LLD-6 DSG-U07-1/2/3；LLD-7 DSG-N03-3 | ✅ |
| BR-11 | 证据真实性 | P0 | `方案§3` | LLD-1 DSG-M01（对照视图两侧不得同对象）/ DSG-M09 / DSG-M10（CI_STATUS_UNKNOWN 不猜测）；LLD-2 DSG-F02-9；LLD-3 DSG-C02-3（simulated）/ DSG-C06-5 / DSG-C13-4 INV-EVID-1 / DSG-C14-2（EVIDENCE_SIMULATED）；LLD-4 DSG-D06-6 / DSG-D07-4/5；LLD-5 DSG-A06-13/17 / DSG-A07-5；LLD-6 DSG-U04-3 / DSG-U06-10；LLD-7 DSG-N03-7 | ✅ |
| BR-12 | 单一写者 | P0 | `实施计划全局约束 / basis()` | LLD-2 DSG-F02-1 / DSG-F02-4；LLD-3 DSG-C03-2/4 / DSG-C04-1/3 / DSG-C10-1 / DSG-C13-4 INV-BULK-1 / DSG-C14-2（VERSION_CONFLICT）；LLD-4 DSG-D03-5 / DSG-D04-1/3 / DSG-D05-1 / DSG-D12-6 / DSG-D15-2；LLD-5 DSG-A01-3 / DSG-A02-3 / DSG-A03-13/15；LLD-6 DSG-U06-14 | ✅ |
| BR-13 | 自动执行归属 | P0 | `契约§9` | LLD-2 DSG-F02-6 / DSG-F07-1/2；LLD-3 DSG-C01-2/3 / DSG-C06-3 / DSG-C12-4 归属三元组；LLD-4 DSG-D01-3 / DSG-D06-3/8 / DSG-D09-2；LLD-5 DSG-A01-2 / DSG-A06-10/11 / DSG-A11-2；LLD-7 DSG-N02-12 / DSG-N04-2 | ✅ |
| BR-14 | 崩溃恢复 | P0 | `原型写事务重设计` | LLD-2 DSG-F03-1/2/4；LLD-3 DSG-C06-3（效果 ledger 状态机）/ DSG-C13-4 INV-EFFECT-1；LLD-4 DSG-D10-1/2 / DSG-D13；LLD-5 DSG-A01-3 / DSG-A10-7 / DSG-A11-1/2；LLD-6 DSG-U02-7 / DSG-U06-13；LLD-7 DSG-N03-2/4 | ✅ |
| BR-15 | 示例数据隔离 | P0 | `新增: 产品化` | LLD-1 DSG-M13；LLD-3 DSG-C02-1（isSample）；LLD-4 DSG-D03-1（is_demo，不作为真实门禁依据）；LLD-6 DSG-U06-7（示例独立分组+徽标） | ✅ |

### 3.10 上游需求层（R ← CR → REQ，详见 `CRD.md`）

R-xx（原始诉求，保留用户原话要点）与 CR-xx 的完整陈述与出处见 `CRD.md`；此处登记 CR→REQ 的追溯主表。状态列：✅ 已承接；⏸ deferred（显式推迟，不进入 L0b 分母，计入 L0d 计数）；❌ 缺口。

| CR | 主题 | 承接 REQ/BR | 状态 |
| --- | --- | --- | --- |
| CR-01 | 五阶段流水线与阶段准入 | REQ-701/702、101/201/301/401/501 | ✅ |
| CR-02 | 开发后先自测、证据自动汇总 | REQ-407/413/417 | ✅ |
| CR-03 | 合格后人工确认转测试 | REQ-418/409、BR-06 | ✅ |
| CR-04 | 功能+UI 双达标门槛 | REQ-413/414/415 | ✅ |
| CR-05 | UI 符合度量化口径 | REQ-414、BR-09/11 | ✅ |
| CR-06 | 原型完整性（目录驱动） | REQ-304/305/307 | ✅ |
| CR-07 | 双向可追溯、内容一致 | REQ-207/208/306/312 | ✅ |
| CR-08 | 识别→生成→检查→定稿→基线 | REQ-306/308/309/310、BR-07 | ✅ |
| CR-09 | 保持简单、允许人工参与 | REQ-410/416/607/613、REQ-806 | ✅（「低操作负担」由 LLD-6 规范承接，PRD 无独立条目——半缺口事实陈述与出处见 `CRD.md` CR-09 承接列，是否补非功能条目待评审确认） |
| CR-10 | 保存/提交/定稿三独立动作 | REQ-203/205/209 | ✅ |
| CR-11 | 开发自测与测试验收职责分离 | REQ-501/503/504 | ✅ |
| CR-12 | 一批交付物一套不可变证据 | REQ-501/502、BR-01/03 | ✅ |
| CR-13 | 用例落到业务场景、skip≠pass | REQ-503/504/505 | ✅ |
| CR-14 | 缺陷修复+回归才能关闭 | REQ-506/507 | ✅ |
| CR-15 | 报告定稿≠放行 | REQ-508/509/510 | ✅ |
| CR-16 | 验收四页签与页头状态 | REQ-511/702 | ✅ |
| CR-17 | 资料库 ZIP/双目录/目录树 | REQ-102~107/110 | ✅ |
| CR-18 | 批量加工作业 | REQ-111 | ✅ |
| CR-19 | 停止-重设计纪律 | ❌ 非产品功能，由团队工作规程承接（CRD 登记备查）；相关产品侧规则 REQ-416、BR-10 | ⏸ deferred（规程承接；不进入 L0b 分母，计入 L0d=1） |
| CR-20 | 已交付版本不可变 | REQ-203/209、BR-05 | ✅ |
| CR-21 | 操作反馈真实、阻断明示 | REQ-702/416/703/307 | ✅ |
| CR-22 | 人工确认点可配置策略门禁 | REQ-711、BR-06（7 点全集） | ✅ |
| CR-23 | 生产发布预留扩展接口 | REQ-712 | ✅ |
| CR-24 | 多用户/权限后续扩展 | REQ-707、REQ-706 | ✅ |
| CR-25 | AI 后台基于 Pi SDK | REQ-615、REQ-609~614；HLD ADR-6、LLD-1 DSG-M08 | ✅ |

## 4. 反向孤儿清单（无法回溯到 REQ/BR 的 DSG 条目）

| DSG 条目 | 位置 | 情况 | 处置 |
| --- | --- | --- | --- |
| LLD-1 DSG-M00-4 横切服务归属说明 | LLD-1 §1.3 | 已按规则标注「补充设计」：统稿裁决 D-1——命令事务运行时不单列 M14、归属 M11，属架构归属说明，无直接需求上游 | 合规登记的补充设计，保留 |
| ~~LLD-2 DSG-F01-3 状态图约定~~ | LLD-2 §1 | **已回销（2026-09-20）**：条目已补标「补充设计（记法约定，无直接需求对应）」 | 已关闭 |
| ~~LLD-6 DSG-U06-4 预览加载方式~~ | LLD-6 §6 差异表（D4） | **已回销（2026-09-20）**：条目已补挂 REQ-803（预览不可信隔离）、REQ-307（预览交互不变） | 已关闭 |

其余全部 DSG 条目（含 HLD DSG-M00~M13、ADR-1~9；LLD-1 DSG-M00-1~3、M01~M13；LLD-2 DSG-F01-1~F10-2；LLD-3 DSG-C01-1~C14-2；LLD-4 DSG-D00~D15-2；LLD-5 DSG-A01-1~A11-4；LLD-6 DSG-U01-1~U07-4；LLD-7 DSG-N01-1~N08-3）均至少反向引用一条有效 REQ/BR。

备注（粒度问题，非孤儿）：~~LLD-6 DSG-U01-5 基础组件清单笼统引用~~ **已回销（2026-09-20）**：已改为按组件→页面→REQ 段的具体映射（含 REQ-206、REQ-511 点名）。REQ-206（目录同步）与 REQ-511（验收工作台）现已具备条目级点名承接。

## 5. 悬空引用清单（引用不存在 REQ/BR 编号的 DSG 条目）

**0 条。**

核查说明（全量提取 HLD + LLD-1~7 中全部 `REQ-\d{3}` / `BR-\d{2}` 词法标记，与 PRD 有效编号集合比对）：

- `REQ-512` 不出现在任何设计条目的承接引用中；仅出现于 `统稿裁决记录.md`（M1 裁决「LLD-4 悬空 REQ-512 → 改 REQ-712」）与 LLD-4 修订记录的历史叙述，属变更履历，非悬空引用。
- `REQ-001/002/003/005` 仅出现于 LLD-3 DSG-C04-5、LLD-4 DSG-D04-5、DSG-D05-4 的**格式示例**（RtmLink `to_code` 示例、目录条目 code 示例），非需求引用。
- `REQ-001` 另出现于 LLD-4 §1（约 L54，业务编号格式示例）；`REQ-001/002/077/096` 另出现于 LLD-5 DSG-A04-11/A04-12 的响应报文示例（约 L357/362），同属格式/报文示例，非需求引用。LLD-5 示例中的 `R-001/CR-001/R-003/R-008` 为三位写法，与 CRD 两位编号（R-01/CR-01）不一致——属**示例级差异**（示例报文风格），非编号口径冲突，不改示例也不改权威编号。
- 全部区间引用（如 REQ-101~115、REQ-601~614）展开后均落在 PRD 有效编号集合内。

## 6. 统计

### 6.1 按域统计

| 域 | 条目数 | ✅ 已承接 | ⬜ 非设计途径 | ❌ 缺口 | 覆盖率 | 其中 P0 数 | P0 覆盖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-1xx 资料库 | 15 | 15 | 0 | 0 | 100% | 9 | 100% |
| REQ-2xx 需求管理 | 10 | 10 | 0 | 0 | 100% | 8 | 100% |
| REQ-3xx 设计 | 12 | 12 | 0 | 0 | 100% | 10 | 100% |
| REQ-4xx 开发 | 20 | 20 | 0 | 0 | 100% | 17 | 100% |
| REQ-5xx 测试验收 | 11 | 11 | 0 | 0 | 100% | 11 | 100% |
| REQ-6xx AI 助手与编排 | 15 | 15 | 0 | 0 | 100% | 8 | 100% |
| REQ-7xx 平台通用 | 12 | 12 | 0 | 0 | 100% | 5 | 100% |
| REQ-8xx 非功能 | 8 | 8 | 0 | 0 | 100% | 2 | 100% |
| BR-01~15 核心业务规则 | 15 | 15 | 0 | 0 | 100% | 15 | 100% |
| **合计** | **118** | **118** | **0** | **0** | **100%** | **85** | **100%** |

### 6.2 结论与注意事项

- P0 条目 85 条，覆盖率 100%，无 P0 缺口。
- **本体系自算健康度（PRD REQ-208 四指标口径）**：L0a = 24/24 = 100%（active R 24 条均由 CR 承接；R-19 的唯一承接 CR-19 为 deferred，不计入分母——L0a 分母为 active R，2026-09-21 裁决 R-03 口径）≥ 0.95 ✓；L0b = 24/24 = 100%（active CR 24 条全部被 REQ 承接；CR-19 deferred 不进入分母）✓；L0c = 103/103 = 100%（103 条 REQ 均有至少一个 DSG 条目承接，见 §6.1 合计行）✓；L0d = 1（CR-19 显式 deferred）。
- REQ-406（代码仓视图）主承接为区间引用（HLD DSG-M06、LLD-1 DSG-M06、LLD-6 DSG-U03-5），已有 LLD-5 DSG-A06-9 条目级点名，区间外补充充分；REQ-511（验收工作台）由区间引用 + LLD-6 DSG-U03-6 四页签规格承接。REQ-206（目录同步）已于 2026-09-21 获得 LLD-6 DSG-U01-5 条目级点名承接（见 §3.2 行与 §4 备注），不再是「仅区间级承接」。
- 反向核对发现的 2 个未标注条目（DSG-F01-3、DSG-U06-4）与 1 处笼统引用（DSG-U01-5）均**已于 2026-09-20 回销**，见 §4。
- 悬空引用 0 条；编号重复 0 条。

## 7. 基线记录

| 日期 | 文件 SHA-256 清单 | 说明 |
| --- | --- | --- |
| 2026-09-20 | README `5ba42305ac05b121` / CRD `23bc75ca4e9c641a` / PRD `d945c49aa74210b9` / HLD `d424be41d6e868bc` / LLD-1 `542bea3f955b092b` / LLD-2 `0466a6e978cab9ce` / LLD-3 `f918d0f9984542f1` / LLD-4 `dceba7472c28f937` / LLD-5 `21a44fe9233f8285` / LLD-6 `c384519adfb9404d` / LLD-7 `eb59e14d6f27abcc` / RTM（本表登记前）`8be84853e5901100` / 统稿裁决记录 `4b00ac155363c255` | **首个基线**（评审修订波次 0~3 全部完成后登记；本目录非 git 检出，以全文件 SHA-256 前 16 位清单代替提交 SHA）。此时 L0a/L0b/L0c 自算 100%、L0d=1，check-codes.mjs 零违规，评审状态转「通过（修订后）」 |
| 2026-09-21 | README `5ba42305ac05b121` / CRD `1ca90240d66a48d3` / PRD `714b249dae4562c3` / HLD `157c960c119df041` / LLD-1 `dacb00a35d688036` / LLD-2 `16cb918053a3d943` / LLD-3 `b402cf550f0c5bf2` / LLD-4 `ae93a5b90cb7637e` / LLD-5 `725e5800d3015702` / LLD-6 `786377a6c96c3a88` / LLD-7 `eb59e14d6f27abcc` / RTM（本表登记前）`d34ea077b6819ad3` / 统稿裁决记录 `7b70b21ecf2412c4` | **二轮基线**（二轮评审修订 W5A~W5D + 原型代理全部完成后登记）。L0a 口径改 active R（R-03-1）后自算仍 100%（L0b/L0c 同 100%、L0d=1）；check-codes.mjs 零违规；build-rtm-index.mjs 反向索引 411 条目、无零引用行；新增锚点 DSG-A07-13/14、A06-22、D10-8、U06-24 等 12 个已双向挂接 |

| 2026-09-29 | README `5ba42305ac05b121` / CRD `1ca90240d66a48d3` / PRD `714b249dae4562c3` / HLD `157c960c119df041` / LLD-1 `dacb00a35d688036` / LLD-2 `16cb918053a3d943` / LLD-3 `b402cf550f0c5bf2` / LLD-4 `bd7987cf015c7ff8` / LLD-5 `713861c37efa6bc4` / LLD-6 `5d0c93d3f8956639` / LLD-7 `eb59e14d6f27abcc` / RTM（本表登记前）`95227b71e1a9042c` / 统稿裁决记录 `60cf77073ca1699a` | **R-04 基线**（产品化实机走查修订：req_pendings.reason 增列（D04-4/A04-10）、LLD-5 回补 A06-23/24 并扩展 A06-7、LLD-6 §3.5 措辞回销「开发自测」；裁决见统稿裁决记录 R-04）。check-codes.mjs 零违规；接口/UI 行为不变（文档追认 + 增列为 additive） |
| 2026-10-04 | README `5ba42305ac05b121` / CRD `1ca90240d66a48d3` / PRD `714b249dae4562c3` / HLD `157c960c119df041` / LLD-1 `dacb00a35d688036` / LLD-2 `16cb918053a3d943` / LLD-3 `d624e4c2bc91a781` / LLD-4 `6ee04aee60185ff6` / LLD-5 `bccbbc13a603ec11` / LLD-6 `66d528270e53e4ae` / LLD-7 `eb59e14d6f27abcc` / RTM（本表登记前） `26585f1cdb8222d7` / 统稿裁决记录 `60cf77073ca1699a` | **差异回补基线**（两份差异登记回补：① `doc/dev-plan/AI会话互通与对话改文档-差异登记.md`——LLD-3 C04-4 PendingPatch 增 after 锚点+失配回退、LLD-4 D04-4 增 seq 列、LLD-5 A08-5 工具桥两分/A08-3 系统提示构成/A04-13 导出编号注入、LLD-6 §3.3 章节编号与生成链注+U02-4 工具卡分档；② `doc/dev-plan/V2排版改造-差异登记.md`——LLD-6 U02-1/2 重写为左侧三栏、各页页签收编二级列、新增 U06-25 并挂 REQ-702）。行为不变（文档追认+additive 增列）；REQ/BR/DSG 编号零增删 |
| 2026-10-10 | README `5ba42305ac05b121` / CRD `1ca90240d66a48d3` / PRD `d27cf88cc769e2fe` / HLD `50ef121206ff56b1` / LLD-1 `c9890d9797d947d8` / LLD-2 `81ef59271bc9bef2` / LLD-3 `1a2b27d78a2c8d03` / LLD-4 `1e8d65545bab86e5` / LLD-5 `316d70610f5b8d15` / LLD-6 `ed54dcb25381ac2d` / LLD-7 `85104114d7ccc641` / RTM（本表登记前）`4438773304bcacef` / 统稿裁决记录 `81edc9507e907c76` | **差异回补基线（登记条目 11~38 全量）**：`doc/dev-plan/AI会话互通与对话改文档-差异登记.md` 条目 11~38 全 28 条落册——LLD-3（C04-4 findSection 统一命中/replace 补丁类型/改后接受两域同构/册前缀码括号形态、C10-2 增 doc.section.add/del 与模板套件七命令、C08-1 AiSession docKind）、LLD-4（D04-4 replace/dsg_pendings 0026 reason、D08-1 ai_sessions.doc_kind 0029、D08-2 同刻排序决胜、**新增 D10-9 模板套件四表**（0027/0028）、D01-5 MSF_FILES_PROXY 接线）、LLD-5（§1.2 env 门控登录+同进程静态托管、§1.6 stream.notice 帧+X-Accel-Buffering+断流有界重试、A04-4 prompt 构成单一权威、**新增 A04-14 RTM 覆盖闭环/A04-15 章节增删/A08-11 模板 AI 起草/A10-8 文档模板/A10-9 文件代理**、A08-3 接力循环上限调 8/围栏容错/重编号必走 rewrite）、LLD-6（U02-4 dock 行为口径、§3.1 套件关联行、§3.3/§3.4 补丁 UX/增删节/上游徽标/RTM 闭环/模板钮/排版美化、§3.9 📄 文档模板组、U06-1 登录口径）、LLD-7（N02-1 登录门控/N01-5 文件代理/N05-3 断流重试与 SSE 直通）、LLD-1（M02 登录门/M08 会话工件绑定/M11 签名 URL 双形态/M13 模板套件）、LLD-2（**新增 §11 DSG-F11 文档模板解析与装配流程** F11-1~F11-4）、PRD/RTM（REQ-707 分期口径）、统稿裁决记录（**新增 R-05** 公网部署简易登录门控裁决）。行为不变（文档追认+additive 增列）；既有 REQ/BR/DSG 编号零增删（新增锚点均为章末顺延）；check-codes.mjs 零违规（白名单补 env 变量名/SQL 关键字/生成链常量 19 个）；build-rtm-index.mjs 反向索引 412 条目、无零引用行 |

## 8. 修订记录

| 日期 | 条目 | 变更 |
| --- | --- | --- |
| 2026-09-20 | 全部 | 初稿：102 条 REQ + 15 条 BR 全量正向矩阵（逐条核对 HLD/LLD-1~7 引用，区间引用逐条展开）；反向孤儿 3 条（1 条已合规标「补充设计」，2 条待补标）；悬空引用 0 |
| 2026-09-20 | §4 及备注 | 回销：DSG-F01-3 补标补充设计；DSG-U06-4 补挂 REQ-307/803；DSG-U01-5 笼统引用细化为分区映射（REQ-206/511 获点名承接） |
| 2026-09-20 | §3.6/§3.10/§6 | 变更落档：新增 REQ-615（AI 后台基于 Pi SDK）入矩阵；新增 §3.10 上游需求层（CR-01~25 → REQ，追溯链扩展为 R←CR←REQ←DSG）；统计更新为 118 条（103 REQ + 15 BR）、P0 85 条 |
| 2026-09-20 | §3.2/§3.3/§3.10/§6.2 | 评审修改（波次 1-2/1-3）：CR-19 状态改 ⏸ deferred（不进入 L0b 分母，计入 L0d），§3.10 补 deferred 状态图例；REQ-208 行对齐四指标新口径（L0c 恢复为 REQ→DSG 锚点覆盖率，原型出处补 `rtmL0c`）；REQ-310 行原型出处补 `devGate`；§6.2 补本体系自算健康度（L0a=100%、L0b=100%、L0c=100%、L0d=1） |
| 2026-09-20 | 首部范围注、§1、§3 多行 | 评审修改（波次 2-2）：首部登记原型 P 节点差异（原型节点卡 9 类含 P=原型 UI 过渡态锚点，产品化由 DSG-U/LLD-6 承接，出处 `../msf-prototype.html` L803 `DSG_DEFS`）；§1-2 补反向索引脚本 `tools/build-rtm-index.mjs` 引用（随涉及追溯的提交刷新）；REQ-803 行补承接设计引用（HLD §6 egress-proxy 部署单元、ADR-8 沙箱编排选型、LLD-1 M09、LLD-7 N02-4）；REQ-413/REQ-414/BR-09 行错误码锚点由 DSG-C14-2 更正为 DSG-C15-1（SELFTEST_REQUIRED/UI_EXPECTED_MATRIX_MISMATCH/UI_OUTCOME_UNKNOWN 于波次 0 迁移 §15，码值不变） |
| 2026-09-20 | §3 多行 | 评审修改（波次 2A 移交同步）：REQ-102/111/208/210/405/509/601/612/704/801 行按 PRD 最新表述对齐（封闭六格式枚举、整批快照+开始复核+变化行跳过、空分母条款、乐观锁首期内建理由、看板四列中文名、条件放行已裁决放宽注明、F1/chip 判定句、Usage 从消息结果提取、任务中心判定句、首 token 分档阈值）；补 LLD-6 新增差异条目反向追溯：DSG-U06-16→REQ-703、U06-17→REQ-705/706/708/711、U06-18→REQ-610、U06-19→REQ-504、U06-20→REQ-509、U06-21→REQ-702（行内「置灰」旧表述同步更正为「pill 永远可点、缺口页内横幅明示」）、U06-22→REQ-808 |
| 2026-09-21 | §2、§3.1/§3.2/§3.3/§3.5/§3.7/§3.8、§3.10、§5、§6.2、首部 | 二轮评审整改：① REQ-206 行补 LLD-6 DSG-U01-5 条目级点名承接（§4 已回销的笼统引用细化即含 REQ-206 点名），删「无条目级点名/建议补挂」注，§6.2 同步删除 REQ-206 条目（仅留 REQ-406 区间主承接说明）、§2 图例旧括注同步清理；② 新锚点补挂：DSG-D03-7（mat_uploads 分片上传）→REQ-102/103 行、DSG-A03-18（上传 :abort）→REQ-102 行、DSG-D06-9+DSG-A06-21（CI webhook）→REQ-712 行、DSG-A11-5（预览子域 TLS）→REQ-307/803 行、DSG-A07-13/14（批次 block/unblock）→REQ-510/511 行、DSG-A06-22+DSG-D10-8（webhook secret 登记）→REQ-712 行；③ REQ-208 行补挂 LLD-6 DSG-U06-24（L0d 独立 KPI 卡差异登记）；④ REQ-710 行「五服务 Compose」更正为「六服务（含 egress-proxy）」（对齐 HLD §1 现行口径）；⑤ §5 核查说明补全：REQ-001 另见 LLD-4 §1 业务编号示例（约 L54）、REQ-001/002/077/096 另见 LLD-5 A04-11/A04-12 响应示例（约 L357/362），并注明 LLD-5 示例 R-001/CR-001 三位写法属示例级差异；⑥ CR-09 行措辞与 CRD 取齐（保持半缺口事实陈述、互指出处，状态值 ✅ 不改）；⑦ §6.2 自算健康度按 REQ-208 新口径重算：L0a 分母改 active R（R-19 经 deferred 的 CR-19 承接、不计入分母），L0a=24/24=100% 不变结论；⑧ 首部原型 `DSG_DEFS` 行号 L803→L817（原型波次 3/4 漂移重刷） |
| 2026-09-21 | §3.5（REQ-502 行）、§7 | 二轮收尾：REQ-502 行补挂 DSG-A07-13/A07-14（批次阻断/恢复端点，双向闭合，R-03-23）；§7 登记二轮基线（13 文件 SHA-256 清单） |
| 2026-09-21 | §7 | 基线行哈希刷新：LLD-4 l0b 空分母措辞取齐顺手项（语义不变）落盘后，LLD-4 与 RTM 两格哈希按现行文件重登 |
| 2026-10-04 | §3.4（REQ-702 行）、§7 | 差异回补：REQ-702 行补挂 DSG-U06-25（顶栏→左侧三栏差异登记）、行内 DSG-U02-2 条目名同步改「一级列/二级列与五阶段导航」（其余 REQ/BR/DSG 编号零增删，矩阵其余行不受影响）；§7 重登 2026-10-04 基线 |
| 2026-10-10 | §3.7（REQ-707 行） | 差异回补（登记条目 35）：REQ-707 行补注公网部署 env 门控简易登录分期口径（本期部署期门控、扩展期项不变，裁决见统稿裁决记录 R-05，PRD REQ-707 行同步）；其余 REQ/BR/DSG 编号零增删、矩阵其余行不受影响 |
