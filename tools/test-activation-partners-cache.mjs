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
      b.onLoad({filter:/.*/,namespace:'reader'},()=>({contents:`export function readActivations(_month,_sites,provider){
        globalThis.__providerReads++;globalThis.__duringProviderRead?.(provider);return globalThis.__providerResult?.(provider)??{available:true,revision:'synthetic',partners:{rows:[]}};}`}));
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
  const partial={...input,crmRevision:2,userId:'partial-selection'};
  const digiFile=join(root,'digi','activation-report.sqlite'),vodafoneWal=join(root,'activations.sqlite-wal');
  const mutateOnce=(target,fn)=>{globalThis.__duringProviderRead=provider=>{
    if(provider===target){delete globalThis.__duringProviderRead;fn();}
  };};
  globalThis.__providerResult=provider=>provider==='digi'?{available:false,latestDate:null,importedAt:''}:undefined;
  mutateOnce('vodafone',()=>writeFileSync(vodafoneWal,'changed while Digi was incomplete'));
  assert.throws(()=>readPartnerPage(partial,0),/Activation publication changed/,'an unavailable provider cannot disable the change check');
  const readsBeforePartial=globalThis.__providerReads;
  for(const page of [0,1]){
    const r=readPartnerPage(partial,page);
    assert.equal(r.operators.vodafone.available,true);assert.equal(r.operators.digi.available,false);
  }
  assert.equal(globalThis.__providerReads,readsBeforePartial+4,'stable incomplete reports remain usable and are never cached');
  rmSync(digiFile);
  mutateOnce('vodafone',()=>writeFileSync(vodafoneWal,'replaced while Digi still missing'));
  assert.throws(()=>readPartnerPage(partial,0),/Activation publication changed/,'a null Digi stamp must not mask a changing Vodafone stamp');
  const missing=readPartnerPage(partial,0);
  assert.deepEqual(missing.operators.digi,{available:false,latestDate:null,importedAt:''});
  assert.equal(missing.operators.vodafone.available,true);
  mutateOnce('vodafone',()=>writeFileSync(digiFile,'Digi appeared'));
  assert.throws(()=>readPartnerPage(partial,0),/Activation publication changed/,'a missing provider appeared during the read');
  mutateOnce('vodafone',()=>rmSync(digiFile));
  assert.throws(()=>readPartnerPage(partial,0),/Activation publication changed/,'a provider disappeared during the read');
  globalThis.__providerResult=()=>undefined;
  const unverified=readPartnerPage(partial,0);
  assert.equal(unverified.operators.digi.available,false,'rows from an operator with no verifiable publication are withheld');
  assert.equal(unverified.operators.vodafone.available,true);
  const vodafoneFile=join(root,'activation-report.sqlite');
  rmSync(vodafoneFile);
  const neither=readPartnerPage(partial,0);
  assert.equal(neither.operators.vodafone.available,false);assert.equal(neither.operators.digi.available,false);
  assert.equal(neither.partners.total,0,'two unverifiable sources cannot generate portfolio activity');
  delete globalThis.__providerResult;
  writeFileSync(vodafoneFile,'published again');writeFileSync(digiFile,'published again');
  readPartnerPage(partial,0);
  // Rotate after the cache key is captured but before the worker returns page two.
  const descriptor=Object.getOwnPropertyDescriptor(DatabaseSync.prototype,'prepare');
  const readsBeforeCachedPage=globalThis.__providerReads;
  assert.ok(descriptor && typeof descriptor.value==='function');
  let rotated=false;
  try{
    DatabaseSync.prototype.prepare=function(sql,...args){
      if(!rotated&&sql.includes('SELECT revision FROM crm_directory_revision')){
        rotated=true;writeFileSync(vodafoneWal,'new publication while reading a cached page');
      }
      return Reflect.apply(descriptor.value,this,[sql,...args]);
    };
    assert.throws(()=>readPartnerPage(partial,1),/Activation publication changed/);
    assert.equal(globalThis.__providerReads,readsBeforeCachedPage,'the race occurred on a cache hit');
  } finally {Object.defineProperty(DatabaseSync.prototype,'prepare',descriptor);}
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
  console.log('PASS: combined pages reuse complete results, invalidate publication changes on cold and cached reads, and preserve uncached stable partial reports.');
}finally{
  db.close();delete globalThis.__providerReads;delete globalThis.__duringProviderRead;delete globalThis.__providerResult;
  ['MOBIUP_DATA_DIR','MOBIUP_ACTIVATIONS_DIR'].forEach((key,i)=>{if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i];});
  rmSync(root,{recursive:true,force:true});
}
