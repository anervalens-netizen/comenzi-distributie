import { lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { vodafoneSim0CatalogRevision } from './vodafone-bonus-node';
import { rulesSetting } from './distribution-rules';
import { historyFileGeneration } from './history-source-generation';
import { db, sha256 } from './server';
import { vodafoneBonusEvidenceSetting } from './vodafone-bonus-evidence';

export async function managerAiAnalysisRevision(tables:readonly string[]) {
  if(!tables.length)return '';
  const data=resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data');
  const activations=resolve(process.env.MOBIUP_ACTIVATIONS_DIR||data);
  const activation=tables.some(table=>table.startsWith('activation_')&&table!=='activation_sim0_clients');
  const bonus=tables.some(table=>table.startsWith('bonus')||table==='settlements');
  const sim0=tables.includes('activation_sim0_clients');
  const focus=tables.some(table=>table.startsWith('focus_'));
  const selected=new Set(tables);
  const files:string[]=[];
  if(activation||bonus||sim0){
    const providers=activation?[activations,resolve(activations,'digi')]:[activations];
    for(const provider of providers){
      const pointer=resolve(provider,'current');
      const directory=lstatSync(pointer,{throwIfNoEntry:false})?pointer:provider;
      files.push(resolve(directory,'activations.sqlite'),resolve(directory,'activation-report.sqlite'));
    }
  }
  const sales=selected.has('sales_lines')||selected.has('sales_team_monthly');
  if(focus||bonus||sales)files.push(resolve(data,'sales.sqlite'));
  if(focus||bonus||sim0||sales||selected.has('sales_partner_lines')){
    files.push(resolve(data,'client-history','client-sales-history.sqlite'));
  }
  if(focus)files.push(process.env.MOBIUP_COMMERCIAL_FOCUS_RULES||resolve(data,'vodafone-commercial-focus-rules.json'));
  if(bonus)files.push(process.env.MOBIUP_VODAFONE_TOP_LOCATIONS||resolve(data,'vodafone-top-locations.json'));

  const settings=bonus||sim0?[rulesSetting,vodafoneBonusEvidenceSetting]:[rulesSetting];
  const revisions:unknown[]=[(await db().prepare('SELECT key,value FROM settings WHERE key IN (SELECT value FROM json_each(?)) ORDER BY key')
    .bind(JSON.stringify(settings)).all()).results];
  if(selected.has('sales_team_monthly')){
    revisions.push(await db().prepare('SELECT scope_revision FROM portfolio_revision WHERE id=1').first());
    revisions.push((await db().prepare("SELECT id,name,active,site_code,warehouse_name,manager_scope,role FROM users WHERE role IN ('manager','agent') ORDER BY id").all()).results);
    revisions.push((await db().prepare('SELECT manager_id,agent_id FROM manager_agents ORDER BY manager_id,agent_id').all()).results);
    revisions.push(await db().prepare("SELECT value FROM settings WHERE key='sales-agent-aliases-v1'").first());
  }
  if(sim0)revisions.push(vodafoneSim0CatalogRevision(data));
  if(bonus||sim0||selected.has('orders')||selected.has('stands')){
    revisions.push(await db().prepare('SELECT revision FROM order_list_revision WHERE id=1').first());
  }
  if(bonus||sim0||selected.has('partners')||selected.has('sales_partner_lines')||selected.has('activation_partners')){
    revisions.push(await db().prepare('SELECT revision FROM crm_directory_revision WHERE id=1').first());
  }
  if(selected.has('stock')){
    revisions.push(await db().prepare(`SELECT json_extract(value,'$.history[0].fileHash') version
      FROM settings WHERE key='agent-stock-v1'`).first());
  }
  for(const table of ['inventories','transfers'])if(selected.has(table)){
    const prefix=table==='inventories'?'inventory-v1:':'transfer-v1:';
    revisions.push((await db().prepare(`SELECT key,json_extract(value,'$.revision') revision,json_extract(value,'$.updatedAt') updated
      FROM settings WHERE key>=? AND key<? AND json_extract(value,'$.status')='finalized' ORDER BY key`)
      .bind(prefix,prefix.slice(0,-1)+';').all()).results);
  }
  return sha256(JSON.stringify([files.map(historyFileGeneration),revisions]));
}
