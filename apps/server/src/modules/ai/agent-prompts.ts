/**
 * Agent 三层链运行时解析与装配（2026-10-12，设计 §1；Task 2）：
 * 每层独立解析——ai_prompt_versions is_current 用户版本（base_prompt+overlay_text 拼接）优先，
 * 无则代码基底（stage-guides DEFAULT_AGENTS）；零配置=纯基底（mock 期/未配置零阻断）。
 * 装配三层：assistant 全局基底 + 主（ctx）+ 子（doc_kind 命中；dev 恒叠加 dev.coding-std）。
 * 设置页 Agent prompt 从此是运行时真身（此前版本内容从未注入运行时，只盖戳 id）。
 * 读侧模块：不进命令事务（嵌套 LLM 纪律不涉及——纯 SELECT）。
 *
 * 上下文预算分档（2026-10-13，设计 §2；Task 3）：按会话解析到的模型 context_window 分三档
 * （wide ≥512k / standard 128k~512k / narrow <128k）；无模型/mock 期=wide（现状基线口径不变）。
 * 窄档裁剪只作用于子 Agent 叠加块（只留【职责】【反模式】段）——能力边界/工具签名/反模式
 * 永不进裁剪表；assistant 全局基底与主 Agent 窄档同权全段保留。
 */
import { query } from '../../db/pool.js';
import { DEFAULT_AGENT_MAP } from './stage-guides.js';

export interface ResolvedAgent { key: string; text: string; versionId: string | null }

/** 三层链解析（设计 §1）：is_current 用户版本（base+overlay 拼接）→ 代码基底；零配置=纯基底 */
export async function resolveAgentPrompt(agentKey: string): Promise<ResolvedAgent> {
  const r = await query<{ id: string; base_prompt: string; overlay_text: string }>(
    'SELECT id, base_prompt, overlay_text FROM ai_prompt_versions WHERE agent_key=$1 AND is_current', [agentKey]);
  const v = r.rows[0];
  if (v) return { key: agentKey, text: v.overlay_text ? `${v.base_prompt}\n\n${v.overlay_text}` : v.base_prompt, versionId: v.id };
  const d = DEFAULT_AGENT_MAP[agentKey];
  return { key: agentKey, text: d?.prompt ?? '', versionId: null };
}

/** 上下文分档（设计 §2；Task 3） */
export type ContextBand = 'wide' | 'standard' | 'narrow';

/** 无模型/mock 期=wide（306 基线口径不变）；窗口未知的真实模型按 128000 默认落 standard */
export function contextBand(contextWindow: number | null | undefined): ContextBand {
  if (contextWindow == null) return 'wide';
  if (contextWindow >= 512000) return 'wide';
  if (contextWindow >= 128000) return 'standard';
  return 'narrow';
}

/** 分档预算：wide=现状常量原位参数化（toolLog 接力回喂总预算/doc.read 正文截断阈值，字符） */
export const BAND_BUDGETS: Record<ContextBand, { toolLog: number; docRead: number }> = {
  wide: { toolLog: 80000, docRead: 12000 },
  standard: { toolLog: 40000, docRead: 8000 },
  narrow: { toolLog: 16000, docRead: 6000 },
};

/**
 * 窄档裁剪（设计 §2 裁段顺序钉死）：主/assistant/overlay 全保，role==='sub' 子 Agent
 * 只留【职责】【反模式】段（按行首段标题切；方法论/质量闸段裁掉）。
 * 空结果兜底：用户自发布版本无行首【职责】/【反模式】段标题时返回空串——装配层据此
 * 整块跳过注入，不得把空块或原文塞回去。
 */
export function narrowTrim(agentKey: string, text: string): string {
  if (DEFAULT_AGENT_MAP[agentKey]?.role !== 'sub') return text;
  const keep = text.split(/\n(?=【)/).filter((seg) => /^【(职责|反模式)/.test(seg));
  return keep.join('\n');
}

/** 装配产物（send() 装配一次同源消费：盖戳/指纹/注入，消除「盖戳版本 X、注入版本 Y」一致性窗口） */
export interface AssembledAgents { blocks: string[]; versionIds: string[]; stampId: string | null }

/**
 * 装配三层（assistant 全局基底 + 主（ctx）+ 子（doc_kind 命中；dev 恒叠加 coding-std））。
 * stampId=注入链首层用户版本 id（assistant→主→子取首个有用户版本者，全无=NULL）——盖戳口径；
 * versionIds=三层实际使用的全部用户版本 id（并入 input_fingerprint，审计溯源不缺层）。
 * band='narrow' 时对 role==='sub' 的子块套 narrowTrim（role==='overlay' 的 dev.coding-std
 * 不裁——编码规范是标准援引非方法论）。
 */
export async function assembleAgentBlocks(
  ctx: string | null,
  docKind: string | null,
  band: ContextBand = 'wide',
): Promise<AssembledAgents> {
  const keys: string[] = ['assistant'];
  if (ctx && DEFAULT_AGENT_MAP[ctx]) keys.push(ctx);
  if (ctx === 'dev') keys.push('dev.coding-std');
  else if (ctx && docKind && DEFAULT_AGENT_MAP[`${ctx}.${docKind}`]) keys.push(`${ctx}.${docKind}`);
  const resolved = await Promise.all(keys.map(resolveAgentPrompt));
  const texts = resolved.map((r) => (band === 'narrow' ? narrowTrim(r.key, r.text) : r.text));
  const blocks: string[] = [];
  if (texts[0]) blocks.push(`【全局基底】\n${texts[0]}`);
  if (texts[1]) blocks.push(`【角色与方法】\n${texts[1]}`);
  if (texts[2]) blocks.push(`【工件专项】\n${texts[2]}`);
  const versionIds = resolved.map((r) => r.versionId).filter((x): x is string => !!x);
  return { blocks, versionIds, stampId: versionIds[0] ?? null };
}
