import {decode} from 'jpeg-js';
import seed from '@/resources/seed.json';
import { db, fail, sha256, textField } from './server';
import type { Product } from './types';
import {validEan} from './barcodes';
import {stockCode} from './stock-types';
import {isProductPhoto, maxProductPhotoBase64, maxProductPhotoSide, productPhotoMime} from './product-photo';

type CatalogState={overrides:Record<string,Product|null>};
const photoKey=(encodedId:string)=>'catalog-photo:'+encodedId;

export async function readProductPhoto(encodedId:string,filename:string) {
  if(!/^[a-f0-9]{64}\.jpg$/.test(filename))fail(404,'Poza produsului nu a fost găsită.');
  const photo=await db().prepare('SELECT substr(value,66) AS base64 FROM settings WHERE key=? AND substr(value,1,65)=?')
    .bind(photoKey(encodedId),filename.slice(0,-4)+':').first<{base64:string}>();
  if(!photo)fail(404,'Poza produsului nu a fost găsită.');
  return new Response(new Uint8Array(Buffer.from(photo.base64,'base64')), {headers:{
    'Content-Type':productPhotoMime,
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':'no-store',
  }});
}

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
  return {raw:row?.value??null,mappingsRaw:imported?.value??null,state,products,mappings};
}
export async function changeProduct(method:string,id:string|undefined,body:Record<string,unknown>) {
  const current=await readCatalog();
  const existing=current.products.find(p=>p.id===id);
  if(method!=='POST'&&!existing)fail(404,'Produsul nu mai este în catalog.');
  if(existing&&body.version!==existing.version)fail(409,'Produsul s-a modificat. Actualizează catalogul și redeschide editarea.');
  const productId=existing?.id||'custom-'+crypto.randomUUID();
  const encodedId=encodeURIComponent(productId);
  let photoWrite;
  if(method==='DELETE')current.state.overrides[productId]=null;
  else {
    const code=textField(body.code,80),name=textField(body.name,300),brand=textField(body.brand,100),category=textField(body.category,100);
    if(existing&&stockCode(code)!==stockCode(existing.code)&&(existing.eans.length||validEan(stockCode(existing.code))||Object.values(current.mappings).some(mapped=>stockCode(mapped)===stockCode(existing.code))))fail(409,'Codul produsului are asocieri EAN și nu poate fi schimbat. Păstrează codul; poți modifica denumirea și celelalte detalii.');
    const kind=existing?.kind||body.kind;
    const ean=body.ean===undefined?existing?.ean||'':textField(body.ean,80);
    if(ean&&!validEan(ean))fail(400,'EAN invalid: verifică lungimea și cifra de control.');
    if(ean&&current.products.some(p=>p.id!==productId&&stockCode(p.code)!==stockCode(code)&&(p.eans?.includes(ean)||stockCode(p.code)===ean)))fail(409,'EAN-ul este deja asociat altui cod produs.');
    if(ean&&current.mappings[ean]&&current.mappings[ean]!==stockCode(code)&&!current.products.some(p=>stockCode(p.code)===current.mappings[ean]))fail(409,'EAN-ul este asociat altui cod în catalogul Excel importat.');
    if(!code||!name||!category||!['accessories','stands'].includes(String(kind)))fail(400,'Completează codul, denumirea, categoria și tipul produsului.');
    for(const key of ['price','netPrice'] as const)if(body[key]!==null&&(typeof body[key]!=='number'||!Number.isFinite(body[key])||Number(body[key])<0||Number(body[key])>1000000))fail(400,'Prețurile trebuie să fie pozitive sau necompletate.');
    if(kind==='accessories'&&(body.price===null||body.netPrice===null))fail(400,'Completează ambele prețuri pentru accesorii.');
    const storedProduct=current.state.overrides[productId]||(seed.products as Product[]).find(p=>p.id===productId);
    let image=existing?.image||null;
    if(body.photo!==undefined){
      const photo=body.photo;
      if(typeof photo!=='string')fail(400,'Poza produsului este invalidă.');
      if(photo.length>maxProductPhotoBase64)fail(413,'Poza produsului este prea mare.');
      const bytes=Buffer.from(photo,'base64');
      const invalidPhoto='Poza produsului trebuie să fie o imagine JPEG validă.';
      if(bytes.toString('base64')!==photo||!isProductPhoto(bytes))fail(400,invalidPhoto);
      try {
        decode(bytes,{useTArray:true,tolerantDecoding:false,formatAsRGBA:false,
          maxResolutionInMP:maxProductPhotoSide**2/1_000_000,maxMemoryUsageInMB:24});
      } catch {
        fail(400,invalidPhoto);
      }
      const digest=sha256(photo);
      image=`/api/catalog/photo/${encodedId}/${digest}.jpg`;
      photoWrite=db().prepare('INSERT INTO settings (key,value) SELECT ?,? WHERE changes()=1 ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind(photoKey(encodedId),digest+':'+photo);
    }
    current.state.overrides[productId]={id:productId,code,name,brand,category,kind:String(kind),price:body.price as number|null,netPrice:body.netPrice as number|null,sourceRow:existing?.sourceRow||0,image,...(existing?.description?{description:existing.description}:{}),...(ean===existing?.ean&&storedProduct?.ean===undefined?{}:{ean})};
  }
  const value=JSON.stringify(current.state);
  // Compare the mapping snapshot in the same statement: an import racing a
  // previously unassociated code change must not leave a newly orphaned EAN.
  const catalogWrite=current.raw===null
    ?db().prepare("INSERT OR IGNORE INTO settings (key,value) SELECT 'catalog',? WHERE (SELECT value FROM settings WHERE key='inventory-ean-v1') IS ?").bind(value,current.mappingsRaw)
    :db().prepare("UPDATE settings SET value=? WHERE key='catalog' AND value=? AND (SELECT value FROM settings WHERE key='inventory-ean-v1') IS ?").bind(value,current.raw,current.mappingsRaw);
  if(method==='DELETE')photoWrite=db().prepare('DELETE FROM settings WHERE key=? AND changes()=1').bind(photoKey(encodedId));
  // The batch is transactional. A failed catalog compare must also skip the photo write.
  const result=photoWrite?(await db().batch([catalogWrite,photoWrite]))[0]:await catalogWrite.run();
  if(!result.meta.changes)fail(409,'Catalogul a fost modificat între timp. Actualizează lista și încearcă din nou.');
  return {products:(await readCatalog()).products};
}
