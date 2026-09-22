import { Injectable } from '@nestjs/common';
import { DomainError } from '@msf/shared';

/**
 * M10 CI/身份/发布适配器（LLD-1 M10-2；REQ-412/712）：
 * - CiAdapter：trigger/status 接口 + 本地桩（webhook 回传已随 M4 落地 A06-21/22，
 *   HMAC 校验与幂等经 dev.ci.callback 实证，本域验收复核）
 * - IdentityAdapter/ReleaseAdapter：仅接口，调用即 RELEASE_NOT_IMPLEMENTED（不静默降级）
 */
export interface CiAdapter {
  /** 触发流水线，返回外部 run 标识 */
  trigger(pipeline: string, ref: string, vars?: Record<string, string>): Promise<{ externalId: string }>;
  /** 查询外部 run 状态（unknown=状态不明如实上抛，REQ-412） */
  status(externalId: string): Promise<{ status: 'queued' | 'running' | 'pass' | 'fail' | 'unknown' }>;
}

export interface IdentityAdapter {
  verifyToken(token: string): Promise<{ subject: string; roles: string[] }>;
}

export interface ReleaseAdapter {
  publish(artifactRef: string, target: string): Promise<{ releaseId: string }>;
}

/** 本地 CI 桩：不触外，trigger 即记 queued，status 恒 unknown（真实 CI 经 webhook 回传驱动） */
@Injectable()
export class LocalCiAdapter implements CiAdapter {
  async trigger(pipeline: string, ref: string): Promise<{ externalId: string }> {
    return { externalId: `local:${pipeline}@${ref}` };
  }
  async status(_externalId: string): Promise<{ status: 'unknown' }> {
    void _externalId;
    return { status: 'unknown' };
  }
}

@Injectable()
export class IdentityAdapterStub implements IdentityAdapter {
  async verifyToken(_token: string): Promise<never> {
    void _token;
    throw new DomainError('IDENTITY_AUTH_FAILED', '外部身份适配未配置（本期仅本地默认身份 REQ-707 最简）', 'identity');
  }
}

@Injectable()
export class ReleaseAdapterStub implements ReleaseAdapter {
  async publish(_artifactRef: string, _target: string): Promise<never> {
    void _artifactRef; void _target;
    throw new DomainError('RELEASE_NOT_IMPLEMENTED', '发布适配器本期仅接口预留', 'release');
  }
}
