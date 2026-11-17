import { db, fail } from './server';
import type { PartnerCompany } from './types';
import { normalizeCui } from './partner-identity';

// No schema changes or table export: SQLite filters/groups a narrow projection.
// Fold Romanian letters before SQLite upper(), which folds ASCII only.
function folded(sql:string){
  for(const [from,to] of Object.entries({'ă':'a','Ă':'A','â':'a','Â':'A','î':'i','Î':'I','ș':'s','Ș':'S','ş':'s','Ş':'S','ț':'t','Ț':'T','ţ':'t','Ţ':'T'}))sql=`replace(${sql},'${from}','${to}')`;
  return `upper(${sql})`;
}
function cuiExpression(){
  const raw="upper(COALESCE(json_extract(data,'$.cui'),''))";
  let sql=raw;
  // Match normalizeCui for ASCII separators, including legacy dotted RO values.
  for(let i=0;i<128;i++)if(!/[A-Z0-9]/.test(String.fromCharCode(i))&&!(i>=97&&i<=122))sql=`replace(${sql},char(${i}),'')`;
  return `CASE WHEN ${raw} NOT GLOB '*[^0-9]*' THEN ${raw} WHEN substr(${raw},1,2)='RO' AND substr(${raw},3) NOT GLOB '*[^0-9]*' THEN substr(${raw},3) WHEN substr(${sql},1,2)='RO' THEN substr(${sql},3) ELSE ${sql} END`;
}
const cuiSql=cuiExpression(),nameSql=folded("COALESCE(json_extract(data,'$.name'),'')");
const windows=new Map<string,{start:number;count:number}>();
function admit(userId:string){
  const now=Date.now();
  for(const [id,window] of windows)if(now-window.start>=60000)windows.delete(id);
  const window=windows.get(userId)||{start:now,count:0};
  if(window.count>=90||(!windows.has(userId)&&windows.size>=4096))fail(429,'Prea multe căutări. Reîncearcă peste un minut.');
  window.count++;windows.set(userId,window);
}
export async function searchPartnerCompanies(userId:string,raw:string){
  if(raw.length>100||Array.from(raw).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127))fail(400,'Căutarea trebuie să aibă maximum 100 de caractere, fără caractere de control.');
  const query=raw.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
  if(query.length<3)return {companies:[] as PartnerCompany[],hasMore:false};
  const canonical=normalizeCui(raw),numeric=/^\d+$/.test(canonical),needle=numeric?canonical:query;
  if(needle.length<3)return {companies:[] as PartnerCompany[],hasMore:false};
  admit(userId);
  // instr uses literal text: %, _ and quotes never become wildcards or SQL.
  const rows=(await db().prepare(`WITH active AS MATERIALIZED (
    SELECT id,${cuiSql} AS cui,COALESCE(json_extract(data,'$.name'),'') AS name,${nameSql} AS search_name
    FROM customers WHERE active=1
  ), matched AS (SELECT DISTINCT CASE WHEN cui='' THEN 'point:'||id ELSE 'cui:'||cui END AS identity FROM active WHERE instr(${numeric?'cui':'search_name'},?)>0)
  SELECT min(name) AS name,cui,count(*) AS pointCount FROM active
  WHERE CASE WHEN cui='' THEN 'point:'||id ELSE 'cui:'||cui END IN (SELECT identity FROM matched)
  GROUP BY CASE WHEN cui='' THEN 'point:'||id ELSE 'cui:'||cui END
  ORDER BY min(search_name),cui,min(id) LIMIT 21`).bind(needle).all<PartnerCompany>()).results;
  return {companies:rows.slice(0,20),hasMore:rows.length>20};
}
