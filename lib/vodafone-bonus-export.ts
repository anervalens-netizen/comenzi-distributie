import {utils,write} from 'xlsx';
import {vodafoneBonusReasonLabels,type VodafoneBonusReport} from './vodafone-bonus-types';

export function vodafoneBonusWorkbook(report: VodafoneBonusReport) {
  const book = utils.book_new();
  const sheet = (name: string, rows: (string|number|null)[][], widths: number[]) => {
    const page = utils.aoa_to_sheet(rows);
    page['!cols']=widths.map(wch=>({wch}));
    if (rows.length>1) page['!autofilter']={ref:utils.encode_range({s:{c:0,r:0},e:{c:rows[0].length-1,r:rows.length-1}})};
    utils.book_append_sheet(book,page,name);
  };
  sheet('Luni',[
    ['Lună','Date până la','Raport operator publicat la','Activări partenere','Activări confirmate','Punct neidentificat'],
    ...report.months.filter(row=>!report.selectedMonth || row.month===report.selectedMonth).map(row=>[
      row.month,row.sourceThrough,row.publishedOn,row.activations,row.confirmedActivations,row.unresolvedActivations,
    ]),
  ],[14,17,25,19,23,23]);
  sheet('Registru pe punct',[
    ['Lună','Franciză','CUI','Partener','TR · activări','Activări atribuite','Activări confirmate','Target Top Locații','Bonus Top Locații','Bonus SIM 0 calculat','Total calculat','Acordat în luna facturii','Documente cu tip neconfirmat','Stins confirmat','Rest confirmat','Stins în simularea SIM 0','Rest în simularea SIM 0','Acoperire'],
    ...report.points.map(row=>[row.month,row.pointCode,row.cui,row.partner,row.sites.map(item=>item.site+' '+item.activations).join(', '),
      row.activations,row.confirmedActivations,row.target,row.topBonus,row.sim0Bonus,row.totalBonus,
      row.partial?null:row.givenOnDocuments,row.partial?null:row.candidateOnDocuments,row.applied,row.remaining,row.simulatedApplied,row.simulatedRemaining,
      row.partial?'Punct comun dincolo de selecție':'Completă pentru selecție']),
  ],[14,16,18,39,30,20,22,21,21,21,17,25,29,19,18,26,28,30]);
  sheet('Documente',[
    ['Dată','Nr. document','Emitent','SiteId ERP','TR','Franciză','CUI','Partener','Bucăți','Clasificare'],
    ...report.documents.map(row=>[row.date,row.number,row.company,row.siteId,row.sites.join(', '),row.pointCode,row.cui,row.partner,row.quantity,vodafoneBonusReasonLabels[row.reason]]),
  ],[14,18,18,16,22,15,15,40,12,26]);
  sheet('Stingeri FIFO',[
    ['Dată','Nr. document','Emitent','SiteId ERP','Franciză','Luna dreptului','Tip bonus','Cantitate','Stare'],
    ...report.documents.flatMap(doc=>doc.allocations.map(row=>[
      doc.date,doc.number,doc.company,doc.siteId,doc.pointCode,row.month,row.kind,row.quantity,row.status==='confirmed'?'Confirmată':'Simulare',
    ])),
  ],[14,18,18,16,16,18,17,12,17]);
  sheet('De identificat',[
    ['Lună','TR','CUI','Partener','Motiv','Activări'],
    ...report.unresolved.map(row=>[row.month,row.site,row.cui,row.partner,vodafoneBonusReasonLabels[row.reason],row.count]),
  ],[14,18,18,40,28,15]);
  sheet('Metodă',[
    ['Regulă','Aplicare'],
    ['Perioadă','Luna de la care începe istoricul este iunie 2026. Soldul de deschidere din simulare este zero.'],
    ['Identitate','Prag o singură dată pe cod de franciză și lună. Contribuțiile rămân vizibile pe TR.'],
    ['SIM 0','3–4 activări dau 1 SIM 5, 5–9 dau 2, fiecare grup complet de 10 dă 5.'],
    ['Simulare','Documentele cu toate liniile eligibile la zero și cu tip fiscal lipsă rămân în simulare.'],
    ['Publicare','Stingerile confirmate necesită raport final și dovada tipului fiscal. Restul combinat cere și premiul Top Locații verificat.'],
    ['Acordare','Factură completă cu SIM 5 sau voucher eligibil. Stinge prima lună eligibilă. Facturile mixte, retururile neasociate și referințele neconfirmate apar la verificare.'],
    ['Excluderi','Conturile de tip generic, bonurile de consum și reglările de gestiune identificate sunt scoase din calcul.'],
  ],[22,125]);
  return write(book,{type:'base64',bookType:'xlsx',compression:true});
}
