const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const specs=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../task-specs.json'),'utf8'));
const tasks=specs.tasks.concat(specs.missingTask), ids=tasks.map(t=>t.id), sourceIds=specs.catalog.map(c=>c.id);
assert.equal(new Set(ids).size,ids.length,'任务ID唯一');
assert.equal(new Set(sourceIds).size,sourceIds.length,'来源ID唯一');
for(let i=1;i<=7;i++)assert.ok(specs.catalog.some(c=>c.req==='REQ-00'+i),'REQ-00'+i+'有独立来源条目');
for(const t of tasks){
  for(const dep of t.deps)assert.ok(ids.includes(dep),t.id+'依赖'+dep+'不存在');
  for(const source of t.sourceIds)assert.ok(sourceIds.includes(source),t.id+'来源'+source+'不存在');
}
let remaining=tasks.slice(),done=[];
while(remaining.length){
  const ready=remaining.filter(t=>t.deps.every(id=>done.includes(id)));
  assert.ok(ready.length,'任务依赖不能形成环：'+remaining.map(t=>t.id).join(','));
  done.push(...ready.map(t=>t.id));remaining=remaining.filter(t=>!done.includes(t.id));
}
(async()=>{
 const browser=await launch(),page=await browser.newPage();
 try{
  await page.goto(url);
  const report=await page.evaluate(specs=>{
   const tasks=specs.tasks.concat(specs.missingTask);
   const issues=tasks.flatMap(t=>devSpecIssues(t).map(i=>t.id+': '+i.message));
   const references=[];
   for(const c of specs.catalog){
    const refs=[c.design,...(c.designRefs||[])].filter(Boolean);
    for(const ref of refs){
     const d=S.design.docs[ref.docKey];
     const sec=d&&curVer(d).secs.find(s=>s.id===ref.sectionId);
     const chapter=String(ref.anchor||'').match(/§(\d+)/)?.[1];
     references.push({source:c.id,docKey:ref.docKey,sectionId:ref.sectionId,exists:!!sec,correctTitle:!!sec&&String(sec.title).startsWith(chapter+'.')});
    }
   }
   const drift=[];
   for(const source of specs.catalog){
    const c=S.dev.catalog.find(c=>c.id===source.id);
    if(!c){drift.push(source.id+' 未嵌入');continue;}
    for(const field of ['req','summary','module','design','designRefs'])
     if(JSON.stringify(c[field])!==JSON.stringify(source[field]))drift.push(source.id+'.'+field);
   }
   for(const source of specs.tasks){
    const t=devTaskById(source.id);
    if(!t){drift.push(source.id+' 未嵌入');continue;}
    for(const field of ['title','kind','owner','goal','scope','boundary','sourceIds','work','inputs','inputArtifactIds','deliverables','acceptance','deps','writeScopes'])
     if(JSON.stringify(t[field])!==JSON.stringify(source[field]))drift.push(source.id+'.'+field);
   }
   return {issues,references,drift};
  },specs);
  assert.deepEqual(report.issues,[],'标准任务规格必须完整');
  assert.deepEqual(report.references.filter(r=>!r.exists),[],'来源必须跳到真实设计章节');
  assert.deepEqual(report.references.filter(r=>!r.correctTitle),[],'来源锚点必须对应所声明章节，不能仅ID存在但跳错');
  assert.deepEqual(report.drift,[],'嵌入HTML的任务与维护源一致');
  const result={ok:true,tasks:tasks.length,catalog:specs.catalog.length,referenceChecks:report.references.length,issues:[]};
  fs.writeFileSync(path.resolve(__dirname,'../evidence/task-data.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
 }catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}
})();
