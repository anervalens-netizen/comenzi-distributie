import assert from 'node:assert/strict';import {build} from 'esbuild';
const b=await build({entryPoints:['lib/distribution-sales.ts'],bundle:true,platform:'node',format:'esm',write:false});const m=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const rules={revision:'synthetic',products:{ZERO:'vodafone_0',THREE:'vodafone_3',FIVE:'vodafone_5',BATTERY:'varta',CABLE:'accessories',SCENT:'scent',DIGI:'digi'}};
const view=(month,products)=>({month,filename:'synthetic',products:products.map(([itemCode,quantity,value])=>({itemCode,quantity,value}))});
const a=view('2026-09',[['ZERO',1000,0],['THREE',2,20],['BATTERY',3,6],['CABLE',4,12]]),b2=view('2026-10',[['FIVE',1,40],['SCENT',2,6],['DIGI',3,9],['UNKNOWN',2,8]]);
const r=m.distributionSales([a,b2],rules,['2026-09','2026-10']);assert.equal(r.vodafoneCredit.quantity,3);assert.equal(r.vodafoneCredit.average,20);assert.equal(r.groups.vodafone_0.quantity,1000);assert.equal(r.groups.accessories.quantity,4);assert.equal(r.groups.varta.quantity,3);assert.equal(r.groups.scent.quantity,2);assert.equal(r.groups.unmapped.quantity,2);
assert.equal(m.distributionSales([view('x',[['THREE',1,10],['FIVE',-1,-20]])],rules,[]).vodafoneCredit.average,null);
assert.equal(m.distributionSales([view('x',[['THREE',-1,-10]])],rules,[]).vodafoneCredit.average,null);
console.log('PASS: integer totals, weighted multi-month mean, zero-credit exclusion, returns and disjoint exact product groups.');
