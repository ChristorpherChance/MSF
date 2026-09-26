import { useState } from 'react';
import { ApiError } from '../../api';
import { designApi, type ReviewItem } from './api';
import { useDesignView } from './store';

/**
 * 自检评审面板（LLD-6 §3.4 V20；S8）：
 * 工具栏（未决/已解决 tag + 规则说明 + 🔁 重新自检评审）+ 分组表 .grp-row（概要/详细/原型三组，
 * .sevdot 级别圆点 + 「标记已解决 / 重新打开」行内操作）。
 */

const GROUPS: Array<{ key: string; label: string; desc: string }> = [
  { key: '概要', label: '📐 概要规则', desc: '架构完整性 / 容量估算 / 部署拓扑 / 关键时序类（7 条 checklist）' },
  { key: '详细', label: '📋 详细规则', desc: '接口一致性 / 错误语义 / 表结构 / REQ 覆盖类（11 条 checklist）' },
  { key: '原型', label: '🖼️ 原型规则', desc: '《原型 UI 设计规范》20 条 checklist · proto-lint 机器自动扫描' },
];

/** 工件列中文名（原型口径：显示册名而非 docKind 代码） */
const KIND_NAME: Record<string, string> = {
  hld: '概要', mod: '模块设计', alg: '算法设计', cls: '类设计', db: '数据库',
  api: '接口', ui: '界面', nfr: '非功能', proto: '原型 UI',
};

/** 分组口径：hld 册归概要规则；ui 册归原型规则；其余归详细规则 */
function groupOf(docKind: string): string {
  if (docKind === 'hld') return '概要';
  if (docKind === 'ui' || docKind === 'proto') return '原型';
  return '详细';
}

export function ReviewPanel() {
  const { projectId, reviews, loading, refreshReviews } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (loading && reviews.length === 0) return <div className="doc-empty">加载中…</div>;
  const open = reviews.filter((r) => r.status === 'open');
  const done = reviews.filter((r) => r.status === 'done');

  /** S8 🔁 重新自检评审（幂等补齐种子条目，不动已有结论） */
  const reseed = () => {
    if (!projectId) return;
    setBusy(true);
    setMsg(null);
    void designApi.reseedReviews(projectId)
      .then((r) => setMsg(r.count > 0 ? `自检完成：新增 ${r.count} 条发现` : '自检完成：既有发现复核仍成立，无新增'))
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '自检失败'))
      .finally(() => { setBusy(false); void refreshReviews(); });
  };

  return (
    <div className="proto-wrap">
      {/* 工具栏：未决/已解决 tag + 规则说明 + 🔁 */}
      <div className="doc-toolbar">
        <span className={`tag ${open.length > 0 ? 'tag-warn' : 'tag-ok'}`}>未决 {open.length}</span>
        <span className="tag">已解决 {done.length}</span>
        <span className="pop-tip">概要规则 7 条 + 详细规则 11 条 + 原型规则 20 条 checklist（机器扫描）+ REQ 覆盖比对</span>
        <span className="sep" />
        <button className="act primary" disabled={busy} onClick={reseed}>🔁 重新自检评审</button>
        {msg && <span className="rsn">{msg}</span>}
      </div>

      <div className="rtm-card">
        <table className="rtm-table review-table">
          <thead>
            <tr><th>编号</th><th>级别</th><th>工件</th><th>问题</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {GROUPS.map((g) => {
              const list = reviews.filter((r) => groupOf(r.docKind) === g.key);
              return (
                <GroupBlock key={g.key} g={g} list={list} />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GroupBlock({ g, list }: { g: { key: string; label: string; desc: string }; list: ReviewItem[] }) {
  return (
    <>
      <tr className="grp-row">
        <td colSpan={6}>
          <b>{g.label}</b> <span className="pop-tip" style={{ marginLeft: 6 }}>{g.desc} · {list.length} 条</span>
        </td>
      </tr>
      {list.length === 0 && (
        <tr><td colSpan={6} className="pop-tip" style={{ padding: '6px 10px 12px' }}>
          — 暂无发现{g.key === '原型' ? '（原型 UI 生成 / 初稿入库后由 proto-lint 自动登记）' : ''}
        </td></tr>
      )}
      {list.map((r) => <ReviewRow key={r.id} r={r} />)}
    </>
  );
}

function SevDot({ sev }: { sev: string }) {
  const color = sev === '高' ? 'var(--red, #c0392b)' : sev === '中' ? 'var(--orange, #b7950b)' : 'var(--ink2)';
  return (
    <>
      <span className="sevdot" style={{ background: color }} />
      {sev}
    </>
  );
}

function ReviewRow({ r }: { r: ReviewItem }) {
  const { projectId, refreshReviews } = useDesignView();
  const [conclusion, setConclusion] = useState<'pass' | 'fail' | 'na'>('pass');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;

  const resolve = () => {
    if (conclusion !== 'pass' && !note.trim()) {
      setMsg('fail/na 结论需填写处理说明');
      return;
    }
    setMsg(null);
    void designApi.conclude(projectId, r.id, conclusion, note.trim() || '人工确认已解决')
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refreshReviews());
  };
  const reopen = () => {
    setMsg(null);
    void designApi.reopenReview(projectId, r.id)
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refreshReviews());
  };

  return (
    <tr>
      <td><code>{r.id}</code></td>
      <td><SevDot sev={r.severity} /></td>
      <td>{KIND_NAME[r.docKind] ?? r.docKind}</td>
      <td>
        {r.item}
        {r.status === 'done' && r.conclusion && (
          <span className="mut" style={{ display: 'block', fontSize: 12 }}>
            → {r.conclusion}{r.at ? ` · ${new Date(r.at).toLocaleString()}` : ''}
          </span>
        )}
        {msg && <span className="rsn err" style={{ display: 'block' }}>{msg}</span>}
      </td>
      <td>
        <span className={`tag ${r.status === 'open' ? 'tag-warn' : 'tag-ok'}`}>{r.status === 'open' ? '未决' : '已解决'}</span>
      </td>
      <td>
        {r.status === 'open' ? (
          <span className="review-cell-ops">
            <select value={conclusion} onChange={(e) => setConclusion(e.target.value as 'pass' | 'fail' | 'na')}>
              <option value="pass">通过</option>
              <option value="fail">不通过</option>
              <option value="na">不适用</option>
            </select>
            <input placeholder="处理说明（fail/na 必填）" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="act" onClick={resolve}>标记已解决</button>
          </span>
        ) : (
          <button className="act" onClick={reopen}>重新打开</button>
        )}
      </td>
    </tr>
  );
}
