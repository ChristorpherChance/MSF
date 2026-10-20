/** 开发域真化·纯函数单元测试（无 DB/沙箱依赖）：
 *  parseFileBlocks 契约解析（含未闭合尾围栏容错/路径收编/去重/上限）+ scaffoldFiles 补缺不覆盖 + devMode 开关 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFileBlocks, scaffoldFiles, APP_CONVENTIONS } from './codegen.service.js';
import { DevWorkspaceService, devMode } from './workspace.service.js';
import { rewritePreviewHtml } from './preview.service.js';
import { buildTaskSpecs } from './tasks.service.js';
import { pageWiredOutcome } from './selftest.service.js';
import { parseAiReview } from './board.service.js';

describe('parseFileBlocks 输出契约', () => {
  it('标准文件块解析', () => {
    const text = '前言\n```file path="package.json"\n{"a":1}\n```\n中间话\n```file path="server/index.js"\nconsole.log(1)\n```\n尾声';
    const files = parseFileBlocks(text);
    expect(files).toEqual([
      { path: 'package.json', content: '{"a":1}' },
      { path: 'server/index.js', content: 'console.log(1)' },
    ]);
  });

  it('未闭合尾围栏容错（模型漏写收尾 ``` 时尾文件照样采用）', () => {
    const text = '```file path="a.js"\nlet a = 1;\n```\n```file path="b.js"\nlet b = 2;';
    const files = parseFileBlocks(text);
    expect(files.map((f) => f.path)).toEqual(['a.js', 'b.js']);
    expect(files[1]!.content).toBe('let b = 2;');
  });

  it('路径收编：上跳/绝对/反斜杠/非法字符一律滤除', () => {
    const text = [
      '```file path="../evil.js"', 'x', '```',
      '```file path="/abs.js"', 'x', '```',
      '```file path="src\\win.js"', 'x', '```',
      '```file path="ok/good.ts"', 'x', '```',
    ].join('\n');
    const files = parseFileBlocks(text);
    expect(files.map((f) => f.path)).toEqual(['src/win.js', 'ok/good.ts']);
  });

  it('同路径后写胜出 + 零块=空数组', () => {
    const dup = '```file path="a.js"\nv1\n```\n```file path="a.js"\nv2\n```';
    expect(parseFileBlocks(dup)[0]!.content).toBe('v2');
    expect(parseFileBlocks('没有任何文件块的回复')).toEqual([]);
  });
});

describe('scaffoldFiles 确定性脚手架', () => {
  const task = { code: 'T-001', title: '页面实现：首页', deliverables: ['src/pages/P-001/index.ts', 'docs/note.md'] };

  it('空仓库：骨架五件 + 可执行交付物 stub', () => {
    const files = scaffoldFiles(task, new Set());
    const paths = files.map((f) => f.path);
    expect(paths).toContain('package.json');
    expect(paths).toContain('server/index.js');
    expect(paths).toContain('public/index.html');
    expect(paths).toContain('scripts/build.js');
    expect(paths).toContain('tests/smoke.test.js');
    expect(paths).toContain('src/pages/P-001/index.ts'); // .ts 交付物补 stub
    expect(paths).not.toContain('docs/note.md'); // 非代码交付物不补
  });

  it('已有文件一律不覆盖（补缺纪律）', () => {
    const files = scaffoldFiles(task, new Set(['package.json', 'server/index.js', 'src/pages/P-001/index.ts']));
    expect(files.map((f) => f.path)).not.toContain('package.json');
    expect(files.map((f) => f.path)).not.toContain('server/index.js');
    expect(files.map((f) => f.path)).not.toContain('src/pages/P-001/index.ts');
    expect(files.map((f) => f.path)).toContain('public/index.html');
  });

  it('应用约定文案含输出契约与内网纪律', () => {
    expect(APP_CONVENTIONS).toContain('```file path=');
    expect(APP_CONVENTIONS).toContain('无出向');
    expect(APP_CONVENTIONS).toContain('PORT');
  });
});

describe('devMode / 工作区路径收编', () => {
  const OLD = { ...process.env };
  afterEach(() => { process.env = { ...OLD }; });

  it('MSF_DEV_MODE 默认 mock，real 显式开启', () => {
    delete process.env.MSF_DEV_MODE;
    expect(devMode()).toBe('mock');
    process.env.MSF_DEV_MODE = 'real';
    expect(devMode()).toBe('real');
  });

  it('writeFile/readFile 路径越界拒绝；合法路径真实落盘', async () => {
    const root = mkdtempSync(join(tmpdir(), 'msf-ws-'));
    process.env.MSF_WORKSPACES_ROOT = root;
    const ws = new DevWorkspaceService();
    const pid = '11111111-1111-1111-1111-111111111111';
    await expect(ws.writeFile(pid, '../x.js', 'x')).rejects.toThrow('路径非法');
    await expect(ws.writeFile(pid, 'node_modules/x.js', 'x')).rejects.toThrow('禁写区');
    await ws.writeFile(pid, 'src/a/b.js', 'hello');
    expect(await ws.readFile(pid, 'src/a/b.js')).toBe('hello');
    rmSync(root, { recursive: true, force: true });
  });

  it('dir() 非 uuid projectId 拒绝', () => {
    const ws = new DevWorkspaceService();
    expect(() => ws.dir('../../etc')).toThrow('形态非法');
  });
});

describe('rewritePreviewHtml 根相对引用重写', () => {
  const PID = '11111111-2222-4333-8444-555555555555';
  it('src/href/action 根相对 → 反代前缀；协议相对/外链/已带前缀/相对引用不动（幂等）', () => {
    const html = [
      '<link rel="stylesheet" href="/style.css">',
      '<script src="/app.js" defer></script>',
      '<form action="/submit">',
      '<a href="//cdn.example.com/x.js">',
      '<a href="https://example.com/y">',
      `<a href="/dev-preview/${PID}/already">`,
      '<img src="img/logo.png">',
    ].join('');
    const out = rewritePreviewHtml(html, PID);
    expect(out).toContain(`href="/dev-preview/${PID}/style.css"`);
    expect(out).toContain(`src="/dev-preview/${PID}/app.js"`);
    expect(out).toContain(`action="/dev-preview/${PID}/submit"`);
    expect(out).toContain('href="//cdn.example.com/x.js"');
    expect(out).toContain('href="https://example.com/y"');
    expect(out).toContain(`href="/dev-preview/${PID}/already"`);
    expect(out).toContain('src="img/logo.png"');
    // 幂等：重写结果再过一遍不变
    expect(rewritePreviewHtml(out, PID)).toBe(out);
  });
});

describe('buildTaskSpecs 真化口径（2026-10-20 预览=原型根修）', () => {
  it('页面恒 frontend 交付 public/pages/<code>.html；壳/后端/联调三骨架齐备且批次有序', () => {
    const specs = buildTaskSpecs([
      { item_type: 'page', code: 'P-001', payload: { title: '首页' } },
      { item_type: 'page', code: 'P-002', payload: { title: '接口清单页' } }, // 标题含「接口」也不可被关键词带偏成 backend
      { item_type: 'flow', code: 'F-001', payload: { title: '主流程' } },
    ]);
    const pages = specs.filter((s) => s.kind === 'frontend');
    expect(pages).toHaveLength(2);
    expect(pages[0]!.deliverables).toEqual(['public/pages/P-001.html']);
    expect(pages[0]!.writeScopes).toEqual(['public/pages/P-001.html']); // 页面级写入范围：同批页面不互报假冲突
    const shell = specs.find((s) => s.title === '应用壳与公共接线')!;
    const api = specs.find((s) => s.title === '服务实现：后端 API 与数据')!;
    const e2e = specs.find((s) => s.title === '端到端联调')!;
    expect(shell.batchNo).toBe(1);
    expect(api.batchNo).toBe(1);
    expect(api.deliverables).toEqual(['server/api.js']);
    expect(e2e.batchNo).toBeGreaterThan(1); // 联调殿后
    expect(e2e.sourceIds).toEqual(['F-001']);
  });
});

describe('pageWiredOutcome 页面接线观察判定', () => {
  it('缺失→fail；原型静态副本标记→fail；接线版→pass', () => {
    expect(pageWiredOutcome(null)).toBe('fail');
    expect(pageWiredOutcome('<!-- msf:prototype-copy 原型静态副本 -->\n<html></html>')).toBe('fail');
    expect(pageWiredOutcome('<!doctype html><html><body>wired</body></html>')).toBe('pass');
  });
});

describe('parseAiReview 评审输出抽取', () => {
  it('围栏 JSON / 裸 JSON / 垃圾输出三径（垃圾落 fail 宁严不宽）', () => {
    expect(parseAiReview('```json\n{"verdict":"pass","comment":"可合并"}\n```')).toMatchObject({ conclusion: 'pass', note: '可合并' });
    expect(parseAiReview('前缀 {"verdict":"fail","comment":"缺测试"} 后缀')).toMatchObject({ conclusion: 'fail', note: '缺测试' });
    expect(parseAiReview('完全不是 JSON')).toMatchObject({ conclusion: 'fail' });
    expect(parseAiReview('{"verdict":"pass"}').conclusion).toBe('fail'); // 无 comment 不落 pass
  });
});
