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
  /** 编辑草稿（v11Guard 未保存守卫：text≠base 时切换文件需确认） */
  draft: { fileId: string; base: string; text: string } | null;
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
  guardedSelect: (id: string | null) => boolean;
  init: () => Promise<void>;
  refresh: () => Promise<void>;
}

export const useMaterialView = create<MaterialState>((set, get) => ({
  subTab: 'file',
  viewMode: 'preview',
  selectedFileId: null,
  collapsed: {},
  draft: null,
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

  /** 带未保存守卫的文件选择（v11Guard：编辑脏内容切文件需确认，确认则弃稿） */
  guardedSelect: (id: string | null): boolean => {
    const { draft, selectedFileId } = get();
    if (draft && draft.fileId === selectedFileId && draft.text !== draft.base && id !== selectedFileId) {
      if (!window.confirm('当前编辑未保存，确定放弃修改？')) return false;
    }
    if (id !== selectedFileId) set({ draft: null });
    set({ selectedFileId: id });
    void get().refresh();
    return true;
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
