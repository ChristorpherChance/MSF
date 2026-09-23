import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { platformApi } from '../platform/api';
import { useDelegateStore } from './store';
import { delegateApi, type Delegation, type DelegationTarget, type DraftTestResult } from './api';
import '../req/req.css';
import '../platform/settings.css';
import './delegate.css';

/** 委派状态五态+超时态（LLD-6 §3.8 失败语义） */
const STATUS_LABEL: Record<string, [string, string]> = {
  queued: ['排队', ''], running: ['执行中', 'dlg-tag-run'], succeeded: ['成功', 'dlg-tag-ok'],
  failed: ['失败', 'dlg-tag-err'], failed_timeout: ['超时失败', 'dlg-tag-err'], cancelled: ['已取消', ''],
};
const FAIL_SEMANTICS: Array<[string, string]> = [
  ['rejected', '入口拒绝'],
  ['failed_capability', '能力不足'],
  ['failed_timeout', '超时'],
  ['failed_budget', '预算不足'],
  ['failed_runtime', '运行时异常'],
];
const TARGET_ICON: Record<string, string> = { builtin: '🪛', 'local-cli': '🌀', 'remote-agent': '🐙' };

const dur = (d: Delegation): string => {
  if (d.status === 'running' || d.status === 'queued') return '…';
  if (!d.started_at || !d.finished_at) return '—';
  const ms = new Date(d.finished_at).getTime() - new Date(d.started_at).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(0)}s`;
};

/** 委派页（LLD-6 §3.8 DSG-U03-8；E1-E6：副标题/Target 卡/注册向导/工具卡/失败语义/并发上限） */
export function DelegatePage() {
  const s = useDelegateStore();
  useEffect(() => {
    void s.init();
    const t = setInterval(() => void s.refresh(), 4000); // 运行态轮询
    return () => clearInterval(t);
  }, []);

  return (
    <div className="full-wrap">
      <div className="full-inner">
        {/* E1 副标题行 */}
        <h2>🤝 外部 Agent 委派</h2>
        <p className="set-note" style={{ marginTop: -6 }}>
          delegate_to_external_agent(&#123; target, task, execution, audit &#125;) · capability 路由 + 预算最低优先 ·
          缺能力不静默降级 · 全部不可用时回落 pi_native
        </p>

        {s.error && <div className="gate-box err" style={{ marginBottom: 10 }}>{s.error}</div>}
        {s.notice && <div className="op-result" style={{ marginBottom: 10 }}>{s.notice}</div>}

        {/* E2 Target 注册表卡 */}
        <div className="set-card">
          <h3>
            Target 注册表<span style={{ flex: 1 }} />
            <span className="set-note">并发上限 {s.concurrencyMax}（设置 → 系统设置可调）</span>
            <button className="act mini" onClick={() => s.toggleRegister(true)}>＋ 注册 target</button>
          </h3>
          {s.targets.length === 0 && <div className="empty-tip">暂无委派目标，先注册一个</div>}
          {s.targets.map((t) => (
            <TargetCard key={t.key} t={t} />
          ))}
        </div>

        {/* E4 委派记录表（耗时/成本/工具卡列） */}
        <div className="set-card">
          <h3>委派记录</h3>
          <table className="set-table">
            <thead>
              <tr><th>Target</th><th>任务</th><th>状态</th><th>耗时</th><th>成本</th><th>时间</th><th /></tr>
            </thead>
            <tbody>
              {s.delegations.map((d) => {
                const st = STATUS_LABEL[d.status] ?? [d.status, ''];
                return (
                  <tr key={d.id} className={s.selId === d.id ? 'dlg-sel' : ''}>
                    <td><code>{d.target}</code></td>
                    <td>{d.task_desc}</td>
                    <td><span className={`tag ${st[1]}`}>{st[0]}</span></td>
                    <td>{dur(d)}</td>
                    <td>{d.cost ?? '—'}</td>
                    <td className="set-note">{new Date(d.created_at).toLocaleString()}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="act mini" onClick={() => void s.select(d.id)}>工具卡</button>{' '}
                      {(d.status === 'queued' || d.status === 'running') && (
                        <button
                          className="act mini"
                          onClick={() => void s.act(() => delegateApi.cancel(s.projectId!, d.id), `已取消 ${d.code}`)}
                        >取消</button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {s.delegations.length === 0 && (
                <tr><td colSpan={7} className="set-note">暂无委派单</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* E5 失败语义卡 */}
        <div className="set-card">
          <h3>失败语义（五态）</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {FAIL_SEMANTICS.map(([k, label]) => (
              <span key={k} className="tag" style={{ padding: '5px 10px' }}>{k} · {label}</span>
            ))}
          </div>
          <p className="set-note" style={{ marginTop: 10 }}>
            每次委派均写入审计：谁发起 / 用了哪个 target / 传入摘要 / 产出摘要 / 成本。
          </p>
        </div>
      </div>

      {s.detail && <ToolCardModal d={s.detail} onClose={() => void s.select(null)} />}
      {s.showRegister && <RegisterWizard />}
      {s.showCreate && <CreateModal />}
    </div>
  );
}

/** E2 Target 卡：图标 + 名称 + 可用性 tag + 描述/延迟 + capability tags + 测试/发起委派 */
function TargetCard({ t }: { t: DelegationTarget }) {
  const s = useDelegateStore();
  const [testing, setTesting] = useState(false);
  return (
    <div className="model-card">
      <div className="mi">{TARGET_ICON[t.adapter_kind] ?? '🐙'}</div>
      <div className="mmain">
        <div className="mname">
          {t.name}{' '}
          {t.status === 'available'
            ? <span className="tag tag-ok">可用</span>
            : <span className="tag">{t.status === 'disabled' ? '停用' : '未配置'}</span>}
          {t.key === 'pi_native' && <span className="tag tag-ok">降级兑底</span>}
        </div>
        <div className="mdesc">
          {t.description ?? t.key} · {t.adapter_kind}
          {t.endpoint ? ` · ${t.endpoint}` : ''}
          {t.last_latency_ms !== null ? ` · 延迟 ${t.last_latency_ms}ms` : ''}
          {t.credential_ref ? ` · 凭据引用：${t.credential_ref}` : ''}
        </div>
        {t.capabilities.length > 0 && (
          <div className="mtags">{t.capabilities.map((c) => <span key={c} className="tag">{c}</span>)}</div>
        )}
      </div>
      <button
        className="act mini" disabled={testing}
        onClick={() => {
          setTesting(true);
          void (async () => {
            try {
              const r = await delegateApi.testTarget(t.key);
              toast(
                r.status === 'available'
                  ? `连通测试通过${r.latencyMs !== null ? ` · ${r.latencyMs}ms` : ''}`
                  : `连通失败：${r.detail ?? '请先在 manifest 中配置凭据'}`,
                r.status === 'available' ? 'success' : 'warn',
              );
            } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
            setTesting(false);
            await s.refresh();
          })();
        }}
      >{testing ? '测试中…' : '测试'}</button>
      <button
        className="act mini" disabled={t.status !== 'available'}
        title={t.status !== 'available' ? '未配置 target 不可委派' : ''}
        onClick={() => s.toggleCreate(true, t.key)}
      >发起委派</button>
    </div>
  );
}

/** E4 工具卡 modal：入参/执行/审计摘要 + 失败时「用 pi_native 重跑」（不静默降级，需确认） */
function ToolCardModal({ d, onClose }: { d: Delegation; onClose: () => void }) {
  const s = useDelegateStore();
  const st = STATUS_LABEL[d.status] ?? [d.status, ''];
  const failed = d.status === 'failed' || d.status === 'failed_timeout';
  const errMsg = (d.result as { error?: string } | null)?.error;
  return (
    <Modal title="委派工具卡" onClose={onClose}>
      <div className="toolcard">
        <div className="tc-head">🤝 delegate_to_external_agent · {d.target}</div>
        <div className="tc-body">
          task: {d.task_desc}<br />
          execution: &#123; budget: {d.budget_limit ? `$${d.budget_limit}` : '"$0.50"'}, timeout: "10m", sandbox: true &#125;<br />
          audit: &#123; 发起人: {d.created_by}, 证据行: {d.evidence_ids.length ? d.evidence_ids.map((i) => `evd#${i}`).join('，') : '—'}, 成本: {d.cost ?? '—'} &#125;<br />
          结果：<span className={`tag ${st[1]}`}>{st[0]}</span> · {dur(d)}
          {errMsg && <><br /><span style={{ color: 'var(--red)' }}>error: {errMsg}</span></>}
        </div>
      </div>
      {d.result && Object.keys(d.result).some((k) => k !== 'error') && (
        <pre className="dlg-result">{JSON.stringify(d.result, null, 2)}</pre>
      )}
      {failed && (
        <p style={{ marginTop: 10, fontSize: 13 }}>
          ⚠ 已按策略提示降级选项：改用 pi_native 重跑（不静默降级，需确认）。
          <button
            className="act mini" style={{ marginLeft: 8 }}
            onClick={() => {
              if (window.confirm(`用 pi_native 重跑「${d.task_desc}」？（不静默降级：将新建一张委派单）`)) {
                void s.act(async () => {
                  await delegateApi.create(s.projectId!, {
                    target: 'pi_native', taskDesc: d.task_desc,
                    ...(d.budget_limit ? { budgetLimit: Number(d.budget_limit) } : {}),
                  });
                  onClose();
                }, '已用 pi_native 重新排队');
              }
            }}
          >用 pi_native 重跑</button>
        </p>
      )}
    </Modal>
  );
}

/** E3 注册向导：名称/类型/端点/凭据引用（引用设置中已存凭据）+ 保存前测试连通（失败不入册） */
function RegisterWizard() {
  const s = useDelegateStore();
  const [form, setForm] = useState({
    key: '', name: '', adapterKind: 'local-cli', endpoint: '', credentialRef: '',
    capabilities: '', description: '',
  });
  const [credentials, setCredentials] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<DraftTestResult | null>(null);

  useEffect(() => {
    // 凭据引用候选 = 设置页模型注册表（密钥只写不读，引用按名称）
    void platformApi.models().then((ms) => setCredentials(ms.map((m) => m.name))).catch(() => undefined);
  }, []);

  const dirty = () => setTested(null); // 任何字段修改后须重新测试
  const canSave = form.key.trim() && form.name.trim() && tested?.ok === true;

  return (
    <Modal
      title="注册委派目标" onClose={() => s.toggleRegister(false)}
      footer={(
        <>
          <button
            className="act" disabled={testing}
            onClick={() => {
              setTesting(true);
              void (async () => {
                try {
                  const r = await delegateApi.testDraft({
                    adapterKind: form.adapterKind,
                    ...(form.endpoint.trim() ? { endpoint: form.endpoint.trim() } : {}),
                  });
                  setTested(r);
                  toast(r.ok ? `连通测试通过 · ${r.latencyMs}ms` : `连通失败：${r.detail}`, r.ok ? 'success' : 'warn');
                } catch (e) {
                  setTested({ ok: false, detail: e instanceof ApiError ? e.message : String(e), latencyMs: 0 });
                }
                setTesting(false);
              })();
            }}
          >{testing ? '测试中…' : '测试连通'}</button>
          <button className="act" onClick={() => s.toggleRegister(false)}>取消</button>
          <button
            className="act primary" disabled={!canSave}
            title={!tested?.ok ? '保存前须测试连通通过（失败不入册）' : ''}
            onClick={() => void s.act(async () => {
              await delegateApi.upsertTarget({
                key: form.key.trim(), name: form.name.trim(), adapterKind: form.adapterKind,
                ...(form.endpoint.trim() ? { endpoint: form.endpoint.trim() } : {}),
                ...(form.credentialRef ? { credentialRef: form.credentialRef } : {}),
                capabilities: form.capabilities.split(',').map((x) => x.trim()).filter(Boolean),
                ...(form.description.trim() ? { description: form.description.trim() } : {}),
                status: 'available',
              });
              s.toggleRegister(false);
            }, `目标 ${form.key} 已注册`)}
          >注册</button>
        </>
      )}
    >
      <div className="set-form-grid" style={{ gridTemplateColumns: '150px 1fr' }}>
        <label>标识 key（唯一）</label>
        <input value={form.key} onChange={(e) => { setForm({ ...form, key: e.target.value }); dirty(); }} placeholder="例：codex_cli" />
        <label>名称</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <label>类型（适配器）</label>
        <select
          value={form.adapterKind}
          onChange={(e) => { setForm({ ...form, adapterKind: e.target.value }); dirty(); }}
        >
          <option value="local-cli">本机 CLI（local-cli）</option>
          <option value="remote-agent">远程代理（remote-agent）</option>
          <option value="builtin">内建（builtin）</option>
        </select>
        <label>端点</label>
        <input
          value={form.endpoint}
          onChange={(e) => { setForm({ ...form, endpoint: e.target.value }); dirty(); }}
          placeholder={form.adapterKind === 'remote-agent' ? 'https://…（连接地址）' : '可执行名（如 claude）/本机启动方式'}
        />
        <label>凭据引用</label>
        <select value={form.credentialRef} onChange={(e) => setForm({ ...form, credentialRef: e.target.value })}>
          <option value="">（不引用）</option>
          {credentials.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label>能力（逗号分隔）</label>
        <input value={form.capabilities} onChange={(e) => setForm({ ...form, capabilities: e.target.value })} placeholder="code, review, extract" />
        <label>描述</label>
        <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <p className="set-note" style={{ marginTop: 8 }}>
        凭据一律引用设置页已存凭据，不内嵌明文（DSG-U06-18）；保存前须「测试连通」通过，失败不入册。
      </p>
      {tested && !tested.ok && (
        <div className="gate-box err" style={{ marginTop: 8 }}>连通失败：{tested.detail}（不入册）</div>
      )}
    </Modal>
  );
}

/** 发起委派 modal（任务描述 + 预算上限） */
function CreateModal() {
  const s = useDelegateStore();
  const [form, setForm] = useState({ target: s.createTarget ?? 'pi_native', taskDesc: '', budgetLimit: '$0.50' });
  const available = s.targets.filter((t) => t.status === 'available');
  return (
    <Modal
      title={`发起委派 · ${form.target}`} onClose={() => s.toggleCreate(false)}
      footer={(
        <>
          <button className="act" onClick={() => s.toggleCreate(false)}>取消</button>
          <button
            className="act primary" disabled={!form.taskDesc.trim()}
            onClick={() => void s.act(async () => {
              await delegateApi.create(s.projectId!, {
                target: form.target, taskDesc: form.taskDesc.trim(),
                budgetLimit: Number(form.budgetLimit.replace('$', '')) || 0.5,
              });
              s.toggleCreate(false);
            }, '委派已提交，执行中…')}
          >提交委派</button>
        </>
      )}
    >
      <div className="set-form-grid" style={{ gridTemplateColumns: '110px 1fr' }}>
        <label>目标</label>
        <select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
          {available.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
        </select>
        <label>任务描述</label>
        <textarea
          rows={3} style={{ width: '100%' }} value={form.taskDesc}
          onChange={(e) => setForm({ ...form, taskDesc: e.target.value })}
          placeholder="例：抽取招标文件附录 B 的设备清单表格"
        />
        <label>预算上限</label>
        <select value={form.budgetLimit} onChange={(e) => setForm({ ...form, budgetLimit: e.target.value })}>
          <option>$0.50</option><option>$1.00</option><option>$5.00</option>
        </select>
      </div>
      <p className="set-note" style={{ marginTop: 8 }}>
        并发上限 {s.concurrencyMax}：超限将在提交时提示（RATE_LIMITED），可稍后重试或到设置页调整。
      </p>
    </Modal>
  );
}
