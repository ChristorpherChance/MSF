const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..');let scripts=0,immutableVersions=0;
for(const dir of ['V1.1初始版','V1.2','V1.3','V1.4','V1.5','V1.6','V1.7','V1.8','V1.9']){
 const rel=dir+'/msf-prototype.html',content=fs.readFileSync(path.join(root,rel),'utf8');
 for(const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)){new vm.Script(m[1],{filename:rel});scripts++;}
 if(dir!=='V1.9'){assert.equal(cp.execFileSync('git',['hash-object',rel],{cwd:root,encoding:'utf8'}).trim(),cp.execFileSync('git',['rev-parse','e129d9c:'+rel],{cwd:root,encoding:'utf8'}).trim(),dir+' 不可变');immutableVersions++;}
}
console.log(JSON.stringify({ok:true,html:9,scripts,immutableVersions}));
