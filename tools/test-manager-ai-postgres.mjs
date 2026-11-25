import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync,chmodSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {managerAiTestSdk} from './manager-ai-test-sdk.mjs';

const {outputFiles}=await build({stdin:{resolveDir:process.cwd(),contents:`
 export * from './lib/manager-ai-postgres.ts';
 export {runManagerAi} from './lib/manager-ai-provider-node.ts';
 export {defaultManagerAiModel} from './lib/manager-ai.ts';
`},bundle:true,platform:'node',format:'esm',write:false,plugins:[managerAiTestSdk,{name:'isolated-auth',setup(build){
 build.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'test'}));
 build.onLoad({filter:/^server$/,namespace:'test'},()=>({contents:`export class AppError extends Error{constructor(status,message){super(message);this.status=status;}} export function fail(status,message){throw new AppError(status,message);}`}));
}}]});
const {createManagerAiPostgres,managerAiPostgresAvailable,runManagerAi,defaultManagerAiModel}=await import('data:text/javascript;base64,'+Buffer.from(outputFiles[0].text).toString('base64'));
const root=mkdtempSync(join(tmpdir(),'postgres-agent-test-'));
const path=join(root,'snapshot.json'),secret='SHOULD_NOT_BE_RETURNED';
const owner={id:'operator',role:'manager',managerScope:'global',active:1};
let current={...owner};
const signal=new AbortController().signal;
const check=async()=>current;
const options={check,signal,selectedPortfolio:false};
const envKeys=['MOBIUP_MANAGER_AI_POSTGRES_SNAPSHOT','MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS','MOBIUP_MANAGER_AI_POSTGRES_INSTANCES'];
const previous=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const target={database:'sample',status:'ok',container_version:'PostgreSQL 18.6',container:'/private',
 inventory:{version:'18.6',database_bytes:123,settings:{io_workers:'3',private_path:secret}},
 capabilities:{server_version_num:180006,features:{repack_progress:false,lock_statistics:false}},
 sections:{locks:{status:'unsupported',reason:'server_version'},replication:{status:'ok',visibility:'restricted'},health:{status:'ok'}},
 health:{database:'sample',transactions_committed:3,sql:secret,conninfo:secret},
 diagnostics:{query_metrics:[{queryid:'17',calls:9,total_exec_time:4,query:secret}],locks:null,replication:[],
 progress_repack:null,compatibility:{invalid_indexes:0,stored_tsvector_columns:3},
 semantics:{tuple_counts:'estimates'}},
 maintenance:[{schemaname:'public',relname:'synthetic',dead_estimate:5,query:secret}],
 rates:{database:{status:'ok',interval_seconds:300,values:{transactions_committed_per_second:2}}}};
const snapshot=()=>({schema_version:2,collector_version:'0.2.0',collected_at:new Date().toISOString(),
 host:secret,instances:{primary:structuredClone(target),excluded:{database:secret}},
 preflight:{ready:false,checks:[{check:'full_restore',status:'unverified',detail:secret}],version_policy:{checked_at:'2026-11-24',latest_verified:{18:'18.7',19:'19.0'},knowledge_stale:false}},
 backup_evidence:{primary:{status:'ok',restore_verified:false,archive_basename:secret}},storage:secret});
const put=(value=snapshot())=>writeFileSync(path,JSON.stringify(value));
let count=0;
async function verifies(label,fn){await fn();count++;console.log('PASS '+label);}
try{
 for(const key of envKeys)delete process.env[key];
 await verifies('disabled without operator configuration',async()=>assert.equal(await createManagerAiPostgres(options),undefined));
 process.env.MOBIUP_MANAGER_AI_POSTGRES_SNAPSHOT=path;
 process.env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS='operator';
 process.env.MOBIUP_MANAGER_AI_POSTGRES_INSTANCES='primary';
 put();
 await verifies('ordinary and service accounts cannot discover tools',async()=>{
  for(const user of [{...owner,id:'other-global'},{...owner,id:'service-account'},{...owner,managerScope:'assigned'},{...owner,role:'agent'},{...owner,active:0}]){
   current=user;assert.equal(managerAiPostgresAvailable(user,false),false);assert.equal(await createManagerAiPostgres(options),undefined);
  }
  current={...owner};
 });
 await verifies('portfolio selection excludes infrastructure tools',async()=>assert.equal(await createManagerAiPostgres({...options,selectedPortfolio:true}),undefined));
 const cap=await createManagerAiPostgres(options);assert.ok(cap);
 await verifies('exactly four strict fixed tools with configured instances',async()=>{
  assert.deepEqual(cap.tools.map(t=>t.name),['pg_fleet_inventory','pg_instance_health','pg_maintenance_candidates','pg_upgrade_preflight']);
  assert.deepEqual(cap.tools[1].parameters.properties.instance.enum,['primary']);
  assert.ok(cap.tools.every(t=>t.parameters.additionalProperties===false));
 });
 await verifies('current inventory excludes unknown fields and other instances',async()=>{
  const r=await cap.run('pg_fleet_inventory','{}');assert.equal(r.stale,false);assert.equal(r.instances.primary.inventory.version,'18.6');assert.equal(r.instances.excluded,undefined);assert.ok(!JSON.stringify(r).includes(secret));
 });
 await verifies('health preserves unavailable and visibility semantics without SQL',async()=>{
  const r=await cap.run('pg_instance_health','{"instance":"primary"}');
  assert.equal(r.sections.locks.status,'unsupported');assert.equal(r.sections.replication.visibility,'restricted');
  assert.equal(r.diagnostics.locks,null);assert.equal(r.rates.database.interval_seconds,300);assert.equal(r.diagnostics.query_metrics[0].queryid,'17');assert.ok(!JSON.stringify(r).includes(secret));
 });
 await verifies('maintenance estimates remain distinct from executed work',async()=>{
  const r=await cap.run('pg_maintenance_candidates','{"instance":"primary"}');assert.equal(r.maintenance[0].dead_estimate,5);assert.equal(r.capabilities.features.repack_progress,false);assert.ok(!JSON.stringify(r).includes(secret));
 });
 await verifies('preflight preserves current SQLite and unselected target',async()=>{
  const r=await cap.run('pg_upgrade_preflight','{}');assert.equal(r.application.current_database_engine,'sqlite');assert.equal(r.application.target_instance,null);assert.equal(r.execution_authorized,false);assert.equal(r.backups.primary.restore_verified,false);assert.ok(!JSON.stringify(r).includes(secret));
 });
 await verifies('optional restore receipts retain qualification limits and scope',async()=>{
  const s=snapshot();s.qualification_evidence={schema_version:1,instances:{primary:{status:'passed',completed_at:new Date().toISOString(),target_version:'19.0',database_count:2,globals_from_original_archive:true,cleanup_completed:true,production_database_writes:false,authentication:[{application:'synthetic',correct_password:true,wrong_password_rejected:true,read_only_query:true}],matches_latest_backup:false,age_hours:1,stale:false,application_workflows_verified:false,production_replica_transition_verified:false,path:secret},excluded:{status:secret}}};
  put(s);const r=await cap.run('pg_upgrade_preflight','{}');assert.equal(r.qualification_evidence.instances.primary.authentication[0].wrong_password_rejected,true);assert.equal(r.qualification_evidence.instances.primary.matches_latest_backup,false);assert.equal(r.qualification_evidence.instances.primary.application_workflows_verified,false);assert.equal(r.qualification_evidence.instances.excluded,undefined);assert.equal(r.execution_authorized,false);assert.ok(!JSON.stringify(r).includes(secret));put();
 });

 await verifies('shared memory evidence survives inventory and health without peak claims',async()=>{
  const s=snapshot();s.collector_version='0.2.2';
  const memory={configured_bytes:67108864,capacity_bytes:67108864,used_bytes:9437184,available_bytes:57671680,used_percent:14.062,df_reported_percent:15,observed_at:new Date().toISOString(),scope:'instantaneous container sample',peak_usage_verified:false,configuration_source:'fixed container configuration',usage_source:'fixed container usage',review_thresholds:{small_configured_bytes_at_or_below:67108864,used_percent_at_or_above:90},configuration_status:{status:'ok'},usage_status:{status:'ok'},configured_capacity_matches_mount:true,private_path:secret};
  s.instances.primary.diagnostics.shared_memory=memory;s.instances.primary.sections.shared_memory={status:'ok',configuration_status:'ok',usage_status:'ok',peak_usage_verified:false};put(s);
  const health=await cap.run('pg_instance_health','{"instance":"primary"}');
  assert.equal(health.diagnostics.shared_memory.configured_bytes,67108864);assert.equal(health.diagnostics.shared_memory.used_percent,14.062);assert.equal(health.diagnostics.shared_memory.peak_usage_verified,false);assert.equal(health.sections.shared_memory.status,'ok');assert.equal(health.diagnostics.shared_memory.review_thresholds.used_percent_at_or_above,90);
  for(const name of ['pg_fleet_inventory','pg_upgrade_preflight']){const value=await cap.run(name,'{}');assert.equal(value.instances.primary.shared_memory.available_bytes,57671680);assert.ok(!JSON.stringify(value).includes(secret));}
  assert.ok(!JSON.stringify(health).includes(secret));put();
 });
 await verifies('partial shared memory retains unknown capacity and failure evidence',async()=>{
  const s=snapshot();s.instances.primary.diagnostics.shared_memory={configuration_status:{status:'permission_denied'},usage_status:{status:'ok'},used_bytes:1,peak_usage_verified:false};s.instances.primary.sections.shared_memory={status:'partial',configuration_status:'permission_denied',usage_status:'ok',peak_usage_verified:false};put(s);
  const value=await cap.run('pg_instance_health','{"instance":"primary"}');assert.equal(value.sections.shared_memory.status,'partial');assert.equal(value.diagnostics.shared_memory.configuration_status.status,'permission_denied');assert.equal(value.diagnostics.shared_memory.configured_bytes,undefined);put();
 });
 await verifies('backup scheduler operations remain separate and bounded to known fields',async()=>{
  const s=snapshot();s.backup_schedulers={managed_full:{service:{unit:'example-pg-backup.service',status:'ok',operation_state:'last_attempt_succeeded',fields:{LoadState:'loaded',ActiveState:'inactive',Result:'success',ExecMainStatus:'0',ExecStart:secret},raw_state:secret},timer:{unit:'example-pg-backup.timer',status:'ok',operation_state:'scheduled',fields:{ActiveState:'active',NextElapseUSecRealtime:'next sample'}},receipt_keys:{latest_attempt:'full_cluster_attempt',last_success:'full_cluster'},restore_verified:false,meaning:'managed PostgreSQL backup',private:secret},legacy_nightly:{service:{status:'ok',operation_state:'last_attempt_failed',fields:{ActiveState:'failed',Result:'exit-code',ExecMainStatus:'1'}},timer:{status:'ok',operation_state:'scheduled'},restore_verified:false},other:{status:secret}};
  put(s);for(const name of ['pg_fleet_inventory','pg_upgrade_preflight']){const value=await cap.run(name,'{}');assert.equal(value.backup_schedulers.managed_full.service.operation_state,'last_attempt_succeeded');assert.equal(value.backup_schedulers.legacy_nightly.service.operation_state,'last_attempt_failed');assert.equal(value.backup_schedulers.managed_full.service.fields.ExecMainStatus,'0');assert.equal(value.backup_schedulers.managed_full.receipt_keys.latest_attempt,'full_cluster_attempt');assert.equal(value.backup_schedulers.managed_full.restore_verified,false);assert.equal(value.backup_schedulers.other,undefined);assert.ok(!JSON.stringify(value).includes(secret));}put();
 });
 await verifies('zero estimates retain missing evidence instead of implying empty tables',async()=>{
  const s=snapshot();s.instances.primary.maintenance=[{relname:'synthetic',heap_bytes:40960,live_estimate:0,dead_estimate:0,last_analyze:null,last_autoanalyze:null,tuple_estimate_evidence:{status:'unverified',reason:'allocated_heap_zero_estimates_without_analyze_evidence',exact_row_count_verified:false,private:secret}}];s.instances.primary.sections.maintenance={status:'ok',unverified_tuple_estimate_rows:1};put(s);
  const value=await cap.run('pg_maintenance_candidates','{"instance":"primary"}');assert.equal(value.sections.maintenance.unverified_tuple_estimate_rows,1);assert.equal(value.maintenance[0].tuple_estimate_evidence.status,'unverified');assert.equal(value.maintenance[0].tuple_estimate_evidence.exact_row_count_verified,false);assert.equal(value.maintenance[0].last_analyze,null);assert.ok(!JSON.stringify(value).includes(secret));put();
 });
 await verifies('invalid restore receipts preserve validation and proof scope',async()=>{
  const s=snapshot();s.qualification_evidence={schema_version:1,instances:{primary:{status:'invalid_receipt',instance:'primary',validation_errors:['full_archive_database_scope_invalid'],database_scope_valid:false,relation_metadata_match:false,extension_owners_match:false,artifact_kind:'pgops-full-v1',restart_verified:true,role_attributes_passwords_defaults_match:true,bootstrap_identity_verified:true,proof_scope:'full_archive_restore_restart_roles_and_relation_metadata',complete_schema_policy_equivalence_verified:false,path:secret},excluded:{status:secret}}};put(s);
  const value=await cap.run('pg_upgrade_preflight','{}'),receipt=value.qualification_evidence.instances.primary;assert.equal(receipt.instance,'primary');assert.deepEqual(receipt.validation_errors,['full_archive_database_scope_invalid']);assert.equal(receipt.database_scope_valid,false);assert.equal(receipt.restart_verified,true);assert.equal(receipt.complete_schema_policy_equivalence_verified,false);assert.equal(receipt.proof_scope,'full_archive_restore_restart_roles_and_relation_metadata');assert.equal(value.execution_authorized,false);assert.equal(value.qualification_evidence.instances.excluded,undefined);assert.ok(!JSON.stringify(value).includes(secret));put();
 });
 await verifies('mismatched receipt identity does not cross the configured instance scope',async()=>{
  const s=snapshot();s.qualification_evidence={schema_version:1,instances:{primary:{status:'passed',instance:'excluded',database_count:99,authentication:[{application:secret}]}}};put(s);
  const value=await cap.run('pg_upgrade_preflight','{}'),receipt=value.qualification_evidence.instances.primary;assert.equal(receipt.status,'invalid_receipt');assert.equal(receipt.instance,'primary');assert.deepEqual(receipt.validation_errors,['instance_scope_mismatch']);assert.equal(receipt.database_count,undefined);assert.ok(!JSON.stringify(value).includes(secret));put();
 });
 await verifies('older snapshots keep missing new diagnostics explicitly unavailable',async()=>{
  put();const inventory=await cap.run('pg_fleet_inventory','{}');assert.equal(inventory.backup_schedulers,null);assert.equal(inventory.instances.primary.shared_memory,null);const health=await cap.run('pg_instance_health','{"instance":"primary"}');assert.equal(health.diagnostics.shared_memory,undefined);
 });

 await verifies('reject SQL, unknown tools, malformed and outside-scope instances',async()=>{
  for(const [name,args] of [['pg_fleet_inventory','{"sql":"select 1"}'],['pg_fleet_inventory','{"":"ignored"}'],['pg_instance_health','{}'],['pg_instance_health','{"instance":"excluded"}'],['pg_instance_health','{"instance":"primary","sql":"delete"}'],['other','{}'],['pg_fleet_inventory','[]'],['pg_upgrade_preflight','not json']])assert.equal((await cap.run(name,args)).status,'invalid_arguments');
 });
 await verifies('stale and future snapshots cannot report current metrics',async()=>{
  for(const [offset,status] of [[-601000,'stale_snapshot'],[60000,'future_snapshot']]){const s=snapshot();s.collected_at=new Date(Date.now()+offset).toISOString();put(s);const r=await cap.run('pg_instance_health','{"instance":"primary"}');assert.equal(r.status,status);assert.equal(r.data,null);}
  put();
 });
 await verifies('explicit unsupported schema and invalid snapshot',async()=>{
  const s=snapshot();s.schema_version=3;put(s);assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_schema_unsupported');
  writeFileSync(path,'{invalid');assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_invalid');put();
 });
 await verifies('invalid collector metadata cannot bypass the field projection',async()=>{
  for(const version of [{version:'0.2.0',query:secret,private_path:secret},'bad version',null]){
   const s=snapshot();s.collector_version=version;put(s);const r=await cap.run('pg_fleet_inventory','{}');assert.equal(r.status,'snapshot_invalid');assert.ok(!JSON.stringify(r).includes(secret));
  }
  put();
 });
 await verifies('reader retains producer rows or returns an explicit size failure',async()=>{
  const s=snapshot();s.instances.primary.maintenance=Array.from({length:101},(_,i)=>({relname:'table'+i,dead_estimate:i===100?9:0}));s.instances.primary.sections.maintenance={status:'ok',rows:101,truncated:false};put(s);
  const r=await cap.run('pg_maintenance_candidates','{"instance":"primary"}');assert.equal(r.maintenance.length,101);assert.equal(r.maintenance[100].dead_estimate,9);assert.equal(r.sections.maintenance.truncated,false);
  s.instances.primary.maintenance=Array.from({length:10000},()=>({relname:'table',dead_estimate:1}));put(s);const bounded=await cap.run('pg_maintenance_candidates','{"instance":"primary"}');assert.equal(bounded.status,'response_too_large');assert.equal(bounded.data,null);put();
 });
 await verifies('missing, oversized, directory and symlink reads fail closed',async()=>{
  rmSync(path);assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_unavailable');
  writeFileSync(path,' '.repeat(1024*1024+1));assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_invalid');
  rmSync(path);mkdirSync(path);assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_invalid');rmSync(path,{recursive:true});
  const other=join(root,'other.json');writeFileSync(other,JSON.stringify(snapshot()));symlinkSync(other,path);assert.equal((await cap.run('pg_fleet_inventory','{}')).status,'snapshot_unavailable');rmSync(path);put();
 });
 await verifies('permission error never leaks file details',async()=>{
  if(process.getuid()===0)return;
  chmodSync(path,0);const r=await cap.run('pg_fleet_inventory','{}');assert.equal(r.status,'snapshot_permission_denied');assert.ok(!JSON.stringify(r).includes(path));chmodSync(path,0o600);
 });
 await verifies('role, identity and config revocation stop existing capabilities',async()=>{
  for(const user of [{...owner,managerScope:'assigned'},{...owner,id:'other-global'},{...owner,active:0}]){current=user;await assert.rejects(()=>cap.run('pg_fleet_inventory','{}'),{status:403});}
  current={...owner};process.env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS='different';await assert.rejects(()=>cap.check(),{status:403});process.env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS='operator';
 });
 await verifies('actual Agents SDK registers and invokes PostgreSQL FunctionTool',async()=>{
  let calls=0;
  const answer=await runManagerAi({model:defaultManagerAiModel,key:'synthetic',turns:[{role:'user',content:'Database readiness'}],signal,postgres:cap,check:async()=>{},readSource:async()=>{throw Error('unexpected commercial read');},send:async(_url,init)=>{
   const body=JSON.parse(init.body);assert.ok(body.tools.some(t=>t.name==='pg_upgrade_preflight'));
   if(++calls===1)return Response.json({id:'r_pg1',model:defaultManagerAiModel,status:'completed',output:[{type:'function_call',name:'pg_upgrade_preflight',call_id:'pg_readiness',arguments:'{}'}]});
   const output=body.input.find(x=>x.type==='function_call_output');assert.ok(output);assert.equal(JSON.parse(output.output).application.current_database_engine,'sqlite');
   return Response.json({id:'r_pg2',model:defaultManagerAiModel,status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'SQLite remains active; restore qualification is required.',annotations:[]}]}]});
  }});
  assert.equal(calls,2);assert.match(answer.answer,/SQLite/);assert.equal(answer.reports.length,0);
 });
 await verifies('SDK discards a result if infrastructure authorization is revoked',async()=>{
  await assert.rejects(()=>runManagerAi({model:defaultManagerAiModel,key:'synthetic',turns:[{role:'user',content:'Hello'}],signal,postgres:cap,check:async()=>{},readSource:async()=>{throw Error('unexpected read');},send:async()=>{
   current={...owner,id:'different'};
   return Response.json({id:'r_revoked',model:defaultManagerAiModel,status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'This result must be discarded.',annotations:[]}]}]});
  }}),{status:403});
  current={...owner};
 });
 await verifies('SDK rechecks PostgreSQL access before each streamed publication',async()=>{
  let calls=0;const events=[];
  const stream=items=>new Response(items.map(item=>'data: '+JSON.stringify(item)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(()=>runManagerAi({model:defaultManagerAiModel,key:'synthetic',turns:[{role:'user',content:'Read database readiness'}],signal,postgres:cap,check:async()=>{},onEvent:async event=>{events.push(event);},readSource:async()=>{throw Error('unexpected read');},send:async()=>{
   if(++calls===1)return stream([{type:'response.created',response:{model:defaultManagerAiModel}},{type:'response.completed',response:{id:'r_stream_tool',model:defaultManagerAiModel,status:'completed',output:[{type:'function_call',name:'pg_upgrade_preflight',call_id:'stream_readiness',arguments:'{}'}]}}]);
   process.env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS='revoked';
   return stream([{type:'response.created',response:{model:defaultManagerAiModel}},{type:'response.output_text.delta',delta:'Private metadata must not be published.'},{type:'response.completed',response:{id:'r_stream_result',model:defaultManagerAiModel,status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Private metadata must not be published.'}]}]}}]);
  }}),{status:403});
  process.env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS='operator';
  assert.ok(!JSON.stringify(events).includes('Private metadata must not be published.'));
 });
 await verifies('ordinary SDK invocation never advertises PostgreSQL tools',async()=>{
  await runManagerAi({model:defaultManagerAiModel,key:'synthetic',turns:[{role:'user',content:'Hello'}],signal,check:async()=>{},readSource:async()=>{throw Error('unexpected read');},send:async(_url,init)=>{
   assert.ok(!JSON.parse(init.body).tools.some(t=>t.name.startsWith('pg_')));
   return Response.json({id:'r_normal',model:defaultManagerAiModel,status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Hello.',annotations:[]}]}]});
  }});
 });
 console.log(JSON.stringify({passed:count,failed:0,provider:'installed SDK; synthetic transport',external_requests:0}));
}finally{
 rmSync(root,{recursive:true,force:true});
 for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
