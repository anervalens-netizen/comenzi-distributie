import type {DatabaseSync} from 'node:sqlite';
import {vodafoneEligibility} from './distribution-rules';
import type {ActivationQuery} from './activation-distribution';
import type {ActivationReport,ActivationPartner} from './activation-types';
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
 const keySql="CASE WHEN point_key<>'' THEN point_key ELSE 'unresolved:'||id END";
 if(query.view==='partners'){
   const rows=db.prepare(`SELECT ${keySql} key,company,client_code clientCode,point_code pointCode,MIN(label) label,COUNT(*) total,MAX(activation_date) lastDate,${recentSql} FROM details WHERE ${periodWhere} GROUP BY ${keySql},company,client_code,point_code ORDER BY total DESC,key`).all(...recentArgs,...periodArgs);
   const recentRows=db.prepare(`SELECT ${keySql} key,${recentSql} FROM details WHERE ${where} AND activation_date>=? AND activation_date<=? GROUP BY ${keySql}`).all(...recentArgs,...args,windows[2],asOf||'0000-01-01');
   const recentByKey=new Map(recentRows.map(r=>[String(r.key),r]));
   const points=new Map<string,ActivationPartner>(),represented=new Set<string>();
   const portfolioIndex=new Map<string,NonNullable<ActivationQuery['portfolio']>>();
   for(const p of query.portfolio||[])for(const code of p.codes){const key=JSON.stringify([p.client,code]);portfolioIndex.set(key,[...(portfolioIndex.get(key)||[]),p]);}
   for(const r of rows){
     const recent=recentByKey.get(String(r.key));
     const matches=portfolioIndex.get(JSON.stringify([r.clientCode,r.pointCode]))||[];
     const p=matches.length===1?matches[0]:undefined;if(p)represented.add(p.id);
     points.set(String(r.key),{key:String(r.key),company:String(r.company),clientCode:String(r.clientCode),pointCode:String(r.pointCode),label:p?.name||String(r.label),portfolioId:p?.id,total:Number(r.total),lastDate:r.lastDate?String(r.lastDate):null,recent:{'7':Number(recent?.r0||0),'14':Number(recent?.r1||0),'30':Number(recent?.r2||0)},kind:r.clientCode==='CLIENTGEN'?'generic':r.pointCode&&r.clientCode?'point':'unresolved'});
   }
   // Current authorized portfolio points with no selected activations remain visible at the end.
   for(const p of query.portfolio||[]){
     if(represented.has(p.id))continue;
     const key='portfolio:'+p.id;
     points.set(key,{key,company:'',clientCode:p.client,pointCode:p.codes.length===1?p.codes[0]:'',label:p.name,portfolioId:p.id,total:0,lastDate:null,recent:{'7':0,'14':0,'30':0},kind:p.codes.length===1?'point':'unresolved'});
   }
   const q=(query.q||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
   const all=[...points.values()].filter(p=>!q||[p.label,p.clientCode,p.pointCode].join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().includes(q)).sort((a,b)=>b.total-a.total||a.key.localeCompare(b.key));
   const page=query.page||0;result.partners={rows:query.allPartners?all:all.slice(page*50,(page+1)*50),total:all.length,page,hasMore:(page+1)*50<all.length,asOf};
   return;
 }
 const selection=query.point?`(${keySql})=?`:query.company?'company=? AND client_code=?':'0';
 let selectedArgs:string[]=[];
 if(query.point)selectedArgs=[query.point];
 else if(query.company){try{const v=JSON.parse(query.company);if(!Array.isArray(v)||v.length!==2||v.some(v=>typeof v!=='string'))throw new Error();selectedArgs=v;}catch{throw new Error('Invalid company selection');}}
 const selectedWhere=periodWhere+' AND '+selection,selected=[...periodArgs,...selectedArgs];
 const stats=db.prepare(`SELECT COUNT(*) total,MAX(activation_date) lastDate,${recentSql} FROM details WHERE ${selectedWhere}`).get(...recentArgs,...selected)!;
 const recent=db.prepare(`SELECT MAX(activation_date) lastDate,${recentSql} FROM details WHERE ${where} AND ${selection}`).get(...recentArgs,...args,...selectedArgs)!;
 const page=query.page||0;
 const rows=db.prepare(`SELECT id,activation_date date,item_type itemType,county,handset,contradictory,site,reasons FROM details WHERE ${selectedWhere} ORDER BY activation_date DESC,id LIMIT 50 OFFSET ?`).all(...selected,page*50);
 result.detail={rows:rows.map(r=>{
   const a=query.rules.assignments.find(a=>a.siteCode.toUpperCase()===String(r.site).toUpperCase());
   const e=vodafoneEligibility(String(r.county),String(r.handset),a?.territoryId||null,!!r.contradictory);
   return {id:String(r.id),date:String(r.date),itemType:String(r.itemType),county:String(r.county),handset:String(r.handset),eligible:result.provider==='vodafone'?e.eligible:null,reasons:[...new Set([...JSON.parse(String(r.reasons)),...(result.provider==='vodafone'?e.reasons:[])])]};
 }),total:Number(stats.total),page,hasMore:(page+1)*50<Number(stats.total),lastDate:recent.lastDate?String(recent.lastDate):null,recent:{'7':Number(recent.r0||0),'14':Number(recent.r1||0),'30':Number(recent.r2||0)},asOf};
}
