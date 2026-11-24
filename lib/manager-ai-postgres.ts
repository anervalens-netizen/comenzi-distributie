import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {fail} from './server';
import type {User} from './types';

const maxBytes=1024*1024;
const token=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const names=['pg_fleet_inventory','pg_instance_health','pg_maintenance_candidates','pg_upgrade_preflight'] as const;
type ToolName=typeof names[number];
type Json=Record<string,unknown>;
const object=(x:unknown):x is Json=>!!x&&typeof x==='object'&&!Array.isArray(x);
const fields=(text:string)=>text.split(/\s+/).filter(Boolean);

// The collector's schema is a metadata contract. New fields require an explicit
// allowlist change; arbitrary SQL, connection strings and filesystem paths never
// pass through this projection.
const keys=new Set(fields(`
status reason visibility privacy rows truncated limit eligible_databases database_inventory_may_be_truncated
all_database_schemas_inspected scope value values unit source pending_restart name version version_num
database database_bytes read_only recovery postmaster_start_time database_oid extensions settings setting_details
replication_slots streaming_replica_count visible_replication_rows replication_visibility
server_version_num privileges superuser read_all_stats views query_metrics_view schema columns features
dynamic_io_settings repack_progress autovacuum_scores lock_statistics wal_fpi_bytes plan_advice sql_features
pg_stat_io pg_stat_lock pg_stat_wal pg_stat_recovery pg_stat_progress_vacuum pg_stat_progress_analyze
pg_stat_progress_repack pg_stat_progress_basebackup pg_stat_autovacuum_scores pg_stat_replication
pg_replication_slots pg_stat_wal_receiver pg_stat_subscription_stats pg_stat_user_indexes pg_stat_user_tables
table_and_query_metrics_database catalog_summary_scope database_inventory_limit database_inventory_rows cluster_database_bytes meaning
transactions_committed transactions_rolled_back deadlocks blocks_read blocks_hit temporary_bytes stats_reset connections active_connections waiting_connections
wal database interval_seconds transactions_committed_per_second transactions_rolled_back_per_second deadlocks_per_second
blocks_read_per_second blocks_hit_per_second temporary_bytes_per_second wal_records_per_second wal_fpi_per_second wal_bytes_per_second wal_buffers_full_per_second wal_fpi_bytes_per_second
backend_type object context reads read_bytes read_time writes write_bytes write_time writebacks writeback_time extends extend_bytes extend_time hits evictions reuses fsyncs fsync_time
locktype waits wait_time fastpath_exceeded wal_records wal_fpi wal_bytes wal_buffers_full
promote_triggered last_replayed_read_lsn last_replayed_end_lsn last_replayed_tli replay_end_lsn replay_end_tli recovery_last_xact_time current_chunk_start_time pause_state
pid datid datname relid phase heap_blks_total heap_blks_scanned heap_blks_vacuumed index_vacuum_count max_dead_tuple_bytes dead_tuple_bytes num_dead_item_ids indexes_total indexes_processed delay_time mode started_by
sample_blks_total sample_blks_scanned ext_stats_total ext_stats_computed child_tables_total child_tables_done current_child_table_relid
command repack_index_relid heap_tuples_scanned heap_tuples_inserted heap_tuples_updated heap_tuples_deleted index_rebuild_count
backup_total backup_streamed tablespaces_total tablespaces_streamed backup_type
schemaname relname score xid_score mxid_score vacuum_score vacuum_insert_score analyze_score do_vacuum do_analyze for_wraparound
state sent_lsn write_lsn flush_lsn replay_lsn write_lag flush_lag replay_lag sync_priority sync_state reply_time
slot_name plugin slot_type temporary active active_pid xmin catalog_xmin restart_lsn confirmed_flush_lsn wal_status safe_wal_size two_phase inactive_since conflicting invalidation_reason failover synced retained_wal_bytes
receive_start_lsn receive_start_tli written_lsn flushed_lsn received_tli last_msg_send_time last_msg_receipt_time latest_end_lsn latest_end_time
subid subname apply_error_count sync_error_count sync_seq_error_count sync_table_error_count confl_insert_exists confl_update_origin_differs confl_update_exists confl_update_deleted confl_update_missing confl_delete_origin_differs confl_delete_missing confl_multiple_unique_conflicts
indexrelid indexrelname idx_scan last_idx_scan idx_tup_read idx_tup_fetch n_live_tup n_dead_tup
visible_sessions sessions_with_hidden_state idle_in_transaction waiting_on_locks blocked_sessions oldest_transaction_seconds oldest_query_seconds oldest_backend_xmin_age
datallowconn datistemplate bytes xid_age multixact_age datcollversion actual_collation_version
unvalidated_constraints invalid_indexes trigram_indexes inet_cidr_gist_indexes stored_tsvector_columns
in_recovery current_or_replay_lsn last_replay_timestamp slots queryid calls total_exec_time mean_exec_time min_exec_time max_exec_time shared_blks_hit shared_blks_read shared_blks_dirtied shared_blks_written temp_blks_read temp_blks_written stats_since minmax_stats_since plans total_plan_time mean_plan_time generic_plans custom_plans
catalog compatibility tuple_counts lock_waits rates io_times repack index_sample
heap_bytes index_bytes live_estimate dead_estimate n_mod_since_analyze n_ins_since_vacuum n_tup_upd n_tup_hot_upd n_tup_newpage_upd last_autovacuum last_autoanalyze autovacuum_count autoanalyze_count relpersistence relkind relreplident access_method identity_index_available has_invalid_index
shared_buffers work_mem maintenance_work_mem autovacuum_work_mem max_connections max_wal_size min_wal_size wal_level effective_wal_level wal_compression wal_keep_size max_slot_wal_keep_size max_replication_slots max_wal_senders max_worker_processes max_parallel_workers max_parallel_workers_per_gather max_parallel_maintenance_workers
autovacuum autovacuum_max_workers autovacuum_worker_slots autovacuum_max_parallel_workers autovacuum_vacuum_score_weight autovacuum_vacuum_insert_score_weight autovacuum_analyze_score_weight autovacuum_freeze_score_weight autovacuum_multixact_freeze_score_weight autovacuum_vacuum_threshold autovacuum_vacuum_scale_factor autovacuum_vacuum_insert_threshold autovacuum_vacuum_insert_scale_factor autovacuum_analyze_threshold autovacuum_analyze_scale_factor autovacuum_freeze_max_age autovacuum_multixact_freeze_max_age vacuum_freeze_table_age vacuum_multixact_freeze_table_age
jit io_method io_workers io_min_workers io_max_workers io_worker_launch_interval io_worker_idle_timeout effective_io_concurrency maintenance_io_concurrency track_io_timing track_wal_io_timing max_locks_per_transaction max_repack_replication_slots default_toast_compression data_checksums password_encryption md5_password_warnings password_expiration_warning_threshold wal_sender_shutdown_timeout deadlock_timeout hot_standby
ok completed_at at sha256 mirror_sha256 restore_verified nas_copy_verified nas_checksum_verified nas_decryption_and_tar_read receipt_age_seconds receipt_stale stale_threshold_hours qualification databases databases_truncated
ready checks check checked_at latest_verified 18 19 sources refresh_before_upgrade age_days knowledge_stale
target_version target_image archive_sha256 database_count globals_from_original_archive cleanup_completed production_database_writes authentication application correct_password wrong_password_rejected read_only_query matches_latest_backup age_hours stale application_workflows_verified production_replica_transition_verified
`));
function safe(value:unknown,depth=0):unknown {
  if(depth>10)return null;
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(typeof value==='string')return value.length<=1024?value:value.slice(0,1024)+' [truncated]';
  if(Array.isArray(value))return value.slice(0,100).map(v=>safe(v,depth+1));
  if(!object(value))return null;
  return Object.fromEntries(Object.entries(value).filter(([k])=>keys.has(k)).map(([k,v])=>[k,safe(v,depth+1)]));
}
function pick(value:unknown,allow:string[]) {
  if(!object(value))return null;
  return Object.fromEntries(allow.filter(k=>Object.hasOwn(value,k)).map(k=>[k,safe(value[k])]));
}
function configuration(env=process.env) {
  const path=env.MOBIUP_MANAGER_AI_POSTGRES_SNAPSHOT?.trim();
  const admins=env.MOBIUP_MANAGER_AI_POSTGRES_ADMIN_IDS?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  const instances=env.MOBIUP_MANAGER_AI_POSTGRES_INSTANCES?.split(',').map(x=>x.trim()).filter(Boolean)??[];
  if(!path||!isAbsolute(path)||!admins.length||!instances.length||admins.length>8||instances.length>8||![...admins,...instances].every(x=>token.test(x)))return null;
  return {path,admins,instances:[...new Set(instances)]};
}
function allowed(user:User,config:NonNullable<ReturnType<typeof configuration>>) {
  return user.role==='manager'&&user.managerScope==='global'&&user.active!==0&&config.admins.includes(user.id);
}

export function managerAiPostgresAvailable(user:User,selectedPortfolio:boolean) {
  const config=configuration();
  return !selectedPortfolio&&!!config&&allowed(user,config);
}

const guidance=`Instrumentele pg_* oferă numai metadate PostgreSQL citite dintr-un snapshot local controlat de operator. Sunt FunctionTools ale SDK, fără SQL arbitrar și fără comenzi de administrare. Pentru versiune, sănătate sau pregătire citește instrumentul în schimbul curent și citează collected_at. Nu transforma null, permission_denied, unsupported ori o secțiune parțială în zero. Snapshot-urile expirate sau din viitor nu stabilesc sănătatea curentă. Ratele necesită intervalul și status=ok; dead tuples sunt estimări, nu spațiu recuperabil exact. Comenzi folosește încă SQLite; ținta PostgreSQL nu a fost selectată. Un rezultat de preflight nu autorizează și nu execută migrarea.
Documentația PostgreSQL 19 descrie funcții țintă, nu dovedește că instanța le are. Consultă capabilities și versiunea live. REPACK CONCURRENTLY necesită PG19, identitate validă, spațiu, verificarea tranzacțiilor vechi și lock final. Autovacuum paralel nu este implicit activ; pg_stat_autovacuum_scores și pg_stat_lock sunt specifice versiunii. io_workers se înlocuiește cu setările dinamice io_min_workers/io_max_workers în PG19. Verifică wal_level și effective_wal_level; sincronizarea secvențelor logice este explicită, nu fiecare nextval. WAIT trebuie limitat în timp. pg_plan_advice este modul încărcat, pg_stash_advice necesită obiecte și încărcare; instalarea nu dovedește aplicarea. Nu promite viteză fără benchmark sau restaurare fără roluri, autentificare și paritate aplicație. Referințe: https://www.postgresql.org/docs/19/ ; https://www.postgresql.org/docs/release/19.0/ . Revalidează release-urile înainte de upgrade.`;

function definitions(instances:string[]) {
  return names.map(name=>({name,description:{
    pg_fleet_inventory:'Citește versiunile, capabilitățile și acoperirea PostgreSQL pentru instanțele autorizate.',
    pg_instance_health:'Citește I/O, WAL, lock-uri, replicare și rate PostgreSQL, cu vizibilitate și stări explicite.',
    pg_maintenance_candidates:'Citește estimări de întreținere, indexuri, autovacuum și progres REPACK. Nu execută operații.',
    pg_upgrade_preflight:'Citește dovezile de compatibilitate și backup pentru pregătirea PG19. Comenzi rămâne SQLite; migrarea nu este executată.',
  }[name],parameters:{type:'object',properties:name==='pg_instance_health'||name==='pg_maintenance_candidates'?{instance:{type:'string',enum:instances}}:{},required:name==='pg_instance_health'||name==='pg_maintenance_candidates'?['instance']:[],additionalProperties:false}}));
}

export type ManagerAiPostgresCapability={instructions:string;tools:ReturnType<typeof definitions>;check:()=>Promise<void>;run:(name:string,raw:string)=>Promise<unknown>};

async function readSnapshot(path:string) {
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size>maxBytes)throw Error('snapshot_invalid');
    const buffer=Buffer.alloc(maxBytes+1);
    let offset=0;
    while(offset<buffer.length){const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset);if(!bytesRead)break;offset+=bytesRead;}
    if(offset>maxBytes)throw Error('snapshot_invalid');
    const value:unknown=JSON.parse(buffer.subarray(0,offset).toString('utf8'));
    if(!object(value)||!object(value.instances)||typeof value.collected_at!=='string'||!Number.isFinite(Date.parse(value.collected_at)))throw Error('snapshot_invalid');
    if(value.schema_version!==2)throw Error('snapshot_schema_unsupported');
    return value;
  } finally {await handle.close();}
}

function render(snapshot:Json,name:ToolName,instance:string|undefined,instances:string[]) {
  const collectedAt=String(snapshot.collected_at),age=(Date.now()-Date.parse(collectedAt))/1000;
  const base={schema_version:2,collector_version:snapshot.collector_version,collected_at:collectedAt,age_seconds:Math.round(age),stale:age<0||age>600,scope:'Operator-authorized read-only PostgreSQL metadata. Null is unknown; no business rows or SQL text.'};
  if(base.stale)return {...base,status:age<0?'future_snapshot':'stale_snapshot',data:null};
  const source=snapshot.instances as Json;
  if(instance){
    const target=source[instance];
    if(!object(target))return {...base,instance,status:'instance_unavailable'};
    const health=name==='pg_instance_health';
    const diagnostics=health?fields('io wal locks activity replication replication_state slots wal_receiver recovery subscription query_metrics databases semantics'):fields('autovacuum_scores progress_vacuum progress_repack progress_analyze progress_basebackup indexes databases database_catalogs compatibility cluster_compatibility semantics');
    return {...base,instance,...pick(target,fields('database status container_version coverage capabilities')),
      sections:pick(target.sections,health?fields('inventory health wal io locks activity replication replication_state slots wal_receiver recovery subscription query_metrics databases'):fields('maintenance autovacuum_scores progress_vacuum progress_repack progress_analyze progress_basebackup indexes databases database_catalogs compatibility')),
      [health?'health':'maintenance']:safe(target[health?'health':'maintenance']),...(health?{rates:safe(target.rates)}:{}),diagnostics:pick(target.diagnostics,diagnostics)};
  }
  const inventory=Object.fromEntries(instances.map(id=>[id,object(source[id])?pick(source[id],fields('database status container_version state inventory coverage capabilities')):{status:'instance_unavailable'}]));
  const result={...base,instances:inventory,version_policy:safe(snapshot.version_policy??(object(snapshot.preflight)?snapshot.preflight.version_policy:null))};
  if(name==='pg_fleet_inventory')return result;
  const qualification=snapshot.qualification_evidence;
  const receipts=object(qualification)&&qualification.schema_version===1&&object(qualification.instances)?qualification.instances:null;
  return {...result,application:{current_database_engine:'sqlite',target_major:19,target_instance:null,cutover_executed:false},
    backups:Object.fromEntries(instances.map(id=>[id,object(snapshot.backup_evidence)?safe(snapshot.backup_evidence[id]):null])),
    qualification_evidence:receipts?{schema_version:1,instances:Object.fromEntries(instances.map(id=>[id,safe(receipts[id])]))}:null,
    preflight:pick(snapshot.preflight,fields('ready qualification checks')),execution_authorized:false,
    required_qualification:['full_backup_restore','roles_authentication_acl','application_parity','replica_transition','storage_capacity','authorized_maintenance_window'],
    qualification:'Diagnostic evidence only. A timer or copied archive is not proof of a full restore. Owner authorization and technical qualification are separate.'};
}

export async function createManagerAiPostgres({check,signal,selectedPortfolio}:{check:()=>Promise<User>;signal:AbortSignal;selectedPortfolio:boolean}):Promise<ManagerAiPostgresCapability|undefined> {
  if(selectedPortfolio)return;
  const config=configuration();
  if(!config)return;
  const initial=await check();
  if(!allowed(initial,config))return;
  async function authorize(){
    signal.throwIfAborted();
    const current=await check(),live=configuration();
    if(!live||JSON.stringify(live)!==JSON.stringify(config)||current.id!==initial.id||!allowed(current,live))fail(403,'Accesul la diagnosticele PostgreSQL nu mai este disponibil.');
    signal.throwIfAborted();
  }
  return {instructions:guidance,tools:definitions(config.instances),check:authorize,async run(name,raw){
    await authorize();
    let args:unknown;
    try{args=JSON.parse(raw);}catch{return {status:'invalid_arguments'};}
    const instanceTool=name==='pg_instance_health'||name==='pg_maintenance_candidates';
    if(!names.includes(name as ToolName)||!object(args)||Object.keys(args).some(k=>!instanceTool||k!=='instance')||
      (instanceTool&&(typeof args.instance!=='string'||!config.instances.includes(args.instance))))return {status:'invalid_arguments'};
    let result:unknown;
    try{result=render(await readSnapshot(config.path),name as ToolName,args.instance as string|undefined,config.instances);}
    catch(error){
      const code=(error as NodeJS.ErrnoException)?.code,message=(error as Error)?.message;
      result={status:code==='EACCES'||code==='EPERM'?'snapshot_permission_denied':message==='snapshot_schema_unsupported'?message:message==='snapshot_invalid'||error instanceof SyntaxError?'snapshot_invalid':'snapshot_unavailable',data:null};
    }
    await authorize();
    if(JSON.stringify(result).length>128*1024)return {status:'response_too_large',data:null};
    return result;
  }};
}
