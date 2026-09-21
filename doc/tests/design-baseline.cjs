const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {enterDesign,generateDesign,checkDesign}=require('./design-helpers.cjs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../design-catalog.json'),'utf8'));
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const p=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];p.setDefaultTimeout(2500);
  p.on('pageerror',e=>errors.push(e.message));await p.goto(url);await enterDesign(p);
  try{await fn(p);assert.deepEqual(errors,[]);checks.push({name,ok:true});}
  catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}
 }
 await test('初始缺少完整设计基线不能直接进入开发',async p=>{
  assert.equal(await p.evaluate(()=>typeof designPrototypeGate),'function');
  assert.equal(await p.getByTestId('prototype-workbench').isVisible(),true);
  assert.equal(await p.getByTestId('prototype-plan').isVisible(),true);
  assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),false);
  const before=await p.evaluate(()=>JSON.stringify(S.proto));
  await p.evaluate(()=>designFinalizePrototypeBaseline());
  assert.equal(await p.evaluate(()=>JSON.stringify(S.proto)),before,'未生成/检查时不假定稿');
 });
 await test('识别规划不写原型且页面流程可查看',async p=>{
  const before=await p.evaluate(()=>JSON.stringify(S.proto));
  await p.getByTestId('prototype-plan').click();await p.clock.runFor(1800);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.proto)),before,'规划不写原型或定稿事实');
  const plan=await p.evaluate(()=>S.design.prototype.plans.find(x=>x.planId===S.design.prototype.currentPlanId));
  assert.ok(plan,'有不可变规划快照');
  assert.equal(await p.getByTestId('prototype-page-list').isVisible(),true);
  for(const page of catalog.pages)assert.equal(await p.getByTestId('prototype-page-'+page.id).count(),1,'目录可定位 '+page.id);
 });
 await test('完整生成检查定稿形成共同版本基线',async p=>{
  await generateDesign(p);
  assert.equal(await p.evaluate(()=>S.proto.finalized),false,'生成不会代人定稿');
  assert.equal(await p.evaluate(()=>designPrototypeGate('finalize').ok),false,'没有检查不能定稿');
  await checkDesign(p);
  assert.equal(await p.evaluate(()=>designPrototypeGate('finalize').ok),true);
  const reports=await p.evaluate(()=>JSON.stringify(S.design.prototype.checkReports));
  assert.equal(await p.evaluate(()=>!!designFinalizePrototypeBaseline()),true);
  assert.equal(await p.evaluate(()=>S.proto.finalized),true);
  assert.ok(await p.evaluate(()=>S.design.prototype.currentBaselineId));
  assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),true);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.design.prototype.checkReports)),reports,'定稿不改历史检查');
  assert.equal(await p.getByTestId('prototype-baseline-current').isVisible(),true);
 });
 await test('检查后同版本原型内容变化拒绝旧定稿',async p=>{
  await generateDesign(p);await checkDesign(p);
  const before=await p.evaluate(()=>({cur:S.proto.cur,reports:JSON.stringify(S.design.prototype.checkReports)}));
  await p.evaluate(()=>{executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- 人工尚未重新核查的修改 -->'}});});
  assert.equal(await p.evaluate(()=>S.proto.cur),before.cur);
  assert.equal(await p.evaluate(()=>designPrototypeGate('finalize').ok),false);
  await p.evaluate(()=>designFinalizePrototypeBaseline());
  assert.equal(await p.evaluate(()=>S.proto.finalized),false);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.design.prototype.checkReports)),before.reports);
 });
 await test('上游同版本内容变化使共同基线失效',async p=>{
  await generateDesign(p);await checkDesign(p);await p.evaluate(()=>designFinalizePrototypeBaseline());
  const frozen=await p.evaluate(()=>JSON.stringify(S.design.prototype.baselines));
  await p.evaluate(()=>{curVer(S.design.docs.api).secs[0].md+='\n新增需要重新确认的接口约束';});
  assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),false);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.design.prototype.baselines)),frozen,'历史基线保持原样');
 });
 await test('未知上传内容不能借完整目录通过检查',async p=>{
  await generateDesign(p);
  await p.evaluate(()=>{executePrototypeCommand({type:'save-html',payload:{html:'<!doctype html><html><body><h1>只有首页</h1></body></html>'}});});
  await checkDesign(p);
  const gate=await p.evaluate(()=>designPrototypeGate('finalize'));
  assert.equal(gate.ok,false);assert.ok(gate.issues.length,'缺失内容有具体问题');
  await p.evaluate(()=>designFinalizePrototypeBaseline());assert.equal(await p.evaluate(()=>S.proto.finalized),false);
 });
 await test('旁项目不能改变客户设计基线',async p=>{
  await generateDesign(p);await checkDesign(p);
  await p.evaluate(()=>openProject('pj2'));
  const before=await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype}));
  await p.evaluate(()=>{designPlanPrototype();designGeneratePrototype();designCheckPrototype();designFinalizePrototypeBaseline();});await p.clock.runFor(6000);
  assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before);
 });
 await test('定稿审计失败不得留下部分批准',async p=>{
  await generateDesign(p);await checkDesign(p);
  const before=await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype}));
  await p.evaluate(()=>{const old=designAudit;designAudit=function(){throw new Error('设计审计故障');};try{designFinalizePrototypeBaseline();}catch{}finally{designAudit=old;}});
  assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before);
 });
 await browser.close();const result={ok:checks.every(x=>x.ok),checks};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/design-baseline.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
