import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,rmSync,chmodSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';

const root=mkdtempSync(join(tmpdir(),'client-history-incremental-'));
try{
  mkdirSync(join(root,'client-history'));
  const modulePath=join(root,'module.mjs');
  await build({
    stdin:{contents:"export {buildActivitySnapshot} from './lib/partner-activity-snapshot';export {refreshActivitySnapshotMonth} from './lib/partner-activity-incremental';export {readActivitySnapshot} from './lib/partner-activity-snapshot';export {historyLogicalRevision} from './lib/history-source-generation';export {historyFileGeneration} from './lib/history-source-generation';",resolveDir:process.cwd(),loader:'ts'},
    outfile:modulePath,bundle:true,platform:'node',format:'esm',logLevel:'silent',
  });
  const {buildActivitySnapshot,refreshActivitySnapshotMonth:refreshReal,historyFileGeneration,historyLogicalRevision,readActivitySnapshot}=await import(pathToFileURL(modulePath).href);
  const digest=value=>createHash('sha256').update(value).digest('hex');
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

  execFileSync('python3',['-c',"import sys,sqlite3;sys.path.insert(0,'tools');import client_sales_history as h;c=sqlite3.connect(sys.argv[1]);h.ensure_history_revision(c);c.close()",history]);
  buildActivitySnapshot(root,'2026-09-30');


  const bytes=readFileSync(history);
  chmodSync(history,0o600);
  assert.deepEqual(readFileSync(history),bytes,'permission change preserves source bytes');
  const result=refreshReal(root,'2026-09','2026-09-30',digest(historyFileGeneration(history)));
  assert(result&&result.mode==='incremental','metadata-only change must not force a full rebuild');

  const logical=()=>{
    const db=new DatabaseSync(history,{readOnly:true});
    try{return historyLogicalRevision(db);}finally{db.close();}
  };
  const pythonLogical=()=>execFileSync('python3',['-c',"import sys,sqlite3;sys.path.insert(0,'tools');import client_sales_history as h;c=sqlite3.connect(sys.argv[1]);print(h.logical_revision(c));c.close()",history],{encoding:'utf8'}).trim();
  assert.equal(logical(),pythonLogical(),'Python importer and Node readers share the same revision protocol');
  assert.equal(readActivitySnapshot([{id:'a',cui:'123'}],root,'2026-09-30').state,'ready','metadata-only change preserves a readable snapshot');
  const revisionBefore=logical();
  const writer=new DatabaseSync(history);
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)');
  writer.close();
  assert.equal(logical(),revisionBefore,'WAL checkpoint does not advance source data revision');
  assert(refreshReal(root,'2026-09','2026-09-30'),'checkpoint-only change stays incremental');
  // The pre/post importer receipt spans exactly one monthly write.
  const previous=digest(logical());
  const change=new DatabaseSync(history);
  change.exec('BEGIN IMMEDIATE; UPDATE history_rows SET value_cents=value_cents+11 WHERE import_id=2');
  const applied=digest(historyLogicalRevision(change));change.exec('COMMIT');change.close();
  const increment=refreshReal(root,'2026-09','2026-09-30',undefined,previous,applied);
  assert(increment&&increment.mode==='incremental','attested monthly write stays incremental');
  const dump=()=>{
    const db=new DatabaseSync(join(root,'client-history','partner-activity.sqlite'),{readOnly:true});
    try{return ['daily','company_daily','revenue_daily','activity','company_activity'].map(t=>db.prepare('SELECT * FROM '+t+' ORDER BY 1,2').all());}finally{db.close();}
  };
  const actual=dump();buildActivitySnapshot(root,'2026-09-30');assert.deepEqual(dump(),actual,'logical incremental output equals full rebuild');
  const base=digest(logical());
  const concurrent=new DatabaseSync(history);concurrent.exec('BEGIN IMMEDIATE; UPDATE history_rows SET value_cents=value_cents+1 WHERE import_id=2');
  const expected=digest(historyLogicalRevision(concurrent));concurrent.exec('COMMIT');
  concurrent.exec('UPDATE history_rows SET value_cents=value_cents+1 WHERE import_id=1');concurrent.close();
  let reason;
  assert.equal(refreshReal(root,'2026-09','2026-09-30',undefined,base,expected,r=>{reason=r;}),null);
  assert.equal(reason,'source_changed_after_import','older correction after import must not be certified by the import receipt');
  assert.equal(readActivitySnapshot([{id:'a',cui:'123'}],root,'2026-09-30').state,'unavailable','external correction invalidates readers');
  buildActivitySnapshot(root,'2026-09-30');
  const coverage=new DatabaseSync(history);coverage.exec('DROP TRIGGER history_revision_history_rows_update');coverage.close();
  assert.equal(logical(),null,'missing write coverage cannot certify a logical revision');
  assert.equal(refreshReal(root,'2026-09','2026-09-30',undefined,undefined,undefined,r=>{reason=r;}),null);
  assert.equal(reason,'logical_revision_coverage_missing');
  const epochBefore=pythonLogical();
  execFileSync('python3',['-c',"import sys,sqlite3;sys.path.insert(0,'tools');import client_sales_history as h;c=sqlite3.connect(sys.argv[1]);h.ensure_history_revision(c);c.close()",history]);
  assert.notEqual(logical(),epochBefore,'repair uses a fresh epoch');
  // All source tables fire for writes from a separate connection, including
  // same-value UPDATEs. Rollbacks restore the revision atomically.
  const external=new DatabaseSync(history);
  for(const table of ['history_meta','history_references','history_imports','history_identities','history_allocations','history_rows']){
    const row=external.prepare('SELECT * FROM '+table+' LIMIT 1').get();
    const column=Object.keys(row)[0],before=historyLogicalRevision(external);
    external.exec('BEGIN IMMEDIATE; UPDATE '+table+' SET '+column+'='+column);
    assert.notEqual(historyLogicalRevision(external),before,table+' external update advances revision');
    external.exec('ROLLBACK');assert.equal(historyLogicalRevision(external),before,table+' rollback restores revision');
    external.exec('BEGIN IMMEDIATE; DELETE FROM '+table);
    assert.notEqual(historyLogicalRevision(external),before,table+' external delete advances revision');
    const afterDelete=historyLogicalRevision(external);
    external.prepare('INSERT INTO '+table+' VALUES('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
    assert.notEqual(historyLogicalRevision(external),afterDelete,table+' external insert advances revision');
    external.exec('ROLLBACK');assert.equal(historyLogicalRevision(external),before,table+' insert/delete rollback restores revision');
  }
  external.close();
  buildActivitySnapshot(root,'2026-09-30');
  const originalPrepare=Object.getOwnPropertyDescriptor(DatabaseSync.prototype,"prepare").value;let raced=false;
  DatabaseSync.prototype.prepare=function(sql,...args){
    if(!raced&&sql==='DELETE FROM daily WHERE date>=? AND date<=?'){
      raced=true;const other=new DatabaseSync(history);
      other.exec('UPDATE history_rows SET value_cents=value_cents+3 WHERE import_id=1');other.close();
    }
    return originalPrepare.call(this,sql,...args);
  };
  try{
    assert.equal(refreshReal(root,'2026-09','2026-09-30',undefined,undefined,undefined,r=>{reason=r;}),null,'concurrent mutation after pinning cannot publish stale snapshot');
    assert.equal(reason,'source_or_snapshot_race');assert(raced);
  }finally{DatabaseSync.prototype.prepare=originalPrepare;}

  console.log('PASS: chmod/checkpoint, cross-language receipts, monthly equivalence, external correction, coverage repair and transactional write revision');

}finally{rmSync(root,{recursive:true,force:true});}
