const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.setDefaultTimeout(3000);
  try{await p.goto(url);await prepareDesign(p);await fn(p);checks.push({name,ok:true});}
  catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}
 }
 async function pass(p){await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');}
 await test('报告删检查或替换依据不可放行且无失败不得关联复测',async p=>{
  await pass(p);
  const result=await p.evaluate(()=>{
   const mutations={
    emptyChecks:r=>{r.ui.pages[0].viewports[0].checks=[];},
    duplicateCheck:r=>{const v=r.ui.pages[0].viewports[0];v.checks.push({...v.checks[0]});},
    wrongBaseline:r=>{r.basedOn.designBaselineId='DESIGN-BL-NOT-CURRENT';},
    missingBasedOn:r=>{r.basedOn={};},
    changedOutcome:r=>{r.ui.pages[0].viewports[0].checks[0].status='not-run';},
    extraPage:r=>{r.ui.pages.push({...r.ui.pages[0],pageId:'P-UNAPPROVED'});}
   };
   const gates=Object.entries(mutations).map(([name,mutate])=>{const copy=JSON.parse(JSON.stringify(S.dev)),report=copy.selftest.reports.find(r=>r.reportId===copy.selftest.currentReportId);mutate(report);return {name,ok:devSelfTestGate(copy).ok};});
   const before=JSON.stringify(S.dev),started=!!devRetestSelfTest('无历史失败的错误关联复测');
   return {gates,started,unchanged:JSON.stringify(S.dev)===before};
  });
  assert.deepEqual(result.gates.filter(x=>x.ok),[],'报告身份、精确检查集合与结果须重验');
  assert.equal(result.started,false);assert.equal(result.unchanged,true);
 });
 await test('自测单飞且运行期间旧合格报告不能放行',async p=>{
  await pass(p);const history=await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports));
  await p.evaluate(()=>devStartSelfTest());
  assert.equal(await p.evaluate(()=>S.dev.operations.selftest.status),'running');
  assert.equal(await p.evaluate(()=>S.dev.operations.selftest.owner),'manual');
  assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),false);
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),false);
  const before=await p.evaluate(()=>JSON.stringify(S.dev));await p.evaluate(()=>devStartSelfTest());
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev)),before,'重复启动不覆盖operation或增加审计');
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports)),history);
  await p.clock.runFor(1800);assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),true);
 });
 await test('自测报告真实导出且绑定设计与构建',async p=>{
  await pass(p);const identity=await p.evaluate(()=>({report:S.dev.selftest.currentReportId,baseline:S.design.prototype.currentBaselineId,build:S.dev.build.buildId}));
  const promise=p.waitForEvent('download');await p.evaluate(id=>devExportSelfTestReport(id),identity.report);
  const download=await promise,content=fs.readFileSync(await download.path(),'utf8');
  for(const id of Object.values(identity))assert.ok(content.includes(id),'导出包含 '+id);
  assert.ok(content.includes('P-PUB-APPLICATION'));
 });
 await test('接管后人工自测及转测试耗尽旧自动授权',async p=>{
  await p.evaluate(()=>{const original=devStartSelfTest;let once=false;devStartSelfTest=function(...args){const value=original.apply(this,args);if(!once&&S.dev.operations.selftest?.status==='running'){once=true;setTimeout(()=>devAutoTakeover(),0);}return value;};});
  await startAuto(p);
  for(let i=0;i<130;i++){if(await p.evaluate(()=>S.dev.autopilot.run.status==='taken-over'))break;await p.clock.runFor(6000);}
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'taken-over');
  await p.evaluate(()=>devStartSelfTest());assert.equal(await p.evaluate(()=>S.dev.operations.selftest.owner),'manual');
  await p.clock.runFor(1800);assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),true);
  await p.evaluate(()=>devTransferToTest());
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'transferred');
  const after=await p.evaluate(()=>JSON.stringify(S.dev));await p.evaluate(()=>devAutoResume());await p.clock.runFor(12000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev)),after,'旧授权、tick和晚回调不能继续开发');
 });
 await test('自测启动审计失败零业务写入',async p=>{
  await pass(p);const before=await p.evaluate(()=>JSON.stringify(S.dev));
  await p.evaluate(()=>{const saved=devAudit;devAudit=()=>{throw Error('SELFTEST_START_AUDIT');};try{devStartSelfTest();}catch{}finally{devAudit=saved;}});
  await p.clock.runFor(1800);assert.equal(await p.evaluate(()=>JSON.stringify(S.dev)),before);
 });
 await test('实际候选HTML变化使旧自测报告失效',async p=>{
  await pass(p);const history=await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports));
  const result=await p.evaluate(()=>{
   const candidate=JSON.parse(JSON.stringify(S.dev));candidate.build.uiArtifact.html='<html><body>缺少所有客户业务页面</body></html>';
   return {changed:devBuildFingerprint(candidate.build)!==devBuildFingerprint(S.dev.build),selftest:devSelfTestGate(candidate).ok,transfer:devTransferGate(candidate,'pj1').ok};
  });
  assert.deepEqual(result,{changed:true,selftest:false,transfer:false},'门禁实时哈希原始内容，不能信任工件自报的旧hash');
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports)),history);
 });
 await test('只在移动视口关键项失败不能被桌面结果稀释',async p=>{
  await pass(p);
  const target=await p.evaluate(()=>{
   const r=S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId),page=r.ui.pages.find(x=>x.pageId==='P-PUB-HOME');
   const viewport=page.viewports.find(x=>x.viewportId==='public-mobile'),check=viewport.checks.find(x=>x.kind==='critical');
   return {pageId:page.pageId,viewportId:viewport.viewportId,checkId:check.id};
  });
  assert.ok(target.checkId);
  await p.evaluate(x=>{V19_TEST_HOOKS.uiOutcomeByCheck[x.pageId+':'+x.viewportId+':'+x.checkId]='fail';devStartSelfTest();},target);await p.clock.runFor(1800);
  const result=await p.evaluate(()=>S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId));
  assert.equal(result.status,'fail');assert.equal(result.gates.ui.ok,false);
  const page=result.ui.pages.find(x=>x.pageId===target.pageId);
  assert.notEqual(page.viewports.find(x=>x.viewportId===target.viewportId).status,'pass');
  assert.ok(page.viewports.filter(x=>x.viewportId!==target.viewportId).every(x=>x.status==='pass'),'其它视口独立存证');
  assert.ok(result.defects.some(x=>x.pageId===target.pageId&&x.viewportId===target.viewportId),'缺陷定位到具体视口');
 });
 for(const [label,selector] of [['状态','[data-prototype-state]'],['控件','[data-prototype-control]'],['字段','[data-prototype-field]']])await test('实际候选缺少'+label+'即使重算内容hash也检查失败',async p=>{
  await pass(p);
  const result=await p.evaluate(selector=>{
   const candidate=JSON.parse(JSON.stringify(S.dev.build)),doc=new DOMParser().parseFromString(candidate.uiArtifact.html,'text/html'),node=doc.querySelector(selector);
   if(!node)return {hadNode:false};
   const identity=node.getAttribute(selector.slice(1,-1)),pageId=node.closest('[data-prototype-page]')?.getAttribute('data-prototype-page');
   node.remove();candidate.uiArtifact.html='<!DOCTYPE html>'+doc.documentElement.outerHTML;
   candidate.uiArtifact.htmlFingerprint=devBuildIdentity(candidate).computedHtmlFingerprint;
   const inspected=devInspectBuildUiArtifact(candidate);
   return {hadNode:true,identity,pageId,ok:inspected.ok,issues:inspected.issues};
  },selector);
  assert.equal(result.hadNode,true,'独立构建UI必须包含真实'+label);
  assert.equal(result.ok,false,'检查必须观察实际'+label+'，而非只看page ID或缓存hash');
  assert.ok(result.issues?.length>0);
 });
 for(const group of ['functional','integration'])await test(group+'必测失败不能硬编码四门通过',async p=>{
  await pass(p);
  const checkId=await p.evaluate(group=>{
   const report=S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId);
   return report.checks.find(x=>x.group===group&&x.required)?.id;
  },group);
  assert.ok(checkId,group+'报告应有实际必测条目');
  await p.evaluate(id=>{V19_TEST_HOOKS.selftestOutcomeByCheck[id]='fail';devStartSelfTest();},checkId);await p.clock.runFor(1800);
  const report=await p.evaluate(()=>S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId));
  assert.equal(report.checks.find(x=>x.id===checkId).status,'fail');
  assert.equal(report.gates[group].ok,false);assert.equal(report.status,'fail');
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),false);
 });
 await browser.close();const result={ok:checks.every(x=>x.ok),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/selftest-boundary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
