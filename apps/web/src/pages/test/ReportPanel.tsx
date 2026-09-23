import { useState } from 'react';
import { tstApi } from './api';
import { useTstStore } from './store';

/** 页签四：报告与交付（汇总报告 + 结论横幅 + basis 过期置灰 T6 + 定稿/放行/导出按钮组 + 豁免多选清单 T7 + 决定历史） */
export function ReportPanel() {
  const s = useTstStore();
  const pid = s.projectId!;
  /** T7 豁免多选：defectId → 豁免理由（逐项列举，须覆盖全部未关闭缺陷） */
  const [waiver, setWaiver] = useState<{ reportId: string; items: Record<string, string> } | null>(null);
  const det = s.batchDetail;
  if (!det) return <p className="dsg-prefix qa-empty">请先接收批次</p>;

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
      {/* 汇总报告 */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>验收报告</strong>
          <span className="dsg-prefix">{s.reports.length} 份 · 有未通过项或未关闭缺陷即 fail · 定稿≠放行</span>
          <button className="act" disabled={!canGenerate}
            title={!canGenerate ? '须先执行（批次 executing/reported 且有运行）' : ''}
            onClick={() => s.act(() => tstApi.generateReport(pid, det.batchId), '报告已生成（draft，登记 basis 指纹）')}>
            生成/重新汇总
          </button>
        </div>

        {latest && (
          <>
            {/* 结论横幅 */}
            <div className={`qa-banner ${latest.verdict === 'pass' ? 'qa-banner-pass' : 'qa-banner-fail'}`}>
              结论：{latest.verdict === 'pass' ? '通过' : '不通过'} · {latest.reportId} · {latest.status === 'finalized' ? `已定稿（${latest.finalizedBy ?? ''}）` : '草稿'}
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
                  onClick={() =>
                    window.confirm(`人工定稿报告 ${latest.reportId}（结论：${latest.verdict === 'pass' ? '通过' : '不通过'}）？\n（策略确认点 test.report.finalize；可定稿不通过；定稿≠放行）`) &&
                    s.act(() => tstApi.finalizeReport(pid, latest.reportId), '报告已定稿')}>
                  人工定稿报告
                </button>
              )}
              {latest.status === 'finalized' && det.status !== 'released' && (
                <>
                  <button className="act" disabled={stale || latest.verdict !== 'pass' || unclosed.length > 0}
                    title={stale ? 'basis 指纹已过期，请重新汇总' : latest.verdict !== 'pass' || unclosed.length > 0 ? '正常放行需结论 pass 且无未关闭缺陷' : ''}
                    onClick={() =>
                      window.confirm('确认本批交付（正常放行）？\n（策略确认点 test.release，决定不可变）') &&
                      s.act(() => tstApi.release(pid, latest.reportId, { type: 'normal' }), '已放行（批次 released）')}>
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
                    onClick={() =>
                      window.confirm('确认本批不予交付（reject）？\n（决定不可变，随报告与批次身份保存）') &&
                      s.act(() => tstApi.release(pid, latest.reportId, { type: 'reject' }), '已登记不予交付')}>
                    不予交付
                  </button>
                </>
              )}
              <button className="act" onClick={async () => {
                const e = await tstApi.exportReport(pid, latest.reportId);
                window.open(e.downloadUrl, '_blank');
              }}>导出报告</button>
            </div>
            {waiverBlocked.length > 0 && latest.status === 'finalized' && !stale && (
              <p className="dsg-prefix">条件放行不可用：{waiverBlocked.join('；')}</p>
            )}
          </>
        )}
        {!latest && <p className="dsg-prefix qa-empty">尚无报告（执行后生成）</p>}

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
                onClick={() =>
                  window.confirm(`条件放行：豁免 ${Object.keys(waiver.items).join('、')}？\n（服务端复核：P0/P1/必测未执行/证据失真不可豁免；须覆盖全部未关闭缺陷）`) &&
                  s.act(async () => {
                    await tstApi.release(pid, waiver.reportId, {
                      type: 'conditional',
                      waivers: Object.entries(waiver.items).map(([defectId, justification]) => ({ defectId, justification })),
                    });
                    setWaiver(null);
                  }, '已条件放行（豁免清单落库）')}>
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
    </div>
  );
}
