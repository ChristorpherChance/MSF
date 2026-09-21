const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {enterDesign,prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../design-catalog.json'),'utf8'));
const sourceHtml=fs.readFileSync(path.resolve(__dirname,'../msf-prototype.html'),'utf8');

(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn,options={}){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(options.timeout||4000);
  try{if(!options.noGoto)await page.goto(url);await fn(page);checks.push({name,ok:true});}
  catch(error){checks.push({name,ok:false,error:error&&error.stack||String(error)});}
  finally{await page.close();}
 }
 function writeEvidence(){
  const skipped=process.env.V19_SKIP_HEALTH?['健康报告重验operation、复测身份和完成异常恢复']:[];
  const result={ok:checks.length>0&&checks.every(x=>x.ok),profile:skipped.length?'quick-without-health':'full',candidate:path.basename(url),skipped,checks};
  const main=path.resolve(__dirname,'../evidence/contract-hardening.json');
  fs.writeFileSync(main,JSON.stringify(result,null,2));
  if(!result.ok)fs.writeFileSync(path.resolve(__dirname,'../evidence/contract-hardening-red.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
 }

 await test('静态来源规则拒绝在启动前已被替换的正文',async page=>{
  const anchor=sourceHtml.includes('const V19_APPROVED_SOURCE_RULES')?'const V19_APPROVED_SOURCE_RULES':'const V19_APPROVED_SOURCE_SPEC';
  assert.ok(sourceHtml.includes(anchor),'候选必须公开静态来源规则入口');
  const poison="curVer(S.design.docs.mod).secs.find(function(s){return s.id==='o6';}).md='启动前已被替换的无约束正文，所有角色均可执行所有操作。';\n";
  const altered=sourceHtml.replace(anchor,poison+anchor);
  assert.notEqual(altered,sourceHtml);
  await page.setContent(altered,{waitUntil:'load',timeout:15000});
  const audit=await page.evaluate(()=>designAuditCatalogAgainstSources());
  assert.equal(audit.ok,false,'待测当前正文不能在同一次启动中自封为批准来源');
  assert.ok(audit.issues.some(x=>/SOURCE_/.test(x.code)),JSON.stringify(audit.issues));
 },{noGoto:true,timeout:16000});

 await test('规划显式物化全部非UI承接及需求反查',async page=>{
  await enterDesign(page);await page.evaluate(()=>designPlanPrototype());await page.clock.runFor(1800);
  const result=await page.evaluate(()=>{
   const plan=S.design.prototype.plans.find(x=>x.planId===S.design.prototype.currentPlanId);
   return {complete:plan&&plan.complete,nonUiCoverage:plan&&plan.nonUiCoverage,requirementCoverage:plan&&plan.requirementCoverage};
  });
  assert.equal(result.complete,true);
  assert.ok(Array.isArray(result.nonUiCoverage),'plan.nonUiCoverage 必须是冻结计划事实');
  assert.deepEqual(result.nonUiCoverage.map(x=>x.id).sort(),catalog.nonUiCoverage.map(x=>x.id).sort());
  assert.ok(result.nonUiCoverage.every(x=>Array.isArray(x.reqIds)&&x.reqIds.length>0),'每个非UI事实都必须关联需求');
  assert.ok(result.requirementCoverage.every(x=>Array.isArray(x.nonUiCoverageIds)),'每个需求覆盖行都必须保存非UI反查');
  assert.deepEqual([...new Set(result.requirementCoverage.flatMap(x=>x.nonUiCoverageIds))].sort(),catalog.nonUiCoverage.map(x=>x.id).sort());
 });

 await test('删除一个非UI事实及其目录侧引用仍须fail closed',async page=>{
  await page.clock.install();
  const result=await page.evaluate(()=>{
   openProject('pj1');
   const index=V19_DESIGN_CATALOG.nonUiCoverage.findIndex(x=>x.id==='NUI-001');
   if(index>=0)V19_DESIGN_CATALOG.nonUiCoverage.splice(index,1);
   const audit=designAuditCatalogAgainstSources();
   designPlanPrototype();
   return {had:index>=0,audit,operation:S.design.prototype.operation&&{status:S.design.prototype.operation.status,dispatchAction:S.design.prototype.operation.dispatchAction}};
  });
  assert.equal(result.had,true);
  assert.equal(result.audit.ok,false,'删除期望侧与其全部可遍历引用不能缩小已批准范围');
  assert.ok(result.audit.issues.some(x=>['SOURCE_CATALOG_CHANGED','SOURCE_NON_UI_UNVERIFIED','SOURCE_UNVERIFIED','CATALOG_SEMANTIC_UNVERIFIED'].includes(x.code)),JSON.stringify(result.audit.issues));
  await page.clock.runFor(1800);
  assert.equal(await page.evaluate(()=>designPrototypeGate('generate').ok),false,'目录范围变化不能进入生成');
 });

 await test('build manifest逐项归属且fingerprint绑定计划与代码修订',async page=>{
  const result=await page.evaluate(()=>{
   openProject('pj1');
   commitDevAction('selftest.init','contract-build',()=>{S.dev.plan.approved={taskIds:[],snapshotId:'PLAN-SNAPSHOT-A'};return true;});
   const build={ownerProjectId:'pj1',status:'pass',buildId:'BUILD-CONTRACT',baselineKey:'BL-X',sourceFingerprint:'PLAN-FP',planSnapshotId:'PLAN-SNAPSHOT-A',commits:[],taskRevisions:{},codeRevisions:{},evidenceIndex:{}};
   build.uiArtifact=v19CreateBuildUiArtifact(build);
   const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
   const mutate=(name,fn)=>{const copy=JSON.parse(JSON.stringify(build));fn(copy);copy.uiArtifact.manifestFingerprint=devHash(canonical(copy.uiArtifact.implementationManifest));const inspected=devInspectBuildUiArtifact(copy);return {name,ok:inspected.ok,issues:inspected.issues};};
   const cases=[
    mutate('pageIds',x=>x.uiArtifact.implementationManifest.pageIds.pop()),
    mutate('sourceTaskRevisions',x=>x.uiArtifact.implementationManifest.sourceTaskRevisions.GHOST=1),
    mutate('sourceCodeRevisions',x=>x.uiArtifact.implementationManifest.sourceCodeRevisions.GHOST=1),
    mutate('commits',x=>x.uiArtifact.implementationManifest.commits.push('ghost-commit')),
    mutate('implementationSourceFingerprint',x=>x.uiArtifact.implementationManifest.implementationSourceFingerprint='fp-wrong'),
    mutate('verificationCertificate',x=>x.uiArtifact.implementationManifest.verificationCertificate='V19-WRONG')
   ];
   const planChanged=JSON.parse(JSON.stringify(build));planChanged.planSnapshotId='PLAN-SNAPSHOT-B';
   const codeChanged=JSON.parse(JSON.stringify(build));codeChanged.codeRevisions={GHOST:2};
   return {base:devInspectBuildUiArtifact(build),cases,planFingerprintChanged:devBuildFingerprint(planChanged)!==devBuildFingerprint(build),codeFingerprintChanged:devBuildFingerprint(codeChanged)!==devBuildFingerprint(build)};
  });
  assert.equal(result.base.ok,true,JSON.stringify(result.base.issues));
  assert.deepEqual(result.cases.filter(x=>x.ok),[],JSON.stringify(result.cases));
  assert.equal(result.planFingerprintChanged,true,'build fingerprint 必须绑定批准 snapshot');
  assert.equal(result.codeFingerprintChanged,true,'build fingerprint 必须绑定独立代码修订');
 });

 await test('DevStore拒绝改写历史报告并回滚',async page=>{
  const result=await page.evaluate(()=>{
   openProject('pj1');
   commitDevAction('selftest.complete','R-SEED',()=>{S.dev.selftest={currentReportId:'R-SEED',nextReport:2,reports:[{reportId:'R-SEED',status:'pass',nested:{value:1}}]};return true;});
   const before=JSON.stringify(S.dev.selftest),auditBefore=JSON.stringify(S.dev.audit);let error='';
   try{commitDevAction('selftest.init','mutate-history',()=>{S.dev.selftest.reports[0].nested.value=2;return true;});}catch(e){error=String(e.message||e);}
   return {before,after:JSON.stringify(S.dev.selftest),auditBefore,auditAfter:JSON.stringify(S.dev.audit),error};
  });
  assert.ok(result.error,'历史改写事务必须被不变量拒绝');
  assert.equal(result.after,result.before);assert.equal(result.auditAfter,result.auditBefore);
 });

 await test('DevStore拒绝原地改写同buildId并回滚',async page=>{
  const result=await page.evaluate(()=>{
   openProject('pj1');
   commitDevAction('build.complete','BUILD-SEED',()=>{S.dev.build={buildId:'BUILD-SEED',status:'pass',uiArtifact:{html:'<html>A</html>',htmlFingerprint:'A',implementationManifest:{pageIds:[]},manifestFingerprint:'M'}};return true;});
   const before=JSON.stringify(S.dev.build),auditBefore=JSON.stringify(S.dev.audit);let error='';
   try{commitDevAction('selftest.init','mutate-build',()=>{S.dev.build.uiArtifact.html='<html>B</html>';S.dev.build.uiArtifact.htmlFingerprint='B';return true;});}catch(e){error=String(e.message||e);}
   return {before,after:JSON.stringify(S.dev.build),auditBefore,auditAfter:JSON.stringify(S.dev.audit),error};
  });
  assert.ok(result.error,'completed build 同身份改写必须被不变量拒绝');
  assert.equal(result.after,result.before);assert.equal(result.auditAfter,result.auditBefore);
 });

 await test('精确legacy checklist与skip可只读派生',async page=>{
  const result=await page.evaluate(()=>{
   openProject('pj1');
   const clone=x=>JSON.parse(JSON.stringify(x));
   function tuple(pr,task){return {prId:pr.id,taskId:task.id,taskRev:task.rev,codeRev:task.codeRev,commitId:pr.commitId,headRevision:pr.headRevision};}
   function fixture(kind){
    const checks=[{id:'security',label:'安全核对',checked:kind==='checklist'},{id:'copy',label:'文案核对',checked:kind==='checklist'}];
    const pr={id:'PR-LEGACY-'+kind,taskId:'T-LEGACY-'+kind,commitId:'commit-'+kind,headRevision:7,status:'merged',checks:clone(checks),skipReason:kind==='skip'?'历史人工确认跳过文案项':''};
    const task={id:pr.taskId,rev:4,codeRev:3,col:'done',pr:clone(pr)},identity=tuple(pr,task);
    const merge=Object.assign({eventId:'AUD-MERGE-'+kind,action:'pr.merge',target:pr.id,actor:'superopen',at:'2026-09-06 12:00'},identity);
    const decision=kind==='skip'?[Object.assign({eventId:'AUD-SKIP',action:'pr.manual.skip',target:pr.id,actor:'superopen',at:'2026-09-06 11:59',skipReason:pr.skipReason},identity)]:checks.map((_,i)=>Object.assign({eventId:'AUD-CHECK-'+i,action:'pr.manual.check',target:pr.id,actor:'superopen',at:'2026-09-06 11:5'+i,checklistSnapshot:clone(checks)},identity));
    return {pr,dev:{ownerProjectId:'pj1',tasks:[task],prs:[clone(pr)],audit:[merge].concat(decision),autopilot:{authorizationReceipts:[]},aiReviews:[]}};
   }
   const valid=['checklist','skip'].map(kind=>{const f=fixture(kind),before=JSON.stringify(f.dev),resolved=devResolveMergeBasis(f.pr,f.dev);return {kind,resolved,unchanged:JSON.stringify(f.dev)===before};});
   const missingHead=fixture('checklist');missingHead.dev.audit.forEach(e=>delete e.headRevision);
   const wrongCommit=fixture('skip');wrongCommit.dev.audit.forEach(e=>e.commitId='other-commit');
   return {valid,missingHead:devResolveMergeBasis(missingHead.pr,missingHead.dev),wrongCommit:devResolveMergeBasis(wrongCommit.pr,wrongCommit.dev)};
  });
  for(const item of result.valid){assert.equal(item.resolved.ok,true,item.kind+': '+JSON.stringify(item.resolved));assert.equal(item.resolved.basis.kind,'legacy-manual');assert.equal(item.unchanged,true,'legacy派生不得回写输入');}
  assert.ok(result.valid.find(x=>x.kind==='checklist').resolved.basis.sourceAuditEventIds.length>=3);
  const skip=result.valid.find(x=>x.kind==='skip').resolved.basis.skipReceipt;
  assert.deepEqual(Object.keys(skip).sort(),['actor','at','auditEventId','reason'].sort());
  assert.equal(result.missingHead.ok,false,'缺 head 身份不得猜测 legacy');
  assert.equal(result.wrongCommit.ok,false,'错误 commit 身份不得猜测 legacy');
 });

 if(!process.env.V19_SKIP_HEALTH)await test('健康报告重验operation、复测身份和完成异常恢复',async page=>{
  await prepareDesign(page);await startAuto(page);assert.equal(await finishAuto(page),'awaiting-transfer');
  const initial=await page.evaluate(()=>{
   const current=S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId),taskIds=S.dev.plan.approved.taskIds.slice(),checks=current.checks||[];
   const requiredIntegration=['integration-portal-content','integration-application','integration-cms-publish','integration-search-opendata'];
   return {taskIds,requiredIntegration,checkIds:checks.map(x=>x.id),missingTaskChecks:taskIds.flatMap(id=>['functional-unit-'+id,'functional-ci-'+id,'functional-coverage-'+id].filter(checkId=>!checks.some(x=>x.id===checkId))),missingIntegration:requiredIntegration.filter(checkId=>!checks.some(x=>x.id===checkId))};
  });
  assert.deepEqual(initial.missingTaskChecks,[],'报告必须显式保存各任务 unit/CI/coverage 必测证据');
  assert.deepEqual(initial.missingIntegration,[],'报告必须显式保存四组联调与冒烟');

  const opTamper=await page.evaluate(()=>{
   const copy=JSON.parse(JSON.stringify(S.dev)),report=copy.selftest.reports.find(x=>x.reportId===copy.selftest.currentReportId),canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
   report.operation.owner=report.operation.owner==='manual'?'autopilot':'manual';const raw=JSON.parse(JSON.stringify(report));delete raw.reportFingerprint;report.reportFingerprint=devHash(canonical(raw));
   return devSelfTestGate(copy);
  });
  assert.equal(opTamper.ok,false,'重算报告hash不能掩盖producing operation不一致');

  const retest=await page.evaluate(()=>{
   let value={available:typeof devCanRetestSelfTest==='function'},error='';
   try{commitDevAction('selftest.init','synthetic-old-failure',()=>{
    const r=S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId),canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
    r.status='fail';r.gates.ui.ok=false;r.basedOn.buildFingerprint='fp-prior';r.basedOn.taskRevisions=Object.fromEntries(Object.entries(r.basedOn.taskRevisions||{}).map(([k,v])=>[k,Number(v)-1]));r.basedOn.codeRevisions=Object.fromEntries(Object.entries(r.basedOn.codeRevisions||{}).map(([k,v])=>[k,Number(v)-1]));r.basedOn.commits=['prior-commit'];
    const raw=JSON.parse(JSON.stringify(r));delete raw.reportFingerprint;r.reportFingerprint=devHash(canonical(raw));
    value.sameBuildAllowed=typeof devCanRetestSelfTest==='function'&&devCanRetestSelfTest();
    r.basedOn.buildId='BUILD-OLDER-RECEIPT';const raw2=JSON.parse(JSON.stringify(r));delete raw2.reportFingerprint;r.reportFingerprint=devHash(canonical(raw2));
    value.newBuildAllowed=typeof devCanRetestSelfTest==='function'&&devCanRetestSelfTest();value.html=v19SelftestHtml();throw Error('ROLLBACK-SYNTHETIC');
   });}catch(e){error=String(e.message||e);}
   return Object.assign(value,{error,currentBuildId:S.dev.build.buildId});
  });
  assert.equal(retest.available,true,'需要独立、公开的复测资格判断');
  assert.equal(retest.sameBuildAllowed,false,'同buildId不能被包装成修复证据');
  assert.equal(retest.newBuildAllowed,true,'真实新build identity且有实质变化时复测可达');
  assert.ok(!/data-testid="selftest-retest" disabled/.test(retest.html),'页面复测按钮应使用复测资格而非首次启动资格');

  await page.evaluate(()=>{window.__contractOriginalAudit=devAudit;devAudit=function(action){if(action==='selftest.complete')throw Error('CONTRACT_COMPLETE_AUDIT');return window.__contractOriginalAudit.apply(this,arguments);};devStartSelfTest();});
  try{await page.clock.runFor(1800);}catch{}
  const recovered=await page.evaluate(()=>{devAudit=window.__contractOriginalAudit;delete window.__contractOriginalAudit;return {status:S.dev.operations.selftest&&S.dev.operations.selftest.status,gate:devSelfTestGate(S.dev),canStart:devCanStartSelfTest(),currentReportId:S.dev.selftest.currentReportId};});
  assert.notEqual(recovered.status,'running','完成事务异常不能留下永久busy operation');
  assert.equal(recovered.gate.ok,false,'新操作失败后不能回落到旧pass报告');
  assert.equal(recovered.canStart,true,'异常终态必须保留可达恢复入口');
 },{timeout:8000});

 await browser.close();writeEvidence();
})().catch(error=>{console.error(error);process.exitCode=1;});
