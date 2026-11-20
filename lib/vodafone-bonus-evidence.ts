import {firstVodafoneBonusMonth} from './vodafone-bonus-types';

export const vodafoneBonusEvidenceSetting = 'vodafone-bonus-evidence-v1';
export type VodafoneBonusEvidence = {
  /** A publication date for an archived final report documented by the operator. */
  published: {month: string; date: string; evidence: string}[];
  /** The exact source document, with an authoritative type available outside the export. */
  documents: {
    source: 'activation' | 'sales';
    company: string;
    date: string;
    site: string;
    number: string;
    kind: 'commercial' | 'excluded';
    evidence: string;
  }[];
};
export const bonusMonth = (value: string) => /^20\d\d-(?:0[1-9]|1[0-2])$/.test(value);
export function bonusDate(value: string) {
  if (!/^20\d\d-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(value)) return false;
  return new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
export function bonusEvidenceIdentity(source: 'activation' | 'sales', company: string, date: string, site: string, number: string) {
  return JSON.stringify([source,company.trim().toUpperCase(),date,site.trim().toUpperCase(),number.trim()]);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= length && value.trim() === value;
}
export function parseVodafoneBonusEvidence(raw: string | undefined): VodafoneBonusEvidence {
  if (!raw) return {published:[],documents:[]};
  const input: unknown = JSON.parse(raw);
  if (!record(input) || !Array.isArray(input.published) || !Array.isArray(input.documents) || input.published.length > 1200 || input.documents.length > 40_000) {
    throw new Error('Invalid Vodafone bonus source evidence');
  }
  const identifiers = new Set<string>();
  const published = input.published.map((row: unknown) => {
    if (!record(row) || !text(row.month,7) || !bonusMonth(row.month) || row.month < firstVodafoneBonusMonth ||
        !text(row.date,10) || !bonusDate(row.date) || row.date.slice(0,7) <= row.month || !text(row.evidence,500) || identifiers.has(row.month)) {
      throw new Error('Invalid Vodafone final report evidence');
    }
    identifiers.add(row.month);
    return {month:row.month,date:row.date,evidence:row.evidence};
  });
  const documents = input.documents.map((row: unknown): VodafoneBonusEvidence['documents'][number] => {
    if (!record(row) || (row.source !== 'activation' && row.source !== 'sales') ||
        !text(row.company,100) || !text(row.date,10) || !bonusDate(row.date) || !text(row.site,100) ||
        !text(row.number,100) || (row.kind !== 'commercial' && row.kind !== 'excluded') || !text(row.evidence,500)) {
      throw new Error('Invalid Vodafone document evidence');
    }
    const id = bonusEvidenceIdentity(row.source,row.company,row.date,row.site,row.number);
    if (identifiers.has(id)) throw new Error('Ambiguous Vodafone document evidence');
    identifiers.add(id);
    return {source:row.source,company:row.company,date:row.date,site:row.site,number:row.number,kind:row.kind,evidence:row.evidence};
  });
  return {published,documents};
}
