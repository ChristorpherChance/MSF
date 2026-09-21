// 历史预期在编辑前捕获；每步独立断言，不从撤销栈或修改后的版本反推原文。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launch,pathToFileURL}=require('./browser.cjs');
const {enterDesign,generateDesign,checkDesign}=require('./design-helpers.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
 const source=fs.readFileSync(path.join(root,'msf-prototype.html'));
 const candidateSha256=crypto.createHash('sha256').update(source).digest('hex');
 const dir=path.resolve(root,'../.superpowers/sdd/原型草稿与历史版本重设计/candidates');
 fs.mkdirSync(dir,{recursive:true});
 const candidate=path.join(dir,candidateSha256+'.html');
 if(!fs.existsSync(candidate))fs.writeFileSync(candidate,source);
 const browser=await launch(),checks=[];
 async function test(name,fn){
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  try{
   await page.goto(pathToFileURL(candidate).href);await enterDesign(page);await generateDesign(page);
   const original=await page.evaluate(()=>JSON.parse(JSON.stringify(S.proto.versions)));
   await fn(page,original);assert.deepEqual(errors,[],'页面不应出现未捕获异常');checks.push({name,ok:true});
  }catch(error){checks.push({name,ok:false,error:String(error.stack).slice(0,2400)});}
  finally{await page.close();}
 }
 async function history(page,original,step,appended=0){
  const actual=await page.evaluate(count=>({count:S.proto.versions.length,previous:JSON.parse(JSON.stringify(S.proto.versions.slice(0,count)))}),original.length);
  assert.equal(actual.count,original.length+appended,step+'：追加数量必须精确匹配操作');
  assert.deepEqual(actual.previous,original,step+'：已提交历史所有字段必须保持原样');
 }
 async function save(page,html){const base=await page.evaluate(()=>{const version=S.proto.versions.find(v=>v.v===S.proto.cur);return {version:JSON.parse(JSON.stringify(version)),fingerprint:S.proto.draft?.baseContentFingerprint||designPrototypeOutputSnapshot().contentFingerprint};});assert.equal(await page.evaluate(html=>executePrototypeCommand({type:'save-html',payload:{html}}).committed,html),true,'保存必须真正成功');const state=await page.evaluate(()=>({draft:S.proto.draft,modified:S.proto.modified,output:designPrototypeOutputSnapshot()}));assert.equal(state.modified,true);assert.equal(state.draft.baseVersion,base.version.v);assert.equal(state.draft.html,html);assert.deepEqual(state.draft.manifest,base.version.manifest);assert.equal(state.draft.baseContentFingerprint,base.fingerprint);assert.notEqual(state.draft.baseContentFingerprint,state.output.contentFingerprint);}
 async function pair(page){return page.evaluate(()=>{const v=curProtoVer();return {html:v.html,manifest:JSON.parse(JSON.stringify(v.manifest))};});}
 for(const saves of [1,35])await test('定稿后连续保存不改历史 '+saves,async(page,original)=>{
  await checkDesign(page);assert.equal(await page.evaluate(()=>designFinalizePrototypeBaseline()),true);
  const records=await page.evaluate(()=>JSON.stringify({reports:S.design.prototype.checkReports,baselines:S.design.prototype.baselines}));
  assert.equal(await page.evaluate(()=>designUnlockPrototype()),true);
  const h0=original.at(-1).html;
  for(let i=1;i<=saves;i++){await save(page,h0+'\n<!-- HISTORY DRAFT '+i+' -->');await history(page,original,'保存'+i);}
  assert.equal(await page.evaluate(()=>commitProtoVer()),true);
  await history(page,original,'提交',1);
  assert.equal(await page.evaluate(()=>S.proto.versions.length),original.length+1);
  assert.equal(await page.evaluate(()=>JSON.stringify({reports:S.design.prototype.checkReports,baselines:S.design.prototype.baselines})),records);
 });
 await test('撤销重做恢复HTML与manifest并保护历史',async(page,original)=>{
  const h0=await pair(page),h1={...h0,html:h0.html+'\n<!-- H1 -->'},h2={...h0,html:h0.html+'\n<!-- H2 -->'};
  await save(page,h1.html);await save(page,h2.html);
  for(const [action,expected] of [['undo',h1],['undo',h0],['redo',h1],['redo',h2]]){
   await page.evaluate(action=>action==='undo'?protoUndo():protoRedo(),action);
   assert.deepEqual(await pair(page),expected,action+'必须恢复完整内容对');
   if(expected===h0)assert.deepEqual(await page.evaluate(()=>({modified:S.proto.modified,draft:S.proto.draft,redo:S.proto.redo.length})),{modified:false,draft:null,redo:2});
   await history(page,original,action);
  }
 });
 for(const changed of [false,true])await test('重复保存严格零写 '+(changed?'H1':'H0'),async(page,original)=>{
  if(changed)await save(page,original.at(-1).html+'\n<!-- NOOP H1 -->');
  const result=await page.evaluate(()=>{
   const before=JSON.stringify(capturePrototypeCommandSnapshot()),dom=document.documentElement.outerHTML;
   const timer=window.setTimeout;let timers=0;
   window.setTimeout=function(...args){timers++;return timer(...args);};
   let outcome;try{outcome=executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html}});}finally{window.setTimeout=timer;}
   return {committed:outcome.committed,same:before===JSON.stringify(capturePrototypeCommandSnapshot()),domSame:dom===document.documentElement.outerHTML,timers};
  });assert.deepEqual(result,{committed:false,same:true,domSame:true,timers:0});await history(page,original,'重复保存');
 });
 for(const accepted of [false,true])await test('真实AI提案'+(accepted?'接受':'拒绝')+'不改历史',async(page,original)=>{
  const h0=await pair(page);
  await page.evaluate(()=>{const session=curSess('proto');session.msgs.push({role:'ai',text:'',tool:{name:'edit_patch',status:'run'}});AGENT_TOOLS.edit_patch.run({}, {ctx:'proto',sess:session},()=>{});});
  await page.clock.runFor(700);
  assert.equal(await page.evaluate(()=>S.proto.pend.length),1,'实际产生pending');
  assert.deepEqual(await pair(page),h0,'提议阶段不改工作正文');await history(page,original,'提议');
  await page.evaluate(accepted=>accepted?acceptProtoPend():rejectProtoPend(),accepted);
  assert.equal(await page.evaluate(()=>S.proto.pend.length),0);
  if(accepted)assert.notEqual((await pair(page)).html,h0.html);else assert.deepEqual(await pair(page),h0);
  await history(page,original,accepted?'接受':'拒绝');
 });
 await test('提交后切回旧版读取原文',async(page,original)=>{
  const old=original.at(-1),h1=old.html+'\n<!-- COMMITTED H1 -->';
  await save(page,h1);assert.equal(await page.evaluate(()=>commitProtoVer()),true);
  const next=await page.evaluate(()=>S.proto.cur);assert.notEqual(next,old.v);
  await page.evaluate(v=>switchProtoVer(v),old.v);assert.equal((await pair(page)).html,old.html);
  await history(page,original,'切回旧版',1);
  await page.evaluate(v=>switchProtoVer(v),next);assert.equal((await pair(page)).html,h1);
 });
 await test('工作读接口深只读且历史读取严格匹配三指纹',async(page,original)=>{
  const result=await page.evaluate(()=>{
   const view=readPrototypeWorking(S.proto),expected=designPrototypeOutputSnapshot(),before=JSON.stringify(S.proto);
   const read=readPrototypeCommitted(S.proto,expected.versionId,expected);
   try{view.html='CORRUPTED';view.manifest.pages[0].pageId='CORRUPTED';}catch{}
   const invalid=['htmlFingerprint','manifestFingerprint','contentFingerprint'].map(key=>readPrototypeCommitted(S.proto,expected.versionId,{...expected,[key]:'wrong'}));
   return {ok:read.ok,unchanged:before===JSON.stringify(S.proto),frozen:Object.isFrozen(view)&&Object.isFrozen(view.manifest.pages[0]),invalid:invalid.every(x=>!x.ok&&x.reason==='HISTORICAL_PROTOTYPE_MISMATCH'),missing:readPrototypeCommitted(S.proto,'v999',expected).ok};
  });assert.deepEqual(result,{ok:true,unchanged:true,frozen:true,invalid:true,missing:false});await history(page,original,'只读接口');
 });
 for(const operation of ['generate','import','switch'])await test('未提交草稿阻止 '+operation,async(page,original)=>{
  await save(page,original.at(-1).html+'\n<!-- DIRTY -->');
  const result=await page.evaluate(operation=>{
   const before=JSON.stringify(capturePrototypeCommandSnapshot());let accepted;
   if(operation==='generate')accepted=!!designGeneratePrototype();
   if(operation==='import')accepted=executePrototypeCommand({type:'import-draft',payload:{name:'拒绝丢草稿.html',html:'<!doctype html><p>new</p>',manifest:{pages:[]}}}).committed;
   if(operation==='switch')accepted=executePrototypeCommand({type:'switch-version',payload:{version:999}}).committed;
   return {accepted,same:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  },operation);assert.deepEqual(result,{accepted:false,same:true});await history(page,original,operation);
 });
 for(const operation of ['generate','import','commit'])await test('追加者恰好新增一个版本 '+operation,async(page,original)=>{
  if(operation==='commit'){await save(page,original.at(-1).html+'\n<!-- APPEND -->');assert.equal(await page.evaluate(()=>commitProtoVer()),true);}
  if(operation==='generate'){assert.ok(await page.evaluate(()=>designGeneratePrototype()));await page.clock.runFor(1800);}
  if(operation==='import')assert.equal(await page.evaluate(()=>executePrototypeCommand({type:'import-draft',payload:{name:'追加.html',html:'<!doctype html><p>new</p>',manifest:{pages:[]}}}).committed),true);
  await history(page,original,operation,1);const state=await page.evaluate(()=>({count:S.proto.versions.length,cur:S.proto.cur,draft:S.proto.draft,modified:S.proto.modified,frozen:Object.isFrozen(S.proto.versions)&&S.proto.versions.every(v=>Object.isFrozen(v)&&Object.isFrozen(v.manifest))}));
  assert.deepEqual(state,{count:original.length+1,cur:Math.max(...original.map(v=>v.v))+1,draft:null,modified:false,frozen:true});
 });
 await test('提交审计失败保留草稿且不消费新版本',async(page,original)=>{
  await save(page,original.at(-1).html+'\n<!-- RETAIN DRAFT -->');
  const result=await page.evaluate(()=>{const before=JSON.stringify(capturePrototypeCommandSnapshot()),audit=window.designAudit;let hit=false;window.designAudit=(name,...args)=>{if(name==='prototype.content.commit-version'){hit=true;throw Error('AUDIT_FAIL');}return audit(name,...args);};try{commitProtoVer();}catch{}finally{window.designAudit=audit;}return {hit,same:before===JSON.stringify(capturePrototypeCommandSnapshot())};});assert.deepEqual(result,{hit:true,same:true});await history(page,original,'提交失败');
 });
 await test('撤销重做独立恢复不同manifest内容对',async(page,original)=>{
  const h0=await pair(page),h1={html:h0.html+'\n<!-- MANIFEST H1 -->',manifest:{...h0.manifest,testIdentity:'H1'}},h2={html:h0.html+'\n<!-- MANIFEST H2 -->',manifest:{...h0.manifest,testIdentity:'H2'}};
  // 显式构造合法工作态，只测试栈转换；预期对在浏览器外固定。
  await page.evaluate(({h0,h1,h2})=>{const base=designPrototypeOutputSnapshot();S.proto.draft={baseVersion:S.proto.cur,baseContentFingerprint:base.contentFingerprint,...h2};S.proto.modified=true;S.proto.undo=[h0,h1];S.proto.redo=[];},{h0,h1,h2});
  for(const [action,expected]of [['undo',h1],['undo',h0],['redo',h1],['redo',h2]]){assert.equal(await page.evaluate(action=>action==='undo'?protoUndo():protoRedo(),action),true);assert.deepEqual(await pair(page),expected);await history(page,original,action+' manifest');}
 });
 await test('pending阻止提交与导入并保留当前草稿',async(page,original)=>{
  await save(page,original.at(-1).html+'\n<!-- PENDING DRAFT -->');
  const result=await page.evaluate(()=>{S.proto.pend=[{from:'<!doctype html>',to:'<!doctype html>\n<!-- WAIT -->'}];const before=JSON.stringify(capturePrototypeCommandSnapshot());const commit=commitProtoVer(),imported=executePrototypeCommand({type:'import-draft',payload:{name:'new.html',html:'new',manifest:{}}}).committed,generated=!!designGeneratePrototype();return {commit,imported,generated,same:before===JSON.stringify(capturePrototypeCommandSnapshot())};});
  assert.deepEqual(result,{commit:false,imported:false,generated:false,same:true});await history(page,original,'pending');
 });
 await test('生成完成呈现失败不回滚新版本',async(page,original)=>{
  assert.ok(await page.evaluate(()=>designGeneratePrototype()));
  await page.evaluate(()=>{window.__historyRender=window.render;window.render=()=>{throw Error('GENERATION_PRESENTATION_FAILURE');};});
  await page.clock.runFor(1800);
  const state=await page.evaluate(()=>{window.render=window.__historyRender;return {count:S.proto.versions.length,status:S.design.prototype.operation.status,error:V19_RUNTIME.prototypePresentationError};});
  assert.deepEqual(state,{count:original.length+1,status:'done',error:'GENERATION_PRESENTATION_FAILURE'});await history(page,original,'生成呈现失败',1);
 });
 await test('错误草稿基准在纯准备阶段明确拒绝且零写',async(page,original)=>{
  await save(page,original.at(-1).html+'\n<!-- INVALID BASIS -->');
  const result=await page.evaluate(()=>{const snapshot=capturePrototypeCommandSnapshot();snapshot.proto.draft.baseContentFingerprint='wrong';const state={projectId:snapshot.projectId,governing:snapshot.governing,proto:snapshot.proto,design:snapshot.design,events:snapshot.events,notices:snapshot.notices,sessions:snapshot.sessions,curSession:snapshot.curSession,receipts:snapshot.receipts};const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;snapshot.identity=devHash(canonical(state));const before=JSON.stringify(snapshot),live=JSON.stringify(S.proto);let outcome,error='';try{outcome=preparePrototypeCommand(snapshot,{type:'save-html',payload:{html:'new'}},{projectId:'pj1',commandId:'INVALID',receiptId:'INVALID',at:'2026-09-11',actor:'tester',nonce:'invalid'});}catch(e){error=e.message;}return {error,ok:outcome?.ok,reason:outcome?.reason,same:before===JSON.stringify(snapshot)&&live===JSON.stringify(S.proto)};});
  assert.deepEqual(result,{error:'',ok:false,reason:'PROTOTYPE_DRAFT_BASE_MISMATCH',same:true});
 });
 await browser.close();
 const result={ok:checks.length>0&&checks.every(c=>c.ok),candidateSha256,immutableRunInput:true,checks};
 const output=process.env.V19_HISTORY_EVIDENCE||'prototype-history.json';
 if(path.basename(output)!==output||!output.endsWith('.json'))throw Error('Evidence filename must be a JSON basename');
 fs.writeFileSync(path.join(root,'evidence',output),JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
