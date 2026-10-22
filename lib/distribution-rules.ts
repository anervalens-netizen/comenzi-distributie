import {canonicalCounty} from './portfolio-facets';

export const projectIds = ['vodafone_sud', 'vodafone_nord', 'non_exclusiv'] as const;
export type DistributionProject = typeof projectIds[number];
export const territories = {
  sud: ['CL', 'AG', 'DB', 'GR', 'OT', 'TR', 'PH'],
  nord_a: ['CV', 'HR', 'MS'],
  nord_b: ['BC', 'BT', 'IS', 'NT', 'SV', 'VS'],
} as const;
export type Territory = keyof typeof territories;
export type DistributionAssignment = {userId:string;siteCode:string;projectId:DistributionProject;territoryId:Territory|null;counties:string[]};
export type ProductGroup = 'vodafone_0'|'vodafone_3'|'vodafone_5'|'vodafone_credit'|'digi'|'accessories'|'varta'|'scent'|'unmapped';
export type DistributionRules = {version:1;revision:string;history:'all';assignments:DistributionAssignment[];products:Record<string,ProductGroup>};
export const rulesSetting = 'distribution-rules-v1';
const groups:ProductGroup[]=['vodafone_0','vodafone_3','vodafone_5','vodafone_credit','digi','accessories','varta','scent','unmapped'];
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim();
/** Private owner-maintained identities and exact catalog codes. Invalid rules fail closed. */
export function parseDistributionRules(value:unknown):DistributionRules {
  if(typeof value==='string')value=JSON.parse(value);
  const r=value as DistributionRules;
  if(!r||r.version!==1||!text(r.revision)||r.history!=='all'||!Array.isArray(r.assignments)||!r.products||typeof r.products!=='object'||Array.isArray(r.products))throw new Error('Invalid distribution rules');
  const users=new Set<string>(),sites=new Set<string>();
  for(const a of r.assignments){
    if(!text(a.userId)||!text(a.siteCode)||!projectIds.includes(a.projectId)||!Array.isArray(a.counties)||a.counties.some(c=>!canonicalCounty(c).id))throw new Error('Invalid distribution assignment');
    const site=a.siteCode.toUpperCase();
    if(users.has(a.userId)||sites.has(site))throw new Error('Ambiguous distribution identity');
    users.add(a.userId);sites.add(site);
    if((a.projectId==='vodafone_sud'&&a.territoryId!=='sud')||(a.projectId==='vodafone_nord'&&!['nord_a','nord_b'].includes(a.territoryId||''))||(a.projectId==='non_exclusiv'&&a.territoryId!==null))throw new Error('Invalid project territory');
  }
  for(const [code,group] of Object.entries(r.products))if(!text(code)||!groups.includes(group))throw new Error('Invalid product mapping');
  return r;
}
export function assignmentFor(rules:DistributionRules,userId:string,siteCode:string){return rules.assignments.find(a=>a.userId===userId&&a.siteCode.toUpperCase()===siteCode.trim().toUpperCase());}
export function productGroup(rules:DistributionRules,code:string):ProductGroup{return Object.hasOwn(rules.products,code)?rules.products[code]:'unmapped';}
export function vodafoneEligibility(county:string,handset:string,territory:Territory|null,contradictory=false){
  const id=canonicalCounty(county).id?.slice(3),reasons:string[]=[];
  if(!id)reasons.push('missing_county');
  else if(!Object.values(territories).some(cs=>(cs as readonly string[]).includes(id)))reasons.push('outside_territory');
  if(!['SIM with initial credit >= 3 EUR','SIM Zero with Recharge >= 5E'].includes(handset))reasons.push(handset?'ineligible_type':'missing_type');
  if(contradictory)reasons.push('contradictory_source');
  const eligible=reasons.length===0;
  return {eligible,reasons,region:eligible?(territory?((territories[territory] as readonly string[]).includes(id!)?'own':'other'):'unknown'):null};
}
