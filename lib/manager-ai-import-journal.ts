import type {AiSource} from './manager-ai-query';

type JournalJob = {
  id:string; kind:string; state:string; source:{date_start:string;date_end:string};
  preview?:Record<string,unknown>|null;
};
type JournalPage = {jobs:JournalJob[];next_cursor?:string|null};
const kind='sim_activations_digi';
const count=(value:unknown) => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : null;

// One row per attempt. Two attempts may cover the same activation, even with different hashes.
export function digiImportReport(page:JournalPage,month:string):AiSource {
  const jobs=page.jobs.filter(job=>job.kind===kind && job.source.date_end.slice(0,7)===month);
  return {
    rows:jobs.map(job=>{
      const p=job.preview??{};
      return {operation:job.id,state:job.state,declaredFrom:job.source.date_start,declaredTo:job.source.date_end,
        sourceRows:count(p.rows),distinctSIMs:count(p.distinctSIMs),rowsWithIssues:count(p.rowsWithIssues),
        duplicateSourceRows:count(p.duplicateSourceRows),matchingTR:count(p.matchingTR),
        otherInternalChannel:count(p.otherInternalChannel),withoutExactInternalMatch:count(p.withoutExactInternalMatch)};
    }),
    coverage:[{month,source:'Jurnal importuri · Activări Digi',available:jobs.length>0,
      note:(page.next_cursor?'Sunt consultate ultimele 50 de operații. ':'')+
        'Fiecare rând reprezintă un import, în luna sfârșitului perioadei declarate. Câmpurile absente nu au fost măsurate. Jurnalul nu identifică SIM-urile individuale.'}],
  };
}

export async function fetchDigiImportJournal(request:Request,user:import('./types').User):Promise<JournalPage> {
  // Reuse the authorized application read; no internal key or extra write path.
  const {importsJobs}=await import('./import-engine-runtime');
  const url=new URL('/api/imports/jobs',request.url);
  url.search=new URLSearchParams({kind,limit:'50'}).toString();
  const response=await importsJobs(new Request(url),user);
  if(!response.ok)throw new Error('Jurnalul de import nu este disponibil.');
  return await response.json() as JournalPage;
}
