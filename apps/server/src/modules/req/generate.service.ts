import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { mdToPatches, normalizePatches, sha256Text, splitSections, type EditPatch } from '../platform/doc-sections.js';
import { AI_PROVIDER, type AiProvider, type AiUsage } from '../ai/ai-provider.interface.js';
import { classifyAiError, sanitizeAiError } from '../ai/stream-pipeline.js';
import { registerExternalTool } from '../platform/external-tools.js';

/**
 * 文档 AI 生成（A04-4/5；REQ-202/114/115；F02-12 流式控制）。
 * M2 mock 口径：生成器确定性产出章节补丁（目录先行→章节增量），不产真实 LLM 调用；
 * M6 真接：注入 AI_PROVIDER（purpose='generation'）时走真实模型流式生成，产出 markdown
 *   按 `## ` 章节切分为补丁；未注入（测试/MSF_AI_PROVIDER=mock 直构造）保持 mock 口径。
 * pause/resume=平台缓冲层语义（暂停即停推缓冲、续传从缓冲继续），stop=中止并作废不残留（F02-12/A04-5 注）。
 * REQ-114：参考输入仅 content_final（非定稿 REFERENCE_NOT_FINAL）；
 * REQ-115：流末提交补丁前复验参考指纹，变化即 stream.error REFERENCE_STALE（不落稿）。
 */

export interface GenStartInput {
  referenceFileIds: string[];
  referenceFingerprints: Record<string, string>;
  instruction?: string | undefined;
}

interface GenOp {
  id: string;
  projectId: string;
  kind: 'crd' | 'prd';
  status: 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  chunks: string[];
  patches: EditPatch[];
  targetFingerprint: string;
  refs: Array<{ fileId: string; fingerprint: string }>;
  /** 发起时文档挂接集合（fileId 排序快照；W2-030 流末复验挂接变更用，独立于本次提交的参考载荷） */
  refSet: string[];
  /** 真接模式：start 时取参考正文，drive 时经 AI_PROVIDER 流式生成后切补丁 */
  real?: {
    instruction: string;
    refTexts: Array<{ name: string; md: string }>;
    /** 当前文档已占用条目编号（增量修订顺延，#10 撞车防控） */
    existingCodes: string[];
    /** 当前文档内容（增量修订时注入 prompt，模型据此只产差异补丁——W2-009） */
    currentContent: string;
    /** PRD 生成的上游 CRD 定稿稿（LLD-6 §3.3 消费链；空态文案已承诺「PRD 以 CRD 定稿稿为默认参考」——W2-006 补齐实现） */
    upstreamCrd: string;
  };
}

const ops = new Map<string, GenOp>();

/** 测试/驱动注入点：chunk 间隔（生产 15ms，测试可调 0） */
export const genTiming = { chunkDelayMs: 15 };

@Injectable()
export class GenerateService {
  constructor(
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  onModuleInit(): void {
    // 生成启动登记：gen_state=generating（垃圾状态在 stop/done/failed 时复位）
    registerCommand('req.doc.generate', async (client, payload) => {
      const { projectId, kind, operationId } = payload as { projectId: string; kind: string; operationId: string };
      await client.query(
        "UPDATE req_documents SET gen_state='generating', updated_at=now() WHERE project_id=$1 AND doc_kind=$2",
        [projectId, kind],
      );
      return { operationId };
    });
    registerCommand('req.doc.gen_control', async (client, payload) => {
      const { projectId, kind, genState } = payload as { projectId: string; kind: string; genState: string };
      await client.query(
        'UPDATE req_documents SET gen_state=$3, updated_at=now() WHERE project_id=$1 AND doc_kind=$2',
        [projectId, kind, genState],
      );
      return { genState };
    });
    // 对话改文档旁路（嵌套 LLM 绝不在 ai.tool.invoke 命令事务内跑——注册进外部工具注册表，
    // ai 编排层流末命中走旁路：本 handler 无事务 → doc.propose-pending 独立事务）
    registerExternalTool('req.doc.propose_edits', async (projectId, call, ctx) => {
      const kind = String(call.args['kind'] ?? '');
      if (kind !== 'crd' && kind !== 'prd') return { ok: false, reason: 'kind 枚举 crd|prd' };
      const instruction = String(call.args['instruction'] ?? '').trim();
      if (!instruction) return { ok: false, reason: 'instruction 必填（描述要改什么）' };
      return this.proposeEditsFromChat(projectId, kind, instruction, ctx);
    });
  }

  /** A04-4 启动生成：校验参考输入 + PRD 门禁（CRD 已定稿），返回 operationId */
  async start(projectId: string, kind: 'crd' | 'prd', input: GenStartInput, ctx: CommandContext): Promise<{ operationId: string; source: 'model' | 'mock' }> {
    const doc = await query<{ id: string; final_version_id: string | null; current_version_id: string | null; modified: boolean }>(
      'SELECT * FROM req_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, kind]);
    const d = doc.rows[0];
    if (!d) throw new DomainError('NOT_FOUND', '文档不存在', kind);
    if (d.final_version_id && d.final_version_id === d.current_version_id) {
      throw new DomainError('VERSION_LOCKED', '已定稿文档不可生成（先解锁）', kind);
    }
    const running = [...ops.values()].find((o) => o.projectId === projectId && o.kind === kind && (o.status === 'running' || o.status === 'paused'));
    if (running) throw new DomainError('INVALID_STATE', '已有进行中的生成', running.id);

    // REQ-114：参考输入逐一校验 content_final + 指纹登记
    const refs: Array<{ fileId: string; fingerprint: string }> = [];
    for (const fileId of input.referenceFileIds) {
      const r = await query<{ content_fingerprint: string }>(
        `SELECT p.content_fingerprint FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
         WHERE f.id=$1 AND f.project_id=$2 AND f.parse_status='content_final'
           AND p.kind='content_parse' AND p.status='final'`,
        [fileId, projectId],
      );
      if (!r.rows[0]) throw new DomainError('REFERENCE_NOT_FINAL', '参考输入须为已定稿（content_final）资料', fileId);
      const declared = (input.referenceFingerprints[fileId] ?? '').replace(/^sha256:/, '');
      if (declared && declared !== r.rows[0].content_fingerprint) {
        throw new DomainError('REFERENCE_STALE', '参考输入指纹与登记不一致', fileId);
      }
      refs.push({ fileId, fingerprint: r.rows[0].content_fingerprint });
    }
    // W2-021：CRD 整篇生成（无修订指令）必须至少一份已定稿参考——否则模型只会产出索要资料文本
    if (kind === 'crd' && !input.instruction?.trim() && refs.length === 0) {
      throw new DomainError('REFERENCE_NOT_FINAL', 'CRD 初稿生成须先挂接至少一份已定稿（content_final）参考资料', 'referenceFileIds');
    }
    // PRD 生成门禁：CRD 已定稿（LLD-6 §3.3）
    let upstreamCrd = '';
    if (kind === 'prd') {
      const crd = await query<{ final_version_id: string | null }>(
        "SELECT final_version_id FROM req_documents WHERE project_id=$1 AND doc_kind='crd'", [projectId]);
      if (!crd.rows[0]?.final_version_id) {
        throw new DomainError('GATE_BLOCKED', 'PRD 生成前置：CRD 已定稿', 'crd');
      }
      // W2-006：注入 CRD 定稿稿全文作为上游输入（消费链权威输入，不只靠挂接参考）
      const crdContent = await query<{ content: string }>(
        `SELECT v.content FROM req_versions v JOIN req_documents d ON d.final_version_id=v.id
         WHERE d.project_id=$1 AND d.doc_kind='crd'`, [projectId]);
      upstreamCrd = crdContent.rows[0]?.content ?? '';
    }
    const cur = d.current_version_id
      ? await query<{ content: string }>(
          `SELECT content FROM req_versions v JOIN req_documents d ON d.current_version_id=v.id
           WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, kind])
      : { rows: [] as Array<{ content: string }> };
    // T16：基准与 doc.propose-pending/doc.accept-pending 同口径——草稿优先（草稿有未提交修改时不再 PATCH_BASE_STALE）
    const draft = await query<{ content: string }>(
      'SELECT content FROM req_drafts WHERE document_id=$1', [d.id]);
    const effective = draft.rows[0]?.content ?? cur.rows[0]?.content ?? '';
    // W2-030：挂接集合快照（发起时 DB 实况，流末复验比对增/删挂接）
    const refSetRows = await query<{ file_id: string }>(
      `SELECT DISTINCT f.id AS file_id FROM req_doc_refs r
         JOIN mat_parsed p ON p.id=r.parsed_id JOIN mat_files f ON f.id=p.file_id
       WHERE r.document_id=$1 ORDER BY f.id`, [d.id]);
    const refSet = refSetRows.rows.map((r) => r.file_id);
    const operationId = `op_gen_${randomBytes(6).toString('hex')}`;
    if (this.ai?.kind === 'pi') {
      // 真接：取参考正文（content_final 已校验），drive 时流式生成后切补丁
      const refTexts: Array<{ name: string; md: string }> = [];
      for (const ref of refs) {
        const t = await query<{ name: string; body_md: string }>(
          `SELECT f.name, p.body_md FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
           WHERE f.id=$1 AND p.kind='content_parse' AND p.status='final'`, [ref.fileId]);
        if (t.rows[0]) refTexts.push({ name: t.rows[0].name, md: t.rows[0].body_md });
      }
      ops.set(operationId, {
        id: operationId, projectId, kind, status: 'running',
        chunks: [], patches: [], targetFingerprint: sha256Text(effective), refs, refSet,
        real: {
          instruction: input.instruction ?? '', refTexts,
          existingCodes: [...new Set(effective.match(kind === 'crd' ? /\bCR-\d{3}\b/g : /\bREQ-\d{3}\b/g) ?? [])].sort(),
          currentContent: effective,
          upstreamCrd,
        },
      });
    } else {
      const { chunks, patches } = buildMock(kind, input.instruction ?? '', refs);
      ops.set(operationId, {
        id: operationId, projectId, kind, status: 'running',
        chunks, patches, targetFingerprint: sha256Text(effective), refs, refSet,
      });
    }
    await executeCommand('req.doc.generate', { projectId, kind, operationId }, { ...ctx, projectId });
    // #5：生成来源随流首帧透出（mock 桩 vs 真模型），前端可辨识
    return { operationId, source: this.ai?.kind === 'pi' ? ('model' as const) : ('mock' as const) };
  }

  /** A04-5 过程控制：pause/resume（缓冲层）/stop（中止作废，不产生版本与补丁） */
  async control(projectId: string, operationId: string, action: 'pause' | 'resume' | 'stop', ctx: CommandContext): Promise<{ operationId: string; status: string }> {
    const op = ops.get(operationId);
    if (!op || op.projectId !== projectId) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    if (op.status === 'done' || op.status === 'failed') {
      throw new DomainError('INVALID_STATE', `生成已${op.status}`, operationId);
    }
    if (action === 'pause' && op.status === 'running') op.status = 'paused';
    else if (action === 'resume' && op.status === 'paused') op.status = 'running';
    else if (action === 'stop') {
      op.status = 'stopped';
      await executeCommand('req.doc.gen_control', { projectId, kind: op.kind, genState: 'idle' }, { ...ctx, projectId });
      ops.delete(operationId);
      return { operationId, status: 'stopped' };
    } else {
      throw new DomainError('INVALID_STATE', `当前状态不可 ${action}`, operationId);
    }
    await executeCommand('req.doc.gen_control',
      { projectId, kind: op.kind, genState: op.status === 'paused' ? 'paused' : 'generating' }, { ...ctx, projectId });
    return { operationId, status: op.status };
  }

  /**
   * 驱动生成流：逐 chunk 回调 onDelta；流末 REQ-115 复验参考指纹 → doc.propose-pending 落补丁；
   * stop 时中止不残留。autoRun=false 时由测试手动驱动（与 batch 同模式）。
   */
  async drive(
    operationId: string,
    ctx: CommandContext,
    onDelta: (text: string) => void,
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patchIds?: string[]; error?: string; errorMessage?: string }> {
    const op = ops.get(operationId);
    if (!op) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    if (op.real) {
      const real = await this.driveReal(op, onDelta);
      if (real.status === 'stopped') return { status: 'stopped' };
      if (real.status === 'failed') {
        ops.delete(operationId);
        await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        return { status: 'failed', error: real.error ?? 'INTERNAL', ...(real.errorMessage ? { errorMessage: real.errorMessage } : {}) };
      }
      op.patches = real.patches ?? [];
    } else {
      for (const chunk of op.chunks) {
        while (op.status === 'paused') await sleep(30);
        if (op.status === 'stopped') return { status: 'stopped' };
        onDelta(chunk);
        if (genTiming.chunkDelayMs > 0) await sleep(genTiming.chunkDelayMs);
      }
    }
    if (op.status === 'stopped') return { status: 'stopped' };
    // W2-030：流末复验覆盖挂接集合本身——生成期间增/删挂接即 REFERENCE_STALE（不只比对参考内容指纹）；
    // 与发起时 DB 实况快照（op.refSet）比对，独立于本次提交的参考载荷
    const docRow = await query<{ id: string }>(
      'SELECT id FROM req_documents WHERE project_id=$1 AND doc_kind=$2', [op.projectId, op.kind]);
    if (docRow.rows[0]) {
      const curRefs = await query<{ file_id: string }>(
        `SELECT DISTINCT f.id AS file_id FROM req_doc_refs r
           JOIN mat_parsed p ON p.id=r.parsed_id JOIN mat_files f ON f.id=p.file_id
         WHERE r.document_id=$1 ORDER BY f.id`, [docRow.rows[0].id]);
      const cur = curRefs.rows.map((r) => r.file_id);
      if (cur.length !== op.refSet.length || cur.some((id, i) => id !== op.refSet[i])) {
        ops.delete(operationId);
        await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        return { status: 'failed', error: 'REFERENCE_STALE' };
      }
    }
    // REQ-115：流末复验参考指纹，变化即拒绝提交（不落稿）
    for (const ref of op.refs) {
      const r = await query<{ content_fingerprint: string }>(
        `SELECT p.content_fingerprint FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
         WHERE f.id=$1 AND p.kind='content_parse' AND p.status='final'`, [ref.fileId]);
      if (r.rows[0]?.content_fingerprint !== ref.fingerprint) {
        ops.delete(operationId);
        await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        return { status: 'failed', error: 'REFERENCE_STALE' };
      }
    }
    try {
      const r = (await executeCommand('doc.propose-pending', {
        projectId: op.projectId, kind: op.kind, patches: op.patches,
        targetFingerprint: op.targetFingerprint, proposedBy: 'assistant',
      }, { ...ctx, projectId: op.projectId })) as { patchIds: string[] };
      await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'done' }, { ...ctx, projectId: op.projectId });
      ops.delete(operationId);
      return { status: 'done', patchIds: r.patchIds };
    } catch (e) {
      // 生成期间用户编辑了文档：补丁目标指纹失配，作废本次生成（不残留）
      ops.delete(operationId);
      await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
      return { status: 'failed', error: e instanceof DomainError ? e.code : 'INTERNAL' };
    }
  }

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
  ): Promise<{ ok: boolean; patchCount?: number; route?: string; kind?: 'crd' | 'prd'; reason?: string }> {
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
    // 用量与生成流同口径（purpose='generation'），先于落补丁（token 已真实消耗，usage 独立命令留存属预期；补丁落库失败则整单失败不留半截补丁）
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
      return { ok: true, patchCount: r.patchIds.length, route: '/req', kind };
    } catch (e) {
      // 竞态兜底（命令内 FOR UPDATE 重查命中守卫）：与守卫链同口径翻人话不落码
      if (e instanceof DomainError && e.code === 'PATCH_BASE_STALE') {
        return { ok: false, reason: '文档已被其它操作变更，请刷新后重试' };
      }
      if (e instanceof DomainError && e.code === 'VERSION_LOCKED') {
        return { ok: false, reason: '文档已定稿，请先在需求页 ⋯ 菜单解锁后再修改' };
      }
      if (e instanceof DomainError && e.code === 'INVALID_STATE') {
        return { ok: false, reason: '有待确认补丁，请先在需求页处置后再提新修改' };
      }
      throw e;
    }
  }

  /**
   * 真接驱动：经 AI_PROVIDER（purpose='generation'）流式生成；pause 缓冲、stop 中止；
   * 完成后按章节切补丁，用量经 ai.usage.record 落账（REQ-612）。
   */
  private async driveReal(
    op: GenOp,
    onDelta: (text: string) => void,
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patches?: EditPatch[]; error?: string; errorMessage?: string }> {
    const real = op.real!;
    const t0 = Date.now();
    try {
      const session = await this.ai!.createSession({ projectId: op.projectId, purpose: 'generation' });
      const { deltas, result } = session.stream(buildPrompt(op.kind, real.instruction, real.refTexts, real.existingCodes, real.currentContent, real.upstreamCrd));
      let buf: string[] = [];
      for await (const d of deltas) {
        if (op.status === 'stopped') {
          session.stop();
          return { status: 'stopped' };
        }
        if (op.status === 'paused') {
          buf.push(d);
          continue;
        }
        if (buf.length > 0) {
          for (const b of buf) onDelta(b);
          buf = [];
        }
        onDelta(d);
      }
      // W2-022：pause 冻结整个生成语义——流在暂停期间走完后不得直接收尾（done+落补丁）；
      // 待 resume 后先冲放缓冲再进入复验/落库（模型侧仍在跑属缓冲层口径，但完成事件绝不越过暂停）
      while (op.status === 'paused') await sleep(50);
      if (op.status === 'stopped') { session.stop(); return { status: 'stopped' }; }
      if (buf.length > 0) {
        for (const b of buf) onDelta(b);
        buf = [];
      }
      const res = await result;
      // op 为共享可变态（pause/resume/stop 由外部改写），await 期间可能已被停止——绕开 TS 控制流收窄再判
      const afterResult: string = op.status;
      if (afterResult === 'stopped') return { status: 'stopped' };
      // 归一化：命中既有节的 add 转整节 modify（修复「修改=重复追加」；增量修订与对话改文档共用）
      const patches = normalizePatches(mdToPatches(res.text), splitSections(real.currentContent));
      if (patches.length === 0) return { status: 'failed', error: 'INTERNAL' };
      if (res.modelId) {
        await executeCommand('ai.usage.record', {
          projectId: op.projectId, modelId: res.modelId, purpose: 'generation',
          tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens,
          durationMs: Date.now() - t0, cost: res.usage.cost ?? 0,
        }, { projectId: op.projectId, actorKind: 'assistant', actorId: 'pi' });
      }
      return { status: 'done', patches };
    } catch (e) {
      // W2-002：生成失败留后端日志 + 归类闭集码 + 脱敏人话（原始供应商错误不再被吞）
      const raw = e instanceof Error ? e.message : String(e);
      console.error(`[req] generate failed op=${op.id}: ${raw}`);
      return { status: 'failed', error: e instanceof DomainError ? e.code : classifyAiError(raw), errorMessage: sanitizeAiError(raw) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 真接提示词：角色 + 章节口径（`## ` 条目）+ 编号顺延 + 用户指示 + 参考正文 + 上游/当前文档（W2-006/W2-009） */
function buildPrompt(
  kind: 'crd' | 'prd',
  instruction: string,
  refTexts: Array<{ name: string; md: string }>,
  existingCodes: string[] = [],
  currentContent = '',
  upstreamCrd = '',
): string {
  const refs = refTexts.map((r) => `## 参考资料：${r.name}\n\n${r.md}`).join('\n\n');
  const incremental = instruction.trim().length > 0 && currentContent.trim().length > 0;
  return [
    incremental
      ? `你是软件工厂的需求分析助手。本次是${kind === 'crd' ? '客户需求文档（CRD）' : '产品需求文档（PRD）'}的**增量修订**：只输出需要新增或修改的章节（每章一个 \`## \` 标题；修改某章时保持原标题不变、整章重写输出），**不要复述未变化的章节，不要整篇重出**。新增需求节如需落位，可在该节之前输出所属大章标题行（仅当文档尚无该大章时）。`
      : `你是软件工厂的需求分析助手。请基于${kind === 'prd' ? '上游 CRD 定稿稿与' : ''}参考资料生成一份${kind === 'crd' ? '客户需求文档（CRD）' : '产品需求文档（PRD）'}初稿。`,
    `要求：中文 markdown；先按内容归类出若干大章，大章标题形如 \`## 一、背景与目标\`（必须用中文数字序号+顿号，如 背景与目标/功能需求/非功能需求/约束与假设；不要用"第X章"或阿拉伯数字编号），大章下可有一段引言；每条需求单独一个 \`## \` 章节，标题形如 \`${kind === 'crd' ? 'CR' : 'REQ'}-001 简明标题\`，落在合适大章之后（锚点码必须在标题内，不得改动格式）；条目正文含承接来源与需求描述、验收要点。`,
    // #11：整篇漏承接尾部条目 + 锚点错位的防控
    `逐条核对${kind === 'prd' ? '上游 CRD 定稿稿与' : ''}参考资料中的全部功能/需求条目并逐一承接，不得遗漏（尤其文末的条目）；每条正文「承接」锚点（${kind === 'crd' ? 'R-nnn' : 'CR-nnn'}）须与该条实际出处一致，不得张冠李戴。`,
    // #10：增量修订编号撞车防控
    existingCodes.length ? `本文档已占用编号：${existingCodes.join('、')}；新增条目必须使用未占用编号（在最大编号后顺延），不得复用。` : '',
    ...(instruction ? [`用户指示：${instruction}`] : []),
    ...(upstreamCrd ? [`【上游输入：CRD 定稿稿（PRD 的权威输入，逐条承接）】\n\n${upstreamCrd}`] : []),
    ...(incremental ? [`【当前文档内容（增量修订的基线；未提及的章节保持不变，不要输出）】\n\n${currentContent}`] : []),
    refs,
  ].filter(Boolean).join('\n\n');
}

/** 生成稿按 `## ` 章节切分为补丁（标题截 80 字符；## 前的 h1/前言不成补丁；add 带 after 落位锚点=前一节标题） */
/** mock 生成器：目录先行 → 章节补丁（CRD 含 R/CR 锚点，PRD 含 CR/REQ/DSG 锚点，供 RTM 派生演示） */
function buildMock(
  kind: 'crd' | 'prd',
  instruction: string,
  refs: Array<{ fileId: string; fingerprint: string }>,
): { chunks: string[]; patches: EditPatch[] } {
  const n = Math.max(3, refs.length);
  const patches: EditPatch[] = [];
  if (kind === 'crd') {
    patches.push(
      { type: 'add', secId: 's0', title: '背景与目标', new: `${instruction || '依据已定稿资料整理客户需求。'}\n\n参考资料 ${refs.length} 项（指纹登记于版本 refs）。` },
      { type: 'add', secId: 's0', title: '客户原始需求', new: Array.from({ length: n }, (_, i) => `- R-${String(i + 1).padStart(3, '0')} 客户原始诉求 ${i + 1}`).join('\n') },
    );
    for (let i = 0; i < n; i++) {
      const c = String(i + 1).padStart(3, '0');
      patches.push({ type: 'add', secId: 's0', title: `CR-${c} 需求条目 ${i + 1}`, new: `承接：R-${c}\n\n（mock 生成内容，M6 真接 Pi 后替换）` });
    }
  } else {
    patches.push(
      { type: 'add', secId: 's0', title: '产品概述', new: `${instruction || '依据 CRD 定稿生成产品需求。'}` },
    );
    for (let i = 0; i < n; i++) {
      const c = String(i + 1).padStart(3, '0');
      patches.push({ type: 'add', secId: 's0', title: `REQ-${c} 产品需求 ${i + 1}`, new: `承接：CR-${c}\n\n设计锚点：DSG-U03-2\n\n（mock 生成内容，M6 真接 Pi 后替换）` });
    }
  }
  // 目录先行 → 章节增量（F02-12/LLD-6 §3.3：目录先行 → 章节 Task 实时卡）
  const chunks = [
    `# 生成目录\n${patches.map((p) => `- ${p.title}`).join('\n')}\n`,
    ...patches.map((p) => `\n## ${p.title}\n\n${p.new}\n`),
  ];
  return { chunks, patches };
}

/** mock 对话修订产出（确定性两形态：命中既有节标题→normalize 转 modify + 全新节→add，离线可测两分支） */
function buildMockChatEdit(kind: 'crd' | 'prd', effective: string, instruction: string): string {
  const re = kind === 'crd' ? /\bCR-\d{3}\b/ : /\bREQ-\d{3}\b/;
  const hit = splitSections(effective).find((s) => re.test(s.title));
  const codes = [...effective.matchAll(kind === 'crd' ? /\bCR-(\d{3})\b/g : /\bREQ-(\d{3})\b/g)]
    .map((m) => Number(m[1]));
  const next = `${kind === 'crd' ? 'CR' : 'REQ'}-${String((codes.length > 0 ? Math.max(...codes) : 0) + 1).padStart(3, '0')}`;
  const note = (instruction || '按对话要求调整').replace(/\s*\n+\s*/g, ' '); // 压平换行：含换行的指令会切出多余节
  const parts: string[] = [];
  if (hit) parts.push(`## ${hit.title}\n\n${hit.md}\n\n（mock 对话修订：${note}）`);
  parts.push(`## ${next} 对话补充条目\n\n承接：见对话上下文\n\n（mock 对话新增：${note}）`);
  return parts.join('\n\n');
}
