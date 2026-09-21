const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
(async()=>{
 const browser=await launch(),page=await browser.newPage(),checks=[];
 await page.goto(url);
 async function test(name,change,expected){
  if(process.env.V19_CASE&&!name.includes(process.env.V19_CASE))return;
  try{
   const result=await page.evaluate(({change})=>{
    const matrix=['public-desktop','public-mobile'].map(viewportId=>({
     pageId:'P-PUB-HOME',viewportId,
     expectedCriticalCheckIds:['critical-language-fallback'],
     expectedGeneralCheckIds:Array.from({length:20},(_,i)=>'general-'+i),
     checkDefinitions:[{checkId:'critical-language-fallback',kind:'critical',sourceRefs:['REQ-004'],severity:'severe'},...Array.from({length:20},(_,i)=>({checkId:'general-'+i,kind:'general',sourceRefs:['REQ-004'],severity:'minor'}))]
    }));
    const observed=matrix.flatMap(cell=>cell.checkDefinitions.map(def=>({pageId:cell.pageId,viewportId:cell.viewportId,id:def.checkId,checkId:def.checkId,kind:def.kind,outcome:'pass',status:'pass'})));
    const mobile=observed.filter(x=>x.viewportId==='public-mobile');
    if(change==='one-general-fail'){mobile[1].outcome=mobile[1].status='fail';}
    if(change==='two-general-fail'){mobile[1].outcome=mobile[1].status='fail';mobile[2].outcome=mobile[2].status='fail';}
    if(change==='critical-fail'){mobile[0].outcome=mobile[0].status='fail';}
    if(change==='skipped'){mobile[1].outcome=mobile[1].status='skipped';}
    if(change==='not-run'){mobile[1].outcome=mobile[1].status='not-run';}
    if(change==='unknown'){mobile[1].outcome=mobile[1].status='greenish';}
    if(change==='missing'){observed.splice(observed.indexOf(mobile[1]),1);}
    if(change==='duplicate'){observed.push({...mobile[1]});}
    if(change==='extra'){observed.push({...mobile[1],id:'invented',checkId:'invented'});}
    if(change==='empty-critical'){
     matrix[1].expectedCriticalCheckIds=[];matrix[1].checkDefinitions=matrix[1].checkDefinitions.filter(x=>x.kind!=='critical');
     observed.splice(observed.indexOf(mobile[0]),1);
    }
    if(change==='empty-general'){
     matrix[1].expectedGeneralCheckIds=[];matrix[1].checkDefinitions=matrix[1].checkDefinitions.filter(x=>x.kind!=='general');
     for(let i=observed.length-1;i>=0;i--)if(observed[i].viewportId==='public-mobile'&&observed[i].kind==='general')observed.splice(i,1);
    }
    const before=JSON.stringify({matrix,observed});
    const result=v19EvaluateUiEvidence(matrix,observed);
    return {ok:result.ok,unchanged:before===JSON.stringify({matrix,observed}),issues:result.issues,defects:result.defects};
   },{change});
   assert.equal(result.unchanged,true,'评分不得更改基线分母或原始证据');
   assert.equal(result.ok,expected);
   if(!expected)assert.ok((result.issues?.length||0)+(result.defects?.length||0)>0,'失败给出问题依据');
   checks.push({name,ok:true});
  }catch(e){checks.push({name,ok:false,error:e.message});}
 }
 await test('完整独立视口证据可通过','pass',true);
 await test('一般项恰好95%可通过','one-general-fail',true);
 await test('单视口一般项90%不得被总体平均掩盖','two-general-fail',false);
 await test('单视口关键项失败拒绝','critical-fail',false);
 for(const [label,kind] of [['跳过','skipped'],['未运行','not-run'],['未知','unknown']])await test(label+'结果不能充作已测',kind,false);
 await test('删去一个一般项证据不能缩小分母','missing',false);
 await test('重复证据不得提升通过率','duplicate',false);
 await test('额外证据不得稀释缺陷','extra',false);
 await test('关键项分母为空不得通过','empty-critical',false);
 await test('一般项分母为空不得通过','empty-general',false);
 await browser.close();
 const result={ok:checks.every(x=>x.ok),checks};fs.writeFileSync(path.resolve(__dirname,'../evidence/ui-scoring.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
