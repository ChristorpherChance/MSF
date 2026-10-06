import { describe, expect, it } from 'vitest';
import { buildTemplateGuide, listTemplates } from './doc-templates.js';

/** 默认文档模板库（2026-10-06 用户拍板：每种文档一份默认模板，参考国际标准；用户模板优先） */
describe('doc-templates 默认文档模板', () => {
  it('十类文档全部有模板：crd/prd+设计八册，漏册即红', () => {
    const all = listTemplates();
    for (const k of ['crd', 'prd', 'hld', 'mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr']) {
      const t = all[k];
      expect(t, k).toBeDefined();
      expect(t!.standard.length, k).toBeGreaterThan(0);
      expect(t!.quality.length, k).toBeGreaterThan(0);
      expect(t!.chapters.length, k).toBeGreaterThanOrEqual(3);
      for (const c of t!.chapters) {
        expect(c.title, `${k}:${c.title}`).toMatch(/^[一二三四五六七八九十]+、/); // 大章中文数字+顿号（deriveNumbering 判定同源）
        expect(c.requires.length, `${k}:${c.title}`).toBeGreaterThan(0);
      }
    }
  });
  it('标准映射钉死：29148/42010/OpenAPI/WCAG/25010', () => {
    const all = listTemplates();
    expect(all['crd']!.standard).toContain('29148');
    expect(all['prd']!.standard).toContain('29148');
    expect(all['hld']!.standard).toContain('42010');
    expect(all['api']!.standard).toContain('OpenAPI');
    expect(all['ui']!.standard).toContain('WCAG');
    expect(all['nfr']!.standard).toContain('25010');
  });
  it('注入块：含质量 bar+结构+编号规范+「用户模板优先」声明', () => {
    const crd = buildTemplateGuide('req', 'crd');
    expect(crd).toContain('29148');
    expect(crd).toContain('质量要求');
    expect(crd).toContain('CR-001');
    expect(crd).toContain('用户模板优先');
    const hld = buildTemplateGuide('design', 'hld');
    expect(hld).toContain('42010');
    expect(hld).toContain('h-1 简明标题'); // 册前缀锚点码（kind→单字母映射正确）
    expect(buildTemplateGuide('design', 'xyz')).toBe('');
  });
});
