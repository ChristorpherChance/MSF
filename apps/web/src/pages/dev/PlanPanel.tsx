import { useState } from 'react';
import { devApi } from './api';
import { useDevStore } from './store';

/** 页签一：任务与计划（A06-1~7；识别→覆盖核对→计划提交/批准） */
export function PlanPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [note, setNote] = useState('');
  const approved = s.plans.find((p) => p.state === 'approved');
  const submitted = s.plans.find((p) => p.state === 'submitted');

  return (
    <div>
      {/* 基线与识别 */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>任务识别</strong>
          <span className="dsg-prefix">
            基线 {s.baseline ? `${s.baseline.code}（${s.baseline.valid ? '有效' : '已失效'}）` : '无'}
          </span>
        </div>
        <p className="dsg-prefix">按当前设计基线识别任务池：目录页面 → 前端任务逐页派生 + 公共/集成骨架；同基线重复识别幂等。</p>
        <button
          disabled={!s.baseline?.valid}
          onClick={() =>
            s.act(async () => {
              const r = await devApi.identify(pid, s.baseline!.baselineId, s.baseline!.fingerprint);
              setTimeout(() => useDevStore.setState({ notice: `识别完成：新增 ${r.identified} 个任务` }), 0);
            })
          }
        >
          按基线识别任务
        </button>
      </div>

      {/* 覆盖核对（REQ-403） */}
      {s.coverage && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>覆盖核对</strong>
            <span className={s.coverage.ok ? 'dev-ok' : 'dev-bad'}>{s.coverage.ok ? '双向完整' : '存在缺口'}</span>
          </div>
          {!s.coverage.ok && (
            <div className="gate-box">
              {s.coverage.uncoveredDesignItems.map((c) => (
                <div key={c} className="issue-row">设计项 {c} 无任务承接</div>
              ))}
              {s.coverage.unmatchedTasks.map((c) => (
                <div key={c} className="issue-row">任务 {c} 未关联任何设计项</div>
              ))}
            </div>
          )}
          {s.conflicts.length > 0 && (
            <div className="gate-box">
              {s.conflicts.map((c) => (
                <div key={c.writeScope} className="issue-row">
                  写入范围冲突：{c.writeScope} ← {c.taskIds.join('、')}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 任务池 */}
      <div className="dsg-card">
        <div className="gen-head"><strong>任务池（{s.tasks.length}）</strong></div>
        <table className="dev-table">
          <thead>
            <tr><th>编号</th><th>标题</th><th>类型</th><th>批次</th><th>列</th><th>修订</th><th>进度</th><th>操作</th></tr>
          </thead>
          <tbody>
            {s.tasks.map((t) => (
              <tr key={t.id}>
                <td>{t.code}</td>
                <td>{t.title}{t.blocked && <span className="dev-badge-block">阻塞</span>}</td>
                <td>{t.kind}</td>
                <td>{t.batchNo ?? '-'}</td>
                <td>{{ queue: '排队', ing: '进行', review: '评审', done: '完成' }[t.col]}</td>
                <td>r{t.rev}/c{t.codeRev}</td>
                <td>{t.prog}%</td>
                <td>
                  <button className="act" onClick={() => s.act(() => devApi.confirmCoverage(pid, t.id), '覆盖已确认')}>
                    覆盖确认
                  </button>
                </td>
              </tr>
            ))}
            {s.tasks.length === 0 && <tr><td colSpan={8} className="dsg-prefix">尚未识别任务</td></tr>}
          </tbody>
        </table>
      </div>

      {/* 计划提交/批准（A06-6/7） */}
      <div className="dsg-card">
        <div className="gen-head"><strong>开发计划</strong></div>
        <div className="form-row">
          <input
            placeholder="计划备注（可选）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button
            disabled={s.tasks.length === 0}
            onClick={() =>
              s.act(() => devApi.submitPlan(pid, s.tasks.map((t) => t.code), note || undefined), '计划已提交（待批准）')}
          >
            提交新修订（全任务集）
          </button>
        </div>
        <table className="dev-table">
          <thead>
            <tr><th>修订</th><th>状态</th><th>任务数</th><th>覆盖</th><th>批准人</th><th>失效原因</th><th>操作</th></tr>
          </thead>
          <tbody>
            {s.plans.map((p) => (
              <tr key={p.planId}>
                <td>{p.revision}</td>
                <td>{{ submitted: '待批准', approved: '已批准', invalidated: '已失效' }[p.state]}</td>
                <td>{p.snapshot.taskIds.length}</td>
                <td>{p.coverageReport.ok ? '完整' : `缺口 ${p.coverageReport.uncoveredDesignItems.length}`}</td>
                <td>{p.approvedBy ?? '-'}</td>
                <td className="dsg-prefix">{p.invalidatedReason ?? '-'}</td>
                <td>
                  {p.state === 'submitted' && (
                    <button
                      className="act"
                      title={`指纹 ${p.fingerprint}`}
                      onClick={() =>
                        window.confirm(`批准 ${p.revision}？\n指纹：${p.fingerprint}\n（批准后版本固定，AI 不可代批）`) &&
                        s.act(() => devApi.approvePlan(pid, p.revision, p.fingerprint), `${p.revision} 已批准`)}
                    >
                      人工批准
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {s.plans.length === 0 && <tr><td colSpan={7} className="dsg-prefix">尚无计划修订</td></tr>}
          </tbody>
        </table>
        {(approved || submitted) && (
          <p className="dsg-prefix">
            当前：{approved ? `${approved.revision} 已批准` : `${submitted!.revision} 待批准`}；新提交将使旧批准件失效（superseded）。
          </p>
        )}
      </div>
    </div>
  );
}
