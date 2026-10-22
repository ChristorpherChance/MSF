/** 开发域真化·纯函数单元测试（无 DB/沙箱依赖）：
 *  parseFileBlocks 契约解析（含未闭合尾围栏容错/路径收编/去重/上限）+ scaffoldFiles 补缺不覆盖 + devMode 开关 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFileBlocks, scaffoldFiles, APP_CONVENTIONS, pageFidelityCheck, extractInteractiveTexts } from './codegen.service.js';
import { DevWorkspaceService, devMode } from './workspace.service.js';
import { rewritePreviewHtml } from './preview.service.js';
import { buildTaskSpecs, scheduleBatches } from './tasks.service.js';
import { pageWiredOutcome, pageStructureOutcome, extractHtmlLinks, pageLinksOutcome } from './selftest.service.js';
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

  it('应用约定含 2026-10-22 原型保真经验固化（差异65 后续）', () => {
    // 导航出口死循环教训
    expect(APP_CONVENTIONS).toContain('禁「认证成功→首页→再点玩法→又回认证」死循环');
    // 实时房间在线口径（断线座位不卡开局、房主代行）
    expect(APP_CONVENTIONS).toContain('在线最早入座者代行');
    // 对局数据链（回放录帧+记账）
    expect(APP_CONVENTIONS).toContain('对局数据链');
    // 跨页接缝归属（禁页面有按钮服务无路由）
    expect(APP_CONVENTIONS).toContain('跨页接缝归属');
    // 空态与权限引导
    expect(APP_CONVENTIONS).toContain('空态与权限引导');
    // 2026-10-22 run_262 重生成实锤：壳焊缝丢失四轮连红——重写先读契约
    expect(APP_CONVENTIONS).toContain('重写先读契约');
    // 2026-10-22 文案漂移根修：保真闸机器强制（prompt 条款压不住自创版式）
    expect(APP_CONVENTIONS).toContain('保真闸');
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
    // 骨架 writeScopes 文件级（壳 server/index.js+public/index.html、后端 server/api.js 互不重叠，同批不假冲突）
    expect(shell.writeScopes).toEqual(['server/index.js', 'public/index.html']);
    expect(api.writeScopes).toEqual(['server/api.js']);
  });
});

describe('scheduleBatches 类型序约束（2026-10-21：基座先行不被纯 deps 拓扑碾平）', () => {
  it('全 deps=[] 时：壳/后端 batch 1、页面 batch 2、联调 batch 3（文件级写范围零冲突）', () => {
    const specs = buildTaskSpecs([
      { item_type: 'page', code: 'P-001', payload: { title: '首页' } },
      { item_type: 'page', code: 'P-002', payload: { title: '设置页' } },
    ]);
    const tasks = specs.map((s, i) => ({
      id: `id-${i}`, code: `T-0${String(i + 1).padStart(2, '0')}`, kind: s.kind, deps: s.deps, write_scopes: s.writeScopes,
    }));
    const plan = scheduleBatches(tasks);
    expect(plan.ok).toBe(true);
    const batchOf = (title: string) => plan.assignments.get(tasks[specs.findIndex((s) => s.title === title)]!.code)!;
    expect(batchOf('应用壳与公共接线')).toBe(1);
    expect(batchOf('服务实现：后端 API 与数据')).toBe(1); // 与壳同批（写范围不重叠）
    expect(batchOf('页面实现：首页')).toBe(2);
    expect(batchOf('页面实现：设置页')).toBe(2);
    expect(batchOf('端到端联调')).toBe(3); // 殿后
    expect(plan.conflicts).toHaveLength(0);
  });
  it('显式 deps 与类型序叠加：页面依赖指定后端仍成立；common 依赖 frontend 成环拒绝', () => {
    const plan = scheduleBatches([
      { id: '1', code: 'T-01', kind: 'backend', deps: [], write_scopes: ['server/api.js'] },
      { id: '2', code: 'T-02', kind: 'frontend', deps: ['T-01'], write_scopes: ['public/pages/P-001.html'] },
    ]);
    expect(plan.ok).toBe(true);
    expect(plan.assignments.get('T-02')!).toBeGreaterThan(plan.assignments.get('T-01')!);
    const cyc = scheduleBatches([
      { id: '1', code: 'T-01', kind: 'common', deps: ['T-02'], write_scopes: ['server/index.js'] },
      { id: '2', code: 'T-02', kind: 'frontend', deps: [], write_scopes: ['public/pages/P-001.html'] },
    ]);
    expect(cyc.ok).toBe(false); // 类型序隐含边 T-02→T-01 与显式 T-01→T-02 成环
  });
});

describe('pageWiredOutcome 页面接线观察判定', () => {
  it('缺失→fail；原型静态副本标记→fail；接线版→pass', () => {
    expect(pageWiredOutcome(null)).toBe('fail');
    expect(pageWiredOutcome('<!-- msf:prototype-copy 原型静态副本 -->\n<html></html>')).toBe('fail');
    expect(pageWiredOutcome('<!doctype html><html><body>wired</body></html>')).toBe('pass');
  });
});

describe('pageStructureOutcome 页面结构完整判定（real ui 门一般项，2026-10-21 SR-0008 分母闸根修）', () => {
  it('缺失→fail；无 html/body→fail；完整文档→pass', () => {
    expect(pageStructureOutcome(null)).toBe('fail');
    expect(pageStructureOutcome('<div>碎片</div>')).toBe('fail');
    expect(pageStructureOutcome('<body>仅身体</body>')).toBe('fail');
    expect(pageStructureOutcome('<!doctype html><html lang="zh"><head></head><body>wired</body></html>')).toBe('pass');
  });
});

describe('页间链接完整性（real ui 门 c-page-links，2026-10-21「完整产品」断链门禁）', () => {
  it('extractHtmlLinks：相对 .html 全抓（href/location.href、带 query），外链/根相对/mailto/非 html 不算', () => {
    const html = [
      '<a href="P-002.html">房间</a>',
      '<a href="P-001.html?returnTo=P-009.html">登录</a>',
      "location.href = 'P-003.html?x=1'",
      '<a href="https://cdn.example.com/x.html">外链</a>',
      '<a href="//cdn.example.com/y.html">协议相对</a>',
      '<a href="/abs.html">根相对</a>',
      '<a href="mailto:a@b.c">邮</a>',
      '<img src="logo.png">',
    ].join('');
    expect(extractHtmlLinks(html).sort()).toEqual(['P-001.html', 'P-002.html', 'P-003.html']);
  });
  it('pageLinksOutcome：目标存在→pass；指向不存在页码/越界→fail（P-ROOM 冤案形态）', () => {
    const files = new Set(['public/pages/P-001.html', 'public/pages/P-002.html']);
    const exists = (rel: string) => files.has(`public/${rel}`);
    expect(pageLinksOutcome('<a href="P-001.html">x</a><a href="../other.html">y</a>', exists)).toBe('fail'); // other.html 不在
    expect(pageLinksOutcome('<a href="P-001.html">x</a>', exists)).toBe('pass');
    expect(pageLinksOutcome('<a href="P-ROOM.html">断链</a>', exists)).toBe('fail');
    expect(pageLinksOutcome(null, exists)).toBe('fail');
    expect(pageLinksOutcome('<p>无链接</p>', exists)).toBe('pass');
  });
});

describe('pageFidelityCheck 页面保真闸（2026-10-22 文案漂移根修）', () => {
  const btn = (t: string) => `<button>${t}</button>`;
  it('原样保留→pass；嵌套标签剥平后命中；箭头/图标差异不计', () => {
    const proto = btn('账号登录') + btn('游客进入 ↗') + '<a href="x">返回游戏大厅 →</a>' + '<input placeholder="请输入登录账号">';
    const page = '<button class="primary">账号登录</button><button>游客进入</button><a href="P-HOME.html">返回游戏大厅</a><input placeholder="请输入登录账号">';
    const r = pageFidelityCheck(proto, page);
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual([]);
  });
  it('同义改写/缺控件超阈值→fail 且列出原文案', () => {
    const proto = Array.from({ length: 10 }, (_, i) => btn(`功能入口${i + 1}号`)).join('');
    const page = Array.from({ length: 6 }, (_, i) => btn(`功能入口${i + 1}号`)).join('') + btn('自创甲') + btn('自创乙') + btn('自创丙') + btn('自创丁');
    const r = pageFidelityCheck(proto, page);
    expect(r.ok).toBe(false); // 缺 4 > max(3, 10*15%=1)
    expect(r.missing).toEqual(['功能入口7号', '功能入口8号', '功能入口9号', '功能入口10号']);
    expect(r.total).toBe(10);
  });
  it('演示噪音（默认态/空态/原型导航）不计分母；拼接长串（>12 规范化字）剔除；原型硬编码演示数据（人名）计缺失但被阈值吸收', () => {
    const proto = '<div>默认态</div><div>空态</div>' + btn('原型导航：预览对战页 →') + btn('对局模式全部模式双人天梯房间混战') + btn('星野 我') + btn('确定');
    const r = pageFidelityCheck(proto, btn('确定'));
    expect(r.total).toBe(2); // 星野 我 + 确定
    expect(r.missing).toEqual(['星野 我']); // 演示数据缺失如实记录
    expect(r.ok).toBe(true); // 阈值吸收（产品渲染真实数据，演示人名本就不该出现）
  });
  it('extractInteractiveTexts：placeholder 与去重', () => {
    const ts = extractInteractiveTexts('<button>登录</button><button>登录</button><input placeholder="账号"><option>公开</option>');
    expect(ts).toEqual(['登录', '公开', '账号']); // 控件文本按文档序先行，placeholder 批次在后
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
