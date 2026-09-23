import { useEffect } from 'react';
import { BoardPanel } from './BoardPanel';
import { ChangePanel } from './ChangePanel';
import { PlanPanel } from './PlanPanel';
import { QualityPanel } from './QualityPanel';
import { useDevStore, type DevSubTab } from './store';
import '../req/req.css';
import '../design/design.css';
import { GateBanner } from '../../ui/GateBanner';
import './dev.css';

const TABS: Array<{ key: DevSubTab; name: string }> = [
  { key: 'plan', name: '任务与计划' },
  { key: 'board', name: '开发执行' },
  { key: 'quality', name: '质量验收' },
  { key: 'change', name: '变更管理' },
];

/** 开发页（LLD-6 §3.5 四页签；REQ-401~420） */
export function DevPage() {
  const s = useDevStore();
  useEffect(() => {
    void s.init();
  }, []);
  if (!s.projectId) return <main style={{ padding: 24 }}>加载中…</main>;

  const pendingImpacts = s.impacts.filter((i) => i.status === 'pending-assessment').length;
  return (
    <main className="proto-wrap">
      <GateBanner stage="dev" />
      <div className="doc-toolbar">
        <strong>开发</strong>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={s.subTab === t.key ? 'act' : ''}
            onClick={() => void s.setSubTab(t.key)}
          >
            {t.name}
            {t.key === 'change' && pendingImpacts > 0 && <span className="dev-badge-block">{pendingImpacts}</span>}
          </button>
        ))}
        <span className="dsg-prefix">
          任务 {s.tasks.length} · 完成 {s.tasks.filter((t) => t.col === 'done').length}
          {s.autopilot?.run ? ` · ${s.autopilot.run.runId} ${s.autopilot.run.status}` : ''}
          {s.loading ? ' · 刷新中…' : ''}
        </span>
      </div>
      {s.error && <div className="gate-box"><div className="issue-row">{s.error}</div></div>}
      {s.notice && <div className="dsg-card dev-ok" onClick={s.clearNotice}>{s.notice}</div>}
      {s.subTab === 'plan' && <PlanPanel />}
      {s.subTab === 'board' && <BoardPanel />}
      {s.subTab === 'quality' && <QualityPanel />}
      {s.subTab === 'change' && <ChangePanel />}
    </main>
  );
}
