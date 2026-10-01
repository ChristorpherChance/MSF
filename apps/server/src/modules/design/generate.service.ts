import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { mdToPatches, sha256Text, type EditPatch } from '../platform/doc-sections.js';
import { AI_PROVIDER, type AiProvider } from '../ai/ai-provider.interface.js';
import { classifyAiError, sanitizeAiError } from '../ai/stream-pipeline.js';
import { DesignDocsService, DESIGN_BOOKS, type DesignKind } from './docs.service.js';

/**
 * 设计文档 AI 生成（A05-2；REQ-302/114/115）。
 * mock 口径同 M2：目录先行 chunk → 章节补丁；生成门禁链 HLD←PRD 定稿、LLD←HLD 定稿（GATE_BLOCKED）。
 * M7 真接（差异⑭回销）：注入 AI_PROVIDER（purpose='generation'）时走真实模型流式生成，
 * 产出按 `## ` 章节切补丁（mdToPatches）；未注入保持 mock 口径不变。
 */

export interface DesignGenInput {
  referenceFileIds: string[];
  referenceFingerprints: Record<string, string>;
  instruction?: string | undefined;
}

interface GenOp {
  id: string;
  projectId: string;
  kind: DesignKind;
  status: 'running' | 'paused' | 'stopped' | 'done' | 'failed';
  chunks: string[];
  patches: EditPatch[];
  targetFingerprint: string;
  refs: Array<{ fileId: string; fingerprint: string }>;
  /** 真接模式：start 时取参考正文，drive 时经 AI_PROVIDER 流式生成后切补丁 */
  real?: {
    instruction: string;
    refTexts: Array<{ name: string; md: string }>;
    /** 上游定稿全文（#11 立项：承接锚点必须 grounded，模型看不到上游只能猜编号） */
    upstream: Array<{ name: string; md: string }>;
    /** 当前文档已占用章节编号（增量修订顺延，#10） */
    existingCodes: string[];
  };
}

const ops = new Map<string, GenOp>();
export const designGenTiming = { chunkDelayMs: 15 };

@Injectable()
export class DesignGenerateService {
  constructor(
    @Inject(DesignDocsService) private readonly docs: DesignDocsService,
    @Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider,
  ) {}

  onModuleInit(): void {
    registerCommand('design.doc.generate', async (client, payload) => {
      const { projectId, kind, operationId } = payload as { projectId: string; kind: string; operationId: string };
      await client.query(
        "UPDATE dsg_documents SET gen_state='generating', updated_at=now() WHERE project_id=$1 AND doc_kind=$2",
        [projectId, kind],
      );
      return { operationId };
    });
    registerCommand('design.doc.gen_control', async (client, payload) => {
      const { projectId, kind, genState } = payload as { projectId: string; kind: string; genState: string };
      await client.query(
        'UPDATE dsg_documents SET gen_state=$3, updated_at=now() WHERE project_id=$1 AND doc_kind=$2',
        [projectId, kind, genState],
      );
      return { genState };
    });
  }

  /** A05-2 启动生成：参考校验（REQ-114）+ 上游定稿门禁（HLD←PRD、LLD←HLD） */
  async start(projectId: string, kind: DesignKind, input: DesignGenInput, ctx: CommandContext): Promise<{ operationId: string; source: 'model' | 'mock' }> {
    const doc = await query<{ id: string; final_version_id: string | null; current_version_id: string | null }>(
      'SELECT * FROM dsg_documents WHERE project_id=$1 AND doc_kind=$2', [projectId, kind]);
    const d = doc.rows[0];
    if (!d) throw new DomainError('NOT_FOUND', '设计文档不存在', kind);
    if (d.final_version_id && d.final_version_id === d.current_version_id) {
      throw new DomainError('VERSION_LOCKED', '已定稿文档不可生成（先解锁）', kind);
    }
    const running = [...ops.values()].find((o) => o.projectId === projectId && o.kind === kind && (o.status === 'running' || o.status === 'paused'));
    if (running) throw new DomainError('INVALID_STATE', '已有进行中的生成', running.id);

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

    // 生成门禁链（REQ-302/304）：hld 消费 PRD 定稿；七册 LLD 消费 HLD 定稿
    const up = await this.docs.upstreamFingerprint(null, projectId, kind === 'hld' ? 'prd' : 'hld');
    if (!up.ok) {
      throw new DomainError('GATE_BLOCKED', `生成前置：${up.missing.join('、')} 已定稿`, up.missing[0]);
    }

    const cur = d.current_version_id
      ? await query<{ content: string }>(
          'SELECT v.content FROM dsg_versions v JOIN dsg_documents d ON d.current_version_id=v.id WHERE d.id=$1', [d.id])
      : { rows: [] as Array<{ content: string }> };
    const operationId = `op_dgen_${randomBytes(6).toString('hex')}`;
    if (this.ai?.kind === 'pi') {
      // 真接：取参考正文（content_final 已校验），drive 时流式生成后切补丁
      const refTexts: Array<{ name: string; md: string }> = [];
      for (const ref of refs) {
        const t = await query<{ name: string; body_md: string }>(
          `SELECT f.name, p.body_md FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
           WHERE f.id=$1 AND p.kind='content_parse' AND p.status='final'`, [ref.fileId]);
        if (t.rows[0]) refTexts.push({ name: t.rows[0].name, md: t.rows[0].body_md });
      }
      // #11：上游定稿全文注入（HLD←PRD；其余七册←PRD+HLD），承接锚点 grounded
      const upstream: Array<{ name: string; md: string }> = [];
      const upKinds = kind === 'hld' ? (['prd'] as const) : (['prd', 'hld'] as const);
      for (const uk of upKinds) {
        const table = uk === 'prd' ? 'req_documents' : 'dsg_documents';
        const vtable = uk === 'prd' ? 'req_versions' : 'dsg_versions';
        const r = await query<{ content: string }>(
          `SELECT v.content FROM ${table} d JOIN ${vtable} v ON v.id=d.final_version_id
           WHERE d.project_id=$1 AND d.doc_kind=$2`, [projectId, uk]);
        const md = r.rows[0]?.content ?? '';
        if (md) upstream.push({ name: uk.toUpperCase(), md: capText(md) });
      }
      const currentContent = cur.rows[0]?.content ?? '';
      ops.set(operationId, {
        id: operationId, projectId, kind, status: 'running',
        chunks: [], patches: [], targetFingerprint: sha256Text(currentContent), refs,
        real: { instruction: input.instruction ?? '', refTexts, upstream, existingCodes: chapterCodes(currentContent, kind) },
      });
    } else {
      const { chunks, patches } = buildMock(kind, input.instruction ?? '');
      ops.set(operationId, {
        id: operationId, projectId, kind, status: 'running',
        chunks, patches, targetFingerprint: sha256Text(cur.rows[0]?.content ?? ''), refs,
      });
    }
    await executeCommand('design.doc.generate', { projectId, kind, operationId }, { ...ctx, projectId });
    // #5：生成来源随流首帧透出（mock 桩 vs 真模型），前端可辨识
    return { operationId, source: this.ai?.kind === 'pi' ? ('model' as const) : ('mock' as const) };
  }

  async control(projectId: string, operationId: string, action: 'pause' | 'resume' | 'stop', ctx: CommandContext) {
    const op = ops.get(operationId);
    if (!op || op.projectId !== projectId) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    if (op.status === 'done' || op.status === 'failed') {
      throw new DomainError('INVALID_STATE', `生成已${op.status}`, operationId);
    }
    if (action === 'pause' && op.status === 'running') op.status = 'paused';
    else if (action === 'resume' && op.status === 'paused') op.status = 'running';
    else if (action === 'stop') {
      op.status = 'stopped';
      await executeCommand('design.doc.gen_control', { projectId, kind: op.kind, genState: 'idle' }, { ...ctx, projectId });
      ops.delete(operationId);
      return { operationId, status: 'stopped' };
    } else {
      throw new DomainError('INVALID_STATE', `当前状态不可 ${action}`, operationId);
    }
    await executeCommand('design.doc.gen_control',
      { projectId, kind: op.kind, genState: op.status === 'paused' ? 'paused' : 'generating' }, { ...ctx, projectId });
    return { operationId, status: op.status };
  }

  /** 驱动生成流：同 M2 口径（REQ-115 流末复验；落 design.doc.propose-pending） */
  async drive(
    operationId: string,
    ctx: CommandContext,
    onDelta: (text: string) => void,
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patchIds?: string[]; error?: string; errorMessage?: string }> {
    const op = ops.get(operationId);
    if (!op) throw new DomainError('NOT_FOUND', '生成操作不存在', operationId);
    if (op.real) {
      const real = await this.driveReal(op, onDelta);
      if (real.status !== 'done') {
        ops.delete(operationId);
        if (real.status === 'failed') {
          await executeCommand('design.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        }
        return real;
      }
      op.patches = real.patches!;
    } else {
      for (const chunk of op.chunks) {
        while (op.status === 'paused') await sleep(30);
        if (op.status === 'stopped') return { status: 'stopped' };
        onDelta(chunk);
        if (designGenTiming.chunkDelayMs > 0) await sleep(designGenTiming.chunkDelayMs);
      }
      if (op.status === 'stopped') return { status: 'stopped' };
    }
    for (const ref of op.refs) {
      if (!ref.fingerprint) continue;
      const r = await query<{ content_fingerprint: string }>(
        `SELECT p.content_fingerprint FROM mat_parsed p JOIN mat_files f ON f.id=p.file_id
         WHERE f.id=$1 AND p.kind='content_parse' AND p.status='final'`, [ref.fileId]);
      if (r.rows[0]?.content_fingerprint !== ref.fingerprint.replace(/^sha256:/, '')) {
        ops.delete(operationId);
        await executeCommand('design.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
        return { status: 'failed', error: 'REFERENCE_STALE' };
      }
    }
    try {
      const r = (await executeCommand('design.doc.propose-pending', {
        projectId: op.projectId, kind: op.kind, patches: op.patches,
        targetFingerprint: op.targetFingerprint, proposedBy: 'assistant',
      }, { ...ctx, projectId: op.projectId })) as { patchIds: string[] };
      await executeCommand('design.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'done' }, { ...ctx, projectId: op.projectId });
      ops.delete(operationId);
      return { status: 'done', patchIds: r.patchIds };
    } catch (e) {
      ops.delete(operationId);
      await executeCommand('design.doc.gen_control', { projectId: op.projectId, kind: op.kind, genState: 'failed' }, { ...ctx, projectId: op.projectId });
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
  ): Promise<{ status: 'done' | 'stopped' | 'failed'; patches?: EditPatch[]; error?: string; errorMessage?: string }> {
    const real = op.real!;
    const t0 = Date.now();
    try {
      const session = await this.ai!.createSession({ projectId: op.projectId, purpose: 'generation' });
      const { deltas, result } = session.stream(buildDesignPrompt(op.kind, real.instruction, real.refTexts, real.upstream, real.existingCodes));
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
      // 待 resume 后先冲放缓冲再进入复验/落库（与需求域同口径）
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
      // W2-002：生成失败留后端日志 + 归类闭集码 + 脱敏人话（与需求域同口径）
      const raw = e instanceof Error ? e.message : String(e);
      console.error(`[design] generate failed op=${op.id}: ${raw}`);
      return { status: 'failed', error: e instanceof DomainError ? e.code : classifyAiError(raw), errorMessage: sanitizeAiError(raw) };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 真接提示词：角色 + 章节口径（`## ` 条目）+ 上游定稿全文 + 用户指示 + 参考正文 */
function buildDesignPrompt(
  kind: DesignKind,
  instruction: string,
  refTexts: Array<{ name: string; md: string }>,
  upstream: Array<{ name: string; md: string }> = [],
  existingCodes: string[] = [],
): string {
  const book = DESIGN_BOOKS.find((b) => b.kind === kind)!;
  const refs = refTexts.map((r) => `## 参考资料：${r.name}\n\n${r.md}`).join('\n\n');
  const ups = upstream.map((u) => `## 上游定稿：${u.name}\n\n${u.md}`).join('\n\n');
  return [
    `你是软件工厂的设计助手。请基于上游定稿文档（全文附后）与参考资料，生成《${book.name}》（${book.prefix} 册）初稿。`,
    '输出为 Markdown 正文，按 `## ` 二级标题分节（章节标题简洁、不超过 30 字），每节给出可执行的设计内容。',
    // #15 反向派生依赖回引；#11 全量承接
    '逐条承接上游 PRD 的全部 REQ 条目：每个承接章节在标题或正文显式回引 REQ-nnn 编号（追溯链按此派生），不得遗漏尾部条目。',
    // #10 增量修订编号顺延
    existingCodes.length ? `本文档已占用章节编号：${existingCodes.join('、')}；新增章节必须使用未占用编号（顺延），不得复用。` : '',
    instruction ? `用户指示：${instruction}` : '',
    ups ? `\n${ups}` : '',
    refs ? `\n${refs}` : '',
  ].filter(Boolean).join('\n');
}

/** 喂给模型的单文档上限（字符）；超出截断并注明（与解析引擎 AI_INPUT_CAP 同口径） */
const GEN_INPUT_CAP = 24000;
function capText(md: string): string {
  return md.length > GEN_INPUT_CAP ? `${md.slice(0, GEN_INPUT_CAP)}\n\n[原文过长，已截断]` : md;
}

/** 当前文档已占用的本册章节编号（前缀-数字；#10 增量顺延依据） */
function chapterCodes(content: string, kind: DesignKind): string[] {
  const prefix = DESIGN_BOOKS.find((b) => b.kind === kind)!.prefix;
  const re = new RegExp(`\\b${prefix}-\\d+(?:\\.\\d+)?\\b`, 'g');
  return [...new Set(content.match(re) ?? [])].sort();
}

/** mock 生成器：按册前缀产章节（h/o/g/k/d/a/u/n 章节体系，REQ-302） */
function buildMock(kind: DesignKind, instruction: string): { chunks: string[]; patches: EditPatch[] } {
  const book = DESIGN_BOOKS.find((b) => b.kind === kind)!;
  const topics: Record<DesignKind, string[]> = {
    hld: ['总体架构', '技术选型与 ADR', '部署视图'],
    mod: ['模块划分', '模块间依赖矩阵', '接口契约'],
    alg: ['核心流程', '状态机清单', '异常路径'],
    cls: ['核心实体', '值对象', '命令与事件'],
    db: ['表清单', '约束与索引', 'append-only 清单'],
    api: ['端点总览', '错误码使用', '幂等约定'],
    ui: ['页面清单', '组件树', '交互与状态'],
    nfr: ['性能指标', '安全基线', '备份与恢复'],
  };
  const patches: EditPatch[] = topics[kind].map((t, i) => ({
    type: 'add',
    secId: 's0',
    title: `${book.prefix}-${i + 1} ${t}`,
    new: `${instruction || `${book.name}·${t}（mock 生成，M6 真接 Pi 后替换）`}\n\n- 锚点 ${book.prefix}-${i + 1}.1`,
  }));
  const chunks = [
    `# ${book.name} 生成目录\n${patches.map((p) => `- ${p.title}`).join('\n')}\n`,
    ...patches.map((p) => `\n## ${p.title}\n\n${p.new}\n`),
  ];
  return { chunks, patches };
}
