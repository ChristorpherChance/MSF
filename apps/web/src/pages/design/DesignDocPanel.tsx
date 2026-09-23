import { useState } from 'react';
import { mdHtml } from '../../md-html';
import { ApiError } from '../../api';
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
  return (
    <div className="design-doc-layout">
      {kinds.length > 1 && (
        <aside className="book-col">
          {kinds.map((k) => {
            const b = books.find((x) => x.kind === k);
            const ungenerated = b !== undefined && b.cur === 0;
            return (
              <button key={k} className={`book-row${selKind === k ? ' on' : ''}`} onClick={() => void selectBook(k)}>
                <span className="book-ico">{BOOK_ICONS[k]}</span>
                <span className="book-name">{b?.title ?? k}</span>
                <span className={`tag ${ungenerated ? '' : b?.finalized ? 'tag-ok' : b?.modified ? 'tag-warn' : ''}`}>
                  {b ? (ungenerated ? '未生成' : b.finalized ? `已定稿 v${b.finalVer}` : b.modified ? `v${b.cur} 修订中` : `v${b.cur}`) : '…'}
                </span>
              </button>
            );
          })}
        </aside>
      )}
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
  const { projectId, doc, versions, viewMode, setViewMode, loadDoc, refresh, selKind, gen } = useDesignView();
  const [moreOpen, setMoreOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [finOpen, setFinOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const readonly = doc.finalized || doc.viewing !== null;
  const generating = gen.running || doc.genState === 'generating';
  const pendCount = useDesignView.getState().patches.filter((p) => p.status === 'pending').length;

  const act = (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    void fn()
      .then(() => { if (ok) setMsg(ok); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };

  return (
    <div className="doc-toolbar req-toolbar">
      <span className={`tag ${doc.finalized ? 'tag-ok' : 'tag-warn'}`}>
        {doc.viewing !== null ? `历史版本 v${doc.viewing}（只读）` : doc.finalized ? `已定稿 v${doc.finalVer}` : doc.modified ? `v${doc.cur} 修订中` : `v${doc.cur}`}
      </span>
      <select
        className="ver-select"
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
      <button className="act primary" disabled={readonly || !doc.modified || generating || pendCount > 0} onClick={() => setCommitOpen(true)}>⬆ 版本提交</button>
      <button className="act" disabled={readonly || generating} onClick={() => setGenOpen(true)}>
        {generating ? '⚡ 生成中…' : '🔄 重新生成'}
      </button>
      {doc.finalized ? (
        <button className="act" disabled>✓ 已定稿</button>
      ) : (
        <button className="act primary" disabled={readonly || doc.modified || generating || pendCount > 0} onClick={() => setFinOpen(true)}>✓ 定稿</button>
      )}
      <div className="pop-wrap">
        <button className="act" onClick={() => setMoreOpen(!moreOpen)}>⋯</button>
        {moreOpen && (
          <div className="popover menu">
            {doc.finalized && (
              <button className="act" onClick={() => { setMoreOpen(false); if (window.confirm('解除定稿将留审计记录，下游基线实时失效。继续？')) act(() => designApi.unlock(projectId, selKind), '已解除定稿'); }}>
                🔓 解除定稿
              </button>
            )}
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
      {msg && <span className="rsn">{msg}</span>}
      {commitOpen && <CommitModal onClose={() => setCommitOpen(false)} />}
      {finOpen && <FinalizeModal onClose={() => setFinOpen(false)} />}
      {genOpen && <GenerateModal onClose={() => setGenOpen(false)} />}
    </div>
  );
}

function Banners() {
  const { doc, patches, gen, impactNotice, setImpactNotice } = useDesignView();
  if (!doc) return null;
  const pendings = patches.filter((p) => p.status === 'pending');
  return (
    <>
      {impactNotice && (
        <div className="req-banner warn impact-banner">
          ⚡ {impactNotice}
          <button className="act" style={{ marginLeft: 8 }} onClick={() => setImpactNotice(null)}>知道了</button>
        </div>
      )}
      {doc.finalized && <div className="req-banner ok">✓ 已定稿 v{doc.finalVer}：内容冻结；下游（LLD/原型规划）以此指纹为治理输入。</div>}
      {doc.viewing !== null && <div className="req-banner info">ℹ 正在查看历史版本 v{doc.viewing}（只读）。</div>}
      {pendings.length > 0 && <div className="req-banner warn">⚠ {pendings.length} 条待确认补丁：请逐条接受或拒绝。</div>}
      {!doc.finalized && doc.modified && doc.viewing === null && <div className="req-banner info">ℹ 已修改未提交。</div>}
      {gen.error && <div className="req-banner err">生成失败（{gen.error}）。</div>}
      {(gen.running || gen.streamText) && <GenStreamCard />}
    </>
  );
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
  return (
    <aside className="toc-col">
      <div className="toc-title">目录</div>
      {doc.secs.filter((s) => s.title).map((s) => (
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
  const { doc, viewMode, patches, tocFlash } = useDesignView();
  if (!doc) return null;
  const pendBySec = new Map(patches.filter((p) => p.status === 'pending').map((p) => [p.secId, p]));
  const appended = patches.filter((p) => p.status === 'pending' && p.type === 'add');
  if (viewMode === 'source') {
    const full = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
    return <div className="doc-scroll"><div className="paper"><pre className="md-src">{full}</pre></div></div>;
  }
  const readonly = doc.finalized || doc.viewing !== null;
  return (
    <div className="doc-scroll">
      <div className="paper">
        <h1>{doc.kind.toUpperCase()} <span className="tag">{doc.viewing !== null ? `v${doc.viewing}` : `v${doc.cur}`}</span></h1>
        {doc.secs.map((s) => (
          <section key={s.id} id={`dsec-${s.id}`} className={`sect${tocFlash === s.id ? ' flash' : ''}`}>
            {s.title && <h2>{s.title}</h2>}
            {viewMode === 'preview' ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(s.md) }} />
            ) : (
              <SectionEditor secId={s.id} md={s.md} readonly={readonly} />
            )}
            {s.pending && pendBySec.get(s.id) && <PendingBar patch={pendBySec.get(s.id)!} />}
          </section>
        ))}
        {appended.map((p) => (
          <section key={p.patchId} className="sect pending-add">
            {p.title && <h2>{p.title} <span className="tag tag-warn">新增章节提案</span></h2>}
            <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(p.new ?? '') }} />
            <PendingBar patch={p} />
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
      <span className="pend-desc">
        {patch.type === 'add' ? `＋新增「${patch.title ?? '章节'}」` : patch.type === 'del' ? `－删除「${patch.old ?? ''}」` : `✎ ${patch.old ?? ''} → ${patch.new ?? ''}`}
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

/** 定稿弹窗：未决评审项二次确认（仍要定稿记审计，LLD-6 §3.4）；S9 再定稿成功后挂影响提示 */
function FinalizeModal({ onClose }: { onClose: () => void }) {
  const { projectId, selKind, doc, refresh, openReviews, setImpactNotice } = useDesignView();
  const [allow, setAllow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const submit = () => {
    setMsg(null);
    void designApi.finalize(projectId, selKind, doc.cur, doc.cur, allow)
      .then(() => {
        onClose();
        // S9 impactTrigger：同册再定稿/新定稿均形成新的输入身份，下游实时失效
        setImpactNotice(
          `${selKind.toUpperCase()} v${doc.cur} 已定稿为新的治理输入——下游（原型规划 / 开发任务输入）按新指纹实时复核，请在开发页「影响处置」确认承接。`,
        );
      })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '定稿失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>✓ 定稿 {selKind.toUpperCase()} v{doc.cur}</h3>
        <p className="pop-tip">定稿为只读基线，登记定稿证据；下游生成/规划以此指纹为治理输入。</p>
        {openReviews > 0 && (
          <label className="gate-box err" style={{ display: 'block' }}>
            <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.target.checked)} />
            {' '}存在 {openReviews} 条未决评审项，我确认仍要定稿（记审计）
          </label>
        )}
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={openReviews > 0 && !allow} onClick={submit}>确认定稿</button>
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
    useDesignView.setState({ gen: { operationId: null, running: true, paused: false, streamText: '', error: null } });
    onClose();
    void generateDesignDoc(projectId, selKind, { referenceFileIds: [], referenceFingerprints: {}, ...(instruction ? { instruction } : {}) }, (f) => {
      const g = useDesignView.getState().gen;
      if (f.type === 'stream.start') useDesignView.setState({ gen: { ...g, operationId: f.operationId ?? null } });
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
