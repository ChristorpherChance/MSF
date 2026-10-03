/**
 * 页级原型纯函数层（单页 UI 原型 AI 生成 + 汇总完整原型；差异登记，待 13 册回补）。
 *
 * 生成契约（mock 与 AI 提示词共同遵守，汇总/检查依赖）：
 * - 单页=完整可独立渲染 HTML 文档（iframe 签名 URL 直开）；style/body/script 三段以
 *   `<!--msf:style-begin-->` 等注释标记封装——汇总时按标记确定性抽取，不做猜测性 HTML 解析。
 * - 页根 `<div id="pg-{code}" data-page-block="{code}">`；每目录 state 一个
 *   `<section data-page="{code}" data-state="{st}">`（属性序钉死：checkPrototype 定序 includes 匹配）。
 * - 所有 <style> 选择器以 `#pg-{code}` 开头（汇总样式隔离：prompt 强制 + 入库前 assertScopedStyles + 页根锚）。
 * - <script> 一律 IIFE、只查 `#pg-{code}` 子树。
 * - 选页选态协议与汇总版共用 NAV_SCRIPT（v19-prototype-select postMessage + hash 双通道，前端零改动）。
 * - 状态 section 可见性由 NAV_SCRIPT 独占（inline display）：页 CSS 不得对 section[data-page] 设
 *   display:none/visibility:hidden（入库前 validatePageHtml 拒收）；页内态切换钮统一 data-show-state 属性，
 *   NAV_SCRIPT 事件委托接管点击切换与激活态，模型脚本无需也不应自管 section 显隐。
 */

export interface CatalogItemLike {
  item_type: string;
  code: string;
  payload: Record<string, unknown>;
}

/** 单页抽取产物（styleBlock/scriptBlock 含标签本体，汇总时直接内嵌） */
export interface PageParts {
  styleBlock: string;
  body: string;
  scriptBlock: string;
}

const MARK = {
  styleBegin: '<!--msf:style-begin-->',
  styleEnd: '<!--msf:style-end-->',
  bodyBegin: '<!--msf:body-begin-->',
  bodyEnd: '<!--msf:body-end-->',
  scriptBegin: '<!--msf:script-begin-->',
  scriptEnd: '<!--msf:script-end-->',
} as const;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** S3（DSG-U04-2）选页选态协议——单页文档与汇总文档共用；无 hash 时默认显示首页首态。
 *  状态 section 可见性由本脚本独占（inline display）：事件委托接管 [data-show-state] 点击并同步激活态，
 *  页 CSS 一律不得隐藏 section（生成契约，validatePageHtml 拒收 display:none/visibility:hidden）。 */
export const NAV_SCRIPT = `<script>
(function(){
  function show(pageId,stateId){
    document.querySelectorAll('[data-page-block]').forEach(function(b){b.style.display=b.getAttribute('data-page-block')===pageId?'':'none';});
    document.querySelectorAll('section[data-page]').forEach(function(s){
      s.style.display=(s.getAttribute('data-page')===pageId&&(!stateId||s.getAttribute('data-state')===stateId))?'':'none';
    });
    document.querySelectorAll('[data-show-state]').forEach(function(t){
      var blk=t.closest('[data-page-block]');
      if(blk&&blk.getAttribute('data-page-block')===pageId){
        var on=t.getAttribute('data-show-state')===stateId;
        t.classList.toggle('active',on);t.setAttribute('aria-pressed',String(on));
      }
    });
  }
  window.prototypeNavigate=show;
  window.addEventListener('message',function(e){var d=e.data||{};if(d.type==='v19-prototype-select')show(d.pageId,d.stateId);});
  document.addEventListener('click',function(e){
    var t=e.target&&e.target.closest?e.target.closest('[data-show-state]'):null;
    if(!t)return;
    var blk=t.closest('[data-page-block]');
    if(blk)show(blk.getAttribute('data-page-block'),t.getAttribute('data-show-state'));
  });
  function fromHash(){
    var h=(location.hash||'').replace(/^#/,'').split('/');
    if(h[0])show(decodeURIComponent(h[0]),h[1]?decodeURIComponent(h[1]):null);
  }
  window.addEventListener('hashchange',fromHash);
  if(location.hash){fromHash();}
  else{
    var b=document.querySelector('[data-page-block]');
    var s=document.querySelector('section[data-page]');
    if(b)show(b.getAttribute('data-page-block'),s?s.getAttribute('data-state'):null);
  }
})();
</script>`;

/** 模型产物共享脚本补齐（幂等）：NAV_SCRIPT 属系统协议层，不依赖模型自觉输出——缺则在 </body> 前注入 */
export function ensureNavScript(html: string): string {
  if (html.includes('v19-prototype-select')) return html;
  const i = html.lastIndexOf('</body>');
  return i >= 0 ? `${html.slice(0, i)}${NAV_SCRIPT}\n${html.slice(i)}` : `${html}\n${NAV_SCRIPT}`;
}

/** 完整单页文档封装（envelope 标记 + 页根契约 + 共享选态脚本） */
export function wrapPageEnvelope(code: string, title: string, styleCss: string, bodyHtml: string, scriptJs: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
${MARK.styleBegin}<style>${styleCss}</style>${MARK.styleEnd}
</head><body>
${MARK.bodyBegin}${bodyHtml}${MARK.bodyEnd}
${MARK.scriptBegin}<script>${scriptJs}</script>${MARK.scriptEnd}
${NAV_SCRIPT}
</body></html>`;
}

/** envelope 抽取（缺任一标记 → null 拒绝，不做猜测性解析） */
export function extractPageParts(html: string): PageParts | null {
  const grab = (b: string, e: string): string | null => {
    const i = html.indexOf(b);
    const j = html.indexOf(e);
    if (i < 0 || j < 0 || j < i) return null;
    return html.slice(i + b.length, j).trim();
  };
  const styleBlock = grab(MARK.styleBegin, MARK.styleEnd);
  const body = grab(MARK.bodyBegin, MARK.bodyEnd);
  const scriptBlock = grab(MARK.scriptBegin, MARK.scriptEnd);
  if (styleBlock === null || body === null || scriptBlock === null) return null;
  return { styleBlock, body, scriptBlock };
}

/**
 * 状态 section 显隐独占校验：命中对 section[data-page…] 设 display:none / visibility:hidden / 带 !important 的
 * display 的规则 → 返回违例选择器（NAV_SCRIPT inline display 会被样式表 none 或 !important 压住，切态失效）。
 */
export function findHiddenSectionRule(css: string): string | null {
  const flat = stripKeyframes(css);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(flat)) !== null) {
    const sel = m[1] ?? '';
    const body = m[2] ?? '';
    if (!sel.includes('section[data-page')) continue;
    if (/display\s*:\s*none/.test(body)) return sel.trim();
    if (/visibility\s*:\s*hidden/.test(body)) return sel.trim();
    if (/display\s*:[^;]*!important/.test(body)) return sel.trim();
  }
  return null;
}

/** 剔除 @keyframes 整块（其内部 from/to/百分比不是选择器；含嵌套大括号配对） */function stripKeyframes(css: string): string {
  let out = css;
  for (;;) {
    const m = /@(-[\w]+-)?keyframes[^{}]*\{/.exec(out);
    if (!m) return out;
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < out.length && depth > 0) {
      if (out[i] === '{') depth += 1;
      else if (out[i] === '}') depth -= 1;
      i += 1;
    }
    out = out.slice(0, m.index) + out.slice(i);
  }
}

/** scoped 样式校验：每条规则的选择器（逗号拆分）均须以 `#pg-{code}` 开头；返回违例选择器清单 */
export function assertScopedStyles(css: string, code: string): string[] {
  const anchor = `#pg-${code}`;
  const cleaned = stripKeyframes(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const problems: string[] = [];
  const re = /([^{}]+)\{/g;
  for (let m = re.exec(cleaned); m; m = re.exec(cleaned)) {
    const head = m[1]!.trim();
    if (!head || head.startsWith('@')) continue; // @media 等 at-rule 头（内部规则仍逐条校验）
    for (const one of head.split(',')) {
      const s = one.trim();
      if (s && !s.startsWith(anchor)) problems.push(s);
    }
  }
  return problems;
}

/** 占位块（未生成页汇总回落；保留 data-page-block/data-page/data-state 标记，对应性检查不受影响） */
export function placeholderBlock(page: CatalogItemLike, states: CatalogItemLike[]): string {
  const title = (page.payload.title as string) ?? page.code;
  const hint = '（本页 UI 原型尚未生成——在左侧页面清单点 🎨 生成，或「✨ 全部生成」后重新汇总）';
  const statesHtml = states.length > 0
    ? states.map((s) =>
      `    <section data-page="${page.code}" data-state="${s.code}"><h2>${esc(title)} · ${esc((s.payload.title as string) ?? s.code)}</h2><p>${hint}</p></section>`,
    ).join('\n')
    : `    <section data-page="${page.code}"><h2>${esc(title)}</h2><p>${hint}</p></section>`;
  return `  <div data-page-block="${page.code}">\n${statesHtml}\n  </div>`;
}

/** mock 降级单页（AI_PROVIDER 未注入时；标记/封装/scoped 样式全合规，内容含标题+需求点 chip+每态骨架） */
export function buildMockPage(page: CatalogItemLike, states: CatalogItemLike[]): string {
  const code = page.code;
  const title = (page.payload.title as string) ?? code;
  const reqIds = (page.payload.reqIds as string[] | undefined) ?? [];
  const style = `
#pg-${code} { font: 14px/1.6 system-ui, -apple-system, sans-serif; color: #1f2937; padding: 20px; background: #f7f8fa; }
#pg-${code} .pg-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-bottom: 16px; }
#pg-${code} .pg-head h1 { font-size: 20px; margin: 0; }
#pg-${code} .pg-code { color: #6b7280; font-size: 12px; }
#pg-${code} .req-chip { background: #eef2ff; color: #1a6bbb; border-radius: 999px; padding: 1px 8px; font-size: 12px; }
#pg-${code} .mock-note { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 8px 12px; font-size: 12.5px; color: #92400e; margin-bottom: 14px; }
#pg-${code} .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
#pg-${code} .stat { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 10px 12px; }
#pg-${code} .stat b { display: block; font-size: 18px; }
#pg-${code} .stat span { color: #6b7280; font-size: 12px; }
#pg-${code} table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; overflow: hidden; }
#pg-${code} th, #pg-${code} td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #e5e7eb; font-size: 13px; }
#pg-${code} th { background: #f3f4f6; color: #6b7280; font-weight: 500; }
#pg-${code} .act-btn { background: #2783de; color: #fff; border: none; border-radius: 8px; padding: 6px 14px; cursor: pointer; }
#pg-${code} section[data-page] { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
`.trim();
  const stateSecs = (states.length > 0 ? states : [{ item_type: 'state', code: '', payload: { title: '' } } as CatalogItemLike]).map((s) => {
    const stAttr = s.code ? ` data-state="${s.code}"` : '';
    const stTitle = s.code ? ` · ${esc((s.payload.title as string) ?? s.code)}` : '';
    return `  <section data-page="${code}"${stAttr}>
    <div class="pg-head"><h1>${esc(title)}${stTitle}</h1><span class="pg-code">${esc(code)}</span>${reqIds.map((r) => `<span class="req-chip">${esc(r)}</span>`).join('')}</div>
    <div class="mock-note">本页为 mock 降级原型（未配置生成模型）：结构占位已合规，配置模型后点 🎨 重新生成可得高保真 UI。</div>
    <div class="card-row">
      <div class="stat"><b>128</b><span>示例指标一</span></div>
      <div class="stat"><b>96.2%</b><span>示例指标二</span></div>
      <div class="stat"><b>7</b><span>待处理事项</span></div>
    </div>
    <table>
      <thead><tr><th>名称</th><th>状态</th><th>负责人</th><th>更新时间</th></tr></thead>
      <tbody>
        <tr><td>示例记录 A</td><td>启用</td><td>张三</td><td>2026-10-01</td></tr>
        <tr><td>示例记录 B</td><td>停用</td><td>李四</td><td>2026-09-28</td></tr>
      </tbody>
    </table>
    <p style="margin-top:12px"><button class="act-btn">主要操作</button></p>
  </section>`;
  }).join('\n');
  const body = `<div id="pg-${code}" data-page-block="${code}">
${stateSecs}
</div>`;
  return wrapPageEnvelope(code, title, style, body, '(function(){})();');
}

/** 喂给模型的单文档上限（与 generate.service GEN_INPUT_CAP 同口径） */
export const PAGE_INPUT_CAP = 24000;

/** AI 单页生成提示词（输出契约即本文件头部契约；锚点/PRD 定稿注入使页面内容 grounded） */
export function buildPagePrompt(
  page: CatalogItemLike,
  states: CatalogItemLike[],
  anchors: Array<{ docKind: string | null; sectionId: string | null; anchor: string | null }>,
  upstreamPrd: string,
  instruction: string,
): string {
  const code = page.code;
  const title = (page.payload.title as string) ?? code;
  const route = (page.payload.route as string) ?? '';
  const reqIds = (page.payload.reqIds as string[] | undefined) ?? [];
  const stateList = states.map((s) => `${s.code}（${(s.payload.title as string) ?? s.code}）`).join('、');
  const anchorLines = anchors
    .map((a) => `- [${(a.docKind ?? 'prd').toUpperCase()}] ${a.sectionId ?? ''} ${a.anchor ?? ''}`.trim())
    .join('\n');
  return [
    `你是高保真 UI 原型设计师。请为「${title}」（页面编号 ${code}${route ? `，路由 ${route}` : ''}）生成一个完整可独立渲染的单页 HTML 原型。`,
    reqIds.length > 0 ? `本页承接需求条目：${reqIds.join('、')}。` : '',
    '',
    '## 硬性输出契约（逐条必须满足，否则产物被拒收）',
    `1. 输出且仅输出一个完整 HTML 文档（<!doctype html> 开头），不要输出任何解释文字或 markdown 围栏。`,
    `2. <style> 整段用 ${MARK.styleBegin} 与 ${MARK.styleEnd} 包裹；页面主体用 ${MARK.bodyBegin} 与 ${MARK.bodyEnd} 包裹；<script> 整段用 ${MARK.scriptBegin} 与 ${MARK.scriptEnd} 包裹。`,
    `3. 页面根元素必须是 <div id="pg-${code}" data-page-block="${code}">，全部页面内容在其内部。`,
    states.length > 0
      ? `4. 为以下每个状态各渲染一个 <section data-page="${code}" data-state="状态编号">（属性顺序必须是 data-page 在前 data-state 在后）：${stateList}。每个 section 呈现该状态下页面的真实形态（如空态/加载/错误/正常）。`
      : `4. 渲染一个 <section data-page="${code}"> 呈现页面主体。`,
    `5. 所有 CSS 选择器必须以 #pg-${code} 开头（逗号拆分后的每个选择器都算；@keyframes 除外）——本页将与其他页汇总进同一文档，样式必须完全隔离。`,
    `6. 脚本一律 IIFE，DOM 查询限定在 document.getElementById('pg-${code}') 子树内；不得改写 document 全局状态；无脚本则输出空 IIFE (function(){})();。`,
    '7. 不使用任何外部资源（无 CDN、无外链图片/字体/脚本）；图标用 emoji 或内联 SVG。',
    `8. 状态 section 的显示/隐藏一律不得用 CSS 或脚本控制（禁止对 section[data-page] 写 display:none 或 visibility:hidden，禁止自写 class 切换显隐）——可见性由系统共享脚本接管。页内状态切换按钮统一写 <button type="button" data-show-state="状态编号">，系统脚本会自动接管点击切换与激活态；默认展示第一个状态，不要给任何 section 预设隐藏。`,
    '',
    '## 质量要求',
    '- 中文界面、逼真占位数据（真实感的姓名/数字/日期，不要 lorem ipsum）。',
    '- 高保真：完整布局（导航/侧栏/工具栏/表格/表单/卡片/弹层之一以上），hover 与选中态，现代清爽配色。',
    `- 页面顶部渲染页面标题栏：页面名「${title}」+ 编号 ${code}${reqIds.length > 0 ? ` + 需求点标记（${reqIds.join('、')}）以 chip 样式展示` : ''}。`,
    '- 交互尽量用纯 HTML/CSS（:hover、:checked、details/summary），需要状态切换的交互用限定作用域的脚本实现。',
    instruction ? `\n## 用户补充指示\n${instruction}` : '',
    anchorLines ? `\n## 设计锚点（上游章节）\n${anchorLines}` : '',
    upstreamPrd ? `\n## 上游 PRD 定稿（节选）\n${upstreamPrd}` : '',
  ].filter(Boolean).join('\n');
}

/** 汇总输入：某页已生成的工作工件 */
export interface AssemblePageInput {
  code: string;
  parts: PageParts;
  objectKey: string;
  fingerprint: string;
  source: string;
}

export interface PrototypeManifest {
  pages: Array<{ code: string; title: string; objectKey?: string; fingerprint?: string; source?: string; placeholder?: boolean }>;
  states: Array<{ code: string; title: string }>;
  generatedBy: string;
  warnings?: string[];
}

/**
 * 汇总拼装：目录 page×state 全集 → 已生成页内嵌 envelope 段、未生成页回落占位块。
 * 产物保留全部 data-page-block/data-page/data-state 静态标记 → checkPrototype/定稿/基线零改动。
 */
export function composePrototype(
  items: CatalogItemLike[],
  pages: AssemblePageInput[],
  warnings: string[] = [],
): { html: string; manifest: PrototypeManifest } {
  const pageItems = items.filter((i) => i.item_type === 'page');
  const stateItems = items.filter((i) => i.item_type === 'state');
  const byCode = new Map(pages.map((p) => [p.code, p]));
  const blocks = pageItems.map((pi) => {
    const got = byCode.get(pi.code);
    if (!got) return placeholderBlock(pi, stateItems);
    return `  ${got.parts.styleBlock}\n  ${got.parts.body}`;
  }).join('\n');
  const scripts = pages
    .map((p) => p.parts.scriptBlock)
    .filter((s) => s.replace(/<\/?script>/g, '').trim().length > 4)
    .join('\n');
  const nav = pageItems.map((p) => `<a href="#${p.code}">${esc((p.payload.title as string) ?? p.code)}</a>`).join(' | ');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>客户原型（汇总）</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:16px}nav{margin-bottom:12px}</style></head>
<body data-prototype="msf">
<nav>${nav}</nav>
${blocks}
${scripts}
${NAV_SCRIPT}
</body></html>`;
  const manifest: PrototypeManifest = {
    pages: pageItems.map((pi) => {
      const got = byCode.get(pi.code);
      const title = (pi.payload.title as string) ?? pi.code;
      return got
        ? { code: pi.code, title, objectKey: got.objectKey, fingerprint: got.fingerprint, source: got.source }
        : { code: pi.code, title, placeholder: true };
    }),
    states: stateItems.map((s) => ({ code: s.code, title: (s.payload.title as string) ?? s.code })),
    generatedBy: 'assemble',
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return { html, manifest };
}
