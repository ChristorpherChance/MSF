/**
 * 平台层文档导出（L1 立项：原型 dlPopover 三格式 md/docx/pdf 口径）。
 * md→docx 走 docx 包（CJS 已验证）；md→pdf 走 pdfkit + CJK 字体解析
 * （TTC 须带 postscript 名；无字体抛 INTERNAL——注册表闭集不加码）。
 * 语法覆盖与 md-html.ts 同口径：#/##/### 标题、- 列表、代码围栏、管道表、段落、粗体/行内代码。
 */
import { existsSync } from 'node:fs';
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, Packer, Paragraph, ShadingType,
  Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import PDFDocument from 'pdfkit';
import { DomainError } from '@msf/shared';
import { mdToHtml } from './md-html.js';

/** 导出格式（L1：原型 dlPopover 三格式 md/docx/pdf + 既有 html 保留 API 面） */
export type ExportFormat = 'md' | 'html' | 'docx' | 'pdf';

/** 版本内容 → 导出字节（内容不可变 → 同 (versionId,format) 字节相同，内容寻址复用） */
export async function renderExport(content: string, format: ExportFormat, title: string): Promise<Buffer> {
  if (format === 'md') return Buffer.from(content, 'utf8');
  if (format === 'html') {
    return Buffer.from(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${mdToHtml(content)}</body></html>`, 'utf8');
  }
  if (format === 'docx') return mdToDocx(content, title);
  return mdToPdf(content, title);
}

interface MdBlock {
  kind: 'h1' | 'h2' | 'h3' | 'li' | 'p' | 'code' | 'table';
  text: string;
  rows?: string[][];
}

/** md → 块序列（导出专用轻量解析；行内标记在渲染层剥离） */
export function mdToBlocks(md: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = md.split('\n');
  let code: string[] | null = null;
  let table: string[][] | null = null;
  const flushTable = () => {
    if (table && table.length > 0) blocks.push({ kind: 'table', text: '', rows: table });
    table = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line.trim())) {
      if (code !== null) { blocks.push({ kind: 'code', text: code.join('\n') }); code = null; }
      else { flushTable(); code = []; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const t = line.trim();
    if (/^\|.*\|$/.test(t) && t.includes('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if (/^[\s:-]+$/.test(cells.join(''))) continue; // 分隔行
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    flushTable();
    if (t === '') continue;
    if (/^###\s+/.test(t)) blocks.push({ kind: 'h3', text: t.replace(/^###\s+/, '') });
    else if (/^##\s+/.test(t)) blocks.push({ kind: 'h2', text: t.replace(/^##\s+/, '') });
    else if (/^#\s+/.test(t)) blocks.push({ kind: 'h1', text: t.replace(/^#\s+/, '') });
    else if (/^-\s+/.test(t)) blocks.push({ kind: 'li', text: t.replace(/^-\s+/, '') });
    else blocks.push({ kind: 'p', text: t });
  }
  if (code !== null) blocks.push({ kind: 'code', text: code.join('\n') });
  flushTable();
  return blocks;
}

/** 行内标记剥离（pdf 用；docx 走 runs） */
const plain = (s: string) => s.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');

/** 行内粗体/行内代码 → TextRun 序列 */
function inlineRuns(text: string, opts: { size?: number; codeFont?: boolean } = {}): TextRun[] {
  const runs: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) runs.push(new TextRun({ text: plain(text.slice(last, idx)), ...opts }));
    const tok = m[0];
    if (tok.startsWith('**')) runs.push(new TextRun({ text: tok.slice(2, -2), bold: true, ...opts }));
    else runs.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas', ...opts }));
    last = idx + tok.length;
  }
  if (last < text.length) runs.push(new TextRun({ text: plain(text.slice(last)), ...opts }));
  return runs.length > 0 ? runs : [new TextRun({ text: '', ...opts })];
}

const HEADING: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
};

/** md → docx Buffer（标题/列表/代码灰底/管道表/正文；内容寻址调用方复用） */
export async function mdToDocx(md: string, title: string): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title, bold: true })] }),
  ];
  for (const b of mdToBlocks(md)) {
    if (b.kind === 'table' && b.rows) {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: b.rows.map((r, ri) => new TableRow({
          children: r.map((c) => new TableCell({
            children: [new Paragraph({ children: inlineRuns(c, { size: 20 }) })],
            ...(ri === 0 ? { shading: { type: ShadingType.CLEAR, fill: 'F2F4F8' } } : {}),
          })),
        })),
      }));
    } else if (b.kind === 'code') {
      for (const cl of b.text.split('\n')) {
        children.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F5F5F5' },
          border: { left: { style: BorderStyle.SINGLE, size: 6, color: 'D0D5DD' } },
          children: [new TextRun({ text: cl || ' ', font: 'Consolas', size: 18 })],
        }));
      }
    } else if (b.kind === 'li') {
      children.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(b.text) }));
    } else if (b.kind === 'p') {
      children.push(new Paragraph({ children: inlineRuns(b.text), spacing: { after: 120 } }));
    } else {
      children.push(new Paragraph({ heading: HEADING[b.kind]!, children: inlineRuns(b.text) }));
    }
  }
  return Packer.toBuffer(new Document({
    sections: [{ properties: {}, children }],
    styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 21 } } } },
  }));
}

/** CJK 字体候选（env MSF_PDF_FONT=path[#postscriptName] 优先；TTC 须带 postscript 名） */
const FONT_CANDIDATES: Array<{ path: string; name?: string }> = [
  { path: 'C:/Windows/Fonts/msyh.ttc', name: 'MicrosoftYaHei' },
  { path: 'C:/Windows/Fonts/simsun.ttc', name: 'SimSun' },
  { path: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', name: 'NotoSansCJKsc-Regular' },
  { path: '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc', name: 'WenQuanYiMicroHei' },
  { path: '/usr/share/fonts/truetype/arphic/uming.ttc', name: 'ARPLUMing' },
  { path: '/System/Library/Fonts/PingFang.ttc', name: 'PingFangSC-Regular' },
];

function resolveCjkFont(): { path: string; name?: string } {
  const env = process.env.MSF_PDF_FONT;
  if (env) {
    const [p, name] = env.split('#');
    if (p && existsSync(p)) return name ? { path: p, name } : { path: p };
  }
  for (const c of FONT_CANDIDATES) {
    if (existsSync(c.path)) return c;
  }
  throw new DomainError('INTERNAL', 'PDF 导出不可用：未找到 CJK 字体（设 MSF_PDF_FONT=路径[#字体名]）', 'font');
}

/** md → pdf Buffer（A4；CJK 字体嵌入；表格退化为等宽文本行，保留全部信息） */
export async function mdToPdf(md: string, title: string): Promise<Buffer> {
  const font = resolveCjkFont();
  return new Promise<Buffer>((resolvePromise, reject) => {
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      if (font.name) doc.font(font.path, font.name);
      else doc.font(font.path);
    } catch (e) {
      reject(new DomainError('INTERNAL', `PDF 导出不可用：字体加载失败（${font.path}）`, e instanceof Error ? e.message : 'font'));
      return;
    }
    doc.fontSize(18).text(title, { align: 'center' });
    doc.moveDown(0.8);
    for (const b of mdToBlocks(md)) {
      if (b.kind === 'h1') { doc.moveDown(0.6); doc.fontSize(16).text(plain(b.text)); doc.moveDown(0.3); }
      else if (b.kind === 'h2') { doc.moveDown(0.5); doc.fontSize(14).text(plain(b.text)); doc.moveDown(0.2); }
      else if (b.kind === 'h3') { doc.moveDown(0.4); doc.fontSize(12).text(plain(b.text)); doc.moveDown(0.15); }
      else if (b.kind === 'li') doc.fontSize(10.5).text(`• ${plain(b.text)}`, { indent: 12 });
      else if (b.kind === 'code') {
        doc.moveDown(0.2);
        doc.fontSize(9).text(b.text, { indent: 8 });
        doc.moveDown(0.2);
      } else if (b.kind === 'table' && b.rows) {
        doc.moveDown(0.2);
        for (const r of b.rows) doc.fontSize(9.5).text(r.map(plain).join(' ｜ '), { indent: 4 });
        doc.moveDown(0.2);
      } else {
        doc.fontSize(10.5).text(plain(b.text), { lineGap: 2 });
        doc.moveDown(0.25);
      }
    }
    doc.end();
  });
}
