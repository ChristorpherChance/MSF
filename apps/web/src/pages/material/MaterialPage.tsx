import { useEffect, useState } from 'react';
import { ApiError } from '../../api';
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

/** 内容解析面右操作列（§3.2：翻译/建索引/脱敏 → 批量加工作业；术语查询/附件后续里程碑） */
const OPS: Array<{ icon: string; name: string; kind?: JobKind }> = [
  { icon: '🌐', name: '翻译', kind: 'translate' },
  { icon: '🗂️', name: '建索引', kind: 'index' },
  { icon: '🕶️', name: '脱敏', kind: 'mask' },
  { icon: '📖', name: '术语查询' },
  { icon: '📎', name: '附件' },
];

function SubTabs() {
  const { subTab, setSubTab, refresh } = useMaterialView();
  return (
    <div className="subtabs" role="tablist">
      {SUB_TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={subTab === t.key}
          className={subTab === t.key ? 'on' : ''}
          onClick={() => {
            setSubTab(t.key);
            void refresh();
          }}
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
 */
export function MaterialPage() {
  const { subTab, selectedFileId, loading, error, init } = useMaterialView();
  const [jobModal, setJobModal] = useState<{ kind: JobKind; fileIds: string[] } | null>(null);
  const [finalizeModal, setFinalizeModal] = useState<string[] | null>(null);

  useEffect(() => {
    void init();
  }, [init]);

  const openJob = (kind: JobKind) => {
    const { checked, parsedTree } = useMaterialView.getState();
    const ids = collectCheckedFiles(parsedTree, checked);
    if (ids.length === 0) {
      window.alert('先在左侧勾选要加工的文件（须为文件已定稿状态）');
      return;
    }
    setJobModal({ kind, fileIds: ids });
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
        {subTab === 'content' && (
          <div className="ops-col" aria-label="加工操作列">
            {OPS.map((op) => (
              <button
                key={op.name}
                className="opbtn"
                disabled={!op.kind}
                title={op.kind ? `${op.name}（对勾选文件建批量作业）` : `${op.name}（后续里程碑）`}
                onClick={() => op.kind && openJob(op.kind)}
              >
                {op.icon}
              </button>
            ))}
          </div>
        )}
        <aside className="mat-dock" title="全局助手 dock（随 M7 接入）">
          🤖
        </aside>
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
    </main>
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
  const [notice, setNotice] = useState<string | null>(null);
  const n = Object.values(checked).filter(Boolean).length;

  if (subTab === 'file') {
    const runBatchParse = async () => {
      if (!projectId) return;
      const ids = collectCheckedFiles(originalTree, checked);
      setBusy(true);
      setNotice(null);
      try {
        const r = await materialApi.batchParse(projectId, ids, true);
        setNotice(
          r.rejected.length > 0
            ? `已受理 ${r.accepted} 个；拒绝 ${r.rejected.length} 个（${r.rejected.map((x) => x.reason).join('、')}）`
            : `已受理 ${r.accepted} 个，解析中…`,
        );
        clearChecked();
      } catch (e) {
        setNotice(e instanceof ApiError ? e.message : '批量解析失败');
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
        {notice && <span className="rsn" style={{ flexBasis: '100%' }}>{notice}</span>}
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
