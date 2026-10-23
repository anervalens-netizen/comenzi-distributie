import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { DatabaseSync } from 'node:sqlite';
import { createECDH, createHash, randomBytes, hkdfSync, createDecipheriv, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { connect as tcpConnect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, fetch as networkFetch } from 'undici';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const dir=mkdtempSync(join(tmpdir(),'push-policy-')),sql=new DatabaseSync(':memory:');
const originalFetch=globalThis.fetch;
let transportCalls=0;
globalThis.__pushTransport=()=>{transportCalls++;throw new Error('Unexpected external send.');};
globalThis.__pushDb={prepare(query){return {args:[],bind(...args){this.args=args;return this;},async first(){return sql.prepare(query).get(...this.args)||null;},async all(){return {results:sql.prepare(query).all(...this.args)};},async run(){if(query.startsWith('INSERT INTO push_subscriptions')&&globalThis.__pushBeforeRun){const before=globalThis.__pushBeforeRun;delete globalThis.__pushBeforeRun;before();}return {meta:sql.prepare(query).run(...this.args)};}};},async batch(statements){sql.exec('BEGIN');try{const values=[];for(const statement of statements)values.push(await statement.run());sql.exec('COMMIT');return values;}catch(error){sql.exec('ROLLBACK');throw error;}}};
const fixtures={name:'push-fixtures',setup(b){
  b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'push-fixture'}));
  b.onResolve({filter:/^@\/resources\/mail-defaults.json$/},()=>({path:'mail',namespace:'push-fixture'}));
  b.onLoad({filter:/.*/,namespace:'push-fixture'},a=>({loader:'js',contents:a.path==='mail'?`export default {publicOrigin:'https://example.invalid'};`:`import {createHash} from 'node:crypto';export const sha256=value=>createHash('sha256').update(value).digest('hex');export const sessionToken=req=>req.headers.get('Cookie')?.match(/mobiup_session=([^;]+)/)?.[1]||'';export const db=()=>globalThis.__pushDb;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};export const textField=(x,n=500)=>typeof x==='string'?x.trim().slice(0,n):'';export const isGlobalManager=u=>u.managerScope==='global';export const requireManager=u=>{if(u.role!=='manager')fail(403,'Forbidden');};`}));
}};
const manager={id:'manager',role:'manager',managerScope:'global',profileVersion:'1'},agent={id:'agent',role:'agent',name:'Synthetic agent'};
const receiver=createECDH('prime256v1');receiver.generateKeys();
const keys={p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};
const endpoints=[
  'https://fcm.googleapis.com/fcm/send/synthetic-token:example',
  'https://fcm.googleapis.com/wp/synthetic-token',
  'https://updates.push.services.mozilla.com/wpush/v2/synthetic-token',
  'https://updates.push.services.mozilla.com/wpush/v1/synthetic-token',
  'https://web.push.apple.com/synthetic-token',
  'https://wns2-example.notify.windows.com/w/?token=synthetic%2Btoken%3D',
];
const blocked=[
  'http://fcm.googleapis.com/fcm/send/token','https://127.0.0.1/fcm/send/token','https://localhost/fcm/send/token',
  'https://[::1]/token','https://[::ffff:127.0.0.1]/token','https://169.254.169.254/latest/meta-data',
  'https://10.0.0.1/token','https://192.168.1.1/token','https://0x7f000001/token','https://2130706433/token',
  'https://127.0.0.1.nip.io/token','https://rebinding.example.invalid/token','https://fcm.googleapis.com.evil.invalid/fcm/send/token',
  'https://evilfcm.googleapis.com/fcm/send/token','https://fcm.googleapis.com@127.0.0.1/token',
  (()=>{const url=new URL('https://fcm.googleapis.com/fcm/send/token');url.username='synthetic-user';url.password='synthetic-password';return url.href;})(),'https://@fcm.googleapis.com/fcm/send/token',
  'https://fcm.googleapis.com:8443/fcm/send/token','https://fcm.googleapis.com:443/fcm/send/token',
  'https://fcm.googleapis.com./fcm/send/token','https://%66cm.googleapis.com/fcm/send/token',
  'https://FCM.googleapis.com/fcm/send/token','https://fcm.googleapis.com/fcm/send/token#',
  'https://fcm.googleapis.com/fcm/send/token#secret','https://fcm.googleapis.com/fcm/send/token?redirect=http://127.0.0.1',
  'https://fcm.googleapis.com/fcm/send/../redirect','https://fcm.googleapis.com/fcm/send/%2Fredirect',
  'https://fcm.googleapis.com/redirect','https://sub.updates.push.services.mozilla.com/wpush/v2/token',
  'https://web.push.apple.com.evil.invalid/token','https://web.push.apple.com/path/token',
  'https://wns2-example.notify.windows.com.evil.invalid/w/?token=token','https://a.b.notify.windows.com/w/?token=token',
  'https://wns2-example.notify.windows.com/w/?token=token&next=http://127.0.0.1','https://wns2-example.notify.windows.com/w/?token=',
  'https://wns2-example.notify.windows.com/w/?token=token&token=other','https://fcm.googleapis.com/fcm/send/to\\ken',
  ' https://fcm.googleapis.com/fcm/send/token','https://fcm.googleapis.com/fcm/send/to\nken',
  'https://fcm.googleapis.com/fcm/send/'+'a'.repeat(4096), '', 'not-a-url',
];
function decryptRecord(value){
  const body=Buffer.from(value),salt=body.subarray(0,16),sender=body.subarray(21,86),shared=receiver.computeSecret(sender);
  const ikm=Buffer.from(hkdfSync('sha256',shared,Buffer.from(keys.auth,'base64url'),Buffer.concat([Buffer.from('WebPush: info\0'),receiver.getPublicKey(),sender]),32));
  const cek=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: aes128gcm\0'),16));
  const nonce=Buffer.from(hkdfSync('sha256',ikm,salt,Buffer.from('Content-Encoding: nonce\0'),12));
  const decipher=createDecipheriv('aes-128-gcm',cek,nonce);decipher.setAuthTag(body.subarray(-16));
  const plaintext=Buffer.concat([decipher.update(body.subarray(86,-16)),decipher.final()]);
  assert.equal(plaintext.at(-1),2);return JSON.parse(plaintext.subarray(0,-1).toString());
}
function verifyVapid(endpoint,authorization,vapid){
  const [,jwt,publicKey]=authorization.match(/^vapid t=([^,]+), k=(.+)$/);assert.equal(publicKey,vapid.publicKey);
  const parts=jwt.split('.'),claims=JSON.parse(Buffer.from(parts[1],'base64url'));assert.equal(claims.aud,new URL(endpoint).origin);assert.equal(claims.sub,vapid.subject);assert.ok(claims.exp>Date.now()/1000&&claims.exp<Date.now()/1000+86400);
  const bytes=Buffer.from(publicKey,'base64url'),key=createPublicKey({format:'jwk',key:{kty:'EC',crv:'P-256',x:bytes.subarray(1,33).toString('base64url'),y:bytes.subarray(33).toString('base64url')}});
  assert.ok(verify('sha256',Buffer.from(parts[0]+'.'+parts[1]),{key,dsaEncoding:'ieee-p1363'},Buffer.from(parts[2],'base64url')),'VAPID signature verifies independently');
}
let sink,tls,dispatcher,worker;
try{
  await build({stdin:{contents:`export * from './lib/push-notifications';export * from './lib/push-delivery';export {generateVapidKeys} from '@mmmike/web-push/vapid';`,resolveDir:resolve('.'),loader:'ts'},outfile:join(dir,'push.mjs'),bundle:true,format:'esm',platform:'node',plugins:[fixtures],banner:{js:'const fetch=(...args)=>globalThis.__pushTransport(...args);'}});
  const {isAllowedPushEndpoint,upsertPushSubscription:rawUpsert,removePushSubscription:remove,sendPartnerRequestPush:dispatch,encryptPushRecord,sendBrowserPushBatch:send,generateVapidKeys}=await import(join(dir,'push.mjs'));
  const managerRequest=new Request('https://example.invalid/api/notifications/push',{headers:{Cookie:'mobiup_session=synthetic-push-session'}});
  const upsert=(user,input,req=managerRequest)=>rawUpsert(user,input,req);
  sql.exec(`CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER,manager_scope TEXT,profile_revision INTEGER DEFAULT 1,must_change_password INTEGER DEFAULT 0);CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);
    CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,user_id TEXT,p256dh TEXT,auth TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO users(id,role,active,manager_scope) VALUES('manager','manager',1,'global'),('agent','agent',1,'assigned'),('inactive','manager',0,'global'),('other-region','manager',1,'assigned');`);
  const sessionHash=createHash('sha256').update('synthetic-push-session').digest('hex');
  sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionHash,'manager',Date.now()+3600000);
  for(const endpoint of endpoints){assert.ok(isAllowedPushEndpoint(endpoint),endpoint);await upsert(manager,{endpoint,keys});}
  for(const endpoint of blocked){assert.equal(isAllowedPushEndpoint(endpoint),false,endpoint);await assert.rejects(upsert(manager,{endpoint,keys}),e=>e.status===400);}
  for(const invalidKeys of [{...keys,p256dh:keys.p256dh+'a'.repeat(512)},{...keys,auth:keys.auth+'a'.repeat(512)},{...keys,p256dh:' '+keys.p256dh}])await assert.rejects(upsert(manager,{endpoint:endpoints[0],keys:invalidKeys}),e=>e.status===400);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n,endpoints.length);
  await assert.rejects(upsert(agent,{endpoint:endpoints[0],keys}),e=>e.status===403);
  await assert.rejects(remove(agent,{endpoint:endpoints[0]}),e=>e.status===403);
  await remove(manager,{endpoint:endpoints[0]});
  await upsert(manager,{endpoint:endpoints[0],keys});
  for(let i=endpoints.length;i<9;i++)await upsert(manager,{endpoint:`https://fcm.googleapis.com/fcm/send/limit-${i}`,keys});
  const results=await Promise.allSettled(Array.from({length:4},(_,i)=>upsert(manager,{endpoint:`https://fcm.googleapis.com/fcm/send/excess-${i}`,keys})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.status===429));
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n,10,'Concurrent registration cannot exceed the atomic account cap');
  await upsert(manager,{endpoint:endpoints[0],keys});
  await remove(manager,{endpoint:endpoints[0]});
  await upsert(manager,{endpoint:endpoints[0],keys});
  assert.equal(transportCalls,0,'Registration, removal and policy checks must never call a push service or resolve untrusted DNS');

  // The real shared guard executes in the same INSERT/UPSERT, after the request
  // was admitted. Revocation cannot add a destination or rotate an existing one.
  const resetSession=()=>{
    sql.exec("UPDATE users SET active=1,role='manager',profile_revision=1,must_change_password=0 WHERE id='manager';DELETE FROM sessions;");
    sql.prepare('INSERT INTO sessions VALUES(?,?,?)').run(sessionHash,'manager',Date.now()+3600000);
  };
  for(const mutation of [
    "UPDATE users SET active=0 WHERE id='manager'",'DELETE FROM sessions',
    "UPDATE users SET role='agent' WHERE id='manager'","UPDATE users SET profile_revision=2 WHERE id='manager'",
    "UPDATE users SET must_change_password=1 WHERE id='manager'","UPDATE sessions SET user_id='agent'",'UPDATE sessions SET expires_at=0',
  ])for(const endpoint of [endpoints[0],'https://fcm.googleapis.com/fcm/send/revoked-registration']){
    resetSession();let before;
    globalThis.__pushBeforeRun=()=>{sql.exec(mutation);before=sql.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all();};
    await assert.rejects(upsert(manager,{endpoint,keys}),error=>error.status===409,mutation);
    assert.deepEqual(sql.prepare('SELECT * FROM push_subscriptions ORDER BY endpoint').all(),before,'Revoked registration has no subscription write');
  }
  resetSession();
  await assert.rejects(upsert(manager,{endpoint:endpoints[0],keys},new Request('https://example.invalid')),error=>error.status===409,'Missing exact request session has no bypass');

  // RFC 8291 section 5 / Appendix A. Public published test material only.
  const asPublic='BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
  const uaPublic='BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const publicBytes=Buffer.from(asPublic,'base64url');
  const ephemeral={publicKey:await crypto.subtle.importKey('raw',publicBytes,{name:'ECDH',namedCurve:'P-256'},true,[]),privateKey:await crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:publicBytes.subarray(1,33).toString('base64url'),y:publicBytes.subarray(33).toString('base64url'),d:'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'},{name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])};
  const vector=await encryptPushRecord(new TextEncoder().encode('When I grow up, I want to be a watermelon'),{p256dh:uaPublic,auth:'BTBZMqHH6r4Tts7J_aSIgg'},ephemeral,Buffer.from('DGv6ra1nlYgDCS1FRnbzlw','base64url'));
  assert.equal(Buffer.from(vector).toString('base64url'),'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const vapid={...await generateVapidKeys(),subject:'https://example.invalid'};
  const payload={title:'Synthetic notification',body:'Synthetic body',url:'/?request=synthetic',tag:'synthetic'};
  const requests=[];
  const capture=async(endpoint,options)=>{requests.push({endpoint,options});return new Response(null,{status:201});};
  const first=await send(endpoints.map(endpoint=>({endpoint,keys})),payload,vapid,'synthetic-topic',capture);
  assert.equal(first.delivered,endpoints.length);assert.deepEqual(first.failed,[]);
  // Independent receiver uses Node's ECDH/HKDF/AES APIs, not the sender's helpers.
  for(const {endpoint,options} of requests){
    const body=Buffer.from(options.body);assert.equal(body.readUInt32BE(16),4096);assert.equal(body[20],65);
    assert.deepEqual(decryptRecord(body),payload);
    assert.equal(options.redirect,'manual');assert.equal(options.method,'POST');assert.equal(options.credentials,'omit');assert.equal(options.headers.TTL,'86400');assert.equal(options.headers.Urgency,'high');assert.equal(options.headers.Topic,'synthetic-topic');assert.ok(options.signal instanceof AbortSignal);
    verifyVapid(endpoint,options.headers.Authorization,vapid);
  }
  assert.equal(new Set(requests.map(r=>Buffer.from(r.options.body).subarray(0,86).toString('hex'))).size,endpoints.length,'Fresh ephemeral keys and salt per delivery');
  let active=0,maximum=0,cancelled=0;
  const limited=await send(Array.from({length:20},(_,i)=>({endpoint:`https://fcm.googleapis.com/fcm/send/pool-${i}`,keys})),payload,vapid,'pool',async()=>{active++;maximum=Math.max(maximum,active);await delay(10);active--;return new Response(new ReadableStream({cancel(){cancelled++;}}),{status:201});});
  assert.equal(limited.delivered,20);assert.equal(maximum,8);assert.equal(cancelled,20,'Responses are cancelled without reading unbounded service bodies');
  let failedCalls=0;
  const forbidden=await send(blocked.map(endpoint=>({endpoint,keys})),payload,vapid,'policy',async()=>{failedCalls++;throw Error('Network forbidden');});
  assert.equal(forbidden.failed.length,blocked.length);assert.equal(failedCalls,0);
  for(const invalidKeys of [{p256dh:'AAAA',auth:'BBBB'},{p256dh:keys.p256dh,auth:'a'.repeat(21)},{p256dh:'B'+'A'.repeat(86),auth:keys.auth}]){
    const invalid=await send([{endpoint:endpoints[0],keys:invalidKeys}],payload,vapid,'keys',async()=>{failedCalls++;throw Error('Network forbidden');});assert.equal(invalid.failed.length,1);
  }
  assert.equal(failedCalls,0);
  await assert.rejects(send([{endpoint:endpoints[0],keys}],{title:'a'.repeat(3994)},vapid,'size',capture),/payload/);
  await assert.rejects(send([{endpoint:endpoints[0],keys}],payload,vapid,'invalid topic!',capture),/payload/);
  // AbortSignal.timeout is unref'ed in Node; keep this isolated synthetic request alive.
  const keepalive=setTimeout(()=>{},6000);
  try{
    const timeout=await send([{endpoint:endpoints[0],keys}],payload,vapid,'timeout',async(_endpoint,options)=>new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});}));
    assert.equal(timeout.failed[0].error.name,'TimeoutError');
  }finally{clearTimeout(keepalive);}

  // Send through real fetch/TLS to a synthetic provider. The scoped test dispatcher
  // routes the allowlisted host to our local TLS fixture and verifies its certificate.
  const cert=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem'),'-days','1','-subj','/CN=fcm.googleapis.com','-addext','subjectAltName=DNS:fcm.googleapis.com'],{encoding:'utf8'});assert.equal(cert.status,0,cert.stderr);
  let sinkHits=0,tlsHits=0,tlsPort=0;
  sink=createServer((req,res)=>{sinkHits++;req.resume();res.end('synthetic sink');});await new Promise(r=>sink.listen(0,'127.0.0.1',r));
  tls=createTlsServer({key:readFileSync(join(dir,'key.pem')),cert:readFileSync(join(dir,'cert.pem'))},(req,res)=>{tlsHits++;req.resume();res.writeHead(Number(req.url.split('/').at(-1)),{Location:`http://127.0.0.1:${sink.address().port}/synthetic-internal`});res.end();});await new Promise(r=>tls.listen(0,'127.0.0.1',r));tlsPort=tls.address().port;
  dispatcher=new Agent({connect(options,callback){
    if(options.protocol==='http:'){
      assert.equal(options.hostname,'127.0.0.1');assert.equal(Number(options.port),sink.address().port);
      const socket=tcpConnect({host:'127.0.0.1',port:sink.address().port});socket.once('connect',()=>callback(null,socket));socket.once('error',callback);return;
    }
    assert.equal(options.hostname,'fcm.googleapis.com');
    const socket=tlsConnect({host:'127.0.0.1',port:tlsPort,servername:options.hostname,ca:readFileSync(join(dir,'cert.pem'))});socket.once('secureConnect',()=>callback(null,socket));socket.once('error',callback);
  }});
  const localTransport=(endpoint,options)=>networkFetch(endpoint,{...options,dispatcher});
  for(const status of [301,302,303,307,308]){
    const rejected=await send([{endpoint:`https://fcm.googleapis.com/fcm/send/${status}`,keys}],payload,vapid,'redirect',localTransport);assert.equal(rejected.failed.length,1);assert.equal(rejected.delivered,0);
  }
  assert.equal(tlsHits,5);assert.equal(sinkHits,0,'No redirect may reach a loopback HTTP destination');
  // A default-follow countercheck proves the fixture would reach the sink.
  const followed=await localTransport('https://fcm.googleapis.com/fcm/send/302',{method:'POST',body:'synthetic'});
  assert.equal(followed.status,200);assert.equal(sinkHits,1,'Default-follow countercheck reaches the same synthetic sink');await followed.body.cancel();

  // The same sender runs in workerd with native Web Crypto and native fetch. All
  // outbound requests are handled by this fixture, never by a real push provider.
  await build({stdin:{contents:`import {sendBrowserPushBatch} from './lib/push-delivery';export default {async fetch(request){const mode=new URL(request.url).pathname.slice(1);const endpoint=mode==='invalid'?'https://127.0.0.1/internal':'https://fcm.googleapis.com/fcm/send/'+mode;const result=await sendBrowserPushBatch([{endpoint,keys:${JSON.stringify(keys)}}],${JSON.stringify(payload)},${JSON.stringify(vapid)},'worker');return Response.json({delivered:result.delivered,failed:result.failed.length});}};`,resolveDir:resolve('.'),loader:'ts'},outfile:join(dir,'worker.mjs'),bundle:true,format:'esm',platform:'browser'});
  const workerRequests=[];
  worker=new Miniflare(convertV4MiniflareOptions({modules:true,modulesRoot:dir,scriptPath:join(dir,'worker.mjs'),compatibilityDate:'2026-05-22',outboundService:async request=>{
    assert.equal(new URL(request.url).hostname,'fcm.googleapis.com','A worker redirect must not reach any other host');
    workerRequests.push({endpoint:request.url,body:await request.arrayBuffer(),authorization:request.headers.get('authorization')});
    return request.url.endsWith('/redirect')?new Response(null,{status:302,headers:{Location:'http://127.0.0.1/synthetic-internal'}}):new Response(null,{status:201});
  }}));
  assert.deepEqual(await (await worker.dispatchFetch('http://fixture/success')).json(),{delivered:1,failed:0});
  assert.deepEqual(decryptRecord(workerRequests[0].body),payload,'workerd encryption interoperates with the independent Node receiver');
  verifyVapid(workerRequests[0].endpoint,workerRequests[0].authorization,vapid);
  assert.deepEqual(await (await worker.dispatchFetch('http://fixture/redirect')).json(),{delivered:0,failed:1});
  assert.deepEqual(await (await worker.dispatchFetch('http://fixture/invalid')).json(),{delivered:0,failed:1});
  assert.equal(workerRequests.length,2,'Worker policy rejects invalid stored endpoints and stops redirects before a second request');
  await worker.dispose();worker=null;

  // Exercise the actual registration module's send path, SQL audience, legacy rows,
  // gone pruning and best-effort failures. No global fetch monkeypatch is used.
  sql.exec('DELETE FROM push_subscriptions');
  const insert=(endpoint,user='manager',key=keys)=>sql.prepare('INSERT INTO push_subscriptions VALUES(?,?,?,?,?,?)').run(endpoint,user,key.p256dh,key.auth,'synthetic','synthetic');
  insert('https://127.0.0.1/legacy-internal');insert('https://rebinding.example.invalid/legacy');
  const warnings=[],warn=console.warn;console.warn=(...args)=>warnings.push(args);
  try{
    await dispatch(agent,'synthetic',{company:'Synthetic partner'});assert.equal(transportCalls,0,'Previously stored invalid subscriptions never dispatch');
    const serviceStatuses=[201,404,410,429,503,302];
    for(const status of serviceStatuses)insert(`https://fcm.googleapis.com/fcm/send/status-${status}`);
    insert('https://fcm.googleapis.com/fcm/send/network-error');insert('https://fcm.googleapis.com/fcm/send/malformed-keys','manager',{p256dh:'AAAA',auth:'BBBB'});
    insert('https://fcm.googleapis.com/fcm/send/inactive','inactive');insert('https://fcm.googleapis.com/fcm/send/other-region','other-region');
    const sent=[];
    globalThis.__pushTransport=async(endpoint,options)=>{sent.push(endpoint);assert.equal(options.redirect,'manual');if(endpoint.endsWith('network-error'))throw new TypeError('private endpoint '+endpoint);return new Response('private provider error '+endpoint,{status:Number(endpoint.split('-').at(-1)),headers:{'Retry-After':'2'}});};
    await dispatch(agent,'synthetic',{company:'Synthetic partner'});
    assert.equal(sent.length,7);assert.ok(!sent.some(x=>/legacy|inactive|other-region|malformed/.test(x)));
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%status-404' OR endpoint LIKE '%status-410'").get().n,0,'Gone subscriptions are pruned');
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%status-429'").get().n,1,'Transient failures remain available for a later event');
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint LIKE '%legacy%'").get().n,2,'Rejected stored rows are preserved without use');
    assert.ok(warnings.some(x=>x[1]?.statusCode===429&&x[1]?.retryAfterMs===2000));
    const logs=JSON.stringify(warnings);for(const secret of [keys.p256dh,keys.auth,'https://','private provider','Synthetic partner','network-error'])assert.ok(!logs.includes(secret),'Logs must not contain capability URLs, keys or raw service errors');
  }finally{console.warn=warn;}
  assert.equal(globalThis.fetch,originalFetch,'Push delivery never replaces global fetch');
  console.log('PASS: push endpoint registration/storage policy, atomic cap, RFC8291 vector, independent decryption/VAPID verification, sender limits, Node TLS/workerd redirect refusal, audience selection and sanitized best-effort failure handling.');
}finally{
  await worker?.dispose();
  await dispatcher?.close();tls?.closeAllConnections();sink?.closeAllConnections();
  if(tls)await new Promise(r=>tls.close(r));if(sink)await new Promise(r=>sink.close(r));
  sql.close();rmSync(dir,{recursive:true,force:true});delete globalThis.__pushDb;delete globalThis.__pushTransport;delete globalThis.__pushBeforeRun;
}
