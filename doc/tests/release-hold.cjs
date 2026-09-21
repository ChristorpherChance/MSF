// 隔离候选专用：验证 NO-GO 证书不能作为定稿或开发依据，不加入健康回归。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {enterDesign,generateDesign,checkDesign}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage();await page.goto(url);await enterDesign(page);await generateDesign(page);await checkDesign(page);
  const observed=await page.evaluate(()=>{
   const d=S.design.prototype,r=d.checkReports.find(x=>x.reportId===d.currentCheckReportId);
   return {finalizeBlocked:!designPrototypeGate('finalize').ok,developBlocked:!designPrototypeGate('develop').ok,checkStatus:r?.status,reviewIssues:(r?.issues||[]).filter(x=>x.code==='UI_REVIEW_NOT_APPROVED')};
  });
  assert.equal(observed.finalizeBlocked,true);assert.equal(observed.developBlocked,true);assert.equal(observed.checkStatus,'fail');assert.ok(observed.reviewIssues.length>0);
  const result={ok:true,purpose:'主流程 NO-GO 隔离：不能定稿或充当合格开发依据',htmlSha256:crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../msf-prototype.html'))).digest('hex'),...observed};
  fs.writeFileSync(path.resolve(__dirname,'../evidence/release-hold.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
