import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {managerAiTestSdk} from './manager-ai-test-sdk.mjs';
import {responseEvents} from './manager-ai-test-responses.mjs';
import {verifyAgentsAlpha} from './verify-agents-alpha.mjs';

verifyAgentsAlpha();
const directory = mkdtempSync(join(tmpdir(), 'comenzi-native-contract-'));
try {
  const result = await build({
    stdin: {resolveDir: process.cwd(), contents: "export {runManagerAi} from './lib/manager-ai-provider-node.ts';"},
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [managerAiTestSdk, {name: 'synthetic-errors', setup(plugin) {
      plugin.onResolve({filter: /^\.\/server$/}, () => ({path: 'errors', namespace: 'fixture'}));
      plugin.onLoad({filter: /.*/, namespace: 'fixture'}, () => ({contents:
        "export class AppError extends Error {constructor(status,message){super(message);this.status=status}}; export function fail(status,message){throw new AppError(status,message)}"}));
    }}],
  });
  const modulePath = join(directory, 'provider.mjs');
  writeFileSync(modulePath, result.outputFiles[0].text);
  const {runManagerAi} = await import(pathToFileURL(modulePath));
  const model = 'gpt-6.1-terra';
  const query = JSON.stringify({dataset:'sales',fromMonth:'2026-06',toMonth:'2026-06',site:'',groupBy:[],filters:[],orderBy:'units',descending:true,limit:10});
  const source = {rows: [], coverage: [{month:'2026-06',source:'Synthetic',available:true}]};
  const call = (id = 'fixture_call') => ({type:'function_call',name:'read_report',call_id:id,arguments:query});
  const message = text => ({type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]});
  const envelope = output => ({id:'resp_fixture',model,status:'completed',output});
  const options = {model,key:'synthetic-key',turns:[{role:'user',content:'Synthetic report'}],signal:new AbortController().signal,
    check:async()=>{},readSource:async()=>source};
  let checks = 0;

  for (const mode of ['wrong-model','duplicate-call','unknown-tool','wrong-namespace','incomplete-stream']) {
    let reads = 0, requests = 0;
    await assert.rejects(() => runManagerAi({...options,onEvent:async()=>{},readSource:async()=>{reads++;return source;},send:async()=>{
      requests++;
      const output = mode === 'duplicate-call' ? [call(),call()] : [{...call(),
        ...(mode === 'unknown-tool' ? {name:'shell'} : {}),
        ...(mode === 'wrong-namespace' ? {namespace:'host'} : {}),
      }];
      const response = {...envelope(output),...(mode === 'wrong-model' ? {model:'other-model'} : {})};
      if (mode === 'incomplete-stream') return responseEvents([
        {type:'response.created',response:{model}},
        {type:'response.output_item.done',output_index:0,item:call()},
      ]);
      return responseEvents([{type:'response.created',response:{model:response.model}},{type:'response.completed',response}]);
    }}),{status:502},mode);
    assert.equal(reads,0,mode + ' must not dispatch a local callback');
    assert.equal(requests,1,mode + ' must not replay the model request');
    checks++;
  }

  // Reproduce mismatched wire frames against the official native admission path.
  const wireCall = {...call(),id:'tool_fixture'};
  const wireMessage = {...message('Synthetic terminal answer'),id:'message_fixture'};
  const wireFrames = (calls, output) => [
    {type:'response.created',response:{...envelope([]),status:'in_progress'}},
    ...calls.flatMap((item,output_index)=>[
      {type:'response.output_item.added',output_index,item:{...item,arguments:''}},
      {type:'response.function_call_arguments.delta',output_index,item_id:item.id,delta:item.arguments},
      {type:'response.function_call_arguments.done',output_index,item_id:item.id,arguments:item.arguments},
      {type:'response.output_item.done',output_index,item},
    ]),
    {type:'response.output_item.added',output_index:calls.length,item:{...wireMessage,status:'in_progress',content:[]}},
    {type:'response.output_text.delta',output_index:calls.length,item_id:wireMessage.id,content_index:0,delta:'Synthetic terminal answer'},
    {type:'response.output_item.done',output_index:calls.length,item:wireMessage},
    {type:'response.completed',response:envelope(output)},
  ];
  const exactEvents = events => new Response(events.map((event,sequence_number)=>
    'event: '+event.type+'\ndata: '+JSON.stringify({...event,sequence_number})+'\n\n').join('')+'data: [DONE]\n\n',
    {headers:{'Content-Type':'text/event-stream'}});
  for (const mode of ['stream-only','duplicate-stream-id','terminal-only','settled-arguments',
    'delta-arguments','done-arguments','stream-namespace','stream-call-id','stream-item-id','duplicate-settlement']) {
    let reads=0,requests=0;
    const frames=wireFrames(mode==='terminal-only'?[]:[wireCall],mode==='stream-only'?[wireMessage]:[wireCall,wireMessage]);
    if (mode==='duplicate-stream-id') {
      const duplicate={...wireCall,id:'tool_duplicate'};
      frames.splice(1,0,
        {type:'response.output_item.added',output_index:2,item:{...duplicate,arguments:''}},
        {type:'response.output_item.done',output_index:2,item:duplicate});
    }
    if (mode==='settled-arguments') frames.find(event=>event.type==='response.output_item.done').item={...wireCall,arguments:query.replace('"limit":10','"limit":9')};
    if (mode==='delta-arguments') frames.find(event=>event.type==='response.function_call_arguments.delta').delta=query.replace('"limit":10','"limit":9');
    if (mode==='done-arguments') frames.find(event=>event.type==='response.function_call_arguments.done').arguments=query.replace('"limit":10','"limit":9');
    if (mode==='stream-namespace') frames.find(event=>event.type==='response.output_item.done').item={...wireCall,namespace:'host'};
    if (mode==='stream-call-id') frames.find(event=>event.type==='response.output_item.done').item={...wireCall,call_id:'other_call'};
    if (mode==='stream-item-id') frames.find(event=>event.type==='response.function_call_arguments.delta').item_id='other_item';
    if (mode==='duplicate-settlement') frames.splice(5,0,{...frames[4]});
    await assert.rejects(()=>runManagerAi({...options,onEvent:async()=>{},readSource:async()=>{reads++;return source;},
      send:async()=>++requests===1?exactEvents(frames):responseEvents([{type:'response.completed',response:envelope([wireMessage])}])}),
      {status:502},mode);
    assert.equal(reads,0,mode+' must fail before native tool admission');
    assert.equal(requests,1,mode+' must not start a follow-up provider request');
    checks++;
  }

  let streamingReads=0,streamingRequests=0;
  const streamed=await runManagerAi({...options,onEvent:async()=>{},readSource:async()=>{streamingReads++;return source;},
    send:async()=>++streamingRequests===1?exactEvents(wireFrames([wireCall],[wireCall,wireMessage])):
      responseEvents([{type:'response.completed',response:envelope([wireMessage])}])});
  assert.equal(streamingReads,1,'consistent call frames remain admissible');
  assert.equal(streamingRequests,2);
  assert.equal(streamed.reports.length,1);
  checks++;

  for (const status of [429,500]) {
    let requests=0;
    await assert.rejects(() => runManagerAi({...options,send:async()=>{requests++;return new Response('private provider body',{status});}}),
      {status:status===429?503:502});
    assert.equal(requests,1,'no implicit native or OpenAI client retry');
    checks++;
  }

  let imageRequests=0;
  await assert.rejects(() => runManagerAi({...options,turns:[],content:[{role:'user',content:[
    {type:'input_text',text:'Read this synthetic image'},
    {type:'input_image',image_url:'data:image/png;base64,iVBORw0KGgo=',detail:'auto'},
  ]}],send:async()=>{imageRequests++;return Response.json(envelope([message('must not be sent')]));}}),{status:400});
  assert.equal(imageRequests,0,'an image omitted by native preparation must never be sent as a text-only request');
  checks++;

  for (const completed of [false,true]) {
    const refusal = 'Synthetic refusal';
    const response = envelope([{type:'message',id:'msg_refusal',role:'assistant',status:'completed',content:[{type:'refusal',refusal}]}]);
    const events = [
      {type:'response.created',response:{...response,status:'in_progress',output:[]}},
      {type:'response.refusal.delta',item_id:'msg_refusal',output_index:0,content_index:0,delta:refusal},
      {type:'response.refusal.done',item_id:'msg_refusal',output_index:0,content_index:0,refusal},
      ...(completed ? [{type:'response.completed',response}] : []),
    ];
    const run = runManagerAi({...options,onEvent:async()=>{},send:async()=>responseEvents(events)});
    if (completed) assert.equal((await run).answer,refusal);
    else await assert.rejects(run,{status:502},'a refusal is accepted only with a validated terminal response');
    checks++;
  }

  let requests=0, active=0, maximum=0;
  const two = await runManagerAi({...options,readSource:async()=>{
    active++;maximum=Math.max(maximum,active);
    await new Promise(resolve=>setTimeout(resolve,5));
    active--;return source;
  },send:async(_url,init)=>{
    const body=JSON.parse(init.body);
    assert.deepEqual(body.tools.map(tool=>tool.name),['read_report'],'native host tools stay unavailable');
    assert.equal(body.store,false);
    assert.equal(body.parallel_tool_calls,false);
    return Response.json(envelope(++requests===1?[call('one'),call('two')]:[message('Both reports completed')]));
  }});
  assert.equal(maximum,1,'native callback execution remains sequential');
  assert.equal(two.reports.length,2);
  assert.equal(requests,2);
  checks++;

  requests=0;
  let reads=0;
  await assert.rejects(() => runManagerAi({...options,readSource:async()=>{reads++;return source;},
    send:async()=>Response.json(envelope([call('limit_'+(++requests))]))}),{status:422});
  assert.equal(requests,6);
  assert.equal(reads,5,'the last model step cannot start a callback that needs an extra model request');
  checks++;

  const controller=new AbortController();
  let entered, release, settled=false;
  const started=new Promise(resolve=>{entered=resolve;});
  const cleanup=new Promise(resolve=>{release=resolve;});
  requests=0;
  const cancelled=runManagerAi({...options,signal:controller.signal,readSource:async()=>{entered();await cleanup;return source;},
    send:async()=>{requests++;return Response.json(envelope([call()]));}});
  const observed=cancelled.then(()=>{settled=true;},error=>{settled=true;throw error;});
  const rejected=assert.rejects(observed,/synthetic cancellation/);
  await started;
  controller.abort(new Error('synthetic cancellation'));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(settled,false,'cancellation joins the already admitted callback');
  release();
  await rejected;
  assert.equal(requests,1,'cancelled callback output cannot start another provider request');
  checks++;

  console.log('PASS: '+checks+' native admission, refusal, media, retry, model-limit and cancellation contracts; no external model requests.');
} finally {
  rmSync(directory,{recursive:true,force:true});
}
