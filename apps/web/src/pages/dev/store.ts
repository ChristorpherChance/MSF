import { create } from 'zustand';
import { ensureProject } from '../material/api';
import { designApi } from '../design/api';
import {
  devApi,
  type AutopilotStatus,
  type BuildInfo,
  type DevTask,
  type DevTaskDetail,
  type GateResult,
  type ImpactItem,
  type PlanItem,
  type ReportDetail,
  type ReportItem,
} from './api';

/** 开发页会话态（LLD-6 §3.5；DSG-D00 会话态不落库） */

export type DevSubTab = 'plan' | 'board' | 'quality' | 'change';

interface DevViewState {
  projectId: string | null;
  subTab: DevSubTab;
  tasks: DevTask[];
  selTaskId: string | null;
  taskDetail: DevTaskDetail | null;
  startGate: GateResult | null;
  conflicts: Array<{ writeScope: string; taskIds: string[] }>;
  coverage: { ok: boolean; uncoveredDesignItems: string[]; unmatchedTasks: string[] } | null;
  plans: PlanItem[];
  autopilot: AutopilotStatus | null;
  build: BuildInfo | null;
  selftestGate: (GateResult & { report: ReportItem | null }) | null;
  reports: ReportItem[];
  reportDetail: ReportDetail | null;
  transferGate: GateResult | null;
  impacts: ImpactItem[];
  ciSecret: { enabled: boolean; secretMasked?: string } | null;
  baseline: { baselineId: string; code: string; fingerprint: string; valid: boolean } | null;
  loading: boolean;
  error: string | null;
  notice: string | null;

  init: () => Promise<void>;
  setSubTab: (t: DevSubTab) => Promise<void>;
  refresh: () => Promise<void>;
  selectTask: (taskId: string | null) => Promise<void>;
  act: (fn: () => Promise<unknown>, okMsg?: string) => Promise<void>;
  clearNotice: () => void;
}

export const useDevStore = create<DevViewState>((set, get) => ({
  projectId: null,
  subTab: 'plan',
  tasks: [],
  selTaskId: null,
  taskDetail: null,
  startGate: null,
  conflicts: [],
  coverage: null,
  plans: [],
  autopilot: null,
  build: null,
  selftestGate: null,
  reports: [],
  reportDetail: null,
  transferGate: null,
  impacts: [],
  ciSecret: null,
  baseline: null,
  loading: false,
  error: null,
  notice: null,

  init: async () => {
    if (get().projectId) return;
    const p = await ensureProject();
    set({ projectId: p.id });
    await get().refresh();
  },

  setSubTab: async (t) => {
    set({ subTab: t, error: null });
    await get().refresh();
  },

  refresh: async () => {
    const pid = get().projectId;
    if (!pid) return;
    set({ loading: true, error: null });
    try {
      const [tasks, conflicts, coverage, plans, autopilot, build, reports, impacts, ciSecret, baselines] =
        await Promise.all([
          devApi.listTasks(pid),
          devApi.conflicts(pid),
          devApi.coverage(pid),
          devApi.plans(pid),
          devApi.autopilotStatus(pid),
          devApi.buildCurrent(pid),
          devApi.reports(pid),
          devApi.impacts(pid),
          devApi.secretStatus(pid),
          designApi.baselines(pid),
        ]);
      const bl = baselines.items.find((b) => b.current) ?? baselines.items[0] ?? null;
      set({
        tasks: tasks.items, conflicts: conflicts.conflicts, coverage, plans: plans.items, autopilot,
        build: build.build, reports: reports.items, impacts: impacts.items, ciSecret,
        baseline: bl ? { baselineId: bl.baselineId, code: bl.code, fingerprint: bl.fingerprint, valid: bl.valid } : null,
      });
      // 门禁实时求值（质量/变更页签用）
      const [sg, tg] = await Promise.all([
        devApi.selftestGate(pid).catch(() => null),
        devApi.transferGate(pid).catch(() => null),
      ]);
      set({ selftestGate: sg, transferGate: tg });
      const sel = get().selTaskId;
      if (sel) {
        const [detail, gate] = await Promise.all([
          devApi.taskDetail(pid, sel),
          devApi.startGate(pid, sel).catch(() => null),
        ]);
        set({ taskDetail: detail, startGate: gate });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
  },

  selectTask: async (taskId) => {
    set({ selTaskId: taskId, taskDetail: null, startGate: null });
    const pid = get().projectId;
    if (!pid || !taskId) return;
    const [detail, gate] = await Promise.all([
      devApi.taskDetail(pid, taskId),
      devApi.startGate(pid, taskId).catch(() => null),
    ]);
    set({ taskDetail: detail, startGate: gate });
  },

  /** 命令执行包装：错误落 error、成功刷新+notice（人工操作即领域命令，审计由服务端承载） */
  act: async (fn, okMsg) => {
    set({ error: null, notice: null });
    try {
      await fn();
      if (okMsg) set({ notice: okMsg });
      await get().refresh();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  clearNotice: () => set({ notice: null, error: null }),
}));
