import { Module } from '@nestjs/common';
import { HealthController } from './modules/platform/health.controller.js';
import { ApiModule } from './modules/api/api.module.js';
import { EvidenceModule } from './modules/evidence/evidence.module.js';
import { PolicyModule } from './modules/policy/policy.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { AiModule } from './modules/ai/ai.module.js';
import { MaterialModule } from './modules/material/material.module.js';
import { ReqModule } from './modules/req/req.module.js';
import { DesignModule } from './modules/design/design.module.js';
import { DevModule } from './modules/dev/dev.module.js';

/**
 * 应用根模块（模块化单体，ADR-1）。
 * M0 落地：api(M02)/evidence(M11)/policy(M12)/platform(M13 最小)/ai(M08 mock)/health。
 * 领域模块 material(M03)/req(M04)/design(M05)/dev(M06)/test(M07)/executor(M09)/integration(M10)
 * 随里程碑 M1~M6 逐个落地（目录边界与依赖方向规则已在 dependency-cruiser 固化）。
 */
@Module({
  imports: [ApiModule, EvidenceModule, PolicyModule, PlatformModule, AiModule, MaterialModule, ReqModule, DesignModule, DevModule],
  controllers: [HealthController],
})
export class AppModule {}
