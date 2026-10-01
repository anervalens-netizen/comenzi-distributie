export type ImportClient={name:string;cui:string;city:string;county:string;address:string;route:string};
export type ParsedClients={clients:ImportClient[];warnings:string[];sheet:string};
export const CLIENT_FILE_LIMIT=8_000_000;
export const CLIENT_ROW_LIMIT=3000;
export function validateClientFile(filename:string,size:number) {
  if(!/\.xlsx$/i.test(filename)||size>CLIENT_FILE_LIMIT)throw new Error('Încarcă un fișier .xlsx de maximum 8 MB.');
}
