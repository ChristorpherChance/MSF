import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { designApi, type BaselineItem, type CatalogGroup, type ProtoStatus } from './api';
import { useDesignView } from './store';

/**
 * 原型 UI 工作台（LLD-6 §3.4 V19：命令条四步门禁+导出基线 → KPI 三格（当前结论/需关注/下一步）
 * → 预览 iframe（sandbox，.v19-statebar 选页选态 postMessage 切换不重载）→ 问题列表+基线横幅+追溯 details → 目录/基线）。
 * mock 口径：HTML 由目录驱动生成（M6 真接）；预览用签名 URL + sandbox iframe。
 */
export function PrototypePanel() {
  const { projectId, proto, catalog, loading, error, refreshProto } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [pages_, setSel] = useState<{ pageId: string; stateId: string | null } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewVer, setPreviewVer] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [verOpen, setVerOpen] = useState(false);
  const [finOpen, setFinOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const baselines = useBaselines(projectId, proto?.status ?? null);
  const protoVers = useProtoVersions(projectId, proto?.prototype?.currentVersionId ?? null);

  const pages = (catalog?.groups.page ?? []) as CatalogGroup[];
  const states = (catalog?.groups.state ?? []) as CatalogGroup[];
  const selPage = pages_?.pageId ?? pages[0]?.code ?? null;
  const selState = pages_?.stateId ?? states[0]?.code ?? null;
  const verId = proto?.prototype?.currentVersionId ?? null;

  // 版本切换时重取预览 URL（同版本内选页选态走 postMessage，不重载 iframe）
  useEffect(() => {
    setPreviewUrl(null);
    setPreviewVer(null);
  }, [verId]);
  useEffect(() => {
    if (!projectId || !selPage || !verId || previewVer === verId) return;
    let dead = false;
    designApi.preview(projectId, selPage)
      .then((r) => { if (!dead) { setPreviewUrl(r.previewUrl); setPreviewVer(verId); } })
      .catch((e) => { if (!dead) setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '预览加载失败'); });
    return () => { dead = true; };
  }, [projectId, selPage, verId, previewVer]);

  /** S3（DSG-U04-2）：选页选态 → postMessage {type:'v19-prototype-select'}，iframe 不重载 */
  const select = (pageId: string, stateId: string | null) => {
    setSel({ pageId, stateId });
    iframeRef.current?.contentWindow?.postMessage({ type: 'v19-prototype-select', pageId, stateId }, '*');
  };

  if (error) return <div className="req-banner err">{error}</div>;
  if (!proto) return <div className="doc-empty">{loading ? '加载中…' : '原型工作台初始化中…'}</div>;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusyLabel(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const issues = (e as ApiError & { issues?: unknown[] }).issues;
      setMsg(e instanceof ApiError ? `${e.code}: ${e.message}${issues ? `（${JSON.stringify(issues)}）` : ''}` : '操作失败');
    } finally {
      setBusyLabel(null);
      void refreshProto();
    }
  };
  const currentBaseline = baselines.items?.find((b) => b.current) ?? null;
  const curVerNo = protoVers?.find((v) => v.versionId === verId)?.v ?? null;

  return (
    <div className="proto-wrap">
      <CommandBar
        proto={proto} busy={busyLabel !== null} run={run}
        currentBaseline={currentBaseline}
        onOpenVersions={() => setVerOpen(true)}
        onFinalize={() => setFinOpen(true)}
      />
      {/* D15（原型口径）：四步操作进行中横幅（role=status，持续可见） */}
      {busyLabel && (
        <div className="req-banner warn" role="status" style={{ margin: '8px 0 0' }}>{busyLabel}</div>
      )}
      {msg && <div className="req-banner err" style={{ margin: '8px 0 0' }}>{msg}</div>}
      {proto.plan?.stale && (
        <div className="req-banner warn" style={{ margin: '8px 0 0' }}>
          ⚠ PLAN_STALE · 规划依据（上游定稿）已变化，须重新规划。
        </div>
      )}
      {/* D14（原型口径）：基线定稿后引导进入开发 */}
      {proto.status === 'finalized' && currentBaseline?.valid && (
        <div className="req-banner ok" style={{ margin: '8px 0 0' }}>
          <b>设计基线已定稿，下一步进入开发核对输入并准备计划。</b>
          {' '}<a className="act" href="/dev">进入开发准备计划</a>
        </div>
      )}
      {/* S4 KPI 三格：当前结论 / 需关注 / 下一步 */}
      <KpiRow proto={proto} pageCount={pages.length} flowCount={(catalog?.groups.flow ?? []).length} />

      <div className="proto-main">
        <aside className="proto-pages" data-testid="prototype-page-list">
          <div className="toc-title">客户原型范围 <span className="tag">{pages.length} 页</span></div>
          {pages.map((p) => (
            <button
              key={p.code}
              className={`toc-item${selPage === p.code ? ' sel' : ''}`}
              onClick={() => select(p.code, selState)}
            >
              ▦ {(p.payload.title as string) ?? p.code}
              <span className="mut" style={{ display: 'block', fontSize: 11 }}>{p.code}</span>
            </button>
          ))}
          {pages.length === 0 && <p className="pop-tip">规划后生成页面清单。</p>}
          <div className="book-col-foot">
            期望目录与实际 HTML 独立检查 · {(catalog?.groups.flow ?? []).length} 流程 · {(catalog?.groups.viewport ?? []).length} 视口
          </div>
        </aside>
        <div className="proto-preview">
          {verId ? (
            <>
              {/* S3 .v19-statebar：状态切换钮（postMessage 选页选态，不重载） */}
              {states.length > 0 && (
                <div className="v19-statebar">
                  {states.map((s) => (
                    <button
                      key={s.code}
                      className={`act${selState === s.code ? ' primary' : ''}`}
                      onClick={() => selPage && select(selPage, s.code)}
                    >
                      {(s.payload.title as string) ?? s.code}
                    </button>
                  ))}
                </div>
              )}
              {previewUrl ? (
                <iframe
                  key={verId}
                  ref={iframeRef}
                  title="原型预览"
                  sandbox="allow-scripts"
                  src={previewUrl}
                  className="proto-iframe"
                  onLoad={() => selPage && iframeRef.current?.contentWindow?.postMessage(
                    { type: 'v19-prototype-select', pageId: selPage, stateId: selState }, '*')}
                />
              ) : (
                <div className="doc-empty">预览加载中…（sandbox 隔离 iframe + 签名 URL，A05-8）</div>
              )}
            </>
          ) : (
            /* S6 空态：尚未生成客户原型（生成走命令条 ①②；上传=人工初稿入同一套检查） */
            <div className="v19-empty">
              <div>🖼️</div>
              <b>尚未生成客户原型</b>
              <p>先让 AI 识别完整页面、流程、状态与来源（命令条 ① 识别规划 → ② 生成完整原型）；也可上传 HTML 初稿接受同一套对应性检查。</p>
              <div className="gen-ops" style={{ justifyContent: 'center' }}>
                <button className="act" disabled={busyLabel !== null} onClick={() => setUploadOpen(true)}>⬆ 上传 HTML 初稿</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="v19-issues">
        {proto.latestCheck && (
          <div className="rtm-card">
            <div className="rtm-card-head"><strong>检查报告 #{proto.latestCheck.runNo}</strong>
              <span className={`tag ${proto.latestCheck.passed ? 'tag-ok' : 'tag-warn'}`}>{proto.latestCheck.passed ? 'pass' : 'fail'}</span>
            </div>
            {proto.latestCheck.issues.length === 0 && <p className="pop-tip">无问题。</p>}
            {proto.latestCheck.issues.map((i, idx) => (
              <div key={idx} className="issue-row"><code>{i.code}</code> {i.message} <span className="mut">[{i.target}]</span></div>
            ))}
            {proto.latestCheck.unverified.map((u, idx) => (
              <div key={`u${idx}`} className="issue-row warn"><code>{u.code}</code> {u.message} <span className="mut">[需人工]</span></div>
            ))}
          </div>
        )}
        {/* S5 共同基线横幅（呈现层不暴露技术 ID：显示版本号而非 uuid） */}
        {currentBaseline && (
          <div className="req-banner ok" data-testid="prototype-baseline-current">
            共同基线 {currentBaseline.code} · 当前原型 {curVerNo !== null ? `v${curVerNo}` : '—'}
            {!currentBaseline.valid && <span className="dev-bad">（已失效：{currentBaseline.staleReason ?? '上游变化'}）</span>}
          </div>
        )}
        {/* S5+L8 追溯 details：按选中页补全 需求/锚点/任务/流程（原型 traceHtml 口径） */}
        <TraceDetails
          page={pages.find((p) => p.code === selPage) ?? null}
          flows={(catalog?.groups.flow ?? []) as CatalogGroup[]}
          proto={proto}
          baselineCode={currentBaseline?.code ?? null}
        />
      </div>
      <BaselineCard items={baselines.items} reload={baselines.reload} />
      <CatalogCard onChanged={() => void refreshProto()} />
      <SourceAuditCard />
      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
      {verOpen && <ProtoModal firstPage={pages[0]?.code ?? 'index'} onClose={() => setVerOpen(false)} />}
      {finOpen && verId && (
        <FinalizeProtoModal verId={verId} reFinalize={(baselines.items?.length ?? 0) > 0} onClose={() => setFinOpen(false)} />
      )}
    </div>
  );
}

/**
 * L8 追溯区（原型 traceHtml@9167 口径）：选中页的 需求 / 章节锚点 / 任务 / 流程 来源网格。
 * 数据链：需求=页 payload.reqIds；锚点=A05-4 目录条目 anchors（dsg_catalog_refs，按文档分组）；
 * 任务=开发域 source_ids 反查本页目录条目（HTTP 组合）；流程=目录 flow 条目 steps 命中页标题。
 */
function TraceDetails({ page, flows, proto, baselineCode }: {
  page: CatalogGroup | null;
  flows: CatalogGroup[];
  proto: ProtoStatus;
  baselineCode: string | null;
}) {
  const { projectId, catalog } = useDesignView();
  const [tasks, setTasks] = useState<Array<{ code: string; title: string; sourceIds: string[] }> | null>(null);
  useEffect(() => {
    if (!projectId) return;
    void designApi.devTasks(projectId).then((r) => setTasks(r.items)).catch(() => setTasks([]));
  }, [projectId]);
  const pageTitle = page ? ((page.payload.title as string) ?? page.code) : '';
  const reqIds = (page?.payload.reqIds as string[] | undefined) ?? [];
  const anchorsByDoc = new Map<string, Array<{ sectionId: string | null; anchor: string | null }>>();
  for (const a of page?.anchors ?? []) {
    const k = (a.docKind ?? 'prd').toUpperCase();
    const arr = anchorsByDoc.get(k) ?? [];
    arr.push({ sectionId: a.sectionId, anchor: a.anchor });
    anchorsByDoc.set(k, arr);
  }
  const linkedTasks = page ? (tasks ?? []).filter((t) => t.sourceIds.includes(page.code)) : [];
  const linkedFlows = pageTitle
    ? flows.filter((f) => ((f.payload.steps as string[] | undefined) ?? []).some((s) => s.includes(pageTitle)))
    : [];
  return (
    <details className="v19-trace">
      <summary>查看{pageTitle ? `「${pageTitle}」的` : '页面'}需求 / 锚点 / 任务 / 流程来源</summary>
      {!page ? (
        <p className="pop-tip">规划后生成页面清单，选择页面查看追溯。</p>
      ) : (
        <div className="v19-trace-grid">
          <div>
            <b>需求</b>
            <p>{reqIds.length > 0
              ? reqIds.map((r) => <span key={r} className="tag" style={{ marginRight: 4 }}>{r}</span>)
              : <span className="mut">—（通用页面，无直接 REQ）</span>}</p>
          </div>
          {[...anchorsByDoc.entries()].map(([doc, arr]) => (
            <div key={doc}>
              <b>{doc} 锚点</b>
              {arr.map((a, i) => (
                <p key={i}><code>{a.sectionId ?? '—'}</code> {a.anchor ?? ''}</p>
              ))}
            </div>
          ))}
          <div>
            <b>任务</b>
            <p>{tasks === null
              ? <span className="mut">加载中…</span>
              : linkedTasks.length > 0
                ? linkedTasks.map((t) => <span key={t.code} className="tag" style={{ marginRight: 4 }} title={t.title}>{t.code}</span>)
                : <span className="mut">—（开发任务未承接本页）</span>}</p>
          </div>
          <div>
            <b>流程</b>
            <p>{linkedFlows.length > 0
              ? linkedFlows.map((f) => <span key={f.code} className="tag tag-ok" style={{ marginRight: 4 }}>{f.code}</span>)
              : <span className="mut">—</span>}</p>
          </div>
        </div>
      )}
      <p className="pop-tip">
        当前计划 {proto.plan?.planId.slice(0, 8) ?? '未生成'} · 目录 {proto.plan?.catalogVersion ?? catalog?.catalogVersion ?? '—'}
        {' '}· 检查 {proto.latestCheck?.reportId.slice(0, 8) ?? '未执行'} · 基线 {baselineCode ?? '—'}
      </p>
    </details>
  );
}

/** 基线数据（命令条导出 / 基线横幅 / 基线卡共用） */function useBaselines(projectId: string | null, protoStatus: string | null) {
  const [items, setItems] = useState<BaselineItem[] | null>(null);
  const reload = () => {
    if (projectId) void designApi.baselines(projectId).then((r) => setItems(r.items)).catch(() => setItems(null));
  };
  useEffect(reload, [projectId, protoStatus]);
  return { items, reload };
}

/** S4 KPI 三格：当前结论 / 需关注 / 下一步（共同基线只由人工确认） */
function KpiRow({ proto, pageCount, flowCount }: { proto: ProtoStatus; pageCount: number; flowCount: number }) {
  const issueCount = (proto.latestCheck?.issues.length ?? 0) + (proto.latestCheck?.unverified.length ?? 0);
  const checked = proto.latestCheck && proto.latestCheck.prototypeVersionId === proto.prototype?.currentVersionId;
  const next = !proto.plan ? '先识别规划'
    : proto.plan.stale ? '重新识别规划'
    : !proto.prototype?.currentVersionId ? '生成完整原型'
    : !checked ? '执行对应性检查'
    : proto.status !== 'finalized' ? '人工确认定稿'
    : '进入开发';
  return (
    <div className="kpi-row" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
      <div className="kpi-card">
        <div className="kpi-label">当前结论</div>
        <div className="kpi-value" style={{ fontSize: 18 }}>{statusLabel(proto)}</div>
        <div className="pop-tip">{pageCount} 个页面 · {flowCount} 条关键流程</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">需关注</div>
        <div className="kpi-value" style={{ fontSize: 18 }}>{issueCount > 0 ? `${issueCount} 项` : checked ? '无' : '尚未验证'}</div>
        <div className="pop-tip">{issueCount > 0 ? '检查报告列出需处理项' : checked ? '页面、状态、来源与交互已检查' : '完成对应性检查后给出结论'}</div>
      </div>
      <div className="kpi-card">
        <div className="kpi-label">下一步</div>
        <div className="kpi-value" style={{ fontSize: 18 }}>{next}</div>
        <div className="pop-tip">共同基线只由人工确认</div>
      </div>
    </div>
  );
}

function statusLabel(p: ProtoStatus): string {
  // 原型口径（L8995 status() 五档 + 进行中三态）
  const map: Record<string, string> = {
    idle: '尚未规划', 'plan-ready': '规划完成，等待生成', generated: '原型待检查',
    ready: '检查通过，等待人工定稿', finalized: '共同基线有效', stale: '已失效（须重新规划）', failed: '失败',
    planning: '正在识别页面与业务流程…', generating: '正在生成可交互原型…', checking: '正在检查页面、流程与来源对应性…',
  };
  return map[p.status] ?? p.status;
}

/** 原型版本列表（基线横幅显示「当前原型 vN」用；呈现层不暴露 versionId 哈希） */
function useProtoVersions(projectId: string | null, currentVersionId: string | null) {
  const [items, setItems] = useState<Array<{ versionId: string; v: number }> | null>(null);
  useEffect(() => {
    if (!projectId || !currentVersionId) return;
    let dead = false;
    void designApi.protoVersions(projectId)
      .then((r) => { if (!dead) setItems(r.items); })
      .catch(() => { if (!dead) setItems(null); });
    return () => { dead = true; };
  }, [projectId, currentVersionId]);
  return items;
}

/** 命令条：①规划 → ②生成 → ③检查 → ④人工定稿 + 导出基线 + 版本（S5/S7；逐步门禁实时求值） */
function CommandBar({ proto, busy, run, currentBaseline, onOpenVersions, onFinalize }: {
  proto: ProtoStatus;
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  currentBaseline: BaselineItem | null;
  onOpenVersions: () => void;
  onFinalize: () => void;
}) {
  const { projectId } = useDesignView();
  if (!projectId) return null;
  const verId = proto.prototype?.currentVersionId ?? null;
  return (
    <div className="v19-command">
      <span className={`tag ${proto.status === 'finalized' ? 'tag-ok' : 'tag-warn'}`}>{statusLabel(proto)}</span>
      <button className="act primary" disabled={busy} onClick={() => void run('正在识别页面与业务流程…', () => designApi.plan(projectId))}>① AI 识别规划</button>
      <button className="act" disabled={busy || !proto.plan || proto.plan.stale} onClick={() => void run('正在生成可交互原型…', async () => {
        await designApi.protoGenerate(projectId, proto.plan!.planId, proto.plan!.fingerprint);
      })}>② 生成完整原型</button>
      <button className="act" disabled={busy || !verId} onClick={() => void run('正在检查页面、流程与来源对应性…', () => designApi.protoCheck(projectId, verId!))}>③ 对应性检查</button>
      <button
        className="act primary"
        disabled={busy || !proto.latestCheck?.passed || proto.latestCheck?.prototypeVersionId !== verId}
        title="人工定稿形成设计基线（策略确认点，modal 二次确认）"
        onClick={onFinalize}
      >④ 人工定稿</button>
      {/* S5 导出基线（当前基线 JSON 本端下载；基线失效不可导出） */}
      <button
        className="act"
        disabled={!currentBaseline || !currentBaseline.valid}
        title={currentBaseline ? (currentBaseline.valid ? '下载当前共同基线（JSON）' : '基线已失效（上游变化），不可导出') : '尚无基线——原型定稿后产生'}
        onClick={() => {
          if (!currentBaseline) return;
          const blob = new Blob([JSON.stringify(currentBaseline, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${currentBaseline.code}-设计基线.json`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }}
      >导出基线</button>
      {/* S7 旧版预览入口 */}
      <button className="act" onClick={onOpenVersions}>🕘 版本与旧版预览</button>
    </div>
  );
}

/** 原型人工定稿 modal（DSG-U07-2：共同定稿=形成设计基线，modal 二次确认替代原生 confirm） */
function FinalizeProtoModal({ verId, reFinalize, onClose }: { verId: string; reFinalize: boolean; onClose: () => void }) {
  const { projectId, proto, refreshProto, setImpactNotice } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!projectId || !proto?.latestCheck) return null;
  const submit = () => {
    setBusy(true);
    setMsg(null);
    void designApi.protoFinalize(projectId, verId, proto.latestCheck!.reportId)
      .then(() => {
        onClose();
        // S9 impactTrigger：仅再定稿（此前已有有效基线）提示影响处置
        if (reFinalize) {
          setImpactNotice('原型已再次共同定稿形成新的设计基线——开发输入以此指纹为准，请在开发页「影响处置」确认承接。');
        }
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '定稿失败'))
      .finally(() => { setBusy(false); void refreshProto(); });
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>④ 人工定稿（共同基线）</h3>
        <p className="pop-tip">
          共同定稿将形成设计基线（append-only，人工确认点）：当前原型版本与检查报告指纹冻结，下游开发输入以此为准。定稿只由人工确认，记审计。
        </p>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={busy} onClick={submit}>确认定稿</button>
        </div>
      </div>
    </div>
  );
}

/** S6 上传 HTML 初稿 modal（V1.3 上传通道；入库后走同一套对应性检查） */
function UploadModal({ onClose }: { onClose: () => void }) {
  const { projectId, refreshProto } = useDesignView();
  const [html, setHtml] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;
  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { setMsg('HTML 过大（>5MB）'); return; }
    void f.text().then((t) => { setHtml(t); setMsg(null); });
  };
  const submit = () => {
    setBusy(true);
    setMsg(null);
    void designApi.uploadPrototype(projectId, html, note.trim() || undefined)
      .then(() => onClose())
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '上传失败'))
      .finally(() => { setBusy(false); void refreshProto(); });
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⬆ 上传 HTML 初稿</h3>
        <p className="pop-tip">
          上传的人工初稿登记为原型版本（manifest generatedBy=manual-upload），与 AI 生成走同一套对应性检查，不静默通过。
        </p>
        <label className="form-row">
          选择 .html 文件
          <input type="file" accept=".html,.htm,text/html" onChange={(e) => pickFile(e.target.files?.[0])} />
        </label>
        <textarea
          rows={8}
          style={{ width: '100%' }}
          placeholder="或直接粘贴 HTML 源码"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
        />
        <label className="form-row">版本说明 <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="可选" /></label>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={busy || !html.trim()} onClick={submit}>上传并入库</button>
        </div>
      </div>
    </div>
  );
}

/** S7 .proto-modal（94vw×92vh）：版本列表 + 旧版预览（preview?v=n 取历史对象） */
function ProtoModal({ firstPage, onClose }: { firstPage: string; onClose: () => void }) {
  const { projectId } = useDesignView();
  const [versions, setVersions] = useState<Array<{ versionId: string; v: number; note: string | null; at: string; finalized: boolean }> | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    void designApi.protoVersions(projectId)
      .then((r) => { setVersions(r.items); setSel(r.items[0]?.v ?? null); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '版本列表加载失败'));
  }, [projectId]);
  useEffect(() => {
    if (!projectId || sel === null) return;
    setUrl(null);
    let dead = false;
    designApi.preview(projectId, firstPage, sel)
      .then((r) => { if (!dead) setUrl(r.previewUrl); })
      .catch((e) => { if (!dead) setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '旧版预览加载失败'); });
    return () => { dead = true; };
  }, [projectId, sel, firstPage]);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal proto-modal" onClick={(e) => e.stopPropagation()}>
        <div className="rtm-card-head" style={{ padding: '4px 0' }}>
          <strong>原型版本 · 旧版预览</strong>
          <span className="pop-tip">iframe sandbox（allow-scripts）渲染 · 旧版只读</span>
          <button className="act" onClick={onClose}>✕ 关闭</button>
        </div>
        <div className="proto-modal-body">
          <aside className="proto-modal-vers">
            {versions === null && <p className="pop-tip">加载中…</p>}
            {versions?.length === 0 && <p className="pop-tip">尚无原型版本。</p>}
            {versions?.map((v) => (
              <button
                key={v.versionId}
                className={`toc-item${sel === v.v ? ' sel' : ''}`}
                onClick={() => setSel(v.v)}
              >
                v{v.v}{v.finalized ? ' ✅定稿' : ''}
                <span className="mut" style={{ display: 'block', fontSize: 11 }}>
                  {v.note ?? ''} · {new Date(v.at).toLocaleString()}
                </span>
              </button>
            ))}
          </aside>
          <div className="proto-modal-frame">
            {msg && <p className="pop-tip err">{msg}</p>}
            {url
              ? <iframe key={sel ?? -1} title="旧版原型预览" sandbox="allow-scripts" src={url} className="proto-iframe" />
              : !msg && <div className="doc-empty">选择左侧版本查看。</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function BaselineCard({ items, reload }: { items: BaselineItem[] | null; reload: () => void }) {
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>设计基线（append-only，valid 实时比对）</strong>
        <button className="act" onClick={reload}>↻</button>
      </div>
      {items === null ? <p className="pop-tip">加载中…</p> : items.length === 0 ? <p className="pop-tip">尚无基线——原型定稿后产生。</p> : (
        <table className="rtm-table">
          <thead><tr><th>基线</th><th>当前</th><th>有效</th><th>定稿时间</th></tr></thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.code}>
                <td><code>{b.code}</code></td>
                <td>{b.current ? '✓' : ''}</td>
                <td>{b.valid ? <span className="tag tag-ok">有效</span> : <span className="tag st-uncovered">失效：{b.staleReason}</span>}</td>
                <td className="mut">{new Date(b.confirmedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** 设计目录卡：分组摘要 + 人工增删（增删=新目录版本；识别条目不可直删，REQ-304/306） */
function CatalogCard({ onChanged }: { onChanged: () => void }) {
  const { projectId, catalog } = useDesignView();
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<{ itemId: string; label: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !catalog) return null;
  const groups = Object.entries(catalog.groups);
  const remove = (itemId: string) => {
    setMsg(null);
    void designApi.removeCatalogItem(projectId, itemId)
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '删除失败'))
      .finally(onChanged);
  };
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>设计目录 {catalog.catalogVersion ?? '（未规划）'}</strong>
        <button className="act" onClick={() => setAddOpen(true)}>＋ 人工补充条目</button>
      </div>
      {msg && <p className="pop-tip err">{msg}</p>}
      {groups.length === 0 ? <p className="pop-tip">规划后生成目录条目。</p> : groups.map(([g, items]) => (
        <div key={g} className="cat-group">
          <div className="cat-group-head"><code>{g}</code> <span className="mut">×{items.length}</span></div>
          {items.map((it) => (
            <div key={it.itemId} className="issue-row">
              <code>{it.code}</code> {(it.payload.title as string) ?? ''}
              <span className="mut">[{it.source === 'manual' ? '人工' : '识别'}{it.required ? '·必需' : ''}]</span>
              {it.source === 'manual' && <button className="act" onClick={() => setDelTarget({ itemId: it.itemId, label: `${it.code} ${(it.payload.title as string) ?? ''}` })}>删除</button>}
            </div>
          ))}
        </div>
      ))}
      {addOpen && <AddItemModal onClose={() => setAddOpen(false)} onChanged={onChanged} />}
      {delTarget && (
        <div className="modal-mask" onClick={() => setDelTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除目录条目</h3>
            <p className="pop-tip">删除「{delTarget.label}」将产生新目录版本，引用随行迁移（记审计）。</p>
            <div className="modal-ops">
              <button className="act" onClick={() => setDelTarget(null)}>取消</button>
              <button className="act primary" onClick={() => { const t = delTarget; setDelTarget(null); remove(t.itemId); }}>确认删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const ITEM_TYPES = ['page', 'state', 'component', 'dialog', 'flow', 'viewport', 'theme', 'copy', 'asset'] as const;

function AddItemModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const { projectId } = useDesignView();
  const [itemType, setItemType] = useState<string>('page');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const submit = () => {
    setMsg(null);
    void designApi.addCatalogItem(projectId, { itemType, code: code.trim(), title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '新增失败'))
      .finally(onChanged);
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>＋ 人工补充目录条目</h3>
        <p className="pop-tip">人工条目标记 source=manual，对应性检查时列入「需人工核对」（不静默通过，REQ-306）。</p>
        <label className="form-row">类型
          <select value={itemType} onChange={(e) => setItemType(e.target.value)}>
            {ITEM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="form-row">编号 <input value={code} placeholder="如 P-CUSTOM" onChange={(e) => setCode(e.target.value)} /></label>
        <label className="form-row">标题 <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="form-row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={!code.trim() || !title.trim()} onClick={submit}>新增（产生新目录版本）</button>
        </div>
      </div>
    </div>
  );
}

function SourceAuditCard() {
  const { projectId } = useDesignView();
  const [audit, setAudit] = useState<{ rulesVersion: string; ok: boolean; issues: Array<{ code: string; target: string; message: string }> } | null>(null);
  useEffect(() => {
    if (projectId) void designApi.sourceAudit(projectId).then(setAudit).catch(() => setAudit(null));
  }, [projectId]);
  return (
    <div className="rtm-card">
      <div className="rtm-card-head">
        <strong>来源审计（规则集 {audit?.rulesVersion ?? '…'}）</strong>
        <button className="act" onClick={() => projectId && void designApi.sourceAudit(projectId).then(setAudit)}>↻</button>
      </div>
      {audit === null ? <p className="pop-tip">—</p> : audit.ok ? (
        <p className="pop-tip">✓ 目录与已批准来源文档双向一致。</p>
      ) : (
        audit.issues.map((i, idx) => (
          <div key={idx} className="issue-row"><code>{i.code}</code> {i.message} <span className="mut">[{i.target}]</span></div>
        ))
      )}
    </div>
  );
}
