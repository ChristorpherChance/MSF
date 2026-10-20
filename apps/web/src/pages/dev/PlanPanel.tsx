import { useMemo, useState } from 'react';
import { ConfirmModal } from '../../ui/ConfirmModal';
import { devApi, type DevScenario, type DevTask, type DevTaskDetail, type PlanItem, type PlanSuggestion } from './api';
import { attentionModel, asgIcon, KIND_CLASS, KIND_LABEL, useDevStore } from './store';

const PLAN_STATE_LABEL: Record<string, string> = {
  draft: '准备中', submitted: '待批准', approved: '已批准', invalidated: '已失效 · 需重提交',
};

/** 运行未终态（原型 devPlanHtml activeRun 口径：此时只准查看执行或重新准备） */
const RUN_ACTIVE = ['running', 'paused', 'blocked', 'taken-over', 'awaiting-transfer'];

/** 计划页（V3 命令条+批准摘要、V4 注意项页签、V5 手动操作条+三视图、V6 任务详情表单；L4b 准备两级流程+proposals 卡） */
export function PlanPanel() {
  const s = useDevStore();
  const [approveOpen, setApproveOpen] = useState(false);
  const [approveRunOpen, setApproveRunOpen] = useState(false);
  const [reidentifyOpen, setReidentifyOpen] = useState(false);
  const model = useMemo(() => attentionModel(s), [s.tasks, s.coverage, s.baseline, s.impacts, s.autopilot]);
  if (s.selTaskId && s.taskDetail) return <TaskDetailForm />;

  const draft = s.plans.find((p) => p.state === 'draft');
  const approved = s.plans.find((p) => p.state === 'approved');
  const submitted = s.plans.find((p) => p.state === 'submitted');
  const run = s.autopilot?.run ?? null;
  const activeRun = !!run && RUN_ACTIVE.includes(run.status);
  const pendingSug = draft?.suggestions.filter((g) => g.state === 'pending').length ?? 0;
  const gapCount = (s.coverage?.uncoveredDesignItems.length ?? 0);
  const specGap = s.tasks.filter((t) => t.specIssues.length > 0).length;
  const covPending = s.tasks.filter((t) => t.coveragePending > 0).length;
  const needSchedule = s.tasks.some((t) => t.batchNo === null);
  const rows = s.attentionView === 'ai' ? model.aiActionable : model.needsHuman;

  // V5 三视图过滤（左栏 planFilter + 搜索；L4 req:REQ-xxx 行经目录页 reqIds 映射）
  const reqPages = s.planFilter.startsWith('req:')
    ? new Set(s.catalogPages.filter((p) => p.reqIds.includes(s.planFilter.slice(4))).map((p) => p.code))
    : null;
  const filtered = s.tasks.filter((t) => {
    if (s.planFilter === 'gap' && t.specIssues.length === 0 && t.coveragePending === 0) return false;
    if (reqPages && !t.sourceIds.some((id) => reqPages.has(id))) return false;
    const q = s.planQuery.trim().toLowerCase();
    if (q && !`${t.code} ${t.title} ${t.kind} ${t.sourceIds.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div>
      {/* V3 .v18-command 命令条：按状态切换主按钮 + 展开手动操作 */}
      <div className="v18-command">
        <div className="v18-command-row">
          <div className="v18-command-copy">
            <b>开发计划</b>
            <span>AI 识别遗漏、补齐有出处的规格、核对覆盖并编排依赖；准备不会启动开发。</span>
          </div>
          {draft ? (
            <>
              {/* L4b 两级流程（原型 devPlanHtml runAction 口径）：重新准备 / 批准并自动执行 */}
              <button
                className="act"
                data-testid="prepare-plan"
                disabled={!s.baseline?.valid || s.acting}
                title={s.baseline?.valid ? '重新生成准备快照（旧草稿修订失效）' : '需先在设计阶段确认有效基线'}
                onClick={() => s.act(async () => {
                  const r = await devApi.preparePlan(s.projectId!);
                  useDevStore.setState({ notice: `已重新准备 ${r.revision}：建议 ${r.suggestions} 项` });
                })}
              >
                ✦ 重新准备
              </button>
              <button
                className="act primary"
                data-testid="approve-auto"
                disabled={pendingSug > 0 || activeRun}
                title={
                  pendingSug > 0 ? `${pendingSug} 条建议待处置（采用/不采用后可批准）`
                    : activeRun ? '存在未终态运行' : `指纹 ${draft.fingerprint}`
                }
                onClick={() => setApproveRunOpen(true)}
              >
                批准并自动执行
              </button>
            </>
          ) : !approved && !submitted ? (
            <button
              className="act primary"
              data-testid="prepare-plan"
              disabled={!s.baseline?.valid || s.acting}
              title={s.baseline?.valid ? '' : '需先在设计阶段确认有效基线'}
              onClick={() => s.act(async () => {
                const r = await devApi.preparePlan(s.projectId!);
                useDevStore.setState({ notice: `准备完成 ${r.revision}：建议 ${r.suggestions} 项，请核对具体差异与自动范围` });
              })}
            >
              ✦ 准备计划
            </button>
          ) : null}
          {/* 已批准且运行终态后可重新准备（原型 used → 重新准备 口径；submitted 在批时先走人工批准路径） */}
          {!draft && approved && !activeRun && (
            <button
              className="act"
              data-testid="prepare-plan"
              disabled={!s.baseline?.valid || s.acting}
              title={s.baseline?.valid ? '重新生成准备快照（不改动已批准计划）' : '需先在设计阶段确认有效基线'}
              onClick={() => s.act(async () => {
                const r = await devApi.preparePlan(s.projectId!);
                useDevStore.setState({ notice: `已重新准备 ${r.revision}：建议 ${r.suggestions} 项` });
              })}
            >
              ✦ 重新准备
            </button>
          )}
          {!draft && submitted && (
            <button
              className="act primary"
              title={`指纹 ${submitted.fingerprint}`}
              onClick={() => setApproveOpen(true)}
            >
              批准计划
            </button>
          )}
          {!draft && approved && (
            <button className="act" onClick={() => void s.setTopTab('execute')}>查看开发执行</button>
          )}
          <button className="act" onClick={s.toggleManualTools}>
            {s.manualToolsOpen ? '收起' : '展开'}手动操作
          </button>
        </div>
      </div>
      {approveRunOpen && draft && (
        <ConfirmModal
          title={`批准并自动执行 ${draft.revision}`}
          confirmLabel="批准并自动执行"
          body={`指纹：${draft.fingerprint}\n应用已采用建议 → 批准计划 → 签发授权（转测试永人工）→ 启动运行；AI 不可代批。`}
          onClose={() => setApproveRunOpen(false)}
          onConfirm={() => s.act(async () => {
            await devApi.approvePlan(s.projectId!, draft.revision, draft.fingerprint);
            await devApi.autopilotStart(s.projectId!, draft.revision, draft.fingerprint);
          }, `${draft.revision} 已批准，自动执行开始`)}
        />
      )}
      {approveOpen && submitted && (
        <ConfirmModal
          title={`批准 ${submitted.revision}`}
          confirmLabel="批准计划"
          body={`指纹：${submitted.fingerprint}\n批准后版本固定，AI 不可代批。`}
          onClose={() => setApproveOpen(false)}
          onConfirm={() => s.act(() => devApi.approvePlan(s.projectId!, submitted.revision, submitted.fingerprint), `${submitted.revision} 已批准`)}
        />
      )}

      {/* L4b 准备卡（原型 v18PreparationSummaryHtml）；手动路径的批准摘要保持原样 */}
      {draft ? <PreparationCard plan={draft} /> : (approved ?? submitted) && <PrepSummary />}

      {/* V4 .v18-attention-tabs 注意项页签 */}
      <div className="v18-attention-tabs">
        <button className={s.attentionView === 'human' ? 'act on' : 'act'} onClick={() => s.setAttentionView('human')}>
          需你处理 <span className="tag">{model.needsHuman.length}</span>
        </button>
        <button className={s.attentionView === 'ai' ? 'act on' : 'act'} onClick={() => s.setAttentionView('ai')}>
          AI 可处理 <span className="tag">{model.aiActionable.length}</span>
        </button>
        <button className={s.attentionView === 'all' ? 'act on' : 'act'} onClick={() => s.setAttentionView('all')}>
          全部任务 <span className="tag">{s.tasks.length} 任务{gapCount ? ` ＋ 待补 ${gapCount}` : ''}</span>
        </button>
      </div>

      {/* V5 手动操作条（识别任务/核对覆盖/完善任务/编排计划/提交版本/批准计划） */}
      {s.manualToolsOpen && (
        <div className="v18-manual">
          <div className="doc-toolbar">
            <strong>手动操作</strong>
            <span className="dsg-prefix">原有人工路径保持可达</span>
            <button
              className={`act${gapCount > 0 ? ' primary' : ''}`}
              disabled={!s.baseline?.valid || s.acting}
              onClick={() => s.act(async () => {
                const r = await devApi.identify(s.projectId!, s.baseline!.baselineId, s.baseline!.fingerprint);
                useDevStore.setState({ notice: `识别完成：新增 ${r.identified} 个任务` });
              })}
            >
              ⚡ 识别任务
            </button>
            <button
              className="act"
              disabled={!s.baseline?.valid || s.tasks.length === 0 || s.acting}
              title="交付物口径升级后的正式升级通道：归档全部存量任务并失效在途计划，按当前口径全量重派生（重派生后须重新提交/批准计划）"
              onClick={() => setReidentifyOpen(true)}
            >
              ♻ 重新识别任务池
            </button>
            {reidentifyOpen && (
              <ConfirmModal
                title="重新识别任务池"
                body={`将把当前 ${s.tasks.length} 个存量任务全部归档（留痕可查）并失效在途计划，按最新交付物口径（页面=public/pages/<页码>.html 原型接线版）重新派生任务。重派生后须重新编排、提交并批准计划。确认继续？`}
                confirmLabel="确认重识别"
                onClose={() => setReidentifyOpen(false)}
                onConfirm={() => s.act(async () => {
                  const r = await devApi.reidentify(s.projectId!, s.baseline!.baselineId, s.baseline!.fingerprint);
                  useDevStore.setState({ notice: `重识别完成：归档 ${r.archived} 个旧任务，新派生 ${r.identified} 个任务` });
                })}
              />
            )}
            <button
              className={`act${gapCount === 0 && covPending > 0 ? ' primary' : ''}`}
              disabled={s.tasks.length === 0 || s.acting}
              onClick={() => s.act(async () => {
                const targets = s.tasks.filter((x) => x.coveragePending > 0);
                for (const t of targets) {
                  await devApi.confirmCoverage(s.projectId!, t.id);
                }
                // U-029：核对完成给出结论数字（原来只静默刷新）
                useDevStore.setState({
                  notice: targets.length === 0
                    ? '覆盖核对完成：全部任务覆盖均已确认'
                    : `覆盖核对完成：本轮确认 ${targets.length} 个任务`,
                });
              })}
            >
              核对覆盖
            </button>
            <button
              className="act"
              disabled={specGap === 0 || s.acting}
              title={specGap === 0 ? '当前任务规格已齐全' : '仅补充缺失或不可执行字段，保留已有具体标准'}
              onClick={() => s.act(async () => {
                const r = await devApi.improveTasks(s.projectId!);
                useDevStore.setState({ notice: `已补齐 ${r.improved} 个任务的缺失字段；覆盖需重新核对` });
              })}
            >
              完善任务
            </button>
            <button
              className={`act${gapCount === 0 && covPending === 0 && specGap === 0 && needSchedule ? ' primary' : ''}`}
              disabled={s.tasks.length === 0 || s.acting}
              onClick={() => s.act(async () => {
                const r = await devApi.schedulePlan(s.projectId!);
                useDevStore.setState({
                  notice: `已生成 ${r.batches} 个执行批次${r.conflicts.length ? `，${r.conflicts.length} 处写入冲突已串行` : ''}`,
                });
              }, undefined)}
            >
              编排计划
            </button>
            <SubmitButton />
            {submitted && (
              <button
                className="act"
                title={`指纹 ${submitted.fingerprint}`}
                onClick={() => setApproveOpen(true)}
              >
                批准计划
              </button>
            )}
          </div>
        </div>
      )}

      {s.attentionView === 'all' ? (
        <>
          {/* V5 计划三视图 .v17-viewseg */}
          <div className="doc-toolbar">
            <div className="v17-viewseg">
              {([['business', '业务功能'], ['division', '前后端分工'], ['order', '执行顺序']] as const).map(([k, name]) => (
                <button key={k} className={s.planView === k ? 'act on' : 'act'} onClick={() => s.setPlanView(k)}>{name}</button>
              ))}
            </div>
            <span className="dsg-prefix">三种视图共用统一任务清单，修改会同步到看板和质量页面。</span>
            <NewTaskButton />
            <PlanHistoryButton />
          </div>
          <PlanTable tasks={filtered} />
        </>
      ) : (
        /* V4 注意项行列表 */
        <div className="v18-attention-list">
          {rows.length === 0 && (
            <div className="dsg-card dsg-prefix" style={{ textAlign: 'center', padding: 24 }}>
              {s.attentionView === 'human' ? '无需你处理。AI 可继续准备已有明确依据的常规项。' : '当前没有这类任务。'}
            </div>
          )}
          {rows.map((row) => (
            <div
              key={row.key}
              className="v18-attention-row"
              onClick={() => { if (row.taskId) void s.selectTask(row.taskId); else { s.setAttentionView('all'); s.setPlanFilter('gap'); } }}
            >
              <div>
                <b>{row.taskId ? s.tasks.find((t) => t.id === row.taskId)?.code : row.sourceId}</b>
                <div className="dsg-prefix">{row.title}</div>
              </div>
              <div className="v18-attention-reasons">
                {row.reasons.map((r, i) => <div key={i}>• {r}</div>)}
              </div>
              <div className="gen-ops">
                <span className={`tag ${row.severity === 'blocking' ? 'tag-warn' : ''}`}>
                  {row.kind === 'gap' ? '来源缺口' : row.assigneeType === 'human' ? '人工' : 'AI'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** L4b 准备卡（原型 v18PreparationSummaryHtml：六指标 + 范围 tag + proposals 网格 + 四态 tag + 明细 details） */
function PreparationCard({ plan }: { plan: PlanItem }) {
  const s = useDevStore();
  const [editSg, setEditSg] = useState<PlanSuggestion | null>(null);
  const taskIds = plan.snapshot.taskIds;
  const inPlan = s.tasks.filter((t) => taskIds.includes(t.code));
  const suggestions = plan.suggestions ?? [];
  const active = suggestions.filter((g) => g.state !== 'rejected');
  const pending = suggestions.filter((g) => g.state === 'pending');
  const sources = new Set([...inPlan.flatMap((t) => t.sourceIds), ...active.flatMap((g) => g.sourceRefs)]);
  const frontBatches = new Set(inPlan.filter((t) => t.kind === 'frontend').map((t) => t.batchNo).filter((b) => b !== null)).size;
  const backBatches = new Set(inPlan.filter((t) => t.kind === 'backend').map((t) => t.batchNo).filter((b) => b !== null)).size;
  // 待决问题（U-023 口径统一）：任务级并集 = 有未处置建议的任务 ∪ 有规格缺口的任务（同任务不双计）+ 覆盖缺口。
  // 不得以"已有 patch 建议"豁免缺口计数——采用建议 ≠ 缺口已补齐（缺口随修订内容实时重算），
  // 否则批准前（建议豁免后 0）与批准后（实时 specIssues 1）跳变，与 PrepSummary 口径保持连续。
  const flagged = new Set<string>([
    ...pending.map((g) => g.targetCode),
    ...inPlan.filter((t) => t.specIssues.length > 0).map((t) => t.code),
  ]);
  const issues = flagged.size + (plan.coverageReport.ok ? 0 : plan.coverageReport.uncoveredDesignItems.length);
  const metrics: Array<[string, string]> = [
    ['任务范围', `${taskIds.length} 项`],
    ['具体建议', `${suggestions.length} 项`],
    ['来源覆盖', `${sources.size} 条`],
    ['前端批次', `${frontBatches} 批`],
    ['后端批次', `${backBatches} 批`],
    ['质量目标', '逐任务保留'],
  ];
  const decide = (g: PlanSuggestion, decision: 'accepted' | 'rejected', task?: Record<string, unknown>) =>
    s.act(
      () => devApi.resolveSuggestion(s.projectId!, plan.revision, plan.fingerprint, g.id, decision, task),
      decision === 'rejected' ? `${g.targetCode} 建议已不采用` : `${g.targetCode} 建议已采用`,
    );
  const DECISION_LABEL: Record<string, string> = { pending: '待处理', accepted: '采用', rejected: '不采用' };

  return (
    <section className="v18-prep" data-testid="preparation-summary" data-revision={plan.revision} data-fingerprint={plan.fingerprint}>
      <div className="v18-prep-head">
        <b>本次批准摘要</b>
        <span className="tag">{plan.revision}</span>
        <span className="dsg-prefix">基于当前已确认输入与计划版本 · 准备不会启动开发</span>
        <span className="spacer" />
        <span className={`tag ${issues ? 'tag-warn' : 'tag-ok'}`}>{issues ? `问题 ${issues}` : '无待决问题'}</span>
      </div>
      <div className="v18-prep-metrics">
        {metrics.map(([k, v]) => (
          <div key={k} className="v18-prep-metric"><b>{v}</b><span>{k}</span></div>
        ))}
      </div>
      <div className="v18-prep-scope">
        <span className="tag">自动：开发 → 单测 / CI → 独立 AI 评审 → 合并 → 集成构建</span>
        <span className="tag tag-warn">人工：确认转测试</span>
        <span className="dsg-prefix">不会自动延期、降低质量门槛或勾选人工 checklist。</span>
      </div>

      {/* proposals 网格（原型 v18-proposals；批准前不会写入任务池） */}
      {suggestions.length > 0 && (
        <div className="v18-proposals">
          {suggestions.map((g) => (
            <article key={g.id} className="v18-proposal">
              <div className="v18-proposal-head">
                <b>{g.targetCode}</b>
                <span className="tag">{g.kind === 'create-task' ? '新建任务' : '修订规格'}</span>
                <span className={`tag ${g.state === 'rejected' ? '' : g.state === 'pending' ? 'tag-warn' : 'tag-ok'}`}>
                  {g.state === 'accepted' && g.edited ? '已修订' : DECISION_LABEL[g.state]}
                </span>
                <span className="spacer" />
                {g.state === 'pending' && (
                  <button className="sm" onClick={() => void decide(g, 'accepted')}>采用</button>
                )}
                <button className="sm" data-testid={`proposal-edit-${g.targetCode}`} onClick={() => setEditSg(g)}>查看 / 修订</button>
                <button
                  className="sm"
                  data-testid={`proposal-reject-${g.targetCode}`}
                  disabled={g.state === 'rejected'}
                  onClick={() => void decide(g, 'rejected')}
                >
                  不采用
                </button>
              </div>
              <div className="v18-proposal-diff">
                {g.kind === 'create-task'
                  ? `＋ ${String(g.task.title ?? g.targetCode)}（${KIND_LABEL[String(g.task.kind)] ?? String(g.task.kind ?? '')} · 来源 ${g.sourceRefs.join('、') || '—'}）`
                  : `△ ${g.reason}`}
                {/* U-022：已修订建议的缺口文案为修订前快照，明示防误读 */}
                {g.state === 'accepted' && g.edited && (
                  <span className="dsg-prefix">（缺口为修订前快照；修订内容随批准并入任务池后重算）</span>
                )}
              </div>
              <div className="dsg-prefix" style={{ marginTop: 6 }}>
                依据：{g.sourceRefs.join('；') || '—'}{g.kind === 'create-task' ? ` · ${g.reason}` : ''}
              </div>
            </article>
          ))}
        </div>
      )}

      <details>
        <summary>查看覆盖、依赖批次和问题明细</summary>
        <div className="v18-prep-detail">
          <div><b>覆盖：</b>{plan.coverageReport.ok ? '双向完整（含已采用建议投影）' : `缺口 ${plan.coverageReport.uncoveredDesignItems.join('、')}`}</div>
          <div>
            <b>批次：</b>
            {Object.entries(
              inPlan.reduce<Record<string, string[]>>((m, t) => {
                const k = t.batchNo === null ? '待编排' : `B${t.batchNo}`;
                (m[k] ??= []).push(t.code);
                return m;
              }, {}),
            ).map(([b, codes]) => `${b} ${codes.join('、')}`).join('；') || '—'}
          </div>
          <div><b>质量：</b>每个任务保留当前行/分支门槛及正常、边界、异常场景</div>
          <div>
            <b>问题：</b>
            {issues
              ? [
                  ...pending.map((g) => `${g.targetCode} 建议待处置`),
                  ...inPlan
                    .filter((t) => t.specIssues.length > 0 && !pending.some((g) => g.targetCode === t.code))
                    .map((t) => `${t.code} ${t.specIssues[0]}`),
                  ...plan.coverageReport.uncoveredDesignItems.map((c) => `${c} 无承接任务`),
                ].join('；')
              : '无'}
          </div>
        </div>
      </details>

      {editSg && (
        <ProposalModal
          sg={editSg}
          onClose={() => setEditSg(null)}
          onSave={(task) => { setEditSg(null); void decide(editSg, 'accepted', task); }}
        />
      )}
    </section>
  );
}

/** L4b 建议查看/修订（原型 devPreparationProposalModal：目标/交付物/三场景通过条件；保存=追加新准备修订，旧修订只读） */
function ProposalModal({ sg, onClose, onSave }: {
  sg: PlanSuggestion; onClose: () => void; onSave: (task: Record<string, unknown>) => void;
}) {
  const q = sg.task.quality ?? null;
  const scPass = (type: string) => q?.scenarios?.find((x) => x.type === type)?.pass ?? '';
  const [goal, setGoal] = useState(String(sg.task.goal ?? ''));
  const [deliverables, setDeliverables] = useState(
    (sg.task.deliverables ?? []).map((x) => String(x)).join('\n'));
  // U-021：建议点名的缺口字段（版本化来源/输入与依赖）必须可填——否则修订流于形式
  const [sourceIds, setSourceIds] = useState(
    ((sg.task.sourceIds ?? sg.task.source_ids ?? []) as unknown[]).map((x) => String(x)).join('\n'));
  const [inputs, setInputs] = useState(
    ((sg.task.inputs ?? []) as unknown[]).map((x) => String(x)).join('\n'));
  const [normal, setNormal] = useState(scPass('normal'));
  const [boundary, setBoundary] = useState(scPass('boundary'));
  const [exception, setException] = useState(scPass('exception'));

  const save = () => {
    const passes: Record<string, string> = { normal, boundary, exception };
    const scenarios = (q?.scenarios ?? []).map((x) =>
      x.type in passes && x.applicable !== false ? { ...x, pass: passes[x.type]! } : x);
    onSave({
      goal,
      deliverables: deliverables.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      sourceIds: sourceIds.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      inputs: inputs.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
      ...(q ? { quality: { ...q, scenarios } } : {}),
    });
  };

  return (
    <div className="qa-modal-mask" onClick={onClose}>
      <div className="qa-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="gen-head">
          <strong>{sg.targetCode} · 查看并修订建议</strong>
          <button className="act" onClick={onClose}>✕</button>
        </div>
        {sg.reason && <p className="pop-tip">建议缺口：{sg.reason}（下表字段逐条补齐后保存）</p>}
        <div className="form-row"><label>目标</label></div>
        <textarea rows={3} style={{ width: '100%' }} value={goal} onChange={(e) => setGoal(e.target.value)} />
        <div className="form-row"><label>版本化来源（每行一条：目录条目/REQ 编号或技术决策出处）</label></div>
        <textarea rows={2} style={{ width: '100%' }} value={sourceIds} onChange={(e) => setSourceIds(e.target.value)} />
        <div className="form-row"><label>输入与依赖（每行一条）</label></div>
        <textarea rows={2} style={{ width: '100%' }} value={inputs} onChange={(e) => setInputs(e.target.value)} />
        <div className="form-row"><label>交付物（每行一项）</label></div>
        <textarea rows={3} style={{ width: '100%' }} value={deliverables} onChange={(e) => setDeliverables(e.target.value)} />
        {([['正常', normal, setNormal], ['边界', boundary, setBoundary], ['异常', exception, setException]] as const).map(([name, val, setter]) => (
          <div key={name} className="form-row">
            <label>{name}场景通过条件</label>
            <input value={val} onChange={(e) => setter(e.target.value)} />
          </div>
        ))}
        <p className="dsg-prefix">保存会追加新的准备修订，旧修订保持只读；批准前不会写入任务池。</p>
        <div className="gen-ops">
          <button className="act" onClick={onClose}>取消</button>
          <button className="act primary" data-testid="proposal-edit-save" onClick={save}>保存修订</button>
        </div>
      </div>
    </div>
  );
}

/** V3 .v18-prep 批准摘要：六指标格 + 自动/人工范围 tag + 计划陈旧标记 + 问题徽标 */
function PrepSummary() {
  const s = useDevStore();
  const plan = s.plans.find((p) => p.state === 'approved') ?? s.plans.find((p) => p.state === 'submitted');
  if (!plan) return null;
  const taskIds = plan.snapshot.taskIds;
  const inPlan = s.tasks.filter((t) => taskIds.includes(t.code));
  const front = inPlan.filter((t) => t.kind === 'frontend');
  const back = inPlan.filter((t) => t.kind === 'backend');
  const frontBatches = new Set(front.map((t) => t.batchNo).filter((b) => b !== null)).size;
  const backBatches = new Set(back.map((t) => t.batchNo).filter((b) => b !== null)).size;
  const sources = new Set(inPlan.flatMap((t) => t.sourceIds)).size;
  // stale：计划快照任务集 ≠ 当前任务集，或覆盖报告有缺口，或基线失效
  const stale = s.baseline === null || !s.baseline.valid
    || taskIds.length !== s.tasks.length
    || !plan.coverageReport.ok;
  const issues = inPlan.filter((t) => t.specIssues.length > 0).length + (plan.coverageReport.ok ? 0 : plan.coverageReport.uncoveredDesignItems.length);
  const metrics: Array<[string, string]> = [
    ['任务范围', `${taskIds.length} 项`],
    ['具体建议', `${inPlan.filter((t) => t.ownerType !== 'human').length} 项自动`],
    ['来源覆盖', `${sources} 条`],
    ['前端批次', `${frontBatches} 批`],
    ['后端批次', `${backBatches} 批`],
    ['质量目标', '逐任务保留'],
  ];
  return (
    <section className="v18-prep" data-testid="preparation-summary" data-revision={plan.revision} data-fingerprint={plan.fingerprint}>
      <div className="v18-prep-head">
        <b>本次批准摘要</b>
        <span className="tag">{plan.revision}</span>
        <span className="dsg-prefix">基于当前已确认输入与计划版本</span>
        <span className="spacer" />
        {stale && <span className="tag tag-warn">已过期 · 需重提交</span>}
        <span className={`tag ${issues ? 'tag-warn' : 'tag-ok'}`}>{issues ? `问题 ${issues}` : '无待决问题'}</span>
      </div>
      <div className="v18-prep-metrics">
        {metrics.map(([k, v]) => (
          <div key={k} className="v18-prep-metric"><b>{v}</b><span>{k}</span></div>
        ))}
      </div>
      <div className="v18-prep-scope">
        <span className="tag">自动：开发 → 单测 / CI → 独立 AI 评审 → 合并 → 集成构建</span>
        <span className="tag tag-warn">人工：确认转测试</span>
        <span className="dsg-prefix">不会自动延期、降低质量门槛或勾选人工 checklist。</span>
      </div>
      <details>
        <summary>查看覆盖、依赖批次和问题明细</summary>
        <div className="v18-prep-detail">
          <div><b>覆盖：</b>{plan.coverageReport.ok ? '双向完整' : `缺口 ${plan.coverageReport.uncoveredDesignItems.join('、')}`}</div>
          <div>
            <b>批次：</b>
            {Object.entries(
              inPlan.reduce<Record<string, string[]>>((m, t) => {
                const k = t.batchNo === null ? '待编排' : `B${t.batchNo}`;
                (m[k] ??= []).push(t.code);
                return m;
              }, {}),
            ).map(([b, codes]) => `${b} ${codes.join('、')}`).join('；') || '—'}
          </div>
          <div><b>质量：</b>每个任务保留当前行/分支门槛及正常、边界、异常场景</div>
          <div>
            <b>问题：</b>
            {issues
              ? inPlan.filter((t) => t.specIssues.length > 0).map((t) => `${t.code} ${t.specIssues[0]}`).join('；')
              : '无'}
          </div>
        </div>
      </details>
    </section>
  );
}

/** 提交版本按钮（全任务集；门禁未过由服务端 GATE_BLOCKED 回执呈现） */
function SubmitButton() {
  const s = useDevStore();
  const [note, setNote] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // U-030：已有批准计划时提交新修订需确认后果（原批准转失效、需重新批准）
  const approved = s.plans.find((p) => p.state === 'approved');
  const doSubmit = () =>
    s.act(() => devApi.submitPlan(s.projectId!, s.tasks.map((t) => t.code), note || undefined), '计划已提交（待批准）');
  return (
    <>
      <input
        className="v18-note"
        placeholder="计划备注（可选）"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="act"
        disabled={s.tasks.length === 0 || s.acting}
        onClick={() => (approved ? setConfirmOpen(true) : doSubmit())}
      >
        提交版本
      </button>
      {confirmOpen && approved && (
        <ConfirmModal
          title="提交新计划版本"
          confirmLabel="确认提交"
          body={`当前已有批准计划 ${approved.revision}。\n提交将生成新修订（待批准），原批准计划随即转为「已失效」——autopilot 与新开始动作将以新修订为准，须重新批准。`}
          onClose={() => setConfirmOpen(false)}
          onConfirm={doSubmit}
        />
      )}
    </>
  );
}

/** ＋ 人工新建（原型 newDevTask：草稿入池，再在中央详情补齐规格） */
function NewTaskButton() {
  const s = useDevStore();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('frontend');
  return (
    <>
      <button className="act" onClick={() => setOpen(true)}>＋ 人工新建</button>
      {open && (
        <div className="qa-modal-mask" onClick={() => setOpen(false)}>
          <div className="qa-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gen-head"><strong>人工新建任务</strong></div>
            <div className="form-row">
              <label>任务名称</label>
              <input placeholder="清楚描述可交付结果" value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="form-row">
              <label>分工</label>
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <p className="dsg-prefix">新任务先以草稿进入单一任务池，再在中央详情补齐规格；不会自动获得覆盖确认。</p>
            <div className="gen-ops">
              <button className="act" onClick={() => setOpen(false)}>取消</button>
              <button
                className="act primary"
                disabled={!title.trim()}
                onClick={() => s.act(async () => {
                  const r = await devApi.createTask(s.projectId!, title.trim(), kind);
                  setOpen(false); setTitle('');
                  await s.selectTask(r.id);
                }, '草稿已创建，请补齐规格')}
              >
                创建草稿
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 版本历史（只读） */
function PlanHistoryButton() {
  const s = useDevStore();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="act" onClick={() => setOpen(true)}>版本历史</button>
      {open && (
        <div className="qa-modal-mask" onClick={() => setOpen(false)}>
          <div className="qa-modal" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
            <div className="gen-head"><strong>计划版本历史（只读）</strong><button className="act" onClick={() => setOpen(false)}>✕</button></div>
            {s.plans.length === 0 && <p className="dsg-prefix">尚无提交版本</p>}
            {s.plans.map((p) => (
              <div key={p.planId} className="v17-history">
                <b>{p.revision}</b>{' '}
                <span className={`tag ${p.state === 'approved' ? 'tag-ok' : p.state === 'submitted' ? 'tag-warn' : ''}`}>
                  {PLAN_STATE_LABEL[p.state] ?? p.state}
                </span>
                <div className="dsg-prefix">
                  任务 {p.snapshot.taskIds.length} · 基线 {p.baselineFingerprint.slice(0, 19)}…
                  {p.approvedBy ? ` · ${p.approvedBy} 批准 ${new Date(p.approvedAt!).toLocaleString()}` : ''}
                  {p.invalidatedReason ? ` · 失效：${p.invalidatedReason}` : ''}
                </div>
              </div>
            ))}
            <p className="dsg-prefix">历史版本保存为只读副本，不会覆盖当前任务执行状态，也不能从历史直接恢复批准。</p>
          </div>
        </div>
      )}
    </>
  );
}

/** V5 计划表三视图（business 业务功能 / division 前后端分工 / order 执行顺序） */
function PlanTable({ tasks }: { tasks: DevTask[] }) {
  const s = useDevStore();
  if (s.planView === 'business') {
    return (
      <div className="v17-table-wrap">
        <table className="dev-table v17-plan-table">
          <thead><tr><th>任务</th><th>分工</th><th>覆盖</th><th>前置依赖</th><th>批次</th><th>工作量</th><th>规格 / 就绪</th></tr></thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className={s.selTaskId === t.id ? 'pick' : ''} onClick={() => void s.selectTask(t.id)}>
                <td><b>{t.code}</b><div>{t.title}</div></td>
                <td><span className={`tag dev-kind-${KIND_CLASS[t.kind] ?? 'gray'}`}>{KIND_LABEL[t.kind] ?? t.kind}</span></td>
                <td>{t.sourceIds.join('、') || '—'}<div className="dsg-prefix">已确认 {t.coverageTotal - t.coveragePending}/{t.coverageTotal}</div></td>
                <td>{t.deps.join('、') || '—'}</td>
                <td>{t.batchNo ? `B${t.batchNo}` : '待编排'}</td>
                <td>{t.effort || '—'}</td>
                <td>
                  <span className={`tag ${t.specIssues.length ? 'tag-warn' : 'tag-ok'}`}>
                    {t.specIssues.length ? `待完善 ${t.specIssues.length}` : '规格齐全'}
                  </span>
                </td>
              </tr>
            ))}
            {tasks.length === 0 && <tr><td colSpan={7} className="dsg-prefix">尚未识别任务</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }
  if (s.planView === 'division') {
    const sorted = [...tasks].sort((a, b) => a.kind.localeCompare(b.kind) || a.code.localeCompare(b.code));
    return (
      <div className="v17-table-wrap">
        <table className="dev-table v17-plan-table">
          <thead><tr><th>分工</th><th>任务</th><th>承接</th><th>写入范围</th><th>协作关系</th></tr></thead>
          <tbody>
            {sorted.map((t) => (
              <tr key={t.id} className={s.selTaskId === t.id ? 'pick' : ''} onClick={() => void s.selectTask(t.id)}>
                <td><span className={`tag dev-kind-${KIND_CLASS[t.kind] ?? 'gray'}`}>{KIND_LABEL[t.kind] ?? t.kind}</span></td>
                <td><b>{t.code}</b> {t.title}</td>
                <td>{asgIcon(t.ownerType)} {t.owner}</td>
                <td>{t.writeScopes.join('、') || '—'}</td>
                <td>{t.deps.join('、') || '可独立开始'}</td>
              </tr>
            ))}
            {sorted.length === 0 && <tr><td colSpan={5} className="dsg-prefix">尚未识别任务</td></tr>}
          </tbody>
        </table>
      </div>
    );
  }
  const sorted = [...tasks].sort((a, b) => (a.batchNo ?? 99) - (b.batchNo ?? 99) || a.code.localeCompare(b.code));
  return (
    <div className="v17-table-wrap">
      <table className="dev-table v17-plan-table">
        <thead><tr><th>顺序</th><th>分工</th><th>任务</th><th>前置依赖</th><th>写入范围</th></tr></thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id} className={s.selTaskId === t.id ? 'pick' : ''} onClick={() => void s.selectTask(t.id)}>
              <td><b>{t.batchNo ? `批次 ${t.batchNo}` : '待编排'}</b></td>
              <td><span className={`tag dev-kind-${KIND_CLASS[t.kind] ?? 'gray'}`}>{KIND_LABEL[t.kind] ?? t.kind}</span></td>
              <td><b>{t.code}</b> {t.title}</td>
              <td>{t.deps.join('、') || '无'}</td>
              <td>{t.writeScopes.join('、') || '—'}</td>
            </tr>
          ))}
          {sorted.length === 0 && <tr><td colSpan={5} className="dsg-prefix">尚未识别任务</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/** V6 任务详情：中央可编辑表单（devCloneTaskDraft 全字段；排队中可编辑，保存 rev++ 覆盖重置 pending） */
function TaskDetailForm() {
  const s = useDevStore();
  const t = s.taskDetail!;
  const editable = t.col === 'queue';
  const [draft, setDraft] = useState(() => cloneDraft(t));
  const [reworkReason, setReworkReason] = useState('');
  const [reworkOpen, setReworkOpen] = useState(false);
  const issues = t.specIssuesFull ?? [];

  const set = (k: keyof Draft, v: string) => setDraft({ ...draft, [k]: v });
  const setSc = (type: string, k: string, v: string | boolean) =>
    setDraft({
      ...draft,
      scenarios: draft.scenarios.map((x) => (x.type === type ? { ...x, [k]: v } : x)),
    });

  const save = () =>
    s.act(async () => {
      const linesOf = (v: string) => v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      await devApi.saveTask(s.projectId!, t.id, {
        title: draft.title, kind: draft.kind, owner: draft.owner, asgType: draft.asgType, effort: draft.effort,
        goal: draft.goal, scope: draft.scope, boundary: draft.boundary,
        sourceIds: linesOf(draft.sourceIds), work: linesOf(draft.work), inputs: linesOf(draft.inputs),
        deliverables: linesOf(draft.deliverables),
        acceptance: linesOf(draft.acceptance).map((item) => ({ item, pass: false })),
        deps: linesOf(draft.deps), writeScopes: linesOf(draft.writeScopes),
        quality: {
          object: draft.qualityObject,
          scenarios: draft.scenarios,
          line: Number(draft.line), branch: Number(draft.branch),
        },
      });
      await s.selectTask(t.id);
    }, `已保存为规格版本 r${t.rev + 1}；覆盖需重新核对`);

  return (
    <div>
      <div className="doc-toolbar">
        <button className="act" onClick={() => void s.selectTask(null)}>← 返回计划</button>
        <strong>{t.code} · 规格详情</strong>
        <span className={`tag ${issues.length ? 'tag-warn' : 'tag-ok'}`}>{issues.length ? `待完善 ${issues.length}` : '规格齐全'}</span>
        <span className="tag">规格 r{t.rev}</span>
        <span className="spacer" />
        {!editable && <span className="dsg-prefix">运行/评审/合并中任务只读；返工后可编辑</span>}
        <button
          className="act primary"
          disabled={!editable}
          title={editable ? '' : '运行中、评审中或已合并任务须先返工'}
          onClick={() => void save()}
        >
          保存规格
        </button>
      </div>

      {/* 返工（非排队任务；F02-5 task.rework：理由必填、计划失效） */}
      {!editable && (
        <div className="dsg-card">
          <div className="form-row">
            <input placeholder="返工理由（必填；保留历史提交与合并事实）" value={reworkReason} onChange={(e) => setReworkReason(e.target.value)} />
            <button
              className="act"
              disabled={!reworkReason.trim()}
              onClick={() => setReworkOpen(true)}
            >
              返工后编辑
            </button>
          </div>
        </div>
      )}
      {reworkOpen && (
        <ConfirmModal
          title={`${t.code} 返工`}
          confirmLabel="确认返工"
          body={'rev/codeRev +1 并回排队、已批准计划失效。\n返工理由：' + reworkReason.trim()}
          onClose={() => setReworkOpen(false)}
          onConfirm={() => s.act(async () => { await devApi.transition(s.projectId!, t.id, 'rework', reworkReason); await s.selectTask(t.id); }, '已返回排队，可编辑新规格')}
        />
      )}

      <div className="dsg-card v17-detail">
        <fieldset disabled={!editable} className="v17-fieldset">
          <div className="v17-detail-grid">
            <Field label="任务名称"><input value={draft.title} onChange={(e) => set('title', e.target.value)} /></Field>
            <Field label="前后端分工">
              <select value={draft.kind} onChange={(e) => set('kind', e.target.value)}>
                {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            <Field label="目标" wide><textarea rows={3} value={draft.goal} onChange={(e) => set('goal', e.target.value)} /></Field>
            <Field label="范围"><textarea rows={2} value={draft.scope} onChange={(e) => set('scope', e.target.value)} /></Field>
            <Field label="执行边界"><textarea rows={2} value={draft.boundary} onChange={(e) => set('boundary', e.target.value)} /></Field>
            <Field label="来源条目 / 技术决策（每行一项）"><textarea rows={2} value={draft.sourceIds} onChange={(e) => set('sourceIds', e.target.value)} /></Field>
            <Field label="承接 AI / 人工">
              <input value={draft.owner} onChange={(e) => set('owner', e.target.value)} />
              <select value={draft.asgType} onChange={(e) => set('asgType', e.target.value)} style={{ marginTop: 4 }}>
                <option value="agent">🤖 AI 承接</option>
                <option value="human">👤 人工承接</option>
              </select>
            </Field>
            <Field label="具体工作（每行一项）"><textarea rows={2} value={draft.work} onChange={(e) => set('work', e.target.value)} /></Field>
            <Field label="输入 / 依赖说明（每行一项）"><textarea rows={2} value={draft.inputs} onChange={(e) => set('inputs', e.target.value)} /></Field>
            <Field label="交付物（每行一项）"><textarea rows={2} value={draft.deliverables} onChange={(e) => set('deliverables', e.target.value)} /></Field>
            <Field label="验收条件（每行一项）"><textarea rows={2} value={draft.acceptance} onChange={(e) => set('acceptance', e.target.value)} /></Field>
            <Field label="前置任务编号（每行一项）"><textarea rows={2} value={draft.deps} onChange={(e) => set('deps', e.target.value)} /></Field>
            <Field label="代码写入范围（每行一项）"><textarea rows={2} value={draft.writeScopes} onChange={(e) => set('writeScopes', e.target.value)} /></Field>
            <Field label="工作量"><input value={draft.effort} onChange={(e) => set('effort', e.target.value)} /></Field>
            <Field label="测试对象"><input value={draft.qualityObject} onChange={(e) => set('qualityObject', e.target.value)} /></Field>
            {(['normal', 'boundary', 'exception'] as const).map((type) => {
              const sc = draft.scenarios.find((x) => x.type === type)!;
              const name = { normal: '正常', boundary: '边界', exception: '异常' }[type];
              return (
                <ScenarioFields
                  key={type}
                  name={name}
                  sc={sc}
                  readonly={type === 'normal'}
                  onApplicable={(v) => setSc(type, 'applicable', v)}
                  onSet={(k, v) => setSc(type, k, v)}
                />
              );
            })}
            <Field label="行覆盖率门槛 %"><input value={draft.line} onChange={(e) => set('line', e.target.value)} /></Field>
            <Field label="分支覆盖率门槛 %"><input value={draft.branch} onChange={(e) => set('branch', e.target.value)} /></Field>
          </div>
        </fieldset>
        <p className="dsg-prefix" style={{ marginTop: 12 }}>
          编辑中的内容保留在本页会话；点击保存后生成新的任务规格版本，相关覆盖需重新核对。
        </p>
        {issues.length > 0 && (
          <div className="gate-box err" style={{ marginTop: 10 }}>
            当前问题：{issues.map((x) => x.message).join('；')}
          </div>
        )}
      </div>

      {/* 输入工件与覆盖核对（只读事实） */}
      <div className="dsg-card">
        <div className="gen-head">
          <strong>输入工件与覆盖</strong>
          <span className="dsg-prefix">保存规格后覆盖自动重置为待核对</span>
        </div>
        {t.inputArtifacts.length > 0 && (
          <p className="dsg-prefix">
            输入工件：{t.inputArtifacts.map((a) => `${a.doc_kind}${a.version_id ? `@${a.version_id.slice(0, 8)}` : ''}`).join('、')}
          </p>
        )}
        {t.coverage.length > 0 ? (
          <div className="form-row" style={{ flexWrap: 'wrap' }}>
            {t.coverage.map((c) => (
              <span key={c.item_id} className={`tag ${c.status === 'confirmed' && c.task_rev === t.rev ? 'tag-ok' : 'tag-warn'}`}>
                {c.item_id} {c.status === 'confirmed' && c.task_rev === t.rev ? '✓' : '待核对'}
              </span>
            ))}
            <button
              className="act mini"
              onClick={() => s.act(async () => { await devApi.confirmCoverage(s.projectId!, t.id); await s.selectTask(t.id); }, '覆盖已确认')}
            >
              全部确认
            </button>
          </div>
        ) : (
          <p className="dsg-prefix">无来源关联（人工草稿需在上方补来源条目）</p>
        )}
      </div>
    </div>
  );
}

interface Draft {
  title: string; kind: string; owner: string; asgType: string; effort: string;
  goal: string; scope: string; boundary: string;
  sourceIds: string; work: string; inputs: string; deliverables: string; acceptance: string;
  deps: string; writeScopes: string; qualityObject: string; line: string; branch: string;
  scenarios: DevScenario[];
}

/** 原型 devCloneTaskDraft 同口径：行数组 ↔ 每行一项文本；三场景就位 */
function cloneDraft(t: DevTaskDetail): Draft {
  const q = t.quality ?? { object: '', scenarios: [], line: 80, branch: 70 };
  const find = (type: string): DevScenario =>
    q.scenarios.find((x) => x.type === type) ?? { type, applicable: type === 'normal', case: '', expected: '', pass: '', notApplicableReason: '' };
  const lines = (v: unknown[]) => v.map((x) => (typeof x === 'object' && x !== null ? String((x as Record<string, unknown>).item ?? '') : String(x))).join('\n');
  return {
    title: t.title, kind: t.kind, owner: t.owner, asgType: t.ownerType, effort: t.effort ?? '',
    goal: t.goal, scope: t.scope, boundary: t.boundary,
    sourceIds: t.sourceIds.join('\n'), work: lines(t.work), inputs: lines(t.inputs),
    deliverables: lines(t.deliverables), acceptance: lines(t.acceptance),
    deps: t.deps.join('\n'), writeScopes: t.writeScopes.join('\n'),
    qualityObject: q.object, line: String(q.line), branch: String(q.branch),
    scenarios: [find('normal'), find('boundary'), find('exception')].map((x) => ({ ...x })),
  };
}

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={wide ? 'wide' : ''}><label>{label}</label>{children}</div>;
}

/** 场景字段组（正常必填；边界/异常可不适用但须理由） */
function ScenarioFields({ name, sc, readonly, onApplicable, onSet }: {
  name: string; sc: DevScenario; readonly: boolean;
  onApplicable: (v: boolean) => void; onSet: (k: string, v: string) => void;
}) {
  const applicable = sc.applicable !== false;
  return (
    <>
      {!readonly && (
        <Field label={`${name}场景适用性`}>
          <select value={String(applicable)} onChange={(e) => onApplicable(e.target.value === 'true')}>
            <option value="true">适用</option>
            <option value="false">不适用（须说明理由）</option>
          </select>
        </Field>
      )}
      {applicable ? (
        <>
          <Field label={`${name}场景 · 用例`}><textarea rows={2} value={sc.case ?? ''} onChange={(e) => onSet('case', e.target.value)} /></Field>
          <Field label={`${name}场景 · 预期`}><textarea rows={2} value={sc.expected ?? ''} onChange={(e) => onSet('expected', e.target.value)} /></Field>
          <Field label={`${name}场景 · 通过条件`}><textarea rows={2} value={sc.pass ?? ''} onChange={(e) => onSet('pass', e.target.value)} /></Field>
        </>
      ) : (
        <Field label={`${name}场景 · 不适用理由`}><textarea rows={2} value={sc.notApplicableReason ?? ''} onChange={(e) => onSet('notApplicableReason', e.target.value)} /></Field>
      )}
    </>
  );
}
