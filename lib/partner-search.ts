import { db, fail } from './server';
import { normalizeCui } from './partner-identity';
import type { PartnerCompany } from './types';

// A bounded, revision-validated, process-local search index. The source CRM
// remains authoritative; no schema changes or private data are published.
type SearchRow = {id:string;name:string|null;cui:string|null};
type IndexedCompany = PartnerCompany & {id:string;foldedNames:string;sortName:string};
type Index = {revision:number;companies:IndexedCompany[]};
let cached:Index|null=null;

const fold=(text:string)=>text.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
const revisionSql='SELECT revision FROM crm_directory_revision WHERE id=1';
const windows=new Map<string,{start:number;count:number}>();
function admit(userId:string){
  const now=Date.now();
  for(const [id,window] of windows)if(now-window.start>=60000)windows.delete(id);
  const window=windows.get(userId)||{start:now,count:0};
  if(window.count>=90||(!windows.has(userId)&&windows.size>=4096))fail(429,'Prea multe căutări. Reîncearcă peste un minut.');
  window.count++;windows.set(userId,window);
}

async function activeCompanies():Promise<IndexedCompany[]>{
  const version=await db().prepare(revisionSql).first<{revision:number}>();
  if(!version)fail(503,'Indexul CRM este indisponibil. Reîncearcă.');
  const revision=Number(version.revision);
  if(cached?.revision===revision)return cached.companies;
  // Project only three fields; no address, contact, phone, mail or portfolio scope
  // ever enters the search cache. Recheck the revision before exposing results.
  const rows=(await db().prepare("SELECT id,coalesce(json_extract(data,'$.name'),'') name,coalesce(json_extract(data,'$.cui'),'') cui FROM customers WHERE active=1").all<SearchRow>()).results;
  const after=await db().prepare(revisionSql).first<{revision:number}>();
  if(Number(after?.revision)!==revision)fail(503,'CRM a fost actualizat în timpul căutării. Reîncearcă.');
  const companies=new Map<string,IndexedCompany>();
  for(const row of rows){
    const cui=normalizeCui(String(row.cui??''));
    const name=String(row.name??'');
    const folded=fold(name),identity=cui?'cui:'+cui:'point:'+row.id;
    const found=companies.get(identity);
    if(found){
      found.pointCount++;
      if(name<found.name){found.name=name;found.sortName=folded;}
      // NUL cannot occur in accepted user search input. It separates names
      // so a query cannot spuriously match across adjacent work points.
      found.foldedNames+='\0'+folded;
    } else companies.set(identity,{id:row.id,name,cui,pointCount:1,foldedNames:folded,sortName:folded});
  }
  const ordered=[...companies.values()].sort((a,b)=>a.sortName.localeCompare(b.sortName,'ro')||a.cui.localeCompare(b.cui)||a.id.localeCompare(b.id));
  cached={revision,companies:ordered};
  return ordered;
}

export async function searchPartnerCompanies(userId:string,raw:string){
  if(raw.length>100||Array.from(raw).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))fail(400,'Căutarea trebuie să aibă maximum 100 de caractere, fără caractere de control.');
  const canonical=normalizeCui(raw);
  const numeric=/^\d+$/.test(canonical);
  const needle=numeric?canonical:fold(raw);
  if(needle.length<3)return {companies:[] as PartnerCompany[],hasMore:false};
  admit(userId);
  const groups=await activeCompanies();
  const matches:PartnerCompany[]=[];
  for(const group of groups){
    if((numeric?group.cui:group.foldedNames).includes(needle)){
      matches.push({name:group.name,cui:group.cui,pointCount:group.pointCount});
      if(matches.length>=21)break;
    }
  }
  return {companies:matches.slice(0,20),hasMore:matches.length>20};
}
