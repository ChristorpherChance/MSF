/* V1.9 固定示例的证据与操作边界。维护源静态嵌入 HTML，不加载外部资源。 */
(function(){
'use strict';
const clone=x=>JSON.parse(JSON.stringify(x));
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const hash=x=>devHash(canonical(x)),equal=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const freeze=x=>{if(x&&typeof x==='object'&&!Object.isFrozen(x)){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const baseline=()=>S.design.prototype.baselines.find(b=>b.baselineId===S.design.prototype.currentBaselineId);
const report=(dev=S.dev)=>dev.selftest?.reports.find(r=>r.reportId===dev.selftest.currentReportId);
const reportHash=r=>{const c=clone(r);delete c.reportFingerprint;return hash(c);};
const failure=(code,message)=>({ok:false,issues:[{code,message}]});
const digest=x=>devHash(String(x||'').replace(/\s+/g,' ').trim());
freeze(V19_VERIFIED_UI_CERTIFICATE);
const uiInspectionCache=new Map();

/* 原型内容命令：纯 draft -> 单次同步发布 -> 可恢复逐效果 ledger。 */
V19_RUNTIME.prototypeReceipts=V19_RUNTIME.prototypeReceipts||{};
const prototypeCommandTypes=new Set(['save-html','undo','redo','switch-version','commit-version','accept-pending','reject-pending','propose-pending','import-draft','unlock','add-reference','remove-reference']);
const prototypeContentTypes=new Set(['save-html','undo','redo','switch-version','commit-version','accept-pending','reject-pending','propose-pending','import-draft','unlock']);
const prototypeSession=(state)=>state.sessions.find(s=>s.id===state.curSession.proto);
const prototypeContentPair=v=>({html:v.html,manifest:clone(v.manifest||{})});
const prototypeContentFingerprint=(v,content=v)=>hash({versionId:'v'+v.v,htmlFingerprint:hash(content.html),manifestFingerprint:hash(content.manifest||{})});
function committedPrototypeVersion(proto,number=proto.cur){const matches=proto.versions.filter(v=>v.v===number);if(matches.length!==1)throw Error('HISTORICAL_PROTOTYPE_MISMATCH');return matches[0];}
window.readPrototypeWorking=function(proto){if(!proto.versions.length)return null;const base=committedPrototypeVersion(proto),draft=proto.draft;if(draft&&(draft.baseVersion!==base.v||draft.baseContentFingerprint!==prototypeContentFingerprint(base)))throw Error('PROTOTYPE_DRAFT_BASE_MISMATCH');return freeze({...clone(base),...prototypeContentPair(draft||base)});};
window.readPrototypeCommitted=function(proto,versionId,expected){try{const number=typeof versionId==='string'&&/^v[1-9]\d*$/.test(versionId)?Number(versionId.slice(1)):versionId,v=committedPrototypeVersion(proto,number);if(!expected||expected.htmlFingerprint!==hash(v.html)||expected.manifestFingerprint!==hash(v.manifest||{})||expected.contentFingerprint!==prototypeContentFingerprint(v))throw Error('mismatch');return {ok:true,version:freeze(clone(v))};}catch{return {ok:false,reason:'HISTORICAL_PROTOTYPE_MISMATCH'};}};
const prototypeVersion=proto=>readPrototypeWorking(proto);
window.curProtoVer=()=>readPrototypeWorking(S.proto);
function normalizePrototypeDraft(proto,content){const base=committedPrototypeVersion(proto),changed=!equal(prototypeContentPair(base),content);proto.draft=changed?{baseVersion:base.v,baseContentFingerprint:prototypeContentFingerprint(base),...clone(content)}:null;proto.modified=changed;}
function writePrototypeDraft(proto,content){const before=prototypeContentPair(prototypeVersion(proto));if(equal(before,content))return false;proto.undo.push(before);proto.undo=proto.undo.slice(-30);proto.redo=[];normalizePrototypeDraft(proto,content);return true;}
window.appendPrototypeVersion=function(proto,record){proto.versions=[...proto.versions,clone(record)];proto.cur=record.v;proto.draft=null;proto.undo=[];proto.redo=[];proto.modified=false;proto.pend=[];proto.finalized=false;proto.finalVer=0;};
window.assertPrototypeWorkingState=function(proto){
 const versions=proto.versions;if(!Array.isArray(versions)||new Set(versions.map(v=>v.v)).size!==versions.length||versions.some(v=>!Number.isInteger(v.v)||v.v<1||typeof v.html!=='string'))throw Error('PROTOTYPE_VERSION_INVALID');
 if(!versions.length){if(proto.cur!==0||proto.draft!==null||proto.modified||proto.pend.length||proto.undo.length||proto.redo.length||proto.finalized||proto.finalVer!==0)throw Error('PROTOTYPE_EMPTY_STATE_INVALID');return true;}
 const base=committedPrototypeVersion(proto);if((proto.draft===null)!==(proto.modified===false))throw Error('PROTOTYPE_DRAFT_STATE_INVALID');
 if(proto.draft&&(proto.draft.baseVersion!==base.v||proto.draft.baseContentFingerprint!==prototypeContentFingerprint(base)||equal(prototypeContentPair(base),prototypeContentPair(proto.draft))))throw Error('PROTOTYPE_DRAFT_BASE_MISMATCH');
 for(const stack of [proto.undo,proto.redo])if(!Array.isArray(stack)||stack.length>30||stack.some(v=>!v||typeof v.html!=='string'||!v.manifest||typeof v.manifest!=='object'))throw Error('PROTOTYPE_HISTORY_STACK_INVALID');
 if(proto.finalized?(proto.draft!==null||proto.modified||proto.pend.length||proto.finalVer!==proto.cur):proto.finalVer!==0)throw Error('PROTOTYPE_FINALIZATION_INVALID');return true;
};
window.assertPrototypeVersionHistory=function(before,next,operation){const append=['generate','import-draft','commit-version'].includes(operation)?1:0;if(next.versions.length!==before.versions.length+append||before.versions.some((v,i)=>!equal(v,next.versions[i])))throw Error('PROTOTYPE_HISTORY_IMMUTABLE');if(append&&next.versions.at(-1).v!==Math.max(0,...before.versions.map(v=>v.v))+1)throw Error('PROTOTYPE_VERSION_SEQUENCE_INVALID');assertPrototypeWorkingState(next);return true;};
S.proto.draft=null;S.proto.undo=[];S.proto.redo=[];S.proto.modified=false;S.proto.finalVer=S.proto.finalized?S.proto.cur:0;freeze(S.proto.versions);
window.prototypePendingFingerprint=pend=>hash(Array.isArray(pend)?pend:S.proto.pend||[]);
window.prototypeMessageFingerprint=message=>hash(message);
window.prototypeSessionMessagesFingerprint=messages=>hash(Array.isArray(messages)?messages:[]);
const prototypeSnapshotIdentity=state=>hash({projectId:state.projectId,governing:state.governing,proto:state.proto,design:state.design,events:state.events,notices:state.notices,sessions:state.sessions,curSession:state.curSession,receipts:state.receipts});
const prototypePublishedIdentity=()=>prototypeSnapshotIdentity({projectId:S.proj?.id||'',governing:designPrototypeGoverningSnapshot(),proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,sessions:S.sessions,curSession:S.curSession,receipts:V19_RUNTIME.prototypeReceipts});
window.capturePrototypeCommandSnapshot=function(){return clone({projectId:S.proj?.id||'',proto:S.proto,design:S.design.prototype,events:S.events,notices:S.notices,sessions:S.sessions,curSession:S.curSession,receipts:V19_RUNTIME.prototypeReceipts,governing:designPrototypeGoverningSnapshot(),identity:prototypePublishedIdentity()});};
function commandEffect(context,index,kind,payload,business){return {effectId:context.receiptId+':'+index,kind,status:'pending',payload:clone(payload||{}),attempts:0,lastError:'',business:!!business,timerHandle:null,operationId:''};}
function appendPrototypeSession(next,role,text,extra){const session=prototypeSession(next);if(!session)throw Error('PROTOTYPE_SESSION_MISSING');session.msgs.push(Object.assign({role,text},clone(extra||{})));}
function appendPrototypeEvent(next,context,type,text){next.events.unshift({at:context.at,type,text});}
function appendPrototypeNotice(next,context,text){next.notices.unshift({at:context.at,text,unread:true});}
function stalePrototypeOperation(next,context,type){const op=next.design.operation;if(op?.status!=='running')return;op.opToken+='-stale-'+context.nonce;op.status='stale';window.designAudit('prototype.operation.stale',op.operationId,'原型 '+type+' 使旧操作失效',op.runId,next.design,{at:context.at,actor:context.actor});}
function auditPrototypeCommand(next,context,type){const prefix=type==='add-reference'||type==='remove-reference'?'prototype.reference.':'prototype.content.';window.designAudit(prefix+type,'v'+next.proto.cur,'用户修改原型','',next.design,{at:context.at,actor:context.actor});}
function rejectPrepared(reason,message){return {ok:false,changed:false,reason,message};}
window.preparePrototypeCommand=function(snapshot,command,context){
 if(!snapshot||!command||!prototypeCommandTypes.has(command.type))return rejectPrepared('COMMAND_UNSUPPORTED','不支持的原型命令');
 if(snapshot.projectId!=='pj1'||context?.projectId!=='pj1')return rejectPrepared('PROJECT_MISMATCH','当前项目不匹配');
 if(prototypeSnapshotIdentity(snapshot)!==snapshot.identity)return rejectPrepared('SNAPSHOT_TAMPERED','命令快照内容与身份不一致');
 if(snapshot.receipts?.[context?.receiptId]||Object.values(snapshot.receipts||{}).some(receipt=>receipt.commandId===context?.commandId))return rejectPrepared('COMMAND_ID_CONFLICT','命令或收据编号已经发布');
 const type=command.type,payload=clone(command.payload||{}),next={proto:clone(snapshot.proto),design:clone(snapshot.design),events:clone(snapshot.events),notices:clone(snapshot.notices),sessions:clone(snapshot.sessions),curSession:clone(snapshot.curSession),receipts:clone(snapshot.receipts||{})},proto=next.proto,effects=[];
 try{assertPrototypeWorkingState(snapshot.proto);}catch(error){return rejectPrepared(error.message,'原型状态不合法，操作已拒绝');}
 const version=prototypeVersion(proto);
 if(prototypeContentTypes.has(type)&&type!=='unlock'&&proto.finalized)return rejectPrepared('PROTOTYPE_FINALIZED','请先解锁原型定稿');
 if(!context.commandId||!context.receiptId||!context.at||!context.nonce)return rejectPrepared('COMMAND_CONTEXT_INVALID','命令上下文不完整');
 let toastText='',toastType='success',closeModalAfter=false,scheduleCheck=false,observeDev=false;
 if(type==='save-html'){
  if(!version)return rejectPrepared('PROTOTYPE_REQUIRED','原型尚未生成');
  if(typeof payload.html!=='string')return rejectPrepared('HTML_REQUIRED','缺少保存内容');
  if(payload.html===version.html)return rejectPrepared('NO_CHANGE','内容没有变化');
  writePrototypeDraft(proto,{html:payload.html,manifest:clone(version.manifest||{})});proto.viewMode='src';appendPrototypeEvent(next,context,'artifact.save','原型 UI 手工编辑保存（草稿，未改版本号）');toastText='已保存草稿；「版本提交」已可用';
 }else if(type==='undo'){
  if(!version||!proto.undo.length)return rejectPrepared('NO_CHANGE','没有可撤销内容');
  if(equal(proto.undo.at(-1),prototypeContentPair(version)))return rejectPrepared('NO_CHANGE','内容没有变化');proto.redo.push(prototypeContentPair(version));proto.redo=proto.redo.slice(-30);normalizePrototypeDraft(proto,proto.undo.pop());toastText='已撤销';toastType='';
 }else if(type==='redo'){
  if(!version||!proto.redo.length)return rejectPrepared('NO_CHANGE','没有可重做内容');
  if(equal(proto.redo.at(-1),prototypeContentPair(version)))return rejectPrepared('NO_CHANGE','内容没有变化');proto.undo.push(prototypeContentPair(version));proto.undo=proto.undo.slice(-30);normalizePrototypeDraft(proto,proto.redo.pop());toastText='已重做';toastType='';
 }else if(type==='switch-version'){
  const target=Number(payload.version);if(!proto.versions.some(v=>v.v===target))return rejectPrepared('VERSION_MISSING','目标版本不存在');
  if(target===proto.cur)return rejectPrepared('NO_CHANGE','已经是当前版本');
  if(proto.modified||(proto.pend||[]).length)return rejectPrepared('PROTOTYPE_DIRTY','请先提交修改或处理待确认项再切换版本');
  proto.cur=target;proto.undo=[];proto.redo=[];proto.modified=false;proto.pend=[];toastText='已切换到 v'+target;toastType='';
 }else if(type==='commit-version'){
  if(!version||!proto.modified)return rejectPrepared('NO_CHANGE','当前版本没有待提交修改');
  if(proto.pend.length)return rejectPrepared('PROTOTYPE_DIRTY','请先处理待确认项');const newV=Math.max(...proto.versions.map(v=>v.v))+1;appendPrototypeVersion(proto,{v:newV,at:context.at,by:context.actor,html:version.html,note:'用户提交',manifest:clone(version.manifest||{})});appendPrototypeEvent(next,context,'artifact.version','原型 UI 提交版本 v'+newV);appendPrototypeNotice(next,context,'原型 UI v'+newV+' 已提交');toastText='已提交为 v'+newV;
 }else if(type==='accept-pending'){
  const pending=proto.pend?.[0];if(!version||!pending)return rejectPrepared('NO_CHANGE','没有待确认修改');
  if(typeof pending.from!=='string'||!pending.from||!version.html.includes(pending.from))return rejectPrepared('PENDING_TARGET_MISMATCH','目标文本已变化，待确认项保留');
  if(!writePrototypeDraft(proto,{html:version.html.replace(pending.from,pending.to),manifest:clone(version.manifest||{})}))return rejectPrepared('NO_CHANGE','内容没有变化');proto.pend=[];appendPrototypeEvent(next,context,'pending.applied','原型 UI 源码修改已确认（edit_patch）');toastText='已接受修改；可「版本提交」';
 }else if(type==='reject-pending'){
  if(!proto.pend?.length)return rejectPrepared('NO_CHANGE','没有待确认修改');proto.pend=[];appendPrototypeEvent(next,context,'pending.rejected','原型 UI 源码修改已拒绝');toastText='已拒绝，源码保持不变';toastType='';
 }else if(type==='propose-pending'){
  if(!version)return rejectPrepared('PROTOTYPE_REQUIRED','原型尚未生成');
  const currentContent=hash({versionId:'v'+version.v,htmlFingerprint:hash(version.html),manifestFingerprint:hash(version.manifest||{})});
  const session=next.sessions.find(s=>s.id===payload.sessionId),messageIndex=payload.targetMessageIndex,message=session?.msgs?.[messageIndex],basisComplete=typeof payload.expectedPendingFingerprint==='string'&&payload.expectedSessionCtx==='proto'&&Number.isInteger(messageIndex)&&typeof payload.targetMessageFingerprint==='string'&&Number.isInteger(payload.expectedMessageCount)&&typeof payload.expectedSessionMessagesFingerprint==='string';
  if(!basisComplete)return rejectPrepared('AI_BASIS_INVALID','AI 修改结果缺少启动时的 pending、会话或消息身份');
  if(proto.pend?.length||payload.expectedPendingFingerprint!==prototypePendingFingerprint(proto.pend))return rejectPrepared('PENDING_EXISTS','已有待确认修改，不能覆盖');
  if(payload.projectId!=='pj1'||payload.expectedVersionId!=='v'+version.v||payload.expectedContentFingerprint!==currentContent||payload.sessionId!==next.curSession.proto||session?.ctx!=='proto'||session.ctx!==payload.expectedSessionCtx||payload.expectedMessageCount!==session.msgs.length||messageIndex!==session.msgs.length-1||payload.expectedSessionMessagesFingerprint!==prototypeSessionMessagesFingerprint(session.msgs)||payload.targetMessageFingerprint!==prototypeMessageFingerprint(message))return rejectPrepared('AI_RESULT_STALE','AI 修改结果的项目、版本、内容、会话或目标消息已过期');
  if(typeof payload.from!=='string'||!payload.from||!version.html.includes(payload.from))return rejectPrepared('PENDING_TARGET_MISMATCH','AI 修改目标已变化');
  proto.pend=[{marker:payload.marker||payload.from,from:payload.from,to:String(payload.to||''),reason:String(payload.reason||''),line:String(payload.line||'')}];
  if(payload.pendingActions)message.pendActions=clone(payload.pendingActions);appendPrototypeEvent(next,context,'pending.created','原型 UI 源码产生 1 处待确认修改（edit_patch）');toastText='AI 修改已进入待确认';toastType='';
 }else if(type==='import-draft'){
  if(typeof payload.html!=='string'||!payload.name||!payload.manifest)return rejectPrepared('IMPORT_INVALID','上传初稿未完成读取、校验或目录分析');
  if(proto.modified||proto.pend.length)return rejectPrepared('PROTOTYPE_DIRTY','请先提交修改或处理待确认项');const newV=proto.versions.length?Math.max(...proto.versions.map(v=>v.v))+1:1;appendPrototypeVersion(proto,{v:newV,at:context.at,by:context.actor+'（上传）',html:payload.html,note:'人工上传初稿',manifest:clone(payload.manifest)});proto.viewMode='src';appendPrototypeEvent(next,context,'stage.proto','原型初稿入库 v'+newV+'（'+payload.name+'）');appendPrototypeNotice(next,context,'原型 UI v'+newV+'（上传初稿）已入库，规范检查待执行');appendPrototypeSession(next,'ai','📥 「'+payload.name+'」已作为初稿入库为 v'+newV+'，正在安排对应性检查…');toastText='初稿已入库为 v'+newV;closeModalAfter=true;scheduleCheck=true;
 }else if(type==='unlock'){
  if(!proto.finalized)return rejectPrepared('NO_CHANGE','原型尚未定稿');proto.finalized=false;proto.finalVer=0;next.design.status=version?'generated':'idle';appendPrototypeEvent(next,context,'stage.proto','原型 UI 已解锁定稿');appendPrototypeNotice(next,context,'原型 UI 已解锁，旧开发依据立即失效');toastText='原型 UI 已解锁';observeDev=true;
 }else if(type==='add-reference'){
  if(!payload.name)return rejectPrepared('REFERENCE_INVALID','参考样本缺少名称');const id=String(payload.id||('PROTO-REF-'+context.nonce));if(proto.refs.some(r=>r.id===id))return rejectPrepared('NO_CHANGE','参考样本已存在');proto.refs.push({id,name:String(payload.name),at:context.at.slice(5,16)});appendPrototypeEvent(next,context,'stage.proto','参考样本上传：'+payload.name+'（不进版本仓、不参与定稿）');appendPrototypeSession(next,'ai','📎 参考样本「'+payload.name+'」已加入参考区，下次生成将作为风格约束装配。');toastText='已加入参考样本（生成参考，不参与定稿）';closeModalAfter=true;
 }else if(type==='remove-reference'){
  const found=proto.refs.find(r=>r.id===payload.id);if(!found)return rejectPrepared('NO_CHANGE','参考样本不存在');proto.refs=proto.refs.filter(r=>r.id!==payload.id);appendPrototypeEvent(next,context,'stage.proto','参考样本移除：'+found.name);appendPrototypeSession(next,'ai','参考样本「'+found.name+'」已移除，版本仓不受影响。');toastText='已移除参考样本（版本仓不受影响）';toastType='';
 }
 if(prototypeContentTypes.has(type))stalePrototypeOperation(next,context,type);
 next.proto.finalized=type==='unlock'?false:next.proto.finalized;if(prototypeContentTypes.has(type)){next.design.status='generated';next.design.currentCheckReportId='';}
 assertPrototypeVersionHistory(snapshot.proto,next.proto,type);
 auditPrototypeCommand(next,context,type);
 let effectIndex=0;if(closeModalAfter)effects.push(commandEffect(context,effectIndex++,'modal-close',{expectedHtml:payload.modalHtml||''},false));effects.push(commandEffect(context,effectIndex++,'render',{},false));if(toastText)effects.push(commandEffect(context,effectIndex++,'toast',{message:toastText,type:toastType},false));
 let dispatchEffect;if(scheduleCheck){dispatchEffect=commandEffect(context,effectIndex++,'dispatch-check',{projectId:'pj1',versionId:'v'+next.proto.cur,contentFingerprint:hash({proto:next.proto.cur,html:prototypeVersion(next.proto).html,manifest:prototypeVersion(next.proto).manifest}),dispatchToken:context.nonce},true);effects.push(commandEffect(context,effectIndex++,'schedule-check',{delay:700,dispatchEffectId:dispatchEffect.effectId,projectId:'pj1',versionId:dispatchEffect.payload.versionId,contentFingerprint:dispatchEffect.payload.contentFingerprint},true));effects.push(dispatchEffect);}
 if(observeDev)effects.push(commandEffect(context,effectIndex++,'observe-dev-input',{projectId:'pj1',unlockedFinalizationId:snapshot.proto._finalizationSeq||0,unlockedVersionId:'v'+snapshot.proto.cur},true));
 const receipt={receiptId:context.receiptId,projectId:'pj1',commandId:context.commandId,commandType:type,committedIdentity:hash({proto:next.proto,design:next.design}),effects,committedAt:context.at};next.receipts[receipt.receiptId]=clone(receipt);
 const prepared={ok:true,changed:true,expectedIdentity:snapshot.identity,next,effects:clone(effects),receipt:clone(receipt)};prepared.preparedFingerprint=hash({expectedIdentity:prepared.expectedIdentity,next:prepared.next,receipt:prepared.receipt});return prepared;
};
window.publishPrototypeCommand=function(expectedIdentity,prepared){
 if(!prepared?.ok)return {committed:false,reason:'PUBLISH_CONFLICT'};
 if(hash({expectedIdentity:prepared.expectedIdentity,next:prepared.next,receipt:prepared.receipt})!==prepared.preparedFingerprint)return {committed:false,reason:'PREPARED_TAMPERED'};
 if(expectedIdentity!==prepared.expectedIdentity||prototypePublishedIdentity()!==prepared.expectedIdentity)return {committed:false,reason:'PUBLISH_CONFLICT'};
 const liveReceipts=V19_RUNTIME.prototypeReceipts,receiptId=prepared.receipt.receiptId,commandId=prepared.receipt.commandId,liveKeys=Object.keys(liveReceipts),nextKeys=Object.keys(prepared.next.receipts);if(liveReceipts[receiptId]||Object.values(liveReceipts).some(receipt=>receipt.commandId===commandId)||nextKeys.length!==liveKeys.length+1||!prepared.next.receipts[receiptId]||liveKeys.some(key=>JSON.stringify(prepared.next.receipts[key])!==JSON.stringify(liveReceipts[key])))return {committed:false,reason:'COMMAND_ID_CONFLICT'};
 const next=prepared.next;try{assertPrototypeVersionHistory(S.proto,next.proto,prepared.receipt.commandType);}catch(error){return {committed:false,reason:error.message};}freeze(next.proto.versions);for(const key of ['plans','checkReports','baselines'])for(const record of next.design[key]||[])freeze(record);for(const receipt of Object.values(next.receipts)){for(const effect of receipt.effects){Object.freeze(effect.payload);for(const key of ['effectId','kind','payload','business'])Object.defineProperty(effect,key,{writable:false,configurable:false});Object.seal(effect);}Object.freeze(receipt.effects);Object.freeze(receipt);}
 S.proto=next.proto;S.design.prototype=next.design;S.events=next.events;S.notices=next.notices;S.sessions=next.sessions;S.curSession=next.curSession;V19_RUNTIME.prototypeReceipts=next.receipts;
 return {committed:true,receiptId:prepared.receipt.receiptId};
};
function prototypeEffectCurrent(receipt,effect){if(effect.kind==='observe-dev-input')return S.proj?.id===receipt.projectId;if(S.proj?.id!==receipt.projectId)return false;const version=prototypeVersion(S.proto);if(!['schedule-check','dispatch-check'].includes(effect.kind))return true;return effect.payload.versionId==='v'+S.proto.cur&&effect.payload.contentFingerprint===hash({proto:S.proto.cur,html:version?.html||'',manifest:version?.manifest||{}});}
function effectPendingSummary(receipt){return {presentationPending:receipt.effects.some(e=>!e.business&&!['done','stale'].includes(e.status)),businessEffectsPending:receipt.effects.some(e=>e.business&&!['done','stale'].includes(e.status))};}
function upsertPrototypeToast(effect){const root=document.querySelector('#toast-wrap'),selector='[data-prototype-effect="'+effect.effectId+'"]';if(root?.querySelector(selector))return;const before=root?new Set(root.children):new Set();try{toast(effect.payload.message,effect.payload.type||'');}finally{if(root){const created=[...root.children].filter(node=>!before.has(node)).at(-1);if(created)created.setAttribute('data-prototype-effect',effect.effectId);}}}
function runPrototypeEffect(receipt,effect){
 if(['done','stale','running'].includes(effect.status))return;
 if(!prototypeEffectCurrent(receipt,effect)){if(S.proj?.id===receipt.projectId)effect.status='stale';return;}
 effect.status='running';effect.attempts+=1;effect.lastError='';
 try{
  if(effect.kind==='modal-close'){const root=document.querySelector('#modal-root');if(!root||!root.innerHTML||effect.payload.expectedHtml&&root.innerHTML!==effect.payload.expectedHtml){effect.status='done';return;}closeModal();}
  else if(effect.kind==='render')render();
  else if(effect.kind==='toast')upsertPrototypeToast(effect);
  else if(effect.kind==='schedule-check'){const handle=setTimeout(()=>{const current=V19_RUNTIME.prototypeReceipts[receipt.receiptId],target=current?.effects.find(e=>e.effectId===effect.payload.dispatchEffectId);if(current&&target)runPrototypeEffect(current,target);},effect.payload.delay);if(handle===undefined||handle===null)throw Error('PROTOTYPE_CHECK_TIMER_NOT_REGISTERED');effect.timerHandle=handle;}
  else if(effect.kind==='dispatch-check'){
   const beforeId=S.design.prototype.operation?.operationId||'',matches=op=>!!op&&op.operationId!==beforeId&&op.projectId!=='other'&&op.dispatchAction==='check'&&op.input?.prototypeContentFingerprint===designPrototypeOutputSnapshot().contentFingerprint;
   let started;try{started=designCheckPrototype();}catch(error){const uncertain=S.design.prototype.operation;if(matches(uncertain)){effect.operationId=uncertain.operationId;effect.status='done';return;}throw error;}
   const op=S.design.prototype.operation;if(started&&matches(op))effect.operationId=op.operationId;else if(matches(op))effect.operationId=op.operationId;else throw Error('PROTOTYPE_CHECK_DISPATCH_REJECTED');
  }else if(effect.kind==='observe-dev-input'){
   const resolved=resolveDevInputs(S.dev,S),settled=!devInputChanges(S.dev,resolved).length&&!devMissingInputDispositions(S.dev,resolved).length&&!devBaselineDrift(S.dev,resolved);if(!settled){const observed=devMarkInputDirty('原型 UI 已解锁');if(!observed){const again=resolveDevInputs(S.dev,S);if(devInputChanges(S.dev,again).length||devMissingInputDispositions(S.dev,again).length||devBaselineDrift(S.dev,again))throw Error('PROTOTYPE_DEV_INPUT_OBSERVE_PENDING');}}
  }
  effect.status='done';
 }catch(error){effect.status='failed';effect.lastError=String(error?.message||error);}
}
window.flushPrototypeEffects=function(receiptId,options={}){const receipt=V19_RUNTIME.prototypeReceipts[receiptId];if(!receipt)return {presentationPending:false,businessEffectsPending:false,missing:true};for(const effect of receipt.effects){if(effect.kind==='dispatch-check'&&!options.includeDispatch)continue;runPrototypeEffect(receipt,effect);}return effectPendingSummary(receipt);};
window.designRecoverPrototypeEffects=function(receiptId){const ids=receiptId?[receiptId]:Object.keys(V19_RUNTIME.prototypeReceipts);let result={presentationPending:false,businessEffectsPending:false};for(const id of ids){const current=flushPrototypeEffects(id,{includeDispatch:true});result.presentationPending=result.presentationPending||current.presentationPending;result.businessEffectsPending=result.businessEffectsPending||current.businessEffectsPending;}return result;};
function prototypeCommandContext(){const at=now(),nonce=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9),commandId='PROTO-CMD-'+nonce;return {projectId:S.proj?.id||'',commandId,receiptId:'PROTO-RECEIPT-'+nonce,at,actor:'superopen',nonce};}
window.executePrototypeCommand=function(command){designRecoverPrototypeEffects();const snapshot=capturePrototypeCommandSnapshot(),ctx=prototypeCommandContext(),prepared=preparePrototypeCommand(snapshot,command,ctx);if(!prepared.ok)return Object.assign({ok:false,committed:false,presentationPending:false,businessEffectsPending:false},prepared);const published=publishPrototypeCommand(snapshot.identity,prepared);if(!published.committed)return {ok:false,changed:true,committed:false,reason:published.reason,presentationPending:false,businessEffectsPending:false};const pending=flushPrototypeEffects(published.receiptId,{includeDispatch:false});return Object.assign({ok:true,changed:true,committed:true,receiptId:published.receiptId},pending);};
for(const name of ['designPlanPrototype','designGeneratePrototype','designCheckPrototype','designFinalizePrototypeBaseline']){const original=window[name];window[name]=function(...args){designRecoverPrototypeEffects();return original.apply(this,args);};}
window.genProto=window.designGeneratePrototype;window.lintProto=window.designCheckPrototype;window.finalProto=window.designFinalizePrototypeBaseline;window.doFinalProto=window.designFinalizePrototypeBaseline;
window.snapProto=function(){return false;};
window.commitPrototypeAction=function(){return false;};
window.commitPrototypeContentAction=function(action,command){if(typeof command==='function')throw Error('PROTOTYPE_ARBITRARY_MUTATOR_FORBIDDEN');return executePrototypeCommand(command||{type:action,payload:{}});};
const prototypeUiResult=result=>!!(result&&result.ok&&result.committed);
window.saveProtoEditor=function(){const editor=document.querySelector('#proto-editor');if(!editor)return false;return prototypeUiResult(executePrototypeCommand({type:'save-html',payload:{html:editor.value}}));};
window.protoUndo=function(){return prototypeUiResult(executePrototypeCommand({type:'undo',payload:{}}));};
window.protoRedo=function(){return prototypeUiResult(executePrototypeCommand({type:'redo',payload:{}}));};
window.commitProtoVer=function(){return prototypeUiResult(executePrototypeCommand({type:'commit-version',payload:{}}));};
window.switchProtoVer=function(version){if(S.proto.modified||S.proto.pend?.length){toast('请先提交修改或处理待确认项再切换版本','warn');render();return false;}return prototypeUiResult(executePrototypeCommand({type:'switch-version',payload:{version:Number(version)}}));};
window.acceptProtoPend=function(){const result=executePrototypeCommand({type:'accept-pending',payload:{}});if(!result.ok&&result.reason==='PENDING_TARGET_MISMATCH')toast('目标文本已变化，待确认项已保留','warn');return prototypeUiResult(result);};
window.rejectProtoPend=function(){return prototypeUiResult(executePrototypeCommand({type:'reject-pending',payload:{}}));};
window.doUploadProto=function(){const name=document.querySelector('#up-html')?.value,mode=[...document.querySelectorAll('input[name=up-mode]')].find(r=>r.checked)?.value,modalHtml=document.querySelector('#modal-root')?.innerHTML||'';if(mode==='ref')return prototypeUiResult(executePrototypeCommand({type:'add-reference',payload:{name,modalHtml}}));if(mode!=='draft')return false;const html=UPLOAD_DRAFT_HTML;return prototypeUiResult(executePrototypeCommand({type:'import-draft',payload:{name,html,manifest:v19GeneratedPrototypeManifest(html),modalHtml}}));};
window.delProtoRef=function(id){return prototypeUiResult(executePrototypeCommand({type:'remove-reference',payload:{id}}));};
window.designUnlockPrototype=function(){return prototypeUiResult(executePrototypeCommand({type:'unlock',payload:{}}));};

// 发布边界保护历史收据；业务读取仍沿用 DevStore 的递归只读 facade。
window.v19AssertPublishedReceipts=function(old,next,action){
 const a=old.selftest,b=next.selftest;
 if(a){
  const before=a.reports||[],after=b?.reports||[];
  if(after.length<before.length||before.some((r,i)=>!equal(r,after[i])))throw Error('SELFTEST_HISTORY_IMMUTABLE');
  const appended=after.length-before.length;
  if(appended&&(action!=='selftest.complete'||appended!==1))throw Error('SELFTEST_APPEND_INVALID');
  if(appended){if(b.currentReportId!==after.at(-1).reportId||b.nextReport!==a.nextReport+1)throw Error('SELFTEST_POINTER_INVALID');}
  else if(b.currentReportId!==a.currentReportId||b.nextReport!==a.nextReport)throw Error('SELFTEST_POINTER_INVALID');
 }
 if(old.build&&next.build&&old.build.buildId===next.build.buildId&&!equal(old.build,next.build))throw Error('BUILD_RECEIPT_IMMUTABLE');
 if(next.build&&(!old.build||old.build.buildId!==next.build.buildId)&&action!=='build.complete')throw Error('BUILD_RECEIPT_REPLACEMENT_INVALID');
};

window.v19InspectVerifiedUI=function(html){
 if(uiInspectionCache.has(html))return uiInspectionCache.get(html);
 const doc=new DOMParser().parseFromString(html||'','text/html'),cert=V19_VERIFIED_UI_CERTIFICATE,issues=[];
 const add=(code,message,target)=>issues.push({code,message,target,severity:'blocking',humanRequired:true});
 if(cert.reviewDecision!=='GO')add('UI_REVIEW_NOT_APPROVED','V1.9 主流程复核未通过：原型写入失败仍可能残留界面和事件，当前不能定稿或用于合格自测','customer-review');
 const nodes=[...doc.querySelectorAll('[data-prototype-page]')],pages=nodes.map(n=>n.dataset.prototypePage);
 if(!equal(pages.slice().sort(),Object.keys(cert.pages).sort()))add('UI_PAGE_SET_UNVERIFIED','实际页面集合与已验证范围不同','pages');
 for(const node of nodes)if(digest(node.outerHTML)!==cert.pages[node.dataset.prototypePage])add('UI_CONTENT_UNVERIFIED','页面内容、字段、权限或操作约束已改变，需重新验证',node.dataset.prototypePage);
 if(digest([...doc.scripts].map(s=>s.textContent).join('\n'))!==cert.runtime)add('UI_BEHAVIOR_UNVERIFIED','行为脚本与已执行九条业务链的版本不一致，不能推断交互通过','runtime');
 if(digest([...doc.querySelectorAll('style')].map(s=>s.textContent).join('\n'))!==cert.styles)add('UI_LAYOUT_UNVERIFIED','样式与已验证的屏幕适配版本不同','styles');
 if(doc.querySelector('[data-route]:not([data-prototype-control])'))add('UI_ROUTE_UNTRACED','存在未登记的导航入口','navigation');
 const result=freeze({ok:!issues.length,issues,pages,certificate:cert.version,flows:cert.flows.map(flowId=>({flowId,status:issues.length?'unverified':'pass',evidence:cert.evidence})),observedFingerprint:hash({html,certificate:cert})});
 if(uiInspectionCache.size>=4)uiInspectionCache.delete(uiInspectionCache.keys().next().value);
 uiInspectionCache.set(html,result);return result;
};
window.v19CreateBuildUiArtifact=function(build){
 const html=v19BuildCandidateHTML(build),inspected=v19InspectVerifiedUI(html);
 if(!inspected.ok)throw Error('BUILD_UI_UNVERIFIED: '+inspected.issues[0].message);
 const manifest={pageIds:inspected.pages,sourceTaskRevisions:clone(build.taskRevisions),sourceCodeRevisions:clone(build.codeRevisions),commits:clone(build.commits),implementationSourceFingerprint:hash(V19_BUILD_IMPLEMENTATION_SPEC),verificationCertificate:inspected.certificate};
 return freeze({artifactId:build.buildId+'-UI',html,htmlFingerprint:hash(html),implementationManifest:manifest,manifestFingerprint:hash(manifest)});
};
window.devInspectBuildUiArtifact=function(build){
 const raw=devBuildIdentity(build),actual=v19InspectVerifiedUI(build?.uiArtifact?.html||''),issues=[...raw.issues,...actual.issues],b=baseline(),observations=[];
 const manifest=build?.uiArtifact?.implementationManifest;
 if(manifest&&(!equal(manifest.pageIds,actual.pages)||!equal(manifest.sourceTaskRevisions,build.taskRevisions)||!equal(manifest.sourceCodeRevisions,build.codeRevisions)||!equal(manifest.commits,build.commits)||manifest.implementationSourceFingerprint!==hash(V19_BUILD_IMPLEMENTATION_SPEC)||manifest.verificationCertificate!==V19_VERIFIED_UI_CERTIFICATE.version))issues.push({code:'BUILD_SOURCE_MISMATCH',message:'构建的页面、代码、提交或验证来源不一致'});
 if(build?.planSnapshotId!==S.dev.plan.approved?.snapshotId)issues.push({code:'BUILD_PLAN_MISMATCH',message:'构建不属于当前批准计划'});
 const tasks=(S.dev.plan.approved?.taskIds||[]).map(devTaskById).filter(Boolean);
 if(build&&(build.status!=='pass'||!equal(build.taskRevisions,Object.fromEntries(tasks.map(t=>[t.id,t.rev])))||!equal(build.codeRevisions,Object.fromEntries(tasks.map(t=>[t.id,t.codeRev])))||!equal(build.commits,tasks.map(t=>t.pr?.commitId))))issues.push({code:'BUILD_CURRENT_SOURCE_MISMATCH',message:'任务或提交已变化，必须重新构建'});
 for(const cell of b?.uiAcceptance?.matrix||[]){for(const id of cell.expectedCriticalCheckIds.concat(cell.expectedGeneralCheckIds))observations.push({pageId:cell.pageId,viewportId:cell.viewportId,id,checkId:id,kind:cell.expectedCriticalCheckIds.includes(id)?'critical':'general',status:issues.length?'fail':'pass',evidence:{type:'verified-example-replay',certificate:actual.certificate,source:'固定示例的独立浏览器验证签名；不代表通用视觉算法'}});}
 return {...raw,ok:!issues.length,issues,pages:actual.pages,flows:actual.flows,observations,observedFingerprint:hash({raw:raw.computedHtmlFingerprint,actual:actual.observedFingerprint})};
};

// 合并依据必须由双对象和精确审计共同支撑。
const tuple=(task,pr)=>({prId:pr.id,taskId:task.id,taskRev:task.rev,codeRev:task.codeRev,commitId:pr.commitId,headRevision:pr.headRevision});
const sameTuple=(event,t)=>Object.keys(t).every(k=>event?.[k]===t[k]);
function enrichManualAudit(action,prId){const p=devPrById(prId),t=p&&devTaskById(p.taskId),e=S.dev.audit.find(e=>e.action===action&&e.target===prId);if(!p||!t||!e)return;Object.assign(e,tuple(t,p),{checklistSnapshot:clone(p.checks||[]),skipReason:p.skipReason||''});}
for(const [name,action] of [['prToggleCheck','pr.manual.check'],['doPrSkip','pr.manual.skip']]){const old=window[name];window[name]=function(id,...args){return commitDevAction(name,id,()=>{const before=S.dev.nextAudit,result=old(id,...args);if(S.dev.nextAudit!==before)enrichManualAudit(action,id);return result;});};}
function attachBasis(prId,kind){
 const p=devPrById(prId),t=p&&devTaskById(p.taskId);if(!p||!t||p.status!=='merged'||t.pr?.status!=='merged')return false;
 const identity=tuple(t,p),action=kind==='autopilot-authorization'?'autopilot.merge':'pr.merge',merge=S.dev.audit.find(e=>e.action===action&&e.target===prId);if(!merge)throw Error('MERGE_AUDIT_MISSING');Object.assign(merge,identity);
 const basis={kind,...identity,mergeAuditId:merge.eventId,checklistSnapshot:clone(p.checks||[]),skipReason:p.skipReason||''};
 if(kind==='autopilot-authorization'){basis.authorizationId=S.dev.autopilot.authorization.authorizationId;basis.aiReviewEvidenceId=typeof t.evidence.aiReview==='string'?t.evidence.aiReview:t.evidence.aiReview.evidenceId;}
 else {basis.decisionAuditIds=S.dev.audit.filter(e=>['pr.manual.check','pr.manual.skip'].includes(e.action)&&sameTuple(e,identity)).map(e=>e.eventId);if(kind==='manual-skip'){const e=S.dev.audit.find(e=>e.action==='pr.manual.skip'&&sameTuple(e,identity)&&e.skipReason===basis.skipReason);if(!e)throw Error('SKIP_RECEIPT_MISSING');basis.skipReceipt={reason:e.skipReason,actor:e.actor,at:e.at,auditEventId:e.eventId};}}
 p.mergeBasis=freeze(clone(basis));t.pr.mergeBasis=freeze(clone(basis));return true;
}
const oldMerge=window.prMerge;window.prMerge=function(id){return commitDevAction('prMerge',id,()=>{oldMerge(id);const p=devPrById(id);return p?.status==='merged'?attachBasis(id,p.skipReason?'manual-skip':'manual-checklist'):false;});};
const oldAutoMerge=window.v18AutoMerge;window.v18AutoMerge=function(id,token){return commitDevAction('autopilot.merge',id,()=>{if(!oldAutoMerge(id,token))return false;return attachBasis(devTaskById(id).pr.id,'autopilot-authorization');});};
window.devResolveMergeBasis=function(pr,dev=S.dev){
 const task=dev.tasks?.find(t=>t.id===pr?.taskId),record=dev.prs?.find(p=>p.id===pr?.id),bad=()=>failure('MERGE_BASIS_MISSING','缺少当前提交的完整双向合并依据');
 if(!task||!record||pr.status!=='merged'||record.status!=='merged'||!equal(tuple(task,pr),tuple(task,record)))return bad();
 const identity=tuple(task,pr);let basis=pr.mergeBasis;
 if(!basis&&!record.mergeBasis){
  const merge=dev.audit?.find(e=>e.action==='pr.merge'&&e.target===pr.id&&sameTuple(e,identity));
  if(!merge||!equal(pr.checks,record.checks)||(pr.skipReason||'')!==(record.skipReason||''))return bad();
  const decisions=dev.audit.filter(e=>['pr.manual.check','pr.manual.skip'].includes(e.action)&&e.target===pr.id&&sameTuple(e,identity));
  const skip=decisions.find(e=>e.action==='pr.manual.skip'&&e.skipReason===pr.skipReason&&e.actor&&e.at);
  if(pr.skipReason?!skip:!pr.checks?.length||!pr.checks.every((c,i)=>c.checked&&decisions.some(e=>e.action==='pr.manual.check'&&equal(e.checklistSnapshot?.[i],c)&&e.actor&&e.at)))return bad();
  return {ok:true,basis:{kind:'legacy-manual',...identity,mergeAuditId:merge.eventId,sourceAuditEventIds:[merge.eventId,...decisions.map(e=>e.eventId)],checklistSnapshot:clone(pr.checks),skipReceipt:skip?{reason:skip.skipReason,actor:skip.actor,at:skip.at,auditEventId:skip.eventId}:null}};
 }
 if(!basis||!record.mergeBasis||!equal(basis,record.mergeBasis)||!sameTuple(basis,identity)||!equal(pr.checks,record.checks)||(pr.skipReason||'')!==(record.skipReason||''))return bad();
 const merge=dev.audit?.find(e=>e.eventId===basis.mergeAuditId);if(!merge||!sameTuple(merge,identity)||merge.target!==pr.id)return bad();
 if(basis.kind==='autopilot-authorization'){
  const auth=dev.autopilot?.authorizationReceipts?.find(a=>a.authorizationId===basis.authorizationId),review=dev.aiReviews?.find(r=>r.evidenceId===basis.aiReviewEvidenceId);
  if(merge.action!=='autopilot.merge'||!auth?.scope?.merge||!auth.taskIds.includes(task.id)||auth.taskRevisions[task.id]!==task.rev||!review||review.decision!=='pass'||review.authorizationId!==auth.authorizationId||!sameTuple(review,identity)||review.reviewerId===task.owner||review.independentFrom!==task.owner||review.unitEvidenceId!==task.evidence?.unit?.evidenceId||review.ciEvidenceId!==task.evidence?.ci?.evidenceId)return bad();
 }else if(['manual-checklist','manual-skip'].includes(basis.kind)){
  if(merge.action!=='pr.merge'||!equal(basis.checklistSnapshot,pr.checks)||basis.skipReason!==(pr.skipReason||''))return bad();
  const receipts=(basis.decisionAuditIds||[]).map(id=>dev.audit.find(e=>e.eventId===id));if(!receipts.length||receipts.some(e=>!e||!sameTuple(e,identity)))return bad();
  if(basis.kind==='manual-skip'){if(!basis.skipReason.trim()||!receipts.some(e=>e.action==='pr.manual.skip'&&e.skipReason===basis.skipReason&&e.actor&&e.at&&equal(basis.skipReceipt,{reason:e.skipReason,actor:e.actor,at:e.at,auditEventId:e.eventId})))return bad();}
  else if(!pr.checks?.length||!pr.checks.every((c,i)=>c.checked&&receipts.some(e=>e.action==='pr.manual.check'&&e.checklistSnapshot?.[i]?.checked)))return bad();
 }else return bad();
 return {ok:true,basis:clone(basis)};
};

function ready(dev){const ids=dev.plan?.approved?.taskIds||[];return ids.length>0&&ids.every(id=>{const t=dev.tasks.find(t=>t.id===id);return t&&t.col==='done'&&t.pr?.status==='merged'&&devAutomatedGate(t,t.pr).ok;});}
window.v19CurrentSelftestSnapshot=function(dev=S.dev){
 const b=baseline(),raw=devBuildIdentity(dev.build);if(!b||!dev.build)return null;
 return {buildId:dev.build.buildId,buildFingerprint:devBuildFingerprint(dev.build),buildUiArtifactId:dev.build.uiArtifact?.artifactId,buildUiHtmlFingerprint:raw.computedHtmlFingerprint,buildUiManifestFingerprint:raw.computedManifestFingerprint,planSnapshotId:dev.plan.approved?.snapshotId,planFingerprint:devPlanGate(dev,'execute').fingerprint,baselineKey:dev.baseline.key,inputFingerprint:devCurrentInputGate(dev).inputFingerprint,designBaselineId:b.baselineId,designBaselineFingerprint:b.fingerprint,prototypeVersionId:b.prototypeVersionId,prototypeHtmlFingerprint:b.prototypeHtmlFingerprint,prototypeCheckReportId:b.checkReportId,prototypeObservedFingerprint:b.checkReportFingerprint,catalogFingerprint:b.catalogFingerprint,acceptanceRuleFingerprint:b.uiAcceptance.rulesFingerprint,taskRevisions:clone(dev.build.taskRevisions),codeRevisions:Object.fromEntries((dev.plan.approved?.taskIds||[]).map(id=>[id,dev.tasks.find(t=>t.id===id)?.codeRev])),commits:clone(dev.build.commits)};
};
function remediation(previous,dev=S.dev){const next=v19CurrentSelftestSnapshot(dev);if(!previous||previous.status!=='fail'||!next||previous.basedOn.buildId===next.buildId||previous.basedOn.buildFingerprint===next.buildFingerprint)return null;const changed=!equal(previous.basedOn.taskRevisions,next.taskRevisions)||!equal(previous.basedOn.codeRevisions,next.codeRevisions)||!equal(previous.basedOn.commits,next.commits);if(!changed)return null;return {fingerprint:hash({reportId:previous.reportId,reportFingerprint:previous.reportFingerprint,from:previous.basedOn,to:next}),refs:(dev.audit||[]).filter(e=>/rework|remediation/.test(e.action)).map(e=>e.eventId)};}
window.devSelfTestOperationValid=function(op,dev=S.dev){
 if(!op||op.kind!=='selftest'||op.status!=='running'||op.projectId!=='pj1'||!designPrototypeGate('develop').ok||!ready(dev)||!devInspectBuildUiArtifact(dev.build).ok||!equal(op.snapshot,v19CurrentSelftestSnapshot(dev)))return false;
 const auto=['selftest','selftest-retest'].includes(op.dispatchAction),retest=['manual-retest','selftest-retest'].includes(op.dispatchAction);
 if(!['manual-selftest','manual-retest','selftest','selftest-retest'].includes(op.dispatchAction)||op.owner!==(auto?'autopilot':'manual'))return false;
 if(retest){const previous=report(dev),rem=remediation(previous,dev);if(!rem||op.retestOfReportId!==previous.reportId||op.retestOfReportFingerprint!==previous.reportFingerprint||op.remediationFingerprint!==rem.fingerprint)return false;}
 else if(op.retestOfReportId||op.retestOfReportFingerprint||op.remediationFingerprint)return false;
 if(auto){const run=dev.autopilot?.run,auth=dev.autopilot?.authorization;if(!run||run.status!=='running'||run.runId!==op.autopilotRunId||run.runToken!==op.autopilotRunToken||!auth||auth.status!=='active'||auth.authorizationId!==op.authorizationId)return false;}
 else if(op.authorizationId||op.autopilotRunId||op.autopilotRunToken)return false;
 return true;
};
function blockParent(op,code,message){const run=S.dev.autopilot?.run;if(op.owner==='autopilot'&&run?.status==='running'&&run.runId===op.autopilotRunId&&run.runToken===op.autopilotRunToken){run.runToken=v18RunToken(run.runId,code);run.status='blocked';run.blocker={code,message,category:'failure'};devClearTimer('autopilot');}}
function retireSelftest(){const old=S.dev.operations.selftest;if(!old||old.status!=='running')return true;if(devSelfTestOperationValid(old))return false;return commitDevAction('selftest.stale',old.runId,()=>{const op=S.dev.operations.selftest;if(op?.opToken!==old.opToken)return false;blockParent(op,'SELFTEST_INPUT_STALE','自测依据已变化，请重新确认');op.opToken+='-stale';op.status='stale';devAudit('selftest.stale',op.runId,S.dev.plan.revision,S.dev.plan.revision,'旧操作已失效');return true;});}
window.devRecoverSelfTestStart=function(runId,token){const receipt=V19_RUNTIME.selftestStartFailures[runId];if(!receipt||receipt.opToken!==token)return false;const op=S.dev.operations.selftest;if(receipt.recovered)return true;if(op?.runId!==runId||op.opToken!==token)return false;const ok=commitDevAction('selftest.start.failed',runId,()=>{const current=S.dev.operations.selftest;if(current?.opToken!==token)return false;const parent=S.dev.autopilot?.run,dispatch=parent?.lastDispatch;if(parent?.runId===current.autopilotRunId&&parent.runToken===current.autopilotRunToken&&dispatch?.action===current.dispatchAction&&dispatch.targetId===current.dispatchTargetId&&dispatch.stateIdentity===current.dispatchStateIdentity&&dispatch.runToken===current.autopilotRunToken)parent.lastDispatch=null;blockParent(current,'SELFTEST_START_FAILED','自测控制步骤未完成，可继续重试');current.status='failed';current.opToken+='-failed';devAudit('selftest.start.failed',runId,S.dev.plan.revision,S.dev.plan.revision,receipt.error);return true;});if(ok)receipt.recovered=true;return ok;};
window.devStartSelfTest=function(options={}){
 for(const [id,r] of Object.entries(V19_RUNTIME.selftestStartFailures))if(!r.recovered)devRecoverSelfTestStart(id,r.opToken);
 if(!devProjectOk()||!retireSelftest())return false;
 const previous=report(),ctx=DEV_RUNTIME.autopilotDispatch,auto=!!ctx&&['selftest','selftest-retest'].includes(ctx.action),retest=auto?ctx.action==='selftest-retest':!!options.retest;
 if(retest?previous?.status!=='fail':previous?.status==='fail')return false;
 const rem=retest?remediation(previous):null;if(retest&&(!rem||!String(options.reason||'').trim()))return false;
 if(!ready(S.dev)||!S.dev.build||!devInspectBuildUiArtifact(S.dev.build).ok||!designPrototypeGate('develop').ok)return false;
 let created;const started=commitDevAction('selftest.start','project',()=>{
  const run=S.dev.autopilot?.run,auth=S.dev.autopilot?.authorization;if(auto&&(!run||run.status!=='running'||ctx.runId!==run.runId||ctx.runToken!==run.runToken||auth?.status!=='active'))return false;
  const runId='SELFTEST-RUN-'+S.dev.nextRun++;
  created={runId,opToken:runId+'-'+Date.now(),kind:'selftest',projectId:'pj1',status:'running',dispatchAction:auto?ctx.action:retest?'manual-retest':'manual-selftest',owner:auto?'autopilot':'manual',dispatchTargetId:auto?ctx.targetId:'',dispatchStateIdentity:auto?run.lastDispatch?.stateIdentity:'',authorizationId:auto?auth.authorizationId:'',autopilotRunId:auto?run.runId:'',autopilotRunToken:auto?run.runToken:'',snapshot:v19CurrentSelftestSnapshot(),retestOfReportId:retest?previous.reportId:'',retestOfReportFingerprint:retest?previous.reportFingerprint:'',remediationFingerprint:rem?.fingerprint||'',remediationRefs:rem?.refs||[],reason:options.reason||'',startedAt:now()};
  S.dev.operations.selftest=created;devAudit('selftest.start',runId,S.dev.plan.revision,S.dev.plan.revision,auto?'自动开发自测':'人工开发自测',runId);return true;
 });if(!started)return false;
 try{setTimeout(()=>{const op=S.dev.operations.selftest;if(op?.opToken!==created.opToken||!devSelfTestOperationValid(op))return;try{commitDevAction('selftest.complete',op.runId,()=>{const current=S.dev.operations.selftest;if(current?.opToken!==created.opToken||!devSelfTestOperationValid(current))return false;const r=v19MakeSelfTestReport(current);r.operation.retestOfReportFingerprint=current.retestOfReportFingerprint;r.reportFingerprint=reportHash(r);S.dev.selftest.reports.push(freeze(r));S.dev.selftest.currentReportId=r.reportId;current.status=r.status==='pass'?'done':'failed';current.finishedAt=now();if(r.status!=='pass')blockParent(current,'SELFTEST_FAILED','开发自测存在未通过项');devAudit('selftest.complete',r.reportId,S.dev.plan.revision,S.dev.plan.revision,r.status,current.runId);render();return true;});}catch(e){V19_RUNTIME.selftestStartFailures[created.runId]={opToken:created.opToken,error:'SELFTEST_COMPLETE_FAILED: '+e.message};try{devRecoverSelfTestStart(created.runId,created.opToken);}catch{}}},900);}
 catch(e){V19_RUNTIME.selftestStartFailures[created.runId]={opToken:created.opToken,error:e.message};try{devRecoverSelfTestStart(created.runId,created.opToken);}catch{}throw e;}
 render();return clone(created);
};
window.devRetestSelfTest=reason=>devStartSelfTest({retest:true,reason});
window.devCanStartSelfTest=()=>{const op=S.dev.operations.selftest;return !!(devProjectOk()&&ready(S.dev)&&S.dev.build&&devInspectBuildUiArtifact(S.dev.build).ok&&designPrototypeGate('develop').ok&&(!op||op.status!=='running'||!devSelfTestOperationValid(op))&&report()?.status!=='fail');};
window.devCanRetestSelfTest=()=>{const op=S.dev.operations.selftest;return !!(devProjectOk()&&ready(S.dev)&&S.dev.build&&devInspectBuildUiArtifact(S.dev.build).ok&&designPrototypeGate('develop').ok&&(!op||op.status!=='running'||!devSelfTestOperationValid(op))&&remediation(report()));};

function additionalChecks(dev=S.dev){
 const checks=[];
 for(const id of dev.plan.approved?.taskIds||[]){
  const t=dev.tasks.find(t=>t.id===id),u=t?.evidence?.unit,c=t?.evidence?.ci;
  const context=type=>({ownerProjectId:'pj1',baselineKey:dev.baseline.key,sourceFingerprint:devTaskSourceFingerprint(dev,t),qualityRev:t.qualityRev||dev.qualityRev,evidenceType:type});
  for(const [kind,ok,evidence] of [['unit',!!t&&devEvidenceValid(u,t,context('unit')),u],['ci',!!t&&devEvidenceValid(c,t,context('ci'))&&['lint','unit','api'].every(k=>c.steps?.[k]==='pass')&&Object.values(c.steps||{}).every(x=>x==='pass'),c],['coverage',!!u&&u.line>=t.quality.line&&u.branch>=t.quality.branch,{actual:{line:u?.line,branch:u?.branch},target:t?.quality}]])checks.push({id:'functional-'+kind+'-'+id,group:'functional',required:true,status:ok?'pass':'fail',evidence:clone(evidence||{})});
 }
 const observed=devInspectBuildUiArtifact(dev.build);
 for(const [id,flowIds] of [['portal-content',['F-001','F-002']],['application',['F-003','F-004']],['cms-publish',['F-007','F-008','F-009']],['search-opendata',['F-005','F-006']]])checks.push({id:'integration-'+id,group:'integration',required:true,status:observed.ok&&flowIds.every(id=>observed.flows.some(f=>f.flowId===id&&f.status==='pass'))?'pass':'fail',evidence:{buildId:dev.build?.buildId,flowIds,certificate:V19_VERIFIED_UI_CERTIFICATE.version}});
 return checks;
}
const oldMakeReport=window.v19MakeSelfTestReport;
window.v19MakeSelfTestReport=function(op){
 const r=oldMakeReport(op),added=additionalChecks().map(c=>({...c,status:V19_TEST_HOOKS.selftestOutcomeByCheck[c.id]||c.status}));r.checks.push(...added);
 for(const group of ['functional','integration']){const failed=r.checks.filter(c=>c.group===group&&c.status!=='pass');r.gates[group]={ok:!failed.length,issues:failed.map(c=>({code:group.toUpperCase()+'_CHECK_FAILED',message:c.id}))};}
 r.summary.total+=added.length;for(const [key,status] of [['passed','pass'],['failed','fail'],['skipped','skipped'],['notRun','not-run']])r.summary[key]+=added.filter(c=>c.status===status).length;
 r.status=Object.values(r.gates).every(g=>g.ok)?'pass':'fail';r.reportFingerprint=reportHash(r);return r;
};
window.devSelfTestGate=function(dev=S.dev){
 const r=report(dev),issues=[],add=(code,message)=>issues.push({code,message});if(dev.operations.selftest?.status==='running')add('SELFTEST_RUNNING','自测正在运行');
 if(!r||r.status!=='pass')add('SELFTEST_REQUIRED','需要当前合格的自测报告');
 else{
  if(reportHash(r)!==r.reportFingerprint)add('SELFTEST_REPORT_TAMPERED','报告内容或检查集合已改变');
  if(!equal(r.basedOn,v19CurrentSelftestSnapshot(dev))||!designPrototypeGate('develop').ok||!devInspectBuildUiArtifact(dev.build).ok)add('SELFTEST_INPUT_STALE','报告依据不是当前设计、计划或构建');
  const op=dev.operations.selftest,keys=['runId','opToken','dispatchAction','owner','authorizationId','autopilotRunId','autopilotRunToken','retestOfReportId','retestOfReportFingerprint','remediationFingerprint'];
  if(!op||op.status!=='done'||keys.some(k=>(op[k]||'')!==(r.operation?.[k]||''))||!equal(op.snapshot,r.basedOn))add('SELFTEST_OPERATION_MISMATCH','报告不属于当前完成的自测运行');
  const matrix=baseline()?.uiAcceptance.matrix||[],flat=r.ui?.pages?.flatMap(p=>p.viewports.flatMap(v=>v.checks.map(c=>({...c,pageId:p.pageId,viewportId:v.viewportId}))))||[],score=v19EvaluateUiEvidence(matrix,flat);
  if(!score.ok||!equal(score.pages,r.ui?.pages))add('SELFTEST_CHECK_SET_INVALID','报告的逐页检查分母、结果或汇总不一致');
  const currentChecks=additionalChecks(dev),expectedChecks=V19_VERIFIED_UI_CERTIFICATE.flows.map(id=>'functional-'+id).concat(['integration-build-ui','integration-design-baseline','integration-merged-main','integration-source-revisions','integration-api-workflow'],currentChecks.map(c=>c.id));
  if(currentChecks.some(c=>c.status!=='pass'))add('SELFTEST_TASK_EVIDENCE_STALE','单测、CI、覆盖率或业务联调证据失效');
  if(!equal((r.checks||[]).map(c=>c.id).sort(),expectedChecks.sort())||(r.checks||[]).some(c=>c.status!=='pass'))add('SELFTEST_REQUIRED_CHECKS','功能或联调必测证据不完整');
  if(!r.gates||!equal(Object.keys(r.gates).sort(),['functional','integration','review','ui'])||Object.values(r.gates).some(g=>!g.ok)||(dev.plan.approved?.taskIds||[]).some(id=>{const t=dev.tasks.find(t=>t.id===id);return !t||!devResolveMergeBasis(t.pr,dev).ok;}))add('SELFTEST_REVIEW_INVALID','质量门禁或合并审核依据失效');
 }
 return {ok:!issues.length,issues,report:r};
};
const oldIdentity=window.v18DispatchIdentity,oldPhase=window.v18DispatchPhase,oldExpected=window.v18DispatchExpected;
window.v18DispatchIdentity=(action,id)=>['selftest','selftest-retest'].includes(action)?hash({action,snapshot:v19CurrentSelftestSnapshot(),prior:report()?.reportFingerprint,remediation:remediation(report())?.fingerprint}):oldIdentity(action,id);
window.v18DispatchPhase=action=>['selftest','selftest-retest'].includes(action)?'selftest':oldPhase(action);
window.v18DispatchExpected=(action,id)=>['selftest','selftest-retest'].includes(action)?!!(S.dev.operations.selftest?.dispatchAction===action&&S.dev.operations.selftest.owner==='autopilot'&&devSelfTestOperationValid(S.dev.operations.selftest)):oldExpected(action,id);
window.devAutopilotTick=function(token){
 const run=S.dev.autopilot?.run;if(!run||run.runToken!==token||run.status!=='running')return false;
 if(!ready(S.dev)||!S.dev.build||S.dev.build.status!=='pass')return V19_BASE_AUTOPILOT_TICK(token);
 const op=S.dev.operations.selftest;if(op?.status==='running'){if(devSelfTestOperationValid(op))return false;retireSelftest();return false;}
 const gate=devSelfTestGate();if(gate.ok)return commitDevAction('autopilot.advance',run.runId,()=>{const current=S.dev.autopilot.run;if(current.runToken!==token||current.status!=='running')return false;current.status='awaiting-transfer';current.phase='awaiting-transfer';current.currentAction='';current.finishedAt=now();devClearTimer('autopilot');devAudit('autopilot.awaiting-transfer',current.runId,S.dev.plan.revision,S.dev.plan.revision,'自测合格，等待人工确认转测试',current.runId);render();return true;});
 const previous=report(),isRetest=previous?.status==='fail';if(isRetest&&!remediation(previous)){v18BlockRun('SELFTEST_FAILED','自测失败，需要实际返工与新构建','','failure');return false;}
 const action=isRetest?'selftest-retest':'selftest';return v18DispatchAction(action,previous?.reportId||'',()=>isRetest?devRetestSelfTest('任务返工和新构建后的自动关联复测'):devStartSelfTest());
};
// 页面入口与内部门禁使用同一事实；拒绝必须给出下一步，不能静默失败。
function preparationBlockers(){const design=designPrototypeGate('develop');if(!design.ok)return {design:true,issues:design.issues};const input=devCurrentInputGate(S.dev);return {design:false,issues:input.ok?[]:(input.issues?.length?input.issues:[{message:'设计已定稿，请同步并人工确认开发输入基线'}])};}
window.v19GoPrototype=function(){S.designTab='proto';go('stage-design');};
window.v19GoDevelopment=function(){go('stage-dev');devSetTop('plan');};
window.v19ReviewDevelopmentInputs=function(){devReconcileInputs();devSummaryJump('baseline');};
function preparationBlockerHtml(block){return '<section class="banner warn" data-testid="prepare-blockers"><b>准备计划前需要完成'+(block.design?'设计基线':'开发输入核对')+'</b>'+block.issues.map(issue=>'<p>'+esc(issue.message||issue.code||'输入尚未确认')+'</p>').join('')+'<button data-testid="'+(block.design?'prepare-go-design':'prepare-review-inputs')+'" onclick="'+(block.design?'v19GoPrototype()':'v19ReviewDevelopmentInputs()')+'">'+(block.design?'前往原型 UI 完成设计':'同步并核对开发输入')+'</button><p class="dz-note">不会自动定稿、自动确认基线或启动开发。</p></section>';}
const preparePlanEntry=window.devPreparePlan;
window.devPreparePlan=function(...args){const block=preparationBlockers();if(block.issues.length){toast(block.design?'请先完成原型检查和人工定稿':'请先核对并确认开发输入基线','warn');render();return false;}if(S.dev.autopilot?.preparation?.status==='running')return false;return preparePlanEntry.apply(this,args);};
const planPage=window.devPlanHtml;
window.devPlanHtml=function(){let html=planPage();if(S.dev.selectedTask)return html;const block=preparationBlockers();if(block.issues.length)html=preparationBlockerHtml(block)+html.replace('无需你处理。AI 可继续准备已有明确依据的常规项。','任务层面暂无待决项；请先完成上方的输入门禁，才能准备计划。');if(S.dev.autopilot?.preparation?.status==='running')html='<div class="banner" role="status">正在准备计划：识别遗漏、核对覆盖并编排依赖，请稍候。</div>'+html.replace('data-testid="prepare-plan"','disabled data-testid="prepare-plan"');return html;};
window.designSelectPrototypePage=function(pageId,stateId){const page=V19_DESIGN_CATALOG.pages.find(p=>p.id===pageId);if(!page||stateId&&!page.states.some(s=>s.id===stateId))return false;S.designUi.prototypePageId=pageId;S.designUi.prototypeStateId=stateId||page.states[0].id;const frame=document.querySelector('[data-testid="prototype-preview"]'),workbench=document.querySelector('[data-testid="prototype-workbench"]');if(!frame||!workbench){render();return true;}const template=document.createElement('template');template.innerHTML=protoMainHtml();const fresh=template.content;for(const selector of ['[data-testid="prototype-page-list"]','.v19-statebar','.v19-issues']){const old=document.querySelector(selector),next=fresh.querySelector(selector);if(old&&next)old.replaceWith(next);}frame.contentWindow.postMessage({type:'v19-prototype-select',pageId,stateId:S.designUi.prototypeStateId},'*');return true;};
const prototypePage=window.protoMainHtml;
window.protoMainHtml=function(){let html=prototypePage();if(designPrototypeGate('develop').ok)html='<div class="banner ok"><b>设计基线已定稿，下一步进入开发核对输入并准备计划。</b><button data-testid="prototype-go-development" onclick="v19GoDevelopment()">进入开发准备计划</button></div>'+html;const op=S.design.prototype.operation;if(op?.status==='running'&&designPrototypeOperationValid(op))html='<div class="banner" role="status">'+esc({planning:'正在识别页面与业务流程…',generating:'正在生成可交互原型…',checking:'正在检查页面、流程与来源对应性…'}[op.kind]||'正在处理…')+'</div>'+html;return html;};
// 报告与基线由门禁重验内容身份；呈现层不暴露技术 ID 作为用户术语。
const oldQuality=window.devQualityHtml;window.devQualityHtml=function(){
 let html=oldQuality().replace(/>functional</g,'>功能检查<').replace(/>integration</g,'>联调与冒烟<').replace(/>ui</g,'>UI 符合度<').replace(/>review</g,'>开发审核<').replace(/public-desktop ·/g,'桌面 ·').replace(/public-tablet ·/g,'平板 ·').replace(/public-mobile ·/g,'手机 ·').replace(/cms-desktop ·/g,'CMS 桌面 ·');
 const r=report();if(!r||!html.includes('data-testid="selftest-report"'))return html;
 const names={'integration-portal-content':'门户内容联调','integration-application':'办事申请联调','integration-cms-publish':'CMS 审核发布联调','integration-search-opendata':'检索与开放数据联调','integration-build-ui':'构建工件','integration-design-baseline':'共同设计基线','integration-merged-main':'全部任务合并','integration-source-revisions':'来源修订','integration-api-workflow':'接口工作流对应性'};
 function title(c){const flow=V19_DESIGN_CATALOG.flows.find(f=>'functional-'+f.id===c.id);if(flow)return flow.title;const m=/^functional-(unit|ci|coverage)-(.*)$/.exec(c.id);return names[c.id]||(m?m[2]+' · '+({unit:'单元测试',ci:'CI 检查',coverage:'覆盖率达标'}[m[1]]):c.id);}
 const pending=r.checks.filter(c=>c.status!=='pass'),reviewIssues=r.gates.review.issues||[],count=(r.defects?.length||0)+pending.length+reviewIssues.length;
 if(count)html=html.replace('<b>无当前缺陷</b>','<b>'+count+' 项需处理</b>');
 const blockers=pending.length?'<div class="banner warn"><b>需要关注</b>'+pending.map(c=>'<p>'+esc(title(c))+' · '+esc({fail:'未通过',skipped:'被跳过','not-run':'未运行'}[c.status]||'待核实')+'</p>').join('')+'</div>':'';
 const detail='<details class="v19-trace" data-testid="selftest-evidence-details"><summary>查看单测、覆盖率与业务联调明细（'+r.checks.filter(c=>c.status==='pass').length+'/'+r.checks.length+'）</summary>'+r.checks.map(c=>{const coverage=c.evidence?.actual,threshold=c.evidence?.target;return '<p><span class="tag '+(c.status==='pass'?'green':'red')+'">'+(c.status==='pass'?'通过':'待处理')+'</span> '+esc(title(c))+(coverage?' · 行 '+coverage.line+'% / 目标 '+threshold.line+'%，分支 '+coverage.branch+'% / 目标 '+threshold.branch+'%':'')+'</p>';}).join('')+'</details>';
 return html.replace('<div class="v19-selftest-pages">',blockers+detail+'<div class="v19-selftest-pages">');
};
for(const name of ['devPreparePlan','devApprovePlan','devAutoResume','devStartSelfTest','devTransferToTest']){const original=window[name];if(typeof original==='function')window[name]=function(...args){designRecoverPrototypeEffects();return original.apply(this,args);};}
const openProjectWithRuntime=window.openProject;if(typeof openProjectWithRuntime==='function')window.openProject=function(id,...args){const result=openProjectWithRuntime.call(this,id,...args);if(id==='pj1')designRecoverPrototypeEffects();return result;};
})();
