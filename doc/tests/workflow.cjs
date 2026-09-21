const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, url } = require('./browser.cjs');
const { prepareDesign, refreshDesignBaseline } = require('./design-helpers.cjs');

// 使用产品公开动作和浏览器虚拟时钟；不直接伪造进度、PR、测试或构建通过。
(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [], checks = [];
  let exerciseRace = true;
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.clock.install();
  async function boot() {
    await page.goto(url);
    await prepareDesign(page);
    await page.evaluate(() => { openProject('pj1'); go('stage-dev'); devSetExecutionMode('manual'); devToggleManualTools(true); });
  }
  async function approve() {
    await page.evaluate(() => { S.dev.selectedTask = null; devSetTop('plan'); });
    await page.getByTestId('coverage-check').click();
    assert.match(await page.locator('body').innerText(), /SRC-003/);
    await page.getByTestId('coverage-confirm-all').click();
    await page.getByTestId('schedule').click();
    const gate = await page.evaluate(() => devPlanGate(S.dev, 'submit'));
    assert.equal(gate.ok, true, JSON.stringify(gate.issues));
    await page.getByTestId('plan-submit').click();
    await page.getByTestId('plan-approve').click();
    assert.equal(await page.evaluate(() => devPlanGate(S.dev, 'execute').ok), true);
  }
  async function quality(id) {
    await page.evaluate(id => runTaskUt(id), id);
    await page.clock.runFor(1100);
  }
  async function finishTask(id) {
    await page.evaluate(id => devStart(id), id);
    assert.equal(await page.evaluate(id => devTaskById(id).col, id), 'ing', id + ' 开始');
    await page.clock.runFor(12000);
    assert.equal(await page.evaluate(id => devTaskById(id).prog, id), 100, id + ' 模拟实现就绪');
    await page.evaluate(id => devSubmitReview(id), id);
    assert.equal(await page.evaluate(id => devTaskById(id).col, id), 'review', id + ' 评审');
    if (exerciseRace) {
      await page.evaluate(id => runTaskUt(id), id);
      const previous = await page.evaluate(id => S.dev.operations['quality:' + id].runId, id);
      await page.clock.runFor(300);
      await page.evaluate(id => runTaskUt(id), id);
      const latest = await page.evaluate(id => S.dev.operations['quality:' + id].runId, id);
      assert.notEqual(latest, previous, '人工显式重跑应创建新运行，以验证旧回调淘汰');
      await page.clock.runFor(1100);
      assert.equal(await page.evaluate(id => devTaskById(id).evidence.unit?.runId, id), latest, '旧回调不得淘汰后启动的有效运行');
      checks.push('连续运行时旧回调不改写新运行');
      exerciseRace = false;
    }
    await quality(id);
    if (!await page.evaluate(id => devAutomatedGate(devTaskById(id)).ok, id)) await quality(id);
    assert.equal(await page.evaluate(id => devAutomatedGate(devTaskById(id)).ok, id), true, id + ' 自动质量门禁');
    await page.evaluate(id => {
      const p = devTaskById(id).pr;
      p.checks.forEach((_, index) => prToggleCheck(p.id, index));
      prMerge(p.id);
    }, id);
    assert.equal(await page.evaluate(id => devTaskById(id).col, id), 'done', id + ' 合并');
  }
  try {
    await boot();
    assert.equal(await page.getByTestId('plan-approve').isDisabled(), true);
    assert.equal(await page.evaluate(() => devPlanGate(S.dev, 'submit').coverage.counts.missing), 1);
    const oldCount = await page.evaluate(() => S.dev.tasks.length);
    await page.getByTestId('identify').click();
    await page.clock.runFor(800);
    await page.getByRole('button', { name: '批量采纳', exact: true }).click();
    assert.equal(await page.evaluate(() => S.dev.tasks.length), oldCount + 1);
    await page.evaluate(() => devAdoptAll());
    assert.equal(await page.evaluate(() => S.dev.tasks.length), oldCount + 1, '重复采纳幂等');
    await page.getByRole('button', { name: '完善任务', exact: true }).click();
    checks.push('初始真实缺口、识别采纳、补质量、重复采纳幂等');

    // 只改标题，所有详细质量字段必须原样保留。
    const beforeQuality = await page.evaluate(() => JSON.stringify(devTaskById('T-201').quality));
    await page.evaluate(() => devOpenTask('T-201'));
    const title = page.locator('.v17-detail-grid > div').filter({ has: page.locator('label', { hasText: /^任务名称$/ }) }).locator('input');
    await title.fill('首页领导动态前端 · 人工可执行任务');
    await page.evaluate(() => render());
    assert.equal(await title.inputValue(), '首页领导动态前端 · 人工可执行任务', '重绘保留未保存草稿');
    await page.getByRole('button', { name: '保存规格', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.stringify(devTaskById('T-201').quality)), beforeQuality, '标题编辑不得破坏测试用例/预期/通过条件');
    checks.push('详情草稿保留、质量规格无损往返');

    await approve();
    const fingerprint = await page.evaluate(() => devPlanGate(S.dev, 'execute').fingerprint);
    const snapshot = await page.evaluate(() => JSON.stringify(S.dev.plan.approved));
    const order = await page.evaluate(() => devDependencyPlan(devActiveTasks()).batches.flat());
    const first = order[0];
    const blocked = await page.evaluate(() => devActiveTasks().find(t => t.deps.length)?.id);
    if (blocked) {
      await page.evaluate(id => devStart(id), blocked);
      assert.equal(await page.evaluate(id => devTaskById(id).col, blocked), 'queue');
    }
    checks.push('提交批准、未完成前置任务阻断后继');

    await page.evaluate(id => devStart(id), first);
    await page.clock.runFor(950);
    await page.evaluate(id => devPauseTask(id), first);
    const paused = await page.evaluate(id => devTaskById(id).prog, first);
    await page.clock.runFor(2000);
    assert.equal(await page.evaluate(id => devTaskById(id).prog, first), paused);
    await page.evaluate(() => { openProject('pj2'); go('stage-dev'); });
    assert.match(await page.locator('body').innerText(), /暂无|尚未|空|未建立/);
    await page.evaluate(id => devStart(id), first);
    await page.clock.runFor(1500);
    assert.equal(await page.evaluate(id => devTaskById(id).prog, first), paused, '其他项目不能写入');
    await page.evaluate(() => { openProject('pj1'); go('stage-dev'); });
    await page.clock.runFor(1500);
    assert.equal(await page.evaluate(id => devTaskById(id).prog, first), paused, '主动暂停不因重进项目恢复');
    await page.evaluate(id => devStopTask(id), first);
    checks.push('暂停保持、项目隔离、晚回调不串写');

    for (const id of order) await finishTask(id);
    assert.equal(await page.evaluate(() => devPlanGate(S.dev, 'execute').fingerprint), fingerprint, '执行事实不改变批准内容');
    assert.equal(await page.evaluate(() => JSON.stringify(S.dev.plan.approved)), snapshot, '批准快照不可变');
    assert.equal(await page.evaluate(() => devTransferGate(S.dev, 'pj1').ok), false, '未构建不能转测');
    // 开发证据来自上面的公开执行链；这里只替换受控的上游快照，检验在途构建。
    await page.evaluate(() => runIntegrationBuild());
    const sourceSeq = await page.evaluate(() => {
      const seq=S.design.docs.mod._finalizationSeq,saved=devAudit;
      S.design.docs.mod._finalizationSeq++;devAudit=()=>{throw Error('BUILD_OBSERVE_FAILURE');};
      try{impactTrigger('mod');}catch(e){}finally{devAudit=saved;}return seq;
    });
    assert.equal(await page.evaluate(()=>devPlanGate(S.dev,'execute').ok),false);
    await page.clock.runFor(1200);
    assert.equal(await page.evaluate(()=>S.dev.build?.status==='pass'),false,'实时输入已失效的在途构建不能通过');
    // 恢复本组隔离夹具的上游身份，随后重新调用正式构建动作。
    await page.evaluate(seq=>{S.design.docs.mod._finalizationSeq=seq;},sourceSeq);
    checks.push('上游观察审计失败后在途构建拒绝提交通过结果');
    await page.evaluate(() => runIntegrationBuild());
    await page.clock.runFor(1200);
    assert.equal(await page.evaluate(() => devTransferGate(S.dev, 'pj1').ok), false, '构建通过仍须开发自测报告');
    await page.evaluate(() => devStartSelfTest());
    await page.clock.runFor(1800);
    assert.equal(await page.evaluate(() => devTransferGate(S.dev, 'pj1').ok), true);
    const counterexamples = await page.evaluate(() => {
      function verify(change) {
        const d = JSON.parse(JSON.stringify(S.dev));
        const t = d.tasks.find(t => !t.archived && !t.excluded);
        change(d,t);
        return !devTransferGate(d, 'pj1').ok;
      }
      return {
        '旧PR head':verify((d,t)=>t.pr.headRevision++),
        '旧PR commit':verify((d,t)=>t.pr.commitId+='-new'),
        '缺适用异常场景':verify((d,t)=>{t.evidence.unit.scenarios=t.evidence.unit.scenarios.filter(x=>x!=='exception');}),
        '构建commit集合错配':verify(d=>d.build.commits=[]),
        '质量阈值未达标':verify((d,t)=>{t.evidence.unit.line=t.quality.line-1;}),
        '伪造勾选不能代替CI':verify((d,t)=>{t.evidence.ci.status='fail';t.pr.checks.forEach(x=>x.checked=true);}),
        '所有延期不准空交付':verify(d=>{d.tasks.forEach(t=>t.excluded=true);}),
      };
    });
    Object.entries(counterexamples).forEach(([label,blocked])=>assert.equal(blocked,true,label));
    checks.push('转测反例：PR身份、适用场景、构建提交集、阈值、CI、空计划');
    await page.evaluate(() => devTransferToTest());
    assert.equal(await page.evaluate(() => S.dev.transfer.delivered.length), order.length);
    const receipt=await page.evaluate(()=>({json:JSON.stringify(S.dev.transfer),baseline:S.dev.baseline.key,evidence:devTaskById(S.dev.plan.approved.taskIds[0]).evidence.unit.evidenceId,build:S.dev.build.buildId}));
    assert.ok(receipt.json.includes(receipt.baseline)&&receipt.json.includes(receipt.evidence),'交接收据保存当时基线与质量证据');
    assert.ok((await page.locator('body').innerText()).includes(receipt.build),'S4 可见交接构建摘要');
    checks.push('全部任务真实模拟执行→当前单测/CI→评审合并→main构建→S4交接');

    // 新上游定稿，逐任务分别处置，返工重新批准后可以实施。
    await page.evaluate(() => { go('stage-dev'); doFinalDesign('mod'); });
    await page.clock.runFor(700);
    assert.equal(await page.evaluate(() => devPlanGate(S.dev, 'execute').ok), false, '同版本再定稿须失效');
    await refreshDesignBaseline(page);
    const impacts = await page.evaluate(() => S.dev.impacts.filter(i => i.status === 'pending-assessment').map(i => ({ id: i.dispositionId, task: i.task })));
    assert.ok(impacts.length > 1, '同一变更按真实来源映射命中多个任务');
    const rework = impacts[0];
    for (const item of impacts) {
      await page.evaluate(({id, rework}) => devSetImpact(id, rework ? 'rework' : 'unaffected'), {id:item.id,rework:item.id===rework.id});
      await page.locator('#v17-impact-reason').fill(item.id === rework.id ? '按新界面定稿调整，并重新验收' : '该任务未引用变动内容，已核对');
      await page.getByRole('button', {name:'记录处置', exact:true}).click();
    }
    await page.evaluate(() => devConfirmBaseline());
    await approve();
    assert.equal(await page.evaluate(id => devStartGate(S.dev,id,'pj1').ok,rework.task),true,'重新批准允许返工');
    await finishTask(rework.task);
    assert.equal(await page.evaluate(id=>S.dev.impacts.find(i=>i.dispositionId===id).status,rework.id),'remediation-complete');
    for(const id of order) await quality(id);
    await page.evaluate(() => runIntegrationBuild());
    await page.clock.runFor(1200);
    await page.evaluate(() => devStartSelfTest());
    await page.clock.runFor(1800);
    assert.equal(await page.evaluate(() => devTransferGate(S.dev,'pj1').ok),true,'返工后其它已合并任务可重新验证并恢复交接');
    checks.push('同版本再定稿失效、逐任务处置、重新批准返工与重新验证闭环');

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.resolve(__dirname, '../evidence/workflow.json'), JSON.stringify({ok:true,checks,errors},null,2));
    console.log(JSON.stringify({ok:true,checks,errors}));
  } catch (e) {
    console.error(e.stack);
    fs.writeFileSync(path.resolve(__dirname, '../evidence/workflow-failure.json'), JSON.stringify({ok:false,checks,errors,error:e.stack},null,2));
    process.exitCode=1;
  } finally { await browser.close(); }
})();
