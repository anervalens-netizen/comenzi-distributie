import {strToU8,zipSync} from 'fflate';
import type {Order} from './types';
import {orderProductGroup,orderProductGroupLabels,type OrderProductGroup} from './order-product-group';
import {xmlSafeText} from './xml-text';

const escape=(value:unknown)=>xmlSafeText(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
const main='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export function orderedProductGroups(order:Order){
  const lines=[...order.items,...(order.kind==='combined'?order.standItems||[]:[])].filter(p=>Number.isInteger(p.quantity)&&p.quantity>0);
  return (['accessories','stands','merchandising'] as OrderProductGroup[]).map(key=>({key,label:orderProductGroupLabels[key],lines:lines.filter(p=>orderProductGroup(p)===key)})).filter(g=>g.lines.length);
}
const cell=(ref:string,value:unknown,style:number,formula?:string)=>typeof value==='number'&&Number.isFinite(value)
  ?`<c r="${ref}" s="${style}">${formula?`<f>${escape(formula)}</f>`:''}<v>${value}</v></c>`
  :value===null||value===undefined?`<c r="${ref}" s="${style}"/>`:`<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
const styles=`<styleSheet xmlns="${main}"><fonts count="3"><font><sz val="11"/><color rgb="FF243247"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="16"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE52430"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F5F8"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom style="thin"><color rgb="FFE1E6EC"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">${[[0,0,0,'left'],[2,2,0,'left'],[1,2,0,'left'],[0,3,0,'left'],[0,0,1,'center'],[0,3,1,'center'],[0,0,4,'right'],[0,3,4,'right']].map(([font,fill,num,align])=>`<xf numFmtId="${num}" fontId="${font}" fillId="${fill}" borderId="0" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="${align}" vertical="center" wrapText="1"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/** Export the immutable order snapshot, never the catalogue or unselected rows. */
export function orderWorkbook(order:Order){
  const groups=orderedProductGroups(order);
  if(!groups.length)throw new Error('Comanda nu conține produse cu cantitate pozitivă.');
  const files:Record<string,Uint8Array>={},overrides:string[]=[],relations:string[]=[],sheets:string[]=[],names:string[]=[];
  for(const [index,group] of groups.entries()){
    const number=index+1,priced=group.key==='accessories',end=priced?'G':'D',last=7+group.lines.length,total=last+2;
    const headers=['Cod produs','Denumire','Categorie','Cantitate (buc.)',...(priced?['Preț fără TVA (RON)','Preț cu TVA (RON)','Valoare cu TVA (RON)']:[])];
    const row=(n:number,values:unknown[],style=0,height=30)=>`<row r="${n}" ht="${height}" customHeight="1">${values.map((v,i)=>cell(`${String.fromCharCode(65+i)}${n}`,v,style)).join('')}</row>`;
    const data=[row(1,['COMANDĂ STOC · '+order.number],1,34),row(2,[group.label],2,30),row(3,['Gestiune',order.warehouseName]),row(4,['Agent',order.agentName]),row(5,['Data',new Date(order.finalizedAt||order.createdAt).toLocaleString('ro-RO',{timeZone:'Europe/Bucharest'})]),...(order.notes?[row(6,['Observații',order.notes],3,42)]:[]),row(7,headers,2,38)];
    group.lines.forEach((p,i)=>{
      const n=8+i,stripe=i%2;
      const values=[p.code,p.name,p.category,p.quantity,...(priced?[p.netPrice,p.price,p.price===null?null:Math.round(p.price*p.quantity*100)/100]:[])];
      data.push(`<row r="${n}" ht="42" customHeight="1">${values.map((v,j)=>cell(`${String.fromCharCode(65+j)}${n}`,v,j===3?4+stripe:j>=4?6+stripe:stripe?3:0,j===6&&p.price!==null?`D${n}*F${n}`:undefined)).join('')}</row>`);
    });
    const quantity=group.lines.reduce((sum,p)=>sum+p.quantity,0),knownPrices=group.lines.every(p=>p.price!==null);
    data.push(`<row r="${total}" ht="32" customHeight="1">${cell(`A${total}`,'TOTAL',2)}${cell(`D${total}`,quantity,4,`SUM(D8:D${last})`)}${priced?cell(`G${total}`,knownPrices?Math.round(group.lines.reduce((sum,p)=>sum+(p.price||0)*p.quantity,0)*100)/100:null,6,knownPrices?`SUM(G8:G${last})`:undefined):''}</row>`);
    if(priced&&!knownPrices)data.push(row(total+1,['Valoarea totală nu este calculată: există produse fără preț.'],0,32));
    const merges=[`A1:${end}1`,`A2:${end}2`,`B3:${end}3`,`B4:${end}4`,`B5:${end}5`,`A${total}:C${total}`,...(order.notes?[`B6:${end}6`]:[]),...(priced&&!knownPrices?[`A${total+1}:${end}${total+1}`]:[])];
    const bottom=total+(priced&&!knownPrices?1:0),path=`xl/worksheets/sheet${number}.xml`;
    files[path]=strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${main}"><sheetPr filterMode="1"><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:${end}${bottom}"/><sheetViews><sheetView showGridLines="0" tabSelected="${index===0?1:0}" workbookViewId="0"><pane ySplit="7" topLeftCell="A8" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A8" sqref="A8"/></sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="58" customWidth="1"/><col min="3" max="3" width="25" customWidth="1"/><col min="4" max="4" width="18" customWidth="1"/>${priced?'<col min="5" max="7" width="19" customWidth="1"/>':''}</cols><sheetData>${data.join('')}</sheetData><autoFilter ref="A7:${end}${last}"><filterColumn colId="3"><customFilters><customFilter operator="greaterThan" val="0"/></customFilters></filterColumn></autoFilter><mergeCells count="${merges.length}">${merges.map(ref=>`<mergeCell ref="${ref}"/>`).join('')}</mergeCells><pageMargins left="0.25" right="0.25" top="0.4" bottom="0.4" header="0.15" footer="0.15"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`);
    overrides.push(`<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    sheets.push(`<sheet name="${escape(group.label)}" sheetId="${number}" r:id="rId${number}"/>`);
    relations.push(`<Relationship Id="rId${number}" Type="${rel}/worksheet" Target="worksheets/sheet${number}.xml"/>`);
    names.push(`<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${escape(`'${group.label}'!$A$7:$${end}$${last}`)}</definedName><definedName name="_xlnm.Print_Area" localSheetId="${index}">${escape(`'${group.label}'!$A$1:$${end}$${bottom}`)}</definedName><definedName name="_xlnm.Print_Titles" localSheetId="${index}">${escape(`'${group.label}'!$7:$7`)}</definedName>`);
  }
  files['xl/styles.xml']=strToU8(styles);
  files['xl/workbook.xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${main}" xmlns:r="${rel}"><!-- mobiup-order-v4 --><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.join('')}</sheets><definedNames>${names.join('')}</definedNames><calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`);
  files['xl/_rels/workbook.xml.rels']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relations.join('')}<Relationship Id="rIdStyles" Type="${rel}/styles" Target="styles.xml"/></Relationships>`);
  files['_rels/.rels']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWorkbook" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  files['[Content_Types].xml']=strToU8(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides.join('')}</Types>`);
  return zipSync(files,{level:6});
}
