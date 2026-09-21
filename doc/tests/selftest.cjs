const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../design-catalog.json'),'utf8'));
(async()=>{
 const browser=await launch(),checks=[];
 const evidenceDir=path.resolve(__dirname,process.env.V19_EVIDENCE_DIR||'../evidence');fs.mkdirSync(evidenceDir,{recursive:true});
 async function test(name,fn){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  console.log('SELFTEST START '+name);
  const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];p.setDefaultTimeout(3000);
  p.on('pageerror',e=>errors.push(e.message));await p.goto(url);
  try{await prepareDesign(p);await fn(p);assert.deepEqual(errors,[]);checks.push({name,ok:true});}
  catch(e){const diagnostic=await p.evaluate(()=>({run:S.dev.autopilot.run,selftest:S.dev.operations.selftest,gate:devSelfTestGate(S.dev),attention:devAttentionModel(),audit:S.dev.audit.slice(-15)})).catch(()=>null);checks.push({name,ok:false,error:e.message,diagnostic});}finally{await p.close();}
 }
 async function report(p){return p.evaluate(()=>S.dev.selftest.reports.find(x=>x.reportId===S.dev.selftest.currentReportId));}
 await test('构建前不能启动项目自测或生成通过报告',async p=>{
  await p.evaluate(()=>devSetTop('quality'));
  assert.equal(await p.getByTestId('selftest-summary').isVisible(),true,'开发自测是质量页默认入口');
  assert.equal(await p.getByTestId('selftest-start').isDisabled(),true,'尚未构建时入口明确禁用');
  const before=await p.evaluate(()=>JSON.stringify(S.dev));
  await p.evaluate(()=>devStartSelfTest());
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev)),before);
  assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),false);
 });
 await test('自动完整链生成四门报告并等待人工转测试',async p=>{
  await p.evaluate(()=>{window.__v19SavedDesignGenerator=v19CustomerPrototypeHTML;v19CustomerPrototypeHTML=()=>{throw Error('开发构建不能调用设计原型生成器来假装独立实现');};});
  await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');
  const r=await report(p);assert.equal(r.status,'pass');
  for(const gate of ['functional','integration','ui','review'])assert.equal(r.gates[gate].ok,true,gate);
  assert.equal(r.ui.pages.length,catalog.pages.length,'每个期望页面都有独立结果');
  assert.ok(r.ui.pages.every(x=>x.critical.ratio===1&&x.general.ratio>=0.95&&x.status==='pass'));
  for(const page of catalog.pages){
   const result=r.ui.pages.find(x=>x.pageId===page.id),expected=catalog.viewportProfiles.filter(x=>x.area===page.area).map(x=>x.id).sort();
   assert.deepEqual(result.viewports.map(x=>x.viewportId).sort(),expected,page.id+'的每个适用视口都要检查');
   assert.ok(result.viewports.every(x=>x.critical.total>0&&x.critical.ratio===1&&x.general.ratio>=0.95&&x.status==='pass'));
  }
  assert.equal(r.summary.testedPageViewports,r.summary.requiredPageViewports);
  assert.equal(r.summary.testedStates,r.summary.requiredStates);
  assert.equal(await p.evaluate(()=>!!S.dev.transfer),false);
  assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),true);
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),true);
  assert.notEqual(await p.evaluate(()=>S.dev.build.uiArtifact.html),await p.evaluate(()=>curProtoVer().html),'构建UI有独立工件');
  await p.evaluate(()=>devSetTop('quality'));
  assert.equal(await p.getByTestId('selftest-summary').isVisible(),true);
  for(const gate of ['functional','integration','ui','review'])assert.equal(await p.getByTestId('selftest-gate-'+gate).isVisible(),true,gate+'结论可见');
  assert.equal(await p.getByTestId('selftest-export').isEnabled(),true,'报告可从页面导出');
  const cdp=await p.context().newCDPSession(p),shot=await cdp.send('Page.captureScreenshot',{format:'png'});await cdp.detach();
  fs.writeFileSync(path.join(evidenceDir,'selftest-report-1440.png'),Buffer.from(shot.data,'base64'));
  const frozen=JSON.stringify(r);
  await p.evaluate(()=>devTransferToTest());
  assert.ok(await p.evaluate(()=>S.dev.transfer));
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'transferred');
  assert.ok((await p.evaluate(()=>JSON.stringify(S.dev.transfer))).includes(r.reportId),'交接带当前报告');
  assert.equal(JSON.stringify(await report(p)),frozen,'交接不修改报告');
 });
 await test('功能通过但单页UI失败仍阻断且不能空重跑',async p=>{
  await p.evaluate(id=>{V19_TEST_HOOKS.uiOutcomeByPage[id]='fail';},catalog.pages[0].id);
  await startAuto(p);assert.equal(await finishAuto(p),'blocked');
  const r=await report(p);assert.equal(r.gates.functional.ok,true);assert.equal(r.gates.ui.ok,false);assert.equal(r.status,'fail');
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),false);
  assert.ok((await p.evaluate(()=>JSON.stringify(devAttentionModel().needsHuman))).includes(catalog.pages[0].id),'UI问题可从关注列表定位');
  const before=await p.evaluate(()=>JSON.stringify(S.dev.selftest));
  await p.evaluate(()=>{V19_TEST_HOOKS.uiOutcomeByPage={};devRetestSelfTest('仅移除故障注入，没有修复或新构建');devStartSelfTest();});
  await p.clock.runFor(6000);assert.equal(await p.evaluate(()=>JSON.stringify(S.dev.selftest)),before,'清hook或填理由不能制造新通过结果');
  const operations=await p.evaluate(()=>S.dev.audit.filter(x=>String(x.action||'').includes('selftest')).length);
  await p.clock.runFor(20000);assert.equal(await p.evaluate(()=>S.dev.audit.filter(x=>String(x.action||'').includes('selftest')).length),operations,'失败不会无限重跑');
 });
 await test('UI失败经实质返工与新构建后产生关联复测报告',async p=>{
  await p.evaluate(()=>{V19_TEST_HOOKS.uiOutcomeByPage['P-PUB-HOME']='fail';});
  await startAuto(p);assert.equal(await finishAuto(p),'blocked');
  const failed=await report(p),frozen=JSON.stringify(failed);
  const old=await p.evaluate(()=>({codeRev:devTaskById('T-201').codeRev,commitId:devTaskById('T-201').pr.commitId,build:devBuildFingerprint(S.dev.build),auth:S.dev.autopilot.authorization.authorizationId}));
  await p.evaluate(()=>devBeginRework('T-201'));
  await p.locator('#v17-rework-reason').fill('修复首页移动布局偏差，保留批准设计与全部检查标准');
  await p.evaluate(()=>devConfirmRework('T-201'));
  assert.ok(await p.evaluate(rev=>devTaskById('T-201').codeRev>rev,old.codeRev),'生成实际任务代码新修订');
  await p.evaluate(()=>{V19_TEST_HOOKS.uiOutcomeByPage={};});
  await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');
  const passed=await report(p);
  assert.equal(passed.status,'pass');assert.notEqual(passed.reportId,failed.reportId);
  assert.equal(passed.retestOfReportId||passed.operation.retestOfReportId,failed.reportId,'复测报告关联原始失败报告');
  assert.equal(passed.operation.dispatchAction,'selftest-retest');
  assert.notEqual(await p.evaluate(()=>devTaskById('T-201').pr.commitId),old.commitId);
  assert.notEqual(await p.evaluate(()=>devBuildFingerprint(S.dev.build)),old.build);
  assert.notEqual(await p.evaluate(()=>S.dev.autopilot.authorization.authorizationId),old.auth);
  assert.equal(await p.evaluate(id=>JSON.stringify(S.dev.selftest.reports.find(x=>x.reportId===id)),failed.reportId),frozen,'真实复测也不得覆盖失败历史');
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),true);
 });
 for(const outcome of ['skipped','not-run'])await test('UI '+outcome+' 不能算已测或通过',async p=>{
  await p.evaluate(({id,outcome})=>{V19_TEST_HOOKS.uiOutcomeByPage[id]=outcome;},{id:catalog.pages[0].id,outcome});
  await startAuto(p);assert.equal(await finishAuto(p),'blocked');const r=await report(p);
  assert.equal(r.gates.ui.ok,false);assert.equal(r.status,'fail');
  const target=r.ui.pages.find(x=>x.pageId===catalog.pages[0].id);assert.notEqual(target.status,'pass');
  assert.ok(target.checks.some(x=>x.status===outcome),'报告如实显示未执行类型');
 });
 await test('暂停自测淘汰旧回调并以新operation继续',async p=>{
  await p.evaluate(()=>{const original=devStartSelfTest;let once=false;devStartSelfTest=function(...args){const value=original.apply(this,args);if(!once&&S.dev.operations.selftest?.status==='running'){once=true;window.__v19FirstSelftestToken=S.dev.operations.selftest.opToken;setTimeout(()=>devAutoPause(),0);}return value;};});
  await startAuto(p);
  for(let i=0;i<130;i++){if(await p.evaluate(()=>S.dev.autopilot.run.status==='paused'))break;await p.clock.runFor(6000);}
  assert.equal(await p.evaluate(()=>S.dev.autopilot.run.status),'paused');
  const reports=await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports));await p.clock.runFor(6000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.dev.selftest.reports)),reports,'暂停的旧回调不追加报告');
  await p.evaluate(()=>devAutoResume());assert.equal(await finishAuto(p),'awaiting-transfer');
  assert.notEqual((await report(p)).operation.opToken,await p.evaluate(()=>window.__v19FirstSelftestToken));
 });
 await test('已通过报告在上游同版本变化后立即失效',async p=>{
  await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');const frozen=JSON.stringify(await report(p));
  await p.evaluate(()=>{curVer(S.design.docs.ui).secs[0].md+='\n新增待确认布局约束';});
  assert.equal(await p.evaluate(()=>devSelfTestGate(S.dev).ok),false);
  assert.equal(await p.evaluate(()=>devTransferGate(S.dev,'pj1').ok),false);
  await p.evaluate(()=>devTransferToTest());assert.equal(await p.evaluate(()=>!!S.dev.transfer),false);
  assert.equal(JSON.stringify(await report(p)),frozen,'历史报告不随界面状态改写');
 });
 await browser.close();const result={ok:checks.every(x=>x.ok),checks};fs.writeFileSync(path.join(evidenceDir,'selftest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
