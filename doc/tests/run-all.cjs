const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../');
const sources=['msf-prototype.html','design-catalog.json','task-specs.json','prototype-template.js','设计基线与自测契约.md','build-template.js','runtime-hardening.js','verified-ui-certificate.json','source-acceptance-rules.json','customer-state-kernel.js'];
const sha=()=>Object.fromEntries(sources.map(name=>[name,crypto.createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../',name))).digest('hex')]));
const before=sha(),startedAt=new Date().toISOString(),checks=[];
const suites=['syntax','logic','task-data','design-catalog','customer-prototype','customer-authority-boundary','customer-state-kernel','customer-route-matrix','customer-privacy-projection','prototype-commands','prototype-effects-integration','design-baseline','design-boundary','prototype-content','ui-scoring','selftest','selftest-boundary','build-artifact','merge-basis','contract-hardening','main-integration-boundary','attention-auto','autopilot-boundary','review-cases','boundary','failure-matrix','workflow','regression','visual','design-visual'];
for(const name of suites){
 const start=Date.now(),env={...process.env};delete env.V18_CASE;delete env.V19_CASE;delete env.V19_CATALOG_SOURCE_ONLY;delete env.V19_CUSTOMER_ARTIFACT_HTML;delete env.V19_SKIP_HEALTH;delete env.V19_PROTOTYPE_CANDIDATE;
 const result=spawnSync(process.execPath,[path.join(__dirname,name+'.cjs')],{cwd:root,encoding:'utf8',env});
 const lines=(result.stdout||'').trim().split(/\r?\n/);let summary=null;try{summary=JSON.parse(lines.at(-1));}catch{}
 checks.push({name,ok:result.status===0,durationMs:Date.now()-start,summary});
 console.log(JSON.stringify({suite:name,ok:result.status===0,durationMs:Date.now()-start,checks:summary?.checks?.length}));if(result.status!==0)process.stderr.write((result.stdout||'')+(result.stderr||''));
 if(result.status!==0){console.error(name+' 未通过，停止完整套件');break;}
}
const after=sha(),candidateUnchanged=JSON.stringify(before)===JSON.stringify(after),ok=checks.length===suites.length&&checks.every(c=>c.ok)&&candidateUnchanged;
const report={ok,startedAt,finishedAt:new Date().toISOString(),htmlSha256:after['msf-prototype.html'],sourceSha256:after,candidateUnchanged,checks};
fs.writeFileSync(path.resolve(__dirname,'../evidence/final-validation.json'),JSON.stringify(report,null,2));
if(!ok)process.exitCode=1;console.log(JSON.stringify({ok,checks:checks.length,htmlSha256:after['msf-prototype.html'],candidateUnchanged}));
