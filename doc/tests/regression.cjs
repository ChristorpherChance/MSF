const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launch,url}=require('./browser.cjs');
(async()=>{
  const browser=await launch();const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];const checks=[];
  page.on('pageerror',e=>errors.push(e.message));
  try{
    await page.goto(url);await page.evaluate(()=>openProject(S.projects[0].id));
    for(const stage of ['material','req','design','dev','test']){
      await page.evaluate(s=>go('stage-'+s),stage);
      assert.ok((await page.locator('body').innerText()).length>100,stage+'可渲染');checks.push(stage+'渲染');
    }
    for(const tab of ['outline','detail','proto','review']){
      await page.evaluate(t=>{S.designTab=t;go('stage-design');},tab);
      assert.ok((await page.locator('body').innerText()).length>100);checks.push('设计/'+tab);
    }
    await page.clock.install();
    await page.evaluate(()=>{S.designTab='proto';go('stage-design');designPlanPrototype();});await page.clock.runFor(1800);
    await page.evaluate(()=>designGeneratePrototype());await page.clock.runFor(1800);
    assert.ok(await page.evaluate(()=>curProtoVer()?.html?.length>1000),'通过真实命令生成预览夹具');
    await page.evaluate(()=>previewProto());await page.clock.resume();
    assert.equal(await page.locator('#modal-root iframe').count(),1,'原型预览沙箱仍可打开');
    await page.evaluate(()=>closeModal());checks.push('原型预览');
    await page.evaluate(()=>{S.reqTab='prd';go('stage-req');});
    const documentCheck=await page.evaluate(()=>({name:docName(),versions:curDoc().versions.length,sections:curVer(curDoc()).secs.length}));
    assert.equal(documentCheck.name,'PRD');assert.ok(documentCheck.versions>0&&documentCheck.sections>0);checks.push('PRD版本及章节');
    await page.evaluate(()=>{S.reqTab='rtm';render();});
    assert.match(await page.locator('body').innerText(),/REQ-00/);checks.push('RTM');
    await page.evaluate(()=>{S.reqTab='crd';go('stage-req');curDoc().finalized=false;S.docViewMode='edit';render();});
    const editor=page.locator('#doc-editor');const oldText=await editor.inputValue();
    await editor.fill(oldText+'\n\n## 回归新增章节\n人工编辑的验收内容。');
    await page.evaluate(()=>saveDocEditor());
    assert.equal(await page.evaluate(()=>curDoc().modified),true);
    assert.match(await page.locator('body').innerText(),/人工编辑的验收内容/);
    await page.evaluate(()=>docUndo());assert.doesNotMatch(await page.locator('body').innerText(),/人工编辑的验收内容/);
    await page.evaluate(()=>docRedo());assert.match(await page.locator('body').innerText(),/人工编辑的验收内容/);checks.push('人工编辑/撤销/重做');
    const oldVersion=await page.evaluate(()=>curDoc().cur);await page.evaluate(()=>commitVer());
    assert.equal(await page.evaluate(()=>curDoc().cur),oldVersion+1);checks.push('版本提交');
    await page.evaluate(()=>finalizeDoc());await page.getByRole('button',{name:'确认定稿',exact:true}).click();
    assert.equal(await page.evaluate(()=>curDoc().finalized),true);checks.push('定稿');
    await page.evaluate(()=>{const d=curDoc();d.finalized=false;const s=curVer(d).secs[0];d.pend=[{secId:s.id,type:'mod',old:s.md,reason:'回归补丁'}];s.md='回归待确认补丁';render();});
    assert.equal(await page.locator('.pending-mod').count(),1);
    await page.evaluate(()=>rejectPend(curDoc().pend[0].secId));
    assert.equal(await page.locator('.pending-mod').count(),0);assert.doesNotMatch(await page.locator('body').innerText(),/回归待确认补丁/);
    await page.evaluate(()=>{const d=curDoc(),s=curVer(d).secs[0];d.pend=[{secId:s.id,type:'mod',old:s.md,reason:'回归补丁'}];s.md='回归接受补丁';render();acceptPend(s.id);});
    assert.equal(await page.evaluate(()=>curDoc().pend.length),0);assert.match(await page.locator('body').innerText(),/回归接受补丁/);checks.push('diff高亮/拒绝/接受');
    await page.evaluate(()=>tocJump(curVer(curDoc()).secs[0].id));checks.push('目录定位');
    const modelIds=await page.locator('#model-sel option').evaluateAll(xs=>xs.map(x=>x.value));
    if(modelIds.length>1){await page.locator('#model-sel').selectOption(modelIds[1]);assert.equal(await page.evaluate(()=>S.curModel),modelIds[1]);checks.push('模型切换');}
    await page.evaluate(()=>{S.reqTab='crd';go('stage-req');streamReply('req','回归验证：此消息用于验证流式暂停继续和停止。'.repeat(12));});
    await page.waitForTimeout(160);
    await page.evaluate(()=>pauseStream());
    assert.equal(await page.evaluate(()=>S.streaming.paused),true);
    await page.evaluate(()=>resumeStream());
    assert.equal(await page.evaluate(()=>S.streaming.paused),false);
    await page.evaluate(()=>stopStream());
    assert.ok(await page.evaluate(()=>!S.streaming));checks.push('流式/暂停/继续/停止');
    await page.evaluate(()=>{S.chatCollapsed=true;render();});await page.keyboard.press('F1');
    assert.ok(await page.locator('.chat-dock').count()>0);checks.push('F1助手');
    await page.evaluate(()=>go('projects'));checks.push('返回项目列表');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.resolve(__dirname,'../evidence/regression.json'),JSON.stringify({ok:true,checks,errors},null,2));
    console.log(JSON.stringify({ok:true,checks,errors}));
  }catch(e){console.error(e.stack);process.exitCode=1;}finally{await browser.close();}
})();
