/** structuralIssueCount 前端单测（规格 §4 M3 第二钉「滞后进计数不进默认勾选」——
 *  纯前端推导服务端钉不到，故钉在此；仓内首个前端 vitest 用例） */
import { describe, expect, it } from 'vitest';
import { structuralIssueCount } from '../api';

describe('structuralIssueCount（默认勾选判定：剔除尾部滞后行）', () => {
  it('滞后行在尾部时计数剔除：结构 2 行 + 滞后 1 行 → 2', () => {
    const report = {
      issues: ['缺失大章「六、术语表」', '锚点码 CR-003 重复', '上游 CRD 已提交 v2（本册基于 v1）——重排只动结构不动内容，建议先对话改文档同步内容再重排'],
      upstreamStale: true,
    };
    expect(structuralIssueCount(report)).toBe(2);
  });

  it('无滞后行时全计：结构 2 行且 upstreamStale=false → 2', () => {
    const report = { issues: ['缺失大章「六、术语表」', '条目节缺锚点码'], upstreamStale: false };
    expect(structuralIssueCount(report)).toBe(2);
  });

  it('纯滞后（结构零问题）计数=0 → 不默认勾', () => {
    const report = {
      issues: ['上游 PRD 已提交 v3（本册基于 v2）——重排只动结构不动内容，建议先对话改文档同步内容再重排'],
      upstreamStale: true,
    };
    expect(structuralIssueCount(report)).toBe(0);
  });
});
