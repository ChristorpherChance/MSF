const assert=require('node:assert/strict');
async function enterDesign(page){
 await page.clock.install();
 await page.evaluate(()=>{openProject('pj1');S.designTab='proto';go('stage-design');});
}
async function generateDesign(page){
 await page.evaluate(()=>designPlanPrototype());await page.clock.runFor(1800);
 await page.evaluate(()=>designGeneratePrototype());await page.clock.runFor(1800);
 assert.ok(await page.evaluate(()=>curProtoVer()?.html?.length>1000),'生成可交互客户原型');
}
async function checkDesign(page){await page.evaluate(()=>designCheckPrototype());await page.clock.runFor(1800);}
async function prepareDesign(page){
 await enterDesign(page);await generateDesign(page);await checkDesign(page);
 assert.equal(await page.evaluate(()=>designPrototypeGate('finalize').ok),true,'完整原型可定稿');
 assert.equal(await page.evaluate(()=>!!designFinalizePrototypeBaseline()),true,'人工显式定稿');
 await page.evaluate(()=>{go('stage-dev');devReconcileInputs();devConfirmBaseline();devSetTop('plan');});
}
async function refreshDesignBaseline(page){
 await page.evaluate(()=>{S.designTab='proto';go('stage-design');designPlanPrototype();});await page.clock.runFor(1800);
 await checkDesign(page);
 assert.equal(await page.evaluate(()=>designPrototypeGate('finalize').ok),true,'上游修订后重新检查可定稿');
 assert.equal(await page.evaluate(()=>!!designFinalizePrototypeBaseline()),true);
 await page.evaluate(()=>{go('stage-dev');devReconcileInputs();});
}
async function startAuto(page){
 await page.evaluate(()=>{go('stage-dev');devPreparePlan();});await page.clock.runFor(1800);
 assert.equal(await page.evaluate(()=>!!devApproveAndRun()),true,'批准自动运行');
}
async function finishAuto(page){
 for(let i=0;i<130;i++){
  const status=await page.evaluate(()=>S.dev.autopilot.run?.status);
  if(['awaiting-transfer','blocked','stopped'].includes(status))return status;
  await page.clock.runFor(6000);
 }
 assert.fail('自动链未在有界时间内完成或明确阻断');
}
module.exports={enterDesign,generateDesign,checkDesign,prepareDesign,refreshDesignBaseline,startAuto,finishAuto};
