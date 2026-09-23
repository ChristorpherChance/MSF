import { useEffect, useMemo, useState } from 'react';
import { mdHtml } from '../../md-html';
import { ApiError } from '../../api';
import { Popover } from '../../ui/Popover';
import { toast } from '../../ui/toast';
import { materialApi } from './api';
import { useMaterialView, type ViewMode } from './store';
import { ContentTag, StatusTag } from './TreePanel';

const VIEW_MODES: Array<{ key: ViewMode; label: string }> = [
  { key: 'preview', label: '预览' },
  { key: 'edit', label: '编辑' },
  { key: 'source', label: '源码' },
];

/** 三态切换（预览/编辑/源码），置于工具栏末尾（§3.2 .viewmode）；切出编辑态走 v11Guard */
export function ViewModeSwitch() {
  const { viewMode, setViewMode, requestGuard } = useMaterialView();
  return (
    <span className="viewmode" role="group" aria-label="视图三态">
      {VIEW_MODES.map((m) => (
        <button
          key={m.key}
          className={viewMode === m.key ? 'on' : ''}
          onClick={() => {
            if (viewMode === 'edit' && m.key !== 'edit') {
              requestGuard(() => setViewMode(m.key));
            } else {
              setViewMode(m.key);
            }
          }}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}

/** ⬇ 下载 ▾（§3.2 工具栏）：解析稿 Markdown（本端落盘）/ 原文件（签名直链 5 分钟） */
function DownloadButton({ md, fileName }: { md: string | null; fileName: string }) {
  const { projectId, selectedFileId } = useMaterialView();
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const downloadMd = () => {
    if (!md) return;
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName.replace(/\.[^.]+$/, '') + '.md';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('已下载解析稿 Markdown', 'success');
  };
  const downloadOriginal = async () => {
    if (!projectId || !selectedFileId) return;
    try {
      const r = await materialApi.download(projectId, selectedFileId);
      window.open(r.url, '_blank', 'noopener');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : '获取下载链接失败', 'warn');
    }
  };

  return (
    <>
      <button
        className="act"
        onClick={(e) => setAnchor((e.target as HTMLElement).getBoundingClientRect())}
      >
        ⬇ 下载 ▾
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div className="po-head">下载</div>
          <button
            className="po-item"
            disabled={!md}
            onClick={() => {
              setAnchor(null);
              downloadMd();
            }}
          >
            ⬇ 解析稿 Markdown (.md)
          </button>
          <button
            className="po-item"
            onClick={() => {
              setAnchor(null);
              void downloadOriginal();
            }}
          >
            ⬇ 原文件
          </button>
        </Popover>
      )}
    </>
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
    () => (viewMode === 'preview' && md ? mdHtml(md) : ''),
    [viewMode, md],
  );

  // 解析中轮询刷新（SSE parse.* 事件随集成里程碑接入前的收口口径，见 doc/dev-plan/M1-验收.md）
  const parsing = detail?.status === 'parsing';
  useEffect(() => {
    if (!parsing) return;
    const t = setInterval(() => void refresh(), 1500);
    return () => clearInterval(t);
  }, [parsing, refresh]);

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
  const contentStatus = detail.contentStatus;
  // 内容定稿：有未保存编辑则以编辑器内容一键「保存+定稿」；否则以现有内容稿/解析稿定稿
  const finalizeContent = () =>
    void run((pid) =>
      dirty && activeDraft
        ? materialApi.finalizeContent(pid, fileId, activeDraft.text).then(() => setDraft(null))
        : materialApi.finalizeContent(pid, fileId),
    );

  return (
    <>
      {notice && <div className="mat-banner">{notice}</div>}
      {status === 'failed' && <div className="mat-banner">解析失败，可重试</div>}
      {status === 'parsing' && <div className="mat-banner info">解析中…</div>}
      {subTab === 'content' && status === 'parsed' && (
        <div className="mat-banner info">
          内容稿可编辑保存；内容定稿需先在「文件解析」面完成文件定稿
        </div>
      )}
      <div className="doc-toolbar">
        {subTab === 'content' ? <ContentTag status={contentStatus} /> : <StatusTag status={status} />}
        {subTab === 'file' && status === 'pending' && (
          <button
            className="act primary"
            disabled={busy}
            onClick={() => void run((pid) => materialApi.parse(pid, fileId))}
          >
            ▶ 开始解析
          </button>
        )}
        {(status === 'failed' || (subTab === 'file' && (status === 'parsed' || status === 'file_final'))) && (
          <button
            className="act"
            disabled={busy}
            onClick={() => void run((pid) => materialApi.retryParse(pid, fileId))}
          >
            ↻ {status === 'failed' ? '重试解析' : '重新解析'}
          </button>
        )}
        {subTab === 'file' && status === 'parsed' && (
          <button
            className="act primary"
            disabled={busy}
            title="定稿后进入内容解析面（F02-3）"
            onClick={() => void run((pid) => materialApi.finalizeFile(pid, fileId))}
          >
            ✓ 文件解析定稿
          </button>
        )}
        {subTab === 'file' && status === 'file_final' && (
          <button
            className="act"
            disabled={busy}
            title="退回已解析状态，可重新解析"
            onClick={() => void run((pid) => materialApi.unfinalizeFile(pid, fileId))}
          >
            取消定稿
          </button>
        )}
        {subTab === 'content' && status === 'file_final' && contentStatus !== 'final' && (
          <button
            className="act primary"
            disabled={busy}
            title={dirty ? '以当前编辑内容保存并定稿（成为需求参考输入，REQ-114）' : '以当前内容稿定稿（成为需求参考输入，REQ-114）'}
            onClick={finalizeContent}
          >
            ✓ 内容解析定稿
          </button>
        )}
        {viewMode === 'edit' && dirty && contentStatus !== 'final' && (
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
        {dirty && contentStatus !== 'final' && (
          <button className="act" disabled={busy} onClick={() => setDraft(null)}>
            放弃修改
          </button>
        )}
        <DownloadButton md={md} fileName={detail.name ?? 'document'} />
        <ViewModeSwitch />
      </div>
      <div className="doc-scroll">
        <div className="doc-paper">
          {viewMode === 'preview' &&
            (md ? (
              // 渲染本端用户资料 Markdown（单用户本地部署）；外部不可信内容策略见 LLD-7 N02
              <div className="md-view" dangerouslySetInnerHTML={{ __html: html }} />
            ) : (
              <p style={{ color: 'var(--ink2)' }}>
                {status === 'pending' ? '尚未解析，点击工具栏「开始解析」。' : '暂无内容。'}
              </p>
            ))}
          {viewMode === 'edit' &&
            (contentStatus === 'final' ? (
              <p style={{ color: 'var(--ink2)' }}>内容已定稿，不可再编辑（切「预览/源码」查看）。</p>
            ) : (
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
            ))}
          {viewMode === 'source' && <pre className="md-src">{md ?? '（无内容）'}</pre>}
        </div>
        {/* M2：内容面附件列表区（加工产物挂载处；原型 .attach-row） */}
        {subTab === 'content' && (detail.attachments ?? []).length > 0 && (
          <div className="attach-area">
            <div className="attach-head">附件（{detail.attachments!.length}）</div>
            {detail.attachments!.map((a, i) => (
              <div key={`${a.name ?? i}`} className="attach-row">
                <span>📎</span>
                <span className="nm" style={{ flex: 1 }} title={a.name}>
                  {a.name ?? `附件 ${i + 1}`}
                  {a.by ? `（${a.by}）` : ''}
                </span>
                <button
                  className="act"
                  onClick={() => toast('附件产物下载随 M6 沙箱存储接入', 'warn')}
                >
                  下载
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
