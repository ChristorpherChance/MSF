/**
 * V2.0 二级列（阶段页签列）：替代各页内嵌页签条（原 .subtabs/.doc-toolbar/.mat-subtabs 三种方言统一收编）。
 * 五个阶段 store 全部无条件订阅（hooks 规则），按当前路由选当前阶段；点击=setSubTab+必要时 navigate。
 * 徽章平移：design review=openReviews；dev plan=attentionModel.needsHuman、change=待评估影响数；test defect=未关闭缺陷数。
 * material 页签切换走 requestGuard（未保存草稿三选弹窗不丢）。
 */
import { useLocation, useNavigate } from 'react-router-dom';
import { useDesignView } from '../pages/design/store';
import { attentionModel, useDevStore } from '../pages/dev/store';
import { useMaterialView } from '../pages/material/store';
import { useReqView } from '../pages/req/store';
import { useTstStore } from '../pages/test/store';
import { useSession } from '../store';
import { stageOfPath, useLayoutPrefs, type NavStage } from './nav';

/** 当前阶段 + 当前页签（SubNav 与 CrumbBar 共用） */
export function useCurrentSub(): { stage: NavStage | undefined; subKey: string } {
  const { pathname } = useLocation();
  const stage = stageOfPath(pathname);
  const materialSub = useMaterialView((s) => s.subTab);
  const reqSub = useReqView((s) => s.subTab);
  const designSub = useDesignView((s) => s.subTab);
  const devTop = useDevStore((s) => s.topTab);
  const tstSub = useTstStore((s) => s.subTab);
  const subKey = stage?.key === 'material' ? materialSub
    : stage?.key === 'req' ? reqSub
    : stage?.key === 'design' ? designSub
    : stage?.key === 'dev' ? devTop
    : stage?.key === 'test' ? tstSub
    : '';
  return { stage, subKey };
}

/** 各阶段页签徽章计数（0=不显示） */
function useBadges(stageKey: string | undefined): Record<string, number> {
  const openReviews = useDesignView((s) => s.openReviews);
  const impacts = useDevStore((s) => s.impacts);
  const tasks = useDevStore((s) => s.tasks);
  const coverage = useDevStore((s) => s.coverage);
  const baseline = useDevStore((s) => s.baseline);
  const autopilot = useDevStore((s) => s.autopilot);
  const defects = useTstStore((s) => s.defects);
  void stageKey;
  return {
    'design:review': openReviews,
    'dev:plan': attentionModel({ tasks, coverage, baseline, impacts, autopilot }).needsHuman.length,
    'dev:change': impacts.filter((i) => i.status === 'pending-assessment').length,
    'test:defect': defects.filter((d) => d.status !== 'closed').length,
  };
}

export function SubNav() {
  const { stage, subKey } = useCurrentSub();
  const badges = useBadges(stage?.key);
  const subClosed = useLayoutPrefs((s) => s.subClosed);
  const setSubClosed = useLayoutPrefs((s) => s.setSubClosed);
  const projectName = useSession((s) => s.projectName);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (!stage) return null; // 非阶段页恒隐藏

  const pick = (key: string) => {
    if (stage.key === 'material') {
      // 未保存草稿拦截（GuardModal 三选），不裸切；口径同原页内 SubTabs（setSubTab+refresh）
      useMaterialView.getState().requestGuard(() => {
        useMaterialView.getState().setSubTab(key as 'file' | 'content');
        void useMaterialView.getState().refresh();
      });
    } else if (stage.key === 'req') {
      void useReqView.getState().setSubTab(key as 'crd' | 'prd' | 'rtm');
    } else if (stage.key === 'design') {
      void useDesignView.getState().setSubTab(key as 'hld' | 'detail' | 'prototype' | 'review');
    } else if (stage.key === 'dev') {
      void useDevStore.getState().setTopTab(key as 'plan' | 'execute' | 'quality' | 'change');
    } else if (stage.key === 'test') {
      void useTstStore.getState().setSubTab(key as 'plan' | 'run' | 'defect' | 'report');
    }
    if (!stageOfPath(pathname) || pathname !== stage.path) void navigate(stage.path);
  };

  return (
    <aside className={`subnav${subClosed ? ' closed' : ''}`}>
      <div className="subnav-head">
        <span>{stage.icon} {stage.name}</span>
        <button type="button" className="subnav-x" title="收拢页签栏" onClick={() => setSubClosed(true)}>«</button>
      </div>
      {projectName && (
        <button type="button" className="subnav-proj" title="当前项目（点击切换）" onClick={() => void navigate('/projects')}>
          {projectName}
        </button>
      )}
      <div className="subnav-items" role="tablist">
        {stage.subs.map((sub) => {
          const n = badges[`${stage.key}:${sub.key}`] ?? 0;
          return (
            <button
              key={sub.key}
              type="button"
              role="tab"
              aria-selected={subKey === sub.key}
              {...(sub.testid ? { 'data-testid': sub.testid } : {})}
              className={`subnav-btn${subKey === sub.key ? ' active' : ''}`}
              onClick={() => pick(sub.key)}
            >
              {sub.label}
              {n > 0 && <span className="tag tag-warn subnav-badge">{n}</span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
