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
  type ReferenceCandidate,
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
  /** #5 生成来源（stream.start 首帧携带）：model=真模型 / mock=桩 */
  source: 'model' | 'mock' | null;
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
  /** L7 生成参考候选（资料域 content_final 清单，popover 打开时懒加载） */
  refCandidates: ReferenceCandidate[];
  /** L7 生成期参考勾选：kind → fileId 集合；随下次生成提交，指纹快照进 dsg_versions.refs */
  refSel: Partial<Record<DesignKind, string[]>>;
  /** S9 再定稿影响提示（impactTrigger 口径：定稿成功后置，人工关闭） */
  impactNotice: string | null;
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
  /** 补丁定位闪高亮（需求阶段模式推广，与 req store 同构） */
  patchFlash: string | null;
  flashPatch: (patchId: string) => void;
  setImpactNotice: (msg: string | null) => void;
  gate: (action: 'generate' | 'check' | 'finalize' | 'develop') => Promise<GateResult>;
  loadRefCandidates: () => Promise<void>;
  toggleRef: (kind: DesignKind, fileId: string, on: boolean) => void;
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
  gen: { operationId: null, running: false, paused: false, streamText: '', error: null, source: null },
  tocFlash: null,
  refCandidates: [],
  refSel: {},
  impactNotice: null,
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

  // 需求阶段模式推广：补丁定位闪高亮（与 req store flashPatch 同构，供常驻横幅「定位第一条」用）
  patchFlash: null as string | null,
  flashPatch: (patchId: string) => {
    set({ patchFlash: patchId });
    setTimeout(() => {
      if (get().patchFlash === patchId) set({ patchFlash: null });
    }, 1600);
  },

  gate: (action) => designApi.gates(get().projectId!, action),

  setImpactNotice: (msg) => set({ impactNotice: msg }),

  loadRefCandidates: async () => {
    const { projectId, refCandidates } = get();
    if (!projectId || refCandidates.length > 0) return;
    const r = await designApi.referenceCandidates(projectId);
    set({ refCandidates: r.items });
  },

  toggleRef: (kind, fileId, on) => {
    const cur = get().refSel[kind] ?? [];
    const next = on ? [...new Set([...cur, fileId])] : cur.filter((x) => x !== fileId);
    set({ refSel: { ...get().refSel, [kind]: next } });
  },
}));

// 对话改设计册回环（与 req 域 msf:req-proposed 同构）：dock 提案成功广播 msf:dsg-proposed →
// 落位目标册（直写 subTab+selKind——setSubTab 会把 detail 的 selKind 强制回 mod，丢目标册）并重拉，
// 补丁行内高亮即时可见；监听挂模块级，SubNav 常驻即全域生效
if (typeof window !== 'undefined') {
  window.addEventListener('msf:dsg-proposed', ((ev: Event) => {
    const kind = (ev as CustomEvent<{ kind?: string }>).detail?.kind as DesignKind | undefined;
    const s = useDesignView.getState();
    if (!s.projectId || !kind) return;
    void (async () => {
      useDesignView.setState({ subTab: kind === 'hld' ? 'hld' : 'detail', selKind: kind });
      const { toast } = await import('../../ui/toast');
      await useDesignView.getState().loadDoc();
      await useDesignView.getState().refresh();
      toast('AI 已提交设计册修改建议，正文已刷新——请在行内高亮处逐条处置（接受 / 拒绝）', 'success');
    })();
  }) as EventListener);
}
