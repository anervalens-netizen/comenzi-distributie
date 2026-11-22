import {managerAiTestSdk} from './manager-ai-test-sdk.mjs';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const directory=mkdtempSync(join(tmpdir(),'synthetic-distribution-ai-'));
const db=new DatabaseSync(join(directory,'mobiup.sqlite'));
const originalFetch=globalThis.fetch;
process.env.MOBIUP_DATA_DIR=directory;
process.env.MOBIUP_MANAGER_AI_OPENAI_API_KEY='synthetic-provider-config';
const digest=value=>createHash('sha256').update(value).digest('hex');

try {
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER,must_change_password INTEGER,profile_revision INTEGER,manager_scope TEXT);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    CREATE TABLE portfolio_revision(id INTEGER PRIMARY KEY,scope_revision INTEGER);
    INSERT INTO portfolio_revision VALUES(1,1);
    INSERT INTO users VALUES ('alpha','manager',1,0,1,'assigned'),('beta','manager',1,0,1,'assigned'),('agent','agent',1,0,1,'assigned');
  `);
  const createToken=db.prepare('INSERT INTO sessions VALUES(?,?,?)');
  for(const [token,id] of [['alpha-token','alpha'],['other-alpha-token','alpha'],['beta-token','beta'],['agent-token','agent']]) {
    createToken.run(digest(token),id,Date.now()+60_000);
  }
  const schema=readFileSync('drizzle/0014_manager_ai_conversations.sql','utf8');
  const runOptionsSchema=/CREATE TABLE IF NOT EXISTS manager_ai_run_options \([\s\S]*?\n\);/;
  assert.match(schema,runOptionsSchema);
  db.exec(schema.replace(runOptionsSchema,''));
  const savedConversation=randomUUID(),olderTimestamp='2026-06-01T08:00:00.000Z';
  db.prepare('INSERT INTO manager_ai_conversations VALUES(?,?,?,?,?,?)').run(
    savedConversation,digest(JSON.stringify(['beta','assigned',null])),'Conversație salvată','medium',olderTimestamp,olderTimestamp);
  db.exec(schema);
  globalThis.syntheticAiDatabase=db;
  const mocks={
    './runtime':"export const runtimeKind='node';",
    './manager-ai-sandbox':"export const managerAiSandboxAvailable=()=>Boolean(globalThis.syntheticAnalysisTool);",
    './manager-ai-analysis':"export const createManagerAiAnalysis=options=>globalThis.syntheticAnalysisTool(options);",
    './manager-ai-data':`
      export const managerAiScope=async (user,params)=>({params,filter:globalThis.syntheticAiPortfolio??null,signature:JSON.stringify([user.id,user.profileVersion,params.toString(),globalThis.syntheticAiPortfolio])});
      export const managerAiReader=()=>Object.assign(async query=>{
        if (query.dataset!=='salesByPoint') throw Error('unexpected data tool');
        return {rows:[{franchise:'FIX-42',units:3}],coverage:[{month:'2026-06',source:'Synthetic',available:true}]};
      },{checkSourceScope:async()=>{}});
    `,
    './server':`
      import {createHash} from 'node:crypto';
      export class AppError extends Error {constructor(status,message){super(message);this.status=status;}}
      export const fail=(status,message)=>{throw new AppError(status,message);};
      export const sha256=v=>createHash('sha256').update(v).digest('hex');
      export const sessionToken=req=>req.headers.get('cookie')?.split('=')[1]||'';
      export const assertOrigin=req=>{if(req.headers.get('Origin')&&req.headers.get('Origin')!==new URL(req.url).origin)fail(403,'forbidden origin');};
      export const db=()=>({prepare:sql=>({first:async()=>globalThis.syntheticAiDatabase.prepare(sql).get()})});
      export const response=(data,status=200)=>Response.json(data,{status});
      export const readLimited=async(req,max)=>{const out=await req.arrayBuffer();if(out.byteLength>max)fail(413,'too large');return out;};
      export const jsonBody=req=>req.json();
      export const requireUser=async req=>{
        const row=globalThis.syntheticAiDatabase.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(sha256(sessionToken(req)),Date.now());
        if(!row)fail(401,'session expired');
        return {id:row.id,role:row.role,profileVersion:String(row.profile_revision),managerScope:row.manager_scope};
      };
      export const requireManager=user=>{if(user.role!=='manager')fail(403,'manager only');};
    `,
  };
  const bundle=await build({
    stdin:{resolveDir:process.cwd(),contents:"export * from './lib/manager-ai-conversations.ts'; export {requireUser} from './lib/server.ts';"},
    platform:'node',format:'esm',bundle:true,write:false,
    plugins:[managerAiTestSdk,{name:'synthetic-authority',setup(build){
      build.onResolve({filter:/^\.\/(runtime|manager-ai-data|manager-ai-sandbox|manager-ai-analysis|server)$|^\.\/lib\/server\.ts$/},args=>({path:args.path==='./lib/server.ts'?'./server':args.path,namespace:'synthetic'}));
      build.onLoad({filter:/.*/,namespace:'synthetic'},args=>({contents:mocks[args.path],resolveDir:process.cwd()}));
    }}],
  });
  const modulePath=join(directory,'manager-ai-fixture.mjs');
  writeFileSync(modulePath,bundle.outputFiles[0].text);
  const {managerAiConversations,requireUser}=await import(pathToFileURL(modulePath));

  function call(path,{body,token='alpha-token',origin='https://synthetic.invalid',method='GET'}={}) {
    const headers={cookie:'mobiup_session='+token,Origin:origin};
    if(body!==undefined&&!(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
    const req=new Request('https://synthetic.invalid/api/manager-ai/'+path,body===undefined?{headers,method}:{method:'POST',headers,body});
    return requireUser(req).then(user=>managerAiConversations(req,user,new URL(req.url).pathname.split('/').slice(3)));
  }
  /** @returns {[FormData, string]} */
  function form(text,id=randomUUID(),files=[]) {
    const data=new FormData();
    for(const [key,value] of Object.entries({text,model:'gpt-6.1-terra',effort:'low',submission_id:id}))data.set(key,value);
    for(const file of files)data.append('files',file);
    return [data,id];
  }

  const pending=[];
  const accesses=[];
  const providerOptions=[];
  const oldPartial='Prima redactare, înainte de schimbarea instrucțiunii. '.repeat(4);
  const newPartial='Redactarea după schimbare, deja transmisă clientului. '.repeat(4);
  const responseEvents=events=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  function answer(body,text) {
    const events=[
      {type:'response.created',response:{model:body.model}},
      {type:'response.output_text.delta',delta:text.slice(0,5)},
      {type:'response.output_text.delta',delta:text.slice(5)},
      {type:'response.completed',response:{id:'resp_synthetic',model:body.model,status:'completed',output:[
        {type:'message',id:'msg_synthetic',role:'assistant',status:'completed',content:[{type:'output_text',text}]},
      ]}},
    ];
    return responseEvents(events);
  }
  globalThis.fetch=(url,options)=>{
    assert.equal(new URL(url).hostname,'api.openai.com');
    const body=JSON.parse(options.body);
    assert.equal(body.store,false);
    assert.equal(body.stream,true);
    const text=body.input.at(-1).content;
    const toolOutput=body.input.at(-1).type==='function_call_output';
    accesses.push(body.input);
    providerOptions.push({model:body.model,effort:body.reasoning.effort});
    if(toolOutput&&body.input.at(-1).call_id==='test-analysis'){
      assert.deepEqual(JSON.parse(body.input.at(-1).output),{units:7});
      return Promise.resolve(answer(body,'Analiză sandbox terminată.'));
    }
    if(typeof text==='string'&&text.startsWith('Raport sandbox')){
      assert(body.tools.some(tool=>tool.name==='run_analysis'));
      return Promise.resolve(responseEvents([
        {type:'response.created',response:{model:body.model}},
        {type:'response.completed',response:{id:'resp_synthetic',model:body.model,status:'completed',output:[{
          type:'function_call',name:'run_analysis',call_id:'test-analysis',arguments:JSON.stringify({
            language:'sql',code:'SELECT COUNT(*) FROM sales_lines',tables:[{table:'sales_lines',fromMonth:'2026-06',toMonth:'2026-06'}],files:[],
          }),
        }]}},
      ]));
    }
    if(toolOutput) {
      assert.match(body.input.at(-1).output,/FIX-42/);
      return Promise.resolve(answer(body,'Franciza FIX-42 are 3 bucăți.'));
    }
    if(typeof text==='string'&&text.startsWith('flux parțial')) {
      const output=new ReadableStream({start(controller){
        const delta=text.endsWith('nou')?newPartial:oldPartial;
        for(const event of [{type:'response.created',response:{model:body.model}},{type:'response.output_text.delta',delta}]) {
          controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\n\n'));
        }
        options.signal.addEventListener('abort',()=>controller.error(options.signal.reason),{once:true});
      }});
      return Promise.resolve(new Response(output,{headers:{'Content-Type':'text/event-stream'}}));
    }
    if(text==='Raport franciză')return Promise.resolve(responseEvents([
      {type:'response.created',response:{model:body.model}},
      {type:'response.completed',response:{id:'resp_synthetic',model:body.model,status:'completed',output:[{
        type:'function_call',name:'read_report',call_id:'test-report',arguments:JSON.stringify({
          dataset:'salesByPoint',fromMonth:'2026-06',toMonth:'2026-06',site:'',groupBy:['franchise'],filters:[],orderBy:'units',descending:true,limit:10,
        }),
      }]}},
    ]));
    if(typeof text==='string'&&text.includes('așteaptă'))return new Promise((resolve,reject)=>{
      pending.push(()=>resolve(answer(body,'Terminată')));
      options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    });
    return Promise.resolve(answer(body,'Răspuns verificat'));
  };
  const events=async response=>(await response.text()).trim().split('\n').map(item=>JSON.parse(item));
  async function nextEvent(reader,type) {
    for(;;) {
      const item=await reader.read();
      assert.ok(!item.done,'Missing event '+type);
      const event=JSON.parse(new TextDecoder().decode(item.value));
      if(event.type===type)return event;
    }
  }
  const waitFor=async predicate=>{for(let i=0;i<100&&!predicate();i++)await new Promise(done=>setTimeout(done,10));assert.ok(predicate());};

  assert.deepEqual(await (await call('conversations')).json(),{items:[]});
  await assert.rejects(call('conversations',{token:'agent-token'}),{status:403});
  await assert.rejects(call('conversations',{body:{effort:'low'},origin:'https://other.invalid'}),{status:403});
  const first=await (await call('conversations',{body:{effort:'low'}})).json(),base='conversations/'+first.id;
  const second=await (await call('conversations',{body:{effort:'low'}})).json(),other='conversations/'+second.id;
  await assert.rejects(call(base,{token:'beta-token'}),{status:404});
  await assert.rejects(call(base+'/messages',{token:'beta-token'}),{status:404});
  assert.equal((await (await call(base+'/submissions/'+randomUUID())).json()).state,'unseen');
  const saved=await (await call('conversations',{token:'beta-token'})).json();
  assert.deepEqual(saved.items.map(item=>item.id),[savedConversation]);
  assert.equal(saved.items[0].effort,'medium');

  const firstFiles=()=>[
    new File(['sku,bucati\nA,3'],'rânduri.csv',{type:'text/csv'}),
    new File(['fragment-sterge'],'notite.txt',{type:'text/plain'}),
    new File(['fragment-pastreaza'],'notite.txt',{type:'text/plain'}),
  ];
  const [data,id]=form('Situația lunii',undefined,firstFiles());
  const page=JSON.stringify({tab:'Prepay',period:'2026-09, 2026-10',owner:'neautorizat'});
  data.set('current_view',page);
  const result=await events(await call(base+'/turn',{body:data}));
  assert.equal(result[0].type,'submission_status');
  assert.equal(result[1].message.id,id);
  assert.match(JSON.stringify(accesses.at(-1)),/sku|bucati/);
  assert.match(JSON.stringify(accesses.at(-1)),/2026-09, 2026-10/);
  assert.doesNotMatch(JSON.stringify(accesses.at(-1)),/neautorizat/);
  assert.equal(result.filter(e=>e.type==='complete').length,1);
  assert.ok(result.some(e=>e.type==='delta'&&e.text==='Răspuns verificat'));
  const attachment=result[1].message.attachments[0];
  const artifactPath=attachment.download_url.split('/api/manager-ai/')[1];
  const removable=result[1].message.attachments[1];
  const removablePath=removable.download_url.split('/api/manager-ai/')[1];
  const downloaded=await call(artifactPath);
  assert.equal(await downloaded.text(),'sku,bucati\nA,3');
  assert.equal(downloaded.headers.get('cache-control'),'private, no-store');
  await assert.rejects(call(artifactPath,{token:'beta-token'}),{status:404});
  await assert.rejects(call(artifactPath.replace(base,other)),{status:404});

  const [replay]=form('Situația lunii',id,firstFiles());
  replay.set('current_view',page);
  assert.equal((await events(await call(base+'/turn',{body:replay}))).at(-1).type,'complete');
  assert.equal(accesses.length,1);
  const [wrong]=form('Alt text',id);
  await assert.rejects(call(base+'/turn',{body:wrong}),{status:409});
  const persisted=await (await call(base+'/messages?limit=1')).json();
  assert.equal(persisted.has_more,true);
  assert.equal(persisted.items[0].text,'Răspuns verificat');
  const older=await (await call(base+'/messages?before_ordinal='+persisted.items[0].ordinal)).json();
  assert.equal(older.items[0].id,id);
  assert.equal((await (await call(base)).json()).title,'Situația lunii');
  assert.equal((await (await call(base+'/submissions/'+id)).json()).state,'complete');

  const report=await events(await call(other+'/turn',{body:form('Raport franciză')[0]}));
  assert.ok(report.some(e=>e.type==='status'&&e.message.includes('Vodafone')));
  const reportFile=report.at(-1).message.attachments[0];
  assert.equal(reportFile.kind,'output');
  const reportPath=reportFile.download_url.split('/api/manager-ai/')[1];
  assert.equal(reportFile.has_report_card,true);
  assert.equal(reportFile.reportCard,undefined,'history metadata excludes the preview rows');
  const reportWire=await (await call(reportPath+'/report-card')).json();
  assert.equal(reportWire[0].version,'1.0');
  assert.equal(reportWire[0].createSurface.surfaceId,reportFile.id);
  assert.match(JSON.stringify(reportWire[1]),/FIX-42/);
  await assert.rejects(call(reportPath+'/report-card?agentId=another'),{status:403});
  await assert.rejects(call(reportPath+'/report-card',{token:'beta-token'}),{status:404});
  const reportDownload=await call(reportPath);
  assert.deepEqual(new Uint8Array(await reportDownload.arrayBuffer()).slice(0,2),new Uint8Array([80,75]));
  assert.equal((await (await call(reportPath,{method:'DELETE'})).json()).attachment.removed,true);
  await assert.rejects(call(reportPath),{status:410});
  await assert.rejects(call(reportPath+'/report-card'),{status:410});

  process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED='1';
  const analysisInputs=[];
  const analysisInputContent=[];
  const sandboxArtifact={
    kind:'output',filename:'synthetic-sandbox.csv',mime_type:'text/csv',bytes:new TextEncoder().encode('units\n7\n'),
  };
  globalThis.syntheticAnalysisTool=options=>{
    analysisInputs.push(options.files.map(item=>item.filename));
    analysisInputContent.push(options.files.map(item=>new TextDecoder().decode(item.bytes)));
    return {tables:['sales_lines'],instructions:'Synthetic SQL workspace',async run(value){
      assert.equal(value.tables[0].table,'sales_lines');
      assert.equal(value.language,'sql');
      await options.check();
      return {result:{units:7},artifacts:[sandboxArtifact]};
    }};
  };
  const sandboxConversation=await (await call('conversations',{body:{effort:'low'}})).json();
  const sandboxPath='conversations/'+sandboxConversation.id;
  const firstSandboxEvents=await events(await call(sandboxPath+'/turn',{body:form('Raport sandbox inițial',undefined,[
    new File(['units\n7'],'synthetic-data.csv',{type:'text/csv'}),
    new File(['units\n11'],'synthetic-data.csv',{type:'text/csv'}),
  ])[0]}));
  const firstSandbox=firstSandboxEvents.at(-1);
  const uploaded=firstSandboxEvents.find(event=>event.type==='user_message').message.attachments;
  assert.deepEqual(uploaded.map(item=>item.filename),['synthetic-data.csv','synthetic-data.csv']);
  const downloads=await Promise.all(uploaded.map(item=>call(item.download_url.split('/api/manager-ai/')[1])));
  assert.deepEqual(await Promise.all(downloads.map(response=>response.text())),['units\n7','units\n11']);
  assert.equal(firstSandbox.type,'complete');
  const sandboxDownload=firstSandbox.message.attachments[0].download_url.split('/api/manager-ai/')[1];
  assert.equal(await (await call(sandboxDownload)).text(),'units\n7\n');
  await assert.rejects(call(sandboxDownload,{token:'beta-token'}),{status:404});
  await events(await call(sandboxPath+'/turn',{body:form('Raport sandbox repetat')[0]}));
  await events(await call(sandboxPath+'/turn?agentId=synthetic-selection',{body:form('Raport sandbox alt portofoliu')[0]}));
  assert.deepEqual(analysisInputs,[
    ['synthetic-data.csv','synthetic-data.csv'],['synthetic-sandbox.csv','synthetic-data.csv','synthetic-data.csv'],[],
  ]);
  assert.deepEqual(analysisInputContent,[['units\n7','units\n11'],['units\n7\n','units\n7','units\n11'],[]]);
  delete process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED;
  delete globalThis.syntheticAnalysisTool;

  const [held,heldId]=form('așteaptă sfârșitul');
  const heldResponse=await call(base+'/turn',{body:held});
  const firstRead=heldResponse.body.getReader(),part=JSON.parse(new TextDecoder().decode((await firstRead.read()).value));
  await firstRead.cancel();
  assert.equal(part.type,'submission_status');
  const controls={run_id:part.run_id,attempt_id:part.attempt_id,control_id:randomUUID()};
  await waitFor(()=>pending.length===1);
  await assert.rejects(call(removablePath,{method:'DELETE'}),{status:409});
  const [concurrent]=form('Concurent');
  await assert.rejects(call(other+'/turn',{body:concurrent}),{status:409});
  await assert.rejects(call(other+'/stop',{body:controls}),{status:409});
  await assert.rejects(call(base+'/stop',{body:controls,token:'other-alpha-token'}),{status:409});
  await assert.rejects(call(base+'/stop',{body:{...controls,attempt_id:randomUUID()}}),{status:409});
  const resumed=await call(base+'/submissions/'+heldId+'/events?after='+part.sequence);
  const stopped=await (await call(base+'/stop',{body:controls})).json();
  assert.equal(stopped.state,'stopped');
  assert.equal(stopped.message.text,'Analiza a fost oprită.');
  assert.equal((await (await call(base+'/stop',{body:controls})).json()).message.id,stopped.message.id);
  const stoppedEvent=(await events(resumed)).at(-1);
  assert.equal(stoppedEvent.type,'stopped');
  assert.equal(stoppedEvent.message.id,stopped.message.id);
  const stoppedStatus=await (await call(base+'/submissions/'+heldId)).json();
  assert.equal(stoppedStatus.state,'stopped');
  assert.equal(stoppedStatus.terminal_message_id,stopped.message.id);
  pending.shift()();

  const [partInput,partId]=form('flux parțial vechi');
  const partStream=(await call(base+'/turn',{body:partInput})).body.getReader();
  const partRun=await nextEvent(partStream,'submission_status');
  assert.equal((await nextEvent(partStream,'delta')).text,oldPartial);
  await call(base+'/steer',{body:form('flux parțial nou')[0]});
  await nextEvent(partStream,'reset');
  assert.equal((await nextEvent(partStream,'delta')).text,newPartial);
  const partControls={run_id:partRun.run_id,attempt_id:partRun.attempt_id,control_id:randomUUID()};
  const stoppedPartial=await (await call(base+'/stop',{body:partControls})).json();
  assert.equal(stoppedPartial.message.status,'stopped');
  assert.equal(stoppedPartial.message.text,newPartial);
  assert.equal((await nextEvent(partStream,'stopped')).message.id,stoppedPartial.message.id);
  assert.equal((await partStream.read()).done,true);
  const reloaded=(await (await call(base+'/messages?limit=1')).json()).items[0];
  assert.deepEqual(reloaded,stoppedPartial.message);
  const partStatus=await (await call(base+'/submissions/'+partId)).json();
  assert.equal(partStatus.terminal_message_id,reloaded.id);

  await assert.rejects(call(removablePath,{method:'DELETE',token:'beta-token'}),{status:404});
  await assert.rejects(call(removablePath.replace(base,other),{method:'DELETE'}),{status:404});
  await assert.rejects(call(removablePath,{method:'DELETE',origin:'https://other.invalid'}),{status:403});
  // Exercise storage accounting without writing a real 100 MiB fixture.
  db.prepare('UPDATE manager_ai_artifacts SET size_bytes=? WHERE id=?').run(100*1024*1024,removable.id);
  const quotaInput=form('Atașament după eliberarea cotei',undefined,[new File(['date'],'nou.txt',{type:'text/plain'})])[0];
  await assert.rejects(call(base+'/turn',{body:quotaInput}),{status:413});
  const quotaReport=(await events(await call(other+'/turn',{body:form('Raport franciză')[0]}))).at(-1);
  assert.equal(quotaReport.type,'complete');
  assert.match(quotaReport.message.text,/Franciza FIX-42 are 3 bucăți.*Spațiul pentru fișiere AI este plin/s);
  assert.deepEqual(quotaReport.message.attachments,[]);
  const removal=await (await call(removablePath,{method:'DELETE'})).json();
  assert.deepEqual(removal,{ok:true,attachment:{...removable,removed:true}});
  assert.deepEqual(await (await call(removablePath,{method:'DELETE'})).json(),removal);
  assert.deepEqual(db.prepare('SELECT id FROM manager_ai_artifacts WHERE id=?').all(removable.id),[]);
  await assert.rejects(call(removablePath),{status:410});
  const replayedFiles=(await events(await call(base+'/submissions/'+id+'/events'))).find(event=>event.type==='user_message').message.attachments;
  assert.equal(replayedFiles[1].removed,true);
  assert.equal(replayedFiles[2].removed,undefined);
  assert.equal((await events(await call(base+'/turn',{body:quotaInput}))).at(-1).type,'complete');
  assert.match(JSON.stringify(accesses.at(-1)),/fragment-pastreaza/);
  assert.doesNotMatch(JSON.stringify(accesses.at(-1)),/fragment-sterge/);
  assert.doesNotMatch(JSON.stringify(accesses.at(-1)),/Redactarea după schimbare/);

  const [steered,steeredId]=form('așteaptă indicația următoare');
  steered.set('model','gpt-6.2-sol');
  const active=await call(base+'/turn',{body:steered});
  await waitFor(()=>pending.length===1);
  assert.deepEqual(providerOptions.at(-1),{model:'gpt-6.2-sol',effort:'low'});
  await assert.rejects(call(base+'/steer',{body:form('Schimbă modelul')[0]}),{status:409});
  const [unsupported]=form('Nu analiza');
  unsupported.delete('model');
  unsupported.set('effort','none');
  await assert.rejects(call(base+'/steer',{body:unsupported}),{status:400});
  const [steer,steerId]=form('așteaptă a doua indicație');
  steer.set('model','gpt-6.2-sol');
  steer.set('effort','high');
  const added=await (await call(base+'/steer',{body:steer})).json();
  assert.equal(added.message.id,steerId);
  const replayedSteer=await (await call(base+'/steer',{body:steer})).json();
  assert.equal(replayedSteer.message.id,steerId);
  await waitFor(()=>pending.length===2);
  assert.deepEqual(providerOptions.at(-1),{model:'gpt-6.2-sol',effort:'high'});
  const [keepEffort,lastSteerId]=form('Calculează pentru ultima lună.');
  keepEffort.delete('model');
  keepEffort.delete('effort');
  const lastSteer=await (await call(base+'/steer',{body:keepEffort})).json();
  assert.equal(lastSteer.message.id,lastSteerId);
  const joined=await events(active);
  assert.equal(joined.filter(e=>e.type==='reset').length,2);
  assert.equal(joined.at(-1).type,'complete');
  assert.equal(accesses.at(-1).at(-1).content,'Calculează pentru ultima lună.');
  assert.deepEqual(providerOptions.at(-1),{model:'gpt-6.2-sol',effort:'high'});
  const state=await (await call(base+'/submissions/'+steeredId)).json();
  assert.equal(state.state,'complete');
  assert.equal(state.processed_order_key,lastSteer.message.ordinal);
  for(const resolve of pending.splice(0))resolve();

  const [lost,lostId]=form('așteaptă revocarea');
  const revoked=await call(base+'/turn',{body:lost});
  await waitFor(()=>pending.length===1);
  db.prepare("DELETE FROM sessions WHERE user_id='alpha' AND token_hash<>?").run(digest('other-alpha-token'));
  pending.shift()();
  assert.equal((await events(revoked)).at(-1).type,'error');
  db.prepare('UPDATE manager_ai_runs SET expires_at=0 WHERE id=(SELECT run_id FROM manager_ai_submissions WHERE id=?)').run(lostId);
  assert.equal((await (await call(base+'/submissions/'+lostId,{token:'other-alpha-token'})).json()).state,'interrupted');
  db.exec("UPDATE users SET profile_revision=2 WHERE id='alpha';");
  assert.equal((await (await call(base,{token:'other-alpha-token'})).json()).id,first.id);
  db.exec('UPDATE portfolio_revision SET scope_revision=2 WHERE id=1;');
  globalThis.syntheticAiPortfolio={warehouseIds:['other-warehouse']};
  await assert.rejects(call(base,{token:'other-alpha-token'}),{status:404});
  await assert.rejects(call(artifactPath,{token:'other-alpha-token'}),{status:404});
  console.log('Manager AI chat: durable history, streaming, attachment ownership, resume, steering, stop, exact run identities and revoked sessions passed.');
} finally {
  globalThis.fetch=originalFetch;
  db.close();
  rmSync(directory,{recursive:true,force:true});
}
