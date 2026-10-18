/** 页级原型纯函数单测（envelope 往返/scoped 校验/mock 合规/汇总拼装 + checkPrototype 复用断言
 *  + pickUiSections/buildPagePrompt UI 册注入钉 + data-nav 穿流/流程视图/flow 校验（覆盖检测 §3）
 *  + 风格基线 PROTO_THEME_CSS 注入/幂等与真·应用壳断言（2026-10-17 视觉一致性根修）；
 * 无需基础设施） */
import { describe, expect, it } from 'vitest';
import {
  NAV_SCRIPT,
  PAGE_INPUT_CAP,
  PROTO_THEME_PRESETS,
  UI_PAGE_SECTION_RE,
  assertScopedStyles,
  buildMockPage,
  buildPagePrompt,
  buildThemeCss,
  composePrototype,
  ensureDocumentOnly,
  ensureNavScript,
  ensureThemeStyle,
  extractDataNavTargets,
  extractPageParts,
  findDataNavProblem,
  findHiddenSectionRule,
  parseFlowStepRef,
  parseNavRef,
  parseThemeOverrides,
  pickUiSections,
  placeholderBlock,
  replaceThemeStyle,
  sanitizeThemeTokens,
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

  it('真·应用壳（2026-10-17）：顶栏品牌+面包屑 / 左侧页面导航 / 风格基线头 / 壳同步锚点齐备', () => {
    const parts = extractPageParts(doc)!;
    const { html } = composePrototype(items, [
      { code: 'P-HOME', parts, objectKey: 'sha256/abc', fingerprint: 'fp1', source: 'model' },
    ], [], { productName: '灵感市集' });
    expect(html).toContain('<span class="msf-brand">灵感市集</span>');
    expect(html).toContain('data-shell-crumb');
    expect(html).toContain('data-shell-nav="P-HOME"');
    expect(html).toContain('data-shell-nav="P-LIST"');
    expect(html).toContain('class="msf-sidenav"');
    expect(html).toContain('class="msf-content"');
    // 风格基线进头（壳层单点供给），页样式段不重复携带
    expect(html).toContain('--p-primary');
    expect(html).not.toContain('#fafafa'); // 旧堆叠壳的写死色已清
    // 壳同步脚本段（导航高亮+面包屑）
    expect(html).toContain("data-shell-nav");
    expect(checkPrototype(html, items).issues).toEqual([]);
  });
});

describe('风格基线 PROTO_THEME_CSS（视觉一致性单源）', () => {
  it('wrapPageEnvelope 注入主题块且在标记段之外（汇总抽取不重复携带）', () => {
    const html = wrapPageEnvelope('P-HOME', '首页', '#pg-P-HOME { padding: 0; }', '<div id="pg-P-HOME" data-page-block="P-HOME">x</div>', '(function(){})();');
    expect(html).toContain('--p-primary');
    const parts = extractPageParts(html)!;
    expect(parts.styleBlock).not.toContain('--p-primary');
    expect(parts.styleBlock).toContain('#pg-P-HOME');
  });
  it('ensureThemeStyle：缺则 </head> 前注入；已有（--p-primary 在）→ 幂等原样', () => {
    const raw = '<!doctype html><html><head><meta charset="utf-8"></head><body>x</body></html>';
    const once = ensureThemeStyle(raw);
    expect(once).toContain('--p-primary');
    expect(once.indexOf('--p-primary')).toBeLessThan(once.indexOf('</head>'));
    expect(ensureThemeStyle(once)).toBe(once);
  });
  it('buildMockPage 全走令牌与共享类（无写死 hex 色——与页校验同纪律）', () => {
    const html = buildMockPage(page, [st], [{ code: 'P-LIST', title: '列表页' }]);
    const css = extractPageParts(html)!.styleBlock;
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain('var(--p-line)');
    expect(html).toContain('class="tbl"');
    expect(html).toContain('btn primary');
  });
  it('buildPagePrompt 注入风格基线契约（令牌+共享类+不写死颜色+不画全局壳）', () => {
    const prompt = buildPagePrompt(page, [st], [], '', '', '');
    expect(prompt).toContain('风格基线');
    expect(prompt).toContain('var(--p-primary)');
    expect(prompt).toContain('.btn');
    expect(prompt).toContain('禁止写死任何颜色值');
    expect(prompt).toContain('不要画产品级全局顶栏');
  });
});

describe('项目定制主题链（0033：AI 按项目类型定制配色）', () => {
  it('parseThemeOverrides：剥围栏取 JSON；键白名单+值形态校验（非法键值静默丢弃）', () => {
    expect(parseThemeOverrides('```json\n{"primary":"#16a34a","hack":"x","radius":"12px","bad":"red"}\n```'))
      .toEqual({ primary: '#16a34a', radius: '12px' });
    expect(parseThemeOverrides('{"ink":"#1F2329"}')).toEqual({ ink: '#1F2329' }); // 大写 hex 合法
    expect(parseThemeOverrides('随便一段没有 JSON 的话')).toEqual({});
    expect(parseThemeOverrides('{"primary":"blue"}')).toEqual({}); // 非 hex 拒
    expect(parseThemeOverrides('{"radius":"999px"}')).toEqual({}); // 超长圆角拒
    expect(parseThemeOverrides('{broken json')).toEqual({});
  });
  it('buildThemeCss：覆盖合成最终 CSS（覆盖项用定制值，未覆盖项用默认值）', () => {
    const cssOut = buildThemeCss({ primary: '#16a34a', 'primary-soft': '#eaf7ee' });
    expect(cssOut).toContain('--p-primary:#16a34a;');
    expect(cssOut).toContain('--p-accent:#7c3aed;'); // 未覆盖→默认
    expect(cssOut).toContain('--p-font:'); // 字体固定段恒定存在
  });
  it('buildPagePrompt：theme 实值注入风格基线（模型有参照值），缺省走默认', () => {
    const withTheme = buildPagePrompt(page, [st], [], '', '', '', undefined, { primary: '#16a34a' });
    expect(withTheme).toContain('主色 var(--p-primary)（#16a34a）');
    expect(withTheme).toContain('强调色 var(--p-accent)（#7c3aed）'); // 未覆盖项仍默认实值
    const def = buildPagePrompt(page, [st], [], '', '', '');
    expect(def).toContain('主色 var(--p-primary)（#2563eb）');
  });
  it('buildMockPage/composePrototype：主题透传（定制 primary 进产物头部）', () => {
    const mock = buildMockPage(page, [st], [], buildThemeCss({ primary: '#16a34a' }));
    expect(mock).toContain('--p-primary:#16a34a;');
    const { html } = composePrototype(items, [], [], { productName: '贪吃蛇', theme: { primary: '#16a34a' } });
    expect(html).toContain('--p-primary:#16a34a;');
  });
});

describe('ensureDocumentOnly（思考过程清洗：入库只留文档本体）', () => {
  it('剥首围栏+文档头之前的前言（模型规划自述不入库）', () => {
    const dirty = '```html\n我先规划一下这个页面的结构：分三栏……\n<!doctype html><html><head></head><body>x</body></html>';
    expect(ensureDocumentOnly(dirty)).toBe('<!doctype html><html><head></head><body>x</body></html>');
  });
  it('无 doctype 时以 <html 为界；</html> 之后的尾巴截掉', () => {
    const dirty = '好的，下面给出页面：\n<html><body>x</body></html>\n以上就完成了设计，如需调整请告诉我。';
    expect(ensureDocumentOnly(dirty)).toBe('<html><body>x</body></html>');
  });
  it('干净文档原样通过（幂等）；无文档头兜底=剥围栏后原文（交给下游契约校验拒收）', () => {
    const clean = '<!doctype html><html><body>x</body></html>';
    expect(ensureDocumentOnly(clean)).toBe(clean);
    expect(ensureDocumentOnly('```\n纯文字无文档\n```')).toBe('纯文字无文档');
  });
});

describe('UI_PAGE_SECTION_RE（页面章节识别口径，2026-10-18 收紧）', () => {
  it('标题以 页/界面 结尾才算页面；「页面清单/页面入口/页面四态」等 meta 章节不中', () => {
    for (const t of ['u-23 对战页', '结算页', '登录注册界面', '个人战绩页 ', 'u-1 门户首页（页面）', 'u-3 设置页面']) {
      expect(UI_PAGE_SECTION_RE.test(t), t).toBe(true);
    }
    for (const t of ['一、页面清单', 'u-2 页面入口与导航关系', 'u-3 页面层级与复用组件', 'u-7 页面四态与操作许可', '页面设计规范']) {
      expect(UI_PAGE_SECTION_RE.test(t), t).toBe(false);
    }
  });
});

describe('主题方案库（0034：多套默认+自定义+换肤不重写内容）', () => {
  it('内置预设：5 套，id 唯一且 builtin:* 形态，令牌全过白名单校验', () => {
    expect(PROTO_THEME_PRESETS).toHaveLength(5);
    const ids = PROTO_THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(5);
    for (const p of PROTO_THEME_PRESETS) {
      expect(p.id).toMatch(/^builtin:/);
      expect(sanitizeThemeTokens(p.tokens)).toEqual(p.tokens); // 预设自身必须全合法
      expect(p.name.length).toBeGreaterThan(0);
    }
  });
  it('sanitizeThemeTokens：非对象/非法键/非法值一律滤掉；hex 大写与 radius 合法保留', () => {
    expect(sanitizeThemeTokens(null)).toEqual({});
    expect(sanitizeThemeTokens('x')).toEqual({});
    expect(sanitizeThemeTokens({ primary: '#16A34A', hack: 'x', radius: '16px', bad: 'red' }))
      .toEqual({ primary: '#16A34A', radius: '16px' });
  });
  it('replaceThemeStyle：只换主题块（--p-primary: 定义所在 style），页自身样式段原样保留', () => {
    const themed = wrapPageEnvelope('P-HOME', '首页', '#pg-P-HOME { color: var(--p-primary); }', body, '(function(){})();', buildThemeCss({ primary: '#16a34a' }));
    const out = replaceThemeStyle(themed, buildThemeCss({ primary: '#ea580c' }));
    expect(out).toContain('--p-primary:#ea580c;');
    expect(out).not.toContain('--p-primary:#16a34a;');
    expect(out).toContain('#pg-P-HOME { color: var(--p-primary); }'); // 页样式段不动
    expect(out).toContain('data-page-block="P-HOME"'); // 正文不动
    expect(replaceThemeStyle(out, buildThemeCss({ primary: '#ea580c' }))).toBe(out); // 幂等
  });
  it('replaceThemeStyle：页样式段在主题块之前且引用 var(--p-primary)（无定义冒号）不误判', () => {
    // 模型产物形态：自身 <style> 在前（含 var(--p-primary) 引用），ensureThemeStyle 注入的主题块在后
    const modelHtml = '<!doctype html><html><head><style>#pg-P-HOME a{color:var(--p-primary)}</style></head><body>x</body></html>';
    const withTheme = ensureThemeStyle(modelHtml, buildThemeCss({ primary: '#16a34a' }));
    expect(withTheme).toContain('--p-primary:#16a34a;'); // 引用不阻注入（冒号判据）
    const out = replaceThemeStyle(withTheme, buildThemeCss({ primary: '#ea580c' }));
    expect(out).toContain('--p-primary:#ea580c;');
    expect(out).not.toContain('--p-primary:#16a34a;'); // 标记块整块替换
    expect(out).toContain('#pg-P-HOME a{color:var(--p-primary)}'); // 模型样式段原样
  });
  it('replaceThemeStyle：模型在页样式标记段内自定 :root → 不拆段，追加覆盖块（层叠后者胜）', () => {
    // 0033 实机形态：模型按 prompt 实值自写 :root 定义（在 msf:style 标记段内），系统未再注入
    const selfDefined = wrapPageEnvelope('P-HOME', '首页', ':root{--p-primary:#6d28d9;}\n#pg-P-HOME a{color:var(--p-primary)}', body, 'void 0').replace('<style data-msf-theme>', '<style data-msf-theme-x>'); // 拆掉系统块标记模拟「模型自定为准」
    const legacy = selfDefined.replace(/<style data-msf-theme-x>[\s\S]*?<\/style>/, ''); // 进一步移除系统主题块
    const out = replaceThemeStyle(legacy, buildThemeCss({ primary: '#ea580c' }));
    expect(out).toContain('--p-primary:#6d28d9;'); // 模型段原样保留（不拆段）
    expect(out).toContain('--p-primary:#ea580c;'); // 覆盖块在后
    expect(out.indexOf('--p-primary:#ea580c;')).toBeGreaterThan(out.indexOf('--p-primary:#6d28d9;'));
    expect(out).toContain('#pg-P-HOME a{color:var(--p-primary)}');
  });
  it('replaceThemeStyle：无主题块的旧产物 → 等价注入（回落 ensureThemeStyle）', () => {
    const legacy = '<!doctype html><html><head></head><body>x</body></html>';
    const out = replaceThemeStyle(legacy, buildThemeCss({ primary: '#ea580c' }));
    expect(out).toContain('--p-primary:#ea580c;');
  });
});

describe('整本壳 0034 重构（场景索引默认落页 + 左导航收展）', () => {
  const flow: CatalogItemLike = { item_type: 'flow', code: 'F-01', payload: { title: '主流程', steps: ['P-HOME', 'P-LIST'] } };
  const itemsWithFlow = [...items, flow];
  it('有 flow：产场景索引（data-shell-index/#msf-flows/场景首页链接/☰ 收展钮），检查不受影响', () => {
    const parts = extractPageParts(doc)!;
    const { html, manifest } = composePrototype(itemsWithFlow, [
      { code: 'P-HOME', parts, objectKey: 'sha256/abc', fingerprint: 'fp1', source: 'model' },
    ], [], { productName: '贪吃蛇' });
    expect(html).toContain('data-shell-index');
    expect(html).toContain('id="msf-flows"');
    expect(html).toContain('贪吃蛇 · 使用场景');
    expect(html).toContain('data-shell-home');
    expect(html).toContain('data-shell-toggle');
    expect(html).toContain('主流程'); // 场景卡片
    expect(html).toContain('全部页面'); // 页面直达网格
    expect(manifest.flows).toEqual([{ code: 'F-01', title: '主流程', steps: ['P-HOME', 'P-LIST'] }]);
    expect(checkPrototype(html, itemsWithFlow).issues).toEqual([]);
  });
  it('无 flow：不产索引页/首页链接（旧目录产物零痕迹），首页面包屑=第一页', () => {
    const { html } = composePrototype(items, []);
    expect(html).not.toContain('<div class="msf-index"'); // 索引块本身不产（NAV_SCRIPT 协议字符串恒在属正常）
    expect(html).not.toContain('<a href="#" data-shell-home>');
    expect(html).toContain('data-shell-toggle'); // ☰ 收展钮与流程无关恒在
    expect(html).toContain('>首页</span></header>');
    expect(checkPrototype(html, items).issues).toEqual([]);
  });
  it('NAV_SCRIPT：壳层新协议齐备（场景首页显隐/☰ 收展/hash 空→索引）', () => {
    expect(NAV_SCRIPT).toContain('data-shell-index');
    expect(NAV_SCRIPT).toContain('data-shell-home');
    expect(NAV_SCRIPT).toContain('data-shell-toggle');
    expect(NAV_SCRIPT).toContain('nav-on');
    expect(NAV_SCRIPT).toContain('showHome');
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
  it('ui 非空 → 含「上游 UI 册当前版本（节选）」段且与 PRD 段并列（S-4：注入的是当前版本非定稿，标签消歧）', () => {
    const prompt = buildPagePrompt(page, [st], [], 'PRD 节选正文', '## u-1 门户首页（页面）\n\n承接 REQ-001。', '');
    expect(prompt).toContain('## 上游 PRD 定稿（节选）\nPRD 节选正文');
    expect(prompt).toContain('## 上游 UI 册当前版本（节选）\n## u-1 门户首页（页面）');
  });
  it('ui 为空串 → 不出现 UI 册段（旧目录/无 ui 册口径）', () => {
    const prompt = buildPagePrompt(page, [st], [], 'PRD 节选正文', '', '');
    expect(prompt).not.toContain('上游 UI 册');
    expect(prompt).toContain('## 上游 PRD 定稿（节选）');
  });
  it('data-nav 穿流约定入契约段 + 合法跳转目标清单（覆盖检测 §3）', () => {
    const prompt = buildPagePrompt(page, [st], [], '', '', '', [{ code: 'P-LIST', title: '列表页' }]);
    expect(prompt).toContain('data-nav');
    expect(prompt).toContain('纯展示');
    expect(prompt).toContain('P-LIST（列表页）');
  });
  it('navPages 缺省 → 契约段仍含 data-nav 约定但无目标清单（旧调用兼容）', () => {
    const prompt = buildPagePrompt(page, [st], [], '', '', '');
    expect(prompt).toContain('data-nav');
    expect(prompt).not.toContain('可跳转目标仅限');
  });
});

describe('data-nav 引用解析与校验（覆盖检测 §3）', () => {
  it('parseNavRef：#页码 / #页码/状态 → 解析；缺 #、空段、裸串 → null（格式非法）', () => {
    expect(parseNavRef('#P-002')).toEqual({ page: 'P-002', state: null });
    expect(parseNavRef('#P-002/ST-empty')).toEqual({ page: 'P-002', state: 'ST-empty' });
    expect(parseNavRef('#P-HOME')).toEqual({ page: 'P-HOME', state: null });
    expect(parseNavRef('P-002')).toBeNull();
    expect(parseNavRef('#')).toBeNull();
    expect(parseNavRef('#P-002/')).toBeNull();
    expect(parseNavRef('')).toBeNull();
  });
  it('parseFlowStepRef：P- 前缀引用才判为引用；旧格式 REQ 章节标题永不命中（兼容口径）', () => {
    expect(parseFlowStepRef('P-001')).toEqual({ page: 'P-001', state: null });
    expect(parseFlowStepRef('#P-HOME/ST-empty')).toEqual({ page: 'P-HOME', state: 'ST-empty' });
    expect(parseFlowStepRef('REQ-001 门户首页')).toBeNull();
    expect(parseFlowStepRef('用户登录并进入首页')).toBeNull();
    expect(parseFlowStepRef('')).toBeNull();
  });
  it('extractDataNavTargets：双/单引号属性全提取；无 data-nav → 空', () => {
    expect(extractDataNavTargets('<a data-nav="#P-001">x</a><button data-nav=\'#P-002/s2\'>y</button>'))
      .toEqual(['#P-001', '#P-002/s2']);
    expect(extractDataNavTargets('<div>no nav</div>')).toEqual([]);
  });
  it('findDataNavProblem：目标页/状态在目录集内 → null；不存在/格式非法 → 问题串', () => {
    const pages = new Set(['P-001', 'P-HOME']);
    const states = new Set(['ST-empty']);
    expect(findDataNavProblem('<a data-nav="#P-001">x</a>', pages, states)).toBeNull();
    expect(findDataNavProblem('<a data-nav="#P-001/ST-empty">x</a>', pages, states)).toBeNull();
    expect(findDataNavProblem('<a data-nav="#P-404">x</a>', pages, states)).toContain('P-404');
    expect(findDataNavProblem('<a data-nav="#P-001/ST-nope">x</a>', pages, states)).toContain('ST-nope');
    expect(findDataNavProblem('<a data-nav="P-001">x</a>', pages, states)).toContain('格式非法');
  });
});

describe('NAV_SCRIPT data-nav 穿流委托（覆盖检测 §3）', () => {
  it('含 [data-nav] 事件委托 + preventDefault + 目标块不存在 no-op（单页预览防白屏）', () => {
    expect(NAV_SCRIPT).toContain("closest('[data-nav]')");
    expect(NAV_SCRIPT).toContain('preventDefault');
    expect(NAV_SCRIPT).toContain('if(!found)return;');
    // 穿流后 hash 同步（hashchange 通道复用现有选页选态协议）
    expect(NAV_SCRIPT).toContain('location.hash');
  });
});

describe('buildMockPage 穿流按钮（mock 降级产合法 data-nav）', () => {
  it('带导航目标 → 渲染 data-nav 钮（自身被剔除）；缺省 → 无 data-nav 属性（旧行为兼容）', () => {
    const html = buildMockPage(page, [st], [{ code: 'P-LIST', title: '列表页' }, { code: 'P-HOME', title: '自身' }]);
    expect(html).toContain('data-nav="#P-LIST"');
    expect(html).not.toContain('data-nav="#P-HOME"');
    // NAV_SCRIPT 委托代码含 '[data-nav]' 选择器字样——断言属性形态 data-nav="# 才算穿流目标
    expect(buildMockPage(page, [st])).not.toContain('data-nav="#');
  });
});

describe('composePrototype 流程视图（覆盖检测 §3）', () => {
  const flow: CatalogItemLike = { item_type: 'flow', code: 'F-001', payload: { title: '主流程', steps: ['P-HOME', 'REQ-001 门户首页'] } };
  it('新格式步骤渲染可点 data-nav；旧格式渲染纯文本；manifest 含 flows/dataNavTargets', () => {
    const { html, manifest } = composePrototype([...items, flow], []);
    expect(html).toContain('data-flow="F-001"');
    expect(html).toContain('data-nav="#P-HOME"');
    // 新格式步骤标签=页面标题（可读）；旧格式 REQ 标题纯文本不可点
    expect(html).toContain('>首页</a>');
    expect(html).toContain('<li class="msf-flow-step">REQ-001 门户首页</li>');
    expect(manifest.flows?.[0]).toMatchObject({ code: 'F-001', title: '主流程', steps: ['P-HOME', 'REQ-001 门户首页'] });
    expect(manifest.dataNavTargets).toContain('#P-HOME');
  });
  it('无 flow 条目 → 不渲染流程视图，manifest 无 flows 键（旧目录兼容）', () => {
    const { html, manifest } = composePrototype(items, []);
    expect(html).not.toContain('msf-flow');
    expect(manifest.flows).toBeUndefined();
  });
  it('flow 步骤引用不存在页面/状态 → 降级纯文本不穿流（check 侧报 FLOW_REF_MISSING）', () => {
    const broken: CatalogItemLike = { item_type: 'flow', code: 'F-001', payload: { title: '主流程', steps: ['P-404', 'P-HOME/ST-nope'] } };
    const { html } = composePrototype([...items, broken], []);
    expect(html).not.toContain('data-nav="#P-404"');
    expect(html).not.toContain('data-nav="#P-HOME/ST-nope"');
    expect(html).toContain('P-404');
  });
});

describe('checkPrototype 流程/穿流校验（覆盖检测 §3；issue 只进 issues jsonb）', () => {
  const htmlBase = '<div data-page-block="P-HOME"><section data-page="P-HOME" data-state="ST-empty"></section></div>'
    + '<div data-page-block="P-LIST"><section data-page="P-LIST" data-state="ST-empty"></section></div>';
  it('flow 引用存在 + 旧格式步骤不校验 → 零 issue', () => {
    const flowGood: CatalogItemLike = { item_type: 'flow', code: 'F-001', payload: { title: '主流程', steps: ['P-HOME', '#P-LIST/ST-empty', 'REQ-001 门户首页'] } };
    expect(checkPrototype(htmlBase, [...items, flowGood]).issues).toEqual([]);
  });
  it('flow 引用页面/状态不存在 → FLOW_REF_MISSING 逐条报', () => {
    const flowBad: CatalogItemLike = { item_type: 'flow', code: 'F-001', payload: { title: '主流程', steps: ['P-404', 'P-HOME/ST-nope'] } };
    const { issues } = checkPrototype(htmlBase, [...items, flowBad]);
    const flows = issues.filter((i) => i.code === 'FLOW_REF_MISSING');
    expect(flows).toHaveLength(2);
    expect(flows.every((i) => i.target === 'F-001')).toBe(true);
  });
  it('data-nav 目标页/状态不在目录或格式非法 → DATA_NAV_TARGET_MISSING；合法 → 不报', () => {
    const ok = checkPrototype(`${htmlBase}<a data-nav="#P-LIST/ST-empty">去列表</a>`, items).issues;
    expect(ok.filter((i) => i.code === 'DATA_NAV_TARGET_MISSING')).toEqual([]);
    const badHtml = `${htmlBase}<a data-nav="#P-404">x</a><a data-nav="#P-HOME/ST-nope">y</a><a data-nav="P-HOME">z</a>`;
    const bad = checkPrototype(badHtml, items).issues.filter((i) => i.code === 'DATA_NAV_TARGET_MISSING');
    expect(bad).toHaveLength(3);
  });
});
