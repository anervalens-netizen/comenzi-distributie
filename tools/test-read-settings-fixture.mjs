// Pure fixture boundary checks. No PostgreSQL, application or network is opened.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {parse} from 'acorn';
import {transform} from 'esbuild';

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
// Execute the exact PostgreSQL-only fixture callsites with the real constructor.
// No driver is imported and no SQL is sent to a database.
const {code}=await transform(readFileSync('lib/sql-database.ts','utf8'),{loader:'ts',format:'esm'});
const api=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const fixture=readFileSync('tools/test-read-settings-postgres.mjs','utf8');
const ast=parse(fixture,{ecmaVersion:'latest',sourceType:'module'}),calls=[],declarations=new Map();
function visit(node){
  if(!node||typeof node!=='object')return;
  if(node.type==='VariableDeclarator'&&node.id.type==='Identifier')declarations.set(node.id.name,node.init);
  if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&!node.callee.computed
    &&node.callee.object.type==='Identifier'&&node.callee.object.name==='api'&&node.callee.property.name==='sqlQuery')calls.push(node);
  for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
}
visit(ast);assert.equal(calls.length,2,'Preserve both exact fixture SQL constructor callsites');
const app='"fixture_synthetic"',context={api,app};
if(declarations.has('identitySql')){
  const node=declarations.get('identitySql');context.identitySql=runInNewContext(fixture.slice(node.start,node.end),context,{timeout:1000});
}
const readCall=calls.find(node=>node.arguments[0].value==='read');
const identity=runInNewContext(fixture.slice(readCall.start,readCall.end),context,{timeout:1000});
assert.equal(identity.kind,'read');assert.equal(typeof identity.sqlite,'string');
assert.equal(identity.postgresql,identity.sqlite);assert.match(identity.postgresql,/session_user AS session_role/);
cases.push('real_constructor_identity_has_both_dialects');
const writeCall=calls.find(node=>node.arguments[0].value==='write'),mutationNode=declarations.get('negativeMutations');
const mutations=runInNewContext(fixture.slice(mutationNode.start,mutationNode.end),context,{timeout:1000});
assert.equal(mutations.length,3);
for(const sql of mutations){
  const query=runInNewContext(fixture.slice(writeCall.start,writeCall.end),{...context,sql},{timeout:1000});
  assert.equal(query.kind,'write');assert.equal(query.sqlite,sql);assert.equal(query.postgresql,sql);
}
cases.push('real_constructor_customer_negatives_have_both_dialects');
console.log(JSON.stringify({kind:'read-settings-fixture-pure-guards',passed:true,case_count:cases.length,
  case_ids:cases,postgresql_executed:false}));
