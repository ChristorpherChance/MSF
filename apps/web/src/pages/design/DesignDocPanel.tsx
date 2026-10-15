import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mdHtml } from '../../md-html';
import { ApiError } from '../../api';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
import { Modal } from '../../ui/Modal';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { toast } from '../../ui/toast';
import { downloadFile } from '../../ui/download';
import { DocTemplateButton } from '../../ui/DocTemplateButton';
import { TemplateRefreshModal } from '../../ui/TemplateRefreshModal';
import { useDockStore } from '../../assistant/dock-store';
import { diffText } from '../req/diff';
import { deriveNumbering } from '@msf/shared/doc-numbering';
import { designApi, generateDesignDoc, type DesignKind, type PatchItem, type UpstreamDocItem } from './api';
import { useDesignView, type ViewMode } from './store';

/** S2 分册行图标（📐 概要 / 📋 详细七册） */
const BOOK_ICONS: Record<DesignKind, string> = {
  hld: '📐', mod: '📋', alg: '🧮', cls: '🧩', db: '🗄️', api: '🔌', ui: '🎨', nfr: '🛡️',
};

/**
 * 设计文档面（LLD-6 §3.4：与需求页同构——左分册列表 + 目录栏 + 文档区 + 工具栏/横幅/补丁）。
 * 概要页签=HLD 单册；详细页签=七册左列表平铺。
 */
export function DesignDocPanel({ kinds }: { kinds: DesignKind[] }) {
  const { books, selKind, selectBook } = useDesignView();
  const isDetail = kinds.length > 1;
  const [batchOpen, setBatchOpen] = useState(false);
  return (
    <div className="design-doc-layout">
      <aside className="book-col">
        <div className="book-col-head">{isDetail ? `详细设计工件（${kinds.length}）` : '概要设计工件（1）'}</div>
        {isDetail && <div className="book-col-sub">按方面分册（{kinds.length}）</div>}
        {kinds.map((k) => {
          const b = books.find((x) => x.kind === k);
          const ungenerated = b !== undefined && b.cur === 0;
          return (
            <button key={k} className={`book-row${selKind === k ? ' on' : ''}`} onClick={() => void selectBook(k)}>
              <span className="book-ico">{BOOK_ICONS[k]}</span>
              <span className="book-name">
                {b?.title ?? k}
                {b && !ungenerated && (
                  <span className="book-note">
                    v{b.cur}{b.modified && !b.finalized ? ' · 已修改未提交' : ''}
                    {b.upstreamStale ? ' · ⚠ 上游已变' : ''}
                  </span>
                )}
              </span>
              <span className={`tag ${ungenerated ? '' : b?.finalized ? 'tag-ok' : 'tag-warn'}`}>
                {b ? (ungenerated ? '未生成' : b.finalized ? '已定稿' : '修订中') : '…'}
              </span>
            </button>
          );
        })}
        <div className="book-col-foot">
          消费链：PRD 定稿 → 概要设计定稿 → 详细七册定稿；定稿登记 DSG-* 节点（REQ→DSG implements）。
          {isDetail && (
            <button className="act" style={{ marginTop: 6, width: '100%' }} onClick={() => setBatchOpen(true)}>
              ✓ 批量定稿（七册）
            </button>
          )}
        </div>
      </aside>
      <div className="req-doc" style={{ flex: 1 }}>
        <Toolbar />
        <Banners />
        <div className="req-body">
          <TocCol />
          <Paper />
        </div>
      </div>
      {batchOpen && <BatchFinalizeModal onClose={() => setBatchOpen(false)} />}
    </div>
  );
}

/** 批量定稿弹层（2026-10-16 拍板：除 hld 外七册一键定稿；逐册独立、失败跳过并列原因；
 *  openReviews 为项目级门禁（finalize 命令口径）——有未决评审项须显式勾选二次确认（记审计）。 */
function BatchFinalizeModal({ onClose }: { onClose: () => void }) {
  const { projectId, books, openReviews, refresh } = useDesignView();
  const [allow, setAllow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [result, setResult] = useState<{ finalized: Array<{ kind: DesignKind; v: number }>; skipped: Array<{ kind: DesignKind; reason: string }> } | null>(null);
  if (!projectId) return null;
  const titleOf = (k: DesignKind) => books.find((b) => b.kind === k)?.title ?? k.toUpperCase();
  // 预检提示（服务端仍会逐册复核，此处只是告知）：可定稿=有内容+未定稿+无未提交修改
  const rows = (['mod', 'alg', 'cls', 'db', 'api', 'ui', 'nfr'] as DesignKind[]).map((k) => {
    const b = books.find((x) => x.kind === k);
    const state = !b || b.cur === 0 ? '无内容' : b.finalized ? '已定稿' : b.modified ? '有未提交修改' : `可定稿（v${b.cur}）`;
    return { kind: k, title: titleOf(k), state, runnable: state.startsWith('可定稿') };
  });
  const runnableCount = rows.filter((r) => r.runnable).length;
  const submit = () => {
    setBusy(true);
    setMsg(null);
    void designApi.finalizeAll(projectId, allow)
      .then((r) => { setResult(r); void refresh(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '批量定稿失败'))
      .finally(() => setBusy(false));
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>批量定稿（详细设计七册）</h3>
        {!result && (
          <>
            <p className="pop-tip">逐册独立定稿：每册单独留痕登记，某一册不满足条件只会跳过该册并在结果中列明原因，不影响其它册。</p>
            <div style={{ margin: '8px 0' }}>
              {rows.map((r) => (
                <div key={r.kind} className="form-row" style={{ justifyContent: 'space-between' }}>
                  <span>{BOOK_ICONS[r.kind]} {r.title}</span>
                  <span className={`tag ${r.runnable ? 'tag-warn' : r.state === '已定稿' ? 'tag-ok' : ''}`}>{r.state}</span>
                </div>
              ))}
            </div>
            {openReviews > 0 && (
              <label className="gate-box err" style={{ display: 'block' }}>
                <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
                {''}存在 {openReviews} 条未决评审项，我确认仍要定稿（记审计）
              </label>
            )}
            {msg && <p className="pop-tip err">{msg}</p>}
            <div className="modal-acts">
              <button className="act" onClick={onClose} disabled={busy}>取消</button>
              <button className="act primary" disabled={busy || runnableCount === 0 || (openReviews > 0 && !allow)} onClick={submit}>
                {busy ? '定稿中…' : `确认定稿（${runnableCount} 册）`}
              </button>
            </div>
          </>
        )}
        {result && (
          <>
            <p className="pop-tip">
              已定稿 {result.finalized.length} 册{result.skipped.length > 0 ? `；跳过 ${result.skipped.length} 册` : ''}。
            </p>
            {result.finalized.map((f) => (
              <div key={f.kind} className="form-row" style={{ justifyContent: 'space-between' }}>
                <span>{BOOK_ICONS[f.kind]} {titleOf(f.kind)}</span>
                <span className="tag tag-ok">已定稿 v{f.v}</span>
              </div>
            ))}
            {result.skipped.map((s) => (
              <div key={s.kind} className="form-row" style={{ justifyContent: 'space-between' }}>
                <span>{BOOK_ICONS[s.kind]} {titleOf(s.kind)}</span>
                <span className="pop-tip err" style={{ margin: 0 }}>{s.reason}</span>
              </div>
            ))}
            <div className="modal-acts">
              <button className="act primary" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Toolbar() {
  const { projectId, doc, versions, viewMode, setViewMode, loadDoc, refresh, selKind, gen, impactNotice, setImpactNotice } = useDesignView();
  const [moreOpen, setMoreOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [finOpen, setFinOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const [tlOpen, setTlOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const readonly = doc.finalized || doc.viewing !== null;
  const generating = gen.running || doc.genState === 'generating';
  const pendCount = useDesignView.getState().patches.filter((p) => p.status === 'pending').length;
  const bookTitle = useDesignView.getState().books.find((b) => b.kind === selKind)?.title ?? selKind.toUpperCase();

  // 瞬时异常收为图标点（根简化：工具栏只留操作，状态移正文 H1；点开看详情）
  const errItems: StatusChipItem[] = [];
  if (impactNotice) {
    errItems.push({
      key: 'impact', tone: 'warn', label: '⚡',
      detail: (
        <>
          {impactNotice}
          <br />
          <button className="act" onClick={() => setImpactNotice(null)}>知道了</button>
        </>
      ),
    });
  }
  if (gen.error) {
    errItems.push({
      key: 'generr', tone: 'err', label: '⛔',
      detail: `生成失败（${gen.error}），草稿与版本未受影响，可重新发起。`,
    });
  }

  const act = (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    void fn()
      .then(() => { if (ok) setMsg(ok); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };

  // W2-025：undo/redo 失败走 toast（自动消散），不占工具栏常驻 msg 位
  const undoRedo = (fn: () => Promise<unknown>) => {
    void fn()
      .catch((e) => toast(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败', 'warn'))
      .finally(() => void refresh());
  };

  return (
    <div className="doc-toolbar req-toolbar">
      <select
        className="ver-select"
        title="版本下拉：历史版本只读查看"
        value={doc.viewing ?? doc.cur}
        onChange={(e) => void loadDoc(Number(e.target.value))}
      >
        {versions.map((v) => (
          <option key={v.v} value={v.v}>v{v.v}{v.finalized ? '（定稿）' : ''}{v.note ? ` · ${v.note}` : ''}</option>
        ))}
      </select>
      <div className="pop-wrap">
        <button className="act" title="生成参考：上游定稿自动装配 + 可勾选内容已定稿资料（REQ-114）" onClick={() => setRefsOpen(!refsOpen)}>📚 参考资料 ▾</button>
        {refsOpen && <DesignRefsPopover onClose={() => setRefsOpen(false)} />}
      </div>
      <span className="sep" />
      {/* W2-025：栈空即置灰（与需求域同口径） */}
      <button
        className="act" disabled={readonly || doc.canUndo === false}
        title={doc.canUndo === false ? '无可撤销（栈随草稿消亡）' : '撤销'}
        onClick={() => undoRedo(() => designApi.undo(projectId, selKind))}>↩</button>
      <button
        className="act" disabled={readonly || doc.canRedo === false}
        title={doc.canRedo === false ? '无可重做（栈随草稿消亡）' : '重做'}
        onClick={() => undoRedo(() => designApi.redo(projectId, selKind))}>↪</button>
      <div className="pop-wrap">
        <button className="act" title="下载当前查看版本（服务端导出，审计留痕）" onClick={() => setDlOpen(!dlOpen)}>⬇ 下载 ▾</button>
        {dlOpen && (
          <div className="popover menu">
            <div className="pop-tip" style={{ padding: '4px 10px' }}>下载当前文档 v{doc.viewing ?? doc.cur}</div>
            {(['md', 'docx', 'pdf'] as const).map((f) => (
              <button key={f} className="act" onClick={() => {
                setDlOpen(false);
                act(async () => {
                  const r = await designApi.exportDoc(projectId, selKind, doc.viewing ?? doc.cur, f);
                  downloadFile(r.downloadUrl);
                });
              }}>⬇ {{ md: 'Markdown (.md)', docx: 'Word (.docx)', pdf: 'PDF (.pdf)' }[f]}</button>
            ))}
          </div>
        )}
      </div>
      <DocTemplateButton projectId={projectId} kind={selKind} label={bookTitle} />
      <button className="act" title="按当前生效模板骨架批量重排文档（提案逐册人工确认后生效）" onClick={() => setRefreshOpen(true)}>⇄ 模板重排…</button>
      {refreshOpen && <TemplateRefreshModal projectId={projectId} onClose={() => setRefreshOpen(false)} />}
      <button
        className="act primary"
        disabled={readonly || !doc.modified || generating || pendCount > 0}
        title={pendCount > 0 ? '仍有待确认修改，请先逐一接受/拒绝' : doc.modified ? `提交为 v${Math.max(...versions.map((v) => v.v), doc.cur) + 1}` : '当前版本未修改，无可提交内容'}
        onClick={() => setCommitOpen(true)}
      >⬆ 版本提交</button>
      <button
        className="act"
        disabled={readonly || gen.running}
        title={doc.genState === 'generating' && !gen.running ? '上次生成可能已中断（后端重启），点击重新发起' : 'AI 生成设计文档'}
        onClick={() => setGenOpen(true)}
      >
        {generating ? '⚡ 生成中…' : '🔄 重新生成'}
      </button>
      {doc.finalized ? (
        <button className="act" disabled>✓ 已定稿</button>
      ) : (
        <button
          className="act primary"
          disabled={readonly || doc.modified || generating || pendCount > 0}
          title={pendCount > 0 ? '仍有待确认修改，请先逐一处理' : doc.modified ? '有未提交修改，请先「版本提交」再定稿' : '定稿为只读基线（人工确认点）'}
          onClick={() => setFinOpen(true)}
        >✓ 定稿</button>
      )}
      <div className="pop-wrap">
        <button className="act" onClick={() => setMoreOpen(!moreOpen)}>⋯</button>
        {moreOpen && (
          <div className="popover menu">
            {doc.finalized && (
              <button className="act" onClick={() => { setMoreOpen(false); setUnlockOpen(true); }}>
                🔓 解锁定稿
              </button>
            )}
            <button className="act" onClick={() => { setMoreOpen(false); setTlOpen(true); }}>
              🕒 版本时间线
            </button>
            <button
              className="act"
              onClick={() => {
                setMoreOpen(false);
                const url = `${window.location.origin}/design?book=${selKind}&v=${doc.viewing ?? doc.cur}`;
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast('分享链接已复制到剪贴板', 'success'))
                  .catch(() => toast(url));
              }}
            >
              🔗 复制分享链接
            </button>
            {doc.viewing !== null && (
              <button className="act" onClick={() => { setMoreOpen(false); act(() => designApi.switchVersion(projectId, selKind, doc.viewing!), `已切换当前版本为 v${doc.viewing}`); }}>
                ⤺ 设为当前版本
              </button>
            )}
            <button className="act" onClick={() => setMoreOpen(false)}>取消</button>
          </div>
        )}
      </div>
      <span className="sep" />
      <span className="viewmode" role="group" aria-label="视图三态">
        {([['preview', '预览'], ['edit', '编辑'], ['source', 'Markdown 源码']] as Array<[ViewMode, string]>).map(([m, label]) => (
          <button key={m} className={viewMode === m ? 'on' : ''} onClick={() => setViewMode(m)}>{label}</button>
        ))}
      </span>
      <StatusChips items={errItems} />
      {msg && <span className="rsn">{msg}</span>}
      {commitOpen && <CommitModal onClose={() => setCommitOpen(false)} />}
      {finOpen && <FinalizeModal onClose={() => setFinOpen(false)} />}
      {genOpen && <GenerateModal onClose={() => setGenOpen(false)} />}
      {unlockOpen && (
        <Modal title="🔓 解锁定稿" onClose={() => setUnlockOpen(false)} footer={
          <>
            <button className="sm" onClick={() => setUnlockOpen(false)}>取消</button>
            <button className="sm primary" onClick={() => { setUnlockOpen(false); act(() => designApi.unlock(projectId, selKind), '已解锁定稿'); }}>确认解锁</button>
          </>
        }>
          <p>解除《{bookTitle}》v{doc.finalVer} 的定稿锁定，文档回到可编辑状态。</p>
          <p className="pop-tip">影响面：解锁记审计；下游（原型规划 / 开发任务输入）已消费本定稿的，其输入基线将实时失效需重确认。</p>
        </Modal>
      )}
      {tlOpen && <VersionTimelineModal onClose={() => setTlOpen(false)} />}
    </div>
  );
}

/** 版本时间线（原型 designMenu「🕒 版本时间线」）：版本倒序列出，可跳看历史（只读） */
function VersionTimelineModal({ onClose }: { onClose: () => void }) {
  const { versions, doc, loadDoc, selKind } = useDesignView();
  if (!doc) return null;
  const bookTitle = useDesignView.getState().books.find((b) => b.kind === selKind)?.title ?? selKind.toUpperCase();
  return (
    <Modal title={`${bookTitle} 版本时间线`} onClose={onClose}>
      <ul className="v-timeline">
        {[...versions].sort((a, b) => b.v - a.v).map((v) => (
          <li key={v.v} className={`v-tl-item${v.v === doc.cur ? ' cur' : ''}`}>
            <span className="v-tl-dot" />
            <div className="v-tl-main">
              <strong>
                v{v.v}
                {v.finalized && <span className="tag tag-ok">定稿</span>}
                {v.v === doc.cur && <span className="tag">当前</span>}
              </strong>
              <span className="mut">
                {v.at}
                {v.note ? ` · ${v.note}` : ''}
              </span>
            </div>
            {v.v !== doc.cur && (
              <button className="act" onClick={() => { onClose(); void loadDoc(v.v); }}>查看</button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function Banners() {
  // 状态横幅已收编为工具栏 StatusChips；此处只保留生成活动卡（进行中的实时进度，非状态提示）
  const { gen } = useDesignView();
  return <>{(gen.running || gen.streamText) && <GenStreamCard />}</>;
}

function GenStreamCard() {
  const { gen, projectId, selKind, refresh } = useDesignView();
  const ctl = (action: 'pause' | 'resume' | 'stop') => {
    if (!projectId || !gen.operationId) return;
    void designApi.genControl(projectId, selKind, gen.operationId, action).then(() => refresh());
  };
  // U-018：与需求域同口径的章节级实时进度（流文本按 ## 标题增量切分）
  const sections = [...gen.streamText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
  const runningIdx = gen.running ? sections.length - 1 : -1;
  return (
    <div className="gen-card" role="status">
      <div className="gen-head">
        <strong>{gen.running ? (gen.paused ? '⏸ 已暂停' : '⚡ AI 生成中…') : '✓ 生成完成'}</strong>
        {/* #5 生成来源可辨识：mock 桩产出勿直接定稿 */}
        {gen.source === 'mock' && (
          <span className="tag tag-warn" title="未接真模型（MSF_AI_PROVIDER 未配置或 generation 用途路由缺失），产出为桩内容，勿直接定稿">mock 桩</span>
        )}
        {gen.source === 'model' && (
          <span className="tag tag-ok" title="真实模型生成（generation 用途路由）">真模型</span>
        )}
        {gen.running && (
          <span className="gen-ops">
            {gen.paused
              ? <button className="act" disabled={!gen.operationId} onClick={() => ctl('resume')}>▶ 继续</button>
              : <button className="act" disabled={!gen.operationId} onClick={() => ctl('pause')}>⏸ 暂停</button>}
            <button className="act" disabled={!gen.operationId} onClick={() => ctl('stop')}>⏹ 停止</button>
          </span>
        )}
      </div>
      {sections.length > 0 && (
        <div className="tasklist">
          <div className="tl-head">章节 Task（实时）· {sections.length}</div>
          {sections.map((s, i) => (
            <div key={`${i}-${s}`} className={`tl-item${i === runningIdx ? ' tl-enter' : ''}`}>
              <span className="st">{i === runningIdx ? '🔄' : '✅'}</span>
              <span style={{ flex: 1 }}>{s} · 生成</span>
              {i === runningIdx && (
                <div className="prog" style={{ width: 80 }}>
                  <i className="indet" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <details className="gen-raw">
        <summary>查看原始输出流</summary>
        <pre className="gen-stream">{gen.streamText || '等待模型输出…'}</pre>
      </details>
      {!gen.running && !gen.error && <p className="pop-tip">生成结果为待确认补丁（不落稿），请逐条处置后提交版本。</p>}
    </div>
  );
}

function TocCol() {
  const { doc, tocFlash, flashToc } = useDesignView();
  // 派生编号（渲染层注入，存储零改动；与需求页同函数同口径——2026-10-06「所有文档都要有章节号」）
  const numbered = useMemo(() => (doc ? new Map(deriveNumbering(doc.secs).map((n) => [n.id, n])) : null), [doc]);
  const hasChapter = !!numbered && [...numbered.values()].some((n) => n.chapter);
  if (!doc) return null;
  const tocSecs = doc.secs.filter((s) => s.title);
  return (
    <aside className="toc-col">
      <div className="toc-title">目录 <span className="dz-note">{tocSecs.length} 章</span></div>
      {tocSecs.map((s) => {
        const n = numbered?.get(s.id);
        return (
          <button
            key={s.id}
            className={`toc-item${n?.chapter ? ' chapter' : hasChapter ? ' sub' : ''}${tocFlash === s.id ? ' flash' : ''}${s.pending ? ' has-pend' : ''}`}
            onClick={() => {
              document.getElementById(`dsec-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              flashToc(s.id);
            }}
          >
            {n?.display || s.title}
          </button>
        );
      })}
    </aside>
  );
}

function Paper() {
  const { doc, viewMode, patches, tocFlash, books, selKind, flashPatch } = useDesignView();
  // 派生编号（渲染层注入，存储零改动；与需求页同函数同口径）
  const numbered = useMemo(() => (doc ? new Map(deriveNumbering(doc.secs).map((n) => [n.id, n])) : null), [doc]);
  if (!doc) return null;
  // replace=整篇重写补丁不挂节（secId 恒 s0 但语义是全文替换）——专属块渲染在正文最上方（req 域同口径）
  const pendBySec = new Map(patches.filter((p) => p.status === 'pending' && p.type !== 'replace').map((p) => [p.secId, p]));
  const appended = patches.filter((p) => p.status === 'pending' && p.type === 'add');
  const replaces = patches.filter((p) => p.status === 'pending' && p.type === 'replace');
  const pendCount = pendBySec.size + appended.length + replaces.length;
  const bookTitle = books.find((b) => b.kind === selKind)?.title ?? selKind.toUpperCase();
  // 页内定位：点击「补丁 ×N」滚动到第一条待确认补丁（req 域同口径）
  const locateFirstPending = () => {
    const first = patches.find((p) => p.status === 'pending');
    if (!first) return;
    document.getElementById(`patch-${first.patchId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashPatch(first.patchId);
  };
  if (viewMode === 'source') {
    const full = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
    return <div className="doc-scroll"><div className="paper"><pre className="md-src">{full}</pre></div></div>;
  }
  const readonly = doc.finalized || doc.viewing !== null;
  return (
    <div className="doc-scroll">
      {/* 待确认补丁常驻横幅（吸附正文顶部）：定位 + 批量处置；有条数即显，不再藏进 h1（req 域同口径） */}
      <PatchBulk readonly={readonly} />
      <div className="paper">
        <h1>
          {bookTitle} · v{doc.viewing ?? doc.cur}
          {doc.finalized && (
            <span className="tag tag-ok" title="内容字节冻结，下游（LLD/原型规划）以此指纹为治理输入；修改请先在 ⋯ 菜单「解锁定稿」（留审计）">已定稿 v{doc.finalVer}</span>
          )}
          {doc.viewing !== null && (
            <span className="tag tag-warn" title="历史版本只读；⋯ 菜单可「设为当前版本」，版本下拉可切回当前">历史只读</span>
          )}
          {!doc.finalized && doc.modified && doc.viewing === null && (
            <span className="tag tag-warn" title="工作区有未提交修改；工具栏「⬆ 版本提交」生成新版本">已修改未提交</span>
          )}
          {doc.upstreamStale && doc.viewing === null && (
            <span className="tag tag-warn" title={`PRD 已提交更新的 v${doc.upstreamVersionNo ?? ''}，本册内容可能滞后；建议复核（重新生成或增量修订）`}>⚠ 上游已变·待复核</span>
          )}
          {pendCount > 0 && (
            <button
              className="tag tag-warn tag-btn"
              title="待确认补丁：在下方各章节行内逐条接受或拒绝（REQ-305）。点击定位到第一条待确认补丁"
              onClick={locateFirstPending}
            >
              补丁 ×{pendCount} → 点击定位
            </button>
          )}
        </h1>
        {replaces.map((p) => (
          <section key={p.patchId} className="sect pending-replace-sec">
            <PendingBar patch={p} />
          </section>
        ))}
        {doc.secs.map((s) => (
          <section key={s.id} id={`dsec-${s.id}`} className={`sect${tocFlash === s.id ? ' flash' : ''}`}>
            {/* 补丁条在章节标题之前（原型口径：pending-bar → h2 → 正文） */}
            {s.pending && pendBySec.get(s.id) && <PendingBar patch={pendBySec.get(s.id)!} />}
            {s.title && <h2 className={numbered?.get(s.id)?.chapter ? 'chapter' : 'sect-item'}>{numbered?.get(s.id)?.display || s.title}</h2>}
            {viewMode === 'preview' ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(s.md) }} />
            ) : (
              <SectionEditor secId={s.id} md={s.md} readonly={readonly} />
            )}
          </section>
        ))}
        {appended.map((p) => (
          <section key={p.patchId} className="sect pending-add">
            <PendingBar patch={p} />
            {p.title && <h2>{p.title}</h2>}
            <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(p.new ?? '') }} />
          </section>
        ))}
      </div>
    </div>
  );
}

function SectionEditor({ secId, md, readonly }: { secId: string; md: string; readonly: boolean }) {
  const { projectId, selKind, doc, refresh } = useDesignView();
  const [text, setText] = useState(md);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const dirty = text !== md;
  const save = () => {
    setMsg(null);
    void designApi.saveDraft(projectId, selKind, secId, text, doc.cur, doc.contentFingerprint)
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '保存失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="sec-editor">
      <textarea value={text} rows={Math.min(20, Math.max(4, text.split('\n').length + 1))} disabled={readonly} onChange={(e) => setText(e.target.value)} />
      {!readonly && (
        <div className="sec-ops">
          <button className="act primary" disabled={!dirty} onClick={save}>保存本节</button>
          {dirty && <button className="act" onClick={() => setText(md)}>放弃</button>}
          {msg && <span className="rsn err">{msg}</span>}
        </div>
      )}
    </div>
  );
}

/** 待确认补丁常驻横幅（需求阶段模式推广：吸附正文顶部，定位+批量处置；有条数即显，不再藏进 h1） */
function PatchBulk({ readonly }: { readonly: boolean }) {
  const { projectId, selKind, patches, refresh, flashPatch } = useDesignView();
  const [busy, setBusy] = useState(false);
  const [confirmOp, setConfirmOp] = useState<'accept' | 'reject' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const pending = patches.filter((p) => p.status === 'pending');
  if (pending.length === 0) return null;
  const locate = () => {
    document.getElementById(`patch-${pending[0]!.patchId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flashPatch(pending[0]!.patchId);
  };
  const run = async (op: 'accept' | 'reject') => {
    setBusy(true);
    setMsg(null);
    let done = 0;
    try {
      for (const p of pending) {
        if (op === 'accept') await designApi.acceptPatch(projectId, selKind, p.patchId);
        else await designApi.rejectPatch(projectId, selKind, p.patchId);
        done += 1;
      }
      toast(`已${op === 'accept' ? '接受' : '拒绝'} ${done} 条补丁`, 'success');
    } catch (e) {
      setMsg(`${e instanceof ApiError ? e.message : '批量操作失败'}（已完成 ${done}/${pending.length}，剩余可重试）`);
    } finally {
      setBusy(false);
      setConfirmOp(null);
      await refresh();
    }
  };
  return (
    <div className="patch-banner">
      <span className="pb-text">
        ⚠ {pending.length} 条待确认补丁：AI 提案不落稿，须在文中高亮处逐条处置
      </span>
      <button className="act sm" onClick={locate}>↓ 定位第一条</button>
      {!readonly && (
        <>
          <button className="act primary sm" disabled={busy} title="逐条接受全部待确认补丁（逐条留审计）"
            onClick={() => setConfirmOp('accept')}>✓ 全部接受</button>
          <button className="act sm" disabled={busy} title="逐条拒绝全部待确认补丁"
            onClick={() => setConfirmOp('reject')}>✕ 全部拒绝</button>
        </>
      )}
      {msg && <span className="rsn err">{msg}</span>}
      {confirmOp && (
        <ConfirmModal
          title={confirmOp === 'accept' ? '全部接受补丁' : '全部拒绝补丁'}
          body={`将逐条${confirmOp === 'accept' ? '接受' : '拒绝'}当前 ${pending.length} 条待确认补丁（逐条留审计，REQ-305 确认语义不变）。\n接受 = 并入草稿；拒绝 = 丢弃提案。`}
          confirmLabel={confirmOp === 'accept' ? '全部接受' : '全部拒绝'}
          onClose={() => setConfirmOp(null)}
          onConfirm={() => void run(confirmOp)}
        />
      )}
    </div>
  );
}

/** 待确认补丁行内条（需求阶段模式推广，与 req PendingBar 全同构）：
 *  ①modify/replace 渲染行级 diff 逐块 md 预览（删红增绿）；②「改后接受」内联编辑后并入（newText 覆盖留痕）；
 *  ③拒绝弹窗可填理由（落库）+「拒绝并请 AI 修订」回喂 dock（AI 修订后重新提案） */
function PendingBar({ patch }: { patch: PatchItem }) {
  const { projectId, selKind, doc, refresh, patchFlash } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [editOpen, setEditOpen] = useState(false);
  const [editText, setEditText] = useState(patch.new ?? '');
  // replace=整篇重写：对比基线是当前全文（草稿优先同服务端口径），逐块 md 预览
  const fullText = useMemo(
    () => (doc ? doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).filter((t) => t.trim() !== '').join('\n\n') : ''),
    [doc],
  );
  const diffSegs = useMemo(
    () => (patch.type === 'modify' ? diffText(patch.old ?? '', patch.new ?? '')
      : patch.type === 'replace' ? diffText(fullText, patch.new ?? '')
        : null),
    [patch.type, patch.old, patch.new, fullText],
  );
  if (!projectId) return null;
  const act = (fn: () => Promise<unknown>) => {
    setMsg(null);
    void fn()
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };
  /** 拒绝；feedback=true 时把拒绝理由结构化回喂 dock（AI 修订后重新提案，闭环对话改文档） */
  const doReject = (feedback: boolean) => {
    setRejectOpen(false);
    const r = reason.trim();
    setMsg(null);
    void designApi.rejectPatch(projectId, selKind, patch.patchId, r || undefined)
      .then(async () => {
        if (!feedback) return;
        useDockStore.setState({ open: true });
        await useDockStore.getState().setCtx('design', selKind);
        const clip = (s?: string | null, n = 300) => {
          const t = s ?? '';
          return t.length > n ? `${t.slice(0, n)}…` : t;
        };
        await useDockStore.getState().sendText([
          `我刚才拒绝了你在设计册的一条修改提案。`,
          patch.title ? `章节：${patch.title}` : '',
          `提案类型：${patch.type === 'add' ? '新增' : patch.type === 'del' ? '删除' : patch.type === 'replace' ? '整篇重写' : '修改'}`,
          patch.old ? `原文：${clip(patch.old)}` : '',
          patch.new ? `提案新文：${clip(patch.new)}` : '',
          `拒绝理由：${r || '（未填写）'}`,
          '请按拒绝理由修订后重新提案（使用 design.doc.propose_edits 工具，只提交修订后的内容）。',
        ].filter(Boolean).join('\n'));
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };
  return (
    <div
      id={`patch-${patch.patchId}`}
      className={`pending-bar pending-${patch.type === 'modify' ? 'mod' : patch.type === 'del' ? 'del' : patch.type === 'replace' ? 'replace' : 'add'}${patchFlash === patch.patchId ? ' flash' : ''}`}
    >
      <span className={`plabel ${patch.type === 'modify' ? 'mod' : patch.type}`}>
        ● 待确认·{patch.type === 'add' ? '新增' : patch.type === 'del' ? '删除' : patch.type === 'replace' ? '整篇重写' : '修改'}
      </span>
      <span className="pend-desc">
        {patch.type === 'add' ? `「${patch.title ?? '章节'}」`
          : patch.type === 'replace' ? '「全文替换（下为整篇对比）」'
            : `「${patch.title ?? patch.secId}」`}
        <em>（{patch.source === 'ai' ? 'AI 提案' : patch.source}）</em>
      </span>
      <button className="act primary" onClick={() => act(() => designApi.acceptPatch(projectId, selKind, patch.patchId))}>✓ 接受</button>
      {patch.type !== 'del' && (
        <button className="act" title="先编辑提案新文，再以编辑后的文本并入草稿（留「改后接受」痕）"
          onClick={() => setEditOpen(!editOpen)}>✎ 改后接受</button>
      )}
      <button className="act" onClick={() => setRejectOpen(true)}>✕ 拒绝</button>
      {msg && <span className="rsn err">{msg}</span>}
      {/* 修改对比：行级 diff 逐块 md 预览（删块红底 / 增块绿底 / 同块原样——表格加粗都是真渲染） */}
      {diffSegs && (
        <div className="pend-diff">
          {diffSegs.map((b, i) => (
            <div key={i} className={`pd-block ${b.type}`}>
              <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(b.text) }} />
            </div>
          ))}
        </div>
      )}
      {patch.type === 'del' && patch.old && (
        <div className="pend-diff">
          <div className="pd-block del"><div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(patch.old) }} /></div>
        </div>
      )}
      {editOpen && (
        <div className="pend-edit">
          <textarea
            value={editText}
            rows={Math.min(12, Math.max(3, editText.split('\n').length + 1))}
            onChange={(e) => setEditText(e.target.value)}
          />
          <div className="pend-edit-ops">
            <button
              className="act primary sm"
              disabled={!editText.trim()}
              onClick={() => { setEditOpen(false); act(() => designApi.acceptPatch(projectId, selKind, patch.patchId, undefined, editText)); }}
            >✓ 以编辑后的文本接受</button>
            <button className="act sm" onClick={() => { setEditOpen(false); setEditText(patch.new ?? ''); }}>取消</button>
            <span className="rsn">并入草稿的是编辑后的文本，非 AI 原文（裁决留痕记「改后接受」）</span>
          </div>
        </div>
      )}
      {rejectOpen && (
        <div className="msk" onClick={() => setRejectOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>拒绝补丁</h3>
            <p className="sub">拒绝 = 丢弃本提案（不落稿）。可填写处置理由，随裁决落库留痕；「请 AI 修订」会把理由回喂给 AI 会话，由 AI 修订后重新提案。</p>
            <textarea value={reason} rows={3} placeholder="处置理由（可选）：为什么拒绝这条提案" onChange={(e) => setReason(e.target.value)} />
            <div className="foot">
              <button className="act" onClick={() => setRejectOpen(false)}>取消</button>
              <button className="act" title="拒绝并把理由发给 AI，请其修订后重新提案" onClick={() => doReject(true)}>✕ 拒绝并请 AI 修订</button>
              <button className="act danger" onClick={() => doReject(false)}>✕ 确认拒绝</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CommitModal({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, doc, refresh } = useDesignView();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const submit = () => {
    setMsg(null);
    void designApi.commit(projectId, selKind, note, doc.cur)
      .then(() => onClose())
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '提交失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⬆ 版本提交（v{doc.cur} → v{doc.cur + 1}）</h3>
        <textarea value={note} rows={3} placeholder="提交说明（可选）" onChange={(e) => setNote(e.target.value)} />
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" onClick={submit}>提交</button>
        </div>
      </div>
    </div>
  );
}

/** 定稿弹窗：未决评审项二次确认（仍要定稿记审计，LLD-6 §3.4）；S9 仅同册再定稿（曾定稿过）挂影响提示 */
function FinalizeModal({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, doc, refresh, openReviews, setImpactNotice, books } = useDesignView();
  const [allow, setAllow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const bookTitle = books.find((b) => b.kind === selKind)?.title ?? selKind.toUpperCase();
  // D13（原型 V11 口径）：仅「再定稿」（该册曾定稿、解锁后重新定稿）触发下游影响提示；首次定稿不触发
  const reFinalize = doc.finalVer != null && doc.finalVer > 0;
  const submit = () => {
    setMsg(null);
    void designApi.finalize(projectId, selKind, doc.cur, doc.cur, allow)
      .then(() => {
        onClose();
        if (reFinalize) {
          setImpactNotice(
            `${bookTitle} v${doc.cur} 已定稿为新的治理输入——下游（原型规划 / 开发任务输入）按新指纹实时复核，请在开发页「影响处置」确认承接。`,
          );
        }
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '定稿失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {openReviews > 0 ? (
          <>
            <h3>定稿门禁</h3>
            <p className="pop-tip">
              《{bookTitle}》尚有 {openReviews} 条未决评审项（见「自检评审」页签对应分组）。确认仍要定稿？
            </p>
            <label className="gate-box err" style={{ display: 'block' }}>
              <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
              {''}存在 {openReviews} 条未决评审项，我确认仍要定稿（记审计）
            </label>
            {!allow && <p className="pop-tip">勾选上方确认复选框后，「仍要定稿」按钮才可用。</p>}
          </>
        ) : (
          <>
            <h3>{bookTitle} 定稿确认</h3>
            <p className="pop-tip">将 v{doc.cur} 标记为定稿稿：内容字节冻结，登记定稿证据；下游生成/规划以此指纹为治理输入。</p>
          </>
        )}
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>{openReviews > 0 ? '先去处理' : '取消'}</button>
          {/* W2-046：disabled 须有原因提示（对照影响处置 modal 的 description 口径） */}
          <button
            className="act primary" disabled={openReviews > 0 && !allow}
            title={openReviews > 0 && !allow ? '须先勾选上方「我确认仍要定稿」复选框（未决评审项确认）' : undefined}
            onClick={submit}>
            {openReviews > 0 ? '仍要定稿（记审计）' : '确认定稿'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * L7 📚 参考资料 popover（原型 designRefPopover@3429 口径）：
 * 默认参考=上游定稿自动装配（概要消费 PRD 定稿 / 详细七册消费概要定稿，门禁依据）；
 * 追加资料=生成期勾选 content_final 资料，随下次生成提交，指纹快照进 dsg_versions.refs（REQ-114/115）。
 * 与需求页差异：需求域参考落库（req_doc_refs），设计域按权威模型为生成期输入快照，无持久挂接表。
 */
function DesignRefsPopover({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, books, refCandidates, refSel, loadRefCandidates, toggleRef } = useDesignView();
  const navigate = useNavigate();
  const [upstream, setUpstream] = useState<UpstreamDocItem[] | null>(null);
  useEffect(() => {
    if (!projectId) return;
    void loadRefCandidates();
    designApi.upstreamDocs(projectId)
      .then((r) => setUpstream(r.items))
      .catch(() => setUpstream([]));
  }, [projectId, loadRefCandidates]);
  if (!projectId) return null;
  const isOutline = selKind === 'hld';
  const prd = upstream?.find((d) => d.kind.toLowerCase() === 'prd');
  const crd = upstream?.find((d) => d.kind.toLowerCase() === 'crd');
  const hld = books.find((b) => b.kind === 'hld');
  const sel = new Set(refSel[selKind] ?? []);
  const statusText = (doc: { cur: number; finalVer: number; finalized: boolean } | undefined, gate: boolean) =>
    !doc || doc.cur === 0
      ? `（未生成${gate ? ' · 门禁提示' : ''}）`
      : doc.finalized
        ? gate ? `v${doc.finalVer} · 已定稿（门禁依据）` : `v${doc.finalVer} · 已装配`
        : `v${doc.cur} · 未定稿`;
  const upstreamRows: Array<{ icon: string; name: string; text: string }> = isOutline
    ? [
        { icon: '📕', name: 'PRD', text: statusText(prd, true) },
        { icon: '📗', name: 'CRD', text: statusText(crd, false) },
      ]
    : [
        { icon: '🏛️', name: '概要设计', text: statusText(hld, true) },
        { icon: '📕', name: 'PRD', text: statusText(prd, false) },
      ];
  return (
    <div className="popover refs-pop">
      <div className="pop-head">
        <strong>参考资料 · {isOutline ? '概要设计' : '详细设计'}</strong>
        <button className="act" onClick={onClose}>✕</button>
      </div>
      <div className="pop-sub">默认参考（自动装配）</div>
      {upstreamRows.map((r) => (
        <div key={r.name} className="ref-row" style={{ cursor: 'default' }}>
          <span className="ref-name">{r.icon} {r.name}</span>
          <span className="pop-tip">{r.text}</span>
        </div>
      ))}
      <div className="pop-sub">追加资料（内容已定稿，随下次生成生效）</div>
      {refCandidates.map((c) => (
        <label key={c.fileId} className="ref-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={sel.has(c.fileId)}
            onChange={(e) => toggleRef(selKind, c.fileId, e.target.checked)}
          />
          <span className="ref-name" title={c.name}>📄 {c.name}</span>
        </label>
      ))}
      {refCandidates.length === 0 && (
        <p className="pop-tip">暂无内容定稿资料，请先在资料阶段复核并定稿。</p>
      )}
      <p className="pop-tip">勾选后点击「🔄 重新生成」随本次生成提交；参考指纹随版本登记（REQ-114/115）。</p>
      <button
        className="act"
        style={{ width: '100%', marginTop: 4 }}
        onClick={() => {
          onClose();
          toast('上传件须先在资料库完成解析与内容定稿，之后自动出现在本清单（REQ-114 无旁路）');
          void navigate('/material');
        }}
      >
        ⬆ 上传补充 .md（经资料库解析定稿后引用）
      </button>
    </div>
  );
}

/** 生成弹窗：说明 + 参考（可选 content_final 资料）→ POST-SSE 流式 */
function GenerateModal({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, refresh, refSel, refCandidates } = useDesignView();
  const [instruction, setInstruction] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const refIds = refSel[selKind] ?? [];
  const submit = () => {
    setMsg(null);
    // L7：勾选的生成期参考随本次生成提交；指纹取自候选清单（服务端校验 content_final 现行指纹，REQ-114）
    const referenceFingerprints = Object.fromEntries(
      refCandidates.filter((c) => refIds.includes(c.fileId)).map((c) => [c.fileId, c.contentFingerprint]),
    );
    useDesignView.setState({ gen: { operationId: null, running: true, paused: false, streamText: '', error: null, source: null } });
    onClose();
    void generateDesignDoc(projectId, selKind, { referenceFileIds: refIds, referenceFingerprints, ...(instruction ? { instruction } : {}) }, (f) => {
      const g = useDesignView.getState().gen;
      if (f.type === 'stream.start') useDesignView.setState({ gen: { ...g, operationId: f.operationId ?? null, source: f.source === 'model' ? 'model' : f.source === 'mock' ? 'mock' : null } });
      else if (f.type === 'stream.delta') useDesignView.setState({ gen: { ...g, streamText: g.streamText + (f.text ?? '') } });
      else if (f.type === 'stream.done') useDesignView.setState({ gen: { ...g, running: false } });
      else if (f.type === 'stream.notice') {
        // 断流自动重试提示（不静默纪律）；流继续，不动 running 态
        toast(String(f.message ?? '上游连接中断，已自动重试'), 'warn');
      } else {
        useDesignView.setState({ gen: { ...g, running: false, error: f.code ?? '生成失败' } });
        // W2-001：失败人话 toast（与需求域同口径）；W2-002：附脱敏原因
        toast(`生成失败（${f.code ?? '未知错误'}）${f.message ? `：${f.message}` : ''}。草稿与版本未受影响，可重新发起；若持续失败请到设置页检查模型连接`, 'warn');
      }
    })
      .catch((e) => {
        // W2-023：同步 HTTP 拒绝（如 423 门禁）同样显性提示（与需求域同口径）
        const msg = e instanceof ApiError ? `${e.code}: ${e.message}` : '生成失败';
        useDesignView.setState((s) => ({ gen: { ...s.gen, running: false, error: msg } }));
        toast(`生成未开始：${e instanceof ApiError ? e.message : msg}`, 'warn');
      })
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🔄 AI 生成 {selKind.toUpperCase()}</h3>
        <p className="pop-tip">生成门禁：HLD 消费 PRD 定稿、LLD 消费 HLD 定稿；结果为待确认补丁不落稿。{refIds.length > 0 ? `已勾选追加参考 ${refIds.length} 份（📚 参考资料管理）。` : ''}</p>
        <textarea value={instruction} rows={3} placeholder="补充说明（可选）" onChange={(e) => setInstruction(e.target.value)} />
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" onClick={submit}>开始生成</button>
        </div>
      </div>
    </div>
  );
}
