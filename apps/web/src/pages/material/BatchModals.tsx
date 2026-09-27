import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api';
import { useStagesStore } from '../../ui/GateBanner';
import { materialApi, type JobView, type TreeNode } from './api';
import { useMaterialView } from './store';

/** 行级五态显示（F02-4 权威；skipped=执行中源变化/停止跳过） */
const ITEM_META: Record<JobView['items'][number]['status'], { label: string; cls: string }> = {
  pending: { label: '待处理', cls: 'it-pending' },
  processing: { label: '处理中…', cls: 'it-processing' },
  succeeded: { label: '成功', cls: 'it-succeeded' },
  failed: { label: '失败', cls: 'it-failed' },
  skipped: { label: '已跳过', cls: 'it-skipped' },
};

/** 双树摊平取文件名（弹窗行显示用） */
function useFileNames(): Map<string, string> {
  const { originalTree, parsedTree } = useMaterialView();
  const map = new Map<string, string>();
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === 'file') map.set(n.id, n.name);
      if (n.children) walk(n.children);
    }
  };
  walk(originalTree);
  walk(parsedTree);
  return map;
}

const KIND_LABEL: Record<'translate' | 'mask' | 'index', string> = {
  translate: '🌐 批量翻译',
  mask: '🕶️ 批量脱敏',
  index: '🗂️ 批量建索引',
};

/**
 * 批量加工作业弹窗（A03-15/16，REQ-111 快照复核）：
 * 登记（idle + 基线指纹）→ 确认提交（不一致 STALE_EVIDENCE 整批拒绝、不留作业行）
 * → running 轮询行级五态（skipped=执行中源变化行提示）→ 停止/单条重试。
 */
export function ProcessJobModal({
  kind,
  fileIds,
  onClose,
}: {
  kind: 'translate' | 'mask' | 'index';
  fileIds: string[];
  onClose: () => void;
}) {
  const { projectId, refresh } = useMaterialView();
  const names = useFileNames();
  const [jobId, setJobId] = useState<string | null>(null);
  const [basis, setBasis] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // 登记即落库（idle + basis_start），进入弹窗即创建
  useEffect(() => {
    if (!projectId) return;
    materialApi
      .createJob(projectId, kind, fileIds)
      .then((r) => {
        setJobId(r.jobId);
        setBasis(r.basisFingerprint);
        return materialApi.getJob(projectId, r.jobId);
      })
      .then(setJob)
      .catch((e) => setError(e instanceof ApiError ? e.message : '作业登记失败'));
  }, [projectId, kind, fileIds]);

  const poll = useCallback(
    async (id: string) => {
      if (!projectId) return;
      try {
        const j = await materialApi.getJob(projectId, id);
        setJob(j);
        if (j.status !== 'running' && timer.current) {
          clearInterval(timer.current);
          timer.current = null;
          void refresh();
        }
      } catch {
        /* 轮询失败下一拍再试 */
      }
    },
    [projectId, refresh],
  );

  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  const confirm = async () => {
    if (!projectId || !jobId) return;
    setBusy(true);
    setError(null);
    try {
      await materialApi.confirmJob(projectId, jobId);
      await poll(jobId);
      timer.current = setInterval(() => void poll(jobId), 1500);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_EVIDENCE') {
        // 整批拒绝：作业行已删，展示前后差异并只允许关闭
        setStale(e.message);
        setJob(null);
      } else {
        setError(e instanceof ApiError ? e.message : '确认提交失败');
      }
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!projectId || !jobId) return;
    setBusy(true);
    try {
      await materialApi.stopJob(projectId, jobId);
      await poll(jobId);
    } finally {
      setBusy(false);
    }
  };

  const retry = async (fileId: string) => {
    if (!projectId || !jobId) return;
    await materialApi.retryItem(projectId, jobId, fileId);
    await poll(jobId);
    if (!timer.current) timer.current = setInterval(() => void poll(jobId), 1500);
  };

  const done = job?.status === 'done' || job?.status === 'stopped';

  return (
    <div className="msk" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{KIND_LABEL[kind]}</h3>
        <p className="sub">
          共 {fileIds.length} 个文件{job ? ` · 作业 ${job.code}（${job.status}）` : ' · 登记中…'}
        </p>
        {basis && !stale && (
          <div className="basis-box">基线快照指纹（确认提交时将整批复核）：{basis}</div>
        )}
        {stale && (
          <div className="stale-box">
            ⚠ {stale}：弹窗登记后源已变化，本批未保留作业。请重新登记以当前内容为准。
          </div>
        )}
        {error && <div className="mat-banner">{error}</div>}
        {job &&
          job.items.map((it) => {
            const m = ITEM_META[it.status];
            return (
              <div className="mrow" key={it.fileId}>
                <span className="nm">{names.get(it.fileId) ?? it.fileId}</span>
                <span className={`mat-tag ${m.cls}`}>{m.label}</span>
                {it.status === 'skipped' && job.status !== 'idle' && (
                  <span className="rsn">执行中源变化或已停止</span>
                )}
                {it.error && <span className="rsn">{it.error}</span>}
                {(it.status === 'failed' || (it.status === 'skipped' && done)) && (
                  <button className="act" onClick={() => void retry(it.fileId)}>
                    重试
                  </button>
                )}
              </div>
            );
          })}
        <div className="foot">
          {job?.status === 'running' && (
            <button className="act danger" disabled={busy} onClick={() => void stop()}>
              ■ 停止
            </button>
          )}
          {job?.status === 'idle' && (
            <button className="act primary" disabled={busy} onClick={() => void confirm()}>
              ✓ 确认提交（整批复核）
            </button>
          )}
          <button className="act" onClick={onClose}>
            {stale || done ? '关闭' : '取消'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 批量内容定稿弹窗（A03-12，INV-BULK-1 强制人工逐条确认）：
 * 列出待定稿行 → 人工确认 → 逐条结果（ok/reason），不整批回滚。
 */
export function BatchFinalizeModal({
  fileIds,
  onClose,
}: {
  fileIds: string[];
  onClose: () => void;
}) {
  const { projectId, refresh, clearChecked } = useMaterialView();
  const names = useFileNames();
  const [results, setResults] = useState<Array<{ fileId: string; ok: boolean; reason?: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await materialApi.batchFinalizeContent(projectId, fileIds);
      setResults(r.results);
      clearChecked();
      void useStagesStore.getState().load(projectId); // U-015：定稿后刷新准入门禁
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '批量定稿失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="msk" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>✓ 批量内容定稿</h3>
        <p className="sub">逐条确认以下 {fileIds.length} 个文件内容定稿（定稿后成为需求参考输入）</p>
        {error && <div className="mat-banner">{error}</div>}
        {(
          (results ??
            fileIds.map((fileId) => ({ fileId, ok: false }))) as Array<{
            fileId: string;
            ok: boolean;
            reason?: string;
          }>
        ).map(
          (r) => (
            <div className="mrow" key={r.fileId}>
              <span className="nm">{names.get(r.fileId) ?? r.fileId}</span>
              {results &&
                (r.ok ? (
                  <span className="mat-tag it-succeeded">已定稿</span>
                ) : (
                  <>
                    <span className="mat-tag it-failed">未定稿</span>
                    <span className="rsn">{r.reason}</span>
                  </>
                ))}
            </div>
          ),
        )}
        <div className="foot">
          {!results ? (
            <>
              <button className="act" onClick={onClose}>
                取消
              </button>
              <button className="act primary" disabled={busy} onClick={() => void confirm()}>
                ✓ 确认逐条定稿
              </button>
            </>
          ) : (
            <button className="act primary" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
