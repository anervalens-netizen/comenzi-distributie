import seed from '@/resources/seed.json';
import { db, fail, sha256, textField } from './server';
import type { Product } from './types';
import {validEan} from './barcodes';
import {stockCode} from './stock-types';

type CatalogState={overrides:Record<string,Product|null>};
export async function readCatalog() {
  const row=await db().prepare("SELECT value FROM settings WHERE key='catalog'").first<{value:string}>();
  const state:CatalogState=row?JSON.parse(row.value):{overrides:{}};
  const map=new Map((seed.products as Product[]).map(p=>[p.id,p]));
  for(const [id,p] of Object.entries(state.overrides)){if(p)map.set(id,p);else map.delete(id);}
  const imported=await db().prepare("SELECT value FROM settings WHERE key='inventory-ean-v1'").first<{value:string}>();
  const mappings:Record<string,string>=imported?JSON.parse(imported.value):{};
  const products=[...map.values()].map(p=>{
    const eans=p.ean!==undefined?(p.ean?[p.ean]:[]):Object.entries(mappings).filter(([,code])=>code===stockCode(p.code)).map(([ean])=>ean);
    if(p.ean===undefined&&validEan(p.code)&&!eans.includes(p.code))eans.push(p.code);
    const product={...p,ean:eans[0]||'',eans};
    return {...product,version:sha256(JSON.stringify(product))};
  });
  return {raw:row?.value??null,state,products,mappings};
}
export async function changeProduct(method:string,id:string|undefined,body:Record<string,unknown>) {
  const current=await readCatalog();
  const existing=current.products.find(p=>p.id===id);
  if(method!=='POST'&&!existing)fail(404,'Produsul nu mai este în catalog.');
  if(existing&&body.version!==existing.version)fail(409,'Produsul s-a modificat. Actualizează catalogul și redeschide editarea.');
  const productId=existing?.id||'custom-'+crypto.randomUUID();
  if(method==='DELETE')current.state.overrides[productId]=null;
  else {
    const code=textField(body.code,80),name=textField(body.name,300),brand=textField(body.brand,100),category=textField(body.category,100);
    const kind=existing?.kind||body.kind;
    const ean=body.ean===undefined?existing?.ean||'':textField(body.ean,80);
    if(ean&&!validEan(ean))fail(400,'EAN invalid: verifică lungimea și cifra de control.');
    if(ean&&current.products.some(p=>p.id!==productId&&stockCode(p.code)!==stockCode(code)&&(p.eans?.includes(ean)||stockCode(p.code)===ean)))fail(409,'EAN-ul este deja asociat altui cod produs.');
    if(ean&&current.mappings[ean]&&current.mappings[ean]!==stockCode(code)&&!current.products.some(p=>stockCode(p.code)===current.mappings[ean]))fail(409,'EAN-ul este asociat altui cod în catalogul Excel importat.');
    if(!code||!name||!category||!['accessories','stands'].includes(String(kind)))fail(400,'Completează codul, denumirea, categoria și tipul produsului.');
    for(const key of ['price','netPrice'] as const)if(body[key]!==null&&(typeof body[key]!=='number'||!Number.isFinite(body[key])||Number(body[key])<0||Number(body[key])>1000000))fail(400,'Prețurile trebuie să fie pozitive sau necompletate.');
    if(kind==='accessories'&&(body.price===null||body.netPrice===null))fail(400,'Completează ambele prețuri pentru accesorii.');
    current.state.overrides[productId]={id:productId,code,name,brand,category,kind:String(kind),price:body.price as number|null,netPrice:body.netPrice as number|null,sourceRow:existing?.sourceRow||0,image:existing?.image||null,...(ean===existing?.ean&&current.state.overrides[productId]?.ean===undefined?{}:{ean})};
  }
  const value=JSON.stringify(current.state);
  const result=current.raw===null?await db().prepare("INSERT OR IGNORE INTO settings (key,value) VALUES ('catalog',?)").bind(value).run():await db().prepare("UPDATE settings SET value=? WHERE key='catalog' AND value=?").bind(value,current.raw).run();
  if(!result.meta.changes)fail(409,'Catalogul a fost modificat între timp. Actualizează lista și încearcă din nou.');
  return {products:(await readCatalog()).products};
}
