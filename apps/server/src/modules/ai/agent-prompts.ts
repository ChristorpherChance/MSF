/**
 * Agent 三层链运行时解析与装配（2026-10-12，设计 §1；Task 2）：
 * 每层独立解析——ai_prompt_versions is_current 用户版本（base_prompt+overlay_text 拼接）优先，
 * 无则代码基底（stage-guides DEFAULT_AGENTS）；零配置=纯基底（mock 期/未配置零阻断）。
 * 装配三层：assistant 全局基底 + 主（ctx）+ 子（doc_kind 命中；dev 恒叠加 dev.coding-std）。
 * 设置页 Agent prompt 从此是运行时真身（此前版本内容从未注入运行时，只盖戳 id）。
 * 读侧模块：不进命令事务（嵌套 LLM 纪律不涉及——纯 SELECT）。
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

/**
 * 装配三层（assistant 全局基底 + 主（ctx）+ 子（doc_kind 命中；dev 恒叠加 coding-std））。
 * stampId=注入链首层用户版本 id（assistant→主→子取首个有用户版本者，全无=NULL）——盖戳口径；
 * versionIds=三层实际使用的全部用户版本 id（并入 input_fingerprint，审计溯源不缺层）。
 */
export async function assembleAgentBlocks(ctx: string | null, docKind: string | null): Promise<{
  blocks: string[]; versionIds: string[]; stampId: string | null;
}> {
  const keys: string[] = ['assistant'];
  if (ctx && DEFAULT_AGENT_MAP[ctx]) keys.push(ctx);
  if (ctx === 'dev') keys.push('dev.coding-std');
  else if (ctx && docKind && DEFAULT_AGENT_MAP[`${ctx}.${docKind}`]) keys.push(`${ctx}.${docKind}`);
  const resolved = await Promise.all(keys.map(resolveAgentPrompt));
  const blocks: string[] = [];
  if (resolved[0]!.text) blocks.push(`【全局基底】\n${resolved[0]!.text}`);
  if (resolved[1]?.text) blocks.push(`【角色与方法】\n${resolved[1].text}`);
  if (resolved[2]?.text) blocks.push(`【工件专项】\n${resolved[2].text}`);
  const versionIds = resolved.map((r) => r.versionId).filter((x): x is string => !!x);
  return { blocks, versionIds, stampId: versionIds[0] ?? null };
}
