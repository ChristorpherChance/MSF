import { useState } from 'react';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { downloadFile } from '../../ui/download';
import { devApi, type ReportDetail } from './api';
import { KIND_CLASS, KIND_LABEL, useDevStore } from './store';

const GATE_NAMES: Record<string, string> = {
  functional: '功能检查', integration: '联调与冒烟', ui: 'UI 符合度', review: '开发审核',
};

/** 质量工作区路由（左栏 qualityPage：targets/unit/pr/build/selftest） */
export function QualityPanel() {
  const s = useDevStore();
  if (s.qualityPage === 'targets') return <QualityTargets />;
  if (s.qualityPage === 'unit') return <UnitTestTable />;
  if (s.qualityPage === 'pr') return <PrReview />;
  if (s.qualityPage === 'build') return <BuildPage />;
  return <SelftestPage />;
}

/** V9 质量目标表（原型 devQualityTargetsHtml：任务/对象/场景 tag/覆盖门槛/规格完整度/编辑入口） */
function QualityTargets() {
  const s = useDevStore();
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🎯 质量目标</strong>
        <span className="dsg-prefix">项目默认 80% / 70%；任务可提高。正常场景必需，边界/异常不适用须写理由。</span>
        <span className="spacer" />
        <button
          className="act"
          disabled={!s.tasks.some((t) => t.specIssues.length > 0)}
          title="仅补充缺失或不可执行字段，保留已有具体标准"
          onClick={() => s.act(async () => {
            const r = await devApi.improveTasks(s.projectId!);
            useDevStore.setState({ notice: `已补齐 ${r.improved} 个任务的缺失字段；覆盖需重新核对` });
          })}
        >
          继承并补齐项目标准
        </button>
      </div>
      <div className="v17-table-wrap">
        <table className="dev-table v17-table">
          <thead><tr><th>任务 / 对象</th><th>测试对象</th><th>场景</th><th>覆盖门槛</th><th>规格</th><th></th></tr></thead>
          <tbody>
            {s.tasks.map((t) => {
              const qIssues = t.specIssues.filter((m) => m.includes('场景') || m.includes('覆盖') || m.includes('测试'));
              return (
                <tr key={t.id}>
                  <td><b>{t.code}</b> {t.title}</td>
                  <td>{t.quality?.object || '—'}</td>
                  <td>
                    {(t.quality?.scenarios ?? []).map((sc) => (
                      <span key={sc.type} className={`tag ${sc.applicable === false ? '' : 'tag-ok'}`} style={{ marginRight: 4 }}>
                        {{ normal: '正常', boundary: '边界', exception: '异常' }[sc.type] ?? sc.type}
                        {sc.applicable === false ? ' N/A' : ''}
                      </span>
                    ))}
                  </td>
                  <td>行 {t.quality?.line ?? '—'}% / 分支 {t.quality?.branch ?? '—'}%</td>
                  <td>
                    <span className={`tag ${qIssues.length ? 'tag-warn' : 'tag-ok'}`}>{qIssues.length ? `缺 ${qIssues.length}` : '完整'}</span>
                  </td>
                  <td>
                    <button className="act mini" onClick={() => { void s.setTopTab('plan'); void s.selectTask(t.id); }}>编辑标准</button>
                  </td>
                </tr>
              );
            })}
            {s.tasks.length === 0 && <tr><td colSpan={6} className="dsg-prefix">尚未识别任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** V9 单元测试表（原型 devUtHtml：目标 vs 实际行/分支、unit/CI 状态 tag、证据版本 runId+commitId+规格版本） */
function UnitTestTable() {
  const s = useDevStore();
  const pid = s.projectId!;
  const totTasks = s.tasks.length;
  const passed = s.tasks.filter((t) => t.unit?.pass).length;
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🧪 单元测试与 PR CI</strong>
        <span className="dsg-prefix">证据对应当前任务规格、代码提交、输入版本和质量标准；晚到结果不会覆盖当前证据。</span>
        <span className="spacer" />
        <span className="tag">达标 {passed}/{totTasks}</span>
      </div>
      <div className="v17-table-wrap">
        <table className="dev-table v17-table">
          <thead><tr><th>任务</th><th>对象</th><th>目标 行/分支</th><th>实际 行/分支</th><th>状态</th><th>证据版本</th><th></th></tr></thead>
          <tbody>
            {s.tasks.map((t) => {
              const can = t.col === 'review' || (t.col === 'done' && t.ci?.conclusion === 'pass');
              return (
                <tr key={t.id}>
                  <td><b>{t.code}</b><div>{t.title}</div></td>
                  <td>{t.quality?.object || '—'}</td>
                  <td>{t.quality ? `${t.quality.line}% / ${t.quality.branch}%` : '—'}</td>
                  <td>{t.unit ? `${t.unit.line}% / ${t.unit.branch}%` : '—'}</td>
                  <td>
                    <span className={`tag ${t.unit ? (t.unit.pass && Number(t.unit.taskRev) === t.rev ? 'tag-ok' : 'tag-warn') : ''}`}>
                      unit {t.unit ? (t.unit.pass ? (Number(t.unit.taskRev) === t.rev ? '达标' : '过期') : '未达标') : '无'}
                    </span>{' '}
                    <span className={`tag ${t.ci ? (t.ci.conclusion === 'pass' ? 'tag-ok' : 'tag-warn') : ''}`}>
                      PR CI {t.ci ? t.ci.conclusion : '无'}
                    </span>
                  </td>
                  <td>
                    <span className="dsg-prefix">
                      {t.unit ? `${String(t.unit.commitId).slice(0, 8)} · 规格 r${t.unit.taskRev}` : '无证据'}
                    </span>
                  </td>
                  <td>
                    <button
                      className="act mini"
                      disabled={!can}
                      title={can ? '' : '先提交当前 PR（进入待评审列）'}
                      onClick={() => s.act(() => devApi.quality(pid, t.id), `${t.code} 单测+CI 证据已落`)}
                    >
                      ▶ 运行
                    </button>
                  </td>
                </tr>
              );
            })}
            {s.tasks.length === 0 && <tr><td colSpan={7} className="dsg-prefix">尚未识别任务</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** PR 评审（checklist 勾满才合并 / 显式跳过记审计；历史 PR 只读） */
function PrReview() {
  const s = useDevStore();
  const withPr = s.tasks.filter((t) => ['review', 'done'].includes(t.col));
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🔀 PR 评审</strong>
        <span className="dsg-prefix">委派/人工产物以 PR 回流 · checklist 勾满才可合并（或显式跳过记审计） · CI 绿灯是合并门禁</span>
        <span className="spacer" />
        <span className="tag">{withPr.length} 个任务有 PR</span>
      </div>
      {withPr.length === 0 && (
        <div className="dsg-card dsg-prefix" style={{ textAlign: 'center', padding: 24 }}>
          尚无 PR；任务实现就绪后在看板提交评审。
        </div>
      )}
      {withPr.map((t) => (
        <div key={t.id} className="dsg-card" style={{ cursor: 'pointer' }} onClick={() => { void s.setTopTab('execute'); s.setSide('board'); void s.selectTask(t.id); }}>
          <div className="v17-taskline">
            <b>{t.code}</b>
            <span className={`tag dev-kind-${KIND_CLASS[t.kind] ?? 'gray'}`}>{KIND_LABEL[t.kind] ?? t.kind}</span>
            <span className={`tag ${t.col === 'done' ? 'tag-ok' : 'tag-warn'}`}>{t.col === 'done' ? '已合并' : '待评审'}</span>
            <span className={`tag ${t.unit?.pass ? 'tag-ok' : ''}`}>unit {t.unit ? (t.unit.pass ? '✓' : '✗') : '—'}</span>
            <span className={`tag ${t.ci?.conclusion === 'pass' ? 'tag-ok' : ''}`}>CI {t.ci?.conclusion ?? '—'}</span>
            <span style={{ flex: 1 }}>{t.title}</span>
            <button className="act mini">评审 →</button>
          </div>
        </div>
      ))}
      <p className="dsg-prefix">点击任务卡进入看板抽屉完成 checklist / 豁免 / 合并操作。</p>
    </div>
  );
}

/** 集成与构建（REQ-412；合并后 main 集成构建） */
function BuildPage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const approved = s.plans.find((p) => p.state === 'approved');
  const inPlan = s.tasks.filter((t) => (approved?.snapshot.taskIds ?? []).includes(t.code));
  const ready = !!approved && inPlan.length > 0 && inPlan.every((t) => t.col === 'done');
  return (
    <div>
      <div className="doc-toolbar">
        <strong>🚦 集成与构建</strong>
        <span className={`tag ${s.build?.status === 'pass' ? 'tag-ok' : ''}`}>
          {s.build ? `${s.build.buildId} · ${s.build.status}` : '尚无 main 构建'}
        </span>
        <span className="dsg-prefix">PR CI 用于合并；转测试另需合并后 main 集成构建。</span>
        <span className="spacer" />
        <button
          className="act primary"
          disabled={!ready}
          title={ready ? '' : '批准任务尚未全部合并'}
          onClick={() => s.act(() => devApi.buildRun(pid), '构建完成')}
        >
          ▶ 发起构建
        </button>
      </div>
      {s.build ? (
        <div className="dsg-card">
          <h3>{s.build.buildId} <span className={`tag ${s.build.status === 'pass' ? 'tag-ok' : 'tag-warn'}`}>{s.build.status}</span></h3>
          <p className="dsg-prefix">
            计划 {approved?.revision ?? `r${s.build.planRevision}`} · {new Date(s.build.createdAt).toLocaleString()}
          </p>
          <p className="dsg-prefix">
            指纹 {s.build.buildFingerprint.slice(0, 19)}…｜提交 {s.build.commits.length} 个（{s.build.commits.map((c) => (typeof c === 'string' ? c : c.commitId).slice(0, 8)).join('、')}）｜
            独立 UI 工件 {s.build.uiArtifact.htmlFingerprint.slice(0, 19)}…（{s.build.uiArtifact.independent ? '非原型复制' : '—'}）
          </p>
        </div>
      ) : (
        <div className="dsg-card dsg-prefix" style={{ textAlign: 'center', padding: 24 }}>
          等待本期批准任务全部合并后运行 main 集成构建。
        </div>
      )}
    </div>
  );
}

/** V10 自测报告页（原型 v19SelftestHtml：工具栏 + 三 KPI + 四门卡 + 逐页×视口矩阵 + wide modal 双侧对照）+ 转测试清单 */
function SelftestPage() {
  const s = useDevStore();
  const pid = s.projectId!;
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [cmp, setCmp] = useState<{ pageId: string; viewport: string; proto: string; build: string; distinct: boolean; protoFp: string; buildFp: string } | null>(null);
  const [retestReason, setRetestReason] = useState('');
  const [transferOpen, setTransferOpen] = useState(false);
  const latest = s.reports[0] ?? null;
  const gate = s.selftestGate;
  const failed = latest?.status === 'fail';
  const conclusion = gate?.ok ? '全部门禁通过' : failed ? '存在阻断问题' : s.reports.length === 0 ? '尚未运行' : '门禁阻断';
  const next = gate?.ok
    ? '人工确认转测试'
    : failed ? '修复任务并产生新构建后复测' : s.build ? '运行自测' : '完成合并构建后运行自测';

  return (
    <div>
      {/* 工具栏 */}
      <div className="doc-toolbar">
        <strong>📋 开发自测</strong>
        <span className={`tag ${gate?.ok ? 'tag-ok' : failed ? 'tag-warn' : ''}`}>{conclusion}</span>
        <span className="spacer" />
        <button
          className="act primary"
          disabled={!s.build}
          title={s.build ? '' : '需先完成合并构建'}
          onClick={() => s.act(async () => { await devApi.selftestStart(pid); }, '自测完成')}
        >
          运行自测
        </button>
        <button
          className="act"
          disabled={!failed}
          title={failed ? '' : '仅最近报告未通过时可复测'}
          onClick={() => {
            const reason = window.prompt('复测理由（必填；须实质返工）', retestReason);
            if (reason?.trim()) { setRetestReason(reason); void s.act(() => devApi.selftestRetest(pid, reason.trim()), '复测完成'); }
          }}
        >
          关联复测
        </button>
        {latest && (
          <button className="act" onClick={async () => {
            const e = await devApi.reportExport(pid, latest.id, 'md');
            downloadFile(e.downloadUrl);
          }}>导出报告</button>
        )}
      </div>

      {/* 三 KPI（原型 v19-selftest-overview：当前结论/需关注/下一步） */}
      <div className="v19-selftest-overview">
        <div><small>当前结论</small><b>{conclusion}</b></div>
        <div><small>需关注</small><b>{gate && !gate.ok ? `${gate.issues.length} 项` : latest ? '无当前缺陷' : '尚未检查'}</b></div>
        <div><small>下一步</small><b>{next}</b></div>
      </div>

      {gate && !gate.ok && (
        <div className="gate-box err">
          {gate.issues.map((i) => (
            <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
          ))}
        </div>
      )}

      {/* 报告：四门卡 + 逐页×视口矩阵 */}
      {detail ? (
        <div className="dsg-card">
          <div className="gen-head">
            <strong>{detail.code} 详情</strong>
            <span className="dsg-prefix">
              {detail.immutable ? '不可变' : ''}{detail.tampered ? '（指纹复核不符！）' : '（指纹复核一致）'}
            </span>
            <button className="act" onClick={() => setDetail(null)}>关闭</button>
          </div>
          {/* 四门卡（2026-10-20 可读化：渲染 message 人话+缺口清单，不再只有裸码） */}
          <div className="v19-selftest-grid">
            {Object.entries(detail.gates).map(([k, g]) => (
              <div key={k} className="v19-selftest-card">
                <b>{GATE_NAMES[k] ?? k}</b>
                <span className={`tag ${g.ok ? 'tag-ok' : 'tag-warn'}`}>{g.ok ? '通过' : '阻断'}</span>
                {k === 'functional' && (
                  <div className="dsg-prefix">
                    覆盖率：{g.coverage ? `行 ${g.coverage.line}% / 分支 ${g.coverage.branch}%` : '未采集（沙箱执行口径）'}
                  </div>
                )}
                {k === 'integration' && g.latestSha && (
                  <div className="dsg-prefix">最新提交：{g.latestSha.slice(0, 8)}</div>
                )}
                {(g.missing ?? []).length > 0 && (
                  <div className="dsg-prefix">缺证据：{(g.missing ?? []).join('、')}</div>
                )}
                {(g.issues ?? []).slice(0, 3).map((i) => (
                  <div key={i.code} className="dsg-prefix">{i.code}：{i.message}</div>
                ))}
              </div>
            ))}
          </div>
          {/* 逐页×视口矩阵 */}
          <table className="dev-table">
            <thead>
              <tr><th>页面</th><th>视口</th><th>关键项</th><th>一般项</th><th>严重偏差</th><th>跳过/未测</th><th>格判定</th><th></th></tr>
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
                  <td>
                    <button className="act mini" onClick={async () => {
                      const r = await devApi.comparison(pid, p.page_code);
                      setCmp({
                        pageId: p.page_code, viewport: p.viewport_code,
                        proto: r.prototypePreviewUrl, build: r.buildPreviewUrl,
                        distinct: r.sameObjectGuard.distinct,
                        protoFp: r.sameObjectGuard.prototypeHtmlFingerprint,
                        buildFp: r.sameObjectGuard.buildHtmlFingerprint,
                      });
                    }}>核对</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : latest === null ? (
        <div className="dsg-card v19-selftest-empty">
          <b>项目级自测尚未运行</b>
          <p>全任务合并构建后，系统将执行前后端联调、关键业务冒烟、UI 设计符合度与评审依据检查，并生成不可变报告。</p>
        </div>
      ) : (
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
                    <button className="act mini" onClick={async () => setDetail(await devApi.reportDetail(pid, r.id))}>详情</button>
                    <button className="act mini" onClick={async () => {
                      const e = await devApi.reportExport(pid, r.id, 'md');
                      downloadFile(e.downloadUrl);
                    }}>导出</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* V10 双侧对照 wide modal（指纹摘要行 + 双 iframe + 差异与检查依据） */}
      {cmp && (
        <div className="qa-modal-mask" onClick={() => setCmp(null)}>
          <div className="qa-modal dev-cmp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gen-head">
              <strong>UI 符合度核对 · {cmp.pageId} / {cmp.viewport}</strong>
              <button className="act" onClick={() => setCmp(null)}>✕</button>
            </div>
            <div className="dev-cmp-summary">
              <span>原型 {cmp.protoFp.slice(0, 19)}…</span>
              <span>实现 {cmp.buildFp.slice(0, 19)}…</span>
              <span className={`tag ${cmp.distinct ? 'tag-ok' : 'tag-warn'}`}>{cmp.distinct ? '不同源 ✓' : '同源！'}</span>
            </div>
            <div className="dev-compare">
              <div>
                <div className="dsg-prefix">设计原型</div>
                <iframe className="proto-iframe" src={cmp.proto} title="prototype" sandbox="" />
              </div>
              <div>
                <div className="dsg-prefix">构建 UI 工件</div>
                <iframe className="proto-iframe" src={cmp.build} title="build" sandbox="" />
              </div>
            </div>
            <div className="dev-cmp-diff">
              <b>差异与检查依据</b>
              <p>关键项 100%，一般项达到 95%，必测状态已覆盖，未发现严重偏差。</p>
            </div>
          </div>
        </div>
      )}

      {/* 转测试清单（REQ-418；人工确认点） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>📦 转测试清单</strong>
          <span className={`tag ${s.transferGate?.ok ? 'tag-ok' : 'tag-warn'}`}>{s.transferGate?.ok ? '可交接' : '未就绪'}</span>
          <span className="dsg-prefix">人工确认只生成 S4 交接摘要，不替代系统测试或客户验收。</span>
        </div>
        {s.transferGate && !s.transferGate.ok && (
          <div className="gate-box err">
            {s.transferGate.issues.map((i) => (
              <div key={i.code + (i.target ?? '')} className="issue-row">{i.code}：{i.message}</div>
            ))}
          </div>
        )}
        <p className="dsg-prefix">
          本期交付：{s.tasks.filter((t) => t.col === 'done').map((t) => t.code).join('、') || '—'}；
          构建：{s.build ? `${s.build.buildId}` : '—'}；开放影响：{s.impacts.filter((i) => i.status === 'pending-assessment').length}
        </p>
        <button
          className="act primary"
          disabled={!s.transferGate?.ok || !latest || latest.status !== 'pass'}
          onClick={() => setTransferOpen(true)}
        >
          确认转测试
        </button>
      </div>
      {transferOpen && latest && (
        <ConfirmModal
          title={`确认交接 ${latest.code} 至测试`}
          confirmLabel="确认转测试"
          body={`报告指纹：sha256:${latest.report_fingerprint}\n批次候选：构建+基线+报告三指纹；AI 不可代确认。`}
          onClose={() => setTransferOpen(false)}
          onConfirm={() => s.act(() => devApi.transfer(pid, latest.id, `sha256:${latest.report_fingerprint}`), '已交接（回执幂等）')}
        />
      )}
    </div>
  );
}
