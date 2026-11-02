// Fixed domain executor: engine input and output are JSON over stdio only.
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {fstatSync,readdirSync,statSync} from 'node:fs';
// Existing parser workers resolve their immutable release relative to cwd.
process.chdir(import.meta.dirname);
const lockPath=process.env.IMPORT_ENGINE_LOCK_PATH;
if(!lockPath)throw Error('Missing inherited executor lock');
const expected=statSync(lockPath);
const lockFd=readdirSync('/proc/self/fd').map(Number).find(fd=>{if(fd<3)return false;try{const actual=fstatSync(fd);return actual.dev===expected.dev&&actual.ino===expected.ino;}catch{return false;}});
if(lockFd===undefined)throw Error('Executor lock was not inherited');
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1024*1024)throw Error('Input limit exceeded');}
const request=JSON.parse(input);
const sales=['sales_agent','stock_tr'].includes(request.job?.kind);
const sim=String(request.job?.kind||'').startsWith('sim_');
const child=spawn(sales?process.execPath:'python3',[join(import.meta.dirname,sales?'import-engine-sales.mjs':sim?'import_engine_sim.py':'import_engine_history.py')],{stdio:['pipe','pipe','inherit',lockFd]});
const completion=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
child.stdin.end(input);let output='';for await(const chunk of child.stdout){output+=chunk;if(output.length>1024*1024){child.kill();throw Error('Output limit exceeded');}}
const code=await completion;
if(code!==0)throw Error('Domain executor failed');
const result=JSON.parse(output);
if(result.state==='committed_refresh_pending'&&result.receipt?.verified===true){
 try{
  const refresh=spawn(process.execPath,[join(import.meta.dirname,'import-engine-refresh.mjs')],{stdio:['pipe','pipe','inherit',lockFd]});
  const finished=new Promise((resolve,reject)=>{refresh.on('error',reject);refresh.on('close',resolve);});
  refresh.stdin.end(JSON.stringify(result));let details='';
  for await(const chunk of refresh.stdout){details+=chunk;if(details.length>65536){refresh.kill();throw Error('Refresh output limit exceeded');}}
  if(await finished!==0)throw Error('Refresh failed');
  const activityRefresh=JSON.parse(details);
  if(!['incremental','full'].includes(activityRefresh.mode))throw Error('Invalid refresh response');
  result.result={...result.result,activityRefresh};result.state='completed';
 }catch{/* The committed ledger receipt remains the recovery authority. */}
}
process.stdout.write(JSON.stringify(result)+'\n');
