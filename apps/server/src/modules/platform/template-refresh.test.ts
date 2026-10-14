import { describe, expect, it } from 'vitest';
import { anchorPrefixOf, auditSkeleton, chapterTitlesOf, REFRESH_INSTRUCTION } from './template-refresh.js';
import { codeDefaultTemplate } from './doc-templates.js';

/**
 * auditSkeleton 规则核对三维（2026-10-14，设计 doc/dev-plan/模板重排规则核对报告-设计.md §1）：
 * 大章对照三段式（防级联）+ 锚点码完整性 + 编号顺连续，人话行直接进弹窗明细。
 */
describe('template-refresh 规则核对 auditSkeleton', () => {
  const t = codeDefaultTemplate('hld')!;
  const chapters = t.chapters.map((c) => c.title); // 一、架构目标与约束/二、总体架构/三、架构视图/四、关键机制/五、风险与权衡/六、承接与映射
  const good = t.chapters.map((c) => `## ${c.title}\n\n内容`).join('\n\n');

  it('大章标题提取：只认 `## ` + 中文数字顿号（deriveNumbering 同口径）', () => {
    const titles = chapterTitlesOf(`# 标题\n\n## 一、背景与目标\n\n### 1.1 小节\n\n## 二、总体架构\n\n## CR-001 条目节`);
    expect(titles).toEqual(['一、背景与目标', '二、总体架构']);
  });

  it('anchorPrefixOf：CRD=CR/PRD=REQ；设计册=DSG_BOOK_LETTER 小写形态', () => {
    expect(anchorPrefixOf('crd')).toBe('CR');
    expect(anchorPrefixOf('prd')).toBe('REQ');
    expect(anchorPrefixOf('hld')).toBe('h');
    expect(anchorPrefixOf('nfr')).toBe('n');
  });

  it('1 完全对版（大章全同+锚点顺连续）→ issues 空', () => {
    const withAnchors = t.chapters.map((c, i) => `## ${c.title}\n\n## h-${i + 1} 条目\n\n内容`).join('\n\n');
    expect(auditSkeleton(withAnchors, chapters, 'h').issues).toEqual([]);
  });

  it('2 缺章→「缺失：模板第 N 章」；多章→「多余：模板无此章」', () => {
    const missing4 = good.replace('## 四、关键机制\n\n内容\n\n', '');
    const r1 = auditSkeleton(missing4, chapters, 'h');
    expect(r1.issues).toHaveLength(1);
    expect(r1.issues[0]).toBe('缺失：模板第 4 章『四、关键机制』');
    const extra7 = `${good}\n\n## 七、附录\n\nx`;
    const r2 = auditSkeleton(extra7, chapters, 'h');
    expect(r2.issues).toHaveLength(1);
    expect(r2.issues[0]).toBe('多余：『七、附录』模板无此章');
  });

  it('3 防级联：缺章且后续章顺延重编号 → 只报一条缺失，不连环报章名不符/多余', () => {
    // 删除「三、架构视图」且四五六顺延为三/四/五（名目不变）——三段式①按名目判集合差
    const renumbered = [
      '## 一、架构目标与约束', '## 二、总体架构', '## 三、关键机制', '## 四、风险与权衡', '## 五、承接与映射',
    ].map((h) => `${h}\n\n内容`).join('\n\n');
    const r = auditSkeleton(renumbered, chapters, 'h');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toContain('缺失');
    expect(r.issues[0]).toContain('架构视图');
  });

  it('4 共有章相对顺序颠倒 → 「顺序错位」行并点出首对错位章', () => {
    const swapped = good
      .replace('## 一、架构目标与约束', '## TMP')
      .replace('## 二、总体架构', '## 一、架构目标与约束')
      .replace('## TMP', '## 二、总体架构');
    const r = auditSkeleton(swapped, chapters, 'h');
    const orderLine = r.issues.find((s) => s.includes('顺序错位'));
    expect(orderLine).toBeDefined();
    expect(orderLine).toContain('架构目标与约束');
    expect(orderLine).toContain('总体架构');
    expect(r.issues.some((s) => s.includes('缺失') || s.includes('多余'))).toBe(false);
  });

  it('5 无缺失无多余但同位章名不同（编号漂移）→ 「章名不符」行', () => {
    // 名目全集与模板一致（①无差异），仅末章编号 六→七（③逐位比对命中）
    const drift = good.replace('## 六、承接与映射', '## 七、承接与映射');
    const r = auditSkeleton(drift, chapters, 'h');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toContain('章名不符');
    expect(r.issues[0]).toContain('六、承接与映射');
    expect(r.issues[0]).toContain('七、承接与映射');
  });

  it('6 锚点重复必报；有条目节但零锚点 → 「条目节缺锚点码」一行', () => {
    const dup = `${good}\n\n## h-1 条目甲\n\nx\n\n## h-1 条目乙\n\ny`;
    const r1 = auditSkeleton(dup, chapters, 'h');
    expect(r1.issues).toHaveLength(1);
    expect(r1.issues[0]).toContain('锚点码重复');
    expect(r1.issues[0]).toContain('h-1');
    // 合法大章 + 无码条目节（若大章亦不合法，优先级闸先火则测不到此行）
    const noAnchor = `${good}\n\n## 无码条目节标题\n\nx`;
    const r2 = auditSkeleton(noAnchor, chapters, 'h');
    expect(r2.issues).toHaveLength(1);
    expect(r2.issues[0]).toContain('条目节缺锚点码');
  });

  it('7 编号空洞产行（数值比较：CR-001=1 三位零填充只是显示形态；首号非 1 也算空洞）', () => {
    const gap = `${good}\n\n## h-1 甲\n\nx\n\n## h-2 乙\n\ny\n\n## h-4 丁\n\nz`;
    const r1 = auditSkeleton(gap, chapters, 'h');
    expect(r1.issues).toEqual(['编号不连续：缺 h-3']);
    // 需求域三位零填充不算断号
    const crd = `## 一、背景与目标\n\n## CR-001 甲\n\nx\n\n## CR-002 乙\n\ny`;
    expect(auditSkeleton(crd, ['一、背景与目标'], 'CR').issues).toEqual([]);
    // 首号非 1 也算空洞
    const fromTwo = `${good}\n\n## h-2 乙\n\ny\n\n## h-3 丙\n\nz`;
    expect(auditSkeleton(fromTwo, chapters, 'h').issues).toEqual(['编号不连续：缺 h-1']);
  });

  it('8 优先级闸：大章编号不规范（有 ## 标题但无合规大章）→ 只报一行且第 1 维零行', () => {
    const malformed = `## 第一章 背景\n\nx\n\n## 第二章 架构\n\ny`;
    const r = auditSkeleton(malformed, chapters, 'h');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toContain('大章编号不规范');
    expect(r.issues.some((s) => s.includes('缺失'))).toBe(false); // 不双报
  });

  it('固定 instruction 文案（契约：编排器单点持有，req/design 处理器共享）', () => {
    expect(REFRESH_INSTRUCTION).toContain('模板骨架');
    expect(REFRESH_INSTRUCTION).toContain('保留');
  });
});
