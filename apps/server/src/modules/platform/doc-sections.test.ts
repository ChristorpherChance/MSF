/** normalizePatches 单测：mdToPatches 恒产 add 的归一化（锚点码命中/标题命中转 modify，未命中保持 add） */
import { describe, expect, it } from 'vitest';
import { applyPatch, joinSections, mdToPatches, normalizePatches, splitSections, type DocSection } from './doc-sections.js';

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

describe('applyPatch modify/del secId 错位回退重定位（add 中段插入后混合批按序接受，I-1）', () => {
  const mixedBase = () => splitSections([
    '前言。', '',
    '## CR-001 甲', '', '甲文。', '',
    '## CR-002 乙', '', '乙文。',
  ].join('\n'));
  /** 模拟 accept-pending 真实链路：每次 accept 对当前内容重切分，位置性 id 重派 */
  const resplit = (secs: DocSection[]) => splitSections(joinSections(secs));

  it('混合批链式：add 大章（after=\'\'）后两条 modify 按库存 secId 错位 → 回退锚点码命中，三条全成且结构正确', () => {
    let secs = mixedBase(); // s0 前言 / s1 CR-001 甲 / s2 CR-002 乙——normalizePatches 按此刻位置产 secId
    let out = applyPatch(secs, { type: 'add', secId: 's0', title: '一、背景与目标', new: '背景。', after: '' });
    expect(out).not.toBeNull();
    secs = resplit(out!); // 重切分后 s1=一、背景与目标 / s2=CR-001 甲 / s3=CR-002 乙——库存 secId 全错位
    out = applyPatch(secs, { type: 'modify', secId: 's1', title: 'CR-001 甲', old: '甲文。', new: '甲文修订。' });
    expect(out).not.toBeNull();
    secs = resplit(out!);
    out = applyPatch(secs, { type: 'modify', secId: 's2', title: 'CR-002 乙', old: '乙文。', new: '乙文修订。' });
    expect(out).not.toBeNull();
    secs = resplit(out!);
    expect(secs.map((s) => s.title)).toEqual(['', '一、背景与目标', 'CR-001 甲', 'CR-002 乙']);
    expect(secs[2]!.md).toBe('甲文修订。');
    expect(secs[3]!.md).toBe('乙文修订。');
  });

  it('del 同样回退：库存 secId 错位 → 按标题锚点码重定位删除', () => {
    let secs = mixedBase();
    let out = applyPatch(secs, { type: 'add', secId: 's0', title: '一、背景与目标', new: '背景。', after: '' });
    secs = resplit(out!); // s2=CR-001 甲（库存 del 的 secId='s2' 指向错节）
    out = applyPatch(secs, { type: 'del', secId: 's2', title: 'CR-002 乙', old: '乙文。' });
    expect(out).not.toBeNull();
    expect(out!.map((s) => s.title)).toEqual(['', '一、背景与目标', 'CR-001 甲']);
  });

  it('回退候选仍须 old⊆md：锚点码/标题命中但 old 不在候选节 → null（防错节静默命中）', () => {
    const secs = mixedBase();
    expect(applyPatch(secs, { type: 'modify', secId: 's9', title: 'CR-001 甲', old: '不存在的旧文。', new: 'x' })).toBeNull();
    expect(applyPatch(secs, { type: 'del', secId: 's9', title: 'CR-002 乙', old: '不存在的旧文。' })).toBeNull();
    // 无 title 可回退且 secId 落空 → null（维持原语义）
    expect(applyPatch(secs, { type: 'modify', secId: 's9', old: '甲文。', new: 'x' })).toBeNull();
  });

  it('secId 命中且 old 吻合时不走回退（既有路径零变化）', () => {
    const secs = mixedBase();
    const out = applyPatch(secs, { type: 'modify', secId: 's1', title: 'CR-001 甲', old: '甲文。', new: '甲文修订。' });
    expect(out).not.toBeNull();
    expect(out!.map((s) => s.title)).toEqual(['', 'CR-001 甲', 'CR-002 乙']);
    expect(out![1]!.md).toBe('甲文修订。');
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

describe('第五章改不到位根修：补丁标题容错（模型学 UI 编号格式输出时仍命中 modify 不追加重复节）', () => {
  const base = () => splitSections([
    '前言。', '',
    '## 五、待确认事项', '', '待确认表旧文。', '',
    '## CR-006 单局限时与超时胜负', '', '承接：R-006。每局限时 3 分钟。',
  ].join('\n'));

  it('normalizePatches：编号开头标题「5.7 单局限时与超时胜负（CR-006）」（码在尾部）锚点码命中既有节转 modify', () => {
    const out = normalizePatches(
      [{ type: 'add', secId: 's0', title: '5.7 单局限时与超时胜负（CR-006）', new: '承接：R-006。每局限时 4 分钟。' }],
      base(),
    );
    expect(out[0]!.type).toBe('modify'); // 修复前：add（追加重复节，原文不动=「改不到位」）
    expect(out[0]!.secId).toBe('s2');
    expect(out[0]!.title).toBe('CR-006 单局限时与超时胜负'); // 归一为存储标题
  });

  it('normalizePatches：中文章号「第五章 待确认事项」剥离编号前缀后标题精确命中转 modify', () => {
    const out = normalizePatches(
      [{ type: 'add', secId: 's0', title: '第五章 待确认事项', new: '待确认表新文。' }],
      base(),
    );
    expect(out[0]!.type).toBe('modify');
    expect(out[0]!.secId).toBe('s1');
  });

  it('normalizePatches：纯数字编号「5. 待确认事项」同样剥离命中；无编号前缀标题行为不变', () => {
    const out = normalizePatches(
      [{ type: 'add', secId: 's0', title: '5. 待确认事项', new: 'x。' }, { type: 'add', secId: 's0', title: '五、待确认事项', new: 'y。' }],
      base(),
    );
    expect(out[0]!.type).toBe('modify');
    expect(out[1]!.type).toBe('modify');
    expect(out[1]!.title).toBe('五、待确认事项');
  });

  it('applyPatch 回退重定位同口径：secId 错位+编号标题仍命中；after 锚点编号剥离后命中', () => {
    let secs = base();
    const out = applyPatch(secs, { type: 'modify', secId: 's9', title: '5.7 单局限时与超时胜负（CR-006）', old: '承接：R-006。每局限时 3 分钟。', new: '承接：R-006。每局限时 4 分钟。' });
    expect(out).not.toBeNull();
    expect(out![2]!.md).toContain('4 分钟');
    const out2 = applyPatch(secs, { type: 'add', secId: 's0', title: '六、附录', new: '附录。', after: '第五章 待确认事项' });
    expect(out2).not.toBeNull();
    expect(out2!.map((s) => s.title)).toEqual(['', '五、待确认事项', '六、附录', 'CR-006 单局限时与超时胜负']);
    secs = out2!;
    expect(secs.length).toBe(4);
  });
});

describe('buildNumberGuide（增量修订 prompt 编号对照表）', () => {
  it('输出 UI 显示编号 ⇢ 原始标题 对照行，并附「禁止编号前缀」约束', async () => {
    const { buildNumberGuide } = await import('./doc-sections.js');
    const guide = buildNumberGuide([
      '前言。', '',
      '## 一、功能需求', '', '引言。', '',
      '## CR-001 浏览器即开即玩', '', '承接：R-001',
    ].join('\n'));
    expect(guide).toContain('一、功能需求 ⇢ 原始标题「一、功能需求」');
    expect(guide).toContain('1.1 浏览器即开即玩（CR-001） ⇢ 原始标题「CR-001 浏览器即开即玩」');
    expect(guide).toContain('禁止添加任何编号前缀');
    expect(guide).not.toContain('前言'); // 无标题节不入表
  });

  it('空文档/无标题节 → 空串（prompt 不注入空段）', async () => {
    const { buildNumberGuide } = await import('./doc-sections.js');
    expect(buildNumberGuide('')).toBe('');
    expect(buildNumberGuide('只有前言，没有章节。')).toBe('');
  });
});

describe('findSectionByAnchor（doc.read 定向读：「5.1 节」「第五章」指代口径）', () => {
  const secs = () => splitSections([
    '前言。', '',
    '## 一、背景与目标', '', '背景。', '',
    '## 二、功能需求', '', '引言。', '',
    '## CR-001 浏览器即开即玩', '', '承接：R-001', '',
    '## CR-002 双人同屏', '', '承接：R-002', '',
    '## 五、待确认事项', '', '待确认表。', '',
    '## CR-015 免登录的网页版双人游戏', '', '承接：R-015 细则。',
  ].join('\n'));
  // 编号布局：一、(章1) 二、(章2) 2.1=CR-001 2.2=CR-002 五、(章3) 3.1=CR-015

  it('数字编号 token 命中：「5.1」式多级编号与平铺序号（忽略「节」后缀与尾部点）', async () => {
    const { findSectionByAnchor } = await import('./doc-sections.js');
    const s = secs();
    expect(s[findSectionByAnchor('2.1', s)]!.title).toBe('CR-001 浏览器即开即玩');
    expect(s[findSectionByAnchor('2.2 节', s)]!.title).toBe('CR-002 双人同屏');
    expect(s[findSectionByAnchor('3.1', s)]!.title).toBe('CR-015 免登录的网页版双人游戏');
  });

  it('大章序命中：「第五章」「第5章」→ 第 5 个大章节；「一」→ 首个大章', async () => {
    const { findSectionByAnchor } = await import('./doc-sections.js');
    const s = splitSections([
      '## 一、背景', '', 'a', '',
      '## 二、范围', '', 'b', '',
      '## 三、功能', '', 'c', '',
      '## 四、非功能', '', 'd', '',
      '## 五、待确认事项', '', 'e',
    ].join('\n'));
    expect(s[findSectionByAnchor('第五章', s)]!.title).toBe('五、待确认事项');
    expect(s[findSectionByAnchor('第5章', s)]!.title).toBe('五、待确认事项');
    expect(s[findSectionByAnchor('一', s)]!.title).toBe('一、背景');
  });

  it('回落原始标题口径：锚点码/原标题精确；落空返回 -1（不做前缀误命中）', async () => {
    const { findSectionByAnchor } = await import('./doc-sections.js');
    const s = secs();
    expect(s[findSectionByAnchor('CR-015', s)]!.title).toBe('CR-015 免登录的网页版双人游戏');
    expect(s[findSectionByAnchor('五、待确认事项', s)]!.title).toBe('五、待确认事项');
    expect(findSectionByAnchor('9.9', s)).toBe(-1);
    expect(findSectionByAnchor('第九章', s)).toBe(-1);
  });
});

describe('applyPatch replace（对话改文档 mode:rewrite 整篇重写补丁）', () => {
  const base = () => splitSections([
    '# CRD', '', '前言。', '',
    '## 一、背景', '', 'a', '',
    '## 五、待确认事项', '', '待确认表。', '',
    '## CR-001 条目', '', '承接：R-001',
  ].join('\n'));

  it('整篇替换：new 重切分为章节集（第五章消失=rewrite 表达删除的通道）', () => {
    const next = applyPatch(base(), {
      type: 'replace', secId: 's0', title: '整篇重写',
      new: ['# CRD', '', '前言 v2。', '', '## 一、背景', '', 'a2', '', '## CR-001 条目', '', '承接：R-001 修订'].join('\n'),
    });
    expect(next).not.toBeNull();
    expect(next!.map((s) => s.title)).toEqual(['', '一、背景', 'CR-001 条目']);
    expect(joinSections(next!)).toContain('前言 v2。');
    expect(joinSections(next!)).not.toContain('待确认');
  });

  it('空 new 拒绝（防误清空全文）；replace 经 normalizePatches 原样透传', () => {
    expect(applyPatch(base(), { type: 'replace', secId: 's0', new: '  ' })).toBeNull();
    const p = { type: 'replace' as const, secId: 's0', title: '整篇重写', new: '# X' };
    expect(normalizePatches([p], base())).toEqual([p]);
  });
});
