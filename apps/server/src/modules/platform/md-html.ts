/** 平台层迷你 md→html 渲染器（自 req 域归位，design/dev 导出共用；marked@18 纯 ESM 与 CJS/vitest 不兼容，M2 从简） */
/**
 * 导出 html 用迷你渲染器（marked@18 纯 ESM 与 CJS 产物/vitest 均不兼容，M2 从简）：
 * 覆盖本域文档实际用到的语法（#/## 标题、- 列表、段落、**粗体**、`代码`）；先转义防注入。
 */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
  const out: string[] = [];
  let inList = false;
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (/^##\s+/.test(t)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${inline(t.replace(/^##\s+/, ''))}</h2>`);
    } else if (/^#\s+/.test(t)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h1>${inline(t.replace(/^#\s+/, ''))}</h1>`);
    } else if (/^-\s+/.test(t)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(t.replace(/^-\s+/, ''))}</li>`);
    } else if (t === '') {
      if (inList) { out.push('</ul>'); inList = false; }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

