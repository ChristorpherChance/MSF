import { describe, expect, it } from 'vitest';
import { buildPrompt, buildRewritePrompt } from '../req/generate.service.js';
import { buildDesignEditPrompt, buildDesignRewritePrompt } from '../design/generate.service.js';

/**
 * 生成 prompt 契约测试（2026-10-11 B3，用户拍板两决策钉住）：
 * - rewrite 双通道默认以模板骨架为准重排大章（用户明确要求保持既有结构时除外）+ 禁元话术
 * - 增量通道不注入模板块（结构已存在，不重排）；初稿/rewrite 通道注入且含骨架钉死句
 */
describe('生成 prompt 契约（骨架默认化+禁元话术+模板注入边界）', () => {
  it('req rewrite：骨架默认为准 + 禁元话术 + 模板块含骨架钉死句', () => {
    const p = buildRewritePrompt('prd', '按模板重写', ['REQ-001'], '# 旧文\n\n## 旧节');
    expect(p).toContain('默认以模板结构骨架为准重排大章');
    expect(p).toContain('仅当用户指示明确要求保持既有结构时才保留基线结构');
    expect(p).toContain('禁止写「本文是提案/待确认/未定稿声明/由 AI 生成」类元话术');
    expect(p).toContain('不得自行归章');
    expect(p).toContain('29148');
  });
  it('design rewrite：同口径（五册之一抽查）', () => {
    const p = buildDesignRewritePrompt('概要设计', 'hld', 'h', '重写', [], '# 旧文');
    expect(p).toContain('默认以模板结构骨架为准重排大章');
    expect(p).toContain('禁止写「本文是提案/待确认/未定稿声明/由 AI 生成」类元话术');
    expect(p).toContain('不得自行归章');
    expect(p).toContain('42010');
  });
  it('增量通道不注入模板块（req 增量 + design 增量双双不含骨架钉死句）', () => {
    const inc = buildPrompt('crd', '补充一条', [], [], '# 既有\n\n## CR-001 x');
    expect(inc).toContain('增量修订');
    expect(inc).not.toContain('不得自行归章');
    expect(inc).not.toContain('【默认文档模板');
    const dInc = buildDesignEditPrompt('概要设计', 'h', '改一节', [], '# 既有');
    expect(dInc).toContain('增量修订');
    expect(dInc).not.toContain('【默认文档模板');
  });
  it('初稿通道注入模板块（含骨架钉死句与负面样例）', () => {
    const first = buildPrompt('crd', '', [{ name: '需求访谈', md: '内容' }]);
    expect(first).toContain('【默认文档模板');
    expect(first).toContain('不得自行归章');
    expect(first).toContain('负面样例');
  });
  it('模板重排 instruction 常量（编排器单点持有，处理器共享）', async () => {
    const { REFRESH_INSTRUCTION } = await import('./template-refresh.js');
    expect(REFRESH_INSTRUCTION).toBe('按默认模板骨架重排整篇：内容按主题归入模板大章，保留有效锚点码与编号，不增删需求语义');
  });
});
