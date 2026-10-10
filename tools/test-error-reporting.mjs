import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {scrubErrorEvent,normalizeWorkerFrame} from '../deploy/error-reporting.mjs';
const event=scrubErrorEvent({user:{email:'synthetic@example.invalid'},request:{url:'https://example.invalid/private'},extra:{document:'synthetic'},contexts:{private:{value:'synthetic'}},breadcrumbs:[{message:'synthetic'}],tags:{application:'comenzi',private:'synthetic'},exception:{values:[{type:'Error',value:'private synthetic value',stacktrace:{frames:[{filename:'handler.js',lineno:12,vars:{private:'synthetic'},context_line:'private code'}]}}]}});
for(const key of ['user','request','extra','contexts','breadcrumbs'])assert.equal(event[key],undefined);
assert.deepEqual(event.tags,{application:'comenzi'});
assert.deepEqual(event.exception.values[0].stacktrace.frames,[{filename:'handler.js',lineno:12}]);
assert.equal(event.exception.values[0].value,'Application error (private message omitted)');
console.log('PASS: private context removed; diagnostic stack preserved.');

for (const prefix of ['file:///isolated-release/','/isolated-release/']) {
 const frame={filename:prefix+'sales-parser-worker.mjs',lineno:14,colno:3}; normalizeWorkerFrame(frame);
 assert.equal(frame.filename,'app:///workers/sales-parser-worker.mjs');assert.equal(frame.abs_path,frame.filename);
 assert.equal(frame.lineno,14);assert.equal(frame.colno,3);
}
const other={filename:'file:///isolated-release/server.js'};normalizeWorkerFrame(other);assert.equal(other.filename,'file:///isolated-release/server.js');
console.log('PASS: worker file URLs normalized without changing coordinates or unrelated frames.');

const {mkdtempSync,copyFileSync,mkdirSync,writeFileSync,symlinkSync,rmSync}=await import('node:fs');
const {tmpdir}=await import('node:os');

const {pathToFileURL}=await import('node:url');
const {backendFrameCodeFile}=await import('../deploy/backend-frame-identity.mjs');
const fixture=mkdtempSync(join(tmpdir(),'backend-frame-integration-'));
const savedDsn=process.env.GLITCHTIP_DSN,savedRelease=process.env.GLITCHTIP_RELEASE;
delete process.env.GLITCHTIP_DSN;delete process.env.GLITCHTIP_RELEASE;
try {
 for(const name of ['error-reporting.mjs','backend-frame-identity.mjs'])
  copyFileSync(new URL('../deploy/'+name,import.meta.url),join(fixture,name));
 symlinkSync(resolve('node_modules'),join(fixture,'node_modules'),'dir');
 const release='a'.repeat(40);
 writeFileSync(join(fixture,'RELEASE.json'),JSON.stringify({sha:release}));
 mkdirSync(join(fixture,'.private-source-maps/backend'),{recursive:true});
 const files={};
 const {createHash}=await import('node:crypto');
 for(const [name,id] of [['dist/server/index.js','11111111-1111-5111-8111-111111111111'],['dist/server/ssr/index.js','22222222-2222-5222-8222-222222222222']]) {
  const script="console.log('synthetic');\n//# debugId="+id+'\n';
  const map=JSON.stringify({version:3,sources:['synthetic.ts'],sourcesContent:["console.log('synthetic');"],names:[],mappings:'AAAA',debug_id:id});
  mkdirSync(join(fixture,name,'..'),{recursive:true});
  mkdirSync(join(fixture,'.private-source-maps/backend',name,'..'),{recursive:true});
  writeFileSync(join(fixture,name),script);writeFileSync(join(fixture,'.private-source-maps/backend',name),script);
  writeFileSync(join(fixture,'.private-source-maps/backend',name+'.map'),map);
  files[name]={js:createHash('sha256').update(script).digest('hex'),map:createHash('sha256').update(map).digest('hex'),debug_id:id};
 }
 writeFileSync(join(fixture,'.private-source-maps/backend/manifest.json'),JSON.stringify({release,files}));
 const {scrubErrorEvent:runtimeScrub}=await import(pathToFileURL(join(fixture,'error-reporting.mjs')).href);
 const input={request:{url:'https://example.invalid/private'},exception:{values:[{value:'private',
  stacktrace:{frames:Object.keys(files).map(name=>({filename:'index.js',abs_path:pathToFileURL(join(fixture,name)).href,lineno:12,colno:3,context_line:'private context'}))}}]}};
 const result=runtimeScrub(input);
 assert.equal(result.request,undefined);
 assert.deepEqual(result.debug_meta.images,Object.entries(files).map(([name,value])=>({type:'sourcemap',code_file:backendFrameCodeFile(name,value.debug_id),debug_id:value.debug_id})));
 assert.deepEqual(result.exception.values[0].stacktrace.frames,Object.keys(files).map(name=>({
  filename:backendFrameCodeFile(name,files[name].debug_id),abs_path:backendFrameCodeFile(name,files[name].debug_id),lineno:12,colno:3})));
 process.env.GLITCHTIP_RELEASE='f'.repeat(40);
 const {scrubErrorEvent:mismatchScrub}=await import(pathToFileURL(join(fixture,'error-reporting.mjs')).href+'?mismatch');
 const frame={filename:pathToFileURL(join(fixture,'dist/server/index.js')).href};
 mismatchScrub({exception:{values:[{stacktrace:{frames:[frame]}}]}});
 assert.ok(frame.filename.startsWith('file://'));
 console.log('PASS: runtime scrub loads exact release manifest, maps both indexes, keeps privacy, and refuses mismatched event releases.');
} finally {
 rmSync(fixture,{recursive:true,force:true});
 if(savedDsn===undefined)delete process.env.GLITCHTIP_DSN;else process.env.GLITCHTIP_DSN=savedDsn;
 if(savedRelease===undefined)delete process.env.GLITCHTIP_RELEASE;else process.env.GLITCHTIP_RELEASE=savedRelease;
}
