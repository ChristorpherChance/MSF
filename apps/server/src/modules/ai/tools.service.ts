import { Injectable, OnModuleInit } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import {
  findSectionByAnchor,
  splitSections,
  withNumberedTitles,
} from '../platform/doc-sections.js';
import { deriveNumbering } from '@msf/shared';
import { BAND_BUDGETS, type ContextBand } from './agent-prompts.js';

/**
 * ToolBridge 工具注册表（DSG-D08-3；A08-5/6；REQ-605/606/613）：
 * - 封闭注册表：未注册 TOOL_UNREGISTERED；参数校验失败 TOOL_ARGS_INVALID
 * - 越界工具（定稿/放行/写类）编排层直接拒绝：ai_tool_calls 记 denied + TOOL_DENIED（不执行、不转发）
 * - 允许集为只读/导航/提案七件套：nav.goto / read_context / doc.read / chat.history.read / propose_next_step / req.doc.propose_edits / design.doc.propose_edits（前五个 SQL 直读他域表，不写；两件提案经旁路产出高亮补丁，人工确认后生效）
 * - 一切调用经 ai.tool.invoke 命令：append-only 留痕（REQ-613）
 */

interface ToolDef {
  name: string;
  kind: 'read' | 'nav' | 'propose';
  description: string;
  /** JSON Schema 简式：required 键 + 各键类型 */
  argsSchema: Record<string, 'string' | 'number' | 'boolean'>;
  required: string[];
  /** opts.band（Task 3）：上下文分档经 ai.tool.invoke payload 逐跳透传（不走 args 防走私），
   *  doc.read 据此取 BAND_BUDGETS 截断阈值；缺省 wide=现状常量口径 */
  run: (client: PoolClient, projectId: string, args: Record<string, unknown>, opts?: { band?: ContextBand }) => Promise<Record<string, unknown>>;
}

/** 越界工具名单（定稿/放行/写类；出现在请求即 denied—— REQ-606 编排层拒绝） */
const WRITE_TOOLS = new Set([
  'doc.finalize', 'req.doc.finalize', 'design.prototype.finalize', 'test.release',
  'dev.plan.approve', 'tst.plan.approve', 'tst.report.finalize', 'dev.transfer.handoff',
  'file.write', 'shell.exec', 'git.push',
]);

const ROUTES: Record<string, string> = {
  material: '/material', req: '/req', design: '/design', proto: '/proto',
  dev: '/dev', test: '/test', delegate: '/delegate',
  // W2-053：任务中心/设置页同样可被助手打开（模型自主调用链补齐）
  tasks: '/tasks', settings: '/settings',
  // W3-007：RTM 子页签直达（助手承诺「查看 RTM」落对页签）
  rtm: '/req?tab=rtm',
};

const DOC_REQ_KINDS = new Set(['crd', 'prd']);
const DOC_DSG_KINDS = new Set(['hld', 'mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr']);

const TOOLS: ToolDef[] = [
  {
    name: 'nav.goto',
    kind: 'nav',
    // W4-003：枚举写进描述——模型此前不知道 rtm 可达，会把「打开 RTM」裁决成 /req 并误称无直达页签
    description: '跳转到指定页签，tab 可选：material|req|design|proto|dev|test|delegate|tasks|settings|rtm（RTM 需求矩阵直达）',
    argsSchema: { tab: 'string' },
    required: ['tab'],
    async run(_c, _p, args) {
      const tab = String(args['tab']);
      if (!(tab in ROUTES)) throw new DomainError('TOOL_ARGS_INVALID', `tab 枚举 ${Object.keys(ROUTES).join('|')}`, 'tab');
      return { route: ROUTES[tab] };
    },
  },
  {
    name: 'read_context',
    kind: 'read',
    description: '读取项目当前阶段状态摘要（各域 SQL 直读）',
    argsSchema: {},
    required: [],
    async run(client, projectId) {
      const one = async (sql: string) =>
        (await client.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? '0';
      return {
        materials: await one("SELECT count(*) AS n FROM mat_files WHERE project_id=$1 AND parse_status='content_final'"),
        reqDocsFinal: await one('SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND final_version_id IS NOT NULL'),
        designDocsFinal: await one('SELECT count(*) AS n FROM dsg_documents WHERE project_id=$1 AND final_version_id IS NOT NULL'),
        devTasks: await one('SELECT count(*) AS n FROM dev_tasks WHERE project_id=$1'),
        testBatches: await one('SELECT count(*) AS n FROM tst_batches WHERE project_id=$1'),
      };
    },
  },
  {
    name: 'doc.read',
    kind: 'read',
    // W5-001：助手此前读不到任何文档正文（read_context 只有计数），
    // 「PRD 哪一节承接 X / REQ-00n 原话」类高频诉求只能拒答；补只读正文通道。
    // 2026-10-04「5.1 看不到」根修：①草稿优先（与 UI getDoc 同口径——UI 展示草稿，只读 current_version
    // 会看不到用户刚改的）；②标题注入 UI 派生编号（withNumberedTitles——模型与界面共享编号坐标，
    // 「5.1 节」才有所指）；③anchor 定向读单节（截断不再切掉尾部章节）；④始终附 sections 章节清单
    description: '读取指定文档正文（与界面同口径：草稿优先、章节标题带界面编号）。args.kind：crd|prd 需求文档；hld|mod|alg|cls|db|api|ui|nfr 设计册；args.anchor 可选——章节编号（如「5.1」「第五章」）或标题/CR 编号，定向读单节；args.offset 可选——全文被截断时从第 N 字符续读（截断返回会给 nextOffset）。回答「文档里某条怎么写的/某节内容/哪一节承接某需求」类问题前调用',
    argsSchema: { kind: 'string', anchor: 'string', offset: 'number' },
    required: ['kind'],
    async run(client, projectId, args, opts) {
      const kind = String(args['kind']);
      const isReq = DOC_REQ_KINDS.has(kind);
      if (!isReq && !DOC_DSG_KINDS.has(kind)) {
        throw new DomainError('TOOL_ARGS_INVALID',
          `kind 枚举 ${[...DOC_REQ_KINDS, ...DOC_DSG_KINDS].join('|')}`, 'kind');
      }
      // doc.read 正文上限（字符）按上下文分档取预算（Task 3）：防爆模型上下文
      // （wide 12000=现状常量原位参数化；standard 8000；narrow 6000）
      const cap = BAND_BUDGETS[opts?.band ?? 'wide'].docRead;
      // SQL 直读他域表（与 read_context 同口径，只读）；草稿优先=与界面展示口径一致，附定稿/未提交态供模型如实表述
      const sql = isReq
        ? `SELECT v.version_no, COALESCE(dr.content, v.content) AS content,
                  d.final_version_id IS NOT NULL AS finalized, dr.id IS NOT NULL AS modified
           FROM req_documents d
           JOIN req_versions v ON v.id = d.current_version_id
           LEFT JOIN req_drafts dr ON dr.document_id = d.id
           WHERE d.project_id = $1 AND d.doc_kind = $2`
        : `SELECT v.version_no, COALESCE(dr.content, v.content) AS content,
                  d.final_version_id IS NOT NULL AS finalized, dr.id IS NOT NULL AS modified
           FROM dsg_documents d
           JOIN dsg_versions v ON v.id = d.current_version_id
           LEFT JOIN dsg_drafts dr ON dr.document_id = d.id
           WHERE d.project_id = $1 AND d.doc_kind = $2`;
      const r = await client.query<{
        version_no: number; content: string; finalized: boolean; modified: boolean;
      }>(sql, [projectId, kind]);
      const row = r.rows[0];
      if (!row) return { kind, found: false, message: '该文档尚未生成' };
      // 章节清单（始终附）：界面显示编号口径，截断/定向读时模型据此自助定位
      const secs = splitSections(row.content);
      const disp = new Map(deriveNumbering(secs).map((n) => [n.id, n.display]));
      const all = secs.filter((s) => s.title !== '').map((s) => disp.get(s.id) || s.title);
      const sections = all.length > 60 ? [...all.slice(0, 60), `…（共 ${all.length} 节）`] : all;
      const base = {
        kind, found: true, finalized: row.finalized, versionNo: row.version_no,
        modified: row.modified, sections,
      };
      // anchor 定向读：编号/章序/标题/锚点码统一走 findSectionByAnchor（与补丁定位同族口径）
      const anchor = typeof args['anchor'] === 'string' ? args['anchor'].trim() : '';
      if (anchor) {
        const idx = findSectionByAnchor(anchor, secs);
        if (idx < 0) {
          return { ...base, anchor, anchorFound: false, message: `未找到「${anchor}」对应章节（可用章节见 sections）` };
        }
        const s = secs[idx]!;
        const title = disp.get(s.id) || s.title;
        const cut = s.md.length > cap;
        return {
          ...base, anchor, anchorFound: true, sectionTitle: title,
          truncated: cut,
          content: `${title ? `## ${title}\n\n` : ''}${cut ? `${s.md.slice(0, cap)}\n…（节内截断，全文共 ${s.md.length} 字）` : s.md}`,
        };
      }
      // 全文读：标题注入界面派生编号（「5.1 节」类指代据此可答）；
      // offset 分页续读（截断返回 nextOffset，模型可接力拿齐全文——整篇重写前的取齐通道）
      const numbered = withNumberedTitles(row.content);
      const offset = Math.max(0, Math.trunc(Number(args['offset'] ?? 0) || 0));
      if (offset >= numbered.length && numbered.length > 0) {
        return { ...base, offset, truncated: false, content: '', message: `offset ${offset} 已超全文末尾（全文共 ${numbered.length} 字）` };
      }
      const slice = numbered.slice(offset, offset + cap);
      const next = offset + cap;
      const truncated = next < numbered.length;
      return {
        ...base,
        offset,
        truncated,
        ...(truncated ? { nextOffset: next } : {}),
        content: truncated
          ? `${slice}\n…（截断，全文共 ${numbered.length} 字；用 offset=${next} 续读，或用 anchor 参数按章节定向读取，章节清单见 sections）`
          : slice,
      };
    },
  },
  {
    name: 'chat.history.read',
    kind: 'read',
    // 跨阶段互通深读通道：摘要块只有最近 2 条用户消息，需要细节时模型按会话编号自主深读
    description: '读取本项目其它阶段会话的最近消息（跨阶段读侧互通）。args.sessionCode 为会话编号（如 ss_3，见【他阶段会话】块）；limit 默认 20 封顶 50。当需要了解客户在其它阶段聊过的细节时调用',
    argsSchema: { sessionCode: 'string', limit: 'number' },
    required: ['sessionCode'],
    async run(client, projectId, args) {
      const code = String(args['sessionCode']);
      // Math.trunc：limit 小数直传会被 PG 拒（LIMIT 只收整型）
      const limit = Math.min(50, Math.max(1, Math.trunc(Number(args['limit'] ?? 20) || 20)));
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
  {
    name: 'propose_next_step',
    kind: 'read',
    description: 'next-steps 规则引擎：按项目状态给出下一步建议',
    argsSchema: {},
    required: [],
    async run(client, projectId) {
      const has = async (sql: string) =>
        Number((await client.query<{ n: string }>(sql, [projectId])).rows[0]?.n ?? 0) > 0;
      const suggestions: string[] = [];
      if (!(await has("SELECT count(*) AS n FROM mat_files WHERE project_id=$1 AND parse_status='content_final'"))) {
        suggestions.push('上传并内容定稿至少一份参考输入（资料页）');
      }
      if (!(await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='crd' AND final_version_id IS NOT NULL"))) {
        suggestions.push('完成 CRD 定稿（需求页）');
      } else if (!(await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='prd' AND final_version_id IS NOT NULL"))) {
        suggestions.push('完成 PRD 定稿（需求页；门禁 L0a≥0.95 且 L0b=1）');
      }
      if (await has("SELECT count(*) AS n FROM req_documents WHERE project_id=$1 AND doc_kind='prd' AND final_version_id IS NOT NULL")
        && !(await has("SELECT count(*) AS n FROM dsg_documents WHERE project_id=$1 AND doc_kind='hld' AND final_version_id IS NOT NULL"))) {
        suggestions.push('生成并定稿 HLD（设计页）');
      }
      if (suggestions.length === 0) suggestions.push('按阶段推进：设计→开发→测试交接');
      return { suggestions };
    },
  },
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
  {
    name: 'design.doc.propose_edits',
    kind: 'propose', // 同 req.doc.propose_edits：提案型写，产物=设计册待确认高亮补丁，必经人工确认
    description: '提交设计八册（hld/mod/alg/cls/db/api/ui/nfr）修改建议：产出待确认高亮补丁，经用户在设计页逐条/批量确认后才生效（你不直接改文档）。当用户要求修改设计册内容、或核对发现册内容缺口需要补齐时调用。args.instruction 描述要改什么（截 2000 字）',
    argsSchema: { kind: 'string', instruction: 'string' },
    required: ['kind', 'instruction'],
    async run() {
      return { ok: false, reason: 'propose 类工具须经会话流旁路执行（旁路未接线），本次未产生任何修改' };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

@Injectable()
export class AiToolsService implements OnModuleInit {
  onModuleInit(): void {
    registerCommand('ai.tool.invoke', async (client, payload, ctx) => {
      const p = payload as {
        sessionId?: string; messageId?: string; toolName?: string; args?: Record<string, unknown>;
        /** 上下文分档（Task 3）：编排层逐跳透传（payload 显式字段，不走 args 走私）；白名单收口，非法值=wide */
        band?: ContextBand;
      };
      if (!p.toolName) throw new DomainError('TOOL_ARGS_INVALID', 'toolName 必填', 'toolName');
      // 判别式结果：denied/unregistered/args_invalid 均先落 ai_tool_calls 再返回，
      // 由门面抛错——命令内抛错会回滚留痕行（REQ-606/613 要求拒绝也留痕）
      if (WRITE_TOOLS.has(p.toolName)) {
        await this.record(client, p, 'denied', { reason: '越界工具（写/定稿/放行类），编排层拒绝' });
        return { outcome: 'denied' as const, tool: p.toolName };
      }
      const tool = byName.get(p.toolName);
      if (!tool) {
        await this.record(client, p, 'denied', { reason: '未注册工具' });
        return { outcome: 'unregistered' as const, tool: p.toolName };
      }
      const args = p.args ?? {};
      const bad = (key: string, msg: string) => ({ outcome: 'args_invalid' as const, tool: tool.name, key, msg });
      for (const key of tool.required) {
        if (args[key] === undefined) {
          const r = bad(key, `缺参数 ${key}`);
          await this.record(client, p, 'failed', { error: r.msg });
          return r;
        }
      }
      for (const [key, ty] of Object.entries(tool.argsSchema)) {
        if (args[key] !== undefined && typeof args[key] !== ty) {
          const r = bad(key, `参数 ${key} 须为 ${ty}`);
          await this.record(client, p, 'failed', { error: r.msg });
          return r;
        }
      }
      try {
        const band: ContextBand = p.band === 'standard' || p.band === 'narrow' ? p.band : 'wide';
        const result = await tool.run(client, ctx.projectId!, args, { band });
        await this.record(client, p, 'ok', result);
        return { outcome: 'ok' as const, tool: tool.name, result };
      } catch (e) {
        if (e instanceof DomainError && e.code === 'TOOL_ARGS_INVALID') {
          await this.record(client, p, 'failed', { error: e.message });
          return { outcome: 'args_invalid' as const, tool: tool.name, key: e.target ?? 'args', msg: e.message };
        }
        throw e; // 真异常整体回滚（审计失败零写口径）
      }
    });
  }

  private async record(
    client: PoolClient,
    p: { sessionId?: string; messageId?: string; toolName?: string; args?: Record<string, unknown> },
    status: 'ok' | 'denied' | 'failed',
    result: Record<string, unknown>,
  ): Promise<void> {
    // session_id 列 NOT NULL：有会话落行；无会话调用仅以命令审计留痕
    if (!p.sessionId) return;
    // W2-053：message_id 挂接——工具卡随消息渲染（AiContent 按 message.toolCalls 聚合）的前提
    await client.query(
      'INSERT INTO ai_tool_calls (session_id, message_id, tool_name, args, result_summary, status) VALUES ($1,$2,$3,$4,$5,$6)',
      [p.sessionId, p.messageId ?? null, p.toolName, JSON.stringify(p.args ?? {}), JSON.stringify(result), status]);
  }

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

  /** 注册表元数据（A08-5 工具清单展示） */
  list() {
    return {
      tools: TOOLS.map((t) => ({ name: t.name, kind: t.kind, description: t.description })),
      denied: [...WRITE_TOOLS],
    };
  }

  async invoke(
    projectId: string,
    p: { sessionId?: string; messageId?: string; toolName: string; args?: Record<string, unknown>; band?: ContextBand },
    ctx: CommandContext,
  ): Promise<{ tool: string; result: Record<string, unknown> }> {
    const r = await executeCommand('ai.tool.invoke', p, { ...ctx, projectId }) as
      | { outcome: 'ok'; tool: string; result: Record<string, unknown> }
      | { outcome: 'denied' | 'unregistered'; tool: string }
      | { outcome: 'args_invalid'; tool: string; key: string; msg: string };
    if (r.outcome !== 'ok') {
      if (r.outcome === 'denied') {
        throw new DomainError('TOOL_DENIED', `工具 ${r.tool} 越界：定稿/放行/写类不可经助手触发`, r.tool);
      }
      if (r.outcome === 'unregistered') {
        throw new DomainError('TOOL_UNREGISTERED', `工具未注册: ${r.tool}`, r.tool);
      }
      const bad = r as { outcome: 'args_invalid'; tool: string; key: string; msg: string };
      throw new DomainError('TOOL_ARGS_INVALID', bad.msg, bad.key);
    }
    return { tool: r.tool, result: r.result };
  }

  /** 会话工具调用历史（A08-6 工具卡） */
  async callsOfSession(projectId: string, sessionId: string) {
    const s = await query<{ project_id: string }>('SELECT project_id FROM ai_sessions WHERE id=$1', [sessionId]);
    if (!s.rows[0]) throw new DomainError('NOT_FOUND', '会话不存在', sessionId);
    if (s.rows[0].project_id !== projectId) throw new DomainError('FORBIDDEN', '会话不属本项目', sessionId);
    const r = await query<{
      id: string; tool_name: string; args: unknown; result_summary: unknown;
      status: string; created_at: string;
    }>(
      'SELECT id, tool_name, args, result_summary, status, created_at FROM ai_tool_calls WHERE session_id=$1 ORDER BY created_at DESC LIMIT 100',
      [sessionId]);
    return { items: r.rows };
  }
}
