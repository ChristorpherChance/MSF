import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { materialApi } from './api';
import { BatchFinalizeModal, ProcessJobModal } from './BatchModals';
import { DetailView, ViewModeSwitch } from './DetailView';
import { TreePanel } from './TreePanel';
import { UploadZone } from './UploadZone';
import { useMaterialView, type MaterialSubTab } from './store';
import { GateBanner } from '../../ui/GateBanner';
import './material.css';

const SUB_TABS: Array<{ key: MaterialSubTab; label: string }> = [
  { key: 'file', label: '📥 文件解析' },
  { key: 'content', label: '🛠 内容解析' },
];

type JobKind = 'translate' | 'mask' | 'index';

/** 内容解析面右操作列（§3.2 ops-col + ops-panel 展开表单；原型 OPS 五项） */
const OPS: Array<{ key: string; icon: string; label: string; kind?: JobKind }> = [
  { key: 'translate', icon: '🌐', label: '翻译', kind: 'translate' },
  { key: 'index', icon: '🗂️', label: '建索引', kind: 'index' },
  { key: 'mask', icon: '🕶️', label: '脱敏', kind: 'mask' },
  { key: 'term', icon: '📖', label: '术语查询' },
  { key: 'attach', icon: '📎', label: '附件' },
];

function SubTabs() {
  const { subTab, setSubTab, refresh, requestGuard } = useMaterialView();
  return (
    <div className="subtabs" role="tablist">
      {SUB_TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={subTab === t.key}
          className={subTab === t.key ? 'on' : ''}
          onClick={() =>
            requestGuard(() => {
              setSubTab(t.key);
              void refresh();
            })
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 资料页（route: /material；LLD-6 §3.2 DSG-U03-2，REQ-101~115）。
 * T1-19：批量弹窗与定稿交互（快照/复核/变化行提示与后端五态一致）。
 * W4：⬇下载 / 删除双向同步 modal / 行内进度条与失败原因 / ops-panel 展开表单 / v11Guard 三选 modal。
 */
export function MaterialPage() {
  const { subTab, selectedFileId, loading, error, init } = useMaterialView();
  const [jobModal, setJobModal] = useState<{ kind: JobKind; fileIds: string[] } | null>(null);
  const [finalizeModal, setFinalizeModal] = useState<string[] | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  const openJob = (kind: JobKind) => {
    const { checked, parsedTree, selectedFileId: sel } = useMaterialView.getState();
    const ids = collectCheckedFiles(parsedTree, checked);
    // ops-panel 对当前文件执行；批量条对勾选项执行（原型口径：ops 作用于当前文稿）
    const targets = ids.length > 0 ? ids : sel ? [sel] : [];
    if (targets.length === 0) {
      toast('先在左侧勾选或选中要加工的文件（须为文件已定稿状态）', 'warn');
      return;
    }
    setJobModal({ kind, fileIds: targets });
  };

  return (
    <main>
      <GateBanner stage="material" />
      <SubTabs />
      <div className="mat-layout">
        <aside className="panel-left">
          {subTab === 'file' && <UploadZone />}
          {error && <div className="mat-banner">{error}</div>}
          <TreePanel />
          {loading && <p style={{ color: 'var(--ink2)', fontSize: 12 }}>加载中…</p>}
          <BatchBar onFinalize={(ids) => setFinalizeModal(ids)} />
        </aside>
        <section className="doc-area">
          {selectedFileId ? (
            <DetailView />
          ) : (
            <>
              <div className="doc-toolbar" style={{ justifyContent: 'flex-end' }}>
                <ViewModeSwitch />
              </div>
              <div className="doc-scroll">
                <div className="doc-empty">
                  {subTab === 'file'
                    ? '左侧上传并解析文件后，在此查看 Markdown 解析稿（预览/编辑/源码三态）。'
                    : '文件定稿后进入内容解析面，在此加工并内容定稿。'}
                </div>
              </div>
            </>
          )}
        </section>
        {subTab === 'content' && <OpsColumn onRun={openJob} />}
      </div>
      {jobModal && (
        <ProcessJobModal
          kind={jobModal.kind}
          fileIds={jobModal.fileIds}
          onClose={() => {
            setJobModal(null);
            void useMaterialView.getState().refresh();
          }}
        />
      )}
      {finalizeModal && (
        <BatchFinalizeModal fileIds={finalizeModal} onClose={() => setFinalizeModal(null)} />
      )}
      <GuardModal />
      <DeleteFileModal />
    </main>
  );
}

/** M5：操作列图标钮 + 展开 .ops-panel 表单（原型 opsColHtml）；翻译/建索引/脱敏走批量加工作业 */
function OpsColumn({ onRun }: { onRun: (kind: JobKind) => void }) {
  const { detail, selectedFileId } = useMaterialView();
  const [open, setOpen] = useState<string | null>(null);
  const [lang, setLang] = useState('中文');
  const [maskName, setMaskName] = useState(true);
  const [maskContact, setMaskContact] = useState(true);

  const op = OPS.find((o) => o.key === open);
  const attachments = detail?.attachments ?? [];
  const hasIndex = (detail?.ops ?? []).some((o) => o.op.includes('索引'));

  return (
    <>
      <div className="ops-col" aria-label="加工操作列">
        {OPS.map((o) => (
          <button
            key={o.key}
            className={`opbtn${open === o.key ? ' active' : ''}`}
            title={o.label}
            onClick={() => setOpen(open === o.key ? null : o.key)}
          >
            {o.icon}
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {op && (
        <div className="ops-panel">
          <div className="oph">
            {op.icon} {op.label}
            <button className="ghost mini" onClick={() => setOpen(null)}>
              ✕
            </button>
          </div>
          <div className="opb">
            {!selectedFileId && <p className="hint">先在左侧选中一个已定稿文件。</p>}
            {selectedFileId && op.key === 'translate' && (
              <>
                <div className="form-row">
                  <label>目标语言</label>
                  <select value={lang} onChange={(e) => setLang(e.target.value)}>
                    <option>中文</option>
                    <option>英语</option>
                    <option>法语</option>
                  </select>
                </div>
                <button className="act primary" style={{ width: '100%' }} onClick={() => onRun('translate')}>
                  执行翻译（生成附件）
                </button>
              </>
            )}
            {selectedFileId && op.key === 'index' && (
              <>
                <p className="hint">对当前文稿建立全文检索索引，供术语查询与 CRD 生成引用。</p>
                <button className="act primary" style={{ width: '100%' }} onClick={() => onRun('index')}>
                  建立索引
                </button>
              </>
            )}
            {selectedFileId && op.key === 'mask' && (
              <>
                <div className="form-row">
                  <label>脱敏对象</label>
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={maskName}
                      onChange={(e) => setMaskName(e.target.checked)}
                    />
                    人名
                  </label>
                  <label className="checkline">
                    <input
                      type="checkbox"
                      checked={maskContact}
                      onChange={(e) => setMaskContact(e.target.checked)}
                    />
                    电话 / 邮箱
                  </label>
                </div>
                <button className="act primary" style={{ width: '100%' }} onClick={() => onRun('mask')}>
                  执行脱敏（改写正文）
                </button>
              </>
            )}
            {selectedFileId && op.key === 'term' && (
              <>
                <div className="form-row">
                  <label>查询词</label>
                  <input type="text" placeholder="如：数据主权" disabled />
                </div>
                <button
                  className="act primary"
                  style={{ width: '100%' }}
                  disabled
                  title="术语检索引擎随后续里程碑接入"
                >
                  查询
                </button>
                {!hasIndex && (
                  <p className="hint" style={{ marginTop: 8 }}>
                    ⚠ 尚未建索引，查询时将先自动建索引
                  </p>
                )}
              </>
            )}
            {op.key === 'attach' &&
              (attachments.length > 0 ? (
                attachments.map((a, i) => (
                  <div key={`${a.name ?? i}`} className="attach-row">
                    <span>📎</span>
                    <span className="nm" style={{ flex: 1 }} title={a.name}>
                      {a.name ?? `附件 ${i + 1}`}
                    </span>
                  </div>
                ))
              ) : (
                <p className="hint">暂无附件。翻译等操作的产物会出现在这里。</p>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

/** M6：v11Guard 三选 modal（DSG-U02-7：继续编辑 / 放弃并继续 / 保存并继续） */
function GuardModal() {
  const { guardNext, setGuardNext, draft, setDraft, detail, projectId } = useMaterialView();
  const [busy, setBusy] = useState(false);
  if (!guardNext || !draft) return null;

  const proceed = () => {
    const fn = guardNext;
    setDraft(null);
    setGuardNext(null);
    fn();
  };
  const saveAndProceed = async () => {
    if (!projectId || !detail?.contentFingerprint) {
      toast('文件状态或内容已变化，未保存；请保留编辑内容后重新核对', 'warn');
      return;
    }
    setBusy(true);
    try {
      await materialApi.saveDraft(projectId, draft.fileId, draft.text, detail.contentFingerprint);
      toast('已保存', 'success');
      proceed();
    } catch (e) {
      // 保存失败（乐观锁/状态变化）：留在编辑态人工核对（原型 v11LeaveEdit 口径）
      toast(e instanceof ApiError ? e.message : '保存失败', 'warn');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="有未保存修改"
      onClose={() => setGuardNext(null)}
      footer={
        <>
          <button className="sm" onClick={() => setGuardNext(null)}>
            继续编辑
          </button>
          <button className="sm danger-ghost" disabled={busy} onClick={proceed}>
            放弃并继续
          </button>
          <button className="sm primary" disabled={busy} onClick={() => void saveAndProceed()}>
            保存并继续
          </button>
        </>
      }
    >
      <p>请先保存，或放弃当前编辑再继续。</p>
    </Modal>
  );
}

/** M3：删除双向同步确认 modal（DSG-U07-2 / LLD-6 §3.2 delFile；理由必填；GATE_BLOCKED 明示依赖） */
function DeleteFileModal() {
  const { deleteTarget, setDeleteTarget, projectId, selectedFileId, selectFile, refresh } =
    useMaterialView();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!deleteTarget) return null;

  const close = () => {
    setDeleteTarget(null);
    setReason('');
    setErr(null);
  };
  const confirm = async () => {
    if (!projectId) return;
    if (!reason.trim()) {
      setErr('删除理由必填（留痕审计）');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await materialApi.deleteFile(projectId, deleteTarget.id, reason.trim());
      toast(
        r.parsedDiscarded > 0 || r.children > 0
          ? `已删除（解析稿 ${r.parsedDiscarded} 份、ZIP 子件 ${r.children} 个随行）`
          : '已删除',
        'success',
      );
      if (selectedFileId === deleteTarget.id) selectFile(null);
      close();
      await refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : '删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="删除文件"
      onClose={close}
      footer={
        <>
          <button className="sm" onClick={close}>
            取消
          </button>
          <button className="sm danger-ghost" disabled={busy} onClick={() => void confirm()}>
            确认删除
          </button>
        </>
      }
    >
      <p>
        删除「{deleteTarget.name}」将<b>双向同步</b>：原文件、解析稿、内容解析结果与附件一并删除；
        被引用时会被守卫拦截。
      </p>
      <div className="form-row">
        <label>删除理由（必填，留痕审计）</label>
        <input
          type="text"
          value={reason}
          placeholder="如：重复资料清理"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {err && <div className="mat-banner">{err}</div>}
    </Modal>
  );
}

/** 从树摊平勾选中的文件 id（保持树序） */
function collectCheckedFiles(
  nodes: Array<{ id: string; type: string; children?: unknown[] }>,
  checked: Record<string, boolean>,
): string[] {
  const out: string[] = [];
  const walk = (ns: typeof nodes) => {
    for (const n of ns) {
      if (n.type === 'file' && checked[n.id]) out.push(n.id);
      if (n.children) walk(n.children as typeof nodes);
    }
  };
  walk(nodes);
  return out;
}

/** 批量操作条（§3.2：文件面=批量解析（已选 n）；内容面=批量内容定稿） */
function BatchBar({ onFinalize }: { onFinalize: (ids: string[]) => void }) {
  const { subTab, projectId, checked, originalTree, parsedTree, refresh, clearChecked } =
    useMaterialView();
  const [busy, setBusy] = useState(false);
  const n = Object.values(checked).filter(Boolean).length;

  if (subTab === 'file') {
    const runBatchParse = async () => {
      if (!projectId) return;
      const ids = collectCheckedFiles(originalTree, checked);
      setBusy(true);
      try {
        const r = await materialApi.batchParse(projectId, ids, true);
        if (r.rejected.length > 0) {
          toast(
            `已受理 ${r.accepted} 个；拒绝 ${r.rejected.length} 个（${r.rejected.map((x) => x.reason).join('、')}）`,
            'warn',
          );
        } else {
          toast(`已受理 ${r.accepted} 个，解析中…`, 'success');
        }
        clearChecked();
      } catch (e) {
        toast(e instanceof ApiError ? e.message : '批量解析失败', 'warn');
      } finally {
        setBusy(false);
        await refresh();
      }
    };
    return (
      <div className="batch-bar">
        <button
          className="act primary"
          disabled={busy || n === 0}
          onClick={() => void runBatchParse()}
        >
          ⚡ 批量解析（已选 {n}）
        </button>
      </div>
    );
  }

  return (
    <div className="batch-bar">
      <button
        className="act primary"
        disabled={n === 0}
        onClick={() => onFinalize(collectCheckedFiles(parsedTree, checked))}
      >
        ✓ 批量内容定稿（已选 {n}）
      </button>
    </div>
  );
}
