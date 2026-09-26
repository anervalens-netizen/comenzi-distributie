import { strFromU8, strToU8 } from 'fflate';

// Remove image payloads and the template's obsolete formula dependency chain.
// Excel rebuilds dependencies from the actual formulas when opening the export.
export function cleanWorkbook(files:Record<string,Uint8Array>, accessory:boolean) {
  let changed=false;
  const removed=new Set(Object.keys(files).filter(n=>/^xl\/(media|drawings)\//.test(n)||n==='xl/calcChain.xml'));
  for(const name of removed){delete files[name];changed=true;}
  for(const [name,bytes] of Object.entries(files)) {
    if(!name.endsWith('.xml')&&!name.endsWith('.rels'))continue;
    let xml=strFromU8(bytes);const original=xml;
    if(name.endsWith('.rels'))xml=xml.replace(/<Relationship\b[^>]*\/>/g,tag=>/Type="[^"]*\/(?:image|drawing|calcChain)"/.test(tag)?'':tag);
    if(name==='[Content_Types].xml')xml=xml.replace(/<Override\b[^>]*\/>/g,tag=>removed.has(tag.match(/PartName="\/([^"]+)"/)?.[1]||'')?'':tag);
    if(/^xl\/worksheets\/sheet\d+\.xml$/.test(name))xml=xml.replace(/<(?:drawing|picture)\b[^>]*\/>/g,'');
    if(accessory&&name==='xl/worksheets/sheet1.xml') {
      xml=xml.replace(/<pane\b[^>]*state="frozen(?:Split)?"[^>]*\/>/g,'').replace(/<selection\b[^>]*pane="[^"]*"[^>]*\/>/g,'');
      // Images required tall rows in the source catalogue; text-only exports do not.
      xml=xml.replace(/<row\b[^>]*>/g,tag=>tag.replace(/ht="[^"]*"/,'ht="32"'));
    }
    if(accessory&&(name==='xl/workbook.xml'||name.startsWith('xl/worksheets/'))) {
      xml=xml.replace(/name="Preturi"/g,'name="Accesorii"').replace(/(?:'Preturi'|Preturi)!/g,"'Accesorii'!");
    }
    if(name==='xl/workbook.xml') {
      // A copied template already uses sheetId=2. Assign unique IDs explicitly.
      let id=0;xml=xml.replace(/<sheet\b[^>]*\/>/g,tag=>tag.replace(/sheetId="\d+"/,`sheetId="${++id}"`));
      xml=xml.replace(/<calcPr\b[^>]*\/>/,'<calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>');
    }
    if(xml!==original){files[name]=strToU8(xml);changed=true;}
  }
  return changed;
}
