const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url,pathToFileURL}=require('./browser.cjs');
const {enterDesign,generateDesign,checkDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const p=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});p.setDefaultTimeout(3000);
  try{await p.goto(url);await enterDesign(p);await fn(p);checks.push({name,ok:true});}
  catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}
 }
 await test('API示例澄清新增版本并保留旧版原文',async p=>{
  const legacy=await browser.newPage();let original;
  try{await legacy.goto(pathToFileURL(path.resolve(__dirname,'../../V1.8/msf-prototype.html')).href);original=await legacy.evaluate(()=>{openProject('pj1');return JSON.parse(JSON.stringify(S.design.docs.api.versions));});}finally{await legacy.close();}
  const current=await p.evaluate(()=>JSON.parse(JSON.stringify(S.design.docs.api)));
  assert.ok(current.versions.length>original.length,'澄清必须产生新版本，不能覆盖已有 v1');
  for(const version of original)assert.deepEqual(current.versions.find(v=>v.v===version.v),version,'已有版本内容和元数据保留');
  assert.ok(current.cur>Math.max(...original.map(v=>v.v)));assert.equal(current.finalVer,current.cur);
  const added=current.versions.find(v=>v.v===current.cur);
  assert.match(added.note,/澄清/);assert.ok(added.secs.some(s=>s.md.includes('workflowView')&&s.md.includes('allowedActions')));
 });
 await test('生成和编辑沿用治理依据不使自己的规划过期',async p=>{
  await generateDesign(p);
  const governing=await p.evaluate(()=>designPrototypeGoverningSnapshot().governingFingerprint);
  assert.equal(await p.evaluate(()=>designPrototypeGate('check').ok),true);
  const plan=await p.evaluate(()=>S.design.prototype.currentPlanId);
  await p.evaluate(()=>{if(!executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- 经人工核对的无语义格式编辑 -->'}}).committed||!commitProtoVer())throw Error('编辑提交夹具失败');});
  assert.equal(await p.evaluate(()=>S.design.prototype.currentPlanId),plan);
  assert.equal(await p.evaluate(()=>designPrototypeGoverningSnapshot().governingFingerprint),governing);
  assert.equal(await p.evaluate(()=>designPrototypeGate('check').ok),true);
  await checkDesign(p);assert.equal(await p.evaluate(()=>designPrototypeGate('finalize').ok),true);
 });
 await test('浏览页面和状态不改变设计内容身份',async p=>{
  await generateDesign(p);await checkDesign(p);await p.evaluate(()=>designFinalizePrototypeBaseline());
  const before=await p.evaluate(()=>JSON.stringify(designPrototypeFingerprint()));
  await p.evaluate(()=>{designSelectPrototypePage('P-PUB-APPLICATION','validation-error');S.chatCollapsed=true;render();});
  assert.equal(await p.evaluate(()=>JSON.stringify(designPrototypeFingerprint())),before);
  assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),true);
 });
 await test('新增未承接REQ不能被固定目录静默忽略',async p=>{
  await p.evaluate(()=>{curVer(S.prd).secs.find(x=>x.md.includes('REQ-001')).md+='\n| REQ-099 | 新增预约支付页面和退款流程 | 一期必需 |';});
  await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
  const gate=await p.evaluate(()=>designPrototypeGate('generate'));
  assert.equal(gate.ok,false);assert.ok(gate.issues.length);
  assert.equal(await p.evaluate(()=>S.proto.cur),0,'未知需求不自动编造界面');
 });
 await test('工作流接口来源删除不能借旧目录继续生成',async p=>{
  const removed=await p.evaluate(()=>{
   const secs=curVer(S.design.docs.api).secs;let count=0;
   for(const section of secs){const old=section.md;section.md=section.md.replace(/workflowView/g,'undefinedField').replace(/allowedActions/g,'undefinedCapabilities');if(old!==section.md)count++;}
   return count;
  });
  assert.ok(removed>0,'当前示例API有明确工作流来源');
  await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
  assert.equal(await p.evaluate(()=>designPrototypeGate('generate').ok),false);
 });
 for(const [docKey,sectionId] of Object.entries({hld:'h1',mod:'o6',alg:'g4',cls:'k0',db:'d0',api:'a0',ui:'u2',nfr:'n1'})){
  await test('语义来源被替换保留章节ID也须阻断 '+docKey,async p=>{
   await p.evaluate(({docKey,sectionId})=>{curVer(S.design.docs[docKey]).secs.find(s=>s.id===sectionId).md='本章不再有约束，所有角色可以执行所有操作；不要求鉴权、字段校验或流程。';},{docKey,sectionId});
   await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
   assert.equal(await p.evaluate(()=>designPrototypeGate('generate').ok),false,'章节存在不能自证语义一致 '+docKey);
  });
 }
 await test('既有REQ保留编号但内容变更不能静默通过',async p=>{
  await p.evaluate(()=>{for(const s of curVer(S.prd).secs){if(/REQ-\d+/.test(s.md))s.md=[...new Set(s.md.match(/REQ-\d+/g))].map(id=>id+'：变更为医疗预约与在线支付，需要新的支付和退款界面。').join('\n');}});
  await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
  assert.equal(await p.evaluate(()=>designPrototypeGate('generate').ok),false,'相同REQ编号不意味着原设计仍覆盖当前内容');
 });
 await test('新增未识别设计章节保留为待核对而非自动覆盖',async p=>{
  await p.evaluate(()=>{curVer(S.design.docs.ui).secs.push({id:'u-new',title:'新增审批界面',md:'所有开放数据下载必须由管理员逐项实名审批，新增审批列表与拒绝理由交互。'});});
  await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
  assert.equal(await p.evaluate(()=>designPrototypeGate('generate').ok),false);
 });
 await test('生成期间上游变化晚回调不能写入原型',async p=>{
  await p.evaluate(()=>designPlanPrototype());await p.clock.runFor(1800);
  await p.evaluate(()=>designGeneratePrototype());
  const before=await p.evaluate(()=>JSON.stringify(S.proto));
  await p.evaluate(()=>{curVer(S.design.docs.ui).secs[0].md+='\n变更布局要求';});await p.clock.runFor(4000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.proto)),before);
 });
 await test('生成期间人工改动原型晚回调不能覆盖新内容',async p=>{
  await generateDesign(p);
  await p.evaluate(()=>designGeneratePrototype());
  await p.evaluate(()=>{if(!executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- 生成期间的人工作品 -->'}}).committed)throw Error('编辑夹具失败');});
  const before=await p.evaluate(()=>JSON.stringify(S.proto));await p.clock.runFor(4000);
  assert.equal(await p.evaluate(()=>JSON.stringify(S.proto)),before);
 });
 await test('检查A期间编辑为B旧回调严格不追加报告或审计',async p=>{
  await generateDesign(p);
  await p.evaluate(()=>designCheckPrototype());
  await p.evaluate(()=>{if(!executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- 检查期间提交的新版本B -->'}}).committed||!commitProtoVer())throw Error('编辑提交夹具失败');});
  const before=await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype}));await p.clock.runFor(4000);
  assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before);
  assert.equal(await p.evaluate(()=>designPrototypeGate('finalize').ok),false);
 });
 await test('设计启动审计失败无operation或计数器部分写入',async p=>{
  const before=await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype}));
  await p.evaluate(()=>{const old=designAudit;designAudit=()=>{throw Error('DESIGN_START_AUDIT');};try{designPlanPrototype();}catch{}finally{designAudit=old;}});
  await p.clock.runFor(4000);
  assert.equal(await p.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype})),before);
 });
 await test('旧定稿入口不能绕过实际内容检查',async p=>{
  await generateDesign(p);await checkDesign(p);
  await p.evaluate(()=>{if(!executePrototypeCommand({type:'save-html',payload:{html:'<html><body>不完整原型</body></html>'}}).committed)throw Error('编辑夹具失败');doFinalProto();});
  assert.equal(await p.evaluate(()=>S.proto.finalized),false);
  assert.equal(await p.evaluate(()=>designPrototypeGate('develop').ok),false);
 });
 await test('共同基线导出为真实文件且包含当前身份',async p=>{
  await generateDesign(p);await checkDesign(p);await p.evaluate(()=>designFinalizePrototypeBaseline());
  const id=await p.evaluate(()=>S.design.prototype.currentBaselineId);
  const promise=p.waitForEvent('download');await p.evaluate(()=>designExportPrototypeBaseline());
  const download=await promise,content=fs.readFileSync(await download.path(),'utf8');
  assert.ok(content.includes(id));assert.ok(content.includes('P-PUB-HOME'));assert.ok(content.length>1000);
 });
 await browser.close();const result={ok:checks.every(x=>x.ok),checks};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/design-boundary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
