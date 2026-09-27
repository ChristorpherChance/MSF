import { useEffect } from 'react';
import { BoardPanel } from './BoardPanel';
import { ChangePanel } from './ChangePanel';
import { PlanPanel } from './PlanPanel';
import { QualityPanel } from './QualityPanel';
import { RepoPanel } from './RepoPanel';
import { StdPanel } from './StdPanel';
import { devApi } from './api';
import { attentionModel, RUN_STATUS_LABEL, useDevStore, type DevTopTab } from './store';
import '../req/req.css';
import '../design/design.css';
import { GateBanner } from '../../ui/GateBanner';
import { StatusChips, type StatusChipItem } from '../../ui/StatusChips';
import './dev.css';

const TABS: Array<{ key: DevTopTab; name: string; testid: string }> = [
  { key: 'plan', name: '任务与计划', testid: 'dev-plan' },
  { key: 'execute', name: '开发执行', testid: 'dev-execute' },
  // 原型 viewDev 最终覆盖口径：顶页签为「开发自测」（LLD-6 §3.5 旧文本「质量验收」已被覆盖，差异已登记）
  { key: 'quality', name: '开发自测', testid: 'dev-quality' },
  { key: 'change', name: '变更管理', testid: 'dev-change' },
];

/** 开发页（LLD-6 §3.5：顶页签 + 左栏工作区两层导航；REQ-401~420） */
export function DevPage() {
  const s = useDevStore();
  useEffect(() => {
    void s.init();
  }, []);
  if (!s.projectId) return <main style={{ padding: 24 }}>加载中…</main>;

  const pendingImpacts = s.impacts.filter((i) => i.status === 'pending-assessment');
  // V2 整页空态：无任务且无计划（尚未识别）
  const empty = s.tasks.length === 0 && s.plans.length === 0;
  const model = attentionModel(s);

  // 瞬时异常/回执收为图标点（与需求/设计页同口径：固定区只留操作，点开看详情）
  const flashItems: StatusChipItem[] = [];
  if (s.error) {
    flashItems.push({ key: 'error', tone: 'err', label: '⛔', detail: s.error });
  }
  if (s.notice) {
    flashItems.push({
      key: 'notice', tone: 'ok', label: '✓',
      detail: (
        <>
          {s.notice}
          <br />
          <button className="act" onClick={s.clearNotice}>知道了</button>
        </>
      ),
    });
  }

  return (
    <main className="proto-wrap">
      <GateBanner stage="dev" />
      {/* V1 顶页签 */}
      <div className="doc-toolbar">
        <strong>开发</strong>
        {TABS.map((t) => (
          <button
            key={t.key}
            data-testid={t.testid}
            className={s.topTab === t.key ? 'act' : ''}
            onClick={() => void s.setTopTab(t.key)}
          >
            {t.name}
            {t.key === 'change' && pendingImpacts.length > 0 && <span className="dev-badge-block">{pendingImpacts.length}</span>}
            {t.key === 'plan' && model.needsHuman.length > 0 && <span className="dev-badge-block">{model.needsHuman.length}</span>}
          </button>
        ))}
        <StatusChips items={flashItems} />
        <span className="dsg-prefix">
          任务 {s.tasks.length} · 完成 {s.tasks.filter((t) => t.col === 'done').length}
          {s.autopilot?.run ? ` · ${s.autopilot.run.runId} ${RUN_STATUS_LABEL[s.autopilot.run.status] ?? s.autopilot.run.status}` : ''}
          {s.loading ? ' · 刷新中…' : ''}
        </span>
      </div>

      {/* V11 变更影响常驻红色横幅（原型 devImpactReminderHtml 权威口径，保留；随门禁横幅之下） */}
      {pendingImpacts.length > 0 && (
        <div className="dsg-card dev-impact-reminder">
          <span>
            ⚠ 有 <b>{pendingImpacts.length}</b> 条变更影响待处置
            （{pendingImpacts.flatMap((i) => i.affected_tasks).slice(0, 6).join('、') || '—'} 受影响）
          </span>
          <button className="act mini" onClick={() => { void s.setTopTab('change'); s.setSide('impacts'); }}>前往处置 →</button>
        </div>
      )}

      {empty ? (
        /* V2 整页空态（原型 devProjectOk 空态口径） */
        <div className="dsg-card v17-empty">
          <div className="ico">🧭</div>
          <h2>此项目尚未建立开发计划</h2>
          <p className="dsg-prefix">
            开发任务属于当前项目的共同设计基线。先在「任务与计划」按基线识别任务池；识别幂等，不会覆盖人工编辑。
          </p>
          <div className="gen-ops" style={{ justifyContent: 'center' }}>
            <button
              className="act primary"
              disabled={!s.baseline?.valid}
              title={s.baseline?.valid ? '' : '需先在设计阶段确认有效基线'}
              onClick={() => s.act(async () => {
                const r = await devApi.identify(s.projectId!, s.baseline!.baselineId, s.baseline!.fingerprint);
                useDevStore.setState({ notice: `识别完成：新增 ${r.identified} 个任务` });
              })}
            >
              ⚡ 按基线识别任务
            </button>
            <button className="act" onClick={() => { void s.setTopTab('change'); s.setSide('baseline'); }}>查看输入基线</button>
          </div>
        </div>
      ) : (
        /* V1 两层导航：左栏工作区 + 内容区 */
        <div className="v17-body">
          <DevSide />
          <div className="doc-area">
            {s.topTab === 'plan' && <PlanPanel />}
            {s.topTab === 'execute' && s.executePage === 'board' && <BoardPanel />}
            {s.topTab === 'execute' && s.executePage === 'repo' && <RepoPanel />}
            {s.topTab === 'execute' && s.executePage === 'std' && <StdPanel />}
            {s.topTab === 'quality' && <QualityPanel />}
            {s.topTab === 'change' && <ChangePanel />}
          </div>
        </div>
      )}
    </main>
  );
}

/** V1 左栏工作区（原型 devSideHtml：plan=注意项分组+搜索、execute=看板/代码仓/规范、quality=五组、change=三组） */
function DevSide() {
  const s = useDevStore();
  const gapCount = s.tasks.filter((t) => t.specIssues.length > 0 || t.coveragePending > 0).length
    + (s.coverage?.uncoveredDesignItems.length ?? 0);
  const pendingImpacts = s.impacts.filter((i) => i.status === 'pending-assessment').length;

  let title = '';
  let rows: Array<{ key: string; name: string; count: string | number }> = [];
  let selected = '';
  if (s.topTab === 'plan') {
    title = '业务模块 / 需求';
    selected = s.planFilter;
    rows = [
      { key: 'all', name: '全部任务', count: s.tasks.length },
      { key: 'gap', name: '仅看缺口', count: gapCount },
    ];
    // L4 REQ 过滤行（原型 devReqRows 口径）：任务 sourceIds 经目录页 reqIds 映射 REQ
    const reqMap = new Map<string, { title: string; pages: Set<string> }>();
    for (const p of s.catalogPages) {
      for (const r of p.reqIds) {
        const e = reqMap.get(r) ?? { title: p.title, pages: new Set<string>() };
        e.pages.add(p.code);
        reqMap.set(r, e);
      }
    }
    for (const [req, info] of [...reqMap.entries()].sort()) {
      const count = s.tasks.filter((t) => t.sourceIds.some((id) => info.pages.has(id))).length;
      rows.push({ key: `req:${req}`, name: `${req} · ${info.title}`, count });
    }
  } else if (s.topTab === 'execute') {
    title = '执行工作区';
    selected = s.executePage;
    rows = [
      { key: 'board', name: '🗂 任务看板', count: '' },
      { key: 'repo', name: '📁 代码仓', count: '' },
      { key: 'std', name: '📏 编码规范', count: '' },
    ];
  } else if (s.topTab === 'quality') {
    title = '开发自测';
    selected = s.qualityPage;
    rows = [
      { key: 'targets', name: '📌 自测结论', count: '' },
      { key: 'unit', name: '🧪 单元测试', count: '' },
      { key: 'pr', name: '🔀 PR 评审', count: '' },
      { key: 'build', name: '🚦 集成与构建', count: '' },
      { key: 'selftest', name: '📋 项目自测报告', count: '' },
    ];
  } else {
    title = '变更工作区';
    selected = s.changePage;
    rows = [
      { key: 'impacts', name: '🌊 影响处置', count: pendingImpacts },
      { key: 'baseline', name: '🔐 输入基线', count: s.baseline ? (s.baseline.valid ? '✓' : '!') : '—' },
      { key: 'history', name: '🕒 计划与审计', count: s.plans.length },
    ];
  }

  const latest = s.plans[0];
  return (
    <div className="panel-left v17-side">
      <div className="pl-head">{title}</div>
      {s.topTab === 'plan' && (
        <div className="v17-side-search">
          <input
            value={s.planQuery}
            placeholder="搜索任务 / 来源"
            onChange={(e) => s.setPlanQuery(e.target.value)}
          />
        </div>
      )}
      <div className="filelist">
        {rows.map((r) => (
          <div
            key={r.key}
            className={`file-row${selected === r.key ? ' sel' : ''}`}
            onClick={() => s.setSide(r.key)}
          >
            <span className="fname">{r.name}</span>
            {r.count !== '' && <span className="tag">{r.count}</span>}
          </div>
        ))}
      </div>
      <div className="left-foot">
        单一任务池：前端 / 后端 / 公共 / 联调共享规格、依赖、质量与版本。<br />
        {latest
          ? `当前计划修订 ${latest.revision} · ${{ submitted: '待批准', approved: '已批准', invalidated: '已失效' }[latest.state]}${latest.state === 'invalidated' ? ' · 需重提交' : ''}`
          : '尚无计划修订'}
      </div>
    </div>
  );
}
