const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.resolve(__dirname, '../msf-prototype.html'), 'utf8');
const match = html.match(/\/\* v1\.7 pure logic:start \*\/([\s\S]*?)\/\* v1\.7 pure logic:end \*\//);
assert.ok(match, '原型必须提供可独立执行的 v1.7 纯逻辑块');

const names = [
  'devSpecIssues',
  'devCoverageReport',
  'devDependencyPlan',
  'devNormalizeScope',
  'devTaskSourceFingerprint',
  'devPlanGate',
  'devEvidenceValid',
  'devStartGate',
  'devTransferGate'
];
const context = { console };
vm.createContext(context);
vm.runInContext(`${match[1]}\nthis.__logic={${names.join(',')}};`, context, {
  filename: 'msf-prototype.html#v1.7-pure-logic'
});
const logic = context.__logic;

function codes(result) {
  return (result.issues || result).map(issue => typeof issue === 'string' ? issue : issue.code);
}

function task(overrides = {}) {
  return {
    id: 'T-201', title: '门户首页交互', kind: 'frontend', owner: 'codex_cli',
    goal: '交付可访问的门户首页', scope: '首页导航与内容区', boundary: '只修改门户前端，不改服务接口', sourceIds: ['SRC-1'], inputArtifactIds: ['PRD','HLD','UI'],
    work: ['实现导航', '接入内容'], inputs: ['冻结原型'], deliverables: ['portal/home.ts'],
    acceptance: ['键盘可操作', '法英双语正确'],
    quality: { object: '门户首页', scenarios: [
      { type: 'normal', applicable: true, case: '首页正常加载', expected: '首屏完整显示', pass: '无控制台错误' },
      { type: 'boundary', applicable: true, case: '内容为空', expected: '显示明确空态', pass: '页面可继续操作' },
      { type: 'exception', applicable: false, notApplicableReason: '纯静态视图无独立异常分支' }
    ], line: 80, branch: 70 },
    deps: [], writeScopes: ['portal/home.ts'], batch: 1, effort: '2d',
    rev: 1, codeRev: 1, col: 'queue', coverage: [{ itemId: 'SRC-1', status: 'confirmed', catalogRev: 1, taskRev: 1 }],
    ...overrides
  };
}

function catalog() {
  return [
    { id: 'SRC-1', rev: 1, req: 'REQ-001', summary: '首页领导动态', design: { doc: '界面册', anchor: '§1' }, categories: ['frontend'], version: 'PRD-v1/UI-v1' },
    { id: 'SRC-2', rev: 1, req: 'REQ-002', summary: '新闻空状态', design: { doc: '界面册', anchor: '§2' }, categories: ['frontend'], version: 'PRD-v1/UI-v1' },
    { id: 'SRC-3', rev: 1, req: 'REQ-003', summary: '办事接口', design: { doc: '接口册', anchor: '§2' }, categories: ['backend'], version: 'PRD-v1/API-v1' }
  ];
}

function baseDev(tasks = [task()]) {
  return {
    projectId: 'pj1', ownerProjectId: 'pj1',
    baseline: { valid: true, key: 'PRD1-HLD1-D7-P1', finalizationId: 'FIN-1', fingerprint: 'base-fp-1' },
    catalog: catalog().slice(0, 1),
    tasks,
    deferred: {},
    qualityRev: 1,
    impacts: [],
    plan: { revision: 1, submitted: null, approved: null },
    operations: {}
  };
}

function submitAndApprove(dev) {
  const schedule = logic.devDependencyPlan(dev.tasks.filter(t => !t.archived && !t.excluded));
  schedule.batches.forEach((batch, index) => batch.forEach(id => { dev.tasks.find(t => t.id === id).batch = index + 1; }));
  const current = logic.devPlanGate(dev, 'submit');
  assert.equal(current.ok, true, `有效计划应可提交：${codes(current).join(',')}`);
  dev.plan.submitted = { revision: dev.plan.revision, fingerprint: current.fingerprint, baselineKey: dev.baseline.key, taskIds: dev.tasks.map(t => t.id) };
  const approve = logic.devPlanGate(dev, 'approve');
  assert.equal(approve.ok, true, `当前快照应可批准：${codes(approve).join(',')}`);
  dev.plan.approved = { revision: dev.plan.revision, fingerprint: approve.fingerprint, baselineKey: dev.baseline.key, taskIds: dev.tasks.map(t => t.id) };
  return dev;
}

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('空规格能保存草稿，但规格检查列出关键缺口', () => {
  const got = codes(logic.devSpecIssues(task({ title: '', goal: '', work: [], deliverables: [], acceptance: [], quality: { scenarios: [], line: 80, branch: 70 } })));
  for (const code of ['SPEC_TITLE', 'SPEC_GOAL', 'SPEC_WORK', 'SPEC_DELIVERABLE', 'SPEC_ACCEPTANCE', 'SPEC_QUALITY_SCENARIO']) assert.ok(got.includes(code), code);
});

test('覆盖分母来自冻结目录，未关联、待核对和批准延期分别计数', () => {
  const tasks = [
    task({ sourceIds: ['SRC-1', 'SRC-2'], coverage: [{ itemId: 'SRC-1', status: 'confirmed', catalogRev: 1, taskRev: 1 }, { itemId: 'SRC-2', status: 'pending', catalogRev: 1, taskRev: 1 }] })
  ];
  const report = logic.devCoverageReport(catalog(), tasks, { 'SRC-3': { approved: true, reason: '外部接口待确认', actor: '产品负责人', at: '2026-09-06 10:00', catalogRev: 1 } });
  assert.equal(report.total, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(report.counts)), { confirmed: 1, pending: 1, missing: 0, deferred: 1 });
  assert.equal(report.items.find(x => x.id === 'SRC-2').status, 'pending');
  assert.equal(report.items.find(x => x.id === 'SRC-3').status, 'deferred');
});

test('仅挂来源但没有明确确认，不得算已确认覆盖', () => {
  const report = logic.devCoverageReport(catalog().slice(0, 1), [task({ coverage: [{ itemId: 'SRC-1', status: 'pending', catalogRev: 1, taskRev: 1 }] })], {});
  assert.equal(report.counts.confirmed, 0);
  assert.equal(report.counts.pending, 1);
});

test('同一条款的多个承接关联必须全部核对，来源与覆盖映射不得失配', () => {
  const first = task({ id: 'T-A', sourceIds: ['SRC-1'], coverage: [{ itemId: 'SRC-1', status: 'confirmed', catalogRev: 1, taskRev: 1 }] });
  const second = task({ id: 'T-B', sourceIds: ['SRC-1'], coverage: [{ itemId: 'SRC-1', status: 'pending', catalogRev: 1, taskRev: 1 }] });
  assert.equal(logic.devCoverageReport(catalog().slice(0, 1), [first, second], {}).counts.pending, 1);
  const bad = task({ sourceIds: ['SRC-1', 'UNKNOWN'], coverage: [{ itemId: 'SRC-2', status: 'confirmed', catalogRev: 1, taskRev: 1 }] });
  const dev = baseDev([bad]);
  const got = codes(logic.devPlanGate(dev, 'submit'));
  assert.ok(got.includes('SOURCE_UNKNOWN'));
  assert.ok(got.includes('COVERAGE_SOURCE_MISMATCH'));
});

test('依赖检查一次报告不存在、自依赖和循环', () => {
  const tasks = [
    task({ id: 'A', deps: ['MISSING'] }),
    task({ id: 'B', deps: ['B'] }),
    task({ id: 'C', deps: ['D'] }),
    task({ id: 'D', deps: ['C'] })
  ];
  const got = codes(logic.devDependencyPlan(tasks));
  for (const code of ['DEP_MISSING', 'DEP_SELF', 'DEP_CYCLE']) assert.ok(got.includes(code), code);
});

test('拓扑批次遵守前置依赖，并把共享写入范围任务串行化', () => {
  const tasks = [
    task({ id: 'A', deps: [], writeScopes: ['shared/config.ts'] }),
    task({ id: 'B', deps: [], writeScopes: ['shared/config.ts'] }),
    task({ id: 'C', deps: ['A'], writeScopes: ['api/c.ts'] })
  ];
  const plan = logic.devDependencyPlan(tasks);
  assert.equal(plan.ok, true);
  const batchOf = id => plan.batches.findIndex(batch => batch.includes(id));
  assert.notEqual(batchOf('A'), batchOf('B'));
  assert.ok(batchOf('C') > batchOf('A'));
  assert.ok(plan.conflicts.some(x => x.scope === 'shared/config.ts'));
});

test('父子目录写入范围也必须串行，未编排或错误批次不得提交', () => {
  const tasks = [task({ id: 'A', writeScopes: ['apps/portal'] }), task({ id: 'B', writeScopes: ['apps/portal/pages/home'] })];
  const dep = logic.devDependencyPlan(tasks);
  assert.notEqual(dep.batches.findIndex(x => x.includes('A')), dep.batches.findIndex(x => x.includes('B')));
  const dev = baseDev([task({ batch: null })]);
  assert.ok(codes(logic.devPlanGate(dev, 'submit')).includes('SCHEDULE_REQUIRED'));
});

test('写入范围统一大小写和反斜线，并拒绝绝对路径与上跳', () => {
  assert.equal(logic.devNormalizeScope('Apps\\Portal\\Pages/../Home'), '');
  assert.equal(logic.devNormalizeScope('Apps\\Portal\\Pages/Home'), 'apps/portal/pages/home');
  assert.equal(logic.devNormalizeScope('C:\\repo\\app'), '');
  assert.equal(logic.devNormalizeScope('/repo/app'), '');
  const bad = codes(logic.devSpecIssues(task({ writeScopes: ['../outside'] })));
  assert.ok(bad.includes('SPEC_WRITE_SCOPE'));
});

test('分工、承接人、工作量、写入范围和覆盖目标是批准必填规格', () => {
  const got = codes(logic.devSpecIssues(task({ kind: '', owner: '', effort: '', writeScopes: [], quality: { ...task().quality, line: 0, branch: '' } })));
  for (const code of ['SPEC_KIND','SPEC_OWNER','SPEC_EFFORT','SPEC_WRITE_SCOPE','SPEC_QUALITY_THRESHOLD']) assert.ok(got.includes(code), code);
});

test('计划指纹覆盖规格、质量、延期和基线，但不受执行进度与测试结果影响', () => {
  const dev = baseDev();
  const first = logic.devPlanGate(dev, 'submit').fingerprint;
  dev.tasks[0].prog = 72;
  dev.tasks[0].col = 'ing';
  dev.tasks[0].evidence = { unit: { status: 'pass' } };
  assert.equal(logic.devPlanGate(dev, 'submit').fingerprint, first);
  dev.tasks[0].quality.line = 85;
  assert.notEqual(logic.devPlanGate(dev, 'submit').fingerprint, first);
  dev.tasks[0].quality.line = 80;
  dev.baseline.key = 'PRD2-HLD1-D7-P1';
  assert.notEqual(logic.devPlanGate(dev, 'submit').fingerprint, first);
});

test('批准只针对当前提交快照，规格修改和输入失效都会阻断执行', () => {
  const dev = submitAndApprove(baseDev());
  assert.equal(logic.devPlanGate(dev, 'execute').ok, true);
  dev.tasks[0].acceptance.push('首屏三秒内完成');
  dev.tasks[0].rev++;
  assert.ok(codes(logic.devPlanGate(dev, 'execute')).includes('PLAN_CHANGED'));
  dev.tasks[0].acceptance.pop();
  dev.tasks[0].rev--;
  dev.baseline.valid = false;
  assert.ok(codes(logic.devPlanGate(dev, 'execute')).includes('BASELINE_INVALID'));
});

test('实时输入身份与已确认基线不一致时旧批准立即失效', () => {
  const dev = submitAndApprove(baseDev());
  dev.currentBaseline = { valid: false, key: dev.baseline.key, fingerprint: dev.baseline.fingerprint };
  assert.ok(codes(logic.devPlanGate(dev, 'execute')).includes('BASELINE_INVALID'));
  dev.currentBaseline = { valid: true, key: 'new', fingerprint: 'new' };
  assert.ok(codes(logic.devPlanGate(dev, 'execute')).includes('BASELINE_INVALID'));
});

test('质量证据必须匹配任务、规格、代码、质量标准、基线并带模拟运行标识', () => {
  const t = task();
  const ctx = { ownerProjectId: 'pj1', baselineKey: 'B1', sourceFingerprint: 'fp-1', qualityRev: 3, evidenceType: 'unit' };
  const evidence = { evidenceId: 'EV-18', ownerProjectId: 'pj1', taskId: t.id, taskRev: 1, codeRev: 1, qualityRev: 3, baselineKey: 'B1', sourceFingerprint: 'fp-1', evidenceType: 'unit', status: 'pass', runId: 'UT-18', commitId: 'c0ffee', prId: 'PR-18', headRevision: 1, scenarios: ['normal', 'boundary'] };
  t.pr = { id: 'PR-18', commitId: 'c0ffee', headRevision: 1, codeRev: 1 };
  assert.equal(logic.devEvidenceValid(evidence, t, ctx), true);
  assert.equal(logic.devEvidenceValid({ ...evidence, taskRev: 0 }, t, ctx), false);
  assert.equal(logic.devEvidenceValid({ ...evidence, runId: '' }, t, ctx), false);
  assert.equal(logic.devEvidenceValid({ ...evidence, ownerProjectId: 'pj2' }, t, ctx), false);
  assert.equal(logic.devEvidenceValid({ ...evidence, commitId: 'old-head' }, t, ctx), false);
});

test('开始任务同时校验项目身份、批准计划、前置完成和待处置影响', () => {
  const dep = task({ id: 'T-200', col: 'done' });
  const current = task({ id: 'T-201', deps: ['T-200'] });
  const dev = submitAndApprove(baseDev([dep, current]));
  const start = logic.devStartGate(dev, 'T-201', 'pj1');
  assert.equal(start.ok, true, codes(start).join(','));
  dep.col = 'review';
  assert.ok(codes(logic.devStartGate(dev, 'T-201', 'pj1')).includes('DEPENDENCY_NOT_DONE'));
  dep.col = 'done';
  assert.ok(codes(logic.devStartGate(dev, 'T-201', 'pj2')).includes('PROJECT_SCOPE'));
  dev.impacts.push({ task: 'T-201', status: 'pending' });
  assert.ok(codes(logic.devStartGate(dev, 'T-201', 'pj1')).includes('IMPACT_OPEN'));
});

test('开始任务还需等待更早批准批次，并阻止与运行任务写范围冲突', () => {
  const first = task({ id:'T-A', batch:1, col:'queue', writeScopes:['Apps\\Portal'] });
  const second = task({ id:'T-B', batch:2, col:'queue', writeScopes:['apps/portal/pages'] });
  const dev = baseDev([first, second]);
  const gate = logic.devPlanGate(dev,'submit');
  dev.plan.submitted={revision:1,fingerprint:gate.fingerprint,baselineKey:dev.baseline.key,taskIds:['T-A','T-B']};
  dev.plan.approved={...dev.plan.submitted};
  assert.ok(codes(logic.devStartGate(dev,'T-B','pj1')).includes('BATCH_NOT_DONE'));
  first.col='ing'; first.batch=2; second.batch=2;
  const current=logic.devPlanGate(dev,'submit');dev.plan.approved={...dev.plan.approved,fingerprint:current.fingerprint};
  assert.ok(codes(logic.devStartGate(dev,'T-B','pj1')).includes('WRITE_SCOPE_ACTIVE'));
});

test('任务来源指纹不受其他任务标题修改影响', () => {
  const a=task({id:'A'}),b=task({id:'B'}),dev=baseDev([a,b]);
  const before=logic.devTaskSourceFingerprint(dev,a);b.title='其他任务新标题';b.rev++;
  assert.equal(logic.devTaskSourceFingerprint(dev,a),before);
  dev.catalog[0].rev++;
  assert.notEqual(logic.devTaskSourceFingerprint(dev,a),before);
});

test('显式承接变更的新修订经重新批准后可启动返工，但事件关闭前不能转测试', () => {
  const t = task({ rev: 2, codeRev: 2, remediationEvents: ['CHG-1'], coverage: [{ itemId: 'SRC-1', status: 'confirmed', catalogRev: 1, taskRev: 2 }] });
  const dev = baseDev([t]);
  dev.impacts.push({ changeEventId: 'CHG-1', task: t.id, status: 'rework-required' });
  const submit = logic.devPlanGate(dev, 'submit');
  assert.equal(submit.ok, true, codes(submit).join(','));
  dev.plan.submitted = { revision: 1, fingerprint: submit.fingerprint, baselineKey: dev.baseline.key, taskIds: [t.id], changeEventIds: ['CHG-1'], taskRevisions: { [t.id]: 2 } };
  dev.plan.approved = { ...dev.plan.submitted };
  assert.equal(logic.devStartGate(dev, t.id, 'pj1').ok, true);
  assert.ok(codes(logic.devTransferGate(dev, 'pj1')).includes('IMPACT_OPEN'));
});

test('旧异步回调的 token 或快照变化后证据无效', () => {
  const t = task();
  const ctx = { ownerProjectId: 'pj1', baselineKey: 'B1', sourceFingerprint: 'fp-1', qualityRev: 1, evidenceType: 'unit', opToken: 'op-new' };
  const evidence = { evidenceId: 'EV-19', ownerProjectId: 'pj1', taskId: t.id, taskRev: 1, codeRev: 1, qualityRev: 1, baselineKey: 'B1', sourceFingerprint: 'fp-1', evidenceType: 'unit', status: 'pass', runId: 'UT-19', commitId: 'cafe', prId: 'PR-19', headRevision: 1, opToken: 'op-old', scenarios: ['normal', 'boundary'] };
  t.pr = { id: 'PR-19', commitId: 'cafe', headRevision: 1, codeRev: 1 };
  assert.equal(logic.devEvidenceValid(evidence, t, ctx), false);
});

test('转测试要求批准任务全部完成、当前质量与构建证据有效且无开放影响', () => {
  const t = task({ col: 'done' });
  const dev = submitAndApprove(baseDev([t]));
  const sourceFingerprint = logic.devTaskSourceFingerprint(dev, t);
  const common = { evidenceId: 'EV-20', ownerProjectId: 'pj1', taskId: t.id, taskRev: 1, codeRev: 1, qualityRev: 1, baselineKey: dev.baseline.key, sourceFingerprint, status: 'pass', runId: 'RUN-1', commitId: 'abc123', prId: 'PR-20', headRevision: 1 };
  t.evidence = { unit: { ...common, evidenceType: 'unit', line: 84, branch: 73, scenarios: ['normal', 'boundary'] }, ci: { ...common, evidenceId: 'EV-21', evidenceType: 'ci' } };
  t.pr = { id: 'PR-20', status: 'merged', taskRev: 1, codeRev: 1, commitId: 'abc123', headRevision: 1 };
  dev.build = { evidenceId: 'EV-22', ownerProjectId: 'pj1', evidenceType: 'build', status: 'pass', runId: 'BUILD-RUN-1', buildId: 'BUILD-1', baselineKey: dev.baseline.key, sourceFingerprint: logic.devPlanGate(dev, 'execute').fingerprint, commits: ['abc123'], taskRevisions: { [t.id]: 1 } };
  assert.equal(logic.devTransferGate(dev, 'pj1').ok, true);
  t.evidence.unit.branch = 60;
  assert.ok(codes(logic.devTransferGate(dev, 'pj1')).includes('QUALITY_INVALID'));
  t.evidence.unit.branch = 73;
  dev.impacts.push({ task: t.id, status: 'rework' });
  assert.ok(codes(logic.devTransferGate(dev, 'pj1')).includes('IMPACT_OPEN'));
  dev.impacts = [];
  dev.build.commits = ['stale-commit'];
  assert.ok(codes(logic.devTransferGate(dev, 'pj1')).includes('BUILD_INVALID'));
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok ${passed + 1} - ${name}`);
    throw error;
  }
}
console.log(JSON.stringify({ ok: true, tests: passed }));
