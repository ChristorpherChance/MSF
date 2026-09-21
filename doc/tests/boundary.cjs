const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),results=[];
 async function check(name,fn){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install();await page.goto(url);
  await prepareDesign(page);
  await page.evaluate(()=>{openProject('pj1');go('stage-dev');});
  try{await fn(page,errors);results.push({name,ok:true});}
  catch(e){results.push({name,ok:false,error:e.message});}
  finally{await page.close();}
 }
 await check('运行时初始化保留显式输入来源',async page=>{
  const result=await page.evaluate(()=>{
   const raw=JSON.parse(JSON.stringify(V17_SPEC_DATA.tasks[0]));raw.inputArtifactIds.push('PROTO');
   return devRuntimeTask(raw).inputArtifactIds;
  });assert.ok(result.includes('PROTO'),'初始化不得用来源目录覆盖显式 PROTO');
 });
 await check('合并保留双方输入并持续要求原型定稿',async page=>{
  const result=await page.evaluate(()=>{
   devOpenTask('T-203');devDraftSet('T-203','inputArtifactIds',S.dev.drafts['T-203'].inputArtifactIds+'\nPROTO');devSaveTask('T-203');
   const expected=Array.from(new Set(devTaskById('T-201').inputArtifactIds.concat(devTaskById('T-203').inputArtifactIds)));
   devMergeTask('T-201');document.querySelector('#v17-merge-target').value='T-203';devDoMerge('T-201');
   const merged=devActiveTasks().find(t=>(t.predecessors||[]).includes('T-201')&&(t.predecessors||[]).includes('T-203'));
   return {expected,actual:merged.inputArtifactIds,required:devDeriveBaseline().items.find(i=>i.artifactId==='PROTO').required};
  });for(const id of result.expected)assert.ok(result.actual.includes(id),'合并丢失输入 '+id);
  assert.equal(result.required,true,'合并后原型定稿仍是必需输入');
 });
 await check('显式原型输入参与影响分析',async page=>{
  const affected=await page.evaluate(()=>{
   devOpenTask('T-201');devDraftSet('T-201','inputArtifactIds',S.dev.drafts['T-201'].inputArtifactIds+'\nPROTO');devSaveTask('T-201');
   if(!S.proto.versions.length)S.proto.versions.push({v:1,html:PROTO_HTML,note:'已定稿上游原型夹具',at:now()});
   S.proto.cur=1;S.proto.finalVer=1;S.proto.finalized=true;S.proto.modified=false;S.proto.pend=[];S.proto._finalizationSeq=(S.proto._finalizationSeq||0)+1;
   impactTrigger('proto');return S.dev.impacts.some(i=>i.task==='T-201'&&i.status==='pending-assessment');
  });assert.equal(affected,true,'未在目录主锚点出现的显式输入也必须产生任务处置');
 });
 for(const action of ['devMarkInputDirty','impactTrigger'])await check(action+' 审计失败不部分写入',async page=>{
  const result=await page.evaluate(action=>{
   if(action==='impactTrigger')S.design.docs.mod._finalizationSeq++;else S.prd.finalized=false;
   const before=JSON.stringify(S.dev),saved=devAudit;let caught=false;
   devAudit=()=>{throw new Error('BOUNDARY_AUDIT_FAILURE');};
   try{window[action](action==='impactTrigger'?'mod':'PRD');}catch(e){caught=true;}finally{devAudit=saved;}
   return {same:before===JSON.stringify(S.dev),caught};
  },action);assert.equal(result.caught,true,'故障注入必须触发');assert.equal(result.same,true,'失败必须保持业务与审计原样');
 });
 await check('识别完成回调审计失败保持原状态且可重试',async(page,errors)=>{
  const before=await page.evaluate(()=>{devIdentify();window.savedBoundaryAudit=devAudit;devAudit=()=>{throw new Error('BOUNDARY_AUDIT_FAILURE');};return JSON.stringify(S.dev);});
  try{await page.clock.runFor(750);}catch(e){if(!e.message.includes('BOUNDARY_AUDIT_FAILURE'))throw e;}
  assert.ok((await page.evaluate(()=>JSON.stringify(S.dev)))===before,'异步完成失败不能部分提交建议、状态或ID');
  await page.evaluate(()=>{devAudit=window.savedBoundaryAudit;devIdentify();});await page.clock.runFor(750);
  assert.equal(await page.evaluate(()=>S.dev.suggestions.filter(s=>s.state==='pending').length),1,'重试仅生成一条建议');
  assert.ok(errors.every(e=>e.includes('BOUNDARY_AUDIT_FAILURE')),'不能出现非注入脚本错误');
 });
 await check('事务外业务写明确拒绝且页面草稿可编辑',async page=>{
  const result=await page.evaluate(()=>{
   const before=JSON.stringify(S.dev),attempts=[()=>{S.dev.tasks[0].title='不受控写入';},()=>{S.dev.tasks.push({id:'BAD'});},()=>{delete S.dev.plan.state;},()=>{Object.defineProperty(S.dev.baseline,'valid',{value:true});},()=>{S.dev={};}],rejected=[];
   for(const attempt of attempts){let caught=false;try{attempt();}catch(e){caught=true;}rejected.push(caught);}
   const same=before===JSON.stringify(S.dev);if(!same)return {rejected,same};devOpenTask('T-201');devDraftSet('T-201','title','尚未保存的草稿');
   return {rejected,same,draft:S.dev.drafts['T-201'].title,saved:devTaskById('T-201').title};
  });assert.ok(result.rejected.every(Boolean),'每种业务直写都必须抛错');assert.equal(result.same,true);
  assert.equal(result.draft,'尚未保存的草稿');assert.notEqual(result.saved,result.draft);
 });
 await check('事务内泄露的草稿别名不能改已发布状态',async page=>{
  const result=await page.evaluate(()=>{
   devOpenTask('T-201');devDraftSet('T-201','title','合法保存后的标题');
   const saved=devAudit;let leaked;
   devAudit=function(){leaked=devTaskById('T-201');return saved.apply(null,arguments);};
   try{devSaveTask('T-201');}finally{devAudit=saved;}
   try{leaked.title='旧草稿别名越界改写';}catch(e){}
   return devTaskById('T-201').title;
  });assert.equal(result,'合法保存后的标题');
 });
 await check('其他项目拒绝输入观察与识别写入',async(page,errors)=>{
  const same=await page.evaluate(()=>{
   openProject('pj2');const before=JSON.stringify(S.dev);
   devMarkInputDirty('其他项目的输入');impactTrigger('mod');devIdentify();
   return before===JSON.stringify(S.dev);
  });assert.equal(same,true);await page.clock.runFor(750);assert.deepEqual(errors,[]);
 });
 await check('合并任务仅改标题不丢双方质量场景',async page=>{
  const result=await page.evaluate(()=>{
   devMergeTask('T-201');document.querySelector('#v17-merge-target').value='T-203';devDoMerge('T-201');
   const merged=devActiveTasks().find(t=>(t.predecessors||[]).includes('T-201'));
   const before=JSON.stringify(merged.quality);devOpenTask(merged.id);devDraftSet(merged.id,'title','合并任务仅修改标题');devSaveTask(merged.id);
   return before===JSON.stringify(devTaskById(merged.id).quality);
  });assert.equal(result,true,'双方用例必须在无关编辑后无损保留');
 });
 await check('详情清空覆盖率不能静默变成零阈值',async page=>{
  const result=await page.evaluate(()=>{
   devOpenTask('T-201');devDraftSet('T-201','line','');devSaveTask('T-201');
   const task=devTaskById('T-201');return {line:task.quality.line,issues:devSpecIssues(task)};
  });assert.ok(result.line!==0||result.issues.length>0,'清空阈值应保留旧值或报告缺失，不得以0通过');
 });
 await check('上游观察失败实时阻断并通过基线页幂等恢复',async page=>{
  await page.evaluate(()=>devIdentify());await page.clock.runFor(750);
  await page.evaluate(()=>{devAdoptAll();devImproveTasks();devCoverageCheck();devConfirmAllCoverage();closeModal();devSchedule();devSubmitPlan();devApprovePlan();devStart('T-201');});
  assert.equal(await page.evaluate(()=>devPlanGate(S.dev,'execute').ok),true,'恢复反例的初始计划必须批准且可执行');
  const failed=await page.evaluate(()=>{
   S.design.docs.mod._finalizationSeq++;const before=JSON.stringify(S.dev),saved=devAudit;let caught=false;
   devAudit=()=>{throw new Error('BOUNDARY_AUDIT_FAILURE');};
   try{impactTrigger('mod');}catch(e){caught=true;}finally{devAudit=saved;}
   return {caught,same:before===JSON.stringify(S.dev),blocked:!devPlanGate(S.dev,'execute').ok};
  });assert.deepEqual(failed,{caught:true,same:true,blocked:true});
  await page.evaluate(()=>{devSetTop('change');S.dev.changePage='baseline';render();});
  // 快速夹具操作会同时堆叠多条既有 toast；先推进其 2400+300ms 生命周期。
  await page.clock.runFor(2800);
  assert.equal(await page.getByRole('button',{name:'同步实际输入状态',exact:true}).evaluate(el=>{
   const r=el.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return hit===el||el.contains(hit);
  }),true,'同步按钮不能被其它控件遮挡');
  await page.getByRole('button',{name:'同步实际输入状态',exact:true}).click({force:true});
  const result=await page.evaluate(()=>{
   const first={events:S.dev.changeEvents.length,impacts:S.dev.impacts.length,audit:S.dev.audit.length};
   const valid=S.dev.baseline.valid,running=S.dev.operations['task:T-201']?.status==='running',affected=S.dev.impacts.some(i=>i.task==='T-201');
   devReconcileInputs();return {valid,running,affected,first,again:{events:S.dev.changeEvents.length,impacts:S.dev.impacts.length,audit:S.dev.audit.length},plan:S.dev.plan.state};
  });assert.equal(result.valid,false,'恢复后基线仍待人工确认');assert.equal(result.running,false,'恢复应取消旧运行');assert.equal(result.affected,true,'恢复应补记受影响任务');
  assert.deepEqual(result.again,result.first,'重复同步不得再造事件、影响或审计');assert.notEqual(result.plan,'approved');
 });
 await check('来源身份未变时同步补齐拆分后任务的影响',async page=>{
  const result=await page.evaluate(()=>{
   S.design.docs.mod._finalizationSeq++;impactTrigger('mod');const events=S.dev.changeEvents.length;
   devSplitTask('T-201');const children=devTaskById('T-201').successors.slice(),needs=devInputNeedsReconcile();
   devReconcileInputs();const covered=children.every(id=>S.dev.impacts.some(i=>i.task===id&&i.artifactId==='MOD'));
   const count=S.dev.impacts.length,audit=S.dev.audit.length;devReconcileInputs();
   return {needs,covered,events,afterEvents:S.dev.changeEvents.length,count,afterCount:S.dev.impacts.length,audit,afterAudit:S.dev.audit.length};
  });assert.equal(result.needs,true);assert.equal(result.covered,true,'已有来源事件必须补齐新任务处置');
  assert.equal(result.afterEvents,result.events);assert.equal(result.afterCount,result.count);assert.equal(result.afterAudit,result.audit);
 });
 await browser.close();
 const report={ok:results.every(r=>r.ok),checks:results};
 fs.writeFileSync(path.join(__dirname,'../evidence/boundary.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));if(!report.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
