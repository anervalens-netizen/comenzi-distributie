import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

const temporary=mkdtempSync(join(tmpdir(),'activation-membership-boot-'));
const db=new DatabaseSync(join(temporary,'mobiup.sqlite'));
try {
  const runtime=join(temporary,'runtime.mjs');
  await build({entryPoints:['lib/runtime-node.ts'],outfile:runtime,bundle:true,platform:'node',format:'esm',
    plugins:[{name:'raw-migrations',setup(b){
      b.onResolve({filter:/^@\/drizzle\/.*\.sql\?raw$/},args=>({path:resolve(args.path.slice(2,-4)),namespace:'sql'}));
      b.onLoad({filter:/.*/,namespace:'sql'},args=>({contents:readFileSync(args.path,'utf8'),loader:'text'}));
    }}]});
  const boot=()=>execFileSync(process.execPath,['--input-type=module','-e',
    'import {env} from '+JSON.stringify(pathToFileURL(runtime).href)+'; await env.DB.prepare("SELECT 1").first();'],
    {env:{...process.env,MOBIUP_DATA_DIR:temporary},timeout:10000});
  db.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
  db.exec("CREATE TRIGGER partner_profile_address_changed AFTER UPDATE OF data ON customers WHEN json_extract(OLD.data,'$.address') IS NOT json_extract(NEW.data,'$.address') BEGIN SELECT 1; END");
  const insert=db.prepare('INSERT INTO customers VALUES(?,?,?,1)');
  insert.run('legacy-invalid','A','truncated{');
  insert.run('null','A','null');
  insert.run('scalar','A','"text"');
  insert.run('bad-membership','A','{"warehouseIds":"A"}');
  insert.run('legacy','A','{}');
  insert.run('null-membership','N','{"warehouseIds":null}');
  insert.run('many','ignored','{"warehouseIds":["B","B","C",3]}');
  boot();
  const members=()=>db.prepare('SELECT customer_id,warehouse_id FROM activation_portfolio_memberships ORDER BY customer_id,warehouse_id').all().map(row=>[row.customer_id,row.warehouse_id]);
  assert.deepEqual(members(),[['legacy','A'],['many','B'],['many','C'],['null-membership','N']]);
  const plan=db.prepare("EXPLAIN QUERY PLAN SELECT warehouse_id FROM activation_customer_warehouse_rows WHERE customer_id='legacy'").all();
  assert(plan.some(row=>/SEARCH c USING .*\(id=\?\)/.test(row.detail)),'each customer write must look up only its own primary key');
  const change=db.prepare('UPDATE customers SET data=? WHERE id=?');
  insert.run('malformed-insert','A','broken');
  change.run('{"warehouseIds":["D"]}','legacy-invalid');
  db.exec("INSERT INTO partner_profiles(customer_id,latitude,longitude,position_source,updated_at) VALUES ('legacy',44,26,'manual','today')");
  change.run('oops','legacy');
  assert.equal(db.prepare("SELECT latitude FROM partner_profiles WHERE customer_id='legacy'").get().latitude,null,'an unreadable address invalidates a saved position');
  assert.deepEqual(members(),[['legacy-invalid','D'],['many','B'],['many','C'],['null-membership','N']]);
  change.run('{"warehouseIds":["A"]}','legacy');
  assert.equal(db.prepare("SELECT count(*) n FROM activation_portfolio_memberships WHERE customer_id='legacy'").get().n,1);
  const expected=members();
  for(const [type,name] of [['TRIGGER','activation_membership_update'],['INDEX','activation_memberships_customer'],['VIEW','activation_customer_warehouse_rows'],['TABLE','activation_portfolio_memberships']]){
    const before=db.prepare('SELECT revision FROM crm_directory_revision WHERE id=1').get().revision;
    db.exec('DROP '+type+' '+name);
    if(type!=='TABLE'){
      db.exec("DELETE FROM activation_portfolio_memberships WHERE customer_id='legacy'");
      db.exec("INSERT INTO activation_portfolio_memberships VALUES ('WRONG','malformed-insert')");
    }
    boot();
    assert.equal(db.prepare('SELECT revision FROM crm_directory_revision WHERE id=1').get().revision,before+1,'repair invalidates old worker pages');
    assert.deepEqual(members(),expected,'partial restore repairs missing and stale authorizations after losing '+name);
  }
  db.exec('DROP TRIGGER activation_membership_insert; CREATE TRIGGER activation_membership_insert AFTER INSERT ON customers BEGIN SELECT 1; END');
  insert.run('missed','M','{}');
  boot();
  assert(db.prepare("SELECT customer_id FROM activation_portfolio_memberships WHERE warehouse_id='M' AND customer_id='missed'").get(),'an obsolete trigger with the same name must be repaired and prior writes backfilled');
  db.exec("CREATE TRIGGER qa_detect_rebuild BEFORE INSERT ON activation_portfolio_memberships BEGIN SELECT RAISE(ABORT,'unexpected healthy backfill'); END");
  for(let i=0;i<2;i++){
    boot();
    assert(db.prepare("SELECT name FROM sqlite_schema WHERE name='qa_detect_rebuild'").get(),'healthy boots preserve the populated projection');
  }
  console.log('PASS: malformed legacy and new customers, corrected membership, invalidated address, indexed maintenance, partial restores, outdated triggers and repeated healthy boots.');
} finally {
  db.close();
  rmSync(temporary,{recursive:true,force:true});
}
