import { useEffect, useRef, useState } from 'react';
import type { MatParseStatus } from '@msf/shared';
import { ApiError } from '../../api';
import { Modal } from '../../ui/Modal';
import { toast } from '../../ui/toast';
import { materialApi, type TreeNode } from './api';
import { useMaterialView } from './store';

/** 解析六态显示（F02-3 权威枚举；文件面口径：content_final 属内容阶段，文件面只显示到文件定稿） */
export const STATUS_META: Record<MatParseStatus, { label: string; cls: string }> = {
  pending: { label: '待解析', cls: 'st-pending' },
  parsing: { label: '解析中…', cls: 'st-parsing' },
  parsed: { label: '已解析', cls: 'st-parsed' },
  failed: { label: '解析失败', cls: 'st-failed' },
  file_final: { label: '文件已定稿', cls: 'st-file_final' },
  content_final: { label: '文件已定稿', cls: 'st-file_final' }, // 文件面不泄漏内容阶段（实机走查）
};

export function StatusTag({ status }: { status?: MatParseStatus | undefined }) {
  if (!status) return null;
  const m = STATUS_META[status];
  return <span className={`mat-tag ${m.cls}`}>{m.label}</span>;
}

/** 内容面独立状态（内容稿=独立版本，不显示文件解析阶段；实机走查修复） */
const CONTENT_META: Record<'draft' | 'final' | 'none', { label: string; cls: string }> = {
  none: { label: '待整理', cls: 'st-pending' },
  draft: { label: '内容稿已保存', cls: 'st-parsed' },
  final: { label: '内容已定稿', cls: 'st-content_final' },
};

export function ContentTag({ status }: { status?: 'draft' | 'final' | 'none' | null | undefined }) {
  const m = CONTENT_META[status ?? 'none'];
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

/** 加密文件不可解析（原型：入口拦截 + 失败行引导删除后解密重传） */
const isEncrypted = (n: TreeNode) => /encrypted|加密/i.test(n.failMsg ?? '');

function FileRow({ node, showResults }: { node: TreeNode; showResults?: boolean | undefined }) {
  const {
    selectedFileId, guardedSelect, refresh, projectId, checked, toggleCheck,
    setDeleteTarget, collapsed, toggleFolder, subTab,
  } = useMaterialView();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const isZip = node.name.toLowerCase().endsWith('.zip');
  const results = node.results ?? [];
  const resKey = `res:${node.id}`;
  const resCollapsed = collapsed[resKey];

  const doExtract = async (onConflict: 'reject' | 'rename') => {
    if (!projectId) return;
    setBusy(true);
    try {
      await materialApi.extractZip(projectId, node.id, onConflict);
      if (onConflict === 'rename') toast('已按重命名冲突项解压', 'success');
      setConflict(null);
    } catch (e) {
      // 同名冲突默认整包拒绝；409/422 时给人工选择 rename 的入口（F09-1 / A03-4）
      if (e instanceof ApiError && (e.status === 409 || e.status === 422)) {
        setConflict(e.message);
      } else {
        toast(e instanceof Error ? e.message : '解压失败', 'warn');
      }
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const retry = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      await materialApi.retryParse(projectId, node.id);
      toast('已重新提交解析', 'success');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '重试失败', 'warn');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div>
      <div
        className={`tree-row${selectedFileId === node.id ? ' sel' : ''}`}
        onClick={() => guardedSelect(node.id)}
      >
        <input
          type="checkbox"
          checked={!!checked[node.id]}
          disabled={node.status === 'parsing'}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleCheck(node.id)}
          aria-label={`勾选 ${node.name}`}
        />
        {showResults && results.length > 0 && (
          <button
            className="ghost mini caret"
            aria-label="展开收拢加工结果"
            aria-expanded={!resCollapsed}
            onClick={(e) => {
              e.stopPropagation();
              toggleFolder(resKey);
            }}
          >
            {resCollapsed ? '▸' : '▾'}
          </button>
        )}
        <span>📄</span>
        <div className="nm-wrap">
          <span className="nm" title={node.name}>
            {node.name}
          </span>
          {/* M4：解析中行内进度条（服务端无百分比上报，用不定态条）；失败原因行内细化 */}
          {node.status === 'parsing' && (
            <div className="prog">
              <i className="indet" />
            </div>
          )}
          {node.status === 'failed' && (
            <span className="fail-note">⚠ {node.failMsg ?? '解析失败'}</span>
          )}
        </div>
        {subTab === 'content'
          ? <ContentTag status={node.contentStatus} />
          : <StatusTag status={node.status} />}
        {node.status === 'failed' && !isEncrypted(node) && (
          <button
            className="mini"
            disabled={busy}
            title="重试解析"
            onClick={(e) => {
              e.stopPropagation();
              void retry();
            }}
          >
            ↻ 重试
          </button>
        )}
        {isZip && node.status === 'pending' && (
          <button
            className="mini"
            disabled={busy}
            title="行内解压为同名文件夹（原包保留）"
            onClick={(e) => {
              e.stopPropagation();
              void doExtract('reject');
            }}
          >
            解压
          </button>
        )}
        <button
          className="mini danger-ghost"
          title={
            isEncrypted(node)
              ? '加密文件无法解析，请删除后解除密码重新上传'
              : '删除（双向同步：原文件+解析稿+引用）'
          }
          onClick={(e) => {
            e.stopPropagation();
            setDeleteTarget({ id: node.id, name: node.name });
          }}
        >
          🗑
        </button>
      </div>
      {/* M1：内容面主稿下的 ↳ 加工结果缩进行（可展开收拢） */}
      {showResults && results.length > 0 && !resCollapsed && (
        <div className="result-rows">
          {results.map((r) => (
            <div key={r} className="tree-row result-row" title={r}>
              <span className="nm">↳ {r}</span>
            </div>
          ))}
        </div>
      )}
      {/* M8：ZIP 同名冲突用 modal 承接（替代 window.confirm） */}
      {conflict && (
        <Modal
          title="ZIP 解压冲突"
          onClose={() => setConflict(null)}
          footer={
            <>
              <button className="sm" onClick={() => setConflict(null)}>
                取消
              </button>
              <button className="sm primary" onClick={() => void doExtract('rename')}>
                重命名冲突项并解压
              </button>
            </>
          }
        >
          <p>{conflict}</p>
          <p style={{ color: 'var(--ink2)', fontSize: 12.5 }}>
            默认整包拒绝；也可改用「重命名冲突项」方式解压（自动追加序号，REQ-104）。
          </p>
        </Modal>
      )}
    </div>
  );
}

function FolderRow({
  node,
  depth,
  showResults,
  origin,
}: {
  node: TreeNode;
  depth: number;
  showResults?: boolean | undefined;
  /** 原件树行（新建子目录仅原件树可点；解析稿树目录由镜像自动产生） */
  origin?: boolean | undefined;
}) {
  const { collapsed, toggleFolder, projectId, refresh } = useMaterialView();
  const [busy, setBusy] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const [delError, setDelError] = useState<string | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [childOpen, setChildOpen] = useState(false);
  const isCollapsed = collapsed[node.id];
  const fileIds = collectFiles(node).map((f) => f.id);

  // 空目录可删（实机走查：资料里每个地方的节点都应可清理）；非空由服务端拒绝并明示原因
  const doDelete = async () => {
    if (!projectId) return;
    setBusy(true);
    setDelError(null);
    try {
      await materialApi.deleteFolder(projectId, node.id);
      setDelOpen(false);
      toast('目录已删除', 'success');
    } catch (e) {
      // U-011：拒绝原因（如 409「目录非空」）留在弹窗内展示，不静默关窗
      setDelError(e instanceof ApiError ? e.message : '目录删除失败');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  return (
    <div>
      <div className="tree-row" onClick={() => toggleFolder(node.id)}>
        <TriCheck ids={fileIds} />
        <span>{isCollapsed ? '▸' : '▾'}</span>
        <span>📁</span>
        <span className="nm" title={node.name}>
          {node.name}
        </span>
        {origin && (
          <button
            className="mini"
            disabled={busy}
            title="新建子目录"
            onClick={(e) => {
              e.stopPropagation();
              setChildOpen(true);
            }}
          >
            ＋
          </button>
        )}
        <button
          className="mini"
          disabled={busy}
          title="重命名目录"
          onClick={(e) => {
            e.stopPropagation();
            setRenameOpen(true);
          }}
        >
          ✏️
        </button>
        <button
          className="mini"
          disabled={busy}
          title="删除空目录（非空目录需先清空）"
          onClick={(e) => {
            e.stopPropagation();
            setDelOpen(true);
          }}
        >
          🗑
        </button>
      </div>
      {delOpen && (
        <Modal
          title={`删除目录「${node.name}」`}
          onClose={() => { setDelOpen(false); setDelError(null); }}
          footer={
            <>
              <button className="sm" onClick={() => { setDelOpen(false); setDelError(null); }}>取消</button>
              <button className="sm primary" disabled={busy} onClick={() => void doDelete()}>删除</button>
            </>
          }
        >
          <p>双树镜像一并删除；非空目录由服务端拒绝并明示原因。</p>
          {delError && <p style={{ color: 'var(--red)' }}>✕ {delError}</p>}
        </Modal>
      )}
      {renameOpen && (
        <FolderNameModal
          title={`重命名目录「${node.name}」`}
          initial={node.name}
          onClose={() => setRenameOpen(false)}
          onSubmit={(name) => materialApi.renameFolder(projectId!, node.id, name)}
        />
      )}
      {childOpen && (
        <FolderNameModal
          title={`在「${node.name}」下新建子目录`}
          onClose={() => setChildOpen(false)}
          onSubmit={(name) => materialApi.createFolder(projectId!, node.id, name)}
        />
      )}
      {!isCollapsed && (
        <div className="tree-children">
          {(node.children ?? []).map((c) => (
            <TreeNodeRow key={c.id} node={c} depth={depth + 1} showResults={showResults} origin={origin} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 目录名表单弹窗（U-012 新建/重命名共用；失败原因行内展示不关窗） */
function FolderNameModal(props: {
  title: string;
  initial?: string;
  onSubmit: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { refresh } = useMaterialView();
  const [name, setName] = useState(props.initial ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(name.trim());
      props.onClose();
      toast('目录已保存', 'success');
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={props.title}
      onClose={props.onClose}
      footer={
        <>
          <button className="sm" onClick={props.onClose}>取消</button>
          <button className="sm primary" disabled={!name.trim() || busy} onClick={() => void submit()}>保存</button>
        </>
      }
    >
      <div className="pm-field">
        <label>目录名</label>
        <input
          type="text"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
        />
      </div>
      {error && <p style={{ color: 'var(--red)' }}>✕ {error}</p>}
    </Modal>
  );
}

function TreeNodeRow({
  node,
  depth,
  showResults,
  origin,
}: {
  node: TreeNode;
  depth: number;
  showResults?: boolean | undefined;
  origin?: boolean | undefined;
}) {
  return node.type === 'folder' ? (
    <FolderRow node={node} depth={depth} showResults={showResults} origin={origin} />
  ) : (
    <FileRow node={node} showResults={showResults} />
  );
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
  const { subTab, originalTree, parsedTree, onlyPending, setOnlyPending, projectId } = useMaterialView();
  const [rootCreateOpen, setRootCreateOpen] = useState(false);
  const original = subTab === 'file' && onlyPending ? filterPending(originalTree) : originalTree;
  const isContent = subTab === 'content';
  return (
    <div className="mat-tree">
      {subTab === 'file' && (
        <>
          <h4>
            📁 原始文件 · 待解析
            <button
              className="mini"
              style={{ float: 'right', marginLeft: 6 }}
              title="新建根目录（双树镜像同建）"
              onClick={() => setRootCreateOpen(true)}
            >
              ＋ 目录
            </button>
            <label style={{ float: 'right', fontWeight: 400, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => setOnlyPending(e.target.checked)}
              />{' '}
              仅待解析
            </label>
          </h4>
          {rootCreateOpen && projectId && (
            <FolderNameModal
              title="新建根目录"
              onClose={() => setRootCreateOpen(false)}
              onSubmit={(name) => materialApi.createFolder(projectId, null, name)}
            />
          )}
          {original.length === 0 && (
            <p style={{ color: 'var(--ink2)', fontSize: 13 }}>
              {onlyPending ? '无待解析文件。' : '尚无文件，先上传。'}
            </p>
          )}
          {original.map((n) => (
            <TreeNodeRow key={n.id} node={n} depth={0} origin />
          ))}
        </>
      )}
      <h4>{subTab === 'file' ? '📁 解析文件 · Markdown' : '📁 内容稿（主稿 + ↳ 加工结果）'}</h4>
      {parsedTree.length === 0 && (
        <p style={{ color: 'var(--ink2)', fontSize: 13 }}>解析产出后在此出现。</p>
      )}
      {parsedTree.map((n) => (
        <TreeNodeRow key={n.id} node={n} depth={0} showResults={isContent} />
      ))}
    </div>
  );
}
