import type {DatabaseSync} from 'node:sqlite';

/** Read-only operator KPI. Never uses an importer row count as a TR sales count. */
export type DigiOperatorReported={
 total:number;
 matchedTR:number;
 otherChannels:number;
 noCommercialMatch:number;
 unattributedTR:number;
 sourceThrough:string|null;
 monthly:{month:string;total:number;matchedTR:number;otherChannels:number;noCommercialMatch:number}[];
 sites:{site:string;total:number}[];
};
type ImportRow={id:number;company:string;source_at:string;period_start:string;period_end:string};
type Observation={serial:string};
type Movement={site:string;is_tr:number};
type Company={company:string};
const MONTH=/^20[0-9]{2}-(0[1-9]|1[0-2])$/;
const canonical=(name:string)=>name.normalize('NFKC').trim().toLowerCase();
function nextMonth(month:string){
 const [year,m]=month.split('-').map(Number);
 return new Date(Date.UTC(year,m,1)).toISOString().slice(0,10);
}
function endOfMonth(month:string){
 const [year,m]=month.split('-').map(Number);
 return new Date(Date.UTC(year,m,0)).toISOString().slice(0,10);
}
function newer(a:ImportRow,b:ImportRow){
 return a.period_end.localeCompare(b.period_end)||
  b.period_start.localeCompare(a.period_start)||
  a.source_at.localeCompare(b.source_at)||
  a.id-b.id;
}

/**
 * The latest operator report for one distributor supersedes overlapping older
 * snapshots; report revisions are never added together. Each operator ICCID
 * is compared to the exact 19-digit IMEI in the commercial Digi ledger.
 *
 * Case differences in the distributor spelling only select the unique matching
 * existing commercial company. They never merge different companies, sources,
 * SIM identifiers, or change the immutable imports.
 *
 * Distinct TR attribution requires one unique sale site; a competing site
 * stays unattributed. Revenue/commission eligibility is not inferred.
 */
export function digiOperatorReported(
 source:DatabaseSync,selectedMonths:string[],
):DigiOperatorReported|null{
 const months=[...new Set(selectedMonths)];
 if(!months.length)return null;
 if(months.some(month=>!MONTH.test(month)))throw new Error('Invalid Digi operator month');
 const files=source.prepare(
  "SELECT id,company,source_at,period_start,period_end "+
  "FROM activation_imports WHERE operator='digi' AND source_kind='operator' "+
  "AND status='complete' AND company<>'' AND period_start<>'' AND period_end<>''"
 ).all() as unknown as ImportRow[];
 if(!files.length)return null;
 const companies=(source.prepare(
  "SELECT DISTINCT company FROM activation_effective_movements WHERE provider='digi'"
 ).all() as unknown as Company[]).map(row=>row.company);
 const observed=source.prepare(
  "SELECT DISTINCT serial FROM activation_observations "+
  "WHERE import_id=? AND activation_date>=? AND activation_date<? AND serial<>''"
 );
 const commercial=source.prepare(
  "SELECT site,is_tr FROM activation_effective_movements INDEXED BY effective_imei "+
  "WHERE company=? AND provider='digi' AND imei=?"
 );
 const seen=new Set<string>(),sites=new Map<string,number>();
 const monthly:DigiOperatorReported['monthly']=[];
 let sourceThrough:string|null=null,total=0,matchedTR=0,otherChannels=0,noCommercialMatch=0,unattributedTR=0;
 for(const month of months){
  const start=month+'-01',end=endOfMonth(month);
  const latest=new Map<string,ImportRow>();
  for(const file of files){
   if(file.period_end<start||file.period_start>end)continue;
   const key=canonical(file.company),previous=latest.get(key);
   if(!previous||newer(file,previous)>0)latest.set(key,file);
  }
  if(!latest.size)continue;
  const serialOwners=new Map<string,Set<string>>();
  for(const file of latest.values()){
   if(!sourceThrough||file.period_end>sourceThrough)sourceThrough=file.period_end;
   for(const row of observed.all(file.id,start,nextMonth(month)) as unknown as Observation[]){
    let owners=serialOwners.get(row.serial);
    if(!owners){owners=new Set();serialOwners.set(row.serial,owners);}
    owners.add(canonical(file.company));
   }
  }
  let monthTR=0,monthOther=0,monthMissing=0;
  for(const [serial,owners] of serialOwners){
   if(seen.has(serial))throw new Error('Digi ICCID reported in multiple activation months');
   seen.add(serial);
   if(!/^[0-9]{19}$/.test(serial))throw new Error('Invalid Digi ICCID in certified operator observations');
   const permitted=new Set<string>();
   for(const owner of owners){
    const exact=companies.filter(company=>canonical(company)===owner);
    if(exact.length===1)permitted.add(exact[0]);
   }
   const siteCandidates=new Set<string>();
   let trWithoutSite=false,hasOtherCommercial=false;
   for(const company of companies){
    for(const row of commercial.all(company,serial) as unknown as Movement[]){
     if(row.is_tr===1&&permitted.has(company)){
      if(row.site)siteCandidates.add(row.site);
      else trWithoutSite=true;
     }else hasOtherCommercial=true;
    }
   }
   if(siteCandidates.size||trWithoutSite){
    monthTR++;matchedTR++;
    if(siteCandidates.size===1&&!trWithoutSite){
     const site=[...siteCandidates][0];
     sites.set(site,(sites.get(site)||0)+1);
    }else unattributedTR++;
   }else if(hasOtherCommercial){monthOther++;otherChannels++;}
   else{monthMissing++;noCommercialMatch++;}
  }
  total+=serialOwners.size;
  monthly.push({month,total:serialOwners.size,matchedTR:monthTR,
   otherChannels:monthOther,noCommercialMatch:monthMissing});
 }
 if(!monthly.length)return null;
 if(total!==matchedTR+otherChannels+noCommercialMatch)throw new Error('Digi operator reconciliation mismatch');
 return {total,matchedTR,otherChannels,noCommercialMatch,unattributedTR,sourceThrough,
  monthly,sites:[...sites].map(([site,count])=>({site,total:count})).sort((a,b)=>b.total-a.total||a.site.localeCompare(b.site))};
}
