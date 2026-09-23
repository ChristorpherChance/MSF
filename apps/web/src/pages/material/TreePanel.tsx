import { useEffect, useRef, useState } from 'react';
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

/** 收集子树全部文件节点（半选/全选计算用） */
function collectFiles(node: TreeNode, acc: TreeNode[] = []): TreeNode[] {
  if (node.type === 'file') acc.push(node);
  for (const c of node.children ?? []) collectFiles(c, acc);
  return acc;
}

/** 三态勾选框（全选/半选/全不选；indeterminate 只能经 DOM 属性设置） */
function TriCheck({ ids }: { ids: string[] }) {
  const { checked, setChecked } = useMaterialView();
  const ref = useRef<HTMLInputElement>(null);
  const n = ids.filter((id) => checked[id]).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = n > 0 && n < ids.length;
  }, [n, ids.length]);
  if (ids.length === 0) return null;
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={n === ids.length && ids.length > 0}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setChecked(ids, e.target.checked)}
      aria-label="全选/半选"
    />
  );
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
  const fileIds = collectFiles(node).map((f) => f.id);
  return (
    <div>
      <div className="tree-row" onClick={() => toggleFolder(node.id)}>
        <TriCheck ids={fileIds} />
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

/** 仅待解析过滤（REQ-106/108）：隐藏非 pending 文件与过滤后为空的目录 */
function filterPending(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of nodes) {
    if (n.type === 'file') {
      if (n.status === 'pending' || n.status === 'failed') out.push(n);
    } else {
      const children = filterPending(n.children ?? []);
      if (children.length > 0) out.push({ ...n, children });
    }
  }
  return out;
}

/** 双目录树（§3.2：原始文件·待解析 / 解析文件·Markdown；折叠/勾选/半选/全选为会话态，REQ-106） */
export function TreePanel() {
  const { subTab, originalTree, parsedTree, onlyPending, setOnlyPending } = useMaterialView();
  const original = subTab === 'file' && onlyPending ? filterPending(originalTree) : originalTree;
  return (
    <div className="mat-tree">
      {subTab === 'file' && (
        <>
          <h4>
            📁 原始文件 · 待解析
            <label style={{ float: 'right', fontWeight: 400, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => setOnlyPending(e.target.checked)}
              />{' '}
              仅待解析
            </label>
          </h4>
          {original.length === 0 && (
            <p style={{ color: 'var(--ink2)', fontSize: 13 }}>
              {onlyPending ? '无待解析文件。' : '尚无文件，先上传。'}
            </p>
          )}
          {original.map((n) => (
            <TreeNodeRow key={n.id} node={n} depth={0} />
          ))}
        </>
      )}
      <h4>{subTab === 'file' ? '📁 解析文件 · Markdown' : '📁 解析文件'}</h4>
      {parsedTree.length === 0 && (
        <p style={{ color: 'var(--ink2)', fontSize: 13 }}>解析产出后在此出现。</p>
      )}
      {parsedTree.map((n) => (
        <TreeNodeRow key={n.id} node={n} depth={0} />
      ))}
    </div>
  );
}
