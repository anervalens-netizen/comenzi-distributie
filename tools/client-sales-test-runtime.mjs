// Isolated, synthetic Node runtime. Uses real portfolio SQL/ACL and application API.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createClientSalesFixture} from './client-sales-fixture.mjs';
export async function clientSalesTestRuntime(){
 mkdirSync('work',{recursive:true});const root=mkdtempSync(resolve('work/client-sales-test-'));
 const previous=process.env.MOBIUP_DATA_DIR;process.env.MOBIUP_DATA_DIR=root;
 const sql=new DatabaseSync(join(root,'mobiup.sqlite'));
 sql.exec(readFileSync('drizzle/0000_rare_hardball.sql','utf8'));
 sql.exec("ALTER TABLE users ADD COLUMN manager_scope TEXT DEFAULT 'assigned';CREATE TABLE manager_agents(manager_id TEXT,agent_id TEXT);CREATE TABLE partner_requests(id TEXT,customer_id TEXT,status TEXT,confirmed_at TEXT,payload TEXT);");
 for(const f of ['0006_partner_portfolio.sql','0007_partner_day_plans.sql','0008_partner_map_index.sql','0009_portfolio_read_model.sql'])sql.exec(readFileSync('drizzle/'+f,'utf8'));
 for(const [id,role,warehouse] of [['agent','agent','g-5'],['other','agent','g-3'],['manager','manager','']])sql.prepare('INSERT INTO users(id,username,name,role,warehouse_id,password_hash,must_change_password,active,manager_scope) VALUES(?,?,?,?,?,?,0,1,?)').run(id,id,'Synthetic '+id,role,warehouse,'not-a-credential','global');
 const {partners}=createClientSalesFixture(root,true);
 function prepare(query){return {values:[],bind(...values){this.values=values;return this;},async all(){return {results:sql.prepare(query).all(...this.values)};},async first(){return sql.prepare(query).get(...this.values)||null;},async run(){const result=sql.prepare(query).run(...this.values);return {meta:{changes:result.changes}};}};}
 const adapter={prepare,async batch(items){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const item of items)results.push(await item.run());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}},async portfolioReadVersion(){return JSON.stringify(sql.prepare('SELECT data_revision,scope_revision FROM portfolio_revision').get());}};
 globalThis.__clientSalesDb=adapter;
 const plugin={name:'isolated-server',setup(b){b.onResolve({filter:/^\.\/server$/},()=>({path:'server',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:`import {createHash} from 'node:crypto';export const db=()=>globalThis.__clientSalesDb;export const isGlobalManager=u=>u.role==='manager';export const sha256=s=>createHash('sha256').update(s).digest('hex');export const textField=v=>v;export const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};`}));}};
 const out=join(root,'test.mjs');await build({stdin:{contents:"export * from './lib/client-sales-api';export * from './lib/client-sales-store';export * from './lib/partner-activity-snapshot';export * from './lib/partner-sales-store';export * from './lib/client-sales-portfolio';",resolveDir:process.cwd(),loader:'ts'},outfile:out,bundle:true,format:'esm',platform:'node',plugins:[plugin],logLevel:'silent'});
 const api=await import(pathToFileURL(out));
 const user=id=>({id,role:id==='manager'?'manager':'agent',warehouseId:id==='agent'?'g-5':'g-3',managerScope:'global'});
 const call=(query='',id='agent',now='2026-09-30T12:00:00.000Z')=>api.clientSalesOverview(user(id),new URLSearchParams('month=2026-09&'+query),new Date(now));
 return {root,sql,partners,module:api,call,user,cleanup(){sql.close();delete globalThis.__clientSalesDb;if(previous===undefined)delete process.env.MOBIUP_DATA_DIR;else process.env.MOBIUP_DATA_DIR=previous;rmSync(root,{recursive:true,force:true});}};
}
