import type {DatabaseSync} from 'node:sqlite';
import {statSync} from 'node:fs';
import {normalizedCui,companyIdentityIndex,type CompanyAlias} from './partner-company-identity';

type ReferencePartner={id:string;cui?:string;historyFranchises?:string[];historyCatalog?:{franchiseCode?:string}};
type Master=CompanyAlias&{Cod_Franciza?:string};
const codeKey=(s:string)=>s.trim().toUpperCase();
/** Resolve legal entities from immutable import reference evidence, never the live catalog.
 * Work-point ambiguity within one firm is harmless at company scope. Disputed identities
 * remain recorded but contribute to neither firm's reliable sums/documents. */
function buildCompanyLinks(c:DatabaseSync,reference:string){
  const ref=c.prepare('SELECT * FROM history_references WHERE id=?').get(reference);
  const master=JSON.parse(String(ref?.master_json||'[]')) as Master[];
  const partnerValue:unknown=JSON.parse(String(ref?.partners_json||'[]'));
  const partnerArray=Array.isArray(partnerValue)?partnerValue:partnerValue&&typeof partnerValue==='object'&&'partners' in partnerValue?partnerValue.partners:undefined;
  if(!Array.isArray(partnerArray))throw new Error('Formatul referinței de parteneri este invalid.');
  const partners=partnerArray as ReferencePartner[];
  const allocations=c.prepare('SELECT i.*,a.* FROM history_identities i JOIN history_allocations a ON a.identity_id=i.id WHERE a.reference_id=?').all(reference);
  const universe=new Set([...master.map(p=>normalizedCui(String(p.CIF||''))),...partners.map(p=>normalizedCui(String(p.cui||''))),...allocations.map(p=>normalizedCui(String(p.client_code||'')))]);
  const index=companyIdentityIndex(master,universe);
  const owners=new Map<string,Set<string>>();
  for(const [company,codes] of index.codesByCompany)for(const code of codes){const set=owners.get(code)||new Set<string>();set.add(company);owners.set(code,set);}
  for(const row of master){const code=normalizedCui(String(row.PartnerCode||'')),company=normalizedCui(String(row.CIF||''));if(!code||!company||code==='CLIENTGEN')continue;const set=owners.get(code)||new Set<string>();set.add(company);owners.set(code,set);}
  const legalCompanies=new Set([...master.map(p=>normalizedCui(String(p.CIF||''))),...partners.map(p=>normalizedCui(String(p.cui||'')))]);
  for(const company of legalCompanies){if(!company||company==='CLIENTGEN')continue;const set=owners.get(company)||new Set<string>();set.add(company);owners.set(company,set);}
  const points=new Map<string,Set<string>>();
  const add=(id:string,company:string)=>{if(!id||!company||company==='CLIENTGEN')return;const set=points.get(id)||new Set<string>();set.add(company);points.set(id,set);};
  for(const p of partners){const company=normalizedCui(String(p.cui||''));add(p.id,company);for(const code of [...p.historyFranchises||[],p.historyCatalog?.franchiseCode||''])add(codeKey(String(code)),company);}
  for(const p of master)add(codeKey(String(p.Cod_Franciza||'')),normalizedCui(String(p.CIF||'')));
  const links:Record<string,string>={},incomplete=new Set(index.ambiguousCompanies),known=new Set<string>(index.ambiguousCompanies);
  const unresolved:{identityId:number;companies:string[];reason:string}[]=[];
  for(const row of allocations){
    if(row.status==='consumer')continue;
    const client=normalizedCui(String(row.client_code||'')),candidates=new Set(owners.get(client)||[]);
    const evidence=new Set(candidates);
    const ids=[...JSON.parse(String(row.partner_ids_json||'[]')),...JSON.parse(String(row.candidates_json||'[]')),String(row.franchise_code||'')];
    for(const id of ids)for(const company of points.get(String(id))||points.get(codeKey(String(id)))||[])evidence.add(company);
    const reason=String(row.reason||'');
    // Explicit mismatch with missing candidate evidence is still unresolved. Multiple
    // master addresses of the SAME firm are not a cross-company conflict.
    const conflict=evidence.size>1||(/conflict|mismatch|ambiguous client/i.test(reason)&&!(reason==='Conflicting master entries for franchise'&&evidence.size===1&&ids.filter(Boolean).every(id=>points.has(String(id))||points.has(codeKey(String(id))))));
    const sole=candidates.size===1?[...candidates][0]:undefined;
    const missingCandidate=row.status==='reconcile'&&ids.filter(Boolean).some(id=>!points.has(String(id))&&!points.has(codeKey(String(id))));
    const unsafe=conflict||!sole||missingCandidate;
    for(const company of evidence)known.add(company);
    if(unsafe){for(const company of evidence)incomplete.add(company);unresolved.push({identityId:Number(row.identity_id),companies:[...evidence].sort(),reason:reason||'Unresolved company evidence'});continue;}
    links[String(row.identity_id)]=sole;
  }
  const identityIdsByCompany=new Map<string,{identity_id:number}[]>(),unresolvedCounts=new Map<string,number>();
  for(const [id,company] of Object.entries(links)){const values=identityIdsByCompany.get(company)||[];values.push({identity_id:Number(id)});identityIdsByCompany.set(company,values);}
  for(const row of unresolved)for(const company of row.companies)unresolvedCounts.set(company,(unresolvedCounts.get(company)||0)+1);
  return {links,incomplete,known,unresolved,identityIdsByCompany,unresolvedCounts,codesByCompany:index.codesByCompany};
}

// One immutable reference index, never cached authorization or mutable catalog membership.
// Both file identity and WAL generation participate; same-reference corrections invalidate it.
type CompanyLinks=ReturnType<typeof buildCompanyLinks>;
let lastIndex:{key:string;value:CompanyLinks}|undefined;
export const companyLinkCacheStats={hits:0,builds:0};
export function companyLinkGeneration(c:DatabaseSync):string|null{
  const file=String(c.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file||'');
  if(!file)return null;
  try{return file+'|'+['','-wal'].map(suffix=>{try{const s=statSync(file+suffix,{bigint:true});return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(':');}catch{if(!suffix)throw new Error('Source unavailable');return '-';}}).join('|');}catch{return null;}
}
export function historyCompanyLinks(c:DatabaseSync,reference:string,expectedGeneration=companyLinkGeneration(c)):CompanyLinks{
  const generation=companyLinkGeneration(c),key=expectedGeneration&&generation===expectedGeneration?generation+'|'+reference:null;
  if(key&&lastIndex?.key===key){companyLinkCacheStats.hits++;return lastIndex.value;}
  companyLinkCacheStats.builds++;const result=buildCompanyLinks(c,reference);
  if(key&&generation===companyLinkGeneration(c)&&Object.keys(result.links).length<=200000)lastIndex={key,value:result};
  return result;
}
