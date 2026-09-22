/**
 * UI 符合度评分纯函数（LLD-2 DSG-F05 权威伪代码逐行实现；REQ-414、BR-09）。
 * 规则要点：
 * - 分母冻结：期望矩阵（页面×视口×检查项）随设计基线不可变保存；评分只接受当前基线矩阵。
 * - 判定永远落在最小粒度（格→页→整体）逐层 AND；不以跨页平均掩盖单页不达标。
 * - 关键项 100%、每格一般项 ≥0.95、严重偏差 0、必测状态全覆盖、无 skipped/not-run/unknown。
 * - 空分母不产生 100%（total=0 → ratio=0 且构成阻断 issue）。
 * issue 子码闭集：LLD-3 §15(i)。
 */

export interface UiCheckDef {
  id: string;
  kind: string; // 检查类型（visual/state/…），证据 kind 须相符
  requiredState?: boolean; // state-* 必测状态项（general 内）
}

export interface UiMatrixCell {
  pageId: string;
  viewportId: string;
  criticalItems: UiCheckDef[];
  generalItems: UiCheckDef[];
}

export interface UiObserved {
  pageId?: string;
  viewportId?: string;
  checkId?: string;
  kind?: string;
  outcome?: string; // pass/fail/skipped/not-run；其他值 → UI_OUTCOME_UNKNOWN 按不通过计
}

export interface UiIssue {
  code: string;
  message: string;
  target?: string;
}

export interface UiDefect {
  pageId: string;
  viewportId: string;
  checkId: string;
  severity: 'critical' | 'major';
  hint: string; // 「修复候选实现并产生新构建」
}

export interface UiCellResult {
  pageId: string;
  viewportId: string;
  criticalTotal: number;
  criticalPass: number;
  generalTotal: number;
  generalPass: number;
  severeDeviations: number;
  skipped: number;
  notRun: number;
  passed: boolean;
}

export interface UiEvalResult {
  ok: boolean;
  issues: UiIssue[];
  defects: UiDefect[];
  cells: UiCellResult[];
  pages: Array<{ pageId: string; passed: boolean }>;
}

const VALID_OUTCOMES = new Set(['pass', 'fail', 'skipped', 'not-run']);
const GENERAL_MIN = 0.95; // generalVisualComplianceMin

export function evaluateUiEvidence(matrix: UiMatrixCell[], observed: UiObserved[]): UiEvalResult {
  const issues: UiIssue[] = [];
  const defects: UiDefect[] = [];
  const cells: UiCellResult[] = [];

  // F05-1.2 分母合法性：格唯一、集合非空、项不重复
  const cellKeys = new Set<string>();
  for (const cell of matrix) {
    const key = `${cell.pageId}:${cell.viewportId}`;
    if (cellKeys.has(key)) {
      issues.push({ code: 'UI_CHECK_DEFINITION_MISMATCH', message: `期望矩阵格重复 ${key}`, target: key });
    }
    cellKeys.add(key);
    if (cell.criticalItems.length === 0) {
      issues.push({ code: 'UI_CRITICAL_EMPTY', message: `关键项集合为空（分母非法）`, target: key });
    }
    if (cell.generalItems.length === 0) {
      issues.push({ code: 'UI_GENERAL_EMPTY', message: `一般项集合为空（分母非法）`, target: key });
    }
    const ids = [...cell.criticalItems, ...cell.generalItems].map((c) => c.id);
    if (new Set(ids).size !== ids.length) {
      issues.push({ code: 'UI_CHECK_DEFINITION_MISMATCH', message: `分母检查项重复`, target: key });
    }
  }

  // F05-1.3 观察证据核对：身份齐全、同键不重、kind 相符
  const observedByKey = new Map<string, UiObserved>();
  for (const row of observed) {
    if (!row.pageId || !row.viewportId || !row.checkId) {
      issues.push({ code: 'UI_OBSERVED_IDENTITY_INVALID', message: '证据行缺 pageId/viewportId/checkId' });
      continue;
    }
    const key = `${row.pageId}:${row.viewportId}:${row.checkId}`;
    if (observedByKey.has(key)) {
      issues.push({ code: 'UI_CHECK_DUPLICATE', message: `同一键证据重复 ${key}`, target: key });
      continue;
    }
    observedByKey.set(key, row);
  }

  const denominatorKeys = new Set<string>();
  for (const cell of matrix) {
    for (const c of [...cell.criticalItems, ...cell.generalItems]) {
      denominatorKeys.add(`${cell.pageId}:${cell.viewportId}:${c.id}`);
    }
  }
  for (const key of observedByKey.keys()) {
    if (!denominatorKeys.has(key)) {
      issues.push({ code: 'UI_CHECK_EXTRA', message: `分母外证据 ${key}`, target: key });
    }
  }

  // F05-2 逐格判定
  for (const cell of matrix) {
    let criticalPass = 0;
    let generalPass = 0;
    let severe = 0;
    let skipped = 0;
    let notRun = 0;
    let stateCovered = true;

    const evalItem = (def: UiCheckDef, isCritical: boolean): void => {
      const key = `${cell.pageId}:${cell.viewportId}:${def.id}`;
      const row = observedByKey.get(key);
      if (!row) {
        issues.push({ code: 'UI_CHECK_MISSING', message: `缺少检查证据 ${def.id}`, target: key });
      }
      if (row && row.kind !== undefined && row.kind !== def.kind) {
        issues.push({ code: 'UI_CHECK_KIND_MISMATCH', message: `证据 kind 与分母定义不符 ${def.id}`, target: key });
      }
      let status = row ? (row.outcome ?? 'unknown') : 'not-run';
      if (!VALID_OUTCOMES.has(status)) {
        issues.push({ code: 'UI_OUTCOME_UNKNOWN', message: `结果未知不能充作已测 ${def.id}`, target: key });
        status = 'unknown-not-pass'; // 按不通过计
      }
      if (status === 'skipped') skipped++;
      if (status === 'not-run') notRun++;
      if (status !== 'pass') {
        if (isCritical) severe++; // 关键项非 pass = 严重偏差
        defects.push({
          pageId: cell.pageId,
          viewportId: cell.viewportId,
          checkId: def.id,
          severity: isCritical ? 'critical' : 'major',
          hint: '修复候选实现并产生新构建',
        });
        if (def.requiredState && !isCritical) stateCovered = false; // 必测状态项仅一般项内（F05-2）
      } else if (isCritical) {
        criticalPass++;
      } else {
        generalPass++;
      }
    };

    for (const def of cell.criticalItems) evalItem(def, true);
    for (const def of cell.generalItems) evalItem(def, false);

    // 空分母不产生 100%：total=0 → ratio=0
    const criticalRatio = cell.criticalItems.length === 0 ? 0 : criticalPass / cell.criticalItems.length;
    const generalRatio = cell.generalItems.length === 0 ? 0 : generalPass / cell.generalItems.length;

    const passed =
      criticalRatio === 1 &&
      generalRatio >= GENERAL_MIN &&
      stateCovered &&
      severe === 0 &&
      skipped === 0 &&
      notRun === 0;

    cells.push({
      pageId: cell.pageId,
      viewportId: cell.viewportId,
      criticalTotal: cell.criticalItems.length,
      criticalPass,
      generalTotal: cell.generalItems.length,
      generalPass,
      severeDeviations: severe,
      skipped,
      notRun,
      passed,
    });
  }

  // 页面通过 ⟺ 全部适用视口通过；整体 ⟺ issues 空 ∧ 页非空 ∧ 每页通过
  const byPage = new Map<string, boolean>();
  for (const c of cells) byPage.set(c.pageId, (byPage.get(c.pageId) ?? true) && c.passed);
  const pages = [...byPage.entries()].map(([pageId, passed]) => ({ pageId, passed }));
  const ok = issues.length === 0 && pages.length > 0 && pages.every((p) => p.passed);

  return { ok, issues, defects, cells, pages };
}
