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
    console.warn('[filter] non-domain exception:', exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: '内部错误' },
    });
  }
}
