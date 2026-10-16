import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
async function load(path){const r=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(r.outputFiles[0].text).toString('base64'));}
const folder=mkdtempSync(join(tmpdir(),'activations-test-'));process.env.MOBIUP_ACTIVATIONS_DIR=folder;
const {readActivations}=await load('lib/activation-store-node.ts'),{canViewActivations}=await load('lib/activation-access.ts');
try{
 assert.equal(canViewActivations({id:'pilot-manager',role:'manager'}),false);
 process.env.MOBIUP_ACTIVATIONS_PILOT_MANAGER_ID='pilot-manager';process.env.MOBIUP_ACTIVATIONS_PILOT_AGENT_ID='pilot-agent';
 assert(canViewActivations({id:'pilot-manager',role:'manager'}));assert(canViewActivations({id:'pilot-agent',role:'agent'}));
 for(const u of [{id:'other-manager',role:'manager'},{id:'other-agent',role:'agent'},{id:'pilot-agent',role:'manager'},{id:'pilot-agent',role:'agent',active:0}])assert.equal(canViewActivations(u),false);
 assert.equal(readActivations('2026-10',null).available,false);
 const source=new DatabaseSync(folder+'/activations.sqlite');source.exec("CREATE TABLE activation_meta(key,value); INSERT INTO activation_meta VALUES('schema_version','2');CREATE TABLE activation_imports(sha256,operator,row_count,parser_version,status);INSERT INTO activation_imports VALUES('hash','example',5,2,'complete');");
 const report=new DatabaseSync(folder+'/activation-report.sqlite');report.exec("CREATE TABLE report_meta(key,value);CREATE TABLE monthly(month,item_type,site,count,last_date);CREATE TABLE sites(site,label);INSERT INTO report_meta VALUES('version','1'),('importedAt','2026-10-16');INSERT INTO sites VALUES('A','Example A'),('B','Example B');INSERT INTO monthly VALUES('2026-10','SIM','A',10,'2026-10-13'),('2026-10','TELSIM','A',2,'2026-10-12'),('2026-10','SIM','B',20,'2026-10-13'),('2026-10','SIM','',3,'2026-10-13'),('2024-01','SIM','A',7,'2024-01-31');");report.prepare('INSERT INTO report_meta VALUES(?,?)').run('sourceImports',JSON.stringify([['hash','example',5,2]]));
 const all=readActivations('2026-10',null);assert.equal(all.totals.total,35);assert.equal(all.totals.unassigned,3);assert.equal(all.sites.reduce((n,r)=>n+r.total,0),35);
 const own=readActivations('2026-10',['A']);assert.equal(own.totals.total,12);assert.equal(own.totals.unassigned,0);assert.equal(own.sites.length,1);assert.equal(own.history.length,2);assert(!JSON.stringify(own).includes('Example B'));
 assert.equal(readActivations('2026-10',[]).totals.total,0);assert.equal(readActivations('2024-01',['A']).totals.total,7);
 source.exec("INSERT INTO activation_imports VALUES('new','example',1,2,'complete')");assert.throws(()=>readActivations('2026-10',null),/Stale/);
 source.close();report.close();console.log('PASS: two-account pilot, scoped totals/history, no cross-agent data, missing/stale reports.');
}finally{rmSync(folder,{recursive:true,force:true});}
