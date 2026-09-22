import { useState } from 'react';
import { tstApi } from './api';
import { useTstStore } from './store';

/** 页签一：提测与计划（接收新交接 + 批次事实表 .qa-facts + 计划起草/批准 + 阻断/恢复） */
export function BatchPlanPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  const [recvOpen, setRecvOpen] = useState(false);
  const [reason, setReason] = useState('');
  const det = s.batchDetail;

  const receive = (h: { handoffId: string; buildFingerprint: string; selftestReportFingerprint: string }) =>
    s.act(async () => {
      const r = await tstApi.receive(pid, {
        ...h,
        designBaselineFingerprint: s.baselineFp ?? '',
        environment: { os: 'local', browser: 'chromium-mock' },
      });
      setRecvOpen(false);
      await s.selectBatch(r.batchId);
    }, '批次已接收（幂等按交接指纹归并）');

  return (
    <div>
      {/* 接收新交接（空态：等待开发交付一份可测试的候选） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>接收新交接</strong>
          <span className="dsg-prefix">待接收 {s.pendingHandoffs.length} 份</span>
        </div>
        {s.pendingHandoffs.length === 0 ? (
          <p className="dsg-prefix qa-empty">等待开发交付一份可测试的候选（开发页 · 质量验收 · 转测试交接）</p>
        ) : (
          <button className="act" onClick={() => setRecvOpen(!recvOpen)}>
            {recvOpen ? '收起' : '选择交接并接收'}
          </button>
        )}
        {recvOpen && s.pendingHandoffs.map((h) => (
          <div key={h.handoffId} className="qa-handoff-row">
            <span>
              {h.buildCode} · 自测 {h.reportCode}
              <span className={h.reportStatus === 'pass' ? 'dev-ok' : 'dev-bad'}>（{h.reportStatus}）</span>
              <span className="dsg-prefix"> · {new Date(h.createdAt).toLocaleString()}</span>
            </span>
            <button
              className="act"
              disabled={!s.baselineFp}
              onClick={() =>
                window.confirm(`接收交接为测试批次？\n构建指纹：${h.buildFingerprint}\n基线指纹：${s.baselineFp}\n（不可变快照，接收幂等）`) &&
                void receive(h)}
            >
              接收为批次
            </button>
          </div>
        ))}
      </div>

      {/* 批次事实表 .qa-facts（不可变快照） */}
      {det && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>批次事实表</strong>
            <span className="dsg-prefix">{det.immutable ? '不可变快照' : ''} · 接收人 {det.receivedBy} · {new Date(det.receivedAt).toLocaleString()}</span>
            <button className="act" onClick={async () => {
              const e = await tstApi.exportSnapshot(pid, det.batchId);
              window.open(e.downloadUrl, '_blank');
            }}>导出交接快照</button>
          </div>
          <div className="qa-facts">
            <div><span>候选构建</span><code>{det.snapshot.build.build_fingerprint.slice(0, 19)}…</code></div>
            <div><span>开发自测</span><code>{det.snapshot.devReport.report_fingerprint.slice(0, 19)}…（{det.snapshot.devReport.status}）</code></div>
            <div><span>设计基线</span><code>{det.snapshot.designBaseline.baseline_fingerprint.slice(0, 19)}…</code></div>
            <div><span>环境指纹</span><code>{det.snapshot.environmentFingerprint.slice(0, 26)}…</code></div>
          </div>
          {/* 阻断/恢复（A07-13/14） */}
          {!['received', 'released', 'blocked'].includes(det.status) && (
            <div className="form-row">
              <input placeholder="阻断理由（必填）" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="act" disabled={!reason.trim()}
                onClick={() => s.act(() => tstApi.block(pid, det.batchId, reason), '批次已阻断')}>
                阻断批次
              </button>
            </div>
          )}
          {det.status === 'blocked' && (
            <div className="form-row">
              <input placeholder="恢复理由（必填，快照身份实时复核）" value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className="act" disabled={!reason.trim()}
                onClick={() => s.act(() => tstApi.unblock(pid, det.batchId, reason), '批次已恢复')}>
                恢复批次
              </button>
            </div>
          )}
        </div>
      )}

      {/* 计划起草/批准（A07-3；策略点 test.plan.approve 人工确认） */}
      {det && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>测试计划</strong>
            {s.plan && (
              <span className="dsg-prefix">
                {s.plan.planId} · v{s.plan.versionNo} · {s.plan.state === 'approved' ? `已批准（${s.plan.approvedBy ?? ''}）` : '草稿'}
                {s.plan.hasManualWalkthrough ? ' · 含人工走查' : ''}
              </span>
            )}
          </div>
          <div className="gen-ops">
            {['received', 'planned'].includes(det.status) && (
              <button onClick={() => s.act(() => tstApi.draftPlan(pid, det.batchId), '计划已起草')}>起草计划</button>
            )}
            {s.plan?.state === 'draft' && (
              <button className="act"
                onClick={() =>
                  window.confirm(`批准计划 ${s.plan!.planId}？\n（策略确认点 test.plan.approve，人工确认；批准后追加新版本并用例冻结）`) &&
                  s.act(() => tstApi.approvePlan(pid, det.batchId, s.plan!.planId), '计划已批准')}>
                人工确认批准
              </button>
            )}
          </div>
          {s.cases.length > 0 && (
            <table className="dev-table">
              <thead><tr><th>用例</th><th>标题</th><th>方式</th><th>优先级</th><th>必测</th></tr></thead>
              <tbody>
                {s.cases.map((c) => (
                  <tr key={c.code}>
                    <td>{c.code}</td>
                    <td>{c.title}</td>
                    <td>{c.mode === 'auto' ? '自动' : '人工验证'}</td>
                    <td>{c.priority}</td>
                    <td>{c.mustRun ? '必测' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
