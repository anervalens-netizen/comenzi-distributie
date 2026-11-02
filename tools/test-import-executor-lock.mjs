import assert from 'node:assert/strict';
import {copyFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'import-lock-')),lock=join(dir,'executor.lock'),marker=join(dir,'started');let parent;
try{
 await copyFile(resolve('tools/import-engine-executor.mjs'),join(dir,'import-engine-executor.mjs'));
 await writeFile(join(dir,'import_engine_sim.py'),"import os,sys,time\nsys.stdin.read()\nopen(os.environ['SYNTHETIC_MARKER'],'w').write('started')\ntime.sleep(2)\nprint('{}')\n");
 parent=spawn('/usr/bin/flock',['--exclusive','--nonblock','--no-fork',lock,process.execPath,join(dir,'import-engine-executor.mjs')],{env:{...process.env,IMPORT_ENGINE_LOCK_PATH:lock,SYNTHETIC_MARKER:marker},stdio:['pipe','ignore','ignore']});
 parent.stdin.end(JSON.stringify({job:{kind:'sim_sales_digi'}}));
 let started=false;for(let n=0;n<100;n++){try{started=(await readFile(marker,'utf8'))==='started';if(started)break;}catch{}await new Promise(r=>setTimeout(r,20));}assert(started,'synthetic worker started');
 parent.kill('SIGKILL');await new Promise(r=>parent.once('close',r));
 const available=()=>spawnSync('/usr/bin/flock',['--exclusive','--nonblock',lock,'/usr/bin/true']).status===0;
 assert.equal(available(),false,'child retains shared flock after wrapper crash');
 let released=false;for(let n=0;n<150;n++){if(available()){released=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert(released,'lock is released after worker exits');console.log('PASS: child keeps executor lock after wrapper crash and releases it on exit.');
}finally{parent?.kill('SIGKILL');await rm(dir,{recursive:true,force:true});}
