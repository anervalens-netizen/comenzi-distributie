import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';
const b=await build({stdin:{contents:"export * from './lib/activation-partner-sort';export * from './lib/activation-partners-node';export * from './lib/order-product-group';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',write:false});
const {activationTodayWindow,compareActivationPartners,activationPartnerView,orderProductGroup}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
assert.deepEqual(activationTodayWindow(new Date('2026-10-25T22:30:00Z')),{from:'2026-10-22',to:'2026-10-26'},'Romanian date after UTC midnight offset and DST transition');
assert.deepEqual(activationTodayWindow(new Date('2026-01-01T00:00:00Z')),{from:'2025-12-28',to:'2026-01-01'},'year boundary includes five dates');
const db=new DatabaseSync(':memory:');
try{
 db.exec('CREATE TABLE details(company,provider,is_tr,month,activation_date,point_key,client_code,point_code,label,site)');
 for(const [date,site,company] of [['2026-10-21','A','One'],['2026-10-22','A','One'],['2026-10-25','A','One'],['2026-10-26','A','One'],['2026-10-27','A','One'],['2026-10-23','B','One'],['2026-10-23','A','Two']]){
  db.prepare('INSERT INTO details VALUES(?,?,?,?,?,?,?,?,?,?)').run(company,'vodafone',1,'2026-10',date,JSON.stringify([company,'C','P']),'C','P',company,site);
 }
 const result={provider:'vodafone',latestDate:'2026-10-25'};
 activationPartnerView(db,result,'provider=? AND site=?',['vodafone','A'],{months:['2026-10'],rules:{assignments:[]},view:'partners',todayWindow:{from:'2026-10-22',to:'2026-10-26'}});
 assert.equal(result.partners.rows.find(p=>p.company==='One').recentToday,3,'includes today and start date, excludes older/future and other seller');
 assert.equal(result.partners.rows.find(p=>p.company==='Two').recentToday,1,'company identities remain distinct');
 const historical={provider:'vodafone',latestDate:'2026-10-25'};
 activationPartnerView(db,historical,'provider=? AND site=?',['vodafone','A'],{months:['2026-09'],rules:{assignments:[]},view:'partners',todayWindow:{from:'2026-10-22',to:'2026-10-26'}});
 assert.equal(historical.partners.rows.find(p=>p.company==='One').recentToday,3,'the current calendar window remains visible across selected months');
 assert.equal(historical.partners.rows.find(p=>p.company==='One').total,0,'the selected-period total is preserved');
 const rows=Array.from({length:60},(_,i)=>({key:String(i),label:'Point '+i,total:i,recentToday:60-i,lastDate:i?'2026-10-01':null,vodafone:i,digi:60-i}));
 assert.equal([...rows].sort((a,b)=>compareActivationPartners(a,b,'recentToday','desc'))[0].key,'0');
 assert.equal([...rows].sort((a,b)=>compareActivationPartners(a,b,'total','desc'))[0].key,'59');
 assert.equal([...rows].sort((a,b)=>compareActivationPartners(a,b,'total','asc'))[0].key,'0');
 assert.equal(compareActivationPartners({...rows[0],label:'Ălfa'},{...rows[1],label:'Zeta'},'label','asc')<0,true);
 for(const category of ['Role','Consumabile','Mercantizare Vodafone'])assert.equal(orderProductGroup({kind:'stands',category}),'merchandising');
 assert.equal(orderProductGroup({kind:'stands',category:'Telefoane'}),'stands');
 assert.equal(orderProductGroup({kind:'accessories',category:'Huse & folii'}),'accessories');
}finally{db.close();}
console.log('PASS: five calendar days, Romanian midnight/DST/year boundary, seller and company scope, ordering and catalog groups.');
