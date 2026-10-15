import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdirSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
const folder=process.cwd()+'/work/usage-unit';rmSync(folder,{recursive:true,force:true});mkdirSync(folder,{recursive:true});process.env.MOBIUP_DATA_DIR=folder;
async function load(path){const result=await build({entryPoints:[path],bundle:true,platform:'node',format:'esm',write:false});return import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));}
const {UsageTimeline}=await load('lib/usage-client.ts'),{parseUsagePulse,unionIntervals,intervalDuration}=await load('lib/usage-model.ts'),store=await load('lib/usage-store-node.ts');
const timeline=new UsageTimeline(0,true);
for(let t=30000;t<=180000;t+=30000)timeline.sample(t);
const spans=timeline.take(180000);assert.equal(spans.filter(s=>s.active).reduce((n,s)=>n+s.from-s.to,0),30000);assert.equal(spans.filter(s=>!s.active).reduce((n,s)=>n+s.from-s.to,0),60000,'idle time stops after 120 seconds and queue is bounded');
timeline.visibility(180000,false);timeline.sample(210000);assert.deepEqual(timeline.take(210000),[],'hidden time excluded');timeline.visibility(210000,true);timeline.interact(210000);timeline.sample(240000);assert.equal(timeline.take(240000)[0].active,true);timeline.sample(360000);assert.deepEqual(timeline.take(360000),[],'suspension gap excluded');
assert.deepEqual(unionIntervals([[10,20],[0,10],[5,15],[30,40]]),[[0,20],[30,40]]);assert.equal(intervalDuration(unionIntervals([[0,20],[10,30]])),30);
const base=Date.now(),id=randomUUID(),pulse={owner:'test-agent',id,seq:1,screen:'orders',closed:false,spans:[{from:30000,to:0,active:true}]};assert(parseUsagePulse(pulse));for(const invalid of [{...pulse,seq:-1},{...pulse,spans:[{from:1e20,to:0,active:true}]},{...pulse,screen:'sensitive free text'},{...pulse,spans:[{from:30,to:10,active:true},{from:20,to:0,active:false}]}])assert.equal(parseUsagePulse(invalid),null);
assert(store.recordUsageAuth('test-agent','auth-a','login','192.0.2.1','Synthetic browser',base));assert(store.recordUsagePulse('test-agent','auth-a',pulse,'192.0.2.1','Synthetic browser',base));
assert(store.recordUsagePulse('test-agent','auth-a',pulse,'192.0.2.1','Synthetic browser',base+1000));
assert(store.recordUsagePulse('test-agent','auth-a',{...pulse,id:randomUUID()},'192.0.2.2','Synthetic browser',base));
const day=store.usageDay(base);let result=store.readUsage(day,day,['test-agent'],'test-agent',base-3600000,base+3600000);assert.equal(result.days[0].visible_ms,30000,'overlapping devices unioned');assert.equal(result.days[0].active_ms,30000);assert.equal(result.days[0].opens,2);assert.equal(result.logins['test-agent'],1);
store.recordUsagePulse('test-agent','auth-a',{...pulse,seq:2,spans:[{from:30000,to:0,active:false}]},'', '',base+30000);
store.recordUsagePulse('test-agent','wrong-auth',{...pulse,seq:3},'', '',base+60000);
result=store.readUsage(day,day,['test-agent'],'test-agent',base-3600000,base+3600000);assert.equal(result.days[0].visible_ms,60000);assert.equal(result.days[0].active_ms,30000,'idle not counted as active');
store.recordUsageAuth('test-agent','auth-a','logout','','',base+60000);store.recordUsagePulse('test-agent','auth-a',{...pulse,seq:4},'','',base+90000);assert.equal(store.readUsage(day,day,['test-agent'],'test-agent',base-3600000,base+3600000).days[0].visible_ms,60000,'logout closes visit');
const midnight=Date.parse('2026-10-24T21:00:00Z');store.recordUsagePulse('midnight','auth',{...pulse,id:randomUUID(),seq:1},'','',midnight+15000);
const db=new DatabaseSync(folder+'/usage.sqlite');assert.deepEqual(db.prepare("SELECT day,visible_ms FROM usage_days WHERE user_id='midnight' ORDER BY day").all().map(r=>[r.day,r.visible_ms]),[['2026-10-24',15000],['2026-10-25',15000]],'Bucharest midnight splits exactly');
const latency=[];for(let n=0;n<9600;n++){const user='bench-'+n%40;const at=performance.now();store.recordUsagePulse(user,'auth',{...pulse,id:('00000000-0000-4000-8000-'+String(n%40).padStart(12,'0')),seq:Math.floor(n/40)+1},'','',base+Math.floor(n/40)*30000);latency.push(performance.now()-at);}
latency.sort((a,b)=>a-b);const reportStart=performance.now();store.readUsage(day,day,Array.from({length:40},(_,i)=>'bench-'+i),undefined,base-1,base+86400000);const reportMs=performance.now()-reportStart;
assert(latency[9500]<50,'pulse p99 budget');assert(reportMs<1000,'report budget');
process.env.MOBIUP_USAGE_DISABLED='1';assert.equal(store.recordUsagePulse('test-agent','auth',pulse,'',''),false);assert.equal(store.recordUsageAuth('test-agent','auth','login','',''),false);assert.throws(()=>store.readUsage(day,day,[],undefined,0,base));delete process.env.MOBIUP_USAGE_DISABLED;
// Holds a real SQLite writer lock: analytics fails fast rather than blocking work.
db.exec('BEGIN IMMEDIATE');const busyStart=performance.now();assert.equal(store.recordUsagePulse('busy','auth',{...pulse,id:randomUUID()},'',''),false);assert(performance.now()-busyStart<500);db.exec('ROLLBACK');db.close();
console.log(JSON.stringify({status:'PASS',checks:'visibility, idle, suspend, overlap, dedupe, identity, midnight, disabled, busy, bounded validation',pulses:latency.length,pulseP99Ms:latency[9500],reportMs}));
