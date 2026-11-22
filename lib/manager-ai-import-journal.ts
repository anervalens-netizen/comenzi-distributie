import type {AiSource} from './manager-ai-query';
import {fail} from './server';
import type {User} from './types';

type JournalJob = {
  id:string; kind:string; state:string; source:{date_start:string;date_end:string};
  preview?:Record<string,unknown>|null;
};
type JournalPage = {jobs:JournalJob[];next_cursor?:string|null};
const kind='sim_activations_digi';
const pageSize=50;
const maxPages=20;
const count=(value:unknown) => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : null;

export function digiImportReport(journal:JournalJob[],month:string):AiSource {
  const jobs=journal.filter(job=>job.kind===kind && job.source.date_end.slice(0,7)===month);
  return {
    rows:jobs.map(job=>{
      const p=job.preview??{};
      return {operation:job.id,state:job.state,declaredFrom:job.source.date_start,declaredTo:job.source.date_end,
        sourceRows:count(p.rows),distinctSIMs:count(p.distinctSIMs),rowsWithIssues:count(p.rowsWithIssues),
        duplicateSourceRows:count(p.duplicateSourceRows),matchingTR:count(p.matchingTR),
        otherInternalChannel:count(p.otherInternalChannel),withoutExactInternalMatch:count(p.withoutExactInternalMatch)};
    }),
    coverage:[{month,source:'Jurnal importuri · Activări Digi',available:jobs.length>0,
      note:'Fiecare rând reprezintă un import, în luna sfârșitului perioadei declarate. Câmpurile absente nu au valori în jurnal. Jurnalul nu identifică SIM-urile individuale.'}],
  };
}

export async function fetchDigiImportJournal(request:Request,user:User):Promise<JournalJob[]> {
  const {importsJobs}=await import('./import-engine-runtime');
  const url=new URL('/api/imports/jobs',request.url);
  url.search=new URLSearchParams({kind,limit:String(pageSize)}).toString();
  // Cursors follow job creation dates. A later upload can declare an earlier reporting period.
  const jobs:JournalJob[]=[];
  const cursors=new Set<string>();
  for(let page=0;page<maxPages;page++){
    const response=await importsJobs(new Request(url),user);
    if(!response.ok)throw new Error('Jurnalul de import nu este disponibil.');
    const data=await response.json() as JournalPage;
    for(const job of data.jobs){
      if(job.state==='completed' && count(job.preview?.rows)===null)
        throw new Error('Lipsesc valorile din previzualizarea importului finalizat.');
      jobs.push(job);
    }
    if(!data.next_cursor)return jobs;
    if(cursors.has(data.next_cursor))throw new Error('Cursor repetat în jurnalul de import.');
    cursors.add(data.next_cursor);
    url.searchParams.set('before',data.next_cursor);
  }
  return fail(422,'Jurnalul Digi depășește limita de citire. Acoperirea perioadei nu poate fi confirmată.');
}
