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
 * - 跨页穿流（覆盖检测 §3）：跳转类按钮/链接挂 data-nav="#P-002"（可带状态 "#P-002/s2"；纯展示不挂）；
 *   NAV_SCRIPT 事件委托接管点击（目标块不存在 no-op——单页预览直开防白屏）+ hash 同步；
 *   validatePageHtml 校验目标页/状态在目录集内（start() 查全量 items 传入）。
 */

import { splitSections, type DocSection } from '../platform/doc-sections.js';

export interface CatalogItemLike {
  item_type: string;
  code: string;
  payload: Record<string, unknown>;
}

/** ui 册「页面/界面」章节标题判别（plan 页面种子与双向一致性检查共用单点口径）。
 *  2026-10-18 收紧（贪吃蛇实机抓修）：原口径含「页面」即中，把「页面清单/页面入口与导航关系/
 *  页面层级与复用组件/页面四态与操作许可」这类【关于页面的 meta 章节】误识别为页面 → 目录
 *  充斥假页面。新口径=标题以「页/界面」收尾才算一个页面（允许尾部括号注记，如
 *  「门户首页（页面）」✓；页面清单/页面规范等「关于页面」的章节 ✗）。 */
export const UI_PAGE_SECTION_RE = /(界面|页面|页)(\s*[（(][^）)]{0,10}[）)])?\s*$/;

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
 *  页 CSS 一律不得隐藏 section（生成契约，validatePageHtml 拒收 display:none/visibility:hidden）。
 *  覆盖检测 §3 穿流：document 级 click 委托接管 [data-nav]（"#页码" 或 "#页码/状态"）——
 *  切目标页+hash 同步；目标块不存在时 no-op（单页预览直开场景防白屏，preventDefault 先行拦截
 *  <a data-nav> 默认跳 hash 导致 fromHash 把唯一页块隐藏的白屏）。 */
export const NAV_SCRIPT = `<script>
(function(){
  // T7 Minor：手工上传 HTML 的 data-nav 值可能含非法转义（如百分号后非十六进制）——decode 抛错会打断整个点击委托，包 try/catch 回落原串
  function dec(s){try{return decodeURIComponent(s);}catch(e){return s;}}
  // 场景首页（0034 汇总壳重构）：有 [data-shell-index] 时 hash 为空=显示场景索引，隐藏全部页块
  function showHome(){
    var ix=document.querySelector('[data-shell-index]');
    if(!ix)return; // 单页预览/无流程旧产物无索引——no-op 防白屏
    document.querySelectorAll('[data-page-block]').forEach(function(b){b.style.display='none';});
    document.querySelectorAll('section[data-page]').forEach(function(s){s.style.display='none';});
    ix.style.display='';
    document.querySelectorAll('[data-shell-nav]').forEach(function(a){a.classList.remove('on');});
    var cr=document.querySelector('[data-shell-crumb]');if(cr)cr.textContent='场景首页';
  }
  function show(pageId,stateId){
    var ix=document.querySelector('[data-shell-index]');if(ix)ix.style.display='none';
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
    // 汇总壳同步（单页预览无壳元素，自动 no-op）：左侧导航高亮 + 顶栏面包屑
    document.querySelectorAll('[data-shell-nav]').forEach(function(a){
      a.classList.toggle('on',a.getAttribute('data-shell-nav')===pageId);
    });
    var cr=document.querySelector('[data-shell-crumb]');
    if(cr){var na=document.querySelector('[data-shell-nav="'+pageId+'"]');cr.textContent=(na&&na.getAttribute('data-title'))||pageId||'';}
  }
  window.prototypeNavigate=show;
  window.addEventListener('message',function(e){var d=e.data||{};if(d.type==='v19-prototype-select')show(d.pageId,d.stateId);});
  document.addEventListener('click',function(e){
    // 壳层控件先行（0034）：🏠 回场景首页 / ☰ 左导航收展——单页预览无此元素自动 no-op
    var hm=e.target&&e.target.closest?e.target.closest('[data-shell-home]'):null;
    if(hm){e.preventDefault();if(location.hash){location.hash='';}else{showHome();}return;}
    var tg=e.target&&e.target.closest?e.target.closest('[data-shell-toggle]'):null;
    if(tg){e.preventDefault();document.body.classList.toggle('nav-on');return;}
    var n=e.target&&e.target.closest?e.target.closest('[data-nav]'):null;
    if(n){
      e.preventDefault();
      var v=n.getAttribute('data-nav')||'';
      var h=v.replace(/^#/,'').split('/');
      var pid=h[0]?dec(h[0]):'';
      if(!pid)return;
      var found=false;
      document.querySelectorAll('[data-page-block]').forEach(function(b){if(b.getAttribute('data-page-block')===pid)found=true;});
      if(!found)return;
      if(location.hash!==v){location.hash=v;}
      else{show(pid,h[1]?dec(h[1]):null);}
      return;
    }
    var t=e.target&&e.target.closest?e.target.closest('[data-show-state]'):null;
    if(!t)return;
    var blk=t.closest('[data-page-block]');
    if(blk)show(blk.getAttribute('data-page-block'),t.getAttribute('data-show-state'));
  });
  function fromHash(){
    var h=(location.hash||'').replace(/^#/,'').split('/');
    if(h[0]){show(decodeURIComponent(h[0]),h[1]?decodeURIComponent(h[1]):null);}
    else{showHome();}
  }
  window.addEventListener('hashchange',fromHash);
  if(location.hash){fromHash();}
  else if(document.querySelector('[data-shell-index]')){showHome();}
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

/** 风格基线补齐（幂等）：模型产物缺主题令牌时注入主题 CSS——单页预览（无汇总壳）也有统一视觉。
 *  在 </head> 前插入，不与 msf:style 标记段混淆（extractPageParts 只取标记段，汇总不重复携带）。
 *  themeCss=项目定制主题（buildThemeCss(plan.theme)），缺省默认蓝系。
 *  0034：主题块带 data-msf-theme 标记（换肤精确定位锚）；幂等判据=标记或令牌定义串「--p-primary:」
 *  （含冒号=定义；模型页 CSS 里的 var(--p-primary) 引用不算——2026-10-18 抓修：引用阻注入的边缘）。 */
export function ensureThemeStyle(html: string, themeCss: string = PROTO_THEME_CSS): string {
  if (html.includes('data-msf-theme') || html.includes('--p-primary:')) return html;
  const tag = `<style data-msf-theme>${themeCss}</style>`;
  const i = html.indexOf('</head>');
  return i >= 0 ? `${html.slice(0, i)}${tag}\n${html.slice(i)}` : `${tag}\n${html}`;
}

/**
 * 换肤（0034 主题方案库「换方案不重写内容」）：页 HTML 主题令牌换成新主题 CSS，页面自身
 * 样式段（msf:style 标记内）与正文不动。三路定位：
 *  ① data-msf-theme 标记块（0034 起系统注入）→ 整块精确替换；
 *  ② 令牌定义在页样式标记段内（模型自定 :root）→ 不拆段，</head> 前追加覆盖块（CSS 层叠后者胜）；
 *  ③ 0033 期无标记系统块（plain &lt;style&gt;，标记段外）→ 整块替换并补标记（收敛到 ①）。
 * 找不到任何令牌定义 → 等价 ensureThemeStyle 注入。幂等：同主题重复换肤结果相同。
 */
export function replaceThemeStyle(html: string, themeCss: string): string {
  const tag = `<style data-msf-theme>${themeCss}</style>`;
  const mk = html.indexOf('<style data-msf-theme>');
  if (mk >= 0) {
    const close = html.indexOf('</style>', mk);
    if (close < 0) return html; // 结构异常不改写（宁留旧肤不破坏文档）
    return `${html.slice(0, mk)}${tag}${html.slice(close + '</style>'.length)}`;
  }
  const key = html.indexOf('--p-primary:');
  if (key < 0) return ensureThemeStyle(html, themeCss);
  const sb = html.indexOf(MARK.styleBegin);
  const se = html.indexOf(MARK.styleEnd);
  if (sb >= 0 && se > sb && key > sb && key < se) {
    const h = html.indexOf('</head>');
    return h >= 0 ? `${html.slice(0, h)}${tag}\n${html.slice(h)}` : `${html}\n${tag}`;
  }
  const open = html.lastIndexOf('<style>', key);
  const close = html.indexOf('</style>', key);
  if (open < 0 || close < 0) return html;
  return `${html.slice(0, open)}${tag}${html.slice(close + '</style>'.length)}`;
}

/**
 * 模型输出清洗（2026-10-18 实机抓修「思考过程被渲染出来」）：只保留文档本体——
 * 剥 ```html 围栏、丢弃 <!doctype/<html> 之前的推理/解释前言与 </html> 之后的尾巴。
 * 过程性内容不进工件（生成过程由 SSE 进度流承载可见，成品只呈现干净结果）。
 */
export function ensureDocumentOnly(html: string): string {
  let s = html;
  const dt = s.search(/<!doctype\s+html/i);
  const ht = s.search(/<html[\s>]/i);
  const from = dt >= 0 ? dt : ht;
  if (from > 0) s = s.slice(from);
  else if (from < 0) s = s.replace(/^\s*```(?:html)?\s*/i, ''); // 无文档头时至少剥首围栏
  const end = s.lastIndexOf('</html>');
  if (end >= 0) s = s.slice(0, end + '</html>'.length);
  return s.replace(/\s*```\s*$/, '').trim();
}

/**
 * 原型风格基线（2026-10-17 用户复验「每页各画各的、颜色文字风格不一致」根修）：
 * 全项目单源的设计令牌+共享组件类——单页封装与汇总壳都注入本块，页 prompt 契约钉死
 * 「只准用 var(--p-*) 令牌与共享类，禁写死颜色/字号」，validatePageHtml 扫 hex 色拒收。
 * 页面自身 CSS 只做布局与独有样式（仍须 #pg-<code> 前缀隔离），视觉语言全来自本基线。
 * 2026-10-18 扩展：令牌默认值可被 dsg_plans.theme（AI 按项目类型提炼，0033）逐项覆盖，
 * buildThemeCss(overrides) 合成最终 CSS；共享类段恒定不变。
 */
export const PROTO_THEME_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['primary', '#2563eb'], ['primary-soft', '#eff4ff'], ['accent', '#7c3aed'],
  ['bg', '#f5f6f8'], ['surface', '#ffffff'], ['ink', '#1f2329'], ['ink2', '#6b7280'],
  ['line', '#e5e7eb'], ['ok', '#16a34a'], ['ok-soft', '#eaf7ee'],
  ['warn', '#d97706'], ['warn-soft', '#fdf3e3'], ['danger', '#dc2626'], ['danger-soft', '#fdecec'],
  ['radius', '10px'],
] as const;
/** 主题令牌默认值表（键=令牌后缀，如 primary） */
export const THEME_TOKEN_DEFAULTS: Readonly<Record<string, string>> =
  Object.fromEntries(PROTO_THEME_TOKENS);

/** 令牌中文名（页 prompt 风格基线实值注入用） */
const TOKEN_LABELS: Readonly<Record<string, string>> = {
  primary: '主色', 'primary-soft': '主色浅底', accent: '强调色',
  bg: '背景', surface: '卡片面', ink: '正文文字', ink2: '次要文字',
  line: '边框', ok: '成功色', 'ok-soft': '成功浅底',
  warn: '警告色', 'warn-soft': '警告浅底', danger: '危险色', 'danger-soft': '危险浅底',
  radius: '圆角',
};

/** 合成主题 CSS（overrides=项目定制令牌覆盖，键非法/值非法已在 parseThemeOverrides 滤掉） */
export function buildThemeCss(overrides?: Record<string, string> | null): string {
  const o = overrides ?? {};
  const root = `:root{${PROTO_THEME_TOKENS.map(([k, v]) => `--p-${k}:${o[k] ?? v};`).join('')}}`;
  return `${root}\n${SHARED_CLASS_CSS}`;
}

/** 共享组件类段（恒定——项目定制只改令牌值，不改组件结构；字体令牌固定不开放定制） */
const SHARED_CLASS_CSS = `:root{--p-font:14px/1.6 "PingFang SC","Microsoft YaHei",system-ui,sans-serif;}
body{font:var(--p-font);color:var(--p-ink);background:var(--p-bg);margin:0;}
.btn{border:1px solid var(--p-line);background:var(--p-surface);border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer;color:var(--p-ink);}
.btn:hover{border-color:var(--p-primary);color:var(--p-primary);}
.btn.primary{background:var(--p-primary);border-color:var(--p-primary);color:#fff;}
.btn.primary:hover{filter:brightness(1.08);color:#fff;}
.input{border:1px solid var(--p-line);border-radius:8px;padding:6px 10px;font-size:13px;background:var(--p-surface);color:var(--p-ink);}
.input:focus{outline:none;border-color:var(--p-primary);}
table.tbl{width:100%;border-collapse:collapse;font-size:13px;background:var(--p-surface);}
table.tbl th{text-align:left;color:var(--p-ink2);font-weight:500;padding:8px 10px;border-bottom:1px solid var(--p-line);}
table.tbl td{padding:9px 10px;border-bottom:1px solid var(--p-line);}
.tagline{display:inline-block;border-radius:999px;padding:1px 9px;font-size:11.5px;}
.tagline.ok{background:var(--p-ok-soft);color:var(--p-ok);}
.tagline.warn{background:var(--p-warn-soft);color:var(--p-warn);}
.tagline.danger{background:var(--p-danger-soft);color:var(--p-danger);}
.stat{display:inline-flex;flex-direction:column;background:var(--p-surface);border:1px solid var(--p-line);border-radius:var(--p-radius);padding:12px 18px;margin:0 10px 10px 0;}
.stat b{font-size:20px;color:var(--p-primary);}
.stat span{font-size:12px;color:var(--p-ink2);}
.page-card{background:var(--p-surface);border:1px solid var(--p-line);border-radius:var(--p-radius);padding:18px 20px;}
.page-card h1{font-size:18px;margin:0 0 4px;}
.page-card .sub{color:var(--p-ink2);font-size:12.5px;margin-bottom:14px;}`;

/** 默认主题（无定制覆盖时的完整 CSS；兼容旧引用点） */
export const PROTO_THEME_CSS = buildThemeCss();

/** 主题令牌覆盖白名单校验（单一校验源）：键限 PROTO_THEME_TOKENS，颜色 6 位 hex、radius px 值；非法键值静默丢弃 */
export function sanitizeThemeTokens(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null) return {};
  const allowed = new Set(PROTO_THEME_TOKENS.map(([k]) => k));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    const val = v.trim();
    if (k === 'radius' ? /^\d{1,2}px$/.test(val) : /^#[0-9a-fA-F]{6}$/.test(val)) out[k] = val;
  }
  return out;
}

/** AI 主题定制输出解析：剥围栏→取首个 JSON 对象→ sanitizeThemeTokens 白名单校验 */
export function parseThemeOverrides(text: string): Record<string, string> {
  const m = text.replace(/```(?:json)?/gi, '').match(/\{[\s\S]*\}/);
  if (!m) return {};
  let raw: unknown;
  try { raw = JSON.parse(m[0]); } catch { return {}; }
  return sanitizeThemeTokens(raw);
}

/**
 * 内置主题方案库（0034，用户拍板「多套基础默认选项+可自定义」）：代码基线不入库（同 doc-templates 哲学），
 * 自定义方案存 proto_themes 表。id 形态：builtin:*=内置（不可改删）；'ai'=AI 按项目定制（0033 懒派生）；
 * uuid=自定义。plan.theme_id NULL 兼容旧数据=AI 懒派生。
 */
export const AI_THEME_ID = 'ai';
export interface ProtoThemePreset { id: string; name: string; desc: string; tokens: Record<string, string> }
export const PROTO_THEME_PRESETS: ReadonlyArray<ProtoThemePreset> = [
  { id: 'builtin:default', name: '科技蓝（默认）', desc: '清爽通用的蓝色系，适合大多数工具/企业产品', tokens: {} },
  { id: 'builtin:orange', name: '活力橙', desc: '暖色高能量，适合运营/电商/活动类产品', tokens: { primary: '#ea580c', 'primary-soft': '#fff1e7', accent: '#f59e0b', radius: '12px' } },
  { id: 'builtin:violet', name: '游戏紫', desc: '活泼撞色+大圆角，适合游戏/娱乐/年轻向产品', tokens: { primary: '#6d28d9', 'primary-soft': '#f3efff', accent: '#f59e0b', radius: '16px' } },
  {
    id: 'builtin:dark', name: '深色模式', desc: '暗底高对比，适合开发者工具/夜间场景',
    tokens: {
      bg: '#14171c', surface: '#1e222a', ink: '#e8eaee', ink2: '#9aa3af', line: '#333a45',
      primary: '#5b8def', 'primary-soft': '#26314a', accent: '#a78bfa',
      ok: '#34d399', 'ok-soft': '#14342a', warn: '#fbbf24', 'warn-soft': '#3a2f14',
      danger: '#f87171', 'danger-soft': '#3d1d1d',
    },
  },
  { id: 'builtin:mono', name: '极简灰', desc: '克制中性+小圆角，适合文档/政务/严肃场景', tokens: { primary: '#374151', 'primary-soft': '#f3f4f6', accent: '#6b7280', radius: '4px' } },
];

/** AI 主题定制 prompt（一次性小调用；输出严格 JSON 令牌覆盖） */
export function buildThemePrompt(projectName: string, prdExcerpt: string): string {
  return [
    `你是 UI 视觉设计师。项目「${projectName}」需要一套原型界面主题配色。`,
    '根据下面的需求文档节选判断产品类型与气质（如游戏活泼、政务稳重、工具清爽、内容温暖），给出一套配色令牌覆盖。',
    '',
    '## 硬性输出契约',
    '- 只输出一个 JSON 对象，不要任何解释文字或 markdown 围栏。',
    `- 键只能从这里面选（不需要全给，只给要覆盖的）：${PROTO_THEME_TOKENS.map(([k]) => k).join('、')}。`,
    '- 颜色值必须是 6 位 hex（如 #16a34a）；radius 是像素值（如 12px）；soft 后缀键是同色系浅底（与对应主色协调）。',
    '- 对比度可用性：ink 在 bg/surface 上、白字在 primary 上都须清晰可读；primary 不要太浅。',
    '',
    '## 需求文档节选',
    prdExcerpt.slice(0, 4000),
  ].join('\n');
}

/** 完整单页文档封装（envelope 标记 + 页根契约 + 风格基线 + 共享选态脚本）。
 *  主题块在标记段之外——extractPageParts 只取标记段，汇总时主题由壳层统一供给不重复。
 *  themeCss=项目定制主题（缺省默认）。 */
export function wrapPageEnvelope(code: string, title: string, styleCss: string, bodyHtml: string, scriptJs: string, themeCss: string = PROTO_THEME_CSS): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style data-msf-theme>${themeCss}</style>
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

// ---------- 跨页穿流（覆盖检测 §3） ----------

/** data-nav 属性提取（双/单引号均认；返回原始属性值含 # 前缀，供校验/manifest 清单用） */
export function extractDataNavTargets(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/data-nav\s*=\s*"([^"]*)"|data-nav\s*=\s*'([^']*)'/g)) {
    out.push(m[1] ?? m[2] ?? '');
  }
  return out;
}

/** data-nav 属性值解析：契约钉死 "#页码" 或 "#页码/状态编号"（须 # 开头）；非法 → null */
export function parseNavRef(v: string): { page: string; state: string | null } | null {
  const m = /^#([\w-]+?)(?:\/([\w-]+))?$/.exec(v.trim());
  return m ? { page: m[1]!, state: m[2] ?? null } : null;
}

/** 流程步骤引用判别（覆盖检测 §3 兼容口径）：仅 P- 前缀页码形态（可带 # 与 /状态）算「声明了引用」；
 *  旧格式 steps（REQ 章节标题字符串，REQ-/中文开头）永不命中 → 按「未声明引用」不校验不渲染跳转。 */
export function parseFlowStepRef(step: string): { page: string; state: string | null } | null {
  const m = /^#?(P-[\w-]+?)(?:\/([\w-]+))?$/.exec(step.trim());
  return m ? { page: m[1]!, state: m[2] ?? null } : null;
}

/** data-nav 目标分类（T7 Minor：页级契约校验与汇总 check 共用单点分类器，防单边漂移）：
 *  ok=合法且目标在目录集内；bad-format=属性格式非法；unknown-page=目标页不在目录；unknown-state=目标状态不在目录 */
export type DataNavVerdict = 'ok' | 'bad-format' | 'unknown-page' | 'unknown-state';
export function classifyDataNavTarget(raw: string, pageCodes: ReadonlySet<string>, stateCodes: ReadonlySet<string>): DataNavVerdict {
  const ref = parseNavRef(raw);
  if (!ref) return 'bad-format';
  if (!pageCodes.has(ref.page)) return 'unknown-page';
  if (ref.state && !stateCodes.has(ref.state)) return 'unknown-state';
  return 'ok';
}

/** data-nav 目标校验（页级契约校验 validatePageHtml 用；与汇总 checkPrototype 共用 classifyDataNavTarget，
 *  本函数取首条、check 侧收全部——分类口径单点，消息文案各自保留）。null=通过，否则返回首条问题描述。 */
export function findDataNavProblem(html: string, pageCodes: ReadonlySet<string>, stateCodes: ReadonlySet<string>): string | null {
  for (const raw of extractDataNavTargets(html)) {
    const verdict = classifyDataNavTarget(raw, pageCodes, stateCodes);
    if (verdict === 'ok') continue;
    if (verdict === 'bad-format') return `data-nav 属性格式非法（须 data-nav="#页码" 或 "#页码/状态编号"）：${raw}`;
    const ref = parseNavRef(raw)!; // bad-format 已在上方返回——此处必可解析
    if (verdict === 'unknown-page') return `data-nav 目标页 ${ref.page} 不在目录页面集内`;
    return `data-nav 目标状态 ${ref.state} 不在目录状态集内`;
  }
  return null;
}

/** 占位块（未生成页汇总回落；保留 data-page-block/data-page/data-state 标记，对应性检查不受影响；
 *  视觉走风格基线共享类 page-card/tagline） */
export function placeholderBlock(page: CatalogItemLike, states: CatalogItemLike[]): string {
  const title = (page.payload.title as string) ?? page.code;
  const hint = '本页 UI 原型尚未生成——在左侧页面清单点 🎨 生成，或「✨ 全部生成」后重新汇总。';
  const inner = (suffix: string) =>
    `<div class="page-card"><h2>${esc(title)}${suffix}</h2><p><span class="tagline warn">待生成</span> ${hint}</p></div>`;
  const statesHtml = states.length > 0
    ? states.map((s) =>
      `    <section data-page="${page.code}" data-state="${s.code}">${inner(` · ${esc((s.payload.title as string) ?? s.code)}`)}</section>`,
    ).join('\n')
    : `    <section data-page="${page.code}">${inner('')}</section>`;
  return `  <div data-page-block="${page.code}">\n${statesHtml}\n  </div>`;
}

/** mock 降级单页（AI_PROVIDER 未注入时；标记/封装/scoped 样式全合规，内容含标题+需求点 chip+每态骨架）。
 *  navTargets=目录其它页面（自身剔除，上限 6）→ 渲染 data-nav 穿流按钮，汇总版即可点穿流。 */
export function buildMockPage(
  page: CatalogItemLike,
  states: CatalogItemLike[],
  navTargets: Array<{ code: string; title: string }> = [],
  themeCss: string = PROTO_THEME_CSS,
): string {
  const code = page.code;
  const title = (page.payload.title as string) ?? code;
  const reqIds = (page.payload.reqIds as string[] | undefined) ?? [];
  const navs = navTargets.filter((t) => t.code !== code).slice(0, 6);
  const navRow = navs.length > 0
    ? `  <p class="mock-nav">穿流跳转：${navs.map((t) => `<button type="button" class="btn" data-nav="#${t.code}">${esc(t.title)}</button>`).join(' ')}</p>`
    : '';
  const style = `
#pg-${code} { padding: 0; }
#pg-${code} .pg-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border-bottom: 2px solid var(--p-line); padding-bottom: 10px; margin-bottom: 16px; }
#pg-${code} .pg-head h1 { font-size: 18px; margin: 0; }
#pg-${code} .pg-code { color: var(--p-ink2); font-size: 12px; }
#pg-${code} .req-chip { background: var(--p-primary-soft); color: var(--p-primary); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
#pg-${code} .mock-note { background: var(--p-warn-soft); border: 1px solid var(--p-warn); border-radius: 8px; padding: 8px 12px; font-size: 12.5px; color: var(--p-warn); margin-bottom: 14px; }
#pg-${code} .mock-nav { margin: 0 0 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; color: var(--p-ink2); }
#pg-${code} .card-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
#pg-${code} .card-row .stat { margin: 0; }
`.trim();
  const stateSecs = (states.length > 0 ? states : [{ item_type: 'state', code: '', payload: { title: '' } } as CatalogItemLike]).map((s) => {
    const stAttr = s.code ? ` data-state="${s.code}"` : '';
    const stTitle = s.code ? ` · ${esc((s.payload.title as string) ?? s.code)}` : '';
    return `  <section data-page="${code}"${stAttr}>
    <div class="page-card">
    <div class="pg-head"><h1>${esc(title)}${stTitle}</h1><span class="pg-code">${esc(code)}</span>${reqIds.map((r) => `<span class="req-chip">${esc(r)}</span>`).join('')}</div>
    <div class="mock-note">本页为 mock 降级原型（未配置生成模型）：结构占位已合规，配置模型后点 🎨 重新生成可得高保真 UI。</div>
    <div class="card-row">
      <div class="stat"><b>128</b><span>示例指标一</span></div>
      <div class="stat"><b>96.2%</b><span>示例指标二</span></div>
      <div class="stat"><b>7</b><span>待处理事项</span></div>
    </div>
    <table class="tbl">
      <thead><tr><th>名称</th><th>状态</th><th>负责人</th><th>更新时间</th></tr></thead>
      <tbody>
        <tr><td>示例记录 A</td><td><span class="tagline ok">启用</span></td><td>张三</td><td>2026-10-01</td></tr>
        <tr><td>示例记录 B</td><td><span class="tagline warn">停用</span></td><td>李四</td><td>2026-09-28</td></tr>
      </tbody>
    </table>
    <p style="margin-top:12px"><button class="btn primary">主要操作</button></p>
    </div>
  </section>`;
  }).join('\n');
  const body = `<div id="pg-${code}" data-page-block="${code}">
${navRow}${stateSecs}
</div>`;
  return wrapPageEnvelope(code, title, style, body, '(function(){})();', themeCss);
}

/** 喂给模型的单文档上限（与 generate.service GEN_INPUT_CAP 同口径） */
export const PAGE_INPUT_CAP = 24000;

/**
 * UI 册正文节选（页级 prompt 注入，覆盖检测 §2）：页面相关章节优先——
 * 按页 payload.reqIds 命中章节标题/正文、或页标题与章节标题互含判定相关；
 * 其余章节按原序补齐，节选上限同 PRD 的 PAGE_INPUT_CAP 口径。
 */
export function pickUiSections(content: string, page: CatalogItemLike): string {
  const secs = splitSections(content).filter((s) => s.title);
  if (secs.length === 0) return '';
  const reqIds = (page.payload.reqIds as string[] | undefined) ?? [];
  const title = ((page.payload.title as string) ?? '').trim();
  const relevant = (s: DocSection): boolean =>
    reqIds.some((r) => `${s.title}\n${s.md}`.includes(r))
    || (title !== '' && (s.title.includes(title) || title.includes(s.title)));
  const ordered = [...secs.filter(relevant), ...secs.filter((s) => !relevant(s))];
  let out = '';
  for (const s of ordered) {
    const chunk = `## ${s.title}\n\n${s.md}`;
    if (out && out.length + chunk.length + 2 > PAGE_INPUT_CAP) break;
    out += `${out ? '\n\n' : ''}${chunk}`;
    if (out.length > PAGE_INPUT_CAP) {
      out = `${out.slice(0, PAGE_INPUT_CAP)}\n\n[原文过长，已截断]`;
      break;
    }
  }
  return out;
}

/** AI 单页生成提示词（输出契约即本文件头部契约；锚点/PRD/UI 册定稿注入使页面内容 grounded）。
 *  navPages=目录其它页面清单（覆盖检测 §3 穿流契约的合法跳转目标；缺省=旧调用不列清单） */
export function buildPagePrompt(
  page: CatalogItemLike,
  states: CatalogItemLike[],
  anchors: Array<{ docKind: string | null; sectionId: string | null; anchor: string | null }>,
  upstreamPrd: string,
  upstreamUi: string,
  instruction: string,
  navPages?: Array<{ code: string; title: string }>,
  theme?: Record<string, string> | null,
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
    `9. 跨页穿流：跳转类按钮/链接（点击后应进入其它页面的）必须挂 data-nav 属性——格式 data-nav="#P-002"，可带状态 data-nav="#P-002/状态编号"；点击跳转由系统共享脚本接管，脚本不得自行实现跨页跳转。纯展示或仅页内交互的按钮一律不挂 data-nav。${navPages && navPages.length > 0 ? `本原型可跳转目标仅限目录页面：${navPages.map((p) => `${p.code}（${p.title}）`).join('、')}；不得指向目录外页码。` : ''}`,
    '10. 本页是完整应用的一个内容区：不要画产品级全局顶栏/全局左侧导航/产品 logo 区（汇总时由统一应用壳提供），从页面标题栏与内容区开始画。',
    '',
    '## 风格基线（全原型统一，必须遵守）',
    ...PROTO_THEME_TOKENS.map(([k, def]) => {
      const v = theme?.[k] ?? def;
      const label = TOKEN_LABELS[k] ?? k;
      return `- ${label} var(--p-${k})（${v}）`;
    }),
    '- 配色一律使用以上系统主题令牌（var(--p-*)），禁止写死任何颜色值（如 #fff/#1f2937）与字体族（字体固定 var(--p-font)）。',
    '- 优先使用系统共享类（已在文档层提供样式，直接用类名即可，不要在页 CSS 里重复定义）：按钮 .btn / .btn.primary、输入框 .input、表格 table.tbl、状态标签 .tagline.ok/.tagline.warn/.tagline.danger、指标卡 .stat、页卡片容器 .page-card（h1+.sub 副标题）。',
    '- 页 CSS 只写本页独有的布局与装饰（网格/间距/可视化），颜色仍须引用上述令牌。',
    '',
    '## 质量要求',
    '- 中文界面、逼真占位数据（真实感的姓名/数字/日期，不要 lorem ipsum）。',
    '- 高保真：完整内容区布局（页头/工具栏/表格/表单/卡片/弹层之一以上），hover 与选中态；视觉风格完全取自风格基线，不要自行发明配色与字体。',
    `- 页面顶部渲染页面标题栏：页面名「${title}」+ 编号 ${code}${reqIds.length > 0 ? ` + 需求点标记（${reqIds.join('、')}）以 chip 样式展示` : ''}。`,
    '- 交互尽量用纯 HTML/CSS（:hover、:checked、details/summary），需要状态切换的交互用限定作用域的脚本实现。',
    instruction ? `\n## 用户补充指示\n${instruction}` : '',
    anchorLines ? `\n## 设计锚点（上游章节）\n${anchorLines}` : '',
    upstreamPrd ? `\n## 上游 PRD 定稿（节选）\n${upstreamPrd}` : '',
    upstreamUi ? `\n## 上游 UI 册当前版本（节选）\n${upstreamUi}` : '',
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
  /** 覆盖检测 §3 冻结兼容：flow 快照 + data-nav 目标清单（jsonb 内扩展，零迁移；无 flow/无穿流则不出现该键） */
  flows?: Array<{ code: string; title: string; steps: string[] }>;
  dataNavTargets?: string[];
  warnings?: string[];
}

/** 单条流程卡片（场景索引/左导航共用渲染核）：新格式步骤（页面/状态引用 P-xxx[/ST-xxx]）渲染为
 *  data-nav 可点跳转（点击跳对应 hash）；目标页/状态不在目录时降级纯文本（不穿流，check 侧报
 *  FLOW_REF_MISSING）；旧格式 steps（REQ 章节标题字符串）渲染纯文本步骤——兼容口径。 */
function renderFlowCard(f: CatalogItemLike, pageByCode: ReadonlyMap<string, CatalogItemLike>, stateByCode: ReadonlyMap<string, CatalogItemLike>): string {
  const steps = (f.payload.steps as string[] | undefined) ?? [];
  const lis = steps.map((s) => {
    const ref = parseFlowStepRef(s);
    const target = ref ? pageByCode.get(ref.page) : undefined;
    const stateOk = !ref?.state || stateByCode.has(ref.state);
    if (!ref || !target || !stateOk) return `<li class="msf-flow-step">${esc(s)}</li>`;
    const stTitle = ref.state ? ((stateByCode.get(ref.state)?.payload.title as string | undefined) ?? ref.state) : '';
    const label = `${esc((target.payload.title as string) ?? ref.page)}${stTitle ? ` · ${esc(stTitle)}` : ''}`;
    const hash = `#${ref.page}${ref.state ? `/${ref.state}` : ''}`;
    return `<li class="msf-flow-step"><a href="${hash}" data-nav="${hash}">${label}</a></li>`;
  }).join('');
  return `<div class="msf-flow" data-flow="${esc(f.code)}"><h3>${esc((f.payload.title as string) ?? f.code)}<span class="msf-flow-code">${esc(f.code)}</span></h3><ol>${lis}</ol></div>`;
}

/**
 * 场景索引页（0034 汇总壳重构，用户拍板「汇总=①场景流程清单可跳单页 + ②像真实产品的可交互原型」）：
 * 整本默认落页——列出全部使用场景（flow）卡片，步骤可点跳对应单页；尾部附全部页面直达网格。
 * data-shell-index 由 NAV_SCRIPT 接管显隐（hash 空=显示索引；跳页=隐藏）。仅目录含 flow 条目时产出。
 */
function renderScenarioIndex(flows: CatalogItemLike[], pageItems: CatalogItemLike[], stateItems: CatalogItemLike[], product: string): string {
  const pageByCode = new Map(pageItems.map((p) => [p.code, p]));
  const stateByCode = new Map(stateItems.map((s) => [s.code, s]));
  const cards = flows.map((f) => renderFlowCard(f, pageByCode, stateByCode)).join('\n');
  const pageLinks = pageItems.map((p) =>
    `<a class="msf-pglink" href="#${esc(p.code)}" data-nav="#${esc(p.code)}"><span class="c">${esc(p.code)}</span>${esc((p.payload.title as string) ?? p.code)}</a>`,
  ).join('\n');
  return `<div class="msf-index" data-shell-index style="display:none">
  <h1>${esc(product)} · 使用场景</h1>
  <p class="msf-index-tip">选择一个场景进入：步骤可点击跳到对应页面，页内按钮可像真实产品一样继续操作（数据全部为模拟）。</p>
  <section id="msf-flows" class="msf-scenarios">
${cards}
  </section>
  <h2 class="msf-index-h2">全部页面</h2>
  <div class="msf-pagegrid">
${pageLinks}
  </div>
</div>`;
}

/**
 * 汇总壳样式（2026-10-17 真·可交互原型壳：顶栏 品牌+面包屑 / 左侧导航 页面+流程分组 / 内容区；
 * 配色字体全走风格基线令牌，与单页产物同基线——「汇总=页块堆叠」根修。
 * 2026-10-18 重构（0034）：左导航默认收拢（body.nav-on 展开，顶栏 ☰ 切换——产品级形态：系统导航退位，
 * 页内按钮即主导航）；场景索引页样式（msf-index 卡片+页面网格）。
 * 壳交互由 NAV_SCRIPT 壳同步段接管（[data-shell-nav] 高亮 + [data-shell-crumb] 面包屑 + [data-shell-home/toggle]）。
 */
const SHELL_CSS = '.msf-shell{display:flex;flex-direction:column;height:100vh}'
  + '.msf-top{height:48px;flex:none;display:flex;align-items:center;gap:12px;background:var(--p-surface);border-bottom:1px solid var(--p-line);padding:0 16px}'
  + '.msf-navtoggle{border:1px solid var(--p-line);background:var(--p-surface);border-radius:8px;padding:4px 10px;font-size:14px;cursor:pointer;color:var(--p-ink)}'
  + '.msf-navtoggle:hover{border-color:var(--p-primary);color:var(--p-primary)}'
  + '.msf-brand{font-weight:700;font-size:15px;color:var(--p-ink)}'
  + '.msf-crumb{color:var(--p-ink2);font-size:12.5px}'
  + '.msf-body{flex:1;display:flex;min-height:0}'
  + '.msf-sidenav{display:none;width:208px;flex:none;background:var(--p-surface);border-right:1px solid var(--p-line);padding:10px 8px;overflow-y:auto}'
  + 'body.nav-on .msf-sidenav{display:block}'
  + '.msf-grp{font-size:11px;color:var(--p-ink2);padding:8px 8px 4px;letter-spacing:.05em}'
  + '.msf-sidenav a{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:8px;color:var(--p-ink);text-decoration:none;font-size:13px;border-left:2px solid transparent}'
  + '.msf-sidenav a:hover{background:var(--p-bg)}'
  + '.msf-sidenav a.on{background:var(--p-primary-soft);border-left-color:var(--p-primary);color:var(--p-primary);font-weight:600}'
  + '.msf-sidenav a .c{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--p-ink2);flex:none}'
  + '.msf-content{flex:1;overflow-y:auto;padding:18px 22px;min-width:0}';
/** 场景索引页样式（0034；仅目录含 flow 条目时进汇总——无 flow 旧目录产物零痕迹；令牌化） */
const COMPOSED_FLOW_STYLE = '.msf-index h1{font-size:20px;margin:4px 0 6px;color:var(--p-ink)}'
  + '.msf-index-tip{color:var(--p-ink2);font-size:13px;margin:0 0 16px}'
  + '.msf-index-h2{font-size:14px;margin:20px 0 8px;color:var(--p-ink)}'
  + '.msf-scenarios{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}'
  + '.msf-flow{border:1px solid var(--p-line);border-radius:var(--p-radius);background:var(--p-surface);padding:12px 16px}'
  + '.msf-flow h3{font-size:14px;margin:0 0 8px;color:var(--p-ink)}.msf-flow-code{color:var(--p-ink2);font-size:11px;margin-left:6px}'
  + '.msf-flow ol{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}'
  + '.msf-flow-step{background:var(--p-bg);border:1px solid var(--p-line);border-radius:999px;padding:2px 10px;font-size:12.5px;color:var(--p-ink2)}'
  + '.msf-flow-step a{color:var(--p-primary);text-decoration:none}'
  + '.msf-pagegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}'
  + '.msf-pglink{display:flex;align-items:center;gap:8px;border:1px solid var(--p-line);border-radius:var(--p-radius);background:var(--p-surface);padding:10px 12px;color:var(--p-ink);text-decoration:none;font-size:13px}'
  + '.msf-pglink:hover{border-color:var(--p-primary);color:var(--p-primary)}'
  + '.msf-pglink .c{font-family:ui-monospace,monospace;font-size:10.5px;color:var(--p-ink2);flex:none}';

/**
 * 汇总拼装：目录 page×state 全集 → 已生成页内嵌 envelope 段、未生成页回落占位块；
 * 统一应用壳（顶栏 ☰导航收展+品牌+面包屑 / 左侧导航默认收拢 / 内容区）+ 风格基线头。
 * 0034 重构（用户拍板汇总双定位）：目录含 flow 时产「场景索引页」为整本默认落页
 * （场景清单点步骤跳单页 → 页内按钮像真实产品一样继续操作）；无 flow 时保持首页面直落。
 * 产物保留全部 data-page-block/data-page/data-state 静态标记 → checkPrototype/定稿/基线零改动。
 */
export function composePrototype(
  items: CatalogItemLike[],
  pages: AssemblePageInput[],
  warnings: string[] = [],
  opts: { productName?: string; theme?: Record<string, string> | null } = {},
): { html: string; manifest: PrototypeManifest } {
  const pageItems = items.filter((i) => i.item_type === 'page');
  const stateItems = items.filter((i) => i.item_type === 'state');
  const flowItems = items.filter((i) => i.item_type === 'flow');
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
  const titleOf = (p: CatalogItemLike) => (p.payload.title as string) ?? p.code;
  const hasFlows = flowItems.length > 0;
  const navLinks = pageItems.map((p) =>
    `<a href="#${esc(p.code)}" data-shell-nav="${esc(p.code)}" data-title="${esc(titleOf(p))}"><span class="c">${esc(p.code)}</span>${esc(titleOf(p))}</a>`,
  ).join('\n      ');
  // 流程进侧栏分组：链到该流程首个可解析步骤的页面（纯文本步骤 flow 回落首页）
  const flowLinks = flowItems.map((f) => {
    const steps = (f.payload.steps as string[] | undefined) ?? [];
    const firstRef = steps.map(parseFlowStepRef).find((r) => r !== null);
    const target = firstRef?.page ?? pageItems[0]?.code ?? '';
    return `<a href="#${esc(target)}"><span class="c">${esc(f.code)}</span>${esc((f.payload.title as string) ?? f.code)}</a>`;
  }).join('\n      ');
  const product = opts.productName?.trim() || '项目';
  const indexView = hasFlows ? renderScenarioIndex(flowItems, pageItems, stateItems, product) : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(product)} · 可交互原型</title>
<style>${buildThemeCss(opts.theme)}\n${SHELL_CSS}${indexView ? `\n${COMPOSED_FLOW_STYLE}` : ''}</style></head>
<body data-prototype="msf">
<div class="msf-shell">
  <header class="msf-top"><button class="msf-navtoggle" type="button" data-shell-toggle title="展开/收拢页面导航">☰</button><span class="msf-brand">${esc(product)}</span><span class="msf-crumb" data-shell-crumb>${esc(hasFlows ? '场景首页' : (pageItems[0] ? titleOf(pageItems[0]) : ''))}</span></header>
  <div class="msf-body">
    <nav class="msf-sidenav">
      ${hasFlows ? '<a href="#" data-shell-home><span class="c">🏠</span>场景首页</a>\n      ' : ''}<div class="msf-grp">页面</div>
      ${navLinks}
      ${hasFlows ? `<div class="msf-grp">流程</div>\n      ${flowLinks}` : ''}
    </nav>
    <main class="msf-content">
${indexView}
${blocks}
    </main>
  </div>
</div>
${scripts}
${NAV_SCRIPT}
</body></html>`;
  const navTargets = [...new Set(extractDataNavTargets(html))].sort();
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
    ...(flowItems.length > 0
      ? { flows: flowItems.map((f) => ({ code: f.code, title: (f.payload.title as string) ?? f.code, steps: (f.payload.steps as string[] | undefined) ?? [] })) }
      : {}),
    ...(navTargets.length > 0 ? { dataNavTargets: navTargets } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  return { html, manifest };
}
