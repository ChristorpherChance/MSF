# 软件工厂（MSF）LLD-5 · API 接口设计

> 版本：V1.0-draft · 2026-09-20 · 状态：草稿，待评审
> 上游：`PRD.md`（REQ-1xx~8xx、BR-01~15）、`HLD.md`（DSG-M01~M13，ADR-1~9）；编号与追溯规则见 `README.md`。
> 本册条目编号 `DSG-A<章>-<序>`，每条必须反向引用 REQ/BR；原型事实源为 `../msf-prototype.html`、`../acceptance-workbench.js`、`../runtime-hardening.js`。
> 范围：REST API 全量规格 + SSE 通道规格。API 层（DSG-M02）不承载业务规则，业务规则归属各域服务（DSG-M03~M13），本册只定义「接口契约面」。

---

## 1. API 总规范（DSG-A01）

### 1.1 资源命名与版本（DSG-A01-1）

- 基础前缀：`/api/v1`。版本号只在出现不兼容变更时升级，兼容变更（加字段、加端点）不改版本。
- 资源命名：小写复数名词，层级表达归属：`/api/v1/projects/{projectId}/materials/files/{fileId}`。
- 动作型操作（非 CRUD 的状态迁移/命令）用冒号动词后缀：`POST .../files/{fileId}:parse`、`POST .../docs/{docId}/versions:commit`。**所有冒号动作都是命令型端点**（见 §11.1）。
- 项目隔离：项目域内资源一律挂在 `/projects/{projectId}` 下；服务端校验资源 `ownerProjectId` 与路径一致，不一致返回 403（`FORBIDDEN`，`details.issues` 含缺口子码 `PROJECT_SCOPE`，LLD-3 §15(c)），对应原型 `devTransferGate` 的项目归属检查。
- 承接：REQ-701、REQ-702、BR-04。

### 1.2 鉴权与身份（DSG-A01-2）

- 会话 Cookie（`HttpOnly; Secure; SameSite=Lax`）为浏览器 SPA 主通道；服务端到服务端/CLI 预留 `Authorization: Bearer <token>`。
- 本期为本地默认身份（单工程师）：未配置账号体系时，鉴权中间件放行并注入默认身份 `local-default`，但**所有响应与审计中的 `actor` 字段必须携带该身份**，不留空（REQ-707、ADR-9）。
- 预留 OIDC/LDAP：认证过滤器链按「本地会话 → OIDC Bearer → LDAP Bind」扩展点设计，本期仅实现第一环。
- 虚拟执行者身份：AI/autopilot 发起的服务端内部调用携带 `X-Actor-Type: assistant|sub-agent|autopilot` 与 `X-Run-Id`/`X-Run-Token`，与人工 `human` 严格区分（BR-08、BR-13；操作者类型枚举以 LLD-3 DSG-C01-3 为权威：`human|assistant|sub-agent|autopilot|system`）。外部客户端不得伪造这两个头，网关在入站时剥离。
- CSRF：Cookie 会话的写请求要求 `X-CSRF-Token`（双提交 Cookie）。
- 承接：REQ-707、REQ-803、BR-08、BR-13。

### 1.3 幂等与命令事务（DSG-A01-3）

- **所有写操作**（POST/PATCH/PUT/DELETE 及全部冒号动作）必须携带 `Idempotency-Key: <uuid>` 头。服务端按 `(actor, method, path, key)` 去重：同键重放返回首个响应（含原状态码），不重复执行命令。唯一豁免：分片上传 PUT 以 `(uploadId, partNumber)` 天然键幂等（DSG-A03-2，豁免口径见 DSG-A11-1）。
- 每个写请求映射为封闭命令注册表中的一条命令，执行管线：`鉴权 → 幂等检查 → prepare（纯计算） → publish（单事务：业务写+事件+审计） → flush（效果入队）`（ADR-3、BR-04）。
- 审计写入失败 → 整体回滚，返回 500 `AUDIT_WRITE_FAILED`，客户端不得展示成功（审计失败零写）。
- 并发写：资源带服务端版本号（`version`/`revision` 字段或 `ETag`），写请求携带 `If-Match` 或请求体 `baseVersion`，不匹配返回 409 `VERSION_CONFLICT`（BR-12、REQ-210）。
- 承接：BR-04、BR-12、BR-14、REQ-210、REQ-706。

### 1.4 统一错误响应（DSG-A01-4）

所有错误响应为：

```json
{
  "error": {
    "code": "GATE_BLOCKED",
    "message": "设计基线已过期，不能进入开发准备",
    "details": {
      "issues": [
        { "code": "BASELINE_STALE", "message": "共同设计基线已过期", "target": "DESIGN-BL-3" }
      ]
    },
    "traceId": "trc_01J…"
  }
}
```

HTTP 状态码约定：

| 状态码 | 语义 | 典型 code |
| --- | --- | --- |
| 400 | 请求体/参数校验失败 | `VALIDATION_FAILED` |
| 401 | 未认证 | `UNAUTHENTICATED` |
| 403 | 已认证但无权限/项目越界 | `FORBIDDEN`（项目越界时 details.issues 含 `PROJECT_SCOPE`） |
| 404 | 资源不存在 | `NOT_FOUND` |
| 409 | 并发/版本/幂等冲突 | `VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`RETEST_WITHOUT_CHANGE` |
| 422 | 业务规则不满足（非门禁类） | `INVALID_STATE`、`EVIDENCE_REQUIRED` |
| 423 | 门禁阻断（Locked），details.issues 带缺口明细 | `GATE_BLOCKED`、`STALE_EVIDENCE` |
| 429 | 限流 | `RATE_LIMITED` |
| 500 | 服务端错误 | `INTERNAL`、`AUDIT_WRITE_FAILED` |

业务错误码枚举表（全平台统一；**唯一注册表在 LLD-3 §14（一级 DomainError），本表为跨域通用子集引用**；码值一律 UPPER_SNAKE、无域前缀。门禁/检查/违规的缺口子码（`details.issues[].code`、`details.violations[].code` 等二级 issue code）不属于本表，**唯一注册表在 LLD-3 §15**）：

| code | 含义 | 主要来源 |
| --- | --- | --- |
| `VALIDATION_FAILED` | 参数校验失败 | 通用 |
| `GATE_BLOCKED` | 门禁不通过，details.issues 为缺口数组 | `designPrototypeGate`/`devSelfTestGate`/`devTransferGate` |
| `STALE_EVIDENCE` | 引用证据指纹与现值不一致（BR-07 失效传播） | ADR-4 |
| `VERSION_CONFLICT` | 乐观锁冲突 | BR-12 |
| `IDEMPOTENCY_CONFLICT` | 同 Idempotency-Key 不同载荷 | DSG-A01-3 |
| `RETEST_WITHOUT_CHANGE` | 复测无实质返工 | REQ-416 |
| `AUDIT_WRITE_FAILED` | 审计写入失败，业务零写回滚 | BR-04 |
| `OPERATION_STALE` | 异步操作 token 失效/晚到回调 | BR-08 |
| `REFERENCE_NOT_FINAL` | 引用资料未定稿（content_final） | REQ-114 |
| `REFERENCE_STALE` | 生成期间参考内容变化 | REQ-115 |
| `POLICY_MANUAL_REQUIRED` | 该确认点策略为 manual，AI 通道禁止 | REQ-711、BR-06 |
| `UPLOAD_REJECTED` | 上传/ZIP 安全校验失败 | REQ-103 |
| `ZERO_CASES_FORBIDDEN` | 零用例不得通过 | REQ-504 |
| `WAIVER_NOT_ALLOWED` | 不可豁免项出现在豁免清单 | REQ-509 |

### 1.5 分页与过滤约定（DSG-A01-5）

- 分页：`?page=1&pageSize=50`（默认 20，上限 200）；响应包 `{items:[], total, page, pageSize}`。审计/事件类长流用游标：`?cursor=<opaque>`，响应带 `nextCursor`。
- 过滤：`?status=parsed,failed`（逗号多值）、`?q=<关键词>`、`?updatedAfter=<ISO8601>`；域专属过滤在各章标注。
- 排序：`?sort=-updatedAt`（`-` 为降序）。
- 承接：REQ-801、REQ-802。

### 1.6 SSE 通道规范（DSG-A01-6）

- 通道：`GET /api/v1/streams/projects/{projectId}?channels=<逗号分隔>`，`Accept: text/event-stream`。鉴权同 REST；断线用 `Last-Event-ID` 重连续播（事件流水由 M11 事件表支撑）。**续传基板界定（二轮评审裁决）**：GET 通道的断线续传只覆盖已持久化事件（M11 事件表登记的事件类型，见下表）；`stream.delta` 增量分片不落事件表，仅由平台缓冲层 Redis 滚动窗（LLD-1 DSG-M08-4 `StreamPipeline`，容量=消息条数+TTL 双限）支撑重放——滚动窗之外的 delta 不可经 SSE 续传，客户端改经对应查询端点补拉（AI 消息游标分页见 DSG-A08-2；POST-SSE 断线重发纪律见本条下文）。
- 事件帧：每条含 `id`（单调递增事件 ID）、`event`（事件类型）、`data`（JSON）。
- 事件类型枚举（全平台统一注册表；新增类型必须在 M11 登记）：

| event | 语义 | 主要来源 |
| --- | --- | --- |
| `stream.delta` | AI 流式增量分片 | `streamReply/tickStream` |
| `stream.done` / `stream.error` | 流结束/失败 | 同上 |
| `operation.progress` | 异步操作进度（operationId+percent+message） | BR-08 |
| `operation.completed` / `operation.failed` / `operation.stale` | 异步操作终态 | BR-08 |
| `parse.progress` / `parse.completed` / `parse.failed` | 资料解析进度 | `v11Parse/batchParse` |
| `job.progress` / `job.item` / `job.completed` | 批量加工作业 | `material-bulk.js` |
| `doc.patch.proposed` | AI 提出待确认补丁 | REQ-205 |
| `gate.changed` | 门禁求值结果变化（含 issues） | 各 gate |
| `baseline.invalidated` | 基线/证据失效通知 | BR-07 |
| `autopilot.step` / `autopilot.blocked` / `autopilot.awaiting-transfer` | autopilot 推进 | `devAutopilotTick` |
| `selftest.reported` | 自测报告生成 | `devStartSelfTest` |
| `task.transitioned` | 看板任务流转 | REQ-405 |
| `notice.created` | 通知中心新通知 | REQ-703 |

- 生成类专用短通道：文档/AI 生成也可直接以 SSE 响应（`POST ...:generate`、`POST .../messages` 返回 `text/event-stream`），事件类型同上 `stream.*`；完成后通道关闭。**消费方式约束（波次 2 补充）**：浏览器 `EventSource` 仅支持 GET，不能消费本类 POST-SSE 响应；前端必须用 `fetch` + `ReadableStream`（或等价的 SSE-over-fetch 库）读取响应流并自行解析事件帧。POST-SSE 无自动重连：中断后须以同一 `Idempotency-Key` 重新发起命令（服务端幂等去重、不产生重复执行），已产出增量经对应查询端点（如消息游标分页）补拉；无需请求体的长连订阅一律走上方 GET 通道（`EventSource` + `Last-Event-ID` 续播）。
- 承接：REQ-202、REQ-603、REQ-703、BR-08。

---

## 2. 项目（DSG-A02）· `/api/v1/projects`

承接：REQ-701、REQ-702、REQ-704、REQ-703。

### DSG-A02-1 项目列表
- `GET /api/v1/projects` ｜ 查询型 ｜ 幂等：天然
- 说明：项目卡片网格数据源，含五阶段推进摘要。
- 请求：无体；支持 `?q=`、`?sort=-updatedAt`。
- 响应 200：
```json
{ "items": [ { "id": "pj1", "name": "部委门户", "stage": "dev", "stageSummary": { "material": "done", "req": "done", "design": "done", "dev": "running", "test": "pending" }, "updatedAt": "2026-09-20T08:00:00Z" } ], "total": 1, "page": 1, "pageSize": 20 }
```
- 错误码：`UNAUTHENTICATED`。承接：REQ-701。

### DSG-A02-2 新建项目
- `POST /api/v1/projects` ｜ 命令型 ｜ 幂等：必需 Idempotency-Key
- 请求：`{ "name": "部委门户", "description": "…", "template": "blank" }`
- 响应 201：`{ "id": "pj_01J…", "name": "部委门户", "stage": "material", "createdBy": "local-default" }`
- 错误码：`VALIDATION_FAILED`。承接：REQ-701、BR-04。

### DSG-A02-3 项目详情 / 编辑
- `GET /api/v1/projects/{projectId}` ｜ 查询型；`PATCH /api/v1/projects/{projectId}` ｜ 命令型（Idempotency-Key 必需，携带 `baseVersion`）
- PATCH 请求：`{ "name": "部委门户二期", "baseVersion": 3 }`
- 响应 200：`{ "id": "pj1", "name": "部委门户二期", "version": 4 }`
- 错误码：`NOT_FOUND`、`VERSION_CONFLICT`。承接：REQ-701、BR-12。

### DSG-A02-4 阶段导航准入查询
- `GET /api/v1/projects/{projectId}/stages` ｜ 查询型
- 说明：五阶段（material/req/design/dev/test）准入门禁的实时求值汇总；不满足时明示缺口。等价原型 `topbarHtml`/`devProjectOk` 与各域 gate。
- 响应 200：
```json
{ "stages": [ { "stage": "req", "ok": true, "issues": [] }, { "stage": "design", "ok": false, "issues": [ { "code": "RTM_HEALTH", "message": "L0a=0.91 < 0.95", "target": "rtm" } ] } ] }
```
- 错误码：`NOT_FOUND`。承接：REQ-702、REQ-208、BR-07。

### DSG-A02-5 任务中心汇总
- `GET /api/v1/projects/{projectId}/tasks` ｜ 查询型；支持 `?stage=`、`?status=` 分页
- 响应 200：`{ "items": [ { "id": "tk_1", "stage": "dev", "title": "栏目空状态", "status": "blocked", "owner": "codex_cli", "updatedAt": "…" } ], "total": 12, "page": 1, "pageSize": 20 }`
- 承接：REQ-704。

### DSG-A02-6 项目事件流
- `GET /api/v1/projects/{projectId}/events?cursor=…` ｜ 查询型（游标分页）
- 响应 200：`{ "items": [ { "id": "ev_88", "type": "stage.material", "text": "招标文件.pdf 解析完成", "at": "…", "actor": "local-default" } ], "nextCursor": "ev_88" }`
- 承接：REQ-703、`logEvent`。

---

## 3. 资料（DSG-A03）· `/api/v1/projects/{projectId}/materials`

承接：REQ-101~115、BR-01、BR-03、BR-04、BR-12。原型出处：`mockUpload/doUpload`、`v11Parse/v11Extract/batchParse/retryParse`、`finalFile/finalContent`、`material-zip.js`、`material-bulk.js`、`material-polish.js`、`chat-reference.js`。

### DSG-A03-1 创建上传会话（分片/ZIP 通用入口）
- `POST /api/v1/projects/{projectId}/materials/uploads` ｜ 命令型 ｜ 幂等：必需
- 说明：声明式创建上传；服务端预校验文件名/大小/类型。ZIP 走同一会话，安全校验在 complete 时整包执行。**落库**：会话登记 `mat_uploads`（LLD-4 DSG-D03-7）——upload_id、声明大小/整体 SHA-256、分片大小与总数、目标目录、过期时刻一次写入；会话状态机 `uploading → completed / aborted / expired`。
- 请求：`{ "fileName": "招标文件.pdf", "size": 8388608, "mime": "application/pdf", "sha256": "…", "folderId": "fld_root", "partSize": 4194304 }`
- 响应 201：`{ "uploadId": "upl_01J…", "parts": 2, "expiresAt": "…" }`
- 错误码：`VALIDATION_FAILED`、`UPLOAD_REJECTED`（格式/大小超 REQ-102/103 上限）。承接：REQ-102、REQ-103。

### DSG-A03-2 上传分片
- `PUT /api/v1/projects/{projectId}/materials/uploads/{uploadId}/parts/{partNumber}` ｜ 命令型 ｜ 幂等：按 (uploadId, partNumber) 天然幂等，同分片重传覆盖同内容——天然键幂等，豁免 `Idempotency-Key` 强制（豁免口径见 DSG-A11-1）
- 说明：分片字节暂存 MinIO 临时前缀 `uploads/<uploadId>/`；已收分片清单（partNumber + 大小 + 分片哈希 + 暂存 object_key）经命令事务更新 `mat_uploads.parts`——同会话多分片并发 PUT 的 parts 更新以会话行**行锁串行化**（手段与落库细节见 LLD-4 DSG-D03-7），防并发覆盖丢分片记录。会话不存在/已完成/已中止/已过期返回 `INVALID_STATE`。
- 请求：`Content-Type: application/octet-stream` 原始字节。
- 响应 200：`{ "uploadId": "upl_01J…", "partNumber": 1, "received": 4194304 }`
- 承接：REQ-102、LLD-4 DSG-D03-7。

### DSG-A03-3 完成上传（合并 + ZIP 整包校验）
- `POST /api/v1/projects/{projectId}/materials/uploads/{uploadId}:complete` ｜ 命令型 ｜ 幂等：必需
- 说明：合并分片、校验整体 sha256；**合并依据 `mat_uploads.parts` 分片清单**——先校验分片连续完整（partNumber 覆盖 1..parts_total）与各分片哈希，再合并并校验整体 SHA-256 与创建会话时的声明值一致；成功后 `mat_uploads.status=completed` 并回链产出的 mat_files 行，暂存分片清除。若为 ZIP 则整包执行 REQ-103 校验（仅 STORE/DEFLATE、CRC32、UTF-8 文件名、拒绝加密/ZIP64/多卷/路径穿越/重叠数据区；上限 30MB/100 项/单文件 10MB/总展开 25MB），**整包验证通过才一次提交**，部分失败不产生半截数据。
- 请求：`{}`
- 响应 200：`{ "file": { "id": "f_9", "name": "招标文件.pdf", "status": "pending", "size": 8388608, "uploadedAt": "…", "source": "upload" }, "zipCheck": null }`
- 错误码：`UPLOAD_REJECTED`（details.violations 逐项：code ∈ `ZIP_ENCRYPTED/ZIP_ZIP64/ZIP_MULTI_VOLUME/ZIP_PATH_TRAVERSAL/ZIP_ENTRY_OVERLAP/ZIP_CRC_MISMATCH/ZIP_LIMIT_EXCEEDED/ZIP_FORMAT_INVALID`，违规子码注册表见 LLD-3 §15(j)）。承接：REQ-102、REQ-103、`MaterialZip.read`。

### DSG-A03-4 ZIP 行内解压
- `POST /api/v1/projects/{projectId}/materials/files/{fileId}:extract` ｜ 命令型 ｜ 幂等：必需
- 说明：将已定验 ZIP 行内解压为同名文件夹；原包保留不删。**目标文件夹同名冲突默认拒绝并提示**（与 LLD-2 F09 对齐），调用方可选「重命名解压」。
- 请求：`{ "onConflict": "reject" }`（`reject` 默认；`rename` = 重命名解压，自动追加序号）
- 响应 200：`{ "folderId": "fld_31", "extracted": 14, "skipped": 0, "renamedTo": null, "operationId": "op_…" }`
- 错误码：`INVALID_STATE`（非 ZIP、已解压，或目标同名文件夹冲突且未选择 rename）。承接：REQ-104、`v11Extract`、LLD-2 F09。

### DSG-A03-5 双目录树查询
- `GET /api/v1/projects/{projectId}/materials/tree` ｜ 查询型
- 说明：返回原件树与解析稿树（一一对应，原件树只增不改）；节点含勾选/半选状态所需元数据，选择状态由客户端会话保存。
- 响应 200：`{ "originalTree": [ { "id": "fld_root", "name": "/", "children": [ { "id": "f_9", "type": "file", "name": "招标文件.pdf", "status": "pending" } ] } ], "parsedTree": [ … ] }`
- 承接：REQ-105、REQ-106。

### DSG-A03-6 文件列表
- `GET /api/v1/projects/{projectId}/materials/files?status=pending,failed&folderId=…` ｜ 查询型
- 状态枚举：`pending/parsing/parsed/failed/file_final/content_final`（REQ-107 状态机；定稿态落库值以 LLD-4 为准）。
- 响应 200：`{ "items": [ { "id": "f_9", "name": "招标文件.pdf", "status": "failed", "failType": "needsOcr", "failMsg": "第 3、7 页为扫描页", "progress": 58 } ], "total": 1, "page": 1, "pageSize": 20 }`
- 承接：REQ-101、REQ-107、REQ-110。

### DSG-A03-7 文件详情（解析稿/内容稿/附件）
- `GET /api/v1/projects/{projectId}/materials/files/{fileId}?view=parsed|content|source` ｜ 查询型
- 响应 200：`{ "id": "f_9", "status": "parsed", "parsedMd": "# 招标文件…", "contentMd": null, "attachments": [], "ops": [ { "op": "parse", "at": "…", "result": "ok" } ], "contentFingerprint": "sha256:…" }`
- `source` 视图返回短时签名 URL（MinIO 直链）。承接：REQ-105、REQ-113。

### DSG-A03-8 单个解析
- `POST /api/v1/projects/{projectId}/materials/files/{fileId}:parse` ｜ 命令型 ｜ 幂等：必需
- 响应 202：`{ "operationId": "op_parse_1", "status": "parsing" }`（进度经 SSE `parse.*`）
- 错误码：`INVALID_STATE`（非 pending/failed）。承接：REQ-107、`v11Parse`。

### DSG-A03-9 批量解析
- `POST /api/v1/projects/{projectId}/materials/files:batch-parse` ｜ 命令型 ｜ 幂等：必需
- 说明：默认仅过滤待解析项；逐条记录成功/失败，失败文件停留待解析区并给出原因。
- 请求：`{ "fileIds": ["f_9","f_10"], "onlyPending": true }`
- 响应 202：`{ "operationId": "op_bp_1", "accepted": 2, "rejected": [ { "fileId": "f_11", "reason": "encrypted" } ] }`
- 承接：REQ-110、`batchParse/v11Parse`。

### DSG-A03-10 解析重试
- `POST /api/v1/projects/{projectId}/materials/files/{fileId}:retry-parse` ｜ 命令型 ｜ 幂等：必需
- 说明：仅 `failed` 状态可重试；状态流转全量留痕。
- 响应 202：`{ "operationId": "op_rp_1" }`
- 错误码：`INVALID_STATE`。承接：REQ-107、`retryParse`。

### DSG-A03-11 文件定稿 / 解锁定稿
- `POST .../materials/files/{fileId}:finalize-file` 与 `POST .../materials/files/{fileId}:unfinalize-file` ｜ 命令型 ｜ 幂等：必需
- 说明：人工确认解析结果定稿；定稿后不再参与「待解析」过滤；解锁回到 `parsed` 并留痕。
- 响应 200：`{ "id": "f_9", "status": "file_final" }`
- 错误码：`INVALID_STATE`。承接：REQ-108、`finalFile/doUnfinalFile`、BR-04。

### DSG-A03-12 内容定稿 / 批量内容定稿
- `POST .../materials/files/{fileId}:finalize-content` ｜ 命令型 ｜ 幂等：必需
- `POST .../materials/files:batch-finalize-content` ｜ 命令型 ｜ 幂等：必需；请求 `{ "fileIds": ["f_9","f_10"], "confirm": true }`
- 说明：批量定稿必须人工确认（`confirm:true` 由确认弹窗带回），逐条可查看；响应逐条成功/失败。
- 响应 200：`{ "results": [ { "fileId": "f_9", "ok": true }, { "fileId": "f_10", "ok": false, "reason": "内容稿未保存" } ] }`
- 承接：REQ-109、REQ-112、`finalContent/v11BulkContentFinal`、BR-06。

### DSG-A03-13 内容稿编辑保存
- `PUT /api/v1/projects/{projectId}/materials/files/{fileId}/content-draft` ｜ 命令型 ｜ 幂等：必需
- 说明：预览/编辑/源码三态的保存端点；服务端校验 `baseFingerprint` 防覆盖（未保存离开守卫为前端行为，服务端以乐观锁兜底）。
- 请求：`{ "contentMd": "# 整理稿…", "baseFingerprint": "sha256:…" }`
- 响应 200：`{ "contentFingerprint": "sha256:…" }`
- 错误码：`VERSION_CONFLICT`。承接：REQ-113、`material-polish.js/v11Guard`、BR-12。

### DSG-A03-14 解析行删除（含删除守卫）
- `DELETE /api/v1/projects/{projectId}/materials/content-rows/{rowId}` ｜ 命令型 ｜ 幂等：必需
- 说明：删除解析行不删原件；有下游依赖时拒绝并给出守卫原因。
- 响应 200：`{ "deleted": true }`
- 错误码：`GATE_BLOCKED`（423，details.issues 含 `DEPENDENCY_EXISTS` 与依赖清单 `target`）。承接：REQ-109、`deleteReason`。

### DSG-A03-15 创建批量加工作业
- `POST /api/v1/projects/{projectId}/materials/jobs` ｜ 命令型 ｜ 幂等：必需
- 说明：内置加工：`translate | mask | index`；基线快照口径（REQ-111、LLD-2 DSG-F02-4）：确认弹窗登记整批快照 → **开始（确认提交）时整批复核**，逐行比对不一致则中止启动、不留作业行；执行中源变化的行在提交前二次比对后**逐行跳过**（行级 skipped），不整批拒绝。作业落库时机（`idle`/`confirming` 落库路径与 confirm 快照寄存列）以 LLD-4 DSG-D03-5 为权威。
- 请求：`{ "kind": "mask", "fileIds": ["f_9"], "params": { "patterns": ["name","email","phone"] } }`
- 响应 202：`{ "jobId": "job_1", "operationId": "op_job_1", "basisFingerprint": "sha256:…" }`
- 错误码：`STALE_EVIDENCE`（开始时整批复核与弹窗快照不一致，details 含 before/after 指纹）。承接：REQ-111、`material-bulk.js/basis()`、BR-12。

### DSG-A03-16 作业查询 / 停止 / 单条重试
- `GET .../materials/jobs/{jobId}` ｜ 查询型：响应 `{ "jobId": "job_1", "kind": "mask", "status": "running", "items": [ { "fileId": "f_9", "status": "succeeded" }, { "fileId": "f_10", "status": "failed", "error": "…" } ] }`
- 说明：**作业级状态枚举 `idle/confirming/running/done/stopped`**（以 LLD-2 DSG-F02-4 作业级五态为权威，落库 LLD-4 DSG-D03-5 `mat_batch_jobs.status`；此处指批量作业行本身，非承载它的异步操作行）；**作业行状态枚举 `pending/processing/succeeded/failed/skipped`**（落库值以 LLD-4 DSG-D03-6 为准）。
- `POST .../materials/jobs/{jobId}:stop` ｜ 命令型：响应 `{ "status": "stopped" }`
- `POST .../materials/jobs/{jobId}/items/{fileId}:retry` ｜ 命令型：响应 202 `{ "operationId": "op_…" }`
- 错误码：`INVALID_STATE`。承接：REQ-111。

### DSG-A03-17 需求参考输入清单（引用门禁）
- `GET /api/v1/projects/{projectId}/materials/references` ｜ 查询型
- 说明：仅当前项目已定稿（`content_final`）的 Markdown 可作为需求/设计生成的参考输入；返回可选清单及各自内容指纹（生成请求以此指纹登记，执行期变化则拒绝提交，REQ-115）。
- 响应 200：`{ "items": [ { "fileId": "f_9", "name": "招标文件.md", "status": "content_final", "contentFingerprint": "sha256:…" } ] }`
- 承接：REQ-114、REQ-115、`chat-reference.js/v11RequirementInputs`。

### DSG-A03-18 中止上传会话
- `POST /api/v1/projects/{projectId}/materials/uploads/{uploadId}:abort` ｜ 命令型 ｜ 幂等：必需
- 说明：显式中止分片上传会话：`mat_uploads.status=aborted` 并回收暂存分片；已完成/已过期会话返回 `INVALID_STATE`。过期未完成的会话由清理任务置 `expired` 并同样回收（表规格与清理纪律见 LLD-4 DSG-D03-7）。
- 响应 200：`{ "uploadId": "upl_01J…", "status": "aborted" }`
- 错误码：`INVALID_STATE`、`NOT_FOUND`。承接：REQ-102、BR-04、LLD-4 DSG-D03-7。

---

## 4. 需求（DSG-A04）· `/api/v1/projects/{projectId}/requirements`

承接：REQ-201~210、BR-01、BR-03、BR-05、BR-06、BR-12。原型出处：`viewReq`、`streamReply`、`commitVer/finalizeDoc/doFinalize`、`acceptPend/rejectPend`、`docUndo/docRedo`、`switchVer`、`rtmHtml/rtmHealth`。

### DSG-A04-1 文档列表（CRD/PRD 工作面）
- `GET /api/v1/projects/{projectId}/requirements/docs` ｜ 查询型
- 响应 200：`{ "items": [ { "id": "doc_crd", "kind": "CRD", "cur": 3, "finalVer": 2, "finalized": false, "modified": true, "pendingCount": 1, "version": 12 } ] }`
- 承接：REQ-201。

### DSG-A04-2 文档详情（草稿视图）
- `GET /api/v1/projects/{projectId}/requirements/docs/{docId}` ｜ 查询型
- 响应 200：`{ "id": "doc_crd", "kind": "CRD", "cur": 3, "secs": [ { "id": "s1", "title": "背景", "md": "…", "pending": null } ], "refs": ["f_9"], "version": 12, "contentFingerprint": "sha256:…" }`
- 承接：REQ-201、REQ-203。

### DSG-A04-3 草稿编辑
- `PATCH /api/v1/projects/{projectId}/requirements/docs/{docId}/draft` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "secId": "s1", "md": "新内容", "baseVersion": 12 }`
- 响应 200：`{ "version": 13, "modified": true, "contentFingerprint": "sha256:…" }`
- 错误码：`VERSION_CONFLICT`（单写者/乐观锁）、`INVALID_STATE`（已定稿不可原地改）。承接：REQ-203、REQ-209、REQ-210、BR-05、BR-12。

### DSG-A04-4 文档 AI 生成（SSE）
- `POST /api/v1/projects/{projectId}/requirements/docs/{docId}:generate` ｜ 命令型 ｜ 幂等：必需 ｜ 响应 `text/event-stream`
- 说明：基于已定稿资料参考流式生成；参考输入以指纹登记（REQ-114），执行期间参考变化则生成结果拒绝提交（REQ-115 → 流末 `stream.error` code=`REFERENCE_STALE`）。
- 请求：`{ "referenceFileIds": ["f_9"], "referenceFingerprints": { "f_9": "sha256:…" }, "instruction": "生成 CRD 初稿", "thinkingLevel": "mid" }`
- 响应事件：`stream.delta`（若干）→ `stream.done`（含 `operationId`、`proposedPatchIds`）。生成内容以**待确认补丁**呈现，不直接落稿（REQ-205）。
- 消费方式：本端点为 POST-SSE，浏览器 `EventSource` 不可用；前端必须以 `fetch` + `ReadableStream` 消费事件流（约束与断线重试纪律见 DSG-A01-6）。
- 错误码：`REFERENCE_NOT_FINAL`、`REFERENCE_STALE`。承接：REQ-202、REQ-114、REQ-115、REQ-205、REQ-608。

### DSG-A04-5 生成过程控制
- `POST .../docs/{docId}/generations/{operationId}:pause | :resume | :stop` ｜ 命令型 ｜ 幂等：必需
- 说明：停止后不残留半截状态（服务端中止流并作废未提交补丁）。实现语义（REQ-615 接入面）：`stop` = Pi abort（中止底层生成流）；暂停/继续由平台缓冲层实现（暂停即暂停向下游推送并缓冲增量，续传从缓冲继续），不依赖 Pi steering。
- 响应 200：`{ "operationId": "op_gen_1", "status": "stopped" }`
- 承接：REQ-202、REQ-603、BR-08。

### DSG-A04-6 版本提交
- `POST /api/v1/projects/{projectId}/requirements/docs/{docId}/versions:commit` ｜ 命令型 ｜ 幂等：必需
- 说明：草稿 → 新历史版本；**已提交版本字节不可变、编号不复用**。
- 请求：`{ "note": "用户提交", "baseVersion": 13 }`
- 响应 201：`{ "v": 4, "versionFingerprint": "sha256:…", "at": "…" }`
- 错误码：`INVALID_STATE`（无未提交修改）、`VERSION_CONFLICT`。承接：REQ-203、REQ-209、BR-05、`commitVer`。

### DSG-A04-7 版本定稿
- `POST /api/v1/projects/{projectId}/requirements/docs/{docId}/versions/{v}:finalize` ｜ 命令型 ｜ 幂等：必需
- 说明：人工确认定稿（经放行策略引擎，默认 manual）；前置：无待确认补丁、无未提交修改；CRD 定稿后 PRD 参考自动关联本定稿稿；PRD 定稿触发下游影响登记。
- 请求：`{ "baseVersion": 13, "confirm": true }`
- 响应 200：`{ "finalVer": 4, "finalizationId": "fin_2", "finalFingerprint": "sha256:…", "policy": { "point": "req.doc.finalize", "mode": "manual" } }`
- 错误码：`INVALID_STATE`、`GATE_BLOCKED`（RTM 门禁不满足）、`POLICY_MANUAL_REQUIRED`（AI 通道调用）。承接：REQ-203、REQ-205、REQ-208、BR-06、REQ-711、`finalizeDoc/doFinalize`。

### DSG-A04-8 撤销 / 重做
- `POST .../docs/{docId}:undo` 与 `POST .../docs/{docId}:redo` ｜ 命令型 ｜ 幂等：必需
- 响应 200：`{ "version": 12, "canUndo": true, "canRedo": false }`
- 说明：仅作用于工作草稿，对称转换，不影响已提交历史。承接：REQ-204、BR-05、`docUndo/docRedo`。

### DSG-A04-9 版本列表 / 切换查看
- `GET .../docs/{docId}/versions` ｜ 查询型：`{ "items": [ { "v": 4, "note": "用户提交", "at": "…", "finalized": true, "readonly": true } ] }`（历史只读）
- `POST .../docs/{docId}/versions/{v}:switch` ｜ 命令型：切换工作草稿基底（未提交修改须先提交或放弃）；响应 `{ "cur": 3 }`
- 错误码：`INVALID_STATE`。承接：REQ-203、`switchVer/verHistory`。

### DSG-A04-10 待确认补丁：查询 / 接受 / 拒绝
- `GET .../docs/{docId}/patches` ｜ 查询型：`{ "items": [ { "patchId": "pd_1", "secId": "s1", "type": "modify", "old": "…", "new": "…", "source": "ai" } ] }`
- `POST .../docs/{docId}/patches/{patchId}:accept | :reject` ｜ 命令型 ｜ 幂等：必需
- 响应 200：`{ "patchId": "pd_1", "applied": true, "version": 14 }`
- 说明：逐条人工处理；接受 → 落草稿并标 modified；拒绝 → 恢复原内容。承接：REQ-205、`acceptPend/rejectPend`。

### DSG-A04-11 RTM 查询
- `GET /api/v1/projects/{projectId}/requirements/rtm` ｜ 查询型
- 响应 200：`{ "rows": [ { "r": "R-001 …", "cr": "CR-001", "req": ["REQ-001","REQ-002"], "dsg": ["u"], "state": "covered" } ], "deferred": ["R-008","R-009"] }`
- 承接：REQ-207、`rtmHtml`。

### DSG-A04-12 RTM 健康度门禁
- `GET /api/v1/projects/{projectId}/requirements/rtm/health` ｜ 查询型
- 响应 200：`{ "ok": false, "l0a": 0.91, "l0b": 1.0, "l0c": 0.97, "l0d": 2, "thresholds": { "l0a": 0.95, "l0b": 1.0, "l0c": 1.0 }, "gaps": [ { "code": "L0A_BELOW", "target": "R-003", "message": "R→CR 未覆盖" }, { "code": "L0C_BELOW", "target": "REQ-077", "message": "REQ→DSG 无承接锚点" } ], "deferredItems": [ { "nodeId": "REQ-096", "reason": "本期不做" } ] }`
- 说明：四指标权威定义见 PRD REQ-208——L0a=R→CR 承接率（分母=active R，deferred 不计入；active R 为 0 时记 1 并告警）、L0b=CR→REQ 承接率（分母=active CR，deferred 不计入）、L0c=REQ→DSG 锚点覆盖率（分母=active REQ，deferred 不计入；有至少一个 DSG 条目承接即计覆盖；active REQ 为 0 时记 1 并告警）、L0d=deferred 计数（信息性指标，不进入任何门禁公式）。门禁：L0a ≥ 0.95 且 L0b = 1 才允许进入设计阶段；L0c = 1 为开发入口门禁条件之一（REQ-310）。不达标显示具体缺口；deferred 项以 l0d/deferredItems 单独展示，不允许借 deferred 藏缺口。`gaps[].code` 取值引用 LLD-3 §15(e)：`L0A_BELOW`（L0a 缺口）、`L0C_BELOW`（L0c 缺口，target 逐条指向未承接 REQ）、`RTM_HEALTH`（汇总级）。承接：REQ-208、REQ-310、REQ-702、`rtmHealth/rtmL0c`。

### DSG-A04-13 文档导出
- `POST .../docs/{docId}/versions/{v}:export` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "format": "md|html" }`（本期交付 md+html，pdf 列后续扩展）；响应 202 `{ "operationId": "op_exp_1" }`，完成事件带签名下载 URL。
- 承接：REQ-203、`dlPopover`（原型模拟导出 → 真实导出）。

---

## 5. 设计（DSG-A05）· `/api/v1/projects/{projectId}/design`

承接：REQ-301~312、BR-01、BR-03、BR-06、BR-07。原型出处：`viewDesign`、`DESIGN_PRE`、`designPlanPrototype/designGeneratePrototype/designCheckPrototype/designFinalizePrototypeBaseline`、`designPrototypeGate`、`V19_DESIGN_CATALOG`、`designAudit`、`source-acceptance-rules.json`。

### DSG-A05-1 设计文档八册：列表
- `GET /api/v1/projects/{projectId}/design/docs` ｜ 查询型
- 响应 200：`{ "items": [ { "id": "hld", "book": "h", "title": "概要设计说明书", "finalized": true }, { "id": "lld-module", "book": "o", "title": "模块/组件详细设计", "finalized": false } ] }`
- 说明：共 8 册——概要 1 册（`h`）+ 详细 7 册（`o/g/k/d/a/u/n`），章节前缀以此为准（RTM 设计节点类型同此枚举）。各册的草稿编辑、版本、生成、补丁、undo/redo **复用需求域端点形态**（DSG-A04-3~10），路径为 `/design/docs/{docId}/...`，此处不重复定义。承接：REQ-301、REQ-302。

### DSG-A05-2 设计文档 AI 生成（SSE）
- `POST /api/v1/projects/{projectId}/design/docs/{docId}:generate` ｜ 命令型 ｜ SSE，同 DSG-A04-4（POST-SSE 消费方式约束同 DSG-A01-6：EventSource 不可用，须 fetch + ReadableStream）
- 请求：`{ "referenceFileIds": ["f_9"], "basedOnDocVersions": { "prd": 4 }, "instruction": "生成模块册", "thinkingLevel": "high" }`
- 承接：REQ-302。

### DSG-A05-3 设计评审项
- `GET /api/v1/projects/{projectId}/design/reviews` ｜ 查询型：`{ "items": [ { "id": "DR-01", "item": "接口册覆盖全部外部交互", "conclusion": "pass", "at": "…" } ] }`
- `POST /api/v1/projects/{projectId}/design/reviews/{drId}:conclude` ｜ 命令型：请求 `{ "conclusion": "pass|fail|na", "note": "…" }`，响应 `{ "id": "DR-01", "conclusion": "pass" }`
- 承接：REQ-303、`designReviewHtml`。

### DSG-A05-4 设计目录（catalog）查询
- `GET /api/v1/projects/{projectId}/design/catalog` ｜ 查询型
- 说明：从已定稿 PRD/HLD/LLD 识别的独立设计目录：页面、流程、状态、控件、字段、角色、视口；每项可追溯到具体文档章节锚点。条目带 `source` 标记：`identified`（识别）/`manual`（人工补充，见 DSG-A05-13）。
- 响应 200：`{ "catalogVersion": "V19-3", "catalogFingerprint": "sha256:…", "pages": [ { "id": "pg-home", "title": "首页", "anchors": [ { "doc": "ui", "section": "§1" } ] } ], "flows": [ … ], "states": [ … ], "controls": [ … ], "fields": [ … ], "roles": [ … ], "viewports": [ "1280", "1440", "1920" ] }`
- 承接：REQ-304、`V19_DESIGN_CATALOG/designPlanPrototype`。

### DSG-A05-5 原型规划（plan）
- `POST /api/v1/projects/{projectId}/design/prototype:plan` ｜ 命令型 ｜ 幂等：必需
- 说明：生成/更新原型规划（页面→流程→任务映射），登记治理输入指纹；规划依据变化后旧规划判 stale。
- 请求：`{ "basePlanId": "plan_2" }`（可空=首次）
- 响应 201：`{ "planId": "plan_3", "complete": true, "basedOn": { "governingFingerprint": "sha256:…" }, "fingerprint": "sha256:…" }`
- 承接：REQ-304、`designPlanPrototype`。

### DSG-A05-6 原型生成
- `POST /api/v1/projects/{projectId}/design/prototype:generate` ｜ 命令型 ｜ 幂等：必需
- 说明：目录驱动生成完整可交互 UI 原型（页面×状态×视口）；生成动作与规划可见；前置门禁按 `generate` 求值（PLAN_REQUIRED/PLAN_STALE/PROTOTYPE_DIRTY/PROTOTYPE_FINALIZED）。
- 请求：`{ "planId": "plan_3", "planFingerprint": "sha256:…" }`
- 响应 202：`{ "operationId": "op_pg_1", "prototypeVersionId": "pv_5" }`
- 错误码：`GATE_BLOCKED`（423，issues 见 DSG-A05-10）。承接：REQ-305、`designGeneratePrototype`。

### DSG-A05-7 原型检查
- `POST /api/v1/projects/{projectId}/design/prototype:check` ｜ 命令型 ｜ 幂等:必需
- 说明：正反向追溯检查 + 对实际渲染 DOM 核查；输出问题列表；无法识别条款标「未验证/需人工」，不静默忽略。
- 请求：`{ "prototypeVersionId": "pv_5" }`
- 响应 202：`{ "operationId": "op_pc_1", "reportId": "chk_2" }`（报告经 SSE/查询返回，含 `status: pass|fail`、`issues[]`、`unverified[]`）
- 错误码：`GATE_BLOCKED`（423，issues 含 `PROTOTYPE_REQUIRED`/`CHECK_REQUIRED` 等检查前置缺口，见 DSG-A05-10）。承接：REQ-306、`designCheckPrototype/designAudit`。

### DSG-A05-8 原型预览工件地址
- `GET /api/v1/projects/{projectId}/design/prototype/pages/{pageId}/preview?state=…&viewport=1440` ｜ 查询型
- 响应 200：`{ "previewUrl": "https://artifacts.local/…?sig=…", "htmlFingerprint": "sha256:…", "sandbox": { "iframe": true, "csp": "default-src 'none'" } }`
- 说明：预览与检查共用同一份业务 DOM；iframe 隔离 + 独立子域 + CSP。承接：REQ-307、HLD §6。

### DSG-A05-9 共同定稿（设计基线）
- `POST /api/v1/projects/{projectId}/design/prototype:finalize` ｜ 命令型 ｜ 幂等：必需
- 说明：检查通过后由**人工**定稿形成设计基线（策略门禁 `design.prototype.finalize`）；必需页面/流程/状态缺失或关键冲突时阻断。基线记录各工件版本组合与内容指纹（不复制内容）。
- 请求：`{ "prototypeVersionId": "pv_5", "checkReportId": "chk_2", "confirm": true }`
- 响应 201：`{ "baselineId": "DESIGN-BL-3", "fingerprint": "sha256:…", "basedOn": { "governingFingerprint": "…", "prototypeContentFingerprint": "…" }, "finalizedBy": "local-default" }`
- 错误码：`GATE_BLOCKED`（CHECK_REQUIRED/CHECK_STALE/PROTOTYPE_DIRTY）、`POLICY_MANUAL_REQUIRED`。承接：REQ-308、REQ-309、BR-03、BR-06、REQ-711、`designFinalizePrototypeBaseline`。

### DSG-A05-10 原型门禁求值（designPrototypeGate 等价端点）
- `GET /api/v1/projects/{projectId}/design/gates/{action}` ｜ 查询型；`action ∈ generate|check|finalize|develop`
- 说明：等价原型 `designPrototypeGate(action)`；实时求值，永不缓存为放行依据。
- 响应 200：
```json
{ "ok": false, "issues": [ { "code": "BASELINE_STALE", "message": "共同设计基线已过期", "target": "DESIGN-BL-3" } ] }
```
- issue code 枚举（注册表 LLD-3 §15(a)，此处为引用）：`PROJECT_MISMATCH / PLAN_REQUIRED / PLAN_STALE / PROTOTYPE_REQUIRED / PROTOTYPE_DIRTY / PROTOTYPE_FINALIZED / CHECK_REQUIRED / CHECK_STALE / BASELINE_REQUIRED / BASELINE_STALE`；`action=develop` 时另含 §15(e) 的 `L0C_BELOW`（L0c=REQ→DSG 锚点覆盖率 < 1 缺口，target 逐条指向未承接 REQ；`RTM_HEALTH` 回归汇总级）。
- 承接：REQ-309、REQ-310、BR-07、`designPrototypeGate`。

### DSG-A05-11 基线查询
- `GET /api/v1/projects/{projectId}/design/baselines` ｜ 查询型：`{ "items": [ { "baselineId": "DESIGN-BL-3", "fingerprint": "…", "current": true, "valid": false, "staleReason": "上游 PRD 已定稿新版本" } ] }`
- `GET /api/v1/projects/{projectId}/design/baselines/{baselineId}` ｜ 查询型：完整基线（版本组合、指纹、追溯矩阵、UI 验收矩阵）
- 承接：REQ-309、REQ-310。

### DSG-A05-12 来源审计
- `GET /api/v1/projects/{projectId}/design/source-audit` ｜ 查询型：目录与已批准来源文档双向审计结果；规则集版本化。
- 响应 200：`{ "rulesVersion": "src-rules-2", "ok": false, "issues": [ { "code": "SOURCE_SEMANTIC_UNVERIFIED", "target": "pg-home", "message": "锚点 §1 内容不符" } ] }`（issues[].code 注册表见 LLD-3 §15(h)）
- 承接：REQ-312、`V19-SOURCE-4/source-acceptance-rules.json`。

### DSG-A05-13 设计目录人工增删
- `POST /api/v1/projects/{projectId}/design/catalog/items` ｜ 命令型 ｜ 幂等：必需
- 说明：允许人工向设计目录补充条目（REQ-304 目录识别之外的人工增删已裁决允许）。人工条目一律带「人工补充」标记（`source: "manual"`），与识别条目（`source: "identified"`）区分；全部写操作审计留痕（操作者/时间/前后值/目录指纹）。
- 请求：`{ "kind": "page|flow|state|control|field|role", "title": "设置-审计", "anchors": [], "note": "人工补充原因" }`
- 响应 201：`{ "itemId": "pg-custom-1", "source": "manual", "catalogVersion": "V19-4", "catalogFingerprint": "sha256:…" }`
- `DELETE /api/v1/projects/{projectId}/design/catalog/items/{itemId}` ｜ 命令型 ｜ 幂等：必需
- 说明：仅允许删除人工补充项（`source=manual`）；识别条目须走来源文档修订→重新识别路径，不可直删。删除同样审计留痕。
- 错误码：`VALIDATION_FAILED`、`NOT_FOUND`、`INVALID_STATE`（删除识别条目）。承接：REQ-304、BR-04、REQ-706。

---

## 6. 开发（DSG-A06）· `/api/v1/projects/{projectId}/dev`

承接：REQ-401~420、BR-01、BR-04、BR-07、BR-08、BR-10、BR-11、BR-13。原型出处：`devIdentify/devSubmitPlan/devApprovePlan/devApproveAndRun/devAutoPause/devAutoStop/devAutoTakeover/devAutopilotTick`、`commitDevAction/DEV_ACTION_REGISTRY`、`devTransferGate`、`devStartSelfTest/devRetestSelfTest/devExportSelfTestReport`、`devSelfTestGate`、`devOpenUiComparison`。

### DSG-A06-1 任务识别
- `POST /api/v1/projects/{projectId}/dev/tasks:identify` ｜ 命令型 ｜ 幂等：必需
- 说明：从设计基线与任务规格库识别开发任务进入统一任务池；前置：设计基线有效（`gates/develop` ok）。
- 请求：`{ "baselineId": "DESIGN-BL-3", "baselineFingerprint": "sha256:…" }`
- 响应 201：`{ "identified": 8, "taskIds": ["T-01","T-02"], "poolRevision": 5 }`
- 错误码：`GATE_BLOCKED`（BASELINE_STALE）。承接：REQ-401、REQ-310、`devIdentify/V17_CATALOG`。

### DSG-A06-2 任务池查询
- `GET /api/v1/projects/{projectId}/dev/tasks?col=queue,ing&kind=…` ｜ 查询型
- 响应 200：`{ "items": [ { "id": "T-01", "title": "栏目空状态", "kind": "frontend", "col": "queue", "blocked": false, "blockedReason": null, "ownerType": "agent", "rev": 1, "sourceIds": ["SRC-003"], "writeScopes": ["src/pages/column"], "quality": { "line": 80, "branch": 70 } } ], "total": 8, "page": 1, "pageSize": 20 }`
- 说明：看板列权威定义 `queue/ing/review/done` 四列；**阻塞是标记不是列**（`blocked` + `blockedReason`）。任务归属执行者枚举 `human/agent`（`ownerType`；`owner` 为具体执行体标识）。
- 承接：REQ-401、REQ-402、REQ-405。

### DSG-A06-3 任务详情
- `GET /api/v1/projects/{projectId}/dev/tasks/{taskId}` ｜ 查询型：含 spec（kind/owner/scope/writeScopes/deps/acceptance/quality）、证据、PR、反查设计项。
- 承接：REQ-402、`V17_TASKS/task-specs.json`。

### DSG-A06-4 写入范围冲突检查
- `GET /api/v1/projects/{projectId}/dev/tasks/conflicts` ｜ 查询型
- 响应 200：`{ "conflicts": [ { "writeScope": "src/pages/column", "taskIds": ["T-01","T-05"] } ] }`
- 承接：REQ-402。

### DSG-A06-5 计划覆盖检查
- `GET /api/v1/projects/{projectId}/dev/plan/coverage` ｜ 查询型：设计项 ↔ 任务双向覆盖，缺口可见。
- 响应 200：`{ "ok": false, "uncoveredDesignItems": ["pg-login"], "unmatchedTasks": [] }`
- 承接：REQ-403、`devCoverageCheck`。

### DSG-A06-6 计划提交
- `POST /api/v1/projects/{projectId}/dev/plan:submit` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "taskIds": ["T-01","T-02"], "note": "首批" }`
- 响应 201：`{ "revision": "plan-r3", "snapshotId": "ps_3", "fingerprint": "sha256:…", "status": "submitted" }`
- 承接：REQ-404、`devSubmitPlan`。

### DSG-A06-7 计划批准
- `POST /api/v1/projects/{projectId}/dev/plan:approve` ｜ 命令型 ｜ 幂等：必需
- 说明：人工批准（策略门禁 `dev.plan.approve`）后才进入执行；批准后计划版本固定。
- 请求：`{ "revision": "plan-r3", "fingerprint": "sha256:…", "confirm": true }`
- 响应 200：`{ "revision": "plan-r3", "status": "approved", "approvedBy": "local-default", "approvedAt": "…" }`
- 错误码：`STALE_EVIDENCE`（展示的修订/指纹非最新，对应 `devApproveAndRun` 的 displayedRevisionId/displayedFingerprint 复核）、`POLICY_MANUAL_REQUIRED`。承接：REQ-404、BR-06、REQ-711。

### DSG-A06-8 看板状态流转
- `POST /api/v1/projects/{projectId}/dev/tasks/{taskId}:transition` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "to": "ing", "baseRev": 1, "note": "认领" }`
- 响应 200：`{ "id": "T-01", "col": "ing", "rev": 2 }`
- 说明：看板列 `queue/ing/review/done` 四列；阻塞经 `blocked`/`blockedReason` 标记表达，不是列；操作留痕；完成列进入要求各环节证据齐全（单测/CI/评审/合并），由服务端校验——其中 CI 环节证据来自 `dev_ci_reports`（DSG-A06-21 回传落库，按 commit 取最新匹配行，结论须为 pass）。承接：REQ-405、REQ-407、BR-10。

### DSG-A06-9 代码仓视图
- `GET /api/v1/projects/{projectId}/dev/repo/tree?path=…` ｜ 查询型
- `GET /api/v1/projects/{projectId}/dev/repo/changes?taskId=…` ｜ 查询型
- 响应 200：`{ "tree": [ … ], "lint": { "ok": true, "issues": [] } }`
- 承接：REQ-406。

### DSG-A06-10 autopilot 启动（批准并运行）
- `POST /api/v1/projects/{projectId}/dev/autopilot:start` ｜ 命令型 ｜ 幂等：必需
- 说明：对已批准计划启动自动主线：任务循环→集成构建→开发自测→报告，停在「待人工转测试」。创建运行身份 `runId+runToken+authorizationId`（BR-13）。
- 请求：`{ "displayedRevisionId": "plan-r3", "displayedFingerprint": "sha256:…" }`
- 响应 202：`{ "runId": "run_1", "runToken": "…", "authorizationId": "auth_1", "status": "running", "operationId": "op_ap_1" }`
- 错误码：`STALE_EVIDENCE`、`INVALID_STATE`（计划未批准）。承接：REQ-409、BR-13、`devApproveAndRun`。

### DSG-A06-11 autopilot 暂停 / 停止 / 接管
- `POST .../dev/autopilot:pause | :stop | :takeover` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "reason": "人工暂停自动执行" }`
- 响应 200：`{ "runId": "run_1", "status": "paused|stopped|taken-over" }`
- 说明：仅影响当前自动运行拥有的操作；人工操作保留独立身份；运行撤销后**晚到回调严格零写**（服务端以 runToken 校验，回调不匹配返回 `OPERATION_STALE` 且不产生任何写）。承接：REQ-410、BR-08、BR-13、`devAutoPause/devAutoStop/devAutoTakeover/v18CancelAutomatic`。

### DSG-A06-12 autopilot 状态
- `GET /api/v1/projects/{projectId}/dev/autopilot` ｜ 查询型
- 响应 200：`{ "run": { "runId": "run_1", "status": "awaiting-transfer", "phase": "awaiting-transfer", "currentAction": "", "blocker": null }, "authorization": { "authorizationId": "auth_1", "status": "active", "planSnapshotId": "ps_3" } }`
- 承接：REQ-409、REQ-410。

### DSG-A06-13 集成构建
- `POST /api/v1/projects/{projectId}/dev/build:run` ｜ 命令型 ｜ 幂等：必需
- 说明：全任务合并后生成候选构建与**独立 UI 工件**（禁止复制原型 HTML 冒充），内容指纹可复核。
- 响应 202：`{ "operationId": "op_bd_1", "buildId": "B-2" }`
- `GET /api/v1/projects/{projectId}/dev/build` ｜ 查询型：`{ "buildId": "B-2", "status": "pass", "buildFingerprint": "sha256:…", "commits": ["c1","c2"], "uiArtifact": { "artifactId": "ua_2", "htmlFingerprint": "sha256:…", "independent": true } }`
- 承接：REQ-412、BR-11、`v19BuildCandidateHTML/devInspectBuildUiArtifact`。

### DSG-A06-14 开发自测：启动 / 复测
- `POST /api/v1/projects/{projectId}/dev/selftest:start` ｜ 命令型 ｜ 幂等：必需
- 请求：`{}`；响应 202：`{ "operationId": "op_st_1", "runId": "SELFTEST-RUN-3", "opToken": "…" }`
- `POST /api/v1/projects/{projectId}/dev/selftest:retest` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "reason": "完成修复并产生新构建" }`（reason 必填）；响应同上，含 `retestOfReportId`。
- 说明：构建前启动被拒绝（`GATE_BLOCKED: BUILD_INVALID/BUILD_REQUIRED`）；复测必须有实质返工（新构建/提交/任务修订），否则拒绝。
- 错误码：`GATE_BLOCKED`、`RETEST_WITHOUT_CHANGE`（409，构建指纹与上次失败报告相同）。承接：REQ-413、REQ-416、`devStartSelfTest/devRetestSelfTest`。

### DSG-A06-15 自测门禁（devSelfTestGate 等价端点）
- `GET /api/v1/projects/{projectId}/dev/selftest/gate` ｜ 查询型
- 响应 200：`{ "ok": false, "issues": [ { "code": "SELFTEST_BUILD_STALE", "message": "候选构建已变化" } ], "report": { "reportId": "SR-2", "status": "fail" } }`
- issue code 枚举（注册表 LLD-3 §15(b)，此处为引用）：`SELFTEST_RUNNING / SELFTEST_REQUIRED / SELFTEST_REPORT_TAMPERED / SELFTEST_BUILD_STALE / SELFTEST_DESIGN_STALE / SELFTEST_UI_SET_STALE`。
- 承接：REQ-413、REQ-414、BR-07、`devSelfTestGate`。

### DSG-A06-16 自测报告：列表 / 详情 / 导出
- `GET .../dev/selftest/reports` ｜ 查询型；`GET .../dev/selftest/reports/{reportId}` ｜ 查询型（含四门结论与逐页面×视口 UI 评分明细）
- 响应 200：`{ "reportId": "SR-2", "status": "fail", "gates": { "functional": { "ok": true }, "integration": { "ok": true }, "ui": { "ok": false }, "review": { "ok": true } }, "ui": { "pages": [ { "pageId": "pg-home", "viewports": [ { "viewportId": "1440", "status": "pass", "criticalPass": "3/3", "generalRatio": 0.97 } ] } ] }, "basedOn": { "buildFingerprint": "…", "designBaselineFingerprint": "…" }, "immutable": true }`（gates 键 `functional/integration/ui/review` 权威 PRD REQ-413，对应四门：功能检查/联调与冒烟/UI 符合度/开发审核）
- `POST .../dev/selftest/reports/{reportId}:export` ｜ 命令型：响应 202，产物为 Markdown/HTML（本期 md+html，pdf 后续），含全部执行证据引用；报告不可变、历史不可改写。
- 说明：评分规则——关键项 100%、每页一般项 ≥95%、严重偏差 0；skip/not-run/未知不算已测；空分母不产生 100%（BR-09）。承接：REQ-413、REQ-414、REQ-417、BR-09、`devExportSelfTestReport/v19MakeSelfTestReport/v19EvaluateUiEvidence`。

### DSG-A06-17 自测对照视图
- `GET /api/v1/projects/{projectId}/dev/selftest/comparison?reportId=…&pageId=…&viewportId=…` ｜ 查询型
- 响应 200：`{ "prototypePreviewUrl": "…?sig=…", "buildPreviewUrl": "…?sig=…", "sameObjectGuard": { "prototypeHtmlFingerprint": "…", "buildHtmlFingerprint": "…", "distinct": true } }`
- 说明：双侧对照，两侧不得渲染同一对象冒充比较（服务端校验两指纹不同源）。承接：REQ-415、BR-11、`devOpenUiComparison`。

### DSG-A06-18 转测试门禁查询
- `GET /api/v1/projects/{projectId}/dev/transfer/gate` ｜ 查询型（devTransferGate 等价）
- 响应 200：`{ "ok": false, "issues": [ { "code": "TASK_NOT_DONE", "message": "T-05 尚未合并完成", "target": "T-05" } ] }`
- issue code 枚举（注册表 LLD-3 §15(c)，此处为引用）：`PROJECT_SCOPE / TASK_NOT_DONE / QUALITY_INVALID / CI_INVALID / BUILD_INVALID / IMPACT_OPEN / AUTO_NOT_AWAITING_TRANSFER`，另透传 A06-15 全组（`SELFTEST_RUNNING / SELFTEST_REQUIRED / SELFTEST_REPORT_TAMPERED / SELFTEST_BUILD_STALE / SELFTEST_DESIGN_STALE / SELFTEST_UI_SET_STALE`）。
- 承接：REQ-418、`devTransferGate`。

### DSG-A06-19 确认转测试
- `POST /api/v1/projects/{projectId}/dev/transfer` ｜ 命令型 ｜ 幂等：必需
- 说明：仅当前有效且合格的自测报告可启用；人工确认（策略门禁 `dev.transfer`）后原子交接：旋转运行令牌、消费授权、生成提测交接包。未达标/过期/运行中保持阻断。
- 请求：`{ "reportId": "SR-3", "reportFingerprint": "sha256:…", "confirm": true }`
- 响应 201：`{ "handoffId": "ho_1", "batchCandidate": { "buildFingerprint": "…", "designBaselineFingerprint": "…", "selftestReportFingerprint": "…" }, "tokenRotated": true }`
- 错误码：`GATE_BLOCKED`（423，issues 同 A06-18）、`STALE_EVIDENCE`。承接：REQ-418、BR-06、BR-07、REQ-711。

### DSG-A06-20 变更影响查询 / 基线重确认
- `GET /api/v1/projects/{projectId}/dev/impacts?status=pending-assessment` ｜ 查询型：再定稿触发的影响分析，受影响任务/证据可见。
- `POST /api/v1/projects/{projectId}/dev/baseline:confirm` ｜ 命令型：人工重确认基线；请求 `{ "impactIds": ["im_1"], "resolution": "rework|accept", "note": "…" }`，响应 `{ "resolved": 1 }`
- 承接：REQ-419、REQ-420、`impactTrigger/devConfirmBaseline/devInvalidate`。

### DSG-A06-21 CI 回传（webhook，REQ-712 预留接口的 CI 入口）
- `POST /api/v1/projects/{projectId}/dev/ci/callbacks` ｜ 命令型 ｜ 幂等：投递 ID 去重（见下）
- 说明：外部 CI 系统流水线结论的服务端到服务端回传入口，为 REQ-712 生产发布预留接口的 CI 回传通道；回传结论落库 `dev_ci_reports`（LLD-4 DSG-D06-9，append-only），作为任务完成证据 CI 环节（REQ-407，A06-8）与转测试门禁 CI 缺口（`CI_INVALID`，LLD-3 §15(c)）的事实来源。本端点不走浏览器会话 Cookie。
- 认证（HMAC-SHA256 签名）：请求头 `X-MSF-Timestamp: <unix 秒>` 与 `X-MSF-Signature: sha256=<hex>`，签名串为 `<timestamp>.<原始请求体>`；密钥为项目级 webhook secret（登记/轮换端点见 DSG-A06-22，落库 `sys_webhook_secrets`（LLD-4 DSG-D10-8）；只写不读、密文存储，纪律同 DSG-A10-1）。时间戳偏差超过 ±5 分钟或签名校验失败返回 401 `UNAUTHENTICATED`；失败尝试记 audit_log、不落业务行。
- 幂等：请求头 `X-MSF-Delivery: <uuid>` 为投递 ID，落库 `dev_ci_reports.delivery_id`（`UNIQUE(project_id, delivery_id)`）；重复投递返回首个回执（200，`deduplicated: true`），不重复产生记录。
- 请求：
```json
{ "provider": "github", "commitSha": "9f2c…", "prRef": "PR-17", "taskCodes": ["T-01","T-05"], "conclusion": "pass", "detailsUrl": "https://ci.example/run/881", "startedAt": "…", "finishedAt": "…" }
```
- `conclusion` 枚举 `pass|fail|unknown`；状态不明必须如实传 `unknown`（不猜测，BR-11）。`taskCodes` 与任务池无法匹配的回传仍落库并标 `matched: false`（不拒绝真实回传），由消费侧在门禁求值时按最新匹配行判定。
- 响应 202：`{ "receiptId": "cir_01J…", "deliveryId": "…", "matched": true, "deduplicated": false }`
- 错误码：`UNAUTHENTICATED`（签名/时间戳不合法）、`VALIDATION_FAILED`（载荷缺字段/枚举非法）、`NOT_FOUND`（项目不存在或未启用 CI 回传）、`RATE_LIMITED`。
- 承接：REQ-407、REQ-712、BR-11、REQ-706。

### DSG-A06-22 项目 CI webhook secret 登记（只写不读）
- `PUT /api/v1/projects/{projectId}/dev/ci/webhook-secret` ｜ 命令型 ｜ 幂等：必需
- 说明：登记/轮换 DSG-A06-21 CI 回传的项目级 HMAC-SHA256 签名密钥（即「项目 webhook 设置」的唯一写入口）。**只写不读**：平台不提供任何读取明文的端点，本端点响应与一切查询均只回显掩码；密文存储（口径同 DSG-A10-1、REQ-710），落库 `sys_webhook_secrets`（LLD-4 DSG-D10-8）。首次登记即视为该项目启用 CI 回传（解除 A06-21 的 `NOT_FOUND`「未启用」态）；轮换后旧 secret 立即失效，回传方须同步更新签名密钥。登记/轮换为人工命令，全程审计留痕（含轮换前后 hint，不留明文）。
- 请求：`{ "secret": "whsec_9f2c…" }`（≥32 字符高熵串，服务端校验强度）
- 响应 200：`{ "enabled": true, "secretMasked": "whsec_…9f2c", "rotatedAt": "…" }`
- 错误码：`VALIDATION_FAILED`（强度/格式不符）、`FORBIDDEN`（项目越界）。承接：REQ-407、REQ-710、REQ-712、DSG-A06-21。

---

## 7. 测试验收（DSG-A07）· `/api/v1/projects/{projectId}/acceptance`

承接：REQ-501~511、BR-01、BR-03、BR-06、BR-09、BR-10、BR-11。原型出处：`acceptance-workbench.js`（acceptanceReceive/DraftPlan/ApprovePlan/Run/SaveManual/GenerateReport/FinalizeReport/Release/CreateDefect/SaveDefect/LinkRegression/CloseDefect/ReopenDefect）。

### DSG-A07-1 批次接收（幂等）
- `POST /api/v1/projects/{projectId}/acceptance/batches:receive` ｜ 命令型 ｜ 幂等：必需（重复接收返回首个回执，不产生重复批次）
- 说明：校验构建指纹与自测合格结论；批次为不可变快照（构建身份、设计基线、验收条款、环境指纹）；新构建=新批次。
- 请求：`{ "handoffId": "ho_1", "buildFingerprint": "…", "selftestReportFingerprint": "…", "designBaselineFingerprint": "…", "environment": { "os": "…", "browser": "…" } }`
- 响应 201：`{ "batchId": "TB-2", "status": "received", "snapshotFingerprint": "sha256:…", "receivedAt": "…", "deduplicated": false }`
- 批次状态（承接 LLD-2 F02-8 权威链）：`received → planned → approved → executing → reported → released`，`blocked` 为异常终态；随批次生命周期推进，在批次详情响应中返回。`blocked` 的进入/恢复端点见 DSG-A07-13/14（对应 F02-8 `batch.block`/`batch.unblock` 迁移行）。
- 错误码：`STALE_EVIDENCE`（构建/报告指纹与交接不一致）、`GATE_BLOCKED`（自测结论非 pass）。承接：REQ-501、REQ-502、`acceptanceReceive`。

### DSG-A07-2 批次列表 / 详情 / 快照导出
- `GET .../acceptance/batches` ｜ 查询型；`GET .../acceptance/batches/{batchId}` ｜ 查询型（含不可变快照全文）
- `POST .../acceptance/batches/{batchId}:export` ｜ 命令型：交接快照 JSON 导出（`acceptanceExportBatch` 真实化）；响应 202 + 签名 URL
- 承接：REQ-502。

### DSG-A07-3 测试计划：起草 / 批准
- `POST .../acceptance/batches/{batchId}/plan:draft` ｜ 命令型 ｜ 幂等：必需
- 说明：从设计目录流程起草用例（每条含 flowId/需求关联/步骤/模式）+ 强制至少一条人工走查用例。
- 响应 201：`{ "planId": "TP-2", "cases": [ { "id": "AT-001", "flowId": "fl-1", "mode": "automatic", "required": true }, { "id": "AT-MANUAL", "mode": "manual", "required": true } ], "status": "draft" }`
- `POST .../acceptance/batches/{batchId}/plan:approve` ｜ 命令型：人工批准（策略门禁 `test.plan.approve`）后固定版本与范围；请求 `{ "planId": "TP-2", "confirm": true }`，响应 `{ "planId": "TP-3", "status": "approved", "previousId": "TP-2" }`
- 承接：REQ-503、BR-06、`acceptanceDraftPlan/acceptanceApprovePlan`。

### DSG-A07-4 用例执行（创建运行）
- `POST .../acceptance/batches/{batchId}/runs` ｜ 命令型 ｜ 幂等：必需
- 说明：对已批准计划执行；自动用例由执行器真实执行并附证据；人工用例保持 `not-run` 待人工记录。**结果枚举严格为 `pass/fail/blocked/not-run/not-applicable`**；不适用≠通过；必测 not-run 保留在分母；零用例不得通过。
- 两级模型（A5 裁决）：**运行级** `tst_runs`（运行编号 `TR-<序>`，`previous_run_id` 串联运行历史，运行记录不可改写）+ **用例级** `tst_case_runs`（case_id、结果枚举、证据引用）。
- 请求：`{ "planId": "TP-3" }`
- 响应 202：`{ "runId": "TR-2", "operationId": "op_run_1" }`
- 错误码：`INVALID_STATE`（计划未批准）、`ZERO_CASES_FORBIDDEN`。承接：REQ-504、REQ-505、BR-09、`acceptanceRun`。

### DSG-A07-5 人工执行记录
- `PUT .../acceptance/runs/{runId}/results/{caseId}` ｜ 命令型 ｜ 幂等：必需
- 说明：人工结论不会由自动执行代填；必须附验证证据与有效结论；记录后生成新运行版本（运行历史不可改写，`previous_run_id` 指向上一次运行，运行级/用例级两级落库）。
- 请求：`{ "status": "pass|fail|blocked", "evidence": "验证了…证据位置…", "evidenceAttachmentIds": ["att_1"], "simulation": false }`
- 响应 200：`{ "runId": "TR-3", "previousRunId": "TR-2", "caseId": "AT-MANUAL", "status": "pass" }`
- 错误码：`VALIDATION_FAILED`（缺证据/非法枚举）、`EVIDENCE_REQUIRED`。任何模拟执行必须显式 `simulation:true` 并在报告侧标注。承接：REQ-504、REQ-505、BR-11、`acceptanceManual/acceptanceSaveManual`。

### DSG-A07-6 缺陷：创建 / 查询
- **缺陷模型（权威，A1 裁决）**：状态机五态 `new → confirmed → fixing → pending_regression → closed`；**重开不是状态而是事件**——回归失败产生 `reopened` 事件，缺陷回到 `confirmed`（不是 fixing）；严重度枚举 `P0/P1/P2/P3`（P0 阻断 / P1 严重 / P2 一般 / P3 轻微；原型种子「高/中/低」映射为 P1/P2/P3）；业务编号 `DF-<序>`。
- `POST .../acceptance/defects` ｜ 命令型 ｜ 幂等：必需；只能从本批实际失败记录创建。
- 请求：`{ "batchId": "TB-2", "runId": "TR-3", "caseId": "AT-001", "title": "…", "evidence": "…" }`
- 响应 201：`{ "defectId": "DF-3", "status": "new" }`
- `GET .../acceptance/defects?status=new,confirmed&batchId=…` ｜ 查询型
- 承接：REQ-506、`acceptanceCreateDefect`。

### DSG-A07-7 缺陷：确认（定级）
- `POST .../acceptance/defects/{defectId}:confirm` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "severity": "P0|P1|P2|P3", "reason": "确认依据与影响范围" }`（原型种子「高/中/低」分别映射 P1/P2/P3；P0=阻断级）
- 响应 200：`{ "defectId": "DF-3", "status": "confirmed", "severity": "P1" }`
- 承接：REQ-506、`acceptanceConfirmDefect/acceptanceSaveDefect`。

### DSG-A07-8 缺陷：开发侧标记待回归
- `POST .../acceptance/defects/{defectId}:mark-fixed` ｜ 命令型 ｜ 幂等：必需
- 说明：开发侧只能标记待回归（关联返工任务/新构建），**不能关闭**；状态经 `fixing` 进入 `pending_regression`。
- 请求：`{ "reworkTaskIds": ["T-05"], "newBuildFingerprint": "…", "note": "已修复" }`
- 响应 200：`{ "defectId": "DF-3", "status": "pending_regression", "linkedBuild": "B-3" }`
- 承接：REQ-506、REQ-507。

### DSG-A07-9 缺陷：关联回归证据 / 关闭 / 重开
- `POST .../acceptance/defects/{defectId}:link-regression` ｜ 命令型：需新构建批次 + 相同版本用例 + 通过的回归记录；响应 `{ "status": "pending_regression", "regression": { "batchId": "TB-3", "runId": "TR-5", "caseId": "AT-001" } }`
- `POST .../acceptance/defects/{defectId}:close` ｜ 命令型：仅测试侧人工；服务端复核回归证据指纹，不一致拒绝；响应 `{ "status": "closed" }`
- `POST .../acceptance/defects/{defectId}:reopen` ｜ 命令型：回归失败重开——`reopened` 为**事件**而非状态，缺陷回到 `confirmed`；响应 `{ "status": "confirmed", "event": "reopened" }`
- 错误码：`EVIDENCE_REQUIRED`、`STALE_EVIDENCE`。承接：REQ-506、REQ-507、`acceptanceLinkRegression/acceptanceCloseDefect/acceptanceReopenDefect`。

### DSG-A07-10 验收报告：生成 / 定稿
- `POST .../acceptance/batches/{batchId}/report:generate` ｜ 命令型 ｜ 幂等：必需
- 说明：自动汇总执行与缺陷；结论 `pass|fail`（有未通过项或未关闭缺陷即 fail）；登记 basis 指纹。
- 响应 201：`{ "reportId": "AR-2", "conclusion": "fail", "issues": ["AT-001：fail","DF-3：未关闭缺陷"], "status": "draft", "basisFingerprint": "sha256:…" }`
- `POST .../acceptance/reports/{reportId}:finalize` ｜ 命令型：人工定稿（策略门禁 `test.report.finalize`）；可定稿为「不通过」；执行或缺陷已变化（basis 指纹不符）拒绝并要求重新生成；**定稿≠放行**。
- 错误码：`STALE_EVIDENCE`。承接：REQ-508、BR-03、`acceptanceGenerateReport/acceptanceFinalizeReport`。

### DSG-A07-11 条件放行 / 交付决定
- `POST .../acceptance/reports/{reportId}:release` ｜ 命令型 ｜ 幂等：必需
- 说明：策略门禁 `test.release`（默认人工）。前置：报告已定稿且结论 pass，或走**条件放行**——仅可豁免明确列举的中低等级问题；P0/P1、必测未执行、证据失真不可豁免。决定（放行/不放行）为不可变工件，随报告与批次身份保存；**豁免清单随决定工件落库 `tst_decisions.exemptions`**（不可变，含 defect_code/severity/reason，LLD-4 DSG-D07-8），响应回显已接受豁免明细。
- 请求：`{ "type": "normal|conditional", "waivers": [ { "defectId": "DF-4", "justification": "低等级体验问题，下版本修复" } ], "confirm": true }`
- 响应 201：`{ "decisionId": "AD-2", "type": "conditional", "reportId": "AR-3", "reportFingerprint": "…", "batchId": "TB-2", "waiversAccepted": [ { "defectId": "DF-4", "severity": "P3" } ], "actor": "local-default" }`
- 错误码：`GATE_BLOCKED`、`WAIVER_NOT_ALLOWED`（details 列明不可豁免项）。承接：REQ-509、REQ-510、BR-06、REQ-711、`acceptanceRelease`。

### DSG-A07-12 决定查询 / 报告导出
- `GET .../acceptance/decisions?batchId=…` ｜ 查询型：`{ "items": [ { "decisionId": "AD-2", "type": "normal", "reportId": "AR-3", "at": "…" } ] }`
- `POST .../acceptance/reports/{reportId}:export` ｜ 命令型：报告+决定打包导出（含证据引用清单）
- 承接：REQ-510、REQ-508、`acceptanceExportReport`。

### DSG-A07-13 批次阻断（batch.block）
- `POST /api/v1/projects/{projectId}/acceptance/batches/{batchId}:block` ｜ 命令型 ｜ 幂等：必需
- 说明：批次异常阻断入口，与 LLD-2 F02-8 `batch.block` 迁移行逐条对应（人工中止路径）。前置条件：批次处于 `planned/approved/executing/reported` 之一；对已终态（`released`）批次拒绝（`INVALID_STATE`），`received`（尚未起步）与已 `blocked` 批次同样拒绝。动作：批次置 `blocked`（异常终态，落库 `tst_batches.status` 受控例外列，LLD-4 DSG-D01-4），此后一切推进命令（执行/报告定稿/放行）拒绝 `INVALID_STATE`（F02-8 异常路径）。系统路径（执行/报告期间批次依据——构建/基线/环境指纹失效的失效传播触发，报 `STALE_EVIDENCE` 语义）由失效传播命令内部置位（LLD-4 DSG-D14-4），不经本端点，对外状态语义一致。
- 请求：`{ "reason": "构建工件复核与交接指纹不符" }`（reason 必填，进通知与审计）
- 响应 200：`{ "batchId": "TB-2", "status": "blocked", "previousStatus": "executing", "blockedAt": "…" }`
- 副作用：生成「需你处理」定位条目 + 站内通知（BR-10，SSE `notice.created`）；blocked 期间历史全部保留可查（BR-03）。
- 错误码：`INVALID_STATE`（`received`/`released`/已 `blocked`）、`VALIDATION_FAILED`（缺 reason）、`NOT_FOUND`。承接：REQ-502、BR-03、BR-10、LLD-2 F02-8、LLD-3 C10-2(e)。

### DSG-A07-14 批次恢复（batch.unblock）
- `POST /api/v1/projects/{projectId}/acceptance/batches/{batchId}:unblock` ｜ 命令型 ｜ 幂等：必需
- 说明：人工恢复入口，与 LLD-2 F02-8 `batch.unblock` 迁移行逐条对应（理由必填）。前置条件：批次 `blocked`（否则 `INVALID_STATE`）；阻断原因已消除；批次快照各身份（构建/设计基线/环境指纹）与实时重算一致——不一致拒绝（`STALE_EVIDENCE`），须以新构建走新批次（REQ-502），旧批次保持 `blocked` 留存历史。动作：恢复到阻断前状态；恢复动作审计留痕。恢复不豁免任何门禁——恢复后的执行/报告/放行动作仍按各门禁实时求值，不满足返回 `GATE_BLOCKED`（423，语义同 DSG-A11-4）。
- 请求：`{ "reason": "误报，构建指纹人工复核一致" }`
- 响应 200：`{ "batchId": "TB-2", "status": "executing", "restoredFrom": "blocked", "restoredAt": "…" }`
- 错误码：`INVALID_STATE`（非 `blocked`）、`STALE_EVIDENCE`（409/423，快照身份与实时重算不一致）、`VALIDATION_FAILED`（缺 reason）、`NOT_FOUND`。承接：REQ-502、BR-03、LLD-2 F02-8、LLD-3 C10-2(e)。

---

## 8. AI 助手与编排（DSG-A08）· `/api/v1`

承接：REQ-601~615、BR-06、BR-08。原型出处：`chatDockHtml`、`sessions`、`streamReply/tickStream`、`AGENT_TOOLS/registerTool`、`NAV_MAP`、`nextStepRules`、`agents/prompt vers`、`viewDelegate/targets`（含 pi_native 先导）、`models m1-m4`、`usage`。

> **实现载体注（REQ-615）**：本章端点形态不变；服务端实现载体为 Pi SDK（@earendil-works/pi-*）——消息流式由 pi-ai 驱动、工具调用经 pi-agent-core（平台工具包装为 Pi AgentTool）、会话与模型注册经 pi-coding-agent 嵌入 SDK（SessionManager/ModelRegistry）、委派首选 pi RPC 模式（stdin/stdout JSONL）；REQ-613 行为边界与策略门禁仍在平台层（M12）强制，不经 Pi 审批机制。

### DSG-A08-1 会话：创建 / 列表 / 切换
- `POST /api/v1/projects/{projectId}/ai/sessions` ｜ 命令型：请求 `{ "context": { "stage": "req", "docId": "doc_crd" } }`，响应 201 `{ "sessionId": "ss_1" }`
- `GET /api/v1/projects/{projectId}/ai/sessions` ｜ 查询型（历史保留）
- 说明：AI 会话一律归属项目、挂在项目路径下（波次 2 修订，对齐 DSG-A01-1 项目隔离规则：服务端校验会话 `project_id` 与路径一致，不一致 403 `FORBIDDEN` + 缺口子码 `PROJECT_SCOPE`）；LLD-4 `ai_sessions.project_id` 的 NULL 全局会话为扩展预留，本期不产生端点。
- 承接：REQ-601、REQ-602。

### DSG-A08-2 消息：历史查询
- `GET /api/v1/projects/{projectId}/ai/sessions/{sessionId}/messages?cursor=…` ｜ 查询型
- 响应 200：`{ "items": [ { "id": "m_1", "role": "user|assistant|tool", "text": "…", "tool": { "name": "parser.rerun", "detail": "耗时 12.6s · tokens 4.2k" }, "at": "…" } ], "nextCursor": "…" }`
- 承接：REQ-602。

### DSG-A08-3 发送消息（SSE 流式）
- `POST /api/v1/projects/{projectId}/ai/sessions/{sessionId}/messages` ｜ 命令型 ｜ 幂等：必需 ｜ 响应 `text/event-stream`
- 说明：流式逐字输出；页面上下文感知（请求带当前视图/选中工件）；引用已定稿资料受 REQ-114/115 门禁约束。
- 请求：`{ "text": "生成 CRD 初稿", "context": { "view": "stage-req" }, "referenceFileIds": ["f_9"], "thinkingLevel": "low|mid|high" }`
- 响应事件：`stream.delta` × N → `stream.done`（含 `messageId`、`usage`、`toolCalls[]`）。
- 消费方式：本端点为 POST-SSE，浏览器 `EventSource` 不可用；前端必须以 `fetch` + `ReadableStream` 消费事件流（约束与断线重试纪律见 DSG-A01-6）。
- 错误码（`stream.error` 的 data.code）：`REFERENCE_NOT_FINAL`、`REFERENCE_STALE`、`MODEL_UNAVAILABLE`。承接：REQ-601、REQ-603、REQ-604、REQ-608、REQ-614。

### DSG-A08-4 流控制
- `POST /api/v1/projects/{projectId}/ai/messages/{messageId}:pause | :resume | :stop` ｜ 命令型 ｜ 幂等：必需
- 说明：`stop` = Pi abort（中止底层模型流）；暂停/继续由平台缓冲层实现（缓冲增量、续传继续推送），不依赖 Pi steering。
- 响应 200：`{ "messageId": "m_2", "status": "stopped", "partialDiscarded": true }`
- 承接：REQ-603。

### DSG-A08-5 工具注册表查询
- `GET /api/v1/ai/tools` ｜ 查询型
- 响应 200：`{ "items": [ { "name": "nav.goto", "description": "按名称跳转平台视图", "params": { "view": "string" }, "risk": "read|write", "enabled": true } ] }`
- 说明：工具清单注册式管理；调用过程可见、可审计（每次调用入审计流）。**保留全局路径、不挂项目作用域（波次 2 裁决）**：工具注册表为平台级注册、内容不随项目变化，无项目归属语义。承接：REQ-605、REQ-606、`AGENT_TOOLS/registerTool/NAV_MAP`。

### DSG-A08-6 下一步建议
- `GET /api/v1/ai/next-steps?projectId=…&stage=…` ｜ 查询型
- 响应 200：`{ "suggestions": [ { "action": "finalize-prd", "label": "定稿 PRD v4", "reason": "RTM 健康度已达标", "deeplink": "/projects/pj1/req" } ] }`
- 说明：**保留全局路径 + `projectId` 参数（波次 2 裁决）**：存在跨项目汇总场景（全局助手跨项目给出建议），不挂单一项目路径。承接：REQ-607、`nextStepRules`。

### DSG-A08-7 子 Agent 与提示词版本
- `GET /api/v1/ai/agents` ｜ 查询型：`{ "items": [ { "id": "ag-planner", "role": "规划", "promptVersion": "pv-7", "status": "active" } ] }`
- `GET /api/v1/ai/agents/{agentId}/prompts` ｜ 查询型（版本历史）
- `POST /api/v1/ai/agents/{agentId}/prompts/{promptVersion}:rollback` ｜ 命令型：提示词版本回滚，留痕
- 承接：REQ-609。

### DSG-A08-8 委派
- `POST /api/v1/projects/{projectId}/ai/delegations` ｜ 命令型 ｜ 幂等：必需
- 说明：委派给外部执行目标（本机 Claude Code / Codex CLI 等适配器）；任务隔离执行；过程与结果回传。**委派为项目资源、挂项目路径（波次 2 裁决）**：并发上限按项目计（默认 2、可配置，系统设置；建议值，压测后校准），超限返回 `RATE_LIMITED`。
- 请求：`{ "target": "claude_code_local", "task": "实现 T-01 栏目空状态", "taskId": "T-01", "workspaceScope": ["src/pages/column"] }`
- 响应 202：`{ "delegationId": "dlg_1", "operationId": "op_dlg_1", "status": "running" }`
- `GET /api/v1/projects/{projectId}/ai/delegations/{delegationId}` ｜ 查询型：进度/产出/证据回传
- 承接：REQ-610、ADR-8。

### DSG-A08-9 模型与路由
- `GET /api/v1/ai/models` ｜ 查询型：`{ "items": [ { "id": "m1", "provider": "anthropic", "model": "claude-…", "purposes": ["plan","review"] } ] }`
- `PUT /api/v1/ai/model-routes` ｜ 命令型：请求 `{ "routes": { "plan": "m1", "generate": "m2", "review": "m1" } }`，响应 `{ "updated": true }`
- 承接：REQ-611、REQ-614。

### DSG-A08-10 用量统计
- `GET /api/v1/ai/usage?projectId=…&from=…&to=…` ｜ 查询型
- 响应 200：`{ "items": [ { "model": "m1", "tokensIn": 120400, "tokensOut": 38100, "durationSec": 930, "estimatedCost": 2.41, "currency": "USD" } ], "total": { "estimatedCost": 2.41 } }`
- 说明：**保留全局路径 + `projectId` 参数（波次 2 裁决）**：成本汇总存在跨项目视图（顶栏「本月成本」popover 跨项目聚合），不挂单一项目路径。承接：REQ-612、`usage`。

---

## 9. 放行策略引擎（DSG-A09）· `/api/v1/policies`

承接：REQ-711、BR-06、ADR-7。确认点枚举（**全集 7 点，小写点式**，PRD BR-06 为权威）：`req.doc.finalize` / `design.prototype.finalize` / `dev.plan.approve` / `dev.transfer` / `test.plan.approve` / `test.report.finalize` / `test.release`。

### DSG-A09-1 确认点清单与当前策略
- `GET /api/v1/policies/gates?projectId=…` ｜ 查询型
- 响应 200：`{ "items": [ { "point": "dev.transfer", "mode": "manual", "preconditions": ["selftest.pass","baseline.valid"], "lastSwitch": { "at": "…", "by": "local-default" } } ] }`
- 承接：REQ-711。

### DSG-A09-2 确认点求值
- `POST /api/v1/policies/gates/{point}:evaluate` ｜ 命令型（求值本身留痕，但不改变业务状态）｜ 幂等：必需
- 说明：返回该确认点对当前项目上下文的求值结果；auto 模式下前置条件满足才可自动放行，逐次留痕。
- 请求：`{ "projectId": "pj1", "context": { "reportFingerprint": "…" } }`
- 响应 200：`{ "point": "dev.transfer", "mode": "manual", "wouldPass": false, "issues": [ { "code": "SELFTEST_REQUIRED", "message": "需要当前通过的开发自测报告" } ] }`
- 承接：REQ-711、BR-07、BR-09。

### DSG-A09-3 策略模式切换
- `PUT /api/v1/policies/gates/{point}/mode` ｜ 命令型 ｜ 幂等：必需
- 说明：**切换本身是 manual 命令**（不可由 AI/自动通道执行）并通知项目成员；定义、切换、每次自动放行均留痕可审计。
- 请求：`{ "projectId": "pj1", "mode": "auto", "preconditions": ["selftest.pass","baseline.valid"], "confirm": true }`
- 响应 200：`{ "point": "dev.transfer", "mode": "auto", "switchedBy": "local-default", "auditId": "aud_91" }`
- 错误码：`POLICY_MANUAL_REQUIRED`（非人工通道调用）、`VALIDATION_FAILED`。承接：REQ-711、BR-06、REQ-613。

---

## 10. 平台（DSG-A10）· `/api/v1/system`

承接：REQ-701、REQ-703、REQ-705、REQ-706、REQ-707、REQ-708、REQ-710、REQ-805。

### DSG-A10-1 设置：查询 / 更新
- `GET /api/v1/system/settings` ｜ 查询型：`{ "retentionDays": 365, "parseTempKeepDays": 7, "models": [ … ], "agents": [ … ] }`
- `PUT /api/v1/system/settings` ｜ 命令型：请求 `{ "parseTempKeepDays": 14, "baseVersion": 3 }`；模型/Git 令牌仅写不读（响应返回掩码）。
- 承接：REQ-705、REQ-710（密钥本地加密存储）。

### DSG-A10-2 通知中心
- `GET /api/v1/system/notifications?unread=true` ｜ 查询型
- `POST /api/v1/system/notifications/{noticeId}:read` ｜ 命令型：`{ "unread": false }`
- `POST /api/v1/system/notifications:read-all` ｜ 命令型
- 说明：本期仅站内通知（顶栏铃铛 + 抽屉）；邮件/webhook 等外部通道列后续扩展。承接：REQ-703、`notices`。

### DSG-A10-3 审计查询
- `GET /api/v1/system/audit?projectId=…&actor=…&command=…&cursor=…` ｜ 查询型（游标）
- 响应 200：`{ "items": [ { "eventId": "aud_1001", "actor": "local-default", "actorType": "human", "command": "selftest.start", "inputFingerprint": "sha256:…", "result": "ok", "at": "…", "hashChainPrev": "sha256:…" } ], "nextCursor": "…" }`
- 说明：审计为哈希链追加存储，只读导出，不提供任何修改/删除端点。承接：REQ-706、REQ-805、BR-04、ADR-5、`devAudit`。

### DSG-A10-4 备份导出
- `POST /api/v1/system/backups:export` ｜ 命令型 ｜ 幂等：必需
- 请求：`{ "scope": "project", "projectId": "pj1", "includeEvidence": true }`
- 响应 202：`{ "operationId": "op_bak_1" }`，完成后事件含签名下载 URL（PG 逻辑导出 + MinIO 工件清单，含 SHA-256 清单）。
- 承接：REQ-708、REQ-804。

### DSG-A10-5 用户（本期最简）
- `GET /api/v1/system/users` ｜ 查询型：`{ "items": [ { "id": "local-default", "name": "本地工程师", "role": "engineer", "source": "local" } ] }`
- `GET /api/v1/system/users/me` ｜ 查询型：当前身份（含 actorType）
- 说明：本期不提供用户增删改端点；OIDC/LDAP 接入后扩展（REQ-707）。承接：REQ-707。

### DSG-A10-6 健康检查
- `GET /api/v1/system/health` ｜ 查询型（无需鉴权）：`{ "status": "ok", "services": { "postgres": "ok", "redis": "ok", "minio": "ok", "sandbox": "ok" } }`
- 承接：REQ-804、REQ-805。

### DSG-A10-7 异步操作查询
- `GET /api/v1/projects/{projectId}/operations/{operationId}` ｜ 查询型
- 响应 200：`{ "operationId": "op_st_1", "action": "selftest.start", "owner": "autopilot", "status": "running", "progress": 62 }`
- 说明：异步操作状态枚举 `pending/running/succeeded/failed/cancelled/stale`（M4 统一，波次 2 补 `stale` 落库值，LLD-4 DSG-D06-3）：`stale`=操作过期/被取代（输入失效或被同范围新操作取代，承接 LLD-2 DSG-F01-2 的 `stale`/`superseded` 落库合并值）；操作行置 `stale` 终态时推送 SSE `operation.stale` 事件，过期/被取代不产生任何业务写入（BR-08/14，DSG-A11-2）。
- 承接：BR-08、BR-14。

---

## 11. 专题约定

### 11.1 命令型端点与查询型端点的区分（DSG-A11-1）

- **命令型**（写）：一切 POST/PATCH/PUT/DELETE 与冒号动作。统一走封闭命令注册表（ADR-3）；**必须**携带 `Idempotency-Key`；响应**必须含 `operationId`**（同步命令也返回，供审计追踪与效果恢复关联）。**豁免（唯一）**：分片上传 PUT（DSG-A03-2）以 `(uploadId, partNumber)` 天然键幂等（同分片重传覆盖同内容），不要求 `Idempotency-Key`；其余写端点无一刀切外豁免。
- **查询型**（读）：GET，永不改变领域状态，天然幂等，不要求幂等键；门禁求值类 GET（A05-10、A06-15、A06-18、A02-4）实时计算、不缓存为放行依据。
- 同步命令响应骨架：
```json
{ "operationId": "op_01J…", "status": "committed", "result": { }, "auditId": "aud_1001" }
```
- 承接：BR-04、BR-14、REQ-706。

### 11.2 异步操作身份的 API 呈现（DSG-A11-2）

- 异步命令返回 202 + `{operationId, runId?, opToken?}`；身份四元组 `operationId + token + action + owner`（BR-08）在响应中显式暴露 `operationId` 与 `token`（opToken/runToken 不重复返回给无关第三方，仅当事会话可见）。
- 操作查询端点归平台章：`GET /api/v1/projects/{projectId}/operations/{operationId}`（DSG-A10-7，项目作用域）。
- 回调/推进（执行器→平台）内部通道提交前重验实时指纹与父运行身份；**晚到/失效回调严格零写**：不更新操作行、不产生业务写入，仅记 audit_log。操作因输入失效或被取代进入 `stale` 终态时（LLD-4 DSG-D06-3），对外表现为 SSE `operation.stale` 事件与查询态 `status=stale`，业务对象状态不变。
- 承接：BR-08、BR-13、BR-14。

### 11.3 SSE 事件类型表（DSG-A11-3）

见 DSG-A01-6 表。事件 `data` 最小公共字段：`{ "projectId", "at", "actor", "actorType" }`；操作类事件必带 `operationId`；门禁类事件必带 `issues[]`。客户端按 `event` 分发，`id` 用于断线重连（`Last-Event-ID`）。承接：REQ-202、REQ-603、REQ-703、BR-08。

### 11.4 门禁失败的统一响应（DSG-A11-4）

- 门禁阻断的**命令**端点返回 **423 Locked**（极少数与资源版本冲突并发的场景用 409），`error.code=GATE_BLOCKED`（或更具体的 `STALE_EVIDENCE`），`error.details.issues` 为缺口数组：
```json
{ "error": { "code": "GATE_BLOCKED", "message": "转测试条件不满足", "details": { "issues": [
  { "code": "TASK_NOT_DONE", "message": "T-05 尚未合并完成", "target": "T-05" },
  { "code": "SELFTEST_BUILD_STALE", "message": "候选构建已变化", "target": "B-2" }
] } } }
```
- `issues[].code` 取值闭集见 **LLD-3 §15**（二级 issue code 注册表），各章「issue code 枚举」为其子集引用；`target` 指向缺口对象 ID，供 UI 定位到页面/任务/文件（BR-10 失败定位）。
- 查询型门禁端点（GET）返回 200 + `{ok:false, issues:[…]}`，语义同构。承接：BR-07、BR-10、REQ-418、REQ-208、REQ-702。

### 11.5 预览子域与 TLS（DSG-A11-5）

- 预览面（原型预览 DSG-A05-8、自测对照 DSG-A06-17、构建工件预览）一律走独立子域 `*.preview.<部署域>` + sandboxed iframe + CSP，与主站会话 Cookie 域隔离（HLD §6）。
- **TLS 定案（波次 2）**：本期自托管单节点采用**内部 CA 签发的泛域名证书**（`*.preview.<部署域>`；无内部 CA 时用自签泛域名证书），根证书的安装与信任在部署文档注记（运维手册）中说明；生产扩展期再更换为公共 CA 泛域名证书——端点与预览 URL 结构不变，仅换证书链。不采用「IP 直连无 TLS」（破坏 `Secure` Cookie 与浏览器隔离语义）与「每预览域名单独证书」（与子域动态性不匹配、运维成本高）两方案。
- 承接：REQ-307、REQ-803、HLD §6。

---

## 修订记录

| 日期 | 条目 | 变更 |
| --- | --- | --- |
| 2026-09-20 | 全部 | 初稿（依据 PRD V1.0-draft / HLD V1.0-draft，核对原型 handler：`mockUpload/doUpload`、`v11Parse/v11Extract/batchParse/retryParse`、`finalFile/finalContent`、`commitVer/finalizeDoc/acceptPend/rejectPend`、`designPlanPrototype/designGeneratePrototype/designCheckPrototype/designFinalizePrototypeBaseline/designPrototypeGate`、`devIdentify/devSubmitPlan/devApprovePlan/devApproveAndRun/devStartSelfTest/devRetestSelfTest/devExportSelfTestReport/devTransferGate/devSelfTestGate`、`acceptance-workbench.js` 全量、`preparePrototypeCommand/publishPrototypeCommand`） |
| 2026-09-20 | 全册 | 统稿修订（依据《统稿裁决记录》）：缺陷模型/严重度/重开事件对齐 A1（`pending_regression`、`P0~P3`+映射注、`reopened` 事件回 confirmed）；测试执行两级模型（TR-<序> 运行级 previous_run_id + 用例级）与批次六态落入响应（A5）；§9 确认点对齐全集 7 点小写点式并全册替换旧命名（A6）；错误码表注明唯一注册表在 LLD-3 §14、码值 UPPER_SNAKE 无域前缀（A3）；枚举对齐 M4（file_final/content_final、translate/mask/index、作业行 pending/processing/succeeded/failed/skipped、思考强度 low/mid/high、执行者 human/agent）；业务编号统一 TB/TP/TR/AR/AD/DF、SR、B（M5，替换 AB-B-2/STR/build_N 等漂移写法）；设计册前缀改 h/o/g/k/d/a/u/n（M7）；看板列 queue/ing/review/done + blocked 标记（A4）；RTM 健康度补 L0c deferred 计数（A7）；新增 DSG-A05-13 设计目录人工增删写端点（人工补充标记+审计，D22）；operations 查询归平台章 DSG-A10-7、ZIP 同名冲突默认拒绝可选重命名、导出本期 md+html、委派并发默认 2 可配置、通知本期站内——§12 待澄清 7 项全部裁决回销，本节删除 |
| 2026-09-20 | DSG-A08（章头部） | 用户决策落地（PRD REQ-615）：A08 章头部补实现载体注（Pi SDK：pi-ai 流式、pi-agent-core 工具执行、pi-coding-agent 会话/模型注册、委派 pi RPC）；端点形态不变；承接集扩为 REQ-601~615 |
| 2026-09-20 | DSG-A01-1/A01-4、A03-3、A05-7/A05-10/A05-12、A06-15/A06-18、A11-4 | 波次 0 评审整改（裁决 R-01）：错误码两级制落地——§1.4 错误码表声明一级注册表 LLD-3 §14、二级 issue code 注册表 LLD-3 §15；项目越界 403 改 `FORBIDDEN`+缺口子码 `PROJECT_SCOPE`（§15(c)），业务码表移除 `PROJECT_SCOPE` 行；A03-3 上传违规子码改用注册名 `ZIP_*` 族（§15(j)）；A05-12 `SOURCE_ANCHOR_MISMATCH` 归并为 `SOURCE_SEMANTIC_UNVERIFIED`（§15(h)）；A05-10/A06-15/A06-18 issue code 枚举标注为 §15 引用并展开 `SELFTEST_*` 通配；A11-4 声明 `issues[].code` 闭集见 LLD-3 §15 |
| 2026-09-20 | DSG-A04-12、DSG-A01-2、DSG-A10-3 | 波次 1 评审整改：A04-12 响应与说明改四指标结构（l0c=REQ→DSG 锚点覆盖率、新增 l0d=deferred 计数、thresholds 补 l0c=1.0，权威 PRD REQ-208 波次 1-3 口径）；A01-2/A10-3 操作者类型枚举对齐 LLD-3 DSG-C01-3 权威（`human|assistant|sub-agent|autopilot|system`，替换 agent/user 旧写法） |
| 2026-09-20 | DSG-A01-6、A03-1/A03-2/A03-3、A03-18（新增）、A04-4/A04-5、A05-2、A06-8、A06-21（新增）、A07-11、A08-1~A08-4、A10-7、A11-2、A11-5（新增） | 波次 2 评审整改（D 组）：① 异步操作状态补 `stale`（A10-7 枚举六值、A11-2 零写与 stale 终态表述，落库权威 LLD-4 DSG-D06-3）；② A03 上传系补分片落库流程（mat_uploads 会话登记/分片清单/合并校验/过期清理），新增 A03-18 中止上传会话端点；③ POST-SSE 消费方式定案：EventSource 仅支持 GET，A01-6 补 fetch + ReadableStream 约束与断线重试纪律，A04-4/A05-2/A08-3 逐端点标注；④ AI 会话体系挂项目路径（A08-1~A08-4 改 `/projects/{projectId}/ai/...`，A08-3 请求体去 projectId 冗余），全局会话留扩展预留；⑤ 新增 A06-21 CI 回传 webhook（HMAC-SHA256 签名 + 时间戳防重放、X-MSF-Delivery 投递幂等、落库 dev_ci_reports、conclusion 含 unknown），A06-8 完成列 CI 证据指向该表；⑥ 新增 A11-5 预览子域 TLS 定案（内部 CA/自签泛域名证书 + 部署文档注记，生产扩展期换公共 CA）；⑦ A07-11 条件放行补豁免清单落库指向（tst_decisions.exemptions）与响应回显 |
| 2026-09-20 | DSG-A04-5/A08-4、A08-5/A08-6/A08-8/A08-10、A03-16 | 波次 2 裁决执行：A04-5/A08-4 过程控制补实现语义注（stop=Pi abort，暂停/继续由平台缓冲层实现、不依赖 Pi steering）；A08-8 委派迁移至 `/projects/{projectId}/ai/delegations...`（项目资源、并发上限按项目计），A08-5 工具注册表（平台级注册）与 A08-6 next-steps/A08-10 usage（跨项目汇总场景）保留全局路径并逐端点注明理由；A03-16 作业级状态枚举以 LLD-4 `mat_batch_jobs.status` 为权威对齐为 `running/stopped/done/rejected`（`:stop` 响应示例同步改 `stopped`），并注明该枚举指批量作业行本身而非异步操作行 |
| 2026-09-20 | DSG-A03-15/A03-16、A05-10、A04-12 | 波次 2 裁决执行（第二批）：A03-16 作业级状态枚举改以 LLD-2 DSG-F02-4 五态为权威 `idle/confirming/running/done/stopped`（替代上一轮对齐的四值；落库 LLD-4 DSG-D03-5）；A03-15 基线快照口径同步改述（弹窗整批快照→开始整批复核不一致则中止不留作业行；执行中变化行逐行跳过，STALE_EVIDENCE 语义改指开始复核）；A05-10（action=develop）与 A04-12 gaps 枚举引用补入 §15(e) 新注册子码 `L0C_BELOW`（L0c 缺口逐条指向未承接 REQ，`RTM_HEALTH` 回归汇总级） |
| 2026-09-21 | DSG-A07-13/A07-14（新增）、A07-1、A06-22（新增）、A06-21、A06-16、A01-3、A01-6、A03-2、A03-15、A11-1 | 二轮评审整改：① 新增 A07-13/A07-14 批次阻断/恢复端点（与 LLD-2 F02-8 `batch.block`/`batch.unblock` 迁移行逐条对应，A07-1 补指引；命令已注册 LLD-3 C10-2(e)）；② 新增 A06-22 项目 CI webhook secret 登记端点（只写不读、密文存储落 `sys_webhook_secrets`，HMAC 口径与 A06-21 呼应），A06-21 认证注改指 A06-22；③ A06-16 响应 gates 键 unit/smoke/ui/audit 改 PRD REQ-413 权威键 functional/integration/ui/review（四门中文名功能检查/联调与冒烟/UI 符合度/开发审核）；④ A01-6 补 SSE 断线续传基板界定（GET 通道只覆盖 M11 持久事件；stream.delta 仅 Redis 滚动窗内可续，窗外经查询端点补拉）；⑤ A03-2 分片 PUT 天然键幂等豁免 Idempotency-Key 的说明补入 A11-1 与 A01-3，并补同会话并发分片 parts 更新行锁串行化（落库细节 LLD-4 DSG-D03-7）；⑥ A03-15 补作业落库时机权威指引（LLD-4 DSG-D03-5）；⑦ A03-16 复核：作业级五态与 F02-4 最新口径一致，无需同步变更 |
| 2026-09-21 | DSG-A04-12 | 二轮评审整改（W5A 移交同步）：A04-12 说明中 L0a 权威口径同步 R-03 裁决（分母=active R，deferred 不计；active R 为 0 时记 1 并告警），与 PRD REQ-208/LLD-2 DSG-F06-1 一致 |
