import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';

// Run the shipped artifact outside the checkout. Only Responses transport is
// synthetic: native Agent, authorization, SQLite, uploads and A2UI are real.
const root = mkdtempSync(join(tmpdir(), 'native-runtime-'));
const artifact = join(root, 'release');
const data = join(root, 'data');
const metricsPath = join(root, 'metrics.json');
let child, output = '';
try {
  cpSync(resolve('dist/standalone'), artifact, {recursive:true});
  copyFileSync('tools/manager-ai-test-responses.mjs', join(root,'responses.mjs'));
  writeFileSync(join(root,'transport.mjs'), `
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {responseEvents} from './responses.mjs';
const metrics={requests:0,active:0,maxConcurrent:0,maxRss:0,maxHeap:0,uploads:0};
function save(){const mem=process.memoryUsage();metrics.maxRss=Math.max(metrics.maxRss,mem.rss);metrics.maxHeap=Math.max(metrics.maxHeap,mem.heapUsed);writeFileSync(process.env.SYNTHETIC_METRICS,JSON.stringify(metrics));}
setInterval(save,25).unref();save();
globalThis.fetch=async(input,init)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  assert.equal(url,'https://api.openai.com/v1/responses','Only synthetic Responses transport is permitted');
  const body=JSON.parse(init.body);assert.equal(body.model,'gpt-6.1-terra');
  assert.equal(body.store,false);assert.equal(body.parallel_tool_calls,false);
  assert(body.tools.some(tool=>tool.name==='present_information'));
  assert(!body.tools.some(tool=>['shell','exec_command','computer'].includes(tool.name)));
  metrics.requests++;metrics.active++;metrics.maxConcurrent=Math.max(metrics.maxConcurrent,metrics.active);
  if(JSON.stringify(body.input).includes('eticheta'))metrics.uploads++;
  save();await delay(250);metrics.active--;save();
  const finished=body.input.some(item=>item.type==='function_call_output');
  const text='Synthetic attachment total: 60. '.repeat(5).trim();
  const output=finished?[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]:[
    {type:'function_call',name:'present_information',call_id:'fixture_'+metrics.requests,arguments:JSON.stringify({title:'Synthetic total',layout:'facts',columns:['Metric','Value'],rows:[['Sum','60']]})}
  ];
  return responseEvents([
    {type:'response.created',response:{model:body.model}},
    ...(finished?[{type:'response.output_text.delta',delta:text}]:[]),
    {type:'response.completed',response:{id:'resp_'+metrics.requests,model:body.model,status:'completed',output}}
  ]);
};
`);
  const socket = createServer();
  await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));
  const port = socket.address().port;
  await new Promise(resolve=>socket.close(resolve));
  const origin = 'http://127.0.0.1:'+port;
  child = spawn(process.execPath,['--max-old-space-size=384','--import',join(root,'transport.mjs'),'server.js'],{
    cwd:artifact,env:{...process.env,NODE_PATH:'',NODE_ENV:'production',HOST:'127.0.0.1',PORT:String(port),
      MOBIUP_DATA_DIR:data,MOBIUP_MANAGER_AI_OPENAI_API_KEY:'synthetic-offline-key',
      MOBIUP_MANAGER_AI_SANDBOX_ENABLED:'0',SYNTHETIC_METRICS:metricsPath},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  let ready=false;
  for(let attempt=0;attempt<120;attempt++){
    if(child.exitCode!==null)throw new Error('Relocated server exited: '+output);
    try{ready=(await fetch(origin+'/api/bootstrap')).ok;}catch{}
    if(ready)break;await delay(100);
  }
  assert(ready,'Relocated server did not start: '+output);
  const db = new DatabaseSync(join(data,'mobiup.sqlite'));
  const cookies=[];
  for(const id of ['synthetic-alpha','synthetic-beta']){
    db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES(?,?,?,'manager','assigned','synthetic-disabled',0,1)").run(id,id,id);
    const token=randomUUID();cookies.push('mobiup_session='+token);
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),id,Date.now()+3600000);
  }
  db.close();
  const request=(path,cookie,body)=>fetch(origin+'/api/manager-ai/'+path,{method:body?'POST':'GET',headers:{Cookie:cookie,Origin:origin,...(body&&!(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  const conversations=await Promise.all(cookies.map(async cookie=>{
    const response=await request('conversations',cookie,{effort:'low'});assert.equal(response.status,201,await response.clone().text());return response.json();
  }));
  const ids=cookies.map(()=>randomUUID());
  const csv='eticheta,valoare\nA,10\nB,20\nC,30\n';
  const form=index=>{
    const body=new FormData();
    for(const [key,value] of Object.entries({text:'Read only the synthetic attachment '+index,model:'gpt-6.1-terra',effort:'low',submission_id:ids[index]}))body.set(key,value);
    body.append('files',new File([csv],'synthetic.csv',{type:'text/csv'}));return body;
  };
  const consume=async response=>{
    assert.equal(response.status,200,await response.clone().text());
    return (await response.text()).trim().split('\n').map(line=>JSON.parse(line));
  };
  const turns=await Promise.all(cookies.map(async(cookie,index)=>consume(await request('conversations/'+conversations[index].id+'/turn',cookie,form(index)))));
  for(const [index,events] of turns.entries()){
    assert.equal(events.filter(event=>event.type==='complete').length,1,JSON.stringify(events));
    assert(events.some(event=>event.type==='delta'&&event.text.includes('60')));
    const message=events.find(event=>event.type==='complete').message;
    assert.equal(message.has_presentation,true);
    const path='conversations/'+conversations[index].id+'/messages/'+message.id+'/presentation';
    const presentation=await (await request(path,cookies[index])).json();
    assert.deepEqual(presentation.rows,[['Sum','60']]);
    assert.equal((await request(path,cookies[1-index])).status,404);
    const attachment=events.find(event=>event.message?.attachments?.length)?.message.attachments[0];
    assert(attachment?.download_url);
    const file=attachment.download_url.split('/api/manager-ai/')[1];
    assert.equal(await (await request(file,cookies[index])).text(),csv);
    assert.equal((await request(file,cookies[1-index])).status,404);
  }
  await delay(50);
  const before=JSON.parse(readFileSync(metricsPath,'utf8'));
  assert.equal(before.requests,4);assert.equal(before.maxConcurrent,2);assert(before.uploads>=2);
  const replay=await consume(await request('conversations/'+conversations[0].id+'/turn',cookies[0],form(0)));
  assert.equal(replay.at(-1).type,'complete');
  const after=JSON.parse(readFileSync(metricsPath,'utf8'));
  assert.equal(after.requests,before.requests,'reconnect must not start a native model request');
  const status=readFileSync('/proc/'+child.pid+'/status','utf8');
  const memory=Object.fromEntries(['VmRSS','VmHWM'].map(key=>[key,Number(status.match(new RegExp('^'+key+':\\s+(\\d+)','m'))?.[1])*1024]));
  assert(Math.max(after.maxRss,memory.VmHWM)<768*1024*1024,'synthetic native server exceeds the production memory ceiling');
  const cgroup=readFileSync('/proc/self/cgroup','utf8').trim().split('\n').find(line=>line.startsWith('0::'))?.slice(3);
  const groupPath=cgroup?join('/sys/fs/cgroup',cgroup):undefined;
  const groupMemory={};
  if(groupPath)for(const name of ['memory.peak','memory.high','memory.max','memory.events']){
    const path=join(groupPath,name);if(existsSync(path))groupMemory[name]=readFileSync(path,'utf8').trim();
  }
  assert(!/ERR_MODULE_NOT_FOUND|Cannot find module/.test(output),output);
  console.log('PASS: relocated native artifact, two concurrent turns, attachment isolation, A2UI, streaming and idempotency; '+JSON.stringify({...after,...memory,cgroup:groupMemory}));
} finally {
  if(child&&child.exitCode===null){
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');
    await Promise.race([exited,delay(3000)]);
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
  }
  rmSync(root,{recursive:true,force:true});
}
