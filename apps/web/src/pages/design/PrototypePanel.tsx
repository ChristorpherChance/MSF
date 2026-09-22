import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { designApi, type ProtoStatus } from './api';
import { useDesignView } from './store';

/**
 * 原型 UI 工作台（LLD-6 §3.4 V19：命令条四步门禁 → KPI → 预览 iframe（sandbox）→ 问题列表 → 目录/基线）。
 * mock 口径：HTML 由目录驱动生成（M6 真接）；预览用签名 URL + sandbox iframe。
 */
export function PrototypePanel() {
  const { proto, catalog, loading, error, refreshProto } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; pageId: string } | null>(null);

  if (error) return <div className="req-banner err">{error}</div>;
  if (!proto) return <div className="doc-empty">{loading ? '加载中…' : '原型工作台初始化中…'}</div>;

  const pages = (catalog?.groups.page ?? []) as Array<{ code: string; payload: Record<string, unknown> }>;

  return (
    <div className="proto-wrap">
      <CommandBar proto={proto} onDone={() => void refreshProto()} msg={msg} setMsg={setMsg} />
      {msg && <div className="req-banner err" style={{ margin: '8px 0 0' }}>{msg}</div>}
      {proto.plan?.stale && (
        <div className="req-banner warn" style={{ margin: '8px 0 0' }}>
          ⚠ 规划依据（上游定稿）已变化——PLAN_STALE，请重新规划。
        </div>
      )}
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi-card">
          <div className="kpi-label">当前结论</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>{statusLabel(proto)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">规划 / 目录版本</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>{proto.plan ? proto.plan.catalogVersion : '—'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">最近检查</div>
          <div className="kpi-value" style={{ fontSize: 18 }}>
            {proto.latestCheck ? `#${proto.latestCheck.runNo} ${proto.latestCheck.passed ? '✓ 通过' : '✗ 未通过'}` : '—'}
          </div>
        </div>
      </div>

      <div className="proto-main">
        <aside className="proto-pages">
          <div className="toc-title">客户原型范围（页面清单）</div>
          {pages.map((p) => (
            <button
              key={p.code}
              className={`toc-item${preview?.pageId === p.code ? ' flash' : ''}`}
              onClick={() => void loadPreview(p.code, setPreview, setMsg)}
            >
              {p.code} · {(p.payload.title as string) ?? ''}
            </button>
          ))}
          {pages.length === 0 && <p className="pop-tip">规划后生成页面清单。</p>}
        </aside>
        <div className="proto-preview">
          {preview ? (
            <iframe title="原型预览" sandbox="allow-scripts" src={preview.url} className="proto-iframe" />
          ) : (
            <div className="doc-empty">左侧选页面预览（sandbox 隔离 iframe + 签名 URL，A05-8）。</div>
          )}
        </div>
      </div>

      {proto.latestCheck && (
        <div className="rtm-card">
          <div className="rtm-card-head"><strong>检查报告 #{proto.latestCheck.runNo}</strong>
            <span className={`tag ${proto.latestCheck.passed ? 'tag-ok' : 'tag-warn'}`}>{proto.latestCheck.passed ? 'pass' : 'fail'}</span>
          </div>
          {proto.latestCheck.issues.length === 0 && <p className="pop-tip">无问题。</p>}
          {proto.latestCheck.issues.map((i, idx) => (
            <div key={idx} className="issue-row"><code>{i.code}</code> {i.message} <span className="mut">[{i.target}]</span></div>
          ))}
          {proto.latestCheck.unverified.map((u, idx) => (
            <div key={`u${idx}`} className="issue-row warn"><code>{u.code}</code> {u.message} <span className="mut">[需人工]</span></div>
          ))}
        </div>
      )}
      <BaselineCard />
      <CatalogCard onChanged={() => void refreshProto()} />
      <SourceAuditCard />
    </div>
  );
}

async function loadPreview(pageId: string, set: (v: { url: string; pageId: string }) => void, setMsg: (m: string | null) => void) {
  const pid = useDesignView.getState().projectId;
  if (!pid) return;
  setMsg(null);
  try {
    const r = await designApi.preview(pid, pageId);
    set({ url: r.previewUrl, pageId });
  } catch (e) {
    setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '预览加载失败');
  }
}

function statusLabel(p: ProtoStatus): string {
  const map: Record<string, string> = {
    idle: '尚无规划', 'plan-ready': '规划就绪', generated: '已生成（待检查）',
    ready: '检查通过（待定稿）', finalized: '已定稿（基线有效）', stale: '已失效（需重新规划）', failed: '失败',
    planning: '规划中…', generating: '生成中…', checking: '检查中…',
  };
  return map[p.status] ?? p.status;
}

/** 命令条：①规划 → ②生成 → ③检查 → ④人工定稿（逐步门禁实时求值） */
function CommandBar({ proto, onDone, msg, setMsg }: {
  proto: ProtoStatus; onDone: () => void; msg: string | null; setMsg: (m: string | null) => void;
}) {
  const { projectId } = useDesignView();
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;
  const run = async (step: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const issues = (e as ApiError & { issues?: unknown[] }).issues;
      setMsg(e instanceof ApiError ? `${e.code}: ${e.message}${issues ? `（${JSON.stringify(issues)}）` : ''}` : '操作失败');
    } finally {
      setBusy(false);
      onDone();
    }
  };
  const verId = proto.prototype?.currentVersionId ?? null;
  return (
    <div className="v19-command">
      <span className={`tag ${proto.status === 'finalized' ? 'tag-ok' : 'tag-warn'}`}>{statusLabel(proto)}</span>
      <button className="act primary" disabled={busy} onClick={() => void run('plan', () => designApi.plan(projectId))}>① AI 识别规划</button>
      <button className="act" disabled={busy || !proto.plan || proto.plan.stale} onClick={() => void run('generate', async () => {
        const r = await designApi.protoGenerate(projectId, proto.plan!.planId, proto.plan!.fingerprint);
        setMsg(`已生成原型版本 v${r.v}`);
      })}>② 生成完整原型</button>
      <button className="act" disabled={busy || !verId} onClick={() => void run('check', async () => {
        const r = await designApi.protoCheck(projectId, verId!);
        setMsg(`检查完成：${r.status}（问题 ${r.issues.length}，需人工 ${r.unverified.length}）`);
      })}>③ 对应性检查</button>
      <button
        className="act primary"
        disabled={busy || !proto.latestCheck?.passed || proto.latestCheck?.prototypeVersionId !== verId}
        title="人工定稿形成设计基线（策略确认点）"
        onClick={() => {
          if (!window.confirm('共同定稿将形成设计基线（append-only，人工确认点）。继续？')) return;
          void run('finalize', async () => {
            const r = await designApi.protoFinalize(projectId, verId!, proto.latestCheck!.reportId);
            setMsg(`已定稿：基线 ${r.code}`);
          });
        }}
      >④ 人工定稿</button>
      {msg && <span className="rsn">{msg}</span>}
    </div>
  );
}

function BaselineCard() {
  const { projectId } = useDesignView();
  const [items, setItems] = useState<Array<{ code: string; valid: boolean; current: boolean; staleReason: string | null; confirmedAt: string }> | null>(null);
  useEffect(() => {
    if (projectId) void designApi.baselines(projectId).then((r) => setItems(r.items));
  }, [projectId]);
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>设计基线（append-only，valid 实时比对）</strong>
        <button className="act" onClick={() => projectId && void designApi.baselines(projectId).then((r) => setItems(r.items))}>↻</button>
      </div>
      {items === null ? <p className="pop-tip">加载中…</p> : items.length === 0 ? <p className="pop-tip">尚无基线——原型定稿后产生。</p> : (
        <table className="rtm-table">
          <thead><tr><th>基线</th><th>当前</th><th>有效</th><th>定稿时间</th></tr></thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.code}>
                <td><code>{b.code}</code></td>
                <td>{b.current ? '✓' : ''}</td>
                <td>{b.valid ? <span className="tag tag-ok">有效</span> : <span className="tag st-uncovered">失效：{b.staleReason}</span>}</td>
                <td className="mut">{new Date(b.confirmedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 设计目录卡：分组摘要 + 人工增删（增删=新目录版本；识别条目不可直删，REQ-304/306） */
function CatalogCard({ onChanged }: { onChanged: () => void }) {
  const { projectId, catalog } = useDesignView();
  const [addOpen, setAddOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !catalog) return null;
  const groups = Object.entries(catalog.groups);
  const remove = (itemId: string) => {
    if (!window.confirm('删除该目录条目将产生新目录版本，引用随行迁移。继续？')) return;
    setMsg(null);
    void designApi.removeCatalogItem(projectId, itemId)
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '删除失败'))
      .finally(onChanged);
  };
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>设计目录 {catalog.catalogVersion ?? '（未规划）'}</strong>
        <button className="act" onClick={() => setAddOpen(true)}>＋ 人工补充条目</button>
      </div>
      {msg && <p className="pop-tip err">{msg}</p>}
      {groups.length === 0 ? <p className="pop-tip">规划后生成目录条目。</p> : groups.map(([g, items]) => (
        <div key={g} className="cat-group">
          <div className="cat-group-head"><code>{g}</code> <span className="mut">×{items.length}</span></div>
          {items.map((it) => (
            <div key={it.itemId} className="issue-row">
              <code>{it.code}</code> {(it.payload.title as string) ?? ''}
              <span className="mut">[{it.source === 'manual' ? '人工' : '识别'}{it.required ? '·必需' : ''}]</span>
              {it.source === 'manual' && <button className="act" onClick={() => remove(it.itemId)}>删除</button>}
            </div>
          ))}
        </div>
      ))}
      {addOpen && <AddItemModal onClose={() => setAddOpen(false)} onChanged={onChanged} />}
    </div>
  );
}

const ITEM_TYPES = ['page', 'state', 'component', 'dialog', 'flow', 'viewport', 'theme', 'copy', 'asset'] as const;

function AddItemModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { projectId } = useDesignView();
  const [itemType, setItemType] = useState<string>('page');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const submit = () => {
    setMsg(null);
    void designApi.addCatalogItem(projectId, { itemType, code: code.trim(), title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '新增失败'))
      .finally(onChanged);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>＋ 人工补充目录条目</h3>
        <p className="pop-tip">人工条目标记 source=manual，对应性检查时列入「需人工核对」（不静默通过，REQ-306）。</p>
        <label className="form-row">类型
          <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
            {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="form-row">编号 <input value={code} placeholder="如 P-CUSTOM" onChange={(e) => setCode(e.target.value)} /></label>
        <label className="form-row">标题 <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="form-row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={!code.trim() || !title.trim()} onClick={submit}>新增（产生新目录版本）</button>
        </div>
      </div>
    </div>
  );
}

function SourceAuditCard() {
  const { projectId } = useDesignView();
  const [audit, setAudit] = useState<{ rulesVersion: string; ok: boolean; issues: Array<{ code: string; target: string; message: string }> } | null>(null);
  useEffect(() => {
    if (projectId) void designApi.sourceAudit(projectId).then(setAudit).catch(() => setAudit(null));
  }, [projectId]);
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>来源审计（规则集 {audit?.rulesVersion ?? '…'}）</strong>
        <button className="act" onClick={() => projectId && void designApi.sourceAudit(projectId).then(setAudit)}>↻</button>
      </div>
      {audit === null ? <p className="pop-tip">—</p> : audit.ok ? (
        <p className="pop-tip">✓ 目录与已批准来源文档双向一致。</p>
      ) : (
        audit.issues.map((i, idx) => (
          <div key={idx} className="issue-row"><code>{i.code}</code> {i.message} <span className="mut">[{i.target}]</span></div>
        ))
      )}
    </div>
  );
}
