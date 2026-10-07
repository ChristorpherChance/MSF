import { validateTemplate } from '../platform/doc-templates.js';

/**
 * 自定义模板类别 AI 起草（2026-10-07 拍板：新增类别可用 AI 对话起草内容，人工改后保存）：
 * 模型输出约束为单个 ```json 围栏（或裸 JSON）；parseTemplateDraft 容错抽取（围栏优先、
 * 首尾大括号兜底）+ validateTemplate 专业度闸同标。起草只产草案不落库——人工审改后经
 * template_set.update_item 保存（AI 起草、人工定稿的纪律不破）。
 */

export interface TemplateDraft {
  label: string;
  standard: string;
  quality: string;
  writingRules: string[];
  chapters: Array<{ title: string; requires: string }>;
}

export function buildTemplateDraftPrompt(name: string, hint: string): string {
  return [
    `你是软件工程文档体系专家。请为自定义文档类别《${name}》起草一份**文档模板**（供 AI 生成该类文档时作为结构与质量基线）。`,
    hint.trim() ? `用户补充说明：${hint.trim().slice(0, 500)}` : '',
    '要求：',
    '- 参考适用的国际/行业标准或公司规范命名依据（standard 字段，如 ISO/IEC/IEEE 29148；无对应标准时写团队规范名）；',
    '- quality：整份文档的质量总要求（≥10 字）；',
    '- writingRules：3~6 条编写规则，每条 ≥10 字、可检查（语言/格式/度量纪律）；',
    '- chapters：4~7 个大章，章标题必须中文数字+顿号（如「一、概述」），每章 requires ≥20 字、写到可验收粒度；',
    '- label：该类别的中文显示名（如「验收方案」）。',
    '输出**仅一个** ```json 围栏块（此外不写任何文字），结构：',
    '{"label":"…","standard":"…","quality":"…","writingRules":["…"],"chapters":[{"title":"一、…","requires":"…"}]}',
  ].filter(Boolean).join('\n');
}

/** 容错抽取+校验：围栏优先、首尾大括号兜底；返回草案或人话原因（不落码） */
export function parseTemplateDraft(text: string): { ok: true; draft: TemplateDraft } | { ok: false; reason: string } {
  const fenced = /```json\s*\n([\s\S]*?)```/.exec(text);
  let raw = fenced?.[1]?.trim() ?? '';
  if (!raw) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) raw = text.slice(i, j + 1);
  }
  if (!raw) return { ok: false, reason: 'AI 起草未产出 JSON，可重试或人工填写' };
  try {
    const j = JSON.parse(raw) as TemplateDraft;
    const problems = validateTemplate('x-draft', j);
    if (problems.length > 0) return { ok: false, reason: `AI 草案未过专业度校验（${problems.join('；')}）——可人工补齐后保存` };
    return { ok: true, draft: j };
  } catch {
    return { ok: false, reason: 'AI 起草产出的 JSON 不合法，可重试或人工填写' };
  }
}
