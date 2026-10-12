import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS, DEFAULT_AGENT_MAP, STAGE_GUIDES } from './stage-guides.js';

const MAIN_KEYS = ['assistant', 'req', 'design', 'proto', 'dev', 'test', 'material'];
const SUB_KEYS = ['req.crd', 'req.prd',
  'design.hld', 'design.mod', 'design.alg', 'design.cls', 'design.db', 'design.api', 'design.ui', 'design.nfr',
  'material.file-parse', 'material.content-ops', 'dev.coding-std'];
const MAIN_SECTIONS = ['角色定位', '职责边界', '方法论', '工具纪律', '产出契约', '质量自检', '反模式', '协作联动'];

describe('DEFAULT_AGENTS 二十套基底结构断言', () => {
  it('名册齐全：7 主 + 13 子，key 无重复', () => {
    expect(DEFAULT_AGENTS.map((a) => a.key).sort()).toEqual([...MAIN_KEYS, ...SUB_KEYS].sort());
    expect(new Set(DEFAULT_AGENTS.map((a) => a.key)).size).toBe(20);
  });
  it('主 Agent 八段齐全、600~2000 字', () => {
    for (const k of MAIN_KEYS) {
      const a = DEFAULT_AGENT_MAP[k]!;
      expect(a.role).toBe(k === 'assistant' ? 'global' : 'main');
      for (const s of MAIN_SECTIONS) expect(a.prompt, `${k} 缺 ${s}`).toContain(s);
      expect(a.prompt.length, `${k} 字数`).toBeGreaterThanOrEqual(600);
      expect(a.prompt.length, `${k} 字数`).toBeLessThanOrEqual(2000);
    }
  });
  it('子 Agent 四段齐全、200~800 字，且段标题为行首【】形态（Task 3 narrowTrim 按行首切段的硬约束）', () => {
    for (const k of SUB_KEYS) {
      const a = DEFAULT_AGENT_MAP[k]!;
      expect(a.role === 'sub' || a.role === 'overlay').toBe(true);
      for (const s of ['职责', '方法论', '反模式', '质量闸']) {
        expect(a.prompt, `${k} 缺 ${s}`).toMatch(new RegExp(`^【${s}】`, 'm'));
      }
      expect(a.prompt.length).toBeGreaterThanOrEqual(200);
      expect(a.prompt.length).toBeLessThanOrEqual(800);
    }
  });
  it('实机教训入反模式（抽查钉死）', () => {
    expect(DEFAULT_AGENT_MAP['req']!.prompt).toContain('rewrite');
    expect(DEFAULT_AGENT_MAP['design']!.prompt).toContain('严禁重复读取');
    expect(DEFAULT_AGENT_MAP['material.file-parse']!.prompt).toContain('臆造');
  });
  it('STAGE_GUIDES 兼容契约：键集 = 六阶段 ctx（钉住迁移期消费面，防 role 改动漂移）', () => {
    expect(Object.keys(STAGE_GUIDES).sort()).toEqual(['design', 'dev', 'material', 'proto', 'req', 'test']);
    for (const k of Object.keys(STAGE_GUIDES)) {
      expect(STAGE_GUIDES[k]).toBe(DEFAULT_AGENT_MAP[k]!.prompt);
    }
  });
});
