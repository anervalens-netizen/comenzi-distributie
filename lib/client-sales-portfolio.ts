import {statSync} from 'node:fs';
import {resolve} from 'node:path';
import {db,fail} from './server';
import {portfolioSummary} from './partner-portfolio';
import {maintainReadModelBatch,portfolioVersion,selectedSql} from './portfolio-read-model';
import {salesYield} from './client-sales-cooperative';
import type {PartnerSummary} from './partner-map-types';
import type {User} from './types';
export async function clientPortfolioVersion(){
  if(!(db() as D1Database&{portfolioReadVersion?:unknown}).portfolioReadVersion)return null;
  const path=resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data','mobiup.sqlite');
  let file='';try{const s=statSync(path);file=JSON.stringify([path,s.dev,s.ino]);}catch{/* Non-filesystem test/runtime adapter. */}
  return file+await portfolioVersion();
}
// Cache only decoded cards, never membership. Scoped IDs are selected from current
// customers on EVERY request; the existing SQL trigger revisions invalidate contents.
const cards=new Map<string,PartnerSummary>();
let cardVersion='',cardBytes=0;
const CARD_BYTES=24*1024*1024;
/** Reuse the existing trigger-maintained projection and live scope SQL. Keyset batches
 * keep national reads and first projection builds from monopolizing the HTTP thread. */
export async function clientSalesPortfolio(user:User,warehouseIds?:string[]){
  if(await clientPortfolioVersion()===null)return portfolioSummary(user,undefined,warehouseIds);
  let complete=false;
  for(let i=0;i<2000&&!complete;i++){complete=await maintainReadModelBatch();await salesYield();}
  if(!complete)fail(503,'Portofoliul se actualizează. Reîncearcă.');
  const version=(await clientPortfolioVersion())!;
  if(cardVersion!==version){cards.clear();cardBytes=0;cardVersion=version;}
  const q=selectedSql(user,new URLSearchParams(),warehouseIds),partners:PartnerSummary[]=[];
  let cursor='';
  for(;;){
    const rows=(await db().prepare(`SELECT m.id FROM ${q.from} WHERE ${q.where} AND m.id>? ORDER BY m.id LIMIT 512`).bind(...q.args,cursor).all<{id:string}>()).results;
    const missing=rows.filter(r=>!cards.has(r.id)).map(r=>r.id);
    const fresh=new Map<string,PartnerSummary>();
    if(missing.length){
      const values=(await db().prepare('SELECT id,summary FROM portfolio_read_rows WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(missing)).all<{id:string;summary:string}>()).results;
      for(const row of values){
        const p=JSON.parse(row.summary) as PartnerSummary;fresh.set(row.id,p);
        const bytes=row.summary.length*2+256;
        if(cardVersion===version&&cardBytes+bytes<=CARD_BYTES){cards.set(row.id,p);cardBytes+=bytes;}
      }
    }
    for(const row of rows){const p=cards.get(row.id)||fresh.get(row.id);if(p)partners.push(p);}
    if(rows.length<512)break;
    cursor=rows.at(-1)!.id;await salesYield();
  }
  return partners;
}
