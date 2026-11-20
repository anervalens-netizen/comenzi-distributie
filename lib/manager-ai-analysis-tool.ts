import type { ManagerAiPreparedArtifact } from './manager-ai-media-contract';
import { fail } from './server';

export const managerAiAnalysisToolName='run_analysis';

export type ManagerAiAnalysisRequest = {
  language:'sql'|'python';
  code:string;
  tables:{table:string;fromMonth:string;toMonth:string}[];
  files:string[];
};

export type ManagerAiAnalysisCapability = {
  tables:readonly string[];
  instructions:string;
  run:(request:ManagerAiAnalysisRequest)=>Promise<{result:Record<string,unknown>;artifacts:ManagerAiPreparedArtifact[]}>;
};

export function managerAiAnalysisTool(tables:readonly string[]){
  const month={type:'string',description:'Lună AAAA-LL. Lasă gol pentru date curente sau surse fără perioadă.'};
  return {
    type:'function',
    name:managerAiAnalysisToolName,
    description:'Analiză SQL sau Python pe copii analitice ale tabelelor autorizate în Comenzi Distribuție.',
    strict:true,
    parameters:{
      type:'object',additionalProperties:false,
      properties:{
        language:{type:'string',enum:['sql','python']},
        code:{type:'string',description:'O interogare SQL de citire sau cod Python. Scrie exporturile Python în /output.'},
        tables:{type:'array',description:'Tabelele necesare. [] când analiza folosește doar fișiere.',items:{
          type:'object',additionalProperties:false,
          properties:{table:{type:'string',enum:tables},fromMonth:month,toMonth:month},
          required:['table','fromMonth','toMonth'],
        }},
        files:{type:'array',description:'Numele fișierelor din conversația autorizată ori din pașii de analiză anteriori.',items:{type:'string'}},
      },
      required:['language','code','tables','files'],
    },
  };
}

function record(value:unknown):value is Record<string,unknown>{
  return !!value&&typeof value==='object'&&!Array.isArray(value);
}
const monthPattern=/^20\d\d-(0[1-9]|1[0-2])$/;
const isMonth=(value:unknown):value is string=>typeof value==='string'&&(!value||monthPattern.test(value));

export function parseManagerAiAnalysis(raw:string,allowedTables:readonly string[]):ManagerAiAnalysisRequest{
  if(raw.length>48_000)fail(400,'Cererea pentru sandbox este prea mare.');
  let value:unknown;
  try{value=JSON.parse(raw);}catch{fail(400,'Argumente invalide pentru sandbox.');}
  if(!record(value)||Object.keys(value).some(key=>!['language','code','tables','files'].includes(key)))fail(400,'Argumente invalide pentru sandbox.');
  const {language,code,tables,files}=value;
  if((language!=='sql'&&language!=='python')||typeof code!=='string'||!code.trim()||code.length>16_000||code.includes('\u0000')){
    fail(400,'Alege SQL sau Python și trimite cod de maximum 16.000 de caractere.');
  }
  if(!Array.isArray(tables)||tables.length>6)fail(400,'Alege cel mult șase tabele pentru o analiză.');
  const seen=new Set<string>();
  const selection=tables.map((item:unknown)=>{
    if(!record(item)||Object.keys(item).some(key=>!['table','fromMonth','toMonth'].includes(key)))fail(400,'Selecția tabelelor este invalidă.');
    const {table,fromMonth,toMonth}=item;
    if(typeof table!=='string'||!allowedTables.includes(table)||seen.has(table)||
      !isMonth(fromMonth)||!isMonth(toMonth)||fromMonth&&toMonth&&fromMonth>toMonth){
      fail(400,'Alege surse distincte și luni în format AAAA-LL.');
    }
    seen.add(table);
    return {table,fromMonth,toMonth};
  });
  if(!Array.isArray(files)||files.length>4||files.some((name:unknown)=>typeof name!=='string'||!name||
    name.length>128||/[\\/\p{Cc}\p{Cf}]/u.test(name)||name==='.'||name==='..')||new Set(files).size!==files.length){
    fail(400,'Selecția fișierelor este invalidă.');
  }
  return {language,code,tables:selection,files:files as string[]};
}
