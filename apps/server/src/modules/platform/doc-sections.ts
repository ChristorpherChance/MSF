import { createHash } from 'node:crypto';
import { deriveNumbering } from '@msf/shared';

/**
 * 文档章节拆分/组装与文本指纹（纯函数）。
 * 存储口径：req_versions/req_drafts.content 为规范化 Markdown 全文（LLD-4 D04-2/3）；
 * API 口径：A04-2/3 按章节 secs 呈现与编辑（## 标题切分，文首引言为 s0）。
 */

export interface DocSection {
  id: string;
  title: string;
  md: string;
}

/** 规范化内容 SHA-256（NFC 预规范化，F04-1；BR-01 指纹载体） */
export function sha256Text(s: string): string {
  return createHash('sha256').update(s.normalize('NFC'), 'utf8').digest('hex');
}

/** AI 真接产出 → 章节补丁（`## ` 切分，标题截 80 字符；需求/设计两域生成共用）。
 *  `## ` 前的 h1/前言不成补丁（前言不属于任何节）；
 *  每条 add 带 after 落位锚点 = 模型输出文本中的前一节标题，首节 after=''（文首） */
export function mdToPatches(text: string): EditPatch[] {
  const patches: EditPatch[] = [];
  let prevTitle = '';
  const parts = text.split(/^## /m);
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) continue; // parts[0] 是首个 `## ` 之前的前言/h1（文本以 ## 起时为空串），不成节
    const t = parts[i]!.trim();
    if (!t) continue;
    const nl = t.indexOf('\n');
    const title = (nl < 0 ? t : t.slice(0, nl)).replace(/^#+\s*/, '').trim().slice(0, 80);
    const body = nl < 0 ? '' : t.slice(nl + 1).trim();
    if (!title) continue;
    patches.push({ type: 'add', secId: 's0', title, new: body, after: prevTitle });
    prevTitle = title;
  }
  return patches;
}

/** 全文 → 章节（## 二级标题切分；文首无标题部分为 s0） */
export function splitSections(content: string): DocSection[] {
  const lines = content.split('\n');
  const secs: DocSection[] = [];
  let cur: DocSection = { id: 's0', title: '', md: '' };
  const push = () => {
    cur.md = cur.md.replace(/\n{3,}/g, '\n\n').trim();
    secs.push(cur);
  };
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) {
      push();
      cur = { id: `s${secs.length}`, title: m[1]!.trim(), md: '' };
    } else if (cur.md !== '' || line.trim() !== '') {
      cur.md += (cur.md ? '\n' : '') + line;
    }
  }
  push();
  return secs.filter((s) => s.title !== '' || s.md !== '');
}

/** 章节 → 全文（splitSections 的逆；保持 ## 标题行格式） */
export function joinSections(secs: DocSection[]): string {
  return secs
    .map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md))
    .filter((s) => s.trim() !== '')
    .join('\n\n');
}

/** 编辑补丁（DSG-C04-4 edit_patch：定位+最小变更，禁止全文重写） */
export interface EditPatch {
  type: 'add' | 'modify' | 'del';
  secId: string;
  title?: string;
  old?: string;
  new?: string;
  /** add 落位锚点：undefined=文末追加（向后兼容默认）；''=文首（无标题前言之后、首个有标题节之前）；
   *  非空=插到该标题节之后，锚点落空退化文末（不抛错、不阻塞人工处置）。modify/del 不消费 */
  after?: string;
}

/** 应用补丁到章节集；modify/del 要求 old 文本仍在该节内容中（否则调用方判 PATCH_BASE_STALE） */
export function applyPatch(secs: DocSection[], patch: EditPatch): DocSection[] | null {
  if (patch.type === 'add') {
    // id 只是标识、顺序由数组位置决定：中段插入不重排既有 id
    const next: DocSection = {
      id: `s${secs.length}`,
      title: patch.title ?? '',
      md: patch.new ?? '',
    };
    if (patch.after === undefined) return [...secs, next]; // 缺席：维持文末追加（既有调用方零影响）
    if (patch.after === '') {
      const firstTitled = secs.findIndex((s) => s.title !== '');
      const at = firstTitled < 0 ? secs.length : firstTitled;
      return [...secs.slice(0, at), next, ...secs.slice(at)];
    }
    const anchor = secs.findIndex((s) => s.title === patch.after);
    const at2 = anchor >= 0 ? anchor : findSection(patch.after, secs); // 编号前缀/章号形态容错（与 modify 定位同口径）
    if (at2 < 0) return [...secs, next]; // 锚点落空：退化文末追加
    return [...secs.slice(0, at2 + 1), next, ...secs.slice(at2 + 1)];
  }
  // modify/del 定位（I-1）：secId 是 propose 时刻的位置性 id——混合批中 add 中段插入后既有节位置后移、
  // accept 时重切分 id 重派，库存 secId 可能指向错节。secId 失配（节不存在、或 old 不在该节、或 modify 无 old）
  // 按补丁 title 回退重定位（锚点码优先、标题精确其次）；候选节仍须 old⊆md 校验通过，否则 null（防错节静默命中）。
  const fits = (i: number): boolean =>
    i >= 0 && (patch.type === 'del' || !!patch.old) && (!patch.old || secs[i]!.md.includes(patch.old));
  let idx = secs.findIndex((s) => s.id === patch.secId);
  if (!fits(idx)) {
    // secId 失配回退重定位：findSection 统一口径（锚点码任意位置→标题精确→编号剥离精确），候选仍须 old⊆md 校验
    const cand = findSection(patch.title, secs);
    idx = fits(cand) ? cand : -1;
  }
  if (idx < 0) return null;
  const target = secs[idx]!;
  if (patch.type === 'del') {
    return secs.filter((_, i) => i !== idx);
  }
  // modify（fits 已保证 old 非空且 old⊆md）
  const md = target.md.replace(patch.old!, patch.new ?? '');
  return secs.map((s, i) => (i === idx ? { ...s, md } : s));
}

/** 锚点码（CR-nnn/REQ-nnn）——标题首词提取，归一化优先匹配键 */
const ANCHOR_CODE_RE = /^(?:CR|REQ)-\d{3}\b/;
/** 补丁标题容错：锚点码任意位置提取（模型学 UI 编号格式输出「5.7 单局限时（CR-006）」时码在尾部） */
const CODE_ANYWHERE_RE = /(?:^|\b)(?:CR|REQ)-\d{3}\b/;
/** 补丁标题容错：剥离 UI 派生编号前缀（「5.7 」「5.7.1 」「第五章 」「第三章、」——渲染层编号模型学样输出） */
const NUMBER_PREFIX_RE = /^(?:\d+(?:\.\d+)*|第[一二三四五六七八九十百零]+[章节])[、.．\s]+/;

/** 补丁标题归一化：剥离派生编号前缀（存储标题永不带编号，编号是渲染层派生物） */
function normTitle(t: string): string {
  return t.replace(NUMBER_PREFIX_RE, '').trim();
}

/** 标题命中查找：锚点码（补丁标题任意位置）优先，标题精确其次，编号剥离后精确/后缀兜底
 *  （后缀兜底：模型把「五、待确认事项」写成「第五章 待确认事项」——剥离编号后「待确认事项」≠原标题，
 *   但原标题以它结尾；限 ≥4 字符防短词误命中） */
export function findSection(patchTitle: string | undefined, secs: DocSection[]): number {
  if (!patchTitle) return -1;
  const code = CODE_ANYWHERE_RE.exec(patchTitle)?.[0];
  if (code) {
    const byCode = secs.findIndex((s) => ANCHOR_CODE_RE.exec(s.title)?.[0] === code);
    if (byCode >= 0) return byCode;
  }
  const exact = secs.findIndex((s) => s.title === patchTitle);
  if (exact >= 0) return exact;
  const stripped = normTitle(patchTitle);
  if (stripped === patchTitle) return -1;
  const strippedExact = secs.findIndex((s) => s.title === stripped);
  if (strippedExact >= 0) return strippedExact;
  if (stripped.length < 4) return -1;
  return secs.findIndex((s) => s.title !== '' && s.title.endsWith(stripped));
}

/**
 * AI 增量补丁归一化（修复「修改章节实为重复追加」缺陷）：
 * mdToPatches 恒产 add——标题命中既有节即改写为整节 modify（命中口径=findSection：
 * 锚点码任意位置优先、标题精确其次、剥离 UI 派生编号前缀后精确兜底；
 * old=splitSections 产出的节 md，已 trim+\n{3,} 塌缩，不可从原文裸切，否则 accept 时 includes 失配）。
 * 未命中保持 add。已知限制：mdToPatches 标题截 80 字符而 splitSections 不截，
 * >80 字符的无锚点码节精确匹配落空退回 add（CR/REQ 节走锚点码不受影响）。
 * 标题改写不生效（modify 仅替换正文，标题保持原标题）。
 */
export function normalizePatches(patches: EditPatch[], existing: DocSection[]): EditPatch[] {
  return patches.map((p) => {
    if (p.type !== 'add' || !p.title) return p;
    const hit = findSection(p.title, existing);
    const target = hit >= 0 ? existing[hit]! : undefined;
    // 空正文节不转：modify 的 old⊆md 校验对空 old 必败（PATCH_BASE_STALE 误伤），保 add 由人工处置；
    // 空 new 同守：裸标题（无正文）转 modify 会把整节正文清空（数据损失镜像面），保 add
    if (!target || target.md.trim() === '' || (p.new ?? '').trim() === '') return p;
    return { type: 'modify', secId: target.id, title: target.title, old: target.md, new: p.new ?? '' };
  });
}

/** 导出用：节标题注入派生编号后与 joinSections 规范形同构重组（与前端渲染同函数同口径；存储内容不动） */
export function withNumberedTitles(content: string): string {
  const secs = splitSections(content);
  const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n.display]));
  return joinSections(secs.map((s) => (s.title && disp.get(s.id) ? { ...s, title: disp.get(s.id)! } : s)));
}

/**
 * 增量修订/对话改文档 prompt 用「章节编号对照表」（2026-10-04 第五章改不到位根修）：
 * UI 编号是渲染层派生物，模型收到的正文是原始标题——用户按「第五章」「5.7 节」说话时模型无从对应，
 * 学样输出编号开头标题又会落空成 add 重复节。注入对照表让模型与用户共享同一套编号坐标，
 * 并约束输出必须用右侧原始标题（匹配层 findSection 另有编号剥离兜底，双保险）。
 */
export function buildNumberGuide(content: string): string {
  const secs = splitSections(content);
  const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n.display]));
  const lines = secs
    .filter((s) => s.title !== '')
    .map((s) => `- ${disp.get(s.id) || s.title} ⇢ 原始标题「${s.title}」`);
  if (lines.length === 0) return '';
  return [
    '【章节编号对照（用户在界面上看到的编号 ⇢ 存储原始标题）】',
    ...lines,
    '用户按编号（如「第五章」「5.7 节」）指代章节时，按上表定位；你的输出标题必须原样使用右侧原始标题，禁止添加任何编号前缀。',
  ].join('\n');
}

/** 「第 N 章/节」锚点词形：N 支持中文数字或阿拉伯数字（「第五章」「第5章」「五」） */
const ANCHOR_CHAPTER_RE = /^第?([一二三四五六七八九十]+|\d+)章$/;

/** 中文数字 → 整数（十以内直查；「十一」~「十九」=10+尾；更大序数文档场景不出现，解析不出返回 null） */
function cnOrdinal(s: string): number | null {
  const D: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.startsWith('十')) { const t = D[s.slice(1)]; return t ? 10 + t : null; }
  return D[s] ?? null;
}

/**
 * 章节锚点定位（doc.read 定向读 / 用户「5.1 节」「第五章」指代口径）：
 * ① 派生编号 token 精确命中（display 首词「5.1」「2.」⇢ 锚点「5.1」「2」，忽略尾部 .、与「节」字后缀）；
 * ② 大章序命中（「第五章」「第5章」「五」⇢ 第 5 个大章节——deriveNumbering 的章序=出现序）；
 * ③ 回落 findSection 原始标题口径（锚点码/精确/编号剥离）。
 * 仅 token 精确比较，不做前缀——防「5.1」误命中「5.10」。
 */
export function findSectionByAnchor(anchor: string, secs: DocSection[]): number {
  const a = anchor.trim().replace(/节\s*$/, '').trim(); // 「5.1 节」「5.1节」→ 本体；章类词形保留给 ②
  if (!a) return -1;
  const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n]));
  // ① 编号 token 命中（跳过无标题节与大章——大章 display 是原标题不是数字）
  const tok = a.replace(/[.、\s]+$/, '');
  if (/^\d+(?:\.\d+)*$/.test(tok)) {
    const idx = secs.findIndex((s) => {
      const d = disp.get(s.id);
      if (!d || d.chapter || !d.display) return false;
      const head = d.display.split(/\s+/)[0]!.replace(/[.、]+$/, '');
      return head === tok;
    });
    if (idx >= 0) return idx;
  }
  // ② 大章序（「第五章」「第5章」「五」——对章类节数出现序）
  const cm = ANCHOR_CHAPTER_RE.exec(a) ?? (/^([一二三四五六七八九十]+)$/.exec(a));
  if (cm) {
    const n = /^\d+$/.test(cm[1]!) ? Number(cm[1]) : cnOrdinal(cm[1]!);
    if (n !== null && n >= 1) {
      let ord = 0;
      for (let i = 0; i < secs.length; i++) {
        if (disp.get(secs[i]!.id)?.chapter) {
          ord += 1;
          if (ord === n) return i;
        }
      }
    }
  }
  // ③ 原始标题口径
  return findSection(a, secs);
}
