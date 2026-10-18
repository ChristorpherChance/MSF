import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import { toast } from '../../ui/toast';
import { useDockStore } from '../../assistant/dock-store';
import { designApi, generateProtoPage, type BaselineItem, type CatalogGroup, type ProtoStatus, type ProtoThemeItem } from './api';
import { issueActions, summarizeCoverage, type IssueAction } from './proto-report';
import { useDesignView } from './store';

/**
 * 原型 UI 工作台 V20（2026-10-17 版面改造，模拟页 v3 蓝本+用户拍板「AI 对话复用右下角 dock」）：
 * 流程条步进器（①规划→②生成页→③汇总→④检查→定稿，低频操作右置）
 * → 三列 stage：左页面栏（46⇄250px 折叠）| 中预览（单页打磨⇄整本原型分态；对话提案双排对比）| 右检查器栏（报告/目录/基线/追溯抽屉）
 * 页面对话修改=dock 绑定 page:<页码> 会话（0032），提案经 design.proto.propose_page 落 dsg_proto_page_proposals，
 * 人工「✓ 采用 / ✗ 放弃」处置——AI 只提不判。
 */
export function PrototypePanel() {
  const { projectId, proto, catalog, loading, error, refreshProto } = useDesignView();
  const [params] = useSearchParams();
  const [msg, setMsg] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [pages_, setSel] = useState<{ pageId: string; stateId: string | null } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [proposalUrl, setProposalUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<'single' | 'whole'>('single');
  const [railOpen, setRailOpen] = useState(true);
  const [inspTab, setInspTab] = useState<'report' | 'catalog' | 'baseline' | 'trace' | null>('report');
  const [inspFilter, setInspFilter] = useState('');
  const [uploadOpen, setUploadOpen] = useState(false);
  const [verOpen, setVerOpen] = useState(false);
  const [finOpen, setFinOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  // 页级生成进度（会话态 DSG-D00 不落库；组件内 Map，不占全局 busyLabel 以免锁死流程条）
  const [genMap, setGenMap] = useState<Record<string, { running: boolean; chars: number; error: string | null }>>({});
  const [genAll, setGenAll] = useState(false);
  // 批量生成总进度+耗时（「生成中…」无进度感知——第 N/M 页 + 读秒）
  const [genAllInfo, setGenAllInfo] = useState<{ idx: number; total: number; code: string; startedAt: number } | null>(null);
  const [nowTs, setNowTs] = useState(0);
  const [genTick, setGenTick] = useState(0); // 页生成/提案采用完成后 +1 → 强制重取预览 URL
  // 检查报告行内处置：补录预填/编辑目标/动作中闸
  const [addPrefill, setAddPrefill] = useState<{ itemType: string; title: string } | null>(null);
  const [editItem, setEditItem] = useState<{ itemType: string; item: CatalogGroup } | null>(null);
  const [actBusy, setActBusy] = useState(false);
  const [decideBusy, setDecideBusy] = useState(false);
  // ①规划/②生成页「查看还是重写」确认弹层（防误点直接重写——用户拍板 2026-10-17）
  const [confirmPlan, setConfirmPlan] = useState(false);
  const [confirmGenAll, setConfirmGenAll] = useState(false);
  const [flowOpen, setFlowOpen] = useState(false); // 整本模式流程视图条：0034 默认收拢（用户拍板「主流程可收拢展开」）
  const [themeOpen, setThemeOpen] = useState(false); // 0034 主题方案选择器
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const baselines = useBaselines(projectId, proto?.status ?? null);
  const protoVers = useProtoVersions(projectId, proto?.prototype?.currentVersionId ?? null);

  // 批量生成进行中读秒（1s 节拍）
  useEffect(() => {
    if (!genAll) return;
    const t = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [genAll]);

  const pages = (catalog?.groups.page ?? []) as CatalogGroup[];
  const states = (catalog?.groups.state ?? []) as CatalogGroup[];
  const selPage = pages_?.pageId ?? pages[0]?.code ?? null;
  const selState = pages_?.stateId ?? states[0]?.code ?? null;
  const verId = proto?.prototype?.currentVersionId ?? null;
  const curVerNo = protoVers?.find((v) => v.versionId === verId)?.v ?? null;
  /** 单页模式可预览：有汇总版本，或任一页已生成（单页工件直签，A05-8 分流） */
  const canSingle = verId !== null || (proto?.pages ?? []).some((p) => p.state !== 'none');
  /** 整本模式=汇总版本整份预览（v 参数强制走版本对象，不被页工件直签分流） */
  const canWhole = verId !== null && curVerNo !== null;
  const proposals = proto?.proposals ?? [];
  const selProposal = proposals.find((p) => p.pageCode === selPage) ?? null;
  const compareActive = selProposal !== null && mode === 'single';

  // dock 工具卡「查看对比 →」直达：?page=P-001（&_=ts 强制参数变化重触发）
  const pageParam = params.get('page');
  useEffect(() => {
    if (pageParam && pages.some((p) => p.code === pageParam)) {
      setSel({ pageId: pageParam, stateId: null });
      setMode('single');
    }
    // pages 依赖：目录晚于参数到达（首载时序）——目录到位后补选中
  }, [pageParam, pages]);

  // 对话提案回环（0032）：dock propose_page 成功 → 刷新提案清单并落到该页对比视图
  useEffect(() => {
    const on = (e: Event) => {
      const code = (e as CustomEvent<{ pageCode?: string }>).detail?.pageCode;
      void refreshProto();
      if (code) { setSel({ pageId: code, stateId: null }); setMode('single'); }
    };
    window.addEventListener('msf:proto-proposed', on);
    return () => window.removeEventListener('msf:proto-proposed', on);
  }, [refreshProto]);

  // 页级会话绑定（0032「选中哪页 dock 就聊哪页」，0029 doc_kind 同族）：dock 加载 page:<页码> 会话组
  useEffect(() => {
    if (selPage) void useDockStore.getState().setCtx('design', `page:${selPage}`);
  }, [selPage]);

  // 选页/模式/版本/页生成完成 → 重取预览 URL（单页工件直签时每页独立 URL，换页即换地址）
  const previewFor = `${mode}:${verId ?? 'nv'}:${selPage ?? ''}:${genTick}:${curVerNo ?? ''}`;
  useEffect(() => {
    const ok = mode === 'single' ? canSingle : canWhole;
    if (!projectId || !selPage || !ok) { setPreviewUrl(null); return; }
    let dead = false;
    setPreviewUrl(null);
    designApi.preview(projectId, selPage, mode === 'whole' ? curVerNo! : undefined)
      .then((r) => { if (!dead) setPreviewUrl(r.previewUrl); })
      .catch((e) => { if (!dead) setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '预览加载失败'); });
    return () => { dead = true; };
  }, [projectId, previewFor, canSingle, canWhole]);

  // 提案预览（对比右栏）：选中页有待处置提案时取签名 URL
  useEffect(() => {
    if (!projectId || !selProposal) { setProposalUrl(null); return; }
    let dead = false;
    setProposalUrl(null);
    designApi.protoProposalPreview(projectId, selProposal.id)
      .then((r) => { if (!dead) setProposalUrl(r.previewUrl); })
      .catch(() => { if (!dead) setProposalUrl(null); });
    return () => { dead = true; };
  }, [projectId, selProposal?.id]);

  /** S3（DSG-U04-2）：选页选态 → postMessage {type:'v19-prototype-select'}；换页伴随 URL 切换（单页工件），同页选态不重载 */
  const select = (pageId: string, stateId: string | null) => {
    setSel({ pageId, stateId });
    iframeRef.current?.contentWindow?.postMessage({ type: 'v19-prototype-select', pageId, stateId }, '*');
  };

  /** 💬 对话修改本页：dock 绑定 page:<页码> 会话组并展开（提案生成后回本面板双排对比） */
  const openDockForPage = (code: string) => {
    const dock = useDockStore.getState();
    void dock.setCtx('design', `page:${code}`);
    if (!useDockStore.getState().open) useDockStore.getState().toggle();
  };

  /** 页级生成（🎨 行内/✨ 全部共用）：SSE 四帧消费，行内进度+错误 */
  const genOne = async (code: string): Promise<boolean> => {
    if (!projectId) return false;
    const patch = (p: Partial<{ running: boolean; chars: number; error: string | null }>) =>
      setGenMap((m) => ({ ...m, [code]: { running: false, chars: 0, error: null, ...m[code], ...p } }));
    patch({ running: true, chars: 0, error: null });
    let ok = false;
    try {
      let chars = 0;
      await generateProtoPage(projectId, code, (f) => {
        if (f.type === 'stream.delta' && f.text) { chars += f.text.length; patch({ chars }); }
        else if (f.type === 'stream.done') { ok = f.status !== 'stopped'; }
        else if (f.type === 'stream.notice') { toast(String(f.message ?? '上游连接中断，已自动重试'), 'warn'); }
        else if (f.type === 'stream.error') { patch({ error: `${f.code ?? '生成失败'}${f.message ? `：${f.message}` : ''}` }); }
      });
    } catch (e) {
      patch({ error: e instanceof ApiError ? `${e.code}: ${e.message}` : '生成请求失败' });
    }
    patch({ running: false });
    setGenTick((t) => t + 1);
    void refreshProto();
    return ok;
  };

  /** ✨ 全部生成：顺序循环单页 SSE（逐行落定；失败不中断后续页）；总进度+耗时进常驻横幅。
   *  onlyMissing=true 只补未生成页（确认弹窗「补齐未生成」选项，不覆盖已有页工件） */
  const genAllPages = async (onlyMissing = false) => {
    const generated = new Set((proto?.pages ?? []).filter((x) => x.state !== 'none').map((x) => x.code));
    const targets = onlyMissing ? pages.filter((p) => !generated.has(p.code)) : pages;
    if (targets.length === 0) { toast('全部页面都已生成，无需补齐', 'default'); return; }
    setGenAll(true);
    const startedAt = Date.now();
    try {
      for (let i = 0; i < targets.length; i += 1) {
        setGenAllInfo({ idx: i + 1, total: targets.length, code: targets[i]!.code, startedAt });
        await genOne(targets[i]!.code);
      }
    } finally {
      setGenAll(false);
      setGenAllInfo(null);
      void refreshProto();
    }
  };

  /** 提案处置（✓ 采用=提案提升为页工件行 / ✗ 放弃=丢弃并可继续对话提意见） */
  const decide = (decision: 'accept' | 'discard') => {
    if (!projectId || !selProposal || decideBusy) return;
    setDecideBusy(true);
    designApi.protoProposalDecide(projectId, selProposal.id, decision)
      .then(() => {
        toast(
          decision === 'accept'
            ? `已采用新版（${selProposal.pageCode} 页工件已更新；需 ② 汇总后入整本原型）`
            : '已放弃该提案——可继续在右侧 AI 对话里提修改意见',
          decision === 'accept' ? 'success' : 'default',
        );
        if (decision === 'discard') openDockForPage(selProposal.pageCode);
        setGenTick((t) => t + 1);
      })
      .catch((e) => toast(e instanceof ApiError ? `${e.code}: ${e.message}` : '处置失败', 'warn'))
      .finally(() => { setDecideBusy(false); void refreshProto(); });
  };

  if (error) return <div className="req-banner err">{error}</div>;
  if (!proto) return <div className="doc-empty">{loading ? '加载中…' : '原型工作台初始化中…'}</div>;

  /** 按 code 找目录条目（报告行 target=条目码；type 已知时收窄分组） */
  const findItem = (code: string, itemType?: string): { itemType: string; item: CatalogGroup } | null => {
    for (const [g, items] of Object.entries(catalog?.groups ?? {})) {
      if (itemType && g !== itemType) continue;
      const it = (items as CatalogGroup[]).find((x) => x.code === code);
      if (it) return { itemType: g, item: it };
    }
    return null;
  };

  /** 报告行内处置：按 issue code 路由到现成动作（豁免/核对=update-item；补录/编辑=开对应弹层；缺渲染=页级生成） */
  const runIssueAction = (action: IssueAction, target: string) => {
    if (!projectId || actBusy) return;
    if (action === 'replan') {
      void run('正在识别页面与业务流程…', () => designApi.plan(projectId));
      return;
    }
    if (action === 'add-page') {
      setAddPrefill({ itemType: 'page', title: target });
      return;
    }
    if (action === 'gen-page') {
      void genOne(target.split('/')[0]!); // STATE_MISSING 的 target 是「页码/状态」，取页码部分
      return;
    }
    if (action === 'edit-flow') {
      const found = findItem(target, 'flow');
      if (found) setEditItem(found);
      return;
    }
    // exempt / （已核对在 unverified 行单独入口 markChecked）
    const found = findItem(target, 'page');
    if (!found) { toast(`目录中找不到 ${target}（可能已重规划）`, 'warn'); return; }
    setActBusy(true);
    void designApi.updateCatalogItem(projectId, found.item.itemId, { exempt: true })
      .then(() => toast(`${target} 已豁免「页有册无」报警（保存即新目录版本，重跑 ④ 检查生效）`, 'success'))
      .catch((e) => toast(e instanceof ApiError ? `${e.code}: ${e.message}` : '豁免失败', 'warn'))
      .finally(() => { setActBusy(false); void refreshProto(); });
  };

  /** 需人工核对 → 已核对（verified 销项：update-item 白名单字段，仅人工条目可用） */
  const markChecked = (code: string) => {
    if (!projectId || actBusy) return;
    const found = findItem(code);
    if (!found) { toast(`目录中找不到 ${code}（可能已重规划）`, 'warn'); return; }
    setActBusy(true);
    void designApi.updateCatalogItem(projectId, found.item.itemId, { verified: true })
      .then(() => toast(`${code} 已标记核对`, 'success'))
      .catch((e) => toast(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败', 'warn'))
      .finally(() => { setActBusy(false); void refreshProto(); });
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusyLabel(label);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      const issues = (e as ApiError & { issues?: Array<{ message: string; target?: string }> }).issues;
      // 门禁 issue 逐条人话列出（原 JSON.stringify 整坨输出不可读——GATE_BLOCKED 排查全靠猜）
      const detail = issues?.length
        ? `\n${issues.map((i) => `· ${i.message}${i.target ? `（${i.target}）` : ''}`).join('\n')}`
        : '';
      setMsg(e instanceof ApiError ? `${e.code}: ${e.message}${detail}` : '操作失败');
    } finally {
      setBusyLabel(null);
      void refreshProto();
    }
  };
  const currentBaseline = baselines.items?.find((b) => b.current) ?? null;
  const pageTotal = proto.pages?.length ?? 0;
  const pageGenerated = (proto.pages ?? []).filter((p) => p.state !== 'none').length;
  /** ① 规划入口：已有规划时先弹「查看还是重新规划」确认（防误点触发重写观感）；无规划/已 stale 直接跑 */
  const doPlan = () => void run('正在识别页面与业务流程…', () => designApi.plan(projectId!));
  const clickPlan = () => {
    if (proto.plan && !proto.plan.stale && pageTotal > 0) setConfirmPlan(true);
    else doPlan();
  };
  /** ② 生成页入口：已有页工件时先弹「查看/补齐/全部重写」三选；一页未生成直接跑 */
  const clickGenAll = () => {
    if (pageGenerated > 0) setConfirmGenAll(true);
    else void genAllPages();
  };
  const selPg = (proto.pages ?? []).find((x) => x.code === selPage) ?? null;
  const selCatalogPage = pages.find((p) => p.code === selPage) ?? null;
  const selReqIds = (selCatalogPage?.payload.reqIds as string[] | undefined) ?? [];
  const issueN = (proto.latestCheck?.issues.length ?? 0) + (proto.latestCheck?.unverified.length ?? 0);
  const q = inspFilter.trim();

  return (
    <div className="proto-wrap">
      <FlowBar
        proto={proto} busy={busyLabel !== null} run={run}
        currentBaseline={currentBaseline} curVerNo={curVerNo}
        genAll={genAll} onPlan={clickPlan} onGenAll={clickGenAll}
        onViewWhole={() => setMode('whole')}
        onViewReport={() => setInspTab('report')}
        onOpenUpload={() => setUploadOpen(true)}
        onOpenVersions={() => setVerOpen(true)}
        onOpenTheme={() => setThemeOpen(true)}
        onFinalize={() => setFinOpen(true)}
        onUnlock={() => setUnlockOpen(true)}
      />
      {/* D15（原型口径）：流程操作进行中横幅（role=status，持续可见） */}
      {busyLabel && (
        <div className="req-banner warn" role="status">{busyLabel}</div>
      )}
      {/* 批量页级生成总进度+读秒（长调用常驻——单页数分钟，无进度感知=用户分不清跑着还是死了） */}
      {genAll && genAllInfo && (
        <div className="req-banner warn" role="status">
          ✨ 批量生成中：第 {genAllInfo.idx}/{genAllInfo.total} 页（{genAllInfo.code}）
          {' '}· 已用 {fmtElapsed((nowTs || Date.now()) - genAllInfo.startedAt)}
          {(genMap[genAllInfo.code]?.chars ?? 0) > 0 && ` · 当前页已产出 ${((genMap[genAllInfo.code]?.chars ?? 0) / 1024).toFixed(1)}K`}
        </div>
      )}
      {msg && <div className="req-banner err" style={{ whiteSpace: 'pre-line' }}>{msg}</div>}
      {proto.plan?.stale && (
        <div className="req-banner warn">
          ⚠ PLAN_STALE · 规划依据（上游定稿）已变化，须重新规划。
        </div>
      )}
      {/* D14（原型口径）：基线定稿后引导进入开发 */}
      {proto.status === 'finalized' && currentBaseline?.valid && (
        <div className="req-banner ok">
          <b>设计基线已定稿，下一步进入开发核对输入并准备计划。</b>
          {' '}<a className="act" href="/dev">进入开发准备计划</a>
        </div>
      )}

      <div className="proto-stage">
        {/* 左：页面栏（⇋ 折叠 46px / 展开 250px；行内 🎨 重新生成 + 💬 对话修改） */}
        <aside className={`pagerail${railOpen ? ' open' : ''}`} data-testid="prototype-page-list">
          <div className="rail-head">
            <button className="rail-toggle" title="折叠/展开页面清单" onClick={() => setRailOpen(!railOpen)}>
              ⇋ <span className="w">页面清单 · {pages.length} 页</span>
            </button>
          </div>
          <div className="pglist">
            {pages.map((p) => {
              const pg = (proto.pages ?? []).find((x) => x.code === p.code);
              const g = genMap[p.code];
              const st = !pg || pg.state === 'none' ? 'none' : pg.state === 'pending' ? 'pend' : 'ok';
              const hasProposal = proposals.some((x) => x.pageCode === p.code);
              return (
                <div key={p.code}>
                  <div
                    className={`pg${selPage === p.code ? ' sel' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => select(p.code, selState)}
                    onKeyDown={(e) => { if (e.key === 'Enter') select(p.code, selState); }}
                  >
                    <span className={`st ${st}`} title={st === 'ok' ? '已入当前汇总' : st === 'pend' ? '已生成待汇总' : '未生成'} />
                    <span className="code">{p.code}</span>
                    <span className="nm">
                      {(p.payload.title as string) ?? p.code}
                      {hasProposal && <span className="tag tag-warn" title="有 AI 修改提案待处置（选中本页查看双排对比）"> 💬提案</span>}
                      <span className="mut">
                        {' '}· {pg?.source && `${pg.source === 'model' ? 'AI' : 'mock'} · `}
                        {st === 'ok' ? '已汇总' : st === 'pend' ? '待汇总' : '未生成'}
                      </span>
                    </span>
                    {proto.status !== 'finalized' && (
                      <span className="ops">
                        <button
                          disabled={g?.running || genAll}
                          title={pg && pg.state !== 'none' ? '重新生成页 UI 原型（AI，不带修改意见）' : '生成页 UI 原型（AI）'}
                          onClick={(e) => { e.stopPropagation(); void genOne(p.code); }}
                        >{g?.running ? '…' : '🎨'}</button>
                        <button
                          disabled={g?.running || genAll}
                          title="对话修改本页：右侧 AI 助手按意见出修改提案，双排对比后「✓ 采用 / ✗ 放弃」"
                          onClick={(e) => { e.stopPropagation(); select(p.code, selState); openDockForPage(p.code); }}
                        >💬</button>
                      </span>
                    )}
                  </div>
                  {g?.running && <div className="pg-sub">生成中 {(g.chars / 1024).toFixed(1)}K…</div>}
                  {g?.error && <div className="pg-sub err">⚠ {g.error}</div>}
                </div>
              );
            })}
            {pages.length === 0 && <p className="pop-tip" style={{ padding: '0 6px' }}>规划后生成页面清单。</p>}
          </div>
          <div className="rail-foot">
            {pages.length} 页 · {(catalog?.groups.flow ?? []).length} 流程
            {pages.length > 0 && proto.status !== 'finalized' && (
              <button
                className="all"
                disabled={genAll || busyLabel !== null}
                title="批量生成页面 UI 原型（已有页工件时会先询问：只补缺失还是全部重写）"
                onClick={clickGenAll}
              >{genAll ? '生成中…' : '✨ 全部生成'}</button>
            )}
          </div>
        </aside>

        {/* 中：预览列（单页打磨⇄整本原型分态 + 对比模式 + 四态条/流程视图条） */}
        <div className="stage-preview">
          <div className="modeseg">
            <div className="seg">
              <button className={mode === 'single' ? 'on' : ''} onClick={() => setMode('single')}>
                单页打磨<span className="mini-tag">工作工件</span>
              </button>
              <button
                className={mode === 'whole' ? 'on' : ''}
                disabled={!canWhole}
                title={canWhole ? '汇总后的完整可交互原型（跨页穿流+流程视图）' : '尚无汇总版本——先 ② 汇总生成完整原型'}
                onClick={() => setMode('whole')}
              >
                整本原型<span className="mini-tag">{curVerNo !== null ? `汇总 v${curVerNo}` : '未汇总'}</span>
              </button>
            </div>
            <span className="mode-cap">
              {mode === 'single' ? (
                <>
                  当前页 <b>{selPage ?? '—'} {selCatalogPage ? (selCatalogPage.payload.title as string) ?? '' : ''}</b>
                  {' '}· 最新生成（含未汇总改动）
                  {selPg?.state === 'pending' && <span className="tag tag-warn">待汇总</span>}
                  {selPg?.state === 'assembled' && <span className="tag tag-ok">已汇总</span>}
                  {selPg?.uiStale && <span className="tag tag-warn" title="依据的 ui 册有新提交，须重新生成该页">⚠依据已变更</span>}
                </>
              ) : (
                <>
                  整本原型 · 汇总版本 <b>v{curVerNo ?? '?'}</b>（{pages.length} 页穿流可交互）
                  {proto.pagesStale && <span className="tag tag-warn">页有更新待汇总</span>}
                  {proto.latestCheck?.prototypeVersionId === verId && (
                    <span className={`tag ${proto.latestCheck.passed ? 'tag-ok' : 'tag-warn'}`}>
                      {proto.latestCheck.passed ? `✓ 已检查 v${curVerNo}` : '⚠ 检查未通过'}
                    </span>
                  )}
                </>
              )}
            </span>
          </div>

          {/* 整本模式专属：流程视图条（0034 默认收拢为一行，点击展开；步骤命中目录页码可点跳） */}
          {mode === 'whole' && (
            <div className="flowview">
              {(catalog?.groups.flow ?? []).length === 0 ? (
                <span>流程视图 · 目录尚无流程条目（① 规划识别或目录面板人工补充）</span>
              ) : (
                <>
                  <button className="fv-toggle" onClick={() => setFlowOpen(!flowOpen)}>
                    {flowOpen ? '▾' : '▸'} 主流程 · {(catalog?.groups.flow ?? []).length} 条
                    {!flowOpen && <span className="mut">（点击展开，步骤可点跳页）</span>}
                  </button>
                  {flowOpen && ((catalog?.groups.flow ?? []) as CatalogGroup[]).map((f) => (
                    <div key={f.code}>
                      <b>{f.code} {(f.payload.title as string) ?? ''}</b>：
                      {((f.payload.steps as string[] | undefined) ?? []).map((s, i) => {
                        const hit = pages.find((pg) => s.includes(pg.code));
                        return (
                          <span key={i}>
                            {i > 0 && '→'}
                            <span
                              className={`fstep${hit ? ' nav' : ''}`}
                              title={hit ? `跳到 ${hit.code}` : undefined}
                              onClick={hit ? () => select(hit.code, null) : undefined}
                            >{s}</span>
                          </span>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          {/* 对话提案对比顶条（0032：提案未落库，✓ 采用才写页工件） */}
          {compareActive && selProposal && (
            <div className="compare-bar">
              💬 修改提案：<b title={selProposal.instruction}>「{selProposal.instruction.length > 60 ? `${selProposal.instruction.slice(0, 60)}…` : selProposal.instruction}」</b>
              ——左右对比后决定是否采用（提案未落库）
              <span className="ops">
                <button className="primary" disabled={decideBusy} onClick={() => decide('accept')}>✓ 采用新版</button>
                <button disabled={decideBusy} title="放弃本提案并打开 AI 对话继续提意见" onClick={() => decide('discard')}>✗ 放弃</button>
              </span>
            </div>
          )}

          {/* 单页模式：四态切换条 + 依据锚点 caption */}
          {mode === 'single' && states.length > 0 && (
            <div className="statebar">
              {states.map((s) => (
                <button
                  key={s.code}
                  className={`chip${selState === s.code ? ' on' : ''}`}
                  onClick={() => selPage && select(selPage, s.code)}
                >
                  {(s.payload.title as string) ?? s.code}
                </button>
              ))}
              {(selPg?.uiRef || selReqIds.length > 0) && (
                <span className="cap">
                  依据：
                  {selPg?.uiRef && (
                    <>
                      ui 册「{selPg.uiRef.anchor ?? selPg.uiRef.sectionId}」
                      {selPg.state !== 'none' && (
                        <> {selPg.uiStale
                          ? <span className="tag tag-warn" title="ui 册有新提交，须重新生成该页">⚠已变更</span>
                          : <span className="tag tag-ok">✓一致</span>}</>
                      )}
                    </>
                  )}
                  {selPg?.uiRef && selReqIds.length > 0 && ' + '}
                  {selReqIds.length > 0 && `PRD ${selReqIds.join('、')}`}
                </span>
              )}
            </div>
          )}

          {/* 预览画布：对比双排 / 单页 / 整本 */}
          {compareActive && selProposal ? (
            <div className="compare-grid">
              <div className="compare-col">
                <div className="col-head"><b>修改前</b> · 当前工件{selPg?.state === 'none' ? '（尚未生成）' : ''}</div>
                <div className="proto-viewport">
                  {selPg?.state !== 'none' && previewUrl ? (
                    <iframe title="修改前·当前工件" sandbox="allow-scripts" src={previewUrl} className="proto-iframe" />
                  ) : (
                    <div className="v19-empty"><div>🖼️</div><b>该页尚未生成过</b><p>采用后提案将成为本页首版工件。</p></div>
                  )}
                </div>
              </div>
              <div className="compare-col">
                <div className="col-head proposal"><b>修改后</b> · AI 提案（未落库，放弃即丢弃）</div>
                <div className="proto-viewport">
                  {proposalUrl ? (
                    <iframe title="修改后·AI 提案" sandbox="allow-scripts" src={proposalUrl} className="proto-iframe" />
                  ) : (
                    <div className="doc-empty">提案加载中…</div>
                  )}
                </div>
              </div>
            </div>
          ) : (mode === 'single' ? canSingle : canWhole) ? (
            <div className="proto-viewport">
              {previewUrl ? (
                <iframe
                  key={previewUrl}
                  ref={iframeRef}
                  title="原型预览"
                  sandbox="allow-scripts"
                  src={previewUrl}
                  className="proto-iframe"
                  onLoad={() => selPage && iframeRef.current?.contentWindow?.postMessage(
                    { type: 'v19-prototype-select', pageId: selPage, stateId: selState }, '*')}
                />
              ) : (
                <div className="doc-empty" style={{ margin: 'auto' }}>预览加载中…（sandbox 隔离 iframe + 签名 URL，A05-8）</div>
              )}
            </div>
          ) : (
            /* S6 空态：尚未生成客户原型（页面栏 🎨 单页生成 / ✨ 全部生成 → ③ 汇总；上传=人工初稿入同一套检查） */
            <div className="proto-viewport">
              <div className="v19-empty" style={{ margin: 'auto' }}>
                <div>🖼️</div>
                <b>尚未生成客户原型</b>
                <p>先让 AI 识别完整页面、流程、状态与来源（流程条 ① 识别规划），然后在左侧页面栏逐页 🎨 生成 UI 原型（或 ✨ 全部生成），最后 ③ 汇总生成完整原型；也可上传 HTML 初稿接受同一套对应性检查。</p>
                <div className="gen-ops" style={{ justifyContent: 'center' }}>
                  <button className="act" disabled={busyLabel !== null} onClick={() => setUploadOpen(true)}>⬆ 上传 HTML 初稿</button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右：检查器栏（竖排图标条 + 380px 抽屉；复杂系统下报告/目录纵向滚动+筛选才装得下） */}
        <div className={`inspector${inspTab ? ' open' : ''}`}>
          <div className="insp-panel">
            {inspTab && (
              <>
                <div className="insp-head">
                  <button className="insp-fold" title="收拢为图标条" onClick={() => setInspTab(null)}>⇥</button>
                  <span>{({ report: '🛡 检查报告', catalog: '🗂 设计目录', baseline: '📌 设计基线', trace: '🔗 追溯' } as const)[inspTab]}</span>
                  {(inspTab === 'report' || inspTab === 'catalog') && (
                    <input
                      placeholder="筛选页码/关键词…"
                      value={inspFilter}
                      onChange={(e) => setInspFilter(e.target.value)}
                    />
                  )}
                </div>
                <div className="insp-body">
                  {inspTab === 'report' && (
                    <ReportPanel proto={proto} q={q} actBusy={actBusy} genAll={genAll}
                      runIssueAction={runIssueAction} markChecked={markChecked} />
                  )}
                  {inspTab === 'catalog' && <CatalogCard filter={q} onChanged={() => void refreshProto()} />}
                  {inspTab === 'baseline' && (
                    <>
                      {currentBaseline && (
                        <div className="req-banner ok" data-testid="prototype-baseline-current" style={{ margin: '0 0 8px' }}>
                          共同基线 {currentBaseline.code} · 当前原型 {curVerNo !== null ? `v${curVerNo}` : '—'}
                          {!currentBaseline.valid && <span className="dev-bad">（已失效：{currentBaseline.staleReason ?? '上游变化'}）</span>}
                        </div>
                      )}
                      <BaselineCard items={baselines.items} reload={baselines.reload} />
                      <SourceAuditCard />
                    </>
                  )}
                  {inspTab === 'trace' && (
                    <TraceDetails
                      page={selCatalogPage}
                      flows={(catalog?.groups.flow ?? []) as CatalogGroup[]}
                      proto={proto}
                      baselineCode={currentBaseline?.code ?? null}
                    />
                  )}
                </div>
              </>
            )}
          </div>
          <div className="insp-tabs">
            <button
              className={`insp-tab${inspTab === 'report' ? ' on' : ''}`}
              title="检查报告"
              onClick={() => setInspTab(inspTab === 'report' ? null : 'report')}
            >🛡{issueN > 0 && <span className="bdg">{issueN}</span>}</button>
            <button
              className={`insp-tab${inspTab === 'catalog' ? ' on' : ''}`}
              title="设计目录"
              onClick={() => setInspTab(inspTab === 'catalog' ? null : 'catalog')}
            >🗂</button>
            <button
              className={`insp-tab${inspTab === 'baseline' ? ' on' : ''}`}
              title="设计基线"
              onClick={() => setInspTab(inspTab === 'baseline' ? null : 'baseline')}
            >📌</button>
            <button
              className={`insp-tab${inspTab === 'trace' ? ' on' : ''}`}
              title="追溯（当前页）"
              onClick={() => setInspTab(inspTab === 'trace' ? null : 'trace')}
            >🔗</button>
          </div>
        </div>
      </div>

      {uploadOpen && <UploadModal onClose={() => setUploadOpen(false)} />}
      {themeOpen && <ThemeModal currentThemeId={proto.plan?.themeId ?? 'ai'} onClose={() => setThemeOpen(false)} />}
      {verOpen && <ProtoModal firstPage={pages[0]?.code ?? 'index'} onClose={() => setVerOpen(false)} />}
      {finOpen && verId && (
        <FinalizeProtoModal verId={verId} reFinalize={(baselines.items?.length ?? 0) > 0} onClose={() => setFinOpen(false)} />
      )}
      {unlockOpen && <UnlockProtoModal onClose={() => setUnlockOpen(false)} />}
      {/* ① 规划确认（已有规划时）：查看目录 or 重新识别——防误点触发重写观感 */}
      {confirmPlan && proto.plan && (
        <div className="modal-mask" onClick={() => setConfirmPlan(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>① 规划：查看还是重新识别？</h3>
            <p className="pop-tip">
              当前目录版本 {proto.plan.catalogVersion}（已识别 {pageTotal} 页）。
              重新规划会按最新 PRD/UI 册重新识别：上游内容未变化时复用现目录版本、已生成页面不受影响；
              有变化时产生新目录版本，依据旧目录的待处置提案将失效。
            </p>
            <div className="modal-ops">
              <button className="act" onClick={() => { setConfirmPlan(false); setInspTab('catalog'); }}>查看目录</button>
              <button className="act primary" disabled={busyLabel !== null} onClick={() => { setConfirmPlan(false); doPlan(); }}>重新规划</button>
            </div>
          </div>
        </div>
      )}
      {/* ② 生成页确认（已有页工件时）：查看 / 只补缺失 / 全部重写 三选 */}
      {confirmGenAll && (
        <div className="modal-mask" onClick={() => setConfirmGenAll(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>② 生成页：已生成 {pageGenerated}/{pageTotal}</h3>
            <p className="pop-tip">
              逐页 AI 生成约需数分钟/页。已生成的页可以只看不动、只补缺失页，或全部重写（逐页覆盖现有页工件，生成后需 ③ 重新汇总入整本）。
            </p>
            <div className="modal-ops">
              <button className="act" onClick={() => { setConfirmGenAll(false); setRailOpen(true); }}>查看页面</button>
              <button
                className="act"
                disabled={pageGenerated >= pageTotal}
                title={pageGenerated >= pageTotal ? '没有缺失页' : `只生成未生成的 ${pageTotal - pageGenerated} 页，不动已生成页`}
                onClick={() => { setConfirmGenAll(false); void genAllPages(true); }}
              >补齐未生成（{pageTotal - pageGenerated} 页）</button>
              <button className="act primary" onClick={() => { setConfirmGenAll(false); void genAllPages(false); }}>全部重写</button>
            </div>
          </div>
        </div>
      )}
      {/* 检查报告行内处置触发的弹层（与目录面板内弹层同组件；预填=报告行 target） */}
      {addPrefill && (
        <AddItemModal
          prefill={addPrefill}
          hint="补录后：左侧页面栏 🎨 生成该页 → ③ 汇总 → ④ 重跑检查"
          onClose={() => setAddPrefill(null)}
          onChanged={() => void refreshProto()}
        />
      )}
      {editItem && (
        <EditItemModal
          itemType={editItem.itemType}
          item={editItem.item}
          onClose={() => setEditItem(null)}
          onChanged={() => void refreshProto()}
        />
      )}
    </div>
  );
}

/** 流程条步进器（V20：命令条+KPI 三格合并——胶囊=按钮+状态点+结论；低频操作右置。
 *  ①规划/②生成页的「查看还是重写」判断在父组件（onPlan/onGenAll 可能先弹确认层）） */
function FlowBar({ proto, busy, run, currentBaseline, curVerNo, genAll, onPlan, onGenAll, onViewWhole, onViewReport, onOpenUpload, onOpenVersions, onOpenTheme, onFinalize, onUnlock }: {
  proto: ProtoStatus;
  busy: boolean;
  run: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  currentBaseline: BaselineItem | null;
  curVerNo: number | null;
  genAll: boolean;
  onPlan: () => void;
  onGenAll: () => void;
  /** ③ done 态：无待汇总改动时点击=查看整本（不重跑） */
  onViewWhole: () => void;
  /** ④ 对版态：报告就是当前版本的时点击=查看报告（不重跑） */
  onViewReport: () => void;
  onOpenUpload: () => void;
  onOpenVersions: () => void;
  /** 0034 主题方案选择器（生成页前选配色/风格；换肤不重写内容） */
  onOpenTheme: () => void;
  onFinalize: () => void;
  onUnlock: () => void;
}) {
  const { projectId } = useDesignView();
  if (!projectId) return null;
  const verId = proto.prototype?.currentVersionId ?? null;
  const pageTotal = proto.pages?.length ?? 0;
  const pageGenerated = (proto.pages ?? []).filter((p) => p.state !== 'none').length;
  // 汇总防呆：一页未生成就点汇总 → 全占位空原型（占位汇总+页后生成 → 指纹漂移 → 检查门禁拦死）
  const noPagesGenerated = pageTotal > 0 && pageGenerated === 0;
  const check = proto.latestCheck;
  const checkCurrent = !!check && check.prototypeVersionId === verId;
  const planOk = !!proto.plan && !proto.plan.stale;
  const steps: Array<{ label: string; done: boolean; cap: string; title: string; disabled: boolean; onClick: () => void }> = [
    {
      label: '① 规划', done: planOk, cap: proto.plan?.catalogVersion ?? '',
      title: planOk
        ? '已有规划——点击查看目录或按最新 PRD/UI 册重新识别（内容未变则复用现目录，已生成页面不受影响）'
        : '从已定稿 PRD/UI 册识别页面、流程与状态生成设计目录',
      disabled: busy,
      onClick: onPlan,
    },
    {
      label: '② 生成页', done: pageTotal > 0 && pageGenerated === pageTotal,
      cap: pageTotal > 0 ? `${pageGenerated}/${pageTotal}` : '',
      title: pageGenerated > 0
        ? `已生成 ${pageGenerated}/${pageTotal} 页——点击查看、只补缺失页或全部重写`
        : '顺序生成全部页面 UI 原型（=页面栏 ✨ 全部生成）',
      disabled: busy || genAll || !planOk || pageTotal === 0,
      onClick: onGenAll,
    },
    {
      label: '③ 汇总', done: !!verId && !proto.pagesStale && pageGenerated > 0,
      cap: verId ? `v${curVerNo ?? '?'}${proto.pagesStale ? '·待重汇总' : ''}` : '',
      title: (!!verId && !proto.pagesStale && pageGenerated > 0)
        ? '汇总版就是最新（无待汇总改动）——点击查看整本原型'
        : noPagesGenerated
          ? '先在左侧逐页 🎨 或 ✨ 全部生成页面原型，再汇总（否则只能产出全占位空原型）'
          : pageGenerated < pageTotal
            ? `将各页 UI 原型汇总为完整可交互原型（已生成 ${pageGenerated}/${pageTotal} 页，未生成页以占位块回落）`
            : '将各页 UI 原型汇总为完整可交互原型（统一应用壳+风格基线）',
      disabled: busy || genAll || !proto.plan || proto.plan.stale || noPagesGenerated,
      onClick: (!!verId && !proto.pagesStale && pageGenerated > 0)
        ? onViewWhole
        : () => void run('正在汇总生成完整原型…', async () => {
          await designApi.protoGenerate(projectId, proto.plan!.planId, proto.plan!.fingerprint);
        }),
    },
    {
      label: '④ 检查', done: checkCurrent && check.passed,
      cap: check ? (checkCurrent ? (check.passed ? '✓ 通过' : `${check.issues.length + check.unverified.length} 项待处理`) : '基于旧版本') : '',
      title: checkCurrent
        ? '报告就是当前版本的——点击查看检查报告（原型有改动重新汇总后才需重跑）'
        : check ? '报告依据的原型版本已不是当前版本——须重新检查' : '检查目录页面/状态/流程/来源与原型双向对应',
      disabled: busy || !verId,
      onClick: checkCurrent
        ? onViewReport
        : () => void run('正在检查页面、流程与来源对应性…', () => designApi.protoCheck(projectId, verId!)),
    },
    {
      label: '定稿', done: proto.status === 'finalized', cap: '',
      title: proto.status === 'finalized'
        ? '已定稿（如需再迭代，用右侧 🔓 解锁定稿）'
        : '人工定稿形成设计基线（策略确认点，modal 二次确认）',
      disabled: busy || proto.status === 'finalized' || !check?.passed || !checkCurrent,
      onClick: onFinalize,
    },
  ];
  const nowIdx = steps.findIndex((s) => !s.done);
  return (
    <div className="flowbar">
      <span className={`tag ${proto.status === 'finalized' ? 'tag-ok' : 'tag-warn'}`}>{statusLabel(proto)}</span>
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {i > 0 && <span className="flow-arrow">→</span>}
          <button
            className={`step${s.done ? ' done' : ''}${i === nowIdx ? ' now' : ''}`}
            disabled={s.disabled}
            title={s.title}
            onClick={s.onClick}
          >
            <span className="dot" />{s.label}{s.cap && <span className="mut">{s.cap}</span>}
          </button>
        </span>
      ))}
      <span className="spacer" />
      <button
        className="sub"
        disabled={!proto.plan || proto.status === 'finalized'}
        title={proto.plan
          ? (proto.status === 'finalized'
            ? '已定稿——换主题须先 🔓 解锁定稿'
            : '主题风格：生成页前选配色方案（多套默认+AI 定制+可自定义）；换肤只换配色不重写页面内容，换后需 ③ 重新汇总')
          : '先 ① 规划，再选主题风格'}
        onClick={onOpenTheme}
      >🎨 主题</button>
      <button className="sub" disabled={busy} onClick={onOpenUpload}>⬆ 上传 HTML</button>
      <button className="sub" onClick={onOpenVersions}>🕘 版本</button>
      {/* S5 导出基线（当前基线 JSON 本端下载；基线失效不可导出） */}
      <button
        className="sub"
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
      {/* W7-003 定稿后解锁再迭代入口 */}
      {proto.status === 'finalized' && (
        <button className="sub" title="解除原型定稿：旧基线立即失效，可重新规划/生成迭代" onClick={onUnlock}>🔓 解锁定稿</button>
      )}
    </div>
  );
}

/** 检查报告面板（检查器栏 🛡 抽屉；行内处置动作与覆盖结论行同 V19 口径，加筛选框） */
function ReportPanel({ proto, q, actBusy, genAll, runIssueAction, markChecked }: {
  proto: ProtoStatus;
  q: string;
  actBusy: boolean;
  genAll: boolean;
  runIssueAction: (a: IssueAction, target: string) => void;
  markChecked: (code: string) => void;
}) {
  const hit = (...parts: Array<string | undefined>) =>
    !q || parts.some((p) => (p ?? '').includes(q));
  if (!proto.latestCheck) {
    return proto.prototype?.currentVersionId ? (
      <>
        <div className="rtm-card-head"><strong>对应性检查报告</strong><span className="tag">未执行</span></div>
        <p className="pop-tip">原型已生成但尚未检查——点击流程条 ④ 检查，核对页面/状态/流程/来源与设计目录一致后再定稿。</p>
      </>
    ) : (
      <p className="pop-tip">尚无检查报告——流程条 ① 规划 → ② 生成页 → ③ 汇总后执行 ④ 检查。</p>
    );
  }
  const lc = proto.latestCheck;
  const issues = lc.issues.filter((i) => hit(i.code, i.message, i.target));
  const unverified = lc.unverified.filter((u) => hit(u.code, u.message, u.target));
  return (
    <>
      <div className="rtm-card-head"><strong>对应性检查报告 · 第 {lc.runNo} 次</strong>
        <span className={`tag ${lc.passed ? 'tag-ok' : 'tag-warn'}`}>{lc.passed ? '✓ 通过' : '⚠ 未通过'}</span>
        {lc.prototypeVersionId !== proto.prototype?.currentVersionId && (
          <span className="tag tag-warn" title="报告依据的原型版本已不是当前版本（原型之后有更新）——结论失效，请重新执行 ④ 检查">基于旧版本，须重新检查</span>
        )}
      </div>
      <p className="pop-tip" style={{ margin: '4px 0 8px' }}>
        检查口径：目录页面/状态是否都在原型中渲染、流程步骤引用的页面状态是否存在、页面跳转目标是否合法、ui 册页面章节与目录页双向对应。
      </p>
      {/* 覆盖结论行（近似口径：页面清单为当前 plan 目录，报告基于被检版本——错配时上方有 tag 提示） */}
      {(() => {
        const cov = summarizeCoverage({ pages: proto.pages ?? [], issues: lc.issues });
        return (
          <p className="pop-tip" style={{ margin: '0 0 8px' }}>
            覆盖：
            {cov.uiTotal !== null && `ui 册页面章节 ${cov.uiCovered}/${cov.uiTotal} 已被原型页承接 · `}
            目录页 {cov.assembled}/{cov.pageTotal} 已入当前汇总
          </p>
        );
      })()}
      {lc.issues.length === 0 && lc.unverified.length === 0 && (
        <p className="pop-tip">✓ 页面、状态、流程与来源全部对应，无问题。</p>
      )}
      {issues.length > 0 && (
        <div>
          <div className="cat-group-head"><span className="tag tag-warn">需处理 ×{issues.length}</span></div>
          {issues.map((i, idx) => (
            <div key={idx} className="issue-row">
              <code>{i.code}</code> {i.message} {i.target && <span className="mut">[{i.target}]</span>}
              {i.target && issueActions(i.code).map((a) => (
                <button
                  key={a}
                  className="mini"
                  disabled={actBusy || genAll}
                  title={ISSUE_ACTION_HINTS[a]}
                  onClick={() => runIssueAction(a, i.target!)}
                >{ISSUE_ACTION_LABELS[a]}</button>
              ))}
            </div>
          ))}
        </div>
      )}
      {unverified.length > 0 && (
        <div>
          <div className="cat-group-head"><span className="tag">需人工核对 ×{unverified.length}</span></div>
          {unverified.map((u, idx) => (
            <div key={`u${idx}`} className="issue-row warn">
              <code>{u.code}</code> {u.message}
              {u.target && (
                <button
                  className="mini"
                  disabled={actBusy}
                  title="确认该人工条目已核对无误（重跑 ④ 检查后从本组销项）"
                  onClick={() => markChecked(u.target!)}
                >✓ 已核对</button>
              )}
            </div>
          ))}
        </div>
      )}
      {q && issues.length === 0 && unverified.length === 0 && (lc.issues.length > 0 || lc.unverified.length > 0) && (
        <p className="pop-tip">筛选「{q}」无命中行。</p>
      )}
    </>
  );
}

/** 0034 主题令牌字段（与服务端 PROTO_THEME_TOKENS/TOKEN_LABELS 同序镜像；前端只展示+编辑覆盖项，校验在服务端） */
const THEME_FIELDS: Array<{ key: string; label: string; def: string; size?: boolean }> = [
  { key: 'primary', label: '主色', def: '#2563eb' },
  { key: 'primary-soft', label: '主色浅底', def: '#eff4ff' },
  { key: 'accent', label: '强调色', def: '#7c3aed' },
  { key: 'bg', label: '背景', def: '#f5f6f8' },
  { key: 'surface', label: '卡片面', def: '#ffffff' },
  { key: 'ink', label: '正文文字', def: '#1f2329' },
  { key: 'ink2', label: '次要文字', def: '#6b7280' },
  { key: 'line', label: '边框', def: '#e5e7eb' },
  { key: 'ok', label: '成功色', def: '#16a34a' },
  { key: 'ok-soft', label: '成功浅底', def: '#eaf7ee' },
  { key: 'warn', label: '警告色', def: '#d97706' },
  { key: 'warn-soft', label: '警告浅底', def: '#fdf3e3' },
  { key: 'danger', label: '危险色', def: '#dc2626' },
  { key: 'danger-soft', label: '危险浅底', def: '#fdecec' },
  { key: 'radius', label: '圆角', def: '10px', size: true },
];
const themeDef = (key: string) => THEME_FIELDS.find((f) => f.key === key)?.def ?? '';

/**
 * 0034 主题方案选择器（用户拍板「生成页前选配色/风格：多套默认+AI 定制+自定义」）：
 * 卡片选方案 → 应用到当前规划（plan 冻结；已生成页只换肤不重写内容 → 需 ③ 重新汇总）。
 * 自定义方案：新建（可从选中方案克隆起步）/改/删（内置与 AI 定制不可改删）。全局共享跨项目复用。
 */
function ThemeModal({ currentThemeId, onClose }: { currentThemeId: string; onClose: () => void }) {
  const { projectId, refreshProto } = useDesignView();
  const [items, setItems] = useState<ProtoThemeItem[] | null>(null);
  const [sel, setSel] = useState(currentThemeId);
  const [editor, setEditor] = useState<{ id: string | null; name: string; tokens: Record<string, string> } | null>(null);
  const [delId, setDelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => {
    if (projectId) void designApi.protoThemes(projectId).then((r) => setItems(r.items)).catch(() => setItems([]));
  };
  useEffect(load, [projectId]);
  if (!projectId) return null;
  const selItem = (items ?? []).find((x) => x.id === sel) ?? null;

  const apply = () => {
    setBusy(true);
    setMsg(null);
    void designApi.applyProtoTheme(projectId, sel)
      .then((r) => {
        toast(
          r.reskinned > 0
            ? `已应用「${r.name}」：${r.reskinned} 页已换肤（内容未动）——需 ③ 重新汇总入整本`
            : `已应用「${r.name}」——后续生成的页面按此方案`,
          'success',
        );
        onClose();
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '应用失败'))
      .finally(() => { setBusy(false); void refreshProto(); });
  };
  const saveEditor = () => {
    if (!editor) return;
    setBusy(true);
    setMsg(null);
    const call = editor.id
      ? designApi.updateProtoTheme(projectId, editor.id, { name: editor.name, tokens: editor.tokens })
      : designApi.createProtoTheme(projectId, { name: editor.name, tokens: editor.tokens });
    void call
      .then((r) => { setSel(r.themeId); setEditor(null); load(); toast('方案已保存（全项目可选）', 'success'); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '保存失败'))
      .finally(() => setBusy(false));
  };
  const doDelete = () => {
    if (!delId) return;
    setBusy(true);
    void designApi.removeProtoTheme(projectId, delId)
      .then(() => { if (sel === delId) setSel('ai'); setDelId(null); load(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '删除失败'))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal theme-modal" onClick={(e) => e.stopPropagation()}>
        <h3>🎨 主题风格（生成页前选定，换肤不重写页面内容）</h3>
        <p className="pop-tip">
          方案随规划冻结，全部单页与整本同源；已生成的页换肤只换配色段，换后需 ③ 重新汇总入整本。自定义方案全项目共享。
        </p>
        {items === null ? <p className="pop-tip">加载中…</p> : (
          <div className="theme-grid">
            {items.map((t) => (
              <div
                key={t.id}
                className={`theme-card${sel === t.id ? ' sel' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSel(t.id)}
                onKeyDown={(e) => { if (e.key === 'Enter') setSel(t.id); }}
              >
                <div className="swatches">
                  {['primary', 'accent', 'bg', 'ink'].map((k) => (
                    <span key={k} className="sw" style={{ background: t.tokens[k] ?? themeDef(k) }} />
                  ))}
                  <span className="sw-radius" style={{ borderRadius: t.tokens['radius'] ?? themeDef('radius') }} />
                </div>
                <b>{t.name}</b>
                {t.id === currentThemeId && <span className="tag tag-ok">当前</span>}
                <p className="pop-tip">{t.desc}</p>
                {!t.builtin && (
                  <span className="ops">
                    <button className="act" onClick={(e) => { e.stopPropagation(); setEditor({ id: t.id, name: t.name, tokens: { ...t.tokens } }); }}>编辑</button>
                    <button className="act" onClick={(e) => { e.stopPropagation(); setDelId(t.id); }}>删除</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="theme-ops">
          <button
            className="act"
            onClick={() => setEditor({ id: null, name: '', tokens: selItem && selItem.id !== 'ai' ? { ...selItem.tokens } : {} })}
          >＋ 新建方案{selItem && selItem.id !== 'ai' ? `（基于「${selItem.name}」）` : ''}</button>
        </div>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button
            className="act primary"
            disabled={busy || !selItem}
            title={sel === currentThemeId ? '与当前方案相同（重复应用=按方案重刷一次换肤）' : undefined}
            onClick={apply}
          >{busy ? '应用中…' : `应用「${selItem?.name ?? ''}」到本项目`}</button>
        </div>

        {/* 自定义方案编辑器（令牌覆盖：只写要覆盖的项，未动项跟随默认蓝系） */}
        {editor && (
          <div className="modal-mask" onClick={() => setEditor(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>{editor.id ? '编辑自定义方案' : '新建自定义方案'}</h3>
              <label className="form-row">方案名称
                <input value={editor.name} maxLength={40} placeholder="如：品牌绿" onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
              </label>
              <div className="token-rows">
                {THEME_FIELDS.map((f) => (
                  <label key={f.key} className="token-row">
                    <span>{f.label}</span>
                    {f.size ? (
                      <input
                        value={editor.tokens[f.key] ?? ''}
                        placeholder={f.def}
                        onChange={(e) => {
                          const v = e.target.value.trim();
                          const tokens = { ...editor.tokens };
                          if (v) tokens[f.key] = v; else delete tokens[f.key];
                          setEditor({ ...editor, tokens });
                        }}
                      />
                    ) : (
                      <>
                        <input
                          type="color"
                          value={editor.tokens[f.key] ?? f.def}
                          onChange={(e) => setEditor({ ...editor, tokens: { ...editor.tokens, [f.key]: e.target.value } })}
                        />
                        <code>{editor.tokens[f.key] ?? `${f.def}（默认）`}</code>
                      </>
                    )}
                  </label>
                ))}
              </div>
              <p className="pop-tip">只调要改的项；未动的项跟随系统默认（科技蓝）。</p>
              {msg && <p className="pop-tip err">{msg}</p>}
              <div className="modal-ops">
                <button className="act" onClick={() => setEditor(null)}>取消</button>
                <button className="act primary" disabled={busy || !editor.name.trim()} onClick={saveEditor}>保存方案</button>
              </div>
            </div>
          </div>
        )}
        {/* 删除确认（仅自定义方案） */}
        {delId && (
          <div className="modal-mask" onClick={() => setDelId(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <h3>删除自定义方案</h3>
              <p className="pop-tip">删除后全项目不可再选；已应用该方案的项目产物不受影响（令牌已随规划冻结）。操作记审计。</p>
              <div className="modal-ops">
                <button className="act" onClick={() => setDelId(null)}>取消</button>
                <button className="act primary" disabled={busy} onClick={doDelete}>确认删除</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** W7-003 原型解除定稿 modal（spec ⋯ 菜单「解锁定稿」；解锁后旧基线立即失效，可重新规划/生成迭代） */
function UnlockProtoModal({ onClose }: { onClose: () => void }) {
  const { projectId, refreshProto, setImpactNotice } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;
  const submit = () => {
    setBusy(true);
    setMsg(null);
    void designApi.protoUnlock(projectId)
      .then(() => {
        onClose();
        setImpactNotice('原型已解锁定稿——旧设计基线立即失效，开发输入须待再次定稿后以新指纹为准。');
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '解锁失败'))
      .finally(() => { setBusy(false); void refreshProto(); });
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>解除原型定稿</h3>
        <p className="pop-tip">
          解除后原型回到可迭代状态，可重新规划/生成/检查后再次定稿；旧设计基线立即失效，下游开发须等待新基线。操作记审计。
        </p>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={busy} onClick={submit}>确认解锁</button>
        </div>
      </div>
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
    <details className="v19-trace" open>
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

/** 基线数据（流程条导出 / 基线面板共用） */function useBaselines(projectId: string | null, protoStatus: string | null) {
  const [items, setItems] = useState<BaselineItem[] | null>(null);
  const reload = () => {
    if (projectId) void designApi.baselines(projectId).then((r) => setItems(r.items)).catch(() => setItems(null));
  };
  useEffect(reload, [projectId, protoStatus]);
  return { items, reload };
}

/** 读秒格式化（批量生成横幅：>60s 显示分+秒） */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
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
        <h3>人工定稿（共同基线）</h3>
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
        <strong>设计基线</strong>
        <span className="pop-tip">定稿后形成 · append-only · 上游（PRD/HLD/原型）任一变化即实时失效</span>
        <button className="act" onClick={reload}>↻</button>
      </div>
      {items === null ? <p className="pop-tip">加载中…</p> : items.length === 0 ? (
        <p className="pop-tip">尚无基线——原型通过对应性检查后，点流程条「定稿」形成首条基线；开发阶段的输入以有效基线为准。</p>
      ) : (
        <table className="rtm-table">
          <thead><tr><th>基线</th><th>当前</th><th>状态</th><th>定稿时间</th></tr></thead>
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

/** 目录分组中文名（展示层翻译，原始 type 保留在 code 列） */
const ITEM_TYPE_LABELS: Record<string, string> = {
  page: '页面', state: '状态', flow: '流程', component: '组件', dialog: '弹窗',
  viewport: '视口', theme: '主题', copy: '文案', asset: '资源', role: '角色',
};

/** 检查报告行内处置动作（键=proto-report.issueActions 返回的码；文案/提示在此单点维护） */
const ISSUE_ACTION_LABELS: Record<IssueAction, string> = {
  'add-page': '＋ 补录为页面',
  replan: '↻ 重新规划',
  exempt: '豁免',
  'edit-flow': '编辑流程',
  'gen-page': '🎨 生成此页',
};
const ISSUE_ACTION_HINTS: Record<IssueAction, string> = {
  'add-page': '把该 ui 册章节补录为目录页（标题已预填；补录后到左侧生成该页并重新 ③ 汇总）',
  replan: '重新执行 ① 识别规划（按当前 ui 册/PRD 重导目录；内容不变则复用现目录版本，已生成页面不受影响）',
  exempt: '骨架/通用页无 ui 册章节属正常——豁免后不再报警（重跑 ④ 检查生效）',
  'edit-flow': '打开该流程条目的步骤编辑（修正引用的页面/状态码）',
  'gen-page': '重新生成该页 UI 原型（随后需 ③ 汇总 + ④ 重跑检查）',
};

/** 设计目录面板（检查器栏 🗂 抽屉）：分组摘要 + 人工增删/条目修订（增删改=新目录版本；识别条目不可直删，REQ-304/306） */
function CatalogCard({ filter, onChanged }: { filter?: string; onChanged: () => void }) {
  const { projectId, catalog } = useDesignView();
  const [addOpen, setAddOpen] = useState(false);
  const [delTarget, setDelTarget] = useState<{ itemId: string; label: string } | null>(null);
  const [editTarget, setEditTarget] = useState<{ itemType: string; item: CatalogGroup } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !catalog) return null;
  const q = (filter ?? '').trim();
  const match = (it: CatalogGroup) =>
    !q || it.code.includes(q) || ((it.payload.title as string) ?? '').includes(q);
  const groups = Object.entries(catalog.groups)
    .map(([g, items]) => [g, (items as CatalogGroup[]).filter(match)] as const)
    .filter(([, items]) => items.length > 0);
  const totalItems = Object.values(catalog.groups).reduce((n, items) => n + items.length, 0);
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
        <span className="pop-tip">对应性检查的期望基准 · 共 {totalItems} 条目 · 增删改即产新目录版本</span>
        <button className="act" onClick={() => setAddOpen(true)}>＋ 人工补充条目</button>
      </div>
      {msg && <p className="pop-tip err">{msg}</p>}
      {groups.length === 0 ? <p className="pop-tip">{q ? `筛选「${q}」无命中条目。` : '规划后生成目录条目。'}</p> : groups.map(([g, items]) => (
        <div key={g} className="cat-group">
          <div className="cat-group-head">{ITEM_TYPE_LABELS[g] ?? g} <code>{g}</code> <span className="mut">×{items.length}</span></div>
          {items.map((it) => (
            <div key={it.itemId} className="issue-row">
              <code>{it.code}</code> {(it.payload.title as string) ?? ''}
              <span className="mut">[{it.source === 'manual' ? '人工' : '识别'}{it.required ? '·必需' : ''}{it.payload.exempt === true ? '·已豁免' : ''}]</span>
              <button className="act" onClick={() => setEditTarget({ itemType: g, item: it })}>编辑</button>
              {it.source === 'manual' && <button className="act" onClick={() => setDelTarget({ itemId: it.itemId, label: `${it.code} ${(it.payload.title as string) ?? ''}` })}>删除</button>}
            </div>
          ))}
        </div>
      ))}
      {addOpen && <AddItemModal onClose={() => setAddOpen(false)} onChanged={onChanged} />}
      {editTarget && <EditItemModal itemType={editTarget.itemType} item={editTarget.item} onClose={() => setEditTarget(null)} onChanged={onChanged} />}
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

/**
 * 目录条目修订弹层（覆盖检测 §2/§3：title/note/流程步骤 steps/豁免 exempt 白名单；
 * 编辑即产生新目录版本，需 re-plan 后反映到汇总原型（定稿门禁会以目录指纹比对强制改后重跑检查）。
 * flow 条目增步骤编辑（一行一步骤）；exempt 为「页有册无」人工豁免标记（与 RTM deferred 两套机制，互不通用）。
 */
function EditItemModal({ itemType, item, onClose, onChanged }: {
  itemType: string;
  item: CatalogGroup;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { projectId } = useDesignView();
  const [title, setTitle] = useState((item.payload.title as string) ?? '');
  const [note, setNote] = useState((item.payload.note as string) ?? '');
  const [exempt, setExempt] = useState(item.payload.exempt === true);
  const [stepsText, setStepsText] = useState(((item.payload.steps as string[] | undefined) ?? []).join('\n'));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;
  const submit = () => {
    setBusy(true);
    setMsg(null);
    const input: { title: string; note: string; exempt: boolean; steps?: string[] } = {
      title: title.trim(), note, exempt,
    };
    if (itemType === 'flow') input.steps = stepsText.split('\n').map((s) => s.trim()).filter(Boolean);
    void designApi.updateCatalogItem(projectId, item.itemId, input)
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '保存失败'))
      .finally(() => { setBusy(false); onChanged(); });
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>编辑目录条目 {item.code}</h3>
        <p className="pop-tip">
          仅标题/备注/{itemType === 'flow' ? '流程步骤/' : ''}豁免可改（识别字段如 REQ 关联不可改）；保存即产生新目录版本（记审计）。
        </p>
        <label className="form-row">标题 <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="form-row">备注 <input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {itemType === 'flow' && (
          <label className="form-row">流程步骤（一行一步骤）
            <textarea value={stepsText} onChange={(e) => setStepsText(e.target.value)} rows={5} />
            <span className="pop-tip">
              引用页面写作 P-002 或 P-002/ST-empty（汇总原型流程视图中可点击跳转，检查时校验目标存在）；自然语言步骤仅展示不跳转。
            </span>
          </label>
        )}
        <label className="form-row">
          <input type="checkbox" checked={exempt} onChange={(e) => setExempt(e.target.checked)} />
          豁免对应性检查（页有册无 不报警；re-plan 随行保留；与需求侧 RTM deferred 无关）
        </label>
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={busy || !title.trim()} onClick={submit}>保存（产生新目录版本）</button>
        </div>
      </div>
    </div>
  );
}

const ITEM_TYPES = ['page', 'state', 'component', 'dialog', 'flow', 'viewport', 'theme', 'copy', 'asset'] as const;

function AddItemModal({ prefill, hint, onClose, onChanged }: {
  /** 报告行内「补录为页面」入口的预填（类型/标题）；hint=补录后的操作指引 */
  prefill?: { itemType: string; title: string };
  hint?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { projectId } = useDesignView();
  const [itemType, setItemType] = useState<string>(prefill?.itemType ?? 'page');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState(prefill?.title ?? '');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!projectId) return null;
  const submit = () => {
    setBusy(true);
    setMsg(null);
    void designApi.addCatalogItem(projectId, { itemType, code: code.trim(), title: title.trim(), ...(note.trim() ? { note: note.trim() } : {}) })
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '新增失败'))
      .finally(() => { setBusy(false); onChanged(); });
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>＋ 人工补充目录条目</h3>
        <p className="pop-tip">人工条目标记 source=manual，对应性检查时列入「需人工核对」（不静默通过，REQ-306）。</p>
        {hint && <p className="pop-tip">{hint}</p>}
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
          <button className="act primary" disabled={busy || !code.trim() || !title.trim()} onClick={submit}>新增（产生新目录版本）</button>
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
    <div className="rtm-card" style={{ marginTop: 8 }}>
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
