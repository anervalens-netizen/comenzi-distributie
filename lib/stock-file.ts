import { read, utils } from 'xlsx';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { stockCode, type StockRow } from './stock-types';

export const STOCK_FILE_LIMIT=8_000_000;
export const stockHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const stockName=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
// ERP labels may add GESTIUNE/TR, vary zero padding or reverse person-name order.
// Keep every remaining token (including PREZENTARE) to avoid matching a different stock.
export const stockWarehouseName=(value:string)=>stockName(value).replace(/^GESTIUNE\s+/, '').replace(/^TR\s+/, '').replace(/\s+-\s+/g,' ').split(' ').map(token=>/^\d+$/.test(token)?String(Number(token)):token).sort().join(' ');
export type ParsedStockGroup={key:string;name:string;siteId:string;rows:(StockRow&{depotQuantity:number|null})[]};
export function parseStockFile(bytes:Uint8Array,filename:string):ParsedStockGroup[] {
  if(!/\.(xls|xlsx)$/i.test(filename)||!bytes.length||bytes.length>STOCK_FILE_LIMIT)throw new Error('Încarcă un fișier .xls sau .xlsx de maximum 8 MB.');
  const ole=[0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((b,i)=>bytes[i]===b);
  const zip=bytes[0]===0x50&&bytes[1]===0x4b;
  if(!ole&&!zip)throw new Error('Fișierul nu este un registru Excel .xls sau .xlsx valid.');
  if(zip) {
    let total=0;
    // Inspect declared expansion before SheetJS processes the archive.
    unzipSync(bytes,{filter:file=>{total+=file.originalSize;if(total>40_000_000||file.originalSize>25_000_000)throw new Error('Fișierul Excel este prea mare după decomprimare.');return false;}});
  }
  const book=read(bytes,{type:'array',cellFormula:false,cellHTML:false,cellStyles:false,sheetRows:50_002});
  const sheetName=book.SheetNames.find(name=>stockName(name)==='STOC_TR')||(book.SheetNames.length===1?book.SheetNames[0]:null);
  if(!sheetName)throw new Error('Nu găsesc foaia Stoc_TR.');
  const sheet=book.Sheets[sheetName];
  const sheetRange=utils.decode_range(sheet['!fullref']||sheet['!ref']||'A1');
  if(sheetRange.e.r>=50_001)throw new Error('Importul acceptă maximum 50.000 de rânduri de stoc.');
  const required=['GESTIUNE','ITEMCODE','ITEMNAME','STOC','SITEID','STOCDEPOZIT'];
  const preview=utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:'',raw:true,range:{s:{r:0,c:0},e:{r:Math.min(14,sheetRange.e.r),c:Math.min(100,sheetRange.e.c)}}});
  const headerIndex=preview.findIndex(row=>required.every(name=>row.some(cell=>stockName(String(cell))===name)));
  if(headerIndex<0)throw new Error('Lipsesc coloanele Gestiune, ItemCode, ItemName, Stoc, SiteId sau StocDepozit.');
  const header=preview[headerIndex].map(cell=>stockName(String(cell)));
  if(required.some(name=>header.filter(cell=>cell===name).length!==1))throw new Error('Antetul conține coloane de stoc duplicate.');
  const cols=required.map(name=>header.indexOf(name));
  const rows=utils.sheet_to_json<unknown[]>(sheet,{header:1,defval:'',raw:true,range:{s:{r:0,c:0},e:{r:Math.min(sheetRange.e.r,50_000),c:Math.max(...cols)}}});
  const groups=new Map<string,ParsedStockGroup>(),seen=new Set<string>(),depots=new Map<string,number|null>();
  for(let index=headerIndex+1;index<rows.length;index++) {
    const row=rows[index];
    if(row.every(cell=>cell===''||cell===null))continue;
    const [name,code,label,quantityValue,site,depotValue]=cols.map(col=>row[col]);
    const text=(value:unknown)=>typeof value==='string'?value.trim():typeof value==='number'?String(value):'';
    const siteId=text(site),warehouseName=text(name),productCode=stockCode(text(code)),productName=text(label);
    const quantity=typeof quantityValue==='number'?quantityValue:/^-?\d+(?:[.,]\d+)?$/.test(text(quantityValue))?Number(text(quantityValue).replace(',','.')):NaN;
    const depotQuantity=text(depotValue)===''?null:typeof depotValue==='number'?depotValue:/^-?\d+(?:[.,]\d+)?$/.test(text(depotValue))?Number(text(depotValue).replace(',','.')):NaN;
    if(depotQuantity!==null&&(!Number.isFinite(depotQuantity)||Math.abs(depotQuantity)>1_000_000_000))throw new Error(`Rând ${index+1}: stocul depozitului este invalid.`);
    if(!warehouseName||!productCode||!productName||!siteId||!Number.isFinite(quantity)||Math.abs(quantity)>1_000_000_000||[warehouseName,productName].some(v=>v.length>500)||productCode.length>100||siteId.length>80)throw new Error(`Rând ${index+1}: gestiune, cod, denumire, SiteId sau cantitate invalidă. Importul nu a fost aplicat.`);
    const key=stockHash(JSON.stringify([siteId,stockName(warehouseName)]));
    const duplicate=key+'|'+productCode;
    if(seen.has(duplicate))throw new Error(`Rând ${index+1}: codul ${productCode} apare de mai multe ori în aceeași gestiune. Verifică fișierul înainte de import.`);
    seen.add(duplicate);
    if(depots.has(productCode)&&depots.get(productCode)!==depotQuantity)throw new Error(`Rând ${index+1}: stocuri de depozit diferite pentru codul ${productCode}. Verifică exportul ERP.`);
    depots.set(productCode,depotQuantity);
    const group=groups.get(key)||{key,name:warehouseName,siteId,rows:[]};
    group.rows.push({code:productCode,name:productName,quantity,depotQuantity});groups.set(key,group);
  }
  if(!groups.size)throw new Error('Fișierul nu conține rânduri de stoc.');
  return [...groups.values()];
}
