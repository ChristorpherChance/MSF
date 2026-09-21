const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {launch,url}=require('./browser.cjs');
const {prepareDesign,startAuto,finishAuto}=require('./design-helpers.cjs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
(async()=>{
 const browser=await launch(),p=await browser.newPage({viewport:{width:1440,height:1000}});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v19-build-artifact-')),file=path.join(dir,'candidate.html');
 const result={ok:false,startedAt:new Date().toISOString()};
 try{
  await p.goto(url);await prepareDesign(p);
  await p.evaluate(()=>{v19CustomerPrototypeHTML=()=>{throw Error('BUILD_MUST_NOT_USE_PROTOTYPE_GENERATOR');};});
  await startAuto(p);assert.equal(await finishAuto(p),'awaiting-transfer');
  const candidate=await p.evaluate(()=>({buildId:S.dev.build.buildId,artifact:S.dev.build.uiArtifact,reportId:S.dev.selftest.currentReportId}));
  assert.ok(candidate.artifact?.html?.length>1000,'实际构建必须有独立原始UI');
  result.buildId=candidate.buildId;result.reportId=candidate.reportId;result.artifactId=candidate.artifact.artifactId;result.htmlSha256=sha(candidate.artifact.html);
  fs.writeFileSync(file,candidate.artifact.html);
  await browser.close();
  const env={...process.env,V19_CUSTOMER_ARTIFACT_HTML:file};delete env.V19_CASE;delete env.V18_CASE;
  const run=spawnSync(process.execPath,[path.join(__dirname,'customer-prototype.cjs')],{cwd:path.resolve(__dirname,'../..'),env,encoding:'utf8'});
  result.behaviorExitCode=run.status;result.behaviorOutput=run.stdout.trim();
  assert.equal(run.status,0,(run.stderr||run.stdout||'独立构建行为验证失败').slice(-6000));
  const evidence=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../evidence/build-customer-browser.json'),'utf8'));
  assert.equal(evidence.ok,true);assert.equal(evidence.flows.length,9);assert.equal(evidence.stateCombinations,138);assert.equal(evidence.controls,106);
  result.authorityChecks=[];
  for(const name of ['customer-authority-boundary','customer-route-matrix','customer-privacy-projection']){const check=spawnSync(process.execPath,[path.join(__dirname,name+'.cjs')],{cwd:path.resolve(__dirname,'../..'),env,encoding:'utf8'});const output=JSON.parse(check.stdout.trim().split(/\r?\n/).at(-1));result.authorityChecks.push({name,ok:check.status===0&&output.ok,checks:output.checks.length});assert.equal(check.status,0,check.stderr||check.stdout);assert.equal(output.ok,true);}
  result.behavior=evidence;result.ok=true;
 }catch(e){result.error=e.stack;process.exitCode=1;}
 finally{await browser.close();if(fs.existsSync(file))fs.unlinkSync(file);fs.rmdirSync(dir);result.finishedAt=new Date().toISOString();fs.writeFileSync(path.resolve(__dirname,'../evidence/build-artifact.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})().catch(e=>{console.error(e);process.exitCode=1;});
