/** UI 评分纯函数单测（F05-1/2；契约§11 反例行覆盖） */
import { describe, expect, it } from 'vitest';
import { evaluateUiEvidence, type UiMatrixCell, type UiObserved } from './ui-score.js';

const MATRIX: UiMatrixCell[] = [
  {
    pageId: 'P-001',
    viewportId: 'vp-1440',
    criticalItems: [{ id: 'c-layout', kind: 'visual' }, { id: 'c-nav', kind: 'visual' }],
    generalItems: [
      { id: 'g-color', kind: 'visual' },
      { id: 'state-hover', kind: 'state', requiredState: true },
    ],
  },
  {
    pageId: 'P-001',
    viewportId: 'vp-390',
    criticalItems: [{ id: 'c-layout', kind: 'visual' }],
    generalItems: [{ id: 'g-color', kind: 'visual' }],
  },
];

const passAll: UiObserved[] = [
  { pageId: 'P-001', viewportId: 'vp-1440', checkId: 'c-layout', kind: 'visual', outcome: 'pass' },
  { pageId: 'P-001', viewportId: 'vp-1440', checkId: 'c-nav', kind: 'visual', outcome: 'pass' },
  { pageId: 'P-001', viewportId: 'vp-1440', checkId: 'g-color', kind: 'visual', outcome: 'pass' },
  { pageId: 'P-001', viewportId: 'vp-1440', checkId: 'state-hover', kind: 'state', outcome: 'pass' },
  { pageId: 'P-001', viewportId: 'vp-390', checkId: 'c-layout', kind: 'visual', outcome: 'pass' },
  { pageId: 'P-001', viewportId: 'vp-390', checkId: 'g-color', kind: 'visual', outcome: 'pass' },
];

describe('evaluateUiEvidence（DSG-F05）', () => {
  it('全 pass → ok', () => {
    const r = evaluateUiEvidence(MATRIX, passAll);
    expect(r.ok).toBe(true);
    expect(r.issues).toHaveLength(0);
    expect(r.pages).toEqual([{ pageId: 'P-001', passed: true }]);
  });

  it('单视口缺证据 → not-run 保留分母且该页 fail（公众页漏测移动视口反例）', () => {
    const obs = passAll.filter((o) => o.viewportId !== 'vp-390');
    const r = evaluateUiEvidence(MATRIX, obs);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'UI_CHECK_MISSING')).toBe(true);
    const cell = r.cells.find((c) => c.viewportId === 'vp-390')!;
    expect(cell.notRun).toBe(2);
    expect(cell.passed).toBe(false);
    expect(r.pages[0]!.passed).toBe(false); // 不以跨页平均掩盖
  });

  it('关键项 99% 仍 fail 且计严重偏差', () => {
    const obs = passAll.map((o) =>
      o.viewportId === 'vp-1440' && o.checkId === 'c-nav' ? { ...o, outcome: 'fail' } : o,
    );
    const r = evaluateUiEvidence(MATRIX, obs);
    const cell = r.cells.find((c) => c.viewportId === 'vp-1440')!;
    expect(cell.criticalPass).toBe(1);
    expect(cell.severeDeviations).toBe(1);
    expect(cell.passed).toBe(false);
    expect(r.defects.some((d) => d.severity === 'critical' && d.checkId === 'c-nav')).toBe(true);
  });

  it('skip/unknown 不算已测', () => {
    const obs = passAll.map((o) =>
      o.checkId === 'state-hover' ? { ...o, outcome: 'skipped' } : o,
    );
    const r = evaluateUiEvidence(MATRIX, obs);
    expect(r.ok).toBe(false);
    expect(r.cells.find((c) => c.viewportId === 'vp-1440')!.skipped).toBe(1);

    const obs2 = passAll.map((o) => (o.checkId === 'g-color' && o.viewportId === 'vp-390' ? { ...o, outcome: 'mystery' } : o));
    const r2 = evaluateUiEvidence(MATRIX, obs2);
    expect(r2.issues.some((i) => i.code === 'UI_OUTCOME_UNKNOWN')).toBe(true);
    expect(r2.ok).toBe(false);
  });

  it('分母合法性：空关键项/空一般项/重复证据/分母外证据', () => {
    const r = evaluateUiEvidence(
      [{ pageId: 'P', viewportId: 'v', criticalItems: [], generalItems: [] }],
      [
        { pageId: 'P', viewportId: 'v', checkId: 'x', kind: 'visual', outcome: 'pass' },
        { pageId: 'P', viewportId: 'v', checkId: 'x', kind: 'visual', outcome: 'pass' },
        { pageId: 'P', viewportId: 'v', outcome: 'pass' }, // 身份不全
      ],
    );
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('UI_CRITICAL_EMPTY');
    expect(codes).toContain('UI_GENERAL_EMPTY');
    expect(codes).toContain('UI_CHECK_EXTRA');
    expect(codes).toContain('UI_CHECK_DUPLICATE');
    expect(codes).toContain('UI_OBSERVED_IDENTITY_INVALID');
    expect(r.ok).toBe(false);
  });

  it('kind 不符 → UI_CHECK_KIND_MISMATCH 且按不通过计', () => {
    const obs = passAll.map((o) => (o.checkId === 'c-layout' && o.viewportId === 'vp-1440' ? { ...o, kind: 'a11y' } : o));
    const r = evaluateUiEvidence(MATRIX, obs);
    expect(r.issues.some((i) => i.code === 'UI_CHECK_KIND_MISMATCH')).toBe(true);
    expect(r.ok).toBe(false);
  });
});
