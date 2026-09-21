// 显式冻结已测试示例的签名；不是运行期认证服务，sync-sources 不调用它。
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {launch}=require('./browser.cjs');
const root=path.resolve(__dirname,'..'),read=n=>fs.readFileSync(path.join(root,n),'utf8'),sha=s=>crypto.createHash('sha256').update(s).digest('hex');
(async()=>{
 const evidence=JSON.parse(read('evidence/customer-browser.json')),template=read('prototype-template.js'),test=read('tests/customer-prototype.cjs'),catalog=JSON.parse(read('design-catalog.json'));
 assert.equal(sha(template),process.argv[2],'必须明确指定已经完成浏览器验证的模板 SHA');
 assert.equal(sha(test),process.argv[3],'必须明确指定浏览器验证测试 SHA');
 assert.equal(sha(read('evidence/customer-browser.json')),process.argv[4],'必须明确指定验证结果 SHA');
 assert.equal(evidence.ok,true);assert.equal(evidence.inputSha256,sha(template),'浏览器证据必须来自当前模板');assert.equal(evidence.errors,0);assert.equal(evidence.stateCombinations,138);assert.equal(evidence.controls,106);assert.equal(evidence.flows.length,9);assert.ok(Object.values(evidence.boundaryRegressions).every(Boolean));
 const reviewFile=process.argv[5]||'customer-authority-recheck-review.md';assert.equal(path.basename(reviewFile),reviewFile,'审查证据须为 evidence 内文件');
 const review=read('evidence/'+reviewFile);
 assert.match(review,/结论：\*\*GO(?:\*\*|[，。（\s])/,'必须先取得客户原型独立 GO，已有计数通过不能覆盖 NO-GO');
 assert.ok(review.toLowerCase().includes(sha(template)),'独立 GO 必须绑定当前模板');
 const kernelEvidence=JSON.parse(read('evidence/customer-state-kernel.json')),routeEvidence=JSON.parse(read('evidence/customer-route-matrix.json')),authorityEvidence=JSON.parse(read('evidence/customer-authority-boundary.json'));
 assert.equal(kernelEvidence.ok,true);assert.equal(kernelEvidence.kernelSha256,sha(read('customer-state-kernel.js')));assert.equal(routeEvidence.ok,true);assert.equal(routeEvidence.templateSha256,sha(template));assert.equal(authorityEvidence.ok,true);assert.equal(authorityEvidence.templateSha256,sha(template));
 const privacyEvidence=JSON.parse(read('evidence/customer-privacy-projection.json'));assert.equal(privacyEvidence.ok,true);assert.equal(privacyEvidence.templateSha256,sha(template));
 const authorityEvidenceSha256=Object.fromEntries(['customer-state-kernel','customer-route-matrix','customer-authority-boundary','customer-privacy-projection'].map(n=>[n,sha(read('evidence/'+n+'.json'))]));
 const html=vm.runInNewContext(template+';v19CustomerPrototypeHTML')(catalog),build=vm.runInNewContext(read('build-template.js')+';v19BuildCandidateHTML')();
 const browser=await launch();try{
  const page=await browser.newPage();const inspect=async html=>page.evaluate(html=>{const doc=new DOMParser().parseFromString(html,'text/html');const digest=value=>{const s=String(value||'').replace(/\s+/g,' ').trim();let h=2166136261;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return 'fp-'+(h>>>0).toString(16).padStart(8,'0');};return {runtime:digest([...doc.scripts].map(s=>s.textContent).join('\n')),styles:digest([...doc.querySelectorAll('style')].map(s=>s.textContent).join('\n')),pages:Object.fromEntries([...doc.querySelectorAll('[data-prototype-page]')].map(n=>[n.dataset.prototypePage,digest(n.outerHTML)]))};},html);
  const actual=await inspect(html),candidate=await inspect(build);assert.deepEqual(candidate,actual,'独立构建必须满足同一已测试业务实现；实际构建还由 build-artifact.cjs 重放矩阵');
  const cert={version:'V19-VERIFIED-UI-3',reviewDecision:'GO',reviewEvidence:reviewFile,reviewSha256:sha(review),evidence:'customer-browser.json',templateSha256:sha(template),testSha256:sha(test),evidenceSha256:sha(read('evidence/customer-browser.json')),kernelSha256:sha(read('customer-state-kernel.js')),authorityEvidenceSha256,buildSourceSha256:sha(read('build-template.js')),...actual,flows:evidence.flows,stateViewportCount:evidence.stateCombinations,boundaryRegressions:evidence.boundaryRegressions};
  fs.writeFileSync(path.join(root,'verified-ui-certificate.json'),JSON.stringify(cert,null,2)+'\n');console.log(JSON.stringify({ok:true,version:cert.version,templateSha256:cert.templateSha256}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
