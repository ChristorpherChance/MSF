import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { toast } from '../../ui/toast';
import { designApi, type ReviewItem } from './api';
import { useDesignView } from './store';

/**
 * 自检评审面板（LLD-6 §3.4 V20；S8）：
 * 工具栏（未决/已解决 tag + 规则说明 + ✦ AI 自检评审 + 🔁 重新自检评审）+ 分组表 .grp-row（概要/详细/原型三组，
 * .sevdot 级别圆点 + 「标记已解决 / 重新打开」行内操作）。
 * ✦ AI 自检评审（设计覆盖检测 §1 过度设计侧）：后台跑+轮询 DR 列表进度（分母=启动返回的候选码集）；
 * pi 落项带「✦ AI 自检」来源标；AI 只提不判，结论仍走行内人工三值。
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
  /** ✦ 自检评审进度（后台跑+轮询 DR 列表：分子=候选码集中已落项数，分母=候选数） */
  const [sc, setSc] = useState<{ total: number; done: number } | null>(null);
  const scTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const scTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (scTimer.current) clearInterval(scTimer.current);
    if (scTimeout.current) clearTimeout(scTimeout.current);
  }, []);
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

  /** ✦ AI 自检评审（过度设计候选复核落真实 DR 项）：启动即返候选码集 → 轮询 DR 列表直到齐套 */
  const selfcheck = () => {
    if (!projectId) return;
    setMsg(null);
    void designApi.selfcheckReviews(projectId)
      .then((r) => {
        if (!r.started) {
          setMsg('无过度设计候选（八册锚点节均有 REQ 回引或已人工豁免）');
          return;
        }
        const expected = new Set(r.candidates);
        setSc({ total: expected.size, done: 0 });
        const stop = () => {
          if (scTimer.current) clearInterval(scTimer.current);
          if (scTimeout.current) clearTimeout(scTimeout.current);
          scTimer.current = null;
          scTimeout.current = null;
          setSc(null);
        };
        scTimer.current = setInterval(() => {
          // 轮询走 store 刷新：表格行随落项即时可见，进度同源
          void refreshReviews().then(() => {
            const landed = useDesignView.getState().reviews.filter((x) => expected.has(x.id)).length;
            setSc({ total: expected.size, done: landed });
            if (landed >= expected.size) {
              stop();
              toast(`自检评审完成：${expected.size} 条复核意见已落评审项，请逐条人工结论`, 'success');
            }
          }).catch(() => { /* 单拍轮询失败下拍再试 */ });
        }, 2000);
        // 兜底超时（5 分钟）停轮询，不吊死按钮态
        scTimeout.current = setTimeout(() => {
          stop();
          void refreshReviews();
          setMsg('自检评审等待超时，已停止进度轮询——已落项意见仍在下表，可稍后刷新查看');
        }, 300_000);
      })
      .catch((e) => {
        // 并发闸人话提示（在飞再点）；其余错误落行内消息
        if (e instanceof ApiError && e.code === 'INVALID_STATE') toast(e.message, 'warn');
        else setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '自检失败');
      });
  };

  return (
    <div className="proto-wrap">
      {/* 工具栏：未决/已解决 tag + 规则说明 + ✦/🔁 */}
      <div className="doc-toolbar">
        <span className={`tag ${open.length > 0 ? 'tag-warn' : 'tag-ok'}`}>未决 {open.length}</span>
        <span className="tag">已解决 {done.length}</span>
        <span className="pop-tip">概要规则 7 条 + 详细规则 11 条 + 原型规则 20 条 checklist（机器扫描）+ REQ 覆盖比对</span>
        <span className="sep" />
        <button
          className="act primary"
          disabled={sc !== null}
          title="AI 逐节复核过度设计候选（无 REQ 回引的锚点节），意见落真实评审项，人工逐条结论"
          onClick={selfcheck}
        >
          ✦ 自检评审{sc ? `（${sc.done}/${sc.total}）` : ''}
        </button>
        <button className="act primary" disabled={busy} onClick={reseed}>🔁 重新自检评审</button>
        {sc && <span className="pop-tip">AI 自检评审进行中 {sc.done}/{sc.total}…（逐节复核，落项即更新）</span>}
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
  const color = sev === '高' ? 'var(--red)' : sev === '中' ? 'var(--orange)' : 'var(--ink2)';
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
        {r.by === 'pi' && (
          <span className="tag" title="AI 自检评审产出（过度设计候选复核意见）——AI 只提不判，请人工结论">✦ AI 自检</span>
        )}{' '}
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
