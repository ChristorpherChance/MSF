const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),vm=require('node:vm');
const {launch,url}=require('./browser.cjs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../design-catalog.json'),'utf8'));
const specs=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../task-specs.json'),'utf8'));
function unique(values,label){assert.equal(new Set(values).size,values.length,label+'唯一');}
const requirements=catalog.requirements.map(x=>x.id),pages=catalog.pages.map(x=>x.id),tasks=specs.tasks.map(x=>x.id),proposed=[specs.missingTask.id];
unique(requirements,'需求');unique(pages,'页面');unique(catalog.flows.map(x=>x.id),'流程');
const refs=[];let states=0,controls=0,fields=0;
for(const page of catalog.pages){
 assert.ok(page.roles.length&&page.reqIds.length&&page.hldRefs.length&&page.lldRefs.length,page.id+'有双向依据');
 page.reqIds.forEach(id=>assert.ok(requirements.includes(id),page.id+'需求存在'));
 page.taskIds.forEach(id=>assert.ok(tasks.includes(id),page.id+'已存在任务 '+id));
 (page.proposedTaskIds||[]).forEach(id=>assert.ok(proposed.includes(id),page.id+'建议任务 '+id));
 unique(page.states.map(x=>x.id),page.id+'状态');unique(page.controls.map(x=>x.id),page.id+'控件');unique((page.fields||[]).map(x=>x.id),page.id+'字段');
 states+=page.states.length;controls+=page.controls.length;fields+=(page.fields||[]).length;
 page.states.forEach(x=>assert.ok(typeof x.required==='boolean'&&x.expected,page.id+'状态有判据'));
 page.controls.forEach(x=>{assert.ok(x.action&&x.expected,page.id+'控件有动作与预期');if(x.targetPageId)assert.ok(pages.includes(x.targetPageId),page.id+'目标页存在');refs.push(...(x.sourceRefs||[]).map(r=>({...r,target:page.id+':'+x.id})));});
 const nav=page.controls.filter(x=>x.id.startsWith('nav-'));
 assert.equal(nav.length,4,page.id+'全局导航也须物化声明并接受反向检查');
 assert.ok(nav.every(x=>x.sourceRefs?.length&&x.targetPageId));
 const isCms=page.id.startsWith('P-CMS-');
 assert.deepEqual(nav.map(x=>x.targetPageId).sort(),(isCms?['P-CMS-DASHBOARD','P-CMS-EDITOR','P-CMS-REVIEW','P-CMS-PUBLISH']:['P-PUB-HOME','P-PUB-SECTION','P-PUB-SERVICE-GUIDE','P-PUB-OPENDATA']).sort(),page.id+'导航目标符合所属区域');
 assert.ok(nav.every(x=>x.action===(isCms?'navigate-cms-page':'navigate-public-page')));
 (page.fields||[]).forEach(x=>{assert.equal(typeof x.required,'boolean');assert.ok(x.sourceRef&&x.sourceRef.rule,page.id+'字段规则有出处');refs.push({...x.sourceRef,target:page.id+':'+x.id});if(x.pattern)new RegExp(x.pattern);});
 refs.push(...page.lldRefs.map(x=>({...x,target:page.id})));
 refs.push(...page.hldRefs.map(x=>{const [docKey,sectionId]=x.split(':');return {docKey,sectionId,target:page.id};}));
}
for(const req of catalog.requirements){if(req.uiApplicable){assert.ok(catalog.pages.some(p=>p.reqIds.includes(req.id)),req.id+'有页面');assert.ok(catalog.flows.some(f=>f.reqIds.includes(req.id)),req.id+'有流程');}else assert.ok(req.nonUiRationale);}
for(const flow of catalog.flows){assert.ok(flow.roles.length&&flow.steps.length);flow.reqIds.forEach(id=>assert.ok(requirements.includes(id)));flow.steps.forEach(s=>{assert.ok(pages.includes(s.pageId));assert.ok(s.action&&s.expected);});}
for(const item of catalog.nonUiCoverage){assert.ok(item.reason&&item.sourceRefs.length&&item.hldRefs.length&&item.lldRefs.length);refs.push(...item.lldRefs.map(x=>({...x,target:item.id})));}
assert.equal(catalog.uiConformanceGate.generalVisualComplianceMin,0.95);assert.equal(catalog.uiConformanceGate.criticalItemsMin,1);
assert.ok(catalog.pages.find(p=>p.id==='P-PUB-SECTION').proposedTaskIds.includes('T-210'),'空态建议任务不得被已有任务掩盖');
assert.ok(catalog.viewportProfiles.some(x=>x.id==='public-mobile'));assert.ok(catalog.viewportProfiles.some(x=>x.id==='cms-desktop'));
(async()=>{const browser=await launch(),page=await browser.newPage();try{
 await page.goto(url);
 const source=await page.evaluate(refs=>{
  const prd=curVer(S.prd).secs.map(s=>s.md).join('\n');
  return {reqIds:Array.from(new Set(prd.match(/REQ-00[1-7]/g)||[])).sort(),missing:refs.filter(r=>!S.design.docs[r.docKey]?.versions.find(v=>v.v===S.design.docs[r.docKey].cur)?.secs.some(s=>s.id===r.sectionId)),embedded:typeof V19_DESIGN_CATALOG==='undefined'?null:V19_DESIGN_CATALOG};
 },refs);
 assert.deepEqual(requirements.slice().sort(),source.reqIds,'独立读取PRD的REQ集合');assert.deepEqual(source.missing,[],'设计章节实际存在');
 if(!process.env.V19_CATALOG_SOURCE_ONLY){
  assert.deepEqual(source.embedded,catalog,'HTML静态目录与维护源逐字段一致');
  const templateContext={};vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../prototype-template.js'),'utf8'),templateContext);
  assert.equal(await page.evaluate(()=>v19CustomerPrototypeHTML(V19_DESIGN_CATALOG)),templateContext.v19CustomerPrototypeHTML(catalog),'HTML内嵌客户生成器与最终模板源输出逐字一致');
 }
 const result={ok:true,sourceOnly:!!process.env.V19_CATALOG_SOURCE_ONLY,requirements:requirements.length,pages:pages.length,flows:catalog.flows.length,states,controls,fields,references:refs.length,viewports:catalog.viewportProfiles.length};
 fs.writeFileSync(path.resolve(__dirname,'../evidence/design-catalog'+(result.sourceOnly?'-source':'')+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}})();
