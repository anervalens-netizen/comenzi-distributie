import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,cpSync,symlinkSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve('.');
const temp=mkdtempSync(join(tmpdir(),'public-resource-boundary-'));
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const run=path=>spawnSync(process.execPath,[path],{encoding:'utf8',timeout:30000});
function fixture(name){
 const dir=join(temp,name);mkdirSync(join(dir,'tools'),{recursive:true});
 cpSync(resolve('tools/prepare-public-data.mjs'),join(dir,'tools/prepare-public-data.mjs'));
 symlinkSync(join(root,'node_modules'),join(dir,'node_modules'),'junction');
 return dir;
}
try{
 const a=fixture('generated');const script=join(a,'tools/prepare-public-data.mjs');
 assert.equal(run(script).status,0,'a fresh checkout can generate public fixtures');
 const resources=join(a,'resources');
 assert.deepEqual(JSON.parse(readFileSync(join(resources,'initial-users.json'),'utf8')),[],'public fixtures contain no login accounts');
 const seed=JSON.parse(readFileSync(join(resources,'seed.json'),'utf8'));
 assert.equal(seed.clients.length,315);assert.ok(seed.products.every(p=>p.code.startsWith('DEMO')));
 const before=hash(join(resources,'seed.json'));assert.equal(run(script).status,0);assert.equal(hash(join(resources,'seed.json')),before,'synthetic generation is repeatable');
 const output=join(temp,'must-not-build');
 const rejected=spawnSync(process.execPath,['tools/build-private.mjs','--resources',resources,'--output',output],{cwd:root,encoding:'utf8',timeout:30000});
 assert.notEqual(rejected.status,0,'private build refuses synthetic resource inputs');assert.equal(existsSync(output),false,'a rejected build does not create a release');
 const names=['seed.json','initial-users.json','accesorii.xlsx','standuri.xlsx','templates.json','template-hashes.json','mail-defaults.json'];
 writeFileSync(join(resources,'resource-mode.json'),JSON.stringify({mode:'private',schema:1,sha256:Object.fromEntries(names.map(n=>[n,hash(join(resources,n))]))}));
 assert.equal(run(script).status,0,'an integrity-verified private profile is accepted');assert.equal(hash(join(resources,'seed.json')),before,'private data is not regenerated');
 writeFileSync(join(resources,'seed.json'),'tampered synthetic test data');
 assert.notEqual(run(script).status,0,'tampered private inputs are rejected');assert.equal(readFileSync(join(resources,'seed.json'),'utf8'),'tampered synthetic test data');
 const b=fixture('unclassified');mkdirSync(join(b,'resources'));writeFileSync(join(b,'resources/seed.json'),'keep this fixture');
 assert.notEqual(run(join(b,'tools/prepare-public-data.mjs')).status,0,'unclassified existing data is not overwritten');
 assert.equal(readFileSync(join(b,'resources/seed.json'),'utf8'),'keep this fixture');
 console.log('PASS: synthetic generation, private integrity, no-overwrite and private-build rejection checks.');
}finally{rmSync(temp,{recursive:true,force:true});}
