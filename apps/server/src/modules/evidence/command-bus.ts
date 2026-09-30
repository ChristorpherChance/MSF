import { DomainError, type ActorKind } from '@msf/shared';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../db/pool.js';
import { appendAudit } from './audit.service.js';
import { isCommand, type CommandName } from './commands.js';

/** 命令上下文（身份四元组的最小形态；异步操作四元组见 LLD-2 DSG-F01-2，M4 扩展） */
export interface CommandContext {
  projectId: string | null;
  actorKind: ActorKind;
  actorId: string;
}

type CommandHandler = (client: PoolClient, payload: unknown, ctx: CommandContext) => Promise<unknown>;

const handlers = new Map<CommandName, CommandHandler>();

/** 注册命令处理器（启动期；重复注册拒绝） */
export function registerCommand(name: CommandName, handler: CommandHandler): void {
  if (handlers.has(name)) throw new DomainError('COMMAND_UNKNOWN', `命令重复注册: ${name}`);
  handlers.set(name, handler);
}

/**
 * CommandBus：全部写操作的唯一入口（BR-01/BR-04；LLD-7 N06-3 四件套）。
 * 未注册命令拒绝；执行在单事务内，审计追加同事务（审计失败零写）。
 */
export async function executeCommand(
  name: string,
  payload: unknown,
  ctx: CommandContext,
): Promise<unknown> {
  if (!isCommand(name)) throw new DomainError('COMMAND_UNKNOWN', `未注册命令: ${name}`);
  const handler = handlers.get(name);
  if (!handler) throw new DomainError('COMMAND_UNKNOWN', `命令无处理器: ${name}`);
  return inTransaction(async (client) => {
    // W2-037：归档项目全域只读——项目级写命令一律拒绝（平台项目命令自带状态校验，不在此拦）
    if (ctx.projectId && !name.startsWith('platform.project.')) {
      const st = await client.query<{ status: string }>('SELECT status FROM projects WHERE id=$1', [ctx.projectId]);
      if (st.rows[0]?.status === 'archived') {
        throw new DomainError('INVALID_STATE', '项目已归档（只读），写操作被拒绝', ctx.projectId);
      }
    }
    const result = await handler(client, payload, ctx);
    await appendAudit(client, {
      projectId: ctx.projectId,
      actorKind: ctx.actorKind,
      actorId: ctx.actorId,
      command: name,
      payload,
    });
    return result;
  });
}

/** 测试用：清空处理器表 */
export function resetCommands(): void {
  handlers.clear();
}
