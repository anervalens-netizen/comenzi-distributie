import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {SourceMap} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildSync} from 'esbuild';
import {exportBackendMaps,addBackendDebugIdentity} from './private-backend-source-maps.mjs';
const root=fs.mkdtempSync(path.join(tmpdir(),'private-backend-maps-')),release='a'.repeat(40);
try {
 const scripts=['dist/server/index.js','dist/server/ssr/index.js',
  'sales-parser-worker.mjs','sales-view-worker.mjs','stock-parser-worker.mjs','client-history-import-worker.mjs'];
 const originals=new Map();
 for(const relative of scripts) {
  const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});
  buildSync({stdin:{contents:"export function fail() { throw new Error('synthetic failure'); }",sourcefile:'synthetic.ts',loader:'ts'},
   outfile:target,format:'esm',platform:'node',sourcemap:'external'});
  originals.set(relative,{js:fs.readFileSync(target,'utf8'),map:JSON.parse(fs.readFileSync(target+'.map','utf8'))});
 }
 const result=exportBackendMaps(root,release);
 assert.deepEqual(Object.keys(result.backend).sort(),scripts.slice(0,2).sort());
 assert.deepEqual(Object.keys(result.workers).sort(),scripts.slice(2).sort());
 assert.equal(new Set(Object.values(result.backend).map(x=>x.debug_id)).size,2);
 assert.equal(new Set(Object.values(result.backend).map(x=>path.basename(x.code_file))).size,2);
 for(const relative of scripts) {
  assert.ok(!fs.existsSync(path.join(root,relative+'.map')));
  const worker=relative.endsWith('-worker.mjs'),original=originals.get(relative);
  const target=path.join(root,'.private-source-maps',worker?'workers':'backend',relative);
  const map=JSON.parse(fs.readFileSync(target+'.map','utf8'));
  if(worker) {
   assert.equal(fs.readFileSync(path.join(root,relative),'utf8'),original.js);
   assert.deepEqual(map,original.map);
  } else {
   assert.equal(map.mappings,original.map.mappings);
   assert.ok(fs.readFileSync(path.join(root,relative),'utf8').startsWith(original.js));
   const entry=result.backend[relative];assert.equal(map.debug_id,entry.debug_id);
   assert.ok(fs.readFileSync(path.join(root,relative),'utf8').endsWith('//# debugId='+entry.debug_id+'\n'));
   const mod=await import(pathToFileURL(path.join(root,relative)).href);
   let error;try{mod.fail();}catch(e){error=e;}
   const point=/index\.js:(\d+):(\d+)/.exec(error.stack);assert.ok(point);
   const recovered=new SourceMap(map).findEntry(Number(point[1])-1,Number(point[2])-1);
   assert.ok(recovered.originalSource.endsWith('synthetic.ts'));assert.equal(recovered.originalLine,0);
   assert.throws(()=>addBackendDebugIdentity(path.join(root,relative),target+'.map',relative,release));
  }
 }
 assert.throws(()=>exportBackendMaps(root,release));
 console.log('PASS: both indexes recover real throw locations; debug IDs differ; maps stay private; worker bytes and maps stay unchanged.');
} finally {fs.rmSync(root,{recursive:true,force:true});}
