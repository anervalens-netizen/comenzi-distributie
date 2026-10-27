import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const folder=mkdtempSync(join(tmpdir(),'sim-verify-'));process.env.MOBIUP_ACTIVATIONS_DIR=folder;
const built=await build({entryPoints:['lib/sim-verification-node.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {verifySim}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
let db;
try{
 assert.throws(()=>verifySim('1234567890123456789'),'missing source is not a negative match');
 db=new DatabaseSync(join(folder,'activations.sqlite'));
 db.exec(`CREATE TABLE activation_meta(key TEXT PRIMARY KEY,value);INSERT INTO activation_meta VALUES('schema_version','3');
 CREATE TABLE activation_facts(company,provider,serial,reasons,PRIMARY KEY(company,provider,serial));
CREATE TABLE activation_imports(imported_at,source_at,status,operator,source_kind);INSERT INTO activation_imports VALUES('2026-10-27T10:00:00Z','2026-10-26','complete','vodafone','internal');
 CREATE TABLE activation_movements(id INTEGER PRIMARY KEY,movement_key,company,provider,imei,item_type,serial);
 CREATE INDEX activation_movements_identity ON activation_movements(company,provider,imei);CREATE INDEX activation_movements_serial ON activation_movements(company,provider,serial);
 CREATE TABLE activation_effective_movements(movement_id INTEGER PRIMARY KEY,company,provider,imei,serial,movement_date,site,is_tr,item_code,customer_key,quantity,raw_json);
 CREATE INDEX effective_serial ON activation_effective_movements(company,provider,serial);`);
 let id=0;
 const add=(imei,{company='MobiUp',provider='vodafone',serial='',date='2026-01-01',site='A',tr=1,quantity=1,customer='c',receipt='TEST-01',type='SIM',effective=true}={})=>{id++;db.prepare('INSERT INTO activation_movements VALUES(?,?,?,?,?,?,?)').run(id,'k'+id,company,provider,imei,type,serial);if(effective)db.prepare('INSERT INTO activation_effective_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,company,provider,imei,serial,date,site,tr,'SIM-TEST',customer,quantity,JSON.stringify({TR:tr?'Example TR':'Example Store',Nr:receipt}));return id;};
 const full='1000000000000000001';add(full);let result=verifySim(full);assert.equal(result.status,'sold');assert.equal(result.sale.seller,'Example TR');assert.equal(result.sale.date,'2026-01-01');assert.equal(result.sale.receipt,'TEST-01');assert.equal(verifySim(full.slice(0,-1)).status,'sold','unactivated SIM searchable by 18 digits');
 assert.equal(verifySim('1000000000000000002').status,'not_found','wrong full check digit never prefix-matches');
 add(full,{effective:false});assert.equal(verifySim(full).history.length,1,'obsolete versions excluded');
 add(full,{date:'2026-01-02',quantity:-1});assert.equal(verifySim(full).status,'returned');
 add(full,{date:'2026-01-03',site:'B',tr:0,receipt:'SALE-02'});result=verifySim(full);assert.equal(result.status,'sold');assert.equal(result.sale.kind,'store');assert.equal(result.sale.receipt,'SALE-02');
 const retail='2000000000000000001';add(retail,{company:'MobiCell',tr:0});assert.equal(verifySim(retail).sale.company,'MobiCell');add(retail,{company:'MobiUp',site:'NOM',tr:0});assert.equal(verifySim(retail).sale.company,'MobiCell','central inventory is not a competing retail sale');
 const moved='2000000000000000002';add(moved);add(moved,{quantity:-1,date:'2026-01-02'});add(moved,{company:'MobiCell',tr:0,date:'2026-01-03'});assert.equal(verifySim(moved).sale.company,'MobiCell','cross-company resale reconciles returns within each company');
 const central='3000000000000000001';add(central,{site:'NOM',tr:0});assert.equal(verifySim(central).status,'recorded');
 const ambiguous='4000000000000000001';add(ambiguous);add(ambiguous,{quantity:-1});assert.equal(verifySim(ambiguous).status,'ambiguous','same day return order unknown');
 const collision='500000000000000000';add(collision+'1');add(collision+'2');assert.equal(verifySim(collision).status,'ambiguous');assert.equal(verifySim(collision+'1').status,'sold');
 const conflict='6000000000000000001',conflictId=add(conflict);db.prepare('INSERT INTO activation_meta VALUES(?,?)').run('conflict:k'+conflictId,'1');assert.equal(verifySim(conflict).status,'ambiguous');
 const handset='100000000000001';add(handset,{type:'TELSIM',serial:'123456789012345678'});add(handset,{type:'TELSIM',serial:'123456789012345679'});
 const complete=verifySim('123456789012345678');assert.equal(complete.status,'ambiguous');assert.equal(complete.history.length,2,'serial match expands to complete handset commercial identity');
 const returnedHandset='100000000000002';add(returnedHandset,{type:'TELSIM',serial:'123456789012345680'});add(returnedHandset,{type:'TELSIM',quantity:-1,date:'2026-01-02'});assert.equal(verifySim('123456789012345680').status,'returned','return without activation serial included');
 const resaleHandset='100000000000004';add(resaleHandset,{type:'TELSIM',serial:'123456789012345681'});add(resaleHandset,{type:'TELSIM',quantity:-1,date:'2026-01-02'});const resaleId=add(resaleHandset,{type:'TELSIM',company:'MobiCell',date:'2026-01-03'});const resale=verifySim('123456789012345681');assert.equal(resale.history.length,3);assert.equal(resale.status,'ambiguous','cross-company handset resale without SIM association must be exposed');db.prepare('UPDATE activation_effective_movements SET serial=? WHERE movement_id=?').run('123456789012345681',resaleId);assert.equal(verifySim('123456789012345681').sale.company,'MobiCell');
 const prefix='123456789012345682';add(prefix+'1');add(prefix+'20');assert.equal(verifySim(prefix).status,'sold');assert.equal(verifySim(prefix).history.length,1,'18-digit abbreviation matches only exact 19-digit identities');
 const digi='7000000000000000001';add(digi,{provider:'digi'});assert.equal(verifySim(digi).status,'not_found');
 const voucher='8000000000000000001',voucherId=add(voucher);db.prepare('UPDATE activation_effective_movements SET item_code=? WHERE movement_id=?').run('V05EVDF',voucherId);assert.equal(verifySim(voucher).status,'not_found','scratch vouchers are not physical SIMs');
 assert.throws(()=>verifySim("' OR 1=1"));assert.throws(()=>verifySim('1e18'));
 assert(!JSON.stringify(result).includes('customer_key'));assert(!JSON.stringify(result).includes('raw_json'));
 db.close();db=null;
 const imported=join(folder,'imported');
 execFileSync('python3',['-c',`
import sys,json
from pathlib import Path
sys.path.insert(0,'tools')
import activations as a
from test_activations import row,fixture
root=Path(sys.argv[1]);root.mkdir()
c=a.connect(root/'data')
try:
 for n,serial in enumerate(['123456789012345671','123456789012345672']):
  f=fixture(root/f'revision-{n}.xlsx',[row(Firma='MobiUp',ItemType='TELSIM',IMEI='100000000000003',Activat=serial)])
  a.import_files(c,root/'data',[f],operator='vodafone',source_at='2026-10-27')
 assert c.execute('SELECT COUNT(*) FROM activation_effective_movements').fetchone()[0]==1
 assert 'serial_conflict' in c.execute('SELECT reasons FROM activation_facts LIMIT 1').fetchone()[0]
 assert not c.execute("SELECT 1 FROM activation_meta WHERE key LIKE 'conflict:%'").fetchone()
 f=fixture(root/'mismatched.xlsx',[row(Firma='MobiUp',Activat='123456789012345673',DocumentDetailId='MISMATCH')]);a.import_files(c,root/'data',[f],operator='vodafone',source_at='2026-10-27')
 central=dict(Firma='MobiUp',IMEI='0000000000000000020',Activat='000000000000000002')
 f=fixture(root/'central.xlsx',[row(**central,TR='SEDIU CENTRAL',SiteCode='NOM',DocumentDetailId='C1',DataVDF='20240101'),row(**central,TR='SEDIU CENTRAL',SiteCode='NOM',DocumentDetailId='C2',DataVDF='20240102',Qtty='-1'),row(**central,DocumentDetailId='C3',DataVDF='20240103')]);a.import_files(c,root/'data',[f],operator='vodafone',source_at='2026-10-27')
finally:c.close()
`,imported]);
 process.env.MOBIUP_ACTIVATIONS_DIR=join(imported,'data');
 const importedDb=new DatabaseSync(join(imported,'data','activations.sqlite'));importedDb.exec('DROP INDEX activation_movements_serial');importedDb.close();assert.throws(()=>verifySim('123456789012345671'),'unprepared index fails closed');
 for(let pass=0;pass<2;pass++){const preparation=JSON.parse(execFileSync('python3',['tools/prepare-sim-verification.py','--data-dir',join(imported,'data')],{encoding:'utf8'}));assert.equal(preparation.status,'PASS');assert.equal(preparation.rowChanges,0);}
 const association=verifySim('123456789012345671');assert.equal(association.status,'ambiguous','real importer serial-observation conflict must not claim a verified handset association');assert.equal(association.history.length,1);assert.equal(verifySim('123456789012345672').status,'ambiguous','non-selected conflicting observation must remain searchable');assert.equal(verifySim('123456789012345673').status,'ambiguous','mismatched physical SIM observation is unverified');assert.equal(verifySim('0000000000000000010').status,'sold','direct physical identity does not depend on activation association');assert.equal(verifySim('0000000000000000020').status,'sold','balanced central pair must not obscure later sale');
 process.env.MOBIUP_ACTIVATIONS_DIR=folder;
 mkdirSync(join(folder,'generations'));symlinkSync(tmpdir(),join(folder,'current'));assert.throws(()=>verifySim(full),'unsafe generation pointer');
 console.log('SIM verification: unactivated, retail, returns/resale, ambiguity, version selection, provider isolation and validation PASS');
}finally{db?.close();rmSync(folder,{recursive:true,force:true});}
