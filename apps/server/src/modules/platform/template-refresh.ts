import { DSG_BOOK_LETTER } from './rtm-health.js';

/**
 * ⇄ 模板重排·共享件（2026-10-11，设计 doc/dev-plan/模板重排批量刷新-设计.md）：
 * 规则核对+固定 instruction+kind 注册表。编排器见 template-refresh.service.ts。
 * 2026-10-14：detectSkeletonMismatch（布尔启发式）退役，升级为 auditSkeleton 规则核对报告
 * （设计 doc/dev-plan/模板重排规则核对报告-设计.md §1，人话问题行直接进弹窗明细）。
 */

/** 批量重排固定 instruction（rewrite 通道骨架默认化已生效——重排语义由 prompt 钉死，此处只声明意图） */
export const REFRESH_INSTRUCTION =
  '按默认模板骨架重排整篇：内容按主题归入模板大章，保留有效锚点码与编号，不增删需求语义';

/** 大章标题提取：`## ` + 中文数字顿号（deriveNumbering 同口径；条目节/小节不算大章） */
export function chapterTitlesOf(content: string): string[] {
  return [...content.matchAll(/^##\s+([一二三四五六七八九十]+、[^\n]+)$/gm)].map((m) => m[1]!.trim());
}

/** auditSkeleton 报告（设计 §1）：issues 空=对版；人话行直接进弹窗明细 */
export interface SkeletonAudit { issues: string[] }

/**
 * kind → 条目节锚点码前缀：CRD='CR'/PRD='REQ'；设计册=chapter_prefix 单字母（h/o/g/k/d/a/u/n）。
 * DSG_BOOK_LETTER 是大写（RTM 册级锚 DSG-H），chapter_prefix 是小写（h-*）——同一组字母两种规格形态
 * （doc-templates.ts:289 同口径）。platform 跨域禁令下不取 design 域 DESIGN_BOOKS，复用 rtm-health 单点。
 */
export function anchorPrefixOf(kind: string): string {
  if (kind === 'crd') return 'CR';
  if (kind === 'prd') return 'REQ';
  return (DSG_BOOK_LETTER[kind] ?? kind).toLowerCase();
}

/** 大章名目比对键：去「中文数字、」前缀——删章后顺延重编号名目不变，按名目判集合差防级联误报 */
function chapterKey(title: string): string {
  return title.replace(/^[一二三四五六七八九十]+、/, '').trim();
}

/**
 * 四维之结构三维（纯函数）：大章对照三段式 + 锚点码完整性 + 编号规范。
 * anchorPrefix：CRD='CR'/PRD='REQ'/设计册=chapter_prefix 单字母（h/o/g/k/d/a/u/n），
 * 条目节标题形态 `## {prefix}-{数字} 标题`（需求域三位数 CR-001/REQ-001，设计册 h-1）。
 * 判据权威：doc-conventions.ts reqSectionRule/designSectionRule 与 CHAPTER_RULE。
 */
export function auditSkeleton(content: string, templateChapters: string[], anchorPrefix: string): SkeletonAudit {
  const issues: string[] = [];
  const actual = chapterTitlesOf(content);

  // 优先级闸：有 `## ` 标题但无一合规大章 → 整体提前返回（闸场景下所有 `## ` 标题都是 malformed 大章
  // 而非条目节，同根因不双报——锚点/条目节/编号维度全不跑）
  if (actual.length === 0 && /^##\s+/m.test(content)) {
    return { issues: ['大章编号不规范（大章须用中文数字序号+顿号，如 一、xxx）'] };
  }

  // —— 第 1 维：大章对照三段式（钉死防级联） ——
  const actualKeys = actual.map(chapterKey);
  const expectedKeys = templateChapters.map(chapterKey);
  const actualKeySet = new Set(actualKeys);
  const expectedKeySet = new Set(expectedKeys);
  // ① 集合差：模板有文档无=缺失；文档有模板无=多余（各带章名）
  const missing = templateChapters.filter((title) => !actualKeySet.has(chapterKey(title)));
  const extra = actual.filter((title) => !expectedKeySet.has(chapterKey(title)));
  for (const m of missing) {
    issues.push(`缺失：模板第 ${templateChapters.indexOf(m) + 1} 章『${m}』`);
  }
  for (const e of extra) {
    issues.push(`多余：『${e}』模板无此章`);
  }
  // ② 共有章（名目交集）相对顺序比较，点出首对错位章
  const actualCommon = actualKeys.filter((k) => expectedKeySet.has(k));
  const expectedCommon = expectedKeys.filter((k) => actualKeySet.has(k));
  const sameOrder = actualCommon.length === expectedCommon.length
    && actualCommon.every((k, i) => k === expectedCommon[i]);
  if (!sameOrder) {
    const i = actualCommon.findIndex((k, j) => k !== expectedCommon[j]);
    issues.push(`顺序错位：『${expectedCommon[i]}』应排在『${actualCommon[i]}』之前（与模板相对顺序不符）`);
  }
  // ③ 逐位章名比对：仅当①无缺失无多余（位置对齐）时进行——①有差异跳过③，不报连环「章名不符」
  if (missing.length === 0 && extra.length === 0 && actual.length === templateChapters.length) {
    for (let i = 0; i < actual.length; i++) {
      if (actual[i] !== templateChapters[i]) {
        issues.push(`章名不符：第 ${i + 1} 章应为『${templateChapters[i]}』实为『${actual[i]}』`);
      }
    }
  }

  // —— 第 2 维：锚点码完整性（正则分域钉死：CRD CR-\d+/PRD REQ-\d+/设计册 {prefix}-\d+） ——
  const esc = anchorPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const anchors = [...content.matchAll(new RegExp(`^## (${esc}-\\d+)\\s`, 'gm'))].map((m) => m[1]!);
  const counts = new Map<string, number>();
  for (const a of anchors) counts.set(a, (counts.get(a) ?? 0) + 1);
  for (const [code, n] of counts) {
    if (n > 1) issues.push(`锚点码重复：『${code}』出现 ${n} 次`);
  }
  if (anchors.length === 0) {
    const allH2 = content.match(/^##\s+/gm)?.length ?? 0;
    if (allH2 > actual.length) { // 存在非大章 `## ` 级标题（疑似条目节）但零锚点码
      issues.push(`条目节缺锚点码：存在疑似条目节（## 级标题）但全文无 ${anchorPrefix}-n 锚点码`);
    }
  }

  // —— 第 3 维：编号顺连续（数值比较：CR-001=1，三位零填充只是显示形态不算断号；首号非 1 也算空洞） ——
  if (anchors.length > 0) {
    const nums = new Set(anchors.map((a) => parseInt(a.slice(anchorPrefix.length + 1), 10)));
    const max = Math.max(...nums);
    for (let n = 1; n <= max; n++) { // 重复码第 2 维已报，此维只报空洞不重复报
      if (!nums.has(n)) issues.push(`编号不连续：缺 ${anchorPrefix}-${n}`);
    }
  }

  return { issues }; // 行序=维度序（大章→锚点→编号）
}
