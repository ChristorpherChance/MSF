/** RTM 派生纯函数单测（#15 反向派生口径钉住；无需基础设施） */
import { describe, expect, it } from 'vitest';
import { computeHealth, deriveLinks, scanOverdesign } from './rtm-health.js';

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

describe('scanOverdesign（设计覆盖检测 §1 反向维度：疑似过度设计筛查）', () => {
  it('锚点条目节标题与正文均无 REQ 回引 → 入候选', () => {
    const hld = '# HLD\n\n## 一、总体设计\n\n总述。\n\n## h-1 二级缓存层\n\n为性能引入进程内二级缓存。\n';
    expect(scanOverdesign('hld', hld)).toEqual([
      { book: 'hld', anchor: 'h-1', title: 'h-1 二级缓存层' },
    ]);
  });

  it('有 REQ 回引（标题或正文）不误报', () => {
    const body = '# HLD\n\n## h-1 触发链路\n\n本章承接 REQ-002 的触发链路。\n\n## h-2 REQ-003 会话模型\n\n细节。\n';
    expect(scanOverdesign('hld', body)).toEqual([]);
  });

  it('无码节（大章/总则/约定节）不查', () => {
    const hld = '# HLD\n\n## 一、总体设计\n\n全篇无任何 REQ 回引的总述。\n\n## 设计约定\n\n通用约定，无锚点码。\n';
    expect(scanOverdesign('hld', hld)).toEqual([]);
  });

  it('册级粗链不算承接：册内其它节有回引不豁免无回引节（逐节判定）', () => {
    const hld = [
      '# HLD',
      '## h-1 触发链路',
      '承接 REQ-002。',
      '## h-2 二级缓存层',
      '为性能引入，无需求依据。',
    ].join('\n');
    const c = scanOverdesign('hld', hld);
    expect(c).toEqual([{ book: 'hld', anchor: 'h-2', title: 'h-2 二级缓存层' }]);
  });

  it('只认本册前缀锚点码：他册码节不算本册条目节（逐册各扫各的）', () => {
    // hld 册里出现 ui 册锚点码节（异常内容）——不按 hld 候选报，也不误配 h- 前缀
    const hld = '# HLD\n\n## u-3 弹窗规范\n\n无 REQ 回引。\n';
    expect(scanOverdesign('hld', hld)).toEqual([]);
    expect(scanOverdesign('ui', hld)).toEqual([{ book: 'ui', anchor: 'u-3', title: 'u-3 弹窗规范' }]);
  });

  it('锚点码须在标题内：正文提及本册码不构成条目节', () => {
    const hld = '# HLD\n\n## 一、总体设计\n\n详见 h-1（该节不存在）。\n';
    expect(scanOverdesign('hld', hld)).toEqual([]);
  });

  it('编号边界：h-10 整体取码不误截 h-1；大写 H-1 漏报是有意的保守方向', () => {
    const hld = '# HLD\n\n## h-10 兜底策略\n\n无 REQ 回引。\n\n## H-1 大写异常节\n\n也无回引。\n';
    // h-10 入候选且码完整（\d+ 贪婪+\b 边界，防前缀误配截成 h-1）；H-1 大写不匹配不入候选
    expect(scanOverdesign('hld', hld)).toEqual([
      { book: 'hld', anchor: 'h-10', title: 'h-10 兜底策略' },
    ]);
  });

  it('deferred 扩 dsg：DSG 码（h-1 形）自指行进 deferred 集但不挤占 R/CR/REQ 分母', () => {
    const { links, nodes } = deriveLinks(CRD, PRD);
    const h = computeHealth(nodes, [
      ...links.map((l) => ({
        from_kind: l.fromKind, from_code: l.fromCode, to_kind: l.toKind, to_code: l.toCode, relation: l.relation,
      })),
      // 过度设计豁免自指行（from==to，nodeKind='dsg'，码=册锚点 h-1）
      { from_kind: 'dsg', from_code: 'h-1', to_kind: 'dsg', to_code: 'h-1', relation: 'deferred' },
    ]);
    // h-1 不撞 R/CR/REQ 编码：三层分母与覆盖率不受污染，仅 L0d 计数 +1
    expect(h.l0a).toBe(1);
    expect(h.l0b).toBe(1);
    expect(h.l0c).toBe(0.5); // PRD 基线口径：REQ-001 有锚、REQ-002 无承接
    expect(h.l0d).toBe(1);
    expect(h.deferredItems).toEqual([{ nodeId: 'h-1' }]);
  });
});
