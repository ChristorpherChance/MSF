import { create } from 'zustand';
import { ensureProject } from '../material/api';
import { delegateApi, type Delegation, type DelegationTarget } from './api';

/** 委派页会话态（LLD-6 §3.8；DSG-D00 会话态不落库） */
interface DelegateViewState {
  projectId: string | null;
  targets: DelegationTarget[];
  delegations: Delegation[];
  concurrencyMax: number;
  selId: string | null;
  detail: Delegation | null;
  showRegister: boolean;
  showCreate: boolean;
  /** 发起委派预选目标（Target 卡「发起委派」按钮带入） */
  createTarget: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;

  init: () => Promise<void>;
  refresh: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  act: (fn: () => Promise<unknown>, okMsg?: string) => Promise<void>;
  toggleRegister: (v: boolean) => void;
  toggleCreate: (v: boolean, target?: string) => void;
  clearNotice: () => void;
}

export const useDelegateStore = create<DelegateViewState>((set, get) => ({
  projectId: null,
  targets: [],
  delegations: [],
  concurrencyMax: 2,
  selId: null,
  detail: null,
  showRegister: false,
  showCreate: false,
  createTarget: null,
  loading: false,
  error: null,
  notice: null,

  init: async () => {
    const p = await ensureProject();
    set({ projectId: p.id });
    await get().refresh();
  },

  refresh: async () => {
    const pid = get().projectId;
    if (!pid) return;
    set({ loading: true, error: null });
    try {
      const [targets, dl] = await Promise.all([
        delegateApi.targets(pid),
        delegateApi.list(pid),
      ]);
      set({ targets, delegations: dl.items, concurrencyMax: dl.concurrency.max, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  select: async (id) => {
    const pid = get().projectId;
    set({ selId: id, detail: null });
    if (id && pid) set({ detail: await delegateApi.detail(pid, id) });
  },

  act: async (fn, okMsg) => {
    set({ error: null, notice: null });
    try {
      await fn();
      if (okMsg) set({ notice: okMsg });
      await get().refresh();
      const { selId } = get();
      if (selId) await get().select(selId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  toggleRegister: (v) => set({ showRegister: v }),
  toggleCreate: (v, target) => set({ showCreate: v, ...(target !== undefined ? { createTarget: target } : {}) }),
  clearNotice: () => set({ notice: null, error: null }),
}));
