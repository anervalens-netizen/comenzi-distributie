import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import {resolve} from 'node:path';
import {activationPublicationStamp} from './activation-publication-node';
import {combinePartnerReports} from './combined-activation-partners';
import {ActivationPartnerProjectionChanged,portfolioPoint,portfolioSelection,type CombinedPartnerRead,type PortfolioFields} from './activation-portfolio';
import {readActivations} from './activation-store-node';
import type {CombinedActivationPartners} from './activation-types';

type PageSet = { report:CombinedActivationPartners; pages:string[]; bytes:number };
const stored=new Map<string,PageSet>();
const byteLimit=32*1024*1024;
let storedBytes=0;
const pageSize=50;

function publicationStamp() {
  return {vodafone:activationPublicationStamp('vodafone'),digi:activationPublicationStamp('digi')};
}
function assertCurrent(source:ReturnType<typeof publicationStamp>) {
  const current=publicationStamp();
  if(current.vodafone!==source.vodafone||current.digi!==source.digi)
    throw new ActivationPartnerProjectionChanged('Activation publication changed');
}
function pageFrom(set:PageSet,page:number):CombinedActivationPartners {
  const p=set.report.partners;
  return {...set.report,partners:{...p,page,hasMore:(page+1)*pageSize<p.total,rows:JSON.parse(set.pages[page]||'[]')}};
}
export function readPartnerPage(input:CombinedPartnerRead,page:number):CombinedActivationPartners {
  const path=resolve(process.env.MOBIUP_DATA_DIR||'./work/server-data','mobiup.sqlite');
  const source=publicationStamp();
  const bothPublished=source.vodafone!==null&&source.digi!==null;
  const s=statSync(path,{bigint:true});
  const key=createHash('sha256').update(JSON.stringify([path,s.dev.toString(),s.ino.toString(),source,input])).digest('hex');
  const db=new DatabaseSync(path,{readOnly:true});
  try {
    db.exec('BEGIN');
    if(Number(db.prepare('SELECT revision FROM crm_directory_revision WHERE id=1').get()?.revision)!==input.crmRevision)
      throw new ActivationPartnerProjectionChanged('Customer directory changed');
    const hit=bothPublished&&stored.get(key);
    if(hit){
      const result=pageFrom(hit,page);
      assertCurrent(source);
      stored.delete(key);stored.set(key,hit);
      return result;
    }
    const selection=portfolioSelection(input.scope);
    const portfolio=(db.prepare(selection.sql).all(...selection.args) as unknown as PortfolioFields[]).map(portfolioPoint);
    // Release the CRM read snapshot before doing the provider aggregation.
    db.exec('COMMIT');
    const report=combinePartnerReports(input,portfolio,(month,sites,provider,query)=>{
      const result=readActivations(month,sites,provider,query);
      // Keep the normal missing-source response, but an unpinned provider cannot
      // contribute rows or certify availability even when its reader succeeds.
      if(source[provider]===null&&(result.available||result.partners))throw new Error('Activation publication unavailable');
      return result;
    });
    const all=report.partners.rows;
    const rows=all.slice(page*pageSize,(page+1)*pageSize);
    let entry:PageSet|undefined;
    if(bothPublished && Object.values(report.operators).every(op=>op.available)){
      const pages:string[]=[];
      let bytes=0;
      for(let i=0;i<all.length && bytes<=byteLimit;i+=pageSize){
        const encoded=JSON.stringify(all.slice(i,i+pageSize));
        pages.push(encoded);bytes+=2*encoded.length;
      }
      if(bytes<=byteLimit)entry={report:{...report,partners:{...report.partners,rows:[]}},pages,bytes};
    }
    assertCurrent(source);
    if(entry){
      while(stored.size>=8||storedBytes+entry.bytes>byteLimit){
        const oldest=stored.keys().next().value!;
        storedBytes-=stored.get(oldest)!.bytes;stored.delete(oldest);
      }
      stored.set(key,entry);storedBytes+=entry.bytes;
    }
    return {...report,partners:{...report.partners,rows,page,hasMore:(page+1)*pageSize<all.length}};
  }finally{db.close();}
}
