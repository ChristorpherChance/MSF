/**
 * 需求文档渲染层派生编号（存储零改动：编号不烤入标题；补丁定位仍 secId，RTM 锚点不断链）：
 * - 大章判定：标题命中 /^[一二三四五六七八九十]+、/ → 章计数 +1、节计数清零；大章标题原样展示
 * - 需求节：CR-nnn/REQ-nnn 锚点码从标题首词提取入括号 → `1.2 双人同屏（CR-002）`
 * - 无大章（存量文档）→ 退化纯序号 `1. 标题（CR-001）`；无标题节（s0 文首）不编号
 * - 大章之前的散节（修订说明等）→ 独立纯序号，不占章节号
 */

export interface NumberedSection {
  id: string;
  /** 展示标题（含派生编号与锚点码括号）；无标题节为 '' */
  display: string;
  /** 是否大章（消费侧据此加粗/不缩进） */
  chapter: boolean;
}

const CHAPTER_RE = /^[一二三四五六七八九十]+、/;
/** 行首锚点码（需求域 CR/REQ-nnn，\b 挡住 CR-0012 之类伪码；设计册前缀码 h/o/g/k/d/a/u/n-n）。
 *  2026-10-07：设计册 h-n 码此前不被识别、裸露在派生编号标题里（「1.1 h-1 文档定位…」）——泛化后统一 `1.1 标题（h-1）` 形态 */
const CODE_RE = /^((?:CR|REQ)-\d{3}\b|[hogkdaun]-\d{1,3}\b)\s*/;

export function deriveNumbering(secs: Array<{ id: string; title: string }>): NumberedSection[] {
  const hasChapter = secs.some((s) => CHAPTER_RE.test(s.title));
  let chapter = 0;
  let section = 0;
  let flat = 0;
  return secs.map((s) => {
    if (!s.title) return { id: s.id, display: '', chapter: false };
    if (CHAPTER_RE.test(s.title)) {
      chapter += 1;
      section = 0;
      return { id: s.id, display: s.title, chapter: true };
    }
    const code = CODE_RE.exec(s.title)?.[1];
    const body = s.title.replace(CODE_RE, '').trim();
    const suffix = code ? `（${code}）` : '';
    if (hasChapter && chapter > 0) {
      section += 1;
      return { id: s.id, display: `${chapter}.${section} ${body}${suffix}`, chapter: false };
    }
    flat += 1;
    return { id: s.id, display: `${flat}. ${body}${suffix}`, chapter: false };
  });
}
