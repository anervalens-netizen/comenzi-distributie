import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,chmodSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {unionIntervals,intervalDuration,USAGE_RETENTION_DAYS,type Interval,type UsagePulse,type UsageSnapshot,type UsageDay,type UsageVisit,type UsageAuth} from './usage-model';

const dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});
export const usageDay=(at:number)=>dayFormat.format(at);
let connection:DatabaseSync|undefined,disabledUntil=0,prunedDay='';
function database(now=Date.now()) {
  if(process.env.MOBIUP_USAGE_DISABLED==='1')throw new Error('Usage disabled');
  if(now<disabledUntil)throw new Error('Usage unavailable');
  if(connection)return connection;
  const directory=resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data');
  mkdirSync(directory,{recursive:true,mode:0o700});
  const db=new DatabaseSync(resolve(directory,'usage.sqlite'));
  try{
    chmodSync(resolve(directory,'usage.sqlite'),0o600);
    // A busy analytics database must never hold up a business request.
    db.exec('PRAGMA busy_timeout=25; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    db.exec(`CREATE TABLE IF NOT EXISTS usage_meta(id INTEGER PRIMARY KEY CHECK(id=1),since INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_days(user_id TEXT NOT NULL,day TEXT NOT NULL,visible TEXT NOT NULL,active TEXT NOT NULL,visible_ms INTEGER NOT NULL,active_ms INTEGER NOT NULL,opens INTEGER NOT NULL,last_seen INTEGER NOT NULL,PRIMARY KEY(day,user_id));
      CREATE TABLE IF NOT EXISTS usage_visits(user_id TEXT NOT NULL,id TEXT NOT NULL,auth_id TEXT NOT NULL,started_at INTEGER NOT NULL,last_seen INTEGER NOT NULL,seq INTEGER NOT NULL,ip TEXT NOT NULL,device TEXT NOT NULL,screen TEXT NOT NULL,visible_ms INTEGER NOT NULL,active_ms INTEGER NOT NULL,closed_at INTEGER,PRIMARY KEY(user_id,id));
      CREATE INDEX IF NOT EXISTS usage_visits_seen ON usage_visits(last_seen);
      CREATE INDEX IF NOT EXISTS usage_visits_auth ON usage_visits(auth_id);
      CREATE TABLE IF NOT EXISTS usage_auth(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,auth_id TEXT NOT NULL,event TEXT NOT NULL,at INTEGER NOT NULL,ip TEXT NOT NULL,device TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_auth_at ON usage_auth(at);
      CREATE INDEX IF NOT EXISTS usage_auth_user ON usage_auth(user_id,at);`);
    db.prepare('INSERT OR IGNORE INTO usage_meta VALUES(1,?)').run(now);
    connection=db;return db;
  }catch(error){db.close();disabledUntil=now+60_000;throw error;}
}
function prune(db:DatabaseSync,now:number){
  const today=usageDay(now);if(prunedDay===today)return;
  const cutoff=now-USAGE_RETENTION_DAYS*86400000;
  db.prepare('DELETE FROM usage_days WHERE day<?').run(usageDay(cutoff));
  db.prepare('DELETE FROM usage_visits WHERE last_seen<?').run(cutoff);
  db.prepare('DELETE FROM usage_auth WHERE at<?').run(cutoff);
  prunedDay=today;
}
export function recordUsageAuth(userId:string,authId:string,event:'login'|'logout',ip:string,device:string,now=Date.now()){
  try{
    const db=database(now);prune(db,now);
    db.prepare('INSERT INTO usage_auth VALUES(?,?,?,?,?,?,?)').run(randomUUID(),userId,authId,event,now,ip,device);
    if(event==='logout')db.prepare('UPDATE usage_visits SET closed_at=? WHERE auth_id=? AND closed_at IS NULL').run(now,authId);
    return true;
  }catch{return false;}
}
function splitDays(intervals:Interval[]){
  const groups=new Map<string,Interval[]>();
  for(const [start,end] of intervals){
    // Pulses contain at most 90 seconds. Binary search the rare midnight split,
    // using the timezone itself so DST needs no assumed 24-hour day.
    const day=usageDay(start);let boundary=end;
    if(day!==usageDay(end-1)){
      let lo=start,hi=end;while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(usageDay(mid)===day)lo=mid;else hi=mid;}boundary=hi;
    }
    groups.set(day,[...(groups.get(day)||[]),[start,boundary]]);
    if(boundary<end){const next=usageDay(boundary);groups.set(next,[...(groups.get(next)||[]),[boundary,end]]);}
  }
  return groups;
}
export function recordUsagePulse(userId:string,authId:string,pulse:UsagePulse,ip:string,device:string,now=Date.now()){
  try{
    const db=database(now);prune(db,now);
    db.exec('BEGIN IMMEDIATE');
    try{
      const old=db.prepare('SELECT * FROM usage_visits WHERE user_id=? AND id=?').get(userId,pulse.id);
      if(old && (old.auth_id!==authId || Number(old.seq)>=pulse.seq || old.closed_at!==null)){db.exec('COMMIT');return true;}
      // At most one normal pulse / 5 seconds. Close events still flush promptly.
      if(old && now-Number(old.last_seen)<5000 && !pulse.closed){db.exec('COMMIT');return true;}
      if(!old && Number(db.prepare('SELECT COUNT(*) n FROM usage_visits WHERE user_id=? AND started_at>?').get(userId,now-3600000)?.n)>120){db.exec('COMMIT');return false;}
      const floor=old?Number(old.last_seen):now-90_000;
      const visible=unionIntervals(pulse.spans.map(s=>[Math.max(floor,now-Math.round(s.from)),now-Math.round(s.to)] as Interval));
      const active=unionIntervals(pulse.spans.filter(s=>s.active).map(s=>[Math.max(floor,now-Math.round(s.from)),now-Math.round(s.to)] as Interval));
      const byDay=splitDays(visible),activeByDay=splitDays(active),today=usageDay(now);
      if(!byDay.has(today))byDay.set(today,[]);
      for(const [day,spans] of byDay){
        const previous=db.prepare('SELECT visible,active,opens FROM usage_days WHERE day=? AND user_id=?').get(day,userId);
        const v=unionIntervals([...JSON.parse(String(previous?.visible||'[]')),...spans]);
        const a=unionIntervals([...JSON.parse(String(previous?.active||'[]')),...(activeByDay.get(day)||[])]);
        if(v.length>4096||a.length>4096)throw new Error('Usage interval budget exceeded');
        db.prepare(`INSERT INTO usage_days VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(day,user_id) DO UPDATE SET visible=excluded.visible,active=excluded.active,visible_ms=excluded.visible_ms,active_ms=excluded.active_ms,opens=excluded.opens,last_seen=excluded.last_seen`).run(userId,day,JSON.stringify(v),JSON.stringify(a),intervalDuration(v),intervalDuration(a),Number(previous?.opens||0)+(!old&&day===today?1:0),now);
      }
      db.prepare(`INSERT INTO usage_visits VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET last_seen=excluded.last_seen,seq=excluded.seq,ip=excluded.ip,screen=excluded.screen,visible_ms=excluded.visible_ms,active_ms=excluded.active_ms,closed_at=excluded.closed_at`).run(userId,pulse.id,authId,old?Number(old.started_at):visible[0]?.[0]??now,now,pulse.seq,ip,device,pulse.screen,Number(old?.visible_ms||0)+intervalDuration(visible),Number(old?.active_ms||0)+intervalDuration(active),pulse.closed?now:null);
      db.exec('COMMIT');return true;
    }catch(error){db.exec('ROLLBACK');throw error;}
  }catch{return false;}
}
export function readUsage(from:string,to:string,userIds:string[],detailId:string|undefined,fromAt:number,toAt:number):UsageSnapshot {
  const db=database();prune(db,Date.now());
  const allowed=new Set(userIds);
  const days=(db.prepare('SELECT user_id,day,visible_ms,active_ms,opens,last_seen FROM usage_days WHERE day>=? AND day<=?').all(from,to) as UsageDay[]).filter(r=>allowed.has(r.user_id));
  const logins:Record<string,number>={};
  for(const row of db.prepare("SELECT user_id,COUNT(*) n FROM usage_auth WHERE event='login' AND at>=? AND at<? GROUP BY user_id").all(fromAt,toAt))if(allowed.has(String(row.user_id)))logins[String(row.user_id)]=Number(row.n);
  const visits=detailId?(db.prepare('SELECT id,user_id,started_at,last_seen,ip,device,screen,visible_ms,active_ms,closed_at FROM usage_visits WHERE user_id=? AND last_seen>=? AND started_at<? ORDER BY last_seen DESC LIMIT 101').all(detailId,fromAt,toAt) as UsageVisit[]):[];
  const events=detailId?(db.prepare('SELECT id,user_id,event,at,ip,device FROM usage_auth WHERE user_id=? AND at>=? AND at<? ORDER BY at DESC LIMIT 101').all(detailId,fromAt,toAt) as UsageAuth[]):[];
  return {since:Number(db.prepare('SELECT since FROM usage_meta WHERE id=1').get()!.since),retentionDays:USAGE_RETENTION_DAYS,days,logins,visits:visits.slice(0,100),events:events.slice(0,100),detailsLimited:visits.length>100||events.length>100};
}
