// 模块依赖方向静态检查：固化 LLD-1 §1.1（DSG-M00-1）调用矩阵（LLD-7 DSG-N06-1）
// M01(web) 只与 M02(api) 通信（经 HTTP，不经 import）；M11 evidence 不调用任何业务模块；
// M12 policy 单向被各领域确认点调用；AI 调用必须经 M08；跨域只传身份+指纹。
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-domain-direct',
      comment: '领域服务之间禁止直接 import，跨域只传身份+指纹（DSG-M00-3）',
      severity: 'error',
      from: { path: '^apps/server/src/modules/(material|req|design|dev|test)/' },
      to: { path: '^apps/server/src/modules/(material|req|design|dev|test)/', pathNot: '^apps/server/src/modules/$1/' },
    },
    {
      name: 'evidence-no-business-deps',
      comment: 'M11 证据与审计自身不调用任何业务模块（DSG-M00-1）',
      severity: 'error',
      from: { path: '^apps/server/src/modules/evidence/' },
      to: { path: '^apps/server/src/modules/(material|req|design|dev|test|ai|executor|integration|platform)/' },
    },
    {
      name: 'ai-only-via-m08',
      comment: 'AI 调用必须经 M08 编排层（DSG-M00-3）',
      severity: 'error',
      from: { path: '^apps/server/src/modules/', pathNot: '^apps/server/src/modules/ai/' },
      to: { path: 'node_modules/@earendil-works/' },
    },
    {
      name: 'web-no-server-import',
      comment: 'M01 前端不得以 import 方式依赖 server 内部（仅经 packages/shared）',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^apps/server/' },
    },
    {
      name: 'no-circular',
      comment: '禁止循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['\\.spec\\.ts$', '\\.test\\.ts$', 'doc/'] },
  },
};
