import { describe, expect, it } from 'vitest';
import { buildTemplateDraftPrompt, parseTemplateDraft } from './template-draft.js';

/** 自定义模板类别 AI 起草：容错抽取 + 专业度闸（草案不落库，人工保存时再过 update_item 同闸） */
describe('template-draft 自定义类别 AI 起草', () => {
  const good = {
    label: '验收方案', standard: 'ISO/IEC/IEEE 29119 测试文档', quality: '每项验收准则可测量、可复现、有判定阈值。',
    writingRules: ['验收准则须给量化阈值与测量方法', '每条准则须可追踪到需求编号', '环境矩阵须逐格给验收口径'],
    chapters: [
      { title: '一、验收范围', requires: '验收对象、环境、前置条件与排除项（写到可执行粒度）' },
      { title: '二、验收准则', requires: '逐条准则：条件→操作→预期→判定阈值（可测量可复现）' },
      { title: '三、验收流程', requires: '验收步骤编号、责任人、证据形式与留档要求' },
      { title: '四、不通过处置', requires: '不通过的分类、复验规则与升级路径（写到可执行粒度）' },
    ],
  };
  it('围栏 JSON 正常解析', () => {
    const r = parseTemplateDraft(`这是草案：\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\``);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.draft.label).toBe('验收方案');
  });
  it('裸 JSON 兜底（首尾大括号）', () => {
    const r = parseTemplateDraft(`前文${JSON.stringify(good)}后文`);
    expect(r.ok).toBe(true);
  });
  it('水化草案（章不足）被专业度闸拦，人话原因', () => {
    const bad = { ...good, chapters: good.chapters.slice(0, 2) };
    const r = parseTemplateDraft(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('大章至少 4 章');
  });
  it('非 JSON 产出：人话引导人工填写', () => {
    const r = parseTemplateDraft('我无法生成');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('人工填写');
  });
  it('prompt 钉死输出契约（json 围栏+章数+中文数字顿号+label）', () => {
    const p = buildTemplateDraftPrompt('验收方案', '公司内部用');
    expect(p).toContain('```json');
    expect(p).toContain('验收方案');
    expect(p).toContain('中文数字');
    expect(p).toContain('公司内部用');
  });
});
