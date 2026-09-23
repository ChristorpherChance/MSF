import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { AssistantDock } from './assistant/AssistantDock';
import { NotificationBell } from './assistant/NotificationBell';
import { DesignPage } from './pages/design/DesignPage';
import { DelegatePage } from './pages/delegate/DelegatePage';
import { DevPage } from './pages/dev/DevPage';
import { TestPage } from './pages/test/TestPage';
import { MaterialPage } from './pages/material/MaterialPage';
import { ReqPage } from './pages/req/ReqPage';
import { ProjectsPage } from './pages/platform/ProjectsPage';
import { SettingsPage } from './pages/platform/SettingsPage';
import { AuditPage } from './pages/platform/AuditPage';
import { TasksPage } from './pages/platform/TasksPage';
import { platformApi, STAGE_NAMES, type UsageSummaryRow } from './pages/platform/api';
import { useSession } from './store';
import { Popover } from './ui/Popover';
import { Toaster } from './ui/toast';
import { STAGE_ORDER, useStagesStore } from './ui/GateBanner';
import './app.css';

const STAGES = STAGE_ORDER.map((key) => ({
  path: `/${key}`,
  key,
  name: STAGE_NAMES[key] ?? key,
}));

/**
 * 阶段导航 pill（DSG-U02-2 修订口径：pill 永远可点击，门禁缺口由页内横幅承接）。
 * 未达标阶段 pill 带 ⛔ 提示点，点击照常进入。
 */
function StageNav() {
  const projectId = useSession((s) => s.projectId);
  const { stages, load } = useStagesStore();

  useEffect(() => { void load(projectId); }, [projectId, load]);

  return (
    <span className="stage-nav">
      {STAGES.map((s, i) => {
        const blocked = stages.length > 0 && !stages.slice(0, i).every((g) => g.ok);
        const gap = blocked
          ? stages.slice(0, i).filter((g) => !g.ok)
              .map((g) => `${STAGE_NAMES[g.stage] ?? g.stage}：${g.issues.map((x) => x.message).join('；')}`)
              .join(' / ')
          : '';
        return (
          <NavLink
            key={s.path}
            to={s.path}
            className={({ isActive }) => `stage-pill${isActive ? ' active' : ''}${blocked ? ' gated' : ''}`}
            title={blocked ? `准入未满足（可进入查看）— ${gap}` : undefined}
          >
            {s.name}{blocked && <span className="pill-gap">⛔</span>}
          </NavLink>
        );
      })}
    </span>
  );
}

/** 💰 本月成本（popover 明细：按项目×模型×用途分组，DSG-U02-2） */
function CostChip() {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [rows, setRows] = useState<UsageSummaryRow[]>([]);
  const [total, setTotal] = useState('0');
  const btnRef = useRef<HTMLButtonElement>(null);

  const open = async () => {
    if (anchor) { setAnchor(null); return; }
    try {
      const r = await platformApi.usageSummary('current');
      setRows(r.items.slice(0, 8));
      setTotal(Number(r.totals.cost).toFixed(4));
    } catch { /* 静默 */ }
    setAnchor(btnRef.current?.getBoundingClientRect() ?? null);
  };

  return (
    <>
      <button ref={btnRef} className="topbar-chip" title="本月成本（点击查看明细）" onClick={() => void open()}>
        💰 ${total}
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

/** 当前用户标识（REQ-707 分期：本地默认身份） */
function UserBadge() {
  const [name, setName] = useState('');
  useEffect(() => {
    platformApi.me().then((u) => setName(u.name)).catch(() => undefined);
  }, []);
  if (!name) return null;
  return <span className="topbar-user" title="本地默认身份（账号体系 REQ-707 分期）">👤 {name}</span>;
}

/** 视口宽度提示（DSG-U05-4：<1280 提示建议桌面宽度，可关闭） */
function ViewportHint() {
  const [show, setShow] = useState(
    () => window.innerWidth < 1280 && !localStorage.getItem('msf.viewportHintOff'),
  );
  useEffect(() => {
    const onResize = () => {
      setShow(window.innerWidth < 1280 && !localStorage.getItem('msf.viewportHintOff'));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (!show) return null;
  return (
    <div className="viewport-hint">
      当前视口较窄，建议 ≥1280px 桌面宽度以获得完整工作台布局。
      <button onClick={() => { localStorage.setItem('msf.viewportHintOff', '1'); setShow(false); }}>知道了</button>
    </div>
  );
}

/** 工作台骨架（DSG-U02-1/2：顶栏 52px + 主区横向 flex[.view + 助手 dock]；F1 开合 dock） */
export function App() {
  const projectName = useSession((s) => s.projectName);
  return (
    <div className="app-shell">
      <nav className="app-topbar">
        <Link to="/projects" className="topbar-logo">🏭 软件工厂</Link>
        {projectName && (
          <Link to="/projects" className="badge-chip" title="当前项目（点击切换）">{projectName}</Link>
        )}
        <StageNav />
        <span style={{ flex: 1 }} />
        <NavLink to="/tasks" className="topbar-link" title="任务中心">⚡ Task</NavLink>
        <NavLink to="/delegate" className="topbar-link">🤝 委派</NavLink>
        <CostChip />
        <NavLink to="/req?tab=rtm" className="topbar-link" title="RTM 健康度">🔗 RTM</NavLink>
        <NotificationBell />
        <NavLink to="/settings" className="topbar-link" title="设置">⚙️</NavLink>
        <UserBadge />
      </nav>
      <ViewportHint />
      <div className="app-main">
        <div className="app-view">
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/material" element={<MaterialPage />} />
            <Route path="/req" element={<ReqPage />} />
            <Route path="/design" element={<DesignPage />} />
            <Route path="/dev" element={<DevPage />} />
            <Route path="/test" element={<TestPage />} />
            <Route path="/delegate" element={<DelegatePage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<ProjectsPage />} />
          </Routes>
        </div>
        <AssistantDock />
      </div>
      <Toaster />
    </div>
  );
}
