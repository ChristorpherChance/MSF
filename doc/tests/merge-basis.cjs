const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
(async()=>{
 const browser=await launch(),page=await browser.newPage(),checks=[];
 try{
  await page.goto(url);
  const results=await page.evaluate(()=>{
   openProject('pj1');const base={ownerProjectId:'pj1',tasks:[],prs:[],audit:[]};
   const p1={id:'PR-X',taskId:'T-X',commitId:'c1',headRevision:7,status:'merged',checks:[{id:'c',checked:false}],mergeBasis:{kind:'manual-checklist',prId:'WRONG',commitId:'WRONG',headRevision:999}};
   const r1={id:'PR-X',taskId:'T-X',commitId:'c1',headRevision:7,status:'merged',checks:[{id:'c',checked:false}]};
   const d1=JSON.parse(JSON.stringify(base));d1.tasks=[{id:'T-X',rev:3,pr:p1}];d1.prs=[r1];
   const p2={id:'PR-Y',taskId:'T-Y',commitId:'c2',headRevision:4,status:'merged',skipReason:'because',checks:[{id:'c',checked:false}]};
   const d2=JSON.parse(JSON.stringify(base));d2.tasks=[{id:'T-Y',rev:99,pr:p2}];d2.prs=[JSON.parse(JSON.stringify(p2))];d2.audit=[{eventId:'A1',action:'pr.merge',target:'PR-Y',runId:'c2',afterRevision:1}];
   return [devResolveMergeBasis(p1,d1),devResolveMergeBasis(p2,d2)];
  });
  for(const [i,name] of ['单边错误mergeBasis不能代替双PR当前合并依据','legacy豁免必须有精确版本和人工决定审计'].entries()){
   try{assert.equal(results[i].ok,false);checks.push({name,ok:true,result:results[i]});}catch(e){checks.push({name,ok:false,error:e.message,result:results[i]});}
  }
 }catch(e){checks.push({name:'执行',ok:false,error:e.stack});}finally{await browser.close();}
 const result={ok:checks.every(x=>x.ok),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/merge-basis.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
