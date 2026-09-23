import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDockStore } from '../../assistant/dock-store';
import { useSession } from '../../store';
import { platformApi, STAGE_NAMES, type EventItem, type TaskItem } from './api';
import './tasks.css';

/**
 * 任务中心页（LLD-6 §3.7 DSG-U03-7；REQ-704/703）：
 * KPI 行（累计/进行中/完成率/事件数）→ Task 列表卡（含会话跳转 jumpSession）→ 事件流卡。
 * 刷新=通知 SSE 增量驱动，不整页重载。
 */

const STAGE_ROUTE: Record<string, string> = {
  material: '/material', req: '/req', design: '/design', dev: '/dev', test: '/test',
};

/** 状态→进度（视图不带进度列，按状态映射纯展示） */
function statusProgress(status: string): { pct: number; cls: string; label: string } {
  if (['done', 'closed', 'succeeded'].includes(status)) return { pct: 100, cls: 'ok', label: status };
  if (['running', 'in-progress', 'confirmed', 'fixing', 'retesting'].includes(status)) return { pct: 55, cls: 'ing', label: status };
  if (['blocked', 'failed'].includes(status)) return { pct: 30, cls: 'bad', label: status };
  return { pct: 8, cls: '', label: status };
}

export function TasksPage() {
  const projectId = useSession((s) => s.projectId);
  const projectName = useSession((s) => s.projectName);
  const navigate = useNavigate();
  const [items, setItems] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [eventTotal, setEventTotal] = useState(0);
  const [stage, setStage] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const q = `?page=${page}&pageSize=20${stage ? `&stage=${stage}` : ''}${status ? `&status=${status}` : ''}`;
      const [t, e] = await Promise.all([
        platformApi.tasks(projectId, q),
        platformApi.events(projectId, '?limit=30'),
      ]);
      setItems(t.items); setTotal(t.total);
      setEvents(e.items); setEventTotal(e.total ?? e.items.length);
    } finally { setLoading(false); }
  }, [projectId, page, stage, status]);

  useEffect(() => { void load(); }, [load]);

  // SSE 增量刷新（通知产生=可能有新任务/事件；不整页重载）
  useEffect(() => {
    if (!projectId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const es = new EventSource('/api/v1/system/notifications:stream');
    es.onmessage = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 600);
    };
    return () => { es.close(); if (timer) clearTimeout(timer); };
  }, [projectId, load]);

  const kpi = useMemo(() => {
    const ing = items.filter((t) => statusProgress(t.status).cls === 'ing').length;
    const done = items.filter((t) => statusProgress(t.status).pct === 100).length;
    return { total, ing, rate: total ? Math.round((done / Math.max(total, items.length)) * 100) : 0, events: eventTotal };
  }, [items, total, eventTotal]);

  /** 会话跳转：回所属阶段页并打开该上下文 dock（jumpSession 口径） */
  const jumpSession = (t: TaskItem) => {
    const route = STAGE_ROUTE[t.stage] ?? '/projects';
    navigate(route);
    useDockStore.setState({ open: true });
  };

  return (
    <div className="full-wrap">
      <div className="full-inner">
        <h1 className="tasks-title">⚡ 任务中心</h1>
        <p className="tasks-sub">跨阶段 Task 汇总与事件流{projectName ? ` · 当前项目：${projectName}` : ''}</p>

        <div className="kpi-row">
          <div className="kpi"><div className="kv">{kpi.total}</div><div className="kl">累计 Task</div></div>
          <div className="kpi"><div className="kv">{kpi.ing}</div><div className="kl">进行中</div></div>
          <div className="kpi"><div className="kv">{kpi.rate}%</div><div className="kl">完成率</div></div>
          <div className="kpi"><div className="kv">{kpi.events}</div><div className="kl">事件数</div></div>
        </div>

        <div className="card">
          <div className="card-head">
            <strong>Task 列表</strong>
            <select value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }}>
              <option value="">全部阶段</option>
              {Object.entries(STAGE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">全部状态</option>
              {['queued', 'running', 'done', 'blocked', 'confirmed', 'closed'].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            {loading && <span className="tasks-loading">刷新中…</span>}
          </div>
          <table className="tasks-table">
            <thead>
              <tr><th>阶段</th><th>编号</th><th>目标</th><th>状态</th><th>进度</th><th>会话</th><th>时间</th></tr>
            </thead>
            <tbody>
              {items.map((t) => {
                const p = statusProgress(t.status);
                return (
                  <tr key={t.id}>
                    <td><span className={`tag tag-${t.stage}`}>{STAGE_NAMES[t.stage] ?? t.stage}</span></td>
                    <td><code>{t.code}</code></td>
                    <td className="tt-title">{t.title}</td>
                    <td><span className={`task-st st-${p.cls || 'idle'}`}>{p.label}</span></td>
                    <td><div className="prog"><i className={p.cls} style={{ width: `${p.pct}%` }} /></div></td>
                    <td><button className="sm ghost-link" onClick={() => jumpSession(t)}>💬 会话</button></td>
                    <td className="tt-time">{t.updatedAt.slice(0, 16).replace('T', ' ')}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan={7} className="tt-empty">暂无任务 —— 各阶段产生的 Task 会自动汇总到这里</td></tr>
              )}
            </tbody>
          </table>
          <div className="tasks-pager">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
            <span>第 {page} 页 / 共 {total} 条</span>
            <button disabled={page * 20 >= total} onClick={() => setPage((p) => p + 1)}>下一页</button>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><strong>事件流</strong><span className="tasks-loading">append-only</span></div>
          {events.length === 0 && <p className="tt-empty">暂无事件</p>}
          {events.map((e) => (
            <div key={e.id} className="evt-row">
              <span className="evt-time">{e.at.slice(0, 19).replace('T', ' ')}</span>
              <span className="tag tag-evt">{e.type}</span>
              <span className="evt-actor">{e.actor}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
