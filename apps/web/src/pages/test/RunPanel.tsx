import { useRef, useState } from 'react';
import { ApiError } from '../../api';
import { tstApi } from './api';
import { useTstStore } from './store';

const RESULT_NAME: Record<string, string> = {
  pass: '通过', fail: '失败', blocked: '受阻', 'not-run': '未执行', 'not-applicable': '不适用',
};

/** 证据附件条目（tst.evidence.attach 登记的 evidence_ids 元素） */
interface AttachmentEntry {
  kind: 'attachment'; name: string; objectKey: string; size: number; sha256: string; by: string; at: string;
}

function attachmentsOf(evidenceIds: unknown[]): Array<{ idx: number; att: AttachmentEntry }> {
  const out: Array<{ idx: number; att: AttachmentEntry }> = [];
  evidenceIds.forEach((e, idx) => {
    if (e && typeof e === 'object' && (e as { kind?: string }).kind === 'attachment') {
      out.push({ idx, att: e as AttachmentEntry });
    }
  });
  return out;
}

/** 页签二：用例与执行（执行按钮 + 用例行 .qa-case + 证据附件 T4 + 人工走查录入 modal 五枚举 T5） */
export function RunPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  const [manual, setManual] = useState<{ caseId: string; status: string; evidence: string } | null>(null);
  const det = s.batchDetail;
  if (!det) return <p className="dsg-prefix qa-empty">请先接收批次</p>;

  const canExecute = det.status === 'approved' || det.status === 'executing';
  const approvedPlan = det.plans.find((p) => p.state === 'approved');
  return (
    <div>
      <div className="dsg-card">
        <div className="gen-head">
          <strong>执行</strong>
          <span className="dsg-prefix">
            {s.runs.length > 0 ? `共 ${s.runs.length} 个运行版本（追加式，历史不可改写）` : '尚无运行'}
          </span>
          <button
            className="act"
            disabled={!canExecute || !approvedPlan || s.plan?.state !== 'approved'}
            title={s.plan?.state !== 'approved' ? '计划批准后才可执行' : ''}
            onClick={() => s.act(() => tstApi.executeRun(pid, det.batchId, s.plan!.planId), '执行完成（自动用例由执行器执行）')}
          >
            执行批准计划
          </button>
        </div>
        {s.runs.length > 0 && (
          <div className="qa-runs-row">
            {s.runs.map((r) => (
              <span key={r.runId} className={`dev-run ${r.runId === s.latestRunId ? 'dev-run-running' : ''}`}>
                {r.runId} {r.conclusion ? RESULT_NAME[r.conclusion] ?? r.conclusion : '—'}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 用例行（最新运行版本） */}
      {s.caseRuns.length > 0 && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>用例结果（{s.latestRunId}）</strong>
            <span className="dsg-prefix">不适用≠通过；必测未执行留分母</span>
          </div>
          {s.caseRuns.map((c) => (
            <div key={c.code} className="qa-case">
              <div className="qa-case-head">
                <strong>{c.code}</strong>
                <span>{c.title}</span>
                <span className={`qa-tag qa-tag-${c.result}`}>{RESULT_NAME[c.result] ?? c.result}</span>
                <span className="dsg-prefix">{c.executor_kind === 'auto' ? '自动' : '人工'}</span>
                {c.mode === 'manual' && det.status === 'executing' && (
                  <button className="act" onClick={() => setManual({ caseId: c.code, status: 'pass', evidence: '' })}>
                    录入人工结论
                  </button>
                )}
                {/* T4 证据附件上传入口 */}
                {s.latestRunId && <EvidenceAttach runId={s.latestRunId} caseId={c.code} />}
              </div>
              {c.note && <div className="dsg-prefix">证据摘要：{c.note}</div>}
              {/* T4 证据附件查看（签名直链） */}
              {attachmentsOf(c.evidence_ids).length > 0 && (
                <div className="qa-evid-list">
                  {attachmentsOf(c.evidence_ids).map(({ idx, att }) => (
                    <EvidenceLink key={idx} runId={s.latestRunId!} caseId={c.code} idx={idx} att={att} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 人工走查记录 modal（证据必填；人工结论不得由自动执行代填 → 追加新运行版本；T5 五枚举） */}
      {manual && s.latestRunId && (
        <div className="qa-modal-mask" onClick={() => setManual(null)}>
          <div className="qa-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gen-head"><strong>人工走查记录 · {manual.caseId}</strong></div>
            <div className="form-row">
              <label>结论</label>
              <select value={manual.status} onChange={(e) => setManual({ ...manual, status: e.target.value })}>
                <option value="pass">通过</option>
                <option value="fail">失败</option>
                <option value="blocked">受阻</option>
                <option value="not-applicable">不适用</option>
              </select>
            </div>
            <textarea
              rows={4}
              placeholder="验证证据（必填：验证了什么、观察到什么、证据位置）"
              value={manual.evidence}
              onChange={(e) => setManual({ ...manual, evidence: e.target.value })}
            />
            <div className="gen-ops">
              <button
                className="act"
                disabled={!manual.evidence.trim()}
                onClick={() =>
                  s.act(async () => {
                    await tstApi.manualRecord(pid, s.latestRunId!, manual.caseId, {
                      status: manual.status, evidence: manual.evidence,
                    });
                    setManual(null);
                  }, '已录入（追加新运行版本）')}
              >
                保存记录
              </button>
              <button onClick={() => setManual(null)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** T4 证据附件上传（file picker → PUT 原始字节；≤20MB 由服务端复核） */
function EvidenceAttach({ runId, caseId }: { runId: string; caseId: string }) {
  const s = useTstStore();
  const pid = s.projectId!;
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          if (f.size > 20 * 1024 * 1024) {
            useTstStore.setState({ error: `证据附件过大（>20MB）：${f.name}` });
            return;
          }
          void s.act(() => tstApi.attachEvidence(pid, runId, caseId, f.name, f), `证据附件已上传：${f.name}`);
        }}
      />
      <button className="act" title="上传证据附件（截图/日志等，落对象存储并登记用例行）" onClick={() => fileRef.current?.click()}>
        📎 证据
      </button>
    </>
  );
}

/** T4 证据附件查看（GET 签名直链 → 新窗口打开） */
function EvidenceLink({ runId, caseId, idx, att }: { runId: string; caseId: string; idx: number; att: AttachmentEntry }) {
  const s = useTstStore();
  const pid = s.projectId!;
  return (
    <button
      className="qa-evid-item"
      title={`${att.name} · ${(att.size / 1024).toFixed(1)}KB · ${att.by} · ${new Date(att.at).toLocaleString()}`}
      onClick={() => {
        void tstApi.evidenceDownload(pid, runId, caseId, idx)
          .then((r) => window.open(r.url, '_blank'))
          .catch((e) => useTstStore.setState({ error: e instanceof ApiError ? `${e.code}: ${e.message}` : '证据下载失败' }));
      }}
    >
      📎 {att.name}
    </button>
  );
}
