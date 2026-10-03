// Real temporary files and wholly synthetic data; no external inputs or services.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,existsSync,linkSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';
const temp=mkdtempSync(join(tmpdir(),'source-guards-')),root=join(temp,'data');mkdirSync(root);
try{
 const bundle=join(temp,'readers.mjs');
 await build({stdin:{contents:"export * from './lib/partner-activity-snapshot';export * from './lib/client-sales-store';export * from './lib/partner-sales-store';export * from './lib/history-source-generation';",resolveDir:process.cwd(),loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const m=await import(pathToFileURL(bundle)),{partners}=createClientSalesFixture(root);
 const history=join(root,'client-history/client-sales-history.sqlite'),snapshot=join(root,'client-history/partner-activity.sqlite'),app=join(root,'mobiup.sqlite'),sales=join(root,'sales.sqlite');
 const sentinel=new DatabaseSync(sales);sentinel.exec("CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES('synthetic-source')");sentinel.close();
 const reference=new DatabaseSync(history);reference.exec('ALTER TABLE history_references ADD COLUMN partners_json TEXT');reference.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners}));reference.close();
 const sources=[history,app,sales];
 const evidence=()=>sources.map(file=>{
   const db=new DatabaseSync(file,{readOnly:true});
   try{return {sha:createHash('sha256').update(readFileSync(file)).digest('hex'),schema:db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()};}finally{db.close();}
 });
 const before=evidence(),tree=()=>readdirSync(root,{recursive:true}).sort();
 const stage=join(root,'stage');mkdirSync(stage);
 const alias=join(temp,'output-alias');symlinkSync(root,alias);
 const rootAlias=join(temp,'root-alias');symlinkSync(root,rootAlias);
 const rebuild=()=>m.buildActivitySnapshot(root,'2026-09-30');
 const read=(directory=root)=>m.readClientSales(partners,'2026-09',directory,'2026-09-30');
 const asyncRead=(cards=partners,month='2026-09')=>m.readClientSalesAsync(cards,month,root,'2026-09-30');
 const activity=(scope='company')=>m.readActivitySnapshot(partners,root,'2026-09-30',{period:'year:2026',scope});
 const amount=result=>{assert.equal(result.state,'ready');return result.rows.find(r=>r.id==='monthly-a').metrics.valueCents;};
 // Validate every source before any output mutation, including root symlinks.
 for(const [directory,target] of [[root,join(alias,'client-history/client-sales-history.sqlite')],[root,join(alias,'mobiup.sqlite')],[rootAlias,join(alias,'sales.sqlite')]]){
   const names=tree();assert.throws(()=>m.buildActivitySnapshot(directory,'2026-09-30',target),/cannot replace a source/);assert.deepEqual(tree(),names);assert.deepEqual(evidence(),before);
 }
 for(const source of sources){
   const final=join(stage,'final.sqlite');symlinkSync(source,final);
   assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',final),/cannot replace a source/);rmSync(final);
   linkSync(source,final);assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',final),/cannot replace a source/);rmSync(final);
 }
 // Source itself may be a file symlink, not merely a symlinked parent.
 const physicalHistory=join(root,'physical-history.sqlite');renameSync(history,physicalHistory);symlinkSync(physicalHistory,history);
 assert.throws(()=>m.buildActivitySnapshot(rootAlias,'2026-09-30',physicalHistory),/cannot replace a source/);
 assert.throws(()=>m.buildActivitySnapshot(rootAlias,'2026-09-30',join(alias,'physical-history.sqlite')),/cannot replace a source/);
 m.buildActivitySnapshot(rootAlias,'2026-09-30',join(stage,'file-alias.sqlite'));
 renameSync(join(stage,'file-alias.sqlite'),snapshot);assert.equal(amount(read(rootAlias)),3200);
 rmSync(history);renameSync(physicalHistory,history);
 const dangling=join(stage,'dangling.sqlite');symlinkSync(join(stage,'absent.sqlite'),dangling);
 assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',dangling),/final symlink/);assert(!existsSync(join(stage,'absent.sqlite')));rmSync(dangling);
 assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',join(root,'missing-parent/out.sqlite')),/ENOENT/);assert(!existsSync(join(root,'missing-parent')));
 // Swap the alias at the final integrity check, after the output is populated.
 const mutable=join(temp,'mutable-parent');symlinkSync(stage,mutable);
 const originalPrepare=DatabaseSync.prototype.prepare;
 let swapped=false;
 DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA quick_check'){rmSync(mutable);symlinkSync(root,mutable);swapped=true;}return originalPrepare.call(this,sql);};
 try{assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',join(mutable,'mobiup.sqlite')),/parent changed/);}finally{DatabaseSync.prototype.prepare=originalPrepare;}
 assert(swapped);assert.deepEqual(readdirSync(stage),[]);assert.deepEqual(evidence(),before);
 // Final links introduced after validation are rejected again before promotion.
 for(const link of [symlinkSync,linkSync]){
   const final=join(stage,'late-link.sqlite');let linked=false;
   DatabaseSync.prototype.prepare=function(sql){if(sql==='PRAGMA quick_check'){link(app,final);linked=true;}return originalPrepare.call(this,sql);};
   try{assert.throws(()=>m.buildActivitySnapshot(root,'2026-09-30',final),/cannot replace a source/);assert(linked);}finally{DatabaseSync.prototype.prepare=originalPrepare;rmSync(final,{force:true});}
   assert.deepEqual(readdirSync(stage),[]);assert.deepEqual(evidence(),before);
 }
 const cli=JSON.parse(execFileSync(process.execPath,['tools/build-partner-activity.mjs','--output',join(stage,'cli.sqlite')],{env:{...process.env,MOBIUP_DATA_DIR:root},encoding:'utf8'}));
 assert.equal(cli.state,'ready');assert.equal(cli.version,'8');assert(existsSync(join(stage,'cli.sqlite')));rmSync(join(stage,'cli.sqlite'));
 assert.deepEqual(evidence(),before);
 // An allowed canonical staging output retains the very same raw provenance.
 const metadata=m.buildActivitySnapshot(rootAlias,'2026-09-30',join(stage,'candidate.sqlite'));
 assert.equal(metadata.version,'8');assert.equal(metadata.sourceGeneration,m.historyFileGeneration(history));
 renameSync(join(stage,'candidate.sqlite'),snapshot);assert.equal(amount(read()),3200);assert.equal(amount(read(rootAlias)),3200);assert.deepEqual(evidence(),before);
 const stamp=()=>{const c=new DatabaseSync(history,{readOnly:true});try{return m.historyStamp(c);}finally{c.close();}};
 const initialStamp=stamp();
 const stale=async()=>{
   assert.equal(read().state,'unavailable');assert.equal((await asyncRead()).state,'unavailable');
   assert.equal(activity('point').state,'unavailable');assert.equal(activity('company').state,'unavailable');
 };
 const edit=sql=>{const c=new DatabaseSync(history);try{c.exec(sql);}finally{c.close();}};
 assert.equal(amount(await asyncRead()),3200);const hits=m.clientSalesCacheStats.hits;
 assert.equal(amount(await asyncRead()),3200);assert.equal(m.clientSalesCacheStats.hits,hits+1);
 edit("UPDATE history_rows SET value_cents=value_cents+777 WHERE identity_id=1 AND document_number='joint'");
 assert.deepEqual(stamp(),initialStamp);await stale();rebuild();assert.equal(amount(read()),3977);assert.equal(amount(await asyncRead()),3977);
 assert.equal(activity().metrics.get('monthly-a').valueCents,8977);
 // No metadata change: identity correction creates a dispute across companies.
 edit("UPDATE history_identities SET client_code='200' WHERE id=1");assert.deepEqual(stamp(),initialStamp);await stale();rebuild();
 const disputed=read();assert.equal(disputed.rows.find(r=>r.id==='monthly-a').identityComplete,false);assert.equal(amount(disputed),2000);
 edit("UPDATE history_identities SET client_code='100' WHERE id=1");rebuild();
 edit("UPDATE history_allocations SET partner_ids_json='[\"monthly-repeat\"]' WHERE identity_id=1");assert.deepEqual(stamp(),initialStamp);await stale();rebuild();assert.equal(amount(read()),2000);
 edit("UPDATE history_allocations SET partner_ids_json='[\"monthly-a\",\"monthly-sibling\"]' WHERE identity_id=1");rebuild();
 assert.equal(amount(read()),3977,'legitimate same-company multi-point history remains intact');
 // WAL writes are visible to the generation fence while the writer stays open.
 const writer=new DatabaseSync(history);writer.exec('PRAGMA journal_mode=WAL');rebuild();await asyncRead();
 writer.exec("UPDATE history_rows SET value_cents=value_cents+123 WHERE identity_id=1 AND document_number='joint'");
 assert.deepEqual(stamp(),initialStamp);await stale();rebuild();assert.equal(amount(await asyncRead()),4100);writer.close();
 // A checkpoint changes the physical generation conservatively; rebuild afterward.
 rebuild();
 // Replace the raw inode AFTER open and before BEGIN; metadata stays unchanged.
 const originalExec=DatabaseSync.prototype.exec;
 async function replaceAfterOpen(reader){
   rebuild();await asyncRead(); // Warm shared stamp, but use a cold report month below.
   copyFileSync(history,history+'.new');let replaced=false;
   DatabaseSync.prototype.exec=function(sql){if(!replaced&&sql==='BEGIN'){replaced=true;renameSync(history+'.new',history);}return originalExec.call(this,sql);};
   try{assert.equal((await reader()).state,'unavailable');assert(replaced);}finally{DatabaseSync.prototype.exec=originalExec;}
 }
 await replaceAfterOpen(()=>read());
 await replaceAfterOpen(()=>asyncRead(partners,'2026-08'));
 await replaceAfterOpen(()=>activity());
 await replaceAfterOpen(()=>m.readPartnerSalesAsync('monthly-a','100',new URLSearchParams('scope=company'),root));
 rebuild();assert.equal(amount(await asyncRead()),4100);
 // Mutate while the actual monthly read has yielded with both snapshots open.
 const many=[...partners,...Array.from({length:600},(_,i)=>({...partners[0],id:'synthetic-extra-'+i,cui:String(900000+i)}))];
 let scheduled=false,mutation=Promise.resolve();
 DatabaseSync.prototype.prepare=function(sql){
   if(!scheduled&&sql==='SELECT name FROM sqlite_master LIMIT 1'){
     scheduled=true;mutation=new Promise(resolve=>setImmediate(()=>{edit("UPDATE history_rows SET value_cents=value_cents+1 WHERE identity_id=1 AND document_number='joint'");resolve();}));
   }
   return originalPrepare.call(this,sql);
 };
 try{assert.equal((await asyncRead(many)).state,'unavailable');assert(scheduled);await mutation;}finally{DatabaseSync.prototype.prepare=originalPrepare;}
 await stale();rebuild();assert.equal(amount(await asyncRead()),4101);
 // Replace during cold cooperative reference hashing; all waiters fail closed.
 const wide=new DatabaseSync(history);wide.prepare('UPDATE history_references SET partners_json=?').run(JSON.stringify({partners,syntheticPadding:'x'.repeat(4*1024*1024)}));wide.close();rebuild();
 let hashing=false,replacement=Promise.resolve();
 DatabaseSync.prototype.prepare=function(sql){
   if(!hashing&&sql.includes(' AS BLOB)')){hashing=true;replacement=new Promise(resolve=>setImmediate(()=>{copyFileSync(history,history+'.new');renameSync(history+'.new',history);resolve();}));}
   return originalPrepare.call(this,sql);
 };
 try{
   const results=await Promise.all(Array.from({length:4},()=>asyncRead()));
   assert(hashing);await replacement;for(const result of results)assert.equal(result.state,'unavailable');
 }finally{DatabaseSync.prototype.prepare=originalPrepare;}
 rebuild();const builds=m.clientSalesCacheStats.builds,stamps=m.clientSalesCacheStats.stampBuilds;
 const concurrent=await Promise.all(Array.from({length:4},()=>asyncRead()));
 for(const result of concurrent)assert.equal(amount(result),4101);
 assert.equal(m.clientSalesCacheStats.builds,builds+1);assert.equal(m.clientSalesCacheStats.stampBuilds,stamps+1);
 // Every prior schema, including 6, and missing provenance require a rebuild.
 for(const patch of [{version:'5'},{version:'6'},{sourceGeneration:undefined}]){
   const db=new DatabaseSync(snapshot),meta=JSON.parse(db.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value);
   db.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(JSON.stringify({...meta,...patch}));db.close();await stale();rebuild();
 }
 console.log('PASS: physical output guards/source SHA+schema, mutable parents, canonical staging, raw rows/identity/allocation/WAL freshness, opened-inode and yielding races, exact rebuilt totals and cold single-flight caches.');
}finally{rmSync(temp,{recursive:true,force:true});}
