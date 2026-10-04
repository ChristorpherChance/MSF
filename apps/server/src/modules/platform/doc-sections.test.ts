/** normalizePatches 单测：mdToPatches 恒产 add 的归一化（锚点码命中/标题命中转 modify，未命中保持 add） */
import { describe, expect, it } from 'vitest';
import { applyPatch, mdToPatches, normalizePatches, splitSections } from './doc-sections.js';

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

describe('mdToPatches add 落位锚点 after（整篇重生成大章按模型输出顺序落位）', () => {
  it('首节 after=\'\'，后续节 after=前一节标题；## 前的 h1/前言不成补丁', () => {
    const text = [
      '# 客户需求文档', '', '前言若干（不属于任何节）。', '',
      '## 一、背景与目标', '', '背景。', '',
      '## CR-001 门户首页', '', '承接：R-001', '',
      '## 二、功能需求', '', '功能引言。', '',
      '## CR-002 检索', '', '承接：R-002',
    ].join('\n');
    const patches = mdToPatches(text);
    expect(patches.map((p) => p.title)).toEqual(['一、背景与目标', 'CR-001 门户首页', '二、功能需求', 'CR-002 检索']);
    expect(patches.map((p) => p.after)).toEqual(['', '一、背景与目标', 'CR-001 门户首页', '二、功能需求']);
    expect(patches.every((p) => p.type === 'add')).toBe(true);
  });

  it('无 h1/前言（文本直接以 ## 起）首节仍 after=\'\'', () => {
    const patches = mdToPatches('## 一、背景与目标\n\n背景。\n\n## CR-001 门户首页\n\n承接：R-001');
    expect(patches.map((p) => p.after)).toEqual(['', '一、背景与目标']);
  });
});

describe('applyPatch add + after 落位', () => {
  const base = () => splitSections([
    '初稿引言。', '',
    '## CR-001 门户首页', '', '承接：R-001', '',
    '## CR-002 界面检索', '', '承接：R-002',
  ].join('\n'));

  it('after 锚点命中 → 插到该节之后（中段插入，不再文末追加）', () => {
    const out = applyPatch(base(), { type: 'add', secId: 's0', title: '一、背景与目标', new: '背景。', after: 'CR-001 门户首页' });
    expect(out!.map((s) => s.title)).toEqual(['', 'CR-001 门户首页', '一、背景与目标', 'CR-002 界面检索']);
    expect(out!.find((s) => s.title === '一、背景与目标')!.md).toBe('背景。');
  });

  it('after=\'\' → 插到无标题前言之后、首个有标题节之前；无前言则插到最前', () => {
    const out = applyPatch(base(), { type: 'add', secId: 's0', title: '一、背景与目标', new: '背景。', after: '' });
    expect(out!.map((s) => s.title)).toEqual(['', '一、背景与目标', 'CR-001 门户首页', 'CR-002 界面检索']);
    const noPre = splitSections('## CR-001 门户首页\n\nx');
    const out2 = applyPatch(noPre, { type: 'add', secId: 's0', title: '一、背景与目标', after: '' });
    expect(out2!.map((s) => s.title)).toEqual(['一、背景与目标', 'CR-001 门户首页']);
  });

  it('after 锚点落空 → 退化 append 文末（不抛错）；after 缺席 → 维持现状文末追加', () => {
    const missed = applyPatch(base(), { type: 'add', secId: 's0', title: '三、附录', after: '不存在的大章' });
    expect(missed).not.toBeNull();
    expect(missed!.map((s) => s.title)).toEqual(['', 'CR-001 门户首页', 'CR-002 界面检索', '三、附录']);
    const legacy = applyPatch(base(), { type: 'add', secId: 's0', title: '三、附录' });
    expect(legacy!.map((s) => s.title)).toEqual(['', 'CR-001 门户首页', 'CR-002 界面检索', '三、附录']);
  });

  it('链式模拟整篇重生成逐条接受 → 大章按模型输出顺序落位（实机语义：不文末逆序堆叠）', () => {
    let secs = base();
    // 模型整篇重出的三条大章 add：一 落文首、二 跟一之后、三 落全文末（CR-002 之后）
    const adds: ReadonlyArray<readonly [string, string]> = [
      ['一、背景与目标', ''],
      ['二、功能需求', '一、背景与目标'],
      ['三、非功能需求', 'CR-002 界面检索'],
    ];
    for (const [title, after] of adds) {
      const out = applyPatch(secs, { type: 'add', secId: 's0', title, new: `${title} 正文。`, after });
      expect(out).not.toBeNull();
      secs = out!;
    }
    expect(secs.map((s) => s.title)).toEqual([
      '', '一、背景与目标', '二、功能需求', 'CR-001 门户首页', 'CR-002 界面检索', '三、非功能需求',
    ]);
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
