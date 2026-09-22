import { useState } from 'react';
import { devApi, type ReportDetail } from './api';
import { useDevStore } from './store';

const GATE_NAMES: Record<string, string> = {
  functional: '功能检查', integration: '联调与冒烟', ui: 'UI 符合度', review: '开发审核',
};

/** 页签三：质量验收（构建 + 自测四门 + 报告 + 双侧对照 + 转测试交接） */
export function QualityPanel() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [cmp, setCmp] = useState<{ pageId: string; proto: string; build: string; distinct: boolean } | null>(null);
  const [retestReason, setRetestReason] = useState('');
  const latest = s.reports[0] ?? null;

  return (
    <div>
      {/* 集成构建（REQ-412） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>集成构建</strong>
          {s.build && <span className="dsg-prefix">{s.build.buildId} · {s.build.status} · 计划 r{s.build.planRevision}</span>}
        </div>
        {s.build ? (
          <p className="dsg-prefix">
            指纹 {s.build.buildFingerprint.slice(0, 19)}…｜提交 {s.build.commits.length} 个｜
            独立 UI 工件 {s.build.uiArtifact.htmlFingerprint.slice(0, 19)}…（{s.build.uiArtifact.independent ? '非原型复制' : '—'}）
          </p>
        ) : (
          <p className="dsg-prefix">尚无候选构建（全部计划任务合并后可构建）</p>
        )}
        <button onClick={() => s.act(() => devApi.buildRun(pid), '构建完成')}>发起构建</button>
      </div>

      {/* 自测四门（F02-7） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>开发自测</strong>
          {s.selftestGate && (
            <span className={s.selftestGate.ok ? 'dev-ok' : 'dev-bad'}>{s.selftestGate.ok ? '门禁放行' : '门禁阻断'}</span>
          )}
        </div>
        {s.selftestGate && !s.selftestGate.ok && (
          <div className="gate-box">
            {s.selftestGate.issues.map((i) => (
              <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
            ))}
          </div>
        )}
        <div className="gen-ops">
          <button onClick={() => s.act(() => devApi.selftestStart(pid), '自测完成')}>启动自测</button>
          {latest?.status === 'fail' && (
            <>
              <input placeholder="复测理由（必填）" value={retestReason} onChange={(e) => setRetestReason(e.target.value)} />
              <button className="act" disabled={!retestReason.trim()}
                onClick={() => s.act(() => devApi.selftestRetest(pid, retestReason), '复测完成')}>
                复测（需实质返工）
              </button>
            </>
          )}
        </div>
      </div>

      {/* 报告列表 + 详情 */}
      <div className="dsg-card">
        <div className="gen-head"><strong>自测报告</strong></div>
        <table className="dev-table">
          <thead><tr><th>编号</th><th>结论</th><th>时间</th><th>操作</th></tr></thead>
          <tbody>
            {s.reports.map((r) => (
              <tr key={r.id}>
                <td>{r.code}</td>
                <td className={r.status === 'pass' ? 'dev-ok' : 'dev-bad'}>{r.status === 'pass' ? '通过' : '未通过'}</td>
                <td className="dsg-prefix">{new Date(r.created_at).toLocaleString()}</td>
                <td>
                  <button className="act" onClick={async () => setDetail(await devApi.reportDetail(pid, r.id))}>详情</button>
                  <button className="act" onClick={async () => {
                    const e = await devApi.reportExport(pid, r.id, 'md');
                    window.open(e.downloadUrl, '_blank');
                  }}>导出</button>
                </td>
              </tr>
            ))}
            {s.reports.length === 0 && <tr><td colSpan={4} className="dsg-prefix">尚无报告</td></tr>}
          </tbody>
        </table>
      </div>

      {detail && (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>{detail.code} 详情</strong>
            <span className="dsg-prefix">
              {detail.immutable ? '不可变' : ''}{detail.tampered ? '（指纹复核不符！）' : '（指纹复核一致）'}
            </span>
            <button className="act" onClick={() => setDetail(null)}>关闭</button>
          </div>
          {/* 三 KPI */}
          <div className="kpi-row">
            <div className="kpi-card"><div className="kpi-label">结论</div><div className="kpi-value">{detail.status === 'pass' ? '通过' : '未通过'}</div></div>
            <div className="kpi-card"><div className="kpi-label">四门通过</div><div className="kpi-value">{Object.values(detail.gates).filter((g) => g.ok).length}/4</div></div>
            <div className="kpi-card"><div className="kpi-label">页面×视口</div><div className="kpi-value">{detail.pages.filter((p) => p.passed).length}/{detail.pages.length}</div></div>
          </div>
          {/* 四门卡 */}
          <div className="kpi-row">
            {Object.entries(detail.gates).map(([k, g]) => (
              <div key={k} className="kpi-card">
                <div className="kpi-label">{GATE_NAMES[k] ?? k}</div>
                <div className={`kpi-value ${g.ok ? 'dev-ok' : 'dev-bad'}`}>{g.ok ? '通过' : '阻断'}</div>
                {(g.issues ?? []).slice(0, 3).map((i) => (
                  <div key={i.code} className="kpi-note">{i.code}</div>
                ))}
              </div>
            ))}
          </div>
          {/* 逐页×视口矩阵 */}
          <table className="dev-table">
            <thead>
              <tr><th>页面</th><th>视口</th><th>关键项</th><th>一般项</th><th>严重偏差</th><th>跳过/未测</th><th>格判定</th></tr>
            </thead>
            <tbody>
              {detail.pages.map((p) => (
                <tr key={`${p.page_code}:${p.viewport_code}`}>
                  <td>{p.page_code}</td><td>{p.viewport_code}</td>
                  <td>{p.critical_pass}/{p.critical_total}</td>
                  <td>{p.general_pass}/{p.general_total}</td>
                  <td>{p.severe_deviations}</td>
                  <td>{p.skipped}/{p.not_run}</td>
                  <td className={p.passed ? 'dev-ok' : 'dev-bad'}>{p.passed ? '过' : '挂'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 双侧对照入口（REQ-415） */}
          <div className="form-row">
            <input placeholder="页面 ID（如 P-001）" value={cmp?.pageId ?? ''} onChange={(e) => setCmp({ pageId: e.target.value, proto: '', build: '', distinct: false })} />
            <button className="act" onClick={async () => {
              if (!cmp?.pageId) return;
              const r = await devApi.comparison(pid, cmp.pageId);
              setCmp({ pageId: cmp.pageId, proto: r.prototypePreviewUrl, build: r.buildPreviewUrl, distinct: r.sameObjectGuard.distinct });
            }}>双侧对照</button>
          </div>
          {cmp?.proto && (
            <div className="dev-compare">
              <div>
                <div className="dsg-prefix">设计原型（{cmp.distinct ? '与构建不同源 ✓' : '同源！'}）</div>
                <iframe className="proto-iframe" src={cmp.proto} title="prototype" sandbox="" />
              </div>
              <div>
                <div className="dsg-prefix">构建 UI 工件</div>
                <iframe className="proto-iframe" src={cmp.build} title="build" sandbox="" />
              </div>
            </div>
          )}
        </div>
      )}

      {/* 转测试交接（REQ-418；人工确认点） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>转测试交接</strong>
          {s.transferGate && (
            <span className={s.transferGate.ok ? 'dev-ok' : 'dev-bad'}>{s.transferGate.ok ? '门禁放行' : '门禁阻断'}</span>
          )}
        </div>
        {s.transferGate && !s.transferGate.ok && (
          <div className="gate-box">
            {s.transferGate.issues.map((i) => (
              <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
            ))}
          </div>
        )}
        <button
          disabled={!s.transferGate?.ok || !latest || latest.status !== 'pass'}
          onClick={() =>
            window.confirm(`确认交接 ${latest!.code} 至测试验收？\n报告指纹：sha256:${latest!.report_fingerprint}\n（批次候选：构建+基线+报告三指纹；AI 不可代确认）`) &&
            s.act(() => devApi.transfer(pid, latest!.id, `sha256:${latest!.report_fingerprint}`), '已交接（回执幂等）')}
        >
          人工确认交接
        </button>
      </div>
    </div>
  );
}
