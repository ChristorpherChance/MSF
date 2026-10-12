# Agent 体系深度优化与反思迭代 · 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development，逐任务实现+两阶段评审。

**Goal:** 设置页 Agent 配置从纯摆设升级为运行时真身（三层链：代码基底→ai_prompt_versions 覆盖→装配），七主十三子两层名册、上下文预算三档、反思执行器周自动+手动提案制迭代、设置页 UX 重做+模板编辑区加大。

**Architecture:** 规格=`doc/dev-plan/Agent体系深度优化与反思迭代-设计.md`（评审 Approved，含 C1/I1~I5 修法——实施前必读）。
stage-guides.ts 重写为 DEFAULT_AGENTS 二十套基底导出；新 agent-prompts.ts 管三层链解析与装配块；
reflection.service.ts 反思执行器（取样在事务外、落库写在 ai.reflect.run 命令事务内）；迁移 0030。

**Tech Stack:** NestJS + pg 直驱 + React 18 + Zustand；vitest（集成测试 scp 到 101 跑，命令见 Task 9 Step 1）。

**全局纪律（每个任务都适用）：** 错误码闭集零新增；console 只 warn/error；中文注释/文案；
审计失败零写；嵌套 LLM 绝不在命令事务内；直接 main 逐任务 commit（message 末尾
`Co-Authored-By: Claude Code <noreply@anthropic.com>`）；tsc 在 apps/server 或 apps/web 内分别跑；
`pnpm lint` 必须在仓根跑；集成测试改 101 后 `git checkout -- apps/server/src` 恢复受控树。

---

### Task 1: DEFAULT_AGENTS 二十套基底（stage-guides.ts 重写）

**Files:**
- Modify: `apps/server/src/modules/ai/stage-guides.ts`（整文件重写）
- Test: `apps/server/src/modules/ai/agent-presets.test.ts`（新建）

- [ ] **Step 1: 写结构断言测试（先红）**

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_AGENTS, DEFAULT_AGENT_MAP } from './stage-guides.js';

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
  it('子 Agent 四段齐全、200~800 字', () => {
    for (const k of SUB_KEYS) {
      const a = DEFAULT_AGENT_MAP[k]!;
      expect(a.role === 'sub' || a.role === 'overlay').toBe(true);
      for (const s of ['职责', '方法论', '反模式', '质量闸']) expect(a.prompt, `${k} 缺 ${s}`).toContain(s);
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
```

- [ ] **Step 2: 整文件重写 stage-guides.ts**——新结构：

```ts
/** Agent 基底（设计 §2）：代码默认层。三层链=代码基底 → ai_prompt_versions is_current 覆盖 → 运行时装配。
 *  主 Agent 八段式（角色定位/职责边界/方法论/工具纪律/产出契约/质量自检/反模式/协作联动），
 *  子 Agent 轻量四段式（职责/方法论/反模式/质量闸）。实机教训全部进⑦反模式/③方法论。 */
export interface AgentDef { key: string; group: string; name: string; role: 'global' | 'main' | 'sub' | 'overlay'; prompt: string }
export const DEFAULT_AGENTS: AgentDef[] = [ /* 20 套 */ ];
export const DEFAULT_AGENT_MAP: Record<string, AgentDef> = Object.fromEntries(DEFAULT_AGENTS.map((a) => [a.key, a]));
/** 兼容导出（sessions.service 迁移期引用；装配链迁完后删除） */
export const STAGE_GUIDES: Record<string, string> = Object.fromEntries(
  DEFAULT_AGENTS.filter((a) => a.role === 'main').map((a) => [a.key, a.prompt]));
```

内容来源（设计 §2 表，逐套归位升级，**实机教训一条不丢**）：
- `assistant`（global）← 现 SettingsPage.tsx:28 GLOBAL_BASE 文案移入服务端+扩八段（跨阶段导航方法论：何时建议切页签/何时提议换阶段会话）；
- `req` ← 现 REQ_GUIDE 全文保留进③④⑦（核对四步走/多文档串行/重编号 rewrite/29148/模板纪律条）+补①②⑤⑥⑧；
- `design` ← 现 DESIGN_GUIDE 同法（五册重写 24 读教训/分册标准口径 42010+1016/OpenAPI/WCAG/25010/原型纪律）；
- `proto`/`dev`/`test`/`material` ← 现 PROTO/DEV/TEST/MATERIAL_GUIDE 同法；`dev` ③补旧 ag-dev 任务卡口径（REQ 锚点+设计锚点+验收+DoD）；
- `req.crd` ← CR 客户原声溯源（每条 CR 标来源 R-*）；`req.prd` ← 验收量化（每条 REQ refines CR-*）；
- `design.八册` ← 各册标准评审口径精要（api=OpenAPI 契约+错误码闭集、db=范式/索引/迁移表、hld=ADR 决策理由、ui=WCAG 2.2 AA 核对表、nfr=25010 特性映射）；
- `material.file-parse`/`material.content-ops` ← 旧 ag-file/ag-content（不臆造原文/质量自检清单/定位补丁禁重写全文）；
- `dev.coding-std` ← 现 StdPanel 默认口径一句话基底（overlay 角色）。

- [ ] **Step 3:** `cd apps/server && npx vitest run src/modules/ai/agent-presets.test.ts`（本机绿）→ `npx tsc --noEmit` → 仓根 `pnpm lint`

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/ai/stage-guides.ts apps/server/src/modules/ai/agent-presets.test.ts
git commit -m "feat(ai): DEFAULT_AGENTS 二十套基底——七主八段式+十三子四段式，实机教训全入反模式（stage-guides 重写）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 三层链解析 + 装配块重构（agent-prompts.ts + buildSystemPrompt）

**Files:**
- Create: `apps/server/src/modules/ai/agent-prompts.ts`
- Modify: `apps/server/src/modules/ai/sessions.service.ts`（buildPrompt 重构）
- Test: `apps/server/src/modules/ai/agent-prompts.integration.test.ts`（新建，101 跑）

- [ ] **Step 1: 集成测试（先红）**——fixture 镜像 propose-edits.integration.test.ts（infraUp/resetCommands/项目行/afterAll）。断言矩阵：
  1. 无用户版本 → buildSystemPrompt 含代码基底（assistant+主 Agent 全文各抽查一句）；
  2. 发布 req 主用户版本（ai.prompt.publish activate=true）→ 装配含用户版、不含基底句；
  3. 子叠加：会话 doc_kind='crd' → 含 req.crd 子块；doc_kind NULL（dev 会话）→ 含 dev.coding-std 叠加块、不含任何 doc_kind 子块；
  4. 盖戳：ai_messages.prompt_version_id = 注入链首层用户版本 id（全无用户版本=NULL）；input_fingerprint 随版本翻转变化；
  5. overlay_text 拼接：版本带 overlayText 时基底+叠加同现。

- [ ] **Step 2: agent-prompts.ts**

```ts
import { query } from '../../db/pool.js';
import { DEFAULT_AGENT_MAP } from './stage-guides.js';

/** 三层链解析（设计 §1）：is_current 用户版本（base+overlay 拼接）→ 代码基底；零配置=纯基底 */
export interface ResolvedAgent { key: string; text: string; versionId: string | null }
export async function resolveAgentPrompt(agentKey: string): Promise<ResolvedAgent> {
  const r = await query<{ id: string; base_prompt: string; overlay_text: string }>(
    'SELECT id, base_prompt, overlay_text FROM ai_prompt_versions WHERE agent_key=$1 AND is_current', [agentKey]);
  const v = r.rows[0];
  if (v) return { key: agentKey, text: v.overlay_text ? `${v.base_prompt}\n\n${v.overlay_text}` : v.base_prompt, versionId: v.id };
  const d = DEFAULT_AGENT_MAP[agentKey];
  return { key: agentKey, text: d?.prompt ?? '', versionId: null };
}

/** 装配三层（assistant 全局基底 + 主（ctx）+ 子（doc_kind 命中；dev 恒叠加 coding-std）） */
export async function assembleAgentBlocks(ctx: string | null, docKind: string | null): Promise<{
  blocks: string[]; versionIds: string[]; stampId: string | null;
}> {
  const keys: string[] = ['assistant'];
  if (ctx && DEFAULT_AGENT_MAP[ctx]) keys.push(ctx);
  if (ctx === 'dev') keys.push('dev.coding-std');
  else if (ctx && docKind && DEFAULT_AGENT_MAP[`${ctx}.${docKind}`]) keys.push(`${ctx}.${docKind}`);
  const resolved = await Promise.all(keys.map(resolveAgentPrompt));
  const blocks: string[] = [];
  if (resolved[0]!.text) blocks.push(`【全局基底】\n${resolved[0]!.text}`);
  if (resolved[1]?.text) blocks.push(`【角色与方法】\n${resolved[1].text}`);
  if (resolved[2]?.text) blocks.push(`【工件专项】\n${resolved[2].text}`);
  const versionIds = resolved.map((r) => r.versionId).filter((x): x is string => !!x);
  return { blocks, versionIds, stampId: versionIds[0] ?? null };
}
```

- [ ] **Step 3: sessions.service.ts 重构**——`buildPrompt`（513 行起）拆分：`buildSystemPrompt(projectId, sessionId)` 返回 system 段；
  【阶段职责与方法】块整段替换为 assembleAgentBlocks 三块（位置提前至【当前上下文】之前，其余块序列不动）；
  send() 内盖戳改口径：`prompt_version_id`=assemble 返回的 stampId（不再查 assistant 单点），
  input_fingerprint=sha256hex(`${versionIds.join('|')}|${refsFp}`)。
  ai.message.send 命令（155-156 行单点查 assistant）相应改造——命令需要拿到 stampId：
  方案=send() 先 assemble（读侧不经命令），把 stampId/fingerprint 传入 ai.message.send payload
  （payload 增可选 `promptVersionId`/`inputFingerprint`，命令内优先取 payload、缺省回退旧查询保兼容）。

- [ ] **Step 4: 101 跑**（命令见 Task 9 Step 1；顺带跑 sessions.integration.test.ts 确认装配重构零回归）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/agent-prompts.ts apps/server/src/modules/ai/sessions.service.ts apps/server/src/modules/ai/agent-prompts.integration.test.ts
git commit -m "feat(ai): Agent 三层链运行时接通——assembleAgentBlocks 全局/主/子叠加+盖戳口径升级（设置页 prompt 从此是真身）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 上下文预算分档

**Files:**
- Modify: `apps/server/src/modules/ai/agent-prompts.ts`（band 判定+窄档裁剪）
- Modify: `apps/server/src/modules/ai/sessions.service.ts`（TOOL_LOG_BUDGET 参数化+band 透传）
- Modify: `apps/server/src/modules/ai/tools.service.ts`（DOC_READ_CAP 参数化）
- Test: `apps/server/src/modules/ai/agent-presets.test.ts`（+分档用例）

- [ ] **Step 1: 单测（先红）**：`contextBand(null/undefined)='wide'`、`contextBand(1000000)='wide'`、
  `contextBand(256000)='standard'`、`contextBand(128000)='standard'`、`contextBand(127999)='narrow'`、
  `contextBand(64000)='narrow'`；窄档裁剪：assistant/主 Agent 全段保留、子 Agent 只留职责+反模式段、
  能力边界/工具签名段原文保留。

- [ ] **Step 2: 实现**

```ts
// agent-prompts.ts
export type ContextBand = 'wide' | 'standard' | 'narrow';
/** 无模型/mock 期=wide（306 基线口径不变）；窗口未知的真实模型按 128000 默认落 standard */
export function contextBand(contextWindow: number | null | undefined): ContextBand {
  if (contextWindow == null) return 'wide';
  if (contextWindow >= 512000) return 'wide';
  if (contextWindow >= 128000) return 'standard';
  return 'narrow';
}
export const BAND_BUDGETS: Record<ContextBand, { toolLog: number; docRead: number }> = {
  wide: { toolLog: 80000, docRead: 12000 },      // 现状常量原位参数化
  standard: { toolLog: 40000, docRead: 8000 },
  narrow: { toolLog: 16000, docRead: 6000 },
};
/** 窄档裁剪：主/assistant 全保，子 Agent 只留【职责】【反模式】段（按段标题切） */
export function narrowTrim(agentKey: string, text: string): string {
  if (DEFAULT_AGENT_MAP[agentKey]?.role !== 'sub') return text;
  const keep = text.split(/\n(?=【)/).filter((seg) => /^【(职责|反模式)/.test(seg));
  return keep.join('\n');
}
```
（子 Agent 基底段落标题须与裁剪谓词一致——Task 1 的子 Agent 四段标题固定为【职责】【方法论】【反模式】【质量闸】。）

- [ ] **Step 3: 接线**——send()/drive 链透传 band：send() 解析会话模型（绑定模型或 chat 路由行）取
  context_window → band；PipelineEntry 增 `band?: ContextBand`（缺省 wide）；buildToolFollowup 的
  TOOL_LOG_BUDGET 改 `BAND_BUDGETS[band].toolLog`；tools.service doc.read 的 DOC_READ_CAP 同理参数化
  （tools 调用点从会话上下文取 band，缺省 wide——查 tools.service 调用链把 band 透传进去）。

- [ ] **Step 4:** 本机单测绿 + `npx tsc --noEmit` + 仓根 lint + 101 跑 sessions 套件（盖戳/budget 相关回归）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/ai/agent-prompts.ts apps/server/src/modules/ai/sessions.service.ts apps/server/src/modules/ai/tools.service.ts apps/server/src/modules/ai/agent-presets.test.ts
git commit -m "feat(ai): 上下文预算三档（wide/standard/narrow）——toolLog/doc.read 预算参数化+窄档子 Agent 精简段（无模型=wide 基线不变）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 迁移 0030 + 反思命令注册 + reflection 路由

**Files:**
- Create: `apps/server/src/db/migrations/0030_agent_reflections.sql`
- Modify: `apps/server/src/modules/evidence/commands.ts`（+2 命令）
- Modify: `apps/server/src/modules/ai/models.service.ts`（PURPOSES + 'reflection'；resolve 兜底）
- Test: `apps/server/src/modules/platform/migrations.test.ts`（如有既有迁移测试形态则加例，否则免）

- [ ] **Step 1: 迁移**

```sql
-- 0030: Agent 反思迭代（设计 §3）+ 编码规范叠加区键名收编
CREATE TABLE IF NOT EXISTS ai_reflections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
  window_start timestamptz NOT NULL, window_end timestamptz NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}',
  report text NOT NULL,
  proposals jsonb NOT NULL DEFAULT '[]',
  model_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
UPDATE ai_prompt_versions SET agent_key='dev.coding-std' WHERE agent_key='dev-coding-std';
```
（查迁移runner形态：既有迁移是否自动按序执行——`apps/server/src/db/` 下 migrate 机制，新文件落号即跑；确认 IF NOT EXISTS/幂等口径与既有迁移一致。）

- [ ] **Step 2: commands.ts** ai.prompt 家族后加：

```ts
  'ai.reflect.run',               // 🪞 Agent 反思：执行+落库（取样/LLM 在事务外，落库写在事务内）
  'ai.reflect.proposal.resolve',  // 🪞 反思提案处置（采用=is_current 翻转 / 拒绝=状态回写）
```

- [ ] **Step 3: models.service.ts**——PURPOSES 增 `'reflection'`（枚举校验自动放行）；
  reflection.service 用的解析方法（新增 export，动态兜底钉死）：

```ts
/** reflection 路由解析：显式路由优先；无路由=enabled 中 context_window 最大者（动态兜底，不做种子） */
async resolveReflection(): Promise<{ row: ModelRow; apiKey: string | null }> {
  const r = await query<ModelRow>(
    "SELECT * FROM ai_models WHERE enabled AND routes ? 'reflection' ORDER BY updated_at DESC LIMIT 1", []);
  const row = r.rows[0] ?? (await query<ModelRow>(
    'SELECT * FROM ai_models WHERE enabled ORDER BY context_window DESC, updated_at DESC LIMIT 1', [])).rows[0];
  if (!row) throw new DomainError('MODEL_UNAVAILABLE', '无可用模型（请先在设置页注册并启用模型）', 'reflection');
  return { row, apiKey: row.api_key_enc ? decryptText(row.api_key_enc) : null };
}
```

- [ ] **Step 4:** `npx tsc --noEmit` + lint + check-codes 零违规；101 起库跑迁移幂等验证（两跑不炸）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/db/migrations/0030_agent_reflections.sql apps/server/src/modules/evidence/commands.ts apps/server/src/modules/ai/models.service.ts
git commit -m "feat(ai): 迁移 0030 ai_reflections+dev.coding-std 键名收编+reflection 用途路由动态兜底

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 反思执行器 + 调度器

**Files:**
- Create: `apps/server/src/modules/ai/reflection.service.ts`
- Test: `apps/server/src/modules/ai/reflection.integration.test.ts`（101 跑）
- Modify: `apps/server/src/modules/ai/ai.module.ts`（provider 装配）

- [ ] **Step 1: 集成测试（先红）**——mock 反思通道：mock provider 对 purpose='reflection' 返回固定 JSON
  （查 mock-ai.provider.ts 的 purpose 分发形态，加 reflection 分支产「报告+1 条 req 主 Agent 修订提案」样例）。断言：
  1. 手动 run → ai_reflections 落行（trigger='manual'）+ 提案版本行 is_current=false 且 created_by='reflection'
     （**C1 钉死：不经 publish**）+ proposals[0].status='pending'；
  2. 并发闸：在飞时再 run → INVALID_STATE；
  3. proposal.resolve adopt → 该版本 is_current=true、旧版翻转 false、proposals 状态='adopted'；
  4. proposal.resolve reject → 版本行保留、proposals 状态='rejected'；
  5. 调度判定：ai_reflections 有 3 天前行 → shouldRun=false；空表 → shouldRun=true（无新消息时仍 false——
     新消息判定=窗口内 ai_messages 计数>0）。

- [ ] **Step 2: reflection.service.ts 骨架**：

```ts
const REFLECT_SYSTEM = `你是软件工厂的 Agent 治理反思器。输入=各 Agent 近 7 天使用统计与对话采样
（含提案采纳/拒绝、工具误用、用户反复纠正点）。产出严格 JSON：
{"report":"markdown 报告全文","proposals":[{"agentKey":"…","name":"反思改进 yyyymmdd","summary":"一句理由","fullText":"修订版全文"}]}
纪律：提案必须是整篇修订全文（非 diff）；零提案合法（proposals=[]）；只改「怎么当角色」，不得触碰能力边界/工具集；被拒历史中的方向不得再提。`;

@Injectable()
export class ReflectionService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  onModuleInit(): void {
    registerCommand('ai.reflect.run', async (client, payload) => { /* 落库写：ai_reflections 行 + 提案版本直插（FOR UPDATE 取号同 publish 口径、is_current=false 无条件、created_by='reflection'） */ });
    registerCommand('ai.reflect.proposal.resolve', async (client, payload) => { /* adopt=翻转 is_current（先摘后挂同 rollback 口径）+ proposals 状态回写；reject=仅状态回写 */ });
    this.timer = setInterval(() => { void this.tick(); }, 3600_000); // 每小时探一次
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  /** 调度判定（导出供测试）：无历史=到期；窗口内零新消息=不跑 */
  async shouldRun(now = new Date()): Promise<boolean> { /* COALESCE(max(created_at),'-infinity') + ai_messages 窗口计数 */ }
  private async tick(): Promise<void> { if (await this.shouldRun()) await this.run('scheduled', SYS_CTX).catch((e) => console.error(`[reflection] ${e instanceof Error ? e.message : e}`)); }
  /** 主流程：并发闸 → 取样装配（事务外）→ resolveReflection → LLM（事务外）→ ai.reflect.run 落库 → 通知 */
  async run(trigger: 'scheduled' | 'manual', ctx: CommandContext): Promise<{ reflectionId: string }> { /* … */ }
}
```
取样查询（全项目跨域只读）：窗口内 ai_messages 联 ai_sessions 按 ctx/doc_kind 分组计数；
req_pendings/dsg_pendings 窗口内 status 计数；ai_tool_calls 窗口内按工具名计数+错误率；ai_usage 分组求和；
被拒提案历史（proposals status='rejected' 的 agentKey+summary）。采样超窗按组截断、统计全文保留。
SYS_CTX = `{ actorKind: 'system', actorId: 'system' }`（CommandContext.projectId 可选——reflect 全局跨项目）。

- [ ] **Step 3:** 101 跑集成全绿；本机 tsc+lint+check-codes

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/modules/ai/reflection.service.ts apps/server/src/modules/ai/reflection.integration.test.ts apps/server/src/modules/ai/ai.module.ts apps/server/src/modules/ai/mock-ai.provider.ts
git commit -m "feat(ai): 反思执行器——取样/分析/提案直插（绕开 publish 首版强制）/采用拒绝双态+小时级调度器

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 端点 + 通知

**Files:**
- Modify: `apps/server/src/modules/platform/system.controller.ts`（或 ai-sessions.controller 同族——看 reflections 归属，建议挂 system.controller 的 system 区）

- [ ] **Step 1: 三端点**（镜像既有 system 端点形态；actor 经 getActor）：
  - `POST /api/v1/system/reflections:run` → reflectionService.run('manual', ctx)（并发闸 INVALID_STATE 人话）；
  - `GET /api/v1/system/reflections` → 历史列表（id/trigger/窗口/proposals 状态计数/created_at，report 全文按需 ?id= 单取）；
  - `POST /api/v1/system/reflections:resolve` → body {reflectionId, agentKey, versionNo, action:'adopt'|'reject'}。
- [ ] **Step 2: 通知**——run 完成后经既有 notifications 通道发「🪞 反思报告：N 条 Agent 改进提案待审」
  （查 system 通知发布点照抄；零提案发「本期无需调整」）。
- [ ] **Step 3:** tsc+lint；101 回归 system/ai 套件
- [ ] **Step 4: Commit** `feat(ai): 反思三端点+系统通知（🪞 报告待审）`

---

### Task 7: 前端设置页 Agent 区重做

**Files:**
- Modify: `apps/web/src/pages/platform/SettingsPage.tsx`（AGENTS 名册树重构）
- Modify: `apps/web/src/pages/platform/api.ts`（reflections api 三方法+基底获取）
- Modify: `apps/web/src/pages/platform/settings.css`（.prompt-editor min-height 180→420；名册树样式）
- Modify: `apps/web/src/pages/dev/StdPanel.tsx`（key 'dev-coding-std'→'dev.coding-std'）
- 新端点配套：`promptsApi` 增 `baseline(agentKey)`（后端补 GET 基底端点，或前端直接引 shared 常量——**注意**：基底在服务端 stage-guides.ts，前端要显示须加只读端点 `GET /api/v1/system/agent-baseline?key=`，放 Task 7 顺带在 system.controller 加）

- [ ] **Step 1: 名册树**：全局助手 + 六阶段主（可展开）+ 各阶段子分组缩进（需求：CRD/PRD；设计：八册；
  资料：文件解析/内容加工；开发：编码规范）。名册数据源=新端点返回 DEFAULT_AGENTS 元信息（key/name/group/role）
  +各 key 当前版本号——前端不再内置 AGENTS 常量（旧六员 ag-* 退役不展示）。
- [ ] **Step 2: Agent 卡重做**：生效源标签（「代码默认基底」/「用户版本 vN」）+「查看默认基底」只读对照抽屉
  （基底 vs 当前版并排）+ 大编辑区（min-height 420px）+ 版本列表（现有 setCurrent/rename/delete 不动）
  +「反思提案」区（该 agent 的 pending 提案：summary+理由+并排对照+采用/拒绝钮 → reflections:resolve）。
- [ ] **Step 3: StdPanel 换 key** + 全局助手卡原位升级（工具启用区/执行自检保留）。
- [ ] **Step 4:** `cd apps/web && npx tsc --noEmit` + 仓根 lint
- [ ] **Step 5: Commit** `feat(web): 设置页 Agent 区重做——两层名册树/大编辑区/基底对照/反思提案区+StdPanel 键名收编`

---

### Task 8: 模板编辑区加大

**Files:**
- Modify: `apps/web/src/pages/platform/DocTemplatesGroup.tsx`（两处 rows）

- [ ] **Step 1:** 章条 requires textarea `rows={2}`→`rows={5}`；「质量要求」textarea `rows={2}`→`rows={4}`；
  两处 style 或 css 类补 `resize: 'vertical'`（查现类——.tpl-chapters textarea 挂的类，css 里加 resize:vertical）。
- [ ] **Step 2:** web tsc + lint；`git commit -m "fix(web): 模板编辑区加大——章条 requires 2→5 行/质量要求 2→4 行+纵向可拉"`

---

### Task 9: 差异登记条目 43 + 全量闸 + 收尾

- [ ] **Step 1: 101 测试纪律命令**

```bash
scp -i ~/.ssh/id_ed25519_superopen_192_168_0_143 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_superopen_192_168_0_143 <文件> superopen@192.168.10.101:~/All-Projects/msf/apps/server/src/modules/<同路径>
ssh -i ~/.ssh/id_ed25519_superopen_192_168_0_143 -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=~/.ssh/known_hosts_superopen_192_168_0_143 superopen@192.168.10.101 'export PATH="$HOME/opt/node22/bin:$PATH"; cd ~/All-Projects/msf/apps/server && npx vitest run <测试文件>'
```
101 工作副本被 scp 覆盖后先 `git checkout -- apps/server/src` 再 bundle ff（未跟踪新文件先 rm 同名再 ff）。

- [ ] **Step 2: 差异登记条目 43**（格式同条目 42：背景一句+分点+测试口径+「待 13 册下轮基线回补
  LLD-5 A08（阶段指南→Agent 三层链）/LLD-4（ai_reflections 表）/LLD-6 U02（设置页）」）；
  升级通告口径写明两行为变更：库里既有 assistant 用户版本上线即生效、盖戳语义从 assistant 单点改注入链首层。

- [ ] **Step 3: 全量闸**——双端 tsc / 仓根 lint / check-codes / 101 全量
  `npx vitest run --exclude "**/sandbox.integration.test.ts" --exclude "**/storage.service.test.ts"`（306 基线+新增全绿）

- [ ] **Step 4: Commit** `docs(dev-plan): 差异登记条目 43——Agent 体系深度优化与反思迭代（待 13 册下轮基线回补）`

- [ ] **Step 5: 同步 101 + 部署 116（部署前问用户拍板）**；实机走查清单：设置页名册树逐套看基底 →
  改一套 req 主 Agent 发个版本 → dock 问一句验证新 prompt 生效 →「🪞 立即反思」跑一场看报告+提案 →
  采用一条提案再验证 → 模板编辑区章条框可视行数。
