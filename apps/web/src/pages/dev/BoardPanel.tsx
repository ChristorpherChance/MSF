import { useState } from 'react';
import { devApi, type DevTask } from './api';
import { useDevStore } from './store';

const COLS: Array<{ key: DevTask['col']; name: string }> = [
  { key: 'queue', name: '排队' },
  { key: 'ing', name: '进行中' },
  { key: 'review', name: '待评审' },
  { key: 'done', name: '已完成' },
];

/** 页签二：开发执行（F02-5 看板四列 + F02-6 autopilot 命令条 + 任务操作抽屉） */
export function BoardPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const run = s.autopilot?.run ?? null;
  const approved = s.plans.find((p) => p.state === 'approved');
  const running = run && !['stopped', 'transferred'].includes(run.status);

  return (
    <div>
      {/* autopilot 命令条（F07：批准启动/暂停/恢复/接管/停止；永不含转测试） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>Autopilot</strong>
          {run && (
            <span className={`dev-run dev-run-${run.status}`}>
              {run.runId} · {{ running: '运行中', paused: '已暂停', blocked: '已阻断', 'taken-over': '人工接管', stopped: '已停止', 'awaiting-transfer': '待转测试', transferred: '已交接' }[run.status] ?? run.status}
            </span>
          )}
          {s.autopilot?.authorization && (
            <span className="dsg-prefix">
              授权 {s.autopilot.authorization.authorizationId}（{s.autopilot.authorization.status}；transferToTest=false）
            </span>
          )}
        </div>
        {run?.blocker && (
          <div className="gate-box">
            <div className="issue-row">阻断 {run.blocker.code}：{run.blocker.message}</div>
          </div>
        )}
        <div className="gen-ops">
          {!running && approved && (
            <button
              onClick={() =>
                window.confirm(`批准并启动 autopilot？\n计划 ${approved.revision} 指纹：${approved.fingerprint}\n授权范围：开发/单测CI/AI评审/合并/集成构建（不含转测试）`) &&
                s.act(() => devApi.autopilotStart(pid, approved.revision, approved.fingerprint), 'autopilot 已启动')}
            >
              批准并启动
            </button>
          )}
          {run?.status === 'running' && (
            <button className="act" onClick={() => s.act(() => devApi.autopilotControl(pid, 'pause'), '已暂停')}>暂停</button>
          )}
          {run && ['paused', 'blocked', 'taken-over'].includes(run.status) && (
            <button className="act" onClick={() => s.act(() => devApi.autopilotControl(pid, 'resume'), '已恢复')}>恢复</button>
          )}
          {run && ['running', 'paused', 'blocked'].includes(run.status) && (
            <button className="act" onClick={() => s.act(() => devApi.autopilotControl(pid, 'takeover'), '已人工接管')}>接管</button>
          )}
          {running && (
            <button
              className="act"
              onClick={() => window.confirm('停止将撤销本次授权，确认？') &&
                s.act(() => devApi.autopilotControl(pid, 'stop'), '已停止并撤销授权')}
            >
              停止
            </button>
          )}
          <button className="act" onClick={() => s.refresh()}>刷新状态</button>
        </div>
      </div>

      {/* 看板四列（阻塞是标记不是列） */}
      <div className="dev-board">
        {COLS.map((c) => (
          <div key={c.key} className="dev-col">
            <div className="dev-col-head">{c.name}（{s.tasks.filter((t) => t.col === c.key).length}）</div>
            {s.tasks.filter((t) => t.col === c.key).map((t) => (
              <div
                key={t.id}
                className={`dev-card${s.selTaskId === t.id ? ' sel' : ''}`}
                onClick={() => void s.selectTask(t.id)}
              >
                <div className="dev-card-title">
                  {t.code} {t.title}
                  {t.blocked && <span className="dev-badge-block">阻塞</span>}
                </div>
                <div className="dsg-prefix">
                  {t.kind} · 批次{t.batchNo ?? '-'} · r{t.rev}/c{t.codeRev} · {t.runStatus} · {t.prog}%
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      {s.taskDetail && <TaskDrawer />}
    </div>
  );
}

/** 任务操作抽屉：门禁提示 + 流转 + PR checklist + 合并依据 */
function TaskDrawer() {
  const s = useDevStore();
  const pid = s.projectId!;
  const t = s.taskDetail!;
  const [reason, setReason] = useState('');
  const [skipReason, setSkipReason] = useState('');
  const pr = t.prs.find((p) => p.status === 'review' || p.status === 'changes');
  const transition = (to: string, note?: string) =>
    s.act(async () => {
      await devApi.transition(pid, t.id, to, note);
      await s.selectTask(t.id);
    });

  return (
    <div className="dsg-card dev-drawer">
      <div className="gen-head">
        <strong>{t.code} {t.title}</strong>
        <button className="act" onClick={() => void s.selectTask(null)}>关闭</button>
      </div>
      <p className="dsg-prefix">
        目标：{t.goal}｜范围：{t.scope}｜边界：{t.boundary}｜写入：{t.writeScopes.join('、') || '-'}
      </p>
      {t.col === 'queue' && s.startGate && !s.startGate.ok && (
        <div className="gate-box">
          {s.startGate.issues.map((i) => (
            <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
          ))}
        </div>
      )}
      <div className="gen-ops">
        {t.col === 'queue' && (
          <button disabled={s.startGate ? !s.startGate.ok : false} onClick={() => transition('ing')}>开始</button>
        )}
        {t.col === 'ing' && t.runStatus === 'running' && (
          <>
            <button className="act" onClick={() => s.act(async () => { await devApi.runTask(pid, t.id); await s.selectTask(t.id); }, '编码完成（mock）')}>执行编码</button>
            <button className="act" onClick={() => transition('pause')}>暂停</button>
          </>
        )}
        {t.col === 'ing' && ['paused', 'stopped'].includes(t.runStatus) && (
          <button className="act" onClick={() => transition('resume')}>继续</button>
        )}
        {t.col === 'ing' && t.runStatus === 'running' && (
          <button className="act" onClick={() => transition('stop')}>停止</button>
        )}
        {t.col === 'ing' && t.prog === 100 && (
          <button onClick={() => transition('review')}>提交评审</button>
        )}
        {['ing', 'review'].includes(t.col) && (
          <>
            <input placeholder="返工理由（必填）" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button
              className="act"
              disabled={!reason.trim()}
              onClick={() => transition('rework', reason)}
            >
              驳回返工
            </button>
          </>
        )}
      </div>

      {/* PR 与评审（review 列） */}
      {t.col === 'review' && pr && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>{pr.pr_ref}</strong>
            <span className="dsg-prefix">codeRev {pr.code_rev}</span>
          </div>
          <div className="gen-ops">
            <button className="act" onClick={() => s.act(async () => { await devApi.quality(pid, t.id); await s.selectTask(t.id); }, '单测+CI 证据已落（mock 达标）')}>
              执行单测/CI
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.aiReview(pid, t.id); await s.selectTask(t.id); }, 'AI 独立评审已落')}>
              AI 评审
            </button>
          </div>
          <div className="form-row">
            {(['acceptance', 'standards', 'design'] as const).map((k) => (
              <label key={k} className="dev-check">
                <input
                  type="checkbox"
                  checked={!!pr.checklist[k]}
                  onChange={(e) =>
                    s.act(async () => {
                      await devApi.toggleCheck(pid, t.id, k, e.target.checked);
                      await s.selectTask(t.id);
                    })}
                />
                {{ acceptance: '验收达标', standards: '规范符合', design: '设计一致' }[k]}
              </label>
            ))}
            {pr.checklist.skipped && <span className="dsg-prefix">已登记豁免</span>}
          </div>
          <div className="form-row">
            <input placeholder="豁免理由（manual-skip 必填）" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
            <button className="act" disabled={!skipReason.trim()}
              onClick={() => s.act(async () => { await devApi.prSkip(pid, t.id, skipReason); await s.selectTask(t.id); }, '豁免已登记')}>
              登记豁免
            </button>
          </div>
          <div className="gen-ops">
            <button onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'manual-checklist'); }, '已合并（manual-checklist）')}>
              合并（checklist）
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'manual-skip', skipReason || undefined); }, '已合并（manual-skip）')}>
              合并（豁免）
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'legacy-manual'); }, '已合并（legacy-manual）')}>
              合并（遗留人工）
            </button>
          </div>
        </div>
      )}

      {/* 历史 PR + 证据 + CI */}
      {t.prs.length > 0 && (
        <table className="dev-table">
          <thead><tr><th>PR</th><th>codeRev</th><th>状态</th><th>合并依据</th></tr></thead>
          <tbody>
            {t.prs.map((p) => (
              <tr key={p.pr_ref}>
                <td>{p.pr_ref}</td><td>{p.code_rev}</td>
                <td>{p.status === 'stale' ? '历史只读' : p.status}</td>
                <td className="dsg-prefix">{p.merge_basis ? JSON.stringify(p.merge_basis) : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {t.evidence.length > 0 && (
        <div className="dsg-prefix">
          证据：{t.evidence.map((e) => `${e.kind}#${e.seq}`).join('、')}
          {t.ci.length > 0 && `｜CI：${t.ci.map((c) => `${c.commit_sha.slice(0, 8)}=${c.conclusion}`).join('、')}`}
        </div>
      )}
    </div>
  );
}
