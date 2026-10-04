/** 跨阶段会话摘要纯函数单测（预算截断/标签映射/空态） */
import { describe, expect, it } from 'vitest';
import { buildCrossSessionDigest } from './cross-session-digest.js';

const row = (ctx: string, code: string, excerpts: string[]) => ({ ctx, code, at: '2026-10-03 15:20', excerpts });

describe('buildCrossSessionDigest', () => {
  it('渲染会话行组：阶段标签 + 编号 + 时间 + 用户消息摘录', () => {
    const out = buildCrossSessionDigest([row('material', 'ss_3', ['客户要双人同屏', '预算 5 万'])]);
    expect(out).toContain('【他阶段会话');
    expect(out).toContain('[资料] ss_3（2026-10-03 15:20）');
    expect(out).toContain('客户要双人同屏');
    expect(out).toContain('预算 5 万');
  });

  it('整块超预算时从最旧会话开始丢弃（rows 按 updated_at DESC 传入，尾部=最旧）', () => {
    const rows = [
      row('req', 'ss_9', ['最近的会话']),
      row('material', 'ss_3', ['x'.repeat(4000)]),
    ];
    const out = buildCrossSessionDigest(rows, 3000);
    expect(out).toContain('ss_9');
    expect(out).not.toContain('ss_3');
  });

  it('预算装不下任何会话 / 空输入 → 返回空串（调用方省略整块）', () => {
    expect(buildCrossSessionDigest([], 3000)).toBe('');
    expect(buildCrossSessionDigest([row('req', 'ss_1', ['y'.repeat(4000)])], 100)).toBe('');
  });

  it('未知 ctx 原样呈现；无摘录的会话跳过', () => {
    const out = buildCrossSessionDigest([row('legacy', 'ss_7', ['旧会话表态']), row('req', 'ss_8', [])]);
    expect(out).toContain('[legacy] ss_7');
    expect(out).not.toContain('ss_8');
  });
});
