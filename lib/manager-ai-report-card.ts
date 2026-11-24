import {cardRecord,cardText,cardTextList} from './manager-ai-card-bounds';
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

/** Accept only this application's bounded literal report envelope before A2UI. */
export function boundedReportCardMessages(wire:unknown,id:string):unknown[]|undefined {
  if(!cardText(id,128)||!id.length||!Array.isArray(wire)||wire.length!==2)return undefined;
  const [create,update]=wire;
  if(!cardRecord(create,['version','createSurface'])||create.version!=='1.0'||
    !cardRecord(create.createSurface,['surfaceId','catalogId'])||create.createSurface.surfaceId!==id||create.createSurface.catalogId!==reportCatalogId||
    !cardRecord(update,['version','updateComponents'])||update.version!=='1.0'||
    !cardRecord(update.updateComponents,['surfaceId','components'])||update.updateComponents.surfaceId!==id||
    !Array.isArray(update.updateComponents.components)||update.updateComponents.components.length!==1)return undefined;
  const data=update.updateComponents.components[0];
  if(!cardRecord(data,['id','component','title','columns','rows','exported','total','sources'])||
    data.id!=='root'||data.component!=='ReportTable'||!cardText(data.title,160)||
    !cardTextList(data.columns,64,96)||!data.columns.length||
    !Array.isArray(data.rows)||data.rows.length>10||!cardTextList(data.sources,8,240)||
    typeof data.exported!=='number'||!Number.isSafeInteger(data.exported)||data.exported<data.rows.length||
    typeof data.total!=='number'||!Number.isSafeInteger(data.total)||data.total<data.exported)return undefined;
  for(const row of data.rows)if(!cardTextList(row,64,120)||row.length!==data.columns.length)return undefined;
  return wire;
}
