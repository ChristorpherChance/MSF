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

/** AI 真接产出 → 章节补丁（`## ` 切分，标题截 80 字符；需求/设计两域生成共用） */
export function mdToPatches(text: string): EditPatch[] {
  const patches: EditPatch[] = [];
  for (const part of text.split(/^## /m)) {
    const t = part.trim();
    if (!t) continue;
    const nl = t.indexOf('\n');
    const title = (nl < 0 ? t : t.slice(0, nl)).replace(/^#+\s*/, '').trim().slice(0, 80);
    const body = nl < 0 ? '' : t.slice(nl + 1).trim();
    if (!title) continue;
    patches.push({ type: 'add', secId: 's0', title, new: body });
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
}

/** 应用补丁到章节集；modify/del 要求 old 文本仍在该节内容中（否则调用方判 PATCH_BASE_STALE） */
export function applyPatch(secs: DocSection[], patch: EditPatch): DocSection[] | null {
  const idx = secs.findIndex((s) => s.id === patch.secId);
  if (patch.type === 'add') {
    const next: DocSection = {
      id: `s${secs.length}`,
      title: patch.title ?? '',
      md: patch.new ?? '',
    };
    return [...secs, next];
  }
  if (idx < 0) return null;
  const target = secs[idx]!;
  if (patch.type === 'del') {
    if (patch.old && !target.md.includes(patch.old)) return null;
    return secs.filter((_, i) => i !== idx);
  }
  // modify
  if (!patch.old || !target.md.includes(patch.old)) return null;
  const md = target.md.replace(patch.old, patch.new ?? '');
  return secs.map((s, i) => (i === idx ? { ...s, md } : s));
}

/** 锚点码（CR-nnn/REQ-nnn）——标题首词提取，归一化优先匹配键 */
const ANCHOR_CODE_RE = /^(?:CR|REQ)-\d{3}\b/;

/**
 * AI 增量补丁归一化（修复「修改章节实为重复追加」缺陷）：
 * mdToPatches 恒产 add——标题命中既有节（锚点码优先、标题精确其次）即改写为整节 modify
 * （old=splitSections 产出的节 md，已 trim+\n{3,} 塌缩，不可从原文裸切，否则 accept 时 includes 失配）。
 * 未命中保持 add。已知限制：mdToPatches 标题截 80 字符而 splitSections 不截，
 * >80 字符的无锚点码节精确匹配落空退回 add（CR/REQ 节走锚点码不受影响）。
 * 标题改写不生效（modify 仅替换正文，标题保持原标题）。
 */
export function normalizePatches(patches: EditPatch[], existing: DocSection[]): EditPatch[] {
  const byCode = new Map<string, DocSection>();
  const byTitle = new Map<string, DocSection>();
  for (const s of existing) {
    const code = ANCHOR_CODE_RE.exec(s.title)?.[0];
    if (code && !byCode.has(code)) byCode.set(code, s);
    if (s.title && !byTitle.has(s.title)) byTitle.set(s.title, s);
  }
  return patches.map((p) => {
    if (p.type !== 'add' || !p.title) return p;
    const code = ANCHOR_CODE_RE.exec(p.title)?.[0];
    const target = (code ? byCode.get(code) : undefined) ?? byTitle.get(p.title);
    // 空正文节不转：modify 的 old⊆md 校验对空 old 必败（PATCH_BASE_STALE 误伤），保 add 由人工处置；
    // 空 new 同守：裸标题（无正文）转 modify 会把整节正文清空（数据损失镜像面），保 add
    if (!target || target.md.trim() === '' || (p.new ?? '').trim() === '') return p;
    return { type: 'modify', secId: target.id, title: target.title, old: target.md, new: p.new ?? '' };
  });
}

/** 导出用：节标题注入派生编号后与原文同构重组（与前端渲染同函数同口径；存储内容不动） */
export function withNumberedTitles(content: string): string {
  const secs = splitSections(content);
  const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n.display]));
  return joinSections(secs.map((s) => (s.title && disp.get(s.id) ? { ...s, title: disp.get(s.id)! } : s)));
}
