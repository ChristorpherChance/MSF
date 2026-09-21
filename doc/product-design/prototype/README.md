# 原型快照（productization 基线参考）

> 归档日期：2026-09-21 ｜ 用途：产品化文档体系（`doc/product-design/`）的**事实源**与行号引用基准。

## 内容

| 路径 | 说明 | 行数 | SHA-256（前 16 位） |
| --- | --- | --- | --- |
| `msf-prototype.html` | 原型 V1.11 最新构建产物（单文件、可直接浏览器打开） | 14605 | `0870389e909058ae` |
| `src/` | 维护源与构建脚本（HTML 由维护源嵌入构建生成，见下） | — | 见各文件 |

`src/` 明细：

| 文件 | 角色 |
| --- | --- |
| `runtime-hardening.js` | 写事务硬化层（命令包装/门禁/审计；文档缩写 RH） |
| `customer-state-kernel.js` | 客户域状态内核（缩写 CSK） |
| `acceptance-workbench.js` | 验收工作台（缩写 AWB） |
| `material-folders.js` / `material-bulk.js` / `material-zip.js` / `material-polish.js` | 资料库目录/批量/zip/润色模块（缩写 MFD/MBK/MZIP/—） |
| `chat-reference.js` | 参考输入门禁（缩写 CREF） |
| `prototype-template.js` / `build-template.js` | 原型模板与主构建脚本 |
| `build-material.cjs` | 资料域嵌入构建脚本 |

## 与产品文档体系的关系

- 本快照即产品文档全部「原型出处」行号引用的基准：PRD/HLD/LLD-1~7/RTM 中的 `L<n>` 行号均以本文件（14605 行版）为准（二轮评审已逐符号重刷，2026-09-21）。
- 产品文档引用本原型中的机制时使用的缩写对照见 `../LLD-2-算法与流程.md` 首部。
- 原型的持续演进仍在 `doc/msf-prototype.html`（本目录外）进行；本快照为评审基线存档，**请勿直接修改**。若原型继续演进，应整体替换本目录并同步刷新各册行号引用与 `../RTM.md` §7 基线。

## 质量状态（归档时）

- 回归测试（`doc/tests/` run-all）：28/30 套全绿；`syntax`/`design-boundary` 两套因依赖维护源 V1.1~V1.9 历史快照目录、在本环境缺失，属环境问题（已有替代验证覆盖）。
- 全文件无原生 `confirm()`（确认交互统一为 modal）；定稿门禁/RTM 健康度为实算（非硬编码）。
- 评审记录：`../reviews/2026-09-20-评审报告.md`（一轮）、`../reviews/2026-09-21-二轮评审报告.md`（二轮，通过）。
