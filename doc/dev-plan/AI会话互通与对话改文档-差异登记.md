# AI 会话互通 + 对话改文档 + 章节编号 · 差异登记（2026-10-04，待 13 册下轮基线回补）

> 实施依据：`doc/dev-plan/AI会话互通与对话改文档-实施计划.md`（16 任务，T1–T15 双评审全过，T16 收口）。提交链：b6d1c9d(T1) a5526cc(T2) 7312ea5+24bd2c7(T3) ed50904+faba09d(T4) c50d158(T5) ec40787(T6) bdaabc9+2c6e951(T7) db3a911+cf4c93b(T8) 2624c6f+e11a00c(T9) 3bd1e71+e2ea4fa(T10) 8f1f980+f1b41b3(T11) 8599436+11f48ee(T12) 540d8b7+0e34162(T13) 06192ce+5a2bdb1(T14) 1725344+e341ee6(T15) 3a30432(T16 门槛抓修)。

## 差异条目

1. **LLD-5 §工具桥**：允许集四件套→六件套（+`chat.history.read` 只读、+`req.doc.propose_edits` propose 档）；`ToolDef.kind` 扩 `'read'|'nav'|'propose'`；新增外部工具注册表（`platform/external-tools.ts`，registerExternalTool 旁路机制——嵌套 LLM 工具不经 ai.tool.invoke 命令事务，留痕=ai_tool_calls recordDirect + 内部命令审计行，无 ai.tool.invoke 审计行）。
2. **LLD-5 §会话 prompt**：buildPrompt 新增【他阶段会话】注入块（3000 字预算、SQL 失败静默降级）+【能力边界】【可用工具】两段文案改写（propose_edits 提案通道表述；评审补强：结果未知不断言「已提交」、去内联围栏、instruction 截 2000 字知情）。
3. **LLD-6 §3.3**：增量修订流挂 normalizePatches（修复「修改=重复追加」既有缺陷）；新增 `GenerateService.proposeEditsFromChat`（dock 对话改文档通道，守卫四分支人话不落码+竞态三码翻译 VERSION_LOCKED/INVALID_STATE/PATCH_BASE_STALE）；生成 prompt 大章约定（中文数字+顿号，含负例约束）。
4. **DSG-C04-4/导出**：导出四格式标题注入派生编号（`withNumberedTitles`）；需求页目录栏/纸面渲染层派生编号（`deriveNumbering` 落 packages/shared，前后端同函数同口径；存储零改动，RTM 锚点不断链）。
5. **LLD-5 §工具卡**：dock 工具卡 req.doc.propose_edits 成功卡分档（「已提交 N 条修改建议」+「前往审阅 →」跳转，复用 nav.goto 卡模式；失败卡走既有 reason 分支；patchCount 分支按 toolName 门控）。
6. **测试基建**：页级原型集成套件 PID f4→fb（与 test 域套件共享固定 PID，全量并发互踩——T16 门槛抓修，3a30432）。
7. **构建基建（T16 实机抓修）**：`@msf/shared` 原只产 CJS，web 首次运行时导入 `deriveNumbering` 白屏（vite 不预打包 workspace 链接包）→ 双构建：新增 `tsconfig.build.esm.json`（module ESNext/Bundler → dist/esm），package.json exports 加 `import` 条件 + `./doc-numbering` 子路径导出（绕开 index 整包求值 fingerprint.ts 的 node:crypto）；DocPanel 改子路径导入。存储/接口零变更。
8. **生成基准口径（T16 实机抓修，既有缺陷）**：`GenerateService.start()` 基准原只取当前版本内容，与 propose-pending/accept-pending 的「草稿优先」口径不一致——草稿有未提交修改时重新生成必然 PATCH_BASE_STALE。修为 start() 同口径草稿优先（差异针对 LLD-6 §3.3 生成链基准定义，实机前未被任何用例命中）。
9. **add 补丁落位（T16 实机抓修，既有缺陷）**：`EditPatch` 原无位置字段、applyPatch 的 add 恒 append 文末——整篇重生成的新增大章全部堆到文末逆序，文档结构乱。修：`EditPatch.after?` 落位锚点（''=文首前言之后；非空=插到同名标题节后；落空退化 append 不抛错；缺席=维持 append 兼容），mdToPatches 按模型输出顺序产 after。差异针对 LLD-4 D04 补丁模型（DSG-C04-4 edit_patch 增可选字段，向后兼容）。
10. **补丁批次顺序（T16 实机抓修，既有缺陷，schema 演进）**：propose-pending 单事务逐条 INSERT，`created_at DEFAULT now()` 取事务开始时间全批同值，listPatches `ORDER BY created_at` 乱序 → 链式 after 锚点被接受顺序打乱。修：迁移 0025 加 `seq` 列（req_pendings + design 域 dsg_pendings 同治），propose 写批内序号，listPatches 改 `ORDER BY created_at, seq`。差异针对 D04-4 表结构（只加列不动旧数据）。

## 已知限制

- mdToPatches 标题截 80 字符而 splitSections 不截，>80 字符无锚点码节归一化落空退回 add（CR/REQ 节走锚点码不受影响）。
- 空正文节不转 modify（保 add 由人工处置）；del 补丁模型无法经 markdown 表达，本期不支持（页面手工删除能力已有）。
- splitSections 不识围栏代码块：fence 内的 `## ` 行会被误切为节，withNumberedTitles 会把误切节标题改写进导出（既有缺陷，需求文档场景概率低；UI/RTM/导出同口径一致不发散）。
- 旁路工具不产生 ai.tool.invoke 审计行（设计口径：留痕=ai_tool_calls + 内部命令审计行双链，集成测试已钉）。
- deriveNumbering 大章判定只认中文数字+顿号；模型出「第X章」/阿拉伯数字变体时静默退化为普通节编号（prompt 已加负例约束压实）。
- applyPatch 的节 id 为位置性瞬时值（不落库、重切分即重派）；无前言文档下 add 可能与末节瞬时撞 id（既有，无消费方受害）——6cd5fdf 评审 M-1 登记。
- after 锚点取自 mdToPatches 截断标题（80 字符），匹配 splitSections 未截断标题——>80 字符标题锚点必落空退化 append（与标题截断既有口径同源）；同名标题锚点取首个命中——6cd5fdf 评审 M-2/M-3 登记。
- 前端「全部接受」逐条循环无单条 try/catch，首条失败即中断后续（失败安全、补丁保留可重试）——6cd5fdf 评审附带观察，登记。
- applyPatch 回退重定位残留面：secId 命中的节恰好也含短 old 时不回退（normalizePatches 产 modify 的 old 为整节全文，实际不命中）；锚点码命中但 old 校验失败时不再试精确标题（与 normalizePatches 同优先级约定）——e9c4900 复审 m-1/m-2 登记。
- 整篇重生成不产 del：模型输出不含的既有节不会被删，旧节残留尾部待人工处置（保守设计，防误删）——T16 实机确认语义，登记。
- ↩ 撤销一条 accept 会把该补丁复活为 pending（审计一致性设计）——批量撤销后 pendings 回归，重新生成会被 assertNoPendings 拦（人话提示），先处置再生成即可——T16 实机确认语义，登记。
