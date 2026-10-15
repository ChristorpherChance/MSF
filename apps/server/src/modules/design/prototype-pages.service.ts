import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { AI_PROVIDER, type AiProvider, type AiSession } from '../ai/ai-provider.interface.js';
import { classifyAiError, isRetryableStreamCut, sanitizeAiError } from '../ai/stream-pipeline.js';
import { StorageService } from '../platform/storage.service.js';
import { DesignDocsService } from './docs.service.js';
import {
  PAGE_INPUT_CAP,
  assertScopedStyles,
  buildMockPage,
  buildPagePrompt,
  ensureNavScript,
  extractPageParts,
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
  instruction: string;
  /** 真接模式保留会话句柄（abort 用） */
  session?: AiSession | undefined;
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
  }

  /** 启动单页生成（门禁：plan 完整未 stale + 页归属 plan 目录 + 未定稿 + 并发去重） */
  async start(projectId: string, pageCode: string, instruction: string, ctx: CommandContext): Promise<{ operationId: string; source: 'model' | 'mock' }> {
    void ctx;
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
    const running = [...ops.values()].find((o) => o.projectId === projectId && o.pageCode === pageCode && o.status === 'running');
    if (running) throw new DomainError('INVALID_STATE', '已有进行中的生成', running.id);

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
    // UI 册正文注入（覆盖检测 §2）：当前版本按页相关章节节选，上限同 PRD 口径
    const uiRow = await query<{ content: string }>(
      `SELECT v.content FROM dsg_documents d JOIN dsg_versions v ON v.id=d.current_version_id
       WHERE d.project_id=$1 AND d.doc_kind='ui'`, [projectId]);
    const ui = pickUiSections(uiRow.rows[0]?.content ?? '', page);

    const operationId = `op_pgen_${randomBytes(6).toString('hex')}`;
    ops.set(operationId, {
      id: operationId, projectId, pageCode, catalogVersion: p.catalog_version, status: 'running',
      page, states,
      anchors: anchors.rows.map((a) => ({ docKind: a.doc_kind, sectionId: a.section_id, anchor: a.anchor })),
      prd, ui, instruction,
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

  /** mock 降级：整页 mock HTML 分块吐出（结构与真接同契约，source='mock' 可辨识） */
  private async driveMock(op: PageGenOp, onDelta: (text: string) => void): Promise<string | null> {
    const html = buildMockPage(op.page, op.states);
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
      const prompt = buildPagePrompt(op.page, op.states, op.anchors, op.prd, op.ui, op.instruction)
        + (attempt === 1 ? `\n\n上次输出不合规（${lastProblem}），本次务必逐条满足输出契约。` : '');
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
          }, { projectId: op.projectId, actorKind: 'assistant', actorId: 'pi' });
        }
        const problem = validatePageHtml(res.text, op);
        if (!problem) return ensureNavScript(res.text); // NAV_SCRIPT 属系统协议层，入库前确定性补齐（幂等）
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
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
