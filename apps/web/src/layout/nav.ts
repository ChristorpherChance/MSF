/**
 * V2.0 左侧三栏导航配置与布局开关（差异登记：DSG-U02-1/2 顶栏骨架改左栏三栏，待 13 册回补）。
 * - NAV：五阶段 + 各阶段二级页签（label 与各页原 SUB_TABS/TABS 完全一致，dev 的 data-testid 平移）
 * - useLayoutPrefs：rail mini / subnav 收拢两个开关，localStorage 持久（msf.railMini/msf.subClosed，对齐 msf.chatW 先例）
 */
import { create } from 'zustand';

export interface NavSub {
  key: string;
  label: string;
  testid?: string;
}
export interface NavStage {
  key: 'material' | 'req' | 'design' | 'dev' | 'test';
  path: string;
  icon: string;
  name: string;
  subs: NavSub[];
}

export const NAV: NavStage[] = [
  {
    key: 'material', path: '/material', icon: '📂', name: '资料',
    subs: [
      { key: 'file', label: '📥 文件解析' },
      { key: 'content', label: '🛠 内容解析' },
    ],
  },
  {
    key: 'req', path: '/req', icon: '📝', name: '需求',
    subs: [
      { key: 'crd', label: '📝 CRD' },
      { key: 'prd', label: '📦 PRD' },
      { key: 'rtm', label: '🔗 RTM' },
    ],
  },
  {
    key: 'design', path: '/design', icon: '📐', name: '设计',
    subs: [
      { key: 'hld', label: '📐 概要设计' },
      { key: 'detail', label: '📋 详细设计' },
      { key: 'prototype', label: '🖼️ 原型 UI' },
      { key: 'review', label: '🧪 自检评审' },
    ],
  },
  {
    key: 'dev', path: '/dev', icon: '🛠', name: '开发',
    subs: [
      { key: 'plan', label: '任务与计划', testid: 'dev-plan' },
      { key: 'execute', label: '开发执行', testid: 'dev-execute' },
      { key: 'quality', label: '开发自测', testid: 'dev-quality' },
      { key: 'change', label: '变更管理', testid: 'dev-change' },
    ],
  },
  {
    key: 'test', path: '/test', icon: '✅', name: '测试',
    subs: [
      { key: 'plan', label: '提测与计划' },
      { key: 'run', label: '用例与执行' },
      { key: 'defect', label: '缺陷与回归' },
      { key: 'report', label: '报告与交付' },
    ],
  },
];

/** 按路由前缀找当前阶段（非阶段页返回 undefined） */
export function stageOfPath(pathname: string): NavStage | undefined {
  return NAV.find((s) => pathname === s.path || pathname.startsWith(`${s.path}/`));
}

interface LayoutPrefs {
  railMini: boolean;
  subClosed: boolean;
  toggleRail: () => void;
  toggleSub: () => void;
  setSubClosed: (v: boolean) => void;
}

export const useLayoutPrefs = create<LayoutPrefs>((set) => ({
  railMini: localStorage.getItem('msf.railMini') === '1',
  subClosed: localStorage.getItem('msf.subClosed') === '1',
  toggleRail: () => set((s) => {
    const v = !s.railMini;
    localStorage.setItem('msf.railMini', v ? '1' : '0');
    return { railMini: v };
  }),
  toggleSub: () => set((s) => {
    const v = !s.subClosed;
    localStorage.setItem('msf.subClosed', v ? '1' : '0');
    return { subClosed: v };
  }),
  setSubClosed: (v) => {
    localStorage.setItem('msf.subClosed', v ? '1' : '0');
    set({ subClosed: v });
  },
}));
