import { defineConfig } from 'vitest/config';

// 覆盖率门槛（LLD-7 DSG-N06-2）：M0 落地的 evidence/policy 属核心正确性模块 → 90%/80%
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: { lines: 90, branches: 80 },
      include: ['src/modules/evidence/**', 'src/modules/policy/**'],
      exclude: ['**/*.module.ts'], // NestJS 装饰器装配文件，无逻辑
    },
  },
});
