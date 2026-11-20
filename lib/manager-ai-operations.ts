import {bucharestMonthUtcRange} from './bucharest-month';
import {readDistributionRules} from './distribution-config';
import {productGroup} from './distribution-rules';
import type {ManagerAiCoverage} from './manager-ai';
import type {AiScope} from './manager-ai-data';
import type {AiSource, AiSourceRow} from './manager-ai-query';
import {db,fail} from './server';
import {stockForWarehouses} from './stock-server';

const day = new Intl.DateTimeFormat('en-CA',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Europe/Bucharest'});
const date = (timestamp:string) => day.format(new Date(timestamp));
const selected = (ids:string[]|undefined) => ids===undefined?null:JSON.stringify(ids);
type Operation = 'orders'|'stock'|'inventories'|'transfers';
type Line = {sku:string|null;product:string|null;units:number|null};
type OrdersLine = Line & {document:string;at:string;warehouse:string|null;phase:string;kind:string};
type TransferLine = Line & {document:string;at:string;warehouse:string|null;target:string|null};
type InventoryLine = {at:string;warehouseId:string;sku:string|null;product:string|null;expected:number|null;counted:number|null};
type Warehouse = {id:string;name:string|null;site:string|null};

async function warehouseScope(scope:AiScope):Promise<Warehouse[]> {
  const constraint = selected(scope.filter?.warehouseIds);
  const result = await db().prepare(`SELECT warehouse_id id,MAX(warehouse_name) name,
    CASE WHEN COUNT(DISTINCT site_code)=1 THEN MAX(site_code) ELSE NULL END site
    FROM users WHERE role='agent' AND active=1 AND warehouse_id IS NOT NULL
    AND (? IS NULL OR warehouse_id IN (SELECT value FROM json_each(?))) GROUP BY warehouse_id ORDER BY warehouse_id`)
    .bind(constraint,constraint).all<Warehouse>();
  return result.results;
}

function assertOperationBudget(count:number, max:number) {
  if (count>max) fail(413,'Sursa operațională depășește limita. Restrânge perioada sau portofoliul.');
}

async function stockRows(scope:AiScope, include:(sku:string|null)=>boolean, max:number, allProducts:boolean):Promise<AiSource> {
  const warehouses = await warehouseScope(scope);
  const rows:AiSourceRow[] = [], coverage:ManagerAiCoverage[] = [];
  const stocks = await stockForWarehouses(warehouses.map(warehouse=>warehouse.id));
  for (const warehouse of warehouses) {
    const stock = stocks.get(warehouse.id)!;
    for (const item of stock.rows) if (include(item.code)) {
      assertOperationBudget(rows.length+1,max);
      rows.push({warehouse:warehouse.name,site:warehouse.site,sku:item.code,product:item.name,
        category:item.category||null,observedOn:item.observedAt?date(item.observedAt):stock.importedAt?date(stock.importedAt):null,units:item.quantity});
    }
    coverage.push({source:warehouse.name?'Stoc importat · '+warehouse.name:allProducts?'Stoc importat':'Stoc importat · '+warehouse.id,available:Boolean(stock.importedAt),
      through:stock.importedAt?date(stock.importedAt):null,note:'Ultimul stoc disponibil. Actualizarea poate fi parțială.'});
  }
  if (!warehouses.length) coverage.push({source:'Stoc importat',available:true,note:'Selecția nu conține gestiuni active.'});
  return {rows,coverage};
}

export async function managerAiOperations(
  dataset:Operation, month:string, scope:AiScope, options?:{allProducts:true; maxRows:number},
):Promise<AiSource> {
  const rules = options ? null : await readDistributionRules();
  const sources:Record<Operation,string>={orders:'Comenzi',stock:'Stoc importat',inventories:'Inventare finalizate',transfers:'Transferuri finalizate'};
  if (!rules && !options) return {rows:[],coverage:[{source:sources[dataset],month,available:false,note:'Catalogul Vodafone nu este configurat.'}]};
  const include = (sku:string|null) => !!options || !!sku && !!rules && productGroup(rules,sku.trim().toUpperCase()).startsWith('vodafone_');
  const max=options?.maxRows??Number.MAX_SAFE_INTEGER;
  const limit=options?max+1:-1;
  if (dataset==='stock') return stockRows(scope,include,max,!!options);

  const {start,end} = bucharestMonthUtcRange(month), agents = selected(scope.filter?.agentIds);
  let rows:AiSourceRow[];
  if (dataset==='orders') {
    const result = await db().prepare(`SELECT o.number document,COALESCE(o.finalized_at,o.created_at) at,o.status phase,o.kind,
      json_extract(o.payload,'$.warehouseName') warehouse,json_extract(line.value,'$.code') sku,
      json_extract(line.value,'$.name') product,json_extract(line.value,'$.quantity') units
      FROM orders o JOIN json_each(o.payload, '$.items') line
      WHERE (o.kind IN ('accessories','stands','combined') OR (? AND o.kind='stand_client')) AND o.status IN ('draft','finalized')
      AND COALESCE(o.finalized_at,o.created_at)>=? AND COALESCE(o.finalized_at,o.created_at)<?
      AND (? IS NULL OR o.user_id IN (SELECT value FROM json_each(?)))
      UNION ALL
      SELECT o.number,COALESCE(o.finalized_at,o.created_at),o.status,o.kind,
      json_extract(o.payload,'$.warehouseName'),json_extract(line.value,'$.code'),
      json_extract(line.value,'$.name'),json_extract(line.value,'$.quantity')
      FROM orders o JOIN json_each(o.payload, '$.standItems') line
      WHERE o.kind='combined' AND o.status IN ('draft','finalized')
      AND COALESCE(o.finalized_at,o.created_at)>=? AND COALESCE(o.finalized_at,o.created_at)<?
      AND (? IS NULL OR o.user_id IN (SELECT value FROM json_each(?)))
      UNION ALL
      SELECT o.number,COALESCE(o.finalized_at,o.created_at),o.status,o.kind,
      json_extract(o.payload,'$.warehouseName'),NULL,'SIM 0 Vodafone',COALESCE(json_array_length(o.payload,'$.serials'),0)
      FROM orders o WHERE ? AND o.kind IN ('sim','combined') AND o.status IN ('draft','finalized')
      AND COALESCE(o.finalized_at,o.created_at)>=? AND COALESCE(o.finalized_at,o.created_at)<?
      AND (? IS NULL OR o.user_id IN (SELECT value FROM json_each(?)))
      AND (o.kind='sim' OR json_array_length(o.payload,'$.serials')>0) ORDER BY at,document LIMIT ?`)
      .bind(Number(!!options),start,end,agents,agents,start,end,agents,agents,Number(!!options),start,end,agents,agents,limit).all<OrdersLine>();
    assertOperationBudget(result.results.length,max);
    rows=result.results.filter(row=>include(row.sku)).map(row=>({month,date:date(row.at),document:row.document,
      warehouse:row.warehouse,sku:row.sku,product:row.product,status:row.phase,units:row.units,lines:1,...(options?{kind:row.kind}:{}),
      ...(options&&row.sku===null&&row.product==='SIM 0 Vodafone'?{group:'vodafone_0'}:{})}));
  } else if (dataset==='transfers') {
    const warehouses=selected(scope.filter?.warehouseIds);
    const result = await db().prepare(`SELECT json_extract(s.value,'$.number') document,json_extract(s.value,'$.finalizedAt') at,
      json_extract(s.value,'$.source.warehouseName') warehouse,
      CASE WHEN (? IS NULL OR json_extract(s.value,'$.destination.warehouseId') IN (SELECT value FROM json_each(?)))
        THEN json_extract(s.value,'$.destination.warehouseName') ELSE NULL END target,
      json_extract(line.value,'$.code') sku,json_extract(line.value,'$.name') product,json_extract(line.value,'$.quantity') units
      FROM settings s JOIN json_each(s.value,'$.lines') line
      WHERE s.key LIKE 'transfer-v1:%' AND json_extract(s.value,'$.status')='finalized'
      AND json_extract(s.value,'$.finalizedAt')>=? AND json_extract(s.value,'$.finalizedAt')<?
      AND (? IS NULL OR json_extract(s.value,'$.source.agentId') IN (SELECT value FROM json_each(?))) ORDER BY at,document LIMIT ?`)
      .bind(warehouses,warehouses,start,end,agents,agents,limit).all<TransferLine>();
    assertOperationBudget(result.results.length,max);
    rows=result.results.filter(row=>include(row.sku)).map(row=>({month,date:date(row.at),document:row.document,warehouse:row.warehouse,
      destination:row.target,sku:row.sku,product:row.product,units:row.units}));
  } else {
    const warehouses=await warehouseScope(scope);
    const names=new Map(warehouses.map(warehouse=>[warehouse.id,warehouse.name]));
    const result=await db().prepare(`SELECT json_extract(s.value,'$.finalizedAt') at,json_extract(s.value,'$.warehouseId') warehouseId,
      json_extract(line.value,'$.code') sku,json_extract(line.value,'$.name') product,json_extract(line.value,'$.expected') expected,
      json_extract(line.value,'$.counted') counted
      FROM settings s JOIN json_each(s.value,'$.lines') line
      WHERE s.key LIKE 'inventory-v1:%' AND json_extract(s.value,'$.status')='finalized'
      AND json_extract(s.value,'$.finalizedAt')>=? AND json_extract(s.value,'$.finalizedAt')<?
      AND json_extract(s.value,'$.warehouseId') IN (SELECT value FROM json_each(?)) ORDER BY at,warehouseId LIMIT ?`)
      .bind(start,end,JSON.stringify([...names.keys()]),limit).all<InventoryLine>();
    assertOperationBudget(result.results.length,max);
    rows=result.results.filter(row=>include(row.sku)).map(row=>({month,date:date(row.at),warehouse:names.get(row.warehouseId)??null,
      sku:row.sku,product:row.product,expected:row.expected,counted:row.counted,
      difference:row.counted===null||row.expected===null?null:row.counted-row.expected}));
  }
  const limits = {
    orders:'Data finalizării pentru comenzi finale și data creării pentru ciorne. Statusul permite separarea lor.',
    inventories:'Inventarele finalizate în luna aleasă. Repetarea unui SKU în inventare diferite reprezintă observații distincte.',
    transfers:'Gestiunea sursă este în selecție. Destinația din afara portofoliului este omisă.',
  };
  return {rows,coverage:[{source:sources[dataset],month,available:true,
    through:typeof rows.at(-1)?.date==='string'?String(rows.at(-1)?.date):null,
    note:(options?'Sunt incluse produsele tuturor categoriilor. ':'Sunt incluse codurile atribuite explicit Vodafone în catalog. ')+limits[dataset]}]};
}
