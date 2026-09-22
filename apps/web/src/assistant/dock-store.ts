import { create } from 'zustand';
import { ensureProject } from '../pages/material/api';
import {
  assistantApi,
  sendMessageSse,
  type AiMessageRow,
  type AiSessionRow,
} from './api';

/** 助手 dock 会话态（U02-4；DSG-D00 开合/选择为客户端会话态） */

export type DockTab = 'material' | 'req' | 'design' | 'proto' | 'dev' | 'test';

export const ROUTE_TO_CTX: Record<string, DockTab> = {
  '/material': 'material', '/req': 'req', '/design': 'design',
  '/proto': 'proto', '/dev': 'dev', '/test': 'test', '/delegate': 'dev',
};

export const CTX_LABEL: Record<DockTab, string> = {
  material: '资料', req: '需求', design: '设计', proto: '原型', dev: '开发', test: '测试',
};

interface DockState {
  projectId: string | null;
  open: boolean;
  ctx: DockTab;
  sessions: AiSessionRow[];
  currentId: string | null;
  messages: AiMessageRow[];
  streaming: { messageId: string; text: string; paused: boolean } | null;
  thinkLevel: 'low' | 'mid' | 'high';
  usage: { tokens_in: string; tokens_out: string; cost: string; calls: string } | null;
  input: string;
  error: string | null;

  init: () => Promise<void>;
  toggle: () => void;
  setCtx: (ctx: DockTab) => Promise<void>;
  setThinkLevel: (l: 'low' | 'mid' | 'high') => void;
  setInput: (v: string) => void;
  newSession: () => Promise<void>;
  selectSession: (id: string) => Promise<void>;
  send: () => Promise<void>;
  control: (action: 'pause' | 'resume' | 'stop') => Promise<void>;
  refreshUsage: () => Promise<void>;
}

export const useDockStore = create<DockState>((set, get) => ({
  projectId: null,
  open: false,
  ctx: 'material',
  sessions: [],
  currentId: null,
  messages: [],
  streaming: null,
  thinkLevel: 'mid',
  usage: null,
  input: '',
  error: null,

  init: async () => {
    const p = await ensureProject();
    set({ projectId: p.id });
    await get().refreshUsage();
  },

  toggle: () => set({ open: !get().open }),

  setCtx: async (ctx) => {
    if (get().ctx === ctx) return;
    set({ ctx, sessions: [], currentId: null, messages: [] });
    const pid = get().projectId;
    if (!pid) return;
    const sessions = await assistantApi.sessions(pid, ctx);
    set({ sessions });
    if (sessions[0]) await get().selectSession(sessions[0].id);
  },

  setThinkLevel: (l) => set({ thinkLevel: l }),
  setInput: (v) => set({ input: v }),

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
    set({ currentId: id, messages });
  },

  send: async () => {
    const { projectId: pid, currentId, input, thinkLevel } = get();
    if (!pid || !currentId || !input.trim() || get().streaming) return;
    const content = input.trim();
    set({ input: '', error: null });
    set({ messages: [...get().messages, {
      id: `local-${Date.now()}`, role: 'user', content, status: 'done', created_at: new Date().toISOString(),
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
      const pid2 = get().projectId!;
      const messages = await assistantApi.messages(pid2, currentId);
      set({ streaming: null, messages });
      await get().refreshUsage();
    } catch (e) {
      set({ streaming: null, error: e instanceof Error ? e.message : String(e) });
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
}));
