// 跨阶段效果：只检查真实设计/开发入口，不伪造共同基线或合格证书。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launch,url:defaultUrl,pathToFileURL}=require('./browser.cjs');
const {enterDesign,generateDesign,prepareDesign}=require('./design-helpers.cjs');
(async()=>{
 const candidate=process.env.V19_PROTOTYPE_CANDIDATE?path.resolve(process.env.V19_PROTOTYPE_CANDIDATE):path.resolve(__dirname,'../msf-prototype.html');
 const url=process.env.V19_PROTOTYPE_CANDIDATE?pathToFileURL(candidate).href:defaultUrl;
 const sourceSha256=crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
 const browser=await launch(),checks=[];
 async function test(name,fn){if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;const page=await browser.newPage({viewport:{width:1440,height:1000}});try{await page.goto(url);await fn(page);checks.push({name,ok:true});}catch(error){checks.push({name,ok:false,error:String(error.stack).slice(0,2200)});}finally{await page.close();}}
 await test('检查已启动后抛错恢复不得再次派发',async page=>{
  await enterDesign(page);await generateDesign(page);
  const before=await page.evaluate(()=>{
   const original=window.designCheckPrototype;window.__restoreCheck=original;window.__checkCalls=0;
   window.designCheckPrototype=function(...args){window.__checkCalls++;const result=original(...args);throw Error('CHECK_STARTED_THEN_THROW');};
   uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;doUploadProto();return S.design.prototype.nextOperation;
  });await page.clock.runFor(800);
  await page.evaluate(()=>{window.designCheckPrototype=window.__restoreCheck;designRecoverPrototypeEffects();designRecoverPrototypeEffects();});await page.clock.runFor(3500);
  const after=await page.evaluate(()=>({calls:window.__checkCalls,next:S.design.prototype.nextOperation,started:S.design.prototype.audit.filter(x=>x.action==='prototype.check.start').length,receipts:Object.values(V19_RUNTIME.prototypeReceipts).map(r=>r.effects.filter(e=>e.kind==='dispatch-check').map(e=>({status:e.status,operationId:e.operationId})))}));
  assert.equal(after.calls,1);assert.equal(after.next,before+1);assert.equal(after.started,1);assert.equal(after.receipts.flat()[0].status,'done');
 });
 if(!process.env.V19_SKIP_HEALTH)await test('解锁后开发观察失败仍拒绝旧依据且可幂等恢复',async page=>{
  await prepareDesign(page);
  const result=await page.evaluate(()=>{
   S.designTab='proto';go('stage-design');const devBefore=JSON.stringify(S.dev),audit=window.devAudit;let injected=0,error='';
   window.devAudit=function(action,...args){if(['input.observe','input.reconcile'].includes(action)){injected++;throw Error('UNLOCK_OBSERVE_AUDIT_FAILURE');}return audit(action,...args);};
   try{designUnlockPrototype();}catch(e){error=e.message;}finally{window.devAudit=audit;}
   const receipts=Object.values(V19_RUNTIME.prototypeReceipts).filter(x=>x.commandType==='unlock');
   return {error,injected,finalized:S.proto.finalized,inputGate:devCurrentInputGate(S.dev).ok,designGate:designPrototypeGate('develop').ok,devUnchanged:JSON.stringify(S.dev)===devBefore,effects:receipts.flatMap(r=>r.effects.filter(e=>e.kind==='observe-dev-input').map(e=>e.status))};
  });
  assert.equal(result.error,'');assert.equal(result.injected,1);assert.equal(result.finalized,false);assert.equal(result.inputGate,false);assert.equal(result.designGate,false);assert.equal(result.devUnchanged,true);assert.deepEqual(result.effects,['failed']);
  const recovered=await page.evaluate(()=>{
   designRecoverPrototypeEffects();const once=JSON.stringify(S.dev);designRecoverPrototypeEffects();
   const resolved=resolveDevInputs(S.dev,S);return {same:once===JSON.stringify(S.dev),changes:devInputChanges(S.dev,resolved),missing:devMissingInputDispositions(S.dev,resolved).length,drift:devBaselineDrift(S.dev,resolved),events:S.dev.changeEvents.map(e=>e.inputIdentityKey),impacts:S.dev.impacts.map(e=>e.dispositionId),observations:S.dev.audit.filter(e=>['input.observe','input.reconcile'].includes(e.action)).length,effects:Object.values(V19_RUNTIME.prototypeReceipts).filter(r=>r.commandType==='unlock').flatMap(r=>r.effects.filter(e=>e.kind==='observe-dev-input').map(e=>e.status))};
  });assert.equal(recovered.same,true);assert.deepEqual(recovered.changes,[]);assert.equal(recovered.missing,0);assert.equal(recovered.drift,false);assert.equal(new Set(recovered.events).size,recovered.events.length);assert.equal(new Set(recovered.impacts).size,recovered.impacts.length);assert.deepEqual(recovered.effects,['done']);
 });
 await browser.close();const after=crypto.createHash('sha256').update(fs.readFileSync(candidate)).digest('hex');
 const result={ok:checks.length>0&&checks.every(x=>x.ok)&&after===sourceSha256,candidateSha256:sourceSha256,candidateUnchanged:after===sourceSha256,skipped:process.env.V19_SKIP_HEALTH?['unlock-dev-observe-recovery']:[],checks};
 const evidence=process.env.V19_PROTOTYPE_CANDIDATE?'prototype-effects-isolated-health.json':'prototype-effects-integration.json';
 fs.writeFileSync(path.resolve(__dirname,'../evidence',evidence),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
