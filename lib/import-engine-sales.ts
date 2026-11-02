import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {salesUpload} from './sales-server';
import {stockUpload} from './stock-server';
import {userView} from './server';
import type {ImportAuthorization} from './import-write-authorization';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1024*1024)throw Error('Input too large');}
const request=JSON.parse(input),job=request.job,actionId=request.action_id,root=resolve(process.env.MOBIUP_DATA_DIR||'');
let mutationPossible=false;
async function run(){
 if(!process.env.MOBIUP_DATA_DIR||!uuid.test(job.id)||!uuid.test(actionId))throw Error('Invalid operation');
 const stock=job.kind==='stock_tr';if(!stock&&job.kind!=='sales_agent')throw Error('Unsupported kind');
 if(request.mode==='reconcile'){
  if(request.action==='preview')return {state:'not_committed'};
  const db=new DatabaseSync(join(root,stock?'mobiup.sqlite':'sales.sqlite'),{readOnly:true});
  try{const row=db.prepare(`SELECT value FROM ${stock?'settings':'sales_meta'} WHERE key=?`).get('import_action_receipt:'+actionId);if(!row)return {state:'uncertain',error:{code:'reconciliation_required',message:'Rezultatul necesită verificare; importul nu a fost reluat.'}};const receipt=JSON.parse(String(row.value));if(receipt.verified!==true||receipt.source_sha256!==job.source.sha256)return {state:'uncertain',error:{code:'receipt_mismatch',message:'Dovada importului necesită verificare.'}};return {state:'completed',receipt,result:receipt.result};}finally{db.close();}
 }
 const filename=String(job.source.filename);const ext=filename.toLowerCase().endsWith('.xlsx')?'.xlsx':filename.toLowerCase().endsWith('.xls')?'.xls':'';if(!ext)throw Error('Invalid extension');
 const folder=join(root,'import-engine-spool',job.id),folderStat=await lstat(folder),path=join(folder,'source'+ext),stat=await lstat(path);
 if(!folderStat.isDirectory()||folderStat.isSymbolicLink()||!stat.isFile()||stat.isSymbolicLink()||stat.size!==job.source.size||stat.size>8_000_000)throw Error('Invalid source');
 const bytes=await readFile(path);if(createHash('sha256').update(bytes).digest('hex')!==job.source.sha256)throw Error('Source hash mismatch');
 const db=new DatabaseSync(join(root,'mobiup.sqlite'),{readOnly:true});let row:Record<string,unknown>|undefined;try{row=db.prepare('SELECT * FROM users WHERE id=?').get(job.actor.id) as Record<string,unknown>|undefined;}finally{db.close();}if(!row)throw Error('Account unavailable');
 const user=userView(row),auth=(request.action==='commit'?job.payload?.commit_authorization:job.payload?.preview_authorization||job.payload?.authorization) as ImportAuthorization;
 if(!auth||auth.userId!==user.id||auth.userId!==job.actor.id)throw Error('Invalid authorization');
 const source=job.source,preview=job.preview||{},options=job.options||{};
 const headers:Record<string,string>=stock?{'X-Stock-Filename':encodeURIComponent(filename)}:{'X-Sales-Filename':encodeURIComponent(filename)};
 if(stock){
  if(options.mappings)headers['X-Stock-Mappings']=JSON.stringify(options.mappings);
  if(options.coverage)headers['X-Stock-Coverage']=JSON.stringify(options.coverage);
  if(request.action==='commit')Object.assign(headers,{'X-Stock-Version':String(preview.version),'X-Stock-Hash':String(preview.fileHash),'X-Stock-Confirmation':String(preview.confirmation)});
 }else if(request.action==='commit')Object.assign(headers,{'X-Sales-Revision':String(preview.revision),'X-Sales-Hash':String(preview.fileHash),'X-Sales-Mapping-Hash':String(preview.mappingHash),'X-Sales-Allow-Historical':options.allowHistorical===true?'1':'0','X-Sales-Allow-Regression':options.allowRegression===true?'1':'0'});
 if(!['preview','commit'].includes(request.action))throw Error('Invalid action');
 const req=new Request('http://localhost/internal-sales',{method:'POST',headers,body:bytes});
 const internal={authorization:auth,action:{id:actionId,actor:job.actor,period:{start:source.date_start,end:source.date_end}},onMutationStart:()=>{mutationPossible=true;}};
 const res=stock?await stockUpload(req,user,request.action==='commit',internal):await salesUpload(req,user,request.action==='commit',internal);
 const output=await res.json() as Record<string,unknown>&{receipt?:{verified?:boolean}};
 if(request.action==='preview')return {state:'ready',preview:output};
 if(!output.receipt?.verified)throw Error('Missing sales receipt');
 const {receipt,...result}=output;return {state:'completed',receipt,result};
}
try{process.stdout.write(JSON.stringify(await run())+'\n');}catch(error){
 const preview=request?.mode==='execute'&&request?.action==='preview';
 const rejected=request?.mode==='execute'&&!mutationPossible;
 process.stderr.write((error instanceof Error?error.message:'Import error')+'\n');
 process.stdout.write(JSON.stringify({state:preview||rejected?'failed':'uncertain',error:{code:preview||rejected?'validation_failed':'execution_uncertain',message:preview||rejected?'Fișierul, perioada sau drepturile nu au putut fi validate.':'Rezultatul necesită verificare; importul nu a fost reluat.'}})+'\n');
}
