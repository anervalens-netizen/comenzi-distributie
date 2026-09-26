import { parseStockFile } from './stock-file';

export async function parseStockFileRuntime(bytes:Uint8Array,filename:string) {
  return parseStockFile(bytes,filename);
}
