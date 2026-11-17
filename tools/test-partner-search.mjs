import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const dir=mkdtempSync(join(tmpdir(),'partner-search-')),sql=new DatabaseSync(':memory:');
let reads=0;
globalThis.__partnerSearchDb={prepare(query){const statement=sql.prepare(query);return {bind(...args){return {async all(){reads++;return {results:statement.all(...args)};},async first(){return statement.get(...args);}};},async first(){return statement.get();},async all(){reads++;return {results:statement.all()};}};}};
try{
 sql.exec(`CREATE TABLE customers(id TEXT PRIMARY KEY,data TEXT,active INTEGER); CREATE TABLE portfolio_revision(id INTEGER PRIMARY KEY,data_revision INTEGER NOT NULL); INSERT INTO portfolio_revision VALUES(1,1);
 CREATE TABLE crm_directory_revision(id INTEGER PRIMARY KEY,revision INTEGER NOT NULL); INSERT INTO crm_directory_revision VALUES(1,1);
 CREATE TRIGGER crm_directory_insert AFTER INSERT ON customers BEGIN UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER crm_directory_update AFTER UPDATE ON customers BEGIN UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER crm_directory_delete AFTER DELETE ON customers BEGIN UPDATE crm_directory_revision SET revision=revision+1 WHERE id=1; END`);
 const insert=(id,name,cui,active=1)=>sql.prepare('INSERT INTO customers VALUES(?,?,?)').run(id,JSON.stringify({name,cui,contact:'MUST NOT LEAK',address:'PRIVATE FIELD'}),active);
 insert('one','Știință Exemplu SRL','RO900000000');insert('two','Altă denumire',' r.o. 900-000-000 ');insert('three','Știință inactiv','900000018',0);insert('four','Legacy Ş','ROŞ900000018');insert('five','Normal name','900000018');insert('no-cui','Legacy Unidentified SRL','');
 sql.exec('BEGIN');for(let i=0;i<40000;i++)insert('noise-'+i,'Synthetic '+String(i).padStart(5,'0'),'8'+String(i).padStart(8,'0'));sql.exec('COMMIT');
 await build({entryPoints:['lib/partner-search.ts'],outfile:join(dir,'search.mjs'),bundle:true,format:'esm',platform:'node',plugins:[{name:'db',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'db',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const db=()=>globalThis.__partnerSearchDb;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};`}));}}]});
 const {searchPartnerCompanies:search}=await import(join(dir,'search.mjs'));
 assert.deepEqual(await search('agent','ab'),{companies:[],hasMore:false});assert.equal(reads,0);assert.deepEqual(await search('agent','RO1'),{companies:[],hasMore:false});assert.equal(reads,0);
 const start=performance.now();
 for(const query of ['stiinta','ȘTIINȚĂ','90000000','RO90000000','ro 900000000','R.O. 900-000-000','Altă den']){
  const found=await search('agent',query);assert.equal(found.companies.length,1,query);assert.equal(found.companies[0].pointCount,2);assert.equal(found.companies[0].cui,'900000000');assert.deepEqual(Object.keys(found.companies[0]).sort(),['cui','name','pointCount']);
 }
 for(const query of ["%' OR 1=1 --",'___'])assert.equal((await search('agent',query)).companies.length,0);
 const unicode=await search('agent','900000018');assert.equal(unicode.companies.length,1);assert.equal(unicode.companies[0].pointCount,2);assert.equal(unicode.companies[0].cui,'900000018');
 const noCui=await search('agent','Legacy Unidentified');assert.equal(noCui.companies.length,1);assert.equal(noCui.companies[0].cui,'');
 for(const query of ['a'.repeat(101),'bad\nquery'])await assert.rejects(search('agent',query),e=>e.status===400);
 const page=await search('agent','Synthetic');assert.equal(page.companies.length,20);assert.equal(page.hasMore,true);assert.deepEqual(await search('agent','Synthetic'),page);
 const durations=[];for(let i=0;i<15;i++){const t=performance.now();await search('bench','Synthetic 00001');durations.push(performance.now()-t);}
 durations.sort((a,b)=>a-b);assert.ok(durations[7]<75,'warm indexed search median <75ms, measured '+durations[7].toFixed(1)+'ms');
 const readCount=reads;
 sql.exec('UPDATE portfolio_revision SET data_revision=data_revision+1;');
 await search('agent','Synthetic 00001');
 assert.equal(reads,readCount,'customer index must not rescan CRM rows after unrelated portfolio revision');
 insert('fresh','Fresh Company Entry','RO900000034');
 const refreshed=await search('agent','Fresh Company Entry');assert.equal(refreshed.companies.length,1,'cache must invalidate after CRM revision change');assert.equal(refreshed.companies[0].cui,'900000034');
 for(let i=0;i<90;i++)try{await search('rate','nothing');}catch(e){assert.fail(e);}
 await assert.rejects(search('rate','nothing'),e=>e.status===429);
 const route=readFileSync('app/api/[...path]/route.ts','utf8');assert.ok(route.indexOf("const user=await requireUser(req")<route.indexOf("path.join('/')==='partner/search'"));
 console.log(`PASS CRM search: canonical grouping, 40k active rows, diacritics, partial CUI/name, literal SQL, bounds, revision cache, warm median ${durations[7].toFixed(1)}ms, rate and auth route (${Math.round(performance.now()-start)} ms including rate tests)`);
}finally{sql.close();rmSync(dir,{recursive:true,force:true});}
