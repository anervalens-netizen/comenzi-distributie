import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import {randomBytes,scryptSync} from 'node:crypto';
import assert from 'node:assert/strict';

const root=process.cwd(),data=root+'/work/session-persistence-qa',origin='http://127.0.0.1:3099';
const TTL_SECONDS=365*24*60*60,TTL_MS=TTL_SECONDS*1000;
rmSync(data,{recursive:true,force:true});mkdirSync(data,{recursive:true});
const server=spawn(process.execPath,['dist/standalone/server.js'],{cwd:root,env:{...process.env,MOBIUP_DATA_DIR:data,HOST:'127.0.0.1',PORT:'3099'},stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function request(path,{cookie,method='GET',body}={}){
  const response=await fetch(origin+'/api/'+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),setCookie:response.headers.get('set-cookie')||''};
}
try{
  for(let i=0;i<80;i++){try{if((await fetch(origin+'/api/health')).ok)break;}catch{}await sleep(100);}
  const db=new DatabaseSync(data+'/mobiup.sqlite');
  const password=randomBytes(20).toString('hex'),salt=randomBytes(16).toString('hex'),hash='scrypt:'+salt+':'+scryptSync(password,salt,32,{N:32768,r:8,p:3,maxmem:40*1024*1024}).toString('hex');
  db.prepare("INSERT INTO users(id,username,name,role,manager_scope,password_hash,must_change_password,active) VALUES('session-qa','session-qa','Session QA','manager','global',?,0,1)").run(hash);

  const beforeLogin=Date.now();
  const login=await request('auth/login',{method:'POST',body:{username:'session-qa',password}});
  assert.equal(login.status,200);
  assert(login.setCookie.includes('Max-Age='+TTL_SECONDS));
  const cookie=login.setCookie.split(';')[0];
  assert(cookie.startsWith('mobiup_session='));
  let row=db.prepare('SELECT expires_at FROM sessions WHERE user_id=?').get('session-qa');
  assert(row&&Number(row.expires_at)>=beforeLogin+TTL_MS-5000,'Login persists the device session for about one year.');

  db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now()+60_000,'session-qa');
  const beforeRefresh=Date.now();
  const bootstrap=await request('bootstrap',{cookie});
  assert.equal(bootstrap.status,200);
  assert.equal(bootstrap.data.user?.id,'session-qa');
  assert(bootstrap.setCookie.includes('Max-Age='+TTL_SECONDS));
  row=db.prepare('SELECT expires_at FROM sessions WHERE user_id=?').get('session-qa');
  assert(row&&Number(row.expires_at)>=beforeRefresh+TTL_MS-5000,'Bootstrap renews the registered device session.');

  db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(Date.now()-1,'session-qa');
  const expired=await request('bootstrap',{cookie});
  assert.equal(expired.status,200);
  assert.equal(expired.data.user,null);
  assert.match(expired.setCookie,/(?:^|;\s*)Max-Age=0(?:;|$)/,'Expired/revoked sessions clear the browser credential instead of being resurrected.');

  const relogin=await request('auth/login',{method:'POST',body:{username:'session-qa',password}});
  const liveCookie=relogin.setCookie.split(';')[0];
  const logout=await request('auth/logout',{cookie:liveCookie,method:'POST',body:{}});
  assert.equal(logout.status,200);
  assert.match(logout.setCookie,/(?:^|;\s*)Max-Age=0(?:;|$)/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions WHERE user_id=?').get('session-qa').count,0,'Explicit logout revokes the current device session.');

  db.close();
  console.log('PASS: persistent registered-device session, sliding renewal, expiry cleanup and explicit logout.');
}finally{
  server.kill();
}
