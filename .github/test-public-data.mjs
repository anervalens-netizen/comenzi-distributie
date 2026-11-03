import assert from 'node:assert/strict';
import {inspectPublicFile} from './check-public-data.mjs';
assert.equal(inspectPublicFile('src/example.ts','const contact="review@example.invalid";').length,0);
assert.equal(inspectPublicFile('.env.example','TOKEN=replace-me').length,0);
for(const path of ['resources/seed.json','resources/initial-users.json','.env.production','backup.sqlite','private/report.txt','public/products/item.png'])assert.ok(inspectPublicFile(path,'{}').length>0,path);
const address=['person','gmail.com'].join('@');
assert.ok(inspectPublicFile('src/contact.ts',address).some(x=>x.kind==='non-example-email'));
const verifier=['scrypt','a'.repeat(32),'b'.repeat(64)].join(':');
assert.ok(inspectPublicFile('src/config.ts',verifier).some(x=>x.kind==='password-verifier'));
assert.ok(inspectPublicFile('src/config.ts',['','home','personal-user','config'].join('/')).some(x=>x.kind==='personal-home-directory'));
assert.equal(inspectPublicFile('src/config.ts','/home/operator/config').length,0);

// Fabricated digits only, generated independently of any application fixture.
// Values outside the project sentinel intentionally exercise rejection.
const mobile='07'+[2,6,0,4,8,1,5,9].join('');
const grouped=mobile.slice(1).match(/.{3}/g).join(' ');
const formats=[mobile,`+40${mobile.slice(1)}`,`0040${mobile.slice(1)}`,`+40 ${grouped}`,`0040 ${grouped}`,`+40 (${grouped.slice(0,3)}) ${grouped.slice(4)}`,`+40-${grouped.replaceAll(' ','-')}`,`0040.${grouped.replaceAll(' ','.')}`];
const flagged=(path,text)=>inspectPublicFile(path,text).some(x=>x.kind==='possible-personal-contact');
for(const phone of formats){
 assert.ok(flagged('tools/test-demo.mjs',`const sample='${phone}';`),'test filename rejects suspect mobile');
 assert.ok(flagged('src/demo.ts',`{contact:'Synthetic',phone:'${phone}'}`),'contact and phone need no address or tax ID');
}
for(const path of ['fixtures/sample.json','tests/sample.ts','__tests__/sample.ts','src/sample.test.ts','src/sample.spec.ts','tools/test_demo.py','test-data/sample.json','tools/fixture-demo.mjs']){
 assert.ok(flagged(path,`const sample='${mobile}';`),path);
}
for(const path of ['src/latest.ts','app/attestation.ts','app/contest.ts','src/fixtureFactory.ts']){
 assert.equal(flagged(path,`const unrelated='${mobile}';`),false,path);
 assert.ok(flagged(path,`const record={contact:'Synthetic',phone:'${mobile}'};`),'ordinary source contact still flags');
}
assert.ok(flagged('src/demo.ts',`const record={\n contact:'Synthetic',\n value:'${mobile}'\n};`),'small multiline record');
assert.equal(flagged('src/demo.ts',`const contact='Synthetic';\nconst unrelated='${mobile}';`),false,'unrelated adjacent lines');
assert.equal(flagged('src/demo.ts',`const meta={contact:'Synthetic'}; const unrelated='${mobile}';`),false,'separate same-line statements');
assert.equal(flagged('src/demo.ts',`const records=[{contact:'Synthetic'},{value:'${mobile}'}];`),false,'adjacent records do not share context');
assert.equal(flagged('src/demo.ts',`const meta={contact:'Synthetic'};\nconst unrelated={value:'${mobile}'};`),false,'separate multiline records');

// Existing obviously repeated or ascending QA fixtures are allowed only in genuine
// test/fixture files; new arbitrary phone numbers remain blocked everywhere.
for(const suffix of ['00','42','99']){
 const sentinel='07000000'+suffix;
 const sentinelGrouped=sentinel.slice(1).match(/.{3}/g).join(' ');
 for(const phone of [sentinel,`+40 ${sentinelGrouped}`,`0040 ${sentinelGrouped}`]){
  assert.equal(inspectPublicFile('tools/test-demo.mjs',`{contact:'Synthetic',phone:'${phone}'}`).length,0,'test-only sentinel');
  assert.ok(flagged('src/contact.ts',`{contact:'Synthetic',phone:'${phone}'}`),'sentinel is not a production contact exemption');
 }
}
for(const phone of ['07'+'6'.repeat(8),'07'+Array.from({length:8},(_,index)=>index).join('')]){
 assert.equal(flagged('tools/test-demo.mjs',`const sample='${phone}';`),false,'legacy obvious QA pattern in a fixture');
 assert.ok(flagged('src/contact.ts',`const record={contact:'QA',phone:'${phone}'};`),'do not exempt possible real contacts in source');
}
assert.ok(flagged('tools/test-demo.mjs',`const sample='${'0700000'+'314'}';`),'neighbour outside documented sentinel remains blocked');
const row=`{contact:'Synthetic',phone:'${mobile}'}`;
assert.ok(!JSON.stringify(inspectPublicFile('tools/test-demo.mjs',row)).includes(mobile),'diagnostics omit matched values');
assert.equal(inspectPublicFile('tools/test-demo.mjs',row,{checkPersonalContact:false}).length,0);
assert.ok(inspectPublicFile('tools/test-demo.mjs',address,{checkPersonalContact:false}).some(x=>x.kind==='non-example-email'),'contact exception never disables legacy checks');
console.log('PASS: public-data guard legacy checks, phone formats, context and test-only sentinels.');
