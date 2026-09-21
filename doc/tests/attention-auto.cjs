const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign}=require('./design-helpers.cjs');
const only=process.env.V18_CASE||'';
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(only&&!name.includes(only))return;
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();await page.goto(url);await prepareDesign(page);await page.evaluate(()=>{openProject('pj1');go('stage-dev');});
  try{await fn(page);assert.deepEqual(errors,[]);checks.push({name,ok:true});}
  catch(e){checks.push({name,ok:false,error:e.message});}
  finally{await page.close();}
 }
 async function prepare(page){
  await page.evaluate(()=>devPreparePlan());await page.clock.runFor(1500);
  assert.equal(await page.evaluate(()=>S.dev.autopilot.preparation.status),'ready');
 }
 async function approve(page){await prepare(page);await page.evaluate(()=>devApproveAndRun());assert.equal(await page.evaluate(()=>S.dev.autopilot.run?.status),'running');}
 await test('首屏聚焦与真正的人工问题',async page=>{
  assert.equal(await page.getByTestId('prepare-plan').count(),1,'准备计划主入口');
  assert.equal(await page.getByTestId('approve-auto').count(),1,'一次批准入口');
  for(const id of ['attention-human','attention-ai','attention-all'])assert.equal(await page.getByTestId(id).count(),1,id);
  const model=await page.evaluate(()=>devAttentionModel());
  assert.equal(model.needsHuman.length,0,'初始可由AI处理的常规核对不转嫁给人工');
  assert.ok(model.aiActionable.some(x=>x.key==='gap:SRC-003'),'没有任务的来源仍可见');
  assert.ok(model.aiActionable.some(x=>x.key==='task:T-207'),'有具体补齐依据的单测标准进入AI项');
  assert.ok(model.all.length>=23);
  await page.getByTestId('attention-all').click();
  await page.locator('.v17-side .file-row').filter({hasText:'REQ-002'}).click();
  const expected=await page.evaluate(()=>devActiveTasks().filter(t=>(t.sourceIds||[]).some(id=>S.dev.catalog.some(c=>c.id===id&&c.req==='REQ-002'))).map(t=>t.id).sort());
  assert.ok(expected.length>0);
  assert.deepEqual(await page.locator('.v17-plan-table tbody tr').evaluateAll(rows=>rows.map(r=>r.getAttribute('onclick').match(/T-\d+/)?.[0]).sort()),expected,'左栏需求筛选必须真实影响任务表');
  await page.locator('.v17-side .file-row').filter({hasText:'全部任务'}).click();
  await page.locator('#v17-search').fill('T-207');await page.locator('#v17-search').press('Enter');
  assert.equal(await page.locator('.v17-plan-table tbody tr').count(),1,'搜索只保留匹配任务');
  assert.ok((await page.locator('.v17-plan-table tbody').innerText()).includes('T-207'));
  await page.locator('#v17-search').fill('');await page.locator('#v17-search').press('Enter');
  await page.getByTestId('attention-ai').click();
  await page.locator('.v18-attention-row').filter({hasText:'SRC-003'}).click();
  assert.ok((await page.locator('body').innerText()).includes('SRC-003'),'无任务来源点击后仍可查看具体缺口');
  await page.evaluate(()=>closeModal());
  await page.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','goal','');devDraftSet('T-201','deliverables','');devSaveTask('T-201');});
  const grouped=await page.evaluate(()=>devAttentionModel());
  assert.equal(grouped.needsHuman.filter(x=>x.key==='task:T-201').length,1,'同任务多问题聚合');
 });
 await test('准备不执行、保留人工内容且编辑提案生效',async page=>{
  await page.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','title','人工确认的首页任务');devSaveTask('T-201');});
  const before=await page.evaluate(()=>JSON.stringify({tasks:S.dev.tasks,approved:S.dev.plan.approved}));
  await prepare(page);
  assert.equal(await page.evaluate(()=>JSON.stringify({tasks:S.dev.tasks,approved:S.dev.plan.approved})),before);
  const prep=await page.evaluate(()=>S.dev.autopilot.preparation);
  assert.ok(prep.revisions.length>0);assert.ok(prep.currentRevisionId);
  const latest=prep.revisions.find(x=>x.revisionId===prep.currentRevisionId);
  assert.ok(latest.proposals.some(x=>x.targetId==='T-210'&&x.sourceRefs.length));
  assert.ok(latest.proposals.some(x=>x.targetId==='T-207'&&x.sourceRefs.length));
  const summary=page.getByTestId('preparation-summary');
  assert.equal(await summary.count(),1,'准备完成后必须提供可审阅摘要，不能只有状态对象');
  assert.equal(await summary.isVisible(),true);
  const text=await summary.innerText();
  for(const required of ['T-210','T-207','覆盖','前端','后端','质量','转测试'])assert.ok(text.includes(required),'摘要须呈现 '+required);
  assert.match(text,/\d+\s*%/,'批准摘要须给出具体质量阈值，不能只说保留标准');
  assert.ok((await summary.boundingBox()).y<1000,'摘要入口必须出现在当前视口');
  assert.equal(await page.evaluate(()=>S.dev.tasks.some(t=>t.col==='ing')),false);
  const originalRevision=JSON.stringify(latest),editedGoal='保证栏目在空数据、慢响应和读取失败时可理解且可恢复，采用人工确认的交互文案';
  await page.getByTestId('proposal-edit-T-210').click();
  await page.locator('#v18-proposal-goal').fill(editedGoal);
  await page.getByTestId('proposal-edit-save').click();
  assert.equal(await page.evaluate(id=>JSON.stringify(S.dev.autopilot.preparation.revisions.find(x=>x.revisionId===id)),latest.revisionId),originalRevision,'编辑追加修订，不改写已展示的历史快照');
  assert.equal(await page.evaluate(()=>!!devTaskById('T-210')),false,'编辑建议仍不物化任务');
  await page.getByTestId('approve-auto').click();
  assert.equal(await page.evaluate(()=>devTaskById('T-210')?.goal),editedGoal,'批准必须物化用户编辑后的明确提案');
  assert.equal(await page.evaluate(()=>S.dev.autopilot.run?.status),'running');
  await page.evaluate(()=>devAutoStop());
 });
 await test('一键批准幂等且暂停接管不产生晚到进度',async page=>{
  await approve(page);
  const ids=await page.evaluate(()=>({auth:S.dev.autopilot.authorization.authorizationId,run:S.dev.autopilot.run.runId,history:S.dev.plan.history.length}));
  await page.evaluate(()=>devApproveAndRun());
  assert.deepEqual(await page.evaluate(()=>({auth:S.dev.autopilot.authorization.authorizationId,run:S.dev.autopilot.run.runId,history:S.dev.plan.history.length})),ids);
  await page.clock.runFor(2000);await page.evaluate(()=>devAutoPause());
  const paused=await page.evaluate(()=>JSON.stringify(S.dev.tasks));
  await page.clock.runFor(10000);assert.equal(await page.evaluate(()=>JSON.stringify(S.dev.tasks)),paused);
  assert.equal(await page.evaluate(()=>S.dev.autopilot.run.status),'paused');
  const pausedProgress=await page.evaluate(()=>S.dev.tasks.reduce((n,t)=>n+(t.prog||0),0));
  await page.evaluate(()=>devAutoResume());await page.clock.runFor(2500);
  assert.ok((await page.evaluate(()=>S.dev.tasks.reduce((n,t)=>n+(t.prog||0),0)))>pausedProgress,'开发中暂停后能实际续跑');
  await page.evaluate(()=>devAutoTakeover());
  assert.equal(await page.evaluate(()=>S.dev.autopilot.mode),'manual');
  const taken=await page.evaluate(()=>JSON.stringify(S.dev.tasks));await page.clock.runFor(10000);
  assert.equal(await page.evaluate(()=>JSON.stringify(S.dev.tasks)),taken);
  assert.equal(await page.evaluate(()=>S.dev.autopilot.run.status),'taken-over');
  await page.evaluate(()=>devSetExecutionMode('auto'));await page.clock.runFor(2000);
  assert.equal(await page.evaluate(()=>S.dev.autopilot.run.status),'taken-over','只切模式不能隐式恢复');
  assert.equal(await page.evaluate(()=>JSON.stringify(S.dev.tasks)),taken);
  const rollback=await page.evaluate(()=>{
   devSetExecutionMode('manual');const before=JSON.stringify(S.dev.autopilot),save=devAudit;devAudit=()=>{throw Error('V18_RESUME_AUDIT_FAIL');};
   try{devAutoResume();}catch(e){}finally{devAudit=save;}return before===JSON.stringify(S.dev.autopilot);
  });assert.equal(rollback,true,'继续失败时模式、运行和token原子回滚');
  await page.evaluate(()=>devAutoResume());
  assert.equal(await page.evaluate(()=>S.dev.autopilot.mode),'auto');assert.equal(await page.evaluate(()=>S.dev.autopilot.run.status),'running');
 });
 await test('准备后的输入变化阻断旧批准',async page=>{
  await prepare(page);
  await page.evaluate(()=>{S.design.docs.mod._finalizationSeq++;impactTrigger('mod');devApproveAndRun();});
  assert.notEqual(await page.evaluate(()=>S.dev.autopilot.run?.status),'running');
  assert.equal(await page.evaluate(()=>S.dev.plan.approved?.fingerprint===devPlanGate(S.dev,'execute').fingerprint&&devPlanGate(S.dev,'execute').ok),false);
 });
 await test('未知规格缺失不能自动补成合格',async page=>{
  await page.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','goal','');devSaveTask('T-201');});
  await prepare(page);await page.evaluate(()=>devApproveAndRun());
  assert.notEqual(await page.evaluate(()=>S.dev.autopilot.run?.status),'running');
  assert.equal(await page.evaluate(()=>devTaskById('T-201').goal),'');
  assert.ok((await page.evaluate(()=>devAttentionModel())).needsHuman.some(x=>x.key==='task:T-201'));
 });
 await test('完整自动链保留独立评审并停在人工转测试',async page=>{
  await prepare(page);
  // 在真实公开动作启动后暂停，用同一完整主线验证三类在途恢复；不设置业务结果。
  await page.evaluate(()=>{
   window.v18PauseChecks=[];
   for(const [name,phase]of [['runTaskUt','quality'],['devStartAiReview','ai-review'],['runIntegrationBuild','build']]){
    const original=window[name];let paused=false;
    window[name]=function(...args){const result=original.apply(this,args);if(!paused&&S.dev.autopilot.run?.status==='running'){paused=true;window.v18PauseChecks.push({phase,runToken:S.dev.autopilot.run.runToken});devAutoPause('验证在途 '+phase+' 暂停恢复');}return result;};
   }
  });
  await page.getByTestId('approve-auto').click();
  for(let i=0;i<120;i++){
   const status=await page.evaluate(()=>S.dev.autopilot.run?.status);
   if(status==='awaiting-transfer')break;
   if(status==='paused'){
    const frozen=await page.evaluate(()=>JSON.stringify(S.dev.tasks.map(t=>({id:t.id,prog:t.prog,col:t.col,pr:t.pr,evidence:t.evidence}))));
    const token=await page.evaluate(()=>S.dev.autopilot.run.runToken);
    await page.clock.runFor(1800);
    assert.equal(await page.evaluate(()=>JSON.stringify(S.dev.tasks.map(t=>({id:t.id,prog:t.prog,col:t.col,pr:t.pr,evidence:t.evidence})))),frozen,'取消后的质量/评审/构建不能晚到写入');
    await page.evaluate(()=>devAutoResume());assert.notEqual(await page.evaluate(()=>S.dev.autopilot.run.runToken),token);continue;
   }
   assert.equal(status,'running',JSON.stringify(await page.evaluate(()=>S.dev.autopilot.run)));
   await page.clock.runFor(5000);
  }
  const result=await page.evaluate(()=>({status:S.dev.autopilot.run.status,scope:S.dev.autopilot.authorization.scope,done:devActiveTasks().filter(t=>t.col==='done').length,total:devActiveTasks().length,reviews:S.dev.aiReviews,prs:S.dev.prs,build:S.dev.build,transfer:S.dev.transfer,gate:devTransferGate(S.dev,'pj1')}));
  assert.equal(result.status,'awaiting-transfer');assert.equal(result.done,24);assert.equal(result.total,24);
  assert.equal(result.scope.transferToTest,false);assert.equal(result.build.status,'pass');assert.equal(result.gate.ok,true);assert.ok(!result.transfer);
  assert.deepEqual(await page.evaluate(()=>window.v18PauseChecks.map(x=>x.phase)),['quality','ai-review','build']);
  assert.ok(result.reviews.length>=24);assert.ok(result.reviews.every(r=>r.reviewerId&&r.authorizationId&&r.unitEvidenceId&&r.ciEvidenceId));
  assert.ok(result.prs.every(p=>p.status==='merged'&&p.checks.every(c=>!c.checked)&&!p.skipReason),'AI评审不能冒充人工checklist或豁免');
  await page.evaluate(()=>devTransferToTest());assert.ok(await page.evaluate(()=>S.dev.transfer?.buildId));
  assert.equal(await page.evaluate(()=>S.dev.autopilot.authorization.status),'consumed');
 });
 const report={ok:checks.length>0&&checks.every(x=>x.ok),checks};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/attention-auto.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));await browser.close();if(!report.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
