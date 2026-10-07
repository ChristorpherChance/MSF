import { create } from 'zustand';
import { api } from '../api';
import { ensureProject } from '../pages/material/api';
import { platformApi, type ModelPublic } from '../pages/platform/api';
import {
  assistantApi,
  sendMessageSse,
  type AiMessageRow,
  type AiSessionRow,
  type UsageBreakdown,
} from './api';

/** 助手 dock 会话态（DSG-U02-4；DSG-D00 开合/选择为客户端会话态） */

export type DockTab = 'material' | 'req' | 'design' | 'proto' | 'dev' | 'test';

/** 阶段页内嵌 dock（hasDock 口径）；其余页面浮球+通高抽屉 */
export const STAGE_ROUTES = ['/material', '/req', '/design', '/dev', '/test'];

export const ROUTE_TO_CTX: Record<string, DockTab> = {
  '/material': 'material', '/req': 'req', '/design': 'design',
  '/dev': 'dev', '/test': 'test',
};

export const CTX_LABEL: Record<DockTab, string> = {
  material: '资料', req: '需求', design: '设计', proto: '原型', dev: '开发', test: '测试',
};

/** 会话工件绑定标签（2026-10-08，迁移 0029；与服务端 SESSION_DOC_KINDS 镜像，改动须同步） */
export const DOC_KIND_LABEL: Record<string, string> = {
  crd: 'CRD 客户需求', prd: 'PRD 产品需求',
  hld: '概要设计说明书', mod: '模块设计', alg: '算法与流程', cls: '类与数据结构',
  db: '数据库设计', api: 'API 接口', ui: 'UI 设计', nfr: '非功能规则',
};

/** 草稿/会话分组键：阶段 + 工件（无工件=阶段级） */
export const scopeKey = (ctx: DockTab, docKind: string | null): string => `${ctx}:${docKind ?? ''}`;

/** 阶段感知示例（welcomeHtml 口径） */
export const SUGGESTS: Record<string, string[]> = {
  material: ['总结这份资料的要点', '把这段翻译成中文', '我现在进行到哪了？'],
  req: ['帮我重新生成 CRD', '检查这份 CRD 的遗漏', '把引用段落改写成需求条目'],
  dev: ['我现在进行到哪了？', '开发门禁还差什么？', '下一步该做什么？'],
  proto: ['把首页改成蓝色主题', '对照 PRD 检查页面完整性', '下一步该做什么？'],
  _gen: ['我现在进行到哪了？', '帮我打开 RTM', '试试让我修改文档'],
};

const MODEL_ICONS: Record<string, string> = { pi: '𝜋', openai: '◎', anthropic: '◆', gateway: '⚡' };
export const modelIcon = (m: ModelPublic): string => MODEL_ICONS[m.provider] ?? '🤖';

/** 可用模型：enabled + 已连通（#model-sel「仅已连通」口径） */
export const chatModels = (models: ModelPublic[]): ModelPublic[] =>
  models.filter((m) => m.enabled && m.conn_status === 'ok');

export interface DockUsage {
  tokens: number; win: number; pct: number; color: string; title: string;
}

interface DockState {
  projectId: string | null;
  open: boolean;
  /** 需求页 RTM 页签不内嵌 dock（hasDock L1090-1093） */
  hidden: boolean;
  ctx: DockTab;
  /** 当前工件绑定（req=crd|prd、design=八册 kind；null=阶段级会话组） */
  docKind: string | null;
  /** 已加载会话列表的分组键（scopeKey；W2-054：同值早退须以首载完成为前提） */
  loadedScope: string | null;
  sessions: AiSessionRow[];
  currentId: string | null;
  messages: AiMessageRow[];
  streaming: { messageId: string; text: string; paused: boolean; startedAt: number } | null;
  thinkLevel: 'low' | 'mid' | 'high';
  usage: { tokens_in: string; tokens_out: string; cost: string; calls: string } | null;
  /** 用量分解（统计面板：当前会话/分上下文/分会话）；随 refreshUsage 同刷 */
  breakdown: UsageBreakdown | null;
  models: ModelPublic[];
  /** 模型偏好（localStorage 持久；无会话也可预选，新建会话时带上绑定；有会话时随 setModel 同步） */
  preferredModelId: string | null;
  /** 草稿按上下文页签分存（S.chatDraft[ctx] 口径） */
  drafts: Record<string, string>;
  error: string | null;
  /** 断线行内提示（DSG-U02-7） */
  disconnected: boolean;
  width: number;
  /** 拖选引用 chip（D5 .quote-block；发送时拼 `> 引用` 前缀入 content，服务端不感知） */
  quote: { text: string } | null;
  /** W2-035：参考资料勾选（content_final 候选；随发送提交 referenceFileIds/指纹，服务端 REQ-114 校验） */
  refCandidates: Array<{ fileId: string; name: string; contentFingerprint: string }>;
  refSel: string[];

  init: () => Promise<void>;
  toggle: () => void;
  /** 切换阶段+工件分组：选中某文档时 dock 加载该文档的会话组（无则空组，发送即创建） */
  setCtx: (ctx: DockTab, docKind?: string | null) => Promise<void>;
  setHidden: (h: boolean) => void;
  setThinkLevel: (l: 'low' | 'mid' | 'high') => void;
  setInput: (ctx: DockTab, v: string) => void;
  setWidth: (w: number) => void;
  newSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  setModel: (modelId: string | null) => Promise<void>;
  renameSession: (id: string, name: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  setQuote: (text: string | null) => void;
  loadRefCandidates: () => Promise<void>;
  toggleRef: (fileId: string, on: boolean) => void;
  send: (override?: string) => Promise<void>;
  /** 程序化发消息（拒绝补丁回喂 AI 等场景）：无会话则先新建，复用 send 管道但不消费草稿 */
  sendText: (text: string) => Promise<void>;
  control: (action: 'pause' | 'resume' | 'stop') => Promise<void>;
  refreshUsage: () => Promise<void>;
  refreshModels: () => Promise<void>;
}

const savedWidth = Number(localStorage.getItem('msf.chatW'));

export const useDockStore = create<DockState>((set, get) => ({
  projectId: null,
  open: false,
  hidden: false,
  ctx: 'material',
  docKind: null,
  loadedScope: null,
  sessions: [],
  currentId: null,
  messages: [],
  streaming: null,
  thinkLevel: 'mid',
  usage: null,
  breakdown: null,
  models: [],
  preferredModelId: localStorage.getItem('msf.chatModel') || null,
  drafts: {},
  error: null,
  disconnected: false,
  width: savedWidth >= 300 && savedWidth <= 620 ? savedWidth : 380,
  quote: null,
  refCandidates: [],
  refSel: [],

  init: async () => {
    const p = await ensureProject();
    const changed = get().projectId !== p.id;
    set({ projectId: p.id, ...(changed ? { sessions: [], currentId: null, messages: [], refCandidates: [], refSel: [] } : {}) });
    // 首载时序根修（2026-10-08 实机）：页面工件 effect 可能先于 init 完成（pid 空早退、无 fetch），
    // 而旧 init 又把 docKind 抹回 null——init 完成后以当前 scope 强制重载（loadedScope 清零破早退）
    const { ctx, docKind } = get();
    set({ loadedScope: null });
    await get().setCtx(ctx, docKind);
    await Promise.all([get().refreshUsage(), get().refreshModels()]);
  },

  toggle: () => set({ open: !get().open }),
  setHidden: (h) => set({ hidden: h }),

  setCtx: async (ctx, docKind = null) => {
    const key = scopeKey(ctx, docKind);
    if (scopeKey(get().ctx, get().docKind) === key && get().loadedScope === key) return;
    if (get().streaming) return; // 流式中冻结上下文切换（DSG-U02-7）
    set({ ctx, docKind, sessions: [], currentId: null, messages: [] });
    const pid = get().projectId;
    if (!pid) return;
    // 工件分组过滤只下发 req/design（其余阶段一律 NULL 组，省略参数走老口径）
    const scoped = ctx === 'req' || ctx === 'design';
    const sessions = await assistantApi.sessions(pid, ctx, ...(scoped ? [docKind] as const : []));
    set({ sessions, loadedScope: key });
    if (sessions[0]) await get().selectSession(sessions[0].id);
  },

  setThinkLevel: (l) => set({ thinkLevel: l }),
  setInput: (ctx, v) => set({ drafts: { ...get().drafts, [scopeKey(ctx, get().docKind)]: v } }),

  setWidth: (w) => {
    const width = Math.max(300, Math.min(620, w));
    localStorage.setItem('msf.chatW', String(width));
    set({ width });
  },

  newSession: async () => {
    const { projectId: pid, ctx, docKind, thinkLevel, preferredModelId } = get();
    if (!pid) return;
    // 预选模型随创建绑定（偏好可能已停用/断连——仅仍可用时携带，避免 create 400 断「恒有会话」链）
    const usable = !!preferredModelId && chatModels(get().models).some((m) => m.id === preferredModelId);
    const scoped = ctx === 'req' || ctx === 'design';
    const s = await assistantApi.create(pid, { ctx, thinkLevel, ...(scoped ? { docKind } : {}), ...(usable ? { modelId: preferredModelId } : {}) });
    const sessions = await assistantApi.sessions(pid, ctx, ...(scoped ? [docKind] as const : []));
    set({ sessions });
    await get().selectSession(s.id);
  },

  selectSession: async (id) => {
    const pid = get().projectId;
    if (!pid) return;
    await assistantApi.switchTo(pid, id);
    const messages = await assistantApi.messages(pid, id);
    const sessions = get().sessions.map((x) => (x.id === id ? { ...x, updated_at: new Date().toISOString() } : x));
    set({ currentId: id, messages, sessions });
  },

  setModel: async (modelId) => {
    // 偏好本地持久先行：无会话时也可预选（新建会话带上）；有会话则同时绑定服务端
    if (modelId) localStorage.setItem('msf.chatModel', modelId);
    else localStorage.removeItem('msf.chatModel');
    set({ preferredModelId: modelId });
    const { projectId: pid, currentId } = get();
    if (!pid || !currentId) return;
    await assistantApi.setModel(pid, currentId, modelId);
    set({ sessions: get().sessions.map((x) => (x.id === currentId ? { ...x, model_id: modelId } : x)) });
  },

  renameSession: async (id, name) => {
    const pid = get().projectId;
    if (!pid) return;
    await assistantApi.renameSession(pid, id, name);
    set({ sessions: get().sessions.map((x) => (x.id === id ? { ...x, name } : x)) });
  },

  deleteSession: async (id) => {
    const pid = get().projectId;
    if (!pid) return;
    await assistantApi.deleteSession(pid, id);
    const sessions = get().sessions.filter((x) => x.id !== id);
    set({ sessions });
    // 删除当前会话：切到剩余首个；无剩余则自动新建（dock 恒有会话口径）
    if (get().currentId === id) {
      if (sessions[0]) await get().selectSession(sessions[0].id);
      else { set({ currentId: null, messages: [] }); await get().newSession(); }
    }
  },

  setQuote: (text) => set({ quote: text ? { text: text.slice(0, 500) } : null }),

  loadRefCandidates: async () => {
    const pid = get().projectId;
    if (!pid) return;
    try {
      const r = await api.get<{ items: Array<{ fileId: string; name: string; contentFingerprint: string }> }>(
        `/api/v1/projects/${pid}/materials/references`);
      set({ refCandidates: r.items });
    } catch { /* 候选加载失败不阻塞 dock（发送时服务端 REQ-114 校验兜底） */ }
  },

  toggleRef: (fileId, on) => {
    const cur = get().refSel;
    set({ refSel: on ? [...new Set([...cur, fileId])] : cur.filter((x) => x !== fileId) });
  },

  send: async (override) => {
    // 「该文档暂无会话」空组：发送即创建（恒有会话口径延伸到工件分组，与 sendText 同）
    if (!get().currentId && get().projectId) await get().newSession();
    const { projectId: pid, currentId, ctx, docKind, drafts, thinkLevel, quote, refSel, refCandidates } = get();
    const programmatic = override !== undefined; // 程序化消息：不消费草稿/引用块/参考勾选
    const input = programmatic ? override : (drafts[scopeKey(ctx, docKind)] ?? '');
    if (!pid || !currentId || (!input.trim() && !quote) || get().streaming) return;
    // D5 引用块：拼 `> 引用行` 前缀（每行加 >），服务端按纯文本存
    const quotePrefix = !programmatic && quote
      ? quote.text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n'
      : '';
    const content = (quotePrefix + input.trim()).trim();
    // W2-035：勾选参考随消息提交（指纹快照，服务端 REQ-114/115 校验+登记）
    const referenceFileIds = programmatic ? [] : refSel;
    const referenceFingerprints = programmatic ? {} : Object.fromEntries(
      refCandidates.filter((c) => refSel.includes(c.fileId)).map((c) => [c.fileId, c.contentFingerprint]),
    );
    set(programmatic
      ? { error: null, disconnected: false }
      : { drafts: { ...drafts, [scopeKey(ctx, docKind)]: '' }, quote: null, error: null, disconnected: false });
    set({ messages: [...get().messages, {
      id: `local-${Date.now()}`, role: 'user', content, status: 'done',
      created_at: new Date().toISOString(), durationMs: null, cost: null, toolCalls: [],
    }] });
    let acc = '';
    try {
      await sendMessageSse(pid, currentId, { content, thinkLevel, referenceFileIds, referenceFingerprints }, (f) => {
        if (f.type === 'stream.start' && f.operationId) {
          set({ streaming: { messageId: f.operationId, text: '', paused: false, startedAt: Date.now() } });
        } else if (f.type === 'stream.delta' && f.text) {
          acc += f.text;
          const st = get().streaming;
          if (st) set({ streaming: { ...st, text: acc } });
        } else if (f.type === 'stream.error') {
          // W2-002：错误帧带脱敏 message——失败原因行内可见（不再只有 code/静默）
          set({
            streaming: null,
            disconnected: true,
            error: `生成失败（${f.code ?? '未知'}）${f.message ? `：${f.message}` : ''}`,
          });
        }
      });
      const messages = await assistantApi.messages(pid, currentId);
      set({ streaming: null, messages });
      // 对话改文档回环：本轮回复含 propose_edits 成功提案 → 广播事件，需求/设计页监听后自刷新补丁
      // （window 事件解耦 assistant→pages 导入方向；detail.kind 供目标页签判定）
      const last = messages[messages.length - 1];
      const proposeReq = last?.toolCalls?.find(
        (t) => t.toolName === 'req.doc.propose_edits'
          && (t.resultSummary as { ok?: boolean } | null | undefined)?.ok === true,
      );
      if (proposeReq) {
        const kind = (proposeReq.resultSummary as { kind?: string }).kind;
        window.dispatchEvent(new CustomEvent('msf:req-proposed', { detail: { kind } }));
      }
      const proposeDsg = last?.toolCalls?.find(
        (t) => t.toolName === 'design.doc.propose_edits'
          && (t.resultSummary as { ok?: boolean } | null | undefined)?.ok === true,
      );
      if (proposeDsg) {
        const kind = (proposeDsg.resultSummary as { kind?: string }).kind;
        window.dispatchEvent(new CustomEvent('msf:dsg-proposed', { detail: { kind } }));
      }
      await get().refreshUsage();
    } catch (e) {
      // SSE 断线/失败：行内提示 + 错误条（DSG-U02-7）
      set({
        streaming: null,
        disconnected: true,
        error: e instanceof Error ? e.message : String(e),
      });
      // W2-055：断线恢复后自动补拉——「回复已落库但重拉窗口断网」时回复随网络恢复回到面板，
      // 不再只能手动刷新。online 事件 + 延时重试双通道（断线未必是本地网络，online 可能不触发）；
      // 服务端仍在生成时补拉到的是部分内容，下一次延时重试再追。
      let tries = 0;
      const retry = () => {
        void (async () => {
          try {
            const messages = await assistantApi.messages(pid, currentId);
            set({ messages, disconnected: false, error: null });
            await get().refreshUsage();
          } catch {
            if (++tries < 4) setTimeout(retry, 3000 * tries);
            else window.addEventListener('online', retry, { once: true });
          }
        })();
      };
      setTimeout(retry, 3000);
      window.addEventListener('online', retry, { once: true });
    }
  },

  sendText: async (text) => {
    if (!get().currentId) await get().newSession(); // 恒有会话：拒绝回喂可能发生在尚无会话时
    await get().send(text);
  },

  control: async (action) => {
    const { projectId: pid, streaming } = get();
    if (!pid || !streaming) return;
    await assistantApi.control(pid, streaming.messageId, action);
    if (action === 'pause') set({ streaming: { ...streaming, paused: true } });
    else if (action === 'resume') set({ streaming: { ...streaming, paused: false } });
    else set({ streaming: null });
  },

  refreshUsage: async () => {
    const pid = get().projectId;
    if (!pid) return;
    // 统计面板与顶栏用量同源自刷：breakdown 含 totals，单次请求口径一致
    const bd = await assistantApi.usageBreakdown(pid);
    set({ usage: bd.totals, breakdown: bd });
  },

  refreshModels: async () => {
    try { set({ models: await platformApi.models() }); } catch { /* 模型列表失败不阻塞 dock */ }
  },
}));

/** 当前生效模型：会话绑定 → 本地偏好 → 首个可用（chat 路由默认口径由服务端兜底） */
export function currentModel(s: Pick<DockState, 'models' | 'sessions' | 'currentId' | 'preferredModelId'>): ModelPublic | null {
  const sess = s.sessions.find((x) => x.id === s.currentId);
  const avail = chatModels(s.models);
  const id = sess?.model_id ?? s.preferredModelId;
  if (id) {
    const bound = s.models.find((m) => m.id === id);
    if (bound) return bound;
  }
  return avail[0] ?? null;
}

/** 用量条（usageInfo 口径：会话消息字符/2 估算 tokens ÷ 模型窗口；纯指示不拦截） */
export function dockUsage(s: Pick<DockState, 'messages' | 'streaming' | 'models' | 'sessions' | 'currentId' | 'preferredModelId'>): DockUsage {
  const m = currentModel(s);
  const win = m?.context_window ?? 32768;
  let chars = s.messages.reduce((a, x) => a + (x.content || '').length, 0);
  chars += s.streaming?.text.length ?? 0;
  const tokens = Math.round(chars / 2);
  const pct = Math.min(100, Math.round((tokens / win) * 1000) / 10);
  const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return {
    tokens, win, pct,
    color: pct >= 95 ? 'var(--red)' : pct >= 80 ? 'var(--orange)' : 'var(--blue)',
    title: `已用约 ${fmt(tokens)} / 窗口 ${fmt(win)}（${m?.name ?? '-'}）· 纯指示不拦截`,
  };
}
