import {countyLabel} from './portfolio-facets';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { cleanWorkbook } from './export-cleanup';
import {orderWorkbook,orderedProductGroups} from './order-workbook';
import mailDefaults from '@/resources/mail-defaults.json';
import type { Order, Mail, Settings, Product } from './types';

import {xmlSafeText} from './xml-text';
export {xmlSafeText} from './xml-text';
const xmlEscape=(v: unknown)=>xmlSafeText(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
function cell(ref: string, value: string|number|null, attrs='', formula?: string) {
  attrs=attrs.replace(/\s+t="[^"]*"/g,'').replace(/\s+r="[^"]*"/g,'');
  if(value===null) return `<c r="${ref}"${attrs}/>`;
  if(typeof value==='number') return `<c r="${ref}"${attrs}>${formula?`<f>${xmlEscape(formula)}</f>`:''}<v>${value}</v></c>`;
  return `<c r="${ref}"${attrs} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}
function put(xml: string,ref: string,value: string|number|null,formula?: string,newAttrs='') {
  // Lazy attributes keep an empty <c .../> from consuming the next cell.
  const pattern=new RegExp(`<c\\b([^>]*?\\br="${ref}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match=xml.match(pattern);
  if(match) return xml.replace(pattern,()=>cell(ref,value,match[1],formula));
  const row=ref.match(/\d+/)![0];
  const rowPattern=new RegExp(`(<row\\b[^>]*\\br="${row}"[^>]*>)([\\s\\S]*?)(<\\/row>)`);
  if(rowPattern.test(xml)) return xml.replace(rowPattern,(_,start,content,end)=>start+content+cell(ref,value,newAttrs,formula)+end);
  return xml.replace('</sheetData>',`<row r="${row}">${cell(ref,value,newAttrs,formula)}</row></sheetData>`);
}
function putInRow(rowXml:string,ref:string,value:string|number|null,formula?:string,newAttrs='') {
  const pattern=new RegExp(`<c\\b([^>]*?\\br="${ref}"[^>]*?)(?:\\/>|>[\\s\\S]*?<\\/c>)`);
  const match=rowXml.match(pattern);
  if(match)return rowXml.replace(pattern,()=>cell(ref,value,match[1],formula));
  return rowXml.replace('</row>',cell(ref,value,newAttrs,formula)+'</row>');
}
export function templateExport(template: Uint8Array, order: Order, rows: number[], products?: Product[], includeSupplementary=true) {
  rows=[...new Set(rows.filter(row=>Number.isInteger(row)&&row>0))];
  const files=unzipSync(template);
  cleanWorkbook(files,order.kind==='accessories');
  const path='xl/worksheets/sheet1.xml';
  let xml=strFromU8(files[path]);
  if(order.kind==='accessories') {
    // The accessory template freezes its first row; generated order files should scroll normally.
    xml=xml.replace(/<pane\b[^>]*state="frozen"[^>]*\/>/,'');
    xml=xml.replace(/<selection\b[^>]*pane="bottomLeft"[^>]*\/>/,'');
  }
  const qty=order.kind==='accessories'?'G':'C';
  const lines=new Map(order.items.map(l=>[l.sourceRow,l]));
  const productsByRow=products?new Map(products.map(product=>[product.sourceRow,product])):undefined;
  const rowSet=new Set(rows);
  const seenRows=new Set<number>();
  const col1=order.kind==='accessories'?'K':'F', col2=order.kind==='accessories'?'L':'G';
  const metadata:[string,string][]=[['Gestiune',order.warehouseName],['Agent',order.agentName],['Data',new Date(order.finalizedAt||order.createdAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})],['Observatii',order.notes]];
  const sourceStyle=xml.match(new RegExp(`<c\\b[^>]*r="${order.kind==='accessories'?'D2':'B2'}"[^>]*s="(\\d+)"`))?.[1];
  const metaAttrs=sourceStyle?` s="${sourceStyle}"`:'';
  const seenMeta=new Set<number>();
  type Writer=typeof put;
  const patchCatalogRow=(target:string,row:number,write:Writer)=>{
    const line=lines.get(row);
    const product=productsByRow?.get(row)||line;
    if(product) {
      target=write(target,`A${row}`,product.code);
      target=write(target,`${order.kind==='accessories'?'D':'B'}${row}`,product.name);
      if(order.kind==='accessories') {
        target=write(target,`C${row}`,product.brand);target=write(target,`E${row}`,product.netPrice);target=write(target,`F${row}`,product.price);
      }
    } else if(products) {
      target=write(target,`A${row}`,null);target=write(target,`${order.kind==='accessories'?'D':'B'}${row}`,null);
    }
    target=write(target,`${qty}${row}`,line?.quantity??null);
    if(order.kind==='accessories') {
      const original=target.match(new RegExp(`<c\\b[^>]*r="H${row}"[^>]*>([\\s\\S]*?)<\\/c>`));
      const formula=original?.[1].match(/<f[^>]*>([\s\S]*?)<\/f>/)?.[1]||`F${row}*G${row}`;
      const unit=/E\$?\d+/.test(formula)?line?.netPrice:line?.price;
      target=write(target,`H${row}`,line?Math.round((unit||0)*line.quantity*1e8)/1e8:0,formula);
    }
    return target;
  };
  const patchMetadataRow=(target:string,row:number,write:Writer)=>{
    const [label,value]=metadata[row-1];
    target=write(target,`${col1}${row}`,label,undefined,metaAttrs);
    return write(target,`${col2}${row}`,value,undefined,metaAttrs);
  };
  xml=xml.replace(/<row\b[^>]*\br="(\d+)"[^>]*>[\s\S]*?<\/row>/g,(rowXml,rowText)=>{
    const row=Number(rowText);let next=rowXml;
    if(rowSet.has(row)){seenRows.add(row);next=patchCatalogRow(next,row,putInRow);}
    if(row>=1&&row<=metadata.length){seenMeta.add(row);next=patchMetadataRow(next,row,putInRow);}
    return next;
  });
  // Templates normally contain every source row; keep the old insertion behavior for malformed/legacy templates.
  for(const row of rows)if(!seenRows.has(row))xml=patchCatalogRow(xml,row,put);
  for(let row=1;row<=metadata.length;row++)if(!seenMeta.has(row))xml=patchMetadataRow(xml,row,put);
  const startCol=order.kind==='accessories'?11:6;
  const extraCols=`<col min="${startCol}" max="${startCol}" width="${order.kind==='accessories'?34:15}" customWidth="1"/><col min="${startCol+1}" max="${startCol+1}" width="${order.kind==='accessories'?125:58}" customWidth="1"/>`;
  if(xml.includes('</cols>')) xml=xml.replace('</cols>',extraCols+'</cols>');
  else xml=xml.replace('<sheetData>','<cols>'+extraCols+'</cols><sheetData>');
  xml=xml.replace(/<dimension ref="[^"]*"\s*\/>/,`<dimension ref="A1:${col2}${Math.max(...rows,5)}"/>`);
  files[path]=strToU8(xml);
  let workbook=strFromU8(files['xl/workbook.xml']);
  workbook=workbook.replace(/<calcPr[^>]*\/>/,'<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>');
  files['xl/workbook.xml']=strToU8(workbook);
  if(includeSupplementary) addSupplementaryProducts(files,order);
  cleanWorkbook(files,order.kind==='accessories');
  return zipSync(files,{level:1});
}

export function combinedExport(_template:Uint8Array,order:Order,_rows:number[],_products?:Product[]){
  return orderWorkbook(order);
}

export function repairOrderExport(bytes:Uint8Array,order:Order) {
  if(order.kind==='sim')return bytes;
  const files=unzipSync(bytes);
  if(order.kind==='combined')return strFromU8(files['xl/workbook.xml']).includes('mobiup-order-v4')?bytes:orderWorkbook(order);
  const changed=cleanWorkbook(files,order.kind==='accessories');
  return changed?zipSync(files,{level:6}):bytes;
}

export function simExport(order: Order) {
  const rows:(string|number)[][]=[['MOBIUP · AVIZ CLIENT SIM 0'],['Data',new Date(order.finalizedAt||order.createdAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})],['Gestiune',order.warehouseName],['Agent',order.agentName],['Client',order.client?.name||''],['CUI',order.client?.cui||''],['Localitate',order.client?.city||''],['Județ',countyLabel(order.client?.county)],['Adresă',order.client?.address||''],['Produs','sim 0 vodafone'],['Cantitate',order.serials.length],['Observații',order.notes],[],['Nr. crt.','Serie SIM'],...order.serials.map((s,i)=>[i+1,s])];
  const sheet=`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="14" topLeftCell="A15" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="23" customWidth="1"/><col min="2" max="2" width="85" customWidth="1"/></cols><sheetData>${rows.map((r,i)=>`<row r="${i+1}" ht="${i===0?32:23}" customHeight="1">${r.map((v,j)=>cell(`${String.fromCharCode(65+j)}${i+1}`,v,` s="${i===0||i===13?1:2}"`)).join('')}</row>`).join('')}</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const files:Record<string,Uint8Array>={};
  const content={
    '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Aviz SIM 0" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':'<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE52430"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml':sheet,
  };
  Object.entries(content).forEach(([path,value])=>{files[path]=strToU8(value);});
  return zipSync(files,{level:6});
}
export function mailFor(order: Order,settings: Settings): Mail {
  if(order.kind==='stand_client') {
    const to=mailDefaults.standClientTo,cc=[...new Set(settings.standsCc.filter(address=>address&&!mailDefaults.standClientExcludedCc.includes(address.trim().toLowerCase())))];
    const subject=`Aviz pentru standuri | ${order.client?.name} | ${order.warehouseName}`;
    const body=`Bună ziua,\n\nRog avizare stand către clientul ${order.client?.name}.\nCUI: ${order.client?.cui}\nPunct de lucru: ${order.client?.city}, ${countyLabel(order.client?.county)}, ${order.client?.address}\n\n${order.items.map(l=>`${l.code} — ${l.name}: ${l.quantity} buc.`).join('\n')}\n\nAgent: ${order.agentName}${order.notes?`\nObservații: ${order.notes}`:''}`;
    return {to,cc,subject,body,filename:`aviz-standuri-${order.number}.eml`,mailto:`mailto:${to}?cc=${encodeURIComponent(cc.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`};
  }
  const hasAccessories=order.kind==='accessories'||order.kind==='combined'&&order.items.length>0;
  const hasStands=order.kind==='stands'||order.kind==='combined'&&(order.standItems||[]).length>0;
  const hasSim=order.kind==='sim';
  const ordered=orderedProductGroups(order);
  const combinedLabel=ordered.length>1?'Comandă mixtă':`Comandă ${(ordered[0]?.label||'stoc').toLocaleLowerCase('ro-RO').replace(' & ',' și ')}`;
  const label=order.kind==='sim'?'Aviz SIM 0':order.kind==='stands'?'Comandă standuri, cartele & telefoane':order.kind==='combined'?combinedLabel:'Comandă accesorii';
  const recipientGroups=[...(hasAccessories?[settings.accessoriesEmail]:[]),...(hasStands?[settings.standsEmail]:[]),...(hasSim?[settings.simEmail]:[])];
  const to=[...new Set(recipientGroups.filter(Boolean))].join(',');
  const cc=[...new Set([...(hasAccessories?settings.accessoriesCc:[]),...(hasStands?settings.standsCc:[]),...(hasSim?settings.simCc:[])].filter(Boolean))];
  const subject=`${label} | ${order.kind==='sim'?`${order.client?.name} | CUI ${order.client?.cui} | `:''}${order.warehouseName}`;
  const detail=order.kind==='sim'?`Client: ${order.client?.name}\nCUI: ${order.client?.cui}\nLocalitate: ${order.client?.city}, ${countyLabel(order.client?.county)}\nAdresă: ${order.client?.address}\n\nProdus: sim 0 vodafone\nCantitate: ${order.serials.length}\n\nSerii SIM:\n${order.serials.map((s,i)=>`${i+1}. ${s}`).join('\n')}`:order.items.map(l=>`${l.code} — ${l.name}: ${l.quantity} buc.`).join('\n');
  const body=order.kind==='accessories'
    ? `Bună ziua,\n\nFișierul Excel pentru comanda de accesorii este atașat.\nGestiune: ${order.warehouseName}\nAgent: ${order.agentName}`
    : order.kind==='combined'
    ? `Bună ziua,\n\n${combinedLabel} pentru ${order.warehouseName}:\n${ordered.map(g=>`• ${g.label.replace(' & ',' și ')}: ${g.lines.reduce((sum,p)=>sum+p.quantity,0)} buc.`).join('\n')}\n\nAgent: ${order.agentName}\nDetaliile sunt în Excelul atașat.${order.notes?`\nObservații: ${order.notes}`:''}`
    : `Bună ziua,\n\n${label}\nGestiune: ${order.warehouseName}\nAgent: ${order.agentName}\n\n${detail}${order.notes?`\n\nObservații: ${order.notes}`:''}`;
  const stamp=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Bucharest'}).format(new Date(order.finalizedAt||order.createdAt));
  const filename=`${order.kind==='sim'?'aviz-sim-0':order.kind==='stands'?'comanda-standuri-cartele-telefoane':order.kind==='combined'?'comanda-combinata':'comanda-accesorii'}-${stamp}-${order.agentName.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9.-]/gi,'_')}.xlsx`;
  const shortBody=body.length<5000?body:`Bună ziua,\n\n${order.kind==='accessories'?'Fișierul Excel pentru comanda de accesorii este atașat.':`${label}\nGestiune: ${order.warehouseName}\nAgent: ${order.agentName}\nDetaliile complete sunt în fișierul Excel.`}`;
  return {to,cc,subject,body,filename,mailto:`mailto:${encodeURIComponent(to)}?cc=${encodeURIComponent(cc.join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(shortBody)}`};
}
export function emlFor(mail: Mail,bytes?: Uint8Array) {
  if(!bytes) return `MIME-Version: 1.0\r\nX-Unsent: 1\r\nTo: ${mail.to}\r\n${mail.cc.length?`Cc: ${mail.cc.join(", ")}\r\n`:""}Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(mail.body).toString('base64').match(/.{1,76}/g)?.join('\r\n')||''}\r\n`;
  const boundary='mobiup_'+crypto.randomUUID();
  const base64=(value: Uint8Array|string)=>Buffer.from(value).toString('base64').match(/.{1,76}/g)?.join('\r\n')||'';
  return `MIME-Version: 1.0\r\nX-Unsent: 1\r\nTo: ${mail.to}\r\n${mail.cc.length?`Cc: ${mail.cc.join(", ")}\r\n`:""}Subject: =?UTF-8?B?${Buffer.from(mail.subject).toString('base64')}?=\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(mail.body)}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\nContent-Disposition: attachment; filename="${mail.filename}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64(bytes)}\r\n--${boundary}--\r\n`;
}

function addSupplementaryProducts(files:Record<string,Uint8Array>,order:Order) {
  const products=order.items.filter(p=>!p.sourceRow);
  if(!products.length)return;
  let book=strFromU8(files['xl/workbook.xml']);
  let rels=strFromU8(files['xl/_rels/workbook.xml.rels']);
  let types=strFromU8(files['[Content_Types].xml']);
  const number=Math.max(0,...Object.keys(files).map(p=>Number(p.match(/^xl\/worksheets\/sheet(\d+)\.xml$/)?.[1])||0))+1;
  const sheetId=Math.max(0,...[...book.matchAll(/sheetId="(\d+)"/g)].map(m=>Number(m[1])))+1;
  const rid='rIdCatalog'+number;
  const rows:(string|number|null)[][]=[['Produse suplimentare'],['Gestiune',order.warehouseName],['Agent',order.agentName],[],['Cod','Denumire','Cantitate','Preț fără TVA','Preț cu TVA','Total cu TVA'],...products.map(p=>[p.code,p.name,p.quantity,p.netPrice,p.price,p.price===null?null:Math.round(p.price*p.quantity*100)/100])];
  const sheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="5" topLeftCell="A6" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="22" customWidth="1"/><col min="2" max="2" width="85" customWidth="1"/><col min="3" max="6" width="20" customWidth="1"/></cols><sheetData>${rows.map((r,i)=>`<row r="${i+1}" ht="25" customHeight="1">${r.map((v,j)=>cell(`${String.fromCharCode(65+j)}${i+1}`,v)).join('')}</row>`).join('')}</sheetData><autoFilter ref="A5:F${rows.length}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`;
  files[`xl/worksheets/sheet${number}.xml`]=strToU8(sheet);
  book=book.replace('</sheets>',`<sheet name="Produse suplimentare" sheetId="${sheetId}" r:id="${rid}"/></sheets>`);
  rels=rels.replace('</Relationships>',`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${number}.xml"/></Relationships>`);
  types=types.replace('</Types>',`<Override PartName="/xl/worksheets/sheet${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
  files['xl/workbook.xml']=strToU8(book);files['xl/_rels/workbook.xml.rels']=strToU8(rels);files['[Content_Types].xml']=strToU8(types);
}
