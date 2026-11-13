import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
const data=mkdtempSync(join(tmpdir(),'anaf-http-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const origin='http://127.0.0.1:'+port;
const child=spawn(process.execPath,[resolve('dist/standalone/server.js')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),MOBIUP_DATA_DIR:data,NODE_ENV:'production'},stdio:'ignore'});
try{
 let ready=false;
 for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/bootstrap')).ok){ready=true;break}}catch{}await delay(100);}
 assert.ok(ready,'isolated server ready');
 const url=origin+'/api/partner/anaf?cui=900000001';
 assert.equal((await fetch(url)).status,401);
 const db=new DatabaseSync(join(data,'mobiup.sqlite')),token=randomUUID();
 db.prepare("INSERT INTO users(id,username,name,role,password_hash,must_change_password,active) VALUES('anaf-agent','anaf-agent','Synthetic Agent','agent','disabled',0,1)").run();
 db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(createHash('sha256').update(token).digest('hex'),'anaf-agent',Date.now()+3600000);
 const headers={Cookie:'mobiup_session='+token};
 const response=await fetch(url,{headers});
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
 assert.equal((await response.json()).status,'invalid');
 db.prepare("UPDATE users SET active=0 WHERE id='anaf-agent'").run();
 assert.equal((await fetch(url,{headers})).status,401);
 db.close();
 console.log('PASS ANAF HTTP: unauthenticated and disabled users denied, agent validation available, no-store.');
}finally{
 const exited=new Promise(r=>child.once('exit',r));child.kill();await Promise.race([exited,delay(3000)]);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}
 rmSync(data,{recursive:true,force:true});
}
