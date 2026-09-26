import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

// Generated, fictional CI inputs. Never overwrite an existing private resource set.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const resources=resolve(root,'resources');
// The build plugin needs binding names, not an operator project identifier.
const hostingPath=resolve(root,'.openai/hosting.json');
if(!existsSync(hostingPath)){
  mkdirSync(dirname(hostingPath),{recursive:true});
  writeFileSync(hostingPath,JSON.stringify({d1:'DB',r2:'FILES'}));
}
const manifestPath=resolve(resources,'resource-mode.json');
const names=['seed.json','initial-users.json','accesorii.xlsx','standuri.xlsx','templates.json','template-hashes.json','mail-defaults.json'];
if(existsSync(manifestPath)) {
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(!['synthetic','private'].includes(manifest.mode))throw new Error('Unknown resource classification.');
  for(const name of names)if(!existsSync(resolve(resources,name)))throw new Error(`Missing classified resource: ${name}`);
  if(manifest.mode==='private'){
    for(const name of names){
      const actual=createHash('sha256').update(readFileSync(resolve(resources,name))).digest('hex');
      if(manifest.schema!==1||manifest.sha256?.[name]!==actual)throw new Error(`Private resource integrity verification failed: ${name}`);
    }
    console.log('Using explicitly classified and integrity-verified private resources.');
    process.exit(0);
  }
}
if(!existsSync(manifestPath)&&names.some(name=>existsSync(resolve(resources,name))))throw new Error('Unclassified resources exist. Preserve them outside Git and supply an explicit private resource manifest; refusing to overwrite.');
mkdirSync(resources,{recursive:true});
const products=[];
for(let row=2;row<=101;row++)products.push({id:`acc-${row}`,code:`DEMOACC${row}`,name:`Produs demonstrativ ${row}`,brand:'Example',category:'Încărcătoare',kind:'accessories',price:12.1,netPrice:10,sourceRow:row,image:null});
for(let row=2;row<=37;row++)products.push({id:`stand-${row}`,code:`DEMOSTAND${row===10?9:row}`,name:row===9?'Stand demonstrativ de agatat':row===10?'Stand demonstrativ de tejghea':`Produs stand demonstrativ ${row}`,brand:'Example',category:row===9||row===10?'Standuri':row===11?'Cartele':'Telefoane',kind:'stands',price:null,netPrice:null,sourceRow:row,image:null});
const warehouses=Array.from({length:40},(_,i)=>({id:`g-${i+2}`,name:`Gestiune demonstrativă ${i+2}`}));
warehouses.find(x=>x.id==='g-5').name='GESTIUNE TR Bucuresti 01 Agent Exemplu';
warehouses.find(x=>x.id==='g-3').name='GESTIUNE TR Bacau 02';
const clients=Array.from({length:315},(_,i)=>({id:`demo-client-${i+1}`,warehouseId:'g-5',name:`Client demonstrativ ${i+1}`,cui:`RO${90000000+i}`,city:'Localitate exemplu',county:'Ilfov',address:`Strada Exemplu ${i+1}`,route:'Rută demonstrativă',sourceRow:i+2}));
const seed={products,warehouses,clients,importWarnings:[]};
const headers={accessories:['Cod produs','Poza','Brand','Nume produs','Pret distributie Ron fara Tva','Pret distributie Ron cu tva','nr buc','Total valoare lei','STOC DEPOZIT'],stands:['COD','DENUMIRE','COMANDA NR BUC','status']};
function workbook(kind){
  const rows=[headers[kind]];
  for(const p of products.filter(p=>p.kind===kind))rows[p.sourceRow-1]=kind==='accessories'?[p.code,'',p.brand,p.name,p.netPrice,p.price,null,0,null]:[p.code,p.name,null,null];
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),kind==='accessories'?'Preturi':'Sheet1');
  wb.Props={Title:'Synthetic CI fixture',Author:'Example',Company:'Example',Comments:'Fictional data; not for production.'};
  return XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
}
const bytes={accesorii:workbook('accessories'),standuri:workbook('stands')};
writeFileSync(resolve(resources,'seed.json'),JSON.stringify(seed));
writeFileSync(resolve(resources,'initial-users.json'),'[]\n');
for(const [name,body] of Object.entries(bytes))writeFileSync(resolve(resources,`${name}.xlsx`),body);
writeFileSync(resolve(resources,'templates.json'),JSON.stringify(Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,v.toString('base64')]))));
writeFileSync(resolve(resources,'template-hashes.json'),JSON.stringify(Object.fromEntries(Object.entries(bytes).map(([k,v])=>[k,createHash('sha256').update(v).digest('hex')]))));
writeFileSync(resolve(resources,'mail-defaults.json'),JSON.stringify({publicOrigin:'https://app.example.invalid',partnerTo:['distribution@example.invalid','warehouse@example.invalid'],partnerCc:['operations@example.invalid'],standClientTo:'distribution@example.invalid',standClientExcludedCc:['operations@example.invalid']}));
writeFileSync(manifestPath,JSON.stringify({mode:'synthetic',schema:1,description:'Fictional inputs generated exclusively for development and CI.'}));
console.log(`Generated synthetic fixtures: ${products.length} products and ${clients.length} fictional customers. No login credentials generated.`);
