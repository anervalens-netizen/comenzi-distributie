import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { assertManagerSession, type ImportAuthorization } from './import-write-authorization';
import { managerAiInputContextLead, type ManagerAiPreparedArtifact } from './manager-ai-media';
import { managerAiAttachmentLimits } from './manager-ai-media-contract';
import { defaultManagerAiModel, type ManagerAiModel } from './manager-ai';
import type {
  ManagerAiArtifact, ManagerAiChatEvent, ManagerAiChatMessage, ManagerAiConversation,
  ManagerAiEffort, ManagerAiRunState, ManagerAiSubmissionStatus,
} from './manager-ai-chat-contract';
import {parsePresentation, type ManagerPresentation} from './manager-ai-presentation';
import {AppError, fail} from './server';

export type AiAccount = { auth:ImportAuthorization; owner:string; scopeRevision:number };
type Run = {
  id:string; attempt_id:string; scope_key:string; token_hash:string; state:ManagerAiRunState;
  processed_order_key:number|null; terminal_message_id:string|null; control_id:string|null;
};
type Submission = {
  id:string; order_key:number; mode:'turn'|'steer'; message_id:string; digest:string; context:string;
  run_id:string;
};
type RunOptions = { model:ManagerAiModel; effort:ManagerAiEffort };
type Submit = {
  id:string; digest:string; text:string; context:string; scopeKey:string; files:readonly ManagerAiPreparedArtifact[];
  model:ManagerAiModel|null; effort:ManagerAiEffort|null;
};
type MessageRow = Omit<ManagerAiChatMessage,'attachments' | 'has_presentation'> & {attachments:string; has_presentation?:number};
const messageFields = 'id,ordinal,role,text,status,created_at,attachments, EXISTS(SELECT 1 FROM manager_ai_presentations p WHERE p.message_id=manager_ai_messages.id) has_presentation';
const leaseGraceMs=10_000;
export const managerAiRunTimeoutMs=180_000;
const maxMessages=500;
const maxGlobalRuns=4;
const ownerArtifactLimit=100*1024*1024;
const globalArtifactLimit=512*1024*1024;

export function withAiAccount<T>(account:AiAccount, write:boolean, action:(connection:DatabaseSync)=>T) {
  const connection=new DatabaseSync(resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data','mobiup.sqlite'));
  try {
    connection.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    connection.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    assertManagerSession(connection,account.auth);
    const scope=connection.prepare('SELECT scope_revision FROM portfolio_revision WHERE id=1').get();
    if (scope?.scope_revision!==account.scopeRevision) fail(409,'Portofoliul s-a modificat. Reîncearcă.');
    const value=action(connection);
    connection.exec('COMMIT');
    return value;
  } finally {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    connection.close();
  }
}

const now=()=>new Date().toISOString();
function one<T>(db:DatabaseSync,sql:string,...args:SQLInputValue[]) {
  return db.prepare(sql).get(...args) as T|undefined;
}
function many<T>(db:DatabaseSync,sql:string,...args:SQLInputValue[]) {
  return db.prepare(sql).all(...args) as T[];
}
function run(db:DatabaseSync,sql:string,...args:SQLInputValue[]) {
  return db.prepare(sql).run(...args);
}

export function readAiConversation(db:DatabaseSync,owner:string,id:string) {
  const item=one<ManagerAiConversation>(db,'SELECT id,title,effort,created_at,updated_at FROM manager_ai_conversations WHERE id=? AND owner=?',id,owner);
  if (!item) fail(404,'Conversația nu a fost găsită.');
  return item;
}

export function listAiConversations(db:DatabaseSync,owner:string,limit:number,offset:number) {
  return many<ManagerAiConversation>(db,'SELECT id,title,effort,created_at,updated_at FROM manager_ai_conversations WHERE owner=? ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?',owner,limit,offset);
}

export function createAiConversation(db:DatabaseSync,owner:string,effort:ManagerAiEffort) {
  // The caller holds BEGIN IMMEDIATE. Concurrent creates share the same admission checks.
  const time=now();
  const cutoff=new Date(Date.now()-30*24*60*60*1000).toISOString();
  // Reclaim abandoned drafts only. Preserve every conversation containing user work.
  run(db,`DELETE FROM manager_ai_conversations WHERE id IN (
    SELECT c.id FROM manager_ai_conversations c WHERE c.updated_at<? AND c.title='Sesiune nouă'
    AND NOT EXISTS (SELECT 1 FROM manager_ai_messages m WHERE m.conversation_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM manager_ai_runs r WHERE r.conversation_id=c.id)
    AND NOT EXISTS (SELECT 1 FROM manager_ai_artifacts a WHERE a.conversation_id=c.id)
    ORDER BY c.updated_at LIMIT 64)`,cutoff);
  const recent=new Date(Date.now()-60_000).toISOString();
  const usage=one<{total:number; recent:number}>(db,`SELECT count(*) total,
    count(CASE WHEN created_at>=? THEN 1 END) recent FROM manager_ai_conversations WHERE owner=?`,recent,owner)!;
  if(usage.recent>=12)return new AppError(429,'Ai creat mai multe conversații într-un minut. Reîncearcă peste un minut.');
  if(usage.total>=1000)return new AppError(409,'Spațiul disponibil pentru conversațiile acestui cont este plin.');
  if(one<{total:number}>(db,'SELECT count(*) total FROM manager_ai_conversations')!.total>=10000)
    return new AppError(503,'Spațiul disponibil pentru conversații este plin.');
  const id=randomUUID();
  run(db,'INSERT INTO manager_ai_conversations VALUES(?,?,?,?,?,?)',id,owner,'Sesiune nouă',effort,time,time);
  return readAiConversation(db,owner,id);
}

function nativeMedia(file:{mime_type:string}) {
  return file.mime_type==='application/pdf'||file.mime_type.startsWith('image/');
}

type StoredAttachment = ManagerAiArtifact & {reportCard?: import('./manager-ai-report-card').ReportCardData};

function publicAttachment({reportCard,...metadata}:StoredAttachment):ManagerAiArtifact {
  return reportCard && !metadata.removed ? {...metadata,has_report_card:true} : metadata;
}

function message(row:MessageRow):ManagerAiChatMessage {
  const {has_presentation, ...fields} = row;
  return {...fields,...(has_presentation ? {has_presentation:true as const} : {}),attachments:(JSON.parse(row.attachments) as StoredAttachment[]).map(publicAttachment)};
}

export function listAiMessages(db:DatabaseSync,id:string,limit:number,before:number) {
  const rows=many<MessageRow>(db,'SELECT '+messageFields+' FROM manager_ai_messages WHERE conversation_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?',id,before,limit+1);
  return {items:rows.slice(0,limit).reverse().map(message),has_more:rows.length>limit};
}

function addEvent(db:DatabaseSync,runId:string,event:ManagerAiChatEvent) {
  run(db,'INSERT INTO manager_ai_events SELECT ?,COALESCE(MAX(sequence),0)+1,? FROM manager_ai_events WHERE run_id=?',runId,JSON.stringify(event),runId);
}

function insertArtifacts(db:DatabaseSync,owner:string,conversationId:string,files:readonly ManagerAiPreparedArtifact[]):StoredAttachment[] {
  if(!files.length)return [];
  const bytes=files.reduce((sum,file)=>sum+file.bytes.byteLength,0);
  const ownerTotal=one<{total:number}>(db,'SELECT COALESCE(SUM(size_bytes),0) total FROM manager_ai_artifacts WHERE owner=?',owner)!.total;
  const globalTotal=one<{total:number}>(db,'SELECT COALESCE(SUM(size_bytes),0) total FROM manager_ai_artifacts')!.total;
  if(ownerTotal+bytes>ownerArtifactLimit||globalTotal+bytes>globalArtifactLimit) fail(413,'Spațiul disponibil pentru fișiere AI este plin.');
  const time=now();
  return files.map(file=>{
    const id=randomUUID();
    run(db,'INSERT INTO manager_ai_artifacts VALUES(?,?,?,?,?,?,?,?,?)',id,conversationId,owner,file.filename,file.mime_type,file.kind,file.bytes.byteLength,file.bytes,time);
    return {id,...(file.reportCard?{reportCard:file.reportCard}:{}),filename:file.filename,mime_type:file.mime_type,kind:file.kind,size_bytes:file.bytes.byteLength,created_at:time,
      download_url:`/api/manager-ai/conversations/${conversationId}/artifacts/${id}`};
  });
}

export function getAiArtifact(db:DatabaseSync,owner:string,conversationId:string,id:string) {
  const item=one<Pick<ManagerAiPreparedArtifact,'filename'|'mime_type'|'bytes'>>(db,'SELECT filename,mime_type,bytes FROM manager_ai_artifacts WHERE id=? AND conversation_id=? AND owner=?',id,conversationId,owner);
  if(!item) {
    const link=findAiArtifactLink(db,owner,conversationId,id);
    if(link&&link.artifacts[link.position].removed)fail(410,'Fișierul a fost șters.');
    fail(404,'Fișierul nu a fost găsit.');
  }
  return item;
}

function findAiArtifactLink(db:DatabaseSync,owner:string,conversationId:string,id:string) {
  const link=one<{id:string;attachments:string;position:number}>(db,`SELECT m.id,m.attachments,a.key position
    FROM manager_ai_conversations AS c JOIN manager_ai_messages AS m ON m.conversation_id=c.id
    JOIN json_each(m.attachments) AS a
    WHERE c.id=? AND c.owner=? AND json_extract(a.value,'$.id')=?`,conversationId,owner,id);
  return link&&{id:link.id,position:link.position,artifacts:JSON.parse(link.attachments) as StoredAttachment[]};
}

export function getAiReportCard(db:DatabaseSync,owner:string,conversationId:string,id:string,scopeKey:string) {
  const link=findAiArtifactLink(db,owner,conversationId,id);
  const entry=link?.artifacts[link.position];
  if(entry?.removed)fail(410,'Fișierul a fost șters.');
  if(!link||entry?.kind!=='output'||!entry.reportCard)fail(404,'Fișa raportului nu este disponibilă.');
  const result=one<{scope_key:string}>(db,'SELECT scope_key FROM manager_ai_runs WHERE conversation_id=? AND terminal_message_id=?',conversationId,link.id);
  if(result?.scope_key!==scopeKey)fail(403,'Deschide fișa în selecția în care a fost generat raportul.');
  return entry.reportCard;
}

export function getAiPresentation(db:DatabaseSync, owner:string, conversationId:string, id:string, scopeKey:string) {
  const row=one<{body:string;scope_key:string}>(db,`SELECT p.body,r.scope_key
    FROM manager_ai_presentations p JOIN manager_ai_messages m ON m.id=p.message_id
    JOIN manager_ai_conversations c ON c.id=m.conversation_id
    JOIN manager_ai_runs r ON r.conversation_id=c.id AND r.terminal_message_id=m.id
    WHERE p.message_id=? AND c.id=? AND c.owner=?`,id,conversationId,owner);
  if(!row) fail(404,'Fișa nu a fost găsită.');
  if(row.scope_key!==scopeKey) fail(403,'Deschide fișa în selecția în care a fost creată.');
  const data=parsePresentation(row.body);
  if(!data) fail(422,'Fișa nu mai este disponibilă.');
  return data;
}

function removeAiInputExcerpt(db:DatabaseSync,messageId:string,artifacts:ManagerAiArtifact[],id:string) {
  const submission=one<{context:string}>(db,'SELECT context FROM manager_ai_submissions WHERE message_id=?',messageId);
  if(!submission)return;
  const context=submission.context,start=context.indexOf(managerAiInputContextLead+'\n');
  if(start<0)return;
  const inputFiles=artifacts.filter(file=>file.kind==='input'&&!file.removed&&!nativeMedia(file));
  const excerptIndex=inputFiles.findIndex(file=>file.id===id);
  if(excerptIndex<0)return;
  const excerpts=context.slice(start+managerAiInputContextLead.length+1).split('\n');
  const remaining=excerpts.length===inputFiles.length?excerpts.filter((_,index)=>index!==excerptIndex):[];
  const inherited=context.slice(0,start).trimEnd();
  const updated=[inherited,remaining.length&&managerAiInputContextLead+'\n'+remaining.join('\n')].filter(Boolean).join('\n\n');
  run(db,'UPDATE manager_ai_submissions SET context=? WHERE message_id=?',updated,messageId);
}

export function removeAiArtifact(db:DatabaseSync,owner:string,conversationId:string,id:string) {
  const link=findAiArtifactLink(db,owner,conversationId,id);
  if(!link)fail(404,'Fișierul nu a fost găsit.');
  const existing=link.artifacts[link.position];
  if(existing.removed)return existing;
  // Follow-up analysis can still use input files from earlier turns in the conversation.
  if(existing.kind==='input'&&one(db,"SELECT 1 FROM manager_ai_runs WHERE conversation_id=? AND state='running' AND expires_at>?",conversationId,Date.now())) {
    fail(409,'Oprește analiza din această sesiune înainte de a șterge fișierele de intrare.');
  }
  if(existing.kind==='input'&&!nativeMedia(existing))removeAiInputExcerpt(db,link.id,link.artifacts,id);
  const {reportCard:_reportCard,...metadata}=existing;
  const removed={...metadata,removed:true as const};
  link.artifacts[link.position]=removed;
  run(db,'DELETE FROM manager_ai_artifacts WHERE id=? AND conversation_id=? AND owner=?',id,conversationId,owner);
  run(db,'UPDATE manager_ai_messages SET attachments=? WHERE id=?',JSON.stringify(link.artifacts),link.id);
  return removed;
}

function addMessage(db:DatabaseSync,owner:string,conversationId:string,role:'user'|'assistant',text:string,files:readonly ManagerAiPreparedArtifact[],status:ManagerAiChatMessage['status']='complete',id:string=randomUUID()) {
  const ordinal=one<{ordinal:number}>(db,'SELECT COALESCE(MAX(ordinal),0)+1 ordinal FROM manager_ai_messages WHERE conversation_id=?',conversationId)!.ordinal;
  if(ordinal>maxMessages) fail(409,'Conversația a atins limita de mesaje.');
  const created_at=now(),attachments=insertArtifacts(db,owner,conversationId,files);
  run(db,'INSERT INTO manager_ai_messages VALUES(?,?,?,?,?,?,?,?)',id,conversationId,ordinal,role,text,status,created_at,JSON.stringify(attachments));
  run(db,'UPDATE manager_ai_conversations SET updated_at=? WHERE id=?',created_at,conversationId);
  return {id,ordinal,role,text,status,created_at,attachments:attachments.map(publicAttachment)};
}

function getRun(db:DatabaseSync,id:string) {
  const row=one<Run&{expires_at:number}>(db,'SELECT * FROM manager_ai_runs WHERE id=?',id);
  if(!row) fail(404,'Analiza nu a fost găsită.');
  return row.state==='running'&&row.expires_at<=Date.now()?{...row,state:'interrupted' as const}:row;
}

function getSubmission(db:DatabaseSync,conversationId:string,id:string) {
  return one<Submission>(db,'SELECT * FROM manager_ai_submissions WHERE conversation_id=? AND id=?',conversationId,id);
}

function getRunOptions(db:DatabaseSync,runId:string) {
  return one<RunOptions>(db,'SELECT model,effort FROM manager_ai_run_options WHERE run_id=?',runId);
}

function validateRunEffort(model:ManagerAiModel,effort:ManagerAiEffort) {
  if(model==='gpt-6.2-sol'&&effort==='none')fail(400,'Sol 6.2 necesită un nivel de analiză de cel puțin low.');
}

function submissionStatus(id:string,r?:Run,submission?:Submission):ManagerAiSubmissionStatus {
  return {
    submission_id:id,state:r?.state??'unseen', mode:submission?.mode??null,order_key:submission?.order_key??null,
    run_id:r?.id??null,attempt_id:r?.attempt_id??null,run_state:r?.state??null,
    processed_order_key:r?.processed_order_key??null,terminal_message_id:r?.terminal_message_id??null,
  };
}

export function aiSubmissionStatus(db:DatabaseSync,conversationId:string,id:string) {
  const submission=getSubmission(db,conversationId,id);
  return submissionStatus(id,submission&&getRun(db,submission.run_id),submission);
}

export function expireAiRuns(db:DatabaseSync) {
  const time=Date.now();
  run(db,"UPDATE manager_ai_runs SET state='interrupted' WHERE state='running' AND expires_at<=?",time);
  // Durable messages remain available after short-lived stream fragments are discarded.
  run(db,"DELETE FROM manager_ai_events WHERE run_id IN(SELECT id FROM manager_ai_runs WHERE expires_at<=?)",time-30*60*1000);
}

export function beginAiSubmission(db:DatabaseSync,account:AiAccount,conversationId:string,mode:'turn'|'steer',input:Submit) {
  expireAiRuns(db);
  const previous=getSubmission(db,conversationId,input.id);
  if(previous) {
    if(previous.digest!==input.digest||previous.mode!==mode) fail(409,'Identificatorul trimiterii este folosit de alt mesaj.');
    const existing=one<MessageRow>(db,'SELECT '+messageFields+' FROM manager_ai_messages WHERE id=?',previous.message_id)!;
    return {created:false,message:message(existing),status:submissionStatus(input.id,getRun(db,previous.run_id),previous)};
  }
  if(one(db,'SELECT id FROM manager_ai_messages WHERE id=?',input.id))fail(409,'Identificatorul trimiterii este folosit de alt mesaj.');
  const active=one<Run>(db,"SELECT * FROM manager_ai_runs WHERE conversation_id=? AND state='running'",conversationId);
  const last=one<{ordinal:number}>(db,'SELECT COALESCE(MAX(ordinal),0) ordinal FROM manager_ai_messages WHERE conversation_id=?',conversationId)!.ordinal;
  if(last>=maxMessages-1) fail(409,'Conversația a atins limita de mesaje.');
  let runId=active?.id;
  let effectiveEffort=input.effort??'low';
  if(mode==='turn') {
    const model=input.model??defaultManagerAiModel;
    validateRunEffort(model,effectiveEffort);
    if(one(db,"SELECT id FROM manager_ai_runs WHERE account_id=? AND state='running'",account.auth.userId)) fail(409,'O analiză este deja în curs pentru contul tău.');
    if(one<{total:number}>(db,"SELECT COUNT(*) total FROM manager_ai_runs WHERE state='running'")!.total>=maxGlobalRuns) fail(503,'Toate sesiunile AI sunt ocupate.');
    runId=randomUUID();
    run(db,'INSERT INTO manager_ai_runs(id,attempt_id,conversation_id,account_id,scope_key,token_hash,state,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      runId,randomUUID(),conversationId,account.auth.userId,input.scopeKey,account.auth.tokenHash,'running',Date.now()+managerAiRunTimeoutMs+leaseGraceMs);
    run(db,'INSERT INTO manager_ai_run_options(run_id,model,effort) VALUES(?,?,?)',runId,model,effectiveEffort);
  } else {
    if(!active||active.scope_key!==input.scopeKey||active.token_hash!==account.auth.tokenHash) fail(409,'Nu există o analiză activă în această sesiune și selecție.');
    const options=getRunOptions(db,active.id);
    if(!options) fail(409,'Această analiză a pornit într-o versiune anterioară. Trimite o analiză nouă pentru a schimba nivelul de analiză.');
    if(input.model&&options.model!==input.model)fail(409,'Păstrează modelul analizei active pentru a trimite o instrucțiune suplimentară.');
    effectiveEffort=input.effort??options.effort;
    validateRunEffort(options.model,effectiveEffort);
    if(one<{total:number}>(db,'SELECT COUNT(*) total FROM manager_ai_submissions WHERE run_id=?',active.id)!.total>=8) fail(409,'Analiza are prea multe instrucțiuni suplimentare.');
    if(input.files.some(nativeMedia)) {
      const used=one<{bytes:number;files:number}>(db,`SELECT COALESCE(SUM(a.size_bytes),0) bytes,COUNT(*) files
        FROM manager_ai_submissions s JOIN manager_ai_messages m ON m.id=s.message_id
        JOIN json_each(m.attachments) AS attachment JOIN manager_ai_artifacts a ON a.id=json_extract(attachment.value,'$.id')
        WHERE s.run_id=? AND (a.mime_type='application/pdf' OR a.mime_type LIKE 'image/%')`,active.id)!;
      const media=input.files.filter(nativeMedia);
      if(used.bytes+media.reduce((sum,file)=>sum+file.bytes.byteLength,0)>managerAiAttachmentLimits.maxTotalBytes||
        used.files+media.length>managerAiAttachmentLimits.maxFiles)fail(413,'Fișierele din întreaga analiză depășesc limita admisă.');
    }
    run(db,'UPDATE manager_ai_run_options SET effort=? WHERE run_id=?',effectiveEffort,active.id);
  }
  const userMessage=addMessage(db,account.owner,conversationId,'user',input.text,input.files,'complete',input.id);
  run(db,'INSERT INTO manager_ai_submissions VALUES(?,?,?,?,?,?,?,?)',input.id,conversationId,runId!,userMessage.id,userMessage.ordinal,mode,input.digest,input.context);
  if (last===0) run(db,'UPDATE manager_ai_conversations SET title=?,effort=? WHERE id=?',input.text.replace(/\s+/g,' ').slice(0,64)||input.files[0]?.filename||'Sesiune nouă',effectiveEffort,conversationId);
  const status=aiSubmissionStatus(db,conversationId,input.id);
  addEvent(db,runId!,{type:'submission_status',...status});
  addEvent(db,runId!,{type:'user_message',message:userMessage});
  if(mode==='steer') addEvent(db,runId!,{type:'reset'});
  return {created:true,message:userMessage,status};
}

function collectSandboxFiles(db:DatabaseSync,owner:string,conversationId:string,scopeKey:string,messages:ManagerAiChatMessage[]) {
  const {maxFiles,maxTotalBytes}=managerAiAttachmentLimits;
  const artifactIds=new Set<string>(),files:ManagerAiPreparedArtifact[]=[];
  let total=0;
  for(const message of messages.toReversed()){
    if(!message.attachments.length)continue;
    const run=one<{scope_key:string}>(db,`
      SELECT r.scope_key FROM manager_ai_submissions s JOIN manager_ai_runs r ON r.id=s.run_id
      WHERE s.message_id=? AND r.conversation_id=?
      UNION ALL
      SELECT scope_key FROM manager_ai_runs WHERE terminal_message_id=? AND conversation_id=?
    `,message.id,conversationId,message.id,conversationId);
    if(run?.scope_key!==scopeKey)continue;
    for(const entry of message.attachments){
      if(files.length>=maxFiles)return files;
      if(entry.removed||total+entry.size_bytes>maxTotalBytes||artifactIds.has(entry.id))continue;
      const file=getAiArtifact(db,owner,conversationId,entry.id);
      files.push({...file,kind:'input'});
      artifactIds.add(entry.id);
      total+=file.bytes.byteLength;
    }
  }
  return files;
}

export function aiRunInputs(db:DatabaseSync,owner:string,conversationId:string,runId:string,includeSandboxFiles=false) {
  const r=getRun(db,runId);
  const messages=listAiMessages(db,conversationId,24,Number.MAX_SAFE_INTEGER).items.filter(m=>m.status==='complete');
  const recent=messages.map(m=>{
    const input=one<{context:string}>(db,'SELECT context FROM manager_ai_submissions WHERE message_id=?',m.id);
    return {role:m.role,content:m.text,context:input?.context||'',ordinal:m.ordinal,attachments:m.attachments};
  });
  const current=one<{ord:number}>(db,'SELECT MIN(order_key) ord FROM manager_ai_submissions WHERE run_id=?',runId)!.ord;
  const files:{ordinal:number;file:ManagerAiPreparedArtifact}[]=[];
  let bytes=0;
  // Prefer current-turn attachments, then preserve recent image/PDF context
  // for follow-up questions within the same authorized conversation.
  const newestFirst=recent.toReversed();
  const ordered=[...newestFirst.filter(m=>m.ordinal>=current),...newestFirst.filter(m=>m.ordinal<current)];
  for(const m of ordered) for(const attachment of m.attachments) {
    if(attachment.kind!=='input'||attachment.removed||!nativeMedia(attachment)||files.length>=managerAiAttachmentLimits.maxFiles||
      bytes+attachment.size_bytes>managerAiAttachmentLimits.maxTotalBytes)continue;
    bytes+=attachment.size_bytes;
    files.push({ordinal:m.ordinal,file:{...getAiArtifact(db,owner,conversationId,attachment.id),kind:'input'}});
  }
  const order=one<{ord:number}>(db,'SELECT MAX(order_key) ord FROM manager_ai_submissions WHERE run_id=?',runId)!.ord;
  const sandboxFiles=includeSandboxFiles?collectSandboxFiles(db,owner,conversationId,r.scope_key,messages):[];
  return {r,recent,order,files,sandboxFiles,options:getRunOptions(db,runId)};
}

export function aiRunEvent(db:DatabaseSync,runId:string,order:number,event:ManagerAiChatEvent) {
  const r=getRun(db,runId);
  const latest=one<{ord:number}>(db,'SELECT MAX(order_key) ord FROM manager_ai_submissions WHERE run_id=?',runId)!.ord;
  if(r.state!=='running'||latest!==order) return false;
  addEvent(db,runId,event);
  return true;
}

export function endAiRun(db:DatabaseSync,owner:string,conversationId:string,runId:string,order:number,result:{text:string;files:readonly ManagerAiPreparedArtifact[];failed:boolean;presentation?:ManagerPresentation}) {
  const r=getRun(db,runId);
  const latest=one<{ord:number}>(db,'SELECT MAX(order_key) ord FROM manager_ai_submissions WHERE run_id=?',runId)!.ord;
  if(r.state!=='running'||latest!==order) return r.state==='running'?'retry':'closed';
  let terminal:ManagerAiChatMessage|undefined;
  try {
    db.exec('SAVEPOINT ai_terminal');
    terminal=addMessage(db,owner,conversationId,'assistant',result.text,result.files,result.failed?'error':'complete');
    if (result.presentation && !result.failed) {
      run(db,'INSERT INTO manager_ai_presentations(message_id,body) VALUES(?,?)',terminal.id,JSON.stringify(result.presentation));
      terminal.has_presentation=true;
    }
    db.exec('RELEASE ai_terminal');
  } catch(error) {
    db.exec('ROLLBACK TO ai_terminal; RELEASE ai_terminal');
    throw error;
  }
  run(db,'UPDATE manager_ai_runs SET state=?,processed_order_key=?,terminal_message_id=? WHERE id=?',
    result.failed?'error':'complete',order,terminal.id,runId);
  addEvent(db,runId,result.failed?{type:'error',message:terminal.text}:{type:'complete',message:terminal});
  return 'closed';
}

export function stopAiRun(db:DatabaseSync,account:AiAccount,conversationId:string,runId:string,attemptId:string,controlId:string) {
  const r=getRun(db,runId);
  if(!one(db,'SELECT id FROM manager_ai_runs WHERE id=? AND conversation_id=?',runId,conversationId)||r.attempt_id!==attemptId||r.token_hash!==account.auth.tokenHash) fail(409,'Sesiunea sau analiza s-a modificat.');
  if(r.control_id===controlId) {
    const terminal=r.terminal_message_id&&readAiMessage(db,conversationId,r.terminal_message_id);
    return {state:r.state,message:terminal||undefined};
  }
  if(r.state!=='running') fail(409,'Analiza nu mai rulează.');
  const partial=many<{text:string}>(db,`SELECT json_extract(data,'$.text') text FROM manager_ai_events
    WHERE run_id=? AND sequence>(SELECT COALESCE(MAX(sequence),0) FROM manager_ai_events WHERE run_id=? AND json_extract(data,'$.type')='reset')
    AND json_extract(data,'$.type')='delta' ORDER BY sequence`,runId,runId).map(event=>event.text).join('');
  const terminal=addMessage(db,account.owner,conversationId,'assistant',partial.trim()?partial:'Analiza a fost oprită.',[],'stopped');
  run(db,"UPDATE manager_ai_runs SET state='stopped',control_id=?,terminal_message_id=? WHERE id=?",controlId,terminal.id,runId);
  addEvent(db,runId,{type:'stopped',message:terminal});
  return {state:'stopped' as const,message:terminal};
}

function readAiMessage(db:DatabaseSync,conversationId:string,id:string) {
  const row=one<MessageRow>(db,'SELECT '+messageFields+' FROM manager_ai_messages WHERE conversation_id=? AND id=?',conversationId,id);
  return row&&message(row);
}

export function readAiEvents(db:DatabaseSync,conversationId:string,id:string,after:number) {
  const status=aiSubmissionStatus(db,conversationId,id);
  if(!status.run_id) fail(404,'Analiza nu a fost găsită.');
  const events=many<{sequence:number;data:string}>(db,'SELECT sequence,data FROM manager_ai_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 32',status.run_id,after).map(({sequence,data})=>{
    const event=JSON.parse(data) as ManagerAiChatEvent;
    if((event.type==='user_message'||event.type==='complete')&&event.message.attachments.length) {
      // Historical deliveries keep their sequence and use the current file availability.
      event.message=readAiMessage(db,conversationId,event.message.id)??event.message;
    }
    return {sequence,event};
  });
  const terminal=status.terminal_message_id?readAiMessage(db,conversationId,status.terminal_message_id):undefined;
  return {status,events,terminal};
}
