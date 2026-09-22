import { useState } from 'react';
import { tstApi } from './api';
import { useTstStore } from './store';

const ST_NAME: Record<string, string> = {
  new: '新登记', confirmed: '已确认', fixing: '修复中', pending_regression: '待回归', closed: '已关闭',
};

/** 页签三：缺陷与回归（失败登记行 + 缺陷卡五态流转；reopened 是事件不是状态） */
export function DefectPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  const [reg, setReg] = useState<{ caseId: string; title: string; evidence: string } | null>(null);
  const [confirm, setConfirm] = useState<{ defectId: string; severity: string; reason: string } | null>(null);
  const [fixed, setFixed] = useState<{ defectId: string; fp: string; note: string } | null>(null);
  const [link, setLink] = useState<{ defectId: string; batchId: string; runId: string; caseId: string } | null>(null);
  const [reopen, setReopen] = useState<{ defectId: string; reason: string } | null>(null);
  const det = s.batchDetail;
  if (!det) return <p className="dsg-prefix qa-empty">请先接收批次</p>;

  const failedCases = s.caseRuns.filter((c) => c.result === 'fail');
  return (
    <div>
      {/* 失败登记行（缺陷只能从本批实际失败记录创建） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>失败登记</strong>
          <span className="dsg-prefix">本批失败记录 {failedCases.length} 条（仅 fail 记录可登记缺陷，runId+caseId 幂等）</span>
        </div>
        {failedCases.length === 0 && <p className="dsg-prefix qa-empty">当前运行版本无失败记录</p>}
        {failedCases.map((c) => (
          <div key={c.code} className="qa-handoff-row">
            <span>{c.code} {c.title} <span className="dsg-prefix">（{s.latestRunId}）</span></span>
            <button className="act" onClick={() => setReg({ caseId: c.code, title: '', evidence: '' })}>登记缺陷</button>
          </div>
        ))}
        {reg && s.latestRunId && (
          <div className="qa-inline-form">
            <input placeholder="缺陷标题（必填）" value={reg.title} onChange={(e) => setReg({ ...reg, title: e.target.value })} />
            <input placeholder="失败证据（必填）" value={reg.evidence} onChange={(e) => setReg({ ...reg, evidence: e.target.value })} />
            <button className="act" disabled={!reg.title.trim() || !reg.evidence.trim()}
              onClick={() =>
                s.act(async () => {
                  await tstApi.createDefect(pid, { batchId: det.batchId, runId: s.latestRunId!, caseId: reg.caseId, title: reg.title, evidence: reg.evidence });
                  setReg(null);
                }, '缺陷已登记（new）')}>
              提交
            </button>
            <button onClick={() => setReg(null)}>取消</button>
          </div>
        )}
      </div>

      {/* 缺陷卡（五态流转按钮按状态机启停） */}
      <div className="dsg-card">
        <div className="gen-head"><strong>缺陷</strong><span className="dsg-prefix">{s.defects.length} 项 · 重开是事件不是状态</span></div>
        {s.defects.length === 0 && <p className="dsg-prefix qa-empty">暂无缺陷</p>}
        {s.defects.map((d) => (
          <div key={d.defectId} className="qa-defect">
            <div className="qa-case-head">
              <strong>{d.defectId}</strong>
              <span>{d.title}</span>
              {d.severity && <span className={`qa-tag qa-sev-${d.severity}`}>{d.severity}</span>}
              <span className={`qa-tag qa-st-${d.status}`}>{ST_NAME[d.status] ?? d.status}</span>
              {d.reopenedCount > 0 && <span className="dev-bad">重开×{d.reopenedCount}</span>}
            </div>
            {d.regression && (
              <div className="dsg-prefix">回归证据：批次 {d.regression.batchId} · {d.regression.runId} · {d.regression.caseId}</div>
            )}
            <div className="gen-ops">
              {d.status === 'new' && (
                <button className="act" onClick={() => setConfirm({ defectId: d.defectId, severity: 'P2', reason: '' })}>确认与定级</button>
              )}
              {d.status === 'confirmed' && (
                <button className="act" onClick={() => s.act(() => tstApi.fixStart(pid, d.defectId), '已转开发返工（fixing）')}>前往开发返工</button>
              )}
              {d.status === 'fixing' && (
                <button className="act" onClick={() => setFixed({ defectId: d.defectId, fp: '', note: '' })}>标记待回归（开发侧）</button>
              )}
              {d.status === 'pending_regression' && !d.regression && (
                <button className="act" onClick={() => setLink({ defectId: d.defectId, batchId: '', runId: '', caseId: '' })}>关联回归证据</button>
              )}
              {d.status === 'pending_regression' && d.regression && (
                <button className="act"
                  onClick={() =>
                    window.confirm(`测试侧人工确认关闭 ${d.defectId}？\n（服务端复核回归证据指纹，不一致拒绝；AI 不可代关闭）`) &&
                    s.act(() => tstApi.closeDefect(pid, d.defectId), '缺陷已关闭')}>
                  人工确认关闭
                </button>
              )}
              {['pending_regression', 'closed'].includes(d.status) && (
                <button onClick={() => setReopen({ defectId: d.defectId, reason: '' })}>重开（回归失败）</button>
              )}
            </div>
          </div>
        ))}

        {/* 确认定级表单 */}
        {confirm && (
          <div className="qa-inline-form">
            <select value={confirm.severity} onChange={(e) => setConfirm({ ...confirm, severity: e.target.value })}>
              <option value="P0">P0 阻断</option><option value="P1">P1 严重</option>
              <option value="P2">P2 一般</option><option value="P3">P3 轻微</option>
            </select>
            <input placeholder="确认依据与影响范围（必填）" value={confirm.reason} onChange={(e) => setConfirm({ ...confirm, reason: e.target.value })} />
            <button className="act" disabled={!confirm.reason.trim()}
              onClick={() =>
                s.act(async () => {
                  await tstApi.confirmDefect(pid, confirm.defectId, confirm.severity, confirm.reason);
                  setConfirm(null);
                }, '缺陷已确认')}>
              确认
            </button>
            <button onClick={() => setConfirm(null)}>取消</button>
          </div>
        )}
        {/* 标记待回归表单（新构建≠批次构建） */}
        {fixed && (
          <div className="qa-inline-form">
            <input placeholder="新构建指纹 sha256:…（必填，须≠批次构建）" value={fixed.fp} onChange={(e) => setFixed({ ...fixed, fp: e.target.value })} />
            <input placeholder="备注" value={fixed.note} onChange={(e) => setFixed({ ...fixed, note: e.target.value })} />
            <button className="act" disabled={!fixed.fp.trim()}
              onClick={() =>
                s.act(async () => {
                  await tstApi.markFixed(pid, fixed.defectId, fixed.fp, fixed.note || undefined);
                  setFixed(null);
                }, '已标记待回归')}>
              提交
            </button>
            <button onClick={() => setFixed(null)}>取消</button>
          </div>
        )}
        {/* 关联回归证据表单（四要素服务端核验） */}
        {link && (
          <div className="qa-inline-form">
            <input placeholder="回归批次（新批次≠源批次）" value={link.batchId} onChange={(e) => setLink({ ...link, batchId: e.target.value })} />
            <input placeholder="运行 ID" value={link.runId} onChange={(e) => setLink({ ...link, runId: e.target.value })} />
            <input placeholder="用例 ID（同版）" value={link.caseId} onChange={(e) => setLink({ ...link, caseId: e.target.value })} />
            <button className="act" disabled={!link.batchId.trim() || !link.runId.trim() || !link.caseId.trim()}
              onClick={() =>
                s.act(async () => {
                  await tstApi.linkRegression(pid, link.defectId, { batchId: link.batchId, runId: link.runId, caseId: link.caseId });
                  setLink(null);
                }, '回归证据已关联')}>
              关联
            </button>
            <button onClick={() => setLink(null)}>取消</button>
          </div>
        )}
        {/* 重开表单 */}
        {reopen && (
          <div className="qa-inline-form">
            <input placeholder="重开理由（回归失败证据，必填）" value={reopen.reason} onChange={(e) => setReopen({ ...reopen, reason: e.target.value })} />
            <button className="act" disabled={!reopen.reason.trim()}
              onClick={() =>
                s.act(async () => {
                  await tstApi.reopenDefect(pid, reopen.defectId, reopen.reason);
                  setReopen(null);
                }, '已重开（事件 reopened，缺陷回到 confirmed）')}>
              重开
            </button>
            <button onClick={() => setReopen(null)}>取消</button>
          </div>
        )}
      </div>
    </div>
  );
}
