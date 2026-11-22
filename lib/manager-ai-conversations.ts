import { createHash } from 'node:crypto';
import {reportCardMessages} from './manager-ai-report-card';
import { importAuthorization } from './import-write-authorization';
import { managerAiProviderKey } from './manager-ai-api';
import { defaultManagerAiModel, managerAiModels, managerAiNotConfiguredMessage, type ManagerAiModel } from './manager-ai';
import { managerAiEfforts, type ManagerAiChatEvent, type ManagerAiEffort } from './manager-ai-chat-contract';
import {
  aiRunEvent, aiRunInputs, aiSubmissionStatus, beginAiSubmission, createAiConversation, endAiRun,
  getAiArtifact, getAiReportCard, listAiConversations, listAiMessages, managerAiRunTimeoutMs, readAiConversation, readAiEvents, removeAiArtifact, stopAiRun, withAiAccount,
  type AiAccount,
} from './manager-ai-chat-store';
import { managerAiReader, managerAiScope, type AiScope } from './manager-ai-data';
import {
  managerAiArtifactResponse, managerAiMediaParts, managerAiTranscriptionKey, prepareManagerAiInputs,
  prepareManagerAiReport, transcribeManagerAi, type ManagerAiPreparedArtifact,
} from './manager-ai-media';
import { runtimeKind } from './runtime';
import { AppError, assertOrigin, db, fail, jsonBody, readLimited, requireManager, requireUser, response, sha256 } from './server';
import type { User } from './types';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const active=new Map<string,AbortController>();
const filters=['managerId','agentId'];
const encoder=new TextEncoder();

function identity(value:unknown) {
  if(typeof value!=='string'||!uuid.test(value))fail(400,'Identificatorul este invalid.');
  return value.toLowerCase();
}

function boundedNumber(params:URLSearchParams,key:string,fallback:number,min:number,max:number) {
  const values=params.getAll(key);
  if(!values.length)return fallback;
  const value=Number(values[0]);
  if(values.length!==1||!/^[0-9]+$/.test(values[0])||!Number.isSafeInteger(value)||value<min||value>max)fail(400,'Paginare invalidă.');
  return value;
}

function effort(value:unknown) {
  const selected=value??'low';
  if(!(managerAiEfforts as readonly unknown[]).includes(selected))fail(400,'Nivelul de analiză este invalid.');
  return selected as ManagerAiEffort;
}

async function scopeRevision() {
  const row=await db().prepare('SELECT scope_revision FROM portfolio_revision WHERE id=1').first<{scope_revision:number}>();
  if(!row)fail(503,'Portofoliul nu este disponibil.');
  return Number(row.scope_revision);
}

async function accountFor(req:Request,params=new URLSearchParams(),expected?:AiAccount) {
  const revision=await scopeRevision();
  const user=await requireUser(req);
  requireManager(user);
  const baseScope=await managerAiScope(user,new URLSearchParams());
  const selectedScope=params.size?await managerAiScope(user,params):baseScope;
  const account={auth:importAuthorization(req,user),owner:sha256(JSON.stringify([user.id,user.managerScope,baseScope.filter])),scopeRevision:revision};
  if(revision!==await scopeRevision()||expected&&(account.owner!==expected.owner||account.auth.profileVersion!==expected.auth.profileVersion))fail(409,'Accesul la portofoliu s-a modificat.');
  return {account,user,selectedScope};
}

function pageContext(value:FormDataEntryValue|null) {
  if(value===null)return '';
  if(typeof value!=='string'||value.length>4096)fail(400,'Contextul paginii este invalid.');
  let view:unknown;
  try {view=JSON.parse(value);}catch{fail(400,'Contextul paginii este invalid.');}
  if(view===null)return '';
  if(typeof view!=='object'||Array.isArray(view))fail(400,'Contextul paginii este invalid.');
  const candidate=view as Record<string,unknown>;
  const context:Record<string,string>={};
  if(typeof candidate.tab==='string'&&candidate.tab.length<=60&&/^[\p{L}\p{N} ._›-]+$/u.test(candidate.tab))context.tab=candidate.tab;
  const months=typeof candidate.period==='string'?candidate.period.split(',').map(month=>month.trim()):[];
  if(months.length&&months.length<=36&&months.every(month=>/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)))context.period=[...new Set(months)].join(', ');
  return Object.keys(context).length?JSON.stringify(context):'';
}

async function parseTurn(req:Request,mode:'turn'|'steer') {
  const contentType=req.headers.get('content-type')||'';
  if(!/^multipart\/form-data\s*;/i.test(contentType))fail(415,'Este necesară o cerere multipart.');
  const data=await readLimited(req,4*1024*1024);
  let form:FormData;
  try{form=await new Response(new Uint8Array(data),{headers:{'content-type':contentType}}).formData();}
  catch{fail(400,'Datele mesajului sunt invalide.');}
  for(const name of new Set(form.keys())) {
    if(name==='files')continue;
    if(!['text','model','effort','current_view','submission_id'].includes(name)||form.getAll(name).length!==1)fail(400,'Datele mesajului sunt invalide.');
  }
  const text=form.get('text')??'', uploads=form.getAll('files');
  if(typeof text!=='string'||text.length>4000||!text.trim()&&!uploads.length)fail(400,'Scrie un mesaj de maximum 4.000 de caractere sau atașează un fișier.');
  if(uploads.some(file=>typeof file==='string'))fail(400,'Atașamentele sunt invalide.');
  const requestedModel=form.get('model'),requestedEffort=form.get('effort');
  const selected=(requestedModel??(mode==='turn'?defaultManagerAiModel:null)) as ManagerAiModel|null;
  if(selected!==null&&!managerAiModels.includes(selected))fail(400,'Alege un model AI disponibil.');
  const reasoning=mode==='steer'&&requestedEffort===null?null:effort(requestedEffort);
  return {text:text.trim(),fileUploads:uploads as File[],view:pageContext(form.get('current_view')),
    id:identity(form.get('submission_id')),model:selected,effort:reasoning};
}

function signature(input:Awaited<ReturnType<typeof parseTurn>>,files:readonly ManagerAiPreparedArtifact[],scope:AiScope) {
  const checksum=createHash('sha256').update(JSON.stringify([input.text,input.model,input.effort,input.view,scope.signature,scope.params.toString()]));
  for(const file of files)checksum.update(JSON.stringify([file.filename,file.mime_type,file.bytes.byteLength])).update(file.bytes);
  return checksum.digest('hex');
}

function conversationTxn<T>(account:AiAccount,id:string,write:boolean,action:Parameters<typeof withAiAccount<T>>[2]) {
  return withAiAccount(account,write,connection=>{
    readAiConversation(connection,account.owner,id);
    return action(connection);
  });
}

function stream(req:Request,original:AiAccount,conversationId:string,submissionId:string,after:number) {
  let cancelled=false, timer:ReturnType<typeof setTimeout>|undefined;
  let wake:(()=>void)|undefined;
  const output=new ReadableStream<Uint8Array>({
    async start(controller){
      let cursor=after;
      let deliveredTerminal=false;
      let heartbeat=Date.now();
      const emit=(data:object)=>controller.enqueue(encoder.encode(JSON.stringify(data)+'\n'));
      try {
        while(!cancelled&&!req.signal.aborted) {
          if(controller.desiredSize!==null&&controller.desiredSize<=0) {
            await new Promise<void>(resolve=>{timer=setTimeout(resolve,100);wake=resolve;});
            continue;
          }
          const {account}=await accountFor(req,undefined,original);
          const {status,events,terminal}=conversationTxn(account,conversationId,false,connection=>readAiEvents(connection,conversationId,submissionId,cursor));
          if(cancelled||req.signal.aborted)break;
          if(events.length) {
            for(const {sequence,event} of events) {
              emit({...event,sequence});
              cursor=sequence;
              if(['complete','error','stopped'].includes(event.type))deliveredTerminal=true;
            }
            heartbeat=Date.now();
            continue;
          }
          if(status.run_state!=='running') {
            if(deliveredTerminal)break;
            emit({type:'submission_status',...status,sequence:cursor});
            if(status.run_state==='stopped')emit({type:'stopped',message:terminal,sequence:cursor});
            else if(terminal)emit(terminal.status==='complete'?{type:'complete',message:terminal,sequence:cursor}:{type:'error',message:terminal.text,sequence:cursor});
            else emit({type:'error',message:'Analiza s-a întrerupt.',sequence:cursor});
            break;
          }
          if(Date.now()-heartbeat>10_000){emit({type:'heartbeat',sequence:cursor});heartbeat=Date.now();}
          await new Promise<void>(resolve=>{timer=setTimeout(resolve,350);wake=resolve;});
        }
      } catch(error) {
        if(!cancelled)emit({type:'error',message:error instanceof AppError?error.message:'Fluxul analizei a fost întrerupt.',sequence:cursor});
      } finally {
        if(timer)clearTimeout(timer);
        wake=undefined;
        if(!cancelled)controller.close();
      }
    },
    cancel() {cancelled=true;if(timer)clearTimeout(timer);wake?.();},
  });
  return new Response(output,{headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store, no-transform',
    'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff'}});
}

async function processRun(req:Request,start:AiAccount,scope:AiScope,conversationId:string,runId:string,
  key:string) {
  const timeout=AbortSignal.timeout(managerAiRunTimeoutMs);
  const scopeKey=sha256(JSON.stringify([scope.signature,scope.params.toString()]));
  async function current() {
    const result=await accountFor(req,scope.params,start);
    if(sha256(JSON.stringify([result.selectedScope.signature,result.selectedScope.params.toString()]))!==scopeKey)fail(409,'Accesul la selecție s-a modificat.');
    return result;
  }
  try {
    const sandbox=process.env.MOBIUP_MANAGER_AI_SANDBOX_ENABLED==='1'?await import('./manager-ai-sandbox'):null;
    const analysisModule=sandbox?.managerAiSandboxAvailable()?await import('./manager-ai-analysis'):null;
    for (;;) {
      const attempt=new AbortController();
      active.set(runId,attempt);
      const signal=AbortSignal.any([attempt.signal,timeout]);
      const {account}=await current();
      const work=conversationTxn(account,conversationId,false,connection=>aiRunInputs(connection,account.owner,conversationId,runId,!!analysisModule));
      if(work.r.state!=='running')return;
      let text:string,files:ManagerAiPreparedArtifact[]=[],failed=false;
      try {
        if(!work.options)fail(409,'Setările analizei nu mai sunt disponibile. Trimite o analiză nouă.');
        const readSource=managerAiReader(req,scope,async()=>(await current()).user);
        const authorize=async()=>{
          signal.throwIfAborted();
          const {user}=await current();
          await readSource.checkSourceScope(user);
          signal.throwIfAborted();
          return user;
        };
        const analysis=analysisModule?.createManagerAiAnalysis({scope,check:authorize,signal,files:work.sandboxFiles,readSource});
        const {runManagerAi}=await import('#mobiup-manager-ai-provider');
        const answer=await runManagerAi({
          key,...work.options,turns:[],signal,readSource,check:authorize,analysis,
          content:work.recent.map(turn=>{
            if(turn.role==='assistant')return {role:'assistant',content:turn.content};
            const attachments=managerAiMediaParts(work.files.filter(file=>file.ordinal===turn.ordinal).map(file=>file.file));
            const content=[turn.content,turn.context].filter(Boolean).join('\n\n');
            return {role:'user',content:attachments.length?[{type:'input_text',text:content||'Analizează fișierele atașate.'},...attachments]:content};
          }),
          async onEvent(event:ManagerAiChatEvent) {
            await authorize();
            const {account}=await current();
            if(!conversationTxn(account,conversationId,true,connection=>aiRunEvent(connection,runId,work.order,event)))attempt.abort();
          },
        });
        text=answer.answer;
        const format=/\bcsv\b/i.test(work.recent.at(-1)?.content??'')?'csv':'xlsx';
        files=[...(answer.analysisArtifacts??[]),...answer.reports.map(report=>prepareManagerAiReport(report,format))];
      } catch(error) {
        failed=true;
        text=timeout.aborted?'Analiza a depășit timpul disponibil. Încearcă o cerere mai restrânsă.':
          error instanceof AppError?error.message:'Furnizorul AI nu este accesibil momentan.';
      }
      const {account:finalAccount}=await current();
      let complete;
      try {
        complete=conversationTxn(finalAccount,conversationId,true,connection=>endAiRun(connection,finalAccount.owner,conversationId,runId,work.order,{text,files,failed}));
      } catch(error) {
        if(!(error instanceof AppError))throw error;
        const noExportSpace=error.status===413&&!failed&&files.length>0;
        const savedText=noExportSpace?text+'\n\nSpațiul pentru fișiere AI este plin. Eliberează spațiu și cere din nou exportul.':error.message;
        complete=conversationTxn(finalAccount,conversationId,true,connection=>endAiRun(connection,finalAccount.owner,conversationId,runId,work.order,
          {text:savedText,files:[],failed:!noExportSpace}));
      }
      if(complete!=='retry')return;
    }
  } catch(error) {
    // A lost authorization must never persist model results or report files.
    // The independent durable lease marks the run interrupted.
    if(!(error instanceof AppError))console.error('Manager AI run could not finish.');
  } finally {
    active.delete(runId);
  }
}

export async function managerAiConversations(req:Request,user:User,path:string[]) {
  requireManager(user);
  if(runtimeKind!=='node')fail(503,'Asistentul AI este indisponibil pe această instanță.');
  const params=new URL(req.url).searchParams,key=managerAiProviderKey(),method=req.method;
  if(method==='POST'||method==='DELETE')assertOrigin(req);
  const selected=new URLSearchParams([...params].filter(([field])=>filters.includes(field)));
  const {account,selectedScope}=await accountFor(req,selected);
  if(path[0]==='transcribe'&&path.length===1&&method==='POST') {
    const speechKey=managerAiTranscriptionKey();
    if(!speechKey)fail(503,'Dictarea AI este indisponibilă pe această instanță.');
    return response(await transcribeManagerAi(req,{key:speechKey,check:()=>accountFor(req,undefined,account)}));
  }
  if(path[0]!=='conversations')fail(404,'Funcția AI nu a fost găsită.');
  if(path.length===1&&method==='GET') {
    const limit=boundedNumber(params,'limit',30,1,100),offset=boundedNumber(params,'offset',0,0,Number.MAX_SAFE_INTEGER);
    return response({items:withAiAccount(account,false,db=>listAiConversations(db,account.owner,limit,offset))});
  }
  if(path.length===1&&method==='POST') {
    if(!key)fail(503,managerAiNotConfiguredMessage);
    const reasoning=effort((await jsonBody(req)).effort);
    return response(withAiAccount(account,true,db=>createAiConversation(db,account.owner,reasoning)),201);
  }
  const conversationId=identity(path[1]);
  const transact=<T>(write:boolean,action:Parameters<typeof withAiAccount<T>>[2])=>conversationTxn(account,conversationId,write,action);
  if(path.length===2&&method==='GET')return response(withAiAccount(account,false,db=>readAiConversation(db,account.owner,conversationId)));
  if(path.length===3&&path[2]==='messages'&&method==='GET') {
    const limit=boundedNumber(params,'limit',30,1,200),before=boundedNumber(params,'before_ordinal',Number.MAX_SAFE_INTEGER,1,Number.MAX_SAFE_INTEGER);
    return response(transact(false,db=>listAiMessages(db,conversationId,limit,before)));
  }
  if(path[2]==='artifacts'&&path[4]==='report-card'&&path.length===5&&method==='GET') {
    const id=identity(path[3]);
    const scopeKey=sha256(JSON.stringify([selectedScope.signature,selectedScope.params.toString()]));
    const card=transact(false,db=>getAiReportCard(db,account.owner,conversationId,id,scopeKey));
    return response(reportCardMessages(id,card));
  }
  if(path[2]==='artifacts'&&path.length===4&&(method==='GET'||method==='DELETE')) {
    const artifactId=identity(path[3]);
    if(method==='DELETE')return response({ok:true,attachment:transact(true,db=>removeAiArtifact(db,account.owner,conversationId,artifactId))});
    return managerAiArtifactResponse(transact(false,db=>getAiArtifact(db,account.owner,conversationId,artifactId)));
  }
  if(path.length===3&&method==='POST'&&(path[2]==='turn'||path[2]==='steer')) {
    if(!key)fail(503,managerAiNotConfiguredMessage);
    transact(false,()=>true);
    const mode=path[2];
    const input=await parseTurn(req,mode);
    const prepared=await prepareManagerAiInputs(input.fileUploads);
    const {account:validated,selectedScope:scope}=await accountFor(req,selected,account);
    if(scope.signature!==selectedScope.signature)fail(409,'Accesul la selecție s-a modificat.');
    const scopeKey=sha256(JSON.stringify([scope.signature,scope.params.toString()]));
    const context=[input.view&&'Pagina din Comenzi la trimiterea mesajului: '+input.view,prepared.context].filter(Boolean).join('\n\n');
    const result=conversationTxn(validated,conversationId,true,db=>beginAiSubmission(db,validated,conversationId,mode,{
      id:input.id,digest:signature(input,prepared.files,scope),text:input.text,context,scopeKey,files:prepared.files,model:input.model,effort:input.effort,
    }));
    if(mode==='steer'){
      if(result.created)active.get(result.status.run_id!)?.abort();
      return response({accepted:true,message:result.message,state:result.status.state});
    }
    if(result.created)void processRun(req,validated,scope,conversationId,result.status.run_id!,key);
    return stream(req,validated,conversationId,input.id,0);
  }
  if(path[2]==='submissions'&&(path.length===4||path.length===5&&path[4]==='events')&&method==='GET') {
    const id=identity(path[3]),status=transact(false,db=>aiSubmissionStatus(db,conversationId,id));
    if(path.length===4)return response(status);
    if(status.state==='unseen')fail(404,'Analiza nu a fost găsită.');
    return stream(req,account,conversationId,id,boundedNumber(params,'after',0,0,Number.MAX_SAFE_INTEGER));
  }
  if(path.length===3&&path[2]==='stop'&&method==='POST') {
    const body=await jsonBody(req),runId=identity(body.run_id),attemptId=identity(body.attempt_id),controlId=identity(body.control_id);
    const {account:validated}=await accountFor(req,undefined,account);
    const result=conversationTxn(validated,conversationId,true,db=>stopAiRun(db,validated,conversationId,runId,attemptId,controlId));
    active.get(runId)?.abort();
    return response({ok:true,...result,run_id:runId,attempt_id:attemptId,control_id:controlId});
  }
  fail(404,'Funcția AI nu a fost găsită.');
}
