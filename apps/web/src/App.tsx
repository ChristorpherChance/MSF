import { NavLink, Route, Routes } from 'react-router-dom';
import { AssistantDock } from './assistant/AssistantDock';
import { DesignPage } from './pages/design/DesignPage';
import { DelegatePage } from './pages/delegate/DelegatePage';
import { DevPage } from './pages/dev/DevPage';
import { TestPage } from './pages/test/TestPage';
import { MaterialPage } from './pages/material/MaterialPage';
import { ReqPage } from './pages/req/ReqPage';

const STAGES = [
  { path: '/material', name: '资料', reqs: 'REQ-101~115' },
  { path: '/req', name: '需求', reqs: 'REQ-201~210' },
  { path: '/design', name: '设计', reqs: 'REQ-301~312' },
  { path: '/dev', name: '开发', reqs: 'REQ-401~420' },
  { path: '/test', name: '测试验收', reqs: 'REQ-501~511' },
  { path: '/delegate', name: '委派', reqs: 'REQ-610' },
] as const;

/** 五阶段工作台骨架（LLD-6 §3 各页随 M1~M6 实现；助手 dock 全局挂载，F1 开合） */
export function App() {
  return (
    <div>
      <nav
        style={{
          display: 'flex',
          gap: 16,
          padding: '10px 20px',
          background: 'var(--msf-card)',
          borderBottom: '1px solid var(--msf-line)',
        }}
      >
        <strong>MSF 软件工厂</strong>
        {STAGES.map((s) => (
          <NavLink key={s.path} to={s.path}>
            {s.name}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="/material" element={<MaterialPage />} />
        <Route path="/req" element={<ReqPage />} />
        <Route path="/design" element={<DesignPage />} />
        <Route path="/dev" element={<DevPage />} />
        <Route path="/test" element={<TestPage />} />
        <Route path="/delegate" element={<DelegatePage />} />
        <Route path="*" element={<MaterialPage />} />
      </Routes>
      <AssistantDock />
    </div>
  );
}
