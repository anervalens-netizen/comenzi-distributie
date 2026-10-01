import { parseClients, type ParsedClients } from './import-clients-parser.ts';
export type ClientImportInput={file:Blob;filename:string};
export type ClientImportResult={ok:true;result:ParsedClients}|{ok:false;error:string};
export async function clientImportJob({file,filename}:ClientImportInput):Promise<ClientImportResult> {
  try{return {ok:true,result:parseClients(new Uint8Array(await file.arrayBuffer()),filename)};}
  catch(error){return {ok:false,error:error instanceof Error?error.message:'Fișier Excel invalid.'};}
}
