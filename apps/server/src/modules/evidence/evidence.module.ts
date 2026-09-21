import { Module } from '@nestjs/common';

/**
 * M11 证据与审计（核）：命令事务 + 审计哈希链。
 * 被全部写路径调用，自身不调用任何业务模块（DSG-M00-1，依赖方向由 dependency-cruiser 固化）。
 */
@Module({})
export class EvidenceModule {}
