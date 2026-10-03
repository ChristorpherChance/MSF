/** 页级原型纯函数单测（envelope 往返/scoped 校验/mock 合规/汇总拼装 + checkPrototype 复用断言；无需基础设施） */
import { describe, expect, it } from 'vitest';
import {
  assertScopedStyles,
  buildMockPage,
  composePrototype,
  ensureNavScript,
  extractPageParts,
  findHiddenSectionRule,
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
