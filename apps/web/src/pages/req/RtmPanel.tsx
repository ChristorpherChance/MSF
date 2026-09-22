import { useState } from 'react';
import { ApiError } from '../../api';
import { reqApi, type RtmRow } from './api';
import { useReqView } from './store';

/** DSG 设计层八册节点卡（§3.3：h/o/g/k/d/a/u/n + 登记状态；登记=RTM 中出现该册前缀锚点） */
const DSG_VOLUMES = [
  { prefix: 'DSG-H', name: 'HLD 概要设计' },
  { prefix: 'DSG-O', name: 'LLD-1 模块设计' },
  { prefix: 'DSG-G', name: 'LLD-2 算法与流程' },
  { prefix: 'DSG-K', name: 'LLD-3 类与数据结构' },
  { prefix: 'DSG-D', name: 'LLD-4 数据库设计' },
  { prefix: 'DSG-A', name: 'LLD-5 API 接口' },
  { prefix: 'DSG-U', name: 'LLD-6 UI 设计' },
  { prefix: 'DSG-N', name: 'LLD-7 非功能规则' },
] as const;

const STATE_LABEL: Record<RtmRow['state'], string> = {
  covered: '已覆盖',
  partial: '部分覆盖',
  uncovered: '未覆盖',
  deferred: '已暂缓',
};

/** RTM 工作面（LLD-6 §3.3：六 KPI 卡 + 明细表四色节点 + DSG 八册卡 + 门禁规则卡） */
export function RtmPanel() {
  const { rtm, health, loading, error, refreshRtm } = useReqView();
  const [deferTarget, setDeferTarget] = useState<{ kind: 'cr' | 'req'; code: string } | null>(null);

  if (error) return <div className="req-banner err">{error}</div>;
  if (!rtm || !health) return <div className="doc-empty">{loading ? '加载中…' : 'RTM 数据初始化中…'}</div>;

  const nodes = new Set(rtm.rows.flatMap((r) => [r.r, ...r.cr, ...r.req, ...r.dsg]));
  const uncovered = rtm.rows.filter((r) => r.state === 'uncovered').length;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const kpis = [
    { key: 'L0a', label: 'L0a R→CR 承接率', value: pct(health.l0a), ok: health.l0a >= 0.95, note: '门槛 ≥95%（PRD 定稿门禁）' },
    { key: 'L0b', label: 'L0b CR→REQ 承接率', value: pct(health.l0b), ok: health.l0b === 1, note: '门槛 =100%（PRD 定稿门禁）' },
    { key: 'L0c', label: 'L0c REQ→DSG 锚点覆盖', value: pct(health.l0c), ok: health.l0c === 1, note: '门槛 =100%（开发入口门禁）' },
    { key: 'L0d', label: 'L0d deferred 计数', value: String(health.l0d), ok: true, note: '信息性指标，不进任何门禁公式' },
    { key: 'nodes', label: '节点统计', value: String(nodes.size), ok: true, note: 'R/CR/REQ/DSG 去重合计' },
    { key: 'gap', label: '未覆盖计数', value: String(uncovered), ok: uncovered === 0, note: 'R 维度未承接行数' },
  ];

  return (
    <div className="rtm-wrap">
      <div className="kpi-row">
        {kpis.map((k) => (
          <div key={k.key} className={`kpi-card${k.ok ? '' : ' bad'}`}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-note">{k.note}</div>
          </div>
        ))}
      </div>

      {health.gaps.length > 0 && (
        <div className="req-banner warn">
          ⚠ 缺口 {health.gaps.length} 项：{health.gaps.map((g) => `${g.target}（${g.message}）`).join('；')}
        </div>
      )}

      <div className="rtm-card">
        <div className="rtm-card-head">
          <strong>追溯链明细（R 维度）</strong>
          <button className="act" onClick={() => void refreshRtm()}>↻ 刷新</button>
        </div>
        <table className="rtm-table">
          <thead>
            <tr><th>R 客户需求</th><th>CR 承接条目</th><th>REQ 产品需求</th><th>DSG 设计锚点</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rtm.rows.map((row) => (
              <RtmRowView key={row.r} row={row} deferred={new Set(rtm.deferred)} onDefer={setDeferTarget} />
            ))}
            {rtm.rows.length === 0 && (
              <tr><td colSpan={6} className="mut">暂无 R 节点——CRD 中书写 R-xxx 锚点并提交版本后自动派生。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rtm-card">
        <div className="rtm-card-head"><strong>DSG 设计层节点（八册）</strong></div>
        <div className="dsg-grid">
          {DSG_VOLUMES.map((v) => {
            const registered = [...nodes].some((n) => n.startsWith(v.prefix));
            return (
              <div key={v.prefix} className={`dsg-card${registered ? ' reg' : ''}`}>
                <div className="dsg-prefix">{v.prefix}-*</div>
                <div className="dsg-name">{v.name}</div>
                <span className={`tag ${registered ? 'tag-ok' : ''}`}>{registered ? '已登记锚点' : '未登记'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rtm-card">
        <div className="rtm-card-head"><strong>门禁规则</strong></div>
        <ul className="gate-rules">
          <li>PRD 定稿门禁：L0a ≥ 95% 且 L0b = 100%（定稿时实时重算，不用缓存值放行）</li>
          <li>开发入口门禁：L0c = 100%（M4 开发域启用，本期信息展示）</li>
          <li>L0d 为信息性计数：deferred 条目不进入 L0a/L0b/L0c 分母，不允许借 deferred 藏缺口</li>
          <li>空分母记 100% 并告警；指纹基线随每次度量留痕（rtm_health append-only）</li>
        </ul>
        {health.warnings.length > 0 && <p className="pop-tip err">告警：{health.warnings.join('；')}</p>}
      </div>

      {deferTarget && <DeferModal target={deferTarget} onClose={() => setDeferTarget(null)} />}
    </div>
  );
}

function RtmRowView({
  row, deferred, onDefer,
}: {
  row: RtmRow;
  deferred: Set<string>;
  onDefer: (t: { kind: 'cr' | 'req'; code: string }) => void;
}) {
  const { projectId, refreshRtm } = useReqView();
  const [msg, setMsg] = useState<string | null>(null);
  const undefer = (kind: 'cr' | 'req', code: string) => {
    if (!projectId) return;
    setMsg(null);
    void reqApi.undefer(projectId, kind, code)
      .catch((e) => setMsg(e instanceof ApiError ? e.message : '操作失败'))
      .finally(() => void refreshRtm());
  };
  const nodeOps = (kind: 'cr' | 'req', code: string) =>
    deferred.has(code) ? (
      <button className="act mini" onClick={() => undefer(kind, code)}>撤销 deferred</button>
    ) : (
      <button className="act mini" title="标记暂缓（理由必填，记审计；不进 L0a/L0b/L0c 分母）" onClick={() => onDefer({ kind, code })}>标记 deferred</button>
    );
  return (
    <tr className={`state-${row.state}`}>
      <td><span className="rtm-node n-r">{row.r}</span></td>
      <td>
        {row.cr.map((c) => (
          <span key={c} className={`rtm-node n-cr${deferred.has(c) ? ' deferred' : ''}`}>{c}</span>
        ))}
        {row.cr.map((c) => <span key={`${c}-op`} className="node-op">{nodeOps('cr', c)}</span>)}
      </td>
      <td>
        {row.req.map((r) => (
          <span key={r} className={`rtm-node n-req${deferred.has(r) ? ' deferred' : ''}`}>{r}</span>
        ))}
        {row.req.map((r) => <span key={`${r}-op`} className="node-op">{nodeOps('req', r)}</span>)}
      </td>
      <td>{row.dsg.map((d) => <span key={d} className="rtm-node n-dsg">{d}</span>)}</td>
      <td><span className={`tag st-${row.state}`}>{STATE_LABEL[row.state]}</span>{msg && <div className="rsn err">{msg}</div>}</td>
      <td className="mut">{row.state === 'uncovered' ? '需在 CRD 增加 CR 承接条目' : ''}</td>
    </tr>
  );
}

/** deferred 标记弹窗（modal 二次确认 + 理由必填，记审计） */
function DeferModal({ target, onClose }: { target: { kind: 'cr' | 'req'; code: string }; onClose: () => void }) {
  const { projectId, refreshRtm } = useReqView();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const submit = () => {
    setMsg(null);
    void reqApi.defer(projectId, target.kind, target.code, reason)
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '标记失败'))
      .finally(() => void refreshRtm());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>标记 deferred：{target.code}</h3>
        <p className="pop-tip">
          deferred 条目以 L0d 单独计数展示，不进入 L0a/L0b/L0c 分母；标记留审计，可随时撤销。理由必填。
        </p>
        <textarea value={reason} rows={3} placeholder="暂缓理由（必填）" onChange={(e) => setReason(e.target.value)} />
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={!reason.trim()} onClick={submit}>确认标记</button>
        </div>
      </div>
    </div>
  );
}
