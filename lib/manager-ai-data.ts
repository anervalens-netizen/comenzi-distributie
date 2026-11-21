import {activationReport} from './activation-api';
import {bucharestMonthKey, bucharestMonthUtcRange} from './bucharest-month';
import {commercialFocus} from './commercial-focus-api';
import {readDistributionRules} from './distribution-config';
import {managerFilter, type ManagerFilter} from './manager-scope';
import {readManagerAiSim0} from './manager-ai-sim0';
import {managerAiOperations} from './manager-ai-operations';
import {managerAiSales,managerAiSalesSiteMode} from './manager-ai-sales';
import {clientSalesPortfolio,clientPortfolioVersion} from './client-sales-portfolio';
import {managerAiBillingPoints,readManagerAiBilling,type BillingPoint} from './manager-ai-billing';
import {salesView} from './sales-server';
import {db, fail, isGlobalManager} from './server';
import {readVodafoneBonusForManager} from './vodafone-bonus-api';
import {applyVodafoneActivationTargets} from './vodafone-activation-targets';
import type {VodafoneBonusReport} from './vodafone-bonus-types';
import {managerAiMonths, type AiReportQuery, type AiSource, type AiSourceRow} from './manager-ai-query';
import type {ManagerAiCoverage} from './manager-ai';
import type {SalesView} from './sales-types';
import type {User} from './types';

export type AiScope = {params: URLSearchParams; filter: ManagerFilter|null; signature: string};

export async function managerAiScope(user: User, requested: URLSearchParams): Promise<AiScope> {
  const params = new URLSearchParams();
  for (const field of ['managerId','agentId']) {
    if (requested.getAll(field).length > 1) fail(400,'Filtru de portofoliu duplicat.');
    const value = requested.get(field);
    if (value) params.set(field,value);
  }
  const filter = await managerFilter(user,params) ??
    (isGlobalManager(user) ? null : await managerFilter(user,new URLSearchParams({managerId:user.id})));
  return {params,filter,signature:JSON.stringify([user.id,user.profileVersion,user.managerScope,filter])};
}

const coverage = (source: string, month: string, available: boolean, through?: string|null, revision?: string, note?: string): ManagerAiCoverage =>
  ({source,month,available,through,revision,note});
const valueLei = (cents: number|null) => cents === null ? null : cents / 100;
const activationSource = 'Prepay · Activări Vodafone';
const bonusSource = 'Registru bonusuri Vodafone';
const focusSource = 'Focus comercial Vodafone';

export function managerAiReader(request: Request, scope: AiScope, check: () => Promise<User>, options?:{cacheMonths:false}) {
  const monthlyCache = new Map<string,Promise<AiSource>>();
  const rankings=new Map<string,ReturnType<typeof readManagerAiSim0>>();
  let verifyActivationAccess:((user:User)=>Promise<void>)|undefined;
  let registry: Promise<VodafoneBonusReport>|undefined;
  let billing: {version:string;points:Map<string,BillingPoint>}|undefined;
  function rememberSim0Access(verify:(user:User)=>Promise<void>) { verifyActivationAccess??=verify; }
  async function checkSourceScope(user?:User) {
    if (verifyActivationAccess) await verifyActivationAccess(user??await check());
    if (billing&&billing.version!==await clientPortfolioVersion()) fail(409,'Portofoliul punctelor de lucru s-a modificat. Reîncarcă analiza.');
  }
  async function loadBillingPoints(user:User) {
    if (!billing) {
      const version=await clientPortfolioVersion();
      if (!version) fail(503,'Portofoliul punctelor de lucru nu este disponibil momentan.');
      const points=await managerAiBillingPoints(user,scope.filter?.warehouseIds);
      billing={version,points};
    }
    await checkSourceScope(user);
    return billing.points;
  }

  async function readMonth(query: AiReportQuery & {dataset:Exclude<AiReportQuery['dataset'],'sim0Clients'>}, month: string): Promise<AiSource> {
    const user = await check();
    const params = new URLSearchParams(scope.params);
    params.set('month',month);
    if (query.site) params.set('siteCode',query.site);

    switch(query.dataset) {
      case 'sales': {
        return managerAiSales(query,month,await readDistributionRules(),async site=>{
          const current = await check();
          const selection = new URLSearchParams(params);
          if (site) selection.set('siteCode',site);
          else selection.delete('siteCode');
          const url = new URL('/api/sales',request.url);
          url.search = selection.toString();
          return await (await salesView(new Request(url),current)).json() as SalesView;
        });
      }
      case 'salesByPoint':
      case 'billingDocuments': {
        const result=await readManagerAiBilling(month,query.dataset,await loadBillingPoints(user),await readDistributionRules());
        await checkSourceScope(user);
        return result;
      }
      case 'activations':
      case 'activationsPartners': {
        const partners = query.dataset === 'activationsPartners';
        params.set('provider','vodafone');
        params.set('months',month);
        if (partners) params.set('view','partners');
        const result = await activationReport(user,params,{allPartners:partners});
        if (result.provider==='both') throw new Error('Unexpected activation source');
        const targeted = partners && result.partners ? await applyVodafoneActivationTargets(user,params,{
          provider:'both',revision:result.revision??'',operators:{vodafone:{available:result.available,latestDate:result.latestDate}},
          partners:{...result.partners,rows:result.partners.rows.map(row=>({...row,vodafone:row.total,digi:0}))},
        }) : null;
        const rows = partners ? (targeted?.partners.rows||[]).filter(p=>p.total>0||p.vodafoneTargets?.length).map(p=>({
          month,partner:p.label,franchise:p.pointCode||null,identity:p.kind,activations:p.total,
          target:p.vodafoneTargets?.find(target=>target.month===month)?.units??null,
        })) : result.sites.map(s=>({
          month,site:s.site,total:s.total,sim:s.sim,phoneBundles:s.telsim,other:s.other,unassigned:s.unassigned,
        }));
        const available = result.monthly?.find(m=>m.month===month)?.reported ?? result.history.some(m=>m.month===month);
        const sources = [coverage(activationSource,month,available,result.latestDate,result.revision,
          'Data disponibilă indică ultima zi observată în sursa de activări; luna poate fi încă deschisă.')];
        if (targeted) sources.push(coverage('Incentive Top Locații',month,targeted.vodafoneTargetStatus==='available',null,undefined,
          'Țintele lipsă sau fără punct verificat sunt necunoscute.'));
        return {rows,coverage:sources};
      }
      case 'partners': {
        const partners = await clientSalesPortfolio(user,scope.filter?.warehouseIds);
        const rows = partners.map(p=>({partner:p.name,franchise:p.historyCatalog?.franchiseCode||null,county:p.county,city:p.city,route:p.route,points:1}));
        return {rows,coverage:[{source:'Fișa partenerului · portofoliu curent',available:true,note:'Situația curentă. Data de referință a istoricului nu se aplică.'}]};
      }
      case 'stands': {
        const from = bucharestMonthUtcRange(month).start;
        const to = bucharestMonthUtcRange(month).end;
        const orders = await db().prepare(`SELECT o.number document,o.finalized_at at,json_extract(o.payload,'$.client.name') partner,
          json_extract(o.payload,'$.warehouseName') warehouse,json_extract(li.value,'$.code') sku,
          json_extract(li.value,'$.name') product,json_extract(li.value,'$.quantity') units
          FROM orders o JOIN json_each(o.payload,'$.items') li
          WHERE o.kind='stand_client' AND o.status='finalized' AND o.finalized_at>=? AND o.finalized_at<?
          AND (? IS NULL OR o.user_id IN (SELECT value FROM json_each(?))) ORDER BY o.finalized_at,o.number,li.key`)
          .bind(from,to,...Array(2).fill(scope.filter?JSON.stringify(scope.filter.agentIds):null))
          .all<{document:string;at:string;partner:string|null;warehouse:string|null;sku:string|null;product:string|null;units:number|null}>();
        const day = new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Europe/Bucharest'});
        const rows = orders.results.map(r=>({month,date:day.format(new Date(r.at)),document:r.document,partner:r.partner,warehouse:r.warehouse,
          sku:r.sku,product:r.product,units:r.units,lines:1}));
        return {rows,coverage:[coverage('Avize stand finalizate',month,true,rows.at(-1)?.date,undefined,
          'Sunt incluse avizele înregistrate în aplicație; acoperirea anterioară lansării avizării nu este confirmată.')]};
      }
      case 'orders':
      case 'stock':
      case 'inventories':
      case 'transfers':
        return managerAiOperations(query.dataset,month,scope);
      case 'bonuses':
      case 'bonusDocuments':
      case 'bonusUnresolved':
      case 'settlements': {
        const allParams = new URLSearchParams(scope.params);
        allParams.set('all','1');
        const result = await (registry ??= readVodafoneBonusForManager(user,allParams,check));
        const sourceMonth = result.months.find(row=>row.month===month);
        const notes = sourceMonth ? [
          sourceMonth.publishedOn ? 'Raport publicat la '+sourceMonth.publishedOn : 'Lună în previzualizare.',
          sourceMonth.unresolvedActivations ? `${sourceMonth.unresolvedActivations} activări fără punct cert.` : '',
          result.fiscalKindsComplete ? '' : 'Confirmarea documentelor fiscale este incompletă.',
        ].filter(Boolean).join(' ') : 'Sursa lunii nu a fost identificată.';
        let rows: AiSourceRow[];
        if (query.dataset === 'bonuses') {
          rows = result.points.filter(row=>row.month===month).map(row=>({
            month,partner:row.partner,franchise:row.pointCode,status:row.partial?'partial':sourceMonth?.publishedOn?'publicat':'previzualizare',
            activations:row.activations,target:row.target,bonusSim5:row.sim0Bonus,bonusTop:row.topBonus,amountDue:row.totalBonus,
            settled:row.applied,balance:row.remaining,simulatedSettled:row.simulatedApplied,simulatedBalance:row.simulatedRemaining,
          }));
        } else if (query.dataset === 'bonusDocuments') {
          rows = result.documents.filter(doc=>doc.date.slice(0,7)===month).map(doc=>({
            month,date:doc.date,document:doc.number,site:doc.sites.join(', '),franchise:doc.pointCode,partner:doc.partner,
            status:doc.reason,units:doc.quantity,
          }));
        } else if (query.dataset === 'bonusUnresolved') {
          rows = result.unresolved.filter(row=>row.month===month).map(row=>({
            month,site:row.site,partner:row.partner,status:row.reason,activations:row.count,
          }));
        } else {
          rows = result.documents.flatMap(doc=>doc.allocations.filter(allocation=>allocation.month===month).map(allocation=>({
            month,paymentDate:doc.date,paymentMonth:doc.date.slice(0,7),document:doc.number,site:doc.sites.join(', '),franchise:doc.pointCode,
            kind:allocation.kind,status:allocation.status,units:allocation.quantity,
          })));
        }
        return {rows,coverage:[coverage(bonusSource,month,Boolean(sourceMonth?.sourceThrough),sourceMonth?.sourceThrough,result.revision,notes)]};
      }
      case 'focusAccessories':
      case 'focusPhones':
      case 'focusTargets': {
        const result = await commercialFocus(user,params,check);
        const rows = query.dataset==='focusTargets' ? result.sellers.map(seller=>({
          month,seller:seller.name,site:seller.siteCode,units:seller.units,target:seller.target,incentiveLei:valueLei(seller.phoneCents),
          status:seller.targetReached===null?'neconfigurat':seller.targetReached?'atins':'sub target',
        })) : result.sellers.flatMap(seller=>(query.dataset==='focusAccessories'?seller.accessories:seller.phones).map(item=>({
          month,seller:seller.name,site:seller.siteCode,sku:item.code,product:item.name,units:item.quantity,incentiveLei:valueLei(item.incentiveCents),
        })));
        const notes = [
          result.state==='no-offer'?'Luna nu are o grilă Focus înregistrată.':'',
          result.state==='no-sales'?'Importul de vânzări al lunii lipsește.':'',
          result.simulation?'Simulare retrospectivă a grilei.':'',
          result.excludedRows ? `${result.excludedRows} linii excluse la verificarea titularului.` : '',
          result.unmatchedRows ? `${result.unmatchedRows} linii fără titular confirmat.` : '',
        ].filter(Boolean).join(' ');
        return {rows,coverage:[coverage(focusSource,month,result.available,result.lastDate,result.importedAt??undefined,notes)]};
      }
    }
  }

  async function readSource(query: AiReportQuery): Promise<AiSource> {
    const {dataset}=query;
    if (dataset==='sim0Clients') {
      const key=JSON.stringify([dataset,query.fromMonth,query.toMonth]);
      const user=await check();
      if (verifyActivationAccess) await verifyActivationAccess(user);
      if (!rankings.has(key)) rankings.set(key,readManagerAiSim0(scope.params,query.fromMonth,query.toMonth,check));
      try {
        const {rows,coverage,checkAccess}=await rankings.get(key)!;
        rememberSim0Access(checkAccess);
        return {rows,coverage};
      } catch(error) { rankings.delete(key); throw error; }
    }
    const result: AiSource = {rows:[],coverage:[]};
    const months = (query.dataset==='partners'||query.dataset==='stock') ? [bucharestMonthKey(new Date())] : managerAiMonths(query.fromMonth,query.toMonth);
    for (const month of months) {
      // Reuse completed queries within one turn, especially after a model drills down.
      const key = JSON.stringify([query.dataset,query.site,month,query.dataset==='sales'?managerAiSalesSiteMode(query):null]);
      if (!options && !monthlyCache.has(key)) monthlyCache.set(key,readMonth({...query,dataset},month));
      const source = await (options ? readMonth({...query,dataset},month) : monthlyCache.get(key)!);
      result.rows.push(...source.rows);
      result.coverage.push(...source.coverage);
    }
    return result;
  }
  return Object.assign(readSource,{checkSourceScope,rememberSim0Access});
}
