import { createHash } from 'node:crypto';

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
