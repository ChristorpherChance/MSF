const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,refreshDesignBaseline}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(process.env.V18_CASE&&!name.includes(process.env.V18_CASE))return;
  const p=await browser.newPage({viewport:{width:1440,height:1000}});await p.clock.install();await p.goto(url);await prepareDesign(p);await p.evaluate(()=>{openProject('pj1');go('stage-dev');});
  try{await fn(p);checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}
 }
 async function prepare(p){await p.evaluate(()=>devPreparePlan());await p.clock.runFor(1500);assert.equal(await p.evaluate(()=>S.dev.autopilot.preparation.status),'ready');}
 async function start(p){await prepare(p);await p.evaluate(()=>devApproveAndRun());assert.equal(await p.evaluate(()=>S.dev.autopilot.run?.status),'running');}
 async function facts(p){return p.evaluate(()=>JSON.stringify(S.dev.tasks.map(t=>({id:t.id,col:t.col,prog:t.prog,codeRev:t.codeRev,evidence:t.evidence,pr:t.pr}))));}
 async function untilBlocked(p){for(let i=0;i<20;i++){if(await p.evaluate(()=>S.dev.autopilot.run?.status==='blocked'))return;await p.clock.runFor(1000);}assert.fail('期望自动执行因可复现故障停止');}
 async function repairFirstTask(p,hook){
  const old=await p.evaluate(()=>({auth:S.dev.autopilot.authorization.authorizationId,pr:devTaskById('T-201').pr.id,codeRev:devTaskById('T-201').codeRev}));
  await p.evaluate(()=>devSetTop('plan'));await p.getByTestId('attention-human').click();
  await p.getByRole('button',{name:/返工.*准备/}).first().click();
  await p.locator('#v17-rework-reason').fill('修复已复现问题，保持原验收标准并重新验证');
  await p.evaluate(hook=>{delete V18_TEST_HOOKS[hook]['T-201'];},hook);
  await p.getByRole('button',{name:/确认返工/}).click();await p.clock.runFor(1500);
  assert.ok((await p.evaluate(()=>devTaskById('T-201').codeRev))>old.codeRev);
  assert.equal(await p.evaluate(()=>S.dev.autopilot.authorization.status),'revoked');
  if(await p.evaluate(()=>S.dev.autopilot.preparation.status!=='ready'))await prepare(p);
  await p.evaluate(()=>devApproveAndRun());
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.authorization.authorizationId),old.auth);
  for(let i=0;i<35;i++){if(await p.evaluate(()=>devTaskById('T-201').col==='done'))break;await p.clock.runFor(1000);}
  assert.equal(await p.evaluate(()=>devTaskById('T-201').col),'done','失败可经页面返工入口获得新证据并合并');
  assert.notEqual(await p.evaluate(()=>devTaskById('T-201').pr.id),old.pr);
  assert.notEqual(await p.evaluate(id=>devPrById(id).status,old.pr),'merged');
  assert.ok(await p.evaluate(id=>S.dev.autopilot.authorizationReceipts.some(x=>x.authorizationId===id),old.auth));
  await p.evaluate(()=>devAutoStop());
 }
 await test('准备快照过期与拒绝遗漏方案均不能启动',async p=>{
  await prepare(p);await p.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','title','准备后人工修改');devSaveTask('T-201');devApproveAndRun();});
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.run?.status),'running');
  await prepare(p);
  await p.evaluate(()=>{S.dev.selectedTask=null;devSetTop('plan');});
  await p.getByTestId('proposal-reject-T-210').click();
  assert.equal(await p.evaluate(()=>{const a=S.dev.autopilot.preparation;return a.revisions.find(x=>x.revisionId===a.currentRevisionId).proposals.find(x=>x.targetId==='T-210').decision;}),'rejected','用户可直接从准备摘要拒绝提案');
  const rejected=await p.evaluate(()=>{const a=S.dev.autopilot.preparation;return a.revisions.find(x=>x.revisionId===a.currentRevisionId);});
  assert.ok(rejected.issues.length>0,'拒绝必要任务后摘要应列真实缺口');
  assert.equal(rejected.batches.flat().includes('T-210'),false,'批次不能保留未采纳且尚未生成的任务');
  assert.equal(rejected.coverageDecisions.some(x=>x.result==='confirmed'&&(x.taskIds||[]).includes('T-210')),false,'覆盖不能声称未生成任务已承接');
  assert.equal(await p.getByTestId('approve-auto').isDisabled(),true,'页面与实际批准门禁一致');
  await p.evaluate(()=>devApproveAndRun());
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.run?.status),'running');
  assert.equal(await p.evaluate(()=>!!devTaskById('T-210')),false);
  await p.getByTestId('proposal-edit-T-210').click();await p.getByTestId('proposal-edit-save').click();
  assert.equal(await p.getByTestId('approve-auto').isEnabled(),true,'恢复采用后重新核对可批准性');
  await p.getByTestId('approve-auto').click();assert.equal(await p.evaluate(()=>!!devTaskById('T-210')),true);await p.evaluate(()=>devAutoStop());
 });
 await test('一次授权审计失败不部分接受计划或启动',async p=>{
  await prepare(p);
  const result=await p.evaluate(()=>{
   const snap=()=>JSON.stringify({tasks:S.dev.tasks,plan:S.dev.plan,autopilot:S.dev.autopilot,audit:S.dev.audit}),before=snap(),save=devAudit;devAudit=()=>{throw Error('V18_APPROVE_AUDIT_FAIL');};let caught=false;
   try{devApproveAndRun();}catch(e){caught=true;}finally{devAudit=save;}
   return {same:before===snap(),caught};
  });assert.equal(result.same,true);await p.clock.runFor(10000);
  assert.equal(await p.evaluate(()=>S.dev.tasks.some(t=>t.col==='ing'||t.col==='done')),false);
 });
 await test('观察失败后真实输入仍阻断在途自动链',async p=>{
  await start(p);await p.clock.runFor(1500);
  await p.evaluate(()=>{S.design.docs.mod._finalizationSeq++;const save=devAudit;devAudit=()=>{throw Error('V18_INPUT_AUDIT_FAIL');};try{impactTrigger('mod');}catch(e){}finally{devAudit=save;}});
  const before=await facts(p);await p.clock.runFor(15000);
  assert.equal(await facts(p),before);assert.notEqual(await p.evaluate(()=>S.dev.autopilot.run.status),'running');
 });
 await test('切换项目和停止不允许旧运行恢复',async p=>{
  await start(p);await p.clock.runFor(1300);await p.evaluate(()=>{openProject('pj2');go('stage-dev');});
  const before=await facts(p);await p.clock.runFor(10000);assert.equal(await facts(p),before);
  await p.evaluate(()=>{devApproveAndRun();devAutoResume();});await p.clock.runFor(2000);assert.equal(await facts(p),before);
  await p.evaluate(()=>{openProject('pj1');go('stage-dev');});await p.clock.runFor(2000);assert.equal(await facts(p),before,'回到项目不能隐式恢复自动授权');
  await p.evaluate(()=>devAutoStop());const stopped=await facts(p);await p.clock.runFor(10000);assert.equal(await facts(p),stopped);
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'stopped');
 });
 await test('人工指派任务不会被自动接管',async p=>{
  await p.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','owner',ASG_POOL[0]);devSaveTask('T-201');});
  await start(p);await p.clock.runFor(15000);
  const t=await p.evaluate(()=>devTaskById('T-201'));assert.equal(t.asgType,'human');assert.equal(t.prog,0);assert.equal(t.col,'queue');assert.ok(!t.pr);
  assert.ok((await p.evaluate(()=>devAttentionModel())).needsHuman.some(x=>x.key==='task:T-201'));
  await p.evaluate(()=>{devAutoTakeover();devStart('T-201');});await p.clock.runFor(3000);
  assert.equal(await p.evaluate(()=>devTaskById('T-201').prog),0,'人工任务没有模拟进度');
  await p.evaluate(()=>{devBumpProg('T-201',100);devSubmitReview('T-201');runTaskUt('T-201');});await p.clock.runFor(1200);
  await p.evaluate(()=>{const pr=devTaskById('T-201').pr;pr.checks.forEach((_,i)=>prToggleCheck(pr.id,i));prMerge(pr.id);});
  assert.equal(await p.evaluate(()=>devTaskById('T-201').col),'done','人工可沿同一任务与质量证据完成评审合并');
 });
 await test('质量失败展示处理项且同一失败不得空重跑',async p=>{
  await p.evaluate(()=>{V18_TEST_HOOKS.qualityOutcomeByTask['T-201']='fail';});await start(p);await untilBlocked(p);
  const before=await p.evaluate(()=>({op:S.dev.operations['quality:T-201'],code:devTaskById('T-201').codeRev}));
  assert.notEqual(await p.evaluate(()=>devTaskById('T-201').col),'done');
  assert.ok((await p.evaluate(()=>devAttentionModel())).needsHuman.some(x=>x.key==='task:T-201'));
  await p.evaluate(()=>devAutoResume());await p.clock.runFor(3000);
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'blocked');assert.equal(await p.evaluate(()=>S.dev.operations['quality:T-201'].runId),before.op.runId);
  await repairFirstTask(p,'qualityOutcomeByTask');
 });
 await test('自定义质量目标未达到时一次失败并进入关注',async p=>{
  await p.evaluate(()=>{devOpenTask('T-201');devDraftSet('T-201','line','95');devDraftSet('T-201','branch','90');devSaveTask('T-201');});
  await start(p);await untilBlocked(p);
  const result=await p.evaluate(()=>({run:S.dev.autopilot.run,task:devTaskById('T-201'),starts:S.dev.audit.filter(x=>x.action==='quality.start').length,human:devAttentionModel().needsHuman}));
  assert.equal(result.run.blocker.code,'QUALITY_FAILED');assert.equal(result.task.quality.line,95);assert.equal(result.task.quality.branch,90);
  assert.equal(result.task.evidence.unit.status,'fail');assert.equal(result.task.evidence.unit.line,84);assert.equal(result.task.evidence.unit.branch,74);
  assert.equal(result.starts,1,'低于目标不应通过不断重跑掩盖');assert.ok(result.human.some(x=>x.key==='task:T-201'));
  await p.clock.runFor(5000);assert.equal(await p.evaluate(()=>S.dev.audit.filter(x=>x.action==='quality.start').length),1);
 });
 await test('AI评审失败不能使用空人工勾选合并',async p=>{
  await p.evaluate(()=>{V18_TEST_HOOKS.aiReviewOutcomeByTask['T-201']='fail';});await start(p);await untilBlocked(p);
  const task=await p.evaluate(()=>devTaskById('T-201'));assert.equal(task.col,'review');assert.ok(task.pr.checks.every(x=>!x.checked));assert.ok(!task.pr.skipReason);
  assert.ok((await p.evaluate(()=>devAttentionModel())).needsHuman.some(x=>x.key==='task:T-201'));
  await p.evaluate(()=>prMerge(devTaskById('T-201').pr.id));assert.equal(await p.evaluate(()=>devTaskById('T-201').col),'review');
  await repairFirstTask(p,'aiReviewOutcomeByTask');
 });
 await test('runner启动失败保留批准并可恢复',async p=>{
  await prepare(p);
  await p.evaluate(()=>{const save=setInterval;window.setInterval=()=>{throw Error('V18_RUNNER_START_FAIL');};try{devApproveAndRun();}catch(e){}finally{window.setInterval=save;}});
  const failed=await p.evaluate(()=>({run:S.dev.autopilot.run,auth:S.dev.autopilot.authorization,approved:S.dev.plan.approved,started:S.dev.tasks.some(t=>t.col==='ing')}));
  assert.equal(failed.run.status,'blocked');assert.ok(failed.approved);assert.equal(failed.auth.status,'active');assert.equal(failed.started,false);
  assert.match(JSON.stringify(failed.run.blocker),/RUNNER_START_FAILED/);
  const before=await facts(p);await p.evaluate(token=>devAutopilotTick(token),failed.run.runToken);assert.equal(await facts(p),before);
  await p.evaluate(()=>devAutoResume());await p.clock.runFor(2000);
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.run.runToken),failed.run.runToken);
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'running');assert.ok(await p.evaluate(()=>S.dev.tasks.some(t=>t.prog>0)));
 });
 await test('runner失败记录再遇审计异常仍有恢复入口',async p=>{
  await prepare(p);
  await p.evaluate(()=>{const interval=setInterval,audit=devAudit;window.setInterval=()=>{throw Error('V18_RUNNER_FAIL');};devAudit=function(...args){if(/(?:autopilot|runner).*start.*fail/i.test(args[0]))throw Error('V18_START_FAILURE_AUDIT_FAIL');return audit(...args);};try{devApproveAndRun();}catch(e){}finally{window.setInterval=interval;devAudit=audit;}});
  assert.equal(await p.evaluate(()=>typeof devRecoverAutopilotStart),'function');
  await p.evaluate(()=>devRecoverAutopilotStart());
  if(await p.evaluate(()=>S.dev.autopilot.run.status==='blocked'))await p.evaluate(()=>devAutoResume());
  await p.clock.runFor(2000);assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'running');assert.ok(await p.evaluate(()=>S.dev.tasks.some(t=>t.prog>0)));
 });
 await test('停止后新准备可重新授权且历史收据保留',async p=>{
  await start(p);await p.clock.runFor(1600);
  const old=await p.evaluate(()=>({auth:S.dev.autopilot.authorization.authorizationId,run:S.dev.autopilot.run.runId,prep:S.dev.autopilot.preparation.currentRevisionId}));
  await p.evaluate(()=>devAutoStop());assert.equal(await p.evaluate(()=>S.dev.autopilot.authorization.status),'revoked');
  await p.evaluate(()=>devAutoResume());assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'stopped');
  await prepare(p);await p.evaluate(()=>devApproveAndRun());
  const next=await p.evaluate(()=>({auth:S.dev.autopilot.authorization.authorizationId,run:S.dev.autopilot.run.runId,prep:S.dev.autopilot.preparation.currentRevisionId,receipts:S.dev.autopilot.authorizationReceipts,runs:S.dev.autopilot.runReceipts}));
  assert.notEqual(next.auth,old.auth);assert.notEqual(next.run,old.run);assert.notEqual(next.prep,old.prep);
  assert.ok(next.receipts.some(x=>x.authorizationId===old.auth));assert.ok(next.runs.some(x=>x.runId===old.run));
  await p.evaluate(()=>devApproveAndRun());assert.equal(await p.evaluate(()=>S.dev.autopilot.authorization.authorizationId),next.auth);
  // 第二次准备已无需要物化的差异，停止后仍必须消费这份准备，不能依赖任务变化使它偶然过期。
  await p.evaluate(()=>devAutoStop());const stopped=await p.evaluate(()=>JSON.stringify(S.dev));
  await p.evaluate(()=>devApproveAndRun());assert.equal(await p.evaluate(before=>JSON.stringify(S.dev)===before,stopped),true,'已使用准备在停止后再次批准须零业务写入');
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'stopped');
  await prepare(p);await p.evaluate(()=>devApproveAndRun());
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.authorization.authorizationId),next.auth);
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.preparation.currentRevisionId),next.prep);await p.evaluate(()=>devAutoStop());
 });
 for(const fault of ['false','throw'])await test('派发'+fault+'只尝试一次并明确阻断',async p=>{
  await prepare(p);
  const result=await p.evaluate(fault=>{
   const original=devStart;let calls=0,escaped='';window.devStart=()=>{calls++;if(fault==='throw')throw Error('V18_DISPATCH_FAILURE');return false;};
   try{devApproveAndRun();const token=S.dev.autopilot.run.runToken;devAutopilotTick(token);devAutopilotTick(token);devAutopilotTick(S.dev.autopilot.run.runToken);}catch(e){escaped=e.message;}finally{window.devStart=original;}
   return {calls,escaped,run:S.dev.autopilot.run,started:S.dev.tasks.some(t=>t.col==='ing')};
  },fault);
  assert.equal(result.calls,1,'同一动作身份不能重复派发');assert.equal(result.escaped,'','异常要收敛为可处理的运行状态');
  assert.equal(result.run.status,'blocked');assert.equal(result.run.blocker?.code,'DISPATCH_NO_PROGRESS');
  assert.ok(result.run.lastDispatch);assert.equal(result.started,false);
  const frozen=await p.evaluate(()=>JSON.stringify(S.dev));await p.clock.runFor(2000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev)),frozen,'阻断后不能继续空转派发或审计');
 });
 await test('自动控制不取消人工单独启动的任务',async p=>{
  await start(p);await p.clock.runFor(1500);await p.evaluate(()=>devAutoPause());
  await p.evaluate(()=>devStart('T-202'));
  const before=await p.evaluate(()=>({op:S.dev.operations['task:T-202'],prog:devTaskById('T-202').prog}));
  assert.equal(before.op.status,'running');assert.ok(!before.op.autopilotRunId,'公开手动开始不归自动run所有');
  await p.evaluate(()=>{devAutoPause();devAutoTakeover();devAutoStop();});await p.clock.runFor(2000);
  assert.equal(await p.evaluate(()=>S.dev.operations['task:T-202'].status),'running');
  assert.ok((await p.evaluate(()=>devTaskById('T-202').prog))>before.prog,'保留非本run任务的真实心跳');
 });
 await test('自动暂停不取消运行期间人工启动的单测',async p=>{
  await start(p);await p.evaluate(()=>devStart('T-202'));await p.clock.runFor(12000);
  assert.equal(await p.evaluate(()=>devTaskById('T-202').prog),100);
  await p.evaluate(()=>{devSubmitReview('T-202');runTaskUt('T-202');});
  const op=await p.evaluate(()=>S.dev.operations['quality:T-202']);
  assert.equal(op.status,'running');assert.ok(!op.autopilotRunId,'存在自动run不能代替本次单测的实际派发来源');
  await p.evaluate(()=>devAutoPause());await p.clock.runFor(1200);
  const result=await p.evaluate(()=>({op:S.dev.operations['quality:T-202'],unit:devTaskById('T-202').evidence.unit,ci:devTaskById('T-202').evidence.ci}));
  assert.equal(result.op.runId,op.runId);assert.equal(result.op.status,'done');assert.equal(result.unit.status,'pass');assert.equal(result.ci.status,'pass');
 });
 await test('上游返工自动合并闭环影响且只构建一次',async p=>{
  await p.evaluate(()=>{S.design.docs.mod._finalizationSeq++;impactTrigger('mod');});
  await refreshDesignBaseline(p); // 新上游须重新核对共同设计基线，旧批准不能旁路。
  const rows=await p.evaluate(()=>S.dev.impacts.map(i=>({id:i.dispositionId,task:i.task})));
  assert.ok(rows.some(r=>r.task==='T-201'));
  for(const row of rows)await p.evaluate(row=>{const action=row.task==='T-201'?'rework':'unaffected';devSetImpact(row.id,action);document.querySelector('#v17-impact-reason').value=action==='rework'?'当前输入变化，重新实现首页相关契约':'已核对，当前输入变化不影响此任务';devApplyImpact(row.id,action);},row);
  await p.evaluate(()=>{devConfirmBaseline();window.v18BuildCalls=0;const original=runIntegrationBuild;window.runIntegrationBuild=function(...args){window.v18BuildCalls++;return original.apply(this,args);};});
  await start(p);
  for(let i=0;i<110;i++){if(await p.evaluate(()=>S.dev.autopilot.run.status==='awaiting-transfer'))break;await p.clock.runFor(5000);const closed=await p.evaluate(()=>({done:devTaskById('T-201').col==='done',status:S.dev.impacts.find(i=>i.task==='T-201')?.status}));if(closed.done)assert.equal(closed.status,'remediation-complete','合法自动合并时即闭环返工影响');}
  const result=await p.evaluate(()=>({status:S.dev.autopilot.run.status,impact:S.dev.impacts.find(i=>i.task==='T-201'),pr:devTaskById('T-201').pr,gate:devTransferGate(S.dev,'pj1'),buildCalls:window.v18BuildCalls}));
  assert.equal(result.impact.status,'remediation-complete');assert.ok(result.impact.remediatedBy);
  assert.equal(result.pr.status,'merged');assert.equal(result.pr.mergeBasis.kind,'autopilot-authorization');
  assert.equal(result.status,'awaiting-transfer');assert.equal(result.gate.ok,true);assert.equal(result.buildCalls,1);
  await p.clock.runFor(5000);assert.equal(await p.evaluate(()=>window.v18BuildCalls),1,'等待交接期间不反复构建');
 });
 const report={ok:checks.length>0&&checks.every(x=>x.ok),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/autopilot-boundary.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser.close();if(!report.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
