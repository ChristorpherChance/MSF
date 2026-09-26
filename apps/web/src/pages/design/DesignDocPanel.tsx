import { useState } from 'react';
import { mdHtml } from '../../md-html';
import { ApiError } from '../../api';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { designApi, generateDesignDoc, type DesignKind, type PatchItem } from './api';
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
                  <span className="book-note">v{b.cur}{b.modified && !b.finalized ? ' · 已修改未提交' : ''}</span>
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
  const [tlOpen, setTlOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
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
      <span className="sep" />
      <button className="act" disabled={readonly} title="撤销" onClick={() => act(() => designApi.undo(projectId, selKind))}>↩</button>
      <button className="act" disabled={readonly} title="重做" onClick={() => act(() => designApi.redo(projectId, selKind))}>↪</button>
      <div className="pop-wrap">
        <button className="act" title="下载当前查看版本（Markdown 本端落盘）" onClick={() => setDlOpen(!dlOpen)}>⬇ 下载 ▾</button>
        {dlOpen && (
          <div className="popover menu">
            <div className="pop-tip" style={{ padding: '4px 10px' }}>下载当前文档 v{doc.viewing ?? doc.cur}</div>
            <button className="act" onClick={() => {
              setDlOpen(false);
              const md = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
              const a = document.createElement('a');
              a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
              a.download = `${bookTitle}-v${doc.viewing ?? doc.cur}.md`;
              a.click();
              URL.revokeObjectURL(a.href);
            }}>⬇ Markdown (.md)</button>
          </div>
        )}
      </div>
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
      <pre className="gen-stream">{gen.streamText || '等待模型输出…'}</pre>
      {!gen.running && !gen.error && <p className="pop-tip">生成结果为待确认补丁（不落稿），请逐条处置后提交版本。</p>}
    </div>
  );
}

function TocCol() {
  const { doc, tocFlash, flashToc } = useDesignView();
  if (!doc) return null;
  const tocSecs = doc.secs.filter((s) => s.title);
  return (
    <aside className="toc-col">
      <div className="toc-title">目录 <span className="dz-note">{tocSecs.length} 章</span></div>
      {tocSecs.map((s) => (
        <button
          key={s.id}
          className={`toc-item${tocFlash === s.id ? ' flash' : ''}${s.pending ? ' has-pend' : ''}`}
          onClick={() => {
            document.getElementById(`dsec-${s.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            flashToc(s.id);
          }}
        >
          {s.title}
        </button>
      ))}
    </aside>
  );
}

function Paper() {
  const { doc, viewMode, patches, tocFlash, books, selKind } = useDesignView();
  if (!doc) return null;
  const pendBySec = new Map(patches.filter((p) => p.status === 'pending').map((p) => [p.secId, p]));
  const appended = patches.filter((p) => p.status === 'pending' && p.type === 'add');
  const pendCount = pendBySec.size + appended.length;
  const bookTitle = books.find((b) => b.kind === selKind)?.title ?? selKind.toUpperCase();
  if (viewMode === 'source') {
    const full = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
    return <div className="doc-scroll"><div className="paper"><pre className="md-src">{full}</pre></div></div>;
  }
  const readonly = doc.finalized || doc.viewing !== null;
  return (
    <div className="doc-scroll">
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
          {pendCount > 0 && (
            <span className="tag tag-warn" title="待确认补丁：在下方各章节行内逐条接受或拒绝（REQ-305）">补丁 ×{pendCount}</span>
          )}
        </h1>
        {doc.secs.map((s) => (
          <section key={s.id} id={`dsec-${s.id}`} className={`sect${tocFlash === s.id ? ' flash' : ''}`}>
            {/* 补丁条在章节标题之前（原型口径：pending-bar → h2 → 正文） */}
            {s.pending && pendBySec.get(s.id) && <PendingBar patch={pendBySec.get(s.id)!} />}
            {s.title && <h2>{s.title}</h2>}
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

function PendingBar({ patch }: { patch: PatchItem }) {
  const { projectId, selKind, refresh } = useDesignView();
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const act = (fn: () => Promise<unknown>) => {
    setMsg(null);
    void fn()
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };
  return (
    <div className={`pending-bar pending-${patch.type === 'modify' ? 'mod' : patch.type === 'del' ? 'del' : 'add'}`}>
      <span className={`plabel ${patch.type === 'modify' ? 'mod' : patch.type}`}>
        ● 待确认·{patch.type === 'add' ? '新增' : patch.type === 'del' ? '删除' : '修改'}
      </span>
      <span className="pend-desc">
        {patch.type === 'add' ? `「${patch.title ?? '章节'}」` : patch.type === 'del' ? `「${patch.old ?? ''}」` : `${patch.old ?? ''} → ${patch.new ?? ''}`}
        <em>（{patch.source === 'ai' ? 'AI 提案' : patch.source}）</em>
      </span>
      <button className="act primary" onClick={() => act(() => designApi.acceptPatch(projectId, selKind, patch.patchId))}>✓ 接受</button>
      <button className="act" onClick={() => act(() => designApi.rejectPatch(projectId, selKind, patch.patchId))}>✕ 拒绝</button>
      {msg && <span className="rsn err">{msg}</span>}
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
          <button className="act primary" disabled={openReviews > 0 && !allow} onClick={submit}>
            {openReviews > 0 ? '仍要定稿（记审计）' : '确认定稿'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 生成弹窗：说明 + 参考（可选 content_final 资料）→ POST-SSE 流式 */
function GenerateModal({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, refresh } = useDesignView();
  const [instruction, setInstruction] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const submit = () => {
    setMsg(null);
    useDesignView.setState({ gen: { operationId: null, running: true, paused: false, streamText: '', error: null, source: null } });
    onClose();
    void generateDesignDoc(projectId, selKind, { referenceFileIds: [], referenceFingerprints: {}, ...(instruction ? { instruction } : {}) }, (f) => {
      const g = useDesignView.getState().gen;
      if (f.type === 'stream.start') useDesignView.setState({ gen: { ...g, operationId: f.operationId ?? null, source: f.source === 'model' ? 'model' : f.source === 'mock' ? 'mock' : null } });
      else if (f.type === 'stream.delta') useDesignView.setState({ gen: { ...g, streamText: g.streamText + (f.text ?? '') } });
      else if (f.type === 'stream.done') useDesignView.setState({ gen: { ...g, running: false } });
      else useDesignView.setState({ gen: { ...g, running: false, error: f.code ?? '生成失败' } });
    })
      .catch((e) => useDesignView.setState((s) => ({ gen: { ...s.gen, running: false, error: e instanceof ApiError ? `${e.code}: ${e.message}` : '生成失败' } })))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🔄 AI 生成 {selKind.toUpperCase()}</h3>
        <p className="pop-tip">生成门禁：HLD 消费 PRD 定稿、LLD 消费 HLD 定稿；结果为待确认补丁不落稿。</p>
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
