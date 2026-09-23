import { useEffect } from 'react';
import { create } from 'zustand';
import { platformApi, STAGE_NAMES, type StageGate } from '../pages/platform/api';
import { useSession } from '../store';

/** 阶段准入共享态（A02-4 五门实时求值；顶栏 pill 与页内横幅同源） */

interface StagesState {
  projectId: string | null;
  stages: StageGate[];
  load: (projectId: string | null) => Promise<void>;
}

export const useStagesStore = create<StagesState>((set) => ({
  projectId: null,
  stages: [],
  load: async (projectId) => {
    if (!projectId) { set({ projectId, stages: [] }); return; }
    try {
      const r = await platformApi.stages(projectId);
      set({ projectId, stages: r.stages });
    } catch {
      set({ projectId, stages: [] });
    }
  },
}));

export const STAGE_ORDER = ['material', 'req', 'design', 'dev', 'test'] as const;

/**
 * 页内门禁横幅（DSG-U02-2 修订口径：阶段 pill 永远可点击，缺口由 .banner-gate + gap-chip 承接）。
 * 进入第 i 阶段页时展示前序 i 道门的未达标缺口。
 */
export function GateBanner({ stage }: { stage: (typeof STAGE_ORDER)[number] }) {
  const projectId = useSession((s) => s.projectId);
  const { stages, load } = useStagesStore();

  useEffect(() => {
    if (projectId && useStagesStore.getState().projectId !== projectId) void load(projectId);
  }, [projectId, load]);

  const idx = STAGE_ORDER.indexOf(stage);
  const gaps = stages.slice(0, idx).filter((g) => !g.ok);
  if (gaps.length === 0) return null;

  return (
    <div className="banner-gate">
      <span className="gate-title">⛔ 阶段准入缺口</span>
      {gaps.flatMap((g) =>
        g.issues.map((x, i) => (
          <span key={`${g.stage}-${i}`} className="gap-chip" title={x.target}>
            {STAGE_NAMES[g.stage] ?? g.stage}：{x.message}
          </span>
        )))}
      <span style={{ color: 'var(--ink2)', fontSize: 12 }}>补齐上游缺口后本阶段能力解锁，当前可查看。</span>
    </div>
  );
}
