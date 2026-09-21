import { create } from 'zustand';

/** 全局会话态（M01 只持会话态，领域真相在服务端——HLD DSG-M01） */
interface SessionState {
  projectId: string | null;
  setProject: (id: string | null) => void;
}

export const useSession = create<SessionState>((set) => ({
  projectId: null,
  setProject: (projectId) => set({ projectId }),
}));
