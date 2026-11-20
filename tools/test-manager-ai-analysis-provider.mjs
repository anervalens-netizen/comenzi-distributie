import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { read, utils, write } from 'xlsx';

const bundle=await build({
  stdin:{resolveDir:process.cwd(),contents:`
    export * from './lib/manager-ai-provider.ts';
    export * from './lib/manager-ai-analysis-tool.ts';
    export * from './lib/manager-ai-sandbox-artifacts.ts';
  `},
  bundle:true,platform:'node',format:'esm',write:false,
  plugins:[{name:'synthetic-errors',setup(plugin){
    plugin.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));
    plugin.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
      export class AppError extends Error {
        constructor(status,message){super(message);this.status=status;}
      }
      export function fail(status,message){throw new AppError(status,message);}
      export async function readLimited(){throw Error('Unexpected request body read');}
    `}));
  }}],
});
const {runManagerAi,parseManagerAiAnalysis,normalizeManagerAiSandboxArtifact}=await import(
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
console.log('PASS: scoped SQL/Python tool contract, provider fencing, CSV formula protection and Excel values-only downloads.');
