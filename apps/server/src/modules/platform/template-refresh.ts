import type { DocTemplate } from './doc-templates.js';

/**
 * ⇄ 模板重排·共享件（2026-10-11，设计 doc/dev-plan/模板重排批量刷新-设计.md）：
 * 启发式判据+固定 instruction+kind 注册表。编排器见 template-refresh.service.ts。
 */

/** 批量重排固定 instruction（rewrite 通道骨架默认化已生效——重排语义由 prompt 钉死，此处只声明意图） */
export const REFRESH_INSTRUCTION =
  '按默认模板骨架重排整篇：内容按主题归入模板大章，保留有效锚点码与编号，不增删需求语义';

/** 大章标题提取：`## ` + 中文数字顿号（deriveNumbering 同口径；条目节/小节不算大章） */
export function chapterTitlesOf(content: string): string[] {
  return [...content.matchAll(/^##\s+([一二三四五六七八九十]+、[^\n]+)$/gm)].map((m) => m[1]!.trim());
}

/** 启发式「与模板不对版」：大章集合与模板骨架 缺章/多章/顺序或章名不符 任一命中即 true（只提示不拦截） */
export function detectSkeletonMismatch(content: string, t: DocTemplate): boolean {
  const actual = chapterTitlesOf(content);
  const expected = t.chapters.map((c) => c.title);
  if (actual.length !== expected.length) return true;
  return expected.some((title, i) => actual[i] !== title);
}
