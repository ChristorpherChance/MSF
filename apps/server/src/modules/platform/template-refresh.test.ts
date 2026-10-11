import { describe, expect, it } from 'vitest';
import { chapterTitlesOf, detectSkeletonMismatch, REFRESH_INSTRUCTION } from './template-refresh.js';
import { codeDefaultTemplate } from './doc-templates.js';

/** 启发式判据（2026-10-11 用户拍板：缺章/多章/顺序不符即标黄，纯格式比对只提示不拦截） */
describe('template-refresh 启发式判据', () => {
  const t = codeDefaultTemplate('hld')!;
  const good = t.chapters.map((c) => `## ${c.title}\n\n内容`).join('\n\n');
  it('大章标题提取：只认 `## ` + 中文数字顿号（deriveNumbering 同口径）', () => {
    const titles = chapterTitlesOf(`# 标题\n\n## 一、背景与目标\n\n### 1.1 小节\n\n## 二、总体架构\n\n## CR-001 条目节`);
    expect(titles).toEqual(['一、背景与目标', '二、总体架构']);
  });
  it('一致→不标；缺章/多章/逆序/章名不符→标', () => {
    expect(detectSkeletonMismatch(good, t)).toBe(false);
    expect(detectSkeletonMismatch(good.replace(/## 三、架构视图[\s\S]*?(?=## 四、)/, ''), t)).toBe(true); // 缺章
    expect(detectSkeletonMismatch(`${good}\n\n## 七、多加的一章\n\nx`, t)).toBe(true); // 多章
    const swapped = good.replace('## 一、架构目标与约束', '## TMP').replace('## 二、总体架构', '## 一、架构目标与约束').replace('## TMP', '## 二、总体架构');
    expect(detectSkeletonMismatch(swapped, t)).toBe(true); // 逆序
    expect(detectSkeletonMismatch(good.replace('一、架构目标与约束', '一、架构目标'), t)).toBe(true); // 章名不符
  });
  it('固定 instruction 文案（契约：编排器单点持有，req/design 处理器共享）', () => {
    expect(REFRESH_INSTRUCTION).toContain('模板骨架');
    expect(REFRESH_INSTRUCTION).toContain('保留');
  });
});
