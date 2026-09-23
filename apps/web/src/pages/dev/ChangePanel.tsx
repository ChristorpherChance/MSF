import { useState } from 'react';
import { devApi } from './api';
import { useDevStore } from './store';

/** 变更工作区路由（左栏 changePage：impacts 影响处置 / baseline 输入基线 / history 计划与审计） */
export function ChangePanel() {
  const s = useDevStore();
  if (s.changePage === 'baseline') return <BaselinePage />;
  if (s.changePage === 'history') return <HistoryPage />;
  return <ImpactsPage />;
}

/** V11 影响处置（原型 devImpactHtml：逐事件卡片 + 处置按钮 + CI 回传设置） */
function ImpactsPage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [note, setNote] = useState('');
  const [secret, setSecret] = useState('');
  const pending = s.impacts.filter((i) => i.status === 'pending-assessment');

  return (
    <div>
      <div className="doc-toolbar">
        <strong>🌊 影响处置</strong>
        <span className={`tag ${pending.length ? 'tag-warn' : 'tag-ok'}`}>开放 {pending.length}</span>
        <span className="dsg-prefix">处置与计划批准彼此独立；返工由明确关联的新提交闭环。</span>
        <span className="spacer" />
        <button className="act" onClick={() => s.act(async () => {
          const r = await devApi.observe(pid);
          if (!r.impacts.length) useDevStore.setState({ notice: '未发现受影响任务' });
        })}>观察输入变化</button>
        {pending.length > 0 && (
          <button className="act"
            onClick={() => window.confirm(`对全部 ${pending.length} 张未决影响单执行「基线重确认（accept）」？`) &&
              s.act(() => devApi.confirmBaseline(pid, '基线人工重确认'), '基线已重确认')}>
            基线重确认（全部 accept）
          </button>
        )}
      </div>

      {s.impacts.length === 0 && (
        <div className="dsg-card dsg-prefix" style={{ textAlign: 'center', padding: 24 }}>
          暂无上游变更事件。设计基线再定稿后点「观察输入变化」生成影响单（同触发幂等）。
        </div>
      )}
      {s.impacts.map((im) => (
        <div key={im.id} className="dsg-card">
          <div className="v17-taskline">
            <b>{im.code}</b>
            <span className={`tag ${im.status === 'pending-assessment' ? 'tag-warn' : 'tag-ok'}`}>
              {{ 'pending-assessment': '待评估', rework: '已返工', accepted: '已接受' }[im.status] ?? im.status}
            </span>
            <span style={{ flex: 1 }} className="dsg-prefix">{im.trigger}</span>
          </div>
          <div className="v17-meta">
            受影响任务：{im.affected_tasks.join('、') || '—'}
            {im.resolution ? ` · 处置：${im.resolution}` : ''}{im.note ? `（${im.note}）` : ''}
          </div>
          {im.status === 'pending-assessment' && (
            <div className="gen-ops" style={{ marginTop: 8 }}>
              <input placeholder="处置说明（可选）" value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1 }} />
              <button className="act primary"
                onClick={() => window.confirm(`${im.code} 返工：受影响任务修订+1 并回排队、计划失效，确认？`) &&
                  s.act(() => devApi.applyImpact(pid, [im.code], 'rework', note || undefined), `${im.code} 已返工`)}>
                需返工
              </button>
              <button className="act"
                onClick={() => s.act(() => devApi.applyImpact(pid, [im.code], 'accept', note || undefined), `${im.code} 已接受`)}>
                不受影响
              </button>
            </div>
          )}
        </div>
      ))}

      {/* CI webhook 设置（A06-22 只写不读） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>CI 回传设置</strong>
          <span className="dsg-prefix">{s.ciSecret?.enabled ? `已启用（${s.ciSecret.secretMasked}）` : '未启用'}</span>
        </div>
        <p className="dsg-prefix">
          密钥只写不读（密文落库、掩码回显）；回传端点 POST {`/api/v1/projects/${pid}/dev/ci/callbacks`}，
          头：X-MSF-Timestamp / X-MSF-Signature（HMAC-SHA256，签名串 timestamp.body）/ X-MSF-Delivery（投递幂等）。
        </p>
        <div className="form-row">
          <input
            type="password" placeholder="新密钥（≥32 字符，含字母与数字）"
            value={secret} onChange={(e) => setSecret(e.target.value)}
          />
          <button className="act" disabled={secret.length < 32}
            onClick={() => window.confirm('登记/轮换密钥？旧密钥立即失效。') &&
              s.act(async () => { await devApi.setSecret(pid, secret); setSecret(''); }, '密钥已登记')}>
            {s.ciSecret?.enabled ? '轮换密钥' : '登记密钥'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** V11 输入基线卡（原型 devBaselineHtml：工件/版本/定稿身份/摘要/适用 + 基线失效重确认） */
function BaselinePage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const bl = s.baseline;
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🔐 输入基线</strong>
        <span className={`tag ${bl?.valid ? 'tag-ok' : 'tag-warn'}`}>{bl ? (bl.valid ? '已确认' : '已失效') : '无基线'}</span>
        <span className="dsg-prefix">同版本重新定稿也会形成新的输入批次。</span>
        <span className="spacer" />
        <button
          className="act primary"
          disabled={!bl || bl.valid}
          title={bl?.valid ? '基线有效，无需重确认' : ''}
          onClick={() => window.confirm('核对差异并确认新基线？') &&
            s.act(() => devApi.confirmBaseline(pid, '基线人工重确认'), '基线已重确认')}
        >
          核对差异并确认新基线
        </button>
      </div>
      <div className="dsg-card">
        {bl ? (
          <>
            <h3>{bl.code}</h3>
            <table className="dev-table">
              <thead><tr><th>属性</th><th>值</th></tr></thead>
              <tbody>
                <tr><td>基线编号</td><td>{bl.code}</td></tr>
                <tr><td>指纹</td><td className="dsg-prefix">{bl.fingerprint}</td></tr>
                <tr><td>状态</td><td>{bl.valid ? '有效（开发输入以此为准）' : '已失效（需人工核对差异并重确认）'}</td></tr>
              </tbody>
            </table>
            <p className="dsg-prefix" style={{ marginTop: 10 }}>
              本版本开发以已定稿的共同设计基线为依据，包含原型 UI、设计检查及上游文档身份；确认输入后请返回「任务与计划」准备计划。
            </p>
          </>
        ) : (
          <p className="dsg-prefix">尚无设计基线；请先在设计阶段完成原型定稿并确认共同基线。</p>
        )}
      </div>
    </div>
  );
}

/** V11 计划与审计只读时间线（原型 devHistoryHtml：计划修订 + 影响事件 + 操作审计） */
function HistoryPage() {
  const s = useDevStore();
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🕒 计划版本、变更与审计</strong>
        <span className="dsg-prefix">只读；历史版本不覆盖当前任务执行状态</span>
      </div>
      <div className="dsg-card">
        <div className="gen-head"><strong>计划修订</strong></div>
        {s.plans.length === 0 && <p className="dsg-prefix">尚无提交版本</p>}
        {s.plans.map((p) => (
          <div key={p.planId} className="v17-history">
            <b>{p.revision}</b>{' '}
            <span className={`tag ${p.state === 'approved' ? 'tag-ok' : p.state === 'submitted' ? 'tag-warn' : ''}`}>
              {{ submitted: '已提交', approved: '已批准', invalidated: '已失效' }[p.state] ?? p.state}
            </span>
            <div className="dsg-prefix">
              任务 {p.snapshot.taskIds.length} · 基线 {p.baselineFingerprint.slice(0, 19)}…
              {p.approvedBy ? ` · ${p.approvedBy} 批准${p.approvedAt ? ` ${new Date(p.approvedAt).toLocaleString()}` : ''}` : ''}
              {p.invalidatedReason ? ` · 失效：${p.invalidatedReason}` : ''}
            </div>
          </div>
        ))}
      </div>
      <div className="dsg-card">
        <div className="gen-head"><strong>输入变更事件</strong></div>
        {s.impacts.length === 0 && <p className="dsg-prefix">暂无变更事件</p>}
        {s.impacts.map((im) => (
          <div key={im.id} className="v17-history">
            <b>{im.code}</b> · {im.trigger}
            <div className="dsg-prefix">
              {new Date(im.created_at).toLocaleString()} · 受影响 {im.affected_tasks.join('、') || '—'}
              {im.resolution ? ` · ${im.resolution}` : ''}{im.note ? ` · ${im.note}` : ''}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
