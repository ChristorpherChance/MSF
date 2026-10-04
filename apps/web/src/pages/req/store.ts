import { create } from 'zustand';
import { ensureProject } from '../material/api';
import { toast } from '../../ui/toast';
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
  /** 待确认补丁闪高亮（patchId；与 tocFlash 同构的瞬时 UI 态） */
  patchFlash: string | null;
  /** 跨页「前往审阅」定位触发（时间戳；Paper 消费后清除） */
  patchFocus: number | null;

  init: () => Promise<void>;
  setSubTab: (t: ReqSubTab) => Promise<void>;
  setViewMode: (m: ViewMode) => void;
  refresh: () => Promise<void>;
  refreshRtm: () => Promise<void>;
  loadDoc: (v?: number) => Promise<void>;
  flashToc: (secId: string) => void;
  flashPatch: (patchId: string) => void;
  /** dock 工具卡「前往审阅」：切到目标文档页签并触发补丁定位（patchFocus 由 Paper 消费） */
  focusPatches: (tab?: 'crd' | 'prd') => Promise<void>;
  clearPatchFocus: () => void;
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
  patchFlash: null,
  patchFocus: null,

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
    let { projectId } = get();
    if (!projectId) {
      // W3-003：?tab=rtm 直达竞态——init 尚未落定 projectId 时自举（此前静默 return 致页面永卡「初始化中」）
      const p = await ensureProject();
      projectId = p.id;
      set({ projectId });
    }
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

  flashPatch: (patchId) => {
    set({ patchFlash: patchId });
    setTimeout(() => {
      if (get().patchFlash === patchId) set({ patchFlash: null });
    }, 1600);
  },

  focusPatches: async (tab) => {
    // 先切页签（loadDoc 拉最新补丁），再置定位触发；Paper 在补丁就绪后滚动+闪高亮
    if (tab && get().subTab !== tab) await get().setSubTab(tab);
    set({ patchFocus: Date.now() });
  },

  clearPatchFocus: () => set({ patchFocus: null }),

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
            // W2-008：流完成即重拉（补丁/章节状态立刻渲染，不留「须手动刷新」窗口）
            void get().refresh();
          } else {
            set({ gen: { ...g, running: false, error: f.code ?? '生成失败' } });
            // W2-001：失败人话 toast（工具栏 ⛔ 之外给显性提示；warn 停留 6s）；W2-002：附脱敏原因
            toast(`生成失败（${f.code ?? '未知错误'}）${f.message ? `：${f.message}` : ''}。草稿与版本未受影响，可重新发起；若持续失败请到设置页检查模型连接`, 'warn');
          }
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : '生成失败';
      set((s) => ({
        gen: { ...s.gen, running: false, error: msg },
      }));
      // W2-023：同步 HTTP 拒绝（如 423 门禁）同样显性提示——W2-001 的 toast 原只挂 stream.error 帧分支
      toast(`生成未开始：${msg}`, 'warn');
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

// 对话改文档回环（实机反馈抓修）：dock 提案成功广播 msf:req-proposed → 本页自动切到目标文档并重拉，
// 补丁行内高亮即时可见，不留「须手动刷新」窗口（window 事件解耦 assistant→pages/req 导入方向）
if (typeof window !== 'undefined') {
  window.addEventListener('msf:req-proposed', ((ev: Event) => {
    const kind = (ev as CustomEvent<{ kind?: string }>).detail?.kind;
    const s = useReqView.getState();
    if (!s.projectId) return;
    void (async () => {
      if (kind === 'crd' || kind === 'prd') {
        if (s.subTab !== kind) await s.setSubTab(kind);
        else await s.refresh();
      } else if (s.subTab !== 'rtm') {
        await s.refresh();
      }
      toast('AI 已提交修改建议，正文已刷新——请在行内高亮处逐条处置（接受 / 改后接受 / 拒绝）', 'success');
    })();
  }) as EventListener);
}
