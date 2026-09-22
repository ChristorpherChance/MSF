import { Module } from '@nestjs/common';
import { LocalGitAdapter } from './git.service.js';
import { IdentityAdapterStub, LocalCiAdapter, ReleaseAdapterStub } from './adapters.service.js';

/** M10 集成适配层（M6：Git 本地实现；CI trigger/status 桩 + webhook 回传已在 M4；Identity/Release 仅接口） */
@Module({
  providers: [LocalGitAdapter, LocalCiAdapter, IdentityAdapterStub, ReleaseAdapterStub],
  exports: [LocalGitAdapter, LocalCiAdapter, IdentityAdapterStub, ReleaseAdapterStub],
})
export class IntegrationModule {}
