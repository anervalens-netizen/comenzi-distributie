import {assignmentFor, productGroup, productGroups, type DistributionRules, type ProductGroup} from './distribution-rules';
import type {AiScope} from './manager-ai-data';
import {scanManagerAiAnalysisSales} from './manager-ai-analysis-sales';
import type {ManagerAiCell} from './manager-ai';
import {salesValueExVat} from './sales-vat';
import type {managerSalesAnalysisScope} from './sales-server';
import {db, fail, isGlobalManager} from './server';
import type {User} from './types';

type Member = {agent_id:string; agent_name:string; site_code:string; manager_id:string|null; manager_name:string|null};
type SalesScope = Awaited<ReturnType<typeof managerSalesAnalysisScope>>;
type Total = {units:number; cents:number; missing:number};

export async function teamSalesRoster(user:User, scope:AiScope) {
  const ids=scope.filter ? JSON.stringify(scope.filter.agentIds) : null;
  if(!isGlobalManager(user) && !scope.filter) fail(403,'Portofoliul nu este disponibil.');
  const manager=isGlobalManager(user) ? scope.params.get('managerId') : user.id;
  const rows=await db().prepare(`SELECT a.id agent_id,a.name agent_name,a.site_code,
    membership.manager_id,membership.manager_name
    FROM users a LEFT JOIN (
      SELECT ma.agent_id,m.id manager_id,m.name manager_name FROM manager_agents ma
      JOIN users m ON m.id=ma.manager_id AND m.role='manager' AND m.manager_scope='assigned' AND m.active=1
      WHERE (? IS NULL OR m.id=?)
    ) membership ON membership.agent_id=a.id
    WHERE a.role='agent' AND a.active=1 AND (? IS NULL OR a.id IN (SELECT value FROM json_each(?)))
    ORDER BY a.id,membership.manager_id`).bind(manager,manager,ids,ids).all<Member>();
  return rows.results;
}

export async function readTeamSalesMonth(
  month:string, roster:Member[], scope:SalesScope, rules:DistributionRules,
  label:(text:string|null)=>string|null, ref:(domain:string,id:string)=>string,
  push:(row:ManagerAiCell[])=>void, signal?:AbortSignal,
) {
  const totals=new Map(roster.map(member=>[member.agent_id,new Map<ProductGroup,Total>()]));
  const sellerCache=new Map<string,string|null>();
  const latestSale=new Map<string,string>();
  let unattributed=0;
  const coverage=await scanManagerAiAnalysisSales(month,scope.scope,line=>{
    const pair=JSON.stringify([line.site,line.warehouse]);
    if(!sellerCache.has(pair)) sellerCache.set(pair,scope.resolveSeller(line.site,line.warehouse));
    const seller=sellerCache.get(pair);
    if(!seller){unattributed++;return;}
    const groups=totals.get(seller);
    if(!groups)return; // Manager sales identities do not enter agent denominators.
    if(line.date>(latestSale.get(seller)??'')) latestSale.set(seller,line.date);
    const group=productGroup(rules,line.sku.trim().toUpperCase());
    const sum=groups.get(group)??{units:0,cents:0,missing:0};
    sum.units+=line.quantity;
    if(line.valueCents===null)sum.missing++;else sum.cents+=line.valueCents;
    groups.set(group,sum);
  },signal);
  for(const member of roster) {
    const project=assignmentFor(rules,member.agent_id,member.site_code??'')?.projectId??null;
    for(const group of productGroups) {
      const sum=totals.get(member.agent_id)?.get(group);
      const units=coverage.available ? sum?.units??0 : null;
      const missing=coverage.available ? sum?.missing??0 : null;
      const cents=missing===0 ? sum?.cents??0 : null;
      const net=cents!==null && ['accessories','varta','scent'].includes(group)
        ? salesValueExVat(cents/100,month) : undefined;
      push([month,member.manager_id ? ref('manager',member.manager_id) : null,label(member.manager_name),
        ref('agent',member.agent_id),label(member.agent_name),project,group,units,cents,net??null,missing,coverage.through??null,latestSale.get(member.agent_id)??null]);
    }
  }
  return {...coverage,note:[coverage.note,
    'Efectivul include agenții activi din portofoliul și configurația curentă, inclusiv agenții fără vânzări observate. Valorile lipsă rămân NULL. Managerii care vând sunt excluși.',
    unattributed ? `${unattributed} linii din selecția sursă fără asociere univocă la vânzător au fost excluse.` : '',
  ].filter(Boolean).join(' ')};
}
