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
type Observation={serial:string;activation_date:string};
type Movement={serial:string;site:string;is_tr:number};
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
 const uniqueCompanies=new Map<string,string|null>();
 for(const company of companies){
  const key=canonical(company);
  uniqueCompanies.set(key,uniqueCompanies.has(key)?null:company);
 }
 const observed=source.prepare(
  "SELECT DISTINCT serial,activation_date FROM activation_observations "+
  "WHERE import_id=? AND activation_date>=? AND activation_date<? AND serial<>''"
 );
 const commercial=source.prepare(
  "SELECT m.imei AS serial,m.site,m.is_tr FROM json_each(?) wanted "+
  "CROSS JOIN activation_effective_movements m INDEXED BY effective_imei "+
  "WHERE m.company=? AND m.provider='digi' AND m.imei=wanted.value"
 );
 const seen=new Set<string>(),sites=new Map<string,number>();
 const monthly:DigiOperatorReported['monthly']=[];
 let sourceThrough:string|null=null,total=0,matchedTR=0,otherChannels=0,noCommercialMatch=0,unattributedTR=0;
 for(const month of months){
  const start=month+'-01',end=endOfMonth(month);
  // Each covered day belongs to the highest-priority snapshot covering it.
  // A later disjoint period therefore cannot erase an earlier period.
  const byCompany=new Map<string,Map<string,ImportRow>>();
  for(const file of files){
   if(file.period_end<start||file.period_start>end)continue;
   const key=canonical(file.company);
   const days=byCompany.get(key)??new Map<string,ImportRow>();
   byCompany.set(key,days);
   for(let day=1;day<=Number(end.slice(-2));day++){
    const date=month+'-'+String(day).padStart(2,'0');
    if(date<file.period_start||date>file.period_end)continue;
    const previous=days.get(date);
    if(!previous||newer(file,previous)>0)days.set(date,file);
   }
  }
  if(!byCompany.size)continue;
  const serialOwners=new Map<string,Set<string>>();
  for(const days of byCompany.values())for(const file of new Set(days.values())){
   if(!sourceThrough||file.period_end>sourceThrough)sourceThrough=file.period_end;
   for(const row of observed.all(file.id,start,nextMonth(month)) as unknown as Observation[]){
    if(days.get(row.activation_date)!==file)continue;
    let owners=serialOwners.get(row.serial);
    if(!owners){owners=new Set();serialOwners.set(row.serial,owners);}
    owners.add(canonical(file.company));
   }
  }
  let monthTR=0,monthOther=0,monthMissing=0;
  // The company/provider/IMEI index is probed in one statement per company.
  // A month is also the unit of deduplication and reporting.
  const serials=JSON.stringify([...serialOwners.keys()]);
  const matched=new Map<string,{sites:Set<string>;missingSite:boolean}>();
  for(const company of companies){
   const owner=canonical(company);
   const unique=uniqueCompanies.get(owner)===company;
   for(const row of commercial.all(serials,company) as unknown as Movement[]){
    let match=matched.get(row.serial);
    if(!match){
     match={sites:new Set(),missingSite:false};
     matched.set(row.serial,match);
    }
    if(row.is_tr===1&&unique&&serialOwners.get(row.serial)?.has(owner)){
     if(row.site)match.sites.add(row.site);
     else match.missingSite=true;
    }
   }
  }
  for(const serial of serialOwners.keys()){
   if(seen.has(serial))throw new Error('Digi ICCID reported in multiple activation months');
   seen.add(serial);
   if(!/^[0-9]{19}$/.test(serial))throw new Error('Invalid Digi ICCID in certified operator observations');
   const match=matched.get(serial);
   if(match&&(match.sites.size||match.missingSite)){
    monthTR++;matchedTR++;
    if(match.sites.size===1&&!match.missingSite){
     const site=[...match.sites][0];
     sites.set(site,(sites.get(site)||0)+1);
    }else unattributedTR++;
   }else if(match){monthOther++;otherChannels++;}
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
