# Agent 体系深度优化与反思迭代 · 设计

> 2026-10-12 立项。缘起（用户原话）：「设置里 Agent 的配置做得过于简单，优秀的 Agent 不会这么简单——
> 深度优化，先打造一套优秀的 Agent 作为默认；用户使用过程中做好记录；定期根据使用情况和对话内容
> 反思并不断迭代更新这些 Agent。设置里的文件模板展示区太小，很多内容展示不全。」
>
> 勘查钉死的根事实：**ai_prompt_versions 的 prompt 内容从未注入运行时**（只把版本 id 盖戳到消息），
> 运行时真身是代码常量 stage-guides.ts——设置页 Agent 配置 100% 是摆设，两套并存一真一假。
>
> 用户拍板四决策：①**统一为一套**（设置页 Agent prompt=运行时真身，代码基底+DB 覆盖三层链，
> 与文档模板体系同构）；②**两层名册**（六阶段主 Agent+全局助手+工件子 Agent）；③子 Agent
> **工件绑定联动**（会话 doc_kind 有对应子 Agent 即叠加）；④反思**定期自动（周）+手动补触发**，
> prompt 变更一律提案制人工确认（铁纪律不破）。
> 前瞻约束（用户补充）：未来可能接 256k 级上下文模型（千问系）——prompt 装配须按窗口分档预算。

## 1. 架构：三层链 + 两层名册 + 叠加装配

**名册（7 主 + 13 子 = 20 套）**：

| 层 | agent_key | 深度 | 生效路径 |
|---|---|---|---|
| 全局 | `assistant` | 八段式全规格 | 所有会话基底之上 |
| 阶段主 ×6 | `req`/`design`/`proto`/`dev`/`test`/`material` | 八段式（600~1200 字） | 按 ai_sessions.ctx |
| 需求子 ×2 | `req.crd`/`req.prd` | 轻量四段式（300~500 字） | 会话 doc_kind 命中即叠加 |
| 设计子 ×8 | `design.hld/mod/alg/cls/db/api/ui/nfr` | 轻量四段式 | 同上 |
| 资料子 ×2 | `material.file-parse`/`material.content-ops` | 四段式 | **管道型**：供上传解析/加工作业管道调用，不进 dock 叠加 |
| 开发子 ×1 | `dev.coding-std` | 叠加区 | 现有「编码规范叠加区」收编（kind='std' 先例原位升级） |

RTM 不单列子 Agent——refines 图纪律写入 req 主 Agent 方法论段（RTM 页签 dock 会话 ctx=req 天然吃主 Agent）。
旧 `ag-*` 六员（原型口径，从未接运行时）退役：库中版本行**保留可读**不删除，设置页不再展示，运行时不引用。

**三层链**（每套 Agent 独立）：

```
代码默认基底（stage-guides.ts 重写为 DEFAULT_AGENTS 二十套全文导出）
  → ai_prompt_versions 用户版本（is_current 覆盖；schema 现成：base_prompt/overlay_text/skill_pack/kind）
    → 运行时装配（sessions.service buildSystemPrompt）
```

运行时解析：`SELECT base_prompt, overlay_text FROM ai_prompt_versions WHERE agent_key=$1 AND is_current`；
**有用户版本=base_prompt+overlay_text 拼接生效，无=代码基底**（mock 期/未配置零阻断，与现状口径一致）。
版本 id 照旧盖戳 ai_messages.prompt_version_id（主 Agent 版本 id；子叠加时逗号并入 input_fingerprint 计算，审计可溯源）。

**装配顺序**（buildSystemPrompt parts 序列）：

```
【角色与方法·主】（agent_key=ctx 解析）        ← 替代现【阶段职责与方法】
【角色与方法·子】（agent_key=`${ctx}.${doc_kind}` 命中才注入）
【当前上下文】（项目名+五阶段准入，现有不动）
【当前工件】（0029 绑定块，现有不动）
【联动提醒】（upstream-stale 派生，现有不动）
【能力边界】（代码强制，现有不动）
【可用工具】（代码强制，现有不动）
【参考资料】（现有不动）
```

**治理面不开放**：能力边界/工具声明两块永远代码常量，Agent 可编辑区只管「怎么当好角色」，
管不到「能做什么」——用户版本与反思提案都碰不到治理面（防自伤/防越权）。

## 2. 默认基底内容与上下文预算

**主 Agent 八段式骨架**（每段都是可核对指令而非口号）：①角色定位 ②职责边界（防越界抢答）
③方法论（该类任务固定打法）④工具纪律（何时用/禁用、读齐再动、禁重复读）⑤产出契约
（什么形态算完成，禁口头承诺）⑥质量自检清单 ⑦反模式（实机教训逐条入库）⑧协作联动
（上下游滞后提醒、人工确认点清单）。

**子 Agent 轻量四段式**：职责/该工件方法论/反模式/质量闸——叠加件越小，窄档裁剪越不痛。

**内容来源=已有资产归位升级，实机教训一条不丢**：
- req 主 ← 现 REQ_GUIDE 全文（核对四步走/多文档串行/重编号 rewrite/29148/模板纪律）；
- design 主 ← 现 DESIGN_GUIDE 全文（五册重写教训/42010+1016/OpenAPI/WCAG/25010 分册口径）；
- proto/dev/test/material 主 ← 现 PROTO/DEV/TEST/MATERIAL_GUIDE 同法；
- dev 主子联动 ← 旧 ag-dev 任务卡拆解口径（REQ 锚点+设计锚点+验收+DoD）；
- material 两子 ← 旧 ag-file/ag-content 解析纪律（不臆造原文/质量自检/定位补丁禁重写全文）；
- req.crd 子 ← 客户原声溯源（每条 CR 标来源 R-*）；req.prd 子 ← 验收量化（每条 REQ refines CR-*）；
- design 八册子 ← 各册模板 standard 对应标准的评审口径精要（api=OpenAPI 契约+错误码闭集、
  db=范式/索引/迁移表、hld=ADR 决策理由……）。

**上下文预算分档**（ai_models.context_window 字段现成，装配链此前从未使用——本特性启用）：
按会话解析到的模型（会话绑定优先/用途路由兜底，现成逻辑）取 context_window 分档：

| 档 | 窗口 | 口径 |
|---|---|---|
| 宽档 | ≥512k | 全量（现状即宽档行为） |
| 标准档 | 128k~512k | 主+子全量；toolLog 预算 80000→40000；doc.read 截断阈值收紧 |
| 窄档 | <128k | 主全段+子精简段（只留职责边界+反模式）；工具声明砍示例留签名行；【当前上下文】缺口文案再截短；toolLog 预算 16000 |

裁段顺序钉死：先裁示例细节→再裁方法论展开→**能力边界/工具签名/反模式永不进裁剪表**。
**反思执行器路由解耦**：新增 `reflection` 用途路由，默认挂 context_window 最大的已启用模型
（运行时聊天可用小模型，后台反思用大模型互不绑架）。

## 3. 使用记录与质量信号（反思输入，零新埋点）

全部从既有留痕派生：
1. **对话记录**：ai_messages 按会话 ctx+doc_kind 归因到每个主/子 Agent；ai_tool_calls 工具序列/成败/轮次；
2. **质量信号**：补丁采纳率（req_pendings/dsg_pendings accepted/rejected 比，经消息 prompt_version_id
   关联回当时生效版本——反思最硬的数据）；接力轮次耗尽率；夭折会话（短会话零提案零工具）；
3. **消耗**：ai_usage（A6 归因后 sessionId/messageId 已通）按 Agent 分组统计。

**唯一新表 ai_reflections**（迁移 0030）：

```sql
CREATE TABLE ai_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}',        -- 取样统计（消息数/工具数/采纳率/消耗，按 Agent 分组）
  report text NOT NULL,                     -- 反思报告全文（markdown）
  proposals jsonb NOT NULL DEFAULT '[]',    -- [{agentKey, versionNo, summary, status:'pending'|'adopted'|'rejected'}]
  model_id uuid,                            -- 实际用的反思模型
  created_at timestamptz NOT NULL DEFAULT now()
);
```

命令落审计：`ai.reflect.run`（手动触发，幂等键）、`ai.reflect.proposal.resolve`（采用/拒绝提案）。
端点：`POST /api/v1/system/reflections:run`、`GET /api/v1/system/reflections`（历史列表+报告查看）。
错误码零新增（VALIDATION_FAILED/INVALID_STATE/NOT_FOUND 闭集内）。

## 4. 反思执行器（四步流，全留痕）

**触发**：服务端调度器 setInterval 每小时查「max(ai_reflections.created_at) 距今 ≥7 天
且窗口内有新消息」→ 自动跑（进程重启自然漂移不追钟点；零新消息跳过不空跑）；
手动=设置页「🪞 立即反思」（同刻一场并发闸 INVALID_STATE，模板重排先例）。

**执行**：
1. **取样**：窗口期（默认 7 天）全项目对话按 Agent 归因分组，装配=消息摘要+工具序列+质量信号+消耗；
   超反思模型窗口预算时按组截断、统计全文保留+对话原文采样头尾（信号优先）；
2. **分析**：反思 Agent（专用系统 prompt 代码内置**不可编辑**——管 Agent 的 Agent 不开放自改防自指漂移）
   逐组产出：保持项/问题模式（反复纠正点/提案被拒集中点/工具误用）/改进建议；
3. **提案**：每个有改进点的 Agent 产**修订版全文**（非 diff——prompt 修订必须整篇可审）落
   ai_prompt_versions 新版本（is_current=false、created_by='reflection'、name 带反思场次号）；
   **零提案是合法结论**（「本期无需调整」报告照发）；ai_reflections.proposals 同步登记关联；
4. **通知**：既有 notifications 通道「🪞 反思报告：N 条 Agent 改进提案待审」。

**确认生效**：设置页 Agent 卡「反思提案」区——当前版 vs 反思版并排对照（补丁页 diff UX 口径）
+反思理由摘录；「采用」=is_current 翻转（旧版可回滚，现有版本机制天然支持）；
「拒绝」=proposals 状态翻转+版本行保留标记——**被拒历史回喂下次反思输入**（防同一建议反复提）。
**代码基底永不被反思直接改**；优质提案由开发侧评审后走正常变更纪律吸收进基底（用户智慧回流默认的通道）。

## 5. 设置页 UX

**Agent 配置区重做**：左导航两级名册树（全局助手 / 六阶段主 / 各阶段子分组缩进）；选中右侧大编辑卡——
- 生效源标签（「代码默认基底」/「用户版本 vN · 可回退基底」）；
- 「查看默认基底」只读对照抽屉（基底 vs 当前版 diff）；
- 编辑区从 180px  textarea 升 **min-height 420px + resize:vertical**（1200 字 Agent 全文可编辑）；
- 版本列表保留（设当前/改名/删除现有功能不动）+「反思提案」区（§4）；
- 全局助手卡的工具启用区/执行自检保留原位。

**模板编辑区加大**（DocTemplatesGroup）：章条 requires textarea `rows=2 → 5 + resize:vertical`
（新模板 80~160 字复合粒度 requires 在 2 行框里展不开——用户直接痛点）；章条输入区整行加宽；
其余布局不动。样式纪律：全 var() 令牌零写死色。

## 纪律与测试口径

- 错误码闭集零新增；审计失败零写；prompt 变更提案制人工确认（铁纪律）；
- console 只 warn/error；设计令牌全 var()；含中文 API 一律 node fetch；临时脚本 .tmp/ 用完即删；
- 跨域只 SQL 直读不写（反思取样读 req_pendings/dsg_pendings/ai_* 全是读）；
- **单元**：三层链解析（无版本→基底/有版本→覆盖/overlay 拼接）；上下文分档（三档边界值）；
  窄档裁段顺序（安全段保全断言）；基底八段式结构断言（二十套齐全、主含八段标记、子含四段标记）；
- **集成**（101 跑）：ai.reflect.run 手动触发全链（mock 反思模型产提案→ai_reflections 落行→
  提案版本 is_current=false）→ proposal.resolve 采用（is_current 翻转）/拒绝（状态翻转+回喂记录）；
  并发闸；调度器判定（距上次<7 天跳过/零新消息跳过）；
- **回归**：既有 306 基线全绿；阶段会话 prompt 装配回归（有用户版本前后各跑一遍会话断言注入内容）；
- 差异登记追加条目 43，待 13 册下轮基线回补（LLD-5 A08 阶段指南→Agent 三层链、LLD-4 ai_reflections 表、LLD-6 设置页 U02）。
