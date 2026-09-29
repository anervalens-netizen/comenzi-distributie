import {db,fail,sha256,textField} from './server';
import {normalizeCui,partnerPointKey} from './partner-identity';
import type {Client} from './types';

export type ClientImportImpact={id:string;name:string;cui:string;city:string;address:string};
export type ClientImportPreview={snapshot:string;removed:ClientImportImpact[];added:ClientImportImpact[];unchanged:ClientImportImpact[];ambiguous:ClientImportImpact[];blocked:string[]};
type Row={id:string;warehouse_id:string;data:string;active:number};
const identity=(c:Client)=>`${normalizeCui(c.cui)}|${partnerPointKey(c.city,c.county||'',c.address||'')}`;
const editInstruction='Identitate ambiguă: editează mai întâi adresa clientului cunoscut din Echipă → portofoliul agentului, apoi reimportă. Pentru un punct nou al aceleiași firme, păstrează în fișier identitățile exacte ale punctelor existente.';

export async function importClients(warehouseId:string,body:Record<string,unknown>) {
  if(!Array.isArray(body.clients)||!body.clients.length||body.clients.length>3000)fail(400,'Importul acceptă între 1 și 3.000 de clienți.');
  const incoming:Client[]=[],seen=new Set<string>();
  for(const raw of body.clients) {
    if(!raw||typeof raw!=='object')fail(400,'Client invalid.');
    const client={id:'',warehouseId,name:textField(raw.name,200),cui:textField(raw.cui,40),city:textField(raw.city,100),county:textField(raw.county,100),address:textField(raw.address,500),route:textField(raw.route,30)};
    if(!client.name||!normalizeCui(client.cui)||!client.city)fail(400,'Fiecare client trebuie să aibă denumire, CUI și localitate.');
    const key=identity(client);if(seen.has(key))continue;seen.add(key);
    client.id='imp-'+sha256(`${warehouseId}|${key}`).slice(0,32);incoming.push(client);
  }
  // Include inactive identities, shared memberships and deterministic IDs moved elsewhere.
  const ids=JSON.stringify(incoming.map(c=>c.id));
  const scope="(warehouse_id=? OR EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(data,'$.warehouseIds'),json_array(warehouse_id))) WHERE value=?) OR id IN (SELECT value FROM json_each(?)))";
  const rows=(await db().prepare(`SELECT id,warehouse_id,data,active FROM customers WHERE ${scope} ORDER BY id`).bind(warehouseId,warehouseId,ids).all<Row>()).results;
  const owned=rows.filter(r=>r.warehouse_id===warehouseId);
  const parsed=new Map(rows.map(r=>[r.id,JSON.parse(r.data) as Client]));
  const byIdentity=new Map<string,Row[]>();
  for(const row of owned){const key=identity(parsed.get(row.id)!);byIdentity.set(key,[...(byIdentity.get(key)||[]),row]);}
  const preview:ClientImportPreview={snapshot:sha256(JSON.stringify([warehouseId,incoming,rows])),removed:[],added:[],unchanged:[],ambiguous:[],blocked:[]};
  if(rows.some(r=>(parsed.get(r.id)!.warehouseIds||[r.warehouse_id]).length>1&&(r.active===1||seen.has(identity(parsed.get(r.id)!)))))preview.blocked.push('Portofoliul conține puncte comune. Editează atribuirile din Echipă; importul individual nu poate înlocui un portofoliu partajat.');
  const records:Client[]=[];
  for(const client of incoming) {
    const matches=byIdentity.get(identity(client))||[];
    if(matches.length>1){preview.ambiguous.push(client);continue;}
    if(matches.length===1) {
      const row=matches[0],original=parsed.get(row.id)!;
      // Empty optional spreadsheet values must not clear preserved metadata.
      // The address identity is normalized, but saved pins use raw address strings.
      // Preserve the original address spelling on exact matches so imports do not
      // trigger address invalidation for case/whitespace/diacritic-only changes.
      const values=Object.fromEntries(Object.entries(client).filter(([key,value])=>!['id','warehouseId','address','city','county'].includes(key)&&value!==''));
      const record={...original,...values,id:row.id} as Client;
      records.push(record);preview.unchanged.push(record);
    }else {
      const firm=owned.filter(r=>normalizeCui(parsed.get(r.id)!.cui)===normalizeCui(client.cui));
      // Inactive history still participates in exact matching, ownership and CAS,
      // but only omitted active points can signal a changed existing address.
      if(firm.some(r=>r.active===1&&!seen.has(identity(parsed.get(r.id)!)))||firm.length>0&&!client.address){preview.ambiguous.push(client);continue;}
      if(rows.some(r=>r.id===client.id))preview.blocked.push('Un client din import a fost mutat sau partajat. Verifică atribuirile din Echipă.');
      records.push(client);preview.added.push(client);
    }
  }
  const retained=new Set(records.map(c=>c.id));
  preview.removed=owned.filter(r=>r.active===1&&!retained.has(r.id)).map(r=>({...parsed.get(r.id)!,id:r.id}));
  if(preview.ambiguous.length)preview.blocked.push(editInstruction);
  if(body.preview===true)return {preview};
  if(preview.blocked.length)fail(409,preview.blocked.join(' '));
  // An empty, genuinely new portfolio remains compatible with simple imports.
  if((rows.length>0||body.snapshot!==undefined)&&body.snapshot!==preview.snapshot)fail(409,'Portofoliul s-a modificat sau lipsește previzualizarea. Reîncarcă previzualizarea; importul nu a fost aplicat.');
  if(preview.removed.length&&body.confirmRemovals!==preview.snapshot)fail(409,'Confirmă explicit eliminarea punctelor lipsă din această previzualizare.');
  const snapshot=JSON.stringify(rows);
  const expected=new Map(rows.map(r=>[r.id,{...r}]));
  for(const c of preview.removed)expected.get(c.id)!.active=0;
  for(const c of records)expected.set(c.id,{id:c.id,warehouse_id:warehouseId,data:JSON.stringify(c),active:1});
  const finalSnapshot=JSON.stringify([...expected.values()]);
  // D1 batch is transactional. A NOT NULL assertion runs before any mutation,
  // comparing every row and the set cardinality, including concurrent inserts.
  const guard=`INSERT INTO customers (id,warehouse_id,data,active) SELECT ?,?,NULL,1 WHERE (SELECT COUNT(*) FROM customers WHERE ${scope})<>json_array_length(?) OR EXISTS (SELECT 1 FROM json_each(?) expected LEFT JOIN customers c ON c.id=json_extract(expected.value,'$.id') WHERE c.id IS NULL OR c.data<>json_extract(expected.value,'$.data') OR c.active<>json_extract(expected.value,'$.active') OR c.warehouse_id<>json_extract(expected.value,'$.warehouse_id'))`;
  try {
    await db().batch([
      db().prepare(guard).bind('import-guard-'+crypto.randomUUID(),warehouseId,warehouseId,warehouseId,ids,snapshot,snapshot),
      ...preview.removed.map(c=>db().prepare('UPDATE customers SET active=0 WHERE id=?').bind(c.id)),
      ...records.map(c=>{const old=rows.find(r=>r.id===c.id);return db().prepare("INSERT INTO customers (id,warehouse_id,data,active) VALUES (?,?,?,1) ON CONFLICT(id) DO UPDATE SET data=CASE WHEN customers.warehouse_id=excluded.warehouse_id AND customers.data=? AND customers.active=? THEN excluded.data ELSE NULL END,active=1").bind(c.id,warehouseId,JSON.stringify(c),old?.data??'',old?.active??0);}),
      db().prepare(guard).bind('import-guard-'+crypto.randomUUID(),warehouseId,warehouseId,warehouseId,ids,finalSnapshot,finalSnapshot),
    ]);
  }catch(error){if(error instanceof Error&&/NOT NULL constraint failed: customers\.(data|active)/.test(error.message))fail(409,'Portofoliul s-a modificat între timp. Reîncarcă previzualizarea; importul nu a fost aplicat.');throw error;}
  return {count:records.length};
}
