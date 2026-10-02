import {fail} from './server';
export async function historyImportStatus(..._args:unknown[]):Promise<never>{return fail(503,'Importul pe clienți necesită serverul aplicației.');}
export async function historyImportPreview(..._args:unknown[]):Promise<never>{return fail(503,'Importul pe clienți necesită serverul aplicației.');}
export async function historyImportCommit(..._args:unknown[]):Promise<never>{return fail(503,'Importul pe clienți necesită serverul aplicației.');}
