import { useEffect } from 'react';
import { BatchPlanPanel } from './BatchPlanPanel';
import { RunPanel } from './RunPanel';
import { DefectPanel } from './DefectPanel';
import { ReportPanel } from './ReportPanel';
import { useTstStore, type TstSubTab } from './store';
import '../req/req.css';
import '../design/design.css';
import '../dev/dev.css';
import { GateBanner } from '../../ui/GateBanner';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
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

  // 瞬时异常/回执收为图标点（与需求/设计页同口径：固定区只留操作，点开看详情）
  const flashItems: StatusChipItem[] = [];
  if (s.error) {
    flashItems.push({ key: 'error', tone: 'err', label: '⛔', detail: s.error });
  }
  if (s.notice) {
    flashItems.push({
      key: 'notice', tone: 'ok', label: '✓',
      detail: (
        <>
          {s.notice}
          <br />
          <button className="act" onClick={s.clearNotice}>知道了</button>
        </>
      ),
    });
  }

  return (
    <main className="proto-wrap qa-workbench">
      <GateBanner stage="test" />
      {/* T1 工作台头部：阶段眉标 + 主标题 + 环境 tag 独立区 */}
      <header className="qa-header">
        <div>
          <span className="qa-eyebrow">S4 / 独立测试验收</span>
          <h1>把交付结论建立在证据上</h1>
          <p>固定候选 → 确认范围 → 独立验证 → 人工交付</p>
        </div>
        <span className="qa-env-tag">
          {env ? `环境 ${env.os ?? '—'} / ${env.browser ?? '—'}` : '环境 —（接收批次后固定）'}
        </span>
      </header>
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
        <StatusChips items={flashItems} />
        <span className="dsg-prefix">{s.loading ? '刷新中…' : ''}</span>
      </div>

      {/* 批次条 .qa-batchbar：当前批次下拉（TB-xxx · buildId）+ 环境 + 接收新交接 */}
      <div className="qa-batchbar">
        <label>当前批次</label>
        <select value={s.selBatchId ?? ''} onChange={(e) => void s.selectBatch(e.target.value || null)}>
          {s.batches.length === 0 && <option value="">尚未接收</option>}
          {s.batches.map((b) => (
            <option key={b.batchId} value={b.batchId}>
              {b.batchId} · {b.buildId ?? '—'}{b.current ? '（最新）' : ''}
            </option>
          ))}
        </select>
        {s.batchDetail && (
          <span className={`qa-status qa-status-${s.batchDetail.status}`}>
            {STATUS_NAME[s.batchDetail.status] ?? s.batchDetail.status}
          </span>
        )}
        <span className="dsg-prefix">
          {env ? `环境 ${env.os ?? '—'} / ${env.browser ?? '—'}` : '等待开发人工确认转测试'}
        </span>
        {s.batchDetail?.blockedReason && <span className="dev-bad">阻断：{s.batchDetail.blockedReason}</span>}
        {s.pendingHandoffs.length > 0 && (
          <button className="act" onClick={() => void s.setSubTab('plan')}>接收新交接</button>
        )}
        <span className="dsg-prefix">历史批次只读；新构建=新批次</span>
      </div>

      {/* 面板区独立滚动：头部/页签/批次条固定不动（对齐 material 页固定骨架口径） */}
      <div className="qa-panels">
        {s.subTab === 'plan' && <BatchPlanPanel />}
        {s.subTab === 'run' && <RunPanel />}
        {s.subTab === 'defect' && <DefectPanel />}
        {s.subTab === 'report' && <ReportPanel />}
      </div>

      {/* T1 页脚说明 */}
      <footer className="qa-footer">报告定稿 ≠ 放行 ≠ 生产发布 · 历史批次只读，新构建=新批次</footer>
    </main>
  );
}
