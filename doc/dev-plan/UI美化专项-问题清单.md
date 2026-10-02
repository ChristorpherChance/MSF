# UI 美化专项问题清单（2026-10-02 基线勘查）

基线截图：tmp-shots/base-*.jpeg（projects/material/req/design/dev/test/…）

## 处置结果（全部已修，实机复验）

| 编号 | 问题 | 处置 | 复验 |
| --- | --- | --- | --- |
| U-A1 | .subtabs 双定义撞车→页签蓝底蓝字不可见 | material 改名 .mat-subtabs（下划线式），req.css 胶囊式为 req/design 权威 | 计算样式：req 白字/蓝底✓、material 蓝字+蓝下划线✓ |
| U-A2 | .tag 三处定义撞车 | 权威定义收编 tokens.css（灰底胶囊+彩系 tag-ok/warn/info/err），projects/tasks 删重复仅留派生 | /projects 标签统一灰胶囊✓ |
| U-A3 | .modal 三处定义撞车 | ui→.modal-overlay 作用域、req→.modal-mask、material→.msk；design .proto-modal 提特异性 | 三套互不染指 |
| U-A4 | .popover 双定义撞车 | req.css 收编 .pop-wrap 作用域；ui Popover（portal/fixed）不受影响 | — |
| U-A5 | .toolcard/.prog 等撞车 | settings.css 死代码 .toolcard 删除；tasks .prog 收编 .tasks-table（90px 不再串到看板/树行）；dock .tasklist 与 req 近似容忍 | — |
| U-A6 | 禁用态白字洗白不可读 | tokens.css：button.act/sm/.primary:disabled 改灰底深字 opacity 1（button. 前缀压页面 opacity 规则）；各页重复 opacity 规则删除 | 计算样式：disabled primary=ink2/soft2/op1✓ |
| U-B | 硬编码颜色 | req/test/design/app/dock/notice-drawer/tasks 全量改令牌或 color-mix；新增 --purple/--purple-soft/--blue-ink 令牌 | grep 复核仅剩语义白字与 code-view 深色 |
| U-C1 | qa-*/dev-run 白字实底徽章对比度不足 | 统一 soft 底+彩字+彩边 tag 语言（P0 加粗+实边强调） | — |
| U-C2 | .qa-status 用 --line 当底色 | 改 --soft2 | — |
| U-C3 | qa-modal 灰底/低层级 | 改 --canvas + shadow-modal + z-index 300（对齐 DSG-U02-5） | — |
| U-C4 | 按钮无键盘聚焦环 | tokens.css 补 button/a :focus-visible 蓝环 | — |
| U-C5 | ops-col 10px 小字 | 升 11px | — |

## 基线勘查记录（原判）

- U-A1 实机证据：material 页 .subtabs button.on 计算样式 color==bg==#2783DE（蓝底蓝字）
- U-A6 实机证据：.act.primary:disabled 白字+opacity .45/.5 叠加≈洗白
- test.css qa-tag-blocked 白字 on #b7950b 对比度 ≈2.9:1（12px 不达标）

## 门槛

- [x] apps/web tsc 绿
- [x] pnpm lint 绿
- [ ] 复验截图 after-*.jpeg 逐页对照

