import assert from 'node:assert/strict';
import { createServer, createConnection } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir=mkdtempSync(join(tmpdir(),'distribution-analysis-broker-'));
const outfile=join(dir,'probe.mjs'), path=join(dir,'analysis.sock');
let server;
try {
  await build({entryPoints:['lib/manager-ai-sandbox-broker.ts'],outfile,bundle:true,platform:'node',format:'esm',
    plugins:[{name:'trusted-python',setup(b){
      b.onResolve({filter:/run-manager-ai-sandbox\.py\?raw$/},()=>({path:'worker',namespace:'text'}));
      b.onLoad({filter:/.*/,namespace:'text'},()=>({contents:readFileSync('tools/run-manager-ai-sandbox.py','utf8'),loader:'text'}));
    }}]});
  const {executeBrokerSandbox,serveSandboxConnection}=await import(pathToFileURL(outfile));
  const sample=Uint8Array.of(0,1,2,253,254,255);
  let calls=0,notifyStart,notifyAbort;
  const started=new Promise(resolve=>{notifyStart=resolve;});
  const aborted=new Promise(resolve=>{notifyAbort=resolve;});
  server=createServer(socket=>void serveSandboxConnection(socket,async request=>{
    calls++;
    if(request.code==='wait'){
      notifyStart();
      await once(request.signal,'abort');
      notifyAbort();
      throw Error('cancelled');
    }
    assert.equal(request.language,'python');
    assert.equal(request.inputs[0].filename,'sample.bin');
    assert.deepEqual([...request.inputs[0].bytes],[...sample]);
    assert.deepEqual([...request.database],[...sample]);
    return JSON.stringify({exitCode:0,stdout:'43',artifacts:[]});
  }));
  server.listen(path);
  await once(server,'listening');
  const signal=AbortSignal.timeout(7000);
  const request={language:'python',code:'print(43)',database:sample,
    inputs:[{kind:'input',filename:'sample.bin',mime_type:'application/octet-stream',bytes:sample}],signal};
  assert.equal(JSON.parse(await executeBrokerSandbox(path,request)).stdout,'43');
  const abort=new AbortController();
  const pending=executeBrokerSandbox(path,{...request,code:'wait',signal:abort.signal});
  await started;abort.abort();
  await assert.rejects(pending,{name:'AbortError'});
  await Promise.race([aborted,new Promise((_,reject)=>{
    const timeout=setTimeout(()=>reject(Error('broker did not cancel disconnected job')),3000);
    timeout.unref();
  })]);
  await assert.rejects(executeBrokerSandbox(path,{...request,code:'x'.repeat(24577)}),{status:400});
  const transport=createConnection(path);
  const reply=[];transport.on('data',p=>reply.push(p));
  const closed=once(transport,'close');
  transport.write(Buffer.from([255,255,255,255]));
  await closed;const joined=Buffer.concat(reply);
  assert.equal(joined.readUInt16BE(4),400,'overlong frame rejected before execution');
  assert.equal(calls,2);
  await new Promise(resolve=>server.close(resolve));server=undefined;
  await assert.rejects(executeBrokerSandbox(path,request),{status:503});
  console.log('PASS: bounded sandbox broker binary protocol, inputs, outputs, cancellation and closed socket');
} finally {
  if(server)await new Promise(resolve=>server.close(resolve));
  rmSync(dir,{recursive:true,force:true});
}
