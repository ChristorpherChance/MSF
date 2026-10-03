/**
 * V2.0 一级列（左侧图标列）：logo + 五阶段（门禁 ⛔ 平移自原顶栏 StageNav）+ 工具 + 底部成本/通知/设置/用户。
 * mini 态 44px 纯图标（useLayoutPrefs.railMini，切换钮在 CrumbBar）。
 * 门禁口径不变（DSG-U02-2 修订）：pill 永远可点击，⛔ 仅提示前序阶段缺口，明细由页内 GateBanner 承接。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { NotificationBell } from '../assistant/NotificationBell';
import { platformApi, STAGE_NAMES, type UsageSummaryRow } from '../pages/platform/api';
import { useSession } from '../store';
import { Popover } from '../ui/Popover';
import { useStagesStore } from '../ui/GateBanner';
import { NAV, useLayoutPrefs } from './nav';

/** 💰 本月成本（自 App.tsx 顶栏平移；popover 明细：按项目×模型×用途分组，DSG-U02-2）
 *  U-002：挂载即拉取合计（未加载显示 … 而非误导性 $0）；打开 popover 时刷新明细
 *  W2-031：30s 轮询合计——生成期间费用持续增长，一级列与明细须同源追平 */
export function CostChip() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [rows, setRows] = useState<UsageSummaryRow[]>([]);
  const [total, setTotal] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await platformApi.usageSummary('current');
      setRows(r.items.slice(0, 8));
      setTotal(Number(r.totals.cost).toFixed(4));
    } catch { /* 静默，保持 … 态 */ }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30000);
    return () => clearInterval(t);
  }, [load]);

  const open = async () => {
    if (anchor) { setAnchor(null); return; }
    await load();
    setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
  };

  return (
    <>
      <button ref={btnRef} className="rail-btn" title={`本月成本（点击查看明细）${total === null ? '' : ` $${total}`}`} onClick={() => void open()}>
        <span className="ic">💰</span><span className="lbl">{total === null ? '成本' : `$${total}`}</span>
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="po-head">本月成本明细（当月，按项目×模型×用途）</div>
          {rows.length === 0 && <div className="po-note">本月暂无用量</div>}
          {rows.map((r, i) => (
            <div key={i} className="po-item" style={{ display: 'flex', gap: 8 }}>
              <span style={{ flex: 1 }}>{r.project_name ?? '全局'} · {r.model_name} · {r.purpose}</span>
              <span style={{ color: 'var(--ink2)' }}>{r.calls} 次</span>
              <span>${Number(r.cost).toFixed(4)}</span>
            </div>
          ))}
          {rows.length > 0 && (
            <>
              <div className="po-sep" />
              <div className="po-note">合计 ${total}（更多见设置页用量）</div>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

/** 当前用户标识（REQ-707 分期：本地默认身份；自顶栏平移） */
function UserBadge() {
  const [name, setName] = useState('');
  useEffect(() => {
    platformApi.me().then((u) => setName(u.name)).catch(() => undefined);
  }, []);
  if (!name) return null;
  return (
    <span className="rail-btn rail-user" title={`本地默认身份（账号体系 REQ-707 分期）：${name}`}>
      <span className="ic">👤</span><span className="lbl">{name}</span>
    </span>
  );
}

const TOOLS = [
  { path: '/tasks', icon: '⚡', name: 'Task', title: '任务中心' },
  { path: '/delegate', icon: '🤝', name: '委派', title: '委派' },
];

export function Rail() {
  const projectId = useSession((s) => s.projectId);
  const railMini = useLayoutPrefs((s) => s.railMini);
  const { stages, load } = useStagesStore();

  useEffect(() => { void load(projectId); }, [projectId, load]);

  return (
    <aside className={`rail${railMini ? ' mini' : ''}`}>
      <Link to="/projects" className="rail-logo" title="MSF 软件工厂（项目列表）">🏭</Link>
      <div className="rail-items">
        {NAV.map((s, i) => {
          const blocked = stages.length > 0 && !stages.slice(0, i).every((g) => g.ok);
          const gap = blocked
            ? stages.slice(0, i).filter((g) => !g.ok)
                .map((g) => `${STAGE_NAMES[g.stage] ?? g.stage}：${g.issues.map((x) => x.message).join('；')}`)
                .join(' / ')
            : '';
          return (
            <NavLink
              key={s.key}
              to={s.path}
              className={({ isActive }) => `rail-btn${isActive ? ' active' : ''}`}
              title={blocked ? `${s.name} — 准入未满足（可进入查看）— ${gap}` : s.name}
            >
              <span className="ic">{s.icon}</span>
              <span className="lbl">{s.name}</span>
              {blocked && <span className="rail-gap">⛔</span>}
            </NavLink>
          );
        })}
        <div className="rail-sep" />
        {TOOLS.map((t) => (
          <NavLink key={t.path} to={t.path} className={({ isActive }) => `rail-btn${isActive ? ' active' : ''}`} title={t.title}>
            <span className="ic">{t.icon}</span>
            <span className="lbl">{t.name}</span>
          </NavLink>
        ))}
      </div>
      <div className="rail-foot">
        <CostChip />
        <NotificationBell />
        <NavLink to="/settings" className={({ isActive }) => `rail-btn${isActive ? ' active' : ''}`} title="设置">
          <span className="ic">⚙️</span>
          <span className="lbl">设置</span>
        </NavLink>
        <UserBadge />
      </div>
    </aside>
  );
}
