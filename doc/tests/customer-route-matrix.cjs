const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {launch}=require('./browser.cjs'),root=path.resolve(__dirname,'..'),catalog=JSON.parse(fs.readFileSync(path.join(root,'design-catalog.json'),'utf8'));
const templateSource=fs.readFileSync(path.join(root,'prototype-template.js'),'utf8');
const html=process.env.V19_CUSTOMER_ARTIFACT_HTML?fs.readFileSync(process.env.V19_CUSTOMER_ARTIFACT_HTML,'utf8'):vm.runInNewContext(templateSource+';v19CustomerPrototypeHTML')(catalog);
(async()=>{
 const browser=await launch(),checks=[];const active=p=>p.locator('#app > [data-prototype-page]:visible > [data-prototype-state]:visible');
 const select=async(p,id,state)=>p.evaluate(([id,state])=>prototypeNavigate(id,state),[id,state]);
 const facts=async p=>active(p).evaluate(n=>({page:n.parentElement.dataset.prototypePage,state:n.dataset.prototypeState,role:n.querySelector('.cms-shell')?.dataset.sessionRole||'',content:[n.dataset.storageState,n.dataset.workflowView,n.dataset.allowedActions,n.dataset.lastTransition]}));
 async function login(p,role){if(role==='anonymous')return;if(role==='citizen'){await select(p,'P-PUB-ACCOUNT','register');await active(p).locator('[data-prototype-field="phone"]').fill('61234567');await active(p).locator('[data-prototype-control="submit"]').click();await active(p).locator('[data-prototype-field="otp"]').fill('123456');await active(p).locator('[data-prototype-control="submit"]').click();}else{await select(p,'P-CMS-LOGIN','signed-out');await active(p).locator('[data-prototype-control="sign-in"][data-role="'+role+'"]').click();}}
 async function test(name,fn){const p=await browser.newPage();p.setDefaultTimeout(3000);try{await p.setContent(html);await fn(p);checks.push({name,ok:true});}catch(e){checks.push({name,ok:false,error:e.message});}finally{await p.close();}}
 const roles=['anonymous','citizen','editor','reviewer','publisher'],pages=['dashboard','editor','review','publish'];
 for(const role of roles)for(const target of pages)for(const entry of ['hash','click'])await test(role+' → '+target+' / '+entry,async p=>{
  await login(p,role);
  if(entry==='hash'){await p.evaluate(target=>{location.hash='#/en/cms/'+target;},target);await p.waitForTimeout(60);}
  else{await select(p,'P-CMS-DASHBOARD','role-filtered');await active(p).locator('[data-prototype-control="nav-'+target+'"]:visible').click();}
  const observed=await facts(p),required={editor:'editor',review:'reviewer',publish:'publisher'}[target];let expected;
  if(role==='anonymous')expected=['P-CMS-LOGIN','signed-out'];else if(role==='citizen'||required&&role!==required)expected=['P-CMS-LOGIN','denied'];else if(target==='review'||target==='publish'||target==='dashboard'&&['reviewer','publisher'].includes(role))expected=['P-CMS-DASHBOARD','empty'];else expected=['P-CMS-'+target.toUpperCase(),target==='dashboard'?'role-filtered':'draft'];
  assert.deepEqual([observed.page,observed.state],expected,JSON.stringify(observed));
  if(expected[0]!=='P-CMS-LOGIN')assert.equal(observed.role,role,'展示身份来自实际会话');
 });
 await test('预览切换不改内容事实，普通路由不继承预览角色',async p=>{await login(p,'editor');await select(p,'P-CMS-EDITOR','draft');const before=(await facts(p)).content;await select(p,'P-CMS-PUBLISH','published');await select(p,'P-CMS-REVIEW','approved');await select(p,'P-CMS-EDITOR','submitted');assert.deepEqual((await facts(p)).content,before);await p.evaluate(()=>{location.hash='#/fr/cms/publish';});await p.waitForTimeout(60);assert.deepEqual([(await facts(p)).page,(await facts(p)).state],['P-CMS-LOGIN','denied']);});
 await test('重新载入会清除会话，URL不能恢复CMS身份',async p=>{await login(p,'publisher');await p.goto('about:blank#/fr/cms/publish');await p.setContent(html);assert.deepEqual([(await facts(p)).page,(await facts(p)).state],['P-CMS-LOGIN','signed-out']);});
 await test('预览入口拒绝未知page和state且不切换内容',async p=>{const before=await facts(p);await select(p,'P-CMS-PUBLISH','NOT-A-STATE');assert.deepEqual(await facts(p),before);await select(p,'P-UNKNOWN','ready');assert.deepEqual(await facts(p),before);});
 await test('伪造非父窗口message不能触发受保护预览',async p=>{await p.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{data:{type:'v19-prototype-select',pageId:'P-CMS-PUBLISH',stateId:'published'},source:null})));assert.equal((await facts(p)).page,'P-PUB-HOME');});
 await test('预览往返保留附件，已提交申请不能因预览重新提交',async p=>{
  await login(p,'citizen');await select(p,'P-PUB-SERVICE-GUIDE','available');await active(p).locator('[data-prototype-control="start"]').click();
  await active(p).locator('[data-prototype-control="upload"]').setInputFiles({name:'retained.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 retained')});
  await select(p,'P-CMS-PUBLISH','published');await select(p,'P-PUB-APPLICATION','materials');
  assert.equal(await active(p).locator('[data-prototype-control="upload"]').evaluate(n=>n.files[0]?.name),'retained.pdf');
  await active(p).locator('[data-prototype-control="next"]').click();await active(p).locator('[data-prototype-control="submit"]').click();
  await p.locator('[data-prototype-page="P-PUB-RECEIPT"] > [data-prototype-state="accepted"]').waitFor({state:'visible'});
  await select(p,'P-PUB-APPLICATION','details');await active(p).locator('[data-prototype-control="submit"]').click();await p.waitForTimeout(80);
  assert.deepEqual([(await facts(p)).page,(await facts(p)).state],['P-PUB-APPLICATION','details'],'预览不重置提交锁，也不再次创建回执');
 });
 await browser.close();const result={ok:checks.every(x=>x.ok),input:process.env.V19_CUSTOMER_ARTIFACT_HTML?'build-artifact':'template',templateSha256:require('node:crypto').createHash('sha256').update(templateSource).digest('hex'),checks};fs.writeFileSync(path.join(root,'evidence/'+(process.env.V19_CUSTOMER_ARTIFACT_HTML?'build-route-matrix':'customer-route-matrix')+'.json'),JSON.stringify(result,null,2));if(!result.ok&&!fs.existsSync(path.join(root,'evidence/customer-route-matrix-red.json')))fs.writeFileSync(path.join(root,'evidence/customer-route-matrix-red.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
