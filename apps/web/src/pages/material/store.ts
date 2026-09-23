import { create } from 'zustand';
import {
  ensureProject,
  materialApi,
  type FileDetail,
  type TreeNode,
} from './api';

/**
 * 资料页会话态（DSG-D00：选择/视图/页签属客户端会话，不落库；领域真相在服务端）。
 * 树与详情为服务端读面缓存，任何写动作后调用 refresh() 重拉（SSE 增量随集成里程碑）。
 */
export type MaterialSubTab = 'file' | 'content';
export type ViewMode = 'preview' | 'edit' | 'source';

interface MaterialState {
  // 会话态
  subTab: MaterialSubTab;
  viewMode: ViewMode;
  selectedFileId: string | null;
  collapsed: Record<string, boolean>;
  /** 编辑草稿（v11Guard 未保存守卫：text≠base 时离开编辑需三选确认） */
  draft: { fileId: string; base: string; text: string } | null;
  /** v11Guard 三选 modal（DSG-U02-7）：草稿脏时挂起的动作；null=无守卫 */
  guardNext: (() => void) | null;
  /** 删除双向同步确认 modal 目标（DSG-U07-2；TreePanel 行 🗑 触发，MaterialPage 渲染） */
  deleteTarget: { id: string; name: string } | null;
  /** 批量勾选（会话态；批量解析/批量定稿/批量加工的选集） */
  checked: Record<string, boolean>;
  /** 仅待解析过滤（REQ-106/108：文件面原件树过滤开关，会话态） */
  onlyPending: boolean;
  // 服务端读面
  projectId: string | null;
  originalTree: TreeNode[];
  parsedTree: TreeNode[];
  detail: FileDetail | null;
  loading: boolean;
  error: string | null;
  // 动作
  setSubTab: (t: MaterialSubTab) => void;
  setViewMode: (m: ViewMode) => void;
  selectFile: (id: string | null) => void;
  toggleFolder: (id: string) => void;
  setDraft: (d: { fileId: string; base: string; text: string } | null) => void;
  toggleCheck: (id: string) => void;
  setChecked: (ids: string[], v: boolean) => void;
  clearChecked: () => void;
  setOnlyPending: (v: boolean) => void;
  /** v11Guard：草稿脏则挂起动作弹三选 modal，否则立即执行 */
  requestGuard: (next: () => void) => void;
  setGuardNext: (fn: (() => void) | null) => void;
  setDeleteTarget: (t: { id: string; name: string } | null) => void;
  guardedSelect: (id: string | null) => void;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useMaterialView = create<MaterialState>((set, get) => ({
  subTab: 'file',
  viewMode: 'preview',
  selectedFileId: null,
  collapsed: {},
  draft: null,
  guardNext: null,
  deleteTarget: null,
  checked: {},
  onlyPending: false,
  projectId: null,
  originalTree: [],
  parsedTree: [],
  detail: null,
  loading: false,
  error: null,

  setSubTab: (subTab) => set({ subTab }),
  setViewMode: (viewMode) => set({ viewMode }),
  selectFile: (selectedFileId) => set({ selectedFileId }),
  toggleFolder: (id) =>
    set((s) => ({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } })),
  setDraft: (draft) => set({ draft }),
  toggleCheck: (id) => set((s) => ({ checked: { ...s.checked, [id]: !s.checked[id] } })),
  setChecked: (ids, v) =>
    set((s) => {
      const checked = { ...s.checked };
      for (const id of ids) checked[id] = v;
      return { checked };
    }),
  clearChecked: () => set({ checked: {} }),
  setOnlyPending: (onlyPending) => set({ onlyPending }),

  /** v11Guard（DSG-U02-7）：编辑脏内容时，切文件/切页签/切出编辑态统一挂起为三选 modal */
  requestGuard: (next) => {
    const { draft, selectedFileId } = get();
    const dirty = !!draft && draft.fileId === selectedFileId && draft.text !== draft.base;
    if (dirty) set({ guardNext: next });
    else next();
  },
  setGuardNext: (guardNext) => set({ guardNext }),
  setDeleteTarget: (deleteTarget) => set({ deleteTarget }),

  /** 带未保存守卫的文件选择（v11Guard 三选 modal 由 MaterialPage 渲染承接） */
  guardedSelect: (id: string | null): void => {
    get().requestGuard(() => {
      if (id !== get().selectedFileId) set({ draft: null });
      set({ selectedFileId: id });
      void get().refresh();
    });
  },

  /** 首次进入：定位项目（M1 期取首个/建示例，项目页 M7 实现）并拉双树 */
  init: async () => {
    if (get().projectId) return;
    set({ loading: true, error: null });
    try {
      const p = await ensureProject();
      set({ projectId: p.id });
      await get().refresh();
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  /** 重拉双树 + 当前选中文件详情（视图随页签：文件面=parsed，内容面=content） */
  refresh: async () => {
    const { projectId, selectedFileId, subTab } = get();
    if (!projectId) return;
    set({ loading: true, error: null });
    try {
      const tree = await materialApi.tree(projectId);
      let detail: FileDetail | null = null;
      if (selectedFileId) {
        detail = await materialApi.detail(
          projectId,
          selectedFileId,
          subTab === 'file' ? 'parsed' : 'content',
        );
      }
      set({
        originalTree: tree.originalTree,
        parsedTree: tree.parsedTree,
        detail,
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },
}));
