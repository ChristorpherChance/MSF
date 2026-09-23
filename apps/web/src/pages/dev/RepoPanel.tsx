import { useEffect, useState } from 'react';
import { devApi } from './api';
import { useDevStore } from './store';

/** 执行工作区 · 代码仓（V8；A06-9：左文件树 + 深色代码视图 + 最近提交） */
export function RepoPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [tree, setTree] = useState<Array<{ path: string; kind: 'dir' | 'file'; taskCode?: string }>>([]);
  const [file, setFile] = useState<{ path: string; content: string; taskCode: string | null } | null>(null);
  const [lint, setLint] = useState<{ ok: boolean; issues: string[] }>({ ok: true, issues: [] });
  const [changes, setChanges] = useState<Array<{ commitId: string; taskCode: string; title: string; by: string; at: string; basis: string }>>([]);
  const [selPath, setSelPath] = useState<string | null>(null);

  const load = async (path?: string) => {
    const [t, c] = await Promise.all([devApi.repoTree(pid, path), devApi.repoChanges(pid)]);
    setTree(t.tree); setFile(t.file); setLint(t.lint);
    setSelPath(t.file?.path ?? null);
    setChanges(c.changes);
  };
  useEffect(() => { void load(); }, [s.tasks.length]);

  const pick = (path: string) => {
    void (async () => {
      const t = await devApi.repoTree(pid, path);
      setFile(t.file); setSelPath(path);
    })();
  };

  return (
    <div className="dev-repo">
      {/* 左：文件树 + 最近提交 */}
      <div className="dev-repo-side">
        <div className="pl-head">仓库（任务写范围派生）</div>
        <div className="filelist dev-repo-tree">
          {tree.map((n) => (
            <div
              key={n.path}
              className={`tree-item${selPath === n.path ? ' active' : ''}${n.kind === 'dir' ? ' dir' : ''}`}
              style={{ paddingLeft: 8 + (n.path.split('/').length - 1) * 14 }}
              onClick={() => n.kind === 'file' && pick(n.path)}
              title={n.taskCode ? `任务 ${n.taskCode}` : ''}
            >
              {n.kind === 'dir' ? '📁' : '📄'} {n.path.split('/').pop()}
            </div>
          ))}
          {tree.length === 0 && <div className="dsg-prefix" style={{ padding: 8 }}>任务池为空，无写范围可派生</div>}
        </div>
        <div className="pl-head">最近提交</div>
        <div className="filelist" style={{ maxHeight: 200, overflow: 'auto' }}>
          {changes.map((c) => (
            <div key={c.commitId} className="file-row" title={`合并依据 ${c.basis}`}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="fname">{c.title}</div>
                <div className="dsg-prefix">{c.commitId.slice(0, 8)} · {c.by} · {new Date(c.at).toLocaleString()}</div>
              </div>
            </div>
          ))}
          {changes.length === 0 && <div className="dsg-prefix" style={{ padding: 8 }}>尚无合并提交</div>}
        </div>
      </div>

      {/* 右：工具栏 + 深色代码视图 */}
      <div className="dev-repo-main">
        <div className="doc-toolbar">
          {file && <span className="tag">{file.path}</span>}
          {file?.taskCode && (
            <button className="act mini" onClick={() => { void s.setTopTab('plan'); }}>任务 {file.taskCode} →</button>
          )}
          <span className="spacer" />
          <span className={`tag ${lint.ok ? 'tag-ok' : 'tag-warn'}`}>{lint.ok ? 'lint ✓' : `lint ${lint.issues.length} 问题`}</span>
          <button
            className="act mini"
            disabled={!file}
            onClick={() => { void navigator.clipboard.writeText(file?.content ?? ''); useDevStore.setState({ notice: '已复制文件内容' }); }}
          >
            ⧉ 复制
          </button>
        </div>
        {!lint.ok && (
          <div className="gate-box err">
            {lint.issues.map((i) => <div key={i} className="issue-row">{i}</div>)}
          </div>
        )}
        <div className="doc-scroll">
          {file ? (
            <pre className="code-view">{file.content}</pre>
          ) : (
            <div className="dsg-prefix" style={{ padding: 24, textAlign: 'center' }}>选择左侧文件查看派生预览（真实工作区由执行器维护）</div>
          )}
        </div>
      </div>
    </div>
  );
}
