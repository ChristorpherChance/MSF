/**
 * 命令注册表（封闭枚举，LLD-7 N06-3 四件套之一：先注册后使用）。
 * 命令名小写点式，域前缀对齐 LLD-3 DSG-C10-2 分组。
 * M0 仅注册基座命令；各领域命令随里程碑追加（新增命令=注册+审计映射+效果定义+自动化测试）。
 */
export const COMMANDS = [
  'platform.project.create',
  'platform.project.update',
  'platform.project.archive',
  'policy.gate.set_mode',
  'health.ping', // M0 冒烟用，无副作用
] as const;
export type CommandName = (typeof COMMANDS)[number];

const set: ReadonlySet<string> = new Set(COMMANDS);
export const isCommand = (s: string): s is CommandName => set.has(s);
