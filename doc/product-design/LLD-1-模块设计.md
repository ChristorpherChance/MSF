# 软件工厂（MSF）LLD-1 模块设计

> 版本：V1.0-draft · 2026-09-20 · 状态：草稿，待评审
> 上游：`HLD.md` §3 模块划分（DSG-M01~M13）与 §4 ADR-1~9；需求输入 `PRD.md`（REQ/BR）；编号与追溯规则见 `README.md`。
> 本册对 HLD 13 个模块逐一展开到「职责 / 公开接口 / 依赖 / 内部结构（组件粒度）/ 错误处理 / 承接需求 / 原型对应」七项；详细类设计见 `LLD-3`，状态机与命令流程见 `LLD-2`，REST 规格见 `LLD-5`。
> 条目编号 `DSG-Mxx-y`；每条反向引用至少一条 REQ/BR；无上游需求的条目标注 `补充设计`。

## 1. 总章：模块协作矩阵与边界红线

### 1.1 模块协作矩阵（谁调谁，DSG-M00-1）

方向：行 = 调用方，列 = 被调方。「●」= 直接调用公开接口；「（事）」= 仅经命令事务管线产生数据交互；「—」= 禁止直接调用。

| 调用方 ↓ | M01 | M02 | M03 | M04 | M05 | M06 | M07 | M08 | M09 | M10 | M11 | M12 | M13 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| M01 前端 SPA | | ● | — | — | — | — | — | — | — | — | — | — | — |
| M02 API 层 | — | | ● | ● | ● | ● | ● | ● | — | — | ● | ● | ● |
| M03 资料域 | — | — | | — | — | — | — | — | — | — | ● | ● | — |
| M04 需求域 | — | — | ● | | — | — | — | ● | — | — | ● | ● | — |
| M05 设计域 | — | — | ● | ● | | — | — | ● | — | — | ● | ● | — |
| M06 开发域 | — | — | — | — | ● | | — | ● | ● | ● | ● | ● | — |
| M07 测试验收域 | — | — | — | — | ● | ● | | — | ● | — | ● | ● | — |
| M08 AI 编排层 | — | — | ● | ● | ● | ● | ● | | — | ● | ● | — | ● |
| M09 执行器层 | — | — | — | — | — | — | — | — | | ● | ● | — | — |
| M10 集成适配层 | — | — | — | — | — | — | — | — | — | | ● | — | — |
| M11 证据与审计 | — | — | — | — | — | — | — | — | — | — | | — | — |
| M12 放行策略引擎 | — | — | — | — | — | — | — | — | — | — | ● | | — |
| M13 平台管理 | — | — | ● | ● | ● | ● | ● | ● | — | — | ● | ● | |

补充说明（DSG-M00-2）：
- M01 只与 M02 通信（REST + SSE），不感知任何领域模块。
- M02 是领域服务的唯一对外暴露面；领域模块之间**允许**以 NestJS provider 注入方式直接调用上表标记「●」的接口，但跨域传参只允许身份+指纹（见 §1.2）。
- M11 被全部写路径调用（审计失败零写，BR-04）；M11 自身不调用任何业务模块，防止循环依赖。
- M13 的「调用」限于只读聚合（任务中心/通知汇总）与配置下发（模型/提示词/Agent 配置供 M08 读取）。

### 1.2 模块边界红线（DSG-M00-3）

1. **跨域只传身份+指纹，不复制内容**：领域模块之间传递工件一律为 `{artifactType, artifactId, contentFingerprint}` 三元组；禁止把对端工件正文复制进本域表（BR-01/BR-03，ADR-4）。需要内容时按指纹向属主域实时取，取回后复核指纹。
2. **写操作必须走命令事务**：任何领域写 = 封闭命令枚举中的一条，统一管线 `prepare → publish（单 DB 事务：业务写入+事件+审计）→ flush（效果幂等）`（BR-04，ADR-3）；禁止模块内绕过管线直接写库。审计写入失败则整体回滚、界面零写。
3. **AI 调用必须经 M08**：业务模块与前端禁止直接引用模型 SDK 或自行拼装模型请求（REQ-613/614，ADR-6）；一切生成/评审/工具调用走 M08 公开接口，提示词版本与输入指纹由 M08 统一登记。
4. **门禁判定不旁路**：阶段准入与人工确认点必须经 M12 求值（REQ-711，ADR-7）；业务模块不得自写「直接放行」分支。
5. **异步回调零写纪律**：所有异步操作以 operationId+token+action+owner 四元组为身份，回调提交前重验实时指纹；晚到/失效回调严格零写（BR-08/BR-13）。
6. **不可变证据不可改写**：M11 追加表 DB 层禁 UPDATE/DELETE；`currentXxxId` 仅为指针，不构成有效性证据（BR-03）。

### 1.3 横切服务归属说明（DSG-M00-4，补充设计）

HLD §1 横切服务列有「命令事务」，但 §3 模块表未为其分配编号。**裁决（统稿 D-1，2026-09-20）：不单列 M14**——**命令事务运行时**（CommandBus、事务执行器、效果 ledger 幂等补记器）正式归属 **M11 证据与审计服务**的子组件，因为「审计失败零写」要求审计追加与业务写入同一事务，二者物理上不可分离；**各域命令注册表**（命令枚举、prepare/publish 逻辑）归各域模块自身维护，按域分册登记于 `LLD-2`。

## 2. 模块设计

> 接口表约定：方法签名为 NestJS provider 视角（TS 风格）；`Actor` = `{actorId, kind: human|assistant|sub-agent|autopilot|system, runCtx?}`（操作者类型枚举以 `LLD-3` DSG-C01-3 为权威）；「错误」列与各模块 §错误处理 给代表性错误码，风格统一为 **UPPER_SNAKE、无域前缀**（如 `GATE_BLOCKED`、`AUDIT_WRITE_FAILED`、`RETEST_WITHOUT_CHANGE`），**错误码唯一注册表在 `LLD-3` §14（一级 DomainError）；门禁/检查/阻断的缺口子码（issue code）注册表在 `LLD-3` §15**（本册不再维护域前缀表），HTTP 状态映射见 `LLD-5`。

### 2.1 DSG-M01 前端应用（SPA）

**DSG-M01-1 职责**
一句话：承载五阶段工作台与全局 AI 助手的全部交互，只持有会话态，领域真相一律在服务端。
详述：项目网格与五阶段导航（含准入门禁缺口明示）；资料/需求/设计/开发/测试五域工作台 UI；全局助手 dock（F1 开合、流式渲染、工具调用可见）；原型与客户工件预览走 sandboxed iframe + 独立子域；SSE 订阅流式输出与进度推送；断点 1280/1440/1920 与助手开合布局自适应。本地态（Zustand store）刷新后可由服务端重建，不作为任何有效性依据。

**DSG-M01-2 公开接口（对外契约）**
本模块为前端应用，不向后端模块暴露 provider。其对外契约为：
- 消费面：M02 的 REST 资源与 SSE 端点（规格见 `LLD-5`），禁止绕过 M02 直连 MinIO 或数据库；
- 路由契约：五阶段视图路由 + 项目/任务/批次等深链（清单见 `LLD-6`），供 M08 导航工具（REQ-606）按名称跳转；
- SSE 订阅器：`subscribe(channel, lastEventId?)`，断线以 `lastEventId` 续传，重连不产生重复效果。

**DSG-M01-3 依赖**
依赖 M02 全部资源；间接消费 M12 求值结果（门禁缺口展示）与 M11 证据签名 URL（预览/证据查看）。禁止：持有领域写逻辑（一切写操作发命令给 M02）；在 iframe 预览页注入平台会话凭证。

**DSG-M01-4 内部结构（组件粒度）**
- `AppShell`：顶栏/导航/阶段准入徽标；
- 五个 `StageWorkbench-*`（material/req/design/dev/test）工作台组件树；
- `AssistantDock`：会话列表、流式渲染、工具调用时间线（实现注：消息列表/流式渲染以 pi-web-ui 的 Lit 聊天 Web Components 为**参考实现、浅 fork 并裁剪依赖**——pi-web-ui 版本滞后于 pi-* 锁步主线（0.75.3 vs 0.86.0）且依赖重，不可直接依赖，fork 后维护责任归平台；外观按平台设计令牌定制，交互结构与原型一致，REQ-615 扩展）；
- `PreviewFrame`：sandboxed iframe 装载器 + 签名 URL 获取；
- `SseClient`：订阅/重连/去重；
- `SessionStore`（Zustand）：会话态与选择态（如资料树勾选），可重建。

**DSG-M01-5 错误处理**
本模块为前端，不自定义错误码：M02 返回的域错误码（`LLD-3` §14）原样透传展示；门禁阻断（`GATE_BLOCKED`）展示 `details.issues` 缺口清单（子码见 `LLD-3` §15）；SSE 断连且续传失败时提示刷新重建会话态。恢复策略：UI 不做本地补偿写入；任何失败写操作按「审计失败零写」语义保证服务端未变，界面回滚乐观更新。

**DSG-M01-6 承接需求**
按界面区映射到具体 REQ 段（统稿 M10，消除笼统引用）：项目列表→REQ-701/702；资料工作台→REQ-101~115；需求工作台→REQ-201~210；设计工作台→REQ-301~312；开发工作台→REQ-401~420；测试工作台→REQ-501~511；助手 dock→REQ-601~608；委派视图→REQ-610；设置→REQ-705/711；全局框架→REQ-702/703/706；另承接 REQ-806、BR-11（对照视图两侧不得同对象）。

**DSG-M01-7 原型对应**
`viewProjects / viewMaterial / viewReq / viewDesign / viewDev / viewTest`、`chatDockHtml`（助手 dock）、`keydown F1`、客户工件 iframe 预览（build-template.js 生成的模板渲染侧）。

---

### 2.2 DSG-M02 平台 API 层

**DSG-M02-1 职责**
一句话：唯一的 HTTP 出入口——REST 资源映射、鉴权会话、请求校验、幂等与错误码规范，不承载任何业务规则。
详述：将 HTTP 请求翻译为领域模块的 provider 调用；会话鉴权中间件（缺省放行本地默认身份，策略点就位，ADR-9；**env 门控简易登录**（2026-10-10 差异回补，登记条目 35）：`MSF_AUTH_USER`+`MSF_AUTH_PASS` 双 env 同时设置才启用——HMAC-SHA256 签名 cookie（HttpOnly+SameSite=Lax、无状态 7 天、密钥与 M10 CredentialVault 同根不同域），`/api/**` 无有效 cookie 拒 `UNAUTHENTICATED`，豁免 login/whoami/health；登录恒时比较防时序侧信道，限流=同 IP（反代取 XFF 首跳）错 5 次锁 10 分钟+全局 30 次/10 分钟双闸（`RATE_LIMITED`）；未设 env=本地开发零鉴权、行为完全不变。CSRF 口径：SameSite=Lax+未开 CORS+写操作自带幂等键自定义头（预检不过））；请求 DTO 校验与 actor 注入；幂等键（`Idempotency-Key`）登记与重放拒绝；SSE 通道管理；同进程静态托管（env `MSF_WEB_DIST` 设置时托管前端静态产物、无扩展名路径回退 index.html——单端口单进程部署形态，登记条目 35）；统一错误响应格式 `{code, message, details, traceId}`。

**DSG-M02-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `dispatch(controller route)` | HTTP 请求 + 会话 | 领域响应 DTO / SSE 流 | `VALIDATION_FAILED`、`UNAUTHENTICATED`/`FORBIDDEN` |
| `authenticate(token?)` | 会话凭证（缺省=本地默认身份） | `Actor` | `UNAUTHENTICATED` |
| `checkIdempotency(key, actor)` | 幂等键 | `replay|proceed` | `IDEMPOTENCY_CONFLICT`（同键不同载荷） |
| `openSse(channel, filter)` | 订阅通道 | SSE 流（带 eventId） | `CHANNEL_ERROR` |

**DSG-M02-3 依赖**
依赖 M03~M08、M12、M13 的公开接口做路由分发；调用 M11 记录 API 级审计流水。禁止：包含任何业务分支逻辑；直接访问数据库。

**DSG-M02-4 内部结构**
- `AuthMiddleware`（缺省放行本地默认身份；env 双设时启用 HMAC 签名 cookie 简易登录门与登录限流，口径见 DSG-M02-1）、`ValidationPipe`、`IdempotencyInterceptor`；
- `Controllers`（按域分组，纯转发；`FilesController`=对象存储代理只读端点 `GET /api/v1/files`——公网部署形态（env `MSF_FILES_PROXY=1`）签名直链不可达时由本进程流式回源，key 校验+RFC 5987 下载头，2026-10-10 差异回补，登记条目 36）；
- `SseGateway`：统一 SSE 基础设施与事件信封，三个逻辑通道 `/streams/ai`（M08 流式输出）、`/streams/jobs`（M03/M09 作业进度）、`/streams/notifications`（M13 通知）（统稿 D-5）；
- `ErrorFilter`（域错误码 → HTTP 状态映射表）。

**DSG-M02-5 错误处理**
错误码（注册表见 LLD-3 §14）：`VALIDATION_FAILED`（400）、`UNAUTHENTICATED`（401）/`FORBIDDEN`（403）、`IDEMPOTENCY_CONFLICT`（409，同键不同载荷；同键重放返回首个响应，不产生错误）、`RATE_LIMITED`（429）。恢复策略：校验/鉴权失败不产生任何写；幂等重放返回首次结果副本。

**DSG-M02-6 承接需求**
REQ-707（预留鉴权）、REQ-803（会话/XSS/CSRF 防护边界）、REQ-802（幂等防重）、BR-04（管线入口的幂等检查段）。

**DSG-M02-7 原型对应**
无直接对应（原型单机无鉴权无 API 层）；`新增: 自托管真实化（README §4 S8）`。

---

### 2.3 DSG-M03 资料域服务

**DSG-M03-1 职责**
一句话：项目资料的上传、安全校验、双目录树、解析与定稿、批量作业，以及向 AI 生成链路供给「已定稿参考输入」的门禁。
详述：文件/ZIP 上传（ZIP 整包验证通过才一次提交）；原件/解析稿双目录树一一对应（原件树只增不改）；解析状态机 `pending→parsing→parsed/failed` 全量留痕；文件定稿与内容定稿（人工）；批量解析/批量加工（翻译、脱敏、目录索引）作业含前后基线快照比对；批量定稿人工逐条确认；内容稿三态编辑与离开守卫；向 M08 提供参考输入清单与参考基线校验（REQ-114/115）。

**DSG-M03-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `uploadFile(projectId, actor, meta, stream)` | 文件元数据+流 | `{materialId}` | `UPLOAD_REJECTED` |
| `uploadZip(projectId, actor, stream)` | ZIP 流 | `{batchId, items[]}`（整包提交） | `UPLOAD_REJECTED`（违规子码见 LLD-3 §15(j)，另见 2.3-5） |
| `extractZipInPlace(materialId, actor)` | 包 ID | `{folderId}` | `INVALID_STATE` |
| `listTree(projectId, tree: original\|parsed)` | — | 目录树（含状态/指纹） | — |
| `startParse(ids, actor)` / `retryParse(id, actor)` | 文件 ID 集 | `{jobId}` | `INVALID_STATE` |
| `finalizeFile(id, actor)` | 文件 ID | `{versionId, fingerprint}` | `INVALID_STATE`、`GATE_BLOCKED` |
| `finalizeContent(ids, actor)` | 内容行 ID 集 | `{versionId[]}` | `GATE_BLOCKED`（须人工） |
| `deleteParsedRow(id, actor)` | 行 ID | `void` | `GATE_BLOCKED`（删除守卫，issues 含 `DEPENDENCY_EXISTS` 与依赖清单） |
| `startBulkJob(kind, targetIds, actor)` / `stopBulkJob(jobId)` / `retryBulkItem(jobId, itemId)` | 加工类型+目标 | `{jobId}` / 状态 | `STALE_EVIDENCE`（基线快照比对失败） |
| `getReferenceInputs(projectId)` | — | 已定稿 Markdown 清单 `{id, fingerprint}[]` | — |
| `verifyReferenceBaseline(refSet, baselineFingerprint)` | 引用集+基线指纹 | `valid\|stale` | `REFERENCE_STALE` |
| `saveContentDraft(rowId, actor, expectedVersion, content)` | 乐观锁版本 | `{newVersion}` | `VERSION_CONFLICT` |

**DSG-M03-3 依赖**
依赖 M11（指纹计算、原件/解析稿内容寻址存储、操作审计）、M12（定稿类确认点求值）；解析/加工作业经 M09 沙箱执行（解析器为不可信内容处理）。禁止：直接调用模型（解析中的 AI 摘要等必须经 M08）；向 M04/M05 推送内容正文（只提供身份+指纹清单）。

**DSG-M03-4 内部结构**
- `UploadGuard`（格式/配额校验）、`ZipValidator`（STORE/DEFLATE、CRC32、UTF-8、拒绝加密/ZIP64/多卷/路径穿越/重叠区、30MB/100 项/单文件 10MB/展开 25MB 上限，整包原子提交）；
- `MaterialTreeService`（双树维护、勾选态查询）；
- `ParseStateMachine` 与 `ParseJobRunner`（队列化、逐条成败记录）；
- `BulkJobService`（作业生命周期、开始/提交两次基线快照比对）；
- `FinalizeService`（定稿命令，经 M12）；
- `ReferenceGate`（REQ-114/115 门禁实现）。

**DSG-M03-5 错误处理**
错误码（注册表见 LLD-3 §14）：`UPLOAD_REJECTED`（整包拒绝，零半截数据；逐项违规子码 `ZIP_FORMAT_INVALID`/`ZIP_CRC_MISMATCH`/`ZIP_PATH_TRAVERSAL`/`ZIP_LIMIT_EXCEEDED` 等见 LLD-3 §15(j)）；`INVALID_STATE`（解析状态机非法流转，可重试入口）；`STALE_EVIDENCE`（源基线变化→拒绝提交，提示重新发起）；`REFERENCE_STALE`（参考基线失效→调用方重新生成）；`GATE_BLOCKED`（删除守卫，issues 含 `DEPENDENCY_EXISTS` 与依赖说明）。恢复策略：解析失败可重试；作业停止后单条可重试；一切失败不产生部分提交。

**DSG-M03-6 承接需求**
REQ-101~115、BR-01/02（指纹）、BR-04（整包原子提交）、BR-12（快照比对）。

**DSG-M03-7 原型对应**
`viewMaterial`、`mockUpload/doUpload`（真实化为对象存储）、`material-zip.js / MaterialZip.read`、`material-folders.js / v11Extract / S.materialFolders`、`retryParse / batchParse / v11Parse`、`finalFile / finalContent / deleteReason`、`material-bulk.js / basis()`、`material-polish.js / v11Guard`、`chat-reference.js / v11RequirementInputs`（ReferenceGate）。

---

### 2.4 DSG-M04 需求域服务

**DSG-M04-1 职责**
一句话：CRD/PRD/RTM 三工作面的文档版本体系、AI 辅助编辑（待确认补丁）与 RTM 健康度门禁。
详述：文档草稿/提交/定稿三动作分离，已提交版本字节不可变、编号不复用；单一工作草稿 + undo/redo 对称转换；AI 修改一律以「待确认补丁」呈现，人工逐条接受/拒绝；RTM 维护 R←CR←REQ←DSG 追踪链并计算健康度（L0a ≥ 0.95 且 L0b = 1 方可进入设计；L0c = 1 为开发入口门禁条件之一，REQ-310；L0d 为 deferred 计数，信息性不进门禁；四指标权威定义见 LLD-3 DSG-C04-6）；并发提交按服务端版本号乐观锁拒绝。

**DSG-M04-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `createDraft(docType, actor, basedOnVersionId?)` | 文档类型+基版 | `{draftId}` | `DRAFT_ALREADY_EXISTS` |
| `saveDraft(draftId, actor, expectedVersion, ops[])` | 编辑操作序列 | `{newVersion}` | `VERSION_CONFLICT` |
| `undo/redo(draftId, actor)` | — | `{version, ops}` | `UNDO_STACK_EMPTY` |
| `proposePatches(docId, suggestionSet)` | AI 产出（经 M08 登记） | `{patchIds[]}` | — |
| `acceptPatch / rejectPatch(patchId, actor)` | 补丁 ID | `void` | `PATCH_BASE_STALE` |
| `submitVersion(docId, actor)` | 草稿定版 | `{versionId, fingerprint}` | `INVARIANT_VIOLATION` |
| `finalizeVersion(versionId, actor)` | 经 M12 求值 | `void` | `GATE_BLOCKED` |
| `listVersions / getVersion(versionId)` | — | 版本列表/只读正文 | `VERSION_IMMUTABLE`（写历史版本时） |
| `upsertRtmLink(link, actor)` / `removeRtmLink` | 追踪链边 | `void` | `RTM_LINK_DANGLING` |
| `rtmHealth(projectId)` | — | `{l0a, l0b, l0c, l0d, gaps[]}` | — |
| `guardDesignEntry(projectId)` | — | `pass\|{gaps[]}` | `GATE_BLOCKED`（issues 含 `RTM_HEALTH`/`L0A_BELOW`，LLD-3 §15(e)） |

**DSG-M04-3 依赖**
M08（文档生成与补丁建议的 AI 通道）、M11（版本指纹、不可变历史存储）、M12（定稿确认点）、M03（生成参考输入门禁，经 M08 装配）。禁止：直接改 RTM 对端（设计/任务）数据——RTM 边只存对端身份+指纹。

**DSG-M04-4 内部结构**
- 共享「文档版本内核」（统稿 D-2）：M04 与 M05 的草稿/版本/undo/redo 为同一实现，抽取为共享库——各域自持表、复用内核，不改模块边界；
- `DocVersionService`（草稿/版本/不变式校验：draft 与 modified 一致、历史逐版本字节等价、每次操作追加 0 或 1 条，基于共享内核）；
- `UndoRedoStack`（对称转换，共享内核）；
- `PatchQueue`（待确认补丁生命周期）；
- `RtmService`（链边维护、可视化数据供给）；
- `HealthGate`（L0a/L0b/L0c/L0d 计算与缺口清单；**RTM 跨域一致性校验职责归 M04**（统稿 D-3），设计/任务域只存对端身份+指纹、消费 M04 只读接口）。

**DSG-M04-5 错误处理**
错误码（注册表见 LLD-3 §14）：`VERSION_CONFLICT`（乐观锁冲突→提示刷新合并）、`INVARIANT_VIOLATION`（发布前不变式失败→整命令回滚）、`VERSION_IMMUTABLE`（写已提交版本→拒绝并引导新建草稿）、`GATE_BLOCKED`（RTM 健康度不达标→issues 返回缺口清单，LLD-3 §15(e)；开发入口 L0c 缺口用专用子码 `L0C_BELOW`、target 逐条指向未承接 REQ，`RTM_HEALTH` 仅作汇总级）。恢复策略：不变式失败零写；冲突不丢用户输入（服务端返回冲突基版供合并）。

**DSG-M04-6 承接需求**
REQ-201~210、BR-03/04/05、BR-12（单一写者）。

**DSG-M04-7 原型对应**
`viewReq`、`switchVer/commitVer/finalizeDoc`、`docUndo/docRedo`、`acceptPend/rejectPend`、`bindTocSync`、`rtmHtml / rtmHealth`、`streamReply`（生成侧经 M08）。

---

### 2.5 DSG-M05 设计域服务

**DSG-M05-1 职责**
一句话：HLD/LLD 设计文档、设计目录、UI 原型的识别/生成/检查/共同定稿与设计基线，及其失效传播。
详述：设计文档复用版本体系（章节前缀 h/o/g/k/d/a/u/n）；从已定稿 PRD/HLD/LLD 建立独立设计目录（页面/流程/状态/控件/字段/角色/视口，可追溯到文档章节）；目录驱动生成完整可交互原型；正反向追溯 + 渲染 DOM 核查输出问题列表（无法识别条款标「未验证/需人工」，不静默忽略）；检查通过后人工定稿形成设计基线（工件版本组合+内容指纹，不复制内容）；上游或原型变化旧基线自动失效；基线有效是进入开发的前置；自动修复仅限有明确依据的差异，矛盾保留为「需人工」；来源审计规则集版本化。

**DSG-M05-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| 文档版本接口（同 M04 形态，`docType ∈ {hld, lld-*}`） | — | — | 同 M04 族 |
| `buildCatalog(projectId, actor, sourceRefs[])` | 定稿文档身份+指纹 | `{catalogId, fingerprint}` | `STALE_EVIDENCE` |
| `generatePrototype(catalogId, actor)` | 目录 ID | `{prototypeId, plan}` | `STALE_EVIDENCE` |
| `checkPrototype(prototypeId, actor)` | — | `{issues[], unverified[]}` | — |
| `autoFix(issueIds, actor)` | 有依据差异子集 | `{fixed[], manual[]}` | `FIX_WITHOUT_BASIS` |
| `finalizeBaseline(prototypeId, actor)` | 经 M12 求值 | `{baselineId, fingerprint}` | `GATE_BLOCKED`（必需页/流/态缺失或关键冲突阻断） |
| `getBaseline(projectId)` / `validateBaseline(baselineId)` | — | 基线身份 / `valid\|stale{reason}` | — |
| `gateDevelop(projectId)` | — | `pass\|{gaps[]}` | `GATE_BLOCKED`（issues 含 `BASELINE_STALE` 等，LLD-3 §15(a)） |
| `auditSources(catalogId)` | — | `{failures[]}` | — |
| `invalidateByUpstream(sourceFingerprint)` | 上游指纹 | 受影响基线清单（标失效） | — |

**DSG-M05-3 依赖**
M04（定稿 PRD 身份+指纹作为目录来源）、M08（目录识别/原型生成/检查评审的 AI 通道）、M11（基线指纹与不可变登记）、M12（共同定稿确认点）、M03（设计文档生成的参考门禁，经 M08）。禁止：复制上游文档正文入库（只存指纹与锚点）；向 M06 暴露原型 HTML 供直接复用为构建工件（REQ-412 禁止复制原型冒充构建产物）。

**DSG-M05-4 内部结构**
- `DesignDocService`（章节化文档版本，复用与 M04 共享的「文档版本内核」库——草稿/版本/undo/redo 同一实现，各域自持表，统稿 D-2）；
- `CatalogService`（设计目录 + 章节锚点追溯）；
- `PrototypeGenerator`（目录×视口驱动生成，生成动作与规划可见）；
- `PrototypeChecker`（追溯检查 + DOM 核查 + 未验证清单）；
- `BaselineService`（指纹组合、失效判定）；
- `SourceAudit`（规则集版本化的双向审计）。

**DSG-M05-5 错误处理**
错误码（注册表见 LLD-3 §14）：`STALE_EVIDENCE`（上游指纹/目录漂移→拒绝并提示重识别/重生成）、`GATE_BLOCKED`（定稿阻断，issues 返回缺失/冲突清单；进入开发门禁失效传播 issue 含 `BASELINE_STALE`，LLD-3 §15(a)）、`FIX_WITHOUT_BASIS`（无依据修复→转入「需人工」）。恢复策略：失效不重算旧结论，生成新版本；旧基线保留只读。

**DSG-M05-6 承接需求**
REQ-301~312、BR-01/02/03/07、BR-06（人工定稿）、BR-11（检查不静默忽略）。

**DSG-M05-7 原型对应**
`viewDesign / DESIGN_PRE`、`designPlanPrototype / V19_DESIGN_CATALOG / design-catalog.json`、`designGeneratePrototype`、`designCheckPrototype / designAudit`、`designSelectPrototypePage`、`designFinalizePrototypeBaseline / designPrototypeGate`、`V19-SOURCE-4 / source-acceptance-rules.json`、契约§2（自动修复边界）。

---

### 2.6 DSG-M06 开发域服务

**DSG-M06-1 职责**
一句话：从设计基线到「待人工转测试」的开发主链路——任务池、计划批准、看板、命令事务、autopilot、集成构建、开发自测与转测试交接。
详述：任务识别（含 kind/owner/scope/writeScopes/deps/acceptance/quality 规格与写入范围冲突检出）入统一任务池；计划覆盖双向检查与人工批准；看板流转留痕；全部写操作走封闭命令注册表；单任务循环「编码→单测→CI→独立评审→PR 合并」逐环节证据齐全；PR 合并必须带四类之一依据并深冻结；autopilot 自动主线（runId+runToken+authorizationId 归属，暂停/停止/接管只影响当前运行拥有的操作，晚到回调零写）；集成构建生成候选构建与独立 UI 工件；开发自测四门（功能检查/联调与冒烟/UI 符合度/开发审核，gates 键 functional/integration/ui/review，REQ-413），UI 符合度逐页×逐视口评分（BR-09 语义）；失败进「需你处理」，复测须实质返工；自测报告不可变可导出；仅当前有效且合格的报告可人工确认转测试，原子交接（旋转运行令牌、消费授权）；输入失效向下游传播。

**DSG-M06-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `identifyTasks(baselineRef, actor)` | 基线身份+指纹 | `{taskIds[]}` | `GATE_BLOCKED`（issue `BASELINE_STALE`） |
| `checkCoverage(baselineRef)` | — | `{uncoveredDesign[], orphanTasks[]}` | — |
| `submitPlan(planId)` / `approvePlan(planId, actor)` | 经 M12 | `{planVersion, fingerprint}` | `GATE_BLOCKED` |
| `moveTask(taskId, to, actor)` 等看板命令 | 命令入参 | `{eventId}` | `INVALID_STATE`、`VERSION_CONFLICT` |
| `startAutopilot(planVersion, actor)` / `pause / stop / takeover(runId, actor)` | 运行身份 | `{runId, runToken}` | `RUN_OWNERSHIP_MISMATCH` |
| `attachMergeBasis(prRef, basis, actor)` | 四类依据之一 | `{basisRecordId}`（深冻结） | `MERGE_WITHOUT_BASIS` |
| `requestIntegrationBuild(planVersion)` | — | `{buildId, uiArtifactRef}` | `GATE_BLOCKED`（构建前置门禁，issues 见 LLD-3 §15） |
| `startSelfTest(buildId, actor)` | 候选构建身份 | `{selfTestId}` | `GATE_BLOCKED`（构建前启动被拒，issues 见 LLD-3 §15(b)） |
| `evaluateUiEvidence(selfTestId)` | 证据引用集 | `{perPage×viewport 判定, overall}` | `EVIDENCE_REQUIRED` |
| `retest(selfTestId, changeRef, actor)` | 实质返工证据 | `{newRunId}` | `RETEST_WITHOUT_CHANGE` |
| `exportSelfTestReport(selfTestId)` | — | `{reportId, fingerprint, exportRef}` | — |
| `confirmTransferToTest(reportId, actor)` | 经 M12 求值 | `{handoffId, handoffToken}`（原子交接） | `GATE_BLOCKED`（未达标/过期/运行中阻断，issues 见 LLD-3 §15(c)） |
| `invalidateByUpstream(fingerprint)` | 上游身份 | 受影响任务/证据/报告清单 | — |
| `confirmBaseline(baselineId, actor)` | 基线重确认 | `void` | `STALE_EVIDENCE` |

**DSG-M06-3 依赖**
M05（基线身份与有效性校验）、M08（AI 评审/编码辅助/报告汇总草稿）、M09（沙箱单测/构建/命令执行）、M10（Git 分支/PR/合并、CI 流水线）、M11（全环节证据与指纹、合并依据深冻结）、M12（计划批准/转测试确认点）。禁止：直接调用 Git/CI/模型 SDK（必须经 M10/M08/M09）；绕过命令注册表写任务状态；自评自判放行（放行判定归 M12）。

**DSG-M06-4 内部结构**
- `TaskPoolService`（识别、规格、写入范围冲突检出）；
- `PlanService`（覆盖检查、提交/批准版本固定）；
- `DevCommandRegistry`（封闭命令枚举 + prepare/publish，分册登记于 LLD-2）；
- `BoardService`（看板流转）；
- `AutopilotOrchestrator`（BullMQ 步骤工作流、运行归属令牌、晚到回调零写过滤）；
- `MergeBasisService`（四类依据、深冻结存证）；
- `BuildService`（候选构建、独立 UI 工件、内容指纹）；
- `SelfTestService`（四门、逐页评分、失败定位、复测守卫、报告汇总）；
- `TransferGate`（交接原子性：旋转运行令牌+消费授权）。

**DSG-M06-5 错误处理**
错误码（注册表见 LLD-3 §14）：`VERSION_CONFLICT`（乐观锁）、`INVALID_STATE`（状态机非法流转）、`RUN_OWNERSHIP_MISMATCH`（非当前运行拥有的回调→零写并审计）、`MERGE_WITHOUT_BASIS`（无依据合并→拒绝）、`GATE_BLOCKED`（构建/自测/转测试门禁阻断，issues 附缺口子码，LLD-3 §15）、`RETEST_WITHOUT_CHANGE`（空转重跑拒绝）、`STALE_EVIDENCE`（失效传播，冻结相关放行入口）。恢复策略：命令失败整体回滚（BR-04/14）；autopilot 崩溃按效果 ledger 幂等补记；失败入「需你处理」并定位到页面/任务。

**DSG-M06-6 承接需求**
REQ-401~420、BR-04/07/08/09/10/11/13/14。

**DSG-M06-7 原型对应**
`viewDev / DevStore`、`devIdentify / V17_CATALOG / V17_TASKS / task-specs.json`、`devCoverageCheck / devSubmitPlan / devApprovePlan`、`commitDevAction / DEV_ACTION_REGISTRY / devAudit`、`devApproveAndRun / devAutopilotTick / devAutoPause / devAutoTakeover`、`devResolveMergeBasis / attachBasis（runtime-hardening.js）`、`v19BuildCandidateHTML / devInspectBuildUiArtifact`、`devStartSelfTest / devCanStartSelfTest / v19EvaluateUiEvidence / V19_UI_ACCEPTANCE_RULES`、`devOpenUiComparison`、`devRetestSelfTest`、`devExportSelfTestReport / v19MakeSelfTestReport`、`devTransferGate`、`impactTrigger / devConfirmBaseline / devInvalidate / retireSelftest（runtime-hardening.js）`。

---

### 2.7 DSG-M07 测试验收域服务

**DSG-M07-1 职责**
一句话：提测接收为不可变批次，测试计划/用例执行/缺陷闭环/报告/条件放行/交付决定的验收工作台后端。
详述：幂等接收提测交接（校验构建指纹与自测合格结论，重复接收不产生重复批次）；批次快照不可变（构建身份+设计基线+验收条款+环境指纹，新构建=新批次）；计划从设计目录流程起草 + 至少一条人工走查，人工批准后固定；用例执行结果五值枚举（pass/fail/blocked/not-run/not-applicable），不适用≠通过、必测 not-run 保留在分母、零用例不得通过；每条执行附证据，模拟必须显式标注；缺陷状态机（新建→已确认→修复中→待回归→已关闭，回归失败重开；开发侧只能标待回归，关闭必须测试侧人工）；跨阶段返工链路（缺陷→新构建→新批次→回归）；报告自动汇总、可定稿「不通过」、定稿≠放行；条件放行仅豁免明确列举的中低等级问题；交付决定不可变；向预留发布适配供给「验收通过批次+证据包」（REQ-712）。

**DSG-M07-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `receiveHandoff(handoffId, handoffToken, idempotencyKey)` | 交接令牌+幂等键 | `{batchId, receipt}` | `HANDOFF_INVALID`、`DUPLICATE_RECEIPT`（幂等返回原批次） |
| `getBatch(batchId)` | — | 批次快照（不可变） | — |
| `draftPlan(batchId, actor)` / `approvePlan(planId, actor)` | 经 M12 | `{planVersion}` | `GATE_BLOCKED` |
| `recordExecution(caseId, result, evidenceRefs[], actor)` | 五值结果+证据 | `{executionId}` | `VALIDATION_FAILED`（非法枚举）、`EVIDENCE_REQUIRED` |
| `createDefect(...)` / `transitionDefect(defectId, to, actor)` | 状态机迁移 | `void` | `INVALID_STATE`、`DEFECT_CLOSE_DENIED`（非测试侧关闭） |
| `triggerRework(defectId)` | — | 返工链路句柄（交 M06 新构建） | — |
| `generateReport(batchId)` / `finalizeReport(reportId, actor, verdict)` | 经 M12；verdict 含「不通过」 | `{reportId, fingerprint}` | `REPORT_BASIS_MISMATCH` |
| `evaluateRelease(reportId, exemptions[])` | 豁免清单 | `pass\|{violations[]}` | `WAIVER_NOT_ALLOWED`（P0/P1/必测未执行/证据失真） |
| `recordDecision(reportId, decision, actor)` | 放行/不放行 | `{decisionId}`（不可变） | `GATE_BLOCKED` |
| `getReleasePackage(batchId)` | — | `{batchRef, evidencePackageRef}`（REQ-712 数据形态） | — |

**DSG-M07-3 依赖**
M06（交接令牌验证、返工触发）、M05（设计基线身份入批次快照）、M09（自动用例执行器）、M08（报告汇总草稿、用例起草辅助）、M11（证据附着、批次/报告/决定不可变存储）、M12（计划批准/报告定稿/放行确认点）。禁止：修改批次快照；自行判定放行通过语义（BR-09 判定逻辑虽在本域实现，放行动作必须经 M12 求值留痕）。

**DSG-M07-4 内部结构**
- `IntakeService`（幂等接收、交接校验）；
- `BatchSnapshotService`（不可变快照登记）；
- `PlanService`（起草/批准/范围固定）；
- `ExecutionService`（五值枚举、分母纪律、证据附着、模拟标注强制）；
- `DefectService`（状态机、角色约束、回归重开）；
- `ReworkBridge`（跨阶段返工链路）；
- `ReportService`（自动汇总、定稿、历史不可改写）；
- `ReleaseEvaluator`（豁免规则、决定登记、发布数据形态输出）。

**DSG-M07-5 错误处理**
错误码（注册表见 LLD-3 §14）：`HANDOFF_INVALID`（令牌/指纹不符→拒绝）、`DUPLICATE_RECEIPT`（幂等重放→返回原回执）、`EVIDENCE_REQUIRED`（无证据结果拒收）、`DEFECT_CLOSE_DENIED`（角色约束）、`WAIVER_NOT_ALLOWED`（豁免越界）、`BATCH_IMMUTABLE`（写批次快照→拒绝）。恢复策略：接收幂等可安全重试；执行/缺陷写失败回滚不留半截；回归失败产生 `reopened` 事件，缺陷回到 `confirmed`（统稿 A1）。

**DSG-M07-6 承接需求**
REQ-501~511、REQ-712、BR-03/06/07/09/10/11。

**DSG-M07-7 原型对应**
`viewTest（V19 验收工作台）`、`acceptanceReceive`、`acceptance-workbench.js / S.test.acceptance.batches`、`acceptanceDraftPlan / acceptanceApprovePlan`、`acceptanceRun / acceptanceCreateDefect→…→Close / regressionEvidence`、`acceptance-rework-probe`、`acceptanceGenerateReport / FinalizeReport / decisions / reportBasis`、`acceptanceRelease`、契约§8（模拟标注）。

---

### 2.8 DSG-M08 AI 编排层

**DSG-M08-1 职责**
一句话：全平台唯一的 AI 出入口——基于 Pi SDK（@earendil-works/pi-*）的 AI 编排，平台强制层包在 Pi 之外（REQ-615）。
详述：内部按 Pi 分层实现——pi-ai 承载统一多供应商模型接入与 token/成本计量；pi-agent-core 承载 agent 运行时与工具执行（agent loop、turn/message 事件、steering（注入消息机制）/follow-up 队列）；pi-coding-agent 嵌入 SDK 承载会话管理（SessionManager JSONL 会话树、fork/branch、自动压缩）、模型注册与会话内切换（ModelRegistry）、提示词扩展。平台强制层在其外提供：会话管理（多会话、历史保留；**会话粒度下沉到工件**（2026-10-10 差异回补，登记条目 34）：会话按「阶段 ctx+文档类别 doc_kind」分组绑定——req 域=crd|prd、design 域=设计八册 kind、其余阶段 NULL=阶段级会话组；会话 prompt 注入【当前工件】块，工具 kind 默认取绑定值（用户明确要求其他文档才换并说明）——根修「UI 选中册与 AI 会话上下文坐标不一致」）；流式输出（SSE 透传、暂停/继续/停止且无半截残留——停止=Pi abort；暂停/继续=平台缓冲层：暂停时停止消费并缓冲事件流，恢复时重放缓冲后继续）；思考强度档位；按用途路由模型（规划/生成/评审等，用途→模型路由策略为平台自有层，模型注册由 Pi ModelRegistry 承载）；提示词版本化落库（每次生成记录提示词版本+输入指纹，可查看/回滚）；工具注册表（查页面、读状态、执行允许动作），平台工具包装为 Pi AgentTool 注入运行时，调用可见可审计；上下文引用装配（仅经 M03 门禁放行已定稿 Markdown，生成期间基线校验失败则拒绝提交该生成版本）；多 Agent 管理与委派任务编排（委派执行本身由 M09 适配器承担，首选 pi RPC 模式）；从消息结果提取 Usage 汇总为 token/耗时/成本展示；AI 行为边界强制——AI 通道在技术上无法触达「人工」策略分支的定稿/放行接口。

**DSG-M08-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `createSession(projectId, actor)` / `listSessions / getHistory` | — | `{sessionId}` / 历史 | — |
| `chat(sessionId, message, opts{thinkingLevel?, contextRefs?})` | 消息+选项 | 流句柄（SSE channel） | `REFERENCE_NOT_FINAL`（引用未过门禁） |
| `controlStream(streamId, op: pause\|resume\|stop)` | 流 ID | `void` | `INVALID_STATE` |
| `generate(purpose, promptVersionId, inputs[], outputSink)` | 用途+提示词版本+输入身份集 | `{generationId, fingerprint, usage}` | `REFERENCE_STALE`（基线校验失败拒提交） |
| `routeModel(purpose)` | 用途枚举 | `{modelId, priceRef}` | `MODEL_UNAVAILABLE` |
| `registerTool(spec)` / `invokeTool(toolId, args, actor)` | 工具规格/调用 | 工具结果 | `TOOL_DENIED`、`TOOL_ARGS_INVALID` |
| `listPromptVersions / rollbackPrompt(promptId, version, actor)` | — | 版本清单 | `PROMPT_VERSION_INVALID` |
| `delegate(agentId, task, targetRef, actor)` | 委派任务 | `{delegationId}` | `DELEGATION_TARGET_UNAVAILABLE` |
| `getUsage(projectId?, range)` | — | token/耗时/成本汇总 | — |
| `assembleContext(projectId, refIds[])` | 参考 ID 集 | `{refSet, baselineFingerprint}` | `REFERENCE_NOT_FINAL` |

**DSG-M08-3 依赖**
Pi SDK（@earendil-works/pi-ai / pi-agent-core / pi-coding-agent，嵌入 SDK 形态，REQ-615）；M03（参考输入门禁与基线校验）、M09（委派执行适配）、M11（提示词版本/输入指纹/调用审计登记）、M13（读取模型/提示词/Agent 配置）；被 M04/M05/M06/M07 调用。禁止：业务模块直连模型 SDK 或绕过本模块直接引用 Pi 包（本模块反向亦不得感知领域写逻辑——工具执行的写动作必须回调对应域的命令入口，不得直接写库）；将 REQ-613 行为边界与平台策略门禁委托给 Pi 的审批机制（Pi 为无审批 YOLO 哲学，门禁在平台层 M12 强制）。

**DSG-M08-4 内部结构**
按 Pi 分层组织（REQ-615）：
- `PiAiGateway`：封装 pi-ai——统一多供应商模型调用（流式、鉴权、模型元数据），从消息结果提取 Usage（计量附着于消息结果，非独立事件流）；
- `AgentRuntime`：封装 pi-agent-core——agent loop、工具执行、turn/message 事件、steering（注入消息机制，非暂停/恢复）/follow-up 队列；停止映射为 Pi abort；暂停/继续不由 steering 承担，由平台缓冲层实现（见 StreamPipeline）；
- `SessionStore`：封装 pi-coding-agent `SessionManager`（JSONL 会话树、fork/branch、自动压缩）与 `ModelRegistry`（多供应商模型注册、会话内模型切换）、`AuthStorage`（密钥引用经 M10 CredentialVault 注入）；多会话管理与分支复用 JSONL 会话树（fork/branch），平台持久层 ai_sessions 存树形引用、不复制会话内容（`ai_sessions.doc_kind` 承载工件绑定分组——req=crd|prd、design=八册 kind、其余阶段 NULL=阶段级组；登记条目 34，表结构见 LLD-4、创建校验与过滤见 LLD-5 A08-1）；**会话 JSONL 持久化**（2026-09-20 评审补录）：Pi 会话目录由 app 服务以卷挂载持久化并纳入备份策略（HLD §6）；沙箱内会话声明为一次性——随容器销毁，产物经证据链回传（M09），不入备份；**自动压缩模型归属**（2026-09-20 评审补录）：自动压缩所用模型由平台按 ModelRegistry 配置选择（默认随会话模型，可配置专用小模型），其 Usage 同样从消息结果提取并计入项目用量（REQ-612）；子 Agent 的可复用能力包以 **pi skills（技能包）**承载并随会话下发（REQ-609 扩展）；
- `ToolBridge`：把平台工具注册表（AGENT_TOOLS）逐项包装为 Pi AgentTool 注入运行时；参数校验与执行审计在包装层完成，写动作回调对应域命令入口；
- `UsageCollector`：从消息结果提取 Usage 落库，按模型/用途汇总 token/耗时/成本；自定义模型须提供 cost 元数据，缺失时由平台 price_table 兜底（REQ-612，price_table 见 LLD-4 DSG-D08-5）。
平台强制层组件（包在 Pi 之外）：
- `StreamPipeline`（SSE 透传；停止=Pi abort；暂停/继续=平台缓冲层——暂停时停止消费并缓冲事件流，恢复时重放缓冲后继续；无半截残留。**stream.delta 重放缓冲**（2026-09-20 评审补录）：SSE 断线重连按 lastEventId 续传，delta 重放由平台缓冲层承载——Redis 滚动窗口（容量=消息条数+TTL 双限，窗口外回源会话树；参数为建议值，压测后校准）；pause 缓冲与断线重放缓冲共用同一缓冲层与重放指针，恢复/重连均自指针继续）；
- `ModelRouter`（用途→模型，平台自有路由策略，配置来自 M13）；
- `PromptRegistry`（版本化落库、回滚、生成登记——平台自有，提示词随会话下发给 Pi 运行时；skill 包版本随提示词版本化同步管理，REQ-609 扩展；**文档生成 prompt 的规范与模板供给**（2026-10-10 差异回补，登记条目 26~32）：文档结构规范（大章约定/节级锚点码规则，与渲染层派生编号同源）与默认文档模板库（十类文档，国际标准映射 ISO/IEC/IEEE 29148/42010、OpenAPI 3.1、WCAG 2.2、ISO/IEC 25010）为平台共享单一权威模块——conventions 管格式、templates 管内容，req/design 生成链六处 prompt 单点引用；模板经套件三级解析链供给（解析与装配流程见 LLD-2 DSG-F11，套件管理归 M13））；
- `ContextAssembler`（门禁装配 + 基线校验）；
- `DelegationService`（委派编排，执行经 M09，首选 pi RPC 模式）。

**DSG-M08-5 错误处理**
错误码（注册表见 LLD-3 §14）：`MODEL_UNAVAILABLE`（Pi 侧模型调用失败/供应商故障→按路由降级或失败留痕，不伪造输出；Usage 提取同步如实登记）、`REFERENCE_NOT_FINAL`（引用未过门禁）、`REFERENCE_STALE`（拒绝提交生成版本，提示重新生成）、`TOOL_DENIED`（越权工具→拒绝+审计；ToolBridge 包装层在注入前即拦截）、`INVALID_STATE`（流控制状态非法）。恢复策略：停止语义映射为 pi-agent-core abort（steering 为注入消息机制，不承担暂停/恢复；暂停/继续由平台缓冲层实现——暂停即停止消费并缓冲事件流，恢复时重放缓冲后继续），保证服务端无半截状态；失败的生成不产生版本记录（或显式标记失败且不可定稿）；Pi 会话树（SessionManager JSONL）损坏时按平台会话记录重建，不篡改既有历史。

**DSG-M08-6 承接需求**
REQ-601~615、REQ-114/115（与 M03 共同承接）、BR-06/REQ-613（行为边界）、BR-01（输入指纹登记）。

**DSG-M08-7 原型对应**
`chatDockHtml / sessions`、`streamReply / tickStream / decideMock`（真实化，README §4 S2）、`思考强度`、`AGENT_TOOLS / registerTool`、`NAV_MAP / NAV_KEYS / nextStepRules`、`chat-reference.js`、`agents / prompt vers / models m1-m4 / usage`、`viewDelegate / targets`（编排侧，委派目标含 `pi_native` 先导）；`新增: REQ-615 AI 后台基于 Pi SDK（2026-09-20 用户决策）`。

---

### 2.9 DSG-M09 执行器层

**DSG-M09-1 职责**
一句话：一切「真实执行」的沙箱——单测/构建/命令的一次性容器执行与委派适配器，结果与证据经证据通道回传。
详述：单测/构建/用户命令在一次性 Docker 容器执行：只读挂载依赖、写入限工作区、网络默认关闭（唯一出向例外：沙箱内嵌 AgentSession 与委派执行体的模型调用一律经 `egress-proxy`——沙箱出向唯一通道，域名白名单=已配置模型供应商端点，HLD §6/ADR-8）、CPU/内存/时长限额；沙箱编排形态默认 **docker.sock 挂载** + 最小权限补偿（专用 builder 用户、只挂构建所需目录、短命容器即用即毁），rootless DinD 列为安全加固选项（权衡见 HLD ADR-8）；**沙箱镜像清单**（2026-09-20 评审补录）：基础镜像与预装工具链以平台维护的镜像清单为准——版本锁定（tag 锁定到具体版本 + digest 锚定），清单变更走人工裁决并审计留痕，禁止临时拉取未登记镜像；沙箱内所需模型密钥由平台侧保管（M10 CredentialVault），会话级临时注入沙箱环境变量——不写盘、用后销毁（REQ-803）；执行结果（退出码、日志、产物、截图）连同环境指纹回传 M11 登记为证据；**自动用例执行器属本层沙箱规格之一**：浏览器自动化容器（Playwright 类镜像）承载 M07 自动用例执行，证据最小集 = 执行日志 + 关键截图 + 断言结果（统稿 D-4）；委派适配器（首选 **pi RPC 模式**（stdin/stdout JSONL，承载 pi_native 先导目标），另有本机 Claude Code/Codex CLI、远程 Agent 运行时适配器）在沙箱或受控远程运行时中隔离执行任务，过程与结果回传；委派任务在远端/沙箱内同样以 pi-coding-agent 承载执行，回传经 RPC JSONL 事件流（turn/message/工具调用）映射为平台证据登记 M11；**单任务编码执行（REQ-407 编码/修单测环节）以沙箱容器内嵌入式 pi-coding-agent AgentSession 承载**——沙箱工作区即会话工作目录，Pi 内建 read/write/edit/bash 工具即沙箱工作区操作面，平台不自建编码 agent loop；接受 M06/M07/M08 的执行请求，以 operationId 四元组身份回报（晚到回调由调用方零写过滤，本层保证回报携带完整身份与证据引用）。

**DSG-M09-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `runSandbox(spec{image, cmd, mounts, limits, networkPolicy}, operationCtx)` | 执行规格+四元组身份 | `{executionId}`（异步） | `SANDBOX_SPEC_INVALID`、`SANDBOX_QUOTA_EXCEEDED` |
| `getExecution(executionId)` | — | `{status, exitCode?, evidenceRefs[]}` | `NOT_FOUND` |
| `cancel(executionId)` | — | `void` | `INVALID_STATE` |
| `delegate(targetRef, task, operationCtx)` | 委派目标+任务 | `{delegationRunId}` | `DELEGATION_TARGET_UNAVAILABLE` |
| `reportCallback(payload)` | 适配器回报（含身份+证据） | `ack\|reject` | `OPERATION_STALE`（身份不全/晚到拒收，严格零写） |

**DSG-M09-3 依赖**
M10（远程运行时/CLI 适配的通道）、M11（证据登记）。禁止：直接写领域表；访问平台会话凭证；默认开网络。

**DSG-M09-4 内部结构**
- `SandboxRunner`（容器生命周期、限额、回收）；
- `CodingAgentRunner`（封装沙箱容器内嵌入式 Pi 会话：pi-coding-agent `createAgentSession` 承载单任务编码/修单测循环，内建 read/write/edit/bash 工具即沙箱工作区操作面，会话经 SessionManager 管理、自动压缩；模型与密钥经 AuthStorage/ModelRegistry 注入——密钥平台侧保管、会话级临时注入沙箱环境变量、不写盘、用后销毁；模型出向经 egress-proxy；REQ-615 扩展，ADR-8）；
- `EvidenceCollector`（日志/产物/截图收集与环境指纹；编码会话的 turn/message 事件流同样经本组件映射为证据登记）；
- `DelegateAdapters`（pi RPC（stdin/stdout JSONL，首选，pi_native 先导）/ 本机 CLI / 远程 Agent 运行时；pi RPC 目标的执行体在远端/沙箱内同为 pi-coding-agent，RPC JSONL 事件流映射为平台证据回传）；
- `CallbackGateway`（回报身份校验后转发调用方）。

**DSG-M09-5 错误处理**
错误码（注册表见 LLD-3 §14）：`EXECUTION_TIMEOUT`/`RESOURCE_LIMIT_EXCEEDED`（限额触顶→失败证据如实登记，不得改写为通过）、`SANDBOX_INFRA_FAILED`（基础设施失败→可重试，与原执行区分登记）、`OPERATION_STALE`（回报身份不符/晚到→拒收零写）。恢复策略：执行失败 = 失败证据，重试走新 executionId；容器崩溃残留由回收器清理，幂等。

**DSG-M09-6 承接需求**
REQ-407/412/413（执行真实性）、REQ-504/505（自动执行证据）、REQ-610、REQ-803（沙箱隔离）、BR-08/11。

**DSG-M09-7 原型对应**
README §4 S3（模拟单测/CI/构建结果 → 沙箱真实执行）、S10（假 CLI 委派 → 真实适配器）；原型中 `commitDevAction` 各环节 mock 结果的真实化承接层。

---

### 2.10 DSG-M10 集成适配层

**DSG-M10-1 职责**
一句话：平台与外部系统之间的防腐层——Git 平台、CI 流水线、模型 API 的统一适配，以及 OIDC/LDAP 与生产发布的预留接口。
详述：Git 适配（分支/PR/合并/diff，对接 GitLab/GitHub/Gitee）；CI 适配（触发流水线、轮询/Webhook 状态回传）；模型 Provider 适配（供 M08 路由调用，密钥不出本层、不入日志与证据正文）；身份源适配（OIDC/LDAP，本期仅接口）；**ReleaseAdapter**（消费「验收通过批次+证据包」，本期仅接口与数据形态，REQ-712；证据包 schema 以 `LLD-4` D11-4 导出格式（manifest.jsonl + sha256 内容寻址）为准，统稿 M9/D-6）。适配失败以域错误码上抛，不让外部协议细节渗入领域层。

**DSG-M10-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `GitAdapter.createBranch/openPr/merge/getDiff(repoRef, ...)` | 仓库身份+参数 | `{ref, fingerprint?}` | `GIT_MERGE_CONFLICT` 等（注册表 LLD-3 §14(i)） |
| `CiAdapter.trigger(pipelineRef, buildRef)` / `getStatus(runRef)` | 流水线身份 | `{runRef}` / 状态+结论 | `CI_STATUS_UNKNOWN` 等（注册表 LLD-3 §14(i)） |
| `ModelProviderAdapter.complete/stream(modelRef, request)` | 模型路由结果 | 统一响应/流 | `MODEL_UNAVAILABLE`/`MODEL_RATE_LIMITED` 等（注册表 LLD-3 §14(g)） |
| `IdentityAdapter.authenticate(...)` | （预留） | `Actor` | `IDENTITY_AUTH_FAILED` |
| `ReleaseAdapter.publish(releasePackageRef)` | （预留，仅接口） | `not-implemented` | `RELEASE_NOT_IMPLEMENTED` |

**DSG-M10-3 依赖**
M11（外部交互审计与关键结果存证）。被 M06（Git/CI）、M08（模型）、M02（身份源，预留）、M09（远程运行时通道）调用。禁止：被领域层绕过（业务代码不得直接引用外部 SDK）；在返回值中泄露密钥/令牌。

**DSG-M10-4 内部结构**
`GitLab/GitHub/Gitee 适配器`、`CiAdapter 族`、`ModelProvider 族（Anthropic/OpenAI/本地推理）`、`CredentialVault`（加密落库、出向白名单）、`ReleaseAdapter 接口定义`。

**DSG-M10-5 错误处理**
错误码（注册表见 LLD-3 §14）：`GIT_MERGE_CONFLICT`（合并冲突→原样上抛由 M06 走失败纪律）、`CI_STATUS_UNKNOWN`（状态不明→标未知而非猜测，BR-11）、`MODEL_RATE_LIMITED`（限流→退避重试并如实计量）、`NETWORK_ERROR`（出向失败）。恢复策略：幂等的外部操作带外部幂等键；失败不静默重试造成重复 PR/流水线。

**DSG-M10-6 承接需求**
REQ-407/411/412（Git/CI 真实化，S4）、REQ-611（模型 API）、REQ-707（预留）、REQ-712、REQ-803（密钥保管）。

**DSG-M10-7 原型对应**
README §4 S4（假 Git 状态翻转 → 真实 Git 适配）；`targets`（委派目标配置）；新增：ReleaseAdapter/IdentityAdapter 接口（PRD REQ-712/707）。

---

### 2.11 DSG-M11 证据与审计服务

**DSG-M11-1 职责**
一句话：全平台的「事实底座」——规范化指纹、不可变追加证据存储、哈希链、审计流水、命令事务运行时与证据包导出。
详述：统一实现规范化序列化 + SHA-256 指纹（治理输入指纹与内容指纹分离，readiness 字段不进内容指纹）；证据/报告/批次/决定/历史版本写入 append-only 表（DB 角色禁 UPDATE/DELETE）并以前序记录哈希成链；大体积内容入 MinIO 内容寻址（key=内容哈希），表内只存元数据+哈希引用；**命令事务运行时**：CommandBus 执行 `prepare→publish（单事务：业务写入+事件追加+审计追加）→flush（效果任务入队，ledger 逐条 pending→running→done/failed/stale，重启幂等补记）`，审计写入失败整体回滚零写；审计流水记录操作者/时间/命令/输入指纹/结果；证据包导出（备份/发布消费）；对象存储签名 URL 签发（短时有效；**公网代理形态**（2026-10-10 差异回补，登记条目 36）：env `MSF_FILES_PROXY=1` 时签发改发本进程代理相对 URL `/api/v1/files?key=…`（经 M02 FilesController 流式回源），未设 env=直签不变——「MinIO 不直接暴露浏览器」的边界（HLD §6）两种形态下均成立）。证据链与审计链（双链）追加均以 `UNIQUE(prev_hash)` 兜底防并发分叉：并发 publish 读到同一链尾时仅一个事务成功，冲突事务回滚后由命令层按幂等键重读链尾、重算重试（LLD-4 DSG-D09/D11-2、LLD-2 DSG-F03-1）。

**DSG-M11-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `fingerprint(content, kind: content\|governance)` | 规范化输入 | `{hash}` | `NORMALIZE_FAILED` |
| `executeCommand(command, actor, idempotencyKey)` | 注册命令+入参 | `{eventId, result}` | `AUDIT_WRITE_FAILED`（零写）、`COMMAND_UNKNOWN` |
| `appendEvidence(record, blobRef?)`（仅 publish 事务内） | 证据元数据+内容 | `{evidenceId, hash, prevHash}` | `CHAIN_BROKEN` |
| `verifyFingerprint(artifactRef, expectedHash)` | 身份+指纹 | `valid\|stale` | — |
| `verifyChain(scope)` | 证据范围 | `{ok, breakAt?}` | — |
| `issueSignedUrl(blobKey, ttl)` | 内容哈希 key | 短时签名 URL | `BLOB_STORE_FAILED` |
| `exportEvidencePackage(scopeRef)` | 批次/项目身份 | `{packageRef, manifest}` | — |
| `flushEffects(limit)` | 恢复入口（可重入） | 补记统计 | — |

**DSG-M11-3 依赖**
不依赖任何业务模块（防循环）；基础设施依赖 Postgres/MinIO/Redis 队列。被全部模块调用。禁止：提供 UPDATE/DELETE 证据的任何接口；向调用方返回可绕过指纹校验的正文直写通道。

**DSG-M11-4 内部结构**
- `FingerprintService`（规范化：key 排序、去时间戳）；
- `EvidenceStore`（追加表 + MinIO 内容寻址 + 哈希链）；
- `AuditLog`（审计流水）；
- `CommandBus`（命令注册校验、事务执行、幂等键）；
- `EffectLedger`（效果幂等补记、崩溃恢复）；
- `ExportService`（证据包/备份导出）。

**DSG-M11-5 错误处理**
错误码（注册表见 LLD-3 §14）：`AUDIT_WRITE_FAILED`（审计写失败→命令整体回滚，调用方收到明确失败，界面零写）、`COMMAND_UNKNOWN`（未注册命令拒绝）、`CHAIN_BROKEN`（哈希链断裂→告警并冻结相关放行）、`BLOB_STORE_FAILED`（对象存储故障→写路径失败而非降级为正文字段）。恢复策略：效果 ledger 重启幂等补记；恢复函数可重入（BR-14）。

**DSG-M11-6 承接需求**
BR-01/02/03/04/05（不变式校验配合）、BR-14、REQ-706、REQ-708、REQ-805。

**DSG-M11-7 原型对应**
`devHash`（FNV → SHA-256 规范化）、`preparePrototypeCommand/publish/flush` 与 `runtime-hardening.js`（`prototypeCommandContext / auditPrototypeCommand / commandEffect / runPrototypeEffect / effectPendingSummary / appendPrototypeEvent / appendPrototypeNotice / enrichManualAudit / stalePrototypeOperation`）、`devAudit`；README §4 S6（工件内容寻址）。

---

### 2.12 DSG-M12 放行策略引擎

**DSG-M12-1 职责**
一句话：全部 7 个人工确认点（全集以 PRD BR-06 为权威，key 统一小写点式：`req.doc.finalize`、`design.prototype.finalize`、`dev.plan.approve`、`dev.transfer`、`test.plan.approve`、`test.report.finalize`、`test.release`，统稿 A6）的结构化策略定义、求值、模式切换授权与逐次留痕。
详述：策略形态 `{checkpointId, mode: manual|auto, autoPreconditions[]}`，默认全部 manual；manual 模式下引擎核验「执行者为人工、前置证据有效（BR-07/09 满足）」后放行人工确认；auto 模式执行前置条件集检查，通过才自动放行，逐次留痕；模式切换（manual→auto 与 auto→manual 双向）本身是 manual 命令，通知项目全部成员，切换留痕入 `policy_gate_events`（统稿 D-12）；AI 通道在技术上无法调用 manual 分支（与 M08 边界双重强制）；求值结果含缺口清单供 UI 明示。

**DSG-M12-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `getPolicy(checkpointId, projectId)` | 确认点身份 | `{mode, preconditions}` | — |
| `definePolicy / switchMode(checkpointId, mode, actor)` | 人工命令 | `void` | `POLICY_MANUAL_REQUIRED`（非人工通道） |
| `evaluate(checkpointId, subjectRef, actor)` | 待放行对象身份+指纹 | `{decision: pass\|block, gaps[], evaluationId}` | `STALE_EVIDENCE` |
| `authorizeAuto(checkpointId, authorizationId, actor)` | 人工授权 | `{authorizationId}`（供 autopilot 消费） | `AUTHORIZATION_FAILED` |
| `listEvaluations(subjectRef)` | — | 留痕清单 | — |

**DSG-M12-3 依赖**
M11（策略定义/切换/每次求值的留痕与指纹校验）。被 M03/M04/M05/M06/M07 的确认点命令调用。禁止：业务模块自写放行分支；引擎自身修改被放行对象（只读求值）。

**DSG-M12-4 内部结构**
`PolicyStore`（策略定义版本化）、`Evaluator`（前置条件集执行：证据有效性、BR-07 失效检查、BR-09 通过语义判定委托域内只读接口）、`AuthorizationService`（授权签发/消费，三元组归属）、`EvaluationLog`（逐次留痕）。

**DSG-M12-5 错误处理**
错误码（注册表见 LLD-3 §14）：`GATE_BLOCKED`（条件不满足→block+缺口清单，非异常而是正常判定）、`STALE_EVIDENCE`（对象指纹漂移→阻断并提示重新执行上游）、`POLICY_MANUAL_REQUIRED`（非人工通道调用 manual 命令）；未定义策略不报错，按默认 manual 处理。恢复策略：求值无副作用，失败可安全重试。

**DSG-M12-6 承接需求**
REQ-711、BR-06（人工确认点）、BR-07/09（求值约束）、BR-13（授权归属）。

**DSG-M12-7 原型对应**
原型中各人工确认动作（`finalizeDoc / designFinalizePrototypeBaseline / devApprovePlan / devTransferGate / acceptanceRelease`）的策略化抽象；`devResolveMergeBasis` 的授权路径；`新增: 人工放行自动化就绪（PRD REQ-711）`。

---

### 2.13 DSG-M13 平台管理

**DSG-M13-1 职责**
一句话：项目生命周期、通知与事件、任务中心、系统设置（模型/提示词/Agent/密钥引用）与备份导出的管理面。
详述：项目卡片网格、新建/编辑、项目内五阶段推进状态；阶段准入汇总展示（门禁判定本身委托 M12/各域 guard 接口，本模块不复制判定逻辑）；通知中心与事件流（本期形态：顶栏铃铛 + 抽屉式通知中心，消费 M11 事件表投影；webhook 列后续扩展，统稿 D-20）；跨阶段任务中心（只读聚合 M06/M07 任务视图）；设置管理（模型配置与价目表、提示词版本入口、Agent 配置、密钥引用——密钥本体由 M10 CredentialVault 保管，本模块只存引用）；**文档模板套件管理**（2026-10-10 差异回补，登记条目 30~32）：模板版本管理=命名套件（全局可复用，套件名唯一=「一整套=一个命名版本」），项目绑定活动套件+文档类别级换源；默认模板以代码模块为基线（M08 生成链消费，管理纪律见 LLD-2 DSG-F11-2），套件为覆盖层（前身 sys_settings 单覆盖设施上线一天即随套件化退役）；自定义类别 `x-` 前缀命名空间+AI 起草人工定稿（草案不落库）；全部写操作命令化记审计、保存条目过 validateTemplate 专业度闸（与代码默认测试门槛同标）；REST 见 LLD-5 A10-1、表结构见 LLD-4（迁移 0027/0028）、设置页编辑器与项目卡关联行见 LLD-6 §3.9/§3.1；备份与导出编排（PG dump + MinIO 版本化桶，经 M11 导出）；示例数据隔离（示例项目独立标记，不作为任何真实门禁依据）。

**DSG-M13-2 公开接口**

| 方法 | 入参 | 出参 | 错误 |
| --- | --- | --- | --- |
| `createProject / updateProject / listProjects / getProject(id)` | 项目字段 | `{projectId}` / 列表 | `VALIDATION_FAILED` |
| `getStageGates(projectId)` | — | 五阶段准入状态+缺口（聚合各域 guard） | — |
| `listNotices / listEvents(projectId, filter)` | 过滤 | 通知/事件流 | — |
| `listTasksCrossStage(projectId)` | — | 跨阶段任务聚合 | — |
| `getSettings / updateSettings(scope, patch, actor)` | 设置域 | `void` | `VALIDATION_FAILED` |
| `triggerBackup(scope)` / `listBackups` | — | `{backupRef}` | `BACKUP_FAILED` |

**DSG-M13-3 依赖**
M11（事件投影、导出）、M12（读取策略状态供设置面展示）、各域只读聚合接口（M03/M04/M05/M06/M07 的列表/状态查询）。禁止：复制领域数据建本地副本（聚合实时查询）；经本模块写领域对象（写一律回到对应域命令入口）；存放明文密钥。

**DSG-M13-4 内部结构**
`ProjectService`、`StageGateAggregator`（委托各域 guard + M12 状态）、`NoticeProjector`（事件→通知投影）、`TaskCenterQuery`、`SettingsService`（模型/提示词/Agent/系统）、`TemplateSetsService`（文档模板套件 CRUD/项目绑定/类别级换源，写命令后刷新模板缓存使生成链即时生效，登记条目 31/32）、`BackupService`。

**DSG-M13-5 错误处理**
错误码（注册表见 LLD-3 §14）：`VALIDATION_FAILED`（非法配置→拒绝并回滚该项）、`BACKUP_FAILED`（备份失败→告警重试，不影响业务）。恢复策略：投影可重建（事件表为源）；备份失败不产生半个备份件。

**DSG-M13-6 承接需求**
REQ-701/702/703/704/705/708/709（设置面承载工件多语言配置入口）、REQ-710（部署配置面）、BR-15（示例数据隔离）。

**DSG-M13-7 原型对应**
`viewProjects / projModal`、`topbarHtml / devProjectOk`（准入展示）、`notices / events`、`viewTasks`、`viewSettings`；`新增: 备份与示例隔离（S1/S8 配套）`。

## 3. 编号索引（DSG-Mxx-y 速查）

| 模块 | 条目区间 | 主承接 |
| --- | --- | --- |
| 总章 | DSG-M00-1~4 | 协作矩阵、边界红线、横切归属 |
| M01 前端 SPA | DSG-M01-1~7 | 按界面区映射（见 DSG-M01-6）、REQ-806 |
| M02 API 层 | DSG-M02-1~7 | REQ-707/803、BR-04 入口 |
| M03 资料域 | DSG-M03-1~7 | REQ-101~115 |
| M04 需求域 | DSG-M04-1~7 | REQ-201~210 |
| M05 设计域 | DSG-M05-1~7 | REQ-301~312 |
| M06 开发域 | DSG-M06-1~7 | REQ-401~420 |
| M07 测试验收域 | DSG-M07-1~7 | REQ-501~511、REQ-712 |
| M08 AI 编排层 | DSG-M08-1~7 | REQ-601~615 |
| M09 执行器层 | DSG-M09-1~7 | REQ-407/412/610、REQ-803 |
| M10 集成适配层 | DSG-M10-1~7 | REQ-407/611/707/712 |
| M11 证据与审计 | DSG-M11-1~7 | BR-01~05/14、REQ-706/708 |
| M12 放行策略引擎 | DSG-M12-1~7 | REQ-711、BR-06 |
| M13 平台管理 | DSG-M13-1~7 | REQ-701~710、BR-15 |

## 4. 待澄清

本节原 6 项（C-1~C-6）已于 2026-09-20 统稿裁决全部回销，结论落回正文对应条目，详见《统稿裁决记录》：

| 原 # | 缺口 | 裁决 | 落点 |
| --- | --- | --- | --- |
| C-1 | 命令事务模块编号 | D-1：不单列 M14，运行时归 M11 子组件 | DSG-M00-4 |
| C-2 | M04/M05 文档版本内核共享 | D-2：抽取共享「文档版本内核」库，各域持表复用 | DSG-M04-4 / DSG-M05-4 |
| C-3 | RTM 一致性校验归属 | D-3：归 M04 需求域，设计/任务域消费只读接口 | DSG-M04-4 |
| C-4 | 自动用例执行器边界 | D-4：属 M09 沙箱规格（浏览器自动化容器，证据最小集=执行日志+关键截图+断言结果） | DSG-M09-1 |
| C-5 | SSE 通道划分 | D-5：三逻辑通道 `/streams/ai`、`/streams/jobs`、`/streams/notifications`，统一 SSE 基础设施 | DSG-M02-4 |
| C-6 | ReleaseAdapter 数据形态 | D-6/M9：证据包 schema 以 LLD-4 D11-4 导出格式为准 | DSG-M10-1 |

## 5. 修订记录

| 日期 | 条目 | 变更 |
| --- | --- | --- |
| 2026-09-20 | 全部 | 初稿（对 HLD §3 十三模块逐模块展开，依据 PRD V1.0-draft 与原型 V1.11 出处核对） |
| 2026-09-20 | 全部 | 统稿修订（F4）：错误码全量改 UPPER_SNAKE 无域前缀并指向 LLD-3 §14、删除域前缀表（A3）；M01-6 承接需求按界面区映射（M10）；待澄清 C-1~C-6 回销落正文（D-1~D-6、M9）；M12 确认点对齐 7 点小写点式（A6）；M13 补通知中心形态（D-20） |
| 2026-09-20 | DSG-M08（1/3/4/5/6/7）、DSG-M09（1/4）、§3 索引 | 用户决策落地（PRD REQ-615）：M08 改写为「Pi SDK + 平台强制层」分层结构（PiAiGateway=pi-ai、AgentRuntime=pi-agent-core、SessionStore=SessionManager/ModelRegistry/AuthStorage、ToolBridge=平台工具包装为 Pi AgentTool、UsageCollector=pi-ai 计量汇总）；依赖改直接引用 @earendil-works/pi-* 包并注明不委托审批；M09 委派适配器补 pi RPC（stdin/stdout JSONL）为首选形态、原型对应补 pi_native 先导 |
| 2026-09-20 | DSG-M01-4、DSG-M08-4、DSG-M09（1/4） | 用户决策扩展落地（PRD REQ-615 接入面扩展）：M01 AssistantDock 补 pi-web-ui Lit 组件复用注（外观按设计令牌定制）；M08 SessionStore 补会话树 fork/branch 与 pi skills 技能包承载注、PromptRegistry 补 skill 包版本随提示词版本化管理；M09 新增 `CodingAgentRunner`（沙箱内嵌入式 Pi AgentSession 承载 REQ-407 编码/修单测），委派补「远端/沙箱内同为 pi-coding-agent、RPC JSONL 事件流映射为平台证据」 |
| 2026-09-20 | 全部「错误」列与各 §错误处理、§2 接口表约定 | 波次 0 评审整改（裁决 R-01）：全部错误码对齐 LLD-3 §14 一级注册表——同义码归并（`AUTH_FAILED`→`UNAUTHENTICATED`/`FORBIDDEN`、`OPTIMISTIC_LOCK_CONFLICT`→`VERSION_CONFLICT`、`UNKNOWN_COMMAND`→`COMMAND_UNKNOWN`、`GATE_DENIED`→`GATE_BLOCKED`、`MODE_SWITCH_DENIED`→`POLICY_MANUAL_REQUIRED`、`*_STATE_INVALID` 族→`INVALID_STATE`、`CLOSE_DENIED`→`DEFECT_CLOSE_DENIED`、`EXEMPTION_DENIED`→`WAIVER_NOT_ALLOWED`、`EVIDENCE_INSUFFICIENT`→`EVIDENCE_REQUIRED`、`REFERENCE_BASELINE_STALE`/`SOURCE_STALE`/`CATALOG_STALE`/`UPSTREAM_STALE`/`SUBJECT_STALE`/`BULK_BASELINE_CONFLICT`→`STALE_EVIDENCE` 等）；门禁族错误（`TRANSFER_GATE_BLOCKED`/`BUILD_PRECONDITION_FAILED`/`SELFTEST_PRECONDITION_FAILED`/`DELETE_GUARD_BLOCKED`/`RTM_HEALTH_UNMET`）统一为 `GATE_BLOCKED` + §15 缺口子码；ZIP 违规细码下沉为 `UPLOAD_REJECTED` 的 violations 子码（§15(j)）；`GIT_*`/`CI_*`/`MODEL_*` 通配改为注册表引用；M01-5 前端不再自定义码；完整映射见 LLD-3 DSG-C14-3 |
| 2026-09-20 | §2 接口表约定、DSG-M09-1/M09-4、DSG-M11-1 | 波次 1 评审整改：§2 Actor kind 枚举对齐 LLD-3 DSG-C01-3 权威（human/assistant/sub-agent/autopilot/system）；M09 补沙箱出向设计——网络默认关闭的唯一例外为经 egress-proxy 的模型出向（域名白名单=已配置模型供应商端点），模型密钥平台侧保管、会话级临时注入沙箱环境变量、不写盘、用后销毁；M09 补沙箱编排选型（默认 docker.sock 挂载+最小权限补偿，rootless DinD 列为加固选项，权衡见 HLD ADR-8）；M11-1 补证据/审计双链 UNIQUE(prev_hash) 并发分叉兜底与冲突重试职责 |
| 2026-09-20 | DSG-M01-4、DSG-M08（1/4/5）、DSG-M09-1 | 波次 2 评审整改（C 组，Pi SDK 集成表述修正与缺失决策补录）：pause/resume 误述修正——steering 明确为注入消息机制（非暂停/恢复），停止=Pi abort，暂停/继续=平台缓冲层（暂停=停止消费并缓冲事件流，恢复=重放缓冲后继续）；计量表述修正——「pi-ai 计量事件」改为「从消息结果提取 Usage 落库」，自定义模型 cost 元数据缺失时由平台 price_table 兜底（UsageCollector）；pi-web-ui 限定为参考实现/浅 fork+裁剪依赖（版本滞后 0.75.3 vs 0.86.0，维护责任归平台）；SessionStore 补 Pi 会话 JSONL 持久化（app 服务卷挂载纳入备份、沙箱内会话一次性随容器销毁、产物经证据链回传）与自动压缩模型归属（平台配置选择、计入项目用量）；StreamPipeline 补 stream.delta 重放缓冲（Redis 滚动窗口、与 pause 缓冲共用缓冲层与重放指针）；M09-1 补沙箱镜像清单（版本锁定 tag+digest 锚定、变更走人工裁决） |
| 2026-09-21 | DSG-M04（1/2/4/5）、DSG-M06-1 | 二轮评审整改（裁决 R-02-1/7）：M06-1 开发自测四门显示名对齐原型「功能检查/联调与冒烟/UI 符合度/开发审核」（gates 键 functional/integration/ui/review 不变，权威 PRD REQ-413）；M04 健康度口径对齐 LLD-3 DSG-C04-6 四指标——rtmHealth 出参补 l0c/l0d、HealthGate 职责与 M04-1 详述补 L0c=1 为开发入口门禁条件（REQ-310）与 L0d 信息性说明；M04-5 明确开发入口 L0c 缺口用专用子码 `L0C_BELOW`（§15(e)）、`RTM_HEALTH` 仅作汇总级 |
| 2026-10-10 | DSG-M02-1/-4、DSG-M08-1/-4、DSG-M11-1、DSG-M13-1/-4 | 差异回补（登记条目 26~32、34~36）：M02 补 env 门控简易登录（HMAC 签名 cookie/登录限流/豁免面）与同进程静态托管、FilesController 对象存储代理端点；M08 会话粒度下沉到工件（ctx+doc_kind 分组+【当前工件】prompt 注入）、PromptRegistry 补文档结构规范与默认模板库单一权威供给（三级解析链引 LLD-2 DSG-F11）；M11 签名 URL 补公网代理形态；M13 新增 TemplateSetsService（文档模板套件：命名套件/项目绑定/类别级换源/自定义类别 AI 起草人工定稿，写命令化+validateTemplate 专业度闸） |
