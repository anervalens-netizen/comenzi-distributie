import {fail} from './server';
export async function importsCatalog(..._args:unknown[]):Promise<never>{return fail(503,'Importurile necesită serverul aplicației.');}
export async function importsJobs(..._args:unknown[]):Promise<never>{return fail(503,'Importurile necesită serverul aplicației.');}
export async function importsJob(..._args:unknown[]):Promise<never>{return fail(503,'Importurile necesită serverul aplicației.');}
