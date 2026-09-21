const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch, url } = require('./browser.cjs');
const { prepareDesign } = require('./design-helpers.cjs');
(async()=>{
  const browser=await launch(); const results=[]; const errors=[];
  async function checkPreparation(page,width){
    const summary=page.getByTestId('preparation-summary');assert.equal(await summary.isVisible(),true,`${width} 准备摘要可见`);
    const clipped=await summary.locator('button').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('.doc-area').getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1;}).map(e=>e.textContent));
    assert.deepEqual(clipped,[],`${width} 准备摘要操作不得被裁切`);
    await page.screenshot({path:path.resolve(__dirname,`../evidence/plan-ready-${width}.png`)});
  }
  try {
    for(const width of [1280,1440,1920]) {
      const page=await browser.newPage({viewport:{width,height:1000}});
      page.on('pageerror',e=>errors.push(e.message));
      await page.clock.install();
      await page.goto(url);
      await prepareDesign(page);
      await page.evaluate(()=>{openProject(S.projects[0].id);go('stage-dev');});
      for(const collapsed of [false,true]) {
        await page.evaluate(x=>{S.chatCollapsed=x;render();},collapsed);
        for(const tab of ['dev-plan','dev-execute','dev-quality','dev-change']) {
          await page.getByTestId(tab).click();
          const sizes=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:innerWidth,areas:[...document.querySelectorAll('.stage-body > .doc-area,.stage-body > .chat-dock')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width};})}));
          assert.ok(sizes.body<=sizes.viewport+1,`${width}/${collapsed}/${tab} 页面横向溢出`);
          for(const a of sizes.areas) assert.ok(a.left>=-1&&a.right<=width+1,`${width}/${collapsed}/${tab} 工作区越界`);
          const clipped=await page.locator('.v17-dev .doc-toolbar button').evaluateAll(elements=>elements.filter(e=>e.getClientRects().length).filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('.doc-toolbar').getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1||r.width<28||r.height<22;}).map(e=>e.textContent));
          assert.deepEqual(clipped,[],`${width}/${collapsed}/${tab} 工具栏按钮被裁切或挤压`);
          results.push({width,collapsed,tab,ok:true});
          if(!collapsed||width===1280) await page.screenshot({path:path.resolve(__dirname,`../evidence/${tab}-${width}-${collapsed?'closed':'open'}.png`)});
        }
      }
      if(width===1440){
        await page.evaluate(()=>{S.chatCollapsed=false;devSetTop('plan');S.dev.planView='division';render();});
        await page.getByTestId('attention-all').click();
        await page.screenshot({path:path.resolve(__dirname,'../evidence/division-1440.png')});
        await page.evaluate(()=>devOpenTask('T-201'));
        await page.screenshot({path:path.resolve(__dirname,'../evidence/task-detail-1440.png')});
        await page.evaluate(()=>{S.dev.selectedTask=null;devCoverageCheck();});
        const hiddenActions=await page.locator('#modal-root .v17-table-wrap button').evaluateAll(elements=>elements.filter(e=>{const r=e.getBoundingClientRect(),p=e.closest('.m-body').getBoundingClientRect();return r.left<p.left-1||r.right>p.right+1;}).map(e=>e.textContent));
        assert.deepEqual(hiddenActions,[],'覆盖核对的逐条操作必须在弹窗内可见');
        await page.screenshot({path:path.resolve(__dirname,'../evidence/coverage-1440.png')});
        await page.evaluate(()=>{closeModal();devSetTop('plan');});
        await page.getByTestId('prepare-plan').click();await page.clock.runFor(1500);
        await checkPreparation(page,width);
        await page.getByTestId('approve-auto').click();await page.clock.runFor(1600);
        await page.evaluate(()=>devSetTop('execute'));
        await page.screenshot({path:path.resolve(__dirname,'../evidence/auto-running-1440.png')});
        await page.getByTestId('auto-pause').click();
        await page.screenshot({path:path.resolve(__dirname,'../evidence/auto-paused-1440.png')});
        await page.goto(url);await prepareDesign(page);await page.evaluate(()=>{openProject('pj1');go('stage-dev');V18_TEST_HOOKS.qualityOutcomeByTask['T-201']='fail';devPreparePlan();});
        await page.clock.runFor(1500);await page.evaluate(()=>devApproveAndRun());await page.clock.runFor(18000);
        await page.evaluate(()=>devSetTop('plan'));await page.getByTestId('attention-human').click();
        assert.equal(await page.evaluate(()=>S.dev.autopilot.run.status),'blocked');
        assert.ok((await page.getByTestId('preparation-summary').boundingBox()).height<180,'已批准摘要默认折叠，给当前关注任务让出空间');
        assert.ok((await page.locator('.v18-attention-row').filter({hasText:'T-201'}).boundingBox()).y<500,'需要处理的任务在页面前部可见');
        await page.screenshot({path:path.resolve(__dirname,'../evidence/needs-human-1440.png')});
        await page.getByTestId('approved-plan-toggle').click();
        assert.equal(await page.getByTestId('proposal-edit-T-210').isEnabled(),true,'已批准提案仍可查看');
        await page.getByTestId('proposal-edit-T-210').click();
        assert.equal(await page.locator('#v18-proposal-goal').isDisabled(),true,'查看已批准提案不可编辑');
        assert.equal(await page.getByTestId('proposal-edit-save').isDisabled(),true,'当前授权期间不能修改批准内容');
        await page.evaluate(()=>closeModal());
      }
      if(width!==1440){
        await page.evaluate(()=>{S.chatCollapsed=false;devSetTop('plan');});
        await page.getByTestId('prepare-plan').click();await page.clock.runFor(1500);
        await checkPreparation(page,width);
      }
      await page.close();
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.resolve(__dirname,'../evidence/visual.json'),JSON.stringify({ok:true,results,errors},null,2));
    console.log(JSON.stringify({ok:true,layouts:results.length,errors}));
  } catch(e){console.error(e.stack);process.exitCode=1;} finally {await browser.close();}
})();
