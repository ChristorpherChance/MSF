const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {enterDesign,generateDesign,checkDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch(),checks=[];
 async function test(name,kind){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  const p=await browser.newPage({viewport:{width:1440,height:1000}});p.setDefaultTimeout(2500);
  try{
   await p.goto(url);await enterDesign(p);await generateDesign(p);
   const changed=await p.evaluate(kind=>{
    const document=new DOMParser().parseFromString(curProtoVer().html,'text/html');
    const selector={page:'[data-prototype-page]',state:'[data-prototype-state]',control:'[data-prototype-control]',label:'[data-prototype-control]',scripts:'script',handlers:'script',type:'[data-prototype-control]',unknown:'body'}[kind];
    const target=document.querySelector(selector);if(!target)return false;
    if(['page','state'].includes(kind))target.remove();
    // 一个逻辑控件可能在多个状态出现，语言切换也包含 FR/EN 两个按钮。
    // 本反例删除选中页面的整个逻辑控件，不能只删掉一个重复实例后仍宣称控件不存在。
    if(kind==='control'){
     const page=target.closest('[data-prototype-page]'),id=target.getAttribute('data-prototype-control');
     page.querySelectorAll('[data-prototype-control]').forEach(node=>{if(node.getAttribute('data-prototype-control')===id)node.remove();});
    }
    if(kind==='label')target.textContent='无来源且含义错误的操作';
    if(kind==='scripts')document.querySelectorAll('script').forEach(s=>s.remove());
    if(kind==='handlers')document.querySelectorAll('script').forEach(s=>{s.textContent='/* 只有脚本标签，没有任何交互处理 */';});
    if(kind==='type'){const inert=document.createElement('div');for(const a of target.attributes)inert.setAttribute(a.name,a.value);inert.textContent=target.textContent;target.replaceWith(inert);}
    if(kind==='unknown'){const unknown=document.createElement('section');unknown.setAttribute('data-prototype-page','P-UNAPPROVED');unknown.textContent='未经确认的收费业务';target.appendChild(unknown);}
    const saved=executePrototypeCommand({type:'save-html',payload:{html:'<!doctype html>\n'+document.documentElement.outerHTML}});
    return saved.committed&&commitProtoVer();
   },kind);
   assert.equal(changed,true,'实际HTML中存在被检查对象，不能只有清单声明');
   await checkDesign(p);
   const result=await p.evaluate(()=>({gate:designPrototypeGate('finalize'),report:S.design.prototype.checkReports.find(x=>x.reportId===S.design.prototype.currentCheckReportId)}));
   assert.equal(result.gate.ok,false,'有内容缺陷不能定稿');
   assert.ok(result.report&&result.report.status==='fail','生成针对实际缺陷的失败报告');
   assert.ok(result.report.issues.length,'问题有具体记录');
   checks.push({name,ok:true,codes:result.report.issues.map(x=>x.code)});
  }catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}
 }
 await test('声明保留但真实页面删除必须检出','page');
 await test('声明保留但必需状态删除必须检出','state');
 await test('控件删除必须检出','control');
 await test('相同控件ID但错误业务文案不能通过','label');
 await test('交互脚本全部删除不能声称可交互','scripts');
 await test('保留脚本标签但交互处理为空不能通过','handlers');
 await test('保留声明但真实操作控件变静态div必须检出','type');
 await test('新增无来源业务页面不能通过反向检查','unknown');
 await browser.close();const result={ok:checks.every(x=>x.ok),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/prototype-content.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
