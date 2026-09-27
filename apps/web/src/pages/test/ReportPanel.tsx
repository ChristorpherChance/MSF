import { useState } from 'react';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { tstApi } from './api';
import { NeedBatch } from './NeedBatch';
import { useTstStore } from './store';

/** 页签四：报告与交付（汇总报告 + 结论横幅 + basis 过期置灰 T6 + 定稿/放行/导出按钮组 + 豁免多选清单 T7 + 决定历史） */
export function ReportPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  /** T7 豁免多选：defectId → 豁免理由（逐项列举，须覆盖全部未关闭缺陷） */
  const [waiver, setWaiver] = useState<{ reportId: string; items: Record<string, string> } | null>(null);
  const [confirm, setConfirm] = useState<null | 'finalize' | 'release' | 'reject' | 'waiver'>(null);
  const det = s.batchDetail;
  if (!det) return <NeedBatch />;

  const latest = s.reports[0] ?? null;
  const canGenerate = ['executing', 'reported'].includes(det.status) && s.runs.length > 0;
  const unclosed = latest?.summary.unclosedDefects ?? [];
  const notRun = (latest?.summary.cases ?? []).filter((c) => c.must_run && c.result === 'not-run');
  const simulated = latest?.summary.simulated ?? false;
  // T6 basis 过期：执行或缺陷已变化 → 定稿/放行置灰并提示重新汇总
  const stale = latest?.basisStale ?? false;
  // 条件放行可豁免性预判（与服务端 WAIVER_NOT_ALLOWED 同口径：P0/P1、必测未执行、模拟失真不可豁免）
  const waiverBlocked: string[] = [];
  if (notRun.length > 0) waiverBlocked.push('必测未执行不可豁免');
  if (simulated) waiverBlocked.push('含模拟执行，证据失真不可豁免');
  const p01 = (latest?.summary.defects ?? []).filter((d) => d.status !== 'closed' && ['P0', 'P1'].includes(String(d.severity)));
  if (p01.length > 0) waiverBlocked.push(`P0/P1 不可豁免：${p01.map((d) => d.code).join(',')}`);

  // T7：全部未关闭缺陷均已勾选且填写理由才允许提交
  const waiverReady = waiver !== null && unclosed.length > 0
    && unclosed.every((d) => (waiver.items[d] ?? '').trim().length > 0);

  return (
    <div>
      {/* 汇总报告（原型 delivery() 口径：报告与人工交付决定） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>报告与人工交付决定</strong>
          <span className="dsg-prefix">{s.reports.length} 份 · 有未通过项或未关闭缺陷即 fail · 定稿≠放行</span>
          <button className="act" disabled={!canGenerate}
            title={!canGenerate ? '须先执行（批次 executing/reported 且有运行）' : ''}
            onClick={() => s.act(() => tstApi.generateReport(pid, det.batchId), '报告已生成（draft，登记 basis 指纹）')}>
            汇总本批报告
          </button>
        </div>
        <p className="dsg-prefix" style={{ margin: '4px 0 0' }}>报告可定稿为不通过；定稿不会把失败变绿，也不会自动放行。</p>

        {latest && (
          <>
            {/* 结论横幅（原型：必测项通过/暂不放行 · 已定稿/待审阅） */}
            <div className={`qa-banner ${latest.verdict === 'pass' ? 'qa-banner-pass' : 'qa-banner-fail'}`}>
              {latest.reportId} · {latest.verdict === 'pass' ? '必测项通过' : '暂不放行'} · {latest.status === 'finalized' ? `已定稿（${latest.finalizedBy ?? ''}）` : '待审阅'}
              {simulated && <span className="dev-bad"> · 含模拟执行，不得用于正式放行依据</span>}
            </div>
            {/* T6 basis 指纹过期横幅 */}
            {stale && (
              <div className="qa-banner qa-banner-stale">
                ⚠ 执行或缺陷已有变化（basis 指纹不符）——本报告已过期，定稿与交付决定已置灰，请重新汇总。
              </div>
            )}
            <p className="dsg-prefix">
              basis 指纹 {latest.basisFingerprint.slice(0, 26)}…（执行或缺陷已变化 → 定稿/放行将被拒绝，请重新汇总）
            </p>
            {unclosed.length > 0 && <p className="dev-bad">未关闭缺陷：{unclosed.join('、')}</p>}
            {notRun.length > 0 && <p className="dev-bad">必测未执行：{notRun.map((c) => String(c.code)).join('、')}</p>}

            {/* 定稿/放行/导出按钮组（T6：stale 置灰） */}
            <div className="gen-ops">
              {latest.status === 'draft' && (
                <button className="act"
                  disabled={stale}
                  title={stale ? 'basis 指纹已过期，请重新汇总' : ''}
                  onClick={() => setConfirm('finalize')}>
                  人工定稿报告
                </button>
              )}
              {latest.status === 'finalized' && det.status !== 'released' && (
                <>
                  <button className="act" disabled={stale || latest.verdict !== 'pass' || unclosed.length > 0}
                    title={stale ? 'basis 指纹已过期，请重新汇总' : latest.verdict !== 'pass' || unclosed.length > 0 ? '正常放行需结论 pass 且无未关闭缺陷' : ''}
                    onClick={() => setConfirm('release')}>
                    确认本批交付
                  </button>
                  <button className="act" disabled={stale || waiverBlocked.length > 0}
                    title={stale ? 'basis 指纹已过期，请重新汇总' : waiverBlocked.join('；') || '仅可豁免明确列举的 P2/P3 且须覆盖全部未关闭缺陷'}
                    onClick={() => setWaiver({ reportId: latest.reportId, items: {} })}>
                    条件放行（豁免）
                  </button>
                  <button
                    disabled={stale}
                    title={stale ? 'basis 指纹已过期，请重新汇总' : ''}
                    onClick={() => setConfirm('reject')}>
                    不予交付
                  </button>
                </>
              )}
              <button className="act" onClick={async () => {
                const e = await tstApi.exportReport(pid, latest.reportId);
                window.open(e.downloadUrl, '_blank');
              }}>导出报告与决定</button>
            </div>
            {det.status === 'released' && (
              <p className="qa-banner qa-banner-pass" style={{ marginTop: 6 }}>本批交付决定已记录（不可变）。</p>
            )}
            {waiverBlocked.length > 0 && latest.status === 'finalized' && !stale && (
              <p className="dsg-prefix">条件放行不可用：{waiverBlocked.join('；')}</p>
            )}
          </>
        )}
        {!latest && <p className="dsg-prefix qa-empty">尚未生成报告。先执行批准用例并记录人工验证。</p>}

        {/* T7 条件放行豁免清单：逐项列举全部未关闭缺陷（多选+逐项理由，缺一项即不可提交） */}
        {waiver && latest && (
          <div className="qa-waiver">
            <div className="gen-head">
              <strong>豁免清单</strong>
              <span className="dsg-prefix">
                须覆盖全部未关闭缺陷（{unclosed.length} 项）；仅 P2/P3 可豁免，理由随决定工件不可变落库
              </span>
            </div>
            {(latest.summary.defects ?? [])
              .filter((d) => unclosed.includes(String(d.code)))
              .map((d) => {
                const code = String(d.code);
                const checked = waiver.items[code] !== undefined;
                return (
                  <div key={code} className="qa-waiver-row">
                    <label className="dev-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setWaiver({
                          ...waiver,
                          items: e.target.checked
                            ? { ...waiver.items, [code]: '' }
                            : Object.fromEntries(Object.entries(waiver.items).filter(([k]) => k !== code)),
                        })}
                      />
                      <span><code>{code}</code>（{String(d.severity ?? '—')}）{String(d.title ?? '')}</span>
                    </label>
                    {checked && (
                      <input
                        placeholder="豁免理由（必填：风险判断和后续安排）"
                        value={waiver.items[code] ?? ''}
                        onChange={(e) => setWaiver({ ...waiver, items: { ...waiver.items, [code]: e.target.value } })}
                      />
                    )}
                  </div>
                );
              })}
            {!waiverReady && (
              <p className="dsg-prefix">尚有 {unclosed.filter((d) => !(waiver.items[d] ?? '').trim()).length} 项未勾选或未填理由。</p>
            )}
            <div className="gen-ops">
              <button className="act" disabled={!waiverReady}
                onClick={() => setConfirm('waiver')}>
                提交豁免并放行
              </button>
              <button onClick={() => setWaiver(null)}>取消</button>
            </div>
          </div>
        )}
      </div>

      {/* 报告历史 */}
      {s.reports.length > 0 && (
        <div className="dsg-card">
          <div className="gen-head"><strong>报告历史</strong></div>
          <table className="dev-table">
            <thead><tr><th>编号</th><th>结论</th><th>状态</th><th>basis</th><th>定稿人</th><th>时间</th></tr></thead>
            <tbody>
              {s.reports.map((r) => (
                <tr key={r.reportId}>
                  <td>{r.reportId}</td>
                  <td className={r.verdict === 'pass' ? 'dev-ok' : 'dev-bad'}>{r.verdict === 'pass' ? '通过' : '不通过'}</td>
                  <td>{r.status === 'finalized' ? '已定稿' : '草稿'}</td>
                  <td>{r.basisStale ? <span className="dev-bad">已过期</span> : <span className="dev-ok">有效</span>}</td>
                  <td>{r.finalizedBy ?? '—'}</td>
                  <td className="dsg-prefix">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 决定历史（不可变工件） */}
      {s.decisions.length > 0 && (
        <div className="dsg-card">
          <div className="gen-head"><strong>交付决定（不可变）</strong></div>
          <table className="dev-table">
            <thead><tr><th>编号</th><th>类型</th><th>报告</th><th>豁免</th><th>决定人</th><th>时间</th></tr></thead>
            <tbody>
              {s.decisions.map((d) => (
                <tr key={d.decisionId}>
                  <td>{d.decisionId}</td>
                  <td>{d.type === 'normal' ? '放行' : d.type === 'conditional' ? '条件放行' : '不予交付'}</td>
                  <td>{d.reportId}</td>
                  <td>{d.exemptions.length > 0 ? d.exemptions.map((e) => `${e.defect_code}(${e.severity})`).join('、') : '—'}</td>
                  <td>{d.actor}</td>
                  <td className="dsg-prefix">{new Date(d.at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 定稿/放行/不予交付/豁免 二次确认（DSG-U07-2：禁原生 confirm） */}
      {confirm === 'finalize' && latest && (
        <ConfirmModal
          title={`人工定稿报告 ${latest.reportId}`}
          confirmLabel="人工定稿报告"
          body={`结论：${latest.verdict === 'pass' ? '通过' : '不通过'}\n策略确认点 test.report.finalize；可定稿不通过；定稿≠放行。`}
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => tstApi.finalizeReport(pid, latest.reportId), '报告已定稿')}
        />
      )}
      {confirm === 'release' && latest && (
        <ConfirmModal
          title="确认本批交付（正常放行）"
          confirmLabel="确认本批交付"
          body={'策略确认点 test.release，决定不可变。'}
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => tstApi.release(pid, latest.reportId, { type: 'normal' }), '已放行（批次 released）')}
        />
      )}
      {confirm === 'reject' && latest && (
        <ConfirmModal
          title="确认本批不予交付（reject）"
          confirmLabel="不予交付"
          body={'决定不可变，随报告与批次身份保存。'}
          onClose={() => setConfirm(null)}
          onConfirm={() => s.act(() => tstApi.release(pid, latest.reportId, { type: 'reject' }), '已登记不予交付')}
        />
      )}
      {confirm === 'waiver' && waiver && (
        <ConfirmModal
          title="条件放行（豁免）"
          confirmLabel="提交豁免并放行"
          body={`豁免：${Object.keys(waiver.items).join('、')}\n服务端复核：P0/P1/必测未执行/证据失真不可豁免；须覆盖全部未关闭缺陷。`}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            s.act(async () => {
              await tstApi.release(pid, waiver.reportId, {
                type: 'conditional',
                waivers: Object.entries(waiver.items).map(([defectId, justification]) => ({ defectId, justification })),
              });
              setWaiver(null);
            }, '已条件放行（豁免清单落库）')}
        />
      )}
    </div>
  );
}
