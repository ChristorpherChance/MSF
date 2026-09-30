import { create } from 'zustand';
import { ensureProject } from '../pages/material/api';
import { platformApi, type ModelPublic } from '../pages/platform/api';
import {
  assistantApi,
  sendMessageSse,
  type AiMessageRow,
  type AiSessionRow,
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
  /** 已加载会话列表的 ctx（W2-054：setCtx 同值早退须以首载完成为前提，否则刷新后列表永空） */
  loadedCtx: DockTab | null;
  sessions: AiSessionRow[];
  currentId: string | null;
  messages: AiMessageRow[];
  streaming: { messageId: string; text: string; paused: boolean } | null;
  thinkLevel: 'low' | 'mid' | 'high';
  usage: { tokens_in: string; tokens_out: string; cost: string; calls: string } | null;
  models: ModelPublic[];
  /** 草稿按上下文页签分存（S.chatDraft[ctx] 口径） */
  drafts: Record<string, string>;
  error: string | null;
  /** 断线行内提示（DSG-U02-7） */
  disconnected: boolean;
  width: number;
  /** 拖选引用 chip（D5 .quote-block；发送时拼 `> 引用` 前缀入 content，服务端不感知） */
  quote: { text: string } | null;

  init: () => Promise<void>;
  toggle: () => void;
  setCtx: (ctx: DockTab) => Promise<void>;
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
  send: () => Promise<void>;
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
  loadedCtx: null,
  sessions: [],
  currentId: null,
  messages: [],
  streaming: null,
  thinkLevel: 'mid',
  usage: null,
  models: [],
  drafts: {},
  error: null,
  disconnected: false,
  width: savedWidth >= 300 && savedWidth <= 620 ? savedWidth : 380,
  quote: null,

  init: async () => {
    const p = await ensureProject();
    const changed = get().projectId !== p.id;
    set({ projectId: p.id, ...(changed ? { loadedCtx: null, sessions: [], currentId: null, messages: [] } : {}) });
    await Promise.all([get().refreshUsage(), get().refreshModels()]);
  },

  toggle: () => set({ open: !get().open }),
  setHidden: (h) => set({ hidden: h }),

  setCtx: async (ctx) => {
    if (get().ctx === ctx && get().loadedCtx === ctx) return;
    if (get().streaming) return; // 流式中冻结上下文切换（DSG-U02-7）
    set({ ctx, sessions: [], currentId: null, messages: [] });
    const pid = get().projectId;
    if (!pid) return;
    const sessions = await assistantApi.sessions(pid, ctx);
    set({ sessions, loadedCtx: ctx });
    if (sessions[0]) await get().selectSession(sessions[0].id);
  },

  setThinkLevel: (l) => set({ thinkLevel: l }),
  setInput: (ctx, v) => set({ drafts: { ...get().drafts, [ctx]: v } }),

  setWidth: (w) => {
    const width = Math.max(300, Math.min(620, w));
    localStorage.setItem('msf.chatW', String(width));
    set({ width });
  },

  newSession: async () => {
    const { projectId: pid, ctx, thinkLevel } = get();
    if (!pid) return;
    const s = await assistantApi.create(pid, { ctx, thinkLevel });
    const sessions = await assistantApi.sessions(pid, ctx);
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

  send: async () => {
    const { projectId: pid, currentId, ctx, drafts, thinkLevel, quote } = get();
    const input = drafts[ctx] ?? '';
    if (!pid || !currentId || (!input.trim() && !quote) || get().streaming) return;
    // D5 引用块：拼 `> 引用行` 前缀（每行加 >），服务端按纯文本存
    const quotePrefix = quote
      ? quote.text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n'
      : '';
    const content = (quotePrefix + input.trim()).trim();
    set({ drafts: { ...drafts, [ctx]: '' }, quote: null, error: null, disconnected: false });
    set({ messages: [...get().messages, {
      id: `local-${Date.now()}`, role: 'user', content, status: 'done',
      created_at: new Date().toISOString(), durationMs: null, cost: null, toolCalls: [],
    }] });
    let acc = '';
    try {
      await sendMessageSse(pid, currentId, { content, thinkLevel }, (f) => {
        if (f.type === 'stream.start' && f.operationId) {
          set({ streaming: { messageId: f.operationId, text: '', paused: false } });
        } else if (f.type === 'stream.delta' && f.text) {
          acc += f.text;
          const st = get().streaming;
          if (st) set({ streaming: { ...st, text: acc } });
        }
      });
      const messages = await assistantApi.messages(pid, currentId);
      set({ streaming: null, messages });
      await get().refreshUsage();
    } catch (e) {
      // SSE 断线/失败：行内提示 + 错误条（DSG-U02-7）
      set({
        streaming: null,
        disconnected: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
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
    const r = await assistantApi.usage(pid);
    set({ usage: r.totals });
  },

  refreshModels: async () => {
    try { set({ models: await platformApi.models() }); } catch { /* 模型列表失败不阻塞 dock */ }
  },
}));

/** 当前会话绑定模型；未绑定回落首个可用模型（chat 路由默认口径由服务端兜底） */
export function currentModel(s: Pick<DockState, 'models' | 'sessions' | 'currentId'>): ModelPublic | null {
  const sess = s.sessions.find((x) => x.id === s.currentId);
  const avail = chatModels(s.models);
  if (sess?.model_id) {
    const bound = s.models.find((m) => m.id === sess.model_id);
    if (bound) return bound;
  }
  return avail[0] ?? null;
}

/** 用量条（usageInfo 口径：会话消息字符/2 估算 tokens ÷ 模型窗口；纯指示不拦截） */
export function dockUsage(s: Pick<DockState, 'messages' | 'streaming' | 'models' | 'sessions' | 'currentId'>): DockUsage {
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
