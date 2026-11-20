import { read, utils, write, type WorkSheet } from 'xlsx';
import { boundedWorkbook, csvCell, csvSeparator, strictText } from './manager-ai-media';
import type { ManagerAiPreparedArtifact } from './manager-ai-media-contract';

const maxFileBytes=2*1024*1024;
const maxCells=120_000;
const maxSheets=8;
type Value = string|number|boolean|null;

function worksheetValues(sheet:WorkSheet):Value[][] {
  if(!sheet['!ref'])return [];
  const range=utils.decode_range(sheet['!ref']);
  const rows=range.e.r-range.s.r+1,columns=range.e.c-range.s.c+1;
  if(rows<1||columns<1||rows>20_000||columns>128||rows*columns>maxCells)throw Error('Invalid export dimensions');
  return utils.sheet_to_json<unknown[]>(sheet,{header:1,range,defval:null,raw:true,blankrows:true}).map(row=>row.map(value=>{
    if(value===null||typeof value==='string'||typeof value==='boolean')return value;
    if(typeof value==='number'&&Number.isFinite(value))return value;
    throw Error('Unsupported cell type');
  }));
}

function valuesOnlyWorkbook(bytes:Uint8Array) {
  const input=read(boundedWorkbook(bytes),{type:'array',dense:true,cellFormula:false,cellHTML:false,cellText:false});
  if(!input.SheetNames.length||input.SheetNames.length>maxSheets)throw Error('Invalid export sheets');
  const output=utils.book_new();
  let cells=0;
  for(const [index,name] of input.SheetNames.entries()){
    if(input.Workbook?.Sheets?.[index]?.Hidden)throw Error('Hidden sheets are not supported');
    const values=worksheetValues(input.Sheets[name]);
    cells+=values.reduce((sum,row)=>sum+row.length,0);
    if(cells>maxCells)throw Error('Export workbook has too many cells');
    utils.book_append_sheet(output,utils.aoa_to_sheet(values),name);
  }
  // Rebuild the file from primitive values, without links, drawings, formula records,
  // external relationships, hidden content or original ZIP members.
  return new Uint8Array(write(output,{type:'array',bookType:'xlsx',compression:true}));
}

function sanitizeDelimited(bytes:Uint8Array, tabSeparated:boolean) {
  const text=strictText(bytes);
  const separator=tabSeparated?'\t':csvSeparator(text);
  const input=read(text,{type:'string',dense:true,raw:true,FS:separator,cellFormula:false});
  if(input.SheetNames.length!==1)throw Error('Invalid delimited export');
  const values=worksheetValues(input.Sheets[input.SheetNames[0]]);
  return new TextEncoder().encode('\uFEFF'+values.map(row=>row.map(value=>
    csvCell(typeof value==='boolean'?(value?'true':'false'):value)).join(separator)).join('\r\n')+'\r\n');
}

/** Convert generated document downloads to inert values and keep original binary media only after runner validation. */
export function normalizeManagerAiSandboxArtifact(file:ManagerAiPreparedArtifact):ManagerAiPreparedArtifact|null {
  if(file.kind!=='output'||!file.bytes.byteLength||file.bytes.byteLength>maxFileBytes)return null;
  try {
    const lower=file.filename.toLowerCase();
    let bytes=file.bytes;
    if(lower.endsWith('.xlsx')) bytes=valuesOnlyWorkbook(bytes);
    else if(lower.endsWith('.csv')||lower.endsWith('.tsv')) bytes=sanitizeDelimited(bytes,lower.endsWith('.tsv'));
    else if(!['.png','.txt','.json','.md'].some(ext=>lower.endsWith(ext)))return null;
    return bytes.byteLength<=maxFileBytes?{...file,bytes}:null;
  }catch{
    return null;
  }
}
