import {zipSync,strToU8} from 'fflate';
import {xmlSafeText} from './xml-text';
import {transferLabels,serializedCategory} from './transfer-types';
import type {Transfer} from './transfer-types';
import type {Mail} from './types';

export function transferMail(record:Transfer,to:string,cc:string[]):Mail {
  const clean=(value:string)=>value.replace(/[\r\n]/g,' ');
  const source=clean(record.source.warehouseName),destination=clean(record.destination!.warehouseName);
  const groups=[...new Set(record.lines.map(line=>transferLabels[line.category].toLowerCase()))];
  const subject=`Transfer din gestiunea ${source} către ${destination}`;
  const body=`Bună ziua,\n\nVă rog să operați transferul din gestiunea ${source} către gestiunea ${destination}.\n\nProduse transferate: ${groups.join(', ')}.\nDetaliile și seriile sunt în fișierul Excel atașat.${record.notes?`\n\nObservații: ${record.notes}`:''}`;
  const filename=`transfer-${record.number.replace(/[^a-z0-9-]/gi,'_')}.xlsx`;
  return {to,cc,subject,body,filename,mailto:`mailto:${encodeURIComponent(to)}?cc=${encodeURIComponent(cc.join(','))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`};
}
export function transferExport(record:Transfer):Uint8Array {
  const rows:(string|number)[][]=[['TRANSFER ÎNTRE GESTIUNI'],['Document',record.number],['Data',new Date(record.finalizedAt||record.createdAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})],['Din gestiunea',record.source.warehouseName],['Agent expeditor',record.source.agentName],['Către gestiunea',record.destination!.warehouseName],['Agent destinatar',record.destination!.agentName],['Observații',record.notes],[],['Categorie','Cod produs','Denumire','Cantitate','IMEI1 / Serie SIM']];
  for(const line of record.lines){
    if(serializedCategory(line.category))for(const serial of line.serials)rows.push([transferLabels[line.category],line.code,line.name,1,serial]);
    else rows.push([transferLabels[line.category],line.code,line.name,line.quantity,'']);
  }
  rows.push(['TOTAL BUCĂȚI','','',record.lines.reduce((sum,line)=>sum+line.quantity,0),'']);
  const escape=(value:unknown)=>xmlSafeText(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]!));
  const sheet=`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:E${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="10" topLeftCell="A11" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="3" width="55" customWidth="1"/><col min="4" max="4" width="14" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/></cols><sheetData>${rows.map((row,i)=>`<row r="${i+1}" ht="28" customHeight="1">${row.map((value,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" s="${i===0||i===9?1:0}"${typeof value==='number'?'':' t="inlineStr"'}>${typeof value==='number'?`<v>${value}</v>`:`<is><t xml:space="preserve">${escape(value)}</t></is>`}</c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A10:E${rows.length-1}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  const files:Record<string,string>={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Transfer" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/styles.xml':'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="12"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE52430"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    'xl/worksheets/sheet1.xml':sheet,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,strToU8(value)])),{level:6});
}
