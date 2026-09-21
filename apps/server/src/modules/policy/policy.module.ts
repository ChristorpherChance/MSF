import { Module } from '@nestjs/common';
import { PolicyService } from './policy.service.js';

/** M12 放行策略引擎（核）：单向被各领域确认点调用（DSG-M00-1） */
@Module({ providers: [PolicyService], exports: [PolicyService] })
export class PolicyModule {}
