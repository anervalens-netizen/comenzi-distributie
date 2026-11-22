import type { ManagerAiReport } from './manager-ai';

export const reportCatalogId = 'urn:comenzi:manager-report:1';
export type ReportCardData = {
  title: string;
  columns: string[];
  rows: string[][];
  exported: number;
  total: number;
  sources: string[];
};

const labels:Record<string,string> = {
  digiImports:'Verificare importuri Digi', operation:'ID import', declaredFrom:'De la', declaredTo:'Până la',
  rowsWithIssues:'Rânduri cu observații', state:'Stare', sourceRows:'Rânduri sursă', distinctSIMs:'SIM-uri distincte', duplicateSourceRows:'Rânduri repetate',
  matchingTR:'Potriviri TR', otherInternalChannel:'Alt canal intern', withoutExactInternalMatch:'Fără potrivire internă',
};
const clipped = (value:string,limit:number) => value.length <= limit ? value : value.slice(0,limit - 1) + '…';

export function reportCardData(report: ManagerAiReport): ReportCardData {
  // The export retains all columns and rows supplied by the authorized read_report call.
  return {
    title: labels[report.dataset] ?? 'Raport · ' + report.dataset,
    columns: report.columns.map(column => labels[column] ?? column),
    rows: report.rows.slice(0,10).map(row => row.map(value => value === null ? '—' : clipped(String(value),120))),
    exported: report.rows.length,
    total: report.totalRows,
    sources: [...new Set(report.coverage.map(item => clipped([
      item.source, item.month, item.through && 'până la ' + item.through,
      item.available ? '' : 'indisponibil', item.note,
    ].filter(Boolean).join(' · '),240)))].slice(0,8),
  };
}

export function reportCardMessages(id:string, data:ReportCardData) {
  return [
    {version:'1.0', createSurface:{surfaceId:id, catalogId:reportCatalogId}},
    {version:'1.0', updateComponents:{surfaceId:id, components:[{id:'root',component:'ReportTable',...data}]}},
  ];
}
