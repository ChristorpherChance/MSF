/** RTM 派生纯函数单测（#15 反向派生口径钉住；无需基础设施） */
import { describe, expect, it } from 'vitest';
import { computeHealth, deriveLinks } from './rtm-health.js';

const CRD = '# CRD\n\n## CR-001 自动审查\n\n承接 R-001、R-002\n';
const PRD = [
  '# PRD',
  '## REQ-001 手动入口',
  '承接：CR-001',
  '设计承接：DSG-U03-2',
  '## REQ-002 自动触发',
  '承接：CR-001',
].join('\n');

describe('deriveLinks（#15 设计册反向派生）', () => {
  it('基线口径：仅 PRD 正文 DSG 锚点建 implements', () => {
    const { links, nodes } = deriveLinks(CRD, PRD);
    expect(nodes.req).toEqual(['REQ-001', 'REQ-002']);
    expect(nodes.dsg).toEqual(['DSG-U03-2']);
    expect(links).toContainEqual({ fromKind: 'req', fromCode: 'REQ-001', toKind: 'dsg', toCode: 'DSG-U03-2', relation: 'implements' });
  });

  it('设计册章节只回引 REQ（无 DSG 锚点）→ 册级粗粒度链 DSG-<册>（W3-004：单字母规格前缀）', () => {
    const hld = '# HLD\n\n## REQ-002 自动触发设计\n\n本章承接 REQ-002 的触发链路。\n';
    const { links, nodes } = deriveLinks(CRD, PRD, [{ book: 'hld', content: hld }]);
    expect(nodes.dsg).toContain('DSG-H');
    expect(links).toContainEqual({ fromKind: 'req', fromCode: 'REQ-002', toKind: 'dsg', toCode: 'DSG-H', relation: 'implements' });
  });

  it('设计册章节同含 REQ 与 DSG-* → 精确链优先于册级链', () => {
    const lld = '# LLD\n\n## REQ-002 触发器\n\n锚点 DSG-F09-1，承接 REQ-002。\n';
    const { links, nodes } = deriveLinks(CRD, PRD, [{ book: 'lld', content: lld }]);
    expect(nodes.dsg).toContain('DSG-F09-1');
    expect(nodes.dsg).not.toContain('DSG-LLD');
    expect(links).toContainEqual({ fromKind: 'req', fromCode: 'REQ-002', toKind: 'dsg', toCode: 'DSG-F09-1', relation: 'implements' });
  });

  it('设计册回引不存在的 REQ 不回灌 REQ 节点集（PRD 为权威）', () => {
    const hld = '# HLD\n\n## REQ-099 幻影\n\n承接 REQ-099。\n';
    const { nodes } = deriveLinks(CRD, PRD, [{ book: 'hld', content: hld }]);
    expect(nodes.req).toEqual(['REQ-001', 'REQ-002']);
  });

  it('反向派生使 L0c 达标且无 L0C_BELOW 缺口', () => {
    const hld = '# HLD\n\n## REQ-002 自动触发设计\n\n承接 REQ-002。\n';
    const { links, nodes } = deriveLinks(CRD, PRD, [{ book: 'hld', content: hld }]);
    const h = computeHealth(nodes, links.map((l) => ({
      from_kind: l.fromKind, from_code: l.fromCode, to_kind: l.toKind, to_code: l.toCode, relation: l.relation,
    })));
    expect(h.l0c).toBe(1);
    expect(h.gaps.filter((g) => g.code === 'L0C_BELOW')).toEqual([]);
  });

  it('L0C_BELOW 缺口带修复引导（PRD 锚点 / 设计册回引两条路径）', () => {
    const { links, nodes } = deriveLinks(CRD, PRD);
    const h = computeHealth(nodes, links.map((l) => ({
      from_kind: l.fromKind, from_code: l.fromCode, to_kind: l.toKind, to_code: l.toCode, relation: l.relation,
    })));
    const gap = h.gaps.find((g) => g.code === 'L0C_BELOW' && g.target === 'REQ-002');
    expect(gap?.message).toContain('设计承接：DSG-*');
    expect(gap?.message).toContain('设计册');
  });
});
