import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AssistantDock } from './assistant/AssistantDock';
import { DesignPage } from './pages/design/DesignPage';
import { DelegatePage } from './pages/delegate/DelegatePage';
import { DevPage } from './pages/dev/DevPage';
import { TestPage } from './pages/test/TestPage';
import { MaterialPage } from './pages/material/MaterialPage';
import { ReqPage } from './pages/req/ReqPage';
import { ProjectsPage } from './pages/platform/ProjectsPage';
import { SettingsPage } from './pages/platform/SettingsPage';
import { TasksPage } from './pages/platform/TasksPage';
import { CrumbBar } from './layout/CrumbBar';
import { Rail } from './layout/Rail';
import { SubNav } from './layout/SubNav';
import { Toaster } from './ui/toast';
import { AuthGate } from './AuthGate';
import './app.css';

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

/**
 * 工作台骨架 V2.0（差异登记：DSG-U02-1/2 顶栏骨架改左栏三栏，待 13 册回补）：
 * .app-body 横向 flex = Rail（一级列，68⇄44px）+ SubNav（二级页签列，168px 可收拢，非阶段页隐藏）
 *   + .app-main（CrumbBar 36px + ViewportHint + .app-view 唯一滚动容器）+ AssistantDock（收拢=右下圆盘 FAB，F1 开合）
 * 原顶栏内容去向：logo/项目 chip→SubNav 头部；五阶段 pill+门禁 ⛔→Rail；Task/委派→Rail 工具组；
 * 成本/通知/设置/用户→Rail 底部；🔗 RTM→需求二级页签（原就是 /req?tab=rtm 直达）。
 */
export function App() {
  return (
    <AuthGate>
    <div className="app-shell">
      <div className="app-body">
        <Rail />
        <SubNav />
        <div className="app-main">
          <CrumbBar />
          <ViewportHint />
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
              {/* C8：审计并入设置页一组（DSG-U06-17 信息架构），旧路由重定向 */}
              <Route path="/audit" element={<Navigate to="/settings?nav=audit" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<ProjectsPage />} />
            </Routes>
          </div>
        </div>
        <AssistantDock />
      </div>
      <Toaster />
    </div>
    </AuthGate>
  );
}
