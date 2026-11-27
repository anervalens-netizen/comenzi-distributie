// Synthetic SQLite only. Imports declarations as source; never loads runtime,
// application resources, mail delivery, queue workers or external databases.
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {runSettingsContract} from './settings-contract.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
mkdirSync('work',{recursive:true});const folder=mkdtempSync(resolve('work/settings-contract-'));
let database,other;
const sourceFile=file=>{
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body.map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return {code,nodes};
};
function declarations(source,names){
  return names.map(name=>{
    const matches=source.nodes.filter(node=>node.id?.name===name||node.type==='VariableDeclaration'&&node.declarations.some(item=>item.id.name===name));
    if(matches.length!==1)throw new Error('Original declaration missing or duplicated: '+name);
    return source.code.slice(matches[0].start,matches[0].end);
  }).join('\n');
}
function pathEquals(node,index,value){
  if(node.type==='LogicalExpression')return pathEquals(node.left,index,value)||pathEquals(node.right,index,value);
  return node.type==='BinaryExpression'&&node.operator==='==='&&node.left.type==='MemberExpression'
    &&node.left.object.name==='path'&&node.left.computed&&node.left.property.value===index&&node.right.value===value;
}
try{
  const moduleFile=join(folder,'settings.mjs');
  await build({stdin:{contents:"export * from './lib/sql-database';export * from './lib/sql-sqlite';export * from './lib/session-repository-async';"
    +"export * from './lib/authority-repository-async';export * from './lib/settings-repository-async';",loader:'ts',resolveDir:resolve('.')},
    outfile:moduleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const api=await import(pathToFileURL(moduleFile)),file=join(folder,'app.sqlite'),ledger=join(folder,'ledger.sqlite');
  const open=()=>{const connection=new DatabaseSync(file);connection.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=100;PRAGMA journal_mode=WAL');
    connection.prepare('ATTACH DATABASE ? AS ledger').run(ledger);return connection;};
  const setup=open();for(const sql of authorityFixtureStatements(api,'main','ledger','sqlite'))setup.exec(sql);
  database=new api.SqliteDatabase(setup);other=new api.SqliteDatabase(open());
  const originals=['lib/server.ts','app/api/[...path]/route.ts','lib/weekly-order-limit.ts'];
  const server=sourceFile(originals[0]),route=sourceFile(originals[1]);
  const readerCode=declarations(server,['readAppSettings','settings','operationalMailSettings','withOperationalMailOverride',
    'settingsForAgent','regionalOperationalSettings','managerMailSettings','settingsForOrder']);
  const functions=route.nodes.filter(node=>node.type==='FunctionDeclaration'&&node.id.name==='authenticatedRoute');
  if(functions.length!==1)throw new Error('Original authenticatedRoute declaration missing');
  const admins=functions[0].body.body.filter(node=>node.type==='IfStatement'&&pathEquals(node.test,0,'admin'));
  if(admins.length!==1||admins[0].consequent.type!=='BlockStatement')throw new Error('Original admin route block differs');
  const branches=['settings','regional-settings','manager-mail'].map(name=>{
    const nodes=admins[0].consequent.body.filter(node=>node.type==='IfStatement'&&pathEquals(node.test,1,name));
    if(nodes.length!==1)throw new Error('Original settings branch missing: '+name);
    return route.code.slice(nodes[0].start,nodes[0].end);
  }).join('\n');
  const oracleFile=join(folder,'legacy.mjs');
  await build({stdin:{contents:"import {parseWeeklyLimit,persistWeeklyLimit} from './lib/weekly-order-limit';\n"
    +"export function makeOracle(db,mailDefaults){\nclass AppError extends Error{constructor(status,message){super(message);this.status=status;this.name='AppError';}}\n"
    +"const fail=(status,message)=>{throw new AppError(status,message);};const textField=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';\n"
    +"const isGlobalManager=user=>user.role==='manager'&&user.managerScope==='global';const requireManager=user=>{if(user.role!=='manager')fail(403,'manager');};\n"
    +"const requireGlobalManager=user=>{requireManager(user);if(!isGlobalManager(user))fail(403,'global');};const response=value=>value;\n"
    +readerCode+"\nasync function mutate(kind,body,user){const req={method:'PUT'},path=['admin',kind];const jsonBody=async()=>body;requireManager(user);\n"
    +branches+"\nthrow new Error('Unknown original route');}\nreturn {readAppSettings,settings,settingsForAgent,regionalOperationalSettings,managerMailSettings,settingsForOrder,mutate};}",
    loader:'ts',resolveDir:resolve('.')},outfile:oracleFile,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const {makeOracle}=await import(pathToFileURL(oracleFile));
  const normal=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normal):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normal(item)])):value;
  let oracleComparisons=0,oracleWrites=0,independentCommits=0;
  const legacyOracle=async({kind,method,args,viewerId,defaults})=>{
    // Capture all inputs in one adapter read snapshot, then run the unmodified
    // legacy declarations against a fresh, isolated native SQLite oracle.
    const snapshot=await database.read(async tx=>{
      const result={};for(const table of ['users','manager_agents','settings'])result[table]=normal((await tx.query(
        api.sqlQuery('read','SELECT * FROM "main".'+table,'SELECT * FROM "main".'+table))).rows);return result;
    });
    const native=new DatabaseSync(':memory:');native.exec("PRAGMA foreign_keys=ON;ATTACH DATABASE ':memory:' AS ledger");
    for(const sql of authorityFixtureStatements(api,'main','ledger','sqlite'))native.exec(sql);
    try{
      native.exec('BEGIN IMMEDIATE');
      for(const [table,rows]of Object.entries(snapshot))for(const row of rows){
        const columns=Object.keys(row),statement=native.prepare('INSERT INTO "'+table+'"('+columns.map(c=>'"'+c+'"').join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
        statement.run(...columns.map(c=>row[c]));
      }native.exec('COMMIT');
      const action=work=>{native.exec('BEGIN IMMEDIATE');try{const result=work();native.exec('COMMIT');return result;}
        catch(error){if(native.isTransaction)native.exec('ROLLBACK');throw error;}};
      const statement=(sql,values=[])=>({bind:(...next)=>statement(sql,next),
        first:async column=>{const row=native.prepare(sql).get(...values);return row?(column?row[column]:normal({...row})):null;},
        all:async()=>({results:native.prepare(sql).all(...values).map(row=>normal({...row}))}),
        execute:()=>{const rows=native.prepare(sql).all(...values);return{results:rows.map(row=>normal({...row})),meta:{changes:Number(native.prepare('SELECT changes() n').get().n)}};},
        run:async()=>action(()=>statement(sql,values).execute())});
      const db=()=>({prepare:sql=>statement(sql),batch:async statements=>action(()=>statements.map(item=>item.execute()))});
      const original=makeOracle(db,structuredClone(defaults));let result;
      try{result={ok:true,result:kind==='write'?await original.mutate(method,structuredClone(args[0]),api.accountRecord(snapshot.users.find(row=>row.id===viewerId))):await original[method](...structuredClone(args))};}
      catch(error){result={ok:false,status:error.status??null,errorName:error.name};}
      result.settings=native.prepare('SELECT key,value FROM settings ORDER BY key').all().map(row=>({...row}));
      oracleComparisons++;if(kind==='write')oracleWrites++;return result;
    }finally{native.close();}
  };
  const concurrentWrite=async statements=>{
    const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.path);try{db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=1000;BEGIN IMMEDIATE');
        for(const item of workerData.statements)db.prepare(item.sql).run(...item.values);db.exec('COMMIT');parentPort.postMessage({committed:true});
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');parentPort.postMessage({error:error.message});}finally{db.close();}`,{
      eval:true,workerData:{path:file,statements:statements.map(item=>({sql:item.query.sqlite,values:item.values}))}});
    let timer;try{await new Promise((done,reject)=>{
      timer=setTimeout(()=>reject(new Error('Independent settings writer timed out')),5000);worker.once('error',reject);
      worker.once('message',value=>value.error?reject(new Error(value.error)):value.committed===true?done():reject(new Error('Missing commit acknowledgement')));
      worker.once('exit',code=>{if(code!==0)reject(new Error('Independent settings writer exited '+code));});
    });independentCommits++;}finally{clearTimeout(timer);await worker.terminate();}
  };
  const cases=await runSettingsContract(api,{database,other,applicationSchema:'main',legacyOracle,concurrentWrite});
  console.log(JSON.stringify({kind:'async-settings-synthetic-contract',engine:'sqlite',sqlite_version:process.versions.sqlite,passed:true,
    case_count:cases.length,case_ids:cases,original_source_oracle_comparisons:oracleComparisons,original_write_oracles:oracleWrites,
    independent_wal_commits:independentCommits,original_source_sha256:Object.fromEntries(originals.map(path=>[path,hash(readFileSync(path))])),
    postgresql_executed:false,runtime_wired:false,messages_sent:false}));
}finally{await database?.close();await other?.close();rmSync(folder,{recursive:true,force:true});}
