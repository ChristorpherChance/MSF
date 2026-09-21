const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,checkDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();
 async function approve(){
  await page.evaluate(()=>{devSetTop('plan');devCoverageCheck();devConfirmAllCoverage();closeModal();devSchedule();devSubmitPlan();devApprovePlan();});
  const gate=await page.evaluate(()=>devPlanGate(S.dev,'execute'));
  assert.equal(gate.ok,true,JSON.stringify(gate.issues));
 }
 async function boot(){
  await page.goto(url);await prepareDesign(page);await page.evaluate(()=>{openProject('pj1');go('stage-dev');devIdentify();});
  await page.clock.runFor(750);await page.evaluate(()=>{devAdoptAll();devImproveTasks();});await approve();
 }
 async function submitFirst(){
  await page.evaluate(()=>devStart('T-201'));await page.clock.runFor(12000);
  await page.evaluate(()=>devSubmitReview('T-201'));
  assert.equal(await page.evaluate(()=>devTaskById('T-201').col),'review');
 }
 try{
  await boot();
  const specs=await page.evaluate(()=>{
   const t=JSON.parse(JSON.stringify(devTaskById('T-201'))),cases={};
   for(const [key,value] of [['kind','bad-kind'],['owner',''],['writeScopes',[]],['effort','']]){
    const c=JSON.parse(JSON.stringify(t));c[key]=value;cases[key]=devSpecIssues(c).length>0;
   }
   for(const value of ['',null,101,-1]){const c=JSON.parse(JSON.stringify(t));c.quality.line=value;cases['threshold:'+value]=devSpecIssues(c).length>0;}
   const paths=[JSON.parse(JSON.stringify(t)),JSON.parse(JSON.stringify(t))];
   paths[0].deps=[];paths[1].id='T-X';paths[1].deps=[];
   paths[0].writeScopes=['apps/shared'];paths[1].writeScopes=['apps\\shared\\component'];
   cases['equivalent-path-conflict']=devDependencyPlan(paths).batches.length===2;
   const c=JSON.parse(JSON.stringify(t));c.writeScopes=['../outside'];cases['parent-path']=devSpecIssues(c).length>0;
   return cases;
  });
  for(const [name,ok] of Object.entries(specs))assert.equal(ok,true,name);
  checks.push('规格必填、阈值保真、写范围规范化');

  const batchBlocked=await page.evaluate(()=>{
   const d=JSON.parse(JSON.stringify(S.dev)),a=d.tasks.find(t=>t.id==='T-201'),b=d.tasks.find(t=>t.id==='T-202');
   a.writeScopes=['apps/shared'];b.writeScopes=['apps/shared'];a.deps=[];b.deps=[];
   const p=devDependencyPlan(d.tasks);p.batches.forEach((ids,i)=>ids.forEach(id=>d.tasks.find(t=>t.id===id).batch=i+1));
   const fp=devPlanGate(d,'submit').fingerprint;
   d.plan.approved={...d.plan.approved,fingerprint:fp,taskRevisions:Object.fromEntries(d.tasks.map(t=>[t.id,t.rev]))};
   return {separate:a.batch<b.batch,blocked:!devStartGate(d,b.id,'pj1').ok};
  });
  assert.deepEqual(batchBlocked,{separate:true,blocked:true});checks.push('不同批次即使没有显式依赖也不能提前开始');

  // 审计失败不得留下任务、计划、PR、影响或 ID 计数器的部分提交。
  const atomic=await page.evaluate(()=>{
   devOpenTask('T-202');S.dev.drafts['T-202'].title+=' 审计失败反例';
   const before=JSON.stringify(S.dev),saved=devAudit;let caught=false;
   devAudit=function(){throw new Error('审计构造失败注入');};
   try{devSaveTask('T-202');}catch(e){caught=true;}finally{devAudit=saved;}
   return {same:before===JSON.stringify(S.dev),caught};
  });
  assert.equal(atomic.same,true,'审计失败零业务写入');checks.push('审计失败不部分提交');

  await boot();await submitFirst();
  const oldPr=await page.evaluate(()=>{const p=devTaskById('T-201').pr;p.checks.forEach((_,i)=>prToggleCheck(p.id,i));closeModal();return p.id;});
  await page.evaluate(()=>devBeginRework('T-201'));
  await page.locator('#v17-rework-reason').fill('旧实现需要修订，保留历史 PR');
  await page.evaluate(()=>devConfirmRework('T-201'));await approve();await submitFirst();
  await page.evaluate(()=>runTaskUt('T-201'));await page.clock.runFor(1100);
  const currentPr=await page.evaluate(()=>devTaskById('T-201').pr.id);
  await page.evaluate(id=>prMerge(id),oldPr);
  assert.equal(await page.evaluate(id=>devPrById(id).status==='merged',oldPr),false);
  assert.equal(await page.evaluate(()=>devTaskById('T-201').pr.id),currentPr);
  assert.equal(await page.evaluate(()=>devTaskById('T-201').col),'review');
  checks.push('历史 PR 不能借用新 PR 证据合并');

  await page.evaluate(()=>{devOpenTask('T-202');S.dev.drafts['T-202'].title+=' · 无关标题修订';devSaveTask('T-202');});
  await approve();
  assert.equal(await page.evaluate(()=>devAutomatedGate(devTaskById('T-201')).ok),true,'修改B不使A证据过期');
  checks.push('无关任务修改保留当前任务证据');

  const isolation=await page.evaluate(()=>{
   openProject('pj2');go('stage-dev');const before=JSON.stringify(S.dev),failures=[];
   const calls=[['devSplitTask',['T-201']],['devCreateTask',[]],['devRejectSuggestion',[S.dev.suggestions[0]?.id]],['devConfirmAllCoverage',[]],['devConfirmCoverageItem',['SRC-001']],['devApplyDefer',['SRC-003']],['devUndefer',['SRC-003']],['devConfirmRework',['T-201']],['devBumpProg',['T-201',10]],['prToggleCheck',[S.dev.prs[0]?.id,0]],['doPrSkip',[S.dev.prs[0]?.id]]];
   for(const [name,args] of calls){try{window[name](...args);}catch(e){failures.push(name+': '+e.message);}if(JSON.stringify(S.dev)!==before)failures.push(name+': 写入了其它项目');}
   return failures;
  });
  assert.deepEqual(isolation,[]);checks.push('pj2 对各写入动作均无业务和审计副作用');

  for(const kind of ['PRD','mod']){
   await boot();const before=await page.evaluate(()=>devDeriveBaseline().key);
   await page.evaluate(kind=>{
    if(kind==='PRD'){S.reqTab='prd';go('stage-req');docMenu(document.body);}
    else {S.designTab='detail';S.design.sel='mod';go('stage-design');designMenu(document.body);}
   },kind);
   await page.getByText('🔓 解锁定稿',{exact:true}).click();
   assert.equal(await page.evaluate(()=>devPlanGate(S.dev,'execute').ok),false,kind+'真实解锁必须即时失效');
   await page.evaluate(kind=>{if(kind==='PRD')doFinalize();else doFinalDesign(kind);},kind);
   await page.clock.runFor(750);
   assert.notEqual(await page.evaluate(()=>devDeriveBaseline().key),before,kind+'同版本再定稿改变身份');
   assert.equal(await page.evaluate(()=>devPlanGate(S.dev,'execute').ok),false,'再定稿不能恢复旧批准');
  }
  checks.push('PRD/详细设计真实菜单解锁与同版本再定稿');
  await boot();
  await page.evaluate(()=>{S.designTab='proto';go('stage-design');protoMenu(document.body);});
  await page.locator('#po').getByText('🔓 解锁定稿',{exact:true}).click();
  const prototypeInput=await page.evaluate(()=>{
   devOpenTask('T-201');devDraftSet('T-201','inputArtifactIds',S.dev.drafts['T-201'].inputArtifactIds+'\nPROTO');devSaveTask('T-201');
   const b=devDeriveBaseline();return {required:b.items.find(x=>x.artifactId==='PROTO').required,ready:b.valid,allowed:devPlanGate(S.dev,'execute').ok};
  });
  assert.deepEqual(prototypeInput,{required:true,ready:false,allowed:false},'明确引用原型时不能忽略未定稿原型');
  await checkDesign(page);
  assert.equal(await page.evaluate(()=>!!designFinalizePrototypeBaseline()),true);
  const prototypeKey=await page.evaluate(()=>devDeriveBaseline().key);
  await page.evaluate(()=>protoMenu(document.body));
  await page.locator('#po').getByText('🔓 解锁定稿',{exact:true}).click();
  assert.equal(await page.evaluate(()=>devDeriveBaseline().valid),false);
  await checkDesign(page);await page.evaluate(()=>doFinalProto());await page.clock.runFor(750);
  assert.notEqual(await page.evaluate(()=>devDeriveBaseline().key),prototypeKey,'被引用原型的同版本再定稿改变身份');
  await boot();
  assert.equal(await page.evaluate(()=>{S.prd.pend.push({secId:curVer(S.prd).secs[0].id,type:'mod',old:'',reason:'未处理修改夹具'});return devPlanGate(S.dev,'execute').ok;}),false,'未处理上游修改即刻阻断');
  checks.push('结构化原型输入、原型真实解锁再定稿、上游pending阻断');
  assert.deepEqual(errors,[]);
  const result={ok:true,checks,errors};fs.writeFileSync(path.resolve(__dirname,'../evidence/review-cases.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}
})();
