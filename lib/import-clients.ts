import { unzipSync, strFromU8 } from 'fflate';
import { normalize } from './client-api';
export type ImportClient={name:string;cui:string;city:string;county:string;address:string;route:string};
export async function readClients(file:File):Promise<{clients:ImportClient[];warnings:string[];sheet:string}> {
  if(!/\.xlsx$/i.test(file.name)||file.size>8_000_000) throw new Error('Încarcă un fișier .xlsx de maximum 8 MB.');
  let total=0;
  const archive=unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:f=>{total+=f.originalSize;if(total>40_000_000||f.originalSize>15_000_000)throw new Error('Fișierul Excel este prea mare după decomprimare.');return f.name.endsWith('.xml')||f.name.endsWith('.rels');}});
  const parse=(path:string)=>{
    if(!archive[path])throw new Error('Structura Excel nu este validă.');
    const doc=new DOMParser().parseFromString(strFromU8(archive[path]),'application/xml');
    if(doc.querySelector('parsererror'))throw new Error('Un element din Excel nu poate fi citit.');
    return doc;
  };
  const book=parse('xl/workbook.xml');
  const sheets=Array.from(book.getElementsByTagName('sheet'));
  const sheet=sheets.find(s=>normalize(s.getAttribute('name')||'').trim()==='portofoliu')||sheets[0];
  if(!sheet)throw new Error('Fișierul nu conține foi de calcul.');
  const rid=sheet.getAttribute('r:id');
  const rel=Array.from(parse('xl/_rels/workbook.xml.rels').getElementsByTagName('Relationship')).find(r=>r.getAttribute('Id')===rid);
  const target=rel?.getAttribute('Target');
  if(!target||target.includes('..'))throw new Error('Foaia de clienți nu poate fi identificată.');
  const strings=archive['xl/sharedStrings.xml']?Array.from(parse('xl/sharedStrings.xml').getElementsByTagName('si')).map(s=>Array.from(s.getElementsByTagName('t')).map(t=>t.textContent||'').join('')):[];
  const doc=parse(target.startsWith('/')?target.slice(1):'xl/'+target);
  const rows=Array.from(doc.getElementsByTagName('row')).map(row=>{
    const cells:Record<string,string>={};
    Array.from(row.getElementsByTagName('c')).forEach(c=>{
      const ref=c.getAttribute('r')||'',type=c.getAttribute('t'),raw=c.getElementsByTagName('v')[0]?.textContent||'';
      const text=type==='s'?strings[Number(raw)]||'':type==='inlineStr'?Array.from(c.getElementsByTagName('t')).map(t=>t.textContent||'').join(''):raw;
      cells[ref.replace(/\d/g,'')]=text.replace(/\s+/g,' ').trim();
    });return {number:row.getAttribute('r'),cells};
  });
  const aliases:Record<keyof ImportClient,string[]>={name:['partnername','denumire','denumire client','client','firma'],cui:['cif','cui','cod fiscal'],city:['oras','localitate','localitatea','locatia'],county:['judet'],address:['street','adresa','adresa magazin'],route:['ruta nr','ruta','nr ruta']};
  const header=rows.slice(0,15).find(r=>Object.values(r.cells).some(v=>aliases.name.includes(normalize(v)))&&Object.values(r.cells).some(v=>aliases.cui.includes(normalize(v))));
  if(!header)throw new Error('Nu găsesc coloanele pentru denumire și CUI. Folosește PartnerName / Denumire, CIF / CUI și Oras / Localitate.');
  const cols:Partial<Record<keyof ImportClient,string>>={};
  for(const [key,names] of Object.entries(aliases)) cols[key as keyof ImportClient]=Object.entries(header.cells).find(([,v])=>names.includes(normalize(v)))?.[0];
  if(!cols.city)throw new Error('Lipsește coloana Oras / Localitate.');
  const clients:ImportClient[]=[],warnings:string[]=[];
  for(const row of rows.slice(rows.indexOf(header)+1)) {
    const get=(k:keyof ImportClient)=>cols[k]?row.cells[cols[k]!]||'':'';
    const name=get('name'),cui=get('cui'),city=get('city');
    if(!name&&!cui&&!city)continue;
    if(!name||!cui||!city){warnings.push(`Rând ${row.number}: ${name||'fără denumire'} — lipsesc denumire, CUI sau localitate.`);continue;}
    clients.push({name,cui,city,county:get('county'),address:get('address'),route:get('route')});
  }
  if(!clients.length)throw new Error('Nu am găsit clienți cu denumire, CUI și localitate complete.');
  return {clients,warnings,sheet:sheet.getAttribute('name')||''};
}
