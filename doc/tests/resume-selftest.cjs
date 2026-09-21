// 续跑诊断入口：不覆盖历史证据，逐步骤输出进度并设定硬性期限。
const fs=require('node:fs'),path=require('node:path');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
(async()=>{
 const browser=await launch();
 const deadline=setTimeout(()=>{console.error('SELFTEST_DIAGNOSTIC_TIMEOUT');browser.close().finally(()=>process.exit(1));},120000);
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);console.log('loaded');
  await prepareDesign(page);console.log('design finalized');
  await startAuto(page);console.log('autopilot started');
  const status=await finishAuto(page);console.log('autopilot terminal:',status);
  const result=await page.evaluate(()=>({status:S.dev.autopilot.run.status,operation:S.dev.operations.selftest,report:S.dev.selftest.reports.find(r=>r.reportId===S.dev.selftest.currentReportId),gate:devSelfTestGate(S.dev)}));
  result.errors=errors;
  fs.writeFileSync(path.resolve(__dirname,'../evidence/resume-selftest-diagnostic.json'),JSON.stringify(result,null,2));
  console.log('report:',result.report?.status,'errors:',errors.length);
  if(status!=='awaiting-transfer'||result.report?.status!=='pass'||errors.length)process.exitCode=1;
  const cdp=await page.context().newCDPSession(page);
  const shot=await cdp.send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.resolve(__dirname,'../evidence/resume-selftest-diagnostic.png'),Buffer.from(shot.data,'base64'));
  console.log('CDP screenshot captured');
 }finally{clearTimeout(deadline);await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
