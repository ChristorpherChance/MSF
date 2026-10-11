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
      // 专业度门槛：编写规则 ≥3 条且每条可检查；大章 ≥4 且内容要求言之有物
      expect(t!.writingRules.length, k).toBeGreaterThanOrEqual(3);
      for (const r of t!.writingRules) expect(r.length, `${k}:${r}`).toBeGreaterThanOrEqual(10);
      expect(t!.chapters.length, k).toBeGreaterThanOrEqual(4);
      for (const c of t!.chapters) {
        expect(c.title, `${k}:${c.title}`).toMatch(/^[一二三四五六七八九十]+、/); // 大章中文数字+顿号（deriveNumbering 判定同源）
        expect(c.requires.length, `${k}:${c.title}`).toBeGreaterThanOrEqual(20);
      }
    }
  });
  it('标准映射钉死：29148/42010+1016/OpenAPI/WCAG/25010', () => {
    const all = listTemplates();
    expect(all['crd']!.standard).toContain('29148');
    expect(all['prd']!.standard).toContain('29148');
    // 设计五册：42010 + IEEE 1016（2026-10-11 深度升级：SDD 分解/依赖/行为/信息视图惯例）
    for (const k of ['hld', 'mod', 'alg', 'cls', 'db']) {
      expect(all[k]!.standard, k).toContain('42010');
      expect(all[k]!.standard, k).toContain('1016');
    }
    expect(all['api']!.standard).toContain('OpenAPI');
    expect(all['ui']!.standard).toContain('WCAG');
    expect(all['nfr']!.standard).toContain('25010');
  });
  it('逐册骨架钉死：关键大章名+复合粒度 requires（80~150 字）+antiPatterns 齐全', () => {
    const all = listTemplates();
    const KEY_CHAPTERS: Record<string, string[]> = {
      crd: ['一、背景与目标', '三、功能需求', '六、术语表'],
      prd: ['三、功能需求', '五、界面与交互要求'],
      hld: ['二、总体架构', '三、架构视图', '六、承接与映射'],
      mod: ['二、依赖矩阵', '三、接口契约'],
      alg: ['二、状态机清单', '三、异常路径'],
      cls: ['一、核心实体', '三、关系与聚合'],
      db: ['一、表清单', '三、append-only 清单'],
      api: ['一、端点总览', '四、幂等约定'],
      ui: ['三、交互与状态', '四、可访问性'],
      nfr: ['一、性能效率', '四、安全性'],
    };
    for (const [k, chapters] of Object.entries(KEY_CHAPTERS)) {
      const t = all[k]!;
      const titles = t.chapters.map((c) => c.title);
      for (const ch of chapters) expect(titles, `${k} 缺大章 ${ch}`).toContain(ch);
      // 复合粒度：每章 requires 80~150 字（小节骨架+形态+量级+验收口径）
      for (const c of t.chapters) {
        expect(c.requires.length, `${k}:${c.title} requires=${c.requires.length}字`).toBeGreaterThanOrEqual(80);
        expect(c.requires.length, `${k}:${c.title} requires=${c.requires.length}字`).toBeLessThanOrEqual(160);
        expect(c.requires, `${k}:${c.title} 缺验收口径`).toContain('验收口径');
      }
      // 负面样例：十册全配（生成与评审同口径拦截越界内容）
      expect(t.antiPatterns?.length, k).toBeGreaterThanOrEqual(3);
    }
  });
  it('注入块：含质量 bar+结构+编号规范+骨架钉死句+「用户模板优先」声明', () => {
    const crd = buildTemplateGuide('req', 'crd');
    expect(crd).toContain('29148');
    expect(crd).toContain('质量要求');
    expect(crd).toContain('CR-001');
    expect(crd).toContain('用户模板优先');
    // 骨架钉死（2026-10-11）：消解 CHAPTER_RULE「按内容归类」与固定骨架并存冲突
    expect(crd).toContain('不得自行归章');
    expect(crd).toContain('负面样例');
    const hld = buildTemplateGuide('design', 'hld');
    expect(hld).toContain('42010');
    expect(hld).toContain('h-1 简明标题'); // 册前缀锚点码（kind→单字母映射正确）
    expect(buildTemplateGuide('design', 'xyz')).toBe('');
  });
});
