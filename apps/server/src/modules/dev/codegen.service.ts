import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { appendEvidence } from '../evidence/audit.service.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { AI_PROVIDER, type AiProvider } from '../ai/ai-provider.interface.js';
import { StorageService } from '../platform/storage.service.js';
import { sanitizeAiError } from '../ai/stream-pipeline.js';
import { DevWorkspaceService } from './workspace.service.js';

/**
 * AI 真写码执行器（2026-10-18 开发域真化一期，用户拍板）：
 * dev.task.run 在 MSF_DEV_MODE=real 下的真身——任务规格 + 目录条目载荷 + 页级原型参考 HTML
 * 组织成 prompt，模型按 ```file path="..." 围栏契约产出文件块；服务端解析落盘（路径收编 +
 * .git/node_modules 禁区 + 60 文件/256KB 上限），逐任务 git commit，证据（文件清单/commit/
 * 模型/轮次）随 dev.task.run.complete 命令同事务落库。
 * - 异步任务：start 仅做状态校验+置 prog=10；执行在事务外；complete 对 run_status 已变
 *   （人工 stop/返工）的晚到收尾零写（委派 transition 同口径）
 * - 不静默降级：real 模式但 AI 非 pi 真接 → 走确定性脚手架产物并如实记 mode='deterministic'
 *   （MSF_AI_PROVIDER=mock 的本地/CI 真化联调用）；沙箱/模型故障 → 任务置 stopped+阻塞原因
 */

export interface CodegenFile { path: string; content: string }

const MAX_FILES = 60;
const MAX_PROMPT_HTML = 40_000;

/** 生成应用约定（注入 prompt；预览形态=单进程自包含，沙箱内网零出向可跑） */
export const APP_CONVENTIONS = `
【目标应用形态约定（必须遵守）】
- 单进程自包含 Node.js 应用（CommonJS，不依赖任何需要编译的原生模块）；
- package.json 必须含 scripts：
  "start": "node server/index.js"（服务监听 process.env.PORT || 3000，绑定 0.0.0.0）
  "test":  "node --test"（用 node 内置测试器自动发现 *.test.js，断言真实行为；禁写 "node --test tests/"——Node 22 把带斜杠目录参当模块解析直接炸）
  "build": "node scripts/build.js"（无构建步骤时写检查脚本：校验关键文件存在即退出 0）
- 后端代码在 server/，前端静态资源在 public/ 并由 server 托管；
  页面=public/pages/<页码>.html 单文件自包含 HTML（外观以定稿原型为基准 1:1），
  首页 public/index.html=**产品首页**（打开应用即进入产品本身：直接承载产品首页内容，
  或加载即 location.replace 到 pages/ 下的产品首页页——产品首页页码=P-HOME，无则取页面码序首）；
  开发用页面导航不占首页：由 server 的 GET /dev-pages 路由动态列出 pages/*.html（数据源 /app-api/pages）；
  页面间跳转一律相对链接且**目标页必须真实存在**（href="P-002.html" 形态，禁指向不存在的页码——
  自测 UI 门会逐页核验 .html 引用完整性，断链即红）；
  链接语义按页面职能：首页=P-HOME（无则码序首）、登录=P-001 系、列表/大厅=对应功能页——
  「返回首页」指向首页页码（或 ../index.html 跳板），「进入大厅」指向大厅页码，禁张冠李戴；
  前端一切引用（fetch、src、href、link、script、表单 action）一律用相对路径
  （如 fetch('app-api/xxx')、href="style.css"、pages/P-001.html 页内跳其他页写 "../pages/P-002.html" 或 "P-002.html"），禁用根相对路径（"/..."）——
  预览经 /dev-preview/:pid/ 前缀反代，根相对会解析到平台根 404；
  禁止引用任何外网 CDN/字体/图片（运行环境无出向网络）；
- 数据可用内存态或写 data/ 目录 JSON 文件（data/ 已在 .gitignore）；
- 【实时服务（若接口册含 ws/实时/SSE 端点，必须遵守）】server 必须在 http server 上接
  'upgrade' 事件完成 WebSocket 握手与帧编解码（可用 server/websocket.js 骨架），
  实时路由路径与接口册一致（如 /ws、/app-api/ws）；**禁只写前端 WebSocket 客户端而服务端无接线**——
  测试阶段「功能一致」维度会真实连通核对，连不上即不通过；
  页面发起的每个 WS 指令服务端必须有应答（ack/error），不得静默吞掉；
- 【会话】登录态用 HttpOnly cookie（Path=/），服务端会话内存态即可；
  预览反代会透传应用 cookie（平台凭据 msf_auth 被隔离剥除，应用不得读写它）；
- 【导航出口（必须可达，2026-10-22 死循环教训）】认证/登录/注册成功后必须进入产品功能页
  （默认大厅/列表页；入口带 ?mode= 等参数时目标页必须消费它——如练习模式直接建房进对局页）；
  禁「认证成功→首页→再点玩法→又回认证」死循环；页面承诺的每个入口（模式卡、筛选项、操作按钮）
  必须真实可达可用；
- 【实时房间在线口径（多人房必须遵守）】就绪与开局判定只统计当前在线座位；
  房主断线时由在线最早入座者代行开局/推进；cookie/账号身份断线保留座位但不得阻塞流程；
- 【对局数据链（若产品含回放/排行榜/战绩/结算页，必须遵守）】对局过程逐 tick 录帧，
  终局落回放 manifest（列表 GET /replays → {data:{items,nextCursor}}、
  详情 /replays/:id → {data:manifest}、帧形状含 {players,tick,map}），并把结果写入对局账本
  （排行榜/个人战绩/结算页的数据源）；游客无长期战绩属既设，页面须明示而非空白；
- 【跨页接缝归属】跨页/跨层功能（结算写账、邀请入房、观战、暂停/重开指令、房间设置变更）
  必须在任务中显式立项：后端任务 own 端点、页面任务 own 交互——禁「页面有按钮、服务无路由」；
  原型上的筛选器/设置项/页签做了控件就必须真实生效，禁只做 UI 不接逻辑；
- 【重写先读契约】重写已存在的文件（尤其壳/挂载层 server/index.js）前必须先读当前实现与
  既有测试：路由前缀收编、WS attach、钩子注入等挂载次序与模块导出形状都是契约，
  重生成丢焊缝=功能整层消失；新增/改写测试不得与既有测试的权威口径冲突（冲突以既有为准）；
- 【空态与权限引导】数据为空或当前身份无权限时，渲染设计好的空态/登录引导，禁报错挂死或留白；
- 样式直接写内联 <style> 或 public/ 下 css 文件。
【输出契约（严格执行）】
- 只输出文件块，不要寒暄。每个文件一个代码块，格式：
  \`\`\`file path="相对路径/文件.ext"
  （文件完整内容）
  \`\`\`
- 路径为工作区相对路径（如 package.json、server/index.js、public/index.html），不得含 .. 或以 / 开头；
- 修改已有文件时输出该文件完整新内容；新增文件直接输出；文件总数 ≤ ${MAX_FILES}。
`.trim();

/** 文件块解析（行扫描；未闭合尾围栏容错——模型漏写收尾 ``` 时既有完整文件照样采用） */
export function parseFileBlocks(text: string): CodegenFile[] {
  const files: CodegenFile[] = [];
  const lines = text.split(/\r?\n/);
  let cur: { path: string; buf: string[] } | null = null;
  for (const line of lines) {
    const open = line.match(/^```file\s+path="([^"]+)"\s*$/);
    if (open) {
      if (cur) files.push({ path: cur.path, content: cur.buf.join('\n') }); // 上一个未闭合先收
      cur = { path: open[1]!.trim(), buf: [] };
      continue;
    }
    if (cur) {
      if (/^```\s*$/.test(line)) {
        files.push({ path: cur.path, content: cur.buf.join('\n') });
        cur = null;
      } else {
        cur.buf.push(line);
      }
    }
  }
  if (cur) files.push({ path: cur.path, content: cur.buf.join('\n') }); // 尾围栏缺失容错
  // 去重（后写胜出）+ 形态校验
  const byPath = new Map<string, string>();
  for (const f of files) {
    const p = f.path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p || p.startsWith('/') || p.includes('..') || /[<>:"|?*]/.test(p)) continue;
    byPath.set(p, f.content);
  }
  return [...byPath.entries()].slice(0, MAX_FILES).map(([path, content]) => ({ path, content }));
}

/** 确定性脚手架（mock provider/解析为空兜底；只补缺不覆盖已有文件） */
export function scaffoldFiles(task: { code: string; title: string; deliverables: unknown[] }, existing: Set<string>): CodegenFile[] {
  const files: CodegenFile[] = [];
  const add = (path: string, content: string) => { if (!existing.has(path)) files.push({ path, content }); };
  add('package.json', JSON.stringify({
    name: 'msf-generated-app', private: true, version: '0.1.0',
    scripts: { start: 'node server/index.js', test: 'node --test', build: 'node scripts/build.js' },
  }, null, 2) + '\n');
  add('scripts/build.js', `const { existsSync } = require('node:fs');\nfor (const f of ['server/index.js', 'public/index.html']) {\n  if (!existsSync(f)) { console.error('missing ' + f); process.exit(1); }\n}\nconsole.log('build ok');\n`);
  add('server/index.js', `const http = require('node:http');\nconst { readFile, readdir } = require('node:fs/promises');\nconst { join, extname, normalize } = require('node:path');\nconst PORT = Number(process.env.PORT || 3000);\nconst MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };\nconst pub = (...p) => join(__dirname, '..', 'public', ...p);\nhttp.createServer(async (req, res) => {\n  const url = new URL(req.url, 'http://x');\n  if (url.pathname === '/app-api/info') {\n    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end(JSON.stringify({ name: 'msf-generated-app', tasks: [] }));\n    return;\n  }\n  if (url.pathname === '/app-api/pages') {\n    // 页面索引：public/pages/*.html 运行时发现（/dev-pages 数据源）\n    let pages = [];\n    try { pages = (await readdir(pub('pages'))).filter((f) => f.endsWith('.html')).map((f) => ({ code: f.replace(/\\.html$/, ''), href: 'pages/' + f })); } catch {}\n    res.writeHead(200, { 'content-type': 'application/json' });\n    res.end(JSON.stringify({ pages }));\n    return;\n  }\n  if (url.pathname === '/dev-pages') {\n    // 开发用页面导航（不占产品首页）\n    let pages = [];\n    try { pages = (await readdir(pub('pages'))).filter((f) => f.endsWith('.html')); } catch {}\n    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });\n    res.end('<!doctype html><html><head><meta charset="utf-8"><title>页面导航</title></head><body><h1>页面导航（开发用）</h1><ul>' + pages.map((f) => '<li><a href="pages/' + f + '">' + f + '</a></li>').join('') + '</ul></body></html>');\n    return;\n  }\n  const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^[\\\\/]+/, '');\n  if (rel.includes('..')) { res.writeHead(403); res.end(); return; }\n  try {\n    const buf = await readFile(pub(rel));\n    res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream' });\n    res.end(buf);\n  } catch { res.writeHead(404); res.end('not found'); }\n}).listen(PORT, '0.0.0.0', () => console.log('listening :' + PORT));\n`);
  // 首页=产品入口：加载即跳产品首页（P-HOME 优先，否则页面码序首）；页面集空=骨架就绪占位。
  // 产品页就绪后首页会被页面任务/壳任务覆盖为真首页——本骨架只是「打开即产品」的最低保证。
  add('public/index.html', `<!doctype html><html><head><meta charset="utf-8"><title>应用</title></head><body><p id="hint">正在进入应用…</p><script>fetch('app-api/pages').then(r=>r.json()).then(d=>{var ps=d.pages||[];if(!ps.length){document.getElementById('hint').textContent='应用骨架就绪';return;}var home=ps.find(p=>p.code==='P-HOME')||ps[0];location.replace(home.href);});</script></body></html>\n`);
  add('tests/smoke.test.js', `const { test } = require('node:test');\nconst assert = require('node:assert');\nconst { existsSync, readFileSync } = require('node:fs');\ntest('scaffold intact', () => {\n  assert.ok(existsSync('server/index.js'));\n  assert.ok(JSON.parse(readFileSync('package.json', 'utf8')).scripts.start);\n});\n`);
  for (const d of task.deliverables ?? []) {
    const p = String(d);
    if (/\.(ts|js)$/.test(p)) add(p, `// ${task.code} ${task.title}\nexport {};\n`);
    else if (/\.html$/.test(p)) add(p, `<!doctype html><html><head><meta charset="utf-8"><title>${task.title}</title></head><body><h1>${task.title}</h1></body></html>\n`);
  }
  return files;
}

interface TaskRowFull {
  id: string; code: string; title: string; kind: string; goal: string | null; scope: string | null;
  boundary: string | null; work: unknown[]; inputs: unknown[]; deliverables: unknown[];
  acceptance: unknown[]; quality: Record<string, unknown>; write_scopes: string[];
  source_ids: string[]; code_rev: number; rev: number; run_status: string; col: string;
}

@Injectable()
export class DevCodegenService {
  constructor(
    @Inject(DevWorkspaceService) private readonly ws: DevWorkspaceService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
    @Optional() @Inject(StorageService) private readonly storage?: StorageService,
  ) {}

  onModuleInit(): void {
    // 写码收尾（异步执行器回报；全部 DB 写集中在此命令事务内）
    registerCommand('dev.task.run.complete', async (client, payload) => {
      const p = payload as {
        projectId: string; taskId: string; ok: boolean; files?: string[]; commit?: string | null;
        mode?: 'ai' | 'deterministic'; rounds?: number; error?: string;
        usage?: { inputTokens: number; outputTokens: number };
      };
      const t = await client.query<{ run_status: string; code: string; code_rev: number; rev: number }>(
        'SELECT run_status, code, code_rev, rev FROM dev_tasks WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [p.taskId, p.projectId]);
      if (!t.rows[0]) throw new DomainError('NOT_FOUND', '任务不存在', p.taskId);
      const row = t.rows[0];
      // 晚到收尾零写：人工 stop/返工已改运行态，执行结果落盘但事实不回写看板（委派同口径）
      if (!['running', 'manual'].includes(row.run_status)) {
        return { applied: false, stale: true, current: row.run_status };
      }
      await appendEvidence(client, {
        projectId: p.projectId, kind: 'codegen',
        payload: {
          taskId: p.taskId, taskCode: row.code, codeRev: row.code_rev, taskRev: row.rev,
          ok: p.ok, mode: p.mode ?? 'ai', rounds: p.rounds ?? 1,
          files: p.files ?? [], commit: p.commit ?? null,
          ...(p.error ? { error: p.error } : {}), ...(p.usage ? { usage: p.usage } : {}),
          at: new Date().toISOString(),
        },
      });
      if (p.ok) {
        await client.query("UPDATE dev_tasks SET prog=100, updated_at=now() WHERE id=$1", [p.taskId]);
      } else {
        await client.query(
          "UPDATE dev_tasks SET prog=0, run_status='stopped', blocked=true, blocked_reason=$3, updated_at=now() WHERE id=$1 AND project_id=$2",
          [p.taskId, p.projectId, `AI 写码失败：${(p.error ?? '未知').slice(0, 180)}`]);
      }
      return { applied: true, ok: p.ok, prog: p.ok ? 100 : 0 };
    });
  }

  /** real 模式入口（board.run 转入）：状态校验+起步标记走 dev.task.run 命令，执行异步 */
  async run(projectId: string, taskId: string, ctx: CommandContext): Promise<unknown> {
    const r = await executeCommand('dev.task.run', { projectId, taskId, mode: 'real' }, { ...ctx, projectId });
    void this.execute(projectId, taskId, { ...ctx, projectId }).catch(() => undefined); // 失败在 execute 内已回报
    return r;
  }

  /** 异步执行主体（事务外：AI 调用/fs/git 副作用；结果经 dev.task.run.complete 命令落库） */
  private async execute(projectId: string, taskId: string, ctx: CommandContext): Promise<void> {
    const done = (p: Record<string, unknown>) =>
      executeCommand('dev.task.run.complete', { projectId, taskId, ...p }, { projectId, actorKind: 'system', actorId: 'codegen' });
    try {
      const { dir } = await this.ws.ensure(projectId, ctx);
      const tr = await query<TaskRowFull>('SELECT * FROM dev_tasks WHERE id=$1 AND project_id=$2', [taskId, projectId]);
      const task = tr.rows[0];
      if (!task) throw new DomainError('NOT_FOUND', '任务不存在', taskId);
      const existing = new Set(await this.ws.listFiles(projectId));

      // 返工反馈回路（2026-10-19 116 实机四抓）：本任务最近一次沙箱测试红——把失败日志尾注入 prompt，
      // 模型带着真实失败上下文修；否则二轮盲写（无反馈重犯同错，如 tests/ 目录参坑）
      let lastFail = '';
      const ue = await query<{ payload: { pass?: boolean; logsTail?: string } }>(
        `SELECT payload FROM evd_records WHERE project_id=$1 AND kind='unit'
         AND payload->>'taskId'=$2 ORDER BY created_at DESC LIMIT 1`, [projectId, taskId]);
      if (ue.rows[0] && ue.rows[0].payload.pass === false) {
        lastFail = `\n【上轮沙箱测试失败（npm test 真实执行红）——必须先修复再交稿】\n${(ue.rows[0].payload.logsTail ?? '').slice(-1500)}\n【纪律】既有测试文件即验收规格：代码服从测试，禁止改写/删除 tests/ 下既有测试来凑绿；导出形态与既有测试断言逐条对齐后再交稿。`;
      }
      // 评审意见反馈回路（2026-10-22 run_262 T-021：原型保真评审红后 redevelop 盲写——
      // 差异61 观察项落地）：最近一次 AI 评审 fail 的结论注记注入 prompt，逐条改到位再交稿
      const rv = await query<{ payload: { conclusion?: string; note?: string } }>(
        `SELECT payload FROM evd_records WHERE project_id=$1 AND kind='ai-review'
         AND payload->>'taskId'=$2 ORDER BY created_at DESC LIMIT 1`, [projectId, taskId]);
      if (rv.rows[0] && rv.rows[0].payload.conclusion === 'fail' && rv.rows[0].payload.note) {
        lastFail += `\n【上轮 AI 评审不通过——逐条改到位再交稿】\n${rv.rows[0].payload.note.slice(0, 1200)}\n【纪律】评审意见即返工规格：保真偏差（配色/尺寸/布局/交互与定稿原型不一致）逐项对照原型修正，不得只改其一或自创替代方案。`;
      }

      let files: CodegenFile[] = [];
      let mode: 'ai' | 'deterministic' = 'deterministic';
      let rounds = 0;
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      // 目录载荷/原型页/接口契约无论 AI 是否可用都先装配（deterministic 兜底也要原型静态副本）
      const built = await this.buildPrompt(projectId, task, [...existing]);
      const protoPages = built.protoPages;

      if (this.ai?.kind === 'pi') {
        const prompt = built.text + lastFail;
        let feedback = '';
        for (let round = 1; round <= 2; round++) {
          rounds = round;
          // 用途走闭集内 'generation'（routes 枚举 planning|generation|review|translation|chat|parsing|reflection，
          // 'codegen' 不在闭集内配不了路由——116 实机首跑抓到）；代码生成=文档生成的同池大模型
          const session = await this.ai.createSession({ projectId, purpose: 'generation' });
          const { deltas, result } = session.stream(round === 1 ? prompt : `${prompt}\n\n【上轮问题】${feedback}\n请严格按输出契约重新输出。`);
          let text = '';
          for await (const d of deltas) text += d;
          const r = await result.catch(() => null);
          if (r?.usage) {
            usage = { inputTokens: (usage?.inputTokens ?? 0) + r.usage.inputTokens, outputTokens: (usage?.outputTokens ?? 0) + r.usage.outputTokens };
          }
          const parsed = parseFileBlocks(text);
          if (parsed.length > 0) { files = parsed; mode = 'ai'; break; }
          feedback = '未解析到任何 ```file path="..." 文件块（0 个文件）。';
        }
      }
      if (files.length === 0) {
        files = scaffoldFiles(task, existing);
        // 页面任务兜底升级（2026-10-20 预览≠原型根修）：有定稿原型 HTML 时落原型静态副本
        // （替换空头骨架页；HTML 注释如实标注未接线，mode 仍如实记 deterministic）
        for (const pp of protoPages) {
          const p = `public/pages/${pp.code}.html`;
          if (existing.has(p)) continue;
          files = files.filter((f) => f.path !== p);
          files.push({ path: p, content: `<!-- msf:prototype-copy 原型静态副本（AI 未接线，数据为原型内置模拟） -->\n${pp.html}` });
        }
      }

      // 落盘（AI 产物覆盖写——模型对公共文件负合并责任；脚手架只补缺）
      const written: string[] = [];
      for (const f of files) {
        await this.ws.writeFile(projectId, f.path, f.content);
        written.push(f.path);
      }
      const commit = await this.ws.commitAll(dir, `feat(${task.code}): ${task.title}`);
      await done({ ok: true, files: written, commit, mode, rounds, ...(usage ? { usage } : {}) });
    } catch (e) {
      const msg = sanitizeAiError(e instanceof Error ? e.message : String(e));
      await done({ ok: false, error: msg }).catch(() => undefined);
    }
  }

  /** prompt 装配：任务规格 + 目录条目载荷 + 页级原型参考 HTML + 接口册契约摘录 + 工作区现状。
   *  同时回吐本任务关联的定稿原型页（protoPages）供 deterministic 兜底落静态副本。 */
  private async buildPrompt(projectId: string, task: TaskRowFull, existingFiles: string[]): Promise<{ text: string; protoPages: Array<{ code: string; html: string }> }> {
    const protoPages: Array<{ code: string; html: string }> = [];
    const parts: string[] = [
      `你在为产品工作台中的一个项目开发真实代码。工作区是一个持续演进的应用仓库（git），多个任务会先后向其中提交代码；你只负责本任务，与既有代码共存，不要删除无关文件。`,
      APP_CONVENTIONS,
      `\n【本任务】${task.code}（${task.kind}）${task.title}`,
      `目标：${task.goal ?? '—'}`,
      `范围：${task.scope ?? '—'}；边界：${task.boundary ?? '—'}`,
      `工作项：${(task.work ?? []).map(String).join('；') || '—'}`,
      `交付物：${(task.deliverables ?? []).map(String).join('；') || '—'}`,
      `验收条件：${(task.acceptance ?? []).map((a) => String(typeof a === 'object' && a !== null ? (a as Record<string, unknown>).item ?? JSON.stringify(a) : a)).join('；') || '—'}`,
    ];
    // 目录条目载荷（页面/流程的定义细节）
    if (task.source_ids.length > 0) {
      const cat = await query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_catalog_items WHERE project_id=$1 ORDER BY substring(catalog_version from 4)::int DESC LIMIT 1', [projectId]);
      const cv = cat.rows[0]?.catalog_version;
      if (cv) {
        const items = await query<{ code: string; item_type: string; payload: Record<string, unknown> }>(
          'SELECT code, item_type, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 AND code = ANY($3)',
          [projectId, cv, task.source_ids]);
        for (const it of items.rows) {
          parts.push(`\n【目录条目 ${it.code}（${it.item_type}）】\n${JSON.stringify(it.payload).slice(0, 6000)}`);
        }
        // 页级原型参考 HTML（frontend 任务：交付物即该原型页的接线版）
        if (task.kind === 'frontend' && this.storage) {
          const pages = await query<{ page_code: string; object_key: string }>(
            'SELECT page_code, object_key FROM dsg_prototype_pages WHERE project_id=$1 AND catalog_version=$2 AND page_code = ANY($3)',
            [projectId, cv, task.source_ids]);
          for (const p of pages.rows) {
            const html = await this.storage.getObject(p.object_key).catch(() => null);
            if (html) {
              const text = html.toString('utf8');
              protoPages.push({ code: p.page_code, html: text });
              parts.push(`\n【页面 ${p.page_code} 的已定稿原型 HTML——本任务交付物 public/pages/${p.page_code}.html 就是它的接线版，必须严格按原型实现：配色、布局、区块结构、文案与原型 1:1 保留（含 <style> 与主题变量），原型上每个按钮/表单/列表/筛选器/页签/交互都必须可用且行为一致；只把内置模拟数据与假交互改造为 fetch('app-api/...') 真实驱动；契约确无对应端点的部分保留模拟数据并以 HTML 注释标 TODO，且必须在任务说明输出中逐条列出缺口清单（页面审查与测试阶段按此清单核对）；不得自创版式、不得增减区块、不得省略交互】\n【接线手法（2026-10-22 run_262 T-021 三轮保真红根修）】以原型 HTML 为基底原样保留、逐字节不动外观：配色 hex/尺寸 px/布局结构/区块顺序一处不改，只做最小手术式接线（数据绑定换 fetch、按钮接真实事件）。禁止全文重写、禁止重新设计样式——评审逐块 diff 原型，任何样式漂移（背景色/宽度/排布）直接判红。输出时先完整复述原型，再在其上做手术修改。\n${text.slice(0, MAX_PROMPT_HTML)}`);
            }
          }
        }
      }
    }
    // 接口契约摘录（frontend 接线与 backend 实现的共享真源；api 册草稿优先同 doc.read 口径）
    if (task.kind === 'frontend' || task.kind === 'backend') {
      const apiDoc = await query<{ content: string | null }>(
        `SELECT COALESCE(t.content, v.content) AS content
         FROM dsg_documents d
         LEFT JOIN dsg_drafts t ON t.document_id=d.id
         LEFT JOIN dsg_versions v ON v.id=d.current_version_id
         WHERE d.project_id=$1 AND d.doc_kind='api'`, [projectId]);
      const apiText = apiDoc.rows[0]?.content?.trim();
      if (apiText) {
        parts.push(`\n【接口册契约摘录（app-api 端点以此为准；前端按此接线、后端按此实现，路径在应用内以相对路径 app-api/... 暴露）】\n${apiText.slice(0, 8000)}`);
      }
    }
    parts.push(`\n【工作区已有文件】\n${existingFiles.slice(0, 200).join('\n') || '（空仓库）'}`);
    parts.push(`\n请现在按输出契约给出本任务要新增/修改的文件。package.json 已存在时不要重复输出，除非必须修改（修改则输出完整内容）。`);
    return { text: parts.join('\n'), protoPages };
  }
}
