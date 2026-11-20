import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {digiOperatorReported} from '../lib/digi-operator-source.ts';
const db=new DatabaseSync(':memory:');
try{
 db.exec("CREATE TABLE activation_imports(id INTEGER PRIMARY KEY,company TEXT,operator TEXT,source_kind TEXT,status TEXT,source_at TEXT,period_start TEXT,period_end TEXT);"+
   "CREATE TABLE activation_observations(import_id INTEGER,source_row INTEGER,serial TEXT,activation_date TEXT,PRIMARY KEY(import_id,source_row));"+
   "CREATE TABLE activation_effective_movements(company TEXT,provider TEXT,imei TEXT,site TEXT,is_tr INTEGER);"+
   "CREATE INDEX effective_imei ON activation_effective_movements(company,provider,imei);");
 const imp=db.prepare("INSERT INTO activation_imports VALUES(?,?,'digi','operator','complete',?,?,?)");
 imp.run(1,'ExampleCo','2026-11-09','2026-11-01','2026-11-08');
 imp.run(2,'Exampleco','2026-11-18','2026-11-01','2026-11-15');
 imp.run(3,'ExampleCo','2026-11-20','2026-10-01','2026-10-31');
 const obs=db.prepare("INSERT INTO activation_observations VALUES(?,?,?,?)");
 const iccid=n=>String(n).padStart(19,'0');
 for(const [index,serial] of [1,2,3].entries())obs.run(1,index+1,iccid(serial),'2026-11-02');
 for(const [index,serial] of [1,2,3,4,5,6].entries())obs.run(2,index+1,iccid(serial),'2026-11-02');
 obs.run(3,1,iccid(9),'2026-10-14');
 const sales=db.prepare("INSERT INTO activation_effective_movements VALUES(?,'digi',?,?,?)");
 sales.run('ExampleCo',iccid(1),'TR01',1);
 sales.run('ExampleCo',iccid(2),'TR01',1);
 sales.run('ExampleCo',iccid(3),'TR02',1);
 sales.run('ExampleCo',iccid(4),'',0);
 sales.run('OtherCo',iccid(5),'STORE',0);
 sales.run('ExampleCo',iccid(9),'TR02',1);
 let data=digiOperatorReported(db,['2026-11']);
 assert.equal(data?.total,6);
 assert.equal(data?.matchedTR,3);
 assert.equal(data?.otherChannels,2);
 assert.equal(data?.noCommercialMatch,1);
 assert.equal(data?.unattributedTR,0);
 assert.equal(data?.sourceThrough,'2026-11-15');
 assert.deepEqual(data?.sites,[{site:'TR01',total:2},{site:'TR02',total:1}]);
 assert.deepEqual(data?.monthly,[{month:'2026-11',total:6,matchedTR:3,otherChannels:2,noCommercialMatch:1}]);
 assert.equal(data?.total,data?.matchedTR+data?.otherChannels+data?.noCommercialMatch);
 data=digiOperatorReported(db,['2026-10','2026-11','2026-11']);
 assert.equal(data?.total,7,'all months are counted once');
 assert.deepEqual(data?.monthly.map(x=>x.month),['2026-10','2026-11']);
 assert.equal(data?.matchedTR,4);
 assert.equal(digiOperatorReported(db,['2026-09']),null);
 assert.throws(()=>digiOperatorReported(db,['2026-13']),/Invalid Digi/);
 assert.throws(()=>digiOperatorReported(db,['2026-11','2026-11-01']),/Invalid Digi/);
 // A later partial report MUST NOT blindly accumulate with older snapshots.
 imp.run(4,'EXAMPLECO','2026-11-21','2026-11-01','2026-11-10');
 obs.run(4,1,iccid(1),'2026-11-02');
 assert.equal(digiOperatorReported(db,['2026-11'])?.total,6,'shorter period is not the latest cumulative source');
 // Cross-distributor TR records may not be assigned by a similarly named
 // operator source; only an exact canonical name for the commercial company.
 sales.run('OtherCo',iccid(6),'TR99',1);
 data=digiOperatorReported(db,['2026-11']);
 assert.equal(data?.matchedTR,3,'cross-company TR must not be assigned to Exampleco');
 assert.equal(data?.otherChannels,3);
 assert.equal(data?.noCommercialMatch,0);
 sales.run('ExampleCo',iccid(1),'TR01',1);
 sales.run('ExampleCo',iccid(2),'TR03',1);
 sales.run('ExampleCo',iccid(3),'',1);
 data=digiOperatorReported(db,['2026-11']);
 assert.equal(data.matchedTR,3);
 assert.equal(data.unattributedTR,2,'competing sites and unknown TR site remain unattributed');
 assert.deepEqual(data.sites,[{site:'TR01',total:1}],'duplicate movements at one site are counted once');
 // A second spelling in the commercial ledger makes both commercial owners
 // ambiguous, including where only one of the spellings sold a given SIM.
 sales.run('EXAMPLECO',iccid(8),'TR01',1);
 assert.equal(digiOperatorReported(db,['2026-11']).matchedTR,0);
 const commercialReads=()=>{
  let calls=0;
  const reader={prepare(sql){
   const statement=db.prepare(sql);
   return {all(...args){
    if(sql.includes('activation_effective_movements'))calls++;
    return statement.all(...args);
   }};
  }};
  return {result:digiOperatorReported(reader,['2026-11']),calls};
 };
 const small=commercialReads();
 for(let i=100;i<2100;i++)obs.run(2,i,iccid(i),'2026-11-10');
 const large=commercialReads();
 assert.equal(large.result.total,small.result.total+2000);
 assert.equal(large.calls,small.calls,'commercial SQL reads scale with companies, not SIMs');
 console.log('PASS: latest cumulative Digi operator total, exact ICCID TR site attribution, company safety, other/unmatched, month scoping and no duplicates.');
} finally{db.close();}
