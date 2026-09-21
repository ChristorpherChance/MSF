import { useState } from 'react';
import type { MatParseStatus } from '@msf/shared';
import { ApiError } from '../../api';
import { materialApi, type TreeNode } from './api';
import { useMaterialView } from './store';

/** 解析六态显示（F02-3 权威枚举） */
export const STATUS_META: Record<MatParseStatus, { label: string; cls: string }> = {
  pending: { label: '待解析', cls: 'st-pending' },
  parsing: { label: '解析中…', cls: 'st-parsing' },
  parsed: { label: '已解析', cls: 'st-parsed' },
  failed: { label: '解析失败', cls: 'st-failed' },
  file_final: { label: '文件已定稿', cls: 'st-file_final' },
  content_final: { label: '内容已定稿', cls: 'st-content_final' },
};

export function StatusTag({ status }: { status?: MatParseStatus | undefined }) {
  if (!status) return null;
  const m = STATUS_META[status];
  return <span className={`mat-tag ${m.cls}`}>{m.label}</span>;
}

function FileRow({ node }: { node: TreeNode }) {
  const { selectedFileId, guardedSelect, refresh, projectId, checked, toggleCheck } =
    useMaterialView();
  const [busy, setBusy] = useState(false);
  const isZip = node.name.toLowerCase().endsWith('.zip');

  const extract = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      // 同名冲突默认整包拒绝；409/422 时给人工选择 rename 的入口（F09-1 / A03-4）
      await materialApi.extractZip(projectId, node.id, 'reject');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
        if (window.confirm(`${e.message}\n是否改用「重命名冲突项」方式解压？`)) {
          await materialApi.extractZip(projectId, node.id, 'rename');
        }
      } else {
        window.alert(e instanceof Error ? e.message : '解压失败');
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div
      className={`tree-row${selectedFileId === node.id ? ' sel' : ''}`}
      onClick={() => guardedSelect(node.id)}
    >
      <input
        type="checkbox"
        checked={!!checked[node.id]}
        onClick={(e) => e.stopPropagation()}
        onChange={() => toggleCheck(node.id)}
        aria-label={`勾选 ${node.name}`}
      />
      <span>📄</span>
      <span className="nm" title={node.name}>
        {node.name}
      </span>
      <StatusTag status={node.status} />
      {isZip && (
        <button
          className="mini"
          disabled={busy}
          title="行内解压为同名文件夹（原包保留）"
          onClick={(e) => {
            e.stopPropagation();
            void extract();
          }}
        >
          解压
        </button>
      )}
    </div>
  );
}

function FolderRow({ node, depth }: { node: TreeNode; depth: number }) {
  const { collapsed, toggleFolder } = useMaterialView();
  const isCollapsed = collapsed[node.id];
  return (
    <div>
      <div className="tree-row" onClick={() => toggleFolder(node.id)}>
        <span>{isCollapsed ? '▸' : '▾'}</span>
        <span>📁</span>
        <span className="nm" title={node.name}>
          {node.name}
        </span>
      </div>
      {!isCollapsed && (
        <div className="tree-children">
          {(node.children ?? []).map((c) => (
            <TreeNodeRow key={c.id} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeNodeRow({ node, depth }: { node: TreeNode; depth: number }) {
  return node.type === 'folder' ? <FolderRow node={node} depth={depth} /> : <FileRow node={node} />;
}

/** 双目录树（§3.2：原始文件·待解析 / 解析文件·Markdown；折叠/选择为会话态） */
export function TreePanel() {
  const { subTab, originalTree, parsedTree } = useMaterialView();
  return (
    <div className="mat-tree">
      {subTab === 'file' && (
        <>
          <h4>📁 原始文件 · 待解析</h4>
          {originalTree.length === 0 && (
            <p style={{ color: 'var(--msf-mut)', fontSize: 13 }}>尚无文件，先上传。</p>
          )}
          {originalTree.map((n) => (
            <TreeNodeRow key={n.id} node={n} depth={0} />
          ))}
        </>
      )}
      <h4>{subTab === 'file' ? '📁 解析文件 · Markdown' : '📁 解析文件'}</h4>
      {parsedTree.length === 0 && (
        <p style={{ color: 'var(--msf-mut)', fontSize: 13 }}>解析产出后在此出现。</p>
      )}
      {parsedTree.map((n) => (
        <TreeNodeRow key={n.id} node={n} depth={0} />
      ))}
    </div>
  );
}
