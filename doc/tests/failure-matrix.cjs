const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){const p=await browser.newPage({viewport:{width:1440,height:1000}});await p.clock.install();await p.goto(url);try{await prepareDesign(p);await p.evaluate(()=>{openProject('pj1');go('stage-dev');});await fn(p);checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}}
 async function approve(p){await p.evaluate(()=>devIdentify());await p.clock.runFor(750);await p.evaluate(()=>{devAdoptAll();devImproveTasks();devCoverageCheck();devConfirmAllCoverage();closeModal();devSchedule();devSubmitPlan();devApprovePlan();});assert.equal(await p.evaluate(()=>devPlanGate(S.dev,'execute').ok),true);}
 async function failObserve(p){const r=await p.evaluate(()=>{S.design.docs.mod._finalizationSeq++;const before=JSON.stringify(S.dev),saved=devAudit;let caught=false;devAudit=()=>{throw Error('MATRIX_AUDIT_FAILURE');};try{impactTrigger('mod');}catch(e){caught=true;}finally{devAudit=saved;}return {same:before===JSON.stringify(S.dev),caught,blocked:!devPlanGate(S.dev,'execute').ok};});assert.deepEqual(r,{same:true,caught:true,blocked:true});}
 async function prototypeFixture(p){assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),true,'原型来自公开生成/检查/定稿链');}
 async function editProto(p,id,add){await p.evaluate(({id,add})=>{devOpenTask(id);const ids=devTaskById(id).inputArtifactIds.filter(x=>x!=='PROTO');if(add)ids.push('PROTO');devDraftSet(id,'inputArtifactIds',ids.join('\n'));devSaveTask(id);},{id,add});}
 async function sync(p,required){const r=await p.evaluate(()=>{const needs=devInputNeedsReconcile();devSetTop('change');S.dev.changePage='baseline';render();const reachable=Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='同步实际输入状态'&&!e.disabled);devReconcileInputs();const unconfirmed=!S.dev.baseline.valid;devConfirmBaseline();const live=resolveDevInputs(S.dev,S).baselineCandidate;return {needs,reachable,unconfirmed,valid:S.dev.baseline.valid,same:S.dev.baseline.fingerprint===live.fingerprint,required:S.dev.baseline.items.find(i=>i.artifactId==='PROTO').required};});assert.deepEqual(r,{needs:true,reachable:true,unconfirmed:true,valid:true,same:true,required});}
 await test('增减最后一个原型消费者均可同步并确认',async p=>{await prototypeFixture(p);await editProto(p,'T-201',true);await sync(p,true);await editProto(p,'T-201',false);await sync(p,false);});
 await test('延期与恢复原型消费者均更新必需输入集合',async p=>{
  await prototypeFixture(p);await p.evaluate(()=>devIdentify());await p.clock.runFor(750);await p.evaluate(()=>{devAdoptAll();devOpenTask('T-209');devDraftSet('T-209','deps',devTaskById('T-209').deps.filter(x=>x!=='T-210').join('\n'));devSaveTask('T-209');});
  await editProto(p,'T-210',true);await sync(p,true);
  await p.evaluate(()=>devOpenDefer('SRC-003'));await p.locator('#v17-defer-reason').fill('输入集合变更反例');await p.evaluate(()=>{devApplyDefer('SRC-003');closeModal();});await sync(p,false);
  await p.evaluate(()=>{devUndefer('SRC-003');closeModal();});await sync(p,true);
 });
 await test('观察失败后在途任务不再推进',async p=>{await approve(p);await p.evaluate(()=>devStart('T-201'));const before=await p.evaluate(()=>devTaskById('T-201').prog);await failObserve(p);await p.clock.runFor(1000);assert.equal(await p.evaluate(()=>devTaskById('T-201').prog),before);assert.notEqual(await p.evaluate(()=>S.dev.operations['task:T-201'].status),'running');});
 await test('观察失败后在途质量不生成通过证据',async p=>{await approve(p);await p.evaluate(()=>devStart('T-201'));await p.clock.runFor(12000);await p.evaluate(()=>{devSubmitReview('T-201');runTaskUt('T-201');});await failObserve(p);await p.clock.runFor(1200);assert.equal(await p.evaluate(()=>{const e=devTaskById('T-201').evidence;return e.unit?.status==='pass'||e.ci?.status==='pass';}),false);});
 await test('观察失败后在途识别不生成当前建议',async p=>{await p.evaluate(()=>devIdentify());await failObserve(p);await p.clock.runFor(750);assert.equal(await p.evaluate(()=>S.dev.suggestions.length),0);assert.notEqual(await p.evaluate(()=>S.dev.operations.identify.status),'done');});
 await test('刷新界面失败不阻断任务计时器',async p=>{await approve(p);await p.evaluate(()=>{const saved=render;render=()=>{throw Error('MATRIX_RENDER_FAILURE');};try{devStart('T-201');}catch(e){}finally{render=saved;}});const before=await p.evaluate(()=>devTaskById('T-201').prog);await p.clock.runFor(1000);assert.ok((await p.evaluate(()=>devTaskById('T-201').prog))>before,'业务启动已提交后，UI异常不能阻断后续计时器');});
 await test('计时器启动失败有审计且可用新token重试',async p=>{
  await approve(p);const failed=await p.evaluate(()=>{const saved=setInterval;window.setInterval=()=>{throw Error('MATRIX_TIMER_FAILURE');};try{devStart('T-201');}catch(e){}finally{window.setInterval=saved;}const op=S.dev.operations['task:T-201'];return {status:op.status,token:op.opToken,audited:S.dev.audit.some(a=>/start[._ -]?failed/i.test(a.action+' '+a.reason))};});
  assert.match(failed.status,/fail/);assert.equal(failed.audited,true);
  await p.evaluate(()=>{if(devTaskById('T-201').col==='queue')devStart('T-201');else devResumeTask('T-201');});await p.clock.runFor(1000);
  const retried=await p.evaluate(()=>({token:S.dev.operations['task:T-201'].opToken,progress:devTaskById('T-201').prog}));assert.notEqual(retried.token,failed.token);assert.ok(retried.progress>8);
 });
 await browser.close();const result={ok:checks.every(c=>c.ok),checks};fs.writeFileSync(path.join(__dirname,'../evidence/failure-matrix.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
