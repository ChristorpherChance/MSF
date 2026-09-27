import { describe, expect, it } from 'vitest';
import { mdToBlocks, mdToDocx, mdToPdf } from './doc-export.js';

/** L1 导出渲染：块解析 + docx/pdf 字节签名（pdf 依赖本机 CJK 字体，Windows msyh/宋体必在） */
describe('doc-export（L1）', () => {
  const md = [
    '# 一、概述', '', '正文 **粗体** 与 `代码` 混排。', '',
    '## 二、清单', '', '- 第一项', '- 第二项', '',
    '### 三、表格', '', '| 列A | 列B |', '| --- | --- |', '| 甲 | 乙 |', '',
    '```', 'const x = 1;', '```',
  ].join('\n');

  it('mdToBlocks：标题/列表/表格/代码块分类正确，表分隔行剔除', () => {
    const blocks = mdToBlocks(md);
    expect(blocks.map((b) => b.kind)).toEqual(['h1', 'p', 'h2', 'li', 'li', 'h3', 'table', 'code']);
    expect(blocks.find((b) => b.kind === 'table')!.rows).toEqual([['列A', '列B'], ['甲', '乙']]);
  });

  it('mdToDocx：PK zip 签名且非空', async () => {
    const buf = await mdToDocx(md, 'CRD v3');
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('mdToPdf：%PDF 签名且中文字体内嵌', async () => {
    const buf = await mdToPdf(md, '需求规格书 v3');
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buf.length).toBeGreaterThan(5000);
  });
});
