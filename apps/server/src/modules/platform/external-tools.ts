/**
 * 外部工具注册表（模块级 Map，镜像 evidence/command-bus registerCommand 先例，零模块图边）：
 * 供含长耗时嵌套调用（如 LLM）的 dock 工具绕过 ai.tool.invoke 命令事务执行——
 * 事务/池连接内绝不跑 LLM。owner 模块（如 req）onModuleInit 注册 handler；
 * ai 编排层流末 runToolBlocks 先查本表，命中走旁路（handler 无事务 → 内部命令独立事务），
 * 未命中走 ai.tool.invoke 不变。旁路留痕=ai_tool_calls（recordDirect）+ 内部命令审计行（无 ai.tool.invoke 审计行）。
 */
import type { CommandContext } from '../evidence/command-bus.js';

export interface ExternalToolCall {
  sessionId?: string | undefined;
  messageId?: string | undefined;
  args: Record<string, unknown>;
}

/**
 * 契约（编排层 runToolBlocks 旁路按此留痕）：
 * - resolve 出 `{ ok: false, ... }` → ai_tool_calls.status='failed'（resultSummary=返回值原文）
 * - resolve 其它对象（含 `{ ok: true }` / 无 ok 字段）→ status='ok'
 * - 抛错 → status='failed'，resultSummary={ error: message }
 * - 返回 undefined/非对象属类型违规（编排层按 ok 读取，留痕形状未定义，勿依赖）
 */
export type ExternalToolHandler = (
  projectId: string,
  call: ExternalToolCall,
  ctx: CommandContext,
) => Promise<Record<string, unknown>>;
const handlers = new Map<string, ExternalToolHandler>();

/** 注册外部工具 handler（启动期；重复注册拒绝） */
export function registerExternalTool(name: string, handler: ExternalToolHandler): void {
  if (handlers.has(name)) throw new Error(`外部工具重复注册: ${name}`);
  handlers.set(name, handler);
}

export function getExternalTool(name: string): ExternalToolHandler | undefined {
  return handlers.get(name);
}

/** 测试用：清空注册表 */
export function resetExternalTools(): void {
  handlers.clear();
}
