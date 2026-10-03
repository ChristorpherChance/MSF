/**
 * V2.0 面包屑细条（36px，替代原 52px 顶栏）：rail mini 切换 + 二级列收拢 + 当前位置。
 * 非阶段页只显示页面名；二级列收拢后 ‹ 钮是其唤回入口。
 */
import { useLocation } from 'react-router-dom';
import { useLayoutPrefs } from './nav';
import { useCurrentSub } from './SubNav';

const PAGE_NAMES: Record<string, string> = {
  '/projects': '项目',
  '/tasks': '任务中心',
  '/delegate': '委派',
  '/settings': '设置',
};

export function CrumbBar() {
  const { pathname } = useLocation();
  const { stage, subKey } = useCurrentSub();
  const railMini = useLayoutPrefs((s) => s.railMini);
  const toggleRail = useLayoutPrefs((s) => s.toggleRail);
  const subClosed = useLayoutPrefs((s) => s.subClosed);
  const toggleSub = useLayoutPrefs((s) => s.toggleSub);

  const sub = stage?.subs.find((x) => x.key === subKey);
  const pageName = PAGE_NAMES[pathname] ?? stage?.name ?? '';

  return (
    <div className="crumbbar">
      <button
        type="button"
        className="crumb-tgl"
        title={railMini ? '展开一级菜单（图标+名称）' : '一级菜单收为纯图标'}
        onClick={toggleRail}
      >
        {railMini ? '⇥' : '⇤'}
      </button>
      {stage && (
        <button
          type="button"
          className="crumb-tgl"
          title={subClosed ? '展开页签栏' : '收拢页签栏'}
          onClick={toggleSub}
        >
          {subClosed ? '›' : '‹'}
        </button>
      )}
      <span className="crumb">
        {stage ? (
          <><b>{stage.name}</b>{sub && <> / {sub.label.replace(/^\S+\s/, '')}</>}</>
        ) : (
          <b>{pageName}</b>
        )}
      </span>
    </div>
  );
}
