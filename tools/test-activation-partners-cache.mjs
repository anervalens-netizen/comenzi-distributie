import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const root=mkdtempSync(join(tmpdir(),'partner-page-cache-'));
const previous=[process.env.MOBIUP_DATA_DIR,process.env.MOBIUP_ACTIVATIONS_DIR];
const db=new DatabaseSync(join(root,'mobiup.sqlite'));
try {
  process.env.MOBIUP_DATA_DIR=root;process.env.MOBIUP_ACTIVATIONS_DIR=root;
  const input={userId:'test-manager',profileVersion:'1',role:'manager',managerScope:'global',
    month:'2026-01',sites:null,scope:{selected:['A','B'],owned:null},crmRevision:1,showDigi:true,
    sort:'label',direction:'asc',selectionParams:[null,null,null],
    query:{view:'partners',rules:{assignments:[]},months:['2026-01'],projects:[],policy:'manager',todayWindow:{from:'2026-01-01',to:'2026-01-05'}}};
  db.exec("CREATE TABLE crm_directory_revision(id INTEGER PRIMARY KEY,revision INTEGER);INSERT INTO crm_directory_revision VALUES(1,1);CREATE TABLE customers(id TEXT PRIMARY KEY,warehouse_id TEXT,data TEXT,active INTEGER)");
  const add=db.prepare('INSERT INTO customers VALUES(?,?,?,1)');
  for(let i=0;i<104;i++)add.run(String(i),i===103?'B':'A',JSON.stringify({name:'Example '+String(i).padStart(3,'0')}));
  db.exec(readFileSync('drizzle/0015_activation_portfolio_memberships.sql','utf8'));
  mkdirSync(join(root,'digi'));
  for(const dir of [root,join(root,'digi')])for(const dbName of ['activation-report.sqlite','activations.sqlite'])writeFileSync(join(dir,dbName),'fixture');
  const built=await build({entryPoints:['lib/activation-partners-page-node.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{
    name:'count-provider-reads',setup(b){
      b.onResolve({filter:/^\.\/activation-store-node$/},()=>({path:'fixture',namespace:'reader'}));
      b.onLoad({filter:/.*/,namespace:'reader'},()=>({contents:`export function readActivations(){
        globalThis.__providerReads++;globalThis.__duringProviderRead?.();return {available:true,revision:'synthetic',partners:{rows:[]}};}`}));
    },
  }]});
  globalThis.__providerReads=0;
  const {readPartnerPage}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
  const first=readPartnerPage(input,0),second=readPartnerPage(input,1);
  assert.equal(first.partners.total,104);assert.equal(second.partners.rows.length,50);
  assert.equal(new Set([...first.partners.rows,...second.partners.rows].map(r=>r.key)).size,100);
  assert.equal(globalThis.__providerReads,2,'page two reuses the two completed provider reads');
  // A restricted manager has the same selected projects but a different owned scope.
  const own=readPartnerPage({...input,userId:'limited',scope:{selected:['A','B'],owned:['B']}},0);
  assert.deepEqual(own.partners.rows.map(r=>r.portfolioId),['103']);
  assert.equal(globalThis.__providerReads,4);
  // Source changes can be committed to a WAL without altering the main file.
  writeFileSync(join(root,'digi','activations.sqlite-wal'),'new generation');
  readPartnerPage(input,1);assert.equal(globalThis.__providerReads,6);
  // Never serve a previous CRM generation after a client is removed.
  db.exec("BEGIN; DELETE FROM customers WHERE id='103';UPDATE crm_directory_revision SET revision=2;COMMIT");
  assert.throws(()=>readPartnerPage(input,2),/directory changed/);
  assert.equal(readPartnerPage({...input,crmRevision:2},2).partners.total,103);
  assert.equal(globalThis.__providerReads,8);
  // A real publication change while a cold page is being assembled must
  // invalidate that result across the same worker protocol as a CRM change.
  globalThis.__duringProviderRead=()=>{
    delete globalThis.__duringProviderRead;
    writeFileSync(join(root,'digi','activations.sqlite-wal'),'rotated during computation');
  };
  assert.throws(()=>readPartnerPage({...input,crmRevision:2,userId:'other-manager'},0),/Activation publication changed/);
  // Hosts without local operator files still return the normal unavailable page contract.
  const cloudBuild=await build({entryPoints:['lib/activation-store-cloudflare.ts'],bundle:true,platform:'node',format:'esm',write:false});
  const cloud=await import('data:text/javascript;base64,'+Buffer.from(cloudBuild.outputFiles[0].text).toString('base64'));
  const unavailable=await cloud.readCombinedActivationPartners(input,2);
  assert.deepEqual(unavailable.operators,{
    vodafone:{available:false,error:'Datele operatorului nu sunt disponibile.'},
    digi:{available:false,error:'Datele operatorului nu sunt disponibile.'},
  });
  assert.deepEqual(unavailable.partners,{rows:[],total:0,page:2,hasMore:false,realPointCount:0,unassignedActivations:0,genericActivations:0,unresolvedActivations:0});
  assert.equal(unavailable.showDigi,true);assert.deepEqual(unavailable.recentWindow,input.query.todayWindow);
  assert.equal(unavailable.revision,(await cloud.readCombinedActivationPartners(input,0)).revision);
  assert.notEqual(unavailable.revision,(await cloud.readCombinedActivationPartners({...input,userId:'other'},0)).revision);
  console.log('PASS: combined pages reuse the computation and invalidate on CRM, scope and operator WAL changes.');
}finally{
  db.close();delete globalThis.__providerReads;delete globalThis.__duringProviderRead;
  ['MOBIUP_DATA_DIR','MOBIUP_ACTIVATIONS_DIR'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});
  rmSync(root,{recursive:true,force:true});
}
