"""Version selection and explicit operator evidence; no implicit snapshot deletions."""
import collections
import datetime as dt
import gzip
import json
import re

ACTIVATION_FIELDS = ('Activat', 'DataActivare', 'HandSetType', 'JudetActivare', 'ItemCodeA', 'ItemNameA')
COMMERCIAL_FIELDS = ('Firma', 'DataVDF', 'TR', 'SiteCode', 'ItemCode', 'ItemName', 'Cantitate', 'Pret', 'Valoare', 'PretFD', 'CIF', 'CodPunctDeLucru', 'PunctDeLucru', 'Denumire Client', 'Oras', 'Judet', 'Nr', 'TRVechi', 'ItemType', 'IMEI', 'Qtty', 'DocumentDetailId', 'DocumentId', 'SiteId')
UNKNOWN = {'', '-', 'NEALOCAT', 'UNALLOCATED', 'N/A', 'UNKNOWN', 'UNASSIGNED', '<UNASSIGNED>'}
# A dash is an explicit noncommissionable handset category, but remains a
# missing-value marker for identifiers, dates and counties.
FIELD_UNKNOWN = {'handset': UNKNOWN - {'-'}, 'HandSetType': UNKNOWN - {'-'}}
# Derived reconciliation semantics are independent of the immutable ledger schema.
FACTS_VERSION = '2'


def migrate(c, version):
    if version == '2':
        c.execute('BEGIN IMMEDIATE')
        try:
            for name, default in [('source_kind','internal'),('source_at',''),('period_start',''),('period_end',''),('company','')]:
                c.execute(f"ALTER TABLE activation_imports ADD COLUMN {name} TEXT NOT NULL DEFAULT '{default}'")
            c.execute("UPDATE activation_meta SET value='3' WHERE key='schema_version'")
            c.commit()
        except BaseException:
            c.rollback()
            raise


def select_field(observations, field):
    """Only field-specific missing values are skipped; explicit categories supersede history."""
    missing=FIELD_UNKNOWN.get(field, UNKNOWN)
    values=[o for o in observations if str(o.get(field) or '').strip().upper() not in missing]
    if not values:
        return '', [], False
    rank=max((o['priority'],o['source_at']) for o in values)
    best=[o for o in values if (o['priority'],o['source_at'])==rank]
    distinct={o[field] for o in best}
    return (next(iter(distinct)) if len(distinct)==1 else ''), [o['ref'] for o in best], len(distinct)>1


def effective(rows):
    """One commercial movement per key. All immutable versions remain in the ledger."""
    groups=collections.defaultdict(list)
    for r in rows:groups[r['movement_key']].append(r)
    result=[];conflicts=set()
    for key,versions in groups.items():
        rank=max(v['source_at'] for v in versions)
        best=[v for v in versions if v['source_at']==rank]
        def commercial(v):
            raw=json.loads(v['raw_json'])
            return tuple(raw.get(k,'') for k in COMMERCIAL_FIELDS) if v['provider']!='digi' else tuple(raw.get(k,'') for k in ('Canal','Magazin','Data','Cod','Cantitate','IMEI','Pret','Denumire Client'))
        if len({commercial(v) for v in best})>1:
            conflicts.add(key)
        chosen=min(best,key=lambda v:v['id']).copy()
        chosen['version_ids']=[v['id'] for v in versions]
        # Activation observations are separate from commercial version selection.
        chosen['observations']=[dict(serial=v['serial'],activation_date=v['activation_date'] or '',handset=json.loads(v['raw_json']).get('HandSetType',''),county=json.loads(v['raw_json']).get('JudetActivare',''),priority=0,source_at=v['source_at'],ref={'movementId':v['id']}) for v in versions]
        result.append(chosen)
    return result,conflicts


def apply_observations(rows, official):
    internal=[o for r in rows for o in r['observations'] if o['serial']]
    observations=internal+official
    selected={};refs={};conflicts=[]
    for field in ('serial','activation_date','county','handset'):
        selected[field],refs[field],conflict=select_field(observations,field)
        if conflict:conflicts.append(field+'_conflict')
    for r in rows:
        if selected['serial']:
            r['serial']=selected['serial'];r['activation_date']=selected['activation_date'] or None
            # A valid selected observation supersedes stale/missing activation fields only.
            if selected['activation_date']:
                r['issues']=json.dumps([i for i in json.loads(r['issues']) if i not in ('missing_activation_date','invalid_DataActivare')])
    return selected,refs,conflicts


def operator_records(path, workbook_reader, provider='vodafone'):
    if path.suffixes[-2:]==['.json','.gz']:
        with gzip.open(path,'rt',encoding='utf-8') as f:
            records=json.load(f)
        if not isinstance(records,list) or len(records)>1_000_000:raise ValueError('Invalid operator extraction')
        for i,r in enumerate(records,1):yield i,r
    elif provider=='digi':
        yield from workbook_reader(path,sheet_name='activari',required_headers=['Distribuitor','Seria SIM (iccid)','Data activare'],header_row=1)
    else:
        yield from workbook_reader(path,sheet_name='Detailed SIM',required_headers=['SerieText','DATE_OF_ACTIVATION','COUNTY_OF_ACTIVATION','Paid SIM Category'],header_row=1)


def operator_values(raw, provider='vodafone', company=''):
    if provider=='digi':
        serial=raw.get('Seria SIM (iccid)','')
        if not isinstance(serial,str) or not re.fullmatch(r'[0-9]{19}',serial):raise ValueError('Invalid Digi operator serial text')
        distributor=raw.get('Distribuitor','')
        if not company or not isinstance(distributor,str) or distributor.casefold()!=company.casefold():raise ValueError('Digi distributor does not match explicit company')
        value=raw.get('Data activare','')
        try:activation_date=dt.date.fromisoformat(value).isoformat()
        except (ValueError,TypeError):raise ValueError('Invalid Digi activation date') from None
        return serial,activation_date,'',''
    serial=raw.get('SerieText','')
    # Excel's explicit text marker is a source encoding, not a digit to trim. Raw provenance is retained.
    if isinstance(serial,str) and re.fullmatch(r"'[0-9]{18}",serial):serial=serial[1:]
    if not isinstance(serial,str) or not re.fullmatch(r'[0-9]{18}',serial):raise ValueError('Invalid operator serial text')
    if raw.get('serial',serial)!=serial:raise ValueError('Conflicting operator serial')
    value=raw.get('DATE_OF_ACTIVATION','')
    try:activation_date=dt.date.fromisoformat(value).isoformat()
    except (ValueError,TypeError):raise ValueError('Invalid operator activation date') from None
    return serial,activation_date,str(raw.get('COUNTY_OF_ACTIVATION','')),str(raw.get('Paid SIM Category',''))
