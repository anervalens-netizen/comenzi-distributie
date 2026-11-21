import type {DatabaseSync} from 'node:sqlite';
import {assignedActivationCounty,vodafoneEligibility} from './distribution-rules';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport,ActivationPartner} from './activation-types';
import {activationPartnerSummary} from './activation-partner-summary';
import {consumerAccountCodes,isConsumerAccountCode} from './partner-company-identity';
import {personalSalesPortfolioAccount,portfolioPlaceholder} from './activation-portfolio';
import {activationTodayWindow} from './activation-partner-sort';
const consumerCodesSql = consumerAccountCodes.map(code => `'${code}'`).join(',');
const consumerAccount = `client_code IN (${consumerCodesSql})`;
const start=(asOf:string,days:number)=>new Date(Date.parse(asOf+'T12:00:00Z')-(days-1)*86400000).toISOString().slice(0,10);
/** Source keys reuse client-sales CIF/franchise conventions; names never join points. */
export function activationPartnerView(db:DatabaseSync,result:ActivationReport,where:string,args:(string|number)[],query:ActivationQuery){
 if(!query.view)return;
 const monthWhere=query.months.length?`month IN (${query.months.map(()=>'?').join(',')})`:'0';
 const periodWhere=where+' AND '+monthWhere,periodArgs=[...args,...query.months];
 const asOf=result.latestDate;
 const windows=[7,14,30].map(d=>asOf?start(asOf,d):'9999-12-31');
 const recentSql=windows.map((_,i)=>`SUM(CASE WHEN activation_date>=? AND activation_date<=? THEN 1 ELSE 0 END) r${i}`).join(',');
 const recentArgs=windows.flatMap(d=>[d,asOf||'0000-01-01']);
 // Personal sales are valid activations, not commercial points. Missing point
 // identities group only by existing source identity and seller, never by name.
 const keySql=`CASE WHEN ${consumerAccount} THEN 'generic:'||json_array(company,site) WHEN point_key<>'' THEN point_key ELSE 'unassigned:'||json_array(company,client_code,point_code,site) END`;
 if(query.view==='partners'){
   const today=query.todayWindow||activationTodayWindow();
   const todayRows=db.prepare(`SELECT ${keySql} key,company,client_code clientCode,point_code pointCode,MIN(label) label,MIN(site) siteCode,MAX(point_key<>'') identified,COUNT(*) total,MAX(activation_date) lastDate FROM details WHERE ${where} AND activation_date>=? AND activation_date<=? GROUP BY ${keySql}`).all(...args,today.from,today.to);
   const todayByKey=new Map(todayRows.map(r=>[String(r.key),Number(r.total)]));
   const rows=db.prepare(`SELECT ${keySql} key,company,client_code clientCode,point_code pointCode,MIN(label) label,MIN(site) siteCode,MAX(point_key<>'') identified,COUNT(*) total,MAX(activation_date) lastDate FROM details WHERE ${periodWhere} GROUP BY ${keySql} ORDER BY total DESC,key`).all(...periodArgs);
   // At a month boundary, a point may have recent activations but none in the
   // selected months. Retain that identity without inflating its period total.
   const periodKeys=new Set(rows.map(r=>String(r.key)));
   for(const row of todayRows)if(!periodKeys.has(String(row.key)))rows.push({...row,total:0});
   const recentRows=db.prepare(`SELECT ${keySql} key,${recentSql} FROM details WHERE ${where} AND activation_date>=? AND activation_date<=? GROUP BY ${keySql}`).all(...recentArgs,...args,windows[2],asOf||'0000-01-01');
   const recentByKey=new Map(recentRows.map(r=>[String(r.key),r]));
   const points=new Map<string,ActivationPartner>(),represented=new Set<string>();
   const portfolioIndex=new Map<string,NonNullable<ActivationQuery['portfolio']>>();
   for(const p of query.portfolio||[])for(const code of p.codes){const key=JSON.stringify([p.client,code]);portfolioIndex.set(key,[...(portfolioIndex.get(key)||[]),p]);}
   for(const r of rows){
     const recent=recentByKey.get(String(r.key));
     const kind=isConsumerAccountCode(String(r.clientCode))?'generic':r.identified?'point':'unresolved';
     const matches=kind==='point'?portfolioIndex.get(JSON.stringify([r.clientCode,r.pointCode]))||[]:[];
     const p=matches.length===1?matches[0]:undefined;if(p)represented.add(p.id);
     points.set(String(r.key),{key:String(r.key),company:String(r.company),clientCode:kind==='generic'?'CLIENTGEN':String(r.clientCode),pointCode:kind==='generic'?'':String(r.pointCode),label:kind==='generic'?'Persoane fizice / CLIENTGEN':kind==='unresolved'?'Activări fără punct identificat':p?.name||String(r.label),siteCode:kind==='point'?undefined:String(r.siteCode),portfolioId:p?.id,total:Number(r.total),lastDate:r.lastDate?String(r.lastDate):null,recent:{'7':Number(recent?.r0||0),'14':Number(recent?.r1||0),'30':Number(recent?.r2||0)},kind});
   }
   // Current authorized portfolio points with no selected activations remain visible at the end.
   const placeholders=query.combinedPartnerRows && !query.q ? [] : query.portfolio||[];
   for(const p of placeholders){
     if(represented.has(p.id))continue;
     if(personalSalesPortfolioAccount(p))continue;
     const placeholder=portfolioPlaceholder(p);
     points.set(placeholder.key,placeholder);
   }
   for(const p of points.values())p.recentToday=todayByKey.get(p.key)||0;
   const q=(query.q||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
   const searchConsumer=isConsumerAccountCode(q);
   const all=[...points.values()].filter(p=>!q||(searchConsumer && p.kind==='generic')||[p.label,p.clientCode,p.pointCode].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().includes(q));
   if(query.combinedPartnerRows){
     // The combined reader sorts after merging operators.
     result.partners={...activationPartnerSummary(all),rows:all,total:all.length,page:0,hasMore:false,asOf};
     return;
   }
   all.sort((a,b)=>b.total-a.total||a.key.localeCompare(b.key));
   const page=query.page||0;result.partners={...activationPartnerSummary(all),rows:query.allPartners?all:all.slice(page*50,(page+1)*50),total:all.length,page,hasMore:(page+1)*50<all.length,asOf};
   return;
 }
 // Keep exact point and unresolved identities searchable by their existing indexes.
 let selection='0';
 let selectionIndex='';
 let selectedArgs:string[]=[];
 if(query.point){
   if(query.point.startsWith('unresolved:')){selection="id=? AND point_key=''";selectedArgs=[query.point.slice('unresolved:'.length)];}
   else if(query.point.startsWith('generic:')||query.point.startsWith('unassigned:')){
     const generic=query.point.startsWith('generic:');
     let identity:string[];
     try{const value=JSON.parse(query.point.slice(generic?'generic:'.length:'unassigned:'.length));if(!Array.isArray(value)||value.length!==(generic?2:4)||value.some(v=>typeof v!=='string'))throw new Error();identity=value;}catch{throw new Error('Invalid activation group');}
     selection=generic?`company=? AND ${consumerAccount} AND site=?`:"company=? AND client_code=? AND point_code=? AND site=? AND point_key='' AND client_code<>'CLIENTGEN'";
     selectedArgs=identity;
     selectionIndex='detail_company_scope';
   }
   else if(!query.point.startsWith('portfolio:')){selection=`point_key=? AND NOT (${consumerAccount})`;selectionIndex='detail_point';selectedArgs=[query.point];}
 }else if(query.company){
   try{const v=JSON.parse(query.company);if(!Array.isArray(v)||v.length!==2||v.some(v=>typeof v!=='string'))throw new Error();selectedArgs=v;}catch{throw new Error('Invalid company selection');}
   if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='detail_company_scope'").get())throw new Error('Company projection index requires rebuild');
   if(isConsumerAccountCode(selectedArgs[1])){
     selection=`company=? AND ${consumerAccount}`;selectedArgs=[selectedArgs[0]];
   }else selection='company=? AND client_code=?';
   selectionIndex='detail_company_scope';
 }
 // LIMIT/order must not make SQLite choose an operator-wide date index and
 // scan unrelated partners before finding this identity.
 const selectedTable='details'+(selectionIndex?' INDEXED BY '+selectionIndex:'');
 const selectedWhere=periodWhere+' AND '+selection,selected=[...periodArgs,...selectedArgs];
 const stats=db.prepare(`SELECT COUNT(*) total,MAX(activation_date) lastDate,${recentSql} FROM ${selectedTable} WHERE ${selectedWhere}`).get(...recentArgs,...selected)!;
 const recent=db.prepare(`SELECT MAX(activation_date) lastDate,${recentSql} FROM ${selectedTable} WHERE ${where} AND ${selection}`).get(...recentArgs,...args,...selectedArgs)!;
 const page=query.page||0;
 const rows=db.prepare(`SELECT id,activation_date date,item_type itemType,county,handset,contradictory,site,client_code,reasons FROM ${selectedTable} WHERE ${selectedWhere} ORDER BY activation_date DESC,id LIMIT 50 OFFSET ?`).all(...selected,page*50);
 result.detail={rows:rows.map(r=>{
   const a=query.rules.assignments.find(a=>a.siteCode.toUpperCase()===String(r.site).toUpperCase());
   const e=vodafoneEligibility(String(r.county),String(r.handset),a?.territoryId||null,!!r.contradictory);
   const consumerOutside=result.provider==='vodafone'&&isConsumerAccountCode(String(r.client_code))&&!assignedActivationCounty(String(r.county),a);
   if(consumerOutside)e.reasons.push('unconfirmed_agent_county');
   return {id:String(r.id),date:String(r.date),itemType:String(r.itemType),county:String(r.county),handset:String(r.handset),eligible:result.provider==='vodafone'?e.eligible&&!consumerOutside:null,reasons:[...new Set([...JSON.parse(String(r.reasons)),...(result.provider==='vodafone'?e.reasons:[])])]};
 }),total:Number(stats.total),page,hasMore:(page+1)*50<Number(stats.total),lastDate:recent.lastDate?String(recent.lastDate):null,recent:{'7':Number(recent.r0||0),'14':Number(recent.r1||0),'30':Number(recent.r2||0)},asOf};
}
