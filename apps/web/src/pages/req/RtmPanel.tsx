import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { reqApi, type RtmRow } from './api';
import { useReqView } from './store';

/** DSG 设计层八册节点卡（§3.3 + DSG-U06-23：h/o/g/k/d/a/u/n 共 8 类 + 登记状态；登记=RTM 中出现该册前缀锚点） */
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
  deferred: 'deferred',
};

/** RTM 工作面（LLD-6 §3.3：标题说明 + 六 KPI 卡 + 明细表四色节点 + DSG 八册卡 + 门禁规则卡） */
export function RtmPanel() {
  const { rtm, health, loading, error, refreshRtm, projectId } = useReqView();
  const [deferTarget, setDeferTarget] = useState<{ kind: 'cr' | 'req'; code: string } | null>(null);
  const [undeferTarget, setUndeferTarget] = useState<{ kind: 'cr' | 'req'; code: string } | null>(null);
  const [trace, setTrace] = useState<{ row: RtmRow; node: string } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [rtmBusy, setRtmBusy] = useState(false);
  const [fixNote, setFixNote] = useState<string | null>(null);

  /** 覆盖闭环①：重建映射并即时拿覆盖结论（定稿后按新文档手动重建入口） */
  const onRebuildCheck = async () => {
    if (!projectId || rtmBusy) return;
    setRtmBusy(true);
    try {
      const h = await reqApi.rebuildCheck(projectId);
      await refreshRtm();
      toast(
        h.ok && h.gaps.length === 0
          ? `✅ 映射已重建，覆盖检查通过（L0a ${(h.l0a * 100).toFixed(1)}% / L0b ${(h.l0b * 100).toFixed(1)}% / L0c ${(h.l0c * 100).toFixed(1)}%）`
          : `⚠ 映射已重建，仍有 ${h.gaps.length} 条缺口——可用「✨ AI 补齐缺口」形成解决闭环`,
        h.ok && h.gaps.length === 0 ? 'success' : 'warn',
      );
    } catch (e) {
      toast(`重建失败：${e instanceof ApiError ? e.message : String(e)}`, 'warn');
    } finally {
      setRtmBusy(false);
    }
  };

  /** 覆盖闭环②：按缺口清单向 CRD/PRD 提案定向补齐（人工确认→提交→再检查即转绿）。
   *  实机教训（2026-10-06 用户反馈「点了没用」）：真模型需 1~3 分钟——必须给常驻进度提示，
   *  且完成后广播 msf:req-proposed 复用需求页回环（自动切到目标文档+刷新补丁高亮），
   *  否则补丁悄悄落在 CRD/PRD 页、RTM 页上毫无可见变化 */
  const onCoverageFix = async () => {
    if (!projectId || rtmBusy) return;
    setRtmBusy(true);
    setFixNote('AI 正在按缺口清单生成补齐建议……真模型约需 1~3 分钟，完成后会自动跳到对应文档页并高亮补丁');
    try {
      const r = await reqApi.coverageFix(projectId);
      if (r.results.length === 0) {
        toast('覆盖检查已通过，无缺口需补齐', 'success');
        return;
      }
      for (const it of r.results) {
        if (it.ok) {
          // 回环：与 dock 提案同通道（req store 监听→切页签+重拉+常驻 toast）
          window.dispatchEvent(new CustomEvent('msf:req-proposed', { detail: { kind: it.kind } }));
        }
        toast(
          it.ok
            ? `${it.kind.toUpperCase()}：已提交 ${it.patchCount} 条补齐建议——确认补丁 → 提交版本 → 回此再检查`
            : `${it.kind.toUpperCase()}：${it.reason}`,
          it.ok ? 'success' : 'warn',
        );
      }
    } catch (e) {
      toast(`补齐失败：${e instanceof ApiError ? e.message : String(e)}`, 'warn');
    } finally {
      setRtmBusy(false);
      setFixNote(null);
    }
  };

  // R5：任务卡 REQ 锚点跳入承接（devJumpRtm → /req?tab=rtm#REQ-xxx），定位行并闪高亮
  useEffect(() => {
    if (!rtm) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const row = rtm.rows.find((r) => [r.r, ...r.cr, ...r.req, ...r.dsg].includes(hash));
    if (!row) return;
    const el = document.getElementById(`rtm-${row.r}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlash(row.r);
    const t = setTimeout(() => setFlash(null), 2400);
    return () => clearTimeout(t);
  }, [rtm]);

  if (error) return <div className="req-banner err">{error}</div>;
  if (!rtm || !health) return <div className="doc-empty">{loading ? '加载中…' : 'RTM 数据初始化中…'}</div>;

  const deferredSet = new Set(rtm.deferred);
  const countBy = (pick: (r: RtmRow) => string[]) => new Set(rtm.rows.flatMap(pick)).size;
  const registeredDsg = DSG_VOLUMES.filter((v) =>
    rtm.rows.some((r) => r.dsg.some((d) => d.startsWith(v.prefix))),
  ).length;
  const uncovered = rtm.rows.filter((r) => r.state === 'uncovered').length;
  const l0cGaps = health.gaps.filter((g) => g.code === 'L0C_BELOW').map((g) => g.target);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

  const kpis: Array<{ key: string; label: string; value: string; ok: boolean; note: string; ops?: ReactNode }> = [
    { key: 'L0a', label: 'L0a 承接率（R→CR）', value: pct(health.l0a), ok: health.l0a >= health.thresholds.l0a, note: `门禁 ≥ 95% · ${health.l0a >= health.thresholds.l0a ? '通过' : '未达标'}` },
    { key: 'L0b', label: 'L0b 承接率（CR→REQ）', value: pct(health.l0b), ok: health.l0b >= health.thresholds.l0b, note: `门禁 = 100% · ${health.l0b >= health.thresholds.l0b ? '通过' : '未达标'}` },
    {
      key: 'L0c', label: 'L0c REQ→DSG 锚点覆盖率 · 开发入口门禁', value: pct(health.l0c), ok: health.l0c >= health.thresholds.l0c,
      note: health.l0c >= health.thresholds.l0c
        ? `全部承接${health.l0d > 0 ? `（${health.l0d} 个节点已 deferred 排除出分母）` : ''} · 通过`
        : `${l0cGaps.join('、') || '—'} 缺设计承接`,
      // §3.3：缺口 REQ 行内带「标记 deferred」操作钮，已 deferred 的带撤销钮
      ops: l0cGaps.length > 0 || health.l0d > 0 ? (
        <div className="kpi-ops">
          {l0cGaps.map((c) => (
            <button key={c} className="act mini" title="显式标记暂缓（记审计，排除出分母）" onClick={() => setDeferTarget({ kind: 'req', code: c })}>
              ⏸ 标记 {c} deferred
            </button>
          ))}
          {rtm.deferred.filter((c) => c.startsWith('REQ-')).map((c) => (
            <button key={c} className="act mini" title="撤销后重新计入分母（记审计）" onClick={() => setUndeferTarget({ kind: 'req', code: c })}>
              ↩ 撤销 {c} deferred
            </button>
          ))}
        </div>
      ) : undefined,
    },
    { key: 'L0d', label: 'L0d deferred 计数', value: String(health.l0d), ok: true, note: '信息性指标，不进入任何门禁公式' },
    { key: 'nodes', label: '节点', value: `${countBy((r) => [r.r])} R / ${countBy((r) => r.cr)} CR / ${countBy((r) => r.req)} REQ`, ok: true, note: `DSG ${registeredDsg}/8 册已登记` },
    { key: 'gap', label: '未覆盖（需显式标记）', value: String(uncovered), ok: uncovered === 0, note: uncovered === 0 ? '均已承接或显式 deferred' : 'R 维度未承接行数' },
  ];

  return (
    <div className="rtm-wrap">
      <h2 className="pgt">🔗 需求矩阵 RTM</h2>
      <p className="pgd">
        R（原始诉求）← CR（客户需求）← REQ（产品需求）refines 链 + DSG（设计工件）implements 层 · 定稿时门禁校验
      </p>

      <div className="kpi-row">
        {kpis.map((k) => (
          <div key={k.key} className={`kpi-card${k.ok ? '' : ' bad'}`}>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-value">{k.value}</div>
            <div className="kpi-note">{k.note}</div>
            {k.ops}
          </div>
        ))}
      </div>

      {fixNote && (
        <div className="req-banner">⏳ {fixNote}</div>
      )}

      {health.gaps.length > 0 && (
        <div className="req-banner warn">
          ⚠ 缺口 {health.gaps.length} 项：{health.gaps.map((g) => `${g.target}（${g.message}）`).join('；')}
          {health.gaps.some((g) => g.code === 'L0A_BELOW' || g.code === 'RTM_HEALTH') && (
            <button
              className="act mini primary"
              disabled={rtmBusy}
              title="按缺口清单向 CRD/PRD 定向提案补齐（高亮补丁）：确认补丁 → 提交版本 → 回此再检查，即形成解决闭环；已定稿文档会引导先解锁"
              onClick={() => void onCoverageFix()}
            >
              ✨ AI 补齐缺口
            </button>
          )}
        </div>
      )}

      <div className="rtm-card">
        <div className="rtm-card-head">
          <strong>追溯链明细</strong>
          <span>
            <button
              className="act"
              disabled={rtmBusy}
              title="按当前 CRD/PRD/设计册已提交版本重建锚点映射，并即时给出覆盖检查结论（定稿后核对称手）"
              onClick={() => void onRebuildCheck()}
            >
              ⟳ 重建映射并检查覆盖
            </button>
            <button className="act" onClick={() => void refreshRtm()}>↻ 刷新</button>
          </span>
        </div>
        <table className="rtm-table">
          <thead>
            <tr><th>原始诉求 R</th><th>客户需求 CR</th><th>产品需求 REQ</th><th>设计 DSG（implements）</th><th>状态</th><th>操作</th></tr>
          </thead>
          <tbody>
            {rtm.rows.map((row) => (
              <RtmRowView
                key={row.r}
                row={row}
                deferred={deferredSet}
                flash={flash === row.r}
                onDefer={setDeferTarget}
                onUndefer={setUndeferTarget}
                onTrace={(node) => setTrace({ row, node })}
              />
            ))}
            {rtm.rows.length === 0 && (
              <tr><td colSpan={6} className="mut">暂无 R 节点——CRD 中书写 R-xxx 锚点并提交版本后自动派生。</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rtm-card">
        <div className="rtm-card-head"><strong>设计层节点 DSG-*（每份定稿工件各登记一个）</strong></div>
        <div className="dsg-grid">
          {DSG_VOLUMES.map((v) => {
            const registered = rtm.rows.some((r) => r.dsg.some((d) => d.startsWith(v.prefix)));
            return (
              <div key={v.prefix} className={`dsg-card${registered ? ' reg' : ''}`}>
                <div className="dsg-prefix">{v.prefix}-*</div>
                <div className="dsg-name">{v.name}</div>
                <span className={`tag ${registered ? 'tag-ok' : ''}`}>{registered ? '已登记' : '未定稿'}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rtm-card">
        <div className="rtm-card-head"><strong>门禁规则</strong></div>
        <ul className="gate-rules">
          <li>进入设计阶段：L0a（R→CR）≥ 0.95 且 L0b（CR→REQ）= 1.00，定稿时实时重算（REQ-208）</li>
          <li>开发入口门禁（REQ-310）：PRD + 概要 + 详细七册全部定稿，且 L0c（REQ→DSG）= 100%</li>
          <li>未覆盖项必须显式标记 deferred 或 dropped，不允许静默丢失；deferred 以 L0d 单独计数，不进入 L0a/L0b/L0c 分母</li>
          <li>空分母记 100% 并告警；指纹基线随每次度量留痕（rtm_health append-only）</li>
        </ul>
        {health.warnings.length > 0 && <p className="pop-tip err">告警：{health.warnings.join('；')}</p>}
      </div>

      {deferTarget && <DeferModal target={deferTarget} onClose={() => setDeferTarget(null)} />}
      {undeferTarget && <UndeferModal target={undeferTarget} onClose={() => setUndeferTarget(null)} />}
      {trace && <TraceModal row={trace.row} node={trace.node} deferred={deferredSet} onClose={() => setTrace(null)} />}
    </div>
  );
}

/** R5 追溯弹窗：节点点击 → 该 R 行全链追溯视图（R→CR→REQ→DSG 四色链） */
function TraceModal({
  row, node, deferred, onClose,
}: {
  row: RtmRow; node: string; deferred: Set<string>; onClose: () => void;
}) {
  return (
    <Modal title={`🔗 追溯：${node}`} onClose={onClose}>
      <div className="trace-chain">
        <div className="trace-col">
          <div className="trace-head">原始诉求 R</div>
          <span className={`rtm-node n-r${node === row.r ? ' hit' : ''}`}>{row.r}</span>
        </div>
        <div className="trace-arrow">→</div>
        <div className="trace-col">
          <div className="trace-head">客户需求 CR</div>
          {row.cr.length > 0
            ? row.cr.map((c) => (
                <span key={c} className={`rtm-node n-cr${node === c ? ' hit' : ''}${deferred.has(c) ? ' deferred' : ''}`}>{c}</span>
              ))
            : <span className="mut">未承接</span>}
        </div>
        <div className="trace-arrow">→</div>
        <div className="trace-col">
          <div className="trace-head">产品需求 REQ</div>
          {row.req.length > 0
            ? row.req.map((r) => (
                <span key={r} className={`rtm-node n-req${node === r ? ' hit' : ''}${deferred.has(r) ? ' deferred' : ''}`}>{r}</span>
              ))
            : <span className="mut">未拆解</span>}
        </div>
        <div className="trace-arrow">→</div>
        <div className="trace-col">
          <div className="trace-head">设计 DSG（implements）</div>
          {row.dsg.length > 0
            ? row.dsg.map((d, i) => (
                <span key={`${d}-${i}`} className={`rtm-node n-dsg${node === d ? ' hit' : ''}`}>{d}</span>
              ))
            : <span className="mut">未登记</span>}
        </div>
      </div>
      <p className="pop-tip" style={{ marginTop: 10 }}>
        行状态：{STATE_LABEL[row.state]}；deferred 条目不进入 L0a/L0b/L0c 分母。
      </p>
    </Modal>
  );
}

function RtmRowView({
  row, deferred, flash, onDefer, onUndefer, onTrace,
}: {
  row: RtmRow;
  deferred: Set<string>;
  flash: boolean;
  onDefer: (t: { kind: 'cr' | 'req'; code: string }) => void;
  onUndefer: (t: { kind: 'cr' | 'req'; code: string }) => void;
  onTrace: (node: string) => void;
}) {
  const nodeOps = (kind: 'cr' | 'req', code: string) =>
    deferred.has(code) ? (
      <button className="act mini" title="撤销后重新计入分母（记审计）" onClick={() => onUndefer({ kind, code })}>撤销 deferred</button>
    ) : (
      <button className="act mini" title="标记暂缓（理由必填，记审计；不进 L0a/L0b/L0c 分母）" onClick={() => onDefer({ kind, code })}>标记 deferred</button>
    );
  return (
    <tr id={`rtm-${row.r}`} className={`state-${row.state}${flash ? ' row-flash' : ''}`}>
      <td>
        <button className="rtm-node n-r" title="点击追溯全链" onClick={() => onTrace(row.r)}>{row.r}</button>
      </td>
      <td>
        {row.cr.map((c) => (
          <button key={c} className={`rtm-node n-cr${deferred.has(c) ? ' deferred' : ''}`} title="点击追溯全链" onClick={() => onTrace(c)}>{c}</button>
        ))}
        {row.cr.map((c) => <span key={`${c}-op`} className="node-op">{nodeOps('cr', c)}</span>)}
      </td>
      <td>
        {row.req.map((r) => (
          <button key={r} className={`rtm-node n-req${deferred.has(r) ? ' deferred' : ''}`} title="点击追溯全链" onClick={() => onTrace(r)}>{r}</button>
        ))}
        {row.req.map((r) => <span key={`${r}-op`} className="node-op">{nodeOps('req', r)}</span>)}
      </td>
      <td>{row.dsg.map((d, i) => <button key={`${d}-${i}`} className="rtm-node n-dsg" title="点击追溯全链" onClick={() => onTrace(d)}>{d}</button>)}</td>
      <td><span className={`tag st-${row.state}`}>{STATE_LABEL[row.state]}</span></td>
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

/** 撤销 deferred 二次确认（LLD-6 §3.3：撤销记审计、modal 确认；明示重新计入分母的后果） */
function UndeferModal({ target, onClose }: { target: { kind: 'cr' | 'req'; code: string }; onClose: () => void }) {
  const { projectId, refreshRtm } = useReqView();
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const submit = () => {
    setMsg(null);
    void reqApi.undefer(projectId, target.kind, target.code)
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refreshRtm());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>撤销 {target.code} 的 deferred</h3>
        <p className="pop-tip">
          撤销后该条目重新计入 L0a/L0b/L0c 分母：若仍未被承接，对应覆盖率将下降、相关门禁转为未达标。撤销留审计。
        </p>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" onClick={submit}>确认撤销</button>
        </div>
      </div>
    </div>
  );
}
