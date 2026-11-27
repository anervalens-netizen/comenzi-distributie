// Original source declarations, evaluated only against coherent synthetic
// snapshots. This helper never imports the application runtime or delivers mail.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {build,transformSync} from 'esbuild';
import {parse} from 'acorn';
import {authorityFixtureStatements} from './authority-session-contract.mjs';
import {catalogCustomerFixtureStatements} from './catalog-customer-contract.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function parsed(file){
  const code=transformSync(readFileSync(file,'utf8'),{loader:'ts',format:'esm',target:'node24'}).code;
  const nodes=parse(code,{ecmaVersion:'latest',sourceType:'module'}).body
    .map(node=>node.type==='ExportNamedDeclaration'?node.declaration:node).filter(Boolean);
  return {code,nodes};
}
function declarations(source,names){
  return names.map(name=>{
    const matches=source.nodes.filter(node=>node.id?.name===name||node.type==='VariableDeclaration'
      &&node.declarations.some(item=>item.id.name===name));
    assert.equal(matches.length,1,'Original declaration must be unique: '+name);
    return source.code.slice(matches[0].start,matches[0].end);
  }).join('\n');
}
function pathEquals(node,index,value){
  if(node.type==='LogicalExpression')return pathEquals(node.left,index,value)||pathEquals(node.right,index,value);
  return node.type==='BinaryExpression'&&node.operator==='==='&&node.left.type==='MemberExpression'
    &&node.left.object.name==='path'&&node.left.computed&&node.left.property.value===index&&node.right.value===value;
}

export async function prepareReadSettingsOracles({api,database,applicationSchema,folder}){
  const server=parsed('lib/server.ts'),route=parsed('app/api/[...path]/route.ts');
  const routes=route.nodes.filter(node=>node.type==='FunctionDeclaration'&&node.id.name==='authenticatedRoute');
  assert.equal(routes.length,1);
  const clients=routes[0].body.body.filter(node=>node.type==='IfStatement'
    &&pathEquals(node.test,0,'clients')&&/req\.method\s*===\s*["']GET["']/.test(route.code.slice(node.test.start,node.test.end)));
  assert.equal(clients.length,1);
  const admins=routes[0].body.body.filter(node=>node.type==='IfStatement'&&pathEquals(node.test,0,'admin'));
  assert.equal(admins.length,1);assert.equal(admins[0].consequent.type,'BlockStatement');
  const settingsBranches=['settings','regional-settings','manager-mail'].map(name=>{
    const nodes=admins[0].consequent.body.filter(node=>node.type==='IfStatement'&&pathEquals(node.test,1,name));
    assert.equal(nodes.length,1,'Original settings branch must be unique: '+name);
    return route.code.slice(nodes[0].start,nodes[0].end);
  }).join('\n');
  const catalogCode=declarations(parsed('lib/catalog.ts'),['photoKey','readProductPhoto','readCatalog'])+'\n'
    +declarations(route,['nationalReadScope','visibleWarehouses'])+'\n'
    +declarations(server,['AppError','fail','isGlobalManager','canAccessWarehouse','requireWarehouseAccess']);
  const userCode=declarations(parsed('lib/customer-counts.ts'),['selectUsersWithClientCounts'])+'\n'
    +declarations(server,['userView'])+'\n'+declarations(route,['getUsers']);
  const readerCode=declarations(server,['readAppSettings','settings','operationalMailSettings','withOperationalMailOverride',
    'settingsForAgent','regionalOperationalSettings','managerMailSettings','settingsForOrder']);
  const source="import {createHash} from 'node:crypto';import {validEan} from './lib/barcodes';"
    +"import {stockCode} from './lib/stock-types';import {productPhotoMime} from './lib/product-photo';"
    +"import {canViewActivations} from './lib/activation-access';"
    +"import {parseWeeklyLimit,persistWeeklyLimit} from './lib/weekly-order-limit';\n"
    +"export function catalogOracle(db,seed){const warehouses=seed.warehouses;const sha256=value=>createHash('sha256').update(value).digest('hex');const response=value=>value;\n"
    +catalogCode+'\nasync function customers(user,warehouseId){const readUser=nationalReadScope(user);const url=new URL("https://fixture.invalid/clients");'
    +'if(warehouseId!==null)url.searchParams.set("warehouseId",warehouseId);const req=new Request(url);'
    +route.code.slice(clients[0].consequent.start,clients[0].consequent.end)+'}\n'
    +'return {catalog:readCatalog,photo:readProductPhoto,customers,warehouses:visibleWarehouses};}\n'
    +'export function userOracle(db,warehouses){\n'+userCode+'\nreturn getUsers;}\n'
    +"export function settingsOracle(db,mailDefaults){class AppError extends Error{constructor(status,message){super(message);this.status=status;this.name='AppError';}}\n"
    +"const fail=(status,message)=>{throw new AppError(status,message);};const textField=(value,max=500)=>typeof value==='string'?value.trim().slice(0,max):'';\n"
    +"const isGlobalManager=user=>user.role==='manager'&&user.managerScope==='global';const requireManager=user=>{if(user.role!=='manager')fail(403,'manager');};\n"
    +"const requireGlobalManager=user=>{requireManager(user);if(!isGlobalManager(user))fail(403,'global');};const response=value=>value;\n"
    +readerCode+"\nasync function mutate(kind,body,user){const req={method:'PUT'},path=['admin',kind];const jsonBody=async()=>body;requireManager(user);\n"
    +settingsBranches+"\nthrow new Error('Unknown original route');}\nreturn {readAppSettings,settings,settingsForAgent,regionalOperationalSettings,managerMailSettings,settingsForOrder,mutate};}\n";
  const moduleFile=join(folder,'original-read-settings.mjs');
  await build({stdin:{contents:source,loader:'ts',resolveDir:resolve('.')},outfile:moduleFile,
    bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
  const originals=await import(pathToFileURL(moduleFile));
  const normalize=value=>typeof value==='bigint'?api.safeSqlInteger(value):Array.isArray(value)?value.map(normalize):
    value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,normalize(item)])):value;
  const counts={catalog:0,users:0,settings:0,settings_writes:0,snapshots:0};
  const quote=api.sqlIdentifier,schema=quote(applicationSchema);
  const tables=['users','sessions','manager_agents','settings','customers','portfolio_revision'];
  async function snapshotOracle(action){
    const snapshot=await database.read(async tx=>{
      const rows={};
      for(const table of tables)rows[table]=normalize((await tx.query(api.sqlQuery('read',
        'SELECT * FROM '+schema+'.'+quote(table),'SELECT * FROM '+schema+'.'+quote(table)))).rows);
      return rows;
    });
    const native=new DatabaseSync(':memory:');
    try{
      native.exec("PRAGMA foreign_keys=ON;ATTACH DATABASE ':memory:' AS ledger");
      for(const sql of [...authorityFixtureStatements(api,'main','ledger','sqlite'),...catalogCustomerFixtureStatements(api,'main')])native.exec(sql);
      // The older synthetic authority fixture predates data_revision. Mirror
      // this metadata field as well; none of the extracted business SQL changes.
      native.exec('ALTER TABLE portfolio_revision ADD COLUMN data_revision INTEGER NOT NULL DEFAULT 1');
      native.exec('BEGIN IMMEDIATE');
      for(const table of tables.filter(name=>name!=='portfolio_revision'))for(const row of snapshot[table]){
        const columns=Object.keys(row);native.prepare('INSERT INTO '+quote(table)+'('+columns.map(quote).join(',')+') VALUES('
          +columns.map(()=>'?').join(',')+')').run(...columns.map(key=>row[key]));
      }
      assert.equal(snapshot.portfolio_revision.length,1);
      const generation=snapshot.portfolio_revision[0];
      native.prepare('UPDATE portfolio_revision SET data_revision=?,scope_revision=? WHERE id=1').run(generation.data_revision,generation.scope_revision);
      native.exec('COMMIT');counts.snapshots++;
      const transaction=work=>{native.exec('BEGIN IMMEDIATE');try{const result=work();native.exec('COMMIT');return result;}
        catch(error){if(native.isTransaction)native.exec('ROLLBACK');throw error;}};
      const statement=(sql,values=[])=>({bind:(...next)=>statement(sql,next),
        first:async column=>{const row=native.prepare(sql).get(...values);return row?(column?row[column]:normalize({...row})):null;},
        all:async()=>({results:native.prepare(sql).all(...values).map(row=>normalize({...row}))}),
        execute:()=>{const rows=native.prepare(sql).all(...values);return{results:rows.map(row=>normalize({...row})),
          meta:{changes:Number(native.prepare('SELECT changes() n').get().n)}};},
        run:async()=>transaction(()=>statement(sql,values).execute())});
      const db=()=>({prepare:sql=>statement(sql),batch:async statements=>transaction(()=>statements.map(item=>item.execute()))});
      return await action({snapshot,native,db});
    }finally{native.close();}
  }
  const catalog=async(kind,input)=>snapshotOracle(async({snapshot,db})=>{
    counts.catalog++;const oracle=originals.catalogOracle(db,structuredClone(input.seed));
    if(kind==='catalog')return oracle.catalog();
    if(kind==='photo')return oracle.photo(input.encodedId,input.filename);
    const user=api.accountRecord(snapshot.users.find(row=>row.id===input.userId));
    if(kind==='customers')return (await oracle.customers(user,input.warehouseId)).clients;
    if(kind==='warehouses')return oracle.warehouses(user);
    throw new Error('Unknown original catalog/customer oracle');
  });
  const users=async(viewerId,warehouses)=>snapshotOracle(async({snapshot,db})=>{
    counts.users++;return originals.userOracle(db,structuredClone(warehouses))(
      api.accountRecord(snapshot.users.find(row=>row.id===viewerId)));
  });
  const settings=async({kind,method,args,viewerId,defaults})=>snapshotOracle(async({snapshot,native,db})=>{
    counts.settings++;if(kind==='write')counts.settings_writes++;
    const oracle=originals.settingsOracle(db,structuredClone(defaults));let result;
    try{result={ok:true,result:kind==='write'?await oracle.mutate(method,structuredClone(args[0]),
      api.accountRecord(snapshot.users.find(row=>row.id===viewerId))):await oracle[method](...structuredClone(args))};}
    catch(error){result={ok:false,status:error.status??null,errorName:error.name};}
    result.settings=native.prepare('SELECT key,value FROM settings ORDER BY key').all().map(row=>({...row}));return result;
  });
  const files=['lib/server.ts','app/api/[...path]/route.ts','lib/catalog.ts','lib/customer-counts.ts',
    'lib/activation-access.ts','lib/weekly-order-limit.ts','lib/barcodes.ts','lib/stock-types.ts','lib/product-photo.ts'];
  return {catalog,users,settings,counts,source_sha256:Object.fromEntries(files.map(file=>[file,hash(readFileSync(file))])),
    compiled_sha256:hash(readFileSync(moduleFile))};
}

/** A new worker context uses the ACTUAL adapter and advisory lock. This does
 * not relax its same-context nesting refusal or reuse the read's connection. */
export async function independentAdapterCommit(moduleFile,connectionString,expectedDatabase,statements){
  assert(Array.isArray(statements)&&statements.length>0&&statements.length<=3);
  const worker=new Worker(`const{parentPort,workerData}=require('node:worker_threads');
    (async()=>{let db;const errors=[];try{
      const api=await import(workerData.module);db=new api.PostgresDatabase({connectionString:workerData.url,
        expectedDatabase:workerData.database,maxConnections:2,lockTimeoutMs:1000,statementTimeoutMs:3000,
        onIdleConnectionError:error=>errors.push(error.message)});
      const changes=await db.write(async tx=>{const values=[];for(const item of workerData.statements){
        values.push((await tx.query(item.query,item.values)).changes);}return values;});
      await db.close();if(errors.length)throw new Error('Independent pool observation failed');
      parentPort.postMessage({committed:true,changes});
    }catch(error){try{await db?.close();}catch{}parentPort.postMessage({error:error.message,code:error.code??null});}})();`,
  {eval:true,workerData:{module:pathToFileURL(moduleFile).href,url:connectionString,database:expectedDatabase,statements}});
  let timer;
  try{return await new Promise((done,reject)=>{
    timer=setTimeout(()=>reject(new Error('Independent PostgreSQL commit acknowledgement timed out')),8000);
    worker.once('error',reject);worker.once('message',result=>result.committed===true?done(result):reject(new Error(result.error??'Missing commit acknowledgement')));
    worker.once('exit',code=>{if(code!==0)reject(new Error('Independent PostgreSQL writer exited '+code));});
  });}finally{clearTimeout(timer);await worker.terminate();}
}
