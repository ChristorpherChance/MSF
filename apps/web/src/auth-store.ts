/** 登录态（部署态简易登录的前端镜像，2026-10-08）：后端未启用时 enabled=false 全放行（本地开发行为不变）。
 *  与 api.ts 解耦：api.ts 收到 401 UNAUTHENTICATED → needLogin()；AuthGate 轮 whoami 成功后 set()。 */
import { create } from 'zustand';

interface AuthState {
  /** 启动探测（GET /api/auth/whoami）是否已完成 */
  checked: boolean;
  /** 后端是否启用登录（未启用=本地开发，直接放行） */
  enabled: boolean;
  user: string | null;
  set(s: { enabled: boolean; user: string | null }): void;
  needLogin(): void;
}

export const useAuthStore = create<AuthState>((set) => ({
  checked: false,
  enabled: false,
  user: null,
  set: (s) => set({ enabled: s.enabled, user: s.user, checked: true }),
  needLogin: () => set({ enabled: true, user: null, checked: true }),
}));
