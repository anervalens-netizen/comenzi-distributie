import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';

import { validateClientFile, CLIENT_ROW_LIMIT, type ImportClient, type ParsedClients } from './client-import-types.ts';
export type { ImportClient, ParsedClients } from './client-import-types.ts';
const normalize=(value:string)=>value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const invalidXml=()=>new Error('Un element din Excel nu poate fi citit.');

type XmlHandlers={open?:(name:string,attributes:Record<string,string>)=>void;close?:(name:string)=>void;text?:(text:string)=>void};
function xml(text:string,handlers:XmlHandlers) {
  // Saxes is shared by browser and Node workers. No DOM or worksheet tree is built.
  const parser=new SaxesParser({xmlns:true});
  parser.on('error',()=>{throw invalidXml();});
  parser.on('doctype',()=>{throw invalidXml();});
  parser.on('opentag',tag=>handlers.open?.(tag.name,Object.fromEntries(Object.entries(tag.attributes).map(([name,value])=>[name,value.value]))));
  parser.on('closetag',tag=>handlers.close?.(tag.name));
  parser.on('text',value=>handlers.text?.(value));
  parser.on('cdata',value=>handlers.text?.(value));
  parser.write(text).close();
}

export function parseClients(bytes:Uint8Array,filename:string):ParsedClients {
  validateClientFile(filename,bytes.length);
  let total=0;
  const archive=unzipSync(bytes,{filter:file=>{
    total+=file.originalSize;
    if(total>40_000_000||file.originalSize>15_000_000)throw new Error('Fișierul Excel este prea mare după decomprimare.');
    return file.name.endsWith('.xml')||file.name.endsWith('.rels');
  }});
  const part=(path:string)=>{
    if(!archive[path])throw new Error('Structura Excel nu este validă.');
    return strFromU8(archive[path]);
  };
  const sheets:Record<string,string>[]=[];
  xml(part('xl/workbook.xml'),{open:(name,attrs)=>{if(name==='sheet')sheets.push(attrs);}});
  const sheet=sheets.find(s=>normalize(s.name||'').trim()==='portofoliu')||sheets[0];
  if(!sheet)throw new Error('Fișierul nu conține foi de calcul.');
  let target:string|undefined;
  xml(part('xl/_rels/workbook.xml.rels'),{open:(name,attrs)=>{if(name==='Relationship'&&attrs.Id===sheet['r:id']&&target===undefined)target=attrs.Target;}});
  if(!target||target.includes('..'))throw new Error('Foaia de clienți nu poate fi identificată.');
  const strings:string[]=[];
  if(archive['xl/sharedStrings.xml']) {
    let inString=false,textDepth=0,value='';
    xml(part('xl/sharedStrings.xml'),{
      open:name=>{if(name==='si'){inString=true;value='';}if(inString&&name==='t')textDepth++;},
      text:text=>{if(inString&&textDepth)value+=text;},
      close:name=>{if(name==='t'&&textDepth)textDepth--;if(name==='si'){strings.push(value);inString=false;}},
    });
  }
  const aliases:Record<keyof ImportClient,string[]>={name:['partnername','denumire','denumire client','client','firma'],cui:['cif','cui','cod fiscal'],city:['oras','localitate','localitatea','locatia'],county:['judet'],address:['street','adresa','adresa magazin'],route:['ruta nr','ruta','nr ruta']};
  let cols:Partial<Record<keyof ImportClient,string>>|null=null,rowCount=0,rowNumber:string|null=null,cells:Record<string,string>={},inRow=false;
  let cell:{ref:string;type:string;raw:string;text:string;valueSeen:boolean}|null=null,valueDepth=0,textDepth=0;
  const clients:ImportClient[]=[],warnings:string[]=[];
  const finishRow=()=>{
    rowCount++;
    if(!cols) {
      if(rowCount<=15&&Object.values(cells).some(v=>aliases.name.includes(normalize(v)))&&Object.values(cells).some(v=>aliases.cui.includes(normalize(v)))) {
        cols={};
        for(const [key,names] of Object.entries(aliases))cols[key as keyof ImportClient]=Object.entries(cells).find(([,v])=>names.includes(normalize(v)))?.[0];
        if(!cols.city)throw new Error('Lipsește coloana Oras / Localitate.');
      }
      return;
    }
    const get=(key:keyof ImportClient)=>cols?.[key]?cells[cols[key]!]||'':'';
    const name=get('name'),cui=get('cui'),city=get('city');
    if(!name&&!cui&&!city)return;
    if(!name||!cui||!city){warnings.push(`Rând ${rowNumber}: ${name||'fără denumire'} — lipsesc denumire, CUI sau localitate.`);return;}
    if(clients.length===CLIENT_ROW_LIMIT)throw new Error('Importul acceptă între 1 și 3.000 de clienți.');
    clients.push({name,cui,city,county:get('county'),address:get('address'),route:get('route')});
  };
  xml(part(target.startsWith('/')?target.slice(1):'xl/'+target),{
    open:(name,attrs)=>{
      if(name==='row'){inRow=true;cells={};rowNumber=attrs.r??null;}
      if(inRow&&name==='c'){cell={ref:attrs.r||'',type:attrs.t||'',raw:'',text:'',valueSeen:false};valueDepth=0;textDepth=0;}
      if(cell&&name==='v'&&!cell.valueSeen){cell.valueSeen=true;valueDepth=1;}
      else if(cell&&valueDepth)valueDepth++;
      if(cell&&name==='t')textDepth++;
    },
    text:text=>{if(cell){if(valueDepth)cell.raw+=text;if(textDepth)cell.text+=text;}},
    close:name=>{
      if(cell&&valueDepth)valueDepth--;
      if(name==='t'&&textDepth)textDepth--;
      if(name==='c'&&cell){const value=cell.type==='s'?strings[Number(cell.raw)]||'':cell.type==='inlineStr'?cell.text:cell.raw;cells[cell.ref.replace(/\d/g,'')]=value.replace(/\s+/g,' ').trim();cell=null;}
      if(name==='row'){finishRow();inRow=false;}
    },
  });
  if(!cols)throw new Error('Nu găsesc coloanele pentru denumire și CUI. Folosește PartnerName / Denumire, CIF / CUI și Oras / Localitate.');
  if(!clients.length)throw new Error('Nu am găsit clienți cu denumire, CUI și localitate complete.');
  return {clients,warnings,sheet:sheet.name||''};
}
