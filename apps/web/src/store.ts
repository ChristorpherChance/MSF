import { create } from 'zustand';

/** 全局会话态（M01 只持会话态，领域真相在服务端——HLD DSG-M01） */
const KEY = 'msf.projectId';

interface SessionState {
  projectId: string | null;
  projectName: string | null;
  setProject: (id: string | null, name?: string | null) => void;
}

/** 当前项目（localStorage 持久化；项目页「进入」/新建为 SPA 切换不整页刷新——各域 store 各自 init 重读，跨页长驻件（助手 dock）须订阅本态变更重置，W4-001） */
export const useSession = create<SessionState>((set) => ({
  projectId: localStorage.getItem(KEY),
  projectName: localStorage.getItem(`${KEY}.name`),
  setProject: (projectId, projectName = null) => {
    if (projectId) {
      localStorage.setItem(KEY, projectId);
      localStorage.setItem(`${KEY}.name`, projectName ?? '');
    } else {
      localStorage.removeItem(KEY);
      localStorage.removeItem(`${KEY}.name`);
    }
    set({ projectId, projectName });
  },
}));
