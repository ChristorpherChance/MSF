import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { CTX_LABEL, ROUTE_TO_CTX, useDockStore } from './dock-store';
import './dock.css';

/**
 * 全局助手 dock（U02-4；LLD-6 §2 悬浮球+抽屉；注③ React 实现不混 Lit）：
 * F1 或悬浮球开合；上下文 chip 随路由即时更新；会话创建/切换/历史；
 * fetch+ReadableStream 流式；流控条 pause/resume/stop；思考强度三档；用量条。
 */
export function AssistantDock() {
  const s = useDockStore();
  const location = useLocation();

  useEffect(() => { void s.init(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); useDockStore.getState().toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const ctx = ROUTE_TO_CTX[location.pathname];
    if (ctx) void s.setCtx(ctx);
  }, [location.pathname, s.projectId]);

  return (
    <>
      <button className="dock-fab" title="助手（F1）" onClick={s.toggle}>AI</button>
      {s.open && (
        <aside className="dock-drawer">
          <header className="dock-head">
            <span className="dock-chip">{CTX_LABEL[s.ctx]}上下文</span>
            <select
              value={s.currentId ?? ''}
              onChange={(e) => void s.selectSession(e.target.value)}
            >
              {s.sessions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              {s.sessions.length === 0 && <option value="">（无会话）</option>}
            </select>
            <button onClick={() => void s.newSession()}>新会话</button>
            <select
              value={s.thinkLevel}
              onChange={(e) => s.setThinkLevel(e.target.value as 'low' | 'mid' | 'high')}
              title="思考强度"
            >
              <option value="low">低思考</option>
              <option value="mid">中思考</option>
              <option value="high">高思考</option>
            </select>
            <button className="dock-close" onClick={s.toggle}>×</button>
          </header>

          <div className="dock-msgs">
            {s.messages.map((m) => (
              <div key={m.id} className={`dock-msg dock-msg-${m.role}`}>
                <div className="dock-msg-body">{m.content}</div>
                {m.status === 'stopped' && <div className="dock-msg-meta">已停止（保留前缀）</div>}
                {m.status === 'failed' && <div className="dock-msg-meta dock-err">生成失败</div>}
              </div>
            ))}
            {s.streaming && (
              <div className="dock-msg dock-msg-ai">
                <div className="dock-msg-body">{s.streaming.text || '…'}</div>
                <div className="dock-msg-meta">{s.streaming.paused ? '已暂停（缓冲中）' : '生成中'}</div>
              </div>
            )}
          </div>

          {s.streaming && (
            <div className="dock-flowctl">
              {s.streaming.paused
                ? <button onClick={() => void s.control('resume')}>继续</button>
                : <button onClick={() => void s.control('pause')}>暂停</button>}
              <button onClick={() => void s.control('stop')}>停止</button>
            </div>
          )}

          {s.error && <div className="dock-err dock-errbar">{s.error}</div>}

          <footer className="dock-foot">
            <textarea
              value={s.input}
              placeholder={s.currentId ? '向助手提问…' : '先创建会话'}
              disabled={!s.currentId || !!s.streaming}
              onChange={(e) => s.setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void s.send();
              }}
              rows={2}
            />
            <button disabled={!s.currentId || !!s.streaming || !s.input.trim()} onClick={() => void s.send()}>
              发送
            </button>
          </footer>

          <div className="dock-usage">
            {s.usage
              ? `用量：调用 ${s.usage.calls} 次 · in ${s.usage.tokens_in} / out ${s.usage.tokens_out} tok · $${Number(s.usage.cost).toFixed(4)}`
              : '用量：—'}
          </div>
        </aside>
      )}
    </>
  );
}
