# AI 会话跨阶段互通 + 对话改文档 + 需求章节编号 · 设计（2026-10-03）

> 来源：用户 V2.0 实机使用后提出的三需求。决策已拍板：①各阶段会话独立但互相可读；②对话改文档先只做需求文档（CRD/PRD）；③章节编号=大章+子节号、CR/REQ 锚点码入括号。
> 纪律：错误码闭集不加码（工具失败一律走结果消息，不新增 DomainError 码）；新命令先注册 command-bus；审计失败零写；本设计涉及 LLD-5/LLD-6 的新端点/新工具/prompt 段落，全部差异登记待 13 册回补。

## 一、跨阶段会话互通（摘要注入 + 按需深读）

### 现状

`ai_sessions.ctx` 只是标签（material/req/design/proto/dev/test）；dock 按路由过滤会话列表；`sessions.service.ts buildPrompt` 只取**本会话**近 12 条消息，无任何跨会话读取。跨阶段的唯一读通道是只读工具（doc.read / read_context）。

### 设计

**1. Prompt 注入【他阶段会话】块**（buildPrompt 内，位于【会话历史】之前）：

- SQL：本项目其它会话（`project_id=$1 AND id<>$2`），按 `updated_at DESC` 取最近 10 个会话；每会话取最近 2 条 `role='user' AND status='done'` 消息，单条截 200 字。
- 渲染：每会话一行组——`[资料] ss_3（2026-10-03 15:20）` + 用户消息摘录；整块字符预算封顶 3000（超出从最旧会话开始丢弃）。
- 纯函数 `buildCrossSessionDigest(rows, budget)` 落 platform 层便于单测。

**2. 新只读工具 `chat.history.read`**（tools.service 允许集，非 WRITE_TOOLS）：

- args：`{ sessionCode: string, limit?: number }`（limit 默认 20、封顶 50）。
- 语义：按 `project_id + code` 查会话（跨项目/不存在 → failed 结果消息，不抛码），返回该会话最近 limit 条 user/ai 消息（单条截 1500 字），供模型需要细节时自主深读。
- 【可用工具】硬编码段同步声明该工具（含 args 示例），能力边界段不变（仍是只读）。

**3. 口径**：dock 会话列表/新建/草稿仍按阶段隔离（用户已确认形态），互通只发生在 AI 读侧；token 成本=每请求固定 +≤3000 字符。

## 二、对话改文档（dock 补丁工具，复用现有审阅链）

### 现状

dock 工具全只读；改文档唯一通道是需求页「🔄 重新生成」增量修订 → `req_pendings` 待确认补丁 → 高亮（pending-add/mod/del）→ 逐条 accept/reject + 前端 PatchBulk 全部接受/拒绝。审阅链完整，缺 dock→补丁的桥。

### 设计

**1. 新工具 `req.doc.propose_edits`**（注册进 tools 允许集；不在 WRITE_TOOLS 拒绝名单——它不直写文档，产出的是待确认补丁，人工确认后才生效，符合「人工定稿不可自动化」）：

- args：`{ kind: 'crd'|'prd', instruction: string }`（instruction 截 2000 字）。
- 服务端流程（req/generate.service.ts 扩方法 `proposeEditsFromChat`）：
  1. 读当前文档有效内容（getDoc 同路径；**文档尚未生成** → 「文档还没有内容，请先在需求页生成初稿」）；
  2. 复用增量修订 prompt（`buildPrompt` 的修订分支）+ 用户 instruction，走 pi 网关**非 SSE 内部调用**（mock 模式回落确定性 mock 补丁——mock 产出约定含「命中既有节标题」与「全新节」两种形态，便于测 normalize 两分支，离线可测）；
  3. `mdToPatches` 解析 → **normalizePatches 归一化**（新纯函数，落 platform/doc-sections.ts）：add 补丁标题命中既有节（先按锚点码 CR-nnn/REQ-nnn 匹配、再按标题精确匹配）→ 改写为 `{type:'modify', secId: 既有节 id, title: 原题, old: 既有节 md, new: 新正文}`（整节重写语义；**old 必须取 splitSections 产出的节 md**——已 trim 且 `\n{3,}` 塌缩为 `\n\n`，不可从文档原文裸切，否则 accept 时 includes 校验失配；applyPatch 的 old⊆md 校验天然兼容整节替换）。注意不对称边界：mdToPatches 标题截 80 字符而 splitSections 不截，>80 字符的无锚点码节（如长大章标题）精确匹配会落空退回 add——CR/REQ 节走锚点码匹配不受影响，此边界登记为已知限制。del 模型无法经 markdown 表达，本期不支持（页面手工删除能力已有）；**该归一化同时挂进需求页既有增量修订流（修复其「修改章节实为重复追加」的潜在缺陷，差异登记）**；
  4. 落库走命令总线 `doc.propose-pending`（注意：命令名无域前缀；proposedBy='assistant'，留痕同现有生成流）。

  **事务模型（关键）**：`ai.tool.invoke` 在命令事务内执行工具，而本工具含 10~30s 嵌套 LLM 调用——**绝不能在事务/池连接内跑 LLM**。且存在模块向约束：ReqModule 已 import AiModule 且未导出 GenerateService，AiSessionsService 直接注入 GenerateService 会构成 Nest 循环依赖（本仓刻意不用 forwardRef）。故采用**外部工具注册表**机制（platform 层新增 `registerExternalTool(name, handler)`，镜像 registerCommand 的注册表先例）：req 模块 onModuleInit 时把 `req.doc.propose_edits` 的 handler 注册进去；runToolBlocks 解析到工具块时先查外部注册表——命中则走旁路：handler 内部 LLM 调用无事务包裹 → `executeCommand('doc.propose-pending')` 独立事务落补丁 → 成功后补落 `ai_tool_calls` 行（record 需新增 public 变体：现 record() 为 private 且绑定 PoolClient，旁路在事务外，改用 pool query 直插，INSERT 语句原样平移，sessionId+messageId 挂接同 invoke 口径）；未命中注册表仍走 invoke 不变（其余只读工具口径不动）。补丁落库与工具留痕非同一事务是可接受口径：补丁本身即待确认草稿，留痕缺失风险由 record 失败重试一次+失败仅日志承担（与现有流末 error 帧口径一致）。**审计口径注**：旁路工具不产生 `ai.tool.invoke` 命令审计行，留痕=ai_tool_calls 行 + doc.propose-pending 命令审计行（测试断言按此两链）。
  **用量口径**：嵌套 LLM 调用与生成流同口径落 `ai.usage.record`（purpose='generation'，generate.service.ts:308-312 先例）。

- 前置守卫（沿用现有语义，失败=工具返回 ok:false + 人话原因，不新增错误码）：
  - 文档已定稿（VERSION_LOCKED）→ 「文档已定稿，请先在需求页解锁后再修改」；
  - 存在未处置补丁（assertNoPendings 单批闸）→ 「有 N 条待确认补丁，请先在需求页处置后再提新修改」；
  - 补丁基指纹失配 PATCH_BASE_STALE → 「文档已被其它操作变更，请刷新后重试」；
  - AI 产出 0 补丁/解析失败 → 「未产出有效修改，可换种说法重试」。
- 结果：`{ ok, patchCount, route: '/req' }`。
- **ToolDef.kind 类型扩展**：现为 `'read' | 'nav'`，本工具增 `'propose'` 档（提案型写：不直写文档，产物必经人工确认）——类型与工具卡图标分档同步扩展。

**2. 前端**：ToolCards 对 `req.doc.propose_edits` 成功卡渲染「✓ 已提交 N 条修改建议」+「前往审阅 →」钮（复用 nav.goto 卡的跳转模式，点击才跳，不静默跳页）；失败卡显原因。

**3. 能力边界文案改写**（buildPrompt【能力边界】段）：「你没有写权限……」→「你不能直接修改文档/定稿/放行；但可以通过 ```msf-tool req.doc.propose_edits``` 提交修改建议，以高亮补丁形式交由用户确认后生效」。【可用工具】段补该工具的调用格式与示例。

**4. 时序**：工具在流末 runToolBlocks 执行；propose_edits 经旁路（LLM 在外、命令在内，见上），SSE 保持到 finish——与生成流时长同级；工具卡状态随 `ai.message.finish` 落库后渲染。

## 三、需求文档章节编号（大章生成约定 + 渲染层派生编号）

### 现状

生成 prompt：每条需求一个 `## CR-001 标题` 平铺；splitSections 仅按 `## ` 切节；无数字章节号；RTM 锚点=标题内 CR-nnn/REQ-nnn 码。

### 设计

**1. 生成约定**（req/generate.service buildPrompt 整篇/增量两分支同步改）：

- 整篇：先出大章 `## 一、<章名>`（章下可有一段引言），其下需求节保持 `## CR-001 <标题>` / `## REQ-001 <标题>` 格式不变（锚点码必须在标题内，RTM 不断链）；
- 大章命名引导：背景与目标/功能需求/非功能需求等（模型按内容归类）；
- 增量修订：新增需求节落在合适大章之后（add 补丁文末追加的现有语义不变，编号渲染层派生故无需重排）；编号顺延规则不变。

**2. 派生编号纯函数** `deriveNumbering(secs)`（packages/shared，前后端共用；输入类型取最小形状 `{ id: string; title: string }[]`——web 侧消费的是 API 返回的 secs 而非 server 内部 DocSection，共享包只依赖该最小结构）：

- 输入 splitSections 的节列；标题命中 `/^[一二三四五六七八九十]+、/` 判大章（章计数 +1、节计数清零）；其余节组内计数；
- 输出每节 `displayTitle`：有大章 → `2.1 浏览器即开即玩（CR-001）`（CR/REQ 码从标题首词提取入括号）；无大章（存量文档）→ 退化纯序号 `1. 浏览器即开即玩（CR-001）`；s0 文首不编号。
- 消费点：需求页 TocCol（大章加粗/节缩进一层）+ Paper 节标题 H2；导出 md/html 服务端经同一函数注入编号（导出所见即所得）。

**3. 不变量**：存储内容零改动（编号不烤入标题）；补丁定位仍 secId；undo/版本链/定稿/RTM 派生全部不受影响；存量文档无需迁移。

## 四、错误处理汇总

| 场景 | 行为 |
| --- | --- |
| chat.history.read 会话不存在/跨项目 | 工具 failed + 人话消息（不落码） |
| propose_edits 文档未生成/已定稿/有未清补丁/基失配/零补丁 | 工具 ok:false + 对应人话（不落码）；ai_tool_calls 留痕 |
| 嵌套 AI 调用失败 | classifyAiError 既有归类进工具结果消息 |
| 摘要注入 SQL 失败 | catch 静默降级（该块省略），不阻断聊天主链 |

## 五、测试口径

- server vitest：`buildCrossSessionDigest`（预算截断/排除本会话/排序）；`chat.history.read`（项目守卫/limit 封顶）；`proposeEditsFromChat`（mock 产补丁→normalize→propose-pending 落库留痕；未生成/定稿/未清补丁/基失配四分支拒绝）；`normalizePatches`（锚点码命中转 modify/标题命中转 modify/未命中保持 add/modify 的 old=既有节全文）；`deriveNumbering`（大章分组/无大章退化/码入括号/s0 跳过）。
- 集成：既有 195+ 套件保持全绿；propose_edits 旁路的留痕断言=ai_tool_calls 行 + doc.propose-pending 命令审计行（旁路无 ai.tool.invoke 审计行，口径见 §二.1）。
- 实机：①资料阶段聊「客户要双人同屏」→ 需求阶段问「客户对玩法有什么要求」AI 能引用；②dock「把 CR-002 改为支持手柄」→ 工具卡 → 前往审阅 → 高亮 → 逐条/全部接受拒绝；③CRD 重新生成 → 大章+编号目录 + 导出一致。
- 门槛：双端 tsc、pnpm lint、check:deps、check-codes 零违规；差异登记（新工具×2、prompt 两段、导出编号注入）待 13 册回补。
