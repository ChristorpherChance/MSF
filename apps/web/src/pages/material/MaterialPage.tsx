import { useEffect } from 'react';
import { DetailView, ViewModeSwitch } from './DetailView';
import { TreePanel } from './TreePanel';
import { UploadZone } from './UploadZone';
import { useMaterialView, type MaterialSubTab } from './store';
import './material.css';

const SUB_TABS: Array<{ key: MaterialSubTab; label: string }> = [
  { key: 'file', label: '📥 文件解析' },
  { key: 'content', label: '🛠 内容解析' },
];

/** 内容解析面右操作列（§3.2：翻译/建索引/脱敏/术语查询/附件；加工交互 T1-19 接入） */
const OPS: Array<{ icon: string; name: string }> = [
  { icon: '🌐', name: '翻译' },
  { icon: '🗂️', name: '建索引' },
  { icon: '🕶️', name: '脱敏' },
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

function OpsCol() {
  return (
    <div className="ops-col" aria-label="加工操作列">
      {OPS.map((op) => (
        <button key={op.name} className="opbtn" disabled title={`${op.name}（T1-19 接入）`}>
          {op.icon}
        </button>
      ))}
    </div>
  );
}

/**
 * 资料页（route: /material；LLD-6 §3.2 DSG-U03-2，REQ-101~115）。
 * T1-18：双树 + 解析状态可视 + 上传区 + 三态详情；批量弹窗与定稿交互 T1-19。
 */
export function MaterialPage() {
  const { subTab, selectedFileId, loading, error, init } = useMaterialView();

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <main>
      <SubTabs />
      <div className="mat-layout">
        <aside className="panel-left">
          {subTab === 'file' && <UploadZone />}
          {error && <div className="mat-banner">{error}</div>}
          <TreePanel />
          {loading && <p style={{ color: 'var(--msf-mut)', fontSize: 12 }}>加载中…</p>}
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
        {subTab === 'content' && <OpsCol />}
        <aside className="mat-dock" title="全局助手 dock（随 M7 接入）">
          🤖
        </aside>
      </div>
    </main>
  );
}
