import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mdHtml } from '../md-html';
import { useSession } from '../store';
import { Modal } from '../ui/Modal';
import { Popover } from '../ui/Popover';
import { ConfirmModal } from '../ui/ConfirmModal';
import type { AiMessageRow, ToolCallRow } from './api';
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

  // W4-001：SPA 内新建/切换项目无整页刷新——订阅会话项目变更，dock 重 init（init 内部对变更项目重置会话/消息/参考勾选）
  const sessionProjectId = useSession((x) => x.projectId);
  useEffect(() => {
    if (sessionProjectId && sessionProjectId !== useDockStore.getState().projectId) void useDockStore.getState().init();
  }, [sessionProjectId]);

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

/** 生成中读秒（2026-10-04 用户反馈：生成中无活动感知）——1s 跳动，暂停时冻结计时口径=仍计墙钟 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const sec = Math.max(0, Math.floor((now - since) / 1000));
  return <span className="elapsed">⏱ {sec >= 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec}s`}</span>;
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

  // D5 拖选引用：dock 展开时，在 dock 之外拖选段落 → 输入区 quote-block chip
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('.chat-dock') || t?.closest('.chat-gwrap') || t?.closest('.modal-overlay')) return;
      const sel = window.getSelection()?.toString().trim() ?? '';
      if (sel.length >= 4) useDockStore.getState().setQuote(sel);
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  const send = () => void s.send();

  return (
    <aside className="chat-dock" style={global ? undefined : { width: s.width }}>
      <div className="chat-head">
        <div className="ch-row">
          <span className="ctx-chip" title={chip.title}>{chip.label}</span>
          <span style={{ flex: 1 }} />
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
          <button className="ghost sm" title="新建会话" onClick={() => void s.newSession()}>＋</button>
          <SessionMenu />
        </div>
        <div className="ch-row">
          <div className="usage-wrap" title={usage.title}>
            <div className="usage-bar"><i style={{ width: `${usage.pct}%`, background: usage.color }} /></div>
            <span className="usage-txt">{usage.pct}%</span>
          </div>
          <UsagePanel />
        </div>
      </div>

      <div className="chat-msgs" ref={msgsRef} onScroll={onScroll}>
        {s.messages.length === 0 && !s.streaming && <Welcome ctx={s.ctx} />}
        {s.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
            <div className="avatar">{m.role === 'user' ? '我' : '🤖'}</div>
            <div className="bubble">
              {m.role === 'user' ? <UserContent content={m.content} /> : <AiContent m={m} />}
              {m.status === 'stopped' && <div className="msg-meta">已停止（保留前缀）</div>}
              {m.status === 'failed' && <div className="msg-meta msg-err">生成失败</div>}
              {m.role === 'ai' && m.durationMs != null && (
                <div className="timing-line">
                  ⏱ 耗时 {(m.durationMs / 1000).toFixed(1)}s
                  {m.cost != null && ` · 成本 $${Number(m.cost).toFixed(4)}`}
                </div>
              )}
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
            <Elapsed since={s.streaming.startedAt} />
          </span>
          {s.streaming.paused
            ? <button className="sm primary" onClick={() => void s.control('resume')}>▶ 继续</button>
            : <button className="sm" onClick={() => void s.control('pause')}>⏸ 暂停</button>}
          <button className="sm danger-ghost" onClick={() => void s.control('stop')}>⏹ 停止</button>
        </div>
      )}

      <div className="chat-input">
        {!s.currentId && (
          <div className="conn-lost" style={{ color: 'var(--ink2)' }}>
            💡 尚无会话：点顶部「＋」新建会话后即可提问；助手会携带当前项目与阶段上下文回答。
          </div>
        )}
        {s.quote && (
          <div className="quote-block" title="拖选正文自动引用；发送时随消息附上">
            <span className="qb-main">📎 引用</span>
            <span className="qb-text">{s.quote.text.replace(/\n/g, ' ')}</span>
            <button className="ghost sm" title="移除引用" onClick={() => s.setQuote(null)}>✕</button>
          </div>
        )}
        <textarea
          value={input}
          placeholder={!s.currentId ? '先点顶部「＋」新建会话，再开始对话' : s.ctx === 'req' ? '例：第 4 章补充灾备要求，只改这一处' : '例：重新解析第 3 节表格'}
          disabled={!s.currentId || !!s.streaming}
          onChange={(e) => s.setInput(s.ctx, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="row">
          <RefPicker />
          <select
            title={s.currentId ? '模型切换（仅已连通）' : '模型预选（无会话时作为新建会话的绑定模型）'}
            value={sess?.model_id ?? s.preferredModelId ?? ''}
            onChange={(e) => void s.setModel(e.target.value || null)}
          >
            {!(sess?.model_id ?? s.preferredModelId) && <option value="">默认（chat 路由）</option>}
            {chatModels(s.models).map((m) => (
              <option key={m.id} value={m.id}>{modelIcon(m)} {m.name}</option>
            ))}
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
          <span style={{ flex: 1 }} />
          <button
            className="primary"
            disabled={!s.currentId || !!s.streaming || (!input.trim() && !s.quote)}
            onClick={send}
          >发送 ↵</button>
        </div>
      </div>
    </aside>
  );
}

/** W2-035：参考资料勾选入口（📎 按钮 + popover 清单；content_final 候选，随发送提交指纹快照） */
function RefPicker() {
  const refCandidates = useDockStore((s) => s.refCandidates);
  const refSel = useDockStore((s) => s.refSel);
  const currentId = useDockStore((s) => s.currentId);
  const streaming = useDockStore((s) => s.streaming);
  const loadRefCandidates = useDockStore((s) => s.loadRefCandidates);
  const toggleRef = useDockStore((s) => s.toggleRef);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  return (
    <>
      <button
        className={`ghost sm${refSel.length > 0 ? ' primary' : ''}`}
        title={refSel.length > 0 ? `已挂 ${refSel.length} 份参考资料（点击调整）` : '挂接参考资料提问（内容已定稿资料候选）'}
        disabled={!currentId || !!streaming}
        onClick={(e) => {
          setAnchor(e.currentTarget.getBoundingClientRect());
          void loadRefCandidates();
        }}
      >
        📎{refSel.length > 0 ? ` ${refSel.length}` : ''}
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div style={{ minWidth: 220, maxWidth: 300 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>📚 参考资料（内容已定稿）</div>
            {refCandidates.length === 0 && (
              <p style={{ fontSize: 12, color: 'var(--ink2)' }}>暂无内容定稿资料，请先在资料阶段复核并定稿。</p>
            )}
            {refCandidates.map((c) => (
              <label key={c.fileId} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0', cursor: 'pointer', fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={refSel.includes(c.fileId)}
                  onChange={(e) => toggleRef(c.fileId, e.target.checked)}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
              </label>
            ))}
            {refSel.length > 0 && (
              <p style={{ fontSize: 11, color: 'var(--ink2)', marginTop: 6 }}>
                已选 {refSel.length} 份，随下次发送提交（指纹随消息登记，REQ-114/115）。
              </p>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

/** 欢迎卡（welcomeHtml L1006：阶段感知示例，点击填入输入框） */function Welcome({ ctx }: { ctx: string }) {
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

/** 📊 token 用量统计面板（2026-10-04 用户诉求：当前对话/项目累计/分上下文/分会话分别统计） */
function UsagePanel() {
  const s = useDockStore();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const bd = s.breakdown;
  const fmtTok = (v: string) => {
    const n = Number(v);
    return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  };
  const fmtCost = (v: string) => `$${Number(v).toFixed(4)}`;
  const ctxLabel = (ctx: string | null) =>
    ctx === null ? '文档生成等（无会话）' : (CTX_LABEL[ctx as keyof typeof CTX_LABEL] ?? ctx);
  const cur = bd?.bySession.find((x) => x.session_id === s.currentId);

  return (
    <div className="dock-menu-wrap" ref={wrapRef}>
      <button
        className="ghost sm"
        title="token 用量统计（当前对话 / 分上下文 / 分会话 / 项目累计）"
        onClick={() => { setOpen(!open); if (!open) void s.refreshUsage(); }}
      >📊</button>
      {open && (
        <div className="dock-menu usage-pop">
          {!bd && <div className="up-empty">加载中…</div>}
          {bd && (
            <>
              <div className="up-sec">当前对话</div>
              {cur ? (
                <div className="up-row">
                  <span>{cur.name ?? cur.code ?? '本对话'}</span>
                  <span>入 {fmtTok(cur.tokens_in)} · 出 {fmtTok(cur.tokens_out)} · {fmtCost(cur.cost)} · {cur.calls} 次</span>
                </div>
              ) : (
                <div className="up-empty">本对话暂无计量记录（发送一条消息后产生）</div>
              )}
              <div className="up-sec">分上下文</div>
              {bd.byCtx.length === 0 && <div className="up-empty">暂无用量</div>}
              {bd.byCtx.map((r) => (
                <div className="up-row" key={r.ctx ?? '_none'}>
                  <span>{ctxLabel(r.ctx)}</span>
                  <span>入 {fmtTok(r.tokens_in)} · 出 {fmtTok(r.tokens_out)} · {fmtCost(r.cost)} · {r.calls} 次</span>
                </div>
              ))}
              <div className="up-sec">分会话</div>
              {bd.bySession.length === 0 && <div className="up-empty">暂无会话用量</div>}
              {bd.bySession.map((r) => (
                <div className="up-row" key={r.session_id}>
                  <span className={r.session_id === s.currentId ? 'up-cur' : undefined}>
                    {r.name ?? '已删除会话'} <em>{r.code ?? ''}</em>
                  </span>
                  <span>入 {fmtTok(r.tokens_in)} · 出 {fmtTok(r.tokens_out)} · {fmtCost(r.cost)} · {r.calls} 次</span>
                </div>
              ))}
              <div className="up-sec">项目累计</div>
              <div className="up-row up-total">
                <span>总计</span>
                <span>
                  入 {fmtTok(bd.totals?.tokens_in ?? '0')} · 出 {fmtTok(bd.totals?.tokens_out ?? '0')}
                  · {fmtCost(bd.totals?.cost ?? '0')} · {bd.totals?.calls ?? 0} 次
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** ⋯ 会话菜单（DSG-U02-4：重命名/删除；W8 启用） */function SessionMenu() {
  const s = useDockStore();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [delOpen, setDelOpen] = useState(false);
  const sess = s.sessions.find((x) => x.id === s.currentId);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onDelete = async () => {
    if (!sess) return;
    await s.deleteSession(sess.id);
  };

  return (
    <div className="dock-menu-wrap" ref={wrapRef}>
      <button
        className="ghost sm"
        title="会话操作"
        disabled={!sess}
        onClick={() => setOpen(!open)}
      >⋯</button>
      {open && sess && (
        <div className="dock-menu">
          <button onClick={() => { setOpen(false); setName(sess.name); setRenaming(true); }}>✏ 重命名</button>
          <button className="danger" onClick={() => { setOpen(false); setDelOpen(true); }}>🗑 删除会话</button>
        </div>
      )}
      {delOpen && sess && (
        <ConfirmModal
          title={`删除会话「${sess.name}」`}
          confirmLabel="删除"
          body={'消息记录随行删除（用量留账不删），不可恢复。'}
          onClose={() => setDelOpen(false)}
          onConfirm={() => void onDelete()}
        />
      )}
      {renaming && sess && (
        <Modal
          title="重命名会话"
          onClose={() => setRenaming(false)}
          footer={(
            <>
              <button className="act" onClick={() => setRenaming(false)}>取消</button>
              <button
                className="act primary"
                disabled={!name.trim()}
                onClick={() => { void s.renameSession(sess.id, name.trim()); setRenaming(false); }}
              >保存</button>
            </>
          )}
        >
          <input
            autoFocus
            value={name}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13 }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) {
                void s.renameSession(sess.id, name.trim());
                setRenaming(false);
              }
            }}
          />
        </Modal>
      )}
    </div>
  );
}

/** 用户消息：首段 `> ` 引用行渲染为 .msg-quote chip（D5），其余按原文 */
function UserContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const quoteLines: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i]!.startsWith('> ')) { quoteLines.push(lines[i]!.slice(2)); i += 1; }
  const rest = lines.slice(i).join('\n').trim();
  return (
    <>
      {quoteLines.length > 0 && (
        <div className="msg-quote" title="引用段落">📎 {quoteLines.join(' ').slice(0, 80)}</div>
      )}
      {rest && <div className="md" style={{ whiteSpace: 'pre-wrap' }}>{rest}</div>}
    </>
  );
}

/** AI 消息富渲染（D4）：<thinking> 段 → .thinkcard 折叠卡；正文 markdown；toolCalls → .toolcard；propose_next_step 建议 → .tasklist 行动钮 */
function AiContent({ m }: { m: AiMessageRow }) {
  const segments = splitThinking(m.content);
  const suggestCall = m.toolCalls.find(
    (t) => t.toolName === 'propose_next_step' && t.status === 'ok',
  );
  const suggestions = readSuggestions(suggestCall);
  const otherCalls = m.toolCalls.filter((t) => t !== suggestCall);
  return (
    <>
      {segments.map((seg, i) => seg.kind === 'think'
        ? <ThinkCard key={i} text={seg.text} />
        : <div key={i} className="md" dangerouslySetInnerHTML={{ __html: mdHtml(seg.text) }} />)}
      {otherCalls.length > 0 && <ToolCards calls={otherCalls} />}
      {suggestions.length > 0 && <SuggestList items={suggestions} />}
    </>
  );
}

type Segment = { kind: 'think' | 'md'; text: string };

/** 拆 <thinking>…</thinking> 段（pi 真实 reasoning 落此约定格式；组件就位，产出时生效） */
function splitThinking(content: string): Segment[] {
  const out: Segment[] = [];
  const re = /<thinking>([\s\S]*?)(<\/thinking>|$)/g;
  let last = 0;
  for (let m = re.exec(content); m; m = re.exec(content)) {
    if (m.index > last) out.push({ kind: 'md', text: content.slice(last, m.index) });
    out.push({ kind: 'think', text: m[1]!.trim() });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ kind: 'md', text: content.slice(last) });
  return out.filter((x) => x.kind === 'think' || x.text.trim());
}

/** 可折叠思考卡（原型 thinkcard L1039/L1223：虚线卡 + 头部预览 + 展开体） */
function ThinkCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const prev = text.replace(/\s+/g, ' ').slice(0, 56);
  return (
    <div className={`thinkcard${open ? ' open' : ''}`}>
      <div className="tc-khead" onClick={() => setOpen(!open)}>
        <span className="tk-t">🧠 思考过程</span>
        <span className="tk-caret">{open ? '▾' : '▸'}</span>
        <span className="tk-prev">{prev}</span>
      </div>
      {open && <div className="tc-kbody">{text}</div>}
    </div>
  );
}

/** 工具卡（原型 toolcard L179/L1046：状态图标 + 名称头 + 摘要体；denied 标「已拦截」）
 *  W2-053：nav.goto 成功的卡带「打开 →」行动钮（导航类工具的实际效果由用户点按触发，不静默跳页） */
function ToolCards({ calls }: { calls: ToolCallRow[] }) {
  const navigate = useNavigate();
  return (
    <>
      {calls.map((t, i) => {
        const icon = t.status === 'ok' ? '✅' : t.status === 'denied' ? '🚫' : '❌';
        const summary = summarizeTool(t);
        const navRoute = t.toolName === 'nav.goto' && t.status === 'ok'
          ? (t.resultSummary as { route?: string } | null)?.route
          : undefined;
        // 与 navRoute 同模式：route 从结果读（服务端返回 /req，不硬编码）；kind 用于落到目标文档页签+补丁定位
        const rs = t.resultSummary as { ok?: boolean; route?: string; kind?: string } | null;
        const reviewRoute = t.toolName === 'req.doc.propose_edits' && t.status === 'ok' && rs?.ok === true
          ? rs?.route
          : undefined;
        const reviewKind = rs?.kind === 'prd' ? 'prd' : 'crd';
        return (
          <div key={i} className="toolcard">
            <div className="tc-head">
              {icon} {t.toolName}
              {t.status === 'denied' && <span className="tag red">已拦截</span>}
            </div>
            {summary && <div className="tc-body">{summary}</div>}
            {navRoute && (
              <div className="tc-body">
                <button className="act mini primary" onClick={() => navigate(navRoute)}>打开 →</button>
              </div>
            )}
            {reviewRoute && (
              <div className="tc-body">
                <button
                  className="act mini primary"
                  onClick={() => navigate(`${reviewRoute}?tab=${reviewKind}&focus=pending&_=${Date.now()}`)}
                >
                  前往审阅 →
                </button>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

function summarizeTool(t: ToolCallRow): string {
  const r = t.resultSummary;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if (typeof o.reason === 'string') return o.reason;
    if (typeof o.error === 'string') return o.error;
    // req.doc.propose_edits 成功卡：「已提交 N 条修改建议」（按 toolName 门控；失败走既有 reason 分支）
    if (t.toolName === 'req.doc.propose_edits' && o.ok === true && typeof o.patchCount === 'number') {
      return `已提交 ${o.patchCount} 条修改建议（高亮补丁，待你确认后生效）`;
    }
    if (typeof o.head === 'string') return o.head;
    return JSON.stringify(o).slice(0, 200);
  }
  return typeof r === 'string' ? r.slice(0, 200) : '';
}

/** propose_next_step 建议行动钮（原型 tasklist L182/L1048；点击填入输入框） */
function SuggestList({ items }: { items: string[] }) {
  const setInput = useDockStore((s) => s.setInput);
  const ctx = useDockStore((s) => s.ctx);
  return (
    <div className="tasklist">
      <div className="tl-head">下一步建议 · {items.length}</div>
      {items.map((t) => (
        <div key={t} className="tl-item actionable" title="点击填入输入框" onClick={() => setInput(ctx, t)}>
          <span className="st">➡️</span><span style={{ flex: 1 }}>{t}</span>
        </div>
      ))}
    </div>
  );
}

function readSuggestions(call: ToolCallRow | undefined): string[] {
  const r = call?.resultSummary;
  if (!r || typeof r !== 'object') return [];
  const s = (r as Record<string, unknown>).suggestions;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : [];
}
