import { describe, expect, it } from 'vitest';
import { CHAPTER_RULE, designSectionRule, reqSectionRule } from './doc-conventions.js';

/** 结构规范单一权威（2026-10-06）：文案即契约——钉死关键格式词，防后续改动与 deriveNumbering 判定发散 */
describe('doc-conventions 文档结构规范单一权威', () => {
  it('大章约定：中文数字+顿号+负例（deriveNumbering 判定同源口径）', () => {
    expect(CHAPTER_RULE).toContain('中文数字');
    expect(CHAPTER_RULE).toContain('顿号');
    expect(CHAPTER_RULE).toContain('第X章'); // 负例约束必须在
    expect(CHAPTER_RULE).toContain('## 一、');
  });
  it('需求域条目节锚点码：CR/REQ 分域', () => {
    expect(reqSectionRule('crd')).toContain('CR-001');
    expect(reqSectionRule('prd')).toContain('REQ-001');
    expect(reqSectionRule('crd')).toContain('顺延');
  });
  it('设计册条目节锚点码=册前缀（LLD-4 chapter_prefix 单字母）', () => {
    expect(designSectionRule('h')).toContain('h-1 简明标题');
    expect(designSectionRule('u')).toContain('u-1 简明标题');
  });
  it('设计册规则钉死章码组合关系（2026-10-07 章码双轨实机抓修：大章只分组、条目节随章、禁双出）', () => {
    const r = designSectionRule('h');
    expect(r).toContain('大章');
    expect(r).toContain('分组');
    expect(r).toContain('紧随所属大章');
    expect(r).toContain('章码双轨');
  });
});
