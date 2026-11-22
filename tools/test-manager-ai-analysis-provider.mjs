import {managerAiTestSdk} from './manager-ai-test-sdk.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { read, utils, write } from 'xlsx';

const bundle=await build({
  stdin:{resolveDir:process.cwd(),contents:`
    export * from './lib/manager-ai-provider.ts';
    export * from './lib/manager-ai-analysis-tool.ts';
    export * from './lib/manager-ai-analysis.ts';
    export * from './lib/manager-ai-sandbox-artifacts.ts';
  `},
  bundle:true,platform:'node',format:'esm',write:false,
  plugins:[managerAiTestSdk,{name:'synthetic-errors',setup(plugin){
    plugin.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));
    plugin.onLoad({filter:/^server$/,namespace:'fixture'},()=>({contents:`
      import {createHash} from 'node:crypto';
      export class AppError extends Error {
        constructor(status,message){super(message);this.status=status;}
      }
      export function fail(status,message){throw new AppError(status,message);}
      export function sha256(value){return createHash('sha256').update(value).digest('hex');}
      export const db=()=>({prepare:()=>({bind:()=>({all:async()=>({results:[]})}),first:async()=>null})});
      export async function readLimited(){throw Error('Unexpected request body read');}
    `}));
    plugin.onResolve({filter:/^\.\/(manager-ai-sandbox|manager-ai-analysis-data|manager-ai-analysis-database)$/},
      args=>({path:args.path.slice(2),namespace:'fixture'}));
    const mocks={
      'manager-ai-sandbox':'export const runManagerAiSandbox=request=>globalThis.syntheticAnalysisSandbox(request);',
      'manager-ai-analysis-data':'export const readManagerAiAnalysisTable=(...args)=>globalThis.syntheticAnalysisTable(...args);',
      'manager-ai-analysis-database':'export const materializeManagerAiDatabase=()=>Uint8Array.of(1);',
    };
    plugin.onLoad({filter:/^manager-ai-/,namespace:'fixture'},args=>({contents:mocks[args.path]}));
  }}],
});
const {runManagerAi,parseManagerAiAnalysis,createManagerAiAnalysis,normalizeManagerAiSandboxArtifact}=await import(
  'data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));

const request={
  language:'sql',code:'SELECT COUNT(*) FROM sales_lines',tables:[{table:'sales_lines',fromMonth:'2026-07',toMonth:'2026-08'}],
  files:['synthetic.csv'],
};
const tables=['sales_lines','activation_detail'];
assert.deepEqual(parseManagerAiAnalysis(JSON.stringify(request),tables),request);
for(const invalid of [
  {...request,tables:[request.tables[0],request.tables[0]]},
  {...request,tables:[{...request.tables[0],table:'users'}]},
  {...request,tables:[{...request.tables[0],fromMonth:'2026-13'}]},
  {...request,tables:[{...request.tables[0],toMonth:'2026-06'}]},
  {...request,files:['../synthetic.csv']},
  {...request,filesystem:'/'},
  {...request,code:' '},
])assert.throws(()=>parseManagerAiAnalysis(JSON.stringify(invalid),tables),{status:400});

const output={
  kind:'output',filename:'synthetic.csv',mime_type:'text/csv',
  bytes:new TextEncoder().encode('label,amount\n"=1+1",7\n"simple, label","-private fixture"\n'),
};
const normalized=normalizeManagerAiSandboxArtifact(output);
assert(normalized);
const text=new TextDecoder().decode(normalized.bytes);
assert(text.includes('"\'=1+1"'));
assert(text.includes('"\'-private fixture"'));
assert(text.includes('"simple, label"'));

const book=utils.book_new();
const sheet=utils.aoa_to_sheet([['Label','Value'],['Synthetic',2]]);
sheet.B2.f='1+1';
sheet.A2.l={Target:'https://fixture.invalid/'};
utils.book_append_sheet(book,sheet,'Report');
const safeBook=normalizeManagerAiSandboxArtifact({...output,filename:'synthetic.xlsx',
  mime_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  bytes:new Uint8Array(write(book,{type:'array',bookType:'xlsx',compression:true})),
});
assert(safeBook);
const repaired=read(safeBook.bytes,{type:'array'}).Sheets.Report;
assert.equal(repaired.B2.v,2);
assert.equal(repaired.B2.f,undefined);
assert.equal(repaired.A2.l,undefined);
assert.equal(normalizeManagerAiSandboxArtifact({...output,filename:'synthetic.html'}),null);

for(const revoked of [false,true]){
  const calls=[];
  const model='gpt-6.1-terra';
  let delivered=false;
  const promise=runManagerAi({
    key:'synthetic-key',model,turns:[{role:'user',content:'Raport sintetic'}],
    signal:new AbortController().signal,
    async check(){if(delivered&&revoked)throw Error('Access revoked');},
    async readSource(){throw Error('Unexpected legacy report');},
    analysis:{tables,instructions:'SQLite and Python instructions',async run(value){
      assert.deepEqual(value,request);
      delivered=true;
      return {result:{value:7,exported:[{filename:normalized.filename}]},artifacts:[normalized]};
    }},
    async send(_url,options){
      const body=JSON.parse(options.body);
      assert.equal(body.store,false);
      assert.equal(body.parallel_tool_calls,false);
      assert.deepEqual(body.tools.map(tool=>tool.name),['read_report','run_analysis']);
      calls.push(body);
      const answer=calls.length===1?[{type:'function_call',name:'run_analysis',call_id:'fixture',
        arguments:JSON.stringify(request)}]:[
        {type:'message',role:'assistant',content:[{type:'output_text',text:'Raport sintetic: 7.'}]},
      ];
      return Response.json({model,status:'completed',output:answer});
    },
  });
  if(revoked){
    await assert.rejects(promise,/Access revoked/);
    assert.equal(calls.length,1,'revoked report data never reaches the provider');
  }else{
    const result=await promise;
    assert.equal(calls.length,2);
    const toolOutput=JSON.parse(calls[1].input.at(-1).output);
    assert.equal(toolOutput.value,7);
    assert.equal(Object.hasOwn(toolOutput.exported[0],'bytes'),false);
    assert.equal(result.analysisArtifacts[0].filename,'synthetic.csv');
    assert.equal(result.analysisArtifacts[0].bytes.byteLength,normalized.bytes.byteLength);
  }
}
const encode=value=>new TextEncoder().encode(value);
const upload=(name,value)=>({filename:name,mime_type:'text/csv',bytes:encode(value),kind:'input'});
const files=[upload('daily.csv','first'),upload('daily.csv','second'),upload('daily (2).csv','literal suffix')];
const selections=[];
globalThis.syntheticAnalysisSandbox=({inputs})=>{
  selections.push(inputs.map(file=>[file.filename,new TextDecoder().decode(file.bytes)]));
  return {exitCode:0,stdout:'',stderr:'',artifacts:selections.length===1?[{...upload('daily.csv','generated'),kind:'output'}]:[]};
};
try{
  const analysis=createManagerAiAnalysis({scope:{},check:async()=>{},signal:new AbortController().signal,files});
  assert(analysis.instructions.includes('["daily.csv","daily (3).csv","daily (2).csv"]'));
  const run=names=>analysis.run(parseManagerAiAnalysis(JSON.stringify({language:'python',code:'print("synthetic")',
    tables:[],files:names}),analysis.tables));
  const result=await run(['daily (3).csv','daily.csv','daily (2).csv']);
  assert.deepEqual(result.result.files,['daily.csv','daily (3).csv','daily (2).csv','daily (4).csv']);
  assert.deepEqual(result.result.exported,[{filename:'daily.csv',selectionName:'daily (4).csv',bytes:9}]);
  assert.equal(result.artifacts[0].filename,'daily.csv');
  await run(['daily.csv','daily (4).csv']);
  assert.deepEqual(selections,[
    [['daily (3).csv','second'],['daily.csv','first'],['daily (2).csv','literal suffix']],
    [['daily.csv','first'],['daily (4).csv','generated']],
  ]);
  assert.deepEqual(files.map(file=>file.filename),['daily.csv','daily.csv','daily (2).csv']);
}finally{
  delete globalThis.syntheticAnalysisSandbox;
}
const activationRoot=mkdtempSync(join(tmpdir(),'comenzi-analysis-revision-'));
const priorActivationRoot=process.env.MOBIUP_ACTIVATIONS_DIR;
try{
  process.env.MOBIUP_ACTIVATIONS_DIR=activationRoot;
  const projection=join(activationRoot,'activation-report.sqlite');
  writeFileSync(projection,'synthetic version one');
  let executions=0;
  globalThis.syntheticAnalysisSandbox=()=>{
    executions++;
    return {exitCode:0,stdout:'',stderr:'',artifacts:[]};
  };
  const capability=createManagerAiAnalysis({scope:{},check:async()=>{},signal:new AbortController().signal,files:[]});
  const activationRequest={...request,files:[],tables:[{table:'activation_detail',fromMonth:'2026-07',toMonth:'2026-08'}]};
  globalThis.syntheticAnalysisTable=async()=>({table:'activation_detail',rows:[],coverage:[]});
  await capability.run(activationRequest);
  globalThis.syntheticAnalysisTable=async()=>{
    writeFileSync(projection,'synthetic version two with different size');
    return {table:'activation_detail',rows:[],coverage:[]};
  };
  await assert.rejects(capability.run(activationRequest),{status:409});
  assert.equal(executions,1,'a changed analytical source must never reach the sandbox');
  const priorData=process.env.MOBIUP_DATA_DIR;
  const catalog=new DatabaseSync(join(activationRoot,'mobiup.sqlite'));
  try {
    process.env.MOBIUP_DATA_DIR=activationRoot;
    catalog.exec(`CREATE TABLE users(id,role,site_code,warehouse_id,active); CREATE TABLE customers(id,warehouse_id,active,data);
      CREATE TABLE orders(id,number,user_id,warehouse_id,finalized_at,payload,kind,status);
      CREATE TABLE crm_companies(partner_id,partner_code,cif,name);
      INSERT INTO crm_companies VALUES ('a','a','000','Synthetic');`);
    const requestSim0={...activationRequest,tables:[{table:'activation_sim0_clients',fromMonth:'2026-01',toMonth:'2026-06'}]};
    globalThis.syntheticAnalysisTable=async()=>({table:'activation_sim0_clients',rows:[],coverage:[]});
    globalThis.syntheticAnalysisSandbox=()=>{
      catalog.exec("UPDATE crm_companies SET name='Synthetic rename'");
      return {exitCode:0,stdout:'',stderr:'',artifacts:[]};
    };
    await assert.rejects(capability.run(requestSim0),{status:409});
  } finally {
    catalog.close();
    if (priorData===undefined) delete process.env.MOBIUP_DATA_DIR; else process.env.MOBIUP_DATA_DIR=priorData;
  }
}finally{
  if(priorActivationRoot===undefined)delete process.env.MOBIUP_ACTIVATIONS_DIR;
  else process.env.MOBIUP_ACTIVATIONS_DIR=priorActivationRoot;
  delete globalThis.syntheticAnalysisTable;
  delete globalThis.syntheticAnalysisSandbox;
  rmSync(activationRoot,{recursive:true,force:true});
}
console.log('PASS: scoped SQL/Python tool contract, provider fencing, CSV formula protection and Excel values-only downloads.');
