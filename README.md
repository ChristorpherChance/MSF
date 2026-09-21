# MSF — 软件工厂（自托管）

按 `doc/product-design/` 产品文档体系（二轮评审通过，2026-09-21 基线）实现的软件工厂 Web 应用。

- **产品文档**：`doc/product-design/`（PRD/HLD/LLD×7/RTM/统稿裁决记录，冻结基线，变更走 README §5）
- **行为基准**：`doc/product-design/prototype/`（原型 V1.11 快照 14605 行）
- **开发计划**：`doc/dev-plan/`（开发计划.md + 任务分解.md）

## 仓库结构（pnpm monorepo）

- `apps/web` — 前端 SPA（React 18 + TypeScript + Vite + Zustand）
- `apps/server` — 平台后端（NestJS 模块化单体，模块边界对应 HLD M02~M13）
- `packages/shared` — 共享包（错误码注册表、状态机枚举、JCS+NFC 指纹工具）
- `doc/` — 产品文档、开发计划、原型与测试

## 环境

- Node ≥22.19（Pi SDK 运行要求，HLD §6）、pnpm 10、Docker ≥27
- `docker compose up -d postgres minio redis` 起基础服务
- `pnpm install && pnpm dev` 起开发服务

## 纪律速查

- 错误码闭集：`packages/shared` 错误码由脚本从 LLD-3 §14/§15 生成，先注册后使用
- 写操作四件套：命令注册 + 审计映射 + 效果定义 + 自动化测试（LLD-7 N06-3）
- 模块依赖方向：dependency-cruiser 固化 LLD-1 §1.1 调用矩阵，违规即构建失败
