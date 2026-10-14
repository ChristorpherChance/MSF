import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS, DEFAULT_AGENT_MAP } from './stage-guides.js';
import { BAND_BUDGETS, contextBand, narrowTrim } from './agent-prompts.js';
import { TOOL_BLOCK_CONDENSED, TOOL_BLOCK_FULL } from './sessions.service.js';

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
});

describe('上下文预算分档（Task 3，设计 §2 分档表）', () => {
  it('contextBand 三档边界值钉死', () => {
    // 无模型/mock 期=wide（306 基线口径不变）
    expect(contextBand(null)).toBe('wide');
    expect(contextBand(undefined)).toBe('wide');
    // 宽档：≥512k
    expect(contextBand(1000000)).toBe('wide');
    expect(contextBand(512000)).toBe('wide');
    // 标准档：128k~512k（默认 128000 落标准档）
    expect(contextBand(256000)).toBe('standard');
    expect(contextBand(128000)).toBe('standard');
    // 窄档：<128k
    expect(contextBand(127999)).toBe('narrow');
    expect(contextBand(64000)).toBe('narrow');
  });
  it('BAND_BUDGETS 三档预算钉死（wide=现状常量原位参数化）', () => {
    expect(BAND_BUDGETS.wide).toEqual({ toolLog: 80000, docRead: 12000 });
    expect(BAND_BUDGETS.standard).toEqual({ toolLog: 40000, docRead: 8000 });
    expect(BAND_BUDGETS.narrow).toEqual({ toolLog: 16000, docRead: 6000 });
  });
  it('narrowTrim：assistant/主 Agent 全段保留（窄档不降全局身份与主职责）', () => {
    for (const k of MAIN_KEYS) {
      const a = DEFAULT_AGENT_MAP[k]!;
      expect(narrowTrim(k, a.prompt), k).toBe(a.prompt);
    }
    // overlay（dev.coding-std 编码规范）是标准援引非方法论——不裁
    const ov = DEFAULT_AGENT_MAP['dev.coding-std']!;
    expect(narrowTrim('dev.coding-std', ov.prompt)).toBe(ov.prompt);
  });
  it('narrowTrim：子 Agent 只留【职责】【反模式】段（方法论/质量闸裁掉）', () => {
    for (const k of SUB_KEYS.filter((k) => DEFAULT_AGENT_MAP[k]!.role === 'sub')) {
      const full = DEFAULT_AGENT_MAP[k]!.prompt;
      const trimmed = narrowTrim(k, full);
      expect(trimmed, k).toContain('【职责】');
      expect(trimmed, k).toContain('【反模式】');
      expect(trimmed, k).not.toContain('【方法论】');
      expect(trimmed, k).not.toContain('【质量闸】');
      expect(trimmed.length, k).toBeLessThan(full.length);
    }
  });
  it('narrowTrim 空结果兜底：用户版本无行首【职责】/【反模式】段标题 → 空串（装配层整块不注入）', () => {
    expect(narrowTrim('req.crd', '一段没有任何段标题的自由文本\n仍然没有任何标题')).toBe('');
  });
  it('能力边界/工具签名段原文保留（narrowTrim 不作用于非子 Agent 治理面文本）', () => {
    const gov = '【能力边界（必须遵守）】\n你不能直接修改……\n【可用工具（可自主调用）】\n- doc.read(kind)';
    expect(narrowTrim('assistant', gov)).toBe(gov);
    expect(narrowTrim('req', gov)).toBe(gov);
  });
});

describe('TOOL_BLOCK 双版本平价（Task 9，防将来加工具漏同步窄档精简版）', () => {
  const SEVEN_TOOLS = ['nav.goto', 'read_context', 'doc.read', 'chat.history.read',
    'propose_next_step', 'req.doc.propose_edits', 'design.doc.propose_edits'];
  /** 从声明块提取工具名清单（行首 `- 工具名：` 形态，两版共用此行式） */
  const toolNamesOf = (block: string): string[] =>
    [...block.matchAll(/^- ([\w.]+?)：/gm)].map((m) => m[1]!).sort();
  it('两块均含全部七个工具名+代码围栏格式+自动回喂纪律句', () => {
    for (const block of [TOOL_BLOCK_FULL, TOOL_BLOCK_CONDENSED]) {
      for (const t of SEVEN_TOOLS) expect(block, `缺工具 ${t}`).toContain(`- ${t}：`);
      expect(block).toContain('```msf-tool');
      expect(block).toContain('{"name":"工具名","args":{...}}');
      expect(block).toContain('自动回给你继续回答'); // 接力回喂纪律句两版均不可裁
    }
  });
  it('两版工具清单集合完全一致（FULL 加工具而 CONDENSED 漏同步即红）', () => {
    expect(toolNamesOf(TOOL_BLOCK_FULL)).toEqual([...SEVEN_TOOLS].sort());
    expect(toolNamesOf(TOOL_BLOCK_CONDENSED)).toEqual(toolNamesOf(TOOL_BLOCK_FULL));
  });
});
