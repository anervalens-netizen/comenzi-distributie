import assert from 'node:assert/strict';
import {createBackendFrameNormalizer} from '../deploy/backend-frame-identity.mjs';
const release='a'.repeat(40), root='/isolated/release';
const hashes={js:'b'.repeat(64),map:'c'.repeat(64),debug_id:'11111111-1111-5111-8111-111111111111'};
const files={'dist/server/index.js':hashes,'dist/server/ssr/index.js':{...hashes,debug_id:'22222222-2222-5222-8222-222222222222'},
  'dist/server/_next/static/route-synthetic.js':{...hashes,debug_id:'33333333-3333-5333-8333-333333333333'},'sales-parser-worker.mjs':hashes};
const normalize=createBackendFrameNormalizer({root,release,manifest:{release,files}});
const frames=Object.keys(files).filter(x=>x.startsWith('dist/server/')).map(name=>({
  filename:'index.js',abs_path:'file://'+root+'/'+name,lineno:42,colno:7}));
for (const frame of frames) normalize(frame);
assert.deepEqual(frames.map(x=>x.filename),Object.keys(files).filter(x=>x.startsWith('dist/server/')).map(x=>'app:///backend/'+x));
assert.equal(new Set(frames.map(x=>x.filename)).size,3);
assert.ok(frames.every(x=>x.abs_path===x.filename&&x.lineno===42&&x.colno===7));
for (const frame of frames) {const before=structuredClone(frame);normalize(frame);assert.deepEqual(frame,before);}
const absolute={filename:root+'/dist/server/ssr/index.js',lineno:11};normalize(absolute);
assert.equal(absolute.filename,'app:///backend/dist/server/ssr/index.js');
for (const filename of [
  root+'-other/dist/server/index.js','/another/release/dist/server/index.js',
  root+'/../other/dist/server/index.js',root+'/dist/server/unknown.js',
  root+'/sales-parser-worker.mjs',root+'/node_modules/vendor/index.js',
  './dist/server/index.js','https://example.invalid/index.js',
  'file://untrusted.invalid/isolated/release/dist/server/index.js','file://%broken',
]) {const frame={filename,lineno:1,colno:0},before=structuredClone(frame);normalize(frame);assert.deepEqual(frame,before);}
const foreign={abs_path:'https://example.invalid/index.js',filename:root+'/dist/server/index.js'};
normalize(foreign);assert.equal(foreign.filename,root+'/dist/server/index.js');
for(const bad of [
  {release,files:{...files,'dist/server/ssr/index.js':hashes}},
  {release:'d'.repeat(40),files},{release,files:[]},{release,files:{'../index.js':hashes}},
  {release,files:{'/index.js':hashes}},{release,files:{'dist/server/../index.js':hashes}},
  {release,files:{'dist/server/index.js':{js:'bad',map:hashes.map}}},
]) assert.throws(()=>createBackendFrameNormalizer({root,release,manifest:bad}));
assert.throws(()=>createBackendFrameNormalizer({root:'relative',release,manifest:{release,files}}));
console.log('PASS: release-bound backend paths distinguish RSC/SSR, preserve coordinates, and reject unrelated frames or invalid manifests.');
