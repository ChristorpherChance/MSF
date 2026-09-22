import { useState } from 'react';
import { tstApi } from './api';
import { useTstStore } from './store';

const RESULT_NAME: Record<string, string> = {
  pass: '通过', fail: '失败', blocked: '受阻', 'not-run': '未执行', 'not-applicable': '不适用',
};

/** 页签二：用例与执行（执行按钮 + 用例行 .qa-case + 人工走查录入 modal） */
export function RunPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  const [manual, setManual] = useState<{ caseId: string; status: string; evidence: string; simulation: boolean } | null>(null);
  const det = s.batchDetail;
  if (!det) return <p className="dsg-prefix qa-empty">请先接收批次</p>;

  const canExecute = det.status === 'approved' || det.status === 'executing';
  const approvedPlan = det.plans.find((p) => p.state === 'approved');
  return (
    <div>
      <div className="dsg-card">
        <div className="gen-head">
          <strong>执行</strong>
          <span className="dsg-prefix">
            {s.runs.length > 0 ? `共 ${s.runs.length} 个运行版本（追加式，历史不可改写）` : '尚无运行'}
          </span>
          <button
            className="act"
            disabled={!canExecute || !approvedPlan || s.plan?.state !== 'approved'}
            title={s.plan?.state !== 'approved' ? '计划批准后才可执行' : ''}
            onClick={() => s.act(() => tstApi.executeRun(pid, det.batchId, s.plan!.planId), '执行完成（自动用例 mock 执行器）')}
          >
            执行批准计划
          </button>
        </div>
        {s.runs.length > 0 && (
          <div className="qa-runs-row">
            {s.runs.map((r) => (
              <span key={r.runId} className={`dev-run ${r.runId === s.latestRunId ? 'dev-run-running' : ''}`}>
                {r.runId} {r.conclusion ? RESULT_NAME[r.conclusion] ?? r.conclusion : '—'}
                {r.isSimulated ? '（模拟）' : ''}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 用例行（最新运行版本） */}
      {s.caseRuns.length > 0 && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>用例结果（{s.latestRunId}）</strong>
            <span className="dsg-prefix">不适用≠通过；必测未执行留分母</span>
          </div>
          {s.caseRuns.map((c) => (
            <div key={c.code} className="qa-case">
              <div className="qa-case-head">
                <strong>{c.code}</strong>
                <span>{c.title}</span>
                <span className={`qa-tag qa-tag-${c.result}`}>{RESULT_NAME[c.result] ?? c.result}</span>
                <span className="dsg-prefix">{c.executor_kind === 'auto' ? '自动' : '人工'}{c.is_simulated ? ' · 模拟' : ''}</span>
                {c.mode === 'manual' && det.status === 'executing' && (
                  <button className="act" onClick={() => setManual({ caseId: c.code, status: 'pass', evidence: '', simulation: false })}>
                    录入人工结论
                  </button>
                )}
              </div>
              {c.note && <div className="dsg-prefix">证据摘要：{c.note}</div>}
            </div>
          ))}
        </div>
      )}

      {/* 人工走查记录 modal（证据必填；人工结论不得由自动执行代填 → 追加新运行版本） */}
      {manual && s.latestRunId && (
        <div className="qa-modal-mask" onClick={() => setManual(null)}>
          <div className="qa-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gen-head"><strong>人工走查记录 · {manual.caseId}</strong></div>
            <div className="form-row">
              <label>结论</label>
              <select value={manual.status} onChange={(e) => setManual({ ...manual, status: e.target.value })}>
                <option value="pass">通过</option>
                <option value="fail">失败</option>
                <option value="blocked">受阻</option>
              </select>
            </div>
            <textarea
              rows={4}
              placeholder="验证证据（必填：验证了什么、证据位置）"
              value={manual.evidence}
              onChange={(e) => setManual({ ...manual, evidence: e.target.value })}
            />
            <label className="dev-check">
              <input type="checkbox" checked={manual.simulation}
                onChange={(e) => setManual({ ...manual, simulation: e.target.checked })} />
              模拟执行（显式标注，报告侧不可作正式放行依据）
            </label>
            <div className="gen-ops">
              <button
                className="act"
                disabled={!manual.evidence.trim()}
                onClick={() =>
                  s.act(async () => {
                    await tstApi.manualRecord(pid, s.latestRunId!, manual.caseId, manual);
                    setManual(null);
                  }, '已录入（追加新运行版本）')}
              >
                保存记录
              </button>
              <button onClick={() => setManual(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
