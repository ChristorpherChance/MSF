import { create } from 'zustand';
import './ui.css';

/** Toast：顶部居中堆叠、2.4s 自动消退、不阻塞操作（DSG-U02-5/U01-5） */

export interface ToastItem { id: number; text: string; kind: 'default' | 'success' | 'warn' }

interface ToastState {
  items: ToastItem[];
  push: (text: string, kind?: ToastItem['kind']) => void;
  drop: (id: number) => void;
}

let seq = 0;

export const useToastStore = create<ToastState>((set) => ({
  items: [],
  push: (text, kind = 'default') => {
    const id = ++seq;
    set((s) => ({ items: [...s.items, { id, text, kind }] }));
    // 错误/警告类 toast 停留更久（2.4s 常被错过，U-005/U-011）
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), kind === 'warn' ? 6000 : 2400);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));

/** 命令式入口：`toast('已新建会话')` / `toast('失败', 'warn')` */
export function toast(text: string, kind?: ToastItem['kind']): void {
  useToastStore.getState().push(text, kind);
}

export function Toaster() {
  const items = useToastStore((s) => s.items);
  return (
    <div id="toast-wrap">
      {items.map((t) => (
        <div key={t.id} className={`toast${t.kind !== 'default' ? ` ${t.kind}` : ''}`}>{t.text}</div>
      ))}
    </div>
  );
}
