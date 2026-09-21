# V1.9 验证

V1.9 当前为停止检查点，**整体验收 NO-GO**。固定 32067a 候选的原型命令原 65 组及效果恢复 2 组通过；最终审查新增两项历史字节 RED，当前命令入口共 67 组，不能称全绿。见 `evidence/prototype-transaction-stop-validation.json`。未运行完整回归，历史 NO-GO 与 RED 保留。

- `node V1.9/tests/customer-authority-boundary.cjs`：保留历史客户权威边界反例，并验证新路线不回退。
- `node V1.9/tests/customer-route-matrix.cjs`：客户路由 45 项；`node V1.9/tests/customer-privacy-projection.cjs`：隐私投影 22 项。二者与完整客户矩阵已绿，冻结客户源已独立 GO。
- `node V1.9/tests/prototype-commands.cjs`：67 组纯准备、原子发布、审计失败、共享记录冲突、会话及 pending 归属、收据唯一性、效果恢复、遗留入口封闭、当前检查失效、真实聊天与历史字节验证；目前包含两项已知失败。每次先复制 SHA 命名的固定 HTML，避免执行中来源变化。`V19_CASE` 可筛选名称；定向、历史候选和完整结果各写独立证据文件。`V19_CASE=已定稿版本字节` 可复现 1 次/35 次保存丢失原文；PowerShell 设置环境变量后运行，结束时清除变量。
- `node V1.9/tests/prototype-effects-integration.cjs`：实际检查启动后异常不得重复派发；解锁后即时阻断旧开发依据，观察失败可恢复且不重复记录。正式验收必须 `skipped=[]`。
- `node V1.9/tests/main-integration-boundary.cjs`：9 组来源 readiness、写入保护、双向追溯、自测故障恢复、双方 iframe 状态与人工交接归属验证。`V19_SKIP_HEALTH=1` 仅供前提缺失时诊断，会明确记录跳过四项，不能作为完整验收。
- `prototype-transaction-atomicity.cjs` 与对应 RED：旧 writer 路线的历史反例，已由 `prototype-commands.cjs` 的全命令验证替代，不在完整入口中。新版失败时应保留用户尚未保存的输入，因此不沿用旧脚本“失败后编辑器必须等于已保存状态”的判据。
- `release-hold.cjs` 与 `evidence/release-hold.json`：旧 NO-GO 候选的隔离证据，验证当时不能定稿或进入开发；不是新合格证书候选的健康测试。
- `node V1.9/tests/contract-hardening.cjs`：静态来源根、非 UI 承接、build 归属、历史收据、合并依据和自测恢复。
- `node V1.9/tests/build-artifact.cjs`：使用实际构建 HTML 重放客户矩阵；客户与构建共用 pure kernel，构建 renderer 独立且运行时不读取设计 generator。
- `node V1.9/tests/syntax.cjs`：单HTML脚本编译与旧8版本字节保护。
- `node V1.9/tests/run-all.cjs`：候选冻结后串行运行 30 套完整回归，覆盖 10 个维护源：HTML、catalog、task、template、contract、build、runtime、cert、source-rules、kernel。执行前后校验全部来源 SHA，并清除筛选、跳过和外部候选变量；任何一套失败均停止且最终结果为失败。

`sync-sources.cjs`只静态嵌入维护源；它不会生成通过资格。`freeze-ui-certificate.cjs`要求模板、测试、结果 SHA 与独立客户复核通过；skip/not-run 均不得计为通过。

所有执行使用仓库已有缓存Node、Playwright和Chrome；不需外网，不连接真实模型、后端或CI。
