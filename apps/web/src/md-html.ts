import DOMPurify from 'dompurify';
import { marked } from 'marked';

/**
 * Markdown 渲染统一入口（N02-7：marked 产出必经 sanitize 白名单，标签+属性两级）。
 * 任何 dangerouslySetInnerHTML 只允许消费本函数结果。
 */
export function mdHtml(md: string): string {
  return DOMPurify.sanitize(marked.parse(md, { async: false }) as string, {
    USE_PROFILES: { html: true }, // 白名单 profile：禁 script/style/事件属性
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['srcset', 'formaction'],
  });
}
