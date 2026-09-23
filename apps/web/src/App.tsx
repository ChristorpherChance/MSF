import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
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
import { platformApi, STAGE_NAMES, type StageGate } from './pages/platform/api';
import { useSession } from './store';
import './app.css';

const STAGES = [
  { path: '/material', key: 'material', name: '资料' },
  { path: '/req', key: 'req', name: '需求' },
  { path: '/design', key: 'design', name: '设计' },
  { path: '/dev', key: 'dev', name: '开发' },
  { path: '/test', key: 'test', name: '测试验收' },
] as const;

/** 阶段导航（A02-4：准入实时求值；未满足阶段禁用并提示缺口） */
function StageNav() {
  const projectId = useSession((s) => s.projectId);
  const [stages, setStages] = useState<StageGate[]>([]);

  useEffect(() => {
    if (!projectId) { setStages([]); return; }
    let alive = true;
    platformApi.stages(projectId)
      .then((r) => { if (alive) setStages(r.stages); })
      .catch(() => { if (alive) setStages([]); });
    return () => { alive = false; };
  }, [projectId]);

  return (
    <>
      {STAGES.map((s, i) => {
        const blocked = stages.length > 0 && !stages.slice(0, i).every((g) => g.ok);
        const gap = blocked
          ? stages.slice(0, i).filter((g) => !g.ok)
              .map((g) => `${STAGE_NAMES[g.stage] ?? g.stage}：${g.issues.map((x) => x.message).join('；')}`)
              .join(' / ')
          : '';
        if (blocked) {
          return (
            <span key={s.path} title={`准入未满足 — ${gap}`} style={{ color: '#aaa', cursor: 'not-allowed' }}>
              {s.name} 🔒
            </span>
          );
        }
        return <NavLink key={s.path} to={s.path}>{s.name}</NavLink>;
      })}
    </>
  );
}

/** 工作台骨架（DSG-U02-1：100vh 纵向 flex = 顶栏 52px + 主区横向 flex[.view + 助手 dock]；
 *  LLD-6 §3 各页；F1 开合 dock；顶栏铃铛 + 阶段准入导航） */
export function App() {
  const projectName = useSession((s) => s.projectName);
  return (
    <div className="app-shell">
      <nav
        className="app-topbar"
        style={{
          display: 'flex',
          gap: 16,
          padding: '0 20px',
          height: 52,
          flexShrink: 0,
          background: 'var(--canvas)',
          borderBottom: '1px solid var(--line)',
          alignItems: 'center',
        }}
      >
        <strong>MSF 软件工厂</strong>
        <NavLink to="/projects">项目</NavLink>
        <StageNav />
        <NavLink to="/delegate">委派</NavLink>
        <NavLink to="/audit">审计</NavLink>
        <NavLink to="/settings">设置</NavLink>
        {projectName && (
          <span style={{ fontSize: 12, color: 'var(--ink2)' }}>当前项目：{projectName}</span>
        )}
        <NotificationBell />
      </nav>
      <div className="app-main">
        <div className="app-view">
          <Routes>
            <Route path="/projects" element={<ProjectsPage />} />
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
    </div>
  );
}
