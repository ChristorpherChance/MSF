/** 页级原型纯函数单测（envelope 往返/scoped 校验/mock 合规/汇总拼装 + checkPrototype 复用断言
 *  + pickUiSections/buildPagePrompt UI 册注入钉；无需基础设施） */
import { describe, expect, it } from 'vitest';
import {
  PAGE_INPUT_CAP,
  assertScopedStyles,
  buildMockPage,
  buildPagePrompt,
  composePrototype,
  ensureNavScript,
  extractPageParts,
  findHiddenSectionRule,
  pickUiSections,
  placeholderBlock,
  wrapPageEnvelope,
  type CatalogItemLike,
} from './prototype-pages.js';
import { checkPrototype } from './prototype.service.js';

const page: CatalogItemLike = { item_type: 'page', code: 'P-HOME', payload: { title: '首页', route: '/', reqIds: ['REQ-001'] } };
const page2: CatalogItemLike = { item_type: 'page', code: 'P-LIST', payload: { title: '列表页', route: '/list', reqIds: [] } };
const st: CatalogItemLike = { item_type: 'state', code: 'ST-empty', payload: { title: '空态' } };
const items = [page, page2, st];

const css = '#pg-P-HOME { color: red; }\n#pg-P-HOME .a, #pg-P-HOME .b:hover { color: blue; }';
const body = '<div id="pg-P-HOME" data-page-block="P-HOME"><section data-page="P-HOME" data-state="ST-empty">hi</section></div>';
const doc = wrapPageEnvelope('P-HOME', '首页', css, body, '(function(){})();');

describe('wrapPageEnvelope / extractPageParts 往返', () => {
  it('封装→抽取保真（含标记与属性序）', () => {
    const parts = extractPageParts(doc);
    expect(parts).not.toBeNull();
    expect(parts!.styleBlock).toContain(css);
    expect(parts!.body).toContain('id="pg-P-HOME"');
    expect(parts!.body).toContain('data-page="P-HOME" data-state="ST-empty"');
    expect(parts!.scriptBlock).toContain('(function(){})();');
  });
  it('缺封装标记 → null 拒绝（不做猜测性解析）', () => {
    expect(extractPageParts('<html><body>no markers</body></html>')).toBeNull();
  });
});

describe('assertScopedStyles', () => {
  it('全 scoped 通过（逗号拆分逐个验）', () => {
    expect(assertScopedStyles(css, 'P-HOME')).toEqual([]);
  });
  it('未 scoped 选择器被拦（混合选择器只报违例项）', () => {
    const bad = assertScopedStyles('#pg-P-HOME .a { } body { } .x, #pg-P-HOME .y { }', 'P-HOME');
    expect(bad).toEqual(['body', '.x']);
  });
  it('@media 内规则仍校验；@keyframes 内部豁免', () => {
    expect(assertScopedStyles('@media (max-width: 600px) { #pg-P-HOME .a { } .bad { } }', 'P-HOME')).toEqual(['.bad']);
    expect(assertScopedStyles('@keyframes spin { from { opacity: 0; } to { opacity: 1; } }', 'P-HOME')).toEqual([]);
  });
});

describe('buildMockPage（mock 降级）', () => {
  it('合规：envelope + 属性序 + scoped 样式 + 需求点 chip', () => {
    const html = buildMockPage(page, [st]);
    const parts = extractPageParts(html);
    expect(parts).not.toBeNull();
    expect(parts!.body).toContain('data-page="P-HOME" data-state="ST-empty"');
    expect(parts!.body).toContain('REQ-001');
    const raw = parts!.styleBlock.replace(/^<style>/, '').replace(/<\/style>$/, '');
    expect(assertScopedStyles(raw, 'P-HOME')).toEqual([]);
    expect(findHiddenSectionRule(raw)).toBeNull();
  });
  it('无状态目录 → 单 section 无 data-state', () => {
    expect(buildMockPage(page, [])).toContain('<section data-page="P-HOME">');
  });
});

describe('composePrototype 汇总', () => {
  it('已生成页内嵌 + 未生成页占位；manifest 记录对象/指纹；checkPrototype 复用断言 pass', () => {
    const parts = extractPageParts(doc)!;
    const { html, manifest } = composePrototype(items, [
      { code: 'P-HOME', parts, objectKey: 'sha256/abc', fingerprint: 'fp1', source: 'model' },
    ]);
    expect(html).toContain('data-page-block="P-HOME"');
    expect(html).toContain('data-page-block="P-LIST"');
    expect(html).toContain('v19-prototype-select');
    expect(manifest.generatedBy).toBe('assemble');
    expect(manifest.pages.find((p) => p.code === 'P-HOME')).toMatchObject({ objectKey: 'sha256/abc', fingerprint: 'fp1', source: 'model' });
    expect(manifest.pages.find((p) => p.code === 'P-LIST')).toMatchObject({ placeholder: true });
    expect(checkPrototype(html, items).issues).toEqual([]);
  });
});

describe('placeholderBlock', () => {
  it('占位块保留全部静态标记（对应性检查不受影响）', () => {
    const b = placeholderBlock(page, [st]);
    expect(b).toContain('data-page-block="P-HOME"');
    expect(b).toContain('data-page="P-HOME" data-state="ST-empty"');
  });
});

describe('ensureNavScript（模型产物协议层补齐）', () => {
  it('缺共享脚本 → 注入 </body> 前；已有 → 幂等不重复', () => {
    const raw = '<!doctype html><html><body><div id="pg-P-HOME" data-page-block="P-HOME">x</div></body></html>';
    const once = ensureNavScript(raw);
    expect(once).toContain('v19-prototype-select');
    expect(once.indexOf('v19-prototype-select')).toBeLessThan(once.lastIndexOf('</body>'));
    expect(ensureNavScript(once)).toBe(once);
  });
  it('NAV_SCRIPT 含点击委托与激活态同步（页内 data-show-state 钮系统接管）', () => {
    const once = ensureNavScript('<html><body>x</body></html>');
    expect(once).toContain('data-show-state');
    expect(once).toContain("closest('[data-page-block]')");
    // 汇总文档内 <a href="#页码"> 页间导航依赖 hashchange（初载解析之外必须再挂监听）
    expect(once).toContain('hashchange');
  });
});

describe('findHiddenSectionRule（section 显隐独占校验）', () => {
  it('section display:none / visibility:hidden / display!important → 命中', () => {
    expect(findHiddenSectionRule('#pg-P-HOME section[data-page="P-HOME"] { display:none; }')).toContain('section');
    expect(findHiddenSectionRule('#pg-P-HOME section[data-page].hide { visibility: hidden; }')).toContain('section');
    expect(findHiddenSectionRule('#pg-P-HOME section[data-page="P-HOME"] { display: flex !important; }')).toContain('section');
  });
  it('section 常规样式与非 section 的 display:none 不误伤', () => {
    expect(findHiddenSectionRule('#pg-P-HOME section[data-page="P-HOME"] { background:#fff; display:flex; }')).toBeNull();
    expect(findHiddenSectionRule('#pg-P-HOME .modal { display:none; }')).toBeNull();
    expect(findHiddenSectionRule('@keyframes spin { from { opacity: 0; } } #pg-P-HOME section[data-page="P-HOME"] { color:red; }')).toBeNull();
  });
});

describe('pickUiSections（UI 册节选，覆盖检测 §2）', () => {
  const uiDoc = [
    'UI 设计引言',
    '',
    '## u-0 设计原则',
    '',
    '通用原则（与本页无关）。',
    '',
    '## u-1 门户首页（页面）',
    '',
    '承接 REQ-001。布局：顶部导航。',
    '',
    '## u-2 检索列表界面',
    '',
    '承接 REQ-002。表格 + 筛选。',
  ].join('\n');
  it('相关章节置顶（REQ 命中/标题互含），其余按原序补齐', () => {
    const p: CatalogItemLike = { item_type: 'page', code: 'P-002', payload: { title: '检索列表界面', reqIds: ['REQ-002'] } };
    const out = pickUiSections(uiDoc, p);
    // 相关章节（u-2：REQ-002 命中 + 标题互含）置顶；无关章节按原序（u-0 → u-1）补齐
    expect(out.startsWith('## u-2 检索列表界面')).toBe(true);
    expect(out.indexOf('u-0 设计原则')).toBeLessThan(out.indexOf('u-1 门户首页（页面）'));
    expect(out).toContain('表格 + 筛选');
  });
  it('标题互含反向也算相关（章节标题含页标题）', () => {
    const p: CatalogItemLike = { item_type: 'page', code: 'P-001', payload: { title: '门户首页', reqIds: [] } };
    const out = pickUiSections(uiDoc, p);
    expect(out.startsWith('## u-1 门户首页（页面）')).toBe(true);
  });
  it('超 PAGE_INPUT_CAP 截断带标记；超限时后续章节整体不进', () => {
    const big = `## u-9 大章节\n\n${'长'.repeat(PAGE_INPUT_CAP)}`;
    const out = pickUiSections(big, { item_type: 'page', code: 'P-X', payload: { title: '大章节', reqIds: [] } });
    expect(out).toContain('[原文过长，已截断]');
    expect(out.length).toBeLessThan(PAGE_INPUT_CAP + 40);
    // 相关节已满时，后续无关节不进（截断优先级：相关节完整保留）
    const out2 = pickUiSections(`${big}\n\n## u-0 原则\n\n无关。`, { item_type: 'page', code: 'P-X', payload: { title: '大章节', reqIds: [] } });
    expect(out2).not.toContain('u-0 原则');
  });
  it('无章节/空内容 → 空串（不注入）', () => {
    expect(pickUiSections('', page)).toBe('');
    expect(pickUiSections('只有引言，没有章节。', page)).toBe('');
  });
});

describe('buildPagePrompt UI 册注入段', () => {
  it('ui 非空 → 含「上游 UI 册定稿（节选）」段且与 PRD 段并列', () => {
    const prompt = buildPagePrompt(page, [st], [], 'PRD 节选正文', '## u-1 门户首页（页面）\n\n承接 REQ-001。', '');
    expect(prompt).toContain('## 上游 PRD 定稿（节选）\nPRD 节选正文');
    expect(prompt).toContain('## 上游 UI 册定稿（节选）\n## u-1 门户首页（页面）');
  });
  it('ui 为空串 → 不出现 UI 册段（旧目录/无 ui 册口径）', () => {
    const prompt = buildPagePrompt(page, [st], [], 'PRD 节选正文', '', '');
    expect(prompt).not.toContain('上游 UI 册定稿');
    expect(prompt).toContain('## 上游 PRD 定稿（节选）');
  });
});
