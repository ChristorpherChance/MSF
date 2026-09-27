import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { platformApi, type Notice } from '../pages/platform/api';
import '../ui/ui.css';
import './notice-drawer.css';

/**
 * 通知中心（DSG-U02-2/U06-16；A10-2 + A01-6 SSE）：
 * 顶栏 🔔 未读红点计数；点击开**右侧抽屉**（通知列表 + 全部已读 + 跳转定位）；
 * notice.created SSE 实时推送；条目点击=已读 + 有 link 时跳回来源页。
 * U-033：正文中的 URL 不明文展示（签名串属凭证类信息），渲染为「🔗 打开链接」。
 */
const URL_RE = /(https?:\/\/[^\s]+)/g;
function NoticeText({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener" title={p}
            onClick={(e) => e.stopPropagation()}>
            🔗 打开链接
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      const r = await platformApi.notifications('?limit=30');
      setItems(r.items);
      setUnread(r.unreadCount);
    } catch { /* 服务未就绪时静默 */ }
  }, []);

  useEffect(() => {
    void refresh();
    const es = new EventSource('/api/v1/system/notifications:stream');
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as { type: string; notice?: Notice };
        if (data.type === 'notice.created' && data.notice) {
          setItems((prev) => [data.notice!, ...prev].slice(0, 30));
          if (data.notice.unread) setUnread((n) => n + 1);
        }
      } catch { /* 忽略坏帧 */ }
    };
    return () => es.close();
  }, [refresh]);

  // Esc 关闭抽屉（DSG-U02-5 关闭规则）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const clickItem = async (n: Notice) => {
    if (n.unread) {
      await platformApi.readNotice(n.id);
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, unread: false } : x)));
      setUnread((c) => Math.max(0, c - 1));
    }
    if (n.link) { setOpen(false); navigate(n.link); }
  };

  const readAll = async () => {
    await platformApi.readAllNotices();
    setItems((prev) => prev.map((x) => ({ ...x, unread: false })));
    setUnread(0);
  };

  return (
    <>
      <button className="nb-btn" onClick={() => setOpen((o) => !o)} title="通知中心">
        🔔
        {unread > 0 && <span className="nb-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notice-drawer" role="dialog" aria-label="通知中心">
          <div className="nd-head">
            <strong>通知中心</strong>
            <button className="ghost sm" onClick={() => void readAll()} disabled={unread === 0}>全部已读</button>
            <button className="ghost sm" title="关闭（Esc）" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="nd-list">
            {items.length === 0 && <p className="nd-empty">暂无通知</p>}
            {items.map((n) => (
              <div
                key={n.id}
                className={`nd-item${n.unread ? ' unread' : ''}${n.link ? ' linked' : ''}`}
                onClick={() => void clickItem(n)}
                title={n.link ? '点击跳转到来源' : undefined}
              >
                <div className="nd-meta">
                  <code>{n.type}</code> · {n.created_at.slice(0, 19).replace('T', ' ')}
                  {n.unread && <span className="nd-dot">● 未读</span>}
                  {n.link && <span className="nd-jump">↗</span>}
                </div>
                <div className="nd-text"><NoticeText text={n.text} /></div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
