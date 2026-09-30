import { create } from 'zustand';
import { ensureProject } from '../material/api';
import { designApi } from '../design/api';
import {
  tstApi,
  type PendingHandoff,
  type TstBatch,
  type TstBatchDetail,
  type TstCase,
  type TstCaseRun,
  type TstDecision,
  type TstDefect,
  type TstPlan,
  type TstReport,
  type TstRunItem,
} from './api';

/** 测试验收页会话态（LLD-6 §3.6；DSG-D00 会话态不落库） */

export type TstSubTab = 'plan' | 'run' | 'defect' | 'report';

interface TstViewState {
  projectId: string | null;
  subTab: TstSubTab;
  batches: TstBatch[];
  selBatchId: string | null;
  batchDetail: TstBatchDetail | null;
  pendingHandoffs: PendingHandoff[];
  baselineFp: string | null;
  plan: TstPlan | null;
  cases: TstCase[];
  runs: TstRunItem[];
  latestRunId: string | null;
  caseRuns: TstCaseRun[];
  defects: TstDefect[];
  reports: TstReport[];
  decisions: TstDecision[];
  loading: boolean;
  error: string | null;
  notice: string | null;

  init: () => Promise<void>;
  setSubTab: (t: TstSubTab) => Promise<void>;
  selectBatch: (batchId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  act: (fn: () => Promise<unknown>, okMsg?: string) => Promise<void>;
  clearNotice: () => void;
}

export const useTstStore = create<TstViewState>((set, get) => ({
  projectId: null,
  subTab: 'plan',
  batches: [],
  selBatchId: null,
  batchDetail: null,
  pendingHandoffs: [],
  baselineFp: null,
  plan: null,
  cases: [],
  runs: [],
  latestRunId: null,
  caseRuns: [],
  defects: [],
  reports: [],
  decisions: [],
  loading: false,
  error: null,
  notice: null,

  init: async () => {
    const p = await ensureProject();
    // W2-037：项目变更重置域内会话态（防跨项目写串扰）
    if (get().projectId !== p.id) {
      set({ projectId: p.id, selBatchId: null, batchDetail: null, plan: null, cases: [], runs: [], caseRuns: [], reports: [], decisions: [], notice: null, error: null });
    }
    await get().refresh();
  },

  setSubTab: async (t) => {
    set({ subTab: t, error: null });
    await get().refresh();
  },

  selectBatch: async (batchId) => {
    set({ selBatchId: batchId, batchDetail: null, plan: null, cases: [], runs: [], caseRuns: [], reports: [], decisions: [] });
    await get().refresh();
  },

  refresh: async () => {
    const pid = get().projectId;
    if (!pid) return;
    set({ loading: true, error: null });
    try {
      const [batches, handoffs, baselines] = await Promise.all([
        tstApi.listBatches(pid),
        tstApi.pendingHandoffs(pid),
        designApi.baselines(pid).catch(() => ({ items: [] as Array<{ current?: boolean; fingerprint: string }> })),
      ]);
      const bl = baselines.items.find((b) => b.current) ?? baselines.items[0] ?? null;
      let sel = get().selBatchId;
      if (!sel || !batches.items.some((b) => b.batchId === sel)) {
        sel = batches.items[0]?.batchId ?? null;
      }
      set({ batches: batches.items, pendingHandoffs: handoffs.items, selBatchId: sel, baselineFp: bl?.fingerprint ?? null });
      if (sel) {
        const [detail, planCur, runsV, defectsV, reportsV, decisionsV] = await Promise.all([
          tstApi.batchDetail(pid, sel),
          tstApi.currentPlan(pid, sel).catch(() => ({ plan: null, cases: [] })),
          tstApi.runsOfBatch(pid, sel).catch(() => ({ items: [], latestRunId: null, cases: [] })),
          tstApi.listDefects(pid, sel),
          tstApi.reportsOfBatch(pid, sel).catch(() => ({ items: [] })),
          tstApi.decisions(pid, sel).catch(() => ({ items: [] })),
        ]);
        set({
          batchDetail: detail,
          plan: planCur.plan, cases: planCur.cases,
          runs: runsV.items, latestRunId: runsV.latestRunId, caseRuns: runsV.cases,
          defects: defectsV.items, reports: reportsV.items, decisions: decisionsV.items,
        });
      } else {
        set({ batchDetail: null, plan: null, cases: [], runs: [], latestRunId: null, caseRuns: [], defects: [], reports: [], decisions: [] });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ loading: false });
    }
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
