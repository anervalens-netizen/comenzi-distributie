import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareDigiFixture} from './sim-digi-test-fixture.mjs';
const folder=mkdtempSync(join(tmpdir(),'digi-verify-'));process.env.MOBIUP_ACTIVATIONS_DIR=folder;
try{
 const built=await build({entryPoints:['lib/sim-verification-node.ts'],bundle:true,platform:'node',format:'esm',write:false});
 const {verifySim}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
 const lookup=n=>verifySim(String(n).padStart(19,'0'),'digi');
 assert.throws(()=>lookup(10));prepareDigiFixture(folder);
 const indexDb=new DatabaseSync(join(folder,'digi','activations.sqlite'));indexDb.exec('DROP INDEX activation_occurrences_movement');assert.throws(()=>lookup(10),'unprepared index fails closed');indexDb.close();
 for(let pass=0;pass<2;pass++){const prep=JSON.parse(execFileSync('python3',['tools/prepare-sim-verification.py','--data-dir',join(folder,'digi'),'--provider','digi'],{encoding:'utf8'}));assert.equal(prep.rowChanges,0);assert.equal(prep.status,'PASS');}
 const planDb=new DatabaseSync(join(folder,'digi','activations.sqlite'));const plan=planDb.prepare('EXPLAIN QUERY PLAN SELECT 1 FROM activation_occurrences o INDEXED BY activation_occurrences_movement JOIN activation_movements m ON m.id=o.movement_id WHERE o.movement_id IN (?,?) AND m.company IN (?,?,?) GROUP BY o.import_id,o.movement_id HAVING COUNT(*)>1 LIMIT 1').all(1,2,'MobiUp','MobiCell','ExampleCo');assert(plan.some(r=>r.detail.includes('SEARCH o USING COVERING INDEX activation_occurrences_movement')));assert(!plan.some(r=>r.detail.startsWith('SCAN o')));planDb.close();
 const sale=lookup(10);assert.equal(sale.status,'sold');assert.equal(sale.sale.seller,'TR Example');assert.equal(sale.sale.date,'2026-05-01');assert.equal(sale.sale.receipt,'');assert.equal(sale.provider,'digi');
 assert.equal(lookup(20).sale.kind,'store');assert.equal(lookup(20).sale.company,'MobiCell');
 assert.equal(lookup(30).status,'recorded');assert.equal(lookup(30).history[0].kind,'inventory');
 assert.equal(lookup(40).status,'sold');assert.equal(lookup(40).history.length,3);assert.equal(lookup(40).sale.date,'2026-05-03');
 assert.equal(lookup(50).status,'returned');assert.equal(lookup(60).status,'ambiguous','indistinguishable repeated source observations');assert.equal(lookup(70).status,'ambiguous','same-day order is unknown');
 assert.equal(lookup(80).sale.company,'MobiCell','cross-company resale with company-scoped returns');assert.equal(lookup(90).status,'sold','inventory return is not a commercial return');
 for(const n of [100,110,120])assert.equal(lookup(n).status,'ambiguous');
 assert.equal(lookup(999).status,'not_found');assert.throws(()=>verifySim('123456789012345678','digi'));assert.throws(()=>verifySim('0000000000000000010'),'Vodafone does not read Digi ledger');
 assert(!JSON.stringify(sale).includes('Denumire Client'));assert(!JSON.stringify(sale).includes('Example customer'));
 console.log('PASS Digi verification: real importer, dates, retailers, inventory, returns, resale, duplicates, source absence and provider isolation');
}finally{rmSync(folder,{recursive:true,force:true});}
