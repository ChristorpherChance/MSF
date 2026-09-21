import type { ReactNode } from 'react';
import { useMaterialView, type MaterialSubTab, type ViewMode } from './store';
import './material.css';

const SUB_TABS: Array<{ key: MaterialSubTab; label: string }> = [
  { key: 'file', label: '📥 文件解析' },
  { key: 'content', label: '🛠 内容解析' },
];

const VIEW_MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'preview', label: '预览' },
  { key: 'edit', label: '编辑' },
  { key: 'source', label: '源码' },
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
  const { subTab, setSubTab } = useMaterialView();
  return (
    <div className="subtabs" role="tablist">
      {SUB_TABS.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={subTab === t.key}
          className={subTab === t.key ? 'on' : ''}
          onClick={() => setSubTab(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function ViewModeSwitch() {
  const { viewMode, setViewMode } = useMaterialView();
  return (
    <span className="viewmode" role="group" aria-label="视图三态">
      {VIEW_MODES.map((m) => (
        <button
          key={m.key}
          className={viewMode === m.key ? 'on' : ''}
          onClick={() => setViewMode(m.key)}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}

/** 中央工具栏：状态 tag + 动作区 + 三态切换（动作在 T1-18/19 随数据接线） */
function DocToolbar({ actions }: { actions?: ReactNode }) {
  const { selectedFileId } = useMaterialView();
  return (
    <div className="doc-toolbar">
      <span className="mat-tag">{selectedFileId ? '已选择文件' : '未选择文件'}</span>
      {actions}
      <ViewModeSwitch />
    </div>
  );
}

function DocEmpty({ text }: { text: string }) {
  return <div className="doc-empty">{text}</div>;
}

/** 左栏占位：目录树与文件面 T1-18 填充（双树 + 解析状态可视） */
function LeftPanePlaceholder({ title }: { title: string }) {
  return (
    <div>
      <strong>{title}</strong>
      <p style={{ color: 'var(--msf-mut)', fontSize: 13 }}>
        目录树随 T1-18 接入（GET /materials/tree，双树 + 解析状态）。
      </p>
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
 * T1-17 范围：子页签 + 三栏工作模式骨架（DSG-U02-3）+ 三态视图切换 + 空态；
 * 目录树/文件面 T1-18，批量弹窗与定稿交互 T1-19。
 */
export function MaterialPage() {
  const { subTab } = useMaterialView();
  return (
    <main>
      <SubTabs />
      <div className="mat-layout">
        <aside className="panel-left">
          <LeftPanePlaceholder title={subTab === 'file' ? '📁 原始文件 · 待解析' : '📁 解析文件'} />
        </aside>
        <section className="doc-area">
          <DocToolbar />
          <div className="doc-scroll">
            <DocEmpty
              text={
                subTab === 'file'
                  ? '左侧上传并解析文件后，在此查看 Markdown 解析稿（预览/编辑/源码三态）。'
                  : '文件定稿后进入内容解析面，在此加工并内容定稿。'
              }
            />
          </div>
        </section>
        {subTab === 'content' && <OpsCol />}
        <aside className="mat-dock" title="全局助手 dock（随 M7 接入）">
          🤖
        </aside>
      </div>
    </main>
  );
}
