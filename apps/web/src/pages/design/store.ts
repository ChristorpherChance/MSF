import { create } from 'zustand';
import { ensureProject } from '../material/api';
import {
  designApi,
  type CatalogView,
  type DesignDocItem,
  type DesignDocView,
  type DesignKind,
  type GateResult,
  type PatchItem,
  type ProtoStatus,
  type ReviewItem,
} from './api';

/** 设计页会话态（LLD-6 §3.4；DSG-D00 会话态不落库） */

export type DesignSubTab = 'hld' | 'detail' | 'prototype' | 'review';
export type ViewMode = 'preview' | 'edit' | 'source';

interface GenState {
  operationId: string | null;
  running: boolean;
  paused: boolean;
  streamText: string;
  error: string | null;
}

interface DesignViewState {
  projectId: string | null;
  subTab: DesignSubTab;
  viewMode: ViewMode;
  books: DesignDocItem[];
  selKind: DesignKind;
  doc: DesignDocView | null;
  versions: Array<{ v: number; note: string | null; at: string; finalized: boolean }>;
  patches: PatchItem[];
  openReviews: number;
  reviews: ReviewItem[];
  catalog: CatalogView | null;
  proto: ProtoStatus | null;
  gen: GenState;
  tocFlash: string | null;
  loading: boolean;
  error: string | null;

  init: () => Promise<void>;
  setSubTab: (t: DesignSubTab) => Promise<void>;
  selectBook: (k: DesignKind) => Promise<void>;
  setViewMode: (m: ViewMode) => void;
  refresh: () => Promise<void>;
  loadDoc: (v?: number) => Promise<void>;
  refreshProto: () => Promise<void>;
  refreshReviews: () => Promise<void>;
  flashToc: (secId: string) => void;
  gate: (action: 'generate' | 'check' | 'finalize' | 'develop') => Promise<GateResult>;
}

export const useDesignView = create<DesignViewState>((set, get) => ({
  projectId: null,
  subTab: 'hld',
  viewMode: 'preview',
  books: [],
  selKind: 'hld',
  doc: null,
  versions: [],
  patches: [],
  openReviews: 0,
  reviews: [],
  catalog: null,
  proto: null,
  gen: { operationId: null, running: false, paused: false, streamText: '', error: null },
  tocFlash: null,
  loading: false,
  error: null,

  init: async () => {
    const p = await ensureProject();
    set({ projectId: p.id });
    const list = await designApi.listDocs(p.id); // 首访自举八册
    set({ books: list.items });
    await Promise.all([get().loadDoc(), get().refreshReviews()]);
  },

  setSubTab: async (t) => {
    set({ subTab: t, error: null });
    if (t === 'hld') { set({ selKind: 'hld' }); await get().loadDoc(); }
    if (t === 'detail') { set({ selKind: 'mod' }); await get().loadDoc(); }
    if (t === 'prototype') await get().refreshProto();
    if (t === 'review') await get().refreshReviews();
  },

  selectBook: async (k) => {
    set({ selKind: k });
    await get().loadDoc();
  },

  setViewMode: (m) => set({ viewMode: m }),

  refresh: async () => {
    const { projectId } = get();
    await get().loadDoc(get().doc?.viewing ?? undefined);
    if (projectId) {
      const list = await designApi.listDocs(projectId);
      set({ books: list.items });
    }
  },

  loadDoc: async (v) => {
    const { projectId, selKind } = get();
    if (!projectId) return;
    set({ loading: true, error: null });
    try {
      const [doc, versions, patches] = await Promise.all([
        designApi.getDoc(projectId, selKind, v),
        designApi.listVersions(projectId, selKind),
        designApi.listPatches(projectId, selKind),
      ]);
      set({ doc, versions: versions.items, patches: patches.items, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '加载失败' });
    }
  },

  refreshProto: async () => {
    const { projectId } = get();
    if (!projectId) return;
    set({ loading: true, error: null });
    try {
      const [proto, catalog] = await Promise.all([
        designApi.protoStatus(projectId),
        designApi.catalog(projectId),
      ]);
      set({ proto, catalog, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '加载失败' });
    }
  },

  refreshReviews: async () => {
    const { projectId } = get();
    if (!projectId) return;
    const r = await designApi.reviews(projectId);
    set({ reviews: r.items, openReviews: r.items.filter((x) => x.status === 'open').length });
  },

  flashToc: (secId) => {
    set({ tocFlash: secId });
    setTimeout(() => {
      if (get().tocFlash === secId) set({ tocFlash: null });
    }, 1600);
  },

  gate: (action) => designApi.gates(get().projectId!, action),
}));
