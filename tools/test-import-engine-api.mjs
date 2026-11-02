import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=await mkdtemp(join(tmpdir(),'import-api-test-'));
const requests=[];
const server=createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;requests.push({url:req.url,authorization:req.headers.authorization,body:body&&JSON.parse(body)});res.setHeader('Content-Type','application/json');res.end(JSON.stringify({job:body?JSON.parse(body):{actor:{id:'synthetic-manager'}}}));});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
 process.env.MOBIUP_DATA_DIR=root;process.env.IMPORT_ENGINE_URL=`http://127.0.0.1:${server.address().port}`;process.env.IMPORT_ENGINE_KEY='synthetic-key';
 const stubs={server:`export const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};export const requireManager=u=>{if(u.role!=='manager')fail(403,'denied')};export const response=(v,status=200)=>Response.json(v,{status});export const jsonBody=req=>req.json();`,authorization:`export const importAuthorization=(_,u)=>({userId:u.id,profileVersion:1,managerScope:u.managerScope,tokenHash:'synthetic-hash'});export const withImportAuthorization=(_r,_u,fn)=>fn();`};
 await build({entryPoints:[resolve('lib/import-engine-node.ts')],outfile:join(root,'api.mjs'),bundle:true,platform:'node',format:'esm',plugins:[{name:'stubs',setup(b){b.onResolve({filter:/^node:fs\/promises$/},args=>args.namespace==='file'?{path:args.path,namespace:'fsstub'}:undefined);b.onLoad({filter:/.*/,namespace:'fsstub'},()=>({contents:`export * from 'node:fs/promises';export const statfs=async()=>({bavail:100000000000n,bsize:1n});`,loader:'js'}));b.onResolve({filter:/^\.\/(server|import-write-authorization)$/},args=>({path:args.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:args.path.endsWith('server')?stubs.server:stubs.authorization,loader:'js'}));}}]});
 const api=await import(pathToFileURL(join(root,'api.mjs'))),user={id:'synthetic-manager',name:'Synthetic Manager',role:'manager',managerScope:'global'};
 const content=Buffer.from('synthetic input'),hash=createHash('sha256').update(content).digest('hex'),id=randomUUID();
 function submit(bytes=content,overrides={}){return new Request('http://local/api/imports/jobs',{method:'POST',headers:{'X-Import-Id':id,'X-Import-Kind':'sales_agent','X-Import-Filename':'example.xlsx','X-Import-Sha256':hash,'X-Import-Date-Start':'2026-01-01','X-Import-Date-End':'2026-01-31',...overrides},body:bytes});}
 const result=await api.importsJobs(submit(),user),job=(await result.json()).job;
 assert.equal(job.id,id);assert.equal(job.actor.id,user.id);assert.equal(requests[0].authorization,'Bearer synthetic-key');
 assert.equal(await readFile(join(root,'import-engine-spool',id,'source.xlsx'),'utf8'),'synthetic input');
 await api.importsJobs(submit(),user);assert.deepEqual(requests[1].body,requests[0].body,'retry reuses immutable request');
 await assert.rejects(()=>api.importsJobs(submit(Buffer.from('modified')),user),e=>e.status===400);
 await assert.rejects(()=>api.importsJobs(submit(content,{'X-Import-Date-End':'2026-02-31'}),user),e=>e.status===400);
 await assert.rejects(()=>api.importsJobs(submit(content,{'X-Import-Channel':'eva'}),user),e=>e.status===403);
 let controller;const stream=new ReadableStream({start(value){controller=value;value.enqueue(content.subarray(0,3));}});
 const firstId=randomUUID(),request=submit(content,{'X-Import-Id':firstId});
 const slow=new Request(request.url,{method:'POST',headers:request.headers,body:stream,duplex:'half'});
 const first=api.importsJobs(slow,user);await new Promise(r=>setTimeout(r,100));
 await assert.rejects(()=>api.importsJobs(submit(content,{'X-Import-Id':randomUUID()}),user),e=>e.status===423,'concurrent admission is rejected without blocking the first stream');
 controller.enqueue(content.subarray(3));controller.close();await first;
 console.log('Import API synthetic tests passed');
} finally {await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
