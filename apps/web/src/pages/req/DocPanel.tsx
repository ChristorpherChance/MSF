import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mdHtml } from '../../md-html';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
import { toast } from '../../ui/toast';
import { downloadFile } from '../../ui/download';
import { useStagesStore } from '../../ui/GateBanner';
import { reqApi, type DocKind, type HealthView, type PatchItem } from './api';
import { useReqView, type ViewMode } from './store';

/** CRD/PRD 文档工作面（LLD-6 §3.3：工具栏 + 横幅 + 目录栏 216px + 纸面 820px） */
export function DocPanel({ kind }: { kind: DocKind }) {
  const { doc, loading, error, gen } = useReqView();
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);

  if (!doc) return <div className="doc-empty">{loading ? '加载中…' : (error ?? '文档初始化中…')}</div>;

  const readonly = doc.finalized || doc.viewing !== null;

  // 瞬时异常 → 工具栏 ⛔ 图标点开看详情；文档状态一律在正文 H1 呈现（原型口径，工具栏只留操作）
  const errItems: StatusChipItem[] = [];
  if (error) errItems.push({ key: 'error', tone: 'err', label: '⛔', detail: error });
  if (gen.error) {
    errItems.push({
      key: 'generr', tone: 'err', label: '⛔',
      detail: `生成失败（${gen.error}），草稿与版本未受影响，可重新发起。`,
    });
  }

  return (
    <div className="req-doc">
      <Toolbar
        kind={kind}
        readonly={readonly}
        errors={errItems}
        onFinalize={() => setFinalizeOpen(true)}
        onCommit={() => setCommitOpen(true)}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        onTimeline={() => setTimelineOpen(true)}
      />
      {(gen.running || gen.streamText) && <GenCard />}
      <div className="req-body">
        <TocCol />
        <Paper kind={kind} readonly={readonly} />
      </div>
      {finalizeOpen && <FinalizeModal kind={kind} onClose={() => setFinalizeOpen(false)} />}
      {commitOpen && <CommitModal kind={kind} onClose={() => setCommitOpen(false)} />}
      {timelineOpen && <VersionTimelineModal onClose={() => setTimelineOpen(false)} />}
    </div>
  );
}

function Toolbar({
  kind, readonly, errors, onFinalize, onCommit, moreOpen, setMoreOpen, onTimeline,
}: {
  kind: DocKind; readonly: boolean; errors: StatusChipItem[];
  onFinalize: () => void; onCommit: () => void;
  moreOpen: boolean; setMoreOpen: (b: boolean) => void;
  onTimeline: () => void;
}) {
  const { projectId, doc, versions, viewMode, setViewMode, loadDoc, refresh, gen } = useReqView();
  const [refsOpen, setRefsOpen] = useState(false);
  const [dlOpen, setDlOpen] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
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

  const doExport = (format: 'md' | 'docx' | 'pdf') =>
    act(async () => {
      const r = await reqApi.exportDoc(projectId, kind, doc.viewing ?? doc.cur, format);
      // U-017：await 后 window.open 被弹窗拦截（丢失用户手势）→ 程序化 a.click 下载
      downloadFile(r.downloadUrl);
    }, `已导出 ${format.toUpperCase()}（下载开始）`);

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
        <button className="act" title="挂接/管理生成参考（仅内容已定稿资料）" onClick={() => setRefsOpen(!refsOpen)}>📚 参考资料（{doc.refs.length}）</button>
        {refsOpen && <RefsPopover kind={kind} onClose={() => setRefsOpen(false)} />}
      </div>
      <span className="sep" />
      {/* W2-025：栈空即置灰（不再点了才 409）；失败走 toast 自动消散，不再残留正文区 */}
      <button
        className="act" disabled={readonly || doc.canUndo === false}
        title={doc.canUndo === false ? '无可撤销（栈随草稿消亡）' : '撤销'}
        onClick={() => undoRedo(() => reqApi.undo(projectId, kind))}>↩</button>
      <button
        className="act" disabled={readonly || doc.canRedo === false}
        title={doc.canRedo === false ? '无可重做（栈随草稿消亡）' : '重做'}
        onClick={() => undoRedo(() => reqApi.redo(projectId, kind))}>↪</button>
      <div className="pop-wrap">
        <button className="act" title="下载当前查看版本" onClick={() => setDlOpen(!dlOpen)}>⬇ 下载 ▾</button>
        {dlOpen && (
          <div className="popover menu">
            <div className="pop-tip" style={{ padding: '4px 10px' }}>下载当前文档 v{doc.viewing ?? doc.cur}</div>
            <button className="act" onClick={() => { setDlOpen(false); doExport('md'); }}>⬇ Markdown (.md)</button>
            <button className="act" onClick={() => { setDlOpen(false); doExport('docx'); }}>⬇ Word (.docx)</button>
            <button className="act" onClick={() => { setDlOpen(false); doExport('pdf'); }}>⬇ PDF (.pdf)</button>
          </div>
        )}
      </div>
      <button
        className="act primary"
        disabled={readonly || !doc.modified || generating}
        title={doc.modified ? `提交为 v${Math.max(...versions.map((v) => v.v), doc.cur) + 1}` : '当前版本未修改，无可提交内容'}
        onClick={onCommit}
      >⬆ 版本提交</button>
      <button
        className="act"
        disabled={readonly || gen.running}
        title={
          kind === 'prd'
            ? 'AI 生成 / 增量修订（生成门禁：CRD 已定稿）'
            : doc.genState === 'generating' && !gen.running
              ? '上次生成可能已中断（后端重启），点击重新发起'
              : 'AI 生成 / 增量修订（参考=已挂接定稿资料；留空=整篇重生成，填指令=增量修订）'
        }
        onClick={() => setGenOpen(true)}
      >
        {generating ? '⚡ 生成中…' : '🔄 重新生成'}
      </button>
      {genOpen && (
        <Modal
          title="AI 生成 / 修订"
          onClose={() => setGenOpen(false)}
          footer={
            <>
              <button className="sm" onClick={() => setGenOpen(false)}>取消</button>
              <button
                className="sm primary"
                onClick={() => {
                  const text = instruction.trim();
                  setGenOpen(false);
                  void useReqView.getState().startGenerate(text || undefined);
                }}
              >
                ⚡ 开始生成
              </button>
            </>
          }
        >
          {doc.finalized && (
            <p className="pop-tip" style={{ color: 'var(--red)' }}>
              当前文档已定稿：需先在「⋯」菜单解锁后方可生成，否则将被版本锁拦截。
            </p>
          )}
          <p className="pop-tip">
            留空 = 依据参考整篇重生成；填写指令 = 增量修订（产出待确认补丁，不落稿）。
            助手 dock 对话的修改结论可直接粘贴到这里。
          </p>
          <textarea
            className="md-editor"
            style={{ minHeight: 120 }}
            placeholder={'例：不要重写全文，仅补写承接 CR-001 的需求条目；\n例：把「通知触达」一章补充邮件+企业微信两种通道的验收标准。'}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
          />
        </Modal>
      )}
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
            {/* R1：版本时间线 / 分享（原型 docMenu 项） */}
            <button className="act" onClick={() => { setMoreOpen(false); onTimeline(); }}>
              🕒 版本时间线
            </button>
            <button
              className="act"
              onClick={() => {
                setMoreOpen(false);
                const url = `${window.location.origin}/req?tab=${kind}&v=${doc.viewing ?? doc.cur}`;
                void navigator.clipboard
                  .writeText(url)
                  .then(() => toast('分享链接已复制到剪贴板', 'success'))
                  .catch(() => toast(url));
              }}
            >
              🔗 复制分享链接
            </button>
            {doc.finalized && (
              <button className="act" onClick={() => { setMoreOpen(false); setUnlockOpen(true); }}>
                🔓 解锁定稿
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
      <StatusChips items={errors} />
      {msg && <span className="rsn">{msg}</span>}
      {unlockOpen && (
        <Modal title="🔓 解锁定稿" onClose={() => setUnlockOpen(false)} footer={
          <>
            <button className="sm" onClick={() => setUnlockOpen(false)}>取消</button>
            <button className="sm primary" onClick={() => { setUnlockOpen(false); act(() => reqApi.unlock(projectId, kind), '已解锁定稿'); }}>确认解锁</button>
          </>
        }>
          <p>解除 {kind.toUpperCase()} v{doc.finalVer} 的定稿锁定，文档回到可编辑状态。</p>
          <p className="pop-tip">影响面：解锁记审计；下游（设计/开发）若已消费本定稿，其输入基线将标记失效需重确认。</p>
        </Modal>
      )}
    </div>
  );
}

/** 参考资料 popover：仅内容已定稿（content_final）资料可挂接（REQ-114，无旁路） */
function RefsPopover({ kind, onClose }: { kind: DocKind; onClose: () => void }) {
  const { projectId, doc, candidates, refresh } = useReqView();
  const navigate = useNavigate();
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
      {/* R2：上传补充 .md 入口（REQ-114 无旁路：经资料库解析定稿后引用） */}
      <button
        className="act"
        style={{ width: '100%', marginTop: 8 }}
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

/**
 * R3 生成卡（原型：目录先行 → 章节 Task 实时卡）。
 * 流文本按 `## ` 章节标题增量切分：已越过标题的章节=✅ 完成，当前写入章节=🔄 进行中。
 */
function GenCard() {
  const { gen, controlGenerate } = useReqView();
  const sections = useMemo(() => {
    const heads = [...gen.streamText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]!.trim());
    return heads;
  }, [gen.streamText]);
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
            {gen.paused ? (
              <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('resume')}>▶ 继续</button>
            ) : (
              <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('pause')}>⏸ 暂停</button>
            )}
            <button className="act" disabled={!gen.operationId} onClick={() => void controlGenerate('stop')}>⏹ 停止</button>
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
      {!gen.running && !gen.error && (
        <p className="pop-tip">生成结果为待确认补丁（不落稿），请在下方逐条接受/拒绝后提交版本。</p>
      )}
    </div>
  );
}

/** R4 目录栏（216px 固定）：点击跳转 + 闪高亮 + 滚动联动高亮当前章节（bindTocSync） */
function TocCol() {
  const { doc, tocFlash, flashToc } = useReqView();
  const [activeSec, setActiveSec] = useState<string | null>(null);

  // 滚动联动：IntersectionObserver 跟踪纸面章节，视口上部命中的章节为当前
  useEffect(() => {
    const secs = Array.from(document.querySelectorAll<HTMLElement>('section.sect[id^="sec-"]'));
    if (secs.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSec(e.target.id.replace(/^sec-/, ''));
        }
      },
      { rootMargin: '-10% 0px -75% 0px' },
    );
    for (const s of secs) io.observe(s);
    return () => io.disconnect();
  }, [doc?.secs, doc?.cur]);

  if (!doc) return null;
  const jump = (secId: string) => {
    document.getElementById(`sec-${secId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashToc(secId);
    setActiveSec(secId);
  };
  const tocSecs = doc.secs.filter((s) => s.title);
  return (
    <aside className="toc-col">
      <div className="toc-title">目录 <span className="dz-note">{tocSecs.length} 章</span></div>
      {tocSecs.map((s) => (
        <button
          key={s.id}
          className={`toc-item${tocFlash === s.id ? ' flash' : ''}${s.pending ? ' has-pend' : ''}${activeSec === s.id ? ' act-sec' : ''}`}
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
  const pendCount = pendBySec.size + appended.length;

  if (viewMode === 'source') {
    const full = doc.secs.map((s) => (s.title ? `## ${s.title}\n\n${s.md}` : s.md)).join('\n\n');
    return (
      <div className="doc-scroll"><div className="paper"><pre className="md-src">{full}</pre></div></div>
    );
  }

  return (
    <div className="doc-scroll">
      <div className="paper">
        {/* 文档状态在正文标题呈现（原型口径：tag 随版本号，不占工具栏） */}
        <h1>
          {doc.kind === 'crd' ? '客户需求文档（CRD）' : '产品需求规格书（PRD）'} · v{doc.viewing ?? doc.cur}
          {doc.finalized && (
            <span className="tag tag-ok" title="内容字节冻结；修改请先在 ⋯ 菜单「解锁定稿」（留审计）">已定稿 v{doc.finalVer}</span>
          )}
          {doc.viewing !== null && (
            <span className="tag tag-warn" title="历史版本只读；⋯ 菜单可「设为当前版本」，版本下拉可切回当前">历史只读</span>
          )}
          {!doc.finalized && doc.modified && doc.viewing === null && (
            <span className="tag tag-warn" title="工作区有未提交修改；工具栏「⬆ 版本提交」生成新版本">已修改未提交</span>
          )}
          {pendCount > 0 && (
            <span className="tag tag-warn" title="待确认补丁：在下方各章节行内逐条接受或拒绝（REQ-205）">补丁 ×{pendCount}</span>
          )}
          {pendCount > 1 && !readonly && <PatchBulk kind={kind} />}
        </h1>
        <PatchTrail patches={patches} />
        {doc.secs.map((s) => (
          <section key={s.id} id={`sec-${s.id}`} className={`sect${tocFlash === s.id ? ' flash' : ''}`}>
            {/* 补丁条在章节标题之前（原型口径：pending-bar → h2 → 正文） */}
            {s.pending && pendBySec.get(s.id) && <PendingBar kind={kind} patch={pendBySec.get(s.id)!} />}
            {s.title && <h2>{s.title}</h2>}
            {viewMode === 'preview' ? (
              <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(s.md) }} />
            ) : (
              <SectionEditor kind={kind} secId={s.id} md={s.md} readonly={readonly} />
            )}
          </section>
        ))}
        {appended.map((p) => (
          <section key={p.patchId} className="sect pending-add">
            <PendingBar kind={kind} patch={p} />
            {p.title && <h2>{p.title}</h2>}
            <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(p.new ?? '') }} />
          </section>
        ))}
        {doc.secs.length <= 1 && !doc.secs[0]?.md && (
          <div className="doc-empty">
            {kind === 'prd'
              ? 'PRD 以 CRD 定稿稿为默认参考。CRD 定稿后，挂接参考并点击工具栏「🔄 重新生成」开始；将先生成目录大纲，再逐章生成。'
              : '勾选参考资料后点击工具栏「🔄 重新生成」，将先生成目录大纲，再逐章生成；也可直接编辑。'}
          </div>
        )}
      </div>
    </div>
  );
}

/** 编辑态：逐节 textarea + 保存（save-draft 乐观锁：baseVersion+baseFingerprint；R7 冲突 toast+modal） */
function SectionEditor({ kind, secId, md, readonly }: { kind: DocKind; secId: string; md: string; readonly: boolean }) {
  const { projectId, doc, refresh } = useReqView();
  const [text, setText] = useState(md);
  const [msg, setMsg] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  // W2-042：编辑基线快照——非编辑态基线跟随 store 最新；一旦开始编辑（dirty）即锁定，
  // 保存用锁定基线而非 store 实时值（否则轮询/他人操作刷新指纹会使乐观锁形同虚设、后写覆盖先写）
  const [baseFp, setBaseFp] = useState<string | null>(() => doc?.contentFingerprint ?? null);
  const [baseVer, setBaseVer] = useState<number | null>(() => doc?.cur ?? null);
  const dirty = text !== md;
  useEffect(() => {
    if (!dirty && doc) {
      setBaseFp(doc.contentFingerprint);
      setBaseVer(doc.cur);
    }
  }, [dirty, doc]);
  if (!projectId || !doc) return null;
  const save = () => {
    setMsg(null);
    const ver = baseVer ?? doc.cur;
    const fp = baseFp ?? doc.contentFingerprint;
    void reqApi.saveDraft(projectId, kind, secId, text, ver, fp)
      .then((r) => {
        // 保存成功：编辑基线推进到新指纹（响应携带），后续保存基于新基线
        const next = (r as { contentFingerprint?: string }).contentFingerprint;
        if (next) setBaseFp(next);
        setBaseVer(useReqView.getState().doc?.cur ?? ver);
        toast('已保存本节', 'success');
      })
      .catch((e) => {
        // R7（DSG-U06-14）：并发冲突 toast + 弹窗（查看最新 / 基于最新重新编辑）
        if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
          setConflict(true);
          toast('内容已被他人更新', 'warn');
        } else {
          setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '保存失败');
        }
      })
      .finally(() => void refresh());
  };
  /** 基于最新重新编辑：刷新后保留本地文本，基线随 store 更新 */
  const rebaseAndKeep = async () => {
    await refresh();
    const latest = useReqView.getState().doc;
    setBaseFp(latest?.contentFingerprint ?? null);
    setBaseVer(latest?.cur ?? null);
    setConflict(false);
    toast('已切换到最新基线，当前编辑内容保留，可再次保存', 'success');
  };
  /** 查看最新：丢弃本地修改 */
  const viewLatest = async () => {
    await refresh();
    setText(useReqView.getState().doc?.secs.find((s) => s.id === secId)?.md ?? md);
    setConflict(false);
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
      {conflict && (
        <Modal
          title="内容已被他人更新"
          onClose={() => setConflict(false)}
          footer={
            <>
              <button className="sm" onClick={() => void viewLatest()}>
                查看最新
              </button>
              <button className="sm primary" onClick={() => void rebaseAndKeep()}>
                基于最新重新编辑
              </button>
            </>
          }
        >
          <p>本节内容在你编辑期间已被他人更新（版本/指纹不一致）。可查看最新版本，或保留你的修改基于最新版本重新保存。</p>
        </Modal>
      )}
    </div>
  );
}

/** 补丁批量处置（U-016）：整篇生成产出数十条补丁时一键全收/全拒；逐条调用既有命令（逐条审计），二次确认 */
function PatchBulk({ kind }: { kind: DocKind }) {
  const { projectId, patches, refresh } = useReqView();
  const [busy, setBusy] = useState(false);
  const [confirmOp, setConfirmOp] = useState<'accept' | 'reject' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!projectId) return null;
  const pending = patches.filter((p) => p.status === 'pending');
  if (pending.length < 2) return null;
  const run = async (op: 'accept' | 'reject') => {
    setBusy(true);
    setMsg(null);
    let done = 0;
    try {
      for (const p of pending) {
        if (op === 'accept') await reqApi.acceptPatch(projectId, kind, p.patchId);
        else await reqApi.rejectPatch(projectId, kind, p.patchId);
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
    <span className="patch-bulk">
      <button className="act primary sm" disabled={busy} title="逐条接受全部待确认补丁（逐条留审计）"
        onClick={() => setConfirmOp('accept')}>✓ 全部接受</button>
      <button className="act sm" disabled={busy} title="逐条拒绝全部待确认补丁"
        onClick={() => setConfirmOp('reject')}>✕ 全部拒绝</button>
      {msg && <span className="rsn err">{msg}</span>}
      {confirmOp && (
        <ConfirmModal
          title={confirmOp === 'accept' ? '全部接受补丁' : '全部拒绝补丁'}
          body={`将逐条${confirmOp === 'accept' ? '接受' : '拒绝'}当前 ${pending.length} 条待确认补丁（逐条留审计，REQ-205 确认语义不变）。\n接受 = 并入草稿；拒绝 = 丢弃提案。`}
          confirmLabel={confirmOp === 'accept' ? '全部接受' : '全部拒绝'}
          onClose={() => setConfirmOp(null)}
          onConfirm={() => void run(confirmOp)}
        />
      )}
    </span>
  );
}

/** 待确认补丁行内条（REQ-205；modify/del 高亮旧→新；L2：拒绝可填处置理由，落库留痕） */
function PendingBar({ kind, patch }: { kind: DocKind; patch: PatchItem }) {
  const { projectId, refresh } = useReqView();
  const [msg, setMsg] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!projectId) return null;
  const act = (fn: () => Promise<unknown>) => {
    setMsg(null);
    void fn()
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '操作失败'))
      .finally(() => void refresh());
  };
  const doReject = () => {
    setRejectOpen(false);
    act(() => reqApi.rejectPatch(projectId, kind, patch.patchId, reason.trim() || undefined));
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
      <button className="act primary" onClick={() => act(() => reqApi.acceptPatch(projectId, kind, patch.patchId))}>✓ 接受</button>
      <button className="act" onClick={() => setRejectOpen(true)}>✕ 拒绝</button>
      {msg && <span className="rsn err">{msg}</span>}
      {rejectOpen && (
        <div className="msk" onClick={() => setRejectOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>拒绝补丁</h3>
            <p className="sub">拒绝 = 丢弃本提案（不落稿）。可填写处置理由，随裁决落库留痕。</p>
            <textarea value={reason} rows={3} placeholder="处置理由（可选）：为什么拒绝这条提案" onChange={(e) => setReason(e.target.value)} />
            <div className="foot">
              <button className="act" onClick={() => setRejectOpen(false)}>取消</button>
              <button className="act danger" onClick={doReject}>✕ 确认拒绝</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 补丁处置留痕（L2）：已裁决补丁的理由回放；h1 旁 details 折叠展示 */
function PatchTrail({ patches }: { patches: PatchItem[] }) {
  const decided = patches.filter((p) => p.status !== 'pending');
  if (decided.length === 0) return null;
  return (
    <details className="patch-trail">
      <summary>处置留痕 ×{decided.length}</summary>
      {decided.map((p) => (
        <div key={p.patchId} className="patch-trail-row">
          <span className={`tag ${p.status === 'accepted' ? 'tag-ok' : 'tag-warn'}`}>
            {p.status === 'accepted' ? '已接受' : '已拒绝'}
          </span>
          <span className="pend-desc">
            {p.type === 'add' ? `「${p.title ?? '章节'}」` : p.type === 'del' ? `「${p.old ?? ''}」` : `${p.old ?? ''} → ${p.new ?? ''}`}
          </span>
          <span className="rsn">{p.reason ?? '（未填理由）'}</span>
        </div>
      ))}
    </details>
  );
}

/** R1 版本时间线（原型 docMenu「🕘 版本时间线」）：版本倒序列出，可跳看历史（只读） */
function VersionTimelineModal({ onClose }: { onClose: () => void }) {
  const { versions, doc, loadDoc } = useReqView();
  if (!doc) return null;
  return (
    <Modal title={`${doc.kind.toUpperCase()} 版本时间线`} onClose={onClose}>
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
                {v.at} · {v.by}
                {v.note ? ` · ${v.note}` : ''}
              </span>
            </div>
            {v.v !== doc.cur && (
              <button
                className="act"
                onClick={() => {
                  onClose();
                  void loadDoc(v.v);
                }}
              >
                查看
              </button>
            )}
          </li>
        ))}
      </ul>
    </Modal>
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
      .then(() => { onClose(); void useStagesStore.getState().load(pid); }) // U-015：定稿后刷新准入门禁
      .catch((e) => setMsg(e instanceof ApiError ? `${e.code}: ${e.message}` : '定稿失败'))
      .finally(() => void refresh());
  };
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{doc.kind.toUpperCase()} 定稿确认</h3>
        <p className="pop-tip">将 v{doc.cur} 标记为定稿稿：内容字节冻结，登记定稿证据与内容指纹（人工确认点 req.doc.finalize）。</p>
        {kind === 'prd' && (
          <div className={`gate-box ${gateOk ? 'ok' : 'err'}`}>
            <strong>RTM 门禁校验（实时重算，不用缓存值放行）</strong>
            {health ? (
              <ul>
                <li>L0a R→CR 承接率 {(health.l0a * 100).toFixed(1)}%（门槛 ≥95%）{health.l0a >= 0.95 ? ' ✓' : ' ✗'}</li>
                <li>L0b CR→REQ 承接率 {(health.l0b * 100).toFixed(1)}%（门槛 =100%）{health.l0b === 1 ? ' ✓' : ' ✗'}</li>
                <li className="mut">L0c REQ→DSG {(health.l0c * 100).toFixed(1)}%（开发门禁，本期信息展示）；L0d deferred {health.l0d} 项</li>
                {health.l0d > 0 && <li>✅ 未覆盖项 {health.l0d} 项均已显式标记 deferred（排除出分母）</li>}
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
