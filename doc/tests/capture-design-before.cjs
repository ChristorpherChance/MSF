const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {launch,pathToFileURL}=require('./browser.cjs');
const beforePath=path.resolve(__dirname,'../../V1.8/msf-prototype.html'),url=pathToFileURL(beforePath).href;
(async()=>{
 const browser=await launch();
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});await page.goto(url);
  await page.evaluate(()=>{openProject('pj1');S.designTab='proto';go('stage-design');});
  await page.screenshot({path:path.resolve(__dirname,'../evidence/design-before-1440.png')});
  const html=fs.readFileSync(beforePath);
  fs.writeFileSync(path.resolve(__dirname,'../evidence/design-before.json'),JSON.stringify({htmlSha256:crypto.createHash('sha256').update(html).digest('hex'),width:1440,height:1000,state:'未生成原型的初始设计页',capturedAt:new Date().toISOString()},null,2));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
