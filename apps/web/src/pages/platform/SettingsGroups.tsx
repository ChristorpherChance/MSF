import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { useSession } from '../../store';
import {
  platformApi,
  PURPOSE_NAMES,
  PURPOSES,
  type AuditItem,
  type BackupRow,
  type GateRow,
  type ModelPublic,
} from './api';

const run = async (fn: () => Promise<unknown>, okMsg: string, after?: () => void) => {
  try { await fn(); toast(okMsg, 'success'); after?.(); }
  catch (e) { toast(e instanceof ApiError ? `${e.code}: ${e.message}` : String(e), 'warn'); }
};

const PROVIDER_OPTIONS = ['Ollama（本地）', 'DeepSeek', '阿里云百炼 / Qwen', 'OpenAI 兼容代理', 'Anthropic 兼容代理', 'gateway'];
const CONN_LABEL: Record<string, [string, string]> = {
  ok: ['已连通', 'tag-ok'], fail: ['连接失败', 'tag-warn'], untested: ['未测试', ''], testing: ['测试中…', 'tag-ok'],
};

/** C4 模型配置组：连通四态 tag + 对话默认 + 思考强度标记 + 测试连通/编辑/启停 + 添加/编辑 modal */
export function ModelsGroup() {
  const [models, setModels] = useState<ModelPublic[]>([]);
  const [routes, setRoutes] = useState<Record<string, { modelId: string; modelName: string } | null>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<ModelPublic | 'new' | null>(null);

  const load = useCallback(async () => {
    const [m, r] = await Promise.all([
      platformApi.models().catch(() => [] as ModelPublic[]),
      platformApi.routes().catch(() => ({} as Record<string, { modelId: string; modelName: string } | null>)),
    ]);
    setModels(m); setRoutes(r);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const test = (m: ModelPublic) => {
    setTesting(m.id);
    void (async () => {
      try {
        const r = await platformApi.testModel(m.id);
        toast(r.connStatus === 'ok' ? `${m.name} 连通成功` : `${m.name} 连接失败：${r.detail}`, r.connStatus === 'ok' ? 'success' : 'warn');
      } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
      setTesting(null);
      await load();
    })();
  };

  const chatDefault = routes['chat']?.modelId ?? null;

  return (
    <div className="set-card">
      <h3>
        模型列表（pi-ai 统一接入）<span style={{ flex: 1 }} />
        <button className="act primary" onClick={() => setEditing('new')}>＋ 添加模型</button>
      </h3>
      <p className="set-note" style={{ marginBottom: 12 }}>
        可同时启用多个模型；仅「启用 + 已连通」的模型会出现在对话框右下角的模型选择器中。
      </p>
      {models.length === 0 && <div className="empty-tip">暂无模型，先注册一个</div>}
      {models.map((m) => {
        const conn = testing === m.id ? CONN_LABEL['testing']! : (CONN_LABEL[m.conn_status] ?? CONN_LABEL['untested']!);
        return (
          <div key={m.id} className="model-card">
            <div className="mi">🧩</div>
            <div className="mmain">
              <div className="mname">
                {m.name} <span className={`tag ${conn[1]}`}>{conn[0]}</span>
                {m.id === chatDefault && <span className="tag tag-ok">对话默认</span>}
                <span className={`tag ${m.supports_thinking ? 'tag-ok' : ''}`} title="是否支持思考强度（推理参数）档位切换">
                  {m.supports_thinking ? '思考强度 ✓' : '无思考强度'}
                </span>
              </div>
              <div className="mdesc">
                {m.provider} · {m.base_url} · key: {m.api_key_hint ?? '—'} · 窗口 {m.context_window.toLocaleString()} tokens
                {m.routes.length > 0 && <> · 用途：{m.routes.map((r) => PURPOSE_NAMES[r] ?? r).join('、')}</>}
              </div>
            </div>
            <button className="act mini" disabled={testing !== null} onClick={() => test(m)}>测试连通</button>
            <button className="act mini" onClick={() => setEditing(m)}>编辑</button>
            <button
              className={`switch${m.enabled ? ' on' : ''}`} title="启用/停用"
              onClick={() => void run(() => platformApi.upsertModel({ id: m.id, enabled: !m.enabled }),
                m.enabled ? '已停用' : '已启用', () => void load())}
            />
          </div>
        );
      })}

      <h4 style={{ margin: '16px 0 8px' }}>用途路由</h4>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {PURPOSES.map((p) => (
          <label key={p} style={{ fontSize: 13 }}>
            {PURPOSE_NAMES[p]}{' '}
            <select
              value={routes[p]?.modelId ?? ''}
              onChange={(e) => void run(() => platformApi.setRoute(p, e.target.value || null), '路由已更新', () => void load())}
            >
              <option value="">（未配置）</option>
              {models.filter((m) => m.enabled).map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
        ))}
      </div>

      {editing && (
        <ModelModal
          model={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

/** 添加/编辑模型 modal（密钥只写不读，留空=保留；保存后连通状态回退「未测试」） */
function ModelModal({ model, onClose, onSaved }: { model: ModelPublic | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: model?.name ?? '', provider: model?.provider ?? PROVIDER_OPTIONS[0]!,
    baseUrl: model?.base_url ?? '', modelCode: model?.model_code ?? '',
    apiKey: '', contextWindow: model?.context_window ?? 32768,
    supportsThinking: model?.supports_thinking ?? false, enabled: model?.enabled ?? true,
  });
  const canSave = form.name.trim() && form.modelCode.trim() && (model ? true : form.baseUrl.trim());
  return (
    <Modal
      title={model ? '编辑模型' : '添加模型'} onClose={onClose}
      footer={(
        <>
          <button className="act" onClick={onClose}>取消</button>
          <button
            className="act primary" disabled={!canSave}
            onClick={() => void run(async () => {
              const body: Record<string, unknown> = {
                name: form.name.trim(), provider: form.provider, baseUrl: form.baseUrl.trim(),
                modelCode: form.modelCode.trim(), contextWindow: Number(form.contextWindow) || 32768,
                supportsThinking: form.supportsThinking, enabled: form.enabled,
              };
              if (model) body.id = model.id;
              if (form.apiKey) body.apiKey = form.apiKey; // 只写不读：留空则保留
              await platformApi.upsertModel(body);
              onSaved();
            }, model ? '已保存，请重新测试连通' : '已添加，请测试连通')}
          >{model ? '保存' : '添加'}</button>
        </>
      )}
    >
      <div className="set-form-grid" style={{ gridTemplateColumns: '150px 1fr' }}>
        {!model && (<><label>供应商类型（pi-ai provider）</label>
          <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
            {PROVIDER_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select></>)}
        <label>名称</label>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例：deepseek-chat / qwen3-max" />
        <label>模型标识</label>
        <input value={form.modelCode} onChange={(e) => setForm({ ...form, modelCode: e.target.value })} placeholder="供应商模型标识" />
        <label>Base URL</label>
        <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="http(s)://…" />
        <label>API Key{model ? `（只写不读，留空=保留 ${model.api_key_hint ?? ''}）` : '（本地 Ollama 可留空）'}</label>
        <input type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        <label>支持思考强度</label>
        <select
          value={form.supportsThinking ? '1' : '0'}
          onChange={(e) => setForm({ ...form, supportsThinking: e.target.value === '1' })}
        >
          <option value="1">支持（对话面板可切 低/中/高）</option>
          <option value="0">不支持（控件置灰提示）</option>
        </select>
        <label>上下文窗口（tokens）</label>
        <input
          type="number" value={form.contextWindow}
          onChange={(e) => setForm({ ...form, contextWindow: Number(e.target.value) || 32768 })}
        />
      </div>
    </Modal>
  );
}

/** C5 放行策略组：七确认点 manual/auto + 前置条件编辑 + 理由 modal + 最近切换留痕（切换通知项目成员由后端落通知） */
export function PolicyGroup() {
  const projectId = useSession((s) => s.projectId);
  const [gates, setGates] = useState<GateRow[]>([]);
  const [events, setEvents] = useState<Array<{ gate_key: string; from_mode: string; to_mode: string; reason: string; created_at: string }>>([]);
  const [switching, setSwitching] = useState<GateRow | null>(null);
  const [reason, setReason] = useState('');
  const [condFor, setCondFor] = useState<string | null>(null);
  const [condText, setCondText] = useState('');

  const load = useCallback(async () => {
    if (!projectId) return;
    const g = await platformApi.gates(projectId).catch(() => null);
    if (g) { setGates(g.gates); setEvents(g.events); }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  if (!projectId) return <div className="set-card"><p className="set-note">请先在项目页进入一个项目。</p></div>;

  return (
    <div className="set-card">
      <h3>放行策略（七确认点）</h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        切换授权需填写理由并留痕（F10-2），切换本身为 manual 命令并通知项目成员；
        自动放行后任意人工动作立回阻断态（BR-07）。前置条件为 auto 放行的前置声明（本期为配置面，求值消费后置）。
      </p>
      <table className="set-table">
        <thead><tr><th>确认点</th><th style={{ width: 110 }}>模式</th><th>前置条件</th><th style={{ width: 190 }}>操作</th></tr></thead>
        <tbody>
          {gates.map((g) => (
            <tr key={g.gateKey}>
              <td><code>{g.gateKey}</code></td>
              <td>
                <span className={`tag ${g.mode === 'auto' ? 'tag-warn' : 'tag-ok'}`}>
                  {g.mode === 'auto' ? '自动放行' : '人工确认'}
                </span>
              </td>
              <td className="set-note">{g.preconditions.length ? g.preconditions.join('；') : '—'}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="act mini" onClick={() => { setSwitching(g); setReason(''); }}>
                  切换为{g.mode === 'manual' ? '自动放行' : '人工确认'}
                </button>{' '}
                <button
                  className="act mini"
                  onClick={() => { setCondFor(g.gateKey); setCondText(g.preconditions.join('\n')); }}
                >前置条件</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 13, cursor: 'pointer' }}>最近切换记录（{events.length}）</summary>
          <ul style={{ fontSize: 12, color: 'var(--ink2)' }}>
            {events.map((e, i) => (
              <li key={i}>{e.created_at.slice(0, 19).replace('T', ' ')} {e.gate_key}：{e.from_mode} → {e.to_mode}（{e.reason}）</li>
            ))}
          </ul>
        </details>
      )}

      {switching && (
        <Modal
          title={`切换「${switching.gateKey}」为 ${switching.mode === 'manual' ? '自动放行' : '人工确认'}`}
          onClose={() => setSwitching(null)}
          footer={(
            <>
              <button className="act" onClick={() => setSwitching(null)}>取消</button>
              <button
                className="act primary" disabled={!reason.trim()}
                onClick={() => void run(async () => {
                  await platformApi.setGateMode(projectId, switching.gateKey,
                    switching.mode === 'manual' ? 'auto' : 'manual', reason.trim());
                  setSwitching(null);
                }, '已切换，项目成员将收到通知', () => void load())}
              >确认切换</button>
            </>
          )}
        >
          <p className="set-note">切换授权理由（必填留痕，通知项目成员）：</p>
          <textarea
            style={{ width: '100%', minHeight: 70 }} value={reason}
            onChange={(e) => setReason(e.target.value)} placeholder="例：本期联调窗口内允许自动放行"
          />
        </Modal>
      )}

      {condFor && (
        <Modal
          title={`前置条件编辑 · ${condFor}`}
          onClose={() => setCondFor(null)}
          footer={(
            <>
              <button className="act" onClick={() => setCondFor(null)}>取消</button>
              <button
                className="act primary"
                onClick={() => void run(async () => {
                  await platformApi.setGatePreconditions(projectId, condFor, condText.split('\n'));
                  setCondFor(null);
                }, '前置条件已保存', () => void load())}
              >保存</button>
            </>
          )}
        >
          <p className="set-note">每行一条前置条件（auto 放行的前置声明）：</p>
          <textarea
            style={{ width: '100%', minHeight: 100 }} value={condText}
            onChange={(e) => setCondText(e.target.value)} placeholder={'例：自测报告通过\n单元测试达标'}
          />
        </Modal>
      )}
    </div>
  );
}

/** C8 审计组（原 /audit 页并入；A10-3：只读游标查询 + 导出，无改删入口） */
export function AuditGroup() {
  const projectId = useSession((s) => s.projectId);
  const [items, setItems] = useState<AuditItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [curUsed, setCurUsed] = useState<string | null>(null);
  const [prevCursors, setPrevCursors] = useState<Array<string | null>>([]);
  const [actor, setActor] = useState('');
  const [command, setCommand] = useState('');

  const load = useCallback(async (cur: string | null, prevs: Array<string | null>) => {
    const q = new URLSearchParams();
    if (projectId) q.set('projectId', projectId);
    if (actor) q.set('actor', actor);
    if (command) q.set('command', command);
    if (cur) q.set('cursor', cur);
    q.set('limit', '50');
    try {
      const r = await platformApi.audit(`?${q.toString()}`);
      setItems(r.items); setCursor(r.nextCursor); setCurUsed(cur); setPrevCursors(prevs);
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
  }, [projectId, actor, command]);
  useEffect(() => { void load(null, []); }, [load]);

  const exportJson = () => void (async () => {
    try {
      const data = await platformApi.auditExport(projectId ?? undefined);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { toast(e instanceof ApiError ? e.message : String(e), 'warn'); }
  })();

  return (
    <div className="set-card">
      <h3>🧾 审计日志（只读）</h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        哈希链追加存储，只读导出；不提供任何修改/删除端点（REQ-706、BR-04）。
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input placeholder="操作者" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input placeholder="命令（如 doc.finalize）" value={command} onChange={(e) => setCommand(e.target.value)} />
        <button className="act" onClick={() => void load(null, [])}>查询</button>
        <button className="act" onClick={exportJson}>导出 JSON</button>
        <span className="set-note">{projectId ? '范围：当前项目' : '范围：全部（未选项目）'}</span>
      </div>
      <table className="set-table" style={{ fontSize: 12 }}>
        <thead>
          <tr><th>事件</th><th>时间</th><th>操作者</th><th>命令</th><th>输入指纹</th><th>链上前驱</th></tr>
        </thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.eventId}>
              <td><code>{r.eventId}</code></td>
              <td>{r.at.slice(0, 19).replace('T', ' ')}</td>
              <td>{r.actor}（{r.actorType}）</td>
              <td><code>{r.command}</code></td>
              <td title={r.inputFingerprint}><code>{r.inputFingerprint.slice(0, 20)}…</code></td>
              <td title={r.hashChainPrev ?? ''}><code>{r.hashChainPrev ? `${r.hashChainPrev.slice(0, 20)}…` : '（链首）'}</code></td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={6} className="set-note">无记录</td></tr>}
        </tbody>
      </table>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button
          className="act" disabled={prevCursors.length === 0}
          onClick={() => {
            const prevs = [...prevCursors];
            const prev = prevs.pop() ?? null;
            void load(prev, prevs);
          }}
        >上一页</button>
        <button className="act" disabled={!cursor} onClick={() => void load(cursor, [...prevCursors, curUsed])}>下一页</button>
      </div>
    </div>
  );
}

/** C6 备份组：范围选择（含证据）+ 触发导出 + 历史记录列表（签名下载链接） */
export function BackupGroup() {
  const projectId = useSession((s) => s.projectId);
  const [includeEvidence, setIncludeEvidence] = useState(true);
  const [items, setItems] = useState<BackupRow[]>([]);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    const r = await platformApi.backupList(projectId).catch(() => ({ items: [] as BackupRow[] }));
    setItems(r.items);
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  const doExport = () => void run(async () => {
    setRunning(true);
    try {
      const r = await platformApi.backupExport(projectId!, includeEvidence);
      toast(`备份导出已受理（${r.operationId}），完成后历史列表出现下载链接`, 'success');
      setTimeout(() => { void load(); setRunning(false); }, 4000);
    } finally { /* running 由延时复位 */ }
  }, '', () => void load());

  if (!projectId) return <div className="set-card"><p className="set-note">请先在项目页进入一个项目。</p></div>;

  return (
    <div className="set-card">
      <h3>💾 备份导出</h3>
      <p className="set-note" style={{ marginBottom: 10 }}>
        项目数据逻辑导出（PG 全量表 + MinIO 工件清单 + 每表 SHA-256 清单）。密钥类列不导出。
      </p>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <span className="set-note">范围：</span>
        <label className="checkline"><input type="checkbox" checked readOnly disabled /> 当前项目（全业务表）</label>
        <label className="checkline">
          <input type="checkbox" checked={includeEvidence} onChange={(e) => setIncludeEvidence(e.target.checked)} />
          含审计/证据链（audit_log / evd_records / evd_events）
        </label>
        <button className="act primary" disabled={running} onClick={doExport}>
          {running ? '导出中…' : '触发导出'}
        </button>
      </div>
      <table className="set-table" style={{ fontSize: 12.5 }}>
        <thead><tr><th>操作号</th><th>状态</th><th>范围</th><th>规模</th><th>发起</th><th>时间</th><th>下载</th></tr></thead>
        <tbody>
          {items.map((b) => (
            <tr key={b.operationId}>
              <td><code>{b.operationId}</code></td>
              <td>
                <span className={`tag ${b.status === 'completed' ? 'tag-ok' : b.status === 'failed' ? 'tag-warn' : ''}`}>
                  {b.status === 'completed' ? '已完成' : b.status === 'failed' ? '失败' : '进行中'}
                </span>
                {b.error && <div className="set-note" title={b.error}>{b.error.slice(0, 40)}</div>}
              </td>
              <td>{b.includeEvidence ? '项目+证据' : '项目'}</td>
              <td>{b.status === 'completed' ? `${b.tableCount} 表 / ${b.rowCount} 行` : '—'}</td>
              <td>{b.createdBy}</td>
              <td>{new Date(b.createdAt).toLocaleString()}</td>
              <td>
                {b.downloadUrl
                  ? <a href={b.downloadUrl} target="_blank" rel="noreferrer">下载（1h 有效）</a>
                  : '—'}
              </td>
            </tr>
          ))}
          {items.length === 0 && <tr><td colSpan={7} className="set-note">暂无备份记录</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** C7 系统设置组：结构化存储与清理 + 治理复选组 + 委派并发上限（E6 配置入口）+ 高级 key-value */
export function SystemGroup() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [advKey, setAdvKey] = useState('');
  const [advVal, setAdvVal] = useState('');

  const load = useCallback(async () => {
    const s = await platformApi.settings().catch(() => ({} as Record<string, unknown>));
    setSettings(s);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const put = (key: string, value: unknown, msg = '已保存') =>
    void run(() => platformApi.putSettings({ [key]: value }), msg, () => void load());

  const str = (k: string, dft: string) => String(settings[k] ?? dft);
  const bool = (k: string, dft: boolean) => (settings[k] as boolean | undefined) ?? dft;

  return (
    <>
      <div className="set-card">
        <h3>存储与清理</h3>
        <div className="set-form-grid">
          <label>临时文件夹保留时长（到期定时清理）</label>
          <select
            value={str('retention.tempDays', '7')}
            onChange={(e) => put('retention.tempDays', e.target.value, `已保存：保留 ${e.target.value} 天`)}
          >
            <option value="3">3 天</option>
            <option value="7">7 天（默认）</option>
            <option value="14">14 天</option>
            <option value="30">30 天</option>
          </select>
          <label>待确认（pending）修改自动回收</label>
          <select
            value={str('retention.pendingAction', 'none')}
            onChange={(e) => put('retention.pendingAction', e.target.value)}
          >
            <option value="none">不自动回收（默认）</option>
            <option value="remind72h">72 小时后提醒</option>
            <option value="reject72h">72 小时后自动拒绝</option>
          </select>
          <label>导出默认格式</label>
          <select
            value={str('export.defaultFormat', 'md')}
            onChange={(e) => put('export.defaultFormat', e.target.value)}
          >
            <option value="md">Markdown (.md)</option>
            <option value="docx">Word (.docx)</option>
            <option value="pdf">PDF (.pdf)</option>
          </select>
          <label>委派并发上限（E6；超限在发起时提示）</label>
          <input
            type="number" min={1} max={16}
            value={Number(settings['delegation.concurrencyMax'] ?? 2)}
            onChange={(e) => {
              const v = Math.max(1, Math.min(16, Number(e.target.value) || 2));
              put('delegation.concurrencyMax', v, `并发上限已设为 ${v}`);
            }}
          />
        </div>
      </div>

      <div className="set-card">
        <h3>治理</h3>
        {([
          ['governance.promptSnapshot', '每次会话启动快照 Prompt 版本并写入审计', true],
          ['governance.usageMetering', 'usage.event 用量记账（成本徽标数据源）', true],
          ['governance.rtmGateOnFinalize', '定稿时执行 RTM 门禁校验（L0a≥0.95 / L0b=1.00）', true],
        ] as Array<[string, string, boolean]>).map(([k, label, dft]) => (
          <label key={k} className="checkline">
            <input
              type="checkbox" checked={bool(k, dft)}
              onChange={(e) => put(k, e.target.checked)}
            />
            {label}
          </label>
        ))}
        <label className="checkline" title="预留挂载点，本期不启用（DSG-U06-6）">
          <input type="checkbox" disabled /> RBAC 角色权限（预留挂载点，本期不启用）
        </label>
      </div>

      <div className="set-card">
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>高级：通用设置直编（key-value）</summary>
          <table className="set-table" style={{ marginTop: 8, fontSize: 12.5 }}>
            <tbody>
              {Object.entries(settings).map(([k, v]) => (
                <tr key={k}><td><code>{k}</code></td><td><code>{JSON.stringify(v)}</code></td></tr>
              ))}
              {Object.keys(settings).length === 0 && <tr><td className="set-note">暂无设置项</td></tr>}
            </tbody>
          </table>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input placeholder="键（点分层级，如 zip.limits.maxEntries）" value={advKey} onChange={(e) => setAdvKey(e.target.value)} style={{ flex: 1 }} />
            <input placeholder='值（JSON 或字符串）' value={advVal} onChange={(e) => setAdvVal(e.target.value)} style={{ flex: 1 }} />
            <button
              className="act" disabled={!advKey.trim()}
              onClick={() => {
                let value: unknown = advVal;
                try { value = JSON.parse(advVal); } catch { /* 纯字符串 */ }
                put(advKey.trim(), value);
                setAdvKey(''); setAdvVal('');
              }}
            >保存</button>
          </div>
          <p className="set-note" style={{ marginTop: 6 }}>密钥类不落此表（走模型注册表加密存储，REQ-710）。</p>
        </details>
      </div>
    </>
  );
}
