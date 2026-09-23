import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { useSession } from '../../store';
import {
  platformApi,
  PURPOSE_NAMES,
  PURPOSES,
  type GateRow,
  type ModelPublic,
  type Notice,
} from './api';

const PROVIDERS = ['gateway', 'anthropic', 'openai'];

/**
 * 设置页（T7-07/08/10；U03-9、U06-17、F10-1/2）：
 * 模型注册表（密钥只写不读，掩码回显）/ 用途路由五槽 / 放行策略七确认点 / 通用设置 / 备份导出
 */
export function SettingsPage() {
  const projectId = useSession((s) => s.projectId);
  const [models, setModels] = useState<ModelPublic[]>([]);
  const [routes, setRoutes] = useState<Record<string, { modelId: string; modelName: string } | null>>({});
  const [gates, setGates] = useState<GateRow[]>([]);
  const [gateEvents, setGateEvents] = useState<Array<{ gate_key: string; from_mode: string; to_mode: string; reason: string; created_at: string }>>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [lastBackup, setLastBackup] = useState<Notice | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 模型表单（新建/编辑共用；apiKey 只写不读，留空=保留）
  const blank = { id: '', name: '', provider: 'gateway', baseUrl: '', modelCode: '', apiKey: '', contextWindow: 128000, supportsThinking: false, enabled: true };
  const [form, setForm] = useState({ ...blank });
  const editing = Boolean(form.id);

  // 通用设置编辑
  const [setKey, setSetKey] = useState('');
  const [setVal, setSetVal] = useState('');

  const flash = (m: string) => { setMsg(m); setErr(null); };
  const fail = (e: unknown) => { setErr(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e)); setMsg(null); };

  const refresh = useCallback(async () => {
    try {
      const [m, r, s, n] = await Promise.all([
        platformApi.models(),
        platformApi.routes(),
        platformApi.settings(),
        platformApi.notifications('?limit=10'),
      ]);
      setModels(m);
      setRoutes(r);
      setSettings(s);
      setLastBackup(n.items.find((x) => x.type === 'backup.completed') ?? null);
      if (projectId) {
        const g = await platformApi.gates(projectId);
        setGates(g.gates);
        setGateEvents(g.events);
      }
      setErr(null);
    } catch (e) { fail(e); }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const saveModel = async () => {
    try {
      const body: Record<string, unknown> = {
        name: form.name, provider: form.provider, baseUrl: form.baseUrl,
        modelCode: form.modelCode, contextWindow: Number(form.contextWindow),
        supportsThinking: form.supportsThinking, enabled: form.enabled,
      };
      if (form.id) body.id = form.id;
      if (form.apiKey) body.apiKey = form.apiKey; // 只写不读：留空则保留
      await platformApi.upsertModel(body);
      setForm({ ...blank });
      flash(editing ? '模型已更新' : '模型已注册');
      await refresh();
    } catch (e) { fail(e); }
  };

  const testModel = async (id: string) => {
    try {
      const r = await platformApi.testModel(id);
      flash(r.connStatus === 'ok' ? '连通自检通过' : `连通失败：${r.detail}`);
      await refresh();
    } catch (e) { fail(e); }
  };

  const toggleModel = async (m: ModelPublic) => {
    try {
      await platformApi.upsertModel({ id: m.id, enabled: !m.enabled });
      await refresh();
    } catch (e) { fail(e); }
  };

  const setRoute = async (purpose: string, modelId: string) => {
    try {
      await platformApi.setRoute(purpose, modelId || null);
      await refresh();
    } catch (e) { fail(e); }
  };

  const switchGate = async (g: GateRow) => {
    const to = g.mode === 'manual' ? 'auto' : 'manual';
    const reason = window.prompt(`切换「${g.gateKey}」为 ${to} 的授权理由（必填留痕）：`);
    if (!reason?.trim()) return;
    try {
      await platformApi.setGateMode(projectId!, g.gateKey, to, reason.trim());
      flash(`「${g.gateKey}」已切换为 ${to}`);
      await refresh();
    } catch (e) { fail(e); }
  };

  const saveSetting = async () => {
    if (!setKey.trim()) return;
    let value: unknown = setVal;
    try { value = JSON.parse(setVal); } catch { /* 纯字符串 */ }
    try {
      await platformApi.putSettings({ [setKey.trim()]: value });
      setSetKey(''); setSetVal('');
      flash('设置已保存');
      await refresh();
    } catch (e) { fail(e); }
  };

  const exportBackup = async () => {
    if (!projectId) return;
    try {
      const r = await platformApi.backupExport(projectId);
      flash(`备份导出已受理（${r.operationId}），完成后通知内含签名下载链接`);
      setTimeout(() => void refresh(), 3000);
    } catch (e) { fail(e); }
  };

  const card: React.CSSProperties = { border: '1px solid var(--msf-line, #e2e2e2)', borderRadius: 8, padding: 16, marginBottom: 20 };

  return (
    <div style={{ padding: 20, maxWidth: 960 }}>
      <h2>设置</h2>
      {msg && <p style={{ color: 'var(--msf-ok, #1e8e3e)' }}>{msg}</p>}
      {err && <p style={{ color: 'var(--msf-danger, #c0392b)' }}>{err}</p>}

      {/* T7-07 模型注册表 + 用途路由 */}
      <section style={card}>
        <h3>模型注册表</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#888' }}>
              <th>名称</th><th>提供方</th><th>模型标识</th><th>密钥</th><th>连通</th><th>用途路由</th><th>状态</th><th />
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id} style={{ borderTop: '1px solid #eee' }}>
                <td>{m.name}</td>
                <td>{m.provider}</td>
                <td><code>{m.model_code}</code></td>
                <td>{m.api_key_hint ?? '—'}</td>
                <td style={{ color: m.conn_status === 'ok' ? '#1e8e3e' : m.conn_status === 'fail' ? '#c0392b' : '#888' }}>
                  {m.conn_status === 'ok' ? '正常' : m.conn_status === 'fail' ? '失败' : '未测'}
                </td>
                <td>{(m.routes ?? []).map((r) => PURPOSE_NAMES[r] ?? r).join('、') || '—'}</td>
                <td>{m.enabled ? '启用' : '停用'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => void testModel(m.id)}>自检</button>{' '}
                  <button onClick={() => setForm({
                    id: m.id, name: m.name, provider: m.provider, baseUrl: m.base_url,
                    modelCode: m.model_code, apiKey: '', contextWindow: m.context_window,
                    supportsThinking: m.supports_thinking, enabled: m.enabled,
                  })}>编辑</button>{' '}
                  <button onClick={() => void toggleModel(m)}>{m.enabled ? '停用' : '启用'}</button>
                </td>
              </tr>
            ))}
            {models.length === 0 && <tr><td colSpan={8} style={{ color: '#888' }}>暂无模型，先注册一个</td></tr>}
          </tbody>
        </table>

        <h4 style={{ marginTop: 16 }}>{editing ? `编辑模型（密钥留空=保留 ${models.find((m) => m.id === form.id)?.api_key_hint ?? ''}）` : '注册新模型'}</h4>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, maxWidth: 720 }}>
          <input placeholder="名称（如 gw-gpt-5.5）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <input placeholder="模型标识（如 gpt-5.5）" value={form.modelCode} onChange={(e) => setForm({ ...form, modelCode: e.target.value })} />
          <input placeholder="baseUrl（网关地址）" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} style={{ gridColumn: 'span 2' }} />
          <input type="password" placeholder={editing ? 'API Key（只写不读，留空保留）' : 'API Key（只写不读）'} value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <label style={{ fontSize: 13 }}>
            上下文窗口 <input type="number" style={{ width: 100 }} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) })} />
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={form.supportsThinking} onChange={(e) => setForm({ ...form, supportsThinking: e.target.checked })} /> 支持思考强度
          </label>
          <label style={{ fontSize: 13 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> 启用
          </label>
        </div>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void saveModel()} disabled={!form.name.trim() || !form.modelCode.trim() || (!editing && !form.baseUrl.trim())}>
            {editing ? '保存修改' : '注册模型'}
          </button>{' '}
          {editing && <button onClick={() => setForm({ ...blank })}>取消编辑</button>}
        </div>

        <h4 style={{ marginTop: 16 }}>用途路由</h4>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          {PURPOSES.map((p) => (
            <label key={p} style={{ fontSize: 13 }}>
              {PURPOSE_NAMES[p]}{' '}
              <select
                value={routes[p]?.modelId ?? ''}
                onChange={(e) => void setRoute(p, e.target.value)}
              >
                <option value="">（未配置）</option>
                {models.filter((m) => m.enabled).map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>

      {/* T7-08 放行策略 */}
      <section style={card}>
        <h3>放行策略（七确认点）</h3>
        {!projectId && <p style={{ color: '#888' }}>请先在项目页进入一个项目。</p>}
        {projectId && (
          <>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {gates.map((g) => (
                  <tr key={g.gateKey} style={{ borderTop: '1px solid #eee' }}>
                    <td><code>{g.gateKey}</code></td>
                    <td style={{ color: g.mode === 'auto' ? '#b26a00' : '#1e8e3e' }}>
                      {g.mode === 'auto' ? '自动放行' : '人工确认'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button onClick={() => void switchGate(g)}>
                        切换为 {g.mode === 'manual' ? '自动放行' : '人工确认'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: '#888' }}>
              切换授权需填写理由并留痕（F10-2）；自动放行后任意人工动作立回阻断态（BR-07）。
            </p>
            {gateEvents.length > 0 && (
              <details>
                <summary style={{ fontSize: 13 }}>最近切换记录（{gateEvents.length}）</summary>
                <ul style={{ fontSize: 12 }}>
                  {gateEvents.map((e, i) => (
                    <li key={i}>{e.created_at.slice(0, 19)} {e.gate_key}：{e.from_mode} → {e.to_mode}（{e.reason}）</li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {/* T7-10 备份导出 */}
      <section style={card}>
        <h3>备份导出</h3>
        <p style={{ fontSize: 13, color: '#666' }}>
          项目数据逻辑导出（PG 全量表 + MinIO 工件清单 + 每表 SHA-256 清单），完成后站内通知附签名下载链接（1 小时有效）。密钥类列不导出。
        </p>
        <button onClick={() => void exportBackup()} disabled={!projectId}>导出当前项目备份</button>
        {lastBackup && (
          <p style={{ fontSize: 12, marginTop: 8 }}>
            最近一次：{lastBackup.text.slice(0, 120)}…{' '}
            {/https?:\/\/\S+/.exec(lastBackup.text) && (
              <a href={/https?:\/\/\S+/.exec(lastBackup.text)![0]} target="_blank" rel="noreferrer">下载</a>
            )}
          </p>
        )}
      </section>

      {/* A10-1 通用设置 */}
      <section style={card}>
        <h3>通用设置</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {Object.entries(settings).map(([k, v]) => (
              <tr key={k} style={{ borderTop: '1px solid #eee' }}>
                <td><code>{k}</code></td>
                <td><code>{JSON.stringify(v)}</code></td>
              </tr>
            ))}
            {Object.keys(settings).length === 0 && <tr><td style={{ color: '#888' }}>暂无设置项</td></tr>}
          </tbody>
        </table>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input placeholder="键（点分层级，如 zip.limits.maxEntries）" value={setKey} onChange={(e) => setSetKey(e.target.value)} style={{ flex: 1 }} />
          <input placeholder='值（JSON 或字符串）' value={setVal} onChange={(e) => setSetVal(e.target.value)} style={{ flex: 1 }} />
          <button onClick={() => void saveSetting()} disabled={!setKey.trim()}>保存</button>
        </div>
        <p style={{ fontSize: 12, color: '#888' }}>密钥类不落此表（走模型注册表加密存储，REQ-710）。</p>
      </section>
    </div>
  );
}
