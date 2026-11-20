import assert from 'node:assert/strict';import {build} from 'esbuild';
const b=await build({entryPoints:['lib/distribution-sales.ts'],bundle:true,platform:'node',format:'esm',write:false});const m=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const rules={revision:'synthetic',products:{ZERO:'vodafone_0',THREE:'vodafone_3',FIVE:'vodafone_5',BATTERY:'varta',CABLE:'accessories',SCENT:'scent',DIGI:'digi'}};
const view=(month,products)=>({month,filename:'synthetic',products:products.map(([itemCode,quantity,value])=>({itemCode,quantity,value}))});
const a=view('2026-09',[['ZERO',1000,0],['THREE',2,20],['BATTERY',3,6],['CABLE',4,12]]),b2=view('2026-10',[['FIVE',1,40],['SCENT',2,6],['DIGI',3,9],['UNKNOWN',2,8]]);
const r=m.distributionSales([a,b2],rules,['2026-09','2026-10']);assert.equal(r.vodafoneCredit.quantity,3);assert.equal(r.vodafoneCredit.average,20);assert.equal(r.groups.vodafone_0.quantity,1000);assert.equal(r.groups.accessories.quantity,4);assert.equal(r.groups.varta.quantity,3);assert.equal(r.groups.scent.quantity,2);assert.equal(r.groups.unmapped.quantity,2);
assert.equal(m.distributionSales([view('x',[['THREE',1,10],['FIVE',-1,-20]])],rules,[]).vodafoneCredit.average,null);
assert.equal(m.distributionSales([view('x',[['THREE',-1,-10]])],rules,[]).vodafoneCredit.average,null);
console.log('PASS: integer totals, weighted multi-month mean, zero-credit exclusion, returns and disjoint exact product groups.');

const axis=await build({entryPoints:['lib/monthly-axis.ts'],bundle:true,platform:'node',format:'esm',write:false});const {monthlyAxisNumber}=await import('data:text/javascript;base64,'+Buffer.from(axis.outputFiles[0].text).toString('base64'));
assert.equal(new Set([0,.02,.04].map(monthlyAxisNumber)).size,3,'small nonzero axis ticks remain distinct');
assert.notEqual(monthlyAxisNumber(-.02),monthlyAxisNumber(.02),'return-driven negative values keep their sign');
assert(monthlyAxisNumber(352075.339).length<10,'large amounts use short axis labels');

// A cached multi-month read must release the event loop and stop after its reader leaves.
const stubs={
  './server':`
    export const isGlobalManager=()=>true;
    export const db=()=>({prepare(){const stmt={bind(){return stmt},all:async()=>({results:[]}),first:async()=>null};return stmt}});
    export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
    export const response=Response.json, catalog=[], AppError=Error, readLimited=()=>{}, requireManager=()=>{};
  `,
  './catalog':'export const readCatalog=async()=>({products:[]});',
  './manager-scope':'export const managerFilter=async()=>null;',
  './distribution-config':"export const readDistributionRules=async()=>({assignments:[],products:{},revision:'fixture'});",
  './sales-view-runtime':'export const getSalesViewRuntime=(...args)=>globalThis.__monthlySalesRead(...args);',
  './sales-store':'export const salesRevision=()=>1,currentSalesImport=()=>null,importSalesRows=()=>{},latestSalesImport=()=>null,latestSalesMonth=()=>null,salesCoverageChange=()=>{},saveSalesOriginal=()=>{};',
  './historical-sales':'export const historicalSalesGeneration=()=>1;',
  './sales-parser-runtime':'export const parseSalesFileRuntime=()=>{};',
  './import-write-authorization':'export const withImportAuthorization=()=>{},withCapturedImportAuthorization=()=>{};',
};
const apiBuild=await build({stdin:{contents:"export {salesView} from './lib/sales-server';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false,plugins:[{
  name:'synthetic-monthly-sales',setup(plugin){
    plugin.onResolve({filter:/^\.\//},args=>Object.hasOwn(stubs,args.path)?{path:args.path,namespace:'sales-fixture'}:undefined);
    plugin.onLoad({filter:/.*/,namespace:'sales-fixture'},args=>({contents:stubs[args.path]}));
  },
}]});
const {salesView}=await import('data:text/javascript;base64,'+Buffer.from(apiBuild.outputFiles[0].text).toString('base64'));
const controller=new AbortController(),readMonths=[];
const request=new Request('http://fixture.invalid/api/sales?month=2026-03&months=2026-01,2026-02,2026-03',{signal:controller.signal});
try{
  globalThis.__monthlySalesRead=async month=>{
    readMonths.push(month);
    setTimeout(()=>controller.abort(),0);
    return {month,sites:[],products:[]};
  };
  await assert.rejects(()=>salesView(request,{role:'manager',id:'synthetic'}),e=>e.status===499);
  assert.deepEqual(readMonths,['2026-01'],'later cached months must not run after the navigation is cancelled');
}finally{delete globalThis.__monthlySalesRead;}
console.log('PASS: a cancelled multi-month Sales request stops between cached monthly reads.');
