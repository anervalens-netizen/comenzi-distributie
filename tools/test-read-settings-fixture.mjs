// Pure fixture boundary checks. No PostgreSQL, application or network is opened.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync('tools/settings-contract.mjs','utf8');
const start=source.indexOf('  const pgParameterReader=');
const end=source.indexOf('\n  async function oracle',start);
assert(start>=0&&end>start&&source.indexOf('  const pgParameterReader=',start+1)===-1);
const reader=runInNewContext(source.slice(start,end)+'\npgParameterReader;',
  {assert,TextDecoder,Uint8Array},{timeout:1000});
const cases=[];
for(const dialect of ['sqlite','postgresql'])for(const column of ['key','ma.manager_id','ma.agent_id']){
  const bytes=new TextEncoder().encode('fictional\u0000suffix');let observed;
  const tx={dialect,query:async(_statement,values)=>{observed=values;return{rows:[],changes:0};}};
  await reader(tx,[]).query({postgresql:`SELECT 1 WHERE convert_to(${column},'UTF8')=$1::bytea`},[bytes]);
  if(dialect==='sqlite')assert.equal(observed[0],'fictional\u0000suffix');
  else{assert(observed[0] instanceof Uint8Array);assert.equal(observed[0],bytes);}
  cases.push(dialect+':nul:'+column);
}
for(const dialect of ['sqlite','postgresql']){
  let observed;await reader({dialect,query:async(_sql,values)=>{observed=values;return{rows:[]};}},[])
    .query({postgresql:'SELECT 1 WHERE key=$1'},['fictional']);
  assert.deepEqual(observed,['fictional']);cases.push(dialect+':normal-text');
}
assert.throws(()=>reader({dialect:'postgresql',query:()=>assert.fail('Must refuse before SQL')},[])
  .query({postgresql:'SELECT 1 WHERE key=$1'},['fictional\u0000suffix']),/TEXT parameter contains NUL/);
cases.push('nul-text-refused-before-sql');
assert.throws(()=>reader({dialect:'postgresql',query:()=>assert.fail('Must refuse changed predicate')},[])
  .query({postgresql:'SELECT 1 WHERE key=$1'},[new Uint8Array([1])]),/convert_to/);
cases.push('binary-predicate-mismatch-refused');
console.log(JSON.stringify({kind:'read-settings-fixture-pure-guards',passed:true,case_count:cases.length,
  case_ids:cases,postgresql_executed:false}));
