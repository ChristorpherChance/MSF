import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { mdToPatches, sha256Text, type EditPatch } from '../platform/doc-sections.js';
import { AI_PROVIDER, type AiProvider } from '../ai/ai-provider.interface.js';

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
  /** 真接模式：start 时取参考正文，drive 时经 AI_PROVIDER 流式生成后切补丁 */
  real?: {
    instruction: string;
    refTexts: Array<{ name: string; md: string }>;
    /** 当前文档已占用条目编号（增量修订顺延，#10 撞车防控） */
    existingCodes: string[];
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
    // PRD 生成门禁：CRD 已定稿（LLD-6 §3.3）
    if (kind === 'prd') {
      const crd = await query<{ final_version_id: string | null }>(
        "SELECT final_version_id FROM req_documents WHERE project_id=$1 AND doc_kind='crd'", [projectId]);
      if (!crd.rows[0]?.final_version_id) {
        throw new DomainError('GATE_BLOCKED', 'PRD 生成前置：CRD 已定稿', 'crd');
      }
    }
    const cur = d.current_version_id
      ? await query<{ content: string }>(
          `SELECT content FROM req_versions v JOIN req_documents d ON d.current_version_id=v.id
           WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, kind])
      : { rows: [] as Array<{ content: string }> };
    const effective = cur.rows[0]?.content ?? '';
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
        chunks: [], patches: [], targetFingerprint: sha256Text(effective), refs,
        real: {
          instruction: input.instruction ?? '', refTexts,
          existingCodes: [...new Set(effective.match(kind === 'crd' ? /\bCR-\d{3}\b/g : /\bREQ-\d{3}\b/g) ?? [])].sort(),
        },
      });
    } else {
      const { chunks, patches } = buildMock(kind, input.instruction ?? '', refs);
      ops.set(operationId, {
        id: operationId, projectId, kind, status: 'running',
        chunks, patches, targetFingerprint: sha256Text(effective), refs,
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
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patchIds?: string[]; error?: string }> {
    const op = ops.get(operationId);
    if (!op) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    if (op.real) {
      const real = await this.driveReal(op, onDelta);
      if (real.status === 'stopped') return { status: 'stopped' };
      if (real.status === 'failed') {
        ops.delete(operationId);
        await executeCommand('req.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        return { status: 'failed', error: real.error ?? 'INTERNAL' };
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
   * 真接驱动：经 AI_PROVIDER（purpose='generation'）流式生成；pause 缓冲、stop 中止；
   * 完成后按章节切补丁，用量经 ai.usage.record 落账（REQ-612）。
   */
  private async driveReal(
    op: GenOp,
    onDelta: (text: string) => void,
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patches?: EditPatch[]; error?: string }> {
    const real = op.real!;
    const t0 = Date.now();
    try {
      const session = await this.ai!.createSession({ projectId: op.projectId, purpose: 'generation' });
      const { deltas, result } = session.stream(buildPrompt(op.kind, real.instruction, real.refTexts, real.existingCodes));
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
      const res = await result;
      if (op.status === 'stopped') return { status: 'stopped' };
      const patches = mdToPatches(res.text);
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
      return { status: 'failed', error: e instanceof DomainError ? e.code : 'INTERNAL' };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 真接提示词：角色 + 章节口径（`## ` 条目）+ 编号顺延 + 用户指示 + 参考正文 */
function buildPrompt(
  kind: 'crd' | 'prd',
  instruction: string,
  refTexts: Array<{ name: string; md: string }>,
  existingCodes: string[] = [],
): string {
  const refs = refTexts.map((r) => `## 参考资料：${r.name}\n\n${r.md}`).join('\n\n');
  return [
    `你是软件工厂的需求分析助手。请基于参考资料生成一份${kind === 'crd' ? '客户需求文档（CRD）' : '产品需求文档（PRD）'}初稿。`,
    `要求：中文 markdown；每条需求单独一个 \`## \` 章节，标题形如 \`${kind === 'crd' ? 'CR' : 'REQ'}-001 简明标题\`；条目正文含承接来源与需求描述、验收要点。`,
    // #11：整篇漏承接尾部条目 + 锚点错位的防控
    `逐条核对参考资料中的全部功能/需求条目并逐一承接，不得遗漏（尤其参考资料文末的条目）；每条正文「承接」锚点（${kind === 'crd' ? 'R-nnn' : 'CR-nnn'}）须与该条实际出处一致，不得张冠李戴。`,
    // #10：增量修订编号撞车防控
    existingCodes.length ? `本文档已占用编号：${existingCodes.join('、')}；新增条目必须使用未占用编号（在最大编号后顺延），不得复用。` : '',
    ...(instruction ? [`用户指示：${instruction}`] : []),
    refs,
  ].filter(Boolean).join('\n\n');
}

/** 生成稿按 `## ` 章节切分为补丁（目录/前言段同样成补丁，标题截 80 字符） */
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
