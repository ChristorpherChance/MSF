# 软件工厂（MSF）LLD-6 · UI 设计

> 版本：V1.0-draft · 2026-09-20 · 状态：草稿，待评审
> 上游：`PRD.md`（REQ/BR 为需求输入）、`HLD.md`（ADR-2 预览隔离、ADR-9 扩展预留）；编号规则见 `README.md`。
> **本册原则：原型即 UI 基准。** `../msf-prototype.html`（V1.11，14605 行）是全部界面事实源；真实产品 UI 以原型为准，本册只登记真实化带来的**必要差异**（§6）。原型行号以 V1.11 为准。
> 每条设计条目以 `DSG-U<章>-<序>` 编号并反向引用 REQ/BR；RTM 双向追溯见 `RTM.md`。

## 1. 设计系统（DSG-U01）

### 1.1 设计令牌（原型出处：`:root` L8-13 及各补丁 style 块 L1219/1981/2365/4908/8929/14416/14477）

**DSG-U01-1 颜色令牌表。** 承接 REQ-806（兼容性基线）、REQ-709（平台 UI 中文优先、客户工件独立令牌）。令牌名、取值、用途直接取自原型 `:root`，前端以 CSS 自定义属性落地，禁止绕过令牌写死颜色（与原型《原型 UI 设计规范》B6 ★ 同源约束）：

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ink` | `#2C2C2B` | 主文字 / toast 底色 |
| `--ink2` | `#7D7A75` | 次级文字、说明、图标弱态 |
| `--canvas` | `#FFFFFF` | 卡片、面板、顶栏底色 |
| `--soft` | `#F9F8F7` | 页面底色、hover 底 |
| `--soft2` | `#F0EFED` | 分段控件底、轨道底、弱分隔 |
| `--line` | `#E6E5E3` | 边框、分隔线 |
| `--blue` / `--blue-soft` | `#2783DE` / `#E5F2FC` | 主操作、选中态、链接、进行中、焦点环 |
| `--green` / `--green-soft` | `#46A171` / `#E8F1EC` | 成功、定稿/通过、正向确认按钮 |
| `--orange` / `--orange-soft` | `#D5803B` / `#FBEBDE` | 警告、修订中、待处理、门禁缺口 |
| `--red` / `--red-soft` | `#E56458` / `#FCE9E7` | 危险、失败、阻断、删除 |

**DSG-U01-2 形状与投影令牌。** 承接 REQ-806。`--radius: 8px`（按钮/输入 6px、卡片/面板 10-12px 为派生值）；`--shadow: 0 1px 2px rgba(0,0,0,.05), 0 4px 12px rgba(0,0,0,.04)`；弹层投影 `0 12px 40px rgba(0,0,0,.18)`（modal）/`0 8px 28px rgba(0,0,0,.14)`（popover）；助手悬浮球 `0 4px 16px rgba(39,131,222,.4)`。

**DSG-U01-3 字体与字号。** 承接 REQ-806。正文族：`-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`；代码/源码族：`Menlo, Consolas, monospace`（含 `ui-monospace, SFMono-Regular` 变体）。基准字号 14px / 行高 1.5；按钮与输入 13px；徽章 11-12px；页标题 20-24px；源码 12-12.5px。滚动条统一 8px、滑块 `#D8D6D3`。

**DSG-U01-4 令牌补丁层。** 原型以追加 `<style>` 块承载阶段样式（看板 `.kan-*` L2367、v17 开发台 L4908-4943、v19 工作台 `.v19-*` L8929/9197/9200、验收台 `.qa-*` L14416 与 `doc/acceptance-workbench.css`、V1.11 资料目录 L14477）。真实产品将这些补丁合并为按域划分的样式模块（`styles/material.css`、`styles/design.css`、`styles/dev.css`、`styles/qa.css`），**选择器与视觉值不变**，仅归并文件归属。承接 REQ-807。

### 1.2 组件库清单

**DSG-U01-5 基础组件清单（原型为基准）。** 承接：全局组件 REQ-702/703/706；资料页组件 REQ-101~115；需求页 REQ-201~210（含 REQ-206 目录同步联动、REQ-207 RTM 矩阵）；设计页 REQ-301~312；开发页 REQ-401~420；测试页 REQ-501~511（REQ-511 四页签工作台）；助手 REQ-601~608。前端按 React 组件实现，命名与类名对应如下：

| 组件 | 原型类/结构 | 关键变体 |
| --- | --- | --- |
| 按钮 Button | `button` | `primary`（蓝主操作）/`green`（定稿、通过类确认）/`danger-ghost`（删除、危险）/`ghost`（图标与弱操作）/`sm`；`disabled` 统一 `opacity:.45` |
| 输入 Input/Textarea/Select | `input[type=text], textarea, select` | 聚焦态 `border-color: --blue` + `box-shadow: 0 0 0 2px --blue-soft` |
| 卡片 Card | `.card` / `.proj-card` / `.model-card` / `.kpi` / `.ov-card` / `.imp-card` | 项目卡、KPI 卡（`.kv/.kl/.ks`）、模型卡（含 `.switch`）、总览卡 |
| 看板 Kanban | `.kan-row/.kan-col/.kan-card`（L2367）；`.v17-board/.v17-col/.v17-run` | 四列：queue 排队 / ing 进行中 / review 待评审 / done 完成；阻塞不是列——卡片带 blocked 标记与原因徽标 |
| 树/文件列表 | `.filelist/.file-row`、`.tree-item`、`.v11-folder/.v11-folder-head`（L14477） | 目录折叠/勾选/半选/全选；`.file-row.sel` 选中 |
| 表格 Table | `table.grid`、`table.data`、`.v17-table` | 行 hover `background: --soft`；`.v17-table tr.pick` 选中 |
| 页签 Tabs | `.subtabs/.subtab`（下划线蓝）、`.viewmode`（分段白底）、`.think-seg`、`.v17-viewseg`、`.v18-attention-tabs`（胶囊） | active 语义见 DSG-U01-6 |
| 弹窗 Modal | `.overlay` + `.modal`（480px）/`.modal.wide`（680px）/`.modal.wider`（780px）/`.modal.proto-modal`（min(1280px,94vw) × 92vh） | 头/体/脚三段；点遮罩或 Esc 关闭 |
| 气泡 Popover | `.popover`（z-400，锚点定位、出界翻转）、`.po-item/.po-sep/.po-head/.po-note` | 点击外部关闭；`.po-item.danger` 红字 |
| 气泡消息 Bubble | `.msg .bubble`（用户蓝底 `--blue-soft` / AI 灰底 `--soft`）、`.toolcard`、`.tasklist`、`.thinkcard`（可折叠思考卡）、`.confirm-row`、`.msg-quote` | 流式光标 `.stream-cursor` |
| Toast | `#toast-wrap` 顶部居中（z-500），默认深灰 / `.success` 绿 / `.warn` 橙 | 2.4s 自动消失 |
| 徽章 Tag/Badge | `.tag`（blue/green/orange/red/gray）、`.badge-chip`（顶栏胶囊）、`.reqchip`、`.gap-chip`、`.ctx-chip` | 状态色与 DSG-U01-1 语义一一对应 |
| 横幅 Banner | `.banner.info/.warn/.ok`、`.banner.gate`（可换行 + `.gap-chip` 缺口链） | 门禁横幅常驻内容区顶部 |
| 进度 | `.prog`（4px 蓝条）、`.gauge`（8px）、`.usage-bar` | 颜色随状态：进行中蓝/失败红/完成绿 |
| 开关 Switch | `.switch`（36×20，`.on` 绿） | 模型启停、工具开关 |
| 其他 | `.checkline`（勾选项）、`.sevdot`（严重度圆点）、`.pipe-step`、`.rtm-chain/.rtm-node`（r/cr/req/dsg 四色追溯节点）、`.kpi-row`、`.set-nav` | RTM 节点四色：R 蓝 / CR 绿 / REQ 橙 / DSG 紫（`#F1EBFA/#6B4FA3`） |

**DSG-U01-6 选中态规范（蓝色选中）。** 承接 REQ-806。全局选中态统一蓝系，五种形态按容器区分：① 列表行 `.file-row.sel` / `.tree-item.active` = `--blue-soft` 底 + 左侧 3px 内阴影条 `inset 3px 0 0 --blue`；② 下划线页签 `.subtab.active` = 蓝字加粗 + 2px 蓝底边；③ 分段控件 `.stage-pill.active`/`.viewmode .active`/`.think-seg .active` = 白底 + `--shadow`；④ 设置导航 `.sn-item.active` = `--blue-soft` 底 + 蓝字；⑤ 表格选中行 `.v17-table tr.pick` = `--blue-soft` 底。禁止用绿/橙表达"选中"，绿=成功/定稿、橙=待处理、红=危险的语义不可挪用。

## 2. 全局框架（DSG-U02）

**DSG-U02-1 应用骨架。** 承接 REQ-702、REQ-806。`#app` 为 100vh 纵向 flex：顶栏（52px）+ 主区 `.main`（横向 flex，`.view` 自适应 + 可选助手 dock）。`body{overflow:hidden}`，滚动只发生在各面板内部（`.doc-scroll`/`.filelist`/`.chat-msgs` 等）。原型出处：`render()` L2013、`topbarHtml()` L2033。

**DSG-U02-2 顶栏与五阶段导航。** 承接 REQ-702（阶段导航与准入）、REQ-703（通知中心）。左到右：Logo「🏭 软件工厂」（点击回项目列表）→ 项目切换 chip（`badge-chip`，在项目内出现）→ 五阶段 pill 组 `.stage-nav`（① 资料 ② 需求 ③ 设计 ④ 开发 ⑤ 测试）→ 弹性占位 → ⚡ Task/编排 → 🤝 委派 → 💰 本月成本（popover 明细）→ 🔗 RTM 健康度（项目内）→ 🔔 通知中心（未读红点计数；点击开**右侧抽屉**：通知列表 + 全部已读 + 跳转定位，本期仅站内通知，webhook 列后续扩展）→ ⚙️ 设置。阶段准入：阶段 pill **永远可点击**（原型 `.stage-pill` 无锁定态——`.stage-pill.locked` 为从未生效的死 CSS，此前「未达标置灰」系本册虚构描述，差异登记见 §6-DSG-U06-21）；不满足门禁时 pill 照常进入目标页，缺口明细由页内门禁横幅（`.banner.gate` + `gap-chip`）承接明示。原型出处：`topbarHtml()` L2033-2059。

**DSG-U02-3 三栏工作模式。** 承接 REQ-101/201/301。阶段页统一为「左栏 `panel-left`（288px，开发 238-248px）+ 中央 `.doc-area`（工具栏 `.doc-toolbar` + 可选横幅 + 滚动区 `.doc-scroll` 内嵌 `doc-paper` 760-820px 纸面）+ 右侧助手 dock」。需求/设计文档页在左栏与中央之间另有目录栏 `.toc-col`（216px，章节联动定位，`bindTocSync` L784）。资料内容解析页中央右侧有操作栏 `.ops-col`（52-64px 图标列）+ 可展开操作面板 `.ops-panel`（236-264px）。原型出处：`viewMaterial` L2114、`docStageHtml` L576、`designDocsHtml` L3367、`opsColHtml` L2312。

**DSG-U02-4 全局 AI 助手 dock（F1）。** 承接 REQ-601/602/603/604/612。结构（`chatDockHtml` L1021 / `chatDockInner` L1025）：头部三行（上下文 chip + 新建/菜单/收拢；历史会话下拉 + 思考强度三档 低/中/高；用量条 `usage-bar` + 百分比）→ 消息流（欢迎卡 `.welcome` 阶段感知示例、用户/AI 气泡、工具卡、任务卡、思考卡、待确认行动按钮、耗时行）→ 可选引用块 `.quote-block`（拖选段落生成，`mouseup` 监听 L4673）→ 流式控制条（暂停/继续/停止）→ 输入区（textarea + 模型选择 + 发送）。阶段页内嵌 dock（宽 `S.chatW` 默认 380px，拖拽 300-620px，`bindResizer` L1208）；非阶段页（项目/任务/委派/设置/RTM）以右下角悬浮球 `.chat-fab` + 固定抽屉 `.chat-gwrap` 呈现。RTM 页签不内嵌 dock（`hasDock()` L1090-1093）。F1 开合；收拢态为悬浮球。**实现注（REQ-615 扩展）**：消息流列表/流式渲染以 pi-web-ui 的 Lit 聊天 Web Components 为**参考实现/浅 fork**（其版本滞后 0.75.3 vs pi-* 主线 0.86.0、依赖重；fork 后裁剪依赖，维护责任归平台），外观按 §1 设计令牌定制（颜色/圆角/投影/字号）；交互结构（头部三行、引用块、流式控制条、输入区）与原型一致，不随组件复用改变。

**DSG-U02-5 弹层层叠与关闭规则。** 承接 REQ-806。z-index 层级：顶栏 50 < 全局助手抽屉 150 < 助手悬浮球 200 < modal 遮罩 300 < popover 400 < toast 500。规则：modal 单实例（`#modal-root` 替换式），点遮罩/Esc 关闭；popover 单实例（`#popover-root`），锚点定位、底部出界自动翻转、点击外部关闭；Esc 优先关闭 modal/popover（`keydown` L4701-4708）；toast 顶部居中堆叠、2.4s 自动消退、不阻塞操作（`pointer-events:none`）。原型出处：`modal/popover` L541-557。

**DSG-U02-6 键盘快捷键表。** 承接 REQ-601、REQ-806。

| 快捷键 | 作用域 | 行为 | 原型出处 |
| --- | --- | --- | --- |
| F1 | 全局 | 开合 AI 助手（阶段页=dock 收拢/展开；非阶段页=悬浮抽屉开合） | L4703-4707 |
| Esc | 全局 | 关闭最上层 modal / popover | L4702 |
| Enter | 助手输入框 | 发送消息 | L1085 |
| Shift+Enter | 助手输入框 | 换行 | L1085 |
| Enter | 开发计划左栏搜索框 | 执行筛选 | L5038 |
| 鼠标拖选 | 主内容区 `.doc-scroll .md` / `.html-src` | 生成段落引用块（≥3 字符；流式中禁用；排除会话气泡） | L4673-4690 |

**DSG-U02-7 全局渲染与状态边界。** 承接 BR-05、BR-14。原型 `render()` 全量重绘 + 会话态单例 `S`；真实产品 SPA 以 Zustand 持有会话态（路由、选中项、草稿、UI 开合），领域真相在服务端（HLD ADR-2）。UI 规则保留：流式进行中冻结上下文 chip 切换（防串台）；`#chat-msgs` 滚动位置/贴底态跨重绘恢复（原型 `chatScrollRestore` L1137）；未保存编辑离开守卫（`v11Guard` 弹「继续编辑 / 放弃并继续 / 保存并继续」三选，L14573）。SSE 断线时输入区不丢草稿，重连后接续渲染（差异见 §6）。

## 3. 页面清单与逐页规格（DSG-U03）

> 路由表（`render()` L2018-2028）：`projects` / `stage-material` / `stage-req` / `stage-design` / `stage-dev` / `stage-test` / `tasks` / `delegate` / `settings`。共 9 个一级页面，其中 5 个阶段页含子页签。每页给出：目的 / 布局 / 组件树要点 / 关键交互 / 五态（正常·加载·空·异常·权限）/ 响应式 / 承接 REQ / 原型出处。
> **权限态统一说明（REQ-707）**：本期本地单工程师身份，全部操作可用；架构预留的权限受限入口以 disabled + 说明提示呈现（见 §6-D6），各页不再重复列出。

### 3.1 DSG-U03-1 项目列表页（route: projects）

- **目的**：项目总览与入口；新建/编辑/归档项目。承接 REQ-701。
- **布局**：`.full-wrap` 滚动容器 + `.full-inner`（max-width 1080px 居中）：标题行（「项目」+「＋ 新建项目」primary）+ 副标题 + 项目卡网格 `.proj-grid`（`repeat(auto-fill,minmax(310-320px,1fr))`）。
- **组件树**：`proj-card`（图标 + 名称 + 阶段 tag + 创建信息 + 描述 + 五段进度条 `.proj-stagebar` + 本月成本 + 编辑/打开按钮）；新建卡（虚线 `.newcard`）；`projModal`（新建/编辑弹窗，含归档入口）；归档二次确认 modal。
- **关键交互**：点卡打开项目并按 `stage` 字段落到对应阶段（`openProject` L5204：stage=3 时落设计-原型 UI 子页签）；离开项目清理开发任务进度模拟定时器（原型源码注释称「delegate 心跳」，实为开发看板 agent 任务的进度模拟机制——与委派页/REQ-610 委派无关；真实产品进度由 SSE 承接，见 §6-D3/D13，无此定时器；生命周期闭环）。
- **状态**：正常=卡片网格；空=仅新建卡；加载=骨架卡（真实化新增，见 §6-D2）；异常=项目加载失败行内提示 + 重试。
- **响应式**：网格随宽度自动换列；1280 下约 3 列。
- **原型出处**：`viewProjects` L2075、`projModal` L2089。

### 3.2 DSG-U03-2 资料页（route: stage-material；子页签：文件解析 / 内容解析）

- **目的**：项目资料库两个工作面——文件解析（原件→Markdown 解析稿）与内容解析（加工→内容定稿）。承接 REQ-101~115。
- **布局**：顶部 `.subtabs`（📥 文件解析 / 🛠 内容解析）+ 三栏（左目录树 + 中央文档区 + 右助手 dock）；内容解析面另有 `.ops-col` 操作列。原型出处：`viewMaterial` L2114；V1.11 左栏重构 `matFileHtml` 覆盖 L14508/L14552/L14582。
- **文件解析面组件树**：上传区（`.upload-zone`，点击/拖拽 + 隐藏 `input[type=file][multiple]`，ZIP 上传后行内「解压」）→「📁 原始文件 · 待解析」目录树（折叠/勾选/半选/全选/仅待解析过滤；ZIP 包行内解压为同名文件夹、原包保留可下载）→「批量解析（已选 n）」→「📁 解析文件 · Markdown」树（逐行定稿勾选 + 批量定稿 + 删除解析稿不删原件）→ 中央工具栏（状态 tag + 预览/编辑/源码三态 `.viewmode` + 重新解析/下载/✓ 文件解析定稿）+ `doc-paper` 正文（`.md` 渲染 / `.md-editor` / `pre.md-src`）。
- **内容解析面组件树**：左栏「解析文件」列表（主稿 + 缩进 `↳` 加工结果行，可展开收拢；行首复选框）+ 批量加工/批量内容定稿按钮 → 中央工具栏（预览/编辑/源码三态 + 下载 + ✓ 内容解析定稿）+ 附件列表 → 右操作列：翻译 🌐 / 建索引 🗂️ / 脱敏 🕶️ / 术语查询 📖 / 附件 📎（`.opbtn` 图标 + 展开 `.ops-panel` 表单）。
- **关键交互**：解析状态机 `pending→parsing→parsed/failed` 行内进度条与失败原因（needsOcr 带页码、encrypted 拦截并提示解除密码）；失败可重试；文件定稿 `finalFile` 后进入内容面；内容定稿 `finalContent` 后成为需求默认参考；三态编辑器未保存离开守卫 `v11Guard`（L14573）；批量加工作业前后基线快照比对、期间源变化拒绝提交（`basis()` / REQ-111）；批量定稿强制人工逐条确认弹窗（`v11BulkContentFinal` L14562）；删除双向同步确认（原文件+解析稿+引用勾选一并移除，`delFile` L2263）。
- **状态**：正常=双树 + 纸面；加载=行内进度条 + 左栏「解析中…」禁用批量按钮；空=`doc-empty` 引导（「左侧上传并解析文件…」）；异常=解析失败行红字 + 重试按钮；ZIP 校验失败整包拒绝 toast（不产半截数据，REQ-103）。
- **响应式**：≤760px 时三栏转纵向堆叠（左栏限高 45vh），见 L14477 媒体查询；1280/1440/1920 下纸面 max-width 820px 居中。
- **原型出处**：`viewMaterial` L2114、`matFileHtml` L2121+V1.11 覆盖 L14508、`matContentHtml` L2289+L14533/L14554/L14583、`MaterialZip.read` L14483、`v11Parse` L14522、`opsColHtml` L2312。

### 3.3 DSG-U03-3 需求页（route: stage-req；子页签：CRD / PRD / RTM）

- **目的**：客户需求文档（CRD）、产品需求文档（PRD）、需求追踪矩阵（RTM）三工作面。承接 REQ-201~210。
- **布局**：`.subtabs` 三页签（📝 CRD / 📦 PRD / 🔗 RTM）；CRD/PRD 面 = 目录栏 + 文档区 + 助手 dock；RTM 面 = 整页（无 dock）。原型出处：`viewReq` L563、`docStageHtml` L576、`rtmHtml` L861。
- **CRD/PRD 组件树**：工具栏（状态 tag「已定稿 vX / vX 修订中」+ 版本下拉 + 📚 参考资料 popover ｜ ↩↪ + ⬇ 下载 + ⬆ 版本提交 + 🔄 重新生成 + ✓ 定稿/已定稿 + ⋯ 菜单 ｜ 三态切换 `.viewmode`（预览/编辑/Markdown 源码，置于工具栏末尾）——与设计页工具栏完全同构）→ 可选横幅（定稿 ok / 待确认补丁 warn / 已修改未提交 info）→ 纸面（`h1` 标题 + 状态 tag + 章节 `section.sect`，待确认补丁高亮 `.pending-add/mod/del` + 行内 ✓接受/✕拒绝 `.pending-bar`）。
- **RTM 组件树**：KPI 行（L0a R→CR 承接率 ≥0.95 / L0b CR→REQ 承接率 =1 / L0c REQ→DSG 锚点覆盖率 =1（开发入口门禁指标；缺口 REQ 行内带「标记 deferred」操作钮，已 deferred 的带撤销钮）/ L0d deferred 计数（信息性指标，不进入任何门禁公式）/ 节点统计 / 未覆盖计数）→ 追溯链明细表（R/CR/REQ/DSG 四色 `rtm-node` + 状态 + 追溯弹窗）→ DSG 设计层节点卡（8 个：h/o/g/k/d/a/u/n + 登记状态）→ 门禁规则卡。
- **关键交互**：AI 流式生成（目录先行 → 章节 Task 实时卡 → 版本入库）；参考资料 popover 仅列**内容已定稿** Markdown，失效引用红字 + 移除入口（`v11RequirementInputs` L14597、`refPopover` 覆盖 L14598）；生成期间参考基线变化则拒绝提交（`commitGeneratedVersion` 覆盖 L14602，REQ-115）；PRD 生成门禁=CRD 已定稿；定稿弹窗展示 RTM 门禁校验结果；解锁/版本时间线/分享在 ⋯ 菜单；目录与正文滚动联动、点击跳转 + 闪高亮；未覆盖 REQ 可标记/撤销 deferred（记审计，modal 确认；deferred 条目不进入 L0a/L0b/L0c 分母，以 L0d 单独计数展示，不进入任何门禁公式）；任务卡 REQ 锚点跳入 RTM 行高亮（`devJumpRtm`）；需求页「上传补充 .md（仅本阶段）」入口**不豁免 REQ-114**——上传件先落入资料库走解析与内容定稿路径，定稿后才出现在参考资料清单（无旁路）。
- **状态**：正常=文档三态；加载=`genState:'running'` 时生成按钮禁用「⚡ 生成中…」+ 助手侧流式；空=`doc-empty` 引导（PRD 空态按 CRD 是否定稿分文案）；异常=生成失败 toast + 保留草稿；权限=历史版本只读（已定稿禁用编辑控件）。
- **响应式**：目录栏固定 216px；纸面 820px 居中；1280 下目录栏可保持，纸面自适应。
- **原型出处**：`viewReq` L563、`genDoc` L664、`switchVer/commitVer/finalizeDoc` L684/705/714、`acceptPend/rejectPend` L759/769、`bindTocSync` L784、`rtmHtml/rtmL0c` L861/825。

### 3.4 DSG-U03-4 设计页（route: stage-design；子页签：概要设计 / 详细设计 / 原型 UI / 自检评审）

- **目的**：HLD 一册 + LLD 七册文档管理，原型 UI 的识别/生成/检查/定稿，设计评审项闭环。承接 REQ-301~312。
- **布局**：`.subtabs` 四页签（📐 概要 / 📋 详细 / 🖼️ 原型 UI / 🧪 自检评审[未决计数]）；文档面复用需求页三栏（左分册列表 + 目录栏 + 文档区 + dock）。原型出处：`viewDesign` L3350、`designDocsHtml` L3367。
- **文档面组件树**：左栏分册行（图标 + 名称 + 版本/状态 + tag 未生成/修订中/已定稿；详细组 7 册平铺 `DETAIL_FACETS`）；工具栏、横幅、三态、待确认补丁、版本体系与需求页同构（`switchDesignVer/designUndo/commitDesignVer/finalDesign`）；生成门禁：概要消费 PRD 定稿、详细消费概要定稿；定稿遇未决评审项弹二次确认（仍要定稿记审计）。
- **原型 UI 子页签组件树**（V19 工作台，`protoMainHtml` 覆盖 L9169）：左栏「客户原型范围」页面清单（页 ID + 标题，`designSelectPrototypePage`）→ 命令条 `.v19-command`（状态 tag + ① AI 识别规划 → ② 生成完整原型 → ③ 对应性检查 → ④ 人工定稿 + 导出基线，逐步门禁 `designPrototypeGate`）→ 三 KPI（当前结论 / 需关注 / 下一步）→ 预览区（状态切换按钮条 `.v19-statebar` + 隔离 iframe，postMessage 选页选态）→ 问题列表 `.v19-issues`（逐条 code + message）→ 追溯 details（需求覆盖 / 非 UI 承接 / 页面双向来源）→ 基线横幅。页面级组件：设计目录（页面/流程/状态/控件/字段/角色/视口，源自 `V19_DESIGN_CATALOG` L5552）。
- **自检评审组件树**：工具栏（未决/已解决 tag + 规则说明 + 🔁 重新自检评审）→ 分组表 `.grp-row`（概要规则 / 详细规则 / 原型规则 proto-lint 20 条）：编号/级别 `.sevdot`/工件/问题/状态/操作（标记已解决/重新打开）。
- **关键交互**：定稿登记 DSG-* 节点（RTM REQ→DSG implements）；原型四步流水（识别→生成→检查→定稿）各步按钮按门禁启停；检查问题含「未验证/需人工」不静默忽略（REQ-306）；必需页面/流程/状态缺失或关键冲突阻断定稿（REQ-308）；再定稿触发影响分析（`impactTrigger`）；基线导出。
- **状态**：正常/加载（`.banner role=status` 显示「正在识别/生成/检查…」）/空（「尚未生成客户原型」+ 生成与上传双入口；V1.3 上传通道 modal：参考样本 or 初稿入库）/异常（检查未过=问题列表 + 阻断定稿按钮置灰）/权限（已定稿只读）。
- **响应式**：≤1100px 时 `.v19-overview` 三列转一列、命令条允许换行（L8931）。
- **原型出处**：`protoMainHtml` L4424（V1.3 版）/L9169（V19 覆盖版）、`designPlanPrototype / designGeneratePrototype / designCheckPrototype / designFinalizePrototypeBaseline` L8962 区、`designSelectPrototypePage` L14391、`designReviewHtml` L3557。

### 3.5 DSG-U03-5 开发页（route: stage-dev；顶页签：任务与计划 / 开发执行 / 开发自测 / 变更管理；含开发自测报告页）

- **目的**：任务识别与计划、看板执行、质量证据与集成构建、变更影响处置；autopilot 自动主线停在「待人工转测试」。承接 REQ-401~420。
- **布局**：顶部四页签（`viewDev` L5019，V1.7+ 覆盖旧八页左栏为「顶页签 + 左栏工作区」两层导航：plan=业务模块/需求树 + 搜索；execute=任务看板/代码仓/编码规范；quality=自测结论/单元测试/PR 评审/集成与构建/项目自测报告；change=影响处置/输入基线/计划与审计）+ 左栏 `.v17-side`（238px）+ 中央内容区 + dock。项目无计划时整页空态（`devProjectOk` 拦截）。
- **任务与计划组件树**：命令条 `.v18-command`（准备计划 / 批准并自动执行 / 按状态切换为 查看自动执行·查看失败并返工·确认转测试 等主按钮 + 展开手动操作）→ 批准摘要 `.v18-prep`（六指标格 + 自动/人工范围 tag + 逐条建议卡 `v18-proposal`：查看/修订/不采用）→ 注意项页签 `.v18-attention-tabs`（**需你处理** / AI 可处理 / 全部任务）→ 手动操作条（识别任务/核对覆盖/完善任务/编排计划/提交版本/批准计划）→ 计划表三视图（业务功能/前后端分工/执行顺序 `.v17-viewseg`）；任务详情 = 中央表单（规格全字段 + 质量场景正常/边界/异常 + 行/分支覆盖率门槛 + 问题横幅；排队中可编辑、运行/评审/合并须先返工）。
- **开发执行组件树**：四列看板 `.v17-board`（📥 queue 排队 / ⚙️ ing 进行中 / 👀 review 待评审 / ✅ done 完成；**阻塞不是列**——卡片以 blocked 标记 + 原因徽标呈现），卡片含 kind tag、批次、承接人 👤/🤖（human/agent）、依赖、进度条、行内按钮（开始/暂停/继续/停止/提交评审/查看 PR）；代码仓 = 文件树 `.tree-item` + 深色代码视图 `.code-view` + diff 行（`.diff-add/.diff-del`）；编码规范 = 系统默认只读 + 自定义叠加版本（与设置页同源）。
- **开发自测组件树**（R-04-3：原「质量验收」措辞以原型 `viewDev` L9036 最终覆盖版「开发自测」为准回销）：质量目标表（测试对象/场景/门槛/规格完整度）→ 单元测试表（目标 vs 实际行/分支、unit/PR CI 证据状态 tag、证据版本 runId+commitId）→ PR 评审（checks checklist：验收条件+编码规范符合+与设计一致）→ 集成构建（候选构建 + 独立 UI 工件，内容指纹可复核）→ **项目自测报告页**（`v19SelftestHtml` L9188）：工具栏（运行自测/关联复测/导出报告）+ 三 KPI（当前结论/需关注/下一步）+ 四门卡 `.v19-selftest-card`（功能检查/联调与冒烟/UI 符合度/开发审核——对应 `gates` 键 functional/integration/ui/review，对齐原型 L14396 显示名；通过/阻断）+ 逐页×视口通过矩阵（点击视口开双侧对照，见 §4）。
- **变更管理组件树**：影响处置列表（`.imp-card` 待评估/待返工）、输入基线卡（有效/失效 + 重确认入口）、计划与审计历史（`.v17-history` 只读时间线）。
- **关键交互**：全部写操作经命令事务（按钮点击 → 门禁求值 → toast/行内错误列示 `devIssueText`）；autopilot「批准并自动执行」；暂停/停止/接管（仅影响当前运行拥有的操作）；开始按钮门禁 disabled + title 列原因；识别建议过期标 stale 不可采纳；合并依据四类之一必选；自测未过 → 失败进「需你处理」+ 复测需实质返工（否则 RETEST_WITHOUT_CHANGE）；转测试按钮仅当前有效合格报告可用。
- **状态**：正常/加载（操作按钮 spinning + SSE 进度，见 §6-D3）/空（无计划空态「此项目尚未建立开发计划」+ 返回项目列表）/异常（门禁问题横幅 `devGateIssuesHtml` 分组计数 + 点击跳转定位；构建/自测失败红 tag + 定位链接）/权限（其他项目数据不展示：单一项目工作台，`PROJECT_SCOPE` 拦截）。
- **响应式**：≤1350px 汇总格 5→3 列、详情表单 2→1 列（L4942）；看板 `min-width:900px` 横向滚动。
- **原型出处**：`viewDev` L5019、`devPlanHtml` L5077、`devBoardHtml` L5175、`devTaskDetailHtml` L5109、`v19SelftestHtml` L9188、`devQualityHtml/devChangeHtml` L5207/L5251、`selftestHtml`（旧版 L9039）。

### 3.6 DSG-U03-6 测试验收页（route: stage-test；四页签工作台）

- **目的**：批次接收 → 测试计划 → 用例执行 → 缺陷回归 → 报告与交付决定的独立验收工作台。承接 REQ-501~511。
- **布局**：`.subtabs` 四页签（提测与计划 / 用例与执行 / 缺陷与回归 / 报告与交付）+ 整页工作台 `.qa-workbench`：头部（阶段眉标 + 主标题 + 环境 tag）→ 批次条 `.qa-batchbar`（当前批次下拉 + 环境 + 接收新交接）→ 内容区 `.qa-content`（`.qa-sheet` 白卡）→ 页脚说明。原型出处：`viewTest` V19 覆盖 L14473、样式 `doc/acceptance-workbench.css`；旧版四页签（测试计划/用例执行/缺陷跟踪/测试报告，`viewTest` L4287）被 V19 验收工作台**整体覆盖**，真实产品以 V19 版为基准。
- **组件树**：提测与计划 = 批次事实表 `.qa-facts`（候选构建/开发自测/设计基线/环境/接收人/接收时间）+ 导出交接快照 + 计划起草/确认范围卡（逐用例行：AT 编号 + 标题 + 人工验证/自动 tag）；用例与执行 = 执行按钮 + 用例行 `.qa-case`（证据摘要 + 结果 tag）+ 人工走查记录 modal（证据 textarea + 结论下拉，人工结论不得代填）；缺陷与回归 = 失败登记行 + 缺陷卡（状态流转按钮按缺陷五态状态机 new→confirmed→fixing→pending_regression→closed：确认与定级（new→confirmed，严重度 P0~P3）→ 前往开发返工（confirmed→fixing）→ 关联新构建回归证据（fixing→pending_regression，仅开发侧可标记待回归）→ 测试侧人工确认关闭（pending_regression→closed）；回归失败产生 reopened 事件、缺陷回到 confirmed——重开是事件不是状态）；报告与交付 = 汇总报告 + 结论横幅 + 人工定稿报告 / 确认本批交付 / 导出按钮组。
- **关键交互**：接收幂等（重复接收不产生重复批次，按交接指纹归并）；批次不可变快照（新构建=新批次，批次下拉可切换历史批次只读查看）；计划批准后才可执行；结果枚举 pass/fail/blocked/not-run/not-applicable，「不适用≠通过」在 UI 上以独立 tag 区分且不计入通过；缺陷只能从本批实际失败记录创建；关闭必须测试侧人工且需当前新构建回归证据（`regressionEvidence`）；报告指纹过期（执行或缺陷已变化）→ 定稿/放行按钮置灰 + 横幅提示重新汇总；放行仅可豁免明确列举的中低等级问题（P0/P1、必测未执行、证据失真不可豁免，按钮禁用 + 原因）。
- **状态**：正常/加载（执行中按钮禁用 + 行内进度）/空（`qa-empty`：「等待开发交付一份可测试的候选」+ 接收按钮按交接存在与否启停）/异常（构建指纹不一致拒绝接收 toast；报告 basis 变化阻断）/权限（同统一说明）。
- **响应式**：≤700px 头部/批次条/内容区收窄、事实表 2→1 列（acceptance-workbench.css 媒体查询）。
- **原型出处**：`viewTest` L14473、`acceptanceReceive/DraftPlan/ApprovePlan/Run/Manual/GenerateReport/FinalizeReport/Release` L14429-14457、`defectsHtml` L14468。

### 3.7 DSG-U03-7 任务中心页（route: tasks）

- **目的**：跨阶段 Task 汇总与事件流。承接 REQ-704、REQ-703（事件流部分）。
- **布局**：`full-wrap` + `full-inner`：标题 + 副标题 → KPI 行（累计 Task / 进行中 / 完成率 / 事件数）→ Task 列表卡（表格：所属文档/章节/目标/状态 tag/进度条/会话跳转/时间）→ 事件流卡（时间 + 类型 tag + 文本，append-only）。
- **关键交互**：会话列按钮 `jumpSession` 跳回对应阶段并打开该会话（proto 会话落设计-原型 UI 子页签）；状态机展示 排队→进行中→完成/失败。
- **状态**：正常/空（无任务时空表 + 说明）/加载（真实化为 SSE 增量刷新，不整页重载）。
- **响应式**：表格横向滚动；KPI `auto-fit` 换行。
- **原型出处**：`viewTasks` L1706、`jumpSession` L1726。

### 3.8 DSG-U03-8 委派页（route: delegate）

- **目的**：外部 Agent 执行目标注册表 + 委派记录与审计。承接 REQ-610。
- **布局**：`full-inner`：标题 + 副标题（能力路由 / 预算最低优先 / 不静默降级 / 回落 pi_native）→ Target 注册表卡（`.model-card` 行：图标 + 名称 + 可用性 tag + 描述/延迟 + capability tags + 测试/发起委派按钮 + 「＋ 注册 target」）→ 委派记录表（target/任务/状态五态 tag/耗时/成本/时间/工具卡按钮）→ 失败语义卡（五态枚举 tag 陈列 + 审计说明）。
- **关键交互**：「＋ 注册 target」打开**注册向导 modal**——字段：名称、类型（适配器类型，如 `claude_code_local` / `codex_cli`）、端点（连接地址或本机启动方式）、凭据引用（引用设置中已存凭据，不内嵌明文）；保存前可「测试连通」，失败不入册；发起委派 modal（任务描述 + 预算上限）；工具卡 modal（入参/执行/审计摘要 + 失败时降级选项按钮「用 pi_native 重跑」，不静默降级需确认）；未配置 target 的委派按钮置灰；同一项目并发委派上限默认 2（可配置），超限在发起时提示。
- **状态**：正常/加载（委派执行中行内「执行中」蓝 tag，完成/超时由 SSE 或轮询更新）/空（无记录空表）/异常（五态红/橙 tag + 工具卡详情）。
- **响应式**：标准 full 页，卡片纵向堆叠。
- **原型出处**：`viewDelegate` L1737、`newDelegation/doDelegate/deleDetail` L1756-1769。

### 3.9 DSG-U03-9 设置页（route: settings）

- **目的**：Agent 配置（含全局助手）、模型配置、系统设置。承接 REQ-705、REQ-609、REQ-611、REQ-604。
- **布局**：`full-inner` + `.set-layout`：左设置导航 `.set-nav`（200px sticky：🤖 Agent 配置[下挂全局 AI 助手 + 各子 Agent 子项] / 🧩 模型配置 / 🛂 放行策略 / 🧾 审计 / 💾 备份 / ⚙️ 系统设置）+ 右 `.set-body` 卡片区。
- **组件树**：Agent 卡 = 系统默认 Prompt 只读开关 + 自定义 Prompt 版本列表 `.pver-row`（当前生效蓝框 + 设为生效/重命名/删除，生效版不可删）+ 新版本编辑区（另存/另存并设为生效）+ 开发 Agent 专属「编码规范」叠加区（同机制）+ 执行自检卡；全局助手卡 = 基底 Prompt（只读）/ 叠加版本 / 工具开关清单（`.switch` 逐个启停，停用后决策插槽不再派发）/ 默认思考强度三档 / 当前上下文叠加提示（只读）/ 执行自检；模型卡 = 模型列表（连通状态 tag 已连通/失败/未测试/测试中 + 对话默认 + 思考强度支持标记 + 窗口 tokens + 测试连通/编辑/启停开关 + 添加模型 modal）；**放行策略卡** = 七个确认点（`req.doc.finalize` / `design.prototype.finalize` / `dev.plan.approve` / `dev.transfer` / `test.plan.approve` / `test.report.finalize` / `test.release`）逐点 manual/auto 开关 + 前置条件编辑 + 最近切换留痕（切换本身为 manual 命令并通知项目成员）；**审计卡** = 审计日志只读查询（项目/操作者/命令筛选 + 游标翻页，哈希链标识，无修改/删除入口）；**备份卡** = 备份导出（范围选择 + 触发导出 + 历史下载链接，含 SHA-256 清单说明）；系统卡 = 临时区保留时长 / pending 自动回收 / 导出默认格式 + 治理复选组（含「RBAC 角色权限（预留挂载点，本期不启用）」）。
- **关键交互**：Prompt 版本切换 toast「下次会话启动生效」；模型编辑后连通状态回退「未测试」；密钥字段掩码展示（真实化：密文存储、不回显明文，见 §6-D5）。
- **状态**：正常/加载（连通测试中蓝 tag）/空（「暂无自定义版本」`.empty-tip`）/异常（连接失败红 tag + 原因 toast）。
- **响应式**：≤1100px 左右改上下堆叠（导航不再 sticky）。
- **原型出处**：`viewSettings` L1780、`setAgentsHtml/setGlobalAssistantHtml/setModelsHtml/setSystemHtml` L1793/1870/1924/1964。

## 4. 原型 / 工件预览（DSG-U04）

**DSG-U04-1 隔离 iframe 预览。** 承接 REQ-307、REQ-803、HLD ADR-2/§6（预览隔离）。客户原型与构建工件 HTML 一律视为不可信内容：真实产品中工件存对象存储、经 **sandboxed iframe + 独立子域 + CSP** 渲染（`sandbox="allow-scripts"`，禁同源会话访问；原型用 `srcdoc`，真实产品改签名 URL 经 iframe `src` 加载，见 §6-D4）。预览入口：设计-原型 UI 子页签内嵌预览区（`data-testid="prototype-preview"`）+ 旧版预览弹窗（`.proto-modal` 94vw×92vh，保留为大图查看入口）。

**DSG-U04-2 页面 / 状态 / 视口切换。** 承接 REQ-307。预览与检查共用同一份业务 DOM：左栏选页面、`.v19-statebar` 选状态，宿主经 `postMessage({type:'v19-prototype-select',pageId,stateId})` 指令 iframe 内切换既有页态（不重新生成 DOM）；视口由外层容器宽度与工件自适应承载。切换仅局部刷新左栏/状态条/问题区（`designSelectPrototypePage` L14391），不重载 iframe。

**DSG-U04-3 自测双侧对照弹窗。** 承接 REQ-415、BR-11（两侧不得渲染同一对象）。`devOpenUiComparison`（L9181）：wide modal 内左右双 pane（左=批准原型、右=当前实现），各自独立 iframe 加载各自指纹对应的工件（摘要行展示原型/实现指纹 + 本视口通过/阻断 tag）；顶部状态页签（已通过/待处理）切换时两侧同步选态；底部「差异与检查依据」列未通过检查项。视口宽度按 `viewportProfiles` 设定（如 mobile 390px / desktop 1180px），pane 内横向滚动。

**DSG-U04-4 预览内容与多语言。** 承接 REQ-709。客户工件按目录生成多语言内容（`data-i18n` 法/英双语 span，原型出处 `v19CustomerPrototypeHTML` L9324 区），平台 UI 自身中文优先。预览不改变工件内容指纹——切换语言/页态只读运行时状态。

## 5. 响应式与视口（DSG-U05）

**DSG-U05-1 桌面三档视口。** 承接 REQ-806。验收视口 1280 / 1440 / 1920：顶栏不折行（项目名 `.crumb` 省略号）、五阶段 pill 完整；左栏 288/248/238px 固定、目录栏 216px 固定，中央纸面 max-width 760-820px 居中、随窗宽缩放边距；看板/计划表设 min-width 并横向滚动（不出横向滚动条到 body）。原型内含断点参考：≤1350px（v17 汇总格 5→3、详情 2→1）、≤1200px（v18 指标格 6→3、建议卡 2→1）、≤1100px（v19 概览三列→一列、对照双栏→单栏、注意项行→单列）、≤760px（资料三栏→纵向堆叠）。

**DSG-U05-2 助手开合布局规则。** 承接 REQ-601、REQ-806。dock 展开：阶段页中央区宽度 = 视口 − 左栏 − dock（380px 默认，拖拽范围 300-620px）；dock 收拢：中央区满宽，悬浮球固定右下（`right:22px; bottom:22px`）不遮挡内容操作区；非阶段页悬浮抽屉 `.chat-gwrap` 从顶栏下沿到窗口底。开合不得引起中央区内容重排错位（纸面居中自适应）；1280 视口 + dock 展开为最低通过组合。

**DSG-U05-3 客户工件预览的移动视口。** 承接 REQ-806（客户工件另验移动视口）。工件验收按目录 `viewportProfiles` 逐视口执行（含 390px 移动档）：预览 iframe 容器按视口宽度设限、内部工件自身响应式；UI 符合度逐页×逐适用视口判定（REQ-414），移动视口结果在自测矩阵与双侧对照弹窗中独立呈现，不以桌面结果代替。

**DSG-U05-4 兼容矩阵与低宽度提示。** 承接 REQ-806。浏览器兼容矩阵：Chrome / Edge 最近两版 + Safari 最新版。平台 UI 正式支持 1280/1440/1920 桌面视口；视口 <1280 时顶栏下方显示「建议桌面宽度」可关闭提示条，**提示不阻断使用**；平台 UI 在移动端为**查看级**（只读浏览，编辑/确认类操作不承诺可用）。原型 ≤760px 等响应式残留（如资料页三栏堆叠）保留为降级形态，不作为验收基准。

## 6. 与原型差异表（DSG-U06）

> 原则：原型为 UI 基准，以下仅登记真实化带来的**必要差异**及理由。未列入之处以原型为准。

| 编号 | 差异 | 原型行为 | 真实产品 UI | 理由 |
| --- | --- | --- | --- | --- |
| DSG-U06-1（D1） | 登录入口 | 无鉴权，直进项目列表 | 增加最简本地登录页（账号+口令）：不提供页面注册，首个（本期唯一）本地账号由部署初始化创建；口令校验后建立会话（12h 滑动续期），无「记住我」/找回密码入口；登录后进入项目列表；顶栏右端加当前用户标识；UI 元素/配色沿用本册令牌 | REQ-707/REQ-803：自托管账号本期最简形态；S8 mock→真实映射 |
| DSG-U06-2（D2） | 加载态真实化 | 内存态即时可用 | 各页首屏数据经 API 加载：列表骨架行/纸面骨架屏；加载失败行内错误 + 重试按钮（不白屏、不跳走） | S1：服务端持久化；REQ-801 |
| DSG-U06-3（D3） | 进度与流式真实化 | `setInterval` 模拟推进 | 解析/生成/构建/自测/autopilot 进度由 SSE 推送驱动：行内进度条、命令条状态字、按钮禁用态不变；断线显示「连接中断，重连中」行内提示，恢复后续接 | S2/S3：SSE 推送（HLD §2）；REQ-801/804 |
| DSG-U06-4（D4） | 预览加载方式 | iframe `srcdoc` 内嵌 HTML 字符串 | iframe `src` 加载对象存储签名 URL（独立子域 + sandbox + CSP）；UI 容器、状态条、postMessage 协议不变 | S6、ADR-2/§6 预览隔离：禁同源脚本；承接 REQ-803（预览不可信隔离）、REQ-307（预览交互不变） |
| DSG-U06-5（D5） | 密钥与凭据展示 | 掩码模拟（sk-****72af） | 掩码规则不变；保存后不再回显完整明文；测试连通走服务端 | REQ-803、HLD §6 密钥加密落库 |
| DSG-U06-6（D6） | 权限预留入口置灰 | 「RBAC 角色权限（预留挂载点，本期不启用）」复选 + toast 提示 | 保留并扩展为统一模式：预留能力入口一律 disabled + 说明 tooltip/横幅（含 OIDC/LDAP 接入、生产发布适配入口） | REQ-707/712：扩展点可见但本期不生效，ADR-9 |
| DSG-U06-7（D7） | 模拟数据与示例隔离 | 种子示例项目混入列表，刷新恢复 | 示例项目独立分组展示并标注「示例」徽标；不作为真实门禁依据；真实项目空态替代种子数据 | BR-15 示例数据隔离；S1 |
| DSG-U06-8（D8） | 下载/导出 | toast「模拟下载」 | 真实文件下载（对象存储签名 URL）；按钮与菜单位置不变 | S6、REQ-708 |
| DSG-U06-9（D9） | 演示直链移除 | 开发门禁横幅「✓ 定稿」直链按钮（`devFinalBook`，标注演示用） | 移除该直链；缺口 chip 仅跳转设计页，定稿动作只在设计阶段发生 | 原型自述「正式版将由门禁拦截」；BR-06 确认点归位 |
| DSG-U06-10（D10） | 验收「模拟」标注 | 验收台常驻「模拟执行 · 非真实实测」橙 tag、场景下拉 | 移除场景选择器；执行=真实手工确认 + 自动执行器回传，证据附件上传/查看入口；任何标注「模拟」的 UI 元素删除（模拟通道不存在） | S7、BR-11 证据真实性；REQ-504/505 |
| DSG-U06-11（D11） | 委派目标 | 假 CLI 目标（模拟执行 2.6s 完成） | 真实适配器目标；执行中状态由回传驱动；工具卡展示真实审计摘要；界面结构不变 | S10、REQ-610 |
| DSG-U06-12（D12） | 成本徽标 | mock 数字 | 真实 token/时长计量 × 价目表；popover 结构不变，明细行来自计量表 | S9、REQ-612 |
| DSG-U06-13（D13） | 会话刷新恢复 | 刷新恢复种子，进度定时器 boot 重挂 | 会话态刷新后自服务端重建；进行中的作业/运行从服务端状态恢复展示（含 autopilot 归属标识）；不「假装继续」已失效的本地定时器 | S1、BR-08/14；ADR-2 |
| DSG-U06-14（D14） | 并发冲突提示 | 单写者无冲突 | 并发提交被拒时 toast + 弹窗提示「内容已被他人更新」，提供「查看最新/基于最新重新编辑」入口 | REQ-210、BR-12：多用户真实化预留的乐观锁反馈 |
| DSG-U06-15（D15） | 缺陷状态机五态 | 四态：new→confirmed→regression→closed（`acceptance-workbench.js` L45-51 区）；缺陷编号 AB-<序>；严重度种子 高/中/低 | 五态：new→confirmed→fixing→pending_regression→closed（新建→已确认→修复中→待回归→已关闭）；reopened 为事件（回归失败回到 confirmed）而非状态；缺陷编号 DF-<序>；严重度 P0~P3（原型种子 高/中/低→P1/P2/P3）；缺陷卡按钮流转见 §3.6 | 原型四态→产品五态为**已裁决产品化重构**（统稿裁决 A1，PRD REQ-506 为权威）：拆分「修复中/待回归」以落实「开发侧只能标记待回归、关闭必须测试侧人工确认」 |
| DSG-U06-16（D16） | 通知中心形态 | 顶栏 🔔 点击开 popover（`popover(btn,…)` L2066 区 `bellPopover`） | 改为右侧抽屉：通知列表 + 全部已读 + 跳转定位；本期仅站内通知，webhook 列后续扩展 | 统稿裁决 D20；通知量大时 popover 不可滚动定位，抽屉承接列表与跳转（REQ-703） |
| DSG-U06-17（D17） | 设置页分组扩充 | 设置导航仅三组：Agent 配置 / 模型配置 / 系统设置 | 新增「🛂 放行策略」「🧾 审计」「💾 备份」三组（REQ-711 七点 manual/auto 开关、审计只读查询、备份导出）；既有三组结构不变 | 统稿裁决 D20：放行策略配置、审计查询、备份入口落设置页对应分组（REQ-705/706/708/711） |
| DSG-U06-18（D18） | 委派注册向导与并发上限 | 「＋ 注册 target」为 toast 占位（模拟），无并发上限概念 | 注册向导 modal：名称、类型（适配器类型）、端点、凭据引用（引用设置中已存凭据，不内嵌明文）；保存前可测试连通，失败不入册。同一项目并发委派上限默认 2（可配置），超限在发起时提示 | 新增能力：S10 真实化需要注册流程；统稿裁决 D22（委派并发上限默认 2 可配置）；REQ-610 |
| DSG-U06-19（D19） | 用例结果枚举补 not-applicable | 验收执行结果枚举仅 pass/fail/blocked/not-run（`acceptance-workbench.js`） | 增列 `not-applicable`（不适用）：UI 上以独立 tag 区分、不计入通过、不缩小必测分母 | PRD REQ-504 的文档新增枚举：真实验收存在对本批不适用的条款，须与「未执行」显式区分，防止借「不适用」藏缺口 |
| DSG-U06-20（D20） | 条件放行（豁免通道） | 原型无豁免通道：`acceptanceRelease` 仅当定稿报告结论为 pass 才允许记录交付决定 | 支持条件放行：仅可豁免明确列举的中低等级问题，豁免逐项列举并写入交付决定工件、全程留痕；P0/P1、必测未执行、证据失真不可豁免（按钮禁用 + 原因） | PRD REQ-509 的**已裁决放宽**（理由见该条）；统稿裁决 A1 维持「P0/P1 不可豁免」口径不变 |
| DSG-U06-21（D21） | 移除「阶段 pill 置灰」虚构描述 | 原型 `.stage-pill` 无锁定态：`.stage-pill.locked` 为从未生效的死 CSS（波次 3 已自原型移除） | 阶段 pill 永远可点击，门禁提示以目标页内横幅呈现（DSG-U02-2 已改述）；本册此前「未达标置灰 `.locked`」描述删除 | 评审发现 X5/P2-8：文档虚构须移除；缺口明示由页内门禁横幅承接（REQ-702） |
| DSG-U06-22（D22） | 项目「删除」改「归档」 | 原型入口文案「删除项目」（`delProj`，实为模拟删除数组项） | 入口与确认弹窗改为「归档项目」：项目只归档不可删除，归档不删任何证据、为可逆标记，归档项目从默认列表滤出 | 统稿裁决 D17（REQ-808 优先）：真实产品证据不可物理删除 |
| DSG-U06-23（D23） | RTM 追溯节点卡 9 类→8 类 | 原型追溯节点卡为 9 类（`msf-prototype.html` L817 区常量定义），另含 **P=原型 UI 节点** | 本体系 DSG 设计节点为 h/o/g/k/d/a/u/n 共 8 类，不另立 P 节点：原型 P 节点为原型期过渡态锚点，产品化后原型 UI 工件由 DSG-U（本册）承接 | 统稿裁决 M7（8 册前缀权威）；RTM 首部已登记，本行作差异表兜底 |
| DSG-U06-24（D24） | RTM 页 L0d 独立 KPI 卡 | 原型 `rtmHtml` KPI 行共 5 卡（L0a / L0b / L0c / 节点 / 未覆盖），deferred 计数不是独立卡、在 L0c 卡内文体现（「N 个 REQ 已 deferred 排除出分母」，`rtmHtml` L875 区） | §3.3 RTM 组件树按四指标口径列 6 项 KPI，「L0d deferred 计数」为独立卡片单独展示（信息性指标，不进入任何门禁公式，不允许借 deferred 藏缺口） | 产品化新增 UI 元素：PRD REQ-208 四指标口径要求 L0d 单独展示计数，独立卡较卡内文更符合「不得藏缺口」的可见性要求 |

## 7. 可访问性与反馈（DSG-U07）

**DSG-U07-1 操作反馈分级。** 承接 REQ-703、BR-10。三级反馈：① toast（顶部居中，2.4s）用于轻量成功/警告结果；② 行内反馈（行 tag、横幅 `.banner`、问题列表、按钮 disabled + title 原因）用于需要定位与持续可见的状态；③ modal 确认用于不可逆/门禁类动作。原则：异步长任务必须有持续可见的行内状态，toast 只是补充。

**DSG-U07-2 危险操作确认。** 承接 BR-06、BR-10。归档项目/删除文件（双向同步）/删除会话/返工/解锁定稿/标记 deferred/定稿遇未决项/有条件放行，一律 modal 二次确认，确认按钮语义着色（danger-ghost 红字或 green/primary）；确认文案明示影响面（如「原文件、解析稿、内容解析结果与附件一并删除」）。所有确认动作记审计（操作者/时间/对象，REQ-706）。

**DSG-U07-3 「需你处理」聚合入口。** 承接 BR-10、REQ-416/507。开发计划页注意项页签「需你处理」为一级聚合（计数徽标，区分 blocking/普通，点击定位到任务或缺口）；开发阶段变更影响另有常驻红色横幅提醒（`devImpactReminderHtml`）；通知中心（顶栏 🔔 未读计数）承接跨阶段事件（定稿完成、检查发现问题、自测失败、委派完成等）；任务卡 ⚠ 变更徽标、RTM 行高亮跳转构成定位链。

**DSG-U07-4 可访问性基础。** 承接 REQ-806、REQ-709。交互元素可聚焦（button/input/select 原生语义）；关键控件带 `aria-label`（批次下拉、复选框「选择定稿 …」、树展开钮）；状态不只依赖颜色——tag 同时含文字（「通过/阻断/未执行」等），严重度 `.sevdot` 伴随文字级别；对比度以令牌色值保证（--ink on --canvas ≥ 12:1）；焦点环统一蓝（`box-shadow: 0 0 0 2px --blue-soft`）。键盘可达性见 DSG-U02-6；目标尺寸 ≥32px（icon-btn 32×32）。

## 8. 修订记录

| 日期 | 条目 | 变更 |
| --- | --- | --- |
| 2026-09-20 | 全部 | 初稿（以原型 V1.11 为 UI 基准逆向；真实化差异登记于 §6） |
| 2026-09-20 | 全册 | 统稿修订（依据《统稿裁决记录》）：RTM 设计节点类型对齐 h/o/g/k/d/a/u/n 共 8 册、L0c 改为 deferred 项计数（M7/A7）；开发看板列文案对齐 queue/ing/review/done + blocked 标记（A4）；登录页补最细规格（部署初始化账号、12h 滑动续期，D16）；通知中心=顶栏铃铛+抽屉、审计/备份/放行策略入口落设置页对应分组（D20）；兼容矩阵补 Safari 最新版、<1280 提示不阻断、移动端查看级（D21，新增 DSG-U05-4）；委派注册向导字段（名称/类型/端点/凭据引用）补入委派页；需求页上传补充 md 不豁免 REQ-114——§8 待澄清 8 项全部裁决回销，本节删除 |
| 2026-09-20 | 统稿修订记录更正 | 更正说明（不改上行历史记录）：上行「L0c 改为 deferred 项计数」口径已被 2026-09-20 波次 1 修订取代——L0c=REQ→DSG 锚点覆盖率、L0d=deferred 计数（见 PRD REQ-208 与统稿裁决记录 F 组） |
| 2026-09-20 | DSG-U02-4 | 用户决策扩展落地（PRD REQ-615 接入面扩展）：助手 dock 补 pi-web-ui 实现注——消息流列表/流式渲染拟复用 pi-web-ui 的 Lit 聊天 Web Components（复用方式经波次 2 评审修订为「参考实现/浅 fork + 裁剪依赖」，见下行），外观按 §1 设计令牌定制；交互结构与原型一致，不随组件复用改变 |
| 2026-09-20 | DSG-U02-2、DSG-U02-4、§3.1、§3.5、DSG-U07-2、§6 | 评审修改（波次 2/2C 移交）：①DSG-U02-2 删除「阶段 pill 未达标置灰」虚构描述（原型 `.stage-pill.locked` 为死 CSS），改为「阶段 pill 永远可点击，门禁提示以页内横幅呈现」；②§3.1 项目「删除」改「归档」（统稿裁决 D17），并修正「delegate 心跳」措辞——该定时器是开发看板 agent 任务进度模拟机制，与委派页无关，真实产品由 SSE 承接；③§3.5 自测四门命名对齐原型（功能检查/联调与冒烟/UI 符合度/开发审核，对应 gates 键 functional/integration/ui/review）；④DSG-U07-2「删除项目」改「归档项目」；⑤§6 新增 DSG-U06-16~22 差异登记（通知中心 popover→抽屉、设置页新增放行策略/审计/备份三组、委派注册向导与并发上限、not-applicable 枚举、REQ-509 条件放行已裁决放宽、移除 pill 置灰虚构描述、项目删除改归档）；⑥DSG-U02-4 pi-web-ui 复用口径改为「参考实现/浅 fork + 裁剪依赖」（其版本滞后 0.75.3 vs pi-* 主线 0.86.0、依赖重，fork 后维护责任归平台） |
| 2026-09-20 | §6 | 评审修改（波次 2，2B 移交）：新增 DSG-U06-23 差异登记——原型 RTM 追溯节点卡 9 类（含 P=原型 UI 节点）→ 本体系 8 类（h/o/g/k/d/a/u/n，P 节点由 DSG-U 承接不另立）；RTM 首部已登记，此行作差异表兜底 |
| 2026-09-20 | §3.3、§3.6、§6 | 评审修改（波次 1-3/1-4）：§3.3 RTM 页签 KPI 对齐四指标口径——L0c 恢复为 REQ→DSG 锚点覆盖率（=1 为开发入口门禁指标，含 deferred 标记/撤销操作钮），deferred 计数改称 L0d（信息性，不进门禁公式）；§3.6 缺陷卡状态流转改按五态模型（new→confirmed→fixing→pending_regression→closed，reopened 为事件回 confirmed，与 PRD REQ-506 逐字对齐）；§6 新增 DSG-U06-15 登记「原型四态→产品五态」已裁决重构差异 |
| 2026-09-20 | §3.3（DSG-U03-3 需求页） | 用户 UI 反馈落地：需求/设计文档页的三态切换（预览/编辑/Markdown 源码）由目录栏底部移入文档工具栏（版本下拉之后）——视图切换作用于当前文档，应与文档同处；原型 docStageHtml/designDocsHtml 已同步修改，目录栏恢复为纯章节目录。设计页三态与需求页同构（§3.4 L124 表述随之生效） |
| 2026-09-20 | §3.3（DSG-U03-3 需求页） | 用户 UI 反馈落地（二轮）：需求页工具栏排布与设计页完全同构——状态 tag（已定稿 vX/vX 修订中）+ 版本下拉 + 📚 参考资料 ｜ ↩↪/下载/版本提交/重新生成/定稿/⋯ ｜ 三态末尾；原型 docStageHtml 已同步。全局排查确认其余页面三态/视图切换均在各自文档工具栏内（资料文件解析面、内容解析面、原型 UI 页），无同类错位 |
| 2026-09-21 | 全册原型行号、§6、§8 | 二轮评审整改：① 全册原型行号按波次 3/4 与工具栏改动后的现行 `msf-prototype.html`（14605 行）逐符号实查重刷（非批量偏移）：`:root` L8-13 不变，补丁 style 块→L1219/1981/2365/4908/8929/14416/14477，`render()` L2013（路由表 L2018-2028）、`topbarHtml` L2033-2059、`bindTocSync` L784、`chatDockHtml/chatDockInner` L1021/1025、`hasDock` L1090-1093、`bindResizer` L1208、`chatScrollRestore` L1137、拖选/快捷键监听 L4673-4690/L4701-4708、`modal/popover` L541-557、需求区 L563/576/664/684/705/714/759/769/825/861、设计区 L3350/3367/3557/4424/9169/5552/8962 区/14391、开发区 L5019/5077/5109/5175/5204/5207/5251/9039/9188/14396、V19/验收区 L9324/14416/14429-14457/14468/14473、V1.11 区 L14477/14483/14508/14522/14533/14552/14554/14562/14573/14582/14583/14597/14598/14602、`DSG_DEFS` L817、`bellPopover` L2066；`acceptance-workbench.js` L45-51 区复核未漂移；② §6 新增 DSG-U06-24：RTM 页 L0d deferred 计数独立 KPI 卡（原型 `rtmHtml` 仅 5 卡、deferred 在 L0c 卡内文体现）差异登记；③ §8 修订记录更正：上两条「§3.2（DSG-U02 需求页）」落点编号改正为 §3.3（DSG-U03-3 需求页） |
