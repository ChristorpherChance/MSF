import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { tstApi, type PendingHandoff } from './api';
import { useTstStore } from './store';

/** 环境对象 → 可读文本 */
function envText(env: Record<string, unknown>): string {
  const parts = [env.os, env.browser].filter((x) => typeof x === 'string' && x);
  return parts.length > 0 ? parts.join(' / ') : JSON.stringify(env);
}

/** 页签一：提测与计划（接收新交接 + 批次事实表 .qa-facts + 计划起草/批准 + 阻断/恢复） */
export function BatchPlanPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  const navigate = useNavigate();
  const [recvOpen, setRecvOpen] = useState(false);
  const [recvTarget, setRecvTarget] = useState<PendingHandoff | null>(null);
  const [approveOpen, setApproveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const det = s.batchDetail;

  const receive = (h: PendingHandoff) =>
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
      {/* 接收新交接（空态：等待开发交付一份可测试的候选——原型 intake() 口径） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>接收新交接</strong>
          <span className="dsg-prefix">待接收 {s.pendingHandoffs.length} 份</span>
        </div>
        {s.pendingHandoffs.length === 0 && !det && (
          <div className="qa-empty">
            <h2>等待开发交付一份可测试的候选</h2>
            <p className="dsg-prefix">尚未收到提测批次。开发完成自测后，由你确认转测试；这里再明确接收，避免测错版本。</p>
            <div className="gen-ops" style={{ justifyContent: 'center' }}>
              <button className="act primary" disabled>接收本批提测</button>
              <button className="act" onClick={() => navigate('/dev')}>查看开发自测与交接</button>
            </div>
            <p className="dsg-prefix">接收不代表测试通过，也不会自动批准测试计划。</p>
          </div>
        )}
        {s.pendingHandoffs.length === 0 && det && (
          <p className="dsg-prefix qa-empty">暂无待接收交接（开发页 · 开发自测 · 转测试交接）</p>
        )}
        {s.pendingHandoffs.length > 0 && (
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
              onClick={() => setRecvTarget(h)}
            >
              接收为批次
            </button>
          </div>
        ))}
      </div>
      {recvTarget && (
        <ConfirmModal
          title="接收交接为测试批次"
          confirmLabel="接收为批次"
          body={`构建指纹：${recvTarget.buildFingerprint}\n基线指纹：${s.baselineFp ?? '—'}\n不可变快照，接收幂等。`}
          onClose={() => setRecvTarget(null)}
          onConfirm={() => void receive(recvTarget)}
        />
      )}

      {/* 批次事实表 .qa-facts（不可变快照；原型 intake() 已接收形态：eyebrow + h2 + 下一步横幅） */}
      {det && (
        <div className="dsg-card">
          <span className="qa-eyebrow">交付物已固定</span>
          <h2 style={{ margin: '2px 0 8px' }}>{det.batchId} · {det.snapshot.build.build_id}</h2>
          <div className="gen-head">
            <strong>批次事实表</strong>
            <span className="dsg-prefix">{det.immutable ? '不可变快照' : ''} · 接收人 {det.receivedBy} · {new Date(det.receivedAt).toLocaleString()}</span>
            <button className="act" onClick={async () => {
              const e = await tstApi.exportSnapshot(pid, det.batchId);
              window.open(e.downloadUrl, '_blank');
            }}>导出交接快照</button>
          </div>
          {/* T3 .qa-facts 六格：候选构建/开发自测/设计基线/环境/接收人/接收时间 */}
          <dl className="qa-facts">
            <div><dt>候选构建</dt><dd><code>{det.snapshot.build.build_id}</code></dd></div>
            <div><dt>开发自测</dt><dd><code>{det.snapshot.devReport.report_id}</code> · {det.snapshot.devReport.status === 'pass' ? '通过' : det.snapshot.devReport.status}</dd></div>
            <div><dt>设计基线</dt><dd><code>{det.snapshot.designBaseline.baseline_id}</code></dd></div>
            <div><dt>环境</dt><dd>{envText(det.snapshot.environment)}</dd></div>
            <div><dt>接收人</dt><dd>{det.receivedBy}</dd></div>
            <div><dt>接收时间</dt><dd>{new Date(det.receivedAt).toLocaleString()}</dd></div>
          </dl>
          <p className="dsg-prefix">下一步：基于本批需求和设计确认测试范围。开发自测证据仅作参考，不计为独立测试通过。</p>
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

      {/* 计划起草/批准（A07-3；策略点 test.plan.approve 人工确认；原型 planHtml 口径） */}
      {det && !s.plan && (
        <div className="dsg-card">
          <h2 style={{ margin: '2px 0 8px' }}>准备独立测试范围</h2>
          <p className="dsg-prefix">从业务流程起草用例，并保留人工交互走查；不会复制开发通过结果。</p>
          <div className="gen-ops">
            {['received', 'planned'].includes(det.status) && (
              <button className="act primary" onClick={() => s.act(() => tstApi.draftPlan(pid, det.batchId), '计划已起草')}>起草测试计划</button>
            )}
          </div>
        </div>
      )}
      {det && s.plan && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>测试计划</strong>
            <span className="dsg-prefix">
              {s.plan.planId} · v{s.plan.versionNo} · {s.plan.state === 'approved' ? `已批准（${s.plan.approvedBy ?? ''}）` : '待人工确认'}
              {s.plan.hasManualWalkthrough ? ' · 含人工走查' : ''}
            </span>
            {s.plan.state === 'draft' && (
              <button className="act primary" onClick={() => setApproveOpen(true)}>
                确认测试范围
              </button>
            )}
            {['received', 'planned'].includes(det.status) && (
              <button className="act" onClick={() => s.act(() => tstApi.draftPlan(pid, det.batchId), '计划已起草（追加新版本）')}>重新起草</button>
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
          <p className="dsg-prefix">必测项全部执行、关键项通过、无未解决缺陷，才可申请正常放行。</p>
        </div>
      )}
      {approveOpen && s.plan && det && (
        <ConfirmModal
          title={`确认测试范围 ${s.plan.planId}`}
          confirmLabel="确认测试范围"
          body={'策略确认点 test.plan.approve，人工确认；批准后追加新版本并用例冻结。'}
          onClose={() => setApproveOpen(false)}
          onConfirm={() => s.act(() => tstApi.approvePlan(pid, det.batchId, s.plan!.planId), '计划已批准')}
        />
      )}
    </div>
  );
}
