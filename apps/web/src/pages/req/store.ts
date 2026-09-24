import { create } from 'zustand';
import { ensureProject } from '../material/api';
import {
  reqApi,
  generateDoc,
  type DocKind,
  type DocView,
  type HealthView,
  type PatchItem,
  type ReferenceCandidate,
  type RtmView,
  type VersionItem,
} from './api';

/**
 * 需求页会话态（LLD-6 §3.3；DSG-D00 选择/折叠/视图态不落库，刷新重置）。
 * 领域真相在服务端；本 store 只持当前查看与生成流式暂存。
 */

export type ReqSubTab = 'crd' | 'prd' | 'rtm';
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

interface ReqViewState {
  projectId: string | null;
  subTab: ReqSubTab;
  viewMode: ViewMode;
  doc: DocView | null;
  versions: VersionItem[];
  patches: PatchItem[];
  candidates: ReferenceCandidate[];
  rtm: RtmView | null;
  health: HealthView | null;
  loading: boolean;
  error: string | null;
  gen: GenState;
  tocFlash: string | null;

  init: () => Promise<void>;
  setSubTab: (t: ReqSubTab) => Promise<void>;
  setViewMode: (m: ViewMode) => void;
  refresh: () => Promise<void>;
  refreshRtm: () => Promise<void>;
  loadDoc: (v?: number) => Promise<void>;
  flashToc: (secId: string) => void;
  startGenerate: (instruction?: string) => Promise<void>;
  controlGenerate: (action: 'pause' | 'resume' | 'stop') => Promise<void>;
}

const KINDS: DocKind[] = ['crd', 'prd'];

export const useReqView = create<ReqViewState>((set, get) => ({
  projectId: null,
  subTab: 'crd',
  viewMode: 'preview',
  doc: null,
  versions: [],
  patches: [],
  candidates: [],
  rtm: null,
  health: null,
  loading: false,
  error: null,
  gen: { operationId: null, running: false, paused: false, streamText: '', error: null, source: null },
  tocFlash: null,

  init: async () => {
    const p = await ensureProject();
    set({ projectId: p.id });
    await reqApi.listDocs(p.id); // 首次访问自举 crd/prd 模板
    await get().loadDoc();
  },

  setSubTab: async (t) => {
    set({ subTab: t, error: null });
    if (t === 'rtm') await get().refreshRtm();
    else await get().loadDoc();
  },

  setViewMode: (m) => set({ viewMode: m }),

  refresh: async () => {
    await get().loadDoc(get().doc?.viewing ?? undefined);
  },

  loadDoc: async (v) => {
    const { projectId, subTab } = get();
    if (!projectId || subTab === 'rtm') return;
    set({ loading: true, error: null });
    try {
      const [doc, versions, patches, candidates] = await Promise.all([
        reqApi.getDoc(projectId, subTab, v),
        reqApi.listVersions(projectId, subTab),
        reqApi.listPatches(projectId, subTab),
        reqApi.referenceCandidates(projectId).catch(() => ({ items: [] })),
      ]);
      set({ doc, versions: versions.items, patches: patches.items, candidates: candidates.items, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '加载失败' });
    }
  },

  refreshRtm: async () => {
    const { projectId } = get();
    if (!projectId) return;
    set({ loading: true, error: null });
    try {
      const [rtm, health] = await Promise.all([reqApi.rtm(projectId), reqApi.health(projectId)]);
      set({ rtm, health, loading: false });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '加载失败' });
    }
  },

  flashToc: (secId) => {
    set({ tocFlash: secId });
    setTimeout(() => {
      if (get().tocFlash === secId) set({ tocFlash: null });
    }, 1600);
  },

  /** A04-4 POST-SSE 生成：参考=已挂接 refs（REQ-114 定稿资料）；流式帧增量渲染 */
  startGenerate: async (instruction) => {
    const { projectId, subTab, doc } = get();
    if (!projectId || subTab === 'rtm' || !doc) return;
    const kind = subTab;
    set({
      gen: { operationId: null, running: true, paused: false, streamText: '', error: null, source: null },
      error: null,
    });
    try {
      await generateDoc(
        projectId,
        kind,
        {
          referenceFileIds: doc.refs.map((r) => r.fileId),
          referenceFingerprints: Object.fromEntries(doc.refs.map((r) => [r.fileId, r.fingerprint])),
          ...(instruction ? { instruction } : {}),
        },
        (f) => {
          const g = get().gen;
          if (f.type === 'stream.start') {
            set({ gen: { ...g, operationId: f.operationId ?? null, source: f.source === 'model' ? 'model' : f.source === 'mock' ? 'mock' : null } });
          } else if (f.type === 'stream.delta') {
            set({ gen: { ...g, streamText: g.streamText + (f.text ?? '') } });
          } else if (f.type === 'stream.done') {
            set({ gen: { ...g, operationId: f.operationId ?? g.operationId, running: false } });
          } else {
            set({ gen: { ...g, running: false, error: f.code ?? '生成失败' } });
          }
        },
      );
    } catch (e) {
      set((s) => ({
        gen: { ...s.gen, running: false, error: e instanceof Error ? e.message : '生成失败' },
      }));
    }
    await get().refresh();
  },

  controlGenerate: async (action) => {
    const { projectId, subTab, gen } = get();
    if (!projectId || subTab === 'rtm' || !gen.operationId) return;
    const kind: DocKind = subTab;
    const op = gen.operationId;
    await reqApi.genControl(projectId, kind, op, action);
    if (action === 'stop') {
      set({ gen: { operationId: null, running: false, paused: false, streamText: '', error: null, source: null } });
      await get().refresh();
    } else {
      set((s) => ({ gen: { ...s.gen, paused: action === 'pause' } }));
    }
  },
}));

export { KINDS };
