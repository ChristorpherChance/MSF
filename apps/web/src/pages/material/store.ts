import { create } from 'zustand';

/**
 * 资料页会话态（DSG-D00：选择/视图/页签属客户端会话，不落库；领域真相在服务端）。
 * T1-17 先持页签与三态视图；T1-18/19 追加选中文件、批量勾选等。
 */
export type MaterialSubTab = 'file' | 'content';
export type ViewMode = 'preview' | 'edit' | 'source';

interface MaterialViewState {
  subTab: MaterialSubTab;
  viewMode: ViewMode;
  selectedFileId: string | null;
  setSubTab: (t: MaterialSubTab) => void;
  setViewMode: (m: ViewMode) => void;
  selectFile: (id: string | null) => void;
}

export const useMaterialView = create<MaterialViewState>((set) => ({
  subTab: 'file',
  viewMode: 'preview',
  selectedFileId: null,
  setSubTab: (subTab) => set({ subTab }),
  setViewMode: (viewMode) => set({ viewMode }),
  selectFile: (selectedFileId) => set({ selectedFileId }),
}));
