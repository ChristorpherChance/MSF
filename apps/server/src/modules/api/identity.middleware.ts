import type { NextFunction, Request, Response } from 'express';

/**
 * 本地默认身份（REQ-707 本期最简：单写者纪律，RBAC 后续扩展；策略点就位）。
 * 数据与审计字段本期即按多用户设计——actor 恒为本地用户，但字段不省略。
 */
export interface Actor {
  kind: 'human';
  id: string;
}

const ACTOR = Symbol('msf.actor');

export function identityMiddleware(req: Request, _res: Response, next: NextFunction): void {
  (req as unknown as Record<symbol, Actor>)[ACTOR] = { kind: 'human', id: 'local' };
  next();
}

export function getActor(req: Request): Actor {
  return (
    (req as unknown as Record<symbol, Actor>)[ACTOR] ?? { kind: 'human', id: 'local' }
  );
}
