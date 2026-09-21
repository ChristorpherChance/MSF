// 维护源静态嵌入单 HTML；此工具不生成或批准验证签名。
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),read=name=>fs.readFileSync(path.join(root,name),'utf8');
let html=read('msf-prototype.html');
function replace(start,end,value){const a=html.indexOf(start),b=html.indexOf(end,a);if(a<0||b<0)throw Error('缺少嵌入边界 '+start);html=html.slice(0,a)+value+html.slice(b);}
const kernel=read('customer-state-kernel.js').replace(/\r\n/g,'\n').trim();
for(const name of ['prototype-template.js','build-template.js']){const source=read(name),a=source.indexOf('/* V19_CUSTOMER_KERNEL_START */'),b=source.indexOf('/* V19_CUSTOMER_KERNEL_END */');if(a<0||b<a||source.slice(a+'/* V19_CUSTOMER_KERNEL_START */'.length,b).replace(/\r\n/g,'\n').trim()!==kernel)throw Error(name+' 的状态内核与维护源不一致，拒绝嵌入');}
replace('const V19_DESIGN_CATALOG=','</script>','const V19_DESIGN_CATALOG='+JSON.stringify(JSON.parse(read('design-catalog.json')),null,2)+';\n');
const templateAt=html.indexOf('function v19CustomerPrototypeHTML(catalog)'),templateStart=html.lastIndexOf('<script',templateAt),templateEnd=html.indexOf('</script>',templateAt);if(templateAt<0||templateStart<0||templateEnd<0)throw Error('缺少客户模板script边界');
html=html.slice(0,templateStart)+'<script data-v19-customer-source>\n'+read('prototype-template.js')+'\n'+html.slice(templateEnd);
replace('const V19_APPROVED_SOURCE_RULES=freeze(',');\nconst V19_APPROVED_SOURCE_SPEC','const V19_APPROVED_SOURCE_RULES=freeze('+JSON.stringify(JSON.parse(read('source-acceptance-rules.json'))));
replace('<script data-v19-build-source>','</script>','<script data-v19-build-source>\n'+read('build-template.js')+'\n');
replace('<script data-v19-hardening>','</script>','<script data-v19-hardening>\nconst V19_VERIFIED_UI_CERTIFICATE='+read('verified-ui-certificate.json')+';\n'+read('runtime-hardening.js')+'\n');
const acceptance='<!-- V19_ACCEPTANCE_START -->\n<style>'+read('acceptance-workbench.css')+'</style>\n<script>'+read('acceptance-workbench.js')+'</script>\n<!-- V19_ACCEPTANCE_END -->';
if(html.includes('<!-- V19_ACCEPTANCE_START -->')){const a=html.indexOf('<!-- V19_ACCEPTANCE_START -->'),b=html.indexOf('<!-- V19_ACCEPTANCE_END -->',a);if(b<0)throw Error('缺少测试工作台结束标记');html=html.slice(0,a)+html.slice(b+'<!-- V19_ACCEPTANCE_END -->'.length);}
const bodyEnd=html.lastIndexOf('</body>');if(bodyEnd<0)throw Error('缺少文档body结束标记');html=html.slice(0,bodyEnd)+acceptance+'\n'+html.slice(bodyEnd);
fs.writeFileSync(path.join(root,'msf-prototype.html'),html);
console.log('维护源已静态嵌入；验证签名未变更');
