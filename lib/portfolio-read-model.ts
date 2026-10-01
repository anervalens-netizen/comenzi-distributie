import {db,fail} from './server';
import {partnerScope,portfolioRowView} from './partner-portfolio';
import {createReadProjectionCache} from './read-projection-cache';
import type {User} from './types';
import type {PartnerSummary} from './partner-map-types';
const normalize=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const cache=createReadProjectionCache();
let updating:Promise<void>|undefined;
export const readModelMetrics={rebuilt:0,batches:0,buildMs:0,queries:0};
export async function portfolioVersion(){return JSON.stringify(await db().prepare('SELECT data_revision,scope_revision FROM portfolio_revision WHERE id=1').first());}
async function rebuild(){
 const start=Date.now();
 const state=await db().prepare('SELECT version FROM portfolio_model_state WHERE id=1').first();
 if(!state){await db().batch([db().prepare('INSERT OR IGNORE INTO portfolio_dirty SELECT id FROM customers'),db().prepare('INSERT OR IGNORE INTO portfolio_model_state VALUES(1,1)')]);}
 for(let batch=0;batch<1000;batch++){
  const ids=(await db().prepare('SELECT id FROM portfolio_dirty ORDER BY id LIMIT 500').all<{id:string}>()).results.map(r=>r.id);if(!ids.length){readModelMetrics.buildMs+=Date.now()-start;return;}
  // Revision fence: external writer changes cannot be removed from dirty tracking.
  const version=await portfolioVersion();
  const rows=(await db().prepare(`SELECT c.id,c.warehouse_id,c.data,'' contact,'' phone,'' email,p.latitude,p.longitude,p.position_source,p.position_accuracy,p.position_provider,p.position_metadata,p.address_fingerprint,p.revision,p.updated_at,(SELECT MAX(v.visited_at) FROM partner_visits v WHERE v.customer_id=c.id) last_visited_at FROM customers c LEFT JOIN partner_profiles p ON p.customer_id=c.id WHERE c.active=1 AND c.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)).all()).results;
  const statements=ids.map(id=>db().prepare('DELETE FROM portfolio_read_rows WHERE id=?').bind(id));
  for(const row of rows){const p=portfolioRowView(row as Parameters<typeof portfolioRowView>[0]);const located=typeof p.latitude==='number'&&Number.isFinite(p.latitude)&&Math.abs(p.latitude)<=90&&typeof p.longitude==='number'&&Number.isFinite(p.longitude)&&Math.abs(p.longitude)<=180;
   const summary:PartnerSummary={id:p.id,warehouseIds:p.warehouseIds,historyCatalog:p.historyCatalog?{kind:p.historyCatalog.kind,franchiseCode:p.historyCatalog.franchiseCode,countySource:p.historyCatalog.countySource}:undefined,name:p.name,cui:p.cui,address:p.address,city:p.city,county:p.county,route:p.route,latitude:located?p.latitude:null,longitude:located?p.longitude:null,positionSource:located?p.positionSource:null,positionQuality:located?p.positionQuality:null,lastVisitedAt:p.lastVisitedAt};
   statements.push(db().prepare('INSERT INTO portfolio_read_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(p.id,JSON.stringify(summary),p.name??null,normalize([p.id,p.name,p.cui,p.city,p.county,p.address].join(' ')),normalize(p.city||''),typeof p.county==='string'?p.county:null,typeof p.city==='string'?p.city:null,typeof p.route==='string'?p.route:null,summary.latitude,summary.longitude,summary.positionSource,p.lastVisitedAt));
  }
  const rev=JSON.parse(version) as {data_revision:number;scope_revision:number};
  statements.push(db().prepare('DELETE FROM portfolio_dirty WHERE id IN (SELECT value FROM json_each(?)) AND (SELECT data_revision FROM portfolio_revision WHERE id=1)=?').bind(JSON.stringify(ids),rev.data_revision));
  await db().batch(statements);readModelMetrics.batches++;readModelMetrics.rebuilt+=ids.length;
 }
 fail(503,'Portofoliul se actualizează. Reîncearcă.');
}
export async function readyReadModel(){if(!updating)updating=rebuild().finally(()=>{updating=undefined;});await updating;}
export function selectedSql(user:User,params:URLSearchParams,warehouseIds?:string[],bbox?:[number,number,number,number]){
 const scope=partnerScope(user),args:(string|number)[]=[...scope.args],where=['c.active=1',scope.sql];
 if(warehouseIds){where.push("EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(c.data,'$.warehouseIds'),json_array(c.warehouse_id))) w WHERE w.value IN (SELECT value FROM json_each(?)))");args.push(JSON.stringify(warehouseIds));}
 for(const key of ['q','county','city','route'])if((params.get(key)?.length||0)>300)fail(400,'Filtrul este prea lung.');
 const q=params.get('q')||'',city=(params.get('city')||'').trim(),county=params.get('county')||'',route=params.get('route')||'',position=params.get('position')||'',days=params.get('days')||'';
 if(!['','yes','no'].includes(position)||!['','never','7','14','30','60','90'].includes(days))fail(400,'Filtrul este invalid.');
 if(q){where.push('instr(m.search,?)>0');args.push(normalize(q));}if(city){where.push('instr(m.city_search,?)>0');args.push(normalize(city));}if(county){where.push('m.county=?');args.push(county);}if(route){where.push('m.route=?');args.push(route);}
 if(position)where.push('m.latitude IS '+(position==='yes'?'NOT ':'')+'NULL');
 if(days==='never')where.push('(m.last_visited_at IS NULL OR m.last_visited_at=\'\')');else if(days){where.push("julianday(m.last_visited_at)<=julianday(?)-?");args.push(new Date().toISOString(),Number(days));}
 if(bbox){where.push(`m.latitude BETWEEN ? AND ? AND ${bbox[0]<=bbox[2]?'m.longitude BETWEEN ? AND ?':'(m.longitude>=? OR m.longitude<=?)'}`);args.push(bbox[1],bbox[3],bbox[0],bbox[2]);}
 return {from:'portfolio_read_rows m JOIN customers c ON c.id=m.id',where:where.join(' AND '),args};
}
export async function selectedSummaries(user:User,params:URLSearchParams,warehouseIds?:string[],bbox?:[number,number,number,number]){
 await readyReadModel();const q=selectedSql(user,params,warehouseIds,bbox);readModelMetrics.queries++;
 return (await db().prepare(`SELECT m.summary FROM ${q.from} WHERE ${q.where} ORDER BY m.name,m.id`).bind(...q.args).all<{summary:string}>()).results.map(r=>JSON.parse(r.summary) as PartnerSummary);
}
export async function pagedBrowse(user:User,params:URLSearchParams,warehouseIds:string[]|undefined,offset:number,limit:number,selectedIds?:string[]){
 await readyReadModel();const version=await portfolioVersion(),key=JSON.stringify([user.id,user.role,user.managerScope,user.warehouseId,warehouseIds,params.toString(),offset,limit]);
 const configuredRevision=JSON.stringify(await db().prepare("SELECT value FROM settings WHERE key='partner-map-style-url'").first());
 const cached=cache.get<import('./partner-map-types').PartnerBrowse>(key,version+configuredRevision);if(cached)return cached;
 const q=selectedSql(user,params,warehouseIds),scope=selectedSql(user,new URLSearchParams(),warehouseIds),county=new URLSearchParams();if(params.get('county'))county.set('county',params.get('county')!);const facets=selectedSql(user,county,warehouseIds);
 if(selectedIds){q.where+=' AND m.id IN (SELECT value FROM json_each(?))';q.args.push(JSON.stringify(selectedIds));}
 const totals=await db().prepare(`SELECT COUNT(*) total,COUNT(m.latitude) located,SUM(CASE WHEN m.position_source='geocoding' THEN 1 ELSE 0 END) geocoded,MIN(m.longitude) west,MIN(m.latitude) south,MAX(m.longitude) east,MAX(m.latitude) north FROM ${q.from} WHERE ${q.where}`).bind(...q.args).first<{total:number;located:number;geocoded:number;west:number|null;south:number|null;east:number|null;north:number|null}>();
 const page=await db().prepare(`SELECT m.summary FROM ${q.from} WHERE ${q.where} ORDER BY m.name,m.id LIMIT ? OFFSET ?`).bind(...q.args,limit,offset).all<{summary:string}>();
 const values=async(field:string,s:typeof q)=>(await db().prepare(`SELECT DISTINCT m.${field} value FROM ${s.from} WHERE ${s.where} AND m.${field} IS NOT NULL AND m.${field}<>''`).bind(...s.args).all<{value:string}>()).results.map(r=>r.value).sort((a,b)=>a.localeCompare(b,'ro'));
 const configured=await db().prepare("SELECT value FROM settings WHERE key='partner-map-style-url'").first<{value:string}>();const styleUrl=configured?.value?.trim()||'https://tiles.openfreemap.org/styles/positron';if(!styleUrl.startsWith('https://')&&!/^\/(?!\/)/.test(styleUrl))fail(500,'Configurația hărții este invalidă.');
 const result:import('./partner-map-types').PartnerBrowse={partners:page.results.map(r=>JSON.parse(r.summary)),total:totals!.total,located:totals!.located,geocoded:totals!.geocoded||0,nextOffset:offset+limit<totals!.total?offset+limit:null,bounds:totals!.west===null?null:[totals!.west,totals!.south!,totals!.east!,totals!.north!],facets:{counties:await values('county',scope),cities:await values('city',facets),routes:await values('route',facets)},styleUrl,observedAt:new Date().toISOString()};
 if(version===await portfolioVersion())cache.put(key,version+configuredRevision,result);return result;
}
