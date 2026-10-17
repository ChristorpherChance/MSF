import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { AI_PROVIDER, type AiProvider, type AiSession } from '../ai/ai-provider.interface.js';
import { classifyAiError, isRetryableStreamCut, sanitizeAiError } from '../ai/stream-pipeline.js';
import { registerExternalTool } from '../platform/external-tools.js';
import { StorageService } from '../platform/storage.service.js';
import { DesignDocsService } from './docs.service.js';
import {
  PAGE_INPUT_CAP,
  assertScopedStyles,
  buildMockPage,
  buildPagePrompt,
  ensureNavScript,
  ensureThemeStyle,
  extractPageParts,
  findDataNavProblem,
  findHiddenSectionRule,
  pickUiSections,
  type CatalogItemLike,
} from './prototype-pages.js';

/**
 * 页级 UI 原型生成（单页 AI 生成→MinIO 内容寻址→dsg_prototype_pages 索引；差异登记，待 13 册回补）。
 * 分工纪律（同 design/generate.service）：AI 流式全在命令事务外；命令 design.prototype.page_generate
 * 只做 upsert 索引行+审计，命令内 FOR UPDATE 再断言未定稿堵 TOCTOU。
 * 门禁（域内，与 design.prototype.generate 同口径）：PLAN_REQUIRED/PLAN_STALE/页归属 plan 目录/PROTOTYPE_FINALIZED。
 * v1：一次性 SSE，客户端断连即 abort（无 pause/resume，不引入持久 gen_state）。
 */

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
/** 单页 HTML 上限（与 upload 5MB 口径呼应，页粒度收紧） */
const PAGE_HTML_CAP = 1024 * 1024;
const PROTO_HTML_CT = 'text/html; charset=utf-8';

interface PageGenOp {
  id: string;
  projectId: string;
  pageCode: string;
  catalogVersion: string;
  status: 'running' | 'stopped' | 'done' | 'failed';
  page: CatalogItemLike;
  states: CatalogItemLike[];
  anchors: Array<{ docKind: string | null; sectionId: string | null; anchor: string | null }>;
  prd: string;
  /** UI 册正文节选（页面相关章节优先，覆盖检测 §2；无 ui 册/无章节时为空串不注入） */
  ui: string;
  /** 目录页面全集（覆盖检测 §3：data-nav 契约校验目标集 + prompt 合法跳转清单 + mock 穿流按钮） */
  catalogPages: Array<{ code: string; title: string }>;
  instruction: string;
  /** 真接模式保留会话句柄（abort 用） */
  session?: AiSession | undefined;
  /** A6 usage 归因：dock 对话提案触发的生成挂回触发会话/消息（与 proposeEditsFromChat 同口径） */
  attribution?: { sessionId?: string; messageId?: string } | undefined;
}

/** preparePage 产物：门禁通过后的页生成上下文（start 与对话提案 proposeFromChat 同源共用） */
interface PageContext {
  catalogVersion: string;
  page: CatalogItemLike;
  states: CatalogItemLike[];
  anchors: Array<{ docKind: string | null; sectionId: string | null; anchor: string | null }>;
  prd: string;
  ui: string;
  catalogPages: Array<{ code: string; title: string }>;
}

const ops = new Map<string, PageGenOp>();

@Injectable()
export class PrototypePagesService {
  constructor(
    @Inject(DesignDocsService) private readonly docs: DesignDocsService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  onModuleInit(): void {
    // 页原型 upsert：命令内只做索引行写+未定稿再断言（AI/对象写全在命令外完成）
    registerCommand('design.prototype.page_generate', async (client, payload, ctx) => {
      const { projectId, pageCode, catalogVersion, objectKey, fingerprint, source } = payload as {
        projectId: string; pageCode: string; catalogVersion: string;
        objectKey: string; fingerprint: string; source: string;
      };
      // TOCTOU 兜底：drive 期间可能已定稿——定稿后页重生成会产生「最新页≠已定稿基线」的无信号漂移
      const doc = await client.query<{ final_version_id: string | null; current_version_id: string | null }>(
        "SELECT final_version_id, current_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype' FOR UPDATE",
        [projectId]);
      const d = doc.rows[0];
      if (d?.final_version_id && d.final_version_id === d.current_version_id) {
        throw new DomainError('GATE_BLOCKED', '原型已定稿，页级重生成须先解除定稿', 'prototype', {
          issues: [{ code: 'PROTOTYPE_FINALIZED', message: '原型已定稿，先解锁', target: pageCode }],
        });
      }
      await client.query(
        `INSERT INTO dsg_prototype_pages (project_id, page_code, catalog_version, object_key, html_fingerprint, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, page_code) DO UPDATE
         SET catalog_version=$3, object_key=$4, html_fingerprint=$5, source=$6, updated_at=now()`,
        [projectId, pageCode, catalogVersion, objectKey, fingerprint, source, ctx.actorId],
      );
      return { pageCode, fingerprint };
    });
    // 对话提案登记（0032）：提案 HTML 已在命令外生成+入对象库，命令内只插 pending 行；
    // 部分唯一索引兜底并发重复提案（23505 → 人话 DomainError）
    registerCommand('design.prototype.page_propose', async (client, payload, ctx) => {
      const p = payload as {
        projectId: string; pageCode: string; catalogVersion: string;
        objectKey: string; fingerprint: string; instruction: string; source: string;
        sessionId?: string; messageId?: string;
      };
      try {
        const r = await client.query<{ id: string }>(
          `INSERT INTO dsg_proto_page_proposals
             (project_id, page_code, catalog_version, object_key, html_fingerprint, instruction, source, session_id, message_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [p.projectId, p.pageCode, p.catalogVersion, p.objectKey, p.fingerprint, p.instruction, p.source,
           p.sessionId ?? null, p.messageId ?? null, ctx.actorId],
        );
        return { proposalId: r.rows[0]!.id };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new DomainError('INVALID_STATE', '该页已有一条待处置的修改提案，请先采用或放弃', p.pageCode);
        }
        throw e;
      }
    });
    // 提案处置（0032）：accept=提案对象提升为页工件行（upsert 语义同 page_generate）+ 提案标 accepted；
    // discard=标 discarded。两路都 FOR UPDATE 锁提案行防并发双处置；accept 再断言未定稿+目录版本未漂移
    registerCommand('design.prototype.page_proposal_decide', async (client, payload, ctx) => {
      const { projectId, proposalId, decision } = payload as {
        projectId: string; proposalId: string; decision: 'accept' | 'discard';
      };
      const r = await client.query<{
        id: string; page_code: string; catalog_version: string; object_key: string;
        html_fingerprint: string; source: string; status: string;
      }>(
        'SELECT * FROM dsg_proto_page_proposals WHERE id=$1 AND project_id=$2 FOR UPDATE',
        [proposalId, projectId]);
      const row = r.rows[0];
      if (!row) throw new DomainError('NOT_FOUND', '提案不存在', proposalId);
      if (row.status !== 'pending') throw new DomainError('INVALID_STATE', '提案已处置过，请刷新页面', proposalId);
      if (decision === 'discard') {
        await client.query(
          "UPDATE dsg_proto_page_proposals SET status='discarded', decided_at=now() WHERE id=$1",
          [proposalId]);
        return { pageCode: row.page_code, decision };
      }
      // accept 门禁：定稿后不得改页工件；目录版本漂移（提案生成后 re-plan/目录增删改）则提案失效
      const doc = await client.query<{ final_version_id: string | null; current_version_id: string | null }>(
        "SELECT final_version_id, current_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype' FOR UPDATE",
        [projectId]);
      const d = doc.rows[0];
      if (d?.final_version_id && d.final_version_id === d.current_version_id) {
        throw new DomainError('GATE_BLOCKED', '原型已定稿，采用提案须先解除定稿', 'prototype', {
          issues: [{ code: 'PROTOTYPE_FINALIZED', message: '原型已定稿，先解锁', target: row.page_code }],
        });
      }
      const plan = await client.query<{ catalog_version: string }>(
        'SELECT catalog_version FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
      if (!plan.rows[0] || plan.rows[0].catalog_version !== row.catalog_version) {
        throw new DomainError('GATE_BLOCKED', '提案依据的目录版本已变化（目录有增删改/重规划），请放弃后重新提案', 'prototype', {
          issues: [{ code: 'PLAN_STALE', message: '目录版本已变化，提案失效', target: row.page_code }],
        });
      }
      await client.query(
        `INSERT INTO dsg_prototype_pages (project_id, page_code, catalog_version, object_key, html_fingerprint, source, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (project_id, page_code) DO UPDATE
         SET catalog_version=$3, object_key=$4, html_fingerprint=$5, source=$6, updated_at=now()`,
        [projectId, row.page_code, row.catalog_version, row.object_key, row.html_fingerprint, row.source, ctx.actorId],
      );
      await client.query(
        "UPDATE dsg_proto_page_proposals SET status='accepted', decided_at=now() WHERE id=$1",
        [proposalId]);
      return { pageCode: row.page_code, decision, fingerprint: row.html_fingerprint };
    });
    // 对话改原型页旁路（与 design.doc.propose_edits 同构）：嵌套 LLM 绝不在命令事务内跑——外部注册表旁路。
    // 产物=待处置提案（不落页工件行），人工「✓ 采用 / ✗ 放弃」后才生效——AI 只提不判纪律不破
    registerExternalTool('design.proto.propose_page', async (projectId, call, ctx) => {
      const pageCode = String(call.args['pageCode'] ?? '').trim();
      if (!pageCode) return { ok: false, reason: 'pageCode 必填（目录页面编号，如 P-001）' };
      const instruction = String(call.args['instruction'] ?? '').trim();
      if (!instruction) return { ok: false, reason: 'instruction 必填（描述这页要改什么）' };
      return this.proposeFromChat(projectId, pageCode, instruction, ctx, {
        ...(call.sessionId !== undefined && call.sessionId !== null ? { sessionId: call.sessionId } : {}),
        ...(call.messageId !== undefined && call.messageId !== null ? { messageId: call.messageId } : {}),
      });
    });
  }

  /** 门禁+数据装载（start/proposeFromChat 同源）：plan 完整未 stale + 页归属 plan 目录 + 未定稿 + instruction 上限 */
  private async preparePage(projectId: string, pageCode: string, instruction: string): Promise<PageContext> {
    // 「✏️ 按意见调整」/对话提案共用入口：截断上限防爆 prompt
    if (instruction.length > 1000) {
      throw new DomainError('VALIDATION_FAILED', '修改意见过长（上限 1000 字）', 'instruction');
    }
    const plan = await query<{ catalog_version: string; complete: boolean; governing_fingerprint: string }>(
      'SELECT * FROM dsg_plans WHERE project_id=$1 ORDER BY plan_no DESC LIMIT 1', [projectId]);
    const p = plan.rows[0];
    if (!p || !p.complete) throw new DomainError('GATE_BLOCKED', '尚无完整原型规划，先执行规划', 'prototype', {
      issues: [{ code: 'PLAN_REQUIRED', message: '尚无原型规划，先执行规划' }],
    });
    const up = await this.docs.upstreamFingerprint(null, projectId, 'prd');
    if (!up.ok || p.governing_fingerprint !== up.fingerprint) {
      throw new DomainError('GATE_BLOCKED', '规划依据（上游定稿）已变化，须重新规划', 'prototype', {
        issues: [{ code: 'PLAN_STALE', message: '规划依据（上游定稿）已变化，须重新规划' }],
      });
    }
    const items = await query<{ item_type: string; code: string; payload: Record<string, unknown> }>(
      'SELECT item_type, code, payload FROM dsg_catalog_items WHERE project_id=$1 AND catalog_version=$2 ORDER BY item_type, code',
      [projectId, p.catalog_version]);
    const page = items.rows.find((i) => i.item_type === 'page' && i.code === pageCode);
    if (!page) throw new DomainError('NOT_FOUND', '页面不在当前规划目录中', pageCode);
    const states = items.rows.filter((i) => i.item_type === 'state');
    const doc = await query<{ final_version_id: string | null; current_version_id: string | null }>(
      "SELECT final_version_id, current_version_id FROM dsg_documents WHERE project_id=$1 AND doc_kind='prototype'",
      [projectId]);
    const d = doc.rows[0];
    if (d?.final_version_id && d.final_version_id === d.current_version_id) {
      throw new DomainError('GATE_BLOCKED', '原型已定稿，页级重生成须先解除定稿', 'prototype', {
        issues: [{ code: 'PROTOTYPE_FINALIZED', message: '原型已定稿，先解锁', target: pageCode }],
      });
    }
    // 锚点 + PRD 定稿（页面内容 grounded，与文档生成 #11 同口径）
    const anchors = await query<{ doc_kind: string | null; section_id: string | null; anchor: string | null }>(
      `SELECT r.doc_kind, r.section_id, r.anchor FROM dsg_catalog_refs r
       JOIN dsg_catalog_items i ON i.id=r.item_id
       WHERE i.project_id=$1 AND i.catalog_version=$2 AND i.item_type='page' AND i.code=$3
       ORDER BY r.ref_kind, r.doc_kind, r.section_id`,
      [projectId, p.catalog_version, pageCode]);
    const prdRow = await query<{ content: string }>(
      `SELECT v.content FROM req_documents d JOIN req_versions v ON v.id=d.final_version_id
       WHERE d.project_id=$1 AND d.doc_kind='prd'`, [projectId]);
    const prdRaw = prdRow.rows[0]?.content ?? '';
    const prd = prdRaw.length > PAGE_INPUT_CAP ? `${prdRaw.slice(0, PAGE_INPUT_CAP)}\n\n[原文过长，已截断]` : prdRaw;
    // UI 册正文注入（覆盖检测 §2）：当前版本按页相关章节节选，上限同 PRD 口径。
    // M-1 口径钉死（三面有意不对称）：plan 读 ui 册【定稿】版本（页面种子/refs 须锚定已批准基线），
    // 注入/check 双向/时间基滞后读【当前】版本（尽早暴露已提交未定稿的变更）——滞后判定正是两面之桥。
    const uiRow = await query<{ content: string }>(
      `SELECT v.content FROM dsg_documents d JOIN dsg_versions v ON v.id=d.current_version_id
       WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
    const ui = pickUiSections(uiRow.rows[0]?.content ?? '', page);
    return {
      catalogVersion: p.catalog_version, page, states,
      anchors: anchors.rows.map((a) => ({ docKind: a.doc_kind, sectionId: a.section_id, anchor: a.anchor })),
      prd, ui,
      // 目录页面全集（§3 穿流）：data-nav 校验目标集 + prompt 合法跳转清单 + mock 穿流按钮
      catalogPages: items.rows
        .filter((i) => i.item_type === 'page')
        .map((i) => ({ code: i.code, title: (i.payload.title as string) ?? i.code })),
    };
  }

  /** 启动单页生成（门禁：plan 完整未 stale + 页归属 plan 目录 + 未定稿 + 并发去重） */
  async start(projectId: string, pageCode: string, instruction: string, ctx: CommandContext): Promise<{ operationId: string; source: 'model' | 'mock' }> {
    void ctx;
    const pc = await this.preparePage(projectId, pageCode, instruction);
    const running = [...ops.values()].find((o) => o.projectId === projectId && o.pageCode === pageCode && o.status === 'running');
    if (running) throw new DomainError('INVALID_STATE', '已有进行中的生成', running.id);

    const operationId = `op_pgen_${randomBytes(6).toString('hex')}`;
    ops.set(operationId, {
      id: operationId, projectId, pageCode, catalogVersion: pc.catalogVersion, status: 'running',
      page: pc.page, states: pc.states, anchors: pc.anchors, prd: pc.prd, ui: pc.ui,
      catalogPages: pc.catalogPages, instruction,
    });
    return { operationId, source: this.ai?.kind === 'pi' ? 'model' : 'mock' };
  }

  /** 客户端断连 abort（v1 无 pause/resume） */
  abort(operationId: string): void {
    const op = ops.get(operationId);
    if (op && op.status === 'running') {
      op.status = 'stopped';
      op.session?.stop();
      ops.delete(operationId);
    }
  }

  /** 驱动生成流：mock 降级整页分块吐出；真接走 AI_PROVIDER 流式→契约校验→内容寻址入库 */
  async drive(
    operationId: string,
    ctx: CommandContext,
    onDelta: (text: string) => void,
    onNotice?: (msg: string) => void,
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; fingerprint?: string; error?: string; errorMessage?: string }> {
    const op = ops.get(operationId);
    if (!op) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    try {
      const html = this.ai?.kind === 'pi'
        ? await this.driveReal(op, onDelta, onNotice)
        : await this.driveMock(op, onDelta);
      if (html === null) {
        // null=被 abort 中止（op.status 为共享可变态，await 期间可能已被改写——绕开控制流收窄再判）
        const st: string = op.status;
        return { status: st === 'stopped' ? 'stopped' : 'failed', error: 'INTERNAL' };
      }
      const fin = await this.persist(op, html, this.ai?.kind === 'pi' ? 'model' : 'mock', ctx);
      ops.delete(operationId);
      return { status: 'done', fingerprint: fin };
    } catch (e) {
      ops.delete(operationId);
      if (e instanceof DomainError) return { status: 'failed', error: e.code, errorMessage: e.message };
      const raw = e instanceof Error ? e.message : String(e);
      console.error(`[design] page generate failed op=${operationId}: ${raw}`);
      return { status: 'failed', error: classifyAiError(raw), errorMessage: sanitizeAiError(raw) };
    }
  }

  /** mock 降级：整页 mock HTML 分块吐出（结构与真接同契约，source='mock' 可辨识；穿流按钮=目录其它页面） */
  private async driveMock(op: PageGenOp, onDelta: (text: string) => void): Promise<string | null> {
    const html = buildMockPage(op.page, op.states, op.catalogPages);
    for (let i = 0; i < html.length; i += 240) {
      if (op.status === 'stopped') return null;
      onDelta(html.slice(i, i + 240));
      await sleep(10);
    }
    return html;
  }

  /**
   * 真接驱动：流式生成 → 契约校验（envelope/属性标记/scoped 样式/体积）→ 失败带修正指示重试一次。
   * 传输层断流自动重试（总上限 2 次，跨契约尝试共享计数；2026-10-09 公网实机：上游偶发
   * closed before response.completed，重试即过），重试经 onNotice 发 stream.notice 不静默。
   */
  private async driveReal(op: PageGenOp, onDelta: (text: string) => void, onNotice?: (msg: string) => void): Promise<string | null> {
    const t0 = Date.now();
    let lastProblem = '';
    let transportRetries = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const prompt = buildPagePrompt(
        op.page, op.states, op.anchors, op.prd, op.ui, op.instruction,
        op.catalogPages.filter((x) => x.code !== op.pageCode), // 穿流合法目标=目录其它页面
      ) + (attempt === 1 ? `\n\n上次输出不合规（${lastProblem}），本次务必逐条满足输出契约。` : '');
      try {
        const session = await this.ai!.createSession({ projectId: op.projectId, purpose: 'generation' });
        op.session = session;
        const { deltas, result } = session.stream(prompt);
        for await (const d of deltas) {
          if (op.status === 'stopped') { session.stop(); return null; }
          onDelta(d);
        }
        if (op.status === 'stopped') { session.stop(); return null; }
        const res = await result;
        // op 为共享可变态（abort 由外部改写），await 期间可能已被停止——绕开 TS 控制流收窄再判
        const afterResult: string = op.status;
        if (afterResult === 'stopped') return null;
        if (res.modelId) {
          await executeCommand('ai.usage.record', {
            projectId: op.projectId, modelId: res.modelId, purpose: 'generation',
            tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens,
            durationMs: Date.now() - t0, cost: res.usage.cost ?? 0,
            ...(op.attribution?.sessionId !== undefined ? { sessionId: op.attribution.sessionId } : {}),
            ...(op.attribution?.messageId !== undefined ? { messageId: op.attribution.messageId } : {}),
          }, { projectId: op.projectId, actorKind: 'assistant', actorId: 'pi' });
        }
        const problem = validatePageHtml(res.text, op);
        if (!problem) return ensureNavScript(ensureThemeStyle(res.text)); // NAV_SCRIPT+风格基线属系统协议层，入库前确定性补齐（幂等）
        lastProblem = problem;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        if (op.status !== 'stopped' && transportRetries < 2 && isRetryableStreamCut(raw)) {
          transportRetries += 1;
          attempt -= 1; // 断流不消耗契约修正机会
          console.warn(`[design] page stream cut, auto-retry ${transportRetries}/2 op=${op.id}: ${sanitizeAiError(raw)}`);
          onNotice?.('上游连接中断，已自动重试');
          continue;
        }
        throw e;
      }
    }
    throw new DomainError('VALIDATION_FAILED', `生成产物不符合页面契约（${lastProblem}），请重试`, op.pageCode);
  }

  /** 入库：内容寻址写对象 → 命令 upsert 索引行（先对象后命令，索引行永不指向缺失对象） */
  private async persist(op: PageGenOp, html: string, source: 'model' | 'mock', ctx: CommandContext): Promise<string> {
    const fp = sha256(html);
    const up = await this.storage.putContentAddressed(Buffer.from(html, 'utf8'));
    await executeCommand('design.prototype.page_generate', {
      projectId: op.projectId, pageCode: op.pageCode, catalogVersion: op.catalogVersion,
      objectKey: up.objectKey, fingerprint: fp, source,
    }, { ...ctx, projectId: op.projectId });
    return fp;
  }

  // ---------- 对话提案通道（0032：AI 只提不判——提案暂存 dsg_proto_page_proposals，人工采用才落页工件） ----------

  /**
   * dock design.proto.propose_page 旁路 handler：门禁同源 preparePage → 非 SSE 内部调用生成提案页
   * → 契约校验（driveReal 内）→ 对象库 → page_propose 命令落 pending 行。守卫失败/已有 pending
   * 提案/AI 零产出一律 { ok:false, reason 人话 }（不落码）。
   */
  async proposeFromChat(
    projectId: string,
    pageCode: string,
    instruction: string,
    ctx: CommandContext,
    attribution?: { sessionId?: string; messageId?: string },
  ): Promise<{ ok: boolean; proposalId?: string; pageCode?: string; fingerprint?: string; route?: string; reason?: string }> {
    let pc: PageContext;
    try {
      pc = await this.preparePage(projectId, pageCode, instruction);
    } catch (e) {
      return { ok: false, reason: e instanceof DomainError ? e.message : '提案前置检查失败' };
    }
    const pend = await query<{ n: string }>(
      "SELECT count(*) AS n FROM dsg_proto_page_proposals WHERE project_id=$1 AND page_code=$2 AND status='pending'",
      [projectId, pageCode]);
    if (Number(pend.rows[0]?.n ?? 0) > 0) {
      return { ok: false, reason: `页面 ${pageCode} 已有一条待处置的修改提案，请先在原型页「✓ 采用 / ✗ 放弃」后再提` };
    }
    const source: 'model' | 'mock' = this.ai?.kind === 'pi' ? 'model' : 'mock';
    let html: string;
    if (source === 'model') {
      // 伪 op 复用 driveReal（契约校验+断流重试一体）：不进 ops 表（无 SSE/abort 通道），status 恒 running
      const op: PageGenOp = {
        id: `op_pprop_${randomBytes(6).toString('hex')}`, projectId, pageCode,
        catalogVersion: pc.catalogVersion, status: 'running',
        page: pc.page, states: pc.states, anchors: pc.anchors, prd: pc.prd, ui: pc.ui,
        catalogPages: pc.catalogPages, instruction, attribution,
      };
      try {
        const out = await this.driveReal(op, () => undefined);
        if (out === null) return { ok: false, reason: '生成被中断，请重试' };
        html = out;
      } catch (e) {
        const raw = e instanceof Error ? e.message : String(e);
        console.error(`[design] propose_page AI 调用失败: ${raw}`);
        return { ok: false, reason: `AI 调用失败：${sanitizeAiError(raw)}` };
      }
    } else {
      html = ensureNavScript(buildMockPage(pc.page, pc.states, pc.catalogPages));
    }
    const fp = sha256(html);
    const up = await this.storage.putContentAddressed(Buffer.from(html, 'utf8'));
    try {
      const r = await executeCommand('design.prototype.page_propose', {
        projectId, pageCode, catalogVersion: pc.catalogVersion,
        objectKey: up.objectKey, fingerprint: fp, instruction, source,
        ...(attribution?.sessionId !== undefined ? { sessionId: attribution.sessionId } : {}),
        ...(attribution?.messageId !== undefined ? { messageId: attribution.messageId } : {}),
      }, { ...ctx, projectId }) as { proposalId: string };
      return {
        ok: true, proposalId: r.proposalId, pageCode, fingerprint: `sha256:${fp}`,
        route: `/design?tab=prototype&page=${encodeURIComponent(pageCode)}`,
      };
    } catch (e) {
      if (e instanceof DomainError) return { ok: false, reason: e.message };
      throw e;
    }
  }

  /** 提案处置（✓ 采用 / ✗ 放弃）：命令内 FOR UPDATE+门禁+页工件 upsert（accept），全链审计 */
  async decideProposal(projectId: string, proposalId: string, decision: 'accept' | 'discard', ctx: CommandContext) {
    return executeCommand('design.prototype.page_proposal_decide',
      { projectId, proposalId, decision }, { ...ctx, projectId });
  }

  /** 待处置提案清单（原型工作台状态聚合用：对比视图/页栏徽标） */
  async listPendingProposals(projectId: string) {
    const r = await query<{
      id: string; page_code: string; instruction: string; html_fingerprint: string; created_at: string;
    }>(
      `SELECT id, page_code, instruction, html_fingerprint, created_at
       FROM dsg_proto_page_proposals WHERE project_id=$1 AND status='pending' ORDER BY created_at`,
      [projectId]);
    return r.rows.map((x) => ({
      id: x.id, pageCode: x.page_code, instruction: x.instruction,
      fingerprint: `sha256:${x.html_fingerprint}`, createdAt: x.created_at,
    }));
  }

  /** 提案预览（对比视图右栏）：内容寻址直签，与页工件预览同口径（sandbox iframe 消费） */
  async proposalPreview(projectId: string, proposalId: string): Promise<unknown> {
    const r = await query<{ object_key: string; html_fingerprint: string }>(
      'SELECT object_key, html_fingerprint FROM dsg_proto_page_proposals WHERE id=$1 AND project_id=$2',
      [proposalId, projectId]);
    if (!r.rows[0]) throw new DomainError('NOT_FOUND', '提案不存在', proposalId);
    return {
      previewUrl: await this.storage.presignedGet(r.rows[0].object_key, 300, undefined, PROTO_HTML_CT),
      htmlFingerprint: `sha256:${r.rows[0].html_fingerprint}`,
      sandbox: { iframe: true, csp: "default-src 'none'" },
    };
  }
}

/** 生成产物契约校验（null=通过；与 prompt 输出契约逐条对应） */
function validatePageHtml(html: string, op: PageGenOp): string | null {
  if (Buffer.byteLength(html, 'utf8') > PAGE_HTML_CAP) return '超过 1MB 体积上限';
  const parts = extractPageParts(html);
  if (!parts) return '缺少 msf: 封装标记';
  if (!parts.body.includes(`data-page-block="${op.pageCode}"`)) return `页根缺 data-page-block="${op.pageCode}"`;
  for (const s of op.states) {
    if (!parts.body.includes(`data-page="${op.pageCode}" data-state="${s.code}"`)) {
      return `缺状态 section（data-page="${op.pageCode}" data-state="${s.code}"，属性序不可颠倒）`;
    }
  }
  const css = parts.styleBlock.replace(/^<style>/, '').replace(/<\/style>$/, '');
  const bad = assertScopedStyles(css, op.pageCode);
  if (bad.length > 0) return `存在未隔离选择器（须以 #pg-${op.pageCode} 开头）：${bad.slice(0, 3).join('、')}`;
  const hidden = findHiddenSectionRule(css);
  if (hidden) return `状态 section 不得用 CSS 控制显隐（可见性由系统脚本接管），违例选择器：${hidden}`;
  // 风格基线纪律（2026-10-17）：页样式写死 hex 色拒收——配色一律 var(--p-*) 令牌，全原型视觉一致性靠它钉死
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hex) return `页面样式写死颜色 ${hex[0]}（配色/字体一律用风格基线令牌 var(--p-*) 与共享类，不得写死色值）`;
  // 覆盖检测 §3：data-nav 穿流目标校验（目标页/状态须在目录集内；本页自身也是合法目标）
  const navProblem = findDataNavProblem(
    parts.body,
    new Set(op.catalogPages.map((p) => p.code)),
    new Set(op.states.map((s) => s.code)),
  );
  if (navProblem) return navProblem;
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
