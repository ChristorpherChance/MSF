import { NavLink, Route, Routes } from 'react-router-dom';
import { DesignPage } from './pages/design/DesignPage';
import { DevPage } from './pages/dev/DevPage';
import { MaterialPage } from './pages/material/MaterialPage';
import { ReqPage } from './pages/req/ReqPage';

const STAGES = [
  { path: '/material', name: '资料', reqs: 'REQ-101~115' },
  { path: '/req', name: '需求', reqs: 'REQ-201~210' },
  { path: '/design', name: '设计', reqs: 'REQ-301~312' },
  { path: '/dev', name: '开发', reqs: 'REQ-401~420' },
  { path: '/test', name: '测试验收', reqs: 'REQ-501~511' },
] as const;

function StagePlaceholder({ name, reqs }: { name: string; reqs: string }) {
  return (
    <main style={{ padding: 24 }}>
      <h1>{name}阶段</h1>
      <p style={{ color: 'var(--msf-mut)' }}>
        M0 骨架占位页。本阶段承接 {reqs}，随逐域推进实现（见 doc/dev-plan/开发计划.md）。
      </p>
    </main>
  );
}

/** 五阶段工作台骨架（LLD-6 §3 各页随 M1~M5 实现） */
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
        {STAGES.filter((s) => !['/material', '/req', '/design', '/dev'].includes(s.path)).map((s) => (
          <Route key={s.path} path={s.path} element={<StagePlaceholder {...s} />} />
        ))}
        <Route path="*" element={<MaterialPage />} />
      </Routes>
    </div>
  );
}
