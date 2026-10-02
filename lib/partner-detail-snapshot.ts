import type {DatabaseSync} from 'node:sqlite';
import {normalizedCui} from './partner-company-identity';
import type {CompanyLinks} from './partner-company-links';

/** Batch only: normalized rows, indexed for one company/point. No raw reference
 * parsing or national allocation enumeration belongs in the HTTP detail path. */
export function buildDetailLinks(source:DatabaseSync,out:DatabaseSync,reference:string,index:CompanyLinks){
  out.exec(`CREATE TABLE company_identity_links(company_id TEXT NOT NULL,identity_id INTEGER NOT NULL,PRIMARY KEY(company_id,identity_id));
    CREATE TABLE company_code_aliases(company_id TEXT NOT NULL,code TEXT NOT NULL,PRIMARY KEY(company_id,code));
    CREATE TABLE company_detail_identity(company_id TEXT PRIMARY KEY,known INTEGER NOT NULL,complete INTEGER NOT NULL,unresolved INTEGER NOT NULL);
    CREATE TABLE point_identity_links(partner_id TEXT NOT NULL,identity_id INTEGER NOT NULL,PRIMARY KEY(partner_id,identity_id));
    CREATE TABLE point_unresolved_codes(code TEXT NOT NULL,identity_id INTEGER NOT NULL,PRIMARY KEY(code,identity_id));
    CREATE TABLE point_unresolved_candidates(partner_id TEXT NOT NULL,identity_id INTEGER NOT NULL,PRIMARY KEY(partner_id,identity_id));`);
  const link=out.prepare('INSERT INTO company_identity_links VALUES(?,?)'),code=out.prepare('INSERT INTO company_code_aliases VALUES(?,?)'),company=out.prepare('INSERT INTO company_detail_identity VALUES(?,?,?,?)');
  for(const [key,ids] of index.identityIdsByCompany)for(const row of ids)link.run(key,row.identity_id);
  for(const [key,codes] of index.codesByCompany)for(const alias of codes)code.run(key,alias);
  for(const key of new Set([...index.known,...index.incomplete]))company.run(key,Number(index.known.has(key)),Number(!index.incomplete.has(key)),index.unresolvedCounts.get(key)||0);
  const point=out.prepare('INSERT OR IGNORE INTO point_identity_links VALUES(?,?)'),unresolvedCode=out.prepare('INSERT OR IGNORE INTO point_unresolved_codes VALUES(?,?)'),candidate=out.prepare('INSERT OR IGNORE INTO point_unresolved_candidates VALUES(?,?)');
  for(const row of source.prepare('SELECT a.*,i.client_code FROM history_allocations a JOIN history_identities i ON i.id=a.identity_id WHERE a.reference_id=?').iterate(reference)){
    const ids=JSON.parse(String(row.partner_ids_json)) as string[],direct=['direct_code','single_partner'].includes(String(row.status));
    if(direct)for(const id of ids)point.run(id,row.identity_id);
    if(row.status==='reconcile'||(direct&&!ids.length)){
      unresolvedCode.run(normalizedCui(String(row.client_code||'')),row.identity_id);
      for(const id of JSON.parse(String(row.candidates_json)) as string[])candidate.run(id,row.identity_id);
    }
  }
}
export function readDetailLinks(s:DatabaseSync,company:string,partner:string){
  const record=s.prepare('SELECT known,complete,unresolved FROM company_detail_identity WHERE company_id=?').get(company);
  const companyRows=s.prepare('SELECT identity_id FROM company_identity_links WHERE company_id=?').all(company) as {identity_id:number}[];
  const codes=new Set(s.prepare('SELECT code FROM company_code_aliases WHERE company_id=?').all(company).map(r=>String(r.code)));
  const companyLinks:CompanyLinks={links:{},unresolved:[],known:new Set(record?.known?[company]:[]),incomplete:new Set(record&&!record.complete?[company]:[]),identityIdsByCompany:new Map([[company,companyRows]]),codesByCompany:new Map([[company,codes]]),unresolvedCounts:new Map([[company,Number(record?.unresolved||0)]])};
  const pointRows=s.prepare('SELECT identity_id FROM point_identity_links WHERE partner_id=?').all(partner) as {identity_id:number}[];
  const pointUnresolved=Number(s.prepare(`SELECT COUNT(*) n FROM (
    SELECT identity_id FROM point_unresolved_codes WHERE code IN (SELECT code FROM company_code_aliases WHERE company_id=?)
    UNION SELECT identity_id FROM point_unresolved_candidates WHERE partner_id=?)`).get(company,partner)?.n||0);
  return {companyLinks,pointRows,pointUnresolved};
}
