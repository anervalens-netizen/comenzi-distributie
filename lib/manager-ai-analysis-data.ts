import { monthEnd } from './client-sales-store';
import { activationReport } from './activation-api';
import { canViewActivations } from './activation-access';
import { bucharestMonthKey } from './bucharest-month';
import { clientPortfolioVersion } from './client-sales-portfolio';
import { salesYield } from './client-sales-cooperative';
import { readDistributionRules } from './distribution-config';
import { productGroup, type DistributionRules } from './distribution-rules';
import { historyFileGeneration } from './history-source-generation';
import { historicalSalesGeneration } from './historical-sales';
import { scanManagerAiAnalysisSales } from './manager-ai-analysis-sales';
import { managerAiAnalysisCatalog, managerAiAnalysisLimits,
  type ManagerAiAnalysisRequest, type ManagerAiAnalysisTable } from './manager-ai-analysis-schema';
import { managerAiBillingPoints, readManagerAiBilling } from './manager-ai-billing';
import { managerAiReader, managerAiScope, type AiScope } from './manager-ai-data';
import { managerAiOperations } from './manager-ai-operations';
import { managerAiMonths, type AiSourceRow } from './manager-ai-query';
import type { ManagerAiCell, ManagerAiCoverage, ManagerAiDataset } from './manager-ai';
import { partnerScopeForWarehouses } from './partner-portfolio';
import { salesSiteKey } from './sales-location';
import { salesDatabasePath } from './sales-store';
import { managerSalesAnalysisScope } from './sales-server';
import { AppError, db, fail, requireManager, sha256 } from './server';
import type { User } from './types';

export { managerAiAnalysisCatalog, managerAiAnalysisLimits, type ManagerAiAnalysisDataset,
  type ManagerAiAnalysisRequest, type ManagerAiAnalysisTable } from './manager-ai-analysis-schema';

const ops = { orders:'orders', stock:'stock', inventories:'inventories', transfers:'transfers' } as const;
const reports = { stands:'stands', bonuses:'bonuses', bonus_documents:'bonusDocuments', bonus_unresolved:'bonusUnresolved',
  settlements:'settlements', focus_accessories:'focusAccessories', focus_phones:'focusPhones', focus_targets:'focusTargets' } as const;
const monthPattern = /^20\d{2}-(0[1-9]|1[0-2])$/;
const missing = (source:string, month:string, note:string): ManagerAiCoverage => ({source,month,available:false,note});
const day = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest',year:'numeric',month:'2-digit',day:'2-digit'});

const reference = (domain:string,...parts:ManagerAiCell[]) => domain+'_'+sha256(JSON.stringify(parts)).slice(0,32);
const document = (domain:string,id:ManagerAiCell,date:ManagerAiCell,warehouse:ManagerAiCell) =>
  id ? reference(domain,date,warehouse,id) : null;

const textValue = (value:ManagerAiCell|undefined) => typeof value==='string'&&value.trim() ? value.trim() : null;
const franchiseCode = (value:ManagerAiCell|undefined) => typeof value==='string' ? salesSiteKey(value)||null : null;
const pointRef = (value:ManagerAiCell|undefined) => typeof value==='string'&&value ? reference('point',value) : null;
const label = (value:ManagerAiCell|undefined) => {
  const text = textValue(value);
  // Business labels can occasionally contain contact information pasted into the wrong field.
  return text?.replace(/\b[\w.+-]+@[\w.-]+\.[A-Z]{2,}\b/gi,'[contact]').replace(/(?:\+|\b0)\d(?:[\s().-]*\d){7,14}\b/g,'[contact]') ?? null;
};
const groupFor = (rules:DistributionRules|null, sku:ManagerAiCell|undefined) =>
  rules&&typeof sku==='string'&&sku ? productGroup(rules,sku.trim().toUpperCase()) : null;
const cityCounty = (value:ManagerAiCell|undefined) => textValue(value)?.includes('@') ? null : label(value);

function monthSelection(request:ManagerAiAnalysisRequest, current:string) {
  if (!Object.hasOwn(managerAiAnalysisCatalog,request.table)) fail(400,'Tabel de analiză necunoscut.');
  const from=request.fromMonth||request.toMonth||current, to=request.toMonth||from;
  if (!monthPattern.test(from)||!monthPattern.test(to)||from>to||to>current) fail(400,'Intervalul lunar de analiză este invalid.');
  const months=managerAiMonths(from,to);
  if (months.length>managerAiAnalysisLimits.months) fail(400,'Alege până la 12 luni pentru fiecare tabel.');
  return {from,to,months};
}

function operationRow(table:keyof typeof ops,row:AiSourceRow,rules:DistributionRules|null):ManagerAiCell[] {
  const {month,date,sku,observedOn,units,simZeroUnits,expected,counted,difference,kind,status} = row;
  const warehouse=label(row.warehouse), product=label(row.product), group=row.group??groupFor(rules,sku);
  switch (table) {
    case 'orders': return [month,date,document('order',row.document,date,row.warehouse),warehouse,sku,product,kind,status,units,simZeroUnits,group];
    case 'stock': return [warehouse,textValue(row.site),sku,product,label(row.category),observedOn,units,group];
    case 'inventories': return [month,date,warehouse,sku,product,expected,counted,difference,group];
    case 'transfers': return [month,date,document('transfer',row.document,date,row.warehouse),warehouse,label(row.destination),sku,product,units,group];
  }
}

function reportRow(table:keyof typeof reports,row:AiSourceRow):ManagerAiCell[] {
  const {month,date,sku,units,status,activations,target,site,kind,incentiveLei} = row;
  const franchise=franchiseCode(row.franchise);
  switch (table) {
    case 'stands': return [month,date,document('order',row.document,date,row.warehouse),label(row.partner),label(row.warehouse),sku,label(row.product),units];
    case 'bonuses': return [month,franchise,label(row.partner),status,activations,target,row.bonusSim5,row.bonusTop,
      row.amountDue,row.settled,row.balance,row.simulatedSettled,row.simulatedBalance];
    case 'bonus_documents': return [month,date,document('bonus',row.document,date,site),site,franchise,label(row.partner),status,units];
    case 'bonus_unresolved': return [month,site,status,activations];
    case 'settlements': return [month,row.paymentDate,document('bonus',row.document,row.paymentDate,site),site,franchise,kind,status,units];
    case 'focus_accessories':
    case 'focus_phones': return [month,label(row.seller),site,sku,label(row.product),units,incentiveLei];
    case 'focus_targets': return [month,label(row.seller),site,units,target,incentiveLei,status];
  }
}

async function partnerRows(user:User, scope:AiScope, remaining:number) {
  // Match the read model's live membership without relying on a derivative being up to date.
  const selection=partnerScopeForWarehouses(user,scope.filter?.warehouseIds);
  return (await db().prepare(`SELECT c.id,json_extract(c.data,'$.name') partner,
    COALESCE(NULLIF(TRIM(CAST(json_extract(c.data,'$.historyCatalog.franchiseCode') AS TEXT)),''),
      CAST(json_extract(c.data,'$.crm.franchiseCode') AS TEXT)) franchise,
    json_extract(c.data,'$.county') county,json_extract(c.data,'$.city') city,
    (SELECT MAX(v.visited_at) FROM partner_visits v WHERE v.customer_id=c.id) lastVisit
    FROM customers c WHERE c.active=1 AND ${selection.sql} ORDER BY c.id LIMIT ?`)
    .bind(...selection.args,remaining+1).all<{id:string;partner:string|null;franchise:string|null;county:string|null;city:string|null;lastVisit:string|null}>()).results;
}

/**
 * Read a single table using the authenticated report scope and an allowlisted
 * grain. Nothing from the live database is mounted or copied as a file.
 */
export async function readManagerAiAnalysisTable(
  scope:AiScope, request:ManagerAiAnalysisRequest, revalidate:()=>Promise<User>, signal?:AbortSignal,
):Promise<ManagerAiAnalysisTable> {
  const current=bucharestMonthKey(new Date());
  const selection=monthSelection(request,current);
  const {table} = request, info=managerAiAnalysisCatalog[table];
  const snapshot=table==='partners'||table==='stock';
  const months=snapshot?[current]:selection.months;
  const rows:ManagerAiCell[][]=[], coverage:ManagerAiCoverage[]=[];
  let size=0;
  function push(row:ManagerAiCell[]) {
    if (row.length!==info.columns.length) throw new Error('Invalid analytical row width');
    const cells=row.map((value,index)=>{
      if (value===undefined) value=null;
      const column=info.columns[index];
      if (value===null ? !column.nullable :
        column.type==='text' ? typeof value!=='string' : typeof value!=='number'||!Number.isFinite(value)) {
        throw new Error('Invalid analytical source value');
      }
      const bytes=typeof value==='string'?Buffer.byteLength(value):8;
      size+=bytes;
      if (bytes>managerAiAnalysisLimits.cellBytes||size>managerAiAnalysisLimits.textBytes) limit();
      return value;
    });
    if (rows.length>=managerAiAnalysisLimits.rows) limit();
    rows.push(cells);
  }
  function limit():never { fail(413,'Sursa depășește limita pentru analiză. Restrânge perioada sau portofoliul.'); }
  function remaining(){return managerAiAnalysisLimits.rows-rows.length;}
  async function check() {
    signal?.throwIfAborted();
    const user=await revalidate();
    requireManager(user);
    if (user.active===0 || scope.signature!==(await managerAiScope(user,scope.params)).signature) {
      fail(409,'Accesul la portofoliu s-a modificat. Reia analiza.');
    }
    signal?.throwIfAborted();
    return user;
  }

  const currentUser=await check(), rules=await readDistributionRules();
  const readLegacy=managerAiReader(new Request('http://localhost/api/manager-ai'),scope,check,{cacheMonths:false});
  const saleScope=table==='sales_lines' ? await managerSalesAnalysisScope(currentUser,scope.params) : null;
  const sourceStamp=()=>JSON.stringify([historyFileGeneration(salesDatabasePath),historicalSalesGeneration()]);
  const saleStamp=saleScope?sourceStamp():null;
  const pointVersion=table==='sales_partner_lines'?await clientPortfolioVersion():null;
  if (table==='sales_partner_lines'&&!pointVersion) fail(503,'Portofoliul punctelor nu este disponibil.');
  const billingPoints=pointVersion?await managerAiBillingPoints(currentUser,scope.filter?.warehouseIds):null;

  for (const month of months) {
    const user=await check();
    try {
      if (table==='sales_lines') {
        coverage.push(await scanManagerAiAnalysisSales(month,saleScope!.scope,row=>push([month,row.date,
          textValue(row.site),label(row.warehouse),textValue(row.sku),label(row.product),label(row.brand),
          label(row.category),label(row.subcategory),groupFor(rules,row.sku),row.quantity,row.valueCents,row.source]),signal));
      } else if (table==='sales_partner_lines') {
        const source=await readManagerAiBilling(month,'salesByPoint',billingPoints!,rules,undefined,{allProducts:true,maxRows:remaining()});
        for (const row of source.rows) push([month,row.date,pointRef(row.pointId),franchiseCode(row.franchise),label(row.partner),textValue(row.erpSite),
          document('bill',row.document,row.date,row.erpSite),row.sku,label(row.product),row.units,
          typeof row.valueLei==='number'?Math.round(row.valueLei*100):null,groupFor(rules,row.sku)]);
        coverage.push(...source.coverage);
      } else if (table==='activation_detail'||table==='activation_monthly'||table==='activation_partners') {
        await readActivations(table,user,scope,month,rules,remaining,push,coverage);
      } else if (table==='partners') {
        for (const row of await partnerRows(user,scope,remaining())) {
          const visited=row.lastVisit&&Number.isFinite(Date.parse(row.lastVisit))?day.format(new Date(row.lastVisit)):null;
          push([pointRef(row.id),label(row.partner),franchiseCode(row.franchise),cityCounty(row.county),cityCounty(row.city),visited,1]);
        }
        coverage.push({source:'Portofoliu activ',available:true,through:day.format(new Date()),note:'Instantaneu curent. Adresa, poziția exactă și datele de contact sunt omise.'});
      } else if (Object.hasOwn(ops,table)) {
        const key=table as keyof typeof ops;
        const source=await managerAiOperations(ops[key],month,scope,{allProducts:true,maxRows:remaining()});
        for (const row of source.rows) push(operationRow(key,row,rules));
        coverage.push(...source.coverage.map(item=>({...item,source:label(item.source)??'Operațiuni'})));
      } else if (Object.hasOwn(reports,table)) {
        const key=table as keyof typeof reports, dataset:ManagerAiDataset=reports[key];
        const source=await readLegacy({dataset,fromMonth:month,toMonth:month,site:'',groupBy:[],filters:[],orderBy:'',descending:false,limit:1});
        for (const row of source.rows) push(reportRow(key,row));
        coverage.push(...source.coverage);
      }
    } catch (error) {
      if (!(error instanceof AppError) || error.status!==403&&error.status!==503) throw error;
      coverage.push(missing(info.label,month,error.status===403?'Sursa nu este disponibilă acestui cont.':'Sursa momentan indisponibilă.'));
    }
    await salesYield();
  }
  const finalUser=await check();
  if (saleScope && (saleStamp!==sourceStamp() ||
      saleScope.revision!==(await managerSalesAnalysisScope(finalUser,scope.params)).revision)) fail(409,'Sursele vânzărilor s-au modificat. Reia analiza.');
  if (pointVersion && pointVersion!==await clientPortfolioVersion()) fail(409,'Portofoliul punctelor s-a modificat. Reia analiza.');
  return {table,fromMonth:snapshot?current:selection.from,toMonth:snapshot?current:selection.to,columns:info.columns,rows,coverage};
}

async function readActivations(
  table:'activation_detail'|'activation_monthly'|'activation_partners', user:User, scope:AiScope,
  month:string, rules:DistributionRules|null, remaining:()=>number, push:(row:ManagerAiCell[])=>void, coverage:ManagerAiCoverage[],
) {
  if (!canViewActivations(user)) fail(403,'Activările nu sunt disponibile pentru acest cont.');
  const vodafoneOnly=(process.env.MOBIUP_ACTIVATIONS_VODAFONE_ONLY_MANAGER_IDS||'').split(',').map(id=>id.trim()).includes(user.id);
  const params=new URLSearchParams(scope.params);
  params.set('month',month);
  if (table==='activation_partners') params.set('view','partners');
  if (rules) params.set('months',month);
  for (const provider of ['vodafone','digi'] as const) {
    const source='Activări · '+(provider==='vodafone'?'Vodafone':'Digi');
    if (provider==='digi'&&vodafoneOnly) {
      coverage.push(missing(source,month,'Sursa Digi nu este disponibilă acestui cont.'));
      continue;
    }
    params.set('provider',provider);
    let report;
    try {
      report=await activationReport(user,params,{omitFocus:true,allPartners:table==='activation_partners',analysisLimit:table==='activation_detail'?remaining():undefined});
    } catch (error) {
      if (!(error instanceof AppError) || error.status!==503) throw error;
      coverage.push(missing(source,month,'Sursa operatorului nu este disponibilă.'));
      continue;
    }
    if (report.provider==='both') throw new Error('Unexpected analytical activation projection');
    const monthly=report.monthly?.find(entry=>entry.month===month);
    const available=monthly?.reported??report.history.some(entry=>entry.month===month);
    const sourceMode=monthly?.source==='operator'?'operator':'internal';
    const note=table==='activation_monthly'&&sourceMode==='operator'
      ? 'Sursă Digi oficială disponibilă în aria națională. Nu o aduna cu activările interne.'
      : 'Activări interne ale distribuției. Data limită disponibilă indică ultima observație, nu închiderea perioadei.';
    if (table==='activation_detail') {
      for (const row of report.analysisDays??[]) push([month,row.date,provider,textValue(row.site),textValue(row.sku),
        label(row.itemType),cityCounty(row.county),label(row.handset),row.conflict,row.count,groupFor(rules,row.sku)]);
    } else if (table==='activation_partners') {
      for (const row of report.partners?.rows??[]) if (row.total>0) push([month,provider,pointRef(row.portfolioId),franchiseCode(row.pointCode),
        row.kind==='point'?label(row.label):null,row.kind,row.total]);
    } else {
      for (const row of report.sites) push([month,provider,textValue(row.site),sourceMode,row.total,row.sim,row.telsim,row.other,row.unassigned]);
    }
    const distinctDetail = table==='activation_detail'?report.analysisDays:table==='activation_partners'?report.partners:report;
    const latest = table==='activation_detail'?report.analysisDays?.at(-1)?.date:
      sourceMode==='operator'?report.operatorReported?.sourceThrough:report.latestDate;
    const periods=report.sourcePeriods?.filter(period=>period.from<=monthEnd(month)&&period.to>=month+'-01');
    const cutoff=sourceMode==='operator'&&latest
      ? [latest,monthEnd(month)].sort()[0]
      : latest?.slice(0,7)===month?latest:periods?.map(period=>[period.to,monthEnd(month)].sort()[0]).sort().at(-1);
    coverage.push({source,month,available:available&&!!distinctDetail,through:cutoff??null,
      revision:report.revision,note:distinctDetail?note:'Proiecția detaliată nu este disponibilă în această instanță.'});
  }
}
