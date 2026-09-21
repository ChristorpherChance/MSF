import { useMemo, useState } from 'react';
import { marked } from 'marked';
import { ApiError } from '../../api';
import { materialApi } from './api';
import { useMaterialView, type ViewMode } from './store';
import { StatusTag } from './TreePanel';

const VIEW_MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'preview', label: '预览' },
  { key: 'edit', label: '编辑' },
  { key: 'source', label: '源码' },
];

/** 三态切换（预览/编辑/源码），置于工具栏末尾（§3.2 .viewmode） */
export function ViewModeSwitch() {
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

/**
 * 中央文档区（§3.2：状态 tag + 预览/编辑/源码三态 + 重新解析/下载/定稿）。
 * 编辑保存走 A03-10 内容草稿（乐观锁 baseFingerprint）；定稿/批量交互 T1-19。
 * 草稿与未保存守卫（v11Guard）在 store，树行切换共用。
 */
export function DetailView() {
  const { projectId, selectedFileId, detail, viewMode, subTab, refresh, draft, setDraft } =
    useMaterialView();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const md = subTab === 'file' ? (detail?.parsedMd ?? null) : (detail?.contentMd ?? null);
  const activeDraft = draft && draft.fileId === selectedFileId ? draft : null;
  const dirty = activeDraft !== null && activeDraft.text !== activeDraft.base;

  const html = useMemo(
    () => (viewMode === 'preview' && md ? marked.parse(md, { async: false }) : ''),
    [viewMode, md],
  );

  if (!selectedFileId || !detail) return null;
  const fileId = selectedFileId;

  const run = async (fn: (pid: string) => Promise<unknown>) => {
    if (!projectId) return;
    const pid = projectId;
    setBusy(true);
    setNotice(null);
    try {
      await fn(pid);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : '操作失败');
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const status = detail.status;

  return (
    <>
      {notice && <div className="mat-banner">{notice}</div>}
      {status === 'failed' && <div className="mat-banner">解析失败，可重试</div>}
      {status === 'parsing' && <div className="mat-banner info">解析中…</div>}
      <div className="doc-toolbar">
        <StatusTag status={status} />
        {status === 'pending' && (
          <button
            className="act primary"
            disabled={busy}
            onClick={() => void run((pid) => materialApi.parse(pid, fileId))}
          >
            ▶ 开始解析
          </button>
        )}
        {(status === 'failed' || status === 'parsed' || status === 'file_final') && (
          <button
            className="act"
            disabled={busy}
            onClick={() => void run((pid) => materialApi.retryParse(pid, fileId))}
          >
            ↻ {status === 'failed' ? '重试解析' : '重新解析'}
          </button>
        )}
        {viewMode === 'edit' && dirty && (
          <button
            className="act primary"
            disabled={busy || !detail.contentFingerprint}
            title="保存为内容整理稿（乐观锁）"
            onClick={() =>
              void run(async (pid) => {
                await materialApi.saveDraft(
                  pid,
                  fileId,
                  activeDraft.text,
                  detail.contentFingerprint ?? '',
                );
                setDraft(null);
              })
            }
          >
            💾 保存草稿
          </button>
        )}
        {dirty && (
          <button className="act" disabled={busy} onClick={() => setDraft(null)}>
            放弃修改
          </button>
        )}
        <ViewModeSwitch />
      </div>
      <div className="doc-scroll">
        <div className="doc-paper">
          {viewMode === 'preview' &&
            (md ? (
              // 渲染本端用户资料 Markdown（单用户本地部署）；外部不可信内容策略见 LLD-7 N02
              <div className="md-view" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <p style={{ color: 'var(--msf-mut)' }}>
                {status === 'pending' ? '尚未解析，点击工具栏「开始解析」。' : '暂无内容。'}
              </p>
            ))}
          {viewMode === 'edit' && (
            <textarea
              className="md-editor"
              value={activeDraft?.text ?? md ?? ''}
              placeholder={md ? '' : '解析后可见内容；也可直接起草内容稿'}
              onChange={(e) =>
                setDraft({
                  fileId,
                  base: md ?? '',
                  text: e.target.value,
                })
              }
            />
          )}
          {viewMode === 'source' && <pre className="md-src">{md ?? '（无内容）'}</pre>}
        </div>
      </div>
    </>
  );
}
