export function normalizedCui(value:unknown) {
  const code=typeof value==='string' || typeof value==='number' ? String(value) : '';
  return code.replace(/[^A-Za-z0-9]/g,'').toUpperCase().replace(/^RO/,'');
}
// Reserved ERP account identifiers. Compare exact codes so a registered company
// keeps its fiscal identity regardless of its displayed name.
export const consumerAccountCodes = ['CLIENTGEN','GENERICPARTENER','GENERICPARTNER'] as const;
export function isConsumerAccountCode(code:unknown) {
  const normalized=normalizedCui(code);
  return consumerAccountCodes.some(value=>value===normalized);
}
export type CompanyAlias={CIF?:string;PartnerCode?:string};
/** Shared by detail and batch totals; aliases cannot join different legal entities. */
export function companyIdentityIndex(master:CompanyAlias[],companyKeys:Iterable<string>){
  const owners=new Map<string,Set<string>>();
  for(const row of master){
    const code=normalizedCui(String(row.PartnerCode||'')),owner=normalizedCui(String(row.CIF||''));
    if(!code||!owner||isConsumerAccountCode(code)||isConsumerAccountCode(owner))continue;
    const values=owners.get(code)||new Set<string>();values.add(owner);owners.set(code,values);
  }
  const codesByCompany=new Map<string,Set<string>>(),ambiguousCompanies=new Set<string>();
  for(const key of companyKeys){
    if(!key||isConsumerAccountCode(key))continue;
    const values=owners.get(key),codes=new Set<string>();
    if(!values||(values.size===1&&values.has(key)))codes.add(key);
    codesByCompany.set(key,codes);
  }
  for(const [code,values] of owners){
    if(values.size===1)codesByCompany.get([...values][0])?.add(code);
    else if(values.size>1)for(const key of values)ambiguousCompanies.add(key);
  }
  return {codesByCompany,ambiguousCompanies};
}
