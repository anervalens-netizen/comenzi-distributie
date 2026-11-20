import { AppError, fail } from './server';
import { bucharestMonthKey } from './bucharest-month';
import { managerAiFields, type ManagerAiCell, type ManagerAiCoverage, type ManagerAiDataset, type ManagerAiReport } from './manager-ai';

const MAX_MONTHS = 12;
const MAX_ROWS = 500;
export type AiSourceRow = Record<string, ManagerAiCell>;
export type AiSource = { rows: AiSourceRow[]; coverage: ManagerAiCoverage[] };
type AiFilter = { field: string; op: 'eq'|'contains'|'gt'|'gte'|'lt'|'lte'; value: string|number };
export type AiReportQuery = {
  dataset: ManagerAiDataset;
  fromMonth: string;
  toMonth: string;
  site: string;
  groupBy: string[];
  filters: AiFilter[];
  orderBy: string;
  descending: boolean;
  limit: number;
};

const schemaMonth = {type:'string', description:'Lună AAAA-LL. Lasă gol pentru luna curentă în Europe/Bucharest.'};
export const managerAiReportTool = {
  type: 'function',
  name: 'read_report',
  description: 'Citește un raport Vodafone autorizat, aplică filtre și grupează pe coloane. Catalogul câmpurilor este în instrucțiuni.',
  strict: true,
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      dataset: {type:'string', enum:Object.keys(managerAiFields)},
      fromMonth: schemaMonth,
      toMonth: schemaMonth,
      site: {type:'string', description:'Cod SiteCode exact pentru sales și activations; lasă gol pentru toate gestiunile autorizate.'},
      groupBy: {type:'array', items:{type:'string'}, description:'Dimensiuni pentru agregare. [] păstrează granularitatea sursei.'},
      filters: {type:'array', items:{
        type:'object', additionalProperties:false,
        properties:{field:{type:'string'},op:{type:'string',enum:['eq','contains','gt','gte','lt','lte']},value:{type:['number','string']}},
        required:['field','op','value'],
      }},
      orderBy: {type:'string'},
      descending: {type:'boolean'},
      limit: {type:'integer', description:'Numărul maxim de rânduri de export, între 1 și 500.'},
    },
    required: ['dataset','fromMonth','toMonth','site','groupBy','filters','orderBy','descending','limit'],
  },
} as const;

export function managerAiMonths(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0,4)), month = Number(from.slice(5,7));
  while (year <= Number(to.slice(0,4)) && months.length <= MAX_MONTHS) {
    const value = `${year}-${String(month).padStart(2,'0')}`;
    if (value > to) break;
    months.push(value);
    if (++month > 12) { month = 1; year++; }
  }
  return months;
}

export function parseManagerAiQuery(raw: string, current = bucharestMonthKey(new Date())): AiReportQuery {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { fail(400,'Argumente de raport invalide.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || raw.length > 12_000) fail(400,'Argumente de raport invalide.');
  const q = value as Record<string,unknown>;
  if (typeof q.dataset !== 'string' || !Object.hasOwn(managerAiFields,q.dataset)) fail(400,'Sursă de raport necunoscută.');
  const dataset = q.dataset as ManagerAiDataset;
  const dimensions: readonly string[] = managerAiFields[dataset].dimensions;
  const fields = [...dimensions,...managerAiFields[dataset].measures];
  const fromMonth = q.fromMonth || q.toMonth || current, toMonth = q.toMonth || fromMonth;
  const validMonth = (x: unknown): x is string => typeof x === 'string' && /^20\d{2}-(0[1-9]|1[0-2])$/.test(x);
  if (!validMonth(fromMonth) || !validMonth(toMonth) || fromMonth > toMonth || toMonth > current ||
      managerAiMonths(fromMonth,toMonth).length > MAX_MONTHS) fail(400,'Alege până la 12 luni, inclusiv luna curentă.');
  const site = q.site ?? '';
  if (typeof site !== 'string' || site.length > 80 || (site && dataset !== 'sales' && dataset !== 'activations')) fail(400,'Filtrul SiteCode este invalid pentru această sursă.');
  const groupBy = q.groupBy ?? [];
  if (!Array.isArray(groupBy) || groupBy.length > 6 || groupBy.some(field=>!dimensions.includes(field as string)) || new Set(groupBy).size !== groupBy.length) fail(400,'Dimensiuni de grupare invalide.');
  const filters = q.filters ?? [];
  if (!Array.isArray(filters) || filters.length > 12 || !filters.every((f:unknown)=>{
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    const {field,op,value} = f as AiFilter;
    return fields.includes(field) && ['eq','contains','gt','gte','lt','lte'].includes(op) &&
      (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && value.length <= 200) &&
      (op === 'eq' || (op === 'contains' ? typeof value === 'string' && dimensions.includes(field) : typeof value === 'number' && !dimensions.includes(field)));
  })) fail(400,'Filtru de raport invalid.');
  const orderBy = q.orderBy || managerAiFields[dataset].measures[0], limit = q.limit ?? 40;
  if (typeof orderBy !== 'string' || !(groupBy.length ? [...groupBy,...managerAiFields[dataset].measures] : fields).includes(orderBy)) fail(400,'Sortare de raport invalidă.');
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) fail(400,'Limita raportului este invalidă.');
  if (q.descending !== undefined && typeof q.descending !== 'boolean') fail(400,'Direcția de sortare este invalidă.');
  return {dataset,fromMonth,toMonth,site:site.trim(),groupBy,filters,orderBy,descending:q.descending!==false,limit};
}

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('ro');
export function managerAiFilterMatches(row: AiSourceRow, {field,op,value}: AiFilter) {
  const entry = row[field];
  if (typeof entry === 'string' && typeof value === 'string') {
    return op === 'eq' ? normalize(entry) === normalize(value) : op === 'contains' && normalize(entry).includes(normalize(value));
  }
  if (typeof entry !== 'number' || typeof value !== 'number') return false;
  if (op === 'gt') return entry > value;
  if (op === 'gte') return entry >= value;
  if (op === 'lt') return entry < value;
  if (op === 'lte') return entry <= value;
  return op === 'eq' && entry === value;
}

export function makeManagerAiReport(query: AiReportQuery, source: AiSource, id: string): ManagerAiReport {
  const dimensions: readonly string[] = managerAiFields[query.dataset].dimensions;
  const measures: readonly string[] = managerAiFields[query.dataset].measures;
  let rows = source.rows.filter(row => query.filters.filter(f=> !query.groupBy.length || dimensions.includes(f.field)).every(filter => managerAiFilterMatches(row,filter)));
  if (query.groupBy.length) {
    const names = query.groupBy;
    const groups = new Map<string,AiSourceRow>();
    for (const row of rows) {
      const values = names.map(name => row[name] ?? null);
      const key = JSON.stringify(values);
      let group = groups.get(key);
      if (!group) {
        group = Object.fromEntries(names.map((name,i)=>[name,values[i]]));
        groups.set(key,group);
      }
      for (const metric of measures) {
        const value = row[metric];
        // A missing component makes the group amount uncertain.
        const prior = group[metric];
        group[metric] = typeof value !== 'number' || prior === null ? null : (typeof prior === 'number' ? prior : 0) + value;
      }
    }
    const aggregateFilters = query.filters.filter(f=> !dimensions.includes(f.field));
    rows = [...groups.values()].filter(row=>aggregateFilters.every(filter=>managerAiFilterMatches(row,filter)));
  }
  const columns = [...(query.groupBy.length ? query.groupBy : dimensions),...measures];
  rows.sort((a,b) => {
    const left = a[query.orderBy] ?? null, right = b[query.orderBy] ?? null;
    if (left === null || right === null) return Number(left === null)-Number(right === null);
    const diff = typeof left === 'number' && typeof right === 'number' ? left-right : String(left).localeCompare(String(right),'ro');
    return query.descending ? -diff : diff;
  });
  return {id,dataset:query.dataset,dimensions:[...(query.groupBy.length?query.groupBy:dimensions)],columns,
    totalRows:rows.length,rows:rows.slice(0,query.limit).map(row=>columns.map(col=>{
      const value=row[col];
      return typeof value==='string'?value.slice(0,250):typeof value==='number'&&Number.isFinite(value)?Number(value.toFixed(6)):null;
    })),coverage:source.coverage};
}

export function managerAiToolError(error: unknown) {
  if (error instanceof AppError && error.status < 500) return error.message;
  return 'Sursa nu poate fi citită momentan. Semnalează lipsa în răspuns.';
}
