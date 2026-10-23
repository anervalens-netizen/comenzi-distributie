import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['lib/manager-sales-report.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {managerCategoryRows,managerProductCategory,managerCategoryLabels}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const product=(itemCode,quantity,value,extra)=>({itemCode,itemName:'Synthetic '+itemCode,brand:'Example',category:'Cabluri',subCategory:'',rows:1,quantity,value,segment:'accessories',...extra});
const products=[product('CABLE',4,12,{distributionGroup:'accessories'}),product('RETURN',-1,-3,{distributionGroup:'accessories'}),product('BATTERY',2,8,{distributionGroup:'varta'}),product('SCENT',3,9,{distributionGroup:'scent'}),product('ZERO',1000,0,{distributionGroup:'vodafone_0'}),product('CREDIT',2,20,{distributionGroup:'vodafone_3'}),product('DIGI',1,4,{distributionGroup:'digi'}),product('PHONE',1,100,{distributionGroup:'unmapped',segment:'phones'}),product('VOUCHER',3,30,{distributionGroup:'unmapped',segment:'cardsSim',subsegment:'vouchers'}),product('UNKNOWN',1,5,{distributionGroup:'unmapped'})];
const rows=managerCategoryRows(products),accessories=rows.filter(row=>row.category==='accessories');
assert.equal(accessories.length,1);assert.equal(accessories[0].quantity,3);assert.equal(accessories[0].valueCents,900,'category values include exact cent returns');
for(const [category,quantity] of [['varta',2],['scent',3],['phones',1],['vouchers',3],['other',1]])assert.equal(rows.find(row=>row.category===category)?.quantity,quantity);
assert.equal(rows.reduce((sum,row)=>sum+row.quantity,0),13,'prepay is excluded from accessories and other categories');
assert.equal(managerProductCategory(product('UNCONFIGURED',1,2,{})),'accessories','unconfigured installations retain their existing accessory segment');
assert.equal(managerProductCategory(product('UNCONFIGURED-SIM',1,2,{segment:'cardsSim',subsegment:'sim'})),null,'legacy SIM sales remain in Prepay without duplicate other-product totals');
assert.equal(managerProductCategory(product('MAPPED-SIM',1,2,{distributionGroup:'vodafone_credit',segment:'accessories'})),null,'authoritative mapping wins over broader legacy segment');
assert.equal(managerCategoryLabels.other,'Produse de verificat');
const residual=[
 product('RESIDUAL-ZERO',7,0,{distributionGroup:'unmapped',segment:'cardsSim',subsegment:'sim',category:'Source supplies',subCategory:'Starter'}),
 product('RESIDUAL-RETURN',-2,-0.06,{distributionGroup:'unmapped',category:' Source supplies ',subCategory:' Starter '}),
 product('RESIDUAL-SUBCATEGORY',3,0.3,{distributionGroup:'unmapped',category:'Source supplies',subCategory:'Refill'}),
 product('RESIDUAL-CATEGORY',4,4.04,{distributionGroup:'unmapped',category:'Source equipment',subCategory:'Starter'}),
 product('RESIDUAL-BLANK',1,1.15,{distributionGroup:'unmapped',category:' ',subCategory:''}),
 product('RESIDUAL-SUBCATEGORY-ONLY',2,0,{distributionGroup:'unmapped',category:'',subCategory:'Source detail'}),
];
const configured=[product('MAPPED-ACCESSORY',2,2.02,{distributionGroup:'accessories',category:'Source supplies',subCategory:'Starter'}),product('MAPPED-BATTERY',1,0.1,{distributionGroup:'varta',segment:'phones'}),product('MAPPED-ZERO',11,0,{distributionGroup:'vodafone_0',category:'Source supplies',subCategory:'Starter'})];
const allRows=managerCategoryRows([...residual,...configured]),residualRows=allRows.filter(row=>row.category==='other');
assert.equal(residualRows.length,5,'source category and subcategory form distinct residual groups');
const starter=residualRows.find(row=>row.name==='Source supplies · Starter');
assert.equal(starter.quantity,5,'net residual quantity retains returns and zero-value SIMs');
assert.equal(starter.valueCents,-6,'residual value retains negative cents exactly');
assert.deepEqual(starter.products.map(p=>p.itemCode),['RESIDUAL-ZERO','RESIDUAL-RETURN'],'every grouped product remains inspectable');
assert.equal(residualRows.find(row=>row.name==='Source supplies · Refill').valueCents,30);
assert.equal(residualRows.find(row=>row.name==='Source equipment · Starter').valueCents,404);
assert.equal(residualRows.find(row=>row.name==='Fără categorie în sursă').valueCents,115);
assert.equal(residualRows.find(row=>row.name==='Fără categorie în sursă · Source detail').quantity,2);
assert.deepEqual(residualRows.flatMap(row=>row.products.map(p=>p.itemCode)).sort((a,b)=>a.localeCompare(b)),residual.map(p=>p.itemCode).sort((a,b)=>a.localeCompare(b)),'all residual source products survive grouping');
assert.equal(residualRows.reduce((sum,row)=>sum+row.quantity,0),residual.reduce((sum,p)=>sum+p.quantity,0));
assert.equal(residualRows.reduce((sum,row)=>sum+row.valueCents,0),residual.reduce((sum,p)=>sum+Math.round(p.value*100),0));
assert.equal(allRows.find(row=>row.category==='accessories').valueCents,202,'configured accessories remain outside residual groups with identical source categories');
assert.equal(allRows.find(row=>row.category==='varta').valueCents,10,'exact mapping wins over the older phone segment');
assert(!allRows.some(row=>row.products.some(p=>p.itemCode==='MAPPED-ZERO')),'configured Prepay is not duplicated as residual products');
console.log('PASS: authoritative groups, source category/subcategory residual breakdown, exact net quantities/cents/returns and complete product retention.');
