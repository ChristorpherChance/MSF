// 独立停止证据：只记录当前封装路线的失败，不把它纳入已通过套件。
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launch,url}=require('./browser.cjs');const {enterDesign,generateDesign}=require('./design-helpers.cjs');
(async()=>{const browser=await launch(),checks=[];
for(const action of ['save','commit','upload']){const p=await browser.newPage({viewport:{width:1440,height:1000}});try{await p.goto(url);await enterDesign(p);await generateDesign(p);const observed=await p.evaluate(action=>{
 if(action==='save')document.querySelector('#proto-editor').value+='\n<!-- FAIL-ROLLBACK -->';
 if(action==='commit')S.proto.modified=true;
 if(action==='upload'){uploadProtoModal();document.querySelector('input[name="up-mode"][value="draft"]').checked=true;}
 const before={proto:JSON.stringify(S.proto),design:JSON.stringify(S.design.prototype),events:JSON.stringify(S.events),notices:JSON.stringify(S.notices),session:JSON.stringify(curSess('proto'))};
 const audit=window.designAudit,timer=window.setTimeout;let timers=0,error='';window.designAudit=function(name,...args){if(name.startsWith('prototype.content.'))throw Error('FAIL_FINAL_CONTENT_AUDIT');return audit(name,...args);};window.setTimeout=function(fn,ms,...args){if(ms===700){timers++;return 0;}return timer(fn,ms,...args);};
 try{if(action==='save')saveProtoEditor();if(action==='commit')commitProtoVer();if(action==='upload')doUploadProto();}catch(e){error=e.message;}finally{window.designAudit=audit;window.setTimeout=timer;}
 return {error,protoSame:JSON.stringify(S.proto)===before.proto,designSame:JSON.stringify(S.design.prototype)===before.design,eventsSame:JSON.stringify(S.events)===before.events,noticesSame:JSON.stringify(S.notices)===before.notices,sessionSame:JSON.stringify(curSess('proto'))===before.session,domMatchesState:!document.querySelector('#proto-editor')||document.querySelector('#proto-editor').value===curProtoVer().html,timers};
},action);const ok=observed.error==='FAIL_FINAL_CONTENT_AUDIT'&&['protoSame','designSame','eventsSame','noticesSame','sessionSame','domMatchesState'].every(k=>observed[k])&&observed.timers===0;checks.push({name:action,ok,observed});}catch(e){checks.push({name:action,ok:false,error:String(e.message).slice(0,1500)});}finally{await p.close();}}
await browser.close();const result={ok:checks.every(x=>x.ok),candidateSha256:crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../msf-prototype.html'))).digest('hex'),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/prototype-transaction-atomicity-red.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
