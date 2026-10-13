import { Inject, Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { AI_PROVIDER, type AiMessageResult, type AiProvider, type AiSession } from './ai-provider.interface.js';
import { DEFAULT_AGENT_MAP } from './stage-guides.js';

/**
 * Agent 治理反思执行器（设计 §3/§4；迁移 0030 ai_reflections）：
 * - 四步流：取样（事务外只读）→ LLM 分析（事务外）→ ai.reflect.run 命令落库（事务内）→ 通知
 * - 嵌套 LLM 绝不在命令事务内：取样/分析全在事务外，落库写（ai_reflections 行+提案版本行）收进命令事务
 * - 提案直插 ai_prompt_versions 绕开 ai.prompt.publish——其「首版强制 is_current=true」会击穿提案制（评审 C1）；
 *   version_no 取号与 is_current 翻转口径照抄 publish/rollback（FOR UPDATE 取号、先摘后挂）
 * - 调度器：setInterval 每小时探一次「距上次 ≥7 天且窗口内有新消息」；无历史视为到期；零新消息跳过不空跑
 * - 并发闸：内存 running 标志（模板重排先例——单进程部署），同刻一场；手动 run 在飞再 run 抛 INVALID_STATE，
 *   tick 在飞则静默跳过（每小时撞闸刷 console.error 是噪音，闸只留给手动入口）
 * - run 看门狗：LLM 结果包 30 分钟超时（Promise.race），超时 session.stop() 并抛错——
 *   防上游静默挂起致 running 永真、调度器永久卡死（评审折入，口径=看门狗方案）
 * - 反思系统 prompt 代码内置不可编辑——管 Agent 的 Agent 不开放自改（防自指漂移）
 */

/** 反思系统 prompt（设计 §4：产出严格 JSON；提案整篇全文非 diff；零提案合法；被拒方向不得再提） */
const REFLECT_SYSTEM = `你是软件工厂的 Agent 治理反思器。输入=各 Agent 近 7 天使用统计与对话采样
（含提案采纳/拒绝、工具误用、用户反复纠正点）。产出严格 JSON：
{"report":"markdown 报告全文","proposals":[{"agentKey":"…","name":"反思改进 yyyymmdd","summary":"一句理由","fullText":"修订版全文"}]}
纪律：提案必须是整篇修订全文（非 diff）；零提案合法（proposals=[]）；只改「怎么当角色」，不得触碰能力边界/工具集；被拒历史中的方向不得再提。`;

/** 调度/取样窗口（设计 §4：默认 7 天） */
const WINDOW_MS = 7 * 86400_000;
/** 调度探测节拍：每小时一次（进程重启自然漂移不追钟点） */
const TICK_MS = 3600_000;
/** 单场提案上限（防模型失控刷量；超出截断） */
const MAX_PROPOSALS = 20;
/** 对话原文采样上限（统计全文保留、采样按组截断——信号优先） */
const SAMPLE_LIMIT = 120;
/** run 看门狗：LLM 终态 30 分钟未达即判超时（stop 会话+抛错复位并发闸）；分钟数单点常量，文案插值同源防漂移 */
const WATCHDOG_MIN = 30;
const WATCHDOG_MS = WATCHDOG_MIN * 60_000;

/** 反思全局跨项目上下文（CommandContext.projectId 是 string|null 必填位；调度触发走系统身份） */
export const SYS_CTX: CommandContext = { projectId: null, actorKind: 'system', actorId: 'system' };

export interface ReflectionProposalInput {
  agentKey: string; name: string; summary: string; fullText: string;
}
export interface ReflectionProposalRow extends ReflectionProposalInput {
  versionNo: number; status: 'pending' | 'adopted' | 'rejected';
}
/** 提案处置结果（端点接缝具名类型，不再 cast） */
export interface ReflectionResolveResult {
  reflectionId: string; agentKey: string; versionNo: number; status: 'adopted' | 'rejected';
}
/** 历史列表项（proposals 按状态聚合计数，不带 report 全文） */
export interface ReflectionListItem {
  id: string; trigger: string; windowStart: string; windowEnd: string;
  modelId: string | null; createdAt: string;
  counts: { pending: number; adopted: number; rejected: number };
}
/** 单场次详情（?id= 单取：report 全文 + proposals 明细 + stats） */
export interface ReflectionDetail extends ReflectionListItem {
  report: string;
  proposals: Array<{ agentKey: string; versionNo: number; summary: string; status: string }>;
  stats: Record<string, unknown>;
}

@Injectable()
export class ReflectionService implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据
  constructor(
    @Inject(AI_PROVIDER) private readonly provider: AiProvider,
    // 可选：集成测试直 new 单参构造；运行期由 Nest 注入（报告通知，缺席仅不通知不影响落库）
    @Optional() @Inject(NotificationsService) private readonly notices?: NotificationsService,
  ) {}

  onModuleInit(): void {
    // 落库写（事务内）：ai_reflections 行 + 提案版本直插（is_current=false 无条件、created_by='reflection'）
    registerCommand('ai.reflect.run', async (client, payload) => {
      const p = payload as {
        trigger?: string; windowStart?: string; windowEnd?: string;
        stats?: Record<string, unknown>; report?: string; modelId?: string | null;
        proposals?: ReflectionProposalInput[];
      };
      if (p.trigger !== 'scheduled' && p.trigger !== 'manual') {
        throw new DomainError('VALIDATION_FAILED', 'trigger 枚举 scheduled|manual', 'trigger');
      }
      if (!p.windowStart || !p.windowEnd) {
        throw new DomainError('VALIDATION_FAILED', 'windowStart/windowEnd 必填', 'windowStart');
      }
      if (!p.report?.trim()) throw new DomainError('VALIDATION_FAILED', 'report 不能为空', 'report');
      const registered: ReflectionProposalRow[] = [];
      for (const prop of (p.proposals ?? []).slice(0, MAX_PROPOSALS)) {
        const agentKey = prop.agentKey?.trim();
        if (!agentKey || !prop.fullText?.trim()) {
          throw new DomainError('VALIDATION_FAILED', '提案 agentKey/fullText 必填', 'proposals');
        }
        // 命令侧名册校验（评审折入）：未知键不再静默落 'assistant' 组兜底，直接拒
        const def = DEFAULT_AGENT_MAP[agentKey];
        if (!def) throw new DomainError('VALIDATION_FAILED', `未知 agentKey「${agentKey}」（名册外）`, 'proposals');
        // version_no 取号同 publish 口径（FOR UPDATE 防撞号）
        const prev = await client.query<{ version_no: number; agent_group: string }>(
          'SELECT version_no, agent_group FROM ai_prompt_versions WHERE agent_key=$1 ORDER BY version_no DESC LIMIT 1 FOR UPDATE',
          [agentKey]);
        const versionNo = (prev.rows[0]?.version_no ?? 0) + 1;
        await client.query(
          `INSERT INTO ai_prompt_versions (agent_key, agent_group, version_no, name, base_prompt, overlay_text, is_current, kind, created_by)
           VALUES ($1,$2,$3,$4,$5,'',false,'prompt','reflection')`,
          [agentKey, prev.rows[0]?.agent_group ?? def.group,
           versionNo, prop.name?.trim() || `反思改进 ${versionNo}`, prop.fullText]);
        registered.push({ agentKey, name: prop.name, summary: prop.summary ?? '', fullText: prop.fullText, versionNo, status: 'pending' });
      }
      const r = await client.query<{ id: string }>(
        `INSERT INTO ai_reflections (trigger, window_start, window_end, stats, report, proposals, model_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [p.trigger, p.windowStart, p.windowEnd, JSON.stringify(p.stats ?? {}), p.report,
         JSON.stringify(registered.map(({ agentKey, versionNo, summary, status }) => ({ agentKey, versionNo, summary, status }))),
         p.modelId ?? null]);
      return { reflectionId: r.rows[0]!.id, proposals: registered };
    });

    // 提案处置（事务内）：adopt=is_current 翻转（先摘后挂同 rollback 口径）+状态回写；reject=仅状态回写（版本行保留）
    registerCommand('ai.reflect.proposal.resolve', async (client, payload) => {
      const p = payload as { reflectionId?: string; agentKey?: string; versionNo?: number; decision?: string };
      if (!p.reflectionId || !p.agentKey || !Number.isInteger(p.versionNo)
        || (p.decision !== 'adopt' && p.decision !== 'reject')) {
        throw new DomainError('VALIDATION_FAILED', 'reflectionId + agentKey + versionNo（整数）+ decision（adopt|reject）必填', 'decision');
      }
      // 读改写 proposals 数组：行级 FOR UPDATE 锁住后整体回写（jsonb 行内更新先例）
      const ref = await client.query<{ proposals: Array<{ agentKey: string; versionNo: number; status: string }> }>(
        'SELECT proposals FROM ai_reflections WHERE id=$1 FOR UPDATE', [p.reflectionId]);
      if (!ref.rows[0]) throw new DomainError('NOT_FOUND', '反思场次不存在', p.reflectionId);
      const proposals = ref.rows[0].proposals;
      const target = proposals.find((x) => x.agentKey === p.agentKey && x.versionNo === p.versionNo);
      if (!target) throw new DomainError('NOT_FOUND', `提案不存在: ${p.agentKey}@v${p.versionNo}`, p.agentKey);
      if (target.status !== 'pending') {
        throw new DomainError('INVALID_STATE', `提案已处置（${target.status}），不可重复操作`, p.agentKey);
      }
      if (p.decision === 'adopt') {
        const ver = await client.query<{ id: string }>(
          'SELECT id FROM ai_prompt_versions WHERE agent_key=$1 AND version_no=$2 FOR UPDATE',
          [p.agentKey, p.versionNo]);
        if (!ver.rows[0]) throw new DomainError('NOT_FOUND', `版本不存在: ${p.agentKey}@${p.versionNo}`, p.agentKey);
        await client.query('UPDATE ai_prompt_versions SET is_current=false WHERE agent_key=$1 AND is_current', [p.agentKey]);
        await client.query('UPDATE ai_prompt_versions SET is_current=true WHERE id=$1', [ver.rows[0].id]);
        target.status = 'adopted';
      } else {
        target.status = 'rejected'; // 被拒历史回喂下次反思输入（防同一建议反复提）
      }
      await client.query('UPDATE ai_reflections SET proposals=$2 WHERE id=$1', [p.reflectionId, JSON.stringify(proposals)]);
      return { reflectionId: p.reflectionId, agentKey: p.agentKey, versionNo: p.versionNo, status: target.status };
    });

    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.(); // 直实例化场景（测试/CLI）不吊住进程
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** 调度判定（导出供测试）：无历史=到期；窗口内零新消息=不跑 */
  async shouldRun(now: Date = new Date()): Promise<boolean> {
    const windowStart = new Date(now.getTime() - WINDOW_MS);
    const last = await query<{ last: Date | string }>(
      "SELECT COALESCE(max(created_at), '-infinity'::timestamptz) AS last FROM ai_reflections", []);
    const lastAt = new Date(last.rows[0]?.last ?? 0); // '-infinity' → Invalid Date → NaN 比较恒 false → 视为到期
    const due = !(lastAt.getTime() > windowStart.getTime());
    if (!due) return false;
    // 存在性探测（SELECT 1 LIMIT 1，比 count(*) 便宜——每小时跑一次）；窗口 < 半开与取样六路一致
    const hit = await query(
      'SELECT 1 FROM ai_messages WHERE created_at >= $1 AND created_at < $2 LIMIT 1',
      [windowStart.toISOString(), now.toISOString()]);
    return hit.rows.length > 0;
  }

  private async tick(): Promise<void> {
    if (this.running) return; // 在飞静默跳过：闸抛错留给手动 run，调度撞闸刷 console.error 是噪音
    try {
      if (await this.shouldRun()) await this.run('scheduled', SYS_CTX);
    } catch (e) {
      console.error(`[reflection] ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 主流程：并发闸 → 取样装配（事务外）→ provider.createSession({purpose:'reflection'})（事务外）
   *   → ai.reflect.run 落库（命令事务）→ 通知
   */
  async run(trigger: 'scheduled' | 'manual', ctx: CommandContext): Promise<{ reflectionId: string }> {
    if (this.running) throw new DomainError('INVALID_STATE', '已有反思任务进行中（终态后可再发起）', 'reflection');
    this.running = true;
    try {
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);
      const stats = await this.sample(windowStart, windowEnd);
      // 反思全局跨项目：projectId 仅作占位（pi 网关按 purpose 解析模型，不消费 projectId）
      const session = await this.provider.createSession({ projectId: 'system', purpose: 'reflection' });
      const prompt = `${REFLECT_SYSTEM}\n\n【取样窗口】${windowStart.toISOString()} ~ ${windowEnd.toISOString()}\n【取样数据】\n${JSON.stringify(stats)}`;
      const { deltas, result } = session.stream(prompt);
      const r = await this.awaitModel(session, deltas, result); // 看门狗包超时：静默挂起不致闸永真
      const parsed = parseReflectionOutput(r.text);
      if (!parsed.ok) throw new DomainError('VALIDATION_FAILED', `反思模型输出不可用：${parsed.reason}`, 'report');
      const proposals = normalizeProposals(parsed.value.proposals, windowEnd);
      const out = (await executeCommand('ai.reflect.run', {
        trigger,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        stats,
        report: parsed.value.report,
        proposals,
        modelId: r.modelId ?? null,
      }, ctx)) as { reflectionId: string };
      // 通知（§4 第四步）：落库已完成，通知失败不翻盘；零提案=本期无需调整（规格评审遗留修正）
      await this.notices?.emit(ctx, {
        type: 'ai.reflection.done', link: '/settings',
        text: proposals.length === 0
          ? '🪞 反思报告：本期无需调整'
          : `🪞 反思报告：${proposals.length} 条 Agent 改进提案待审`,
      }).catch((e) => console.warn(`[reflection] 通知发送失败（不影响落库）: ${e instanceof Error ? e.message : e}`));
      // 返回值收口（评审折入）：命令实值含 proposals 全文，HTTP 只下泄 reflectionId（防几百 KB 响应）
      return { reflectionId: out.reflectionId };
    } finally {
      this.running = false;
    }
  }

  /**
   * LLM 终态看门狗（评审折入，重要）：上游静默挂起会让 running 永真、调度器永久卡死——
   * Promise.race 30 分钟超时即 session.stop() 并抛 INVALID_STATE，run 的 finally 复位并发闸
   */
  private awaitModel(
    session: AiSession,
    deltas: AsyncIterable<string>,
    result: Promise<AiMessageResult>,
  ): Promise<AiMessageResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { session.stop(); } catch { /* stop 失败不遮蔽超时主错 */ }
        reject(new DomainError('INVALID_STATE', `反思 LLM 调用超时（${WATCHDOG_MIN} 分钟无终态），会话已终止`, 'reflection'));
      }, WATCHDOG_MS);
      timer.unref?.(); // 直实例化场景（测试/CLI）不吊住进程
    });
    const drain = (async () => {
      for await (const d of deltas) void d; // 反思只取终态全文，delta 排空即可
      return result;
    })();
    return Promise.race([drain, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** 提案处置入口（设置页 Agent 卡「反思提案」区；Task 6 端点接） */
  resolveProposal(
    input: { reflectionId: string; agentKey: string; versionNo: number; decision: 'adopt' | 'reject' },
    ctx: CommandContext,
  ): Promise<ReflectionResolveResult> {
    return executeCommand('ai.reflect.proposal.resolve', input, ctx) as Promise<ReflectionResolveResult>;
  }

  /** 历史列表（端点读）：缺省近 50 场计数视图；传 id 单取含 report 全文 + proposals 明细 + stats */
  async list(id?: string): Promise<{ items: ReflectionListItem[] } | ReflectionDetail> {
    if (id) {
      const r = await query<{
        id: string; trigger: string; window_start: string; window_end: string;
        stats: Record<string, unknown>; report: string;
        proposals: Array<{ agentKey: string; versionNo: number; summary: string; status: string }>;
        model_id: string | null; created_at: string;
      }>('SELECT * FROM ai_reflections WHERE id=$1', [id]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '反思场次不存在', id);
      const row = r.rows[0];
      return {
        ...toListItem(row, row.proposals),
        report: row.report, proposals: row.proposals, stats: row.stats,
      };
    }
    const r = await query<{
      id: string; trigger: string; window_start: string; window_end: string;
      proposals: Array<{ agentKey: string; versionNo: number; summary: string; status: string }>;
      model_id: string | null; created_at: string;
    }>(
      'SELECT id, trigger, window_start, window_end, proposals, model_id, created_at FROM ai_reflections ORDER BY created_at DESC LIMIT 50',
      []);
    return { items: r.rows.map((row) => toListItem(row, row.proposals)) };
  }

  /**
   * 取样装配（全项目跨域只读；事务外）：窗口内消息按 ctx/doc_kind 分组计数 + 补丁处置计数
   * + 工具调用计数/失败率 + 用量分组求和 + 被拒提案历史 + 对话原文采样（截断，统计全文保留）
   */
  private async sample(windowStart: Date, windowEnd: Date): Promise<Record<string, unknown>> {
    const params = [windowStart.toISOString(), windowEnd.toISOString()];
    const [byAgent, pendings, tools, usage, rejected, samples] = await Promise.all([
      query<{ ctx: string; doc_kind: string | null; n: string }>(
        `SELECT s.ctx, s.doc_kind, count(*) AS n
         FROM ai_messages m JOIN ai_sessions s ON s.id=m.session_id
         WHERE m.created_at >= $1 AND m.created_at < $2
         GROUP BY s.ctx, s.doc_kind ORDER BY n DESC`, params),
      query<{ domain: string; status: string; n: string }>(
        `SELECT 'req' AS domain, status, count(*) AS n FROM req_pendings
          WHERE created_at >= $1 AND created_at < $2 GROUP BY status
         UNION ALL
         SELECT 'design' AS domain, status, count(*) AS n FROM dsg_pendings
          WHERE created_at >= $1 AND created_at < $2 GROUP BY status`, params),
      query<{ tool_name: string; n: string; bad: string }>(
        `SELECT tool_name, count(*) AS n, count(*) FILTER (WHERE status<>'ok') AS bad
         FROM ai_tool_calls WHERE created_at >= $1 AND created_at < $2
         GROUP BY tool_name ORDER BY n DESC`, params),
      query<{ purpose: string; calls: string; tokens_in: string; tokens_out: string; cost: string }>(
        `SELECT purpose, count(*) AS calls, sum(tokens_in) AS tokens_in, sum(tokens_out) AS tokens_out, sum(cost) AS cost
         FROM ai_usage WHERE created_at >= $1 AND created_at < $2 GROUP BY purpose`, params),
      // 被拒历史回喂（REFLECT_SYSTEM 纪律：被拒方向不得再提）
      query<{ agent_key: string; summary: string }>(
        `SELECT e->>'agentKey' AS agent_key, e->>'summary' AS summary
         FROM ai_reflections r CROSS JOIN LATERAL jsonb_array_elements(r.proposals) e
         WHERE e->>'status' = 'rejected'
         ORDER BY r.created_at DESC LIMIT 50`, []),
      query<{ ctx: string; doc_kind: string | null; role: string; content: string; created_at: string }>(
        `SELECT s.ctx, s.doc_kind, m.role, left(m.content, 300) AS content, m.created_at
         FROM ai_messages m JOIN ai_sessions s ON s.id=m.session_id
         WHERE m.created_at >= $1 AND m.created_at < $2
         ORDER BY m.created_at DESC LIMIT ${SAMPLE_LIMIT}`, params),
    ]);
    return {
      window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      messagesByAgent: byAgent.rows,
      pendings: pendings.rows,
      toolCalls: tools.rows,
      usage: usage.rows,
      rejectedHistory: rejected.rows,
      samples: samples.rows,
    };
  }
}

/** 行 → 列表项映射：proposals 在 JS 侧按状态聚合计数（jsonb 行内数组，SQL 三趟 lateral 不如内存直数） */
function toListItem(
  row: { id: string; trigger: string; window_start: string; window_end: string; model_id: string | null; created_at: string },
  proposals: Array<{ status: string }>,
): ReflectionListItem {
  const counts = { pending: 0, adopted: 0, rejected: 0 };
  for (const p of proposals) {
    if (p.status === 'pending' || p.status === 'adopted' || p.status === 'rejected') counts[p.status] += 1;
  }
  return {
    id: row.id, trigger: row.trigger,
    windowStart: row.window_start, windowEnd: row.window_end,
    modelId: row.model_id, createdAt: row.created_at, counts,
  };
}

/** 容错抽取（template-draft 先例+未闭合尾围栏容错）：围栏优先 → 未闭合围栏兜底 → 首尾大括号兜底 */
function parseReflectionOutput(
  text: string,
): { ok: true; value: { report: string; proposals: unknown[] } } | { ok: false; reason: string } {
  let raw = /```json\s*\n([\s\S]*?)```/.exec(text)?.[1]?.trim() ?? '';
  if (!raw) raw = /```json\s*\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? ''; // 模型漏写收尾 ``` 时取开围栏后全文
  if (!raw) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) raw = text.slice(i, j + 1);
  }
  if (!raw) return { ok: false, reason: '未产出 JSON' };
  try {
    const j = JSON.parse(raw) as { report?: unknown; proposals?: unknown };
    if (typeof j.report !== 'string' || !j.report.trim()) return { ok: false, reason: 'report 缺失或为空' };
    if (j.proposals !== undefined && !Array.isArray(j.proposals)) return { ok: false, reason: 'proposals 须为数组' };
    return { ok: true, value: { report: j.report, proposals: (j.proposals as unknown[] | undefined) ?? [] } };
  } catch {
    return { ok: false, reason: 'JSON 不合法' };
  }
}

/** 提案归一化：名册外 agentKey/空全文跳过（warn 留痕）；name 缺省补「反思改进 yyyymmdd」；上限截断 */
function normalizeProposals(input: unknown[], windowEnd: Date): ReflectionProposalInput[] {
  const y = windowEnd.getFullYear();
  const stamp = `${y}${String(windowEnd.getMonth() + 1).padStart(2, '0')}${String(windowEnd.getDate()).padStart(2, '0')}`;
  const out: ReflectionProposalInput[] = [];
  for (const item of input) {
    if (out.length >= MAX_PROPOSALS) break;
    const p = item as Record<string, unknown>;
    const agentKey = typeof p.agentKey === 'string' ? p.agentKey.trim() : '';
    const fullText = typeof p.fullText === 'string' ? p.fullText.trim() : '';
    if (!agentKey || !fullText) {
      console.warn('[reflection] 提案缺 agentKey/fullText，已跳过');
      continue;
    }
    if (!DEFAULT_AGENT_MAP[agentKey]) {
      console.warn(`[reflection] 未知 agentKey「${agentKey}」（名册外），提案已跳过`);
      continue;
    }
    out.push({
      agentKey,
      name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `反思改进 ${stamp}`,
      summary: typeof p.summary === 'string' ? p.summary.trim() : '',
      fullText,
    });
  }
  return out;
}
