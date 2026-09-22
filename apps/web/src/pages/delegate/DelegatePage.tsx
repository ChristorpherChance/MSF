import { useEffect, useState } from 'react';
import { useDelegateStore } from './store';
import { delegateApi } from './api';
import './delegate.css';

const STATUS_LABEL: Record<string, string> = {
  queued: '排队', running: '运行中', succeeded: '成功',
  failed: '失败', failed_timeout: '超时失败', cancelled: '已取消',
};

/** 委派页（LLD-6 §3.8：注册向导 / 五态+超时态表 / 详情卡） */
export function DelegatePage() {
  const s = useDelegateStore();
  useEffect(() => {
    void s.init();
    const t = setInterval(() => void s.refresh(), 4000); // 运行态轮询
    return () => clearInterval(t);
  }, []);

  return (
    <main className="proto-wrap">
      <div className="doc-toolbar">
        <strong>委派执行</strong>
        <span className="dsg-prefix">并发上限 {s.concurrencyMax}</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => s.toggleRegister(true)}>注册目标</button>
        <button
          onClick={() => s.toggleCreate(true)}
          disabled={!s.targets.some((t) => t.status === 'available')}
        >
          发起委派
        </button>
      </div>

      {s.error && <div className="dlg-banner dlg-banner-err">{s.error}</div>}
      {s.notice && <div className="dlg-banner">{s.notice}</div>}

      <section className="dlg-targets">
        <h3>委派目标</h3>
        <div className="dlg-target-grid">
          {s.targets.map((t) => (
            <div key={t.key} className="dlg-target-card">
              <div>
                <strong>{t.name}</strong>
                <span className={`dlg-tag dlg-ts-${t.status}`}>
                  {t.status === 'available' ? '可用' : t.status === 'disabled' ? '停用' : '未配置'}
                </span>
              </div>
              <div className="dlg-mut">{t.key} · {t.adapter_kind}</div>
              {t.description && <div className="dlg-mut">{t.description}</div>}
              <div className="dlg-mut">能力：{t.capabilities.join(' / ') || '—'}</div>
              <button
                onClick={() => void s.act(
                  async () => {
                    const r = await delegateApi.testTarget(t.key);
                    if (r.status !== 'available') throw new Error(r.detail ?? '连通失败');
                  },
                  `目标 ${t.key} 连通可用`,
                )}
              >
                测试连通
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>委派单</h3>
        <table className="dlg-table">
          <thead>
            <tr><th>编号</th><th>目标</th><th>任务</th><th>状态</th><th>成本</th><th>发起时间</th><th /></tr>
          </thead>
          <tbody>
            {s.delegations.map((d) => (
              <tr key={d.id} className={s.selId === d.id ? 'sel' : ''} onClick={() => void s.select(d.id)}>
                <td>{d.code}</td>
                <td>{d.target}</td>
                <td className="dlg-task">{d.task_desc}</td>
                <td><span className={`dlg-tag dlg-ds-${d.status}`}>{STATUS_LABEL[d.status] ?? d.status}</span></td>
                <td>{d.cost ?? '—'}</td>
                <td>{new Date(d.created_at).toLocaleString()}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {(d.status === 'queued' || d.status === 'running') && (
                    <button onClick={() => void s.act(() => delegateApi.cancel(s.projectId!, d.id), `已取消 ${d.code}`)}>
                      取消
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {s.delegations.length === 0 && (
              <tr><td colSpan={7} className="dlg-mut">暂无委派单</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {s.detail && (
        <div className="dlg-modal-mask" onClick={() => void s.select(null)}>
          <div className="dlg-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{s.detail.code} · {STATUS_LABEL[s.detail.status]}</h3>
            <p><b>目标：</b>{s.detail.target}　<b>任务：</b>{s.detail.task_desc}</p>
            {s.detail.result && (
              <pre className="dlg-result">{JSON.stringify(s.detail.result, null, 2)}</pre>
            )}
            <p className="dlg-mut">
              证据行：{s.detail.evidence_ids.length ? s.detail.evidence_ids.map((i) => `evd#${i}`).join('，') : '—'}
              　开始：{s.detail.started_at ? new Date(s.detail.started_at).toLocaleString() : '—'}
              　结束：{s.detail.finished_at ? new Date(s.detail.finished_at).toLocaleString() : '—'}
            </p>
            <button onClick={() => void s.select(null)}>关闭</button>
          </div>
        </div>
      )}

      {s.showRegister && <RegisterModal />}
      {s.showCreate && <CreateModal />}
    </main>
  );
}

function RegisterModal() {
  const s = useDelegateStore();
  const [form, setForm] = useState({
    key: '', name: '', adapterKind: 'local-cli', description: '', capabilities: '', config: '{}',
  });
  return (
    <div className="dlg-modal-mask" onClick={() => s.toggleRegister(false)}>
      <div className="dlg-modal" onClick={(e) => e.stopPropagation()}>
        <h3>注册委派目标</h3>
        {(
          [
            ['key', '标识 key（唯一）'], ['name', '名称'], ['description', '描述'],
            ['capabilities', '能力（逗号分隔）'], ['config', '配置 JSON（key/secret/token 字段加密存储）'],
          ] as const
        ).map(([k, label]) => (
          <label key={k} className="dlg-field">
            <span>{label}</span>
            <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
          </label>
        ))}
        <label className="dlg-field">
          <span>适配器类型</span>
          <select value={form.adapterKind} onChange={(e) => setForm({ ...form, adapterKind: e.target.value })}>
            <option value="local-cli">本机 CLI</option>
            <option value="remote-agent">远程代理</option>
            <option value="builtin">内建</option>
          </select>
        </label>
        <div className="dlg-actions">
          <button onClick={() => s.toggleRegister(false)}>取消</button>
          <button
            onClick={() => void s.act(async () => {
              await delegateApi.upsertTarget(useDelegateStore.getState().projectId!, {
                key: form.key, name: form.name, adapterKind: form.adapterKind,
                description: form.description || undefined,
                capabilities: form.capabilities.split(',').map((x) => x.trim()).filter(Boolean),
                config: JSON.parse(form.config || '{}'),
              });
              s.toggleRegister(false);
            }, '目标已注册')}
          >
            注册
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateModal() {
  const s = useDelegateStore();
  const [form, setForm] = useState({ target: 'pi_native', taskDesc: '', budgetLimit: '' });
  const available = s.targets.filter((t) => t.status === 'available');
  return (
    <div className="dlg-modal-mask" onClick={() => s.toggleCreate(false)}>
      <div className="dlg-modal" onClick={(e) => e.stopPropagation()}>
        <h3>发起委派</h3>
        <label className="dlg-field">
          <span>目标</span>
          <select value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
            {available.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}
          </select>
        </label>
        <label className="dlg-field">
          <span>任务描述</span>
          <textarea value={form.taskDesc} onChange={(e) => setForm({ ...form, taskDesc: e.target.value })} rows={4} />
        </label>
        <label className="dlg-field">
          <span>预算上限（可选）</span>
          <input value={form.budgetLimit} onChange={(e) => setForm({ ...form, budgetLimit: e.target.value })} />
        </label>
        <div className="dlg-actions">
          <button onClick={() => s.toggleCreate(false)}>取消</button>
          <button
            disabled={!form.taskDesc.trim()}
            onClick={() => void s.act(async () => {
              await delegateApi.create(s.projectId!, {
                target: form.target, taskDesc: form.taskDesc,
                ...(form.budgetLimit ? { budgetLimit: Number(form.budgetLimit) } : {}),
              });
              s.toggleCreate(false);
            }, '委派已创建（queued）')}
          >
            发起
          </button>
        </div>
      </div>
    </div>
  );
}
