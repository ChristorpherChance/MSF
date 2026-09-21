// 真实公开操作的事务反例：失败不能留下业务记录、DOM 或检查 timer。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launch}=require('./browser.cjs');
const {pathToFileURL}=require('node:url');
const {enterDesign,generateDesign}=require('./design-helpers.cjs');
const root=path.resolve(__dirname,'..');
(async()=>{
 const source=fs.readFileSync(process.env.V19_PROTOTYPE_CANDIDATE||path.join(root,'msf-prototype.html'));
 const candidateSha256=crypto.createHash('sha256').update(source).digest('hex');
 const snapshots=path.resolve(root,'../.superpowers/sdd/原型写事务重设计/candidates');fs.mkdirSync(snapshots,{recursive:true});
 const candidateFile=path.join(snapshots,candidateSha256+'.html');if(!fs.existsSync(candidateFile))fs.writeFileSync(candidateFile,source);
 const url=pathToFileURL(candidateFile).href;
 const browser=await launch(),checks=[];
 async function test(name,fn){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
  try{await page.goto(url);await enterDesign(page);await generateDesign(page);await page.evaluate(()=>{
   window.__prototypeTestBasis=function(session=curSess('proto')){
    if(!session.msgs.at(-1)?.tool)session.msgs.push({role:'ai',text:'',tool:{name:'edit_patch',label:'edit_patch',detail:'独立工具夹具',status:'run'}});
    const output=designPrototypeOutputSnapshot(),messageIndex=session.msgs.length-1;
    return {projectId:'pj1',expectedVersionId:output.versionId,expectedContentFingerprint:output.contentFingerprint,expectedPendingFingerprint:prototypePendingFingerprint(S.proto.pend),sessionId:session.id,expectedSessionCtx:'proto',targetMessageIndex:messageIndex,targetMessageFingerprint:prototypeMessageFingerprint(session.msgs[messageIndex]),expectedMessageCount:session.msgs.length,expectedSessionMessagesFingerprint:prototypeSessionMessagesFingerprint(session.msgs),from:'<!doctype html>',to:'<!doctype html>\n<!-- AI -->',marker:'doctype',reason:'独立反例',line:'L1',pendingActions:[{label:'确认'}]};
   };
  });await fn(page);checks.push({name,ok:true});}
  catch(error){checks.push({name,ok:false,error:String(error.stack).slice(0,1800)});}
  finally{await page.close();}
 }
 for(const fault of ['final','stale'])for(const action of ['save','undo','redo','commit','switch','accept','reject','import','reference-add','reference-remove','unlock']){
  if(fault==='stale'&&action.startsWith('reference-'))continue;
  await test((fault==='final'?'最终':'失效')+'审计失败零写 '+action,async page=>{
   const result=await page.evaluate(({action,fault})=>{
    if(fault==='stale')designCheckPrototype();
    const proto=S.proto,version=curProtoVer();
    if(action==='save')document.querySelector('#proto-editor').value+='\n<!-- UNSAVED INPUT -->';
    if(action==='undo')proto.undo.push({html:version.html+'\n<!-- UNDO -->',manifest:JSON.parse(JSON.stringify(version.manifest))});
    if(action==='redo')proto.redo.push({html:version.html+'\n<!-- REDO -->',manifest:JSON.parse(JSON.stringify(version.manifest))});
    if(action==='commit'){proto.draft={baseVersion:version.v,baseContentFingerprint:designPrototypeOutputSnapshot().contentFingerprint,html:version.html+'\n<!-- COMMIT FIXTURE -->',manifest:JSON.parse(JSON.stringify(version.manifest))};proto.modified=true;}
    if(action==='switch')proto.versions=Object.freeze([...proto.versions,Object.freeze({...JSON.parse(JSON.stringify(version)),v:version.v+1,html:version.html+'\n<!-- OTHER VERSION -->'})]);
    if(['accept','reject'].includes(action))proto.pend=[{from:'<!doctype html>',to:'<!doctype html>\n<!-- ACCEPT -->',reason:'独立测试'}];
    if(['import','reference-add'].includes(action)){uploadProtoModal();document.querySelector('input[name="up-mode"][value="'+(action==='import'?'draft':'ref')+'"]').checked=true;}
    if(action==='reference-remove')proto.refs.push({id:'INDEPENDENT-REF',name:'参考.html',at:'09-08 12:00'});
    if(action==='unlock'){proto.finalized=true;proto.finalVer=proto.cur;}
    const snapshot=()=>JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,session:curSess('proto'),receipts:typeof V19_RUNTIME!=='undefined'?V19_RUNTIME.prototypeReceipts:null});
    const dom=()=>({editor:document.querySelector('#proto-editor')?.value,modal:document.querySelector('#modal-root')?.innerHTML});
    const before=snapshot(),beforeDom=dom(),audit=window.designAudit,timer=window.setTimeout;let timers=0,error='',invoked=false;
    window.designAudit=function(name,...args){if(fault==='stale'?name==='prototype.operation.stale':name.startsWith('prototype.content.')||name.startsWith('prototype.reference.')){invoked=true;throw Error('COMMAND_AUDIT_FAILURE');}return audit(name,...args);};
    window.setTimeout=function(fn,ms,...args){if(ms===700){timers++;return 0;}return timer(fn,ms,...args);};
    try{
     if(action==='save')saveProtoEditor();if(action==='undo')protoUndo();if(action==='redo')protoRedo();if(action==='commit')commitProtoVer();if(action==='switch')switchProtoVer(version.v+1);
     if(action==='accept')acceptProtoPend();if(action==='reject')rejectProtoPend();if(['import','reference-add'].includes(action))doUploadProto();if(action==='reference-remove')delProtoRef('INDEPENDENT-REF');if(action==='unlock')designUnlockPrototype();
    }catch(e){error=e.message;}finally{window.designAudit=audit;window.setTimeout=timer;}
    return {invoked,error,stateSame:before===snapshot(),domSame:JSON.stringify(beforeDom)===JSON.stringify(dom()),timers};
   },{action,fault});
   assert.equal(result.invoked,true,'操作确实经过最终审计：'+JSON.stringify(result));
   assert.equal(result.stateSame,true,'失败仍修改业务状态：'+JSON.stringify(result));
   assert.equal(result.domSame,true,'失败仍修改用户输入或关闭窗口：'+JSON.stringify(result));
   assert.equal(result.timers,0,'失败注册了检查 timer');
  });
 }
 await test('目标文本不匹配时接受补丁不得清空pending或历史',async page=>{
  const result=await page.evaluate(()=>{
   S.proto.pend=[{from:'INDEPENDENT-NONEXISTENT-FROM',to:'replacement'}];
   const before=JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,session:curSess('proto')});acceptProtoPend();
   return before===JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,session:curSess('proto')});
  });assert.equal(result,true);
 });
 for(const state of ['modified','pending'])await test('未完成工作阻止版本切换 '+state,async page=>{
  const result=await page.evaluate(state=>{
   const v=curProtoVer(),target=v.v+1;S.proto.versions=Object.freeze([...S.proto.versions,Object.freeze({...JSON.parse(JSON.stringify(v)),v:target})]);
   if(state==='modified')executePrototypeCommand({type:'save-html',payload:{html:v.html+'\n<!-- DIRTY -->'}});else S.proto.pend=[{from:'a',to:'b'}];
   const before=JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices});
   const confirm=window.confirm;window.confirm=()=>true;try{switchProtoVer(target);}finally{window.confirm=confirm;}
   return before===JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices});
  },state);assert.equal(result,true,'有未提交工作时不应切换、清pending或清modified');
 });
 for(const shared of ['events','messages'])await test('纯准备零写且发布拒绝原数组追加 '+shared,async page=>{
  const result=await page.evaluate(shared=>{
   if(typeof capturePrototypeCommandSnapshot!=='function'||typeof preparePrototypeCommand!=='function'||typeof publishPrototypeCommand!=='function')return {missing:true};
   const snapshot=capturePrototypeCommandSnapshot(),before=JSON.stringify(snapshot),context={projectId:'pj1',commandId:'TEST-CMD',receiptId:'TEST-RECEIPT',at:'2026-09-08 12:00',actor:'superopen',nonce:'test-nonce'};
   const prepared=preparePrototypeCommand(snapshot,{type:'save-html',payload:{html:curProtoVer().html+'\n<!-- PURE -->'}},context);
   const pure=JSON.stringify(snapshot)===before&&JSON.stringify(capturePrototypeCommandSnapshot())===before;
   if(shared==='events')S.events.unshift({id:'INDEPENDENT-EVENT',at:'2026-09-08 12:01',text:'保留外部追加'});else curSess('proto').msgs.push({role:'user',text:'保留外部消息'});
   const afterAppend=JSON.stringify(capturePrototypeCommandSnapshot());const published=publishPrototypeCommand(prepared.expectedIdentity,prepared);
   return {prepared:prepared.ok,changed:prepared.changed,pure,committed:published.committed,appendPreserved:JSON.stringify(capturePrototypeCommandSnapshot())===afterAppend};
  },shared);assert.equal(result.missing,undefined,'缺少生产纯命令接口');assert.equal(result.prepared,true);assert.equal(result.changed,true);assert.equal(result.pure,true);assert.equal(result.committed,false);assert.equal(result.appendPreserved,true);
 });
 await test('迟到AI补丁不能写入新内容或消费收据',async page=>{
  const result=await page.evaluate(()=>{
   if(typeof executePrototypeCommand!=='function')return {missing:true};
   const payload=__prototypeTestBasis();
   document.querySelector('#proto-editor').value+='\n<!-- NEW HUMAN EDIT -->';saveProtoEditor();
   const before=JSON.stringify(capturePrototypeCommandSnapshot());const outcome=executePrototypeCommand({type:'propose-pending',payload});
   return {committed:outcome.committed,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
 });assert.equal(result.missing,undefined);assert.equal(result.committed,false);assert.equal(result.unchanged,true);
 });
 for(const shared of ['events','messages'])await test('发布不能用新身份重新授权旧草稿 '+shared,async page=>{
  const result=await page.evaluate(shared=>{
   const snapshot=capturePrototypeCommandSnapshot(),prepared=preparePrototypeCommand(snapshot,{type:'save-html',payload:{html:curProtoVer().html+'\n<!-- OLD DRAFT -->'}},{projectId:'pj1',commandId:'STALE-CMD',receiptId:'STALE-RECEIPT',at:'2026-09-08 12:00',actor:'superopen',nonce:'stale'});
   if(shared==='events')S.events.push({at:'2026-09-08 12:01',type:'independent',text:'稍后追加的事实'});else curSess('proto').msgs.push({role:'user',text:'稍后追加的要求'});
   const newer=capturePrototypeCommandSnapshot(),published=publishPrototypeCommand(newer.identity,prepared);
   return {prepared:prepared.ok,committed:published.committed,unchanged:JSON.stringify(newer)===JSON.stringify(capturePrototypeCommandSnapshot())};
  },shared);assert.equal(result.prepared,true);assert.equal(result.committed,false);assert.equal(result.unchanged,true);
 });
 await test('修改prepared启动身份也不能发布旧草稿',async page=>{
  const result=await page.evaluate(()=>{
   const prepared=preparePrototypeCommand(capturePrototypeCommandSnapshot(),{type:'save-html',payload:{html:curProtoVer().html+'\n<!-- IDENTITY REPLACED -->'}},{projectId:'pj1',commandId:'IDENTITY-CMD',receiptId:'IDENTITY-RECEIPT',at:'2026-09-08 12:00',actor:'superopen',nonce:'identity'});
   S.events.push({at:'2026-09-08 12:01',type:'independent',text:'应保留'});const newer=capturePrototypeCommandSnapshot();prepared.expectedIdentity=newer.identity;
   const published=publishPrototypeCommand(newer.identity,prepared);return {committed:published.committed,unchanged:JSON.stringify(newer)===JSON.stringify(capturePrototypeCommandSnapshot())};
  });assert.equal(result.committed,false);assert.equal(result.unchanged,true);
 });
 await test('切换不同版本立即移除旧检查通过状态且保留报告历史',async page=>{
  await page.evaluate(()=>{const original=curProtoVer();executePrototypeCommand({type:'save-html',payload:{html:original.html+'\n<!-- NEXT VERSION -->'}});commitProtoVer();designCheckPrototype();});await page.clock.runFor(1800);
  const before=await page.evaluate(()=>({status:S.design.prototype.status,history:JSON.stringify(S.design.prototype.checkReports)}));assert.equal(before.status,'ready');
  const result=await page.evaluate(()=>({switched:switchProtoVer(1),status:S.design.prototype.status,gate:designPrototypeGate('finalize').ok,history:JSON.stringify(S.design.prototype.checkReports)}));
  assert.equal(result.switched,true);assert.equal(result.status,'generated');assert.equal(result.gate,false);assert.equal(result.history,before.history);
 });
 for(const action of ['save','undo','redo','commit','switch','accept','reject','propose','import','unlock'])await test('原型输入改变清除当前检查指针且保留历史 '+action,async page=>{
  await page.evaluate(()=>designCheckPrototype());await page.clock.runFor(1800);
  const result=await page.evaluate(action=>{
   const history=JSON.stringify(S.design.prototype.checkReports),hadReport=!!S.design.prototype.currentCheckReportId,v=curProtoVer();let committed;
   if(action==='save'){document.querySelector('#proto-editor').value+='\n<!-- CHANGED -->';committed=saveProtoEditor();}
   if(action==='undo'){S.proto.undo.push({html:v.html+'\n<!-- UNDO -->',manifest:JSON.parse(JSON.stringify(v.manifest))});committed=protoUndo();}
   if(action==='redo'){S.proto.redo.push({html:v.html+'\n<!-- REDO -->',manifest:JSON.parse(JSON.stringify(v.manifest))});committed=protoRedo();}
   if(action==='commit'){const base=S.proto.versions.find(x=>x.v===S.proto.cur);S.proto.draft={baseVersion:base.v,baseContentFingerprint:designPrototypeOutputSnapshot().contentFingerprint,html:v.html+'\n<!-- COMMIT -->',manifest:JSON.parse(JSON.stringify(v.manifest))};S.proto.modified=true;committed=commitProtoVer();}
   if(action==='switch'){S.proto.versions=Object.freeze([...S.proto.versions,Object.freeze({...JSON.parse(JSON.stringify(v)),v:v.v+1,html:v.html+'\n<!-- OTHER -->'})]);committed=switchProtoVer(v.v+1);}
   if(['accept','reject'].includes(action)){S.proto.pend=[{from:'<!doctype html>',to:'<!doctype html>\n<!-- PENDING -->'}];committed=action==='accept'?acceptProtoPend():rejectProtoPend();}
   if(action==='propose')committed=executePrototypeCommand({type:'propose-pending',payload:__prototypeTestBasis()}).committed;
   if(action==='import'){uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;committed=doUploadProto();}
   if(action==='unlock'){S.proto.finalized=true;S.proto.finalVer=S.proto.cur;committed=designUnlockPrototype();}
   return {committed,hadReport,current:S.design.prototype.currentCheckReportId,status:S.design.prototype.status,historySame:history===JSON.stringify(S.design.prototype.checkReports)};
  },action);assert.equal(result.hadReport,true);assert.equal(result.committed,true);assert.equal(result.current,'','旧报告不能继续作为current');assert.equal(result.status,'generated');assert.equal(result.historySame,true);
 });
 await test('AI补丁最终审计失败时内容会话和收据零写',async page=>{
  const result=await page.evaluate(()=>{
   if(typeof executePrototypeCommand!=='function')return {missing:true};const payload=__prototypeTestBasis(),before=JSON.stringify(capturePrototypeCommandSnapshot()),audit=window.designAudit;let injected=false;
   window.designAudit=function(action,...args){if(action.startsWith('prototype.content.')){injected=true;throw Error('AI_PENDING_AUDIT_FAILURE');}return audit(action,...args);};
   try{executePrototypeCommand({type:'propose-pending',payload});}catch{}finally{window.designAudit=audit;}
   return {injected,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  });assert.equal(result.missing,undefined);assert.equal(result.injected,true);assert.equal(result.unchanged,true);
 });
 for(const sessionCase of ['previous-prototype','other-context'])await test('AI补丁拒绝非当前原型会话 '+sessionCase,async page=>{
  const result=await page.evaluate(sessionCase=>{
   const payload=__prototypeTestBasis(sessionCase==='other-context'?S.sessions.find(s=>s.ctx!=='proto'):curSess('proto'));
   if(sessionCase==='previous-prototype'){S.chatCtx='proto';newSession();}
   const before=JSON.stringify(capturePrototypeCommandSnapshot());const outcome=executePrototypeCommand({type:'propose-pending',payload});
   return {committed:outcome.committed,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  },sessionCase);assert.equal(result.committed,false);assert.equal(result.unchanged,true);
 });
 await test('第二个AI提议不能覆盖尚未处理的pending',async page=>{
  const result=await page.evaluate(()=>{
   const payload={...__prototypeTestBasis(),to:'<!doctype html>\n<!-- FIRST PROPOSAL -->',reason:'第一条'};
   const first=executePrototypeCommand({type:'propose-pending',payload});const before=JSON.stringify(capturePrototypeCommandSnapshot());
   const second=executePrototypeCommand({type:'propose-pending',payload:{...payload,to:'<!doctype html>\n<!-- SECOND PROPOSAL -->',reason:'第二条'}});
   return {first:first.committed,second:second.committed,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
 });assert.equal(result.first,true);assert.equal(result.second,false);assert.equal(result.unchanged,true);
 });
 for(const mutation of ['append','replace','earlier-message','delete-session'])await test('AI补丁拒绝消息或会话漂移 '+mutation,async page=>{
  const result=await page.evaluate(mutation=>{
   const payload=__prototypeTestBasis(),session=curSess('proto');
   if(mutation==='append')session.msgs.push({role:'user',text:'新的需求'});
   if(mutation==='replace')session.msgs[payload.targetMessageIndex]={role:'ai',text:'替换后的工具消息',tool:{name:'read_context',status:'run'}};
   if(mutation==='earlier-message')session.msgs[0]={role:'user',text:'更正了早前上下文'};
   if(mutation==='delete-session')S.sessions=S.sessions.filter(s=>s.id!==payload.sessionId);
   const before=JSON.stringify(capturePrototypeCommandSnapshot()),outcome=executePrototypeCommand({type:'propose-pending',payload});
   return {committed:outcome.committed,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  },mutation);assert.equal(result.committed,false);assert.equal(result.unchanged,true);
 });
 await test('真实AI工具入口产生待确认修改且可接受',async page=>{
  await page.evaluate(()=>{
   const session=curSess('proto');session.msgs.push({role:'ai',text:'',tool:{name:'edit_patch',label:'edit_patch',detail:'精确修改',status:'run'}});
   window.__toolOutcome=null;window.__originalPrototypeHtml=curProtoVer().html;
   AGENT_TOOLS.edit_patch.run({}, {ctx:'proto',sess:session},result=>{window.__toolOutcome=result;});
  });await page.clock.runFor(700);
  const result=await page.evaluate(()=>{
   const proposal=S.proto.pend[0],result={outcome:window.__toolOutcome,pending:S.proto.pend.length,unchanged:curProtoVer().html===window.__originalPrototypeHtml};
   result.accepted=acceptProtoPend();result.changed=curProtoVer().html!==window.__originalPrototypeHtml;result.replaced=!!proposal&&curProtoVer().html.includes(proposal.to)&&!curProtoVer().html.includes(proposal.from);return result;
  });assert.equal(result.pending,1,JSON.stringify(result));assert.equal(result.unchanged,true);assert.equal(result.accepted,true);assert.equal(result.changed,true);assert.equal(result.replaced,true);
 });
 await test('入口上下文不能替换旧收据或伪造审计归因',async page=>{
  const result=await page.evaluate(()=>{
   const first=executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- FIRST RECEIPT -->'}}),old=JSON.stringify(V19_RUNTIME.prototypeReceipts[first.receiptId]);
   const outcome=executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- SECOND RECEIPT -->'}},{projectId:'pj1',receiptId:first.receiptId,commandId:'FORGED-COMMAND',actor:'FORGED-ACTOR',at:'1900-01-01 00:00',nonce:'FORGED-NONCE'});
   return {first:first.committed,oldSame:old===JSON.stringify(V19_RUNTIME.prototypeReceipts[first.receiptId]),forged:S.design.prototype.audit.some(a=>a.actor==='FORGED-ACTOR'||a.at==='1900-01-01 00:00'),replaced:outcome.committed&&outcome.receiptId===first.receiptId};
 });assert.equal(result.first,true);assert.equal(result.oldSame,true);assert.equal(result.forged,false);assert.equal(result.replaced,false);
 });
 await test('聊天发送修改主题色完整返回可确认提案',async page=>{
  await page.evaluate(()=>{S.chatCtx='proto';render();document.querySelector('#chat-text').value='请把主题颜色改成蓝色';sendChat();});
  await page.clock.runFor(15000);
  const result=await page.evaluate(()=>({pending:S.proto.pend.length,busy:S.agentBusy,streaming:!!S.streaming,tool:curSess('proto').msgs.findLast(m=>m.tool?.name==='edit_patch')?.tool,actions:curSess('proto').msgs.filter(m=>m.pendActions?.length).length}));
  assert.equal(result.pending,1,JSON.stringify(result));assert.equal(result.busy,false);assert.equal(result.streaming,false);assert.equal(result.tool?.status,'done');assert.ok(result.actions>=1);
 });
 await test('纯准备拒绝复用已经发布的收据编号',async page=>{
  const result=await page.evaluate(()=>{
   const first=executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- RECEIPT ONCE -->'}}),before=JSON.stringify(capturePrototypeCommandSnapshot());
   const prepared=preparePrototypeCommand(capturePrototypeCommandSnapshot(),{type:'save-html',payload:{html:curProtoVer().html+'\n<!-- COLLISION -->'}},{projectId:'pj1',commandId:'COLLISION',receiptId:first.receiptId,at:'2026-09-08 12:00',actor:'superopen',nonce:'collision'});
   return {ok:prepared.ok,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
 });assert.equal(result.ok,false);assert.equal(result.unchanged,true);
 });
 await test('纯准备拒绝复用已发布commandId即使receiptId不同',async page=>{
  const result=await page.evaluate(()=>{
   const first=executePrototypeCommand({type:'save-html',payload:{html:curProtoVer().html+'\n<!-- COMMAND ONCE -->'}}),receipt=V19_RUNTIME.prototypeReceipts[first.receiptId],before=JSON.stringify(capturePrototypeCommandSnapshot());
   const prepared=preparePrototypeCommand(capturePrototypeCommandSnapshot(),{type:'save-html',payload:{html:curProtoVer().html+'\n<!-- COMMAND COLLISION -->'}},{projectId:'pj1',commandId:receipt.commandId,receiptId:'INDEPENDENT-NEW-RECEIPT',at:'2026-09-08 12:00',actor:'superopen',nonce:'collision'});
   return {ok:prepared.ok,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  });assert.equal(result.ok,false);assert.equal(result.unchanged,true);
 });
 await test('无操作不会作废运行中的检查或新增收据',async page=>{
  const result=await page.evaluate(()=>{
   if(typeof capturePrototypeCommandSnapshot!=='function')return {missing:true};
   designCheckPrototype();const before=JSON.stringify(capturePrototypeCommandSnapshot());
   saveProtoEditor();switchProtoVer(S.proto.cur);protoUndo();protoRedo();acceptProtoPend();rejectProtoPend();
   return {unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
 });assert.equal(result.missing,undefined);assert.equal(result.unchanged,true);
 });
 for(const saves of [1,35])await test('已定稿版本字节必须跨草稿保存与提交保留 '+saves,async page=>{
  await page.evaluate(()=>designCheckPrototype());await page.clock.runFor(1800);
  const before=await page.evaluate(()=>{
   const finalized=designFinalizePrototypeBaseline();window.__approvedOriginalHtml=curProtoVer().html;
   return {finalized,version:S.proto.cur,history:JSON.stringify({reports:S.design.prototype.checkReports,baselines:S.design.prototype.baselines})};
  });assert.equal(before.finalized,true);
  const result=await page.evaluate(({saves,version})=>{
   const unlocked=designUnlockPrototype();let allSaved=true;
   for(let i=0;i<saves;i++)allSaved=executePrototypeCommand({type:'save-html',payload:{html:window.__approvedOriginalHtml+'\n<!-- HUMAN DRAFT '+i+' -->'}}).committed&&allSaved;
   const committed=commitProtoVer(),old=S.proto.versions.find(v=>v.v===version);
   return {unlocked,allSaved,committed,current:S.proto.cur,oldPreserved:old.html===window.__approvedOriginalHtml,newChanged:curProtoVer().html!==window.__approvedOriginalHtml,originalStillStored:S.proto.versions.some(v=>v.html===window.__approvedOriginalHtml),history:JSON.stringify({reports:S.design.prototype.checkReports,baselines:S.design.prototype.baselines})};
  },{saves,version:before.version});assert.equal(result.unlocked,true);assert.equal(result.allSaved,true);assert.equal(result.committed,true);assert.notEqual(result.current,before.version);assert.equal(result.newChanged,true);assert.equal(result.history,before.history);assert.equal(result.oldPreserved,true,'基线元数据仍在但其引用的原始HTML被改写：'+JSON.stringify({oldPreserved:result.oldPreserved,originalStillStored:result.originalStillStored,saves}));
 });
 for(const finalized of [false,true])await test('遗留snapProto入口不可绕过事务写历史 '+finalized,async page=>{
  const result=await page.evaluate(finalized=>{
   S.proto.finalized=finalized;S.proto.finalVer=finalized?S.proto.cur:0;
   const before=JSON.stringify(capturePrototypeCommandSnapshot());try{if(typeof snapProto==='function')snapProto();}catch{}
   return before===JSON.stringify(capturePrototypeCommandSnapshot());
  },finalized);assert.equal(result,true,'遗留入口不得直接写undo/redo或任何权威状态');
 });
 for(const context of ['finalized','other-project'])await test('遗留任意callback事务入口不可回写原型 '+context,async page=>{
  const result=await page.evaluate(context=>{
   if(context==='finalized'){S.proto.finalized=true;S.proto.finalVer=S.proto.cur;}else S.proj=S.projects.find(p=>p.id!=='pj1');
   const before=JSON.stringify(capturePrototypeCommandSnapshot());let invoked=false;
   try{if(typeof commitPrototypeAction==='function')commitPrototypeAction('legacy.inject','independent',()=>{invoked=true;curProtoVer().html+='\n<!-- BYPASS -->';S.proto.modified=true;return true;});}catch{}
   return {invoked,unchanged:before===JSON.stringify(capturePrototypeCommandSnapshot())};
  },context);assert.equal(result.invoked,false,'旧任意回调不应被调用');assert.equal(result.unchanged,true);
 });
 await test('提交后渲染失败可恢复且不重放业务事件',async page=>{
  const committed=await page.evaluate(()=>{
   const expected=curProtoVer().html+'\n<!-- RENDER RECOVERY -->';document.querySelector('#proto-editor').value=expected;
   const render=window.render;let error='',invoked=0;window.render=function(){invoked++;throw Error('PRESENTATION_FAILURE');};
   try{saveProtoEditor();}catch(e){error=e.message;}finally{window.render=render;}
   return {expected,actual:curProtoVer().html,error,invoked,business:JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')})};
  });
  assert.ok(committed.actual===committed.expected,'呈现失败不能回滚已提交内容');assert.equal(committed.error,'','应返回已提交而非抛出业务失败');assert.ok(committed.invoked>0,'没有触发真实 render 故障');
  const recovered=await page.evaluate(()=>{
   if(typeof designRecoverPrototypeEffects!=='function')return {missing:true};designRecoverPrototypeEffects();designRecoverPrototypeEffects();
   return {business:JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')}),editor:document.querySelector('#proto-editor')?.value};
  });assert.equal(recovered.missing,undefined,'必须有无需依赖render的恢复入口');assert.equal(recovered.business,committed.business);assert.equal(recovered.editor,committed.expected);
 });
 for(const afterDisplay of [false,true])await test('成功提示异常后恢复不重复消息 '+afterDisplay,async page=>{
  const committed=await page.evaluate(afterDisplay=>{
   document.querySelector('#proto-editor').value+='\n<!-- TOAST RECOVERY -->';const toast=window.toast;let injected=false,error='';
   window.toast=function(...args){if(!injected){injected=true;if(afterDisplay)toast(...args);throw Error('TOAST_EFFECT_FAILURE');}return toast(...args);};
   try{saveProtoEditor();}catch(e){error=e.message;}finally{window.toast=toast;}
   return {injected,error,business:JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')})};
  },afterDisplay);assert.equal(committed.injected,true);assert.equal(committed.error,'');
  const recovered=await page.evaluate(()=>{designRecoverPrototypeEffects();designRecoverPrototypeEffects();return {messages:[...document.querySelectorAll('#toast-wrap .toast')].filter(n=>n.textContent.includes('已保存草稿')).length,business:JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')})};});
  assert.equal(recovered.messages,1,'同一次保存产生重复成功提示');assert.equal(recovered.business,committed.business);
 });
 for(const afterRegistration of [false,true])await test('上传检查timer失败恢复至多一次真实派发 '+afterRegistration,async page=>{
  const imported=await page.evaluate(afterRegistration=>{
   uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;
   const timer=window.setTimeout,before=S.proto.versions.length;let error='',injected=false;
   window.setTimeout=function(fn,ms,...args){if(ms===700&&!injected){injected=true;if(afterRegistration)timer(fn,ms,...args);throw Error('CHECK_TIMER_FAILURE');}return timer(fn,ms,...args);};
   try{doUploadProto();}catch(e){error=e.message;}finally{window.setTimeout=timer;}
   return {error,injected,before,after:S.proto.versions.length,version:S.proto.cur,business:JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')}),operations:S.design.prototype.nextOperation};
  },afterRegistration);
  assert.equal(imported.injected,true);assert.equal(imported.error,'','timer失败不应伪装为导入失败');assert.equal(imported.after,imported.before+1);
  await page.evaluate(()=>{if(typeof designRecoverPrototypeEffects!=='function')throw Error('MISSING_EFFECT_RECOVERY');designRecoverPrototypeEffects();designRecoverPrototypeEffects();});
  assert.equal(await page.evaluate(()=>JSON.stringify({proto:S.proto,events:S.events,notices:S.notices,session:curSess('proto')})),imported.business,'恢复不能重放上传');
  await page.clock.runFor(4000);
  const result=await page.evaluate(()=>({next:S.design.prototype.nextOperation,audits:S.design.prototype.audit.filter(x=>x.action==='prototype.check.start').length,version:S.proto.cur}));
  assert.equal(result.next,imported.operations+1,'同一上传产生多次检查operation');assert.equal(result.audits,1);assert.equal(result.version,imported.version);
 });
 await test('上传timer迟到时不能检查后来编辑的内容',async page=>{
  const before=await page.evaluate(()=>{
   uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;doUploadProto();
   document.querySelector('#proto-editor').value+='\n<!-- NEWER CONTENT -->';saveProtoEditor();
   return JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,session:curSess('proto')});
  });await page.clock.runFor(4000);
  assert.ok(await page.evaluate(()=>JSON.stringify({proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,session:curSess('proto')}))===before,'旧上传timer写了新内容对应的检查事实');
 });
 await test('来源问题格式完整且重复审计ID稳定',async page=>{
  await page.evaluate(()=>{S.design.docs.api.finalized=false;});
  const observed=await page.evaluate(()=>({first:designAuditCatalogAgainstSources().issues,second:designAuditCatalogAgainstSources().issues}));
  assert.ok(observed.first.length>0);assert.deepEqual(observed.first,observed.second);
  for(const issue of observed.first){
   for(const field of ['issueId','code','severity','target','message'])assert.ok(typeof issue[field]==='string'&&issue[field].length,field+' 缺失：'+JSON.stringify(issue));
   assert.equal(issue.severity,'blocking');assert.equal(issue.humanRequired,true);assert.ok(Array.isArray(issue.sourceRefs)&&issue.sourceRefs.length>0,'缺少来源引用');
   assert.equal(new Set(issue.sourceRefs).size,issue.sourceRefs.length);assert.deepEqual(issue.sourceRefs,[...issue.sourceRefs].sort());
  }
  await page.evaluate(()=>designPlanPrototype());await page.clock.runFor(1800);
  const plan=await page.evaluate(()=>S.design.prototype.plans.find(p=>p.planId===S.design.prototype.currentPlanId));
  assert.ok(plan&&!plan.complete);assert.deepEqual(plan.sourceAudit.unverified,observed.first);
  for(const issue of observed.first)assert.ok(plan.issues.some(x=>JSON.stringify(x)===JSON.stringify(issue)),'规划未保存相同规范来源问题');
 });
 await browser.close();
 const result={ok:checks.length>0&&checks.every(x=>x.ok),candidateSha256,immutableRunInput:true,checks};
 const evidenceName=process.env.V19_PROTOTYPE_CANDIDATE?'prototype-commands-reference.json':process.env.V19_CASE?'prototype-commands-focused.json':'prototype-commands.json';
 const target=path.join(root,'evidence',evidenceName);fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');
 if(!result.ok&&!fs.existsSync(path.join(root,'evidence/prototype-commands-red.json')))fs.copyFileSync(target,path.join(root,'evidence/prototype-commands-red.json'));
 console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
