import { useEffect } from 'react';
import { BatchPlanPanel } from './BatchPlanPanel';
import { RunPanel } from './RunPanel';
import { DefectPanel } from './DefectPanel';
import { ReportPanel } from './ReportPanel';
import { useTstStore, type TstSubTab } from './store';
import '../req/req.css';
import '../design/design.css';
import '../dev/dev.css';
import './test.css';

const TABS: Array<{ key: TstSubTab; name: string }> = [
  { key: 'plan', name: '提测与计划' },
  { key: 'run', name: '用例与执行' },
  { key: 'defect', name: '缺陷与回归' },
  { key: 'report', name: '报告与交付' },
];

const STATUS_NAME: Record<string, string> = {
  received: '已接收', planned: '已计划', approved: '已批准', executing: '执行中',
  reported: '已报告', released: '已放行', blocked: '已阻断',
};

/** 测试验收页（LLD-6 §3.6 四页签 + 批次条 .qa-batchbar；REQ-501~511） */
export function TestPage() {
  const s = useTstStore();
  useEffect(() => {
    void s.init();
  }, []);
  if (!s.projectId) return <main style={{ padding: 24 }}>加载中…</main>;

  const openDefects = s.defects.filter((d) => d.status !== 'closed').length;
  const env = s.batchDetail?.snapshot.environment as { os?: string; browser?: string } | undefined;
  return (
    <main className="proto-wrap">
      <div className="doc-toolbar">
        <strong>测试验收</strong>
        {TABS.map((t) => (
          <button
            key={t.key}
            className={s.subTab === t.key ? 'act' : ''}
            onClick={() => void s.setSubTab(t.key)}
          >
            {t.name}
            {t.key === 'defect' && openDefects > 0 && <span className="dev-badge-block">{openDefects}</span>}
          </button>
        ))}
        <span className="dsg-prefix">
          {env ? `环境 ${env.os ?? '—'}/${env.browser ?? '—'}` : ''}
          {s.loading ? ' · 刷新中…' : ''}
        </span>
      </div>

      {/* 批次条 .qa-batchbar：当前批次下拉 + 环境 + 接收新交接 */}
      <div className="qa-batchbar">
        <label>当前批次</label>
        <select value={s.selBatchId ?? ''} onChange={(e) => void s.selectBatch(e.target.value || null)}>
          {s.batches.length === 0 && <option value="">（无批次）</option>}
          {s.batches.map((b) => (
            <option key={b.batchId} value={b.batchId}>
              {b.batchId} · {STATUS_NAME[b.status] ?? b.status}{b.current ? '（最新）' : ''}
            </option>
          ))}
        </select>
        {s.batchDetail && (
          <span className={`qa-status qa-status-${s.batchDetail.status}`}>
            {STATUS_NAME[s.batchDetail.status] ?? s.batchDetail.status}
          </span>
        )}
        {s.batchDetail?.blockedReason && <span className="dev-bad">阻断：{s.batchDetail.blockedReason}</span>}
        <span className="dsg-prefix">历史批次只读；新构建=新批次</span>
      </div>

      {s.error && <div className="gate-box"><div className="issue-row">{s.error}</div></div>}
      {s.notice && <div className="dsg-card dev-ok" onClick={s.clearNotice}>{s.notice}</div>}

      {s.subTab === 'plan' && <BatchPlanPanel />}
      {s.subTab === 'run' && <RunPanel />}
      {s.subTab === 'defect' && <DefectPanel />}
      {s.subTab === 'report' && <ReportPanel />}
    </main>
  );
}
