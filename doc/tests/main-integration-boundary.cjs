const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {enterDesign,generateDesign,prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(4000);try{await p.goto(url);await fn(p);checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:String(e.stack).slice(0,2400)});}finally{await p.close();}}
 await test('全部上游readiness变化立即阻断旧规划与运行回调',async p=>{
  await enterDesign(p);await generateDesign(p);
  const rows=await p.evaluate(()=>{
   const rows=[],before=designPrototypeGoverningSnapshot().governingFingerprint;
   for(const [key,d] of [['prd',S.prd],...Object.entries(S.design.docs)])for(const kind of ['unlock','wrongFinalVersion','modified','pending']){
    const saved=JSON.parse(JSON.stringify(d));if(kind==='unlock')d.finalized=false;if(kind==='wrongFinalVersion')d.finalVer=-1;if(kind==='modified')d.modified=true;if(kind==='pending')d.pend=[{from:'x',to:'y'}];
    rows.push({key,kind,audit:designAuditCatalogAgainstSources().ok,gate:designPrototypeGate('generate').ok,changed:designPrototypeGoverningSnapshot().governingFingerprint!==before});
    Object.keys(d).forEach(k=>delete d[k]);Object.assign(d,saved);
   }
   return rows;
  });
  assert.equal(rows.length,36);assert.deepEqual(rows.filter(r=>r.audit||r.gate||!r.changed),[],JSON.stringify(rows));
  await p.evaluate(()=>designGeneratePrototype());const before=await p.evaluate(()=>JSON.stringify(S.proto));await p.evaluate(()=>{S.design.docs.api.finalized=false;});await p.clock.runFor(3000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.proto)),before,'解锁使旧生成回调无权写入');
 });
 await test('定稿原型各写入口拒绝且无操作时不解锁',async p=>{
  await enterDesign(p);await generateDesign(p);
  const rows=await p.evaluate(()=>{
   /* V1.9 草稿/历史重设计后，finalized 与 modified/pend 互斥（assertPrototypeWorkingState 不变式）；
      夹具须构造合法定稿态，各写入口应因已定稿静默拒绝而非触发不变式异常 */
   const p=S.proto;p.finalized=true;p.finalVer=p.cur;
   const editor=document.createElement('textarea');editor.id='proto-editor';editor.value='REPLACED';document.body.prepend(editor);
   const cases=[['save',()=>saveProtoEditor()],['undo',()=>protoUndo()],['redo',()=>protoRedo()],['switch',()=>switchProtoVer(99)],['commit',()=>commitProtoVer()],['accept',()=>acceptProtoPend()],['reject',()=>rejectProtoPend()],['generate',()=>designGeneratePrototype()],['legacy-generate',()=>genProto()]],rows=[];
   for(const [name,fn] of cases){const before=JSON.stringify({proto:S.proto,design:S.design.prototype});let error='';try{fn();}catch(e){error=e.message;}rows.push({name,unchanged:before===JSON.stringify({proto:S.proto,design:S.design.prototype}),error});}
   return rows;
  });assert.deepEqual(rows.filter(r=>!r.unchanged||r.error),[],JSON.stringify(rows));
 });
 await test('检查中原型写入先作废旧operation，审计失败整体回滚',async p=>{
  await enterDesign(p);await generateDesign(p);
  const old=await p.evaluate(()=>{designCheckPrototype();const old=JSON.parse(JSON.stringify(S.design.prototype.operation));document.querySelector('#proto-editor').value+='\n<!-- saved during check -->';saveProtoEditor();return old;});
  const now=await p.evaluate(()=>({op:S.design.prototype.operation,audit:S.design.prototype.audit}));
  assert.equal(now.op.status,'stale');assert.notEqual(now.op.opToken,old.opToken);assert.ok(now.audit.some(e=>e.action==='prototype.operation.stale'&&e.target===old.operationId));
  const before=await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype}));await p.clock.runFor(3000);assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before);
  await p.evaluate(()=>{const original=designAudit;designAudit=()=>{throw Error('WRITE_AUDIT_FAILED');};try{protoUndo();}catch{}finally{designAudit=original;}});
  assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before,'stale审计/内容写任一步失败均回滚');
 });
 await test('规划保存全部真实章节与目录目标的双向证据',async p=>{
  await enterDesign(p);await generateDesign(p);
  const trace=await p.evaluate(()=>{const plan=S.design.prototype.plans.find(x=>x.planId===S.design.prototype.currentPlanId);return {audit:plan.sourceAudit};});
  assert.equal(trace.audit.forward.length,45);assert.equal(trace.audit.reverse.length,209);
  for(const key of ['forward','reverse']){assert.deepEqual(trace.audit[key].map(({result,...row})=>row),JSON.parse(fs.readFileSync(path.resolve(__dirname,'../source-acceptance-rules.json'))).traceability[key]);assert.ok(trace.audit[key].every(row=>row.result==='pass'));}
  const reverse=new Map(trace.audit.reverse.map(row=>[row.targetId,row.sourceRefs]));
  for(const row of trace.audit.forward)for(const id of row.catalogTargets)assert.ok(reverse.get(id).includes(row.sourceRef));
  for(const row of trace.audit.reverse)for(const ref of row.sourceRefs)assert.ok(trace.audit.forward.find(x=>x.sourceRef===ref).catalogTargets.includes(row.targetId));
 });
 await test('参考样本和初稿上传两个真实通道可用且初稿作废旧检查',async p=>{
  await enterDesign(p);await generateDesign(p);
  const before=await p.evaluate(()=>({refs:S.proto.refs.length,versions:S.proto.versions.length}));
  await p.evaluate(()=>uploadProtoModal());await p.locator('input[name="up-mode"][value="ref"]').check();await p.evaluate(()=>doUploadProto());
  assert.deepEqual(await p.evaluate(()=>({refs:S.proto.refs.length,versions:S.proto.versions.length})),{refs:before.refs+1,versions:before.versions});
  const outcome=await p.evaluate(()=>{designCheckPrototype();const token=S.design.prototype.operation.opToken;uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;const ok=doUploadProto();return {ok,status:S.design.prototype.operation.status,rotated:S.design.prototype.operation.opToken!==token,versions:S.proto.versions.length};});
  assert.deepEqual(outcome,{ok:true,status:'stale',rotated:true,versions:before.versions+1});
 });
 if(!process.env.V19_SKIP_HEALTH){
 for(const phase of ['start','complete'])await test('自测控制故障可显式恢复且只派发一次新自测 '+phase,async p=>{
  await prepareDesign(p);
  await p.evaluate(phase=>{
   if(phase==='start'){const original=devStartSelfTest;let once=true;devStartSelfTest=function(...args){if(!once)return original.apply(this,args);once=false;const timer=window.setTimeout;window.setTimeout=function(cb,ms,...rest){if(ms===900)throw Error('INTEGRATION_START_FAILED');return timer(cb,ms,...rest);};try{return original.apply(this,args);}finally{window.setTimeout=timer;}};}
   else{const original=devAudit;let once=true;devAudit=function(action,...args){if(action==='selftest.complete'&&once){once=false;throw Error('INTEGRATION_COMPLETE_FAILED');}return original(action,...args);};}
  },phase);
  await startAuto(p);assert.equal(await finishAuto(p),'blocked');
  const failed=await p.evaluate(()=>({op:S.dev.operations.selftest,run:S.dev.autopilot.run,reports:S.dev.selftest.reports.length}));
  assert.equal(failed.op.status,'failed');assert.equal(failed.run.blocker.code,'SELFTEST_START_FAILED');assert.equal(failed.reports,0);assert.equal(failed.run.lastDispatch,null);
  assert.equal(await p.evaluate(()=>!!devAutoResume()),true);assert.equal(await finishAuto(p),'awaiting-transfer');
  const passed=await p.evaluate(()=>({op:S.dev.operations.selftest,reports:S.dev.selftest.reports.length,gate:devSelfTestGate().ok}));
  assert.notEqual(passed.op.opToken,failed.op.opToken);assert.equal(passed.reports,1);assert.equal(passed.gate,true);
  await p.evaluate(()=>devSetTop('quality'));
  assert.equal(await p.getByTestId('selftest-status').count(),1);
  await p.evaluate(()=>devOpenUiComparison(S.dev.selftest.currentReportId,'P-PUB-HOME','public-mobile','fallback'));
  assert.equal(await p.getByTestId('selftest-state-fallback').count(),1);
  for(const kind of ['prototype','build']){const frame=p.frameLocator('[data-testid="ui-compare-'+kind+'"]');await frame.locator('[data-prototype-page="P-PUB-HOME"] > [data-prototype-state="fallback"]').waitFor({state:'visible'});}
 });
 for(const unrelated of [false,true])await test('人工交接保留已停止或无关运行 '+unrelated,async p=>{
  await prepareDesign(p);await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');await p.evaluate(()=>{devAutoStop();devStartSelfTest();});await p.clock.runFor(2000);
  assert.equal(await p.evaluate(()=>devSelfTestGate().ok),true);
  if(unrelated)await p.evaluate(()=>commitDevAction('selftest.init','unrelated-history',()=>{S.dev.autopilot.run.status='paused';S.dev.autopilot.run.authorizationId='UNRELATED';S.dev.autopilot.authorization.authorizationId='UNRELATED';S.dev.autopilot.authorization.status='active';S.dev.autopilot.authorization.planSnapshotId='OTHER-PLAN';return true;}));
  const before=await p.evaluate(()=>JSON.stringify({run:S.dev.autopilot.run,auth:S.dev.autopilot.authorization}));assert.equal(await p.evaluate(()=>devTransferToTest()),true);
  assert.equal(await p.evaluate(()=>JSON.stringify({run:S.dev.autopilot.run,auth:S.dev.autopilot.authorization})),before);
 });
 }
 await browser.close();const result={ok:checks.length>0&&checks.every(x=>x.ok),profile:process.env.V19_SKIP_HEALTH?'non-health-only':'full',skipped:process.env.V19_SKIP_HEALTH?['selftest-start-recovery','selftest-complete-recovery','stopped-run-handoff','unrelated-run-handoff']:[],checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/main-integration-boundary.json'),JSON.stringify(result,null,2));if(!result.ok&&!fs.existsSync(path.resolve(__dirname,'../evidence/main-integration-boundary-red.json')))fs.writeFileSync(path.resolve(__dirname,'../evidence/main-integration-boundary-red.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
