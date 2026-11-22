"""Version selection and explicit operator evidence; no implicit snapshot deletions."""
import collections
import datetime as dt
import gzip
import json
import re
import time

ACTIVATION_FIELDS = ('Activat', 'DataActivare', 'HandSetType', 'JudetActivare', 'ItemCodeA', 'ItemNameA')
COMMERCIAL_FIELDS = ('Firma', 'DataVDF', 'TR', 'SiteCode', 'ItemCode', 'ItemName', 'Cantitate', 'Pret', 'Valoare', 'PretFD', 'CIF', 'CodPunctDeLucru', 'PunctDeLucru', 'Denumire Client', 'Oras', 'Judet', 'Nr', 'TRVechi', 'ItemType', 'IMEI', 'Qtty', 'DocumentDetailId', 'DocumentId', 'SiteId')
UNKNOWN = {'', '-', 'NEALOCAT', 'UNALLOCATED', 'N/A', 'UNKNOWN', 'UNASSIGNED', '<UNASSIGNED>'}
# A dash is an explicit noncommissionable handset category, but remains a
# missing-value marker for identifiers, dates and counties.
FIELD_UNKNOWN = {'handset': UNKNOWN - {'-'}, 'HandSetType': UNKNOWN - {'-'}}
# Derived reconciliation semantics are independent of the immutable ledger schema.
FACTS_VERSION = '3'


def canonical_digi_company(company, sales_companies):
    """Map exact case-only company variants to one existing Digi sales company.

    An operator's displayed distributor label is evidence, not a new
    legal-entity identity. Never guess a match from shared spelling fragments,
    punctuations, or other providers. Conflicting internal canonical labels
    fail closed rather than assign a SIM to an arbitrary company.
    """
    if not isinstance(company, str) or not company.strip():
        raise ValueError('Invalid Digi source company')
    matches = sorted({str(name) for name in sales_companies
                      if isinstance(name, str) and name.casefold() == company.casefold()})
    if len(matches) > 1:
        raise ValueError('Ambiguous case-insensitive Digi sales company identity')
    return matches[0] if matches else company


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
    superseded_date_issues = {'missing_activation_date', 'invalid_DataActivare'}
    if any('importId' in ref for ref in refs['activation_date']):
        superseded_date_issues.add('invalid_DataDigi')
    for r in rows:
        if selected['serial']:
            r['serial']=selected['serial'];r['activation_date']=selected['activation_date'] or None
            # A valid selected observation supersedes stale/missing activation fields only.
            if selected['activation_date']:
                r['issues']=json.dumps([i for i in json.loads(r['issues']) if i not in superseded_date_issues])
    return selected,refs,conflicts


MAX_OPERATOR_JSON_BYTES = 512 << 20
MAX_OPERATOR_RECORD_CHARS = 16 << 20
OPERATOR_PARSE_SECONDS = 15 * 60


def json_records(path):
    """Read an array of operator records with the same limits in preview and commit."""
    decoder = json.JSONDecoder()
    deadline = time.monotonic() + OPERATOR_PARSE_SECONDS
    total = count = position = 0
    buffer = ''
    eof = False
    with gzip.open(path, 'rt', encoding='utf-8', newline='') as stream:
        def check_time():
            if time.monotonic() >= deadline:
                raise ValueError('Operator extraction time limit exceeded')

        def refill(size=65536):
            nonlocal buffer, position, total, eof
            check_time()
            chunk = stream.read(size)
            total += len(chunk.encode('utf-8'))
            if total > MAX_OPERATOR_JSON_BYTES:
                raise ValueError('Operator extraction size limit exceeded')
            buffer = buffer[position:] + chunk
            position = 0
            eof = not chunk

        def next_token():
            nonlocal position
            while True:
                check_time()
                while position < len(buffer) and buffer[position].isspace():
                    position += 1
                if position < len(buffer):
                    return buffer[position]
                if eof:
                    return ''
                refill()

        if next_token() != '[':
            raise ValueError('Invalid operator array')
        position += 1
        if next_token() != ']':
            while True:
                if next_token() != '{':
                    raise ValueError('Invalid operator record')
                while True:
                    try:
                        value, end = decoder.raw_decode(buffer, position)
                        if end - position > MAX_OPERATOR_RECORD_CHARS:
                            raise ValueError('Operator record size limit exceeded')
                        position = end
                        break
                    except json.JSONDecodeError:
                        size = len(buffer) - position
                        if eof or size >= MAX_OPERATOR_RECORD_CHARS:
                            raise ValueError('Invalid operator record') from None
                        refill(min(max(65536, size), 1 << 20, MAX_OPERATOR_RECORD_CHARS - size))
                count += 1
                if count > 1_000_000:
                    raise ValueError('Operator row limit exceeded')
                yield count, value
                separator = next_token()
                if separator == ']':
                    break
                if separator != ',':
                    raise ValueError('Invalid operator separator')
                position += 1
        position += 1
        if next_token():
            raise ValueError('Trailing operator data')


def operator_records(path, workbook_reader, provider='vodafone'):
    if path.suffixes[-2:]==['.json','.gz']:
        yield from json_records(path)
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
