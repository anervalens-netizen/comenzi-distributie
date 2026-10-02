import type {DatabaseSync} from 'node:sqlite';
import {normalizedCui,companyIdentityIndex,type CompanyAlias} from './partner-company-identity';

type ReferencePartner={id:string;cui?:string;historyFranchises?:string[];historyCatalog?:{franchiseCode?:string}};
type Master=CompanyAlias&{Cod_Franciza?:string};
const codeKey=(s:string)=>s.trim().toUpperCase();
/** Resolve legal entities from immutable import reference evidence, never the live catalog.
 * Work-point ambiguity within one firm is harmless at company scope. Disputed identities
 * remain recorded but contribute to neither firm's reliable sums/documents. */
export function historyCompanyLinks(c:DatabaseSync,reference:string){
  const ref=c.prepare('SELECT * FROM history_references WHERE id=?').get(reference);
  const master=JSON.parse(String(ref?.master_json||'[]')) as Master[];
  const partners=JSON.parse(String(ref?.partners_json||'[]')) as ReferencePartner[];
  const allocations=c.prepare('SELECT i.*,a.* FROM history_identities i JOIN history_allocations a ON a.identity_id=i.id WHERE a.reference_id=?').all(reference);
  const universe=new Set([...master.map(p=>normalizedCui(p.CIF||'')),...partners.map(p=>normalizedCui(p.cui||'')),...allocations.map(p=>normalizedCui(String(p.client_code||'')))]);
  const index=companyIdentityIndex(master,universe);
  const owners=new Map<string,Set<string>>();
  for(const [company,codes] of index.codesByCompany)for(const code of codes){const set=owners.get(code)||new Set<string>();set.add(company);owners.set(code,set);}
  for(const row of master){const code=normalizedCui(row.PartnerCode||''),company=normalizedCui(row.CIF||'');if(!code||!company||code==='CLIENTGEN')continue;const set=owners.get(code)||new Set<string>();set.add(company);owners.set(code,set);}
  const legalCompanies=new Set([...master.map(p=>normalizedCui(p.CIF||'')),...partners.map(p=>normalizedCui(p.cui||''))]);
  for(const company of legalCompanies){if(!company||company==='CLIENTGEN')continue;const set=owners.get(company)||new Set<string>();set.add(company);owners.set(company,set);}
  const points=new Map<string,Set<string>>();
  const add=(id:string,company:string)=>{if(!id||!company||company==='CLIENTGEN')return;const set=points.get(id)||new Set<string>();set.add(company);points.set(id,set);};
  for(const p of partners){const company=normalizedCui(p.cui||'');add(p.id,company);for(const code of [...p.historyFranchises||[],p.historyCatalog?.franchiseCode||''])add(codeKey(code),company);}
  for(const p of master)add(codeKey(String(p.Cod_Franciza||'')),normalizedCui(p.CIF||''));
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
  return {links,incomplete,known,unresolved};
}
