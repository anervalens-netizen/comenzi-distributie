import assert from 'node:assert/strict';
import {createAnafLookup} from '../lib/anaf.ts';
import {validAnafCui,normalizeAnafCui} from '../lib/anaf-types.ts';
const cui='900000000',other='900000018';
assert.equal(normalizeAnafCui(' ro 900000000 '),cui);
assert.equal(validAnafCui(cui),true);
assert.equal(validAnafCui(other),true);
for(const invalid of ['','RO','900000001','900-000000','000000000','12345678901'])assert.equal(validAnafCui(invalid),false,invalid);
let now=Date.parse('2026-01-01T22:30:00Z'),calls=0;
const payload=(id=cui,flags=true)=>({found:[{date_generale:{cui:Number(id),data:'2026-01-02',denumire:'Synthetic Company',adresa:'Synthetic Fiscal Address',nrRegCom:'J-SYNTHETIC'},...(flags?{inregistrare_scop_Tva:{scpTVA:false},stare_inactiv:{statusInactivi:true}}:{})}],notFound:[]});
const fetcher=async(url,options)=>{calls++;assert.equal(url,'https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva');assert.equal(options.redirect,'error');assert.deepEqual(JSON.parse(options.body),[{cui:Number(cui),data:'2026-01-02'}]);return Response.json(payload());};
const lookup=createAnafLookup({fetcher,clock:()=>now});
assert.equal((await lookup('900000001')).status,'invalid');assert.equal(calls,0);
const result=await lookup('RO'+cui);assert.equal(result.status,'found');assert.equal(result.company.inactive,true);assert.equal(result.company.vatRegistered,false);
const cached=await lookup(cui);assert.equal(cached.cached,true);assert.equal(cached.checkedAt,result.checkedAt);assert.equal(calls,1);
assert.equal((await lookup(other)).status,'unavailable');assert.equal(calls,1);
now+=3600001;assert.equal((await lookup(cui)).status,'found');assert.equal(calls,2);
for(const data of [{cod:200,found:[],notFound:[Number(cui)]},payload(cui,false)]){
 const response=await createAnafLookup({fetcher:async()=>Response.json(data),clock:()=>now})(cui);
 if(!data.found.length)assert.equal(response.status,'not_found');else {assert.equal(response.company.inactive,null);assert.equal(response.company.vatRegistered,null);}
}
for(const data of [{},payload(other),{...payload(),cod:500},{...payload(),notFound:[cui]},{cod:200,found:[],notFound:[]}]){
 assert.equal((await createAnafLookup({fetcher:async()=>Response.json(data),clock:()=>now})(cui)).status,'unavailable');
}
for(const fetcher of [
 async()=>new Response('x',{status:503}),
 async()=>new Response('<html>not JSON</html>'),
 async()=>new Response('x'.repeat(131073)),
 async()=>{throw new Error('network')},
 (_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout'))))
]){
 assert.equal((await createAnafLookup({fetcher,clock:()=>now,timeoutMs:10})(cui)).status,'unavailable');
}
let release;calls=0;
const shared=createAnafLookup({clock:()=>now,fetcher:()=>{calls++;return new Promise(r=>release=r)}});
const a=shared(cui),b=shared(cui);
assert.equal((await shared(other)).status,'unavailable');assert.equal(calls,1);
release(Response.json(payload()));assert.deepEqual(await a,await b);
console.log('PASS ANAF: checksum, Bucharest date, strict response identity, unknown flags, cache, throttle, coalescing, outage, timeout and response bound');

let missingCalls=0;
const missing=createAnafLookup({clock:()=>now,fetcher:async()=>{missingCalls++;return Response.json({found:[],notFound:[Number(cui)]},{status:404});}});
const notFound=await missing(cui);
assert.equal(notFound.status,'not_found');assert.ok(notFound.checkedAt);
assert.equal((await missing(cui)).cached,true);assert.equal(missingCalls,1);
for(const fetcher of [
 async()=>new Response('<html>Not Found</html>',{status:404}),
 async()=>Response.json({found:[],notFound:[Number(other)]},{status:404}),
 async()=>Response.json(payload(),{status:404}),
 async()=>Response.json({found:[],notFound:[Number(cui)]},{status:500})
])assert.equal((await createAnafLookup({fetcher,clock:()=>now})(cui)).status,'unavailable');
console.log('PASS live-contract regression: 404 JSON not-found cached; HTML/mismatch/found-on-404/500 remain unavailable');
