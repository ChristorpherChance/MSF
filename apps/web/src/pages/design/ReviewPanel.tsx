import { useState } from 'react';
import { ApiError } from '../../api';
import { designApi, type ReviewItem } from './api';
import { useDesignView } from './store';

/** 自检评审面板（LLD-6 §3.4 V20：DR 分组表 + 行内结论 pass|fail|na + 理由） */
export function ReviewPanel() {
  const { reviews, loading } = useDesignView();
  if (loading && reviews.length === 0) return <div className="doc-empty">加载中…</div>;
  const open = reviews.filter((r) => r.status === 'open');
  const done = reviews.filter((r) => r.status === 'done');
  return (
    <div className="proto-wrap">
      <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="kpi-card"><div className="kpi-label">未决评审项</div><div className="kpi-value" style={{ fontSize: 18 }}>{open.length}</div></div>
        <div className="kpi-card"><div className="kpi-label">已结论</div><div className="kpi-value" style={{ fontSize: 18 }}>{done.length}</div></div>
        <div className="kpi-card"><div className="kpi-label">定稿影响</div><div className="kpi-value" style={{ fontSize: 14 }}>{open.length > 0 ? '定稿需二次确认（记审计）' : '无阻断'}</div></div>
      </div>
      <div className="rtm-card">
        <div className="rtm-card-head"><strong>未决（{open.length}）</strong></div>
        {open.length === 0 && <p className="pop-tip">✓ 全部已结论。</p>}
        {open.map((r) => <ReviewRow key={r.id} r={r} />)}
      </div>
      <div className="rtm-card">
        <div className="rtm-card-head"><strong>已结论（{done.length}）</strong></div>
        {done.map((r) => (
          <div key={r.id} className="issue-row">
            <code>{r.id}</code> <SevTag sev={r.severity} /> {r.item}
            <span className="mut">→ {r.conclusion}{r.at ? ` · ${new Date(r.at).toLocaleString()}` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SevTag({ sev }: { sev: string }) {
  const cls = sev === '高' ? 'st-uncovered' : sev === '中' ? 'tag-warn' : 'tag-ok';
  return <span className={`tag ${cls}`}>{sev}</span>;
}

function ReviewRow({ r }: { r: ReviewItem }) {
  const { projectId, refreshReviews } = useDesignView();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const conclude = (conclusion: 'pass' | 'fail' | 'na') => {
    if (conclusion !== 'pass' && !note.trim()) {
      setMsg('fail/na 结论需填写处理说明');
      return;
    }
    setMsg(null);
    void designApi.conclude(projectId, r.id, conclusion, note.trim() || '确认通过')
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refreshReviews());
  };
  return (
    <div className="review-row">
      <div className="issue-row">
        <code>{r.id}</code> <SevTag sev={r.severity} /> <span className="mut">[{r.docKind}]</span> {r.item}
      </div>
      <div className="review-ops">
        <input value={note} placeholder="处理说明（fail/na 必填）" onChange={(e) => setNote(e.target.value)} />
        <button className="act primary" onClick={() => conclude('pass')}>✓ 通过</button>
        <button className="act" onClick={() => conclude('fail')}>✗ 不通过</button>
        <button className="act" onClick={() => conclude('na')}>不适用</button>
        {msg && <span className="rsn err">{msg}</span>}
      </div>
    </div>
  );
}
