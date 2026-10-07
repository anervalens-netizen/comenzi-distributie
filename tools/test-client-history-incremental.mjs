import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,renameSync,symlinkSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'client-history-incremental-'));
try{
  mkdirSync(join(root,'client-history'));
  const modulePath=join(root,'module.mjs');
  await build({
    stdin:{contents:"export {buildActivitySnapshot} from './lib/partner-activity-snapshot';export {refreshActivitySnapshotMonth} from './lib/partner-activity-incremental';export {historyFileGeneration} from './lib/history-source-generation';",resolveDir:process.cwd(),loader:'ts'},
    outfile:modulePath,bundle:true,platform:'node',format:'esm',logLevel:'silent',
  });
  const {buildActivitySnapshot,refreshActivitySnapshotMonth:refreshReal,historyFileGeneration}=await import(pathToFileURL(modulePath).href);
  const digest=value=>createHash('sha256').update(value).digest('hex');
  // Synthetic month replacements below simulate the importer's pre-write receipt.
  let readingReceipt=false;
  const refreshActivitySnapshotMonth=(dir,month,today)=>{
    const s=new DatabaseSync(join(dir,'client-history','partner-activity.sqlite'),{readOnly:true});
    const meta=JSON.parse(s.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value);readingReceipt=true;try{s.close();}finally{readingReceipt=false;}
    return refreshReal(dir,month,today,digest(meta.sourceGeneration));
  };

  const app=new DatabaseSync(join(root,'mobiup.sqlite'));
  app.exec('CREATE TABLE customers(id TEXT PRIMARY KEY,data TEXT)');
  app.prepare('INSERT INTO customers VALUES(?,?)').run('a',JSON.stringify({cui:'123'}));
  app.close();

  const history=join(root,'client-history','client-sales-history.sqlite');
  const c=new DatabaseSync(history);
  c.exec(`
    CREATE TABLE history_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO history_meta VALUES('current_reference','ref');
    CREATE TABLE history_imports(id INTEGER PRIMARY KEY,sha256 TEXT,state TEXT,period_start TEXT,period_end TEXT,row_count INTEGER,imported_at TEXT);
    INSERT INTO history_imports VALUES(1,'old','active','2026-01-01','2026-08-31',6,'2026-09-01T00:00:00Z');
    INSERT INTO history_imports VALUES(2,'sep-old','active','2026-09-01','2026-09-30',2,'2026-09-30T08:00:00Z');
    CREATE TABLE history_references(id TEXT PRIMARY KEY,partners_json TEXT,master_json TEXT);
    INSERT INTO history_references VALUES('ref','{"partners":[{"id":"a","cui":"123","historyFranchises":["F001"]}]}','[{"CIF":"123","PartnerCode":"123","Cod_Franciza":"F001"}]');
    CREATE TABLE history_identities(id INTEGER PRIMARY KEY,client_code TEXT,franchise_code TEXT);
    INSERT INTO history_identities VALUES(1,'123','F001');
    CREATE TABLE history_allocations(identity_id INTEGER,reference_id TEXT,status TEXT,point_key TEXT,partner_ids_json TEXT,reason TEXT,candidates_json TEXT,PRIMARY KEY(identity_id,reference_id));
    INSERT INTO history_allocations VALUES(1,'ref','direct_code','franchise:F001','["a"]','synthetic','[]');
    CREATE TABLE history_rows(import_id INTEGER,identity_id INTEGER,date TEXT,site_id TEXT,document_number TEXT,value_cents INTEGER,quantity_micros INTEGER);
    CREATE INDEX history_rows_identity_date ON history_rows(identity_id,date,import_id);
    CREATE INDEX history_rows_date ON history_rows(date,import_id);
  `);
  const insert=c.prepare('INSERT INTO history_rows VALUES(?,?,?,?,?,?,?)');
  for(const [i,date] of ['2026-06-01','2026-06-08','2026-06-15','2026-06-22','2026-06-29','2026-07-06'].entries())insert.run(1,1,date,'s','old-'+i,10000,1000000);
  insert.run(2,1,'2026-09-10','s','sep-a',1000,1000000);
  insert.run(2,1,'2026-09-11','s','sep-b',2000,1000000);
  c.close();

  buildActivitySnapshot(root,'2026-09-30');

  // Same immutable reference, current month replaced. Old rows remain physical
  // and are excluded only by import state.
  const edit=new DatabaseSync(history);
  edit.exec("UPDATE history_imports SET state='superseded' WHERE id=2; INSERT INTO history_imports VALUES(3,'sep-new','active','2026-09-01','2026-09-30',4,'2026-10-01T08:00:00Z')");
  const add=edit.prepare('INSERT INTO history_rows VALUES(?,?,?,?,?,?,?)');
  add.run(3,1,'2026-09-10','s','sep-a',1500,1000000);
  add.run(3,1,'2026-09-12','s','sep-c',3000,1000000);
  add.run(3,1,'2026-09-13','s','return',-500,-1000000);
  add.run(3,1,'2026-09-14','s','',700,1000000); // point billing day, but company billing excludes blank document numbers
  edit.close();

  const updated=refreshActivitySnapshotMonth(root,'2026-09','2026-09-30');
  assert(updated&&updated.mode==='incremental','same-reference month replacement uses incremental path');
  assert.equal(updated.rawRows,4);

  const tables=['daily','company_daily','revenue_daily','activity','company_activity','company_identity','company_detail_identity','company_unresolved','company_identity_links','company_code_aliases','point_identity_links','point_unresolved_codes','point_unresolved_candidates'];
  const readSnapshot=()=>{
    const s=new DatabaseSync(join(root,'client-history','partner-activity.sqlite'),{readOnly:true});
    try{
      const result={};
      for(const table of tables)result[table]=s.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all();
      const meta=JSON.parse(String(s.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value));
      result.meta={sourceGeneration:meta.sourceGeneration,sourceImports:meta.sourceImports,catalogPartners:meta.catalogPartners,signature:meta.signature,reference:meta.reference,through:meta.through,asOf:meta.asOf,recentStart:meta.recentStart,previousStart:meta.previousStart,rows:meta.rows,companies:meta.companies,unresolvedCompanyIdentities:meta.unresolvedCompanyIdentities,coverage:meta.coverage};
      return result;
    }finally{s.close();}
  };
  const incremental=readSnapshot();
  buildActivitySnapshot(root,'2026-09-30');
  const full=readSnapshot();
  assert.deepEqual(incremental,full,'incremental month refresh is semantically identical to a full rebuild');

  const olderCorrection=new DatabaseSync(history);olderCorrection.exec('UPDATE history_rows SET value_cents=value_cents+7 WHERE import_id=1');olderCorrection.close();
  assert.equal(refreshReal(root,'2026-09','2026-09-30'),null,'unattested source mutation cannot be blessed as fresh');
  const receiptAfterUnknownChange=digest(historyFileGeneration(history));
  assert.equal(refreshReal(root,'2026-09','2026-09-30',receiptAfterUnknownChange),null,'legitimate import receipt after an older in-place correction requires full rebuild');
  const undoCorrection=new DatabaseSync(history);undoCorrection.exec('UPDATE history_rows SET value_cents=value_cents-7 WHERE import_id=1');undoCorrection.close();
  buildActivitySnapshot(root,'2026-09-30');

  // Same displayed coverage can hide a different historical source generation.
  const priorHash=new DatabaseSync(history);priorHash.exec("UPDATE history_imports SET sha256='corrected-old' WHERE id=1");priorHash.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-09','2026-09-30'),null,'historical source hash drift forces full rebuild');
  const undoHash=new DatabaseSync(history);undoHash.exec("UPDATE history_imports SET sha256='old' WHERE id=1");undoHash.close();

  // A catalog membership change needs historical point facts rebuilt.
  const changedCatalog=new DatabaseSync(join(root,'mobiup.sqlite'));changedCatalog.prepare('INSERT INTO customers VALUES(?,?)').run('new-card','{"cui":"999"}');changedCatalog.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-09','2026-09-30'),null,'catalog membership drift forces full rebuild');
  const undoCatalog=new DatabaseSync(join(root,'mobiup.sqlite'));undoCatalog.exec("DELETE FROM customers WHERE id='new-card'");undoCatalog.close();

  // Old snapshots cannot prove which older import generations they contain.
  const oldMeta=new DatabaseSync(join(root,'client-history','partner-activity.sqlite'));
  const savedMeta=oldMeta.prepare("SELECT value FROM meta WHERE key='snapshot'").get().value;
  const legacy=JSON.parse(savedMeta);delete legacy.sourceImports;
  oldMeta.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(JSON.stringify(legacy));oldMeta.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-09','2026-09-30'),null,'legacy snapshot requests one full rebuild');
  const restoreMeta=new DatabaseSync(join(root,'client-history','partner-activity.sqlite'));restoreMeta.prepare("UPDATE meta SET value=? WHERE key='snapshot'").run(savedMeta);restoreMeta.close();

  const snapshotPath=join(root,'client-history','partner-activity.sqlite'),savedPath=snapshotPath+'.saved';
  renameSync(snapshotPath,savedPath);symlinkSync(history,snapshotPath);
  assert.throws(()=>refreshReal(root,'2026-09','2026-09-30'),/symlink|source database/,'incremental output cannot alias authoritative input');
  rmSync(snapshotPath);renameSync(savedPath,snapshotPath);

  const staleOlder=new DatabaseSync(history);staleOlder.prepare("UPDATE history_imports SET imported_at='2026-10-02T00:00:00Z' WHERE id=1").run();staleOlder.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-09','2026-09-30'),null,'older-month coverage drift forces full rebuild instead of patching a stale base');
  const restoreOlder=new DatabaseSync(history);restoreOlder.prepare("UPDATE history_imports SET imported_at='2026-09-01T00:00:00Z' WHERE id=1").run();restoreOlder.close();

  // A reference extension caused only by a genuinely new current-month identity
  // stays incremental when every previous identity keeps identical allocation semantics.
  const extension=new DatabaseSync(history);
  extension.exec(`INSERT INTO history_references VALUES('ref2','{"partners":[{"id":"a","cui":"123","historyFranchises":["F001"]}]}','[{"CIF":"123","PartnerCode":"123","Cod_Franciza":"F001"}]');
    INSERT INTO history_identities VALUES(2,'555','FNEW');
    INSERT INTO history_allocations VALUES(1,'ref2','direct_code','franchise:F001','["a"]','synthetic','[]');
    INSERT INTO history_allocations VALUES(2,'ref2','direct_code','franchise:FNEW','["a"]','new identity','[]');
    UPDATE history_meta SET value='ref2';
    INSERT INTO history_imports VALUES(4,'oct-new','active','2026-10-01','2026-10-01',1,'2026-10-01T08:00:00Z');
    INSERT INTO history_rows VALUES(4,2,'2026-10-01','s','oct-new',4000,1000000);`);
  extension.close();
  const extended=refreshActivitySnapshotMonth(root,'2026-10','2026-10-01');
  assert(extended&&extended.mode==='incremental','new identity with unchanged prior allocations stays on fast path');
  const extendedIncremental=readSnapshot();
  buildActivitySnapshot(root,'2026-10-01');
  assert.deepEqual(extendedIncremental,readSnapshot(),'reference-extension fast path equals full rebuild');

  // Exercise company/point partitions, ambiguous aliases, missing values,
  // document cancellation, blank numbers, consumer/reconcile and empty CUI cards.
  const moreCatalog=new DatabaseSync(join(root,'mobiup.sqlite'));moreCatalog.prepare('INSERT INTO customers VALUES(?,?)').run('blank','{"cui":""}');moreCatalog.close();
  const matrix=new DatabaseSync(history);
  matrix.exec(`UPDATE history_references SET master_json='[{"CIF":"123","PartnerCode":"123","Cod_Franciza":"F001"},{"CIF":"123","PartnerCode":"AMB"},{"CIF":"999","PartnerCode":"AMB"}]' WHERE id='ref2';
    INSERT INTO history_identities VALUES(3,'CLIENTGEN','');
    INSERT INTO history_identities VALUES(4,'AMB','');
    INSERT INTO history_identities VALUES(5,'NOCUI','');
    INSERT INTO history_allocations VALUES(3,'ref2','consumer','','[]','consumer','[]');
    INSERT INTO history_allocations VALUES(4,'ref2','reconcile','','[]','conflicting','["a"]');
    INSERT INTO history_allocations VALUES(5,'ref2','direct_code','','["blank","blank"]','synthetic','[]');`);
  matrix.close();buildActivitySnapshot(root,'2026-10-31');
  const scenarios=[
    [[1,'doc',500,1000000],[1,'doc',-500,-1000000],[1,'missing',null,1000000],[1,'missing',200,1000000],[1,'',300,1000000],[3,'consumer',800,1000000],[4,'unresolved',900,1000000],[5,'empty-cui',200,1000000]],
    [],
    [[1,'zero',0,1000000],[1,'return',-500,-1000000],[2,'corrected',1500,1000000]],
  ];
  for(const [offset,rows] of scenarios.entries()){
    const e=new DatabaseSync(history);e.exec("UPDATE history_imports SET state='superseded' WHERE period_start='2026-10-01'");
    e.prepare('INSERT INTO history_imports VALUES(?,?,?,?,?,?,?)').run(10+offset,'oct-matrix-'+offset,'active','2026-10-01','2026-10-31',rows.length,'2026-10-31T08:00:00Z');
    for(const [id,doc,value,quantity] of rows)e.prepare('INSERT INTO history_rows VALUES(?,?,?,?,?,?,?)').run(10+offset,id,'2026-10-10','s',doc,value,quantity);
    e.close();assert(refreshActivitySnapshotMonth(root,'2026-10','2026-10-31'));
    const beforeFull=readSnapshot();buildActivitySnapshot(root,'2026-10-31');assert.deepEqual(beforeFull,readSnapshot(),'adversarial month matrix '+offset+' equals full rebuild');
  }

  // New allocation for an identity with older unresolved revenue is unsafe.
  const gap=new DatabaseSync(history);
  gap.exec(`INSERT INTO history_identities VALUES(6,'777',''); INSERT INTO history_rows VALUES(1,6,'2026-07-01','s','old-unallocated',100,1000000);`);gap.close();
  buildActivitySnapshot(root,'2026-10-31');
  const allocateGap=new DatabaseSync(history);
  allocateGap.exec("INSERT INTO history_references SELECT 'gapref',partners_json,master_json FROM history_references WHERE id='ref2'; INSERT INTO history_allocations SELECT identity_id,'gapref',status,point_key,partner_ids_json,reason,candidates_json FROM history_allocations WHERE reference_id='ref2'; INSERT INTO history_allocations VALUES(6,'gapref','direct_code','','[\"a\"]','new','[]'); UPDATE history_meta SET value='gapref'");allocateGap.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-10','2026-10-31'),null,'new historical allocation requires full rebuild');
  const undoGap=new DatabaseSync(history);undoGap.exec("UPDATE history_meta SET value='ref2'");undoGap.close();

  // Deterministic races at the last publication boundaries: no partial snapshot
  // may be published over a replaced source/catalog/base generation.
  buildActivitySnapshot(root,'2026-10-31');
  const originalClose=Object.getOwnPropertyDescriptor(DatabaseSync.prototype,'close').value;
  for(const kind of ['source','catalog','catalog-unrelated','snapshot']){
    let injected=false;
    DatabaseSync.prototype.close=function(){
      const file=String(this.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file||'');
      const match=kind==='source'?history:kind.startsWith('catalog')?join(root,'mobiup.sqlite'):snapshotPath;
      const inject=!injected&&!readingReceipt&&file===match;
      const result=originalClose.call(this);
      if(inject){
        injected=true;
        if(kind.startsWith('catalog')){
          const e=new DatabaseSync(match);e.prepare('UPDATE customers SET data=? WHERE id=?').run(kind==='catalog'?'{"cui":"changed"}':'{"cui":"123","note":"unrelated write"}','a');e.close();
        }else{copyFileSync(match,match+'.race');renameSync(match+'.race',match);}
      }
      return result;
    };
    try{const result=refreshActivitySnapshotMonth(root,'2026-10','2026-10-31');if(kind==='catalog-unrelated')assert(result,'unrelated catalog writes preserve incremental path');else assert.equal(result,null,kind+' generation race prevents publication');assert(injected);}
    finally{DatabaseSync.prototype.close=originalClose;}
    if(kind==='catalog'){const undo=new DatabaseSync(join(root,'mobiup.sqlite'));undo.prepare('UPDATE customers SET data=? WHERE id=?').run('{"cui":"123"}','a');undo.close();}
    buildActivitySnapshot(root,'2026-10-31');
  }

  const changed=new DatabaseSync(history);
  changed.exec("INSERT INTO history_references VALUES('ref3','{\"partners\":[{\"id\":\"a\",\"cui\":\"123\"}]}','[]'); UPDATE history_meta SET value='ref3'; INSERT INTO history_allocations VALUES(1,'ref3','direct_code','partner:a','[\"a\"]','changed','[]'); INSERT INTO history_allocations VALUES(2,'ref3','direct_code','partner:a','[\"a\"]','new identity','[]')");
  changed.close();
  assert.equal(refreshActivitySnapshotMonth(root,'2026-10','2026-10-01'),null,'changed prior allocation/reference safely requests full rebuild');

  console.log('PASS: same-reference and compatible reference-extension month refreshes equal full rebuild; changed prior allocation falls back safely.');
}finally{
  rmSync(root,{recursive:true,force:true});
}
