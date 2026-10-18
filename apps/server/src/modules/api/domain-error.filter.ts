import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { DomainError } from '@msf/shared';

/** DomainError 顶级码 → HTTP 状态映射（LLD-5 §1.4 权威；此处只落 M0 用到的子集，随域推进补全） */
const HTTP_BY_CODE: Partial<Record<string, number>> = {
  COMMAND_UNKNOWN: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  AUDIT_WRITE_FAILED: HttpStatus.INTERNAL_SERVER_ERROR,
  NORMALIZE_FAILED: HttpStatus.UNPROCESSABLE_ENTITY,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  UPLOAD_REJECTED: HttpStatus.UNPROCESSABLE_ENTITY,
  GATE_BLOCKED: 423,
  STALE_EVIDENCE: 423,
  // M2 需求域（LLD-3 §14/§15(c) 权威状态列）
  DRAFT_BASE_MISMATCH: HttpStatus.CONFLICT,
  PATCH_BASE_STALE: HttpStatus.CONFLICT,
  VERSION_LOCKED: HttpStatus.CONFLICT,
  VERSION_IMMUTABLE: HttpStatus.CONFLICT,
  UNDO_STACK_EMPTY: HttpStatus.UNPROCESSABLE_ENTITY,
  NO_CHANGE: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_NOT_FINAL: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_STALE: HttpStatus.CONFLICT,
  POLICY_MANUAL_REQUIRED: HttpStatus.FORBIDDEN,
  AI_BASIS_INVALID: HttpStatus.CONFLICT,
  AI_RESULT_STALE: HttpStatus.CONFLICT,
  // M6 AI 域
  FORBIDDEN: HttpStatus.FORBIDDEN,
  MODEL_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  MODEL_RATE_LIMITED: 429,
  // ---- 实机走查第三波补全（#20）：以下注册码已实际抛出但未映射，全部裸落 500；状态列以 LLD-3 §14 为权威 ----
  // 通用/平台
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  RATE_LIMITED: 429,
  OPERATION_STALE: HttpStatus.CONFLICT,
  // 开发域（§14(e)）
  RETEST_WITHOUT_CHANGE: HttpStatus.CONFLICT,
  GIT_MERGE_CONFLICT: HttpStatus.CONFLICT,
  EXECUTION_TIMEOUT: HttpStatus.INTERNAL_SERVER_ERROR,
  // 测试验收域（§14(f)）
  HANDOFF_INVALID: HttpStatus.CONFLICT,
  ZERO_CASES_FORBIDDEN: HttpStatus.UNPROCESSABLE_ENTITY,
  EVIDENCE_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  WAIVER_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  REGRESSION_EVIDENCE_MISMATCH: HttpStatus.CONFLICT,
  DEFECT_CLOSE_DENIED: HttpStatus.FORBIDDEN,
  REPORT_BASIS_MISMATCH: HttpStatus.CONFLICT,
  // AI 编排域（§14(g)）
  TOOL_UNREGISTERED: HttpStatus.BAD_REQUEST,
  TOOL_DENIED: HttpStatus.FORBIDDEN,
  TOOL_ARGS_INVALID: HttpStatus.BAD_REQUEST,
  DELEGATION_TARGET_UNAVAILABLE: HttpStatus.UNPROCESSABLE_ENTITY,
  PROMPT_VERSION_INVALID: HttpStatus.CONFLICT,
  // 执行器与集成适配域（§14(i)）
  SANDBOX_SPEC_INVALID: HttpStatus.BAD_REQUEST,
  SANDBOX_QUOTA_EXCEEDED: 429,
  SANDBOX_INFRA_FAILED: HttpStatus.SERVICE_UNAVAILABLE, // 2026-10-18 开发域真化首批抛点（沙箱/宿主执行环境不可用）
  IDENTITY_AUTH_FAILED: HttpStatus.UNAUTHORIZED,
  RELEASE_NOT_IMPLEMENTED: HttpStatus.NOT_IMPLEMENTED,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** 统一错误壳：{ error: { code, message, target?, details? } }（LLD-5 §1.4 ApiError） */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DomainError) {
      res.status(HTTP_BY_CODE[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: {
          code: exception.code,
          message: exception.message,
          target: exception.target,
          ...(exception.details !== undefined ? { details: exception.details } : {}),
        },
      });
      return;
    }
    if (exception instanceof HttpException) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    // W2-056：body-parser 超限（type=entity.too.large）映射 413 + 闭集码 VALIDATION_FAILED 人话（不加码）
    const raw = exception as { type?: string };
    if (raw?.type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'VALIDATION_FAILED', message: '请求体超出大小上限（2MB）；超长文档请分章节保存', target: 'payload' },
      });
      return;
    }
    console.warn('[filter] non-domain exception:', exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: '内部错误' },
    });
  }
}
