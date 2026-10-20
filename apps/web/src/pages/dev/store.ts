import { create } from 'zustand';
import { ApiError } from '../../api';
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
  type ReportItem,
} from './api';

/** 开发页会话态（LLD-6 §3.5 两层导航；DSG-D00 会话态不落库） */

export type DevTopTab = 'plan' | 'execute' | 'quality' | 'change';
/** plan 左栏：all/gap/req:REQ-xxx 过滤 + 三视图（L4：REQ 过滤行对齐原型 devSideHtml plan 组） */
export type DevPlanFilter = 'all' | 'gap' | `req:${string}`;
export type DevPlanView = 'business' | 'division' | 'order';
/** V4 注意项页签 */
export type DevAttentionView = 'human' | 'ai' | 'all';
export type DevExecutePage = 'board' | 'repo' | 'std' | 'preview';
export type DevQualityPage = 'targets' | 'unit' | 'pr' | 'build' | 'selftest';
export type DevChangePage = 'impacts' | 'baseline' | 'history';

interface DevViewState {
  projectId: string | null;
  topTab: DevTopTab;
  planFilter: DevPlanFilter;
  planQuery: string;
  planView: DevPlanView;
  attentionView: DevAttentionView;
  manualToolsOpen: boolean;
  executePage: DevExecutePage;
  qualityPage: DevQualityPage;
  changePage: DevChangePage;
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
  transferGate: GateResult | null;
  impacts: ImpactItem[];
  ciSecret: { enabled: boolean; secretMasked?: string } | null;
  baseline: { baselineId: string; code: string; fingerprint: string; valid: boolean; items: Array<{ artifact: string; version_id: string | null; fingerprint: string | null }> } | null;
  /** L4 REQ 过滤行：设计目录页条目（code → reqIds），任务 sourceIds 经此映射 REQ */
  catalogPages: Array<{ code: string; title: string; reqIds: string[] }>;
  loading: boolean;
  error: string | null;
  notice: string | null;

  init: () => Promise<void>;
  setTopTab: (t: DevTopTab) => Promise<void>;
  setSide: (key: string) => void;
  setPlanView: (v: DevPlanView) => void;
  setPlanFilter: (f: DevPlanFilter) => void;
  setPlanQuery: (q: string) => void;
  setAttentionView: (v: DevAttentionView) => void;
  toggleManualTools: () => void;
  refresh: () => Promise<void>;
  selectTask: (taskId: string | null) => Promise<void>;
  act: (fn: () => Promise<unknown>, okMsg?: string) => Promise<void>;
  /** U-039：写操作进行中标记（防连点双发；服务端幂等为兜底，不等兜底） */
  acting: boolean;
  clearNotice: () => void;
}

export const useDevStore = create<DevViewState>((set, get) => ({
  projectId: null,
  topTab: 'plan',
  planFilter: 'all',
  planQuery: '',
  planView: 'business',
  attentionView: 'human',
  manualToolsOpen: false,
  executePage: 'board',
  qualityPage: 'targets',
  changePage: 'impacts',
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
  transferGate: null,
  impacts: [],
  ciSecret: null,
  baseline: null,
  catalogPages: [],
  loading: false,
  error: null,
  notice: null,
  acting: false,

  init: async () => {
    const p = await ensureProject();
    // W2-037：项目变更重置域内会话态（防跨项目写串扰）
    if (get().projectId !== p.id) {
      set({ projectId: p.id, selTaskId: null, taskDetail: null, startGate: null, notice: null, error: null });
    }
    await get().refresh();
  },

  setTopTab: async (t) => {
    set({ topTab: t, selTaskId: null, taskDetail: null, startGate: null, error: null });
    await get().refresh();
  },

  /** 左栏切换（按当前顶页签路由到对应工作区键；plan 支持 req:REQ-xxx 过滤行） */
  setSide: (key) => {
    const t = get().topTab;
    if (t === 'plan') set({ planFilter: key.startsWith('req:') ? (key as DevPlanFilter) : key === 'gap' ? 'gap' : 'all' });
    else if (t === 'execute') set({ executePage: key as DevExecutePage });
    else if (t === 'quality') set({ qualityPage: key as DevQualityPage });
    else set({ changePage: key as DevChangePage });
    set({ selTaskId: null, taskDetail: null, startGate: null });
  },

  setPlanView: (v) => set({ planView: v }),
  setPlanFilter: (f) => set({ planFilter: f }),
  setPlanQuery: (q) => set({ planQuery: q }),
  setAttentionView: (v) => set({ attentionView: v }),
  toggleManualTools: () => set({ manualToolsOpen: !get().manualToolsOpen }),

  refresh: async () => {
    const pid = get().projectId;
    if (!pid) return;
    set({ loading: true, error: null });
    try {
      const [tasks, conflicts, coverage, plans, autopilot, build, reports, impacts, ciSecret, baselines, catalog, blLive] =
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
          designApi.catalog(pid).catch(() => null), // L4 REQ 过滤行：目录缺失不阻断开发页
          devApi.baselineLive(pid).catch(() => null), // 基线 valid 读时派生（落库列永真不可信）
        ]);
      const bl = baselines.items.find((b) => b.current) ?? baselines.items[0] ?? null;
      set({
        tasks: tasks.items, conflicts: conflicts.conflicts, coverage, plans: plans.items, autopilot,
        build: build.build, reports: reports.items, impacts: impacts.items, ciSecret,
        baseline: bl ? { baselineId: bl.baselineId, code: bl.code, fingerprint: bl.fingerprint, valid: blLive ? !blLive.stale : bl.valid, items: bl.items } : null,
        catalogPages: ((catalog?.groups.page ?? []) as Array<{ code: string; payload: Record<string, unknown> }>).map((p) => ({
          code: p.code,
          title: (p.payload.title as string) ?? p.code,
          reqIds: (p.payload.reqIds as string[] | undefined) ?? [],
        })),
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
    if (get().acting) return; // U-039：写操作进行中，忽略重复触发
    set({ acting: true, error: null, notice: null });
    try {
      await fn();
      if (okMsg) set({ notice: okMsg });
      await get().refresh();
    } catch (e) {
      // W2-012：门禁拒绝（423 GATE_BLOCKED）带缺口清单——逐条修复引导文案必须呈现，不静默
      if (e instanceof ApiError && e.code === 'GATE_BLOCKED' && e.details) {
        const issues = (e.details as { issues?: Array<{ code: string; message: string }> }).issues;
        if (issues?.length) {
          set({ error: `${e.message}：\n${issues.map((i) => `・${i.message}`).join('\n')}` });
          return;
        }
      }
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ acting: false });
    }
  },

  clearNotice: () => set({ notice: null, error: null }),
}));

/** 分工标签/色（原型 devKindLabel/devKindClass） */
export const KIND_LABEL: Record<string, string> = { frontend: '前端', backend: '后端', common: '公共', integration: '联调' };
export const KIND_CLASS: Record<string, string> = { frontend: 'blue', backend: 'green', common: 'orange', integration: 'red' };
/** 承接图标（原型 asgIcon：agent→🤖 human→👤） */
export const asgIcon = (ownerType: string) => (ownerType === 'human' ? '👤' : '🤖');

/** autopilot 运行状态文案（原型 v18AutoStatusHtml 口径） */
export const RUN_STATUS_LABEL: Record<string, string> = {
  running: '自动执行中', paused: '已暂停', blocked: '已阻断·需要处理', stopped: '已停止',
  'taken-over': '人工接管', 'awaiting-transfer': '等待确认转测试', transferred: '已转测试',
};

/** L6 autopilot 阶段标签（原型 v18AutoStatusHtml phases 映射；selftest 为真实管线扩展档） */
export const RUN_PHASE_LABEL: Record<string, string> = {
  dispatch: '等待派发', development: '开发', quality: '单测与 CI', 'ai-review': '独立 AI 评审',
  merge: '合并', build: '集成构建', selftest: '项目自测', 'awaiting-transfer': '等待确认转测试',
};

/** V4 注意项模型（原型 devAttentionModel 同口径，全部由真实数据派生） */
export interface AttentionRow {
  key: string; kind: 'task' | 'gap'; taskId: string; sourceId: string; title: string;
  severity: 'blocking' | 'normal'; assigneeType: 'human' | 'ai'; reasons: string[];
}
export function attentionModel(s: Pick<DevViewState, 'tasks' | 'coverage' | 'baseline' | 'impacts' | 'autopilot'>) {
  const human = new Map<string, AttentionRow>();
  const ai = new Map<string, AttentionRow>();
  const add = (bucket: Map<string, AttentionRow>, row: AttentionRow) => {
    const found = bucket.get(row.key);
    if (found) { found.reasons.push(...row.reasons); if (row.severity === 'blocking') found.severity = 'blocking'; }
    else bucket.set(row.key, row);
  };
  const base = (t: DevTask): AttentionRow => ({
    key: `task:${t.code}`, kind: 'task', taskId: t.id, sourceId: '', title: `${t.code} · ${t.title}`,
    severity: 'normal', assigneeType: t.ownerType === 'human' ? 'human' : 'ai', reasons: [],
  });
  const doneCodes = new Set(s.tasks.filter((t) => t.col === 'done').map((t) => t.code));
  for (const t of s.tasks) {
    if (t.specIssues.length > 0) {
      add(human, { ...base(t), severity: 'blocking', reasons: t.specIssues.slice(0, 3) });
    }
    if (t.coveragePending > 0) {
      add(ai, { ...base(t), reasons: [`覆盖核对 ${t.coverageTotal - t.coveragePending}/${t.coverageTotal}，可按当前来源与任务修订核对`] });
    }
    if (t.batchNo === null) {
      add(ai, { ...base(t), reasons: ['依赖与写入范围可自动编排'] });
    }
    if (t.unit && !t.unit.pass) {
      add(human, { ...base(t), severity: 'blocking', reasons: ['单测覆盖率或质量场景未通过'] });
    }
    if (t.ci && t.ci.conclusion !== 'pass') {
      add(human, { ...base(t), severity: 'blocking', reasons: [`当前 PR CI 未通过（${t.ci.conclusion}）`] });
    }
    if (t.ownerType === 'human' && t.col !== 'done' && t.deps.every((d) => doneCodes.has(d))) {
      add(human, { ...base(t), severity: 'blocking', reasons: ['人工承接任务已可处理'] });
    }
  }
  for (const code of s.coverage?.uncoveredDesignItems ?? []) {
    add(human, {
      key: `gap:${code}`, kind: 'gap', taskId: '', sourceId: code, title: `设计项 ${code} 尚无承接任务`,
      severity: 'blocking', assigneeType: 'human', reasons: [`${code} 尚无承接任务`],
    });
  }
  if (s.baseline && !s.baseline.valid) {
    add(human, {
      key: 'input:baseline', kind: 'gap', taskId: '', sourceId: 'baseline', title: '开发输入基线已变化',
      severity: 'blocking', assigneeType: 'human', reasons: ['需要人工核对差异并确认新基线'],
    });
  }
  const blocker = s.autopilot?.run?.blocker;
  if (blocker) {
    add(human, {
      key: 'run:blocker', kind: 'gap', taskId: '', sourceId: 'autopilot', title: '自动执行已挂起',
      severity: 'blocking', assigneeType: 'human', reasons: [`${blocker.code}：${blocker.message}`],
    });
  }
  const values = (m: Map<string, AttentionRow>) =>
    [...m.values()].sort((a, b) => (a.severity === 'blocking' ? -1 : 0) - (b.severity === 'blocking' ? -1 : 0) || a.key.localeCompare(b.key));
  return { needsHuman: values(human), aiActionable: values(ai) };
}
