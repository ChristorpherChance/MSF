import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { mdHtml } from '../md-html';
import {
  CTX_LABEL,
  ROUTE_TO_CTX,
  STAGE_ROUTES,
  SUGGESTS,
  chatModels,
  currentModel,
  dockUsage,
  modelIcon,
  useDockStore,
} from './dock-store';
import './dock.css';

/**
 * 全局助手 dock（DSG-U02-4 / DSG-U05-2，对齐原型 chatDockHtml L1021）：
 * 阶段页内嵌右侧栏（chat-resizer 拖宽 300-620px，中央区让位）；非阶段页浮球+通高抽屉 chat-gwrap；
 * 收拢=右下浮球 chat-fab；F1 开合。头部三行 → 消息流 → 流式控制条 → 输入区（模型选择+发送）。
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

  const stagePage = STAGE_ROUTES.includes(location.pathname);
  if (s.hidden) return null;

  if (!s.open) return <Fab />;
  if (!stagePage) {
    return (
      <>
        <Fab />
        <div className="chat-gwrap"><DockInner global /></div>
      </>
    );
  }
  return (
    <>
      <Resizer />
      <DockInner global={false} />
    </>
  );
}

/** 右下浮球（fabHtml L1019；SVG 机器人图标） */
function Fab() {
  const toggle = useDockStore((s) => s.toggle);
  return (
    <button className="chat-fab" title="AI 助手（F1）" onClick={toggle}>
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round">
        <circle cx="14" cy="9" r="4" />
        <path d="M14 13v6M14 15l-5 4M14 15l5 4M9 25h10" />
      </svg>
    </button>
  );
}

/** 拖拽调宽 300-620px（bindResizer L1208） */
function Resizer() {
  const setWidth = useDockStore((s) => s.setWidth);
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useDockStore.getState().width;
    const mv = (ev: MouseEvent) => setWidth(startW + (startX - ev.clientX));
    const up = () => {
      document.removeEventListener('mousemove', mv);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', mv);
    document.addEventListener('mouseup', up);
  };
  return <div className="chat-resizer" onMouseDown={onDown} />;
}

function DockInner({ global }: { global: boolean }) {
  const s = useDockStore();
  const location = useLocation();
  const stagePage = STAGE_ROUTES.includes(location.pathname);
  const msgsRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);

  const model = currentModel(s);
  const thinkOff = !(model && model.supports_thinking);
  const usage = dockUsage(s);
  const sess = s.sessions.find((x) => x.id === s.currentId);
  const input = s.drafts[s.ctx] ?? '';
  const chip = stagePage
    ? { label: `📍 ${CTX_LABEL[s.ctx]} · 阶段上下文`, title: 'AI 可见该阶段产物清单' }
    : { label: '🌐 全局 · 项目级上下文', title: '非阶段页：通用助手形态，不锁定单文档' };

  // 滚动贴底（DSG-U02-7）：用户上翻则不抢滚动
  useEffect(() => {
    const el = msgsRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [s.messages, s.streaming?.text, stick]);

  const onScroll = () => {
    const el = msgsRef.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const send = () => void s.send();

  return (
    <aside className="chat-dock" style={global ? undefined : { width: s.width }}>
      <div className="chat-head">
        <div className="ch-row">
          <span className="ctx-chip" title={chip.title}>{chip.label}</span>
          <button className="ghost sm" title="新建会话" onClick={() => void s.newSession()}>＋</button>
          <button className="ghost sm" title="会话操作（重命名/删除：后续波次）" disabled>⋯</button>
          <button className="ghost sm" title="收拢（F1）" onClick={s.toggle}>⟶</button>
        </div>
        <div className="ch-row">
          <select
            title="历史会话"
            value={s.currentId ?? ''}
            onChange={(e) => void s.selectSession(e.target.value)}
          >
            {s.sessions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            {s.sessions.length === 0 && <option value="">（无会话）</option>}
          </select>
          <div
            className={`think-seg${thinkOff ? ' off' : ''}`}
            title={thinkOff ? '当前模型不支持思考强度' : '思考强度：同一切换为该模型的推理参数，不切模型'}
          >
            {([['low', '低'], ['mid', '中'], ['high', '高']] as const).map(([v, label]) => (
              <button
                key={v}
                className={s.thinkLevel === v ? 'active' : ''}
                disabled={thinkOff}
                onClick={() => s.setThinkLevel(v)}
              >{label}</button>
            ))}
          </div>
        </div>
        <div className="ch-row">
          <div className="usage-wrap" title={usage.title}>
            <div className="usage-bar"><i style={{ width: `${usage.pct}%`, background: usage.color }} /></div>
            <span className="usage-txt">{usage.pct}%</span>
          </div>
        </div>
      </div>

      <div className="chat-msgs" ref={msgsRef} onScroll={onScroll}>
        {s.messages.length === 0 && !s.streaming && <Welcome ctx={s.ctx} />}
        {s.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
            <div className="avatar">{m.role === 'user' ? '我' : '🤖'}</div>
            <div className="bubble">
              {m.role === 'user'
                ? <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                : <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(m.content) }} />}
              {m.status === 'stopped' && <div className="msg-meta">已停止（保留前缀）</div>}
              {m.status === 'failed' && <div className="msg-meta msg-err">生成失败</div>}
            </div>
          </div>
        ))}
        {s.streaming && (
          <div className="msg ai">
            <div className="avatar">🤖</div>
            <div className="bubble">
              <div className="md" style={{ whiteSpace: 'pre-wrap' }}>
                {s.streaming.text || '…'}<span className="stream-cursor" />
              </div>
            </div>
          </div>
        )}
        {s.disconnected && (
          <div className="conn-lost">⚠ 连接中断：{s.error ?? '网络异常'}（内容已保留，可重发）</div>
        )}
      </div>

      {s.streaming && (
        <div className="chat-ctl">
          <span className="status">
            {s.streaming.paused ? '⏸ 已暂停（上下文已保留，可继续）' : '⚡ 生成中…'}
          </span>
          {s.streaming.paused
            ? <button className="sm primary" onClick={() => void s.control('resume')}>▶ 继续</button>
            : <button className="sm" onClick={() => void s.control('pause')}>⏸ 暂停</button>}
          <button className="sm danger-ghost" onClick={() => void s.control('stop')}>⏹ 停止</button>
        </div>
      )}

      <div className="chat-input">
        <textarea
          value={input}
          placeholder={s.ctx === 'req' ? '例：第 4 章补充灾备要求，只改这一处' : '例：重新解析第 3 节表格'}
          disabled={!s.currentId || !!s.streaming}
          onChange={(e) => s.setInput(s.ctx, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="row">
          <select
            title="模型切换（仅已连通）"
            value={sess?.model_id ?? ''}
            disabled={!s.currentId}
            onChange={(e) => void s.setModel(e.target.value || null)}
          >
            {!sess?.model_id && <option value="">默认（chat 路由）</option>}
            {chatModels(s.models).map((m) => (
              <option key={m.id} value={m.id}>{modelIcon(m)} {m.name}</option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          <button
            className="primary"
            disabled={!s.currentId || !!s.streaming || !input.trim()}
            onClick={send}
          >发送 ↵</button>
        </div>
      </div>
    </aside>
  );
}

/** 欢迎卡（welcomeHtml L1006：阶段感知示例，点击填入输入框） */
function Welcome({ ctx }: { ctx: string }) {
  const setInput = useDockStore((s) => s.setInput);
  const sug = SUGGESTS[ctx] ?? SUGGESTS._gen!;
  const icons = ['✍️', '📊', '🌐'];
  return (
    <div className="welcome">
      <div className="w-icon">👋</div>
      <div className="w-title">{CTX_LABEL[ctx as keyof typeof CTX_LABEL] ?? ''}阶段助手已就绪</div>
      <div className="w-sub">
        上下文已自动跟随当前阶段（顶部标识）。<br />也可以从示例开始：
      </div>
      {sug.map((t, i) => (
        <button key={t} className="sg-card" onClick={() => setInput(ctx as never, t)}>
          <span className="sg-ic">{icons[i % 3]}</span><span>{t}</span>
        </button>
      ))}
      <div className="dz-note" style={{ marginTop: 4 }}>点击示例填入输入框，可编辑后发送</div>
    </div>
  );
}
