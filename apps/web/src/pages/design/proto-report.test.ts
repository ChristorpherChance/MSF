import { describe, expect, it } from 'vitest';
import { issueActions, summarizeCoverage } from './proto-report';

describe('summarizeCoverage（原型检查报告覆盖结论口径）', () => {
  it('ui 册承接 = 去重锚点 /（承接 + 报告未承接）；页渲染 = assembled/总页数', () => {
    const s = summarizeCoverage({
      pages: [
        { code: 'P-001', state: 'assembled', uiRef: { anchor: '一、页面清单' } },
        { code: 'P-002', state: 'pending', uiRef: { anchor: 'u-2 导航' } },
        { code: 'P-HOME', state: 'none', uiRef: null },
      ],
      issues: [{ code: 'UI_SECTION_UNMAPPED' }, { code: 'UI_SECTION_UNMAPPED' }, { code: 'PAGE_MISSING' }],
    });
    expect(s).toEqual({ uiCovered: 2, uiTotal: 4, assembled: 1, pageTotal: 3 });
  });

  it('旧目录口径（无 ui 引用且报告无未承接）→ 不评（null）', () => {
    const s = summarizeCoverage({
      pages: [{ code: 'P-001', state: 'assembled', uiRef: null }],
      issues: [{ code: 'PAGE_MISSING' }],
    });
    expect(s.uiCovered).toBeNull();
    expect(s.uiTotal).toBeNull();
  });

  it('同名章节锚点去重（一页一锚点口径下两页同锚只算一次承接）', () => {
    const s = summarizeCoverage({
      pages: [
        { code: 'P-001', state: 'assembled', uiRef: { anchor: '同名单节' } },
        { code: 'P-002', state: 'assembled', uiRef: { anchor: '同名单节' } },
      ],
      issues: [],
    });
    expect(s.uiCovered).toBe(1);
    expect(s.uiTotal).toBe(1);
  });
});

describe('issueActions（报告行内处置动作路由）', () => {
  it('按 issue code 映射动作集合', () => {
    expect(issueActions('UI_SECTION_UNMAPPED')).toEqual(['add-page', 'replan']);
    expect(issueActions('PAGE_UI_UNMAPPED')).toEqual(['exempt']);
    expect(issueActions('PAGE_MISSING')).toEqual(['gen-page']);
    expect(issueActions('STATE_MISSING')).toEqual(['gen-page']);
    expect(issueActions('PROTOTYPE_DIRTY')).toEqual(['gen-page']);
    expect(issueActions('FLOW_REF_MISSING')).toEqual(['edit-flow']);
  });

  it('无定位信息的码（data-nav/未知）不给按钮，只留文字提示', () => {
    expect(issueActions('DATA_NAV_TARGET_MISSING')).toEqual([]);
    expect(issueActions('WHATEVER')).toEqual([]);
  });
});
