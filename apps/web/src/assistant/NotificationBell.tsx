import { useCallback, useEffect, useRef, useState } from 'react';
import { platformApi, type Notice } from '../pages/platform/api';

/**
 * 通知铃铛（T7-03 前端；A10-2 + A01-6 SSE）：
 * 未读角标 + 下拉列表（单条已读/全部已读）+ notice.created SSE 实时推送
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await platformApi.notifications('?limit=20');
      setItems(r.items);
      setUnread(r.unreadCount);
    } catch { /* 服务未就绪时静默 */ }
  }, []);

  useEffect(() => {
    void refresh();
    const es = new EventSource('/api/v1/system/notifications:stream');
    esRef.current = es;
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as { type: string; notice?: Notice };
        if (data.type === 'notice.created' && data.notice) {
          setItems((prev) => [data.notice!, ...prev].slice(0, 20));
          if (data.notice.unread) setUnread((n) => n + 1);
        }
      } catch { /* 忽略坏帧 */ }
    };
    return () => es.close();
  }, [refresh]);

  const readOne = async (n: Notice) => {
    if (!n.unread) return;
    await platformApi.readNotice(n.id);
    setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, unread: false } : x)));
    setUnread((c) => Math.max(0, c - 1));
  };

  const readAll = async () => {
    await platformApi.readAllNotices();
    setItems((prev) => prev.map((x) => ({ ...x, unread: false })));
    setUnread(0);
  };

  return (
    <span style={{ position: 'relative', marginLeft: 'auto' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, position: 'relative' }}
        title="通知"
      >
        🔔
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -6, background: '#c0392b', color: '#fff',
            borderRadius: 8, fontSize: 10, padding: '0 4px', lineHeight: '14px',
          }}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div style={{
          position: 'absolute', right: 0, top: 28, width: 360, maxHeight: 420, overflow: 'auto',
          background: 'var(--msf-card, #fff)', border: '1px solid var(--msf-line, #e2e2e2)',
          borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.12)', zIndex: 100, padding: 8,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 4px 6px' }}>
            <strong style={{ fontSize: 13 }}>通知</strong>
            <button onClick={() => void readAll()} style={{ fontSize: 12 }} disabled={unread === 0}>全部已读</button>
          </div>
          {items.length === 0 && <p style={{ fontSize: 12, color: '#888', padding: 8 }}>暂无通知</p>}
          {items.map((n) => (
            <div
              key={n.id}
              onClick={() => void readOne(n)}
              style={{
                padding: '6px 8px', borderRadius: 6, cursor: n.unread ? 'pointer' : 'default',
                background: n.unread ? 'var(--msf-accent-bg, #eef4ff)' : 'transparent',
                fontSize: 12, marginBottom: 2,
              }}
            >
              <div style={{ color: '#666', marginBottom: 2 }}>
                <code>{n.type}</code> · {n.created_at.slice(0, 19).replace('T', ' ')}
                {n.unread && <span style={{ color: '#2f6fed', marginLeft: 6 }}>● 未读</span>}
              </div>
              <div style={{ wordBreak: 'break-all' }}>{n.text}</div>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
