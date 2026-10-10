import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createBackendFrameNormalizer} from '../deploy/backend-frame-identity.mjs';
const release='a'.repeat(40),root=fs.mkdtempSync(path.join(tmpdir(),'backend-identity-'));
const sha = value => createHash('sha256').update(value).digest('hex');
const files={};
function artifact(name,id) {
 const js="console.log('synthetic');\n//# debugId="+id+'\n';
 const map=JSON.stringify({version:3,sources:['synthetic.ts'],sourcesContent:["console.log('synthetic');"],names:[],mappings:'AAAA',debug_id:id});
 for(const target of [path.join(root,name),path.join(root,'.private-source-maps/backend',name)]) {
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,js);
 }
 fs.writeFileSync(path.join(root,'.private-source-maps/backend',name+'.map'),map);
 return {js:sha(js),map:sha(map),debug_id:id};
}
try {
 files['dist/server/index.js']=artifact('dist/server/index.js','11111111-1111-5111-8111-111111111111');
 files['dist/server/ssr/index.js']=artifact('dist/server/ssr/index.js','22222222-2222-5222-8222-222222222222');
 files['dist/server/_next/static/route-synthetic.js']=artifact('dist/server/_next/static/route-synthetic.js','33333333-3333-5333-8333-333333333333');
 const hashes=files['dist/server/index.js'];
 const normalize=createBackendFrameNormalizer({root,release,manifest:{release,files}});
 const frames=Object.keys(files).map(name=>({filename:'index.js',abs_path:'file://'+root+'/'+name,lineno:42,colno:7}));
 for(const frame of frames)normalize(frame);
 assert.deepEqual(frames.map(x=>x.filename),Object.keys(files).map(x=>'app:///backend/'+x));
 assert.equal(new Set(frames.map(x=>x.filename)).size,3);
 assert.ok(frames.every(x=>x.abs_path===x.filename&&x.lineno===42&&x.colno===7));
 for(const frame of frames){const before=structuredClone(frame);normalize(frame);assert.deepEqual(frame,before);}
 const absolute={filename:root+'/dist/server/ssr/index.js',lineno:11};normalize(absolute);
 assert.equal(absolute.filename,'app:///backend/dist/server/ssr/index.js');
 for(const filename of [
  root+'-other/dist/server/index.js','/another/release/dist/server/index.js',
  root+'/../other/dist/server/index.js',root+'/dist/server/unknown.js',
  root+'/sales-parser-worker.mjs',root+'/node_modules/vendor/index.js',
  './dist/server/index.js','https://example.invalid/index.js',
  'file://untrusted.invalid/isolated/release/dist/server/index.js','file://%broken',
 ]){const frame={filename,lineno:1,colno:0},before=structuredClone(frame);normalize(frame);assert.deepEqual(frame,before);}
 const foreign={abs_path:'https://example.invalid/index.js',filename:root+'/dist/server/index.js'};
 normalize(foreign);assert.equal(foreign.filename,root+'/dist/server/index.js');
 for(const bad of [
  {release,files:{...files,'dist/server/ssr/index.js':hashes}},
  {release:'d'.repeat(40),files},{release,files:[]},{release,files:{'../index.js':hashes}},
  {release,files:{'/index.js':hashes}},{release,files:{'dist/server/../index.js':hashes}},
  {release,files:{'dist/server/index.js':{js:'bad',map:hashes.map}}},
  {release,files:{...files,'dist/server/index.js':{...hashes,debug_id:'44444444-4444-5444-8444-444444444444'}}},
 ])assert.throws(()=>createBackendFrameNormalizer({root,release,manifest:bad}));
 assert.throws(()=>createBackendFrameNormalizer({root:'relative',release,manifest:{release,files}}));
 const target=path.join(root,'dist/server/index.js'),original=fs.readFileSync(target);
 fs.appendFileSync(target,"console.log('changed after startup');\n");
 assert.throws(()=>createBackendFrameNormalizer({root,release,manifest:{release,files}}));
 const changed={filename:target,lineno:1};normalize(changed);assert.equal(changed.filename,target);
 fs.writeFileSync(target,original);
 const privateMap=path.join(root,'.private-source-maps/backend/dist/server/index.js.map');
 fs.appendFileSync(privateMap,' ');
 assert.throws(()=>createBackendFrameNormalizer({root,release,manifest:{release,files}}));
 const corrupted={filename:target,lineno:1};normalize(corrupted);assert.equal(corrupted.filename,target);
 console.log('PASS: exact bundle/map bytes and IDs bind each frame; duplicate indexes stay distinct; changed bytes never get an ID.');
} finally {fs.rmSync(root,{recursive:true,force:true});}
