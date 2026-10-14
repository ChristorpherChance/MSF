import { useEffect, useState } from 'react';
import {
  ApiError, streamRefresh, structuralIssueCount, templateRefreshApi,
  type RefreshFrame, type RefreshPreflightItem,
} from '../api';
import { KIND_LABELS } from '../pages/platform/DocTemplatesGroup';
import { Modal } from './Modal';
import { toast } from './toast';
import './ui.css';

/**
 * ⇄ 模板重排弹窗（三态：选册 → 进行中 → 汇总；样机 .tmp/template-refresh-mock.html 用户过目版）。
 * 只产 pending「整篇重写」提案，逐册人工确认才生效（确认语义不破）；
 * 每册完成即广播 msf:req-proposed / msf:dsg-proposed，开着的页面补丁区自刷新（边产边确认）。
 */

/** 会话内活动批次记忆：「后台运行」关窗不中断服务端批次，重开弹窗恢复进度订阅（流端点全量重放） */
let activeOp: { pid: string; opId: string } | null = null;

type Phase = 'select' | 'run' | 'done';
type RowSt = 'queue' | 'running' | 'done' | 'failed' | 'skipped';
interface RowState {
  st: RowSt;
  reason?: string | undefined;
  patchCount?: number | undefined;
  domain?: 'req' | 'design' | undefined;
}

const KIND_ORDER = Object.keys(KIND_LABELS);
const runnable = (it: RefreshPreflightItem) => it.hasContent && !it.finalized && it.pending === 0;
const skipReason = (it: RefreshPreflightItem) =>
  !it.hasContent ? '未生成 · 将跳过'
    : it.finalized ? '已定稿 · 将跳过'
      : it.pending > 0 ? `待确认补丁 ×${it.pending} · 将跳过`
        : null;
const inferDomain = (kind: string): 'req' | 'design' => (kind === 'crd' || kind === 'prd' ? 'req' : 'design');
const fmtElapsed = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;

export function TemplateRefreshModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const resumed = activeOp?.pid === projectId;
  const [phase, setPhase] = useState<Phase>(resumed ? 'run' : 'select');
  const [items, setItems] = useState<RefreshPreflightItem[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [opId, setOpId] = useState<string | null>(resumed ? activeOp!.opId : null);
  const [batchKinds, setBatchKinds] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [summary, setSummary] = useState<{ done: number; failed: number; skipped: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()); // 问题明细展开的册（纯本地态，无新端点）

  // 打开即预检（选册数据；恢复订阅时同样加载，供域/名称参照）
  useEffect(() => {
    let live = true;
    templateRefreshApi.preflight(projectId)
      .then((its) => {
        if (!live) return;
        setItems(its);
        // 默认勾选 = 可跑 且 结构三维有问题（剔除上游滞后行——仅滞后的册不默认勾，规格 §3 软闸）
        setChecked(new Set(its.filter((i) => runnable(i) && i.report !== null && structuralIssueCount(i.report) > 0).map((i) => i.kind)));
      })
      .catch((e) => { if (live) setErr(e instanceof ApiError ? e.message : '预检加载失败'); });
    return () => { live = false; };
  }, [projectId]);

  // SSE 订阅（deps 不含 phase——refresh.done 切相位若重连，无 lastEventId 会全量重放致 kind.done 重复派发；
  // select 相位 opId 恒 null，opId 仅在新批次/重试时变化；卸载 AbortController 断流，服务端批次照跑）
  useEffect(() => {
    if (!opId) return;
    const ctrl = new AbortController();
    const note = (k: string) => setBatchKinds((ks) => (ks.includes(k) ? ks : [...ks, k]));
    const onFrame = (f: RefreshFrame) => {
      switch (f.type) {
        case 'refresh.kind.started': {
          const k = f.kind;
          if (!k) break;
          note(k);
          setRows((r) => ({ ...r, [k]: { st: 'running', domain: f.domain ?? r[k]?.domain } }));
          break;
        }
        case 'refresh.kind.done': {
          const k = f.kind;
          if (!k) break;
          note(k);
          const domain = f.domain ?? inferDomain(k);
          setRows((r) => ({ ...r, [k]: { st: 'done', patchCount: f.patchCount, domain } }));
          // 开着的页面补丁区自刷新（与 dock 提案回环同事件口径）
          window.dispatchEvent(new CustomEvent(domain === 'design' ? 'msf:dsg-proposed' : 'msf:req-proposed', { detail: { kind: k } }));
          break;
        }
        case 'refresh.kind.failed': {
          const k = f.kind;
          if (!k) break;
          note(k);
          setRows((r) => ({ ...r, [k]: { st: 'failed', reason: f.reason, domain: f.domain ?? r[k]?.domain } }));
          break;
        }
        case 'refresh.kind.skipped': {
          const k = f.kind;
          if (!k) break;
          note(k);
          setRows((r) => ({ ...r, [k]: { st: 'skipped', reason: f.reason, domain: f.domain ?? r[k]?.domain } }));
          break;
        }
        case 'refresh.done':
          setSummary(f.summary ?? null);
          setPhase('done');
          if (activeOp?.opId === opId) activeOp = null;
          break;
        default:
          break; // 帧闭集纪律：未知帧忽略，不得当错误（差异登记条目 37）
      }
    };
    void streamRefresh(projectId, opId, onFrame, ctrl.signal).catch((e) => {
      if (ctrl.signal.aborted) return;
      // 批次失效逃逸口（服务端 ops 为内存态：部署重启后流 404）——清会话记忆退回选册相位，不留 404 死循环
      if (activeOp?.opId === opId) activeOp = null;
      setOpId(null);
      setPhase('select');
      toast(e instanceof ApiError ? e.message : '进度流中断', 'warn');
    });
    return () => ctrl.abort();
  }, [opId, projectId]);

  // 进行秒表（仅 run 相位走针；done 定格）
  useEffect(() => {
    if (phase !== 'run') return;
    const t0 = Date.now() - elapsed * 1000;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(t);
  }, [phase, opId]);

  const startBatch = async (kinds: string[]) => {
    if (starting) return; // 防连点（服务端并发闸兜底，但不在途重发）
    setStarting(true);
    setErr(null);
    try {
      const r = await templateRefreshApi.start(projectId, kinds);
      activeOp = { pid: projectId, opId: r.operationId };
      setOpId(r.operationId);
      setBatchKinds(kinds);
      setRows(Object.fromEntries(kinds.map((k) => [k, { st: 'queue' as RowSt }])));
      setSummary(null);
      setElapsed(0);
      setPhase('run');
    } catch (e) {
      // INVALID_STATE（并发闸）等一律人话 toast
      toast(e instanceof ApiError ? e.message : '启动失败', 'warn');
    } finally {
      setStarting(false);
    }
  };

  const stopBatch = async () => {
    if (!opId) return;
    try {
      await templateRefreshApi.stop(projectId, opId);
      toast('已请求停止：当前册跑完后，剩余册将标记跳过');
    } catch (e) {
      // 批次已消亡（404：服务端重启/已终结）——清记忆退回选册，不再钉死在进度相位
      if (e instanceof ApiError && e.status === 404) {
        if (activeOp?.opId === opId) activeOp = null;
        setOpId(null);
        setPhase('select');
        toast(e.message, 'warn');
      } else {
        toast(e instanceof ApiError ? e.message : '停止失败', 'warn');
      }
    }
  };

  const toggle = (k: string, on: boolean) =>
    setChecked((s) => {
      const n = new Set(s);
      if (on) n.add(k);
      else n.delete(k);
      return n;
    });

  const toggleExpanded = (k: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const goConfirm = (k: string) => {
    const domain = rows[k]?.domain ?? items?.find((i) => i.kind === k)?.domain ?? inferDomain(k);
    window.dispatchEvent(new CustomEvent(domain === 'design' ? 'msf:dsg-proposed' : 'msf:req-proposed', { detail: { kind: k } }));
    onClose(); // 页面回环自动切到目标册并高亮补丁；批次在后台继续
  };

  /* —— 选册相位 —— */
  const renderSelect = () => {
    const groups: Array<{ label: string; list: RefreshPreflightItem[] }> = [
      { label: '需求域', list: (items ?? []).filter((i) => i.domain === 'req') },
      { label: '设计域', list: (items ?? []).filter((i) => i.domain === 'design') },
    ];
    for (const g of groups) g.list.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
    return (
      <>
        <p className="trefresh-sub">
          以当前全文为基线、按当前生效模板骨架重排大章（内容语义不变，锚点码与编号保留）。
          每册产一条「整篇重写」提案，<b>经你逐册确认后才生效</b>。已定稿 / 有待确认补丁 / 未生成的册会自动跳过。
          规则核对明细（大章/锚点码/编号/上游滞后四维）——最终以你的判断为准。
        </p>
        {err && <p className="trefresh-sub trefresh-err">{err}</p>}
        {items === null && !err && <p className="trefresh-sub">预检加载中…</p>}
        {groups.map((g) => g.list.length > 0 && (
          <div key={g.label}>
            <div className="trefresh-grp">{g.label}</div>
            <div className="trefresh-kinds">
              {g.list.map((it) => {
                const ok = runnable(it);
                const skip = skipReason(it);
                const open = expanded.has(it.kind);
                return (
                  <div key={it.kind} className={`trefresh-item${open ? ' open' : ''}`}>
                    <label className={ok ? '' : 'off'}>
                      <input
                        type="checkbox"
                        disabled={!ok}
                        checked={ok && checked.has(it.kind)}
                        onChange={(e) => toggle(it.kind, e.target.checked)}
                      />
                      {KIND_LABELS[it.kind] ?? it.kind}
                      {ok && it.report !== null && (
                        it.report.issues.length > 0 ? (
                          // ⚠ 徽标可点：切换问题明细展开（preventDefault 防 label 联动勾选框）
                          <button
                            type="button"
                            className="tag tag-warn trefresh-tagbtn"
                            aria-expanded={open}
                            title="点击展开/收起核对明细"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleExpanded(it.kind); }}
                          >
                            ⚠ {it.report.issues.length} 项问题
                          </button>
                        ) : (
                          // ✓ 对版软闸：默认不勾选，仍可手动勾（toggle 逻辑天然支持）
                          <span className="tag tag-ok">✓ 与模板一致</span>
                        )
                      )}
                      {!ok && skip && <span className="tag">{skip}</span>}
                    </label>
                    {open && ok && it.report !== null && it.report.issues.length > 0 && (
                      <ul className="trefresh-issues">
                        {it.report.issues.map((s, idx) => <li key={idx}>{s}</li>)}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </>
    );
  };

  /* —— 进行中 / 汇总相位 —— */
  const renderRun = () => {
    const finished = batchKinds.filter((k) => rows[k] && rows[k]!.st !== 'queue' && rows[k]!.st !== 'running').length;
    return (
      <>
        {resumed && phase === 'run' && (
          <div className="trefresh-note">检测到本会话有进行中的批次，已恢复进度订阅（服务端批次未中断）。</div>
        )}
        <div className="trefresh-head">
          {phase === 'run' ? '⇄ 模板重排进行中' : '⇄ 模板重排完成'}
          {phase === 'run' ? <span className="tag tag-info">批次运行中</span> : <span className="tag tag-ok">批次结束</span>}
          <span className="elapsed">
            {phase === 'run' ? `⏱ ${fmtElapsed(elapsed)} · 完成 ${finished}/${batchKinds.length}` : `共 ${fmtElapsed(elapsed)}`}
          </span>
        </div>
        {err && <p className="trefresh-sub trefresh-err">{err}</p>}
        <div className="trefresh-rows">
          {batchKinds.map((k) => {
            const row = rows[k] ?? { st: 'queue' as RowSt };
            return (
              <div key={k} className="trefresh-row">
                <span className="nm">{KIND_LABELS[k] ?? k}</span>
                <span className="kd">{k}</span>
                {row.st === 'queue' && <span className="tag">排队中</span>}
                {row.st === 'running' && <span className="tag tag-info"><span className="trefresh-spin" />生成中</span>}
                {row.st === 'done' && <span className="tag tag-ok">✓ 提案已出</span>}
                {row.st === 'failed' && <span className="tag tag-err">✗ 失败</span>}
                {row.st === 'skipped' && <span className="tag">⊘ 跳过</span>}
                <span className="rs">
                  {row.st === 'running' && '整篇重写调用中（约需数分钟）…'}
                  {row.st === 'done' && `${row.patchCount ?? 1} 条「整篇重写」待确认`}
                  {(row.st === 'failed' || row.st === 'skipped') && (row.reason ?? '')}
                </span>
                {row.st === 'done' && <button className="trefresh-go" onClick={() => goConfirm(k)}>去确认 »</button>}
                {row.st === 'failed' && phase === 'done' && (
                  <button className="trefresh-go" onClick={() => void startBatch([k])}>重试该册 »</button>
                )}
              </div>
            );
          })}
        </div>
        {phase === 'done' && summary && (
          <div className="trefresh-sum">
            汇总：提案已出 <b>{summary.done}</b> 册 · 跳过 <b>{summary.skipped}</b> 册 · 失败 <b>{summary.failed}</b> 册。<br />
            提示：提案逐册确认后，请回 <b>设计页重新确认基线</b>（下游已按变更自动标滞后）。
          </div>
        )}
      </>
    );
  };

  return (
    <Modal
      title="⇄ 按模板骨架重排文档"
      onClose={onClose}
      size="wide"
      footer={
        phase === 'select' ? (
          <>
            <span className="trefresh-foot-note">已选 {checked.size} 册 · 每册约需数分钟（逐册生成，可边产边确认）</span>
            <button className="act" onClick={onClose}>取消</button>
            <button
              className="act primary"
              disabled={checked.size === 0 || starting}
              onClick={() => void startBatch([...checked].sort((a, b) => KIND_ORDER.indexOf(a) - KIND_ORDER.indexOf(b)))}
            >
              开始重排
            </button>
          </>
        ) : phase === 'run' ? (
          <>
            <button className="act" onClick={() => void stopBatch()}>⏹ 停止剩余</button>
            <button className="act primary" title="关闭面板不中断服务端批次；重开入口可恢复进度" onClick={onClose}>后台运行</button>
          </>
        ) : (
          <button className="act primary" onClick={onClose}>关闭</button>
        )
      }
    >
      {phase === 'select' ? renderSelect() : renderRun()}
    </Modal>
  );
}
