import { useEffect, useState } from 'react';
import { marked } from 'marked';
import { ApiError } from '../../api';
import { reqApi, type DocKind, type HealthView, type PatchItem } from './api';
import { useReqView, type ViewMode } from './store';

/** CRD/PRD 文档工作面（LLD-6 §3.3：工具栏 + 横幅 + 目录栏 216px + 纸面 820px） */
export function DocPanel({ kind }: { kind: DocKind }) {
  const { doc, loading, error, gen } = useReqView();
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  if (!doc) return <div className="doc-empty">{loading ? '加载中…' : (error ?? '文档初始化中…')}</div>;

  const readonly = doc.finalized || doc.viewing !== null;
  const pendings = useReqView.getState().patches.filter((p) => p.status === 'pending');
  const statusTag = doc.viewing !== null
    ? `历史版本 v${doc.viewing}（只读）`
    : doc.finalized
      ? `已定稿 v${doc.finalVer}`
      : doc.modified
        ? `v${doc.cur} 修订中`
        : `v${doc.cur}`;

  return (
    <div className="req-doc">
      <Toolbar
        kind={kind}
        readonly={readonly}
        statusTag={statusTag}
        onFinalize={() => setFinalizeOpen(true)}
        onCommit={() => setCommitOpen(true)}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
      />
      {error && <div className="req-banner err">{error}</div>}
      {doc.finalized && <div className="req-banner ok">✓ 已定稿 v{doc.finalVer}：内容字节冻结，修改需先在 ⋯ 菜单解除定稿（留审计）。</div>}
      {doc.viewing !== null && <HistoryBanner kind={kind} v={doc.viewing} />}
      {pendings.length > 0 && (
        <div className="req-banner warn">⚠ {pendings.length} 条待确认补丁：AI 提案不直接落稿，请逐条接受或拒绝（REQ-205）。</div>
      )}
      {!doc.finalized && doc.modified && doc.viewing === null && (
        <div className="req-banner info">ℹ 已修改未提交：提交后生成新版本 v{doc.cur + 1}（编号不复用）。</div>
      )}
      {gen.error && <div className="req-banner err">生成失败（{gen.error}），草稿与版本未受影响。</div>}
      {(gen.running || gen.streamText) && <GenCard />}
      <div className="req-body">
        <TocCol />
        <Paper kind={kind} readonly={readonly} />
      </div>
      {finalizeOpen && <FinalizeModal kind={kind} onClose={() => setFinalizeOpen(false)} />}
      {commitOpen && <CommitModal kind={kind} onClose={() => setCommitOpen(false)} />}
    </div>
  );
}

function Toolbar({
  kind, readonly, statusTag, onFinalize, onCommit, moreOpen, setMoreOpen,
}: {
  kind: DocKind; readonly: boolean; statusTag: string;
  onFinalize: () => void; onCommit: () => void;
  moreOpen: boolean; setMoreOpen: (b: boolean) => void;
}) {
  const { projectId, doc, versions, viewMode, setViewMode, loadDoc, refresh, gen } = useReqView();
  const [refsOpen, setRefsOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const generating = gen.running || doc.genState === 'generating';

  const act = (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    void fn()
      .then(() => { if (ok) setMsg(ok); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };

  const doExport = (format: 'md' | 'html') =>
    act(async () => {
      const r = await reqApi.exportDoc(projectId, kind, doc.viewing ?? doc.cur, format);
      window.open(r.downloadUrl, '_blank');
    });

  return (
    <div className="doc-toolbar req-toolbar">
      <span className={`tag ${doc.finalized ? 'tag-ok' : 'tag-warn'}`}>{statusTag}</span>
      <select
        className="ver-select"
        value={doc.viewing ?? doc.cur}
        onChange={(e) => void loadDoc(Number(e.target.value))}
        title="版本下拉：历史版本只读查看"
      >
        {versions.map((v) => (
          <option key={v.v} value={v.v}>
            v{v.v}{v.finalized ? '（定稿）' : ''}{v.note ? ` · ${v.note}` : ''}
          </option>
        ))}
      </select>
      <div className="pop-wrap">
        <button className="act" onClick={() => setRefsOpen(!refsOpen)}>📚 参考资料（{doc.refs.length}）</button>
        {refsOpen && <RefsPopover kind={kind} onClose={() => setRefsOpen(false)} />}
      </div>
      <span className="sep" />
      <button className="act" disabled={readonly} title="撤销" onClick={() => act(() => reqApi.undo(projectId, kind))}>↩</button>
      <button className="act" disabled={readonly} title="重做" onClick={() => act(() => reqApi.redo(projectId, kind))}>↪</button>
      <button className="act" title="下载当前查看版本" onClick={() => doExport('md')}>⬇ md</button>
      <button className="act" onClick={() => doExport('html')}>⬇ html</button>
      <button className="act primary" disabled={readonly || !doc.modified || generating} onClick={onCommit}>⬆ 版本提交</button>
      <button
        className="act"
        disabled={readonly || generating}
        title={kind === 'prd' ? 'PRD 生成门禁：CRD 已定稿' : 'AI 生成（参考=已挂接定稿资料）'}
        onClick={() => void useReqView.getState().startGenerate()}
      >
        {generating ? '⚡ 生成中…' : '🔄 重新生成'}
      </button>
      {doc.finalized ? (
        <button className="act" disabled>✓ 已定稿</button>
      ) : (
        <button
          className="act primary"
          disabled={readonly || doc.modified || generating || useReqView.getState().patches.some((p) => p.status === 'pending')}
          title="定稿为只读基线（人工确认点）"
          onClick={onFinalize}
        >
          ✓ 定稿
        </button>
      )}
      <div className="pop-wrap">
        <button className="act" onClick={() => setMoreOpen(!moreOpen)}>⋯</button>
        {moreOpen && (
          <div className="popover menu">
            {doc.finalized && (
              <button className="act" onClick={() => { setMoreOpen(false); if (window.confirm('解除定稿将留审计记录，下游基线失效传播随 M3 接入。继续？')) act(() => reqApi.unlock(projectId, kind), '已解除定稿'); }}>
                🔓 解除定稿
              </button>
            )}
            {doc.viewing !== null && (
              <button className="act" onClick={() => { setMoreOpen(false); act(() => reqApi.switchVersion(projectId, kind, doc.viewing!), `已切换当前版本为 v${doc.viewing}`); }}>
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
    </div>
  );
}

/** 参考资料 popover：仅内容已定稿（content_final）资料可挂接（REQ-114，无旁路） */
function RefsPopover({ kind, onClose }: { kind: DocKind; onClose: () => void }) {
  const { projectId, doc, candidates, refresh } = useReqView();
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const attached = new Set(doc.refs.map((r) => r.fileId));
  const act = (fn: () => Promise<unknown>) => {
    setMsg(null);
    void fn()
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="popover refs-pop">
      <div className="pop-head">
        <strong>参考资料</strong>
        <button className="act" onClick={onClose}>✕</button>
      </div>
      <p className="pop-tip">仅内容已定稿的资料可作生成参考；参考指纹随版本登记（REQ-114）。</p>
      {doc.refs.length > 0 && (
        <>
          <div className="pop-sub">已挂接</div>
          {doc.refs.map((r) => (
            <div key={r.fileId} className="ref-row">
              <span className="ref-name">{r.name}</span>
              <code className="ref-fp">{r.fingerprint.slice(0, 15)}…</code>
              <button className="act" onClick={() => act(() => reqApi.removeReference(projectId, kind, r.fileId))}>移除</button>
            </div>
          ))}
        </>
      )}
      <div className="pop-sub">可挂接（资料库 content_final）</div>
      {candidates.filter((c) => !attached.has(c.fileId)).map((c) => (
        <div key={c.fileId} className="ref-row">
          <span className="ref-name">{c.name}</span>
          <button className="act primary" onClick={() => act(() => reqApi.addReference(projectId, kind, c.fileId))}>挂接</button>
        </div>
      ))}
      {candidates.filter((c) => !attached.has(c.fileId)).length === 0 && (
        <p className="pop-tip">暂无可挂接资料——上传件须先在资料页完成解析与内容定稿。</p>
      )}
      {msg && <p className="pop-tip err">{msg}</p>}
    </div>
  );
}

/** 历史版本横幅：只读 + 回切当前 */
function HistoryBanner({ kind, v }: { kind: DocKind; v: number }) {
  const { projectId, doc, loadDoc, refresh } = useReqView();
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  return (
    <div className="req-banner info">
      ℹ 正在查看历史版本 v{v}（只读）。
      <button className="act" onClick={() => void loadDoc()}>返回当前 v{doc.cur}</button>
      <button
        className="act"
        disabled={doc.modified}
        title={doc.modified ? '有未提交修改，须先提交' : '将当前指针切到该版本'}
        onClick={() => {
          setMsg(null);
          void reqApi.switchVersion(projectId, kind, v)
            .then(() => refresh())
            .catch((e) => setMsg(e instanceof ApiError ? e.message : '切换失败'));
        }}
      >
        ⤺ 设为当前版本
      </button>
      {msg && <span className="rsn">{msg}</span>}
    </div>
  );
}

/** 生成流式卡：目录先行 → 章节增量（A04-4/5，mock 驱动） */
function GenCard() {
  const { gen, controlGenerate } = useReqView();
  return (
    <div className="gen-card" role="status">
      <div className="gen-head">
        <strong>{gen.running ? (gen.paused ? '⏸ 已暂停' : '⚡ AI 生成中…') : '✓ 生成完成'}</strong>
        {gen.running && (
          <span className="gen-ops">
            {gen.paused ? (
              <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('resume')}>▶ 继续</button>
            ) : (
              <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('pause')}>⏸ 暂停</button>
            )}
            <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('stop')}>⏹ 停止</button>
          </span>
        )}
      </div>
      <pre className="gen-stream">{gen.streamText || '等待模型输出…'}</pre>
      {!gen.running && !gen.error && (
        <p className="pop-tip">生成结果为待确认补丁（不落稿），请在下方逐条接受/拒绝后提交版本。</p>
      )}
    </div>
  );
}

/** 目录栏（216px 固定）：点击跳转 + 闪高亮 */
function TocCol() {
  const { doc, tocFlash, flashToc } = useReqView();
  if (!doc) return null;
  const jump = (secId: string) => {
    document.getElementById(`sec-${secId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashToc(secId);
  };
  return (
    <aside className="toc-col">
      <div className="toc-title">目录</div>
      {doc.secs.filter((s) => s.title).map((s) => (
        <button
          key={s.id}
          className={`toc-item${tocFlash === s.id ? ' flash' : ''}${s.pending ? ' has-pend' : ''}`}
          onClick={() => jump(s.id)}
        >
          {s.title}
        </button>
      ))}
    </aside>
  );
}

/** 纸面：h1 + 状态 + 章节（待确认补丁高亮 + 行内接受/拒绝） */
function Paper({ kind, readonly }: { kind: DocKind; readonly: boolean }) {
  const { doc, viewMode, patches, tocFlash } = useReqView();
  if (!doc) return null;
  const pendBySec = new Map(patches.filter((p) => p.status === 'pending').map((p) => [p.secId, p]));
  const appended = patches.filter((p) => p.status === 'pending' && p.type === 'add');

  if (viewMode === 'source') {
    const full = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
    return (
      <div className="doc-scroll"><div className="paper"><pre className="md-src">{full}</pre></div></div>
    );
  }

  return (
    <div className="doc-scroll">
      <div className="paper">
        <h1>{doc.kind} <span className="tag">{doc.viewing !== null ? `v${doc.viewing}` : `v${doc.cur}`}</span></h1>
        {doc.secs.map((s) => (
          <section key={s.id} id={`sec-${s.id}`} className={`sect${tocFlash === s.id ? ' flash' : ''}`}>
            {s.title && <h2>{s.title}</h2>}
            {viewMode === 'preview' ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(s.md, { async: false }) }} />
            ) : (
              <SectionEditor kind={kind} secId={s.id} md={s.md} readonly={readonly} />
            )}
            {s.pending && pendBySec.get(s.id) && <PendingBar kind={kind} patch={pendBySec.get(s.id)!} />}
          </section>
        ))}
        {appended.map((p) => (
          <section key={p.patchId} className="sect pending-add">
            {p.title && <h2>{p.title} <span className="tag tag-warn">新增章节提案</span></h2>}
            <div className="md" dangerouslySetInnerHTML={{ __html: marked.parse(p.new ?? '', { async: false }) }} />
            <PendingBar kind={kind} patch={p} />
          </section>
        ))}
        {doc.secs.length <= 1 && !doc.secs[0]?.md && (
          <div className="doc-empty">
            {kind === 'prd' ? 'PRD 空态：CRD 定稿后可 AI 生成初稿，或直接编辑。' : 'CRD 空态：挂接定稿资料后 AI 生成初稿，或直接编辑。'}
          </div>
        )}
      </div>
    </div>
  );
}

/** 编辑态：逐节 textarea + 保存（save-draft 乐观锁：baseVersion+baseFingerprint） */
function SectionEditor({ kind, secId, md, readonly }: { kind: DocKind; secId: string; md: string; readonly: boolean }) {
  const { projectId, doc, refresh } = useReqView();
  const [text, setText] = useState(md);
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = text !== md;
  if (!projectId || !doc) return null;
  const save = () => {
    setMsg(null);
    void reqApi.saveDraft(projectId, kind, secId, text, doc.cur, doc.contentFingerprint)
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '保存失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="sec-editor">
      <textarea
        value={text}
        rows={Math.min(20, Math.max(4, text.split('\n').length + 1))}
        disabled={readonly}
        onChange={(e) => setText(e.target.value)}
      />
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

/** 待确认补丁行内条（REQ-205；modify/del 高亮旧→新） */
function PendingBar({ kind, patch }: { kind: DocKind; patch: PatchItem }) {
  const { projectId, refresh } = useReqView();
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
      <button className="act primary" onClick={() => act(() => reqApi.acceptPatch(projectId, kind, patch.patchId))}>✓ 接受</button>
      <button className="act" onClick={() => act(() => reqApi.rejectPatch(projectId, kind, patch.patchId))}>✕ 拒绝</button>
      {msg && <span className="rsn err">{msg}</span>}
    </div>
  );
}

/** 版本提交弹窗（提交说明 + baseVersion） */
function CommitModal({ kind, onClose }: { kind: DocKind; onClose: () => void }) {
  const { projectId, doc, refresh } = useReqView();
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId || !doc) return null;
  const submit = () => {
    setMsg(null);
    void reqApi.commit(projectId, kind, note, doc.cur)
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '提交失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⬆ 版本提交（{doc.kind} v{doc.cur} → v{doc.cur + 1}）</h3>
        <p className="pop-tip">提交生成不可变新版本（字节冻结、编号不复用），并同事务重建 RTM 派生链。</p>
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

/** 定稿弹窗：PRD 展示 RTM 健康度门禁实时结果（F06-7 不用缓存值放行） */
function FinalizeModal({ kind, onClose }: { kind: DocKind; onClose: () => void }) {
  const { projectId, doc, refresh } = useReqView();
  const [health, setHealth] = useState<HealthView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const pid = projectId;
  useEffect(() => {
    if (pid && kind === 'prd') void reqApi.health(pid).then(setHealth).catch(() => setHealth(null));
  }, [pid, kind]);
  if (!pid || !doc) return null;
  const gateOk = kind === 'crd' || health?.ok === true;
  const submit = () => {
    setMsg(null);
    void reqApi.finalize(pid, kind, doc.cur, doc.cur)
      .then(() => { onClose(); })
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '定稿失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>✓ 定稿 {doc.kind} v{doc.cur}</h3>
        <p className="pop-tip">定稿为只读基线（人工确认点 req.doc.finalize），登记定稿证据与内容指纹。</p>
        {kind === 'prd' && (
          <div className={`gate-box ${gateOk ? 'ok' : 'err'}`}>
            <strong>RTM 健康度门禁（实时重算）</strong>
            {health ? (
              <ul>
                <li>L0a R→CR 承接率 {(health.l0a * 100).toFixed(1)}%（门槛 ≥95%）{health.l0a >= 0.95 ? ' ✓' : ' ✗'}</li>
                <li>L0b CR→REQ 承接率 {(health.l0b * 100).toFixed(1)}%（门槛 =100%）{health.l0b === 1 ? ' ✓' : ' ✗'}</li>
                <li className="mut">L0c REQ→DSG {(health.l0c * 100).toFixed(1)}%（开发门禁，本期信息展示）；L0d deferred {health.l0d} 项</li>
                {health.gaps.map((g) => <li key={`${g.code}-${g.target}`} className="err">✗ {g.target}：{g.message}</li>)}
              </ul>
            ) : <p>健康度加载中…</p>}
          </div>
        )}
        {msg && <p className="pop-tip err">{msg}</p>}
        <div className="modal-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" disabled={!gateOk} title={gateOk ? '' : 'RTM 门禁未通过（GATE_BLOCKED）'} onClick={submit}>
            确认定稿
          </button>
        </div>
      </div>
    </div>
  );
}
