import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import * as Sentry from '@sentry/node';
import {TraceMap,originalPositionFor} from '@jridgewell/trace-mapping';
import {scrubErrorEvent} from '../deploy/error-reporting.mjs';
const release=resolve(process.env.MOBIUP_TEST_RELEASE || 'dist/standalone');
const root=mkdtempSync(join(tmpdir(),'real-worker-map-'));
let worker;
try {
 const script=join(release,'client-history-import-worker.mjs');
 assert.ok(existsSync(script));
 // Missing launch argument throws inside the real emitted worker before import
 // processing. All data paths point to our new empty isolated directory.
 const error=await new Promise((resolveError,reject)=>{
  worker=new Worker(pathToFileURL(script),{argv:[],env:{...process.env,MOBIUP_DATA_DIR:root,GLITCHTIP_DSN:'',NODE_ENV:'test'}});
  worker.once('error',resolveError);worker.once('exit',code=>{if(code===0)reject(new Error('Expected isolated invalid launch failure'));});
 });
 assert.ok(error.stack.includes('file://'));
 let observed;
 Sentry.init({dsn:'https://abc@errors.example.invalid/1',defaultIntegrations:false,beforeSend:scrubErrorEvent,
  transport:()=>({send:async envelope=>{observed=envelope[1].find(item=>item[0].type==='event')?.[1];return {statusCode:200};},flush:async()=>true})});
 const id=Sentry.captureException(error); await Sentry.flush(3000);
 assert.ok(observed);
 const frame=observed.exception.values.flatMap(v=>v.stacktrace.frames).find(f=>f.abs_path==='app:///workers/client-history-import-worker.mjs');
 assert.ok(frame,'Real worker file URL must match uploaded worker artifact');
 const sourceMap=JSON.parse(readFileSync(join(release,'.private-source-maps/workers/client-history-import-worker.mjs.map'),'utf8'));
 const original=originalPositionFor(new TraceMap(sourceMap),{line:frame.lineno,column:frame.colno-1});
 assert.ok(original.source?.endsWith('client-history-import-worker.ts'),JSON.stringify(original));
 console.log(JSON.stringify({status:'PASS_REAL_WORKER_EVENT',eventId:id,frame:frame.abs_path,originalSource:original.source,originalLine:original.line}));
} finally {await worker?.terminate();rmSync(root,{recursive:true,force:true});}
