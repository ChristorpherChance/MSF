/**
 * 原型检查报告：覆盖结论 + 行内处置动作（2026-10-17 易用性专项——报告从「纯文字列表」
 * 升级为「每行可直接处理」；纯函数便于 vitest 钉死口径，组件只负责接线）。
 *
 * 覆盖结论口径（近似值，报告卡已用「基于旧版本」tag 提示版本错配场景）：
 * - ui 册承接 = 当前目录页中带 ui 章节引用的去重锚点数 /（承接数 + 报告中 UI_SECTION_UNMAPPED 数）；
 *   目录无任何 ui 引用且报告无未承接（旧目录口径不检双向）→ 不显示该行。
 * - 页渲染 = 当前 plan 下状态为 assembled 的页数 / 目录总页数。
 */

export interface CoverageInput {
  pages: Array<{ code: string; state: 'none' | 'pending' | 'assembled'; uiRef?: { anchor: string | null } | null }>;
  issues: Array<{ code: string }>;
}

export interface CoverageSummary {
  /** null = 旧目录口径（无 ui refs）不评 */
  uiCovered: number | null;
  uiTotal: number | null;
  assembled: number;
  pageTotal: number;
}

export function summarizeCoverage({ pages, issues }: CoverageInput): CoverageSummary {
  const unmappedSecs = issues.filter((i) => i.code === 'UI_SECTION_UNMAPPED').length;
  const coveredAnchors = new Set(
    pages.filter((p) => p.uiRef?.anchor).map((p) => p.uiRef!.anchor),
  ).size;
  const hasUi = pages.some((p) => p.uiRef) || unmappedSecs > 0;
  return {
    uiCovered: hasUi ? coveredAnchors : null,
    uiTotal: hasUi ? coveredAnchors + unmappedSecs : null,
    assembled: pages.filter((p) => p.state === 'assembled').length,
    pageTotal: pages.length,
  };
}

/** 行内处置动作（按 issue code 路由；按钮文案/行为由组件决定，这里只钉「什么码配什么动作」） */
export type IssueAction = 'add-page' | 'replan' | 'exempt' | 'edit-flow' | 'gen-page';

export function issueActions(code: string): IssueAction[] {
  switch (code) {
    // 册有页无：补录一页（标题预填章节名）或重新规划
    case 'UI_SECTION_UNMAPPED': return ['add-page', 'replan'];
    // 页有册无：人工豁免（骨架/通用页）
    case 'PAGE_UI_UNMAPPED': return ['exempt'];
    // 页未渲染/缺状态/依据滞后（target 分别是 页码、页码/状态、页码——组件统一取页码部分）
    case 'PAGE_MISSING':
    case 'STATE_MISSING':
    case 'PROTOTYPE_DIRTY': return ['gen-page'];
    // 流程步骤引用了不存在的页/状态：编辑该流程
    case 'FLOW_REF_MISSING': return ['edit-flow'];
    // data-nav 目标缺失：缺定位到具体页的信息，只给文字提示
    default: return [];
  }
}
