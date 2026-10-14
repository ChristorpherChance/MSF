import { Inject, Injectable, Optional } from '@nestjs/common';
import { DomainError } from '@msf/shared';
import { query } from '../../db/pool.js';
import { executeCommand, registerCommand, type CommandContext } from '../evidence/command-bus.js';
import { splitSections } from '../platform/doc-sections.js';
import { DSG_BOOK_LETTER, scanOverdesign } from '../platform/rtm-health.js';
import { AI_PROVIDER, type AiMessageResult, type AiProvider, type AiSession } from '../ai/ai-provider.interface.js';

/**
 * 设计评审项（A05-3；REQ-303）。
 * 首访种子三条 DR（mock 评审规则保留不退役；真实项由自检评审量产后自然稀释）；conclude 留痕结论。
 *
 * AI 自检评审（设计覆盖检测与可交互原型 §1 过度设计侧）：
 * - 候选清单=scanOverdesign 八册全扫（草稿优先同 doc.read 口径）剔除 deferred 豁免（dsg 自指行码集）；
 * - 后台跑+并发闸（reflection.service.ts 先例，单进程内存闸）：启动即返，在飞再调 INVALID_STATE；
 *   逐节串行 LLM（purpose='review'，事务外——嵌套 LLM 绝不在命令事务内）；
 * - 复核意见落真实 DR 项（dsg_reviews 不加列，快照式接受陈旧）：code=DR-<册字母>-<节锚点>、
 *   severity='中'、doc_kind=册 kind、created_by='pi' 辨识来源；重跑口径=done 不动 / open 刷新 text；
 * - AI 只提不判：人工三值结论仍走 design.review.conclude；open 计数进 finalize 门禁既有链路；
 * - 前端进度=轮询 DR 列表（逐节一条命令事务落库，新落 pi 项即进度分子）。
 */

const SEED: Array<{ code: string; severity: '高' | '中' | '低'; docKind: string; text: string }> = [
  { code: 'DR-01', severity: '高', docKind: 'api', text: '接口册覆盖全部外部交互（端点清单与页面操作一一对应）' },
  { code: 'DR-02', severity: '中', docKind: 'db', text: '数据库册 append-only 清单与 LLD-4 §4 总则一致' },
  { code: 'DR-03', severity: '中', docKind: 'ui', text: 'UI 册页面清单与原型目录一致（无孤儿页面）' },
];

/** 自检评审系统 prompt（代码内置不可编辑）：候选节全文+PRD REQ 摘录 → 严格 JSON 复核意见（只提不判） */
const REVIEW_SYSTEM = `你是软件工厂的设计自检评审器。输入=设计册某条目节全文（该节标题含本册锚点码、无任何
REQ 需求回引，疑似过度设计）与 PRD 需求节摘录。产出严格 JSON：
{"verdict":"pass|fail","comment":"一句话复核意见（fail=看似无需求依据：…；pass=实为合理技术决策：…）"}
纪律：只产复核意见供人工结论参考，不替人下结论；comment 一句话说清依据。`;

/** 单节复核 LLM 看门狗（reflection 同构）：上游静默挂起不致并发闸永真；分钟数单点常量，文案插值同源 */
const REVIEW_WATCHDOG_MIN = 10;
const REVIEW_WATCHDOG_MS = REVIEW_WATCHDOG_MIN * 60_000;

/** 复核输入的 PRD 摘录上限（防爆 prompt；REQ 节正文逐节截 400 字） */
const REQ_EXCERPT_BUDGET = 12000;

/** 自检候选（code 即落库 DR 码：DR-<册字母>-<节锚点>，如 DR-H-h-3） */
interface SelfcheckCandidate {
  code: string;
  book: string;
  anchor: string;
  title: string;
  sectionText: string;
}

@Injectable()
export class ReviewService {
  /** 并发闸（reflection 先例：单进程部署内存闸，同刻一场） */
  private running = false;

  // 显式 @Inject：vitest(esbuild) 不产 design:paramtypes 元数据；可选注入保 new ReviewService() 旧测试可编
  constructor(@Optional() @Inject(AI_PROVIDER) private readonly ai?: AiProvider) {}

  onModuleInit(): void {
    registerCommand('design.review.seed', async (client, payload, ctx) => {
      const { projectId, force } = payload as { projectId: string; force?: boolean };
      const existing = await client.query('SELECT 1 FROM dsg_reviews WHERE project_id=$1 LIMIT 1', [projectId]);
      if (existing.rows[0] && !force) return { seeded: false };
      // 重新自检评审（S8 🔁）：幂等补齐缺失条目（按 code 去重，不动已有结论）
      let added = 0;
      for (const s of SEED) {
        const r = await client.query(
          `INSERT INTO dsg_reviews (project_id, code, severity, doc_kind, text, created_by)
           SELECT $1,$2,$3,$4,$5,$6
           WHERE NOT EXISTS (SELECT 1 FROM dsg_reviews WHERE project_id=$1 AND code=$2)
           RETURNING id`,
          [projectId, s.code, s.severity, s.docKind, s.text, ctx.actorId],
        );
        added += r.rows.length;
      }
      return { seeded: true, count: added };
    });

    // AI 自检评审单条 DR 落项（逐节一条命令事务=审计天然留痕+进度可轮询）：
    // 幂等 upsert——已有结论（done）不动 / 仍 open 刷新 text+updated_at / 不存在插入（created_by='pi'）
    registerCommand('design.review.selfcheck', async (client, payload) => {
      const { projectId, code, severity, docKind, text } = payload as {
        projectId: string; code: string; severity: '高' | '中' | '低'; docKind: string; text: string;
      };
      if (!code?.trim() || !docKind?.trim() || !text?.trim()) {
        throw new DomainError('VALIDATION_FAILED', 'code/docKind/text 必填', 'code');
      }
      if (!['高', '中', '低'].includes(severity)) {
        throw new DomainError('VALIDATION_FAILED', 'severity 枚举 高|中|低', 'severity');
      }
      const cur = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM dsg_reviews WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, code]);
      if (cur.rows[0]) {
        if (cur.rows[0].status === 'done') return { code, landed: false }; // 重跑口径：已有结论不动
        await client.query(
          "UPDATE dsg_reviews SET text=$3, updated_by='pi', updated_at=now() WHERE id=$1 AND project_id=$2",
          [cur.rows[0].id, projectId, text]);
        return { code, landed: true, refreshed: true };
      }
      await client.query(
        `INSERT INTO dsg_reviews (project_id, code, severity, doc_kind, text, created_by)
         VALUES ($1,$2,$3,$4,$5,'pi')`,
        [projectId, code, severity, docKind, text]);
      return { code, landed: true };
    });

    // S8：已解决项重新打开（结论清空，回到未决）
    registerCommand('design.review.reopen', async (client, payload, ctx) => {
      const { projectId, drId } = payload as { projectId: string; drId: string };
      const r = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM dsg_reviews WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, drId]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '评审项不存在', drId);
      if (r.rows[0].status !== 'done') throw new DomainError('INVALID_STATE', '仅已解决项可重新打开', drId);
      await client.query(
        "UPDATE dsg_reviews SET status='open', resolution=NULL, updated_by=$3, updated_at=now() WHERE id=$1 AND project_id=$2",
        [r.rows[0].id, projectId, ctx.actorId],
      );
      return { id: drId, status: 'open' };
    });

    registerCommand('design.review.conclude', async (client, payload, ctx) => {
      const { projectId, drId, conclusion, note } = payload as {
        projectId: string; drId: string; conclusion: 'pass' | 'fail' | 'na'; note?: string;
      };
      if (!['pass', 'fail', 'na'].includes(conclusion)) {
        throw new DomainError('VALIDATION_FAILED', '结论枚举 pass|fail|na', 'conclusion');
      }
      const r = await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM dsg_reviews WHERE project_id=$1 AND code=$2 FOR UPDATE', [projectId, drId]);
      if (!r.rows[0]) throw new DomainError('NOT_FOUND', '评审项不存在', drId);
      await client.query(
        "UPDATE dsg_reviews SET status='done', resolution=$3, updated_by=$4, updated_at=now() WHERE id=$1 AND project_id=$2",
        [r.rows[0].id, projectId, `${conclusion}${note ? `：${note}` : ''}`, ctx.actorId],
      );
      return { id: drId, conclusion };
    });
  }

  /** A05-3 列表（首访种子）；by=created_by 透出（pi 项前端带来源标） */
  async list(projectId: string, ctx: CommandContext): Promise<unknown> {
    const seeded = await query('SELECT 1 FROM dsg_reviews WHERE project_id=$1 LIMIT 1', [projectId]);
    if (!seeded.rows[0]) {
      await executeCommand('design.review.seed', { projectId }, { ...ctx, projectId });
    }
    const r = await query<{
      code: string; severity: string; doc_kind: string; text: string;
      status: string; resolution: string | null; updated_at: string | null; created_by: string;
    }>('SELECT * FROM dsg_reviews WHERE project_id=$1 ORDER BY code', [projectId]);
    return {
      items: r.rows.map((x) => ({
        id: x.code, severity: x.severity, docKind: x.doc_kind, item: x.text,
        status: x.status, conclusion: x.resolution, at: x.updated_at, by: x.created_by,
      })),
    };
  }

  async conclude(projectId: string, drId: string, conclusion: 'pass' | 'fail' | 'na', note: string | undefined, ctx: CommandContext) {
    return executeCommand('design.review.conclude', { projectId, drId, conclusion, note }, { ...ctx, projectId });
  }

  /** 重新自检评审（幂等补齐种子条目；S8 🔁 按钮） */
  async reseed(projectId: string, ctx: CommandContext) {
    return executeCommand('design.review.seed', { projectId, force: true }, { ...ctx, projectId });
  }

  async reopen(projectId: string, drId: string, ctx: CommandContext) {
    return executeCommand('design.review.reopen', { projectId, drId }, { ...ctx, projectId });
  }

  /** 测试/状态观测：并发闸实态（后台跑完成等待点） */
  get selfcheckRunning(): boolean {
    return this.running;
  }

  /**
   * ✦ AI 自检评审入口（POST design:selfcheck；设计覆盖检测 §1 过度设计侧）：
   * 并发闸在飞即 INVALID_STATE；候选为空不空跑；启动即返（八册×N节串行 LLM 远超网关超时，
   * 钉死后台+轮询），进度=前端轮询 DR 列表（分母=返回的候选码集）。
   */
  async selfcheck(projectId: string, ctx: CommandContext): Promise<{ started: boolean; candidates: string[] }> {
    if (this.running) throw new DomainError('INVALID_STATE', '自检评审进行中（完成后可再发起）', 'selfcheck');
    if (!this.ai) throw new DomainError('INVALID_STATE', 'AI 通道未配置，无法自检评审', 'selfcheck');
    // 进闸检查后立即同步置位（reflection.service.ts 先例）：collectCandidates 是 DB 往返，
    // 先 await 再置位的 check-then-set 会让两请求同挤进 await 窗口双双启动（评审抓修）
    this.running = true;
    let background = false;
    try {
      const candidates = await this.collectCandidates(projectId);
      if (candidates.length === 0) return { started: false, candidates: [] };
      background = true;
      void this.runSelfcheck(candidates, { ...ctx, projectId })
        .catch((e) => console.error(`[design-selfcheck] ${e instanceof Error ? e.message : e}`))
        .finally(() => { this.running = false; });
      return { started: true, candidates: candidates.map((c) => c.code).sort() };
    } finally {
      // 仅未启动后台时在此复位（候选为空/collect 抛错）；已启动则由后台的 finally 复位
      if (!background) this.running = false;
    }
  }

  /** 候选清单=八册全扫（草稿优先同 doc.read 口径）剔除 deferred 豁免（dsg 自指行码集；跨域只 SQL 直读） */
  private async collectCandidates(projectId: string): Promise<SelfcheckCandidate[]> {
    const docs = await query<{ doc_kind: string; content: string | null }>(
      `SELECT d.doc_kind, COALESCE(t.content, v.content) AS content
       FROM dsg_documents d
       LEFT JOIN dsg_drafts t ON t.document_id=d.id
       LEFT JOIN dsg_versions v ON v.id=d.current_version_id
       WHERE d.project_id=$1 AND d.doc_kind!='prototype'`, [projectId]);
    const exempt = await query<{ from_code: string }>(
      `SELECT from_code FROM rtm_links
       WHERE project_id=$1 AND from_kind='dsg' AND relation IN ('deferred','dropped')`, [projectId]);
    const exempted = new Set(exempt.rows.map((r) => r.from_code));
    const out: SelfcheckCandidate[] = [];
    for (const d of docs.rows) {
      if (!d.content) continue;
      const secs = splitSections(d.content);
      for (const c of scanOverdesign(d.doc_kind, d.content)) {
        if (exempted.has(c.anchor)) continue;
        const sec = secs.find((s) => s.title === c.title);
        out.push({
          code: `DR-${DSG_BOOK_LETTER[d.doc_kind] ?? d.doc_kind.toUpperCase()}-${c.anchor}`,
          book: d.doc_kind,
          anchor: c.anchor,
          title: c.title,
          sectionText: sec ? `## ${sec.title}\n${sec.md}` : c.title,
        });
      }
    }
    return out;
  }

  /** 后台主流程：逐节串行（事务外 LLM → 单条落项命令事务）；单节失败跳过不中断整场 */
  private async runSelfcheck(candidates: SelfcheckCandidate[], ctx: CommandContext): Promise<void> {
    const projectId = ctx.projectId!;
    for (const c of candidates) {
      try {
        const session = await this.ai!.createSession({ projectId, purpose: 'review' });
        const reqs = await this.reqExcerpts(projectId, c.book);
        const prompt = `${REVIEW_SYSTEM}\n\n【待复核节（${c.book} 册 ${c.anchor}）】\n${c.sectionText}\n\n【PRD 需求节摘录】\n${reqs}`;
        const { deltas, result } = session.stream(prompt);
        const r = await this.awaitModel(session, deltas, result);
        await executeCommand('design.review.selfcheck', {
          projectId, code: c.code, severity: '中', docKind: c.book,
          text: `自检复核（疑似过度设计候选 ${c.anchor}）：${parseReviewOutput(r.text)}`,
        }, ctx);
      } catch (e) {
        // 单节失败不中断整场（候选清单进度按落项计）；并发闸由 selfcheck 的 finally 复位
        console.warn(`[design-selfcheck] ${c.code} 复核失败已跳过: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** PRD 相关 REQ 节摘录（RTM 直读：本册锚点已承接的 REQ 节优先；无链退化为全量 REQ 标题清单） */
  private async reqExcerpts(projectId: string, book: string): Promise<string> {
    const letter = DSG_BOOK_LETTER[book] ?? book.toUpperCase();
    const links = await query<{ from_code: string }>(
      `SELECT DISTINCT from_code FROM rtm_links
       WHERE project_id=$1 AND relation='implements' AND from_kind='req' AND to_code LIKE $2`,
      [projectId, `DSG-${letter}%`]);
    const prd = await query<{ content: string | null }>(
      `SELECT v.content FROM req_documents d JOIN req_versions v ON v.id=d.current_version_id
       WHERE d.project_id=$1 AND d.doc_kind='prd'`, [projectId]);
    const secs = splitSections(prd.rows[0]?.content ?? '').filter((s) => /REQ-\d{3}/.test(s.title));
    if (secs.length === 0) return '（PRD 暂无 REQ 节）';
    const linked = new Set(links.rows.map((r) => r.from_code));
    const picked = linked.size > 0 ? secs.filter((s) => [...linked].some((code) => s.title.includes(code))) : [];
    if (picked.length === 0) {
      return `PRD 需求节标题清单：${secs.map((s) => s.title).join('；')}`.slice(0, 2000);
    }
    let out = '';
    for (const s of picked) {
      const chunk = `## ${s.title}\n${s.md.slice(0, 400)}\n\n`;
      if (out.length + chunk.length > REQ_EXCERPT_BUDGET) break;
      out += chunk;
    }
    return out || picked.map((s) => s.title).join('；');
  }

  /** 单节 LLM 看门狗（reflection awaitModel 同构）：超时 stop 会话并抛错，防静默挂起致并发闸永真 */
  private awaitModel(
    session: AiSession,
    deltas: AsyncIterable<string>,
    result: Promise<AiMessageResult>,
  ): Promise<AiMessageResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try { session.stop(); } catch { /* stop 失败不遮蔽超时主错 */ }
        reject(new DomainError('INVALID_STATE', `自检评审 LLM 调用超时（${REVIEW_WATCHDOG_MIN} 分钟无终态），会话已终止`, 'selfcheck'));
      }, REVIEW_WATCHDOG_MS);
      timer.unref?.(); // 直实例化场景（测试/CLI）不吊住进程
    });
    const drain = (async () => {
      for await (const d of deltas) void d; // 只取终态全文，delta 排空即可
      return result;
    })();
    return Promise.race([drain, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  }
}

/** 复核输出容错抽取（reflection 同族：围栏优先 → 未闭合围栏兜底 → 首尾大括号兜底 → 原文截断兜底） */
function parseReviewOutput(text: string): string {
  let raw = /```json\s*\n([\s\S]*?)```/.exec(text)?.[1]?.trim() ?? '';
  if (!raw) raw = /```json\s*\n([\s\S]*)$/.exec(text)?.[1]?.trim() ?? ''; // 模型漏写收尾 ``` 时取开围栏后全文
  if (!raw) {
    const i = text.indexOf('{');
    const j = text.lastIndexOf('}');
    if (i >= 0 && j > i) raw = text.slice(i, j + 1);
  }
  if (raw) {
    try {
      const j = JSON.parse(raw) as { verdict?: unknown; comment?: unknown };
      if (typeof j.comment === 'string' && j.comment.trim()) {
        const v = j.verdict === 'fail' ? '不通过' : '通过';
        return `${j.comment.trim()}（AI 倾向：${v}）`;
      }
    } catch { /* 解析失败落原文兜底 */ }
  }
  // 兜底：原文截断照样落项（快照式接受陈旧/粗糙，人工结论时自行判断）
  return text.trim().slice(0, 300) || '（模型未产出有效意见）';
}
