import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { Modal } from '../../ui/Modal';
import { devApi } from './api';
import { useDevStore } from './store';

/** 变更工作区路由（左栏 changePage：impacts 影响处置 / baseline 输入基线 / history 计划与审计） */
export function ChangePanel() {
  const s = useDevStore();
  if (s.changePage === 'baseline') return <BaselinePage />;
  if (s.changePage === 'history') return <HistoryPage />;
  return <ImpactsPage />;
}

/** V11 影响处置（原型 devImpactHtml/devSetImpact：逐事件卡片 + 处置 modal（理由必填）+ CI 回传设置） */
function ImpactsPage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [impactModal, setImpactModal] = useState<{ code: string; act: 'rework' | 'accept' } | null>(null);
  const [reason, setReason] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [secret, setSecret] = useState('');
  const [secretConfirm, setSecretConfirm] = useState(false);
  const pending = s.impacts.filter((i) => i.status === 'pending-assessment');

  return (
    <div>
      <div className="doc-toolbar">
        <strong>🌊 影响处置</strong>
        <span className={`tag ${pending.length ? 'tag-warn' : 'tag-ok'}`}>开放 {pending.length}</span>
        <span className="dsg-prefix">处置与计划批准彼此独立；返工由明确关联的新提交闭环。</span>
        <span className="spacer" />
        <button className="act" disabled={s.acting} onClick={() => s.act(async () => {
          const r = await devApi.observe(pid);
          if (!r.impacts.length) useDevStore.setState({ notice: '未发现受影响任务' });
        })}>观察输入变化</button>
        {pending.length > 0 && (
          <button className="act" onClick={() => { setReason(''); setConfirmAll(true); }}>
            基线重确认（全部 accept）
          </button>
        )}
      </div>
      {/* W2-043/044：重确认=人工确认点，理由必填（与服务端校验同口径）；重登新基线行并使计划失效 */}
      {confirmAll && (
        <Modal
          title="基线重确认"
          onClose={() => setConfirmAll(false)}
          footer={
            <>
              <button className="sm" onClick={() => setConfirmAll(false)}>取消</button>
              <button
                className="sm primary"
                disabled={!reason.trim()}
                title={reason.trim() ? '' : '重确认理由不能为空'}
                onClick={() => {
                  setConfirmAll(false);
                  void s.act(() => devApi.confirmBaseline(pid, reason.trim()), '基线已重确认');
                }}
              >
                全部 accept 并重确认
              </button>
            </>
          }
        >
          <p className="pop-tip">
            对全部 {pending.length} 张未决影响单执行 accept；若上游定稿实况与现行基线不符，将重登新基线行（reconfirmed_of 链），已批准计划失效须重新核对、提交、批准。
          </p>
          <textarea
            rows={3}
            style={{ width: '100%' }}
            placeholder="必填：核对差异结论"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Modal>
      )}

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
              <button className="act primary" onClick={() => { setReason(''); setImpactModal({ code: im.code, act: 'rework' }); }}>
                需返工
              </button>
              <button className="act" onClick={() => { setReason(''); setImpactModal({ code: im.code, act: 'accept' }); }}>
                不受影响
              </button>
            </div>
          )}
        </div>
      ))}

      {/* 处置 modal（原型 devSetImpact 口径：理由必填，空理由不提交） */}
      {impactModal && (
        <Modal
          title={`${impactModal.code} · ${impactModal.act === 'rework' ? '要求返工' : '判断不受影响'}`}
          onClose={() => setImpactModal(null)}
          footer={
            <>
              <button className="sm" onClick={() => setImpactModal(null)}>取消</button>
              <button
                className="sm primary"
                disabled={!reason.trim()}
                title={reason.trim() ? '' : '处置理由不能为空'}
                onClick={() => {
                  const { code, act } = impactModal;
                  setImpactModal(null);
                  void s.act(
                    () => devApi.applyImpact(pid, [code], act, reason.trim()),
                    act === 'rework' ? `${code} 已返工` : `${code} 已接受`,
                  );
                }}
              >
                记录处置
              </button>
            </>
          }
        >
          {impactModal.act === 'rework' && (
            <p className="pop-tip">返工：受影响任务修订 +1 并回排队、已批准计划失效。</p>
          )}
          <textarea
            rows={3}
            style={{ width: '100%' }}
            placeholder="必填：判断依据或返工范围"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Modal>
      )}

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
          <button className="act" disabled={secret.length < 32} onClick={() => setSecretConfirm(true)}>
            {s.ciSecret?.enabled ? '轮换密钥' : '登记密钥'}
          </button>
        </div>
      </div>
      {secretConfirm && (
        <ConfirmModal
          title={s.ciSecret?.enabled ? '轮换密钥' : '登记密钥'}
          body="登记/轮换密钥？旧密钥立即失效。"
          confirmLabel="确认登记"
          onClose={() => setSecretConfirm(false)}
          onConfirm={() => s.act(async () => { await devApi.setSecret(pid, secret); setSecret(''); }, '密钥已登记')}
        />
      )}
    </div>
  );
}

/** V11 输入基线卡（原型 devBaselineHtml：工件/版本/定稿身份/摘要/适用 + 基线失效重确认） */
function BaselinePage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const bl = s.baseline;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmReason, setConfirmReason] = useState('');
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
          onClick={() => { setConfirmReason(''); setConfirmOpen(true); }}
        >
          核对差异并确认新基线
        </button>
      </div>
      {/* W2-043/044：理由必填；重登 dsg_baselines 新行（reconfirmed_of 链），计划失效须重批 */}
      {confirmOpen && (
        <Modal
          title="确认新基线"
          onClose={() => setConfirmOpen(false)}
          footer={
            <>
              <button className="sm" onClick={() => setConfirmOpen(false)}>取消</button>
              <button
                className="sm primary"
                disabled={!confirmReason.trim()}
                title={confirmReason.trim() ? '' : '重确认理由不能为空'}
                onClick={() => {
                  setConfirmOpen(false);
                  void s.act(() => devApi.confirmBaseline(pid, confirmReason.trim()), '基线已重确认');
                }}
              >
                确认新基线
              </button>
            </>
          }
        >
          <p className="pop-tip">
            按上方工件表逐项核对差异后确认：以当前上游定稿实况重登新基线行；已批准计划将失效，任务覆盖核对回 pending，须重新核对、提交、批准。
          </p>
          <textarea
            rows={3}
            style={{ width: '100%' }}
            placeholder="必填：核对差异结论"
            value={confirmReason}
            onChange={(e) => setConfirmReason(e.target.value)}
          />
        </Modal>
      )}
      <div className="dsg-card">
        {bl ? (
          <>
            <h3>{bl.code} · 定稿批次身份 {bl.fingerprint.slice(0, 19)}…</h3>
            {/* L4 输入基线工件表（原型 devBaselineHtml 口径；版本身份=版本对象短 ID，摘要=内容指纹） */}
            <table className="dev-table">
              <thead><tr><th>工件</th><th>版本身份</th><th>内容摘要</th><th>适用</th></tr></thead>
              <tbody>
                {bl.items.map((it) => (
                  <tr key={it.artifact}>
                    <td><b>{it.artifact}</b></td>
                    <td className="dsg-prefix">{it.version_id ? `${it.version_id.slice(0, 8)}…` : '—（未定稿）'}</td>
                    <td className="dsg-prefix">{it.fingerprint ? `sha256:${it.fingerprint.slice(0, 15)}…` : '—'}</td>
                    {/* 适用口径=gate-common liveBaselineFingerprint：PRD/PROTOTYPE 必需定稿，HLD 定稿或当前版 */}
                    <td>{({ PRD: '必需（定稿）', PROTOTYPE: '必需（定稿）', HLD: '定稿或当前版' } as Record<string, string>)[it.artifact] ?? '可选'}</td>
                  </tr>
                ))}
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
              {{ draft: '准备中', submitted: '已提交', approved: '已批准', invalidated: '已失效' }[p.state] ?? p.state}
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
      <AuditCard />
    </div>
  );
}

/** L4 操作审计卡（A10-3 只读链：append-only 哈希链，无改删；本卡过滤 dev. 前缀命令） */
function AuditCard() {
  const s = useDevStore();
  const pid = s.projectId;
  const [items, setItems] = useState<Array<{ eventId: string; actor: string; actorType: string; command: string; at: string }> | null>(null);
  useEffect(() => {
    if (!pid) return;
    void devApi.audit(pid)
      .then((r) => setItems(r.items.filter((x) => x.command.startsWith('dev.'))))
      .catch(() => setItems([]));
  }, [pid]);
  return (
    <div className="dsg-card">
      <div className="gen-head">
        <strong>操作审计</strong>
        <span className="dsg-prefix">append-only 哈希链 · 只读 · 本域命令（dev.*）</span>
      </div>
      {items === null ? (
        <p className="dsg-prefix">加载中…</p>
      ) : items.length === 0 ? (
        <p className="dsg-prefix">暂无本域操作记录。</p>
      ) : (
        <table className="dev-table">
          <thead><tr><th>时间</th><th>命令</th><th>操作者</th></tr></thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.eventId}>
                <td className="dsg-prefix">{new Date(x.at).toLocaleString()}</td>
                <td><code>{x.command}</code></td>
                <td>{x.actor}<span className="dsg-prefix">（{x.actorType}）</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
