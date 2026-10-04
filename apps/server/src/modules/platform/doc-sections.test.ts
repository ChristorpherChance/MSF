/** normalizePatches 单测：mdToPatches 恒产 add 的归一化（锚点码命中/标题命中转 modify，未命中保持 add） */
import { describe, expect, it } from 'vitest';
import { mdToPatches, normalizePatches, splitSections } from './doc-sections.js';

const DOC = [
  '## 一、背景与目标',
  '',
  '项目背景若干。',
  '',
  '## CR-001 门户首页',
  '',
  '承接：R-001',
  '',
  '旧正文。',
  '',
  '## CR-002 检索',
  '',
  '承接：R-002',
].join('\n');

describe('normalizePatches', () => {
  it('锚点码命中（标题改写但 CR 码保留）→ 转 modify，old=既有节全文', () => {
    const patches = mdToPatches('## CR-001 门户首页（重写）\n\n承接：R-001\n\n新正文。');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('modify');
    expect(out[0]!.secId).toBe('s2');
    expect(out[0]!.old).toBe('承接：R-001\n\n旧正文。');
    expect(out[0]!.new).toContain('新正文。');
  });

  it('无锚点码节按标题精确匹配 → 转 modify', () => {
    const patches = mdToPatches('## 一、背景与目标\n\n新背景。');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out[0]!.type).toBe('modify');
    expect(out[0]!.secId).toBe('s1');
  });

  it('未命中保持 add；空正文节不转（modify 的 old⊆md 校验对空 old 必败，保 add 由人工处置）', () => {
    const patches = mdToPatches('## CR-009 全新条目\n\n承接：R-009');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out[0]!.type).toBe('add');
    const emptyDoc = '## CR-001 空节\n\n## CR-002 有内容\n\nx';
    const p2 = mdToPatches('## CR-001 空节\n\n补内容');
    const out2 = normalizePatches(p2, splitSections(emptyDoc));
    expect(out2[0]!.type).toBe('add'); // CR-001 节 md 为空 → 不转 modify
    const bare = normalizePatches(mdToPatches('## CR-002 检索'), splitSections(DOC));
    expect(bare[0]!.type).toBe('add'); // 裸标题（空 new）不转 modify——防整节正文被清空
  });

  it('归一化后的 modify 可被 applyPatch 接受（old 取自 splitSections 节 md，includes 校验必过）', async () => {
    const { applyPatch, joinSections } = await import('./doc-sections.js');
    const secs = splitSections(DOC);
    const [p] = normalizePatches(mdToPatches('## CR-002 检索\n\n承接：R-002\n\n支持手柄。'), secs);
    const applied = applyPatch(secs, p!);
    expect(applied).not.toBeNull();
    expect(joinSections(applied!)).toContain('支持手柄。');
    expect(joinSections(applied!)).not.toContain('承接：R-002\n\n承接：R-002'); // 不重复追加
  });
});

describe('withNumberedTitles（导出注入）', () => {
  it('标题注入派生编号、正文不动、RTM 锚点码保留在括号内', async () => {
    const { withNumberedTitles } = await import('./doc-sections.js');
    const out = withNumberedTitles([
      '## 一、功能需求', '', '引言。', '',
      '## CR-001 浏览器即开即玩', '', '承接：R-001',
    ].join('\n'));
    expect(out).toContain('## 一、功能需求');
    expect(out).toContain('## 1.1 浏览器即开即玩（CR-001）');
    expect(out).toContain('引言。'); // 大章正文保全
    expect(out).toContain('承接：R-001');
    expect(out).not.toContain('## CR-001 浏览器即开即玩\n'); // 原标题被替换
  });

  it('无大章（存量平铺文档）退化纯序号，锚点码仍入括号', async () => {
    const { withNumberedTitles } = await import('./doc-sections.js');
    const out = withNumberedTitles([
      '## CR-001 浏览器即开即玩', '', '承接：R-001', '',
      '## CR-002 双人同屏', '', '承接：R-002',
    ].join('\n'));
    expect(out).toContain('## 1. 浏览器即开即玩（CR-001）');
    expect(out).toContain('## 2. 双人同屏（CR-002）');
    expect(out).toContain('承接：R-002'); // 正文不动
  });
});
