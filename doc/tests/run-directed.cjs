// 将定向验证的输出放入独立目录，保留先前冻结证据。
const fs=require('node:fs'),path=require('node:path');
const suite=process.argv[2];if(!/^[a-z-]+$/.test(suite||''))throw Error('Suite name required');
const evidence=path.resolve(__dirname,'../evidence'),dir=path.join(evidence,'completion-directed');fs.mkdirSync(dir,{recursive:true});
const resolve=path.resolve,write=fs.writeFileSync;
const target=file=>{const absolute=resolve(String(file));return absolute.startsWith(evidence+path.sep)&&!absolute.startsWith(dir+path.sep)?path.join(dir,absolute.slice(evidence.length+1)):file;};
path.resolve=(...args)=>target(resolve(...args));
fs.writeFileSync=(file,...args)=>{const out=target(file);fs.mkdirSync(path.dirname(out),{recursive:true});return write.call(fs,out,...args);};
require(path.join(__dirname,suite+'.cjs'));
