// 最终独立审查反例。保留 RED，重设计必须通过，禁止用更新 expected 接受错误行为。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {launch}=require('./browser.cjs'),root=path.resolve(__dirname,'..');
const source=fs.readFileSync(path.join(root,'prototype-template.js'),'utf8'),catalog=JSON.parse(fs.readFileSync(path.join(root,'design-catalog.json'),'utf8'));
const html=process.env.V19_CUSTOMER_ARTIFACT_HTML?fs.readFileSync(process.env.V19_CUSTOMER_ARTIFACT_HTML,'utf8'):vm.runInNewContext(source+';v19CustomerPrototypeHTML')(catalog);
(async()=>{
 const browser=await launch(),checks=[];
 const active=p=>p.locator('[data-prototype-page]:visible > [data-prototype-state]:visible');
 const select=async(p,id,state)=>{await p.evaluate(([id,state])=>prototypeNavigate(id,state),[id,state]);};
 async function test(name,fn){const p=await browser.newPage();p.setDefaultTimeout(3000);try{await fn(p);checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}}
 for(const route of ['dashboard','editor','review','publish'])for(const entry of ['initial','hashchange'])await test('普通 CMS '+route+' '+entry+' 必须先认证',async p=>{
  await p.goto('about:blank'+(entry==='initial'?'#/fr/cms/'+route:''));await p.setContent(html);
  if(entry==='hashchange'){await p.evaluate(route=>{location.hash='#/fr/cms/'+route;},route);await p.waitForTimeout(100);}
  const observed=await active(p).evaluate(n=>({page:n.parentElement.dataset.prototypePage,state:n.dataset.prototypeState}));
  assert.equal(observed.page,'P-CMS-LOGIN','未认证客户路由显示受保护页：'+JSON.stringify(observed));
 });
 await test('连续发布下线后的 workflowView 必须属于冻结目录',async p=>{
  await p.setContent(html);
  const login=async role=>{await select(p,'P-CMS-LOGIN','signed-out');await active(p).locator('[data-prototype-control="sign-in"][data-role="'+role+'"]').click();};
  await login('editor');await active(p).locator('[data-prototype-control="new-content"]:visible').click();await active(p).locator('[data-prototype-control="submit-review"]').click();
  await login('reviewer');await active(p).locator('[data-prototype-control="review-queue"]:visible').click();await active(p).locator('[data-prototype-control="approve"]').click();
  await login('publisher');await active(p).locator('[data-prototype-control="nav-publish"]:visible').click();await active(p).locator('[data-prototype-control="publish"]').click();await active(p).locator('[data-prototype-control="unpublish"]').click();
  const actual=await active(p).evaluate(n=>({state:n.dataset.prototypeState,workflowView:n.dataset.workflowView,storageState:n.dataset.storageState}));
  const allowed=[...catalog.statusDisplayMapping.canonicalStorageStates.map(x=>x.storageState),...catalog.statusDisplayMapping.workflowViewStates.map(x=>x.id)];
  assert.ok(allowed.includes(actual.workflowView),'出现目录外状态：'+JSON.stringify(actual)+'；允许集合 '+allowed.join(','));
 });
 await browser.close();const result={ok:checks.every(c=>c.ok),templateSha256:crypto.createHash('sha256').update(source).digest('hex'),checks};
 fs.writeFileSync(path.join(root,'evidence/'+(process.env.V19_CUSTOMER_ARTIFACT_HTML?'build':'customer')+'-authority-boundary.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
