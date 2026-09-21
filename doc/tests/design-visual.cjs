const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
const {prepareDesign}=require('./design-helpers.cjs');
const catalog=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../design-catalog.json'),'utf8'));
(async()=>{
 const browser=await launch(),checks=[],errors=[];
 try{
  for(const width of [1280,1440,1920]){
   const p=await browser.newPage({viewport:{width,height:1000}});p.setDefaultTimeout(3500);p.on('pageerror',e=>errors.push(e.message));
   await p.goto(url);await prepareDesign(p);
   await p.evaluate(()=>{S.designTab='proto';S.chatCollapsed=false;go('stage-design');});
   for(const collapsed of [false,true]){
    await p.evaluate(x=>{S.chatCollapsed=x;render();},collapsed);
    const layout=await p.evaluate(()=>({width:innerWidth,scroll:document.body.scrollWidth,clipped:[...document.querySelectorAll('[data-testid="prototype-workbench"] button')].filter(e=>e.getClientRects().length&&e.getBoundingClientRect().width>0).filter(e=>{const r=e.getBoundingClientRect(),parent=e.closest('.doc-area')?.getBoundingClientRect();return parent&&(r.left<parent.left-1||r.right>parent.right+1);}).map(e=>e.textContent)}));
    assert.ok(layout.scroll<=layout.width+1,'工作台页面无横向溢出');assert.deepEqual(layout.clipped,[],width+'按钮可达');
    checks.push({kind:'workbench',width,collapsed,ok:true});
   }
   if(width===1440){
    await p.evaluate(()=>{S.chatCollapsed=false;render();});
    for(const id of ['P-PUB-APPLICATION','P-CMS-EDITOR','P-PUB-HOME']){
     const spec=catalog.pages.find(x=>x.id===id),state=spec.states.at(-1);
     await p.getByTestId('prototype-page-'+id).click();
     await p.frameLocator('[data-testid="prototype-preview"]').locator('[data-prototype-page="'+id+'"]:visible').waitFor();
     await p.getByTestId('prototype-state-'+state.id).click();
     await p.frameLocator('[data-testid="prototype-preview"]').locator('[data-prototype-page="'+id+'"] [data-prototype-state="'+state.id+'"]:visible').waitFor();
     checks.push({kind:'sandbox-navigation',pageId:id,stateId:state.id,ok:true});
    }
    await p.getByTestId('prototype-state-'+catalog.pages[0].states[0].id).click();
    await p.frameLocator('[data-testid="prototype-preview"]').locator('[data-prototype-page="P-PUB-HOME"] [data-prototype-state="'+catalog.pages[0].states[0].id+'"]:visible').waitFor();
    await p.clock.runFor(4500);
    await p.screenshot({path:path.resolve(__dirname,'../evidence/design-workbench-1440.png')});
   }
   await p.close();
  }
  // 独立打开实际生成 HTML，验证客户工件的响应式；外层 MSF 工作台不冒充客户 UI。
  const source=await browser.newPage();await source.goto(url);await prepareDesign(source);
  const html=await source.evaluate(()=>curProtoVer().html);await source.close();
  for(const viewport of catalog.viewportProfiles){
   const width=viewport.id.endsWith('mobile')?390:viewport.id.endsWith('tablet')?820:1440;
   const p=await browser.newPage({viewport:{width,height:1000}});p.setDefaultTimeout(3500);p.on('pageerror',e=>errors.push(e.message));
   for(const spec of catalog.pages.filter(x=>x.area===viewport.area)){
    await p.setContent(html);
    // 生成的客户工件允许通过明确的初始页面配置或其内部导航选择页面。
    const selected=await p.evaluate(([id,stateId])=>{
     if(typeof window.prototypeNavigate==='function')return window.prototypeNavigate(id,stateId)===true;
     if(typeof window.protoNavigate==='function'){window.protoNavigate(id);return true;}
     const link=document.querySelector('[data-target-page="'+id+'"]');if(link){link.click();return true;}
     return !!document.querySelector('[data-prototype-page="'+id+'"]')?.getClientRects().length;
    },[spec.id,spec.states[0].id]);
    assert.equal(selected,true,'客户原型可导航至 '+spec.id);
    const page=p.locator('[data-prototype-page="'+spec.id+'"]');await page.waitFor({state:'visible'});
    const size=await p.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(size.scroll<=size.width+1,spec.id+'/'+viewport.id+'客户页面横向溢出');
    assert.ok((await page.innerText()).trim().length>40,spec.id+'必须有实际业务内容');
    if(['P-PUB-APPLICATION','P-CMS-EDITOR'].includes(spec.id))assert.ok(await page.locator('input,textarea,select').count()>=(spec.fields||[]).length,spec.id+'应包含目录声明的真实业务字段');
    checks.push({kind:'customer',pageId:spec.id,viewportId:viewport.id,width,ok:true});
    if((width===1440&&['P-PUB-HOME','P-PUB-APPLICATION','P-CMS-EDITOR'].includes(spec.id))||(width===390&&['P-PUB-HOME','P-PUB-APPLICATION'].includes(spec.id)))await p.screenshot({path:path.resolve(__dirname,'../evidence/'+spec.id+'-'+width+'.png')});
   }
   await p.close();
  }
  assert.deepEqual(errors,[]);
 }catch(e){checks.push({ok:false,error:e.stack});process.exitCode=1;}finally{await browser.close();}
 const result={ok:checks.every(x=>x.ok)&&errors.length===0,checks,errors};fs.writeFileSync(path.resolve(__dirname,'../evidence/design-visual.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
