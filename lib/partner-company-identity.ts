export const normalizedCui=(s:string)=>s.toUpperCase().replace(/[^A-Z0-9]/g,'').replace(/^RO/,'');
export type CompanyAlias={CIF?:string;PartnerCode?:string};
/** Shared by detail and batch totals; aliases cannot join different legal entities. */
export function companyIdentityIndex(master:CompanyAlias[],companyKeys:Iterable<string>){
  const owners=new Map<string,Set<string>>();
  for(const row of master){
    const code=normalizedCui(String(row.PartnerCode||'')),owner=normalizedCui(String(row.CIF||''));
    if(!code||!owner)continue;
    const values=owners.get(code)||new Set<string>();values.add(owner);owners.set(code,values);
  }
  const codesByCompany=new Map<string,Set<string>>(),ambiguousCompanies=new Set<string>();
  for(const key of companyKeys){
    if(!key||key==='CLIENTGEN')continue;
    const values=owners.get(key),codes=new Set<string>();
    if(!values||(values.size===1&&values.has(key)))codes.add(key);
    codesByCompany.set(key,codes);
  }
  for(const [code,values] of owners){
    if(values.size===1&&code!=='CLIENTGEN')codesByCompany.get([...values][0])?.add(code);
    else if(values.size>1)for(const key of values)ambiguousCompanies.add(key);
  }
  return {codesByCompany,ambiguousCompanies};
}
