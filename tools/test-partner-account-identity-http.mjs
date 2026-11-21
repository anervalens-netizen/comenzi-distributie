import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';

const base=process.env.PARTNER_QA_ORIGIN||'http://127.0.0.1:3000';
const root=resolve('work/qa'),history=join(root,'client-history');
if(existsSync(history))throw new Error('Requires an isolated QA database with no client history.');
const tmp=mkdtempSync(join(tmpdir(),'partner-identity-')),db=new DatabaseSync(join(root,'mobiup.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const added=[],sessionHashes=[],cookies={};
const companyId=code=>'hist-'+createHash('sha256').update(JSON.stringify([code,'company'])).digest('hex').slice(0,32);
const franchiseId='hist-'+createHash('sha256').update(JSON.stringify(['GENERICPARTENER','F1'])).digest('hex').slice(0,32);
const records=[
 ['ph-id-plain','CLIENTGEN'],[companyId('GENERICPARTENER'),'GENERICPARTENER'],[franchiseId,'GENERICPARTENER'],
 ['ph-id-local',' Ro. generic–part_ener '],['ph-id-english','RO Generic/Partner'],['ph-id-dot','Client.Gen.'],
 ['ph-id-null',null],['ph-id-absent',undefined],['ph-id-real','RO12345678'],
 ['ph-id-near','GENERICPARTENER2'],['ph-id-near-word','GENERICPARTNERSRL'],
 ['ph-id-other','RO87654321','g-3']
];
async function get(id,path){
 const response=await fetch(base+'/api/'+path,{headers:id?{Cookie:cookies[id]}:{}});
 return {status:response.status,body:await response.json()};
}
try{
 for(const account of ['qa-agent1','qa-manager']){
  const token=randomUUID(),hash=createHash('sha256').update(token).digest('hex');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash,account,Date.now()+3600000);
  sessionHashes.push(hash);cookies[account]='mobiup_session='+token;
 }
 const {partners}=createClientSalesFixture(root,true);added.push(...partners.map(p=>p.id));
 const insert=db.prepare('INSERT INTO customers(id,warehouse_id,data,active) VALUES(?,?,?,1)');
 for(const [id,cui,warehouse='g-5'] of records){
  const partner={id,cui,name:id==='ph-id-real'?'GENERIC PARTNER':'Test identitate CRM Generic Partner '+id,warehouseId:warehouse,warehouseIds:[warehouse],city:'QA',county:'Olt',address:'Test identitate CRM',route:''};
  insert.run(id,warehouse,JSON.stringify(partner));added.push(id);
 }
 const bundle=join(tmp,'snapshot.mjs');
 await build({entryPoints:['lib/partner-activity-snapshot.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 (await import(pathToFileURL(bundle))).buildActivitySnapshot(root);
 const query='q=Test+identitate+CRM',scope='qa-agent1';
 const checks=[];
 const byId=(a,b)=>a.localeCompare(b,'en');
 // Independent probes report all failing routes on the old release.
 for(const account of [scope,'qa-manager']){
  const expected=records.slice(6).filter(([, ,warehouse])=>account==='qa-manager'||warehouse!=='g-3').map(([id])=>id).sort(byId);
  const probes=[
   ['partner/browse?'+query,b=>b.partners.map(p=>p.id)],
   ['partner/activity?'+query,b=>b.partners.map(row=>row.partner.id)],
   ['sales/clients?month=2026-09&'+query,b=>b.rows.map(row=>row.id)]
  ];
  for(const [path,read] of probes){
   const {status,body}=await get(account,path);
   checks.push({account,path,status,expected,actual:status===200?read(body).sort(byId):[]});
  }
 }
 for(const check of checks)console.log(check.account,check.path,check.status,check.actual.length);
 for(const result of checks){
  assert.equal(result.status,200,result.account+' '+result.path);
  assert.deepEqual(result.actual,result.expected,result.account+' '+result.path);
 }
 for(const [id] of records.slice(0,6))for(const account of [scope,'qa-manager']){
  assert.equal((await get(account,'partner/portfolio/'+id)).status,404);
 }
 assert.equal((await get(scope,'partner/portfolio/ph-id-other')).status,404);
 assert.equal((await get('qa-manager','partner/portfolio/ph-id-other')).status,200);
 assert.equal((await get(scope,'partner/portfolio/ph-id-real')).status,200);
 assert.equal((await get(null,'sales/clients?month=2026-09')).status,401);
 // A corrected CUI on the same historical ID immediately restores access.
 db.prepare("UPDATE customers SET data=json_set(data,'$.cui','RO8765321') WHERE id=?").run(franchiseId);
 assert.equal((await get(scope,'partner/portfolio/'+franchiseId)).status,200);
 console.log('PASS: reserved fiscal codes on arbitrary IDs; nullable/missing CUIs; manager/agent visibility, history and access.');
}finally{
 for(const id of added)db.prepare('DELETE FROM customers WHERE id=?').run(id);
 for(const hash of sessionHashes)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
 db.close();rmSync(history,{recursive:true,force:true});rmSync(tmp,{recursive:true,force:true});
}
