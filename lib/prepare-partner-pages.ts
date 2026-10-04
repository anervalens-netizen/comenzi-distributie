import type {PartnerBrowse,PartnerSummary} from './partner-map-types';
/** A preparation is complete only after one fenced, unique traversal. */
export async function preparePartnerPages(read:(path:string)=>Promise<PartnerBrowse>){
 for(let attempt=0;attempt<3;attempt++){
  const partners:PartnerSummary[]=[],ids=new Set<string>();let offset:number|null=0,total=0,revision:string|undefined;
  try{
   for(let page=0;page<50000&&offset!==null;page++){
    const result:PartnerBrowse=await read('partner/browse?limit=200&offset='+offset+(revision?'&revision='+encodeURIComponent(revision):''));
    if(!result.revision||revision&&result.revision!==revision)throw Object.assign(new Error('Revizia portofoliului nu este confirmată.'),{status:409});
    if(revision&&total!==result.total)throw Object.assign(new Error('Totalul portofoliului s-a schimbat.'),{status:409});
    revision=result.revision;total=result.total;
    for(const partner of result.partners){if(ids.has(partner.id))throw Object.assign(new Error('Portofoliul conține puncte repetate.'),{status:409});ids.add(partner.id);partners.push(partner);}
    if(result.nextOffset!==null&&result.nextOffset<=offset)throw Object.assign(new Error('Paginarea nu avansează.'),{status:409});
    offset=result.nextOffset;
   }
   if(offset!==null||ids.size!==total)throw Object.assign(new Error('Portofoliul nu este complet. Pregătește din nou.'),{status:409});
   return {partners,total};
  }catch(error){if((error as {status?:number}).status!==409||attempt===2)throw error;}
 }
 throw new Error('Portofoliul se modifică. Pregătește din nou.');
}
