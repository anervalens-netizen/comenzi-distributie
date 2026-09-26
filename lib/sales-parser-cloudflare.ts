import { parseSalesFile } from './sales-file';
export async function parseSalesFileRuntime(bytes:Uint8Array,filename:string) {
  return parseSalesFile(bytes,filename);
}
