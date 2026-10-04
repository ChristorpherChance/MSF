# AI 会话跨阶段互通 + 对话改文档 + 需求章节编号 · 实施计划（2026-10-03）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按三审通过的 spec（`doc/dev-plan/AI会话互通与对话改文档-设计.md`）落地三需求：①各阶段 AI 会话读侧互通（摘要注入 + chat.history.read 深读工具）；②dock 对话改 CRD/PRD（req.doc.propose_edits 旁路工具 → req_pendings 高亮审阅链，normalizePatches 顺带修复既有增量修订「改=重复追加」缺陷）；③需求文档大章+子节派生编号（生成约定 + deriveNumbering 渲染层派生，存储零改动）。

**Architecture:** 纯函数下沉（digest 归 platform、normalizePatches 归 doc-sections、deriveNumbering 归 packages/shared 前后端共用）；嵌套 LLM 工具经 platform 层外部工具注册表（registerExternalTool，镜像 registerCommand 模块级 Map 先例，零模块图边）绕过 ai.tool.invoke 命令事务；补丁落库复用 doc.propose-pending 既有审阅链；编号只在渲染/导出层注入。

**Tech Stack:** NestJS + pg 直驱（apps/server）、React18+zustand（apps/web）、packages/shared（tsc build → dist 消费）、vitest（server 单测与源码同目录 `*.test.ts`、集成 `*.integration.test.ts` 需 DB；shared 自带 vitest）。

**工作纪律（每个任务都适用）：**
- pnpm monorepo；tsc 必须在 `apps/server` 或 `apps/web` 目录内跑（`npx tsc --noEmit`）；`pnpm lint`、`pnpm check:deps`、`node doc/product-design/tools/check-codes.mjs` 仓根跑
- **错误码闭集不加码**：工具失败一律 ok:false/人话结果，不新增 DomainError 码；改完跑 check-codes
- 新命令先注册 command-bus；审计失败零写；跨域 SQL 直读不写；console 只允许 warn/error
- 集成测试需本地 postgres 就绪（未就绪自动 it.skip，不算失败）；server 单测命令形如 `cd apps/server && npx vitest run src/modules/platform/doc-sections.test.ts`
- **长连接 SSE 生成期间绝不跑测试/不改 server 代码**；改 packages/shared 后须 `pnpm --filter @msf/shared build` 才会被 web/server 的 dist 消费到
- commit 末尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`；临时 .mjs 脚本用完即删
- 本计划全部新端点/新工具/prompt 段/归一化修复属 13 册冻结基线差异 → 收口任务统一登记 `doc/dev-plan/AI会话互通与对话改文档-差异登记.md`

---

### Task 1: buildCrossSessionDigest 纯函数（platform 层）

**Files:**
- Create: `apps/server/src/modules/platform/cross-session-digest.ts`
- Test: `apps/server/src/modules/platform/cross-session-digest.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
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
    const out = buildCrossSessionDigest([row('legacy', 'ss_7', ['原型要换肤']), row('req', 'ss_8', [])]);
    expect(out).toContain('[legacy] ss_7');
    expect(out).not.toContain('ss_8');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/platform/cross-session-digest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 跨阶段会话摘要（AI 会话读侧互通）：本项目其它会话的最近用户消息 → prompt 注入块。
 * 纯函数便于单测；SQL 取数与降级策略在 ai/sessions.service.ts buildPrompt。
 */

export interface CrossSessionDigestRow {
  /** ai_sessions.ctx（material/req/design/proto/dev/test） */
  ctx: string;
  /** 会话编号 ss_n */
  code: string;
  /** 已格式化时间（SQL to_char 'YYYY-MM-DD HH24:MI'） */
  at: string;
  /** 该会话最近用户消息摘录（调用方已按时间正序、单条截 200 字） */
  excerpts: string[];
}

const CTX_LABEL: Record<string, string> = {
  material: '资料', req: '需求', design: '设计', proto: '原型', dev: '开发', test: '测试',
};

const HEADER = '【他阶段会话（本项目其它阶段会话的最近用户表态，供理解客户意图；需要细节可用 chat.history.read 深读）】';

/**
 * rows 按 updated_at DESC 传入（首=最新）；整块字符预算 budget，超出从最旧（尾部）会话开始丢弃。
 * 无任何会话装得下 → 返回 ''（调用方省略整块）。
 */
export function buildCrossSessionDigest(rows: CrossSessionDigestRow[], budget = 3000): string {
  const kept = [...rows];
  const render = (): string => {
    const blocks = kept
      .filter((r) => r.excerpts.length > 0)
      .map((r) => {
        const head = `[${CTX_LABEL[r.ctx] ?? r.ctx}] ${r.code}（${r.at}）`;
        return [head, ...r.excerpts.map((x) => `- ${x}`)].join('\n');
      });
    if (blocks.length === 0) return '';
    return `${HEADER}\n${blocks.join('\n')}`;
  };
  let out = render();
  while (out.length > budget && kept.length > 0) {
    kept.pop();
    out = render();
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/platform/cross-session-digest.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/platform/cross-session-digest.ts apps/server/src/modules/platform/cross-session-digest.test.ts
git commit -m "feat(ai): 跨阶段会话摘要纯函数 buildCrossSessionDigest（预算截断+阶段标签）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: buildPrompt 注入【他阶段会话】块

**Files:**
- Modify: `apps/server/src/modules/ai/sessions.service.ts`（buildPrompt :414-486，注入点=【会话历史】之前）
- Test: `apps/server/src/modules/ai/sessions.integration.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（追加到 sessions.integration.test.ts describe 内，既有 W2-053 用例之后）

```ts
  it('跨阶段互通：buildPrompt 注入【他阶段会话】块（其它会话最近用户消息；本会话不进块）', async () => {
    // sessionId（req ctx）已在先前用例创建并有用户消息；另建 material 会话发一条
    const m = await sessions.create(PID, { ctx: 'material', name: '资料沟通' }, CTX) as { id: string };
    await sessions.send(PID, m.id, { content: '客户明确要求双人同屏协作' }, CTX);
    await new Promise((r) => setTimeout(r, 1200)); // fake 流终结
    const prompt = await (sessions as unknown as {
      buildPrompt: (p: string, s: string, c: string, r: string[]) => Promise<string>;
    }).buildPrompt(PID, m.id, '本次问题', []);
    expect(prompt).toContain('【他阶段会话');
    expect(prompt).toContain('[需求] ss_1');
    // 摘要注入在会话历史之前
    expect(prompt.indexOf('【他阶段会话')).toBeLessThan(prompt.indexOf('【会话历史】'));
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/ai/sessions.integration.test.ts`
Expected: FAIL（prompt 不含【他阶段会话】）

- [ ] **Step 3: 实现**（sessions.service.ts）

import 区加：

```ts
import { buildCrossSessionDigest } from '../platform/cross-session-digest.js';
```

buildPrompt 中，`const history = await query<...>`（:471）之前插入：

```ts
    // 跨阶段互通（读侧）：本项目其它会话最近用户消息摘要（整块预算 3000，超出从最旧丢弃；
    // 会话列表/草稿仍按阶段隔离，互通仅发生在 AI 读侧；SQL 失败静默降级不阻断聊天主链）
    try {
      const cross = await query<{ ctx: string; code: string; at: string; excerpts: string[] | null }>(
        `SELECT s.ctx, s.code, to_char(s.updated_at, 'YYYY-MM-DD HH24:MI') AS at,
                (SELECT array_agg(m.content) FROM (
                   SELECT content FROM ai_messages
                   WHERE session_id=s.id AND role='user' AND status='done'
                   ORDER BY created_at DESC LIMIT 2) m) AS excerpts
         FROM ai_sessions s
         WHERE s.project_id=$1 AND s.id<>$2
         ORDER BY s.updated_at DESC LIMIT 10`,
        [projectId, sessionId]);
      const digest = buildCrossSessionDigest(cross.rows.map((r) => ({
        ctx: r.ctx, code: r.code, at: r.at,
        excerpts: (r.excerpts ?? []).reverse().map((x) => (x.length > 200 ? `${x.slice(0, 200)}…` : x)),
      })));
      if (digest) parts.push(digest);
    } catch { /* 摘要注入失败静默降级（该块省略） */ }
```

同步把 buildPrompt 的 jsdoc（:413）尾部追加「+ 他阶段会话摘要（跨阶段互通读侧）」。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd apps/server && npx vitest run src/modules/ai/sessions.integration.test.ts && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/sessions.service.ts apps/server/src/modules/ai/sessions.integration.test.ts
git commit -m "feat(ai): buildPrompt 注入【他阶段会话】块——各阶段会话读侧互通（摘要 3000 预算+静默降级）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: chat.history.read 只读工具

**Files:**
- Modify: `apps/server/src/modules/ai/tools.service.ts`（TOOLS :46-144 追加）
- Test: `apps/server/src/modules/ai/tools-prompts-usage.integration.test.ts`

- [ ] **Step 1: 改失败测试**

tools-prompts-usage.integration.test.ts :56 的清单断言改为五件套：

```ts
    expect(list.tools.map((t) => t.name)).toEqual(['nav.goto', 'read_context', 'doc.read', 'chat.history.read', 'propose_next_step']);
```

追加用例（describe 内）：

```ts
  it('chat.history.read：按编号读他会话消息（项目守卫/limit 封顶/不存在人话）', async () => {
    // 造目标会话 + 两条 done 消息
    const target = (await query<{ id: string }>(
      `INSERT INTO ai_sessions (project_id, code, ctx, name, created_by)
       VALUES ($1,'ss_t9','material','资料深读','t') RETURNING id`, [PID])).rows[0]!.id;
    await query(
      `INSERT INTO ai_messages (session_id, role, content, status) VALUES
       ($1,'user','客户要双人同屏','done'), ($1,'ai','已记录','done')`, [target]);
    const r = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_t9' } }, CTX);
    expect(r.result['found']).toBe(true);
    const msgs = r.result['messages'] as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'ai']); // 时间正序
    expect(msgs[0]!.content).toBe('客户要双人同屏');
    // limit 封顶 50 不报错；不存在会话 → ok:false 人话（不抛码）
    const cap = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_t9', limit: 999 } }, CTX);
    expect(cap.result['found']).toBe(true);
    const none = await tools.invoke(PID, { sessionId, toolName: 'chat.history.read', args: { sessionCode: 'ss_nope' } }, CTX);
    expect(none.result['found']).toBe(false);
    expect(String(none.result['message'])).toContain('ss_nope');
    await query('DELETE FROM ai_messages WHERE session_id=$1', [target]);
    await query('DELETE FROM ai_sessions WHERE id=$1', [target]);
  });
```

注意既有 ok 计数断言（:67 `toBe(4)`）会因本用例新增 ok 调用而受影响——该断言在另一个 it 内、查询时点在本用例之前（文件顺序执行），不受影响；若执行顺序变化导致失败，把 4 改为按 toolName 过滤后计数。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/ai/tools-prompts-usage.integration.test.ts`
Expected: FAIL（清单断言 + chat.history.read TOOL_UNREGISTERED）

- [ ] **Step 3: 实现**（tools.service.ts TOOLS 数组，doc.read 之后插入）

```ts
  {
    name: 'chat.history.read',
    kind: 'read',
    // 跨阶段互通深读通道：摘要块只有最近 2 条用户消息，需要细节时模型按会话编号自主深读
    description: '读取本项目其它阶段会话的最近消息（跨阶段读侧互通）。args.sessionCode 为会话编号（如 ss_3，见【他阶段会话】块）；limit 默认 20 封顶 50。当需要了解客户在其它阶段聊过的细节时调用',
    argsSchema: { sessionCode: 'string', limit: 'number' },
    required: ['sessionCode'],
    async run(client, projectId, args) {
      const code = String(args['sessionCode']);
      const limit = Math.min(50, Math.max(1, Number(args['limit'] ?? 20) || 20));
      // 项目守卫：project_id+code 双条件，跨项目会话天然查不到（不落码，人话返回）
      const s = await client.query<{ id: string; name: string; ctx: string }>(
        'SELECT id, name, ctx FROM ai_sessions WHERE project_id=$1 AND code=$2', [projectId, code]);
      if (!s.rows[0]) return { found: false, message: `会话 ${code} 不存在（编号形如 ss_3，见【他阶段会话】块）` };
      const msgs = await client.query<{ role: string; content: string }>(
        `SELECT role, content FROM ai_messages
         WHERE session_id=$1 AND status='done' AND role IN ('user','ai')
         ORDER BY created_at DESC, id DESC LIMIT $2`, [s.rows[0].id, limit]);
      return {
        found: true, sessionCode: code, name: s.rows[0].name, ctx: s.rows[0].ctx,
        messages: msgs.rows.reverse().map((m) => ({
          role: m.role,
          content: m.content.length > 1500 ? `${m.content.slice(0, 1500)}…` : m.content,
        })),
      };
    },
  },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/ai/tools-prompts-usage.integration.test.ts && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/tools.service.ts apps/server/src/modules/ai/tools-prompts-usage.integration.test.ts
git commit -m "feat(ai): 新只读工具 chat.history.read——按会话编号深读他阶段会话（项目守卫/limit 封顶 50）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: normalizePatches 归一化纯函数

**Files:**
- Modify: `apps/server/src/modules/platform/doc-sections.ts`（文件尾追加）
- Test: `apps/server/src/modules/platform/doc-sections.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
/** normalizePatches 单测：mdToPatches 恒产 add 的归一化（锚点码命中/标题命中转 modify，未命中保持 add） */
import { describe, expect, it } from 'vitest';
import { mdToPatches, normalizePatches, splitSections } from './doc-sections.js';

const DOC = [
  '## 一、背景与目标',
  '',
  '项目背景若干。',
  '',
  '## CR-001 门户首页',
  '',
  '承接：R-001',
  '',
  '旧正文。',
  '',
  '## CR-002 检索',
  '',
  '承接：R-002',
].join('\n');

describe('normalizePatches', () => {
  it('锚点码命中（标题改写但 CR 码保留）→ 转 modify，old=既有节全文', () => {
    const patches = mdToPatches('## CR-001 门户首页（重写）\n\n承接：R-001\n\n新正文。');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('modify');
    expect(out[0]!.secId).toBe('s2'); // splitSections：空文首节先占 s0，filter 不重编号，故 CR-001=s2
    expect(out[0]!.old).toBe('承接：R-001\n\n旧正文。');
    expect(out[0]!.new).toContain('新正文。');
  });

  it('无锚点码节按标题精确匹配 → 转 modify', () => {
    const patches = mdToPatches('## 一、背景与目标\n\n新背景。');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out[0]!.type).toBe('modify');
    expect(out[0]!.secId).toBe('s1'); // 一、背景与目标=s1（s0 为空文首节占位，已过滤不重编号）
  });

  it('未命中保持 add；空正文节不转（modify 的 old⊆md 校验对空 old 必败，保 add 由人工处置）', () => {
    const patches = mdToPatches('## CR-009 全新条目\n\n承接：R-009');
    const out = normalizePatches(patches, splitSections(DOC));
    expect(out[0]!.type).toBe('add');
    const emptyDoc = '## CR-001 空节\n\n## CR-002 有内容\n\nx';
    const p2 = mdToPatches('## CR-001 空节\n\n补内容');
    const out2 = normalizePatches(p2, splitSections(emptyDoc));
    expect(out2[0]!.type).toBe('add'); // CR-001 节 md 为空 → 不转 modify
  });

  it('归一化后的 modify 可被 applyPatch 接受（old 取自 splitSections 节 md，includes 校验必过）', async () => {
    const { applyPatch, joinSections } = await import('./doc-sections.js');
    const secs = splitSections(DOC);
    const [p] = normalizePatches(mdToPatches('## CR-002 检索\n\n承接：R-002\n\n支持手柄。'), secs);
    const applied = applyPatch(secs, p!);
    expect(applied).not.toBeNull();
    expect(joinSections(applied!)).toContain('支持手柄。');
    expect(joinSections(applied!)).not.toContain('承接：R-002\n\n承接：R-002'); // 不重复追加
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/platform/doc-sections.test.ts`
Expected: FAIL（normalizePatches 未导出）

- [ ] **Step 3: 实现**（doc-sections.ts 文件尾追加）

```ts
/** 锚点码（CR-nnn/REQ-nnn）——标题首词提取，归一化优先匹配键 */
const ANCHOR_CODE_RE = /^(?:CR|REQ)-\d{3}\b/;

/**
 * AI 增量补丁归一化（修复「修改章节实为重复追加」缺陷）：
 * mdToPatches 恒产 add——标题命中既有节（锚点码优先、标题精确其次）即改写为整节 modify
 * （old=splitSections 产出的节 md，已 trim+\n{3,} 塌缩，不可从原文裸切，否则 accept 时 includes 失配）。
 * 未命中保持 add。已知限制：mdToPatches 标题截 80 字符而 splitSections 不截，
 * >80 字符的无锚点码节精确匹配落空退回 add（CR/REQ 节走锚点码不受影响）。
 */
export function normalizePatches(patches: EditPatch[], existing: DocSection[]): EditPatch[] {
  const byCode = new Map<string, DocSection>();
  const byTitle = new Map<string, DocSection>();
  for (const s of existing) {
    const code = ANCHOR_CODE_RE.exec(s.title)?.[0];
    if (code && !byCode.has(code)) byCode.set(code, s);
    if (s.title && !byTitle.has(s.title)) byTitle.set(s.title, s);
  }
  return patches.map((p) => {
    if (p.type !== 'add' || !p.title) return p;
    const code = ANCHOR_CODE_RE.exec(p.title)?.[0];
    const target = (code ? byCode.get(code) : undefined) ?? byTitle.get(p.title);
    // 空正文节不转：modify 的 old⊆md 校验对空 old 必败（PATCH_BASE_STALE 误伤），保 add 由人工处置
    if (!target || target.md.trim() === '') return p;
    return { type: 'modify', secId: target.id, title: target.title, old: target.md, new: p.new ?? '' };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/platform/doc-sections.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/platform/doc-sections.ts apps/server/src/modules/platform/doc-sections.test.ts
git commit -m "fix(req): normalizePatches 归一化——AI 修改章节由重复追加改为整节 modify（锚点码/标题双键匹配）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 既有增量修订流挂接 normalizePatches

**Files:**
- Modify: `apps/server/src/modules/req/generate.service.ts`（driveReal :305）
- Test: `apps/server/src/modules/req/propose-edits.integration.test.ts`（新建；本任务先建文件只放本用例，Task 8 续用同文件）

- [ ] **Step 1: 写失败测试**（新建 propose-edits.integration.test.ts）

```ts
/** 对话改文档 + 增量修订归一化（集成，需 DB）：GenerateService 旁路与既有流归一化双链断言 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool, query } from '../../db/pool.js';
import { resetCommands, type CommandContext } from '../evidence/command-bus.js';
import type { AiMessageResult, AiProvider, AiSession } from '../ai/ai-provider.interface.js';
import { PolicyService } from '../policy/policy.service.js';
import { ReqDocsService } from './docs.service.js';
import { GenerateService, genTiming } from './generate.service.js';

const PID = '00000000-0000-0000-0000-0000000000e1';
const CTX: CommandContext = { projectId: PID, actorKind: 'human', actorId: 'local' };

/** 假 pi provider：createSession 返回预置全文（kind='pi' 才走 driveReal） */
class FakePiProvider implements AiProvider {
  readonly kind = 'pi' as const;
  text = '';
  async createSession(): Promise<AiSession> {
    const text = this.text;
    return {
      sessionId: 'fake-pi',
      stream: () => ({
        deltas: (async function* () { yield text; })(),
        result: Promise.resolve({ text, usage: { inputTokens: 1, outputTokens: 1 } } satisfies AiMessageResult),
      }),
      steer: () => {},
      stop: () => {},
    };
  }
}

async function infraUp(): Promise<boolean> {
  try { await query('SELECT 1 FROM req_documents LIMIT 1'); return true; } catch { return false; }
}

describe('对话改文档/归一化（集成，需 DB）', async () => {
  if (!(await infraUp())) { it.skip('postgres 未就绪', () => {}); return; }
  genTiming.chunkDelayMs = 0;
  const docs = new ReqDocsService(new PolicyService());
  const gen = new GenerateService();
  const fakePi = new FakePiProvider();
  const genPi = new GenerateService(fakePi);
  resetCommands();
  docs.onModuleInit();
  gen.onModuleInit();

  beforeAll(async () => {
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pe-e1') ON CONFLICT (id) DO NOTHING", [PID]);
    await docs.listDocs(PID, CTX); // provisioning 模板 v1
  });
  afterAll(async () => {
    await query('DELETE FROM req_pendings WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_drafts WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('UPDATE req_documents SET current_version_id=NULL, final_version_id=NULL WHERE project_id=$1', [PID]);
    await query('DELETE FROM req_versions WHERE document_id IN (SELECT id FROM req_documents WHERE project_id=$1)', [PID]);
    await query('DELETE FROM req_documents WHERE project_id=$1', [PID]);
    await query('DELETE FROM rtm_links WHERE project_id=$1', [PID]);   // commit 触发 RTM 派生，不删撞外键
    await query('DELETE FROM rtm_health WHERE project_id=$1', [PID]);
    await query('DELETE FROM projects WHERE id=$1', [PID]);
    await pool.end();
  });

  interface DocView { cur: number; contentFingerprint: string; secs: Array<{ id: string; title: string; md: string }> }
  const view = async (kind: 'crd' | 'prd') => (await docs.getDoc(PID, kind)) as unknown as DocView;
  /** 写入两节 CR 内容并提交为新版本（清 modified，让指纹/补丁流可预期） */
  async function seedSections(): Promise<void> {
    const d = await view('crd');
    await docs.saveDraft(PID, 'crd', {
      secId: d.secs[0]!.id,
      md: '引言\n\n## CR-001 门户首页\n\n承接：R-001\n\n旧正文。\n\n## CR-002 检索\n\n承接：R-002',
      baseVersion: d.cur, baseFingerprint: d.contentFingerprint,
    }, CTX);
    const d2 = await view('crd');
    await docs.commit(PID, 'crd', 'seed', d2.cur, CTX);
  }

  it('既有增量修订流挂归一化：命中 CR-001 的 AI 产出转 modify，不再重复追加', async () => {
    await seedSections();
    fakePi.text = '## CR-001 门户首页\n\n承接：R-001\n\n新正文（支持手柄）。';
    const started = await genPi.start(PID, 'crd', { referenceFileIds: [], referenceFingerprints: {}, instruction: '把 CR-001 改为支持手柄' }, CTX);
    const r = await genPi.drive(started.operationId, CTX, () => {});
    expect(r.status).toBe('done');
    const patches = (await docs.listPatches(PID, 'crd')) as { items: Array<{ type: string; secId: string; status: string }> };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend).toHaveLength(1);
    expect(pend[0]!.type).toBe('modify'); // 归一化生效：非 add 重复追加
    await docs.rejectPatch(PID, 'crd', (patches.items.find((p) => p.status === 'pending') as { patchId: string }).patchId, CTX);
  });
});
```

注意：rejectPatch 需要 patchId——listPatches 返回项含 patchId，上面 DocView 类型不含，直接以 unknown 取。若类型报错，改为先取 `const items = patches.items as Array<{ patchId: string; type: string; secId: string; status: string }>` 再断言（实现时按编译错误微调，断言语义不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/req/propose-edits.integration.test.ts`
Expected: FAIL（pend[0].type 实为 'add'）

- [ ] **Step 3: 实现**（generate.service.ts）

import 行 :6 改为：

```ts
import { mdToPatches, normalizePatches, sha256Text, splitSections, type EditPatch } from '../platform/doc-sections.js';
```

driveReal :305 `const patches = mdToPatches(res.text);` 改为：

```ts
      // 归一化：命中既有节的 add 转整节 modify（修复「修改=重复追加」；增量修订与对话改文档共用）
      const patches = normalizePatches(mdToPatches(res.text), splitSections(real.currentContent));
```

- [ ] **Step 4: 跑测试确认通过 + req 域回归**

Run: `cd apps/server && npx vitest run src/modules/req/ && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/req/generate.service.ts apps/server/src/modules/req/propose-edits.integration.test.ts
git commit -m "fix(req): 增量修订流挂 normalizePatches——AI 修改既有章节不再重复追加

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 外部工具注册表（platform 层）

**Files:**
- Create: `apps/server/src/modules/platform/external-tools.ts`
- Test: `apps/server/src/modules/platform/external-tools.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
/** 外部工具注册表单测（镜像 registerCommand 口径：重复注册拒绝/查询/重置） */
import { describe, expect, it } from 'vitest';
import { getExternalTool, registerExternalTool, resetExternalTools } from './external-tools.js';

describe('外部工具注册表', () => {
  it('注册/查询/重置；重复注册拒绝', async () => {
    resetExternalTools();
    expect(getExternalTool('x.y')).toBeUndefined();
    registerExternalTool('x.y', async () => ({ ok: true }));
    expect(await getExternalTool('x.y')!('p', { args: {} }, { projectId: 'p', actorKind: 'human', actorId: 't' }))
      .toEqual({ ok: true });
    expect(() => registerExternalTool('x.y', async () => ({}))).toThrow('重复注册');
    resetExternalTools();
    expect(getExternalTool('x.y')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/platform/external-tools.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 外部工具注册表（模块级 Map，镜像 evidence/command-bus registerCommand 先例，零模块图边）：
 * 供含长耗时嵌套调用（如 LLM）的 dock 工具绕过 ai.tool.invoke 命令事务执行——
 * 事务/池连接内绝不跑 LLM。owner 模块（如 req）onModuleInit 注册 handler；
 * ai 编排层流末 runToolBlocks 先查本表，命中走旁路（handler 无事务 → 内部命令独立事务），
 * 未命中走 ai.tool.invoke 不变。旁路留痕=ai_tool_calls（recordDirect）+ 内部命令审计行（无 ai.tool.invoke 审计行）。
 */
import type { CommandContext } from '../evidence/command-bus.js';

export interface ExternalToolCall {
  sessionId?: string | undefined;
  messageId?: string | undefined;
  args: Record<string, unknown>;
}

export type ExternalToolHandler = (
  projectId: string,
  call: ExternalToolCall,
  ctx: CommandContext,
) => Promise<Record<string, unknown>>;

const handlers = new Map<string, ExternalToolHandler>();

/** 注册外部工具 handler（启动期；重复注册拒绝） */
export function registerExternalTool(name: string, handler: ExternalToolHandler): void {
  if (handlers.has(name)) throw new Error(`外部工具重复注册: ${name}`);
  handlers.set(name, handler);
}

export function getExternalTool(name: string): ExternalToolHandler | undefined {
  return handlers.get(name);
}

/** 测试用：清空注册表 */
export function resetExternalTools(): void {
  handlers.clear();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/platform/external-tools.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/platform/external-tools.ts apps/server/src/modules/platform/external-tools.test.ts
git commit -m "feat(ai): 外部工具注册表——嵌套 LLM 工具的事务旁路机制（镜像 registerCommand 零模块图边）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 7: tools.service 扩展（kind 'propose' 档 + req.doc.propose_edits 条目 + recordDirect）

**Files:**
- Modify: `apps/server/src/modules/ai/tools.service.ts`（ToolDef :15-23、TOOLS、record :195-207 后）
- Test: `apps/server/src/modules/ai/tools-prompts-usage.integration.test.ts`

- [ ] **Step 1: 改失败测试**

清单断言（Task 3 已改五件套）再加 'req.doc.propose_edits'：

```ts
    expect(list.tools.map((t) => t.name)).toEqual([
      'nav.goto', 'read_context', 'doc.read', 'chat.history.read', 'propose_next_step', 'req.doc.propose_edits',
    ]);
```

追加用例：

```ts
  it('req.doc.propose_edits：list 可见 kind=propose；误入 invoke 路径防御性失败留痕（旁路未接线）', async () => {
    const meta = tools.list().tools.find((t) => t.name === 'req.doc.propose_edits');
    expect(meta?.kind).toBe('propose');
    // 防御分支：正常路径经外部注册表旁路，invoke 直接命中=旁路未接线 → ok:false 人话（不落稿）
    const r = await tools.invoke(PID, { sessionId, toolName: 'req.doc.propose_edits', args: { kind: 'crd', instruction: 'x' } }, CTX);
    expect((r.result as { ok: boolean }).ok).toBe(false);
    expect(String((r.result as { reason: string }).reason)).toContain('旁路');
    // recordDirect 旁路留痕：pool 直插同 INSERT 口径
    await tools.recordDirect({ sessionId, toolName: 'req.doc.propose_edits', args: { kind: 'crd' } }, 'failed', { error: '探针' });
    const rows = await tools.callsOfSession(PID, sessionId);
    expect(rows.items.some((c) => c.tool_name === 'req.doc.propose_edits'
      && c.status === 'failed'
      && String((c.result_summary as { error?: string }).error).includes('探针'))).toBe(true);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/ai/tools-prompts-usage.integration.test.ts`
Expected: FAIL（list 无该工具 / recordDirect 不存在）

- [ ] **Step 3: 实现**（tools.service.ts 三处）

① ToolDef.kind（:17）扩展：

```ts
  kind: 'read' | 'nav' | 'propose';
```

② TOOLS 数组尾部（propose_next_step 之后）追加：

```ts
  {
    name: 'req.doc.propose_edits',
    kind: 'propose', // 提案型写：不直写文档，产物=待确认高亮补丁，必经人工确认（人工定稿不可自动化口径不破）
    description: '提交需求文档（CRD/PRD）修改建议：产出待确认高亮补丁，经用户在需求页逐条/批量确认后才生效（你不直接改文档）。当用户要求修改 CRD/PRD 内容时调用。args.instruction 描述要改什么（截 2000 字）',
    argsSchema: { kind: 'string', instruction: 'string' },
    required: ['kind', 'instruction'],
    async run() {
      // 防御性兜底：本工具含嵌套 LLM，正常路径经外部注册表旁路执行（绝不在命令事务内跑 LLM）；
      // 走到命令内=旁路未接线，拒绝执行并留痕（不落稿）
      return { ok: false, reason: 'propose 类工具须经会话流旁路执行（旁路未接线），本次未产生任何修改' };
    },
  },
```

③ record 方法（:195-207）之后加公共变体：

```ts
  /**
   * 旁路留痕（外部工具不走 ai.tool.invoke 命令事务，事务外无法复用 record 的 PoolClient）：
   * pool 直插同 INSERT 口径；失败重试一次，再失败仅日志（补丁本体已是待确认草稿，
   * 留痕缺失不阻断主链——与流末 error 帧口径一致）。
   */
  async recordDirect(
    p: { sessionId?: string; messageId?: string; toolName?: string; args?: Record<string, unknown> },
    status: 'ok' | 'denied' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> {
    if (!p.sessionId) return;
    const sql = 'INSERT INTO ai_tool_calls (session_id, message_id, tool_name, args, result_summary, status) VALUES ($1,$2,$3,$4,$5,$6)';
    const params = [p.sessionId, p.messageId ?? null, p.toolName, JSON.stringify(p.args ?? {}), JSON.stringify(result), status];
    try {
      await query(sql, params);
    } catch {
      try {
        await query(sql, params);
      } catch (e2) {
        console.error(`[ai] recordDirect 留痕失败 tool=${p.toolName ?? '?'}: ${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/server && npx vitest run src/modules/ai/tools-prompts-usage.integration.test.ts && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/tools.service.ts apps/server/src/modules/ai/tools-prompts-usage.integration.test.ts
git commit -m "feat(ai): 工具桥扩 propose 档——req.doc.propose_edits 注册+recordDirect 旁路留痕公共变体

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 8: proposeEditsFromChat + onModuleInit 注册旁路 handler

**Files:**
- Modify: `apps/server/src/modules/req/generate.service.ts`（新方法 + onModuleInit 注册 + mock 产出函数）
- Test: `apps/server/src/modules/req/propose-edits.integration.test.ts`（Task 5 所建，追加用例）

- [ ] **Step 1: 写失败测试**（propose-edits.integration.test.ts describe 内追加；用例顺序敏感，按下列顺序追加在 Task 5 用例之后）

```ts
  it('对话改文档守卫链：未生成 → 未清补丁 → 定稿锁 全走 ok:false 人话（不落码）', async () => {
    // 未生成：全新文档行（prd 当前只有模板 v1 也有内容——用不存在 doc 行的项目旁证太绕，
    // 直接对空内容场景走「文档还没有内容」语义已在 listDocs provisioning 后难造，改用未打开过文档的新项目）
    const PID2 = '00000000-0000-0000-0000-0000000000e2';
    await query("INSERT INTO projects (id, name) VALUES ($1, 'pe-e2') ON CONFLICT (id) DO NOTHING", [PID2]);
    const none = await gen.proposeEditsFromChat(PID2, 'crd', '改点什么', { ...CTX, projectId: PID2 });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain('还没有内容');
    // 正常提案（mock：命中既有节=modify + 全新节=add 两形态）
    const ok = await gen.proposeEditsFromChat(PID, 'crd', '把 CR-001 改为支持手柄，并补一条验收', CTX);
    expect(ok).toEqual({ ok: true, patchCount: 2, route: '/req' });
    const patches = (await docs.listPatches(PID, 'crd')) as {
      items: Array<{ patchId: string; type: string; status: string; source: string }>;
    };
    const pend = patches.items.filter((p) => p.status === 'pending');
    expect(pend.map((p) => p.type).sort()).toEqual(['add', 'modify']);
    expect(pend[0]!.source).toBe('ai'); // proposedBy='assistant' 同源
    // 未清补丁闸：第二批被拒（人话含数量）
    const busy = await gen.proposeEditsFromChat(PID, 'crd', '再来一条', CTX);
    expect(busy.ok).toBe(false);
    expect(busy.reason).toContain('待确认补丁');
    // 处置干净后定稿 → VERSION_LOCKED 人话
    for (const p of pend) await docs.rejectPatch(PID, 'crd', p.patchId, CTX, '守卫链验证');
    const d = await view('crd');
    await docs.finalize(PID, 'crd', d.cur, d.cur, true, CTX);
    const locked = await gen.proposeEditsFromChat(PID, 'crd', '定稿后改', CTX);
    expect(locked.ok).toBe(false);
    expect(locked.reason).toContain('已定稿');
    await docs.unlock(PID, 'crd', CTX);
    // 双链留痕：模拟编排层旁路——getExternalTool handler + recordDirect；audit_log 有 doc.propose-pending 行
    const { getExternalTool } = await import('../platform/external-tools.js');
    const { AiToolsService } = await import('../ai/tools.service.js');
    const tools = new AiToolsService();
    const sid = (await query<{ id: string }>(
      `INSERT INTO ai_sessions (project_id, code, ctx, name, created_by)
       VALUES ($1,'ss_pe','req','旁路留痕','t') RETURNING id`, [PID])).rows[0]!.id;
    const handler = getExternalTool('req.doc.propose_edits')!;
    const result = await handler(PID, { sessionId: sid, args: { kind: 'crd', instruction: '留痕探针' } }, CTX);
    await tools.recordDirect({ sessionId: sid, toolName: 'req.doc.propose_edits', args: { kind: 'crd' } },
      result['ok'] === false ? 'failed' : 'ok', result);
    const calls = await query<{ status: string }>(
      "SELECT status FROM ai_tool_calls WHERE session_id=$1 AND tool_name='req.doc.propose_edits'", [sid]);
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]!.status).toBe('ok');
    const audit = await query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_log WHERE project_id=$1 AND command='doc.propose-pending'", [PID]);
    expect(Number(audit.rows[0]!.n)).toBeGreaterThan(0);
    // 清理本用例补丁与探针会话
    const rest = (await docs.listPatches(PID, 'crd')) as { items: Array<{ patchId: string; status: string }> };
    for (const p of rest.items.filter((x) => x.status === 'pending')) await docs.rejectPatch(PID, 'crd', p.patchId, CTX, '清理');
    await query('DELETE FROM ai_tool_calls WHERE session_id=$1', [sid]);
    await query('DELETE FROM ai_sessions WHERE id=$1', [sid]);
    await query('DELETE FROM projects WHERE id=$1', [PID2]);
  });

  it('旁路 handler 参数校验：kind 枚举/instruction 必填（人话不落码）', async () => {
    const { getExternalTool } = await import('../platform/external-tools.js');
    const handler = getExternalTool('req.doc.propose_edits')!;
    expect((await handler(PID, { args: { kind: 'hld', instruction: 'x' } }, CTX))['ok']).toBe(false);
    expect((await handler(PID, { args: { kind: 'crd' } }, CTX))['ok']).toBe(false);
  });
```

注：守卫四分支中 PATCH_BASE_STALE 的落码侧已由 req.integration.test.ts 既有用例覆盖（:172-178 deadbeef 指纹 → PATCH_BASE_STALE）；对话通道内读稿与落库之间无外部可注入窗口，catch→人话映射为防御路径，由实机场景②兜底，此处不再构造竞态用例。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/req/propose-edits.integration.test.ts`
Expected: FAIL（proposeEditsFromChat 不存在 / 旁路未注册）

- [ ] **Step 3: 实现**（generate.service.ts）

① import 区：:7 的 ai-provider import 加类型；新增 external-tools import：

```ts
import { AI_PROVIDER, type AiProvider, type AiUsage } from '../ai/ai-provider.interface.js';
import { registerExternalTool } from '../platform/external-tools.js';
```

② onModuleInit（:61-79）内末尾追加注册：

```ts
    // 对话改文档旁路（嵌套 LLM 绝不在 ai.tool.invoke 命令事务内跑——注册进外部工具注册表，
    // ai 编排层流末命中走旁路：本 handler 无事务 → doc.propose-pending 独立事务）
    registerExternalTool('req.doc.propose_edits', async (projectId, call, ctx) => {
      const kind = String(call.args['kind'] ?? '');
      if (kind !== 'crd' && kind !== 'prd') return { ok: false, reason: 'kind 枚举 crd|prd' };
      const instruction = String(call.args['instruction'] ?? '').trim();
      if (!instruction) return { ok: false, reason: 'instruction 必填（描述要改什么）' };
      return this.proposeEditsFromChat(projectId, kind, instruction, ctx);
    });
```

③ 类内（drive 方法之后）追加主方法：

```ts
  /**
   * 对话改文档（dock req.doc.propose_edits 旁路 handler）：
   * 读当前有效稿 → 复用增量修订 prompt 走 AI_PROVIDER 非 SSE 内部调用（mock 回落确定性两形态产出）
   * → mdToPatches → normalizePatches → doc.propose-pending 落库（独立事务，proposedBy='assistant'）。
   * 守卫失败/AI 零产出一律 { ok:false, reason 人话 }（不落码；ai_tool_calls 留痕由编排层 recordDirect 负责）。
   */
  async proposeEditsFromChat(
    projectId: string,
    kind: 'crd' | 'prd',
    instruction: string,
    ctx: CommandContext,
  ): Promise<{ ok: boolean; patchCount?: number; route?: string; reason?: string }> {
    const doc = await query<{ id: string; final_version_id: string | null; current_version_id: string | null }>(
      'SELECT id, final_version_id, current_version_id FROM req_documents WHERE project_id=$1 AND doc_kind=$2',
      [projectId, kind]);
    const d = doc.rows[0];
    if (!d || !d.current_version_id) {
      return { ok: false, reason: '文档还没有内容，请先在需求页生成初稿后再提修改' };
    }
    if (d.final_version_id && d.final_version_id === d.current_version_id) {
      return { ok: false, reason: '文档已定稿，请先在需求页 ⋯ 菜单解锁后再修改' };
    }
    const pend = await query<{ n: string }>(
      `SELECT count(*) AS n FROM req_pendings p JOIN req_documents d2 ON d2.id=p.document_id
       WHERE d2.project_id=$1 AND d2.doc_kind=$2 AND p.status='pending'`, [projectId, kind]);
    const pendN = Number(pend.rows[0]?.n ?? 0);
    if (pendN > 0) {
      return { ok: false, reason: `有 ${pendN} 条待确认补丁，请先在需求页处置后再提新修改` };
    }
    const cur = await query<{ content: string }>(
      `SELECT v.content FROM req_versions v JOIN req_documents d2 ON d2.current_version_id=v.id
       WHERE d2.project_id=$1 AND d2.doc_kind=$2`, [projectId, kind]);
    const draft = await query<{ content: string }>(
      `SELECT t.content FROM req_drafts t JOIN req_documents d2 ON d2.id=t.document_id
       WHERE d2.project_id=$1 AND d2.doc_kind=$2`, [projectId, kind]);
    const effective = draft.rows[0]?.content ?? cur.rows[0]?.content ?? '';
    if (!effective.trim()) {
      return { ok: false, reason: '文档还没有内容，请先在需求页生成初稿后再提修改' };
    }
    const cut = instruction.slice(0, 2000);
    const t0 = Date.now();
    let text: string;
    let modelId: string | undefined;
    let usage: AiUsage | undefined;
    if (this.ai?.kind === 'pi') {
      try {
        const session = await this.ai.createSession({ projectId, purpose: 'generation' });
        const existingCodes = [...new Set(effective.match(kind === 'crd' ? /\bCR-\d{3}\b/g : /\bREQ-\d{3}\b/g) ?? [])].sort();
        const { deltas, result } = session.stream(buildPrompt(kind, cut, [], existingCodes, effective, ''));
        for await (const d2 of deltas) void d2; // 非 SSE 内部调用：delta 排干不转发
        const res = await result;
        text = res.text;
        modelId = res.modelId;
        usage = res.usage;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        console.error(`[req] propose_edits AI 调用失败: ${raw}`);
        return { ok: false, reason: `AI 调用失败：${sanitizeAiError(raw)}` };
      }
    } else {
      text = buildMockChatEdit(kind, effective, cut);
    }
    const patches = normalizePatches(mdToPatches(text), splitSections(effective));
    if (patches.length === 0) {
      return { ok: false, reason: '未产出有效修改，可换种说法重试' };
    }
    // 用量与生成流同口径（purpose='generation'），先于落补丁（失败即整单失败，不留半截补丁）
    if (modelId && usage) {
      await executeCommand('ai.usage.record', {
        projectId, modelId, purpose: 'generation',
        tokensIn: usage.inputTokens, tokensOut: usage.outputTokens,
        durationMs: Date.now() - t0, cost: usage.cost ?? 0,
      }, { projectId, actorKind: 'assistant', actorId: 'pi' });
    }
    try {
      const r = (await executeCommand('doc.propose-pending', {
        projectId, kind, patches, targetFingerprint: sha256Text(effective), proposedBy: 'assistant',
      }, { ...ctx, projectId })) as { patchIds: string[] };
      return { ok: true, patchCount: r.patchIds.length, route: '/req' };
    } catch (e) {
      if (e instanceof DomainError && e.code === 'PATCH_BASE_STALE') {
        return { ok: false, reason: '文档已被其它操作变更，请刷新后重试' };
      }
      throw e;
    }
  }
```

④ 文件尾（buildMock 之后）追加 mock 产出函数：

```ts
/** mock 对话修订产出（确定性两形态：命中既有节标题→normalize 转 modify + 全新节→add，离线可测两分支） */
function buildMockChatEdit(kind: 'crd' | 'prd', effective: string, instruction: string): string {
  const re = kind === 'crd' ? /\bCR-\d{3}\b/ : /\bREQ-\d{3}\b/;
  const hit = splitSections(effective).find((s) => re.test(s.title));
  const codes = [...effective.matchAll(kind === 'crd' ? /\bCR-(\d{3})\b/g : /\bREQ-(\d{3})\b/g)]
    .map((m) => Number(m[1]));
  const next = `${kind === 'crd' ? 'CR' : 'REQ'}-${String((codes.length > 0 ? Math.max(...codes) : 0) + 1).padStart(3, '0')}`;
  const note = instruction || '按对话要求调整';
  const parts: string[] = [];
  if (hit) parts.push(`## ${hit.title}\n\n${hit.md}\n\n（mock 对话修订：${note}）`);
  parts.push(`## ${next} 对话补充条目\n\n承接：见对话上下文\n\n（mock 对话新增：${note}）`);
  return parts.join('\n\n');
}
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `cd apps/server && npx vitest run src/modules/req/ && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/req/generate.service.ts apps/server/src/modules/req/propose-edits.integration.test.ts
git commit -m "feat(req): 对话改文档 proposeEditsFromChat——守卫链/嵌套 LLM 旁路/归一化/双链留痕（mock 两形态可测）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: runToolBlocks 旁路分支

**Files:**
- Modify: `apps/server/src/modules/ai/sessions.service.ts`（runToolBlocks :388-411）
- Test: `apps/server/src/modules/ai/sessions.integration.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（sessions.integration.test.ts，W2-053 用例后追加）

```ts
  it('外部工具旁路：命中注册表走 handler（无事务）+ recordDirect 成功/失败两路留痕；未命中走 invoke 不变', async () => {
    const { registerExternalTool, resetExternalTools } = await import('../platform/external-tools.js');
    resetExternalTools();
    let called = 0;
    registerExternalTool('test.echo', async (_p, call) => { called += 1; return { ok: true, echo: call.args['x'] }; });
    registerExternalTool('test.boom', async () => { throw new Error('boom'); });
    provider.nextChunks = [
      '```msf-tool\n{"name":"test.echo","args":{"x":1}}\n```',
      '```msf-tool\n{"name":"test.boom","args":{}}\n```',
      '```msf-tool\n{"name":"nav.goto","args":{"tab":"req"}}\n```',
    ];
    const { messageId } = await sessions.send(PID, sessionId, { content: '触发旁路' }, CTX);
    const c = await sessions.drive(messageId, () => {}, { ctx: CTX });
    expect(c.status).toBe('done');
    expect(called).toBe(1);
    const msgs = await sessions.messages(PID, sessionId);
    const aiMsg = msgs.items.find((m) => m.id === messageId)! as unknown as {
      toolCalls: Array<{ toolName: string; status: string; resultSummary: unknown }>;
    };
    const echo = aiMsg.toolCalls.find((t) => t.toolName === 'test.echo');
    const boom = aiMsg.toolCalls.find((t) => t.toolName === 'test.boom');
    const nav = aiMsg.toolCalls.find((t) => t.toolName === 'nav.goto');
    expect(echo?.status).toBe('ok');
    expect((echo?.resultSummary as { echo: number }).echo).toBe(1);
    expect(boom?.status).toBe('failed');
    expect(String((boom?.resultSummary as { error: string }).error)).toContain('boom');
    expect(nav?.status).toBe('ok'); // 未命中注册表走 invoke 不变
    resetExternalTools();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/ai/sessions.integration.test.ts`
Expected: FAIL（test.echo 走 invoke → TOOL_UNREGISTERED 且无 handler 调用）

- [ ] **Step 3: 实现**（sessions.service.ts）

import 区加：

```ts
import { getExternalTool } from '../platform/external-tools.js';
```

runToolBlocks 的 for 循环体（:400-408）改为：

```ts
    for (const raw of blocks) {
      try {
        const call = JSON.parse(raw) as { name?: string; args?: Record<string, unknown> };
        if (!call.name) continue;
        // 外部工具旁路：含嵌套 LLM 的工具绝不在 ai.tool.invoke 命令事务内跑——
        // handler 无事务执行（内部命令独立事务），recordDirect 补落 ai_tool_calls（成功/失败两路留痕）
        const external = getExternalTool(call.name);
        if (external) {
          const p = { sessionId, messageId, toolName: call.name, args: call.args ?? {} };
          try {
            const result = await external(projectId, { sessionId, messageId, args: call.args ?? {} }, ctx);
            await this.tools.recordDirect(p, result['ok'] === false ? 'failed' : 'ok', result);
          } catch (e) {
            await this.tools.recordDirect(p, 'failed', { error: e instanceof Error ? e.message : String(e) });
          }
          continue;
        }
        await this.tools
          .invoke(projectId, { sessionId, messageId, toolName: call.name, args: call.args ?? {} }, ctx)
          .catch(() => undefined);
      } catch { /* 非法 JSON 块忽略 */ }
    }
```

- [ ] **Step 4: 跑测试确认通过 + ai 域回归**

Run: `cd apps/server && npx vitest run src/modules/ai/ && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/sessions.service.ts apps/server/src/modules/ai/sessions.integration.test.ts
git commit -m "feat(ai): runToolBlocks 外部工具旁路——命中注册表无事务执行+两路留痕，未命中走 invoke 不变

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 10: 能力边界 + 可用工具 prompt 文案改写

**Files:**
- Modify: `apps/server/src/modules/ai/sessions.service.ts`（buildPrompt :437-452 两段）

（无新测试——既有套件无 prompt 文本断言；由 Task 2 的集成用例与实机验证兜底）

- [ ] **Step 1: 改写【能力边界】段**（:438-441 整块替换）

```ts
    // U-040 能力边界声明（对话改文档落地后修订）：写操作只有 propose_edits 提案通道（人工确认后生效），
    // 缺此声明时模型会谎称"已修改/已定稿"
    parts.push(`【能力边界（必须遵守）】
你不能直接修改、定稿、放行任何文档、UI 原型、代码、计划或批次；也不能替用户点击任何"人工确认"。
唯一写通道：对 CRD/PRD 的修改请求，通过 \`\`\`msf-tool req.doc.propose_edits\`\`\` 提交修改建议——产出高亮补丁，经用户逐条或批量确认后才生效；其它写诉求给出建议文本并指引落地路径（需求页 AI 生成/修订、设计页、开发页流程；定稿与放行永远是人工操作）。
严禁声称"已修改/已定稿/已放行/已完成写入"——凡未经用户确认，系统内数据均未变化。`);
```

- [ ] **Step 2: 改写【可用工具】段**（:442-452 整块替换，含 :442 旧注释行——新片段自带注释，不留重复行）

```ts
    // W2-053 + 跨阶段互通/对话改文档：工具自主调用声明（REQ-605）——```msf-tool 围栏块流末解析执行
    parts.push(`【可用工具（可自主调用）】
需要时，在回复正文之外输出独立的工具围栏块（可多个；不需要则不输出）：
\`\`\`msf-tool
{"name":"工具名","args":{...}}
\`\`\`
- nav.goto：为用户打开某个页面。args: {"tab":"material|req|design|proto|dev|test|tasks|delegate|settings|rtm"}。当用户说"打开/带我去/跳转到某页"时调用，正文同时说明已发起打开。RTM 需求矩阵有直达页签：tab 用 "rtm"。
- read_context：读取当前项目状态快照（各域条目计数）。args: {}。当需要最新项目数据回答"进展/状态"类问题时调用。
- doc.read：读取指定文档的当前稿正文。args: {"kind":"crd|prd|hld|mod|alg|cls|db|api|ui|nfr"}。当用户问"文档里某条怎么写的/REQ 编号原话/哪一节承接某需求"时调用；返回含 finalized（是否已定稿）与 versionNo，回答时如实说明依据的版本与定稿态。返回 found:false 表示该文档尚未生成。
- chat.history.read：读取本项目其它阶段会话的最近消息。args: {"sessionCode":"ss_3","limit":20}（limit 封顶 50）。当【他阶段会话】摘要不够、需要了解客户在其它阶段聊过的细节时调用。
- propose_next_step：按项目当前状态计算下一步建议清单。args: {}。当用户问"下一步该做什么"时调用。
- req.doc.propose_edits：提交 CRD/PRD 修改建议（高亮补丁，用户确认后才生效）。args: {"kind":"crd|prd","instruction":"要改什么"}。当用户要求修改需求文档内容时调用；调用后在正文说明"已提交修改建议，请到需求页确认"。
工具由系统在回复完成后执行，结果以工具卡随消息呈现；围栏块本身不会展示给用户。除 req.doc.propose_edits 的提案通道外，写操作仍须走人工路径。`);
```

- [ ] **Step 3: 回归 + Commit**

Run: `cd apps/server && npx vitest run src/modules/ai/sessions.integration.test.ts && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

```bash
git add apps/server/src/modules/ai/sessions.service.ts
git commit -m "feat(ai): prompt 能力边界/可用工具段改写——propose_edits 提案通道与 chat.history.read 声明

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: 前端工具卡（req.doc.propose_edits 成功卡 + 前往审阅）

**Files:**
- Modify: `apps/web/src/assistant/AssistantDock.tsx`（ToolCards :499-526、summarizeTool :528-538）

spec §二.2：成功卡渲染「✓ 已提交 N 条修改建议」+「前往审阅 →」钮（复用 nav.goto 卡跳转模式，点击才跳不静默跳页）；失败卡显原因（既有 reason 分支已覆盖）。图标分档说明：工具卡图标按 status（✅/🚫/❌）出，propose 档仅是服务端 ToolDef 元数据（A08-5 清单展示），前端无 kind 字段可消费，不改图标逻辑。

- [ ] **Step 1: summarizeTool 加 patchCount 分支**（`if (typeof o.head === 'string')` 之前插入）

```ts
      // req.doc.propose_edits 成功卡：「已提交 N 条修改建议」（失败走既有 reason 分支）
      if (o.ok === true && typeof o.patchCount === 'number') {
        return `已提交 ${o.patchCount} 条修改建议（高亮补丁，待你确认后生效）`;
      }
```

- [ ] **Step 2: ToolCards 加「前往审阅 →」钮**（navRoute 计算之后并列加 reviewRoute）

```tsx
        // 与 navRoute 同模式：route 从结果读（服务端返回 /req，不硬编码）
        const reviewRoute = t.toolName === 'req.doc.propose_edits' && t.status === 'ok'
          && (t.resultSummary as { ok?: boolean } | null)?.ok === true
          ? (t.resultSummary as { route?: string } | null)?.route
          : undefined;
```

渲染区 navRoute 块之后并列加：

```tsx
            {reviewRoute && (
              <div className="tc-body">
                <button className="act mini primary" onClick={() => navigate(reviewRoute)}>前往审阅 →</button>
              </div>
            )}
```

- [ ] **Step 3: 验证**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 零错（实机渲染验证并入 Task 16 场景②）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/assistant/AssistantDock.tsx
git commit -m "feat(ui): dock 工具卡 req.doc.propose_edits 成功卡——已提交 N 条修改建议+前往审阅直达

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 12: deriveNumbering 派生编号纯函数（packages/shared）

**Files:**
- Create: `packages/shared/src/doc-numbering.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/doc-numbering.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
/** 派生编号单测（大章分组/无大章退化/码入括号/s0 跳过/大章前散节） */
import { describe, expect, it } from 'vitest';
import { deriveNumbering } from './doc-numbering.js';

describe('deriveNumbering', () => {
  it('大章分组：章计数+节计数，锚点码入括号，标题保留原貌给大章', () => {
    const out = deriveNumbering([
      { id: 's0', title: '' },
      { id: 's1', title: '一、背景与目标' },
      { id: 's2', title: 'CR-001 浏览器即开即玩' },
      { id: 's3', title: 'CR-002 双人同屏' },
      { id: 's4', title: '二、非功能需求' },
      { id: 's5', title: 'CR-003 性能指标' },
    ]);
    expect(out[0]).toEqual({ id: 's0', display: '', chapter: false });
    expect(out[1]).toEqual({ id: 's1', display: '一、背景与目标', chapter: true });
    expect(out[2]).toEqual({ id: 's2', display: '1.1 浏览器即开即玩（CR-001）', chapter: false });
    expect(out[3]!.display).toBe('1.2 双人同屏（CR-002）');
    expect(out[4]).toEqual({ id: 's4', display: '二、非功能需求', chapter: true });
    expect(out[5]!.display).toBe('2.1 性能指标（CR-003）');
  });

  it('无大章（存量文档）→ 退化纯序号；无码节不带括号', () => {
    const out = deriveNumbering([
      { id: 's0', title: '前言' },
      { id: 's1', title: 'REQ-007 批量导入' },
    ]);
    expect(out[0]!.display).toBe('1. 前言');
    expect(out[1]!.display).toBe('2. 批量导入（REQ-007）');
  });

  it('大章之前的散节独立纯序号（不占章节号）', () => {
    const out = deriveNumbering([
      { id: 's0', title: '修订说明' },
      { id: 's1', title: '一、功能需求' },
      { id: 's2', title: 'REQ-001 登录' },
    ]);
    expect(out[0]!.display).toBe('1. 修订说明');
    expect(out[2]!.display).toBe('1.1 登录（REQ-001）');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/shared && npx vitest run src/doc-numbering.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
/**
 * 需求文档渲染层派生编号（存储零改动：编号不烤入标题；补丁定位仍 secId，RTM 锚点不断链）：
 * - 大章判定：标题命中 /^[一二三四五六七八九十]+、/ → 章计数 +1、节计数清零；大章标题原样展示
 * - 需求节：CR-nnn/REQ-nnn 锚点码从标题首词提取入括号 → `1.2 双人同屏（CR-002）`
 * - 无大章（存量文档）→ 退化纯序号 `1. 标题（CR-001）`；无标题节（s0 文首）不编号
 * - 大章之前的散节（修订说明等）→ 独立纯序号，不占章节号
 */

export interface NumberedSection {
  id: string;
  /** 展示标题（含派生编号与锚点码括号）；无标题节为 '' */
  display: string;
  /** 是否大章（消费侧据此加粗/不缩进） */
  chapter: boolean;
}

const CHAPTER_RE = /^[一二三四五六七八九十]+、/;
const CODE_RE = /^(?:CR|REQ)-\d{3}\s*/;

export function deriveNumbering(secs: Array<{ id: string; title: string }>): NumberedSection[] {
  const hasChapter = secs.some((s) => CHAPTER_RE.test(s.title));
  let chapter = 0;
  let section = 0;
  let flat = 0;
  return secs.map((s) => {
    if (!s.title) return { id: s.id, display: '', chapter: false };
    if (CHAPTER_RE.test(s.title)) {
      chapter += 1;
      section = 0;
      return { id: s.id, display: s.title, chapter: true };
    }
    const code = /^((?:CR|REQ)-\d{3})/.exec(s.title)?.[1];
    const body = s.title.replace(CODE_RE, '').trim();
    const suffix = code ? `（${code}）` : '';
    if (hasChapter && chapter > 0) {
      section += 1;
      return { id: s.id, display: `${chapter}.${section} ${body}${suffix}`, chapter: false };
    }
    flat += 1;
    return { id: s.id, display: `${flat}. ${body}${suffix}`, chapter: false };
  });
}
```

index.ts 追加：

```ts
export * from './doc-numbering.js';
```

- [ ] **Step 4: 跑测试 + 构建 + 双端 tsc**

Run: `cd packages/shared && npx vitest run src/doc-numbering.test.ts && pnpm build`
Expected: PASS + 构建成功
Run: `pnpm --filter @msf/shared build && cd apps/web && npx tsc --noEmit`
Expected: 零错（dist 已含新导出）

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/doc-numbering.ts packages/shared/src/doc-numbering.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): deriveNumbering 渲染层派生编号——大章+子节号、锚点码入括号、存量退化纯序号

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: 需求页消费派生编号（TocCol + Paper + req.css）

**Files:**
- Modify: `apps/web/src/pages/req/DocPanel.tsx`（TocCol :387-428、Paper :466-477）
- Modify: `apps/web/src/pages/req/req.css`（.toc-item :45-54 后追加）

- [ ] **Step 1: DocPanel.tsx**

import 区加：

```tsx
import { deriveNumbering } from '@msf/shared';
```

TocCol 内（useEffect 旁、`if (!doc) return null` 早退之前——hooks 规则，useMemo 不可放早退后）：

```tsx
  // 派生编号（渲染层注入，存储零改动）：大章加粗、节缩进一层
  const numbered = useMemo(() => (doc ? new Map(deriveNumbering(doc.secs).map((n) => [n.id, n])) : null), [doc]);
```

`tocSecs.map` 渲染改为：

```tsx
      {tocSecs.map((s) => {
        const n = numbered?.get(s.id);
        return (
          <button
            key={s.id}
            className={`toc-item${n?.chapter ? ' chapter' : ' sub'}${tocFlash === s.id ? ' flash' : ''}${s.pending ? ' has-pend' : ''}${activeSec === s.id ? ' act-sec' : ''}`}
            onClick={() => jump(s.id)}
          >
            {n?.display || s.title}
          </button>
        );
      })}
```

Paper 内同样计算 numbered（`const pendBySec = ...` 之前），h2（:470）改为：

```tsx
            {s.title && <h2>{numbered?.get(s.id)?.display || s.title}</h2>}
```

注意 Paper 已有 `const { doc, viewMode, patches, tocFlash } = useReqView();`，在其后加 useMemo（hooks 规则：在 `if (!doc) return null` 之后不可加 hook——Paper 的早退在 :433，useMemo 必须放早退之前；把 numbered 计算放在组件顶部解构之后、用 `doc ? ... : null` 守卫）。TocCol 同理（其 useEffect 在早退之前，useMemo 放 useEffect 旁即可）。

- [ ] **Step 2: req.css 追加**（:54 行块之后）

```css
/* 派生编号：大章加粗顶格，需求节缩进一层 */
.toc-item.chapter { font-weight: 700; }
.toc-item.sub { padding-left: 24px; }
```

（只用既有令牌体系，不写死颜色。）

- [ ] **Step 3: 验证**

Run: `cd apps/web && npx tsc --noEmit`
Expected: 零错
（实机渲染验证并入 Task 16）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/pages/req/DocPanel.tsx apps/web/src/pages/req/req.css
git commit -m "feat(ui): 需求页目录栏/纸面注入派生编号——大章加粗、节缩进、码入括号

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 14: 导出注入编号（withNumberedTitles）

**Files:**
- Modify: `apps/server/src/modules/platform/doc-sections.ts`（文件尾追加）
- Modify: `apps/server/src/modules/req/export.service.ts`（:40）
- Test: `apps/server/src/modules/platform/doc-sections.test.ts`（追加用例）

- [ ] **Step 1: 写失败测试**（doc-sections.test.ts 追加）

```ts
describe('withNumberedTitles（导出注入）', () => {
  it('标题注入派生编号、正文不动、RTM 锚点码保留在括号内', async () => {
    const { withNumberedTitles } = await import('./doc-sections.js');
    const out = withNumberedTitles([
      '## 一、功能需求', '', '引言。', '',
      '## CR-001 浏览器即开即玩', '', '承接：R-001',
    ].join('\n'));
    expect(out).toContain('## 一、功能需求');
    expect(out).toContain('## 1.1 浏览器即开即玩（CR-001）');
    expect(out).toContain('承接：R-001');
    expect(out).not.toContain('## CR-001 浏览器即开即玩\n'); // 原标题被替换
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server && npx vitest run src/modules/platform/doc-sections.test.ts`
Expected: FAIL（withNumberedTitles 未导出）

- [ ] **Step 3: 实现**

doc-sections.ts 文件尾追加（import 区加 `import { deriveNumbering } from '@msf/shared';`）：

```ts
/** 导出用：节标题注入派生编号后与原文同构重组（与前端渲染同函数同口径；存储内容不动） */
export function withNumberedTitles(content: string): string {
  const secs = splitSections(content);
  const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n.display]));
  return joinSections(secs.map((s) => (s.title && disp.get(s.id) ? { ...s, title: disp.get(s.id)! } : s)));
}
```

export.service.ts :40 改为：

```ts
    // 导出所见即所得：标题注入派生编号（渲染层同函数；存储内容不动）
    const body = await renderExport(withNumberedTitles(ver.content), format, `${kind.toUpperCase()} v${v}`);
```

import 区加：

```ts
import { withNumberedTitles } from '../platform/doc-sections.js';
```

- [ ] **Step 4: 跑测试 + 回归**

Run: `cd apps/server && npx vitest run src/modules/platform/doc-sections.test.ts src/modules/platform/doc-export.test.ts src/modules/req/ && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/platform/doc-sections.ts apps/server/src/modules/platform/doc-sections.test.ts apps/server/src/modules/req/export.service.ts
git commit -m "feat(req): 导出注入派生编号——md/html/docx/pdf 四格式与页面渲染同口径

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 15: 生成 prompt 大章约定

**Files:**
- Modify: `apps/server/src/modules/req/generate.service.ts`（buildPrompt :343 要求行）

- [ ] **Step 1: 改写要求行**（:343 整行替换——整篇/增量两分支共用此行，一处改动两处生效）

```ts
    `要求：中文 markdown；先按内容归类出若干大章，大章标题形如 \`## 一、背景与目标\`（中文序号+顿号，如 背景与目标/功能需求/非功能需求/约束与假设），大章下可有一段引言；每条需求单独一个 \`## \` 章节，标题形如 \`${kind === 'crd' ? 'CR' : 'REQ'}-001 简明标题\`，落在合适大章之后（锚点码必须在标题内，不得改动格式）；条目正文含承接来源与需求描述、验收要点。`,
```

同时修订分支的提示（:341）补充落位要求——该行 `**不要复述未变化的章节，不要整篇重出**。` 后追加 `新增需求节如需落位，可在该节之前输出所属大章标题行（仅当文档尚无该大章时）。`

注：mock 生成器（buildMock）不动——mock 是桩，产平铺章节即可；存量无大章文档由 deriveNumbering 退化纯序号兜底。

- [ ] **Step 2: 回归 + Commit**

Run: `cd apps/server && npx vitest run src/modules/req/ && npx tsc --noEmit`
Expected: 全 PASS + tsc 零错

```bash
git add apps/server/src/modules/req/generate.service.ts
git commit -m "feat(req): 生成 prompt 大章约定——整篇先出中文序号大章，需求节落位大章之后（锚点码格式不变）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 16: 门槛 + 差异登记 + 实机三场景验证 + 收口

**Files:**
- Create: `doc/dev-plan/AI会话互通与对话改文档-差异登记.md`

- [ ] **Step 1: 全量门槛**

```bash
cd apps/server && npx tsc --noEmit && npx vitest run
cd apps/web && npx tsc --noEmit
# 仓根：
pnpm lint && pnpm check:deps && node doc/product-design/tools/check-codes.mjs
```
Expected: 全绿（集成套件需 DB 的自动 skip 不算失败；仓根三件套零违规）

- [ ] **Step 2: 差异登记**（13 册待回补）

创建 `doc/dev-plan/AI会话互通与对话改文档-差异登记.md`，条目：
1. **LLD-5 §工具桥**：允许集四件套→六件套（+chat.history.read 只读、+req.doc.propose_edits propose 档）；ToolDef.kind 扩 `'read'|'nav'|'propose'`；新增外部工具注册表（platform/external-tools.ts，registerExternalTool 旁路机制——嵌套 LLM 工具不经 ai.tool.invoke 命令事务，留痕=ai_tool_calls recordDirect + 内部命令审计行，无 ai.tool.invoke 审计行）
2. **LLD-5 §会话 prompt**：buildPrompt 新增【他阶段会话】注入块（3000 字预算、静默降级）+【能力边界】【可用工具】两段文案改写（propose_edits 提案通道表述）
3. **LLD-6 §3.3**：增量修订流挂 normalizePatches（修复「修改=重复追加」既有缺陷）；新增 GenerateService.proposeEditsFromChat（dock 对话改文档通道，守卫四分支人话不落码）；生成 prompt 大章约定
4. **DSG-C04-4/导出**：导出四格式标题注入派生编号（withNumberedTitles）；需求页目录栏/纸面渲染层派生编号（deriveNumbering 落 packages/shared）
5. **LLD-5 §工具卡**：dock 工具卡 req.doc.propose_edits 成功卡分档（「已提交 N 条修改建议」+「前往审阅 →」跳转，复用 nav.goto 卡模式；失败卡走既有 reason 分支）
6. **已知限制**：mdToPatches 标题截 80 字符而 splitSections 不截，>80 字符无锚点码节归一化落空退回 add（CR/REQ 节不受影响）；空正文节不转 modify（保 add 人工处置）；del 补丁模型无法经 markdown 表达本期不支持

- [ ] **Step 3: 实机验证**（重启后端走纪律：TaskStop bl4n2xoya → netstat 确认 8080 释放 → `pnpm --filter @msf/server build`（或既有构建命令）→ 重启 → 探针验证代码新鲜度；vite 热更不需重启）

① 跨阶段互通：当前项目资料阶段会话聊「客户要双人同屏」→ 需求阶段 dock 问「客户对玩法有什么要求」→ AI 回答能引用资料阶段表态
② 对话改文档：需求阶段 dock 发「把 CR-001 改为支持手柄」→ 工具卡「✓ 已提交 N 条修改建议」+「前往审阅 →」→ 点击跳 /req → 高亮补丁逐条接受/拒绝 + 全部接受/拒绝（PatchBulk 既有）
③ 章节编号：CRD 重新生成（真模型按新约定出大章）→ 目录栏大章加粗+节缩进+「1.1 标题（CR-001）」→ 导出 md 标题同口径编号；存量文档退化为纯序号不破版

- [ ] **Step 4: 收口 Commit**

```bash
git add doc/dev-plan/AI会话互通与对话改文档-差异登记.md
git commit -m "docs(plan): AI 会话互通+对话改文档+章节编号 差异登记与实机验证收口

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 任务依赖与顺序

```
T1 digest ─→ T2 prompt 注入 ─┐
T3 chat.history.read ────────┤
T4 normalizePatches ─→ T5 既有流挂接 ─┐
T6 注册表 ─→ T7 tools 扩展 ─→ T8 proposeEditsFromChat ─→ T9 runToolBlocks 旁路 ─→ T10 prompt 文案 ─→ T11 前端工具卡
T12 deriveNumbering ─→ T13 前端消费 ─┐
                     ─→ T14 导出注入 ─┤
T15 大章约定 ────────────────────────┴→ T16 收口
```

T1→T11 为 AI 链路（server 为主+一个 web 任务），T12→T15 为编号链（shared+web+server），两链可并行；T16 必须在全部之后。每任务独立 commit，任一任务翻车可单独回滚不影响其它。
