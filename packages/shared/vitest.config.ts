import { defineConfig } from 'vitest/config';

// 覆盖率门槛（LLD-7 DSG-N06-2）：shared 承载指纹/命令枚举等核心正确性工具 → 90%/80%
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      thresholds: { lines: 90, branches: 80 },
      include: ['src/**/*.ts'],
      exclude: ['src/error-codes.ts', 'src/enums.ts'], // error-codes=生成物；enums=纯常量表（正确性由与 LLD-4 CHECK 的人工核对+typecheck 保证）
    },
  },
});
