import { useState } from 'react';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { devApi, type DevTask } from './api';
import { asgIcon, KIND_CLASS, KIND_LABEL, RUN_PHASE_LABEL, RUN_STATUS_LABEL, useDevStore } from './store';

const COLS: Array<{ key: DevTask['col']; name: string }> = [
  { key: 'queue', name: '📥 排队' },
  { key: 'ing', name: '⚙️ 进行中' },
  { key: 'review', name: '👀 待评审' },
  { key: 'done', name: '✅ 已合并' },
];

/** 执行工作区 · 任务看板（V7：卡片全字段 + 行内按钮；F02-5 四列 + F02-6 autopilot 命令条） */
export function BoardPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [confirm, setConfirm] = useState<null | 'start' | 'stop' | 'takeover'>(null);
  const run = s.autopilot?.run ?? null;
  const approved = s.plans.find((p) => p.state === 'approved');
  const latest = s.plans[0];
  const running = run && !['stopped', 'transferred'].includes(run.status);

  return (
    <div>
      {/* autopilot 命令条（F07：批准启动/暂停/继续/人工接管/停止；永不含转测试） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>Autopilot</strong>
          {run ? (
            <span className={`dev-run dev-run-${run.status}`}>
              {run.runId} · {RUN_STATUS_LABEL[run.status] ?? run.status}
              {run.status === 'running' && run.phase ? ` · ${RUN_PHASE_LABEL[run.phase] ?? run.phase}` : ''}
            </span>
          ) : (
            <span className="dsg-prefix">尚未启动 · 准备并批准后开始</span>
          )}
          {s.autopilot?.authorization && (
            <span className="dsg-prefix">
              授权 {s.autopilot.authorization.authorizationId}（{s.autopilot.authorization.status}；transferToTest=false）
            </span>
          )}
        </div>
        {run?.blocker && (
          <div className="gate-box err">
            <div className="issue-row">阻断 {run.blocker.code}：{run.blocker.message}</div>
            {/* 处置引导（2026-10-19 打磨：只说「需要处理」用户不知道干什么） */}
            {run.blocker.code === 'SELFTEST_FAILED' && (
              <div className="issue-row">处置路径：切到「开发自测」页签重跑自测 → 报告翻绿后回此页点「继续」。</div>
            )}
            {run.blocker.code === 'HUMAN_TASK_REQUIRED' && (
              <div className="issue-row">处置路径：该任务需人工完成——在下方任务卡上人工推进（开始/提交/合并）后点「继续」。</div>
            )}
          </div>
        )}
        <div className="gen-ops">
          {!running && approved && (
            <button className="act primary" onClick={() => setConfirm('start')}>
              批准并启动
            </button>
          )}
          {run?.status === 'running' && (
            <button className="act" onClick={() => s.act(() => devApi.autopilotControl(pid, 'pause'), '已暂停')}>暂停</button>
          )}
          {run && ['paused', 'blocked', 'taken-over'].includes(run.status) && (
            <button className="act" onClick={() => s.act(() => devApi.autopilotControl(pid, 'resume'), '已继续')}>继续</button>
          )}
          {run && ['running', 'paused', 'blocked'].includes(run.status) && (
            <button className="act" title="autopilot 停摆，后续派发与推进全部转人工" onClick={() => setConfirm('takeover')}>人工接管</button>
          )}
          {running && (
            <button className="act" onClick={() => setConfirm('stop')}>停止</button>
          )}
          <button className="act" onClick={() => s.refresh()}>刷新状态</button>
        </div>
      </div>
      {confirm === 'start' && approved && (
        <ConfirmModal
          title="批准并启动 autopilot"
          confirmLabel="批准并启动"
          body={`计划 ${approved.revision} 指纹：${approved.fingerprint}\n授权范围：开发/单测CI/AI评审/合并/集成构建（不含转测试）`}
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => devApi.autopilotStart(pid, approved.revision, approved.fingerprint), 'autopilot 已启动')}
        />
      )}
      {confirm === 'takeover' && (
        <ConfirmModal
          title="人工接管"
          confirmLabel="确认接管"
          body={'接管后 autopilot 立即停止派发，任务推进责任全部转交人工（开始/评审/合并均手动）。\n与「停止」不同：授权保留，随时可点「继续」交还 autopilot。'}
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => devApi.autopilotControl(pid, 'takeover'), '已人工接管')}
        />
      )}
      {confirm === 'stop' && (
        <ConfirmModal
          title="停止 autopilot"
          confirmLabel="停止并撤销授权"
          body="停止将撤销本次授权，确认？"
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => devApi.autopilotControl(pid, 'stop'), '已停止并撤销授权')}
        />
      )}

      {/* 看板工具栏（原型 devBoardHtml@5175 口径：标题 + 计划状态 tag + 查看计划） */}
      <div className="doc-toolbar">
        <strong>🗂 开发执行</strong>
        <span className={`tag ${latest?.state === 'approved' ? 'tag-ok' : 'tag-warn'}`}>
          {latest ? `计划 ${latest.revision} · ${{ draft: '准备中', submitted: '待批准', approved: '已批准', invalidated: '已失效' }[latest.state]}` : '尚无计划'}
        </span>
        <span className="dsg-prefix">开始动作实时复核计划、基线、依赖和影响；暂停/停止不会伪造完成。</span>
        <span className="spacer" />
        <button className="act" onClick={() => void s.setTopTab('plan')}>查看计划</button>
      </div>

      {/* V7 看板四列（阻塞是标记不是列；卡片含承接图标/依赖/进度/行内按钮/⚠变更徽标） */}
      <div className="v17-board">
        {COLS.map((c) => {
          const colTasks = s.tasks.filter((t) => t.col === c.key);
          return (
            <div key={c.key} className="v17-col">
              <h4>{c.name} · {colTasks.length}</h4>
              {colTasks.map((t) => <BoardCard key={t.id} t={t} />)}
            </div>
          );
        })}
      </div>

      {s.taskDetail && <TaskDrawer />}
    </div>
  );
}

/** V7 看板卡（原型 devBoardCardHtml：asgIcon + ⚠变更徽标 + 进度条 + 行内按钮） */
function BoardCard({ t }: { t: DevTask }) {
  const s = useDevStore();
  const pid = s.projectId!;
  const impacted = s.impacts.some((i) => i.status === 'pending-assessment' && i.affected_tasks.includes(t.code));
  const gate = s.selTaskId === t.id ? s.startGate : null;

  const act = () => {
    if (t.col === 'queue') {
      return (
        <button
          className="act mini primary"
          disabled={gate !== null && !gate.ok}
          title={gate && !gate.ok ? gate.issues.map((i) => i.message).join('；') : ''}
          onClick={(e) => { e.stopPropagation(); void s.act(async () => { await devApi.transition(pid, t.id, 'ing'); }, `${t.code} 已开始`); }}
        >
          开始
        </button>
      );
    }
    if (t.col === 'ing') {
      return (
        <>
          {t.runStatus === 'paused' || t.runStatus === 'stopped' ? (
            <button className="act mini primary" onClick={(e) => { e.stopPropagation(); void s.act(() => devApi.transition(pid, t.id, 'resume'), '已继续'); }}>继续</button>
          ) : (
            <>
              {t.ownerType !== 'human' && (
                <button className="act mini" onClick={(e) => { e.stopPropagation(); void s.act(() => devApi.runTask(pid, t.id), '编码完成'); }}>执行编码</button>
              )}
              <button className="act mini" onClick={(e) => { e.stopPropagation(); void s.act(() => devApi.transition(pid, t.id, 'pause'), '已暂停'); }}>暂停</button>
            </>
          )}
          <button className="act mini" onClick={(e) => { e.stopPropagation(); void s.act(() => devApi.transition(pid, t.id, 'stop'), '已停止并返回排队重排'); }}>停止</button>
          {t.prog >= 100 && (
            <button className="act mini primary" onClick={(e) => { e.stopPropagation(); void s.act(() => devApi.transition(pid, t.id, 'review'), '已提交评审'); }}>提交评审</button>
          )}
        </>
      );
    }
    if (t.col === 'review') {
      return (
        <button className="act mini" onClick={(e) => { e.stopPropagation(); void s.setTopTab('quality'); s.setSide('pr'); }}>查看 PR</button>
      );
    }
    return null;
  };

  return (
    <div
      className={`v17-run${s.selTaskId === t.id ? ' sel' : ''}`}
      onClick={() => void s.selectTask(t.id)}
    >
      <div className="v17-taskline">
        <b>{t.code}</b>
        <span className={`tag dev-kind-${KIND_CLASS[t.kind] ?? 'gray'}`}>{KIND_LABEL[t.kind] ?? t.kind}</span>
        {impacted && <span className="tag tag-warn" title="有未处置/需返工的变更影响">⚠ 变更</span>}
        {t.blocked && <span className="dev-badge-block">阻塞</span>}
      </div>
      <div className="v17-cardtitle">{t.title}</div>
      <div className="v17-meta">
        批次 {t.batchNo ?? '—'} · {asgIcon(t.ownerType)}{' '}
        <span title={t.owner === 'mock-agent' ? '原型期执行体占位：走真实命令链路与审计，但不产出真实代码提交（M6 接真实执行器）' : undefined}>
          {t.owner}
        </span>
        <br />依赖：{t.deps.join('、') || '无'}
        {t.sourceIds.length > 0 && (
          <>
            <br />
            {t.sourceIds.map((sid) => (
              <span key={sid} className="tag" style={{ marginRight: 4 }} title="来源条目">{sid} 🔗</span>
            ))}
          </>
        )}
      </div>
      {t.col === 'ing' && (
        <>
          <div className="prog"><i style={{ width: `${t.prog}%` }} /></div>
          <div className="v17-meta">{t.prog}% · {t.runStatus === 'paused' ? '已暂停' : t.prog >= 100 ? '实现就绪，尚未提交' : t.ownerType === 'human' ? '人工填报' : '执行中'}</div>
        </>
      )}
      <div className="mini-act">{act()}</div>
    </div>
  );
}

/** 任务操作抽屉：门禁提示 + 返工 + PR checklist + 合并依据（卡片行内按钮之外的完整操作面） */
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
        <span className="dsg-prefix">r{t.rev}/c{t.codeRev} · {t.runStatus}</span>
        <button className="act" onClick={() => void s.selectTask(null)}>关闭</button>
      </div>
      <p className="dsg-prefix">
        目标：{t.goal}｜范围：{t.scope}｜边界：{t.boundary}｜写入：{t.writeScopes.join('、') || '-'}
      </p>
      {t.col === 'queue' && s.startGate && !s.startGate.ok && (
        <div className="gate-box err">
          {s.startGate.issues.map((i) => (
            <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
          ))}
        </div>
      )}
      <div className="gen-ops">
        {t.col === 'queue' && (
          <button className="act primary" disabled={s.startGate ? !s.startGate.ok : false} onClick={() => transition('ing')}>开始</button>
        )}
        {t.col === 'ing' && t.runStatus === 'running' && t.ownerType !== 'human' && (
          <button className="act" onClick={() => s.act(async () => { await devApi.runTask(pid, t.id); await s.selectTask(t.id); }, '编码完成')}>执行编码</button>
        )}
        {t.col === 'ing' && t.prog === 100 && (
          <button className="act primary" onClick={() => transition('review')}>提交评审</button>
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
        {/* W2-016：已合并任务的缺陷驱动返工入口（重入 queue、计划失效待重批） */}
        {t.col === 'done' && (
          <>
            <input placeholder="返工理由（必填，如缺陷编号）" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button
              className="act"
              disabled={!reason.trim()}
              onClick={() => transition('rework', reason)}
            >
              返工重开
            </button>
          </>
        )}
        {t.col === 'ing' && t.ownerType === 'human' && (
          <div className="form-row" style={{ margin: 0 }}>
            {[10, 25, 50].map((n) => (
              <button key={n} className="act mini" onClick={() => s.act(async () => { await devApi.progress(pid, t.id, Math.min(100, t.prog + n)); await s.selectTask(t.id); })}>+{n}%</button>
            ))}
          </div>
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
            <button className="act" onClick={() => s.act(async () => { await devApi.quality(pid, t.id); await s.selectTask(t.id); }, '单测+CI 证据已落')}>
              执行单测/CI
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.aiReview(pid, t.id); await s.selectTask(t.id); }, 'AI 评审已落')}>
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
            <button className="act primary" onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'manual-checklist'); await s.selectTask(t.id); }, '已合并（manual-checklist）')}>
              合并（checklist）
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'manual-skip', skipReason || undefined); await s.selectTask(t.id); }, '已合并（manual-skip）')}>
              合并（豁免）
            </button>
            <button className="act" onClick={() => s.act(async () => { await devApi.merge(pid, t.id, 'legacy-manual'); await s.selectTask(t.id); }, '已合并（legacy-manual）')}>
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
          {t.ciReports.length > 0 && `｜CI：${t.ciReports.map((c) => `${c.commit_sha.slice(0, 8)}=${c.conclusion}`).join('、')}`}
        </div>
      )}
    </div>
  );
}
