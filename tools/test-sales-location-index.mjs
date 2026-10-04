// Plain SQLite location index, exact historical alias semantics and external-writer compatibility.
import assert from 'node:assert/strict';
import {build} from 'esbuild';import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'sales-location-index-')),previousData=process.env.MOBIUP_DATA_DIR;
process.env.MOBIUP_DATA_DIR=dir;
let sql,checks=0,lastMonthsQuery;
const equal=(a,b,label)=>{assert.deepEqual(a,b,label);checks++;};
const prepare=Reflect.get(DatabaseSync.prototype,'prepare');
DatabaseSync.prototype.prepare=function(query){const statement=prepare.call(this,query);if(query.startsWith('SELECT month, imported_at')){const all=Reflect.get(statement,'all');statement.all=function(...args){lastMonthsQuery={query,args};return all.apply(this,args);};}return statement;};
try{
 const output=join(dir,'store.mjs');await build({entryPoints:['lib/sales-store.ts'],outfile:output,bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'synthetic',setup(b){b.onResolve({filter:/resources\/seed\.json$/},()=>({path:'seed',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'{"products":[]}',loader:'json'}));}}]});
 const store=await import(pathToFileURL(output)),{salesLocationKey}=await import('../lib/sales-location.ts');store.salesRevision();
 sql=new DatabaseSync(store.salesDatabasePath);sql.function('sales_location_key',{deterministic:true},value=>salesLocationKey(String(value||'')));
 const addImport=sql.prepare('INSERT INTO sales_imports(month,file_hash,filename,imported_at,imported_by,row_count,original_path,revision) VALUES(?,?,?,?,?,?,?,?)');
 const addRow=sql.prepare('INSERT INTO sales_rows(import_id,row_number,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,location,company,asm,regional,order_number,category,sub_category,agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
 for(let n=1;n<=9;n++){
  const month='2026-'+String(n).padStart(2,'0'),id=Number(addImport.run(month,month,'synthetic.xlsx',month+'-01','synthetic',6,'synthetic',n).lastInsertRowid);
  sql.prepare('INSERT INTO sales_months VALUES(?,?,?,?,?,?)').run(month,id,month+'-01','synthetic.xlsx',month,n);
  for(const [i,location,site] of [[1,'TR Oraș Nord 01',' A '],[2,'tr ORAS-nord 01','B'],[3,'TR Oras Sud 01','A'],[4,'TR Site Only','SELLER'],[5,'TR AB','AB'],[6,'TR A-B','AB']])addRow.run(id,i,month+'-01',month,site,'P1','Synthetic product',1,'Synthetic',100,119,location,'Synthetic','','','synthetic-'+i,'Accesorii','','Untrusted label');
 }
 const baselineFilter=scope=>{
  const args=[],clauses=[],holders=values=>{args.push(...values);return values.map(()=>'?').join(',');};
  if(scope&&typeof scope==='object'&&!Array.isArray(scope)){
   if(scope.warehouseNames.length)clauses.push(`sales_location_key(location) IN (${holders(scope.warehouseNames.map(salesLocationKey))})`);
   for(const pair of scope.warehouseSites||[]){clauses.push('(sales_location_key(location)=? AND UPPER(TRIM(site_code))=?)');args.push(salesLocationKey(pair.warehouseName),pair.siteCode.trim().toUpperCase());}
   if(scope.siteCodes.length){let f=`UPPER(TRIM(site_code)) IN (${holders(scope.siteCodes)})`;if(scope.excludedWarehouseNames.length)f+=` AND sales_location_key(location) NOT IN (${holders(scope.excludedWarehouseNames.map(salesLocationKey))})`;clauses.push('('+f+')');}
   let query=' AND ('+(clauses.join(' OR ')||'0')+')';if(scope.siteCode){query+=' AND UPPER(TRIM(site_code))=UPPER(TRIM(?))';args.push(scope.siteCode);}return {query,args};
  }
  if(Array.isArray(scope)){const values=scope.map(x=>x.trim()).filter(Boolean);return {query:values.length?` AND UPPER(TRIM(site_code)) IN (${holders(values).split(',').map(()=> 'UPPER(TRIM(?))').join(',')})`:' AND 0',args};}
  return {query:scope?.trim()?' AND UPPER(TRIM(site_code))=UPPER(TRIM(?))':'',args:scope?.trim()?[scope.trim()]:[]};
 };
 const checkScope=(scope,label)=>{const f=baselineFilter(scope),old=sql.prepare(`SELECT month,(SELECT COUNT(*) FROM sales_rows r WHERE r.import_id=m.import_id${f.query}) rowCount FROM sales_months m ORDER BY month DESC`).all(...f.args).map(r=>({...r})),next=store.salesMonths(scope).map(({month,rowCount})=>({month,rowCount}));equal(next,old,label);return lastMonthsQuery;};
 checkScope(undefined,'global months');checkScope('A','legacy site selector includes every location');checkScope(['A','B'],'legacy site array');checkScope([],'empty selector');
 const north={warehouseNames:['TR Oras-Nord 01'],siteCodes:[],excludedWarehouseNames:[]};const captured=checkScope(north,'diacritic/case/punctuation exact normalized warehouse aliases');
 assert.match(JSON.stringify(sql.prepare('EXPLAIN QUERY PLAN '+captured.query).all(...captured.args)),/idx_sales_rows_location_import/,'location/import lookup uses plain index');checks++;
 equal(store.salesMonths(north)[0].rowCount,2,'distinct raw aliases contribute both original facts');
 checkScope({warehouseNames:[],warehouseSites:[{warehouseName:'TR Oras Nord 01',siteCode:'A'}],siteCodes:[],excludedWarehouseNames:[]},'shared normalized warehouse constrained to its own site');
 checkScope({warehouseNames:['TR Oras Nord 01'],warehouseSites:[{warehouseName:'TR Oras Sud 01',siteCode:'A'}],siteCodes:['SELLER'],excludedWarehouseNames:['TR Oras Nord 01','TR Oras Sud 01']},'warehouse/pair/site-only OR remains exact');
 checkScope({warehouseNames:[],siteCodes:['A'],excludedWarehouseNames:['TR Oras Nord 01']},'site-only excludes unique operational warehouse');
 checkScope({warehouseNames:['TR Unknown'],siteCodes:[],excludedWarehouseNames:[]},'unknown warehouse matches zero');
 checkScope({warehouseNames:[],siteCodes:['A'],excludedWarehouseNames:['TR Unknown']},'absent excluded raw aliases leave predicate true');
 equal(store.salesMonths({warehouseNames:['TR AB'],siteCodes:[],excludedWarehouseNames:[]})[0].rowCount,1,'normalization cannot merge AB with A-B');
 checkScope({...north,siteCode:'A'},'requested site narrows normalized warehouse');
 // External writers need no application-defined SQLite function for this plain index.
 const external=new DatabaseSync(store.salesDatabasePath);
 external.prepare('INSERT INTO sales_rows SELECT import_id,99,date,month,site_code,item_code,item_name,quantity,brand,price_cents,value_cents,?,company,asm,regional,order_number,category,sub_category,agent FROM sales_rows WHERE import_id=9 AND row_number=1').run('tr  ORAȘ nord-01');external.close();
 equal(store.salesMonths(north)[0].rowCount,3,'new historical spelling is resolved immediately without revision/cache of aliases');
 // Guard parameter size without dropping any rare historical raw spelling.
 for(let n=0;n<501;n++)addRow.run(9,100+n,'2026-09-01','2026-09','A','P1','Synthetic product',1,'Synthetic',100,119,'TR'+' '.repeat(n+1)+'Oraș Rare','Synthetic','','','rare-'+n,'Accesorii','','');
 const rare=checkScope({warehouseNames:['TR Oras Rare'],siteCodes:[],excludedWarehouseNames:[]},'more than500 raw variants fall back without truncation');assert.match(rare.query,/sales_location_key\(location\)/);checks++;
 const snapshot=store.getSalesViewSnapshot('2026-09',north);equal(snapshot.summary.rows,3,'snapshot read sees exact warehouse facts');equal(snapshot.months[0].rowCount,3,'calendar and view use same snapshot and scope');
 console.log(`PASS: ${checks} indexed Sales location checks: exact historical aliases, ownership OR/exclusions/site bounds, empty scope, raw writer compatibility and parameter fallback.`);
}finally{sql?.close();DatabaseSync.prototype.prepare=prepare;rmSync(dir,{recursive:true,force:true});if(previousData===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previousData;}
