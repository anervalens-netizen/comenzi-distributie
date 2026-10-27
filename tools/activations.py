#!/usr/bin/env python3
"""Private, explicit-path activation ledger. No application/production defaults."""
import argparse
import activation_versions as versions
import fcntl
import collections
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import zipfile
import xml.etree.ElementTree as ET

HEADERS = 'Firma DataVDF Regional TR SiteCode ItemCode ItemName Cantitate Pret Valoare PretFD'.split() + ['Denumire Client', 'CIF', 'PunctDeLucru', 'CodPunctDeLucru', 'Oras', 'Judet', 'Nr', 'TRVechi', 'ItemType', 'IMEI', 'Qtty', 'Activat', 'DataActivare', 'HandSetType', 'JudetActivare', 'ItemCodeA', 'ItemNameA', 'Furnizor', 'DocumentDetailId', 'DocumentId', 'SiteId', 'DataVDFFormat']
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
TR = re.compile(r'(^|[^A-Z0-9])TR([^A-Z0-9]|$)')
VERSION = 3
MAX_ROWS = 1_000_000
DIGI_HEADERS = ['Canal', 'Magazin', 'Data', 'Cod', 'Cantitate', 'IMEI', 'Pret', 'Denumire Client', 'Activat', 'DataDigi']

class ImportError(ValueError):
    pass


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def digest(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def date(value):
    if not re.fullmatch(r'[0-9]{8}', value):
        raise ValueError('Invalid date')
    return dt.date(int(value[:4]), int(value[4:6]), int(value[6:])).isoformat()


def xml_rows(archive, target, strings):
    with archive.open(target) as stream:
        parents = []
        for event, element in ET.iterparse(stream, events=('start', 'end')):
            if event == 'start':
                parents.append(element)
                continue
            if element.tag == '{' + NS['s'] + '}row':
                cells = {}
                for cell in element:
                    ref = cell.get('r', '')
                    match = re.fullmatch(r'([A-Z]+)[0-9]+', ref)
                    if not match:
                        raise ImportError('Invalid cell coordinate')
                    col = 0
                    for letter in match[1]:
                        col = col * 26 + ord(letter) - 64
                    if col > 33 or col in cells:
                        raise ImportError('Unexpected or duplicate column')
                    kind = cell.get('t', 'n')
                    value = cell.findtext('s:v', default='', namespaces=NS)
                    if kind == 's':
                        try:
                            index = int(value)
                            if index < 0:
                                raise ValueError()
                            value = strings[index]
                        except (IndexError, ValueError):
                            raise ImportError('Invalid shared string') from None
                    elif kind == 'inlineStr':
                        value = ''.join(n.text or '' for n in cell.findall('.//s:t', NS))
                    if cell.find('s:f', NS) is not None or kind == 'e':
                        raise ImportError('Formulas and Excel errors are not accepted')
                    cells[col] = (value, kind)
                yield int(element.get('r')), cells
                parents[-2].remove(element)
            parents.pop()


def workbook(path, *, sheet_name="SIM", required_headers=None, header_row=None):
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(e.file_size for e in entries) > 2_000_000_000:
            raise ImportError('Workbook size limit exceeded')
        if len({e.filename for e in entries}) != len(entries):
            raise ImportError('Duplicate ZIP members')
        strings = []
        if 'xl/sharedStrings.xml' in archive.namelist():
            if archive.getinfo('xl/sharedStrings.xml').file_size > 512_000_000:
                raise ImportError('Shared string size limit exceeded')
            with archive.open('xl/sharedStrings.xml') as stream:
                context = ET.iterparse(stream, events=('start', 'end'))
                _, root = next(context)
                for event, el in context:
                    if event == 'end' and el.tag == '{' + NS['s'] + '}si':
                        strings.append(''.join(t.text or '' for t in el.findall('.//s:t', NS)))
                        root.clear()
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        sheets = book.findall('s:sheets/s:sheet', NS)
        matches = [s for s in sheets if s.get('name') == sheet_name]
        if len(matches) != 1 or (sheet_name == 'SIM' and len(sheets) != 1):
            raise ImportError('Expected exactly one ' + sheet_name + ' sheet')
        sheets = matches
        rels = {r.get('Id'): r for r in ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        rel = rels[sheets[0].get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')]
        target = rel.get('Target', '')
        if rel.get('TargetMode') == 'External' or '..' in target.split('/'):
            raise ImportError('Invalid sheet relationship')
        target = target.lstrip('/') if target.startswith('/') else 'xl/' + target
        header = None
        digi = False
        last = 0
        for rn, cells in xml_rows(archive, target, strings):
            if rn <= last or rn > MAX_ROWS + 5:
                raise ImportError('Invalid row order or row limit exceeded')
            last = rn
            if required_headers is not None:
                if rn < header_row: continue
                if rn == header_row:
                    header = [cells.get(i, ('', ''))[0] for i in range(1, len(cells)+1)]
                    if len(set(header)) != len(header) or not set(required_headers).issubset(header):
                        raise ImportError('Unexpected operator headers')
                    continue
                if header is None: raise ImportError('Missing operator header')
                raw = {key: cells.get(i, ('', ''))[0] for i,key in enumerate(header,1)}
                if not any(raw.values()): continue
                for i,key in enumerate(header,1):
                    if key == 'SerieText' and raw[key] and cells[i][1] not in ('s','inlineStr','str'):
                        raise ImportError('Numeric operator serial')
                yield rn,raw
                continue
            if rn == 1:
                first = [cells.get(i, ('', ''))[0] for i in range(1, len(cells) + 1)]
                if len(first) == len(DIGI_HEADERS) and set(first) == set(DIGI_HEADERS):
                    header, digi = first, True
                    continue
            if not digi and rn < 5:
                continue
            if not digi and rn == 5:
                header = [cells.get(i, ('', ''))[0] for i in range(1, 34)]
                if len(set(header)) != 33 or set(header) != set(HEADERS):
                    raise ImportError('Unexpected or duplicate headers')
                continue
            if header is None:
                raise ImportError('Missing SIM header')
            raw = {key: cells.get(i, ('', ''))[0] for i, key in enumerate(header, 1)}
            if not any(raw.values()):
                continue
            # Never convert numeric serials, round them or guess missing digits.
            for i, key in enumerate(header, 1):
                if key in ('IMEI', 'Activat') and raw[key] and cells[i][1] not in ('s', 'inlineStr', 'str'):
                    raise ImportError(f'Numeric serial at row {rn}')
            yield rn, raw
        if header is None:
            raise ImportError('Missing header at row 5')


SCHEMA = '''
CREATE TABLE IF NOT EXISTS activation_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activation_imports(
 id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, filename TEXT NOT NULL,
 operator TEXT NOT NULL, nominal_period TEXT NOT NULL, parser_version INTEGER NOT NULL, imported_at TEXT NOT NULL,
 source_kind TEXT NOT NULL DEFAULT 'internal', source_at TEXT NOT NULL DEFAULT '',
 period_start TEXT NOT NULL DEFAULT '', period_end TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
 row_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('loading','complete')));
CREATE TABLE IF NOT EXISTS activation_movements(
 id INTEGER PRIMARY KEY, movement_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
 company TEXT NOT NULL, provider TEXT NOT NULL, imei TEXT NOT NULL, serial TEXT NOT NULL,
 movement_date TEXT, activation_date TEXT, site TEXT NOT NULL, agent TEXT NOT NULL,
 is_tr INTEGER NOT NULL, item_code TEXT NOT NULL, item_type TEXT NOT NULL,
 customer_key TEXT NOT NULL, quantity INTEGER, issues TEXT NOT NULL, raw_json TEXT NOT NULL,
 UNIQUE(movement_key,payload_hash));
CREATE INDEX IF NOT EXISTS activation_movements_identity ON activation_movements(company,provider,imei);
CREATE INDEX IF NOT EXISTS activation_movements_serial ON activation_movements(company,provider,serial);
CREATE TABLE IF NOT EXISTS activation_occurrences(
 import_id INTEGER NOT NULL REFERENCES activation_imports(id), source_row INTEGER NOT NULL,
 movement_id INTEGER NOT NULL REFERENCES activation_movements(id), PRIMARY KEY(import_id,source_row));
CREATE TABLE IF NOT EXISTS activation_facts(
 company TEXT NOT NULL, provider TEXT NOT NULL, serial TEXT NOT NULL,
 activation_date TEXT, month TEXT, item_code TEXT, item_type TEXT,
 candidate_site TEXT, status TEXT NOT NULL, reasons TEXT NOT NULL, net_quantity INTEGER,
 evidence_json TEXT NOT NULL, PRIMARY KEY(company,provider,serial));
CREATE INDEX IF NOT EXISTS activation_occurrences_movement ON activation_occurrences(movement_id,import_id);
CREATE INDEX IF NOT EXISTS activation_facts_month ON activation_facts(month,status);
CREATE TABLE IF NOT EXISTS activation_observations(
 import_id INTEGER NOT NULL REFERENCES activation_imports(id), source_row INTEGER NOT NULL,
 company TEXT NOT NULL, provider TEXT NOT NULL, serial TEXT NOT NULL, activation_date TEXT NOT NULL,
 county TEXT NOT NULL, handset TEXT NOT NULL, raw_json TEXT NOT NULL, PRIMARY KEY(import_id,source_row));
CREATE INDEX IF NOT EXISTS observation_identity ON activation_observations(company,provider,serial);
CREATE TABLE IF NOT EXISTS activation_effective_movements(
 movement_id INTEGER PRIMARY KEY REFERENCES activation_movements(id), company TEXT NOT NULL, provider TEXT NOT NULL,
 imei TEXT NOT NULL, serial TEXT NOT NULL, movement_date TEXT, site TEXT NOT NULL, is_tr INTEGER NOT NULL,
 item_code TEXT NOT NULL, customer_key TEXT NOT NULL, quantity INTEGER, raw_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS effective_serial ON activation_effective_movements(company,provider,serial);
CREATE INDEX IF NOT EXISTS effective_period ON activation_effective_movements(provider,movement_date,site);

'''


def connect(directory):
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (root / 'current').exists() or (root / 'current').is_symlink():
        raise ImportError('Use activation_job for a published generation root')
    path = root / 'activations.sqlite'
    # Refuse unrelated databases before any schema writes.
    c = sqlite3.connect(path, timeout=30)
    c.row_factory = sqlite3.Row
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if tables and 'activation_meta' not in tables:
        c.close()
        raise ImportError('Not an activations database')
    if tables:
        version = c.execute("SELECT value FROM activation_meta WHERE key='schema_version'").fetchone()
        if version and version[0] == '2':
            versions.migrate(c, '2')
            version = (str(VERSION),)
        if not version or version[0] != str(VERSION):
            c.close()
            raise ImportError('Unsupported activations schema version')
    os.chmod(path, 0o600)
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA journal_mode=WAL')
    c.executescript(SCHEMA)
    c.execute("INSERT OR IGNORE INTO activation_meta VALUES('schema_version',?)", (str(VERSION),))
    c.commit()
    return c


def normalized_digi(raw, operator, aliases):
    if operator != 'digi':
        raise ImportError('Digi source requires the digi operator namespace')
    issues = []
    dates = []
    for name in ('Data', 'DataDigi'):
        value = raw[name]
        try:
            if value and not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
                raise ValueError()
            dates.append(dt.date.fromisoformat(value).isoformat() if value else None)
        except ValueError:
            dates.append(None)
            issues.append('invalid_' + name)
    if not dates[0]:
        issues.append('missing_movement_date')
    if raw['Activat'] and not dates[1]:
        issues.append('missing_activation_date')
    if not raw['Canal'] or not raw['IMEI']:
        issues.append('missing_identity')
    for key in ('IMEI', 'Activat'):
        if raw[key] and not re.fullmatch(r'[0-9]{19}', raw[key]):
            issues.append('invalid_serial_text')
    if raw['Activat'] and raw['Activat'] != raw['IMEI']:
        issues.append('unverified_serial_relationship')
    try:
        document_quantity = Decimal(raw['Cantitate'])
        quantity = (1 if document_quantity > 0 else -1) if document_quantity.is_finite() and document_quantity and document_quantity == document_quantity.to_integral_value() else None
    except (InvalidOperation, ValueError):
        quantity = None
    if quantity is None:
        issues.append('unsupported_quantity')
    # Inventory channels are retained as source evidence, never treated as TR sales.
    inventory = raw['Canal'].endswith('Inv')
    is_tr = bool(TR.search(raw['Magazin'].upper())) and not inventory
    site = aliases.get((raw['Canal'], raw['Magazin']), '') if is_tr else ''
    if inventory:
        issues.append('inventory_channel')
    if is_tr and not site:
        issues.append('unmapped_source_site')
    # No document ID exists in this export. Preserve indistinguishable observations
    # and quarantine repeated observations instead of inventing document identities.
    identity = [raw[k] for k in ('Canal', 'Magazin', 'Data', 'Cod', 'IMEI', 'Pret', 'Denumire Client')] + [quantity, operator]
    payload = dump(raw)
    return (hashlib.sha256(dump(identity).encode()).hexdigest(), hashlib.sha256(payload.encode()).hexdigest(),
            raw['Canal'], operator, raw['IMEI'], raw['Activat'] if raw['Activat'].strip() else '',
            *dates, site, raw['Magazin'], int(is_tr), raw['Cod'], 'SIM', '', quantity, dump(sorted(set(issues))), payload)


def normalized(raw, file_hash, rn, operator, aliases=None):
    if 'Canal' in raw:
        return normalized_digi(raw, operator, aliases or {})
    if operator == 'digi':
        raise ImportError('Digi operator requires the Digi source schema')
    issues = []
    dates = []
    for name in ('DataVDF', 'DataActivare'):
        try:
            parsed = date(raw[name]) if raw[name] else None
        except ValueError:
            parsed = None
            issues.append('invalid_' + name)
        dates.append(parsed)
    if not dates[0]:
        issues.append('missing_movement_date')
    if raw['Activat'] and not dates[1]:
        issues.append('missing_activation_date')
    if any(raw[k] and (raw[k] != raw[k].strip() or not re.fullmatch('[0-9]+', raw[k])) for k in ('IMEI', 'Activat')):
        issues.append('invalid_serial_text')
    if not raw['IMEI'] or not raw['Firma']:
        issues.append('missing_identity')
    # Validate this known SIM relationship; never manufacture W from U.
    if raw['ItemType'] == 'SIM' and raw['Activat'] and not (
        len(raw['IMEI']) == 19 and len(raw['Activat']) == 18 and raw['IMEI'][:-1] == raw['Activat']
    ):
        issues.append('unverified_serial_relationship')
    try:
        signed = Decimal(raw['Qtty'])
        quantity = int(signed) if signed.is_finite() and signed in (Decimal(1), Decimal(-1)) else None
    except (InvalidOperation, ValueError):
        quantity = None
    if quantity is None:
        issues.append('unsupported_quantity')
    customer = dump([raw['CIF'], raw['CodPunctDeLucru']]) if raw['CIF'] and raw['CodPunctDeLucru'] else ''
    identity = [raw['Firma'], operator, raw['DocumentDetailId'], raw['IMEI']]
    if not raw['DocumentDetailId'] or not raw['IMEI']:
        issues.append('missing_movement_identity')
        identity += [file_hash, rn]
    key = hashlib.sha256(dump(identity).encode()).hexdigest()
    payload = dump(raw)
    return (key, hashlib.sha256(payload.encode()).hexdigest(), raw['Firma'], operator, raw['IMEI'], raw['Activat'] if raw['Activat'].strip() else '',
            *dates, raw['SiteCode'], raw['TR'], int(bool(TR.search(raw['TR'].upper()))), raw['ItemCode'], raw['ItemType'],
            customer, quantity, dump(sorted(set(issues))), payload)


def reconcile_group(rows, conflicts):
    """Ledger candidate only, never payroll authority. Match returns before TR filtering."""
    reasons = set()
    outstanding = []
    links = []
    active = [r for r in rows if r['serial']]
    if not active:
        return []
    dates = {r['activation_date'] for r in active}
    serials = {r['serial'] for r in active}
    codes = {r['item_code'] for r in rows}
    types = {r['item_type'] for r in rows}
    for r in rows:
        reasons.update(json.loads(r['issues']))
        if r['movement_key'] in conflicts:
            reasons.add('changed_source_movement')
    if len(dates) != 1 or None in dates:
        reasons.add('activation_date_conflict')
    if len(serials) != 1:
        reasons.add('serial_identity_conflict')
    if len(codes) != 1 or len(types) != 1:
        reasons.add('product_conflict')
    activation_date = next(iter(dates)) if len(dates) == 1 else None
    for r in sorted(rows, key=lambda x: (x['movement_date'] or '', x['id'])):
        if r['quantity'] == 1:
            outstanding.append(r)
        elif r['quantity'] == -1:
            # Same-day ordering is unknown. Never choose a sale by row order.
            matches = [s for s in outstanding if r['customer_key'] and s['customer_key'] == r['customer_key']
                       and s['item_code'] == r['item_code'] and s['movement_date'] and r['movement_date']
                       and s['movement_date'] < r['movement_date']]
            if len(matches) == 1:
                sale = matches[0]
                outstanding.remove(sale)
                links.append([sale['id'], r['id']])
            else:
                reasons.add('ambiguous_or_unmatched_return')
        if activation_date and r['movement_date'] and r['movement_date'] > activation_date:
            reasons.add('post_activation_movement_rule_pending')
    net = sum(r['quantity'] or 0 for r in rows)
    candidate = None
    if len(outstanding) == 1 and net == 1 and not reasons:
        survivor = outstanding[0]
        if survivor['is_tr'] and survivor['site']:
            candidate = survivor['site']
        else:
            reasons.add('remaining_movement_not_tr')
    elif not reasons:
        reasons.add('non_unique_remaining_sale')
    evidence = dump({'movementIds': [r['id'] for r in rows], 'returnLinks': links,
                     'remainingSaleIds': [r['id'] for r in outstanding], 'version': VERSION,
                     'commissionStatus': 'rules_pending', 'employeeMapping': 'unconfirmed'})
    return [(rows[0]['company'], rows[0]['provider'], serial, activation_date,
             activation_date[:7] if activation_date else None, next(iter(codes)) if len(codes) == 1 else None,
             next(iter(types)) if len(types) == 1 else None, candidate,
             'candidate' if candidate else 'unresolved', dump(sorted(reasons)), net, evidence) for serial in sorted(serials)]


def facts_need_rebuild(c):
    version=c.execute("SELECT value FROM activation_meta WHERE key='facts_version'").fetchone()
    return not version or version[0]!=versions.FACTS_VERSION or not c.execute("SELECT 1 FROM activation_meta WHERE key='generation'").fetchone()


def rebuild(c, operator=None):
    # A semantic migration must reconcile the entire ledger before certifying
    # its derived version, including no-op imports and old complete generations.
    if facts_need_rebuild(c):operator=None
    if operator is None:
        c.execute('DELETE FROM activation_facts')
    else:
        c.execute('DELETE FROM activation_facts WHERE provider=?', (operator,))
    c.execute('DELETE FROM activation_effective_movements' + (' WHERE provider=?' if operator else ''), (operator,) if operator else ())
    c.execute("DELETE FROM activation_meta WHERE key LIKE 'conflict:%'")
    official = collections.defaultdict(list)
    for o in c.execute("SELECT o.*,i.source_at FROM activation_observations o JOIN activation_imports i ON i.id=o.import_id WHERE i.status='complete'"):
        official[(o['company'],o['provider'],o['serial'])].append(dict(serial=o['serial'],activation_date=o['activation_date'],county=o['county'],handset=o['handset'],priority=1,source_at=o['source_at'],ref={'importId':o['import_id'],'row':o['source_row']}))
    used=set()
    repeated_digi = {r[0] for r in c.execute("SELECT o.movement_id FROM activation_occurrences o JOIN activation_movements m ON m.id=o.movement_id WHERE m.provider='digi' GROUP BY o.import_id,o.movement_id HAVING COUNT(*)>1")}
    query="SELECT m.*,COALESCE(MAX(i.source_at),'') source_at FROM activation_movements m JOIN activation_occurrences o ON o.movement_id=m.id JOIN activation_imports i ON i.id=o.import_id"
    query+=(' WHERE m.provider=?' if operator else '')+' GROUP BY m.id ORDER BY m.company,m.provider,m.imei,m.id'
    cursor=c.execute(query,(operator,) if operator else ())
    for identity,group in itertools.groupby(cursor,key=lambda r:(r['company'],r['provider'],r['imei'])):
        rows,conflicts=versions.effective([dict(r) for r in group])
        for key in conflicts:c.execute('INSERT OR REPLACE INTO activation_meta VALUES(?,?)',('conflict:'+key,'1'))
        company,provider,imei=identity
        # Explicit operator observation supplies the activation, never an IMEI truncation alone.
        serial_keys={o['serial'] for r in rows for o in r['observations'] if o['serial']}
        if provider=='vodafone' and re.fullmatch(r'[0-9]{19}',imei) and all(r['item_type']=='SIM' for r in rows):
            serial_keys.add(imei[:-1])
        external=[]
        for serial in serial_keys:
            key=(company,provider,serial)
            if key in official:external+=official[key];used.add(key)
        selected,refs,observation_conflicts=versions.apply_observations(rows,external)
        for r in rows:
            if any(i in repeated_digi for i in r['version_ids']):
                r['issues']=dump(sorted(set(json.loads(r['issues'])+['indistinguishable_source_rows'])))
            c.execute('INSERT INTO activation_effective_movements VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', (r['id'],r['company'],r['provider'],r['imei'],r['serial'],r['movement_date'],r['site'],r['is_tr'],r['item_code'],r['customer_key'],r['quantity'],r['raw_json']))
        for fact in reconcile_group(rows,conflicts):
            fact=list(fact)
            evidence=json.loads(fact[-1]);evidence.update(observation=selected,observationSources=refs,versionIds=[i for r in rows for i in r['version_ids']])
            reasons=set(json.loads(fact[9]))|set(observation_conflicts)
            if observation_conflicts:
                fact[7]=None;fact[8]='unresolved'
                if 'activation_date_conflict' in observation_conflicts:fact[3]=fact[4]=None
            fact[9]=dump(sorted(reasons));fact[-1]=dump(evidence)
            old=c.execute('SELECT evidence_json,reasons FROM activation_facts WHERE company=? AND provider=? AND serial=?',fact[:3]).fetchone()
            if old:
                previous=json.loads(old[0])
                for key in ('movementIds','returnLinks','remainingSaleIds','versionIds'):previous[key]+=evidence[key]
                reasons=sorted(set(json.loads(old[1])+json.loads(fact[9])+['conflicting_imei_for_serial']))
                c.execute("UPDATE activation_facts SET status='unresolved',candidate_site=NULL,activation_date=NULL,month=NULL,item_code=NULL,item_type=NULL,net_quantity=NULL,reasons=?,evidence_json=? WHERE company=? AND provider=? AND serial=?",(dump(reasons),dump(previous),*fact[:3]))
            else:c.execute('INSERT INTO activation_facts VALUES('+','.join('?'*12)+')',fact)
    for key,observations in official.items():
        if key in used or (operator and key[1]!=operator):continue
        selected={};refs={};reasons=['operator_without_distribution']
        for field in ('serial','activation_date','county','handset'):
            selected[field],refs[field],conflict=versions.select_field(observations,field)
            if conflict:reasons.append(field+'_conflict')
        ad=selected['activation_date'] or None
        c.execute('INSERT INTO activation_facts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',(*key,ad,ad[:7] if ad else None,None,None,None,'unresolved',dump(reasons),None,dump({'observation':selected,'observationSources':refs,'movementIds':[],'returnLinks':[],'remainingSaleIds':[],'versionIds':[]})))
    c.execute("INSERT INTO activation_meta VALUES('generation','1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1")
    c.execute("INSERT OR REPLACE INTO activation_meta VALUES('facts_version',?)",(versions.FACTS_VERSION,))


def summary(c):
    return {
        'imports': c.execute("SELECT COUNT(*) FROM activation_imports WHERE status='complete'").fetchone()[0],
        'sourceRows': c.execute('SELECT COUNT(*) FROM activation_occurrences').fetchone()[0],
        'movementVersions': c.execute('SELECT COUNT(*) FROM activation_movements').fetchone()[0],
        'blankActivatMovements': c.execute("SELECT COUNT(*) FROM activation_movements WHERE serial='' ").fetchone()[0],
        'facts': c.execute('SELECT COUNT(*) FROM activation_facts').fetchone()[0],
        'movementsWithIssues': c.execute("SELECT COUNT(*) FROM activation_movements WHERE issues<>'[]'").fetchone()[0],
        'conflictingMovementKeys': c.execute('SELECT COUNT(*) FROM (SELECT movement_key FROM activation_movements GROUP BY movement_key HAVING COUNT(*)>1)').fetchone()[0],
        'unresolvedReasons': dict(c.execute('SELECT j.value,COUNT(*) FROM activation_facts f,json_each(f.reasons) j GROUP BY j.value')),
        'statusCounts': dict(c.execute('SELECT status,COUNT(*) FROM activation_facts GROUP BY status')),
        'months': [dict(r) for r in c.execute('SELECT month,item_type,COUNT(*) count FROM activation_facts GROUP BY month,item_type ORDER BY month,item_type')],
        'commissionStatus': 'not_implemented_rules_pending',
    }


def import_files(c, directory, paths, **options):
    if Path(c.execute('PRAGMA database_list').fetchone()[2]).resolve() != Path(directory).resolve() / 'activations.sqlite':
        raise ImportError('Data directory does not match the database')
    with (Path(directory) / '.activation-job.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _import_files(c, directory, paths, **options)


def _import_files(c, directory, paths, *, operator, nominal_period='', site_aliases=None, source_kind='internal', source_at='', period_start='', period_end='', company=''):
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,63}', operator):
        raise ImportError('Explicit stable operator namespace required')
    if source_kind not in ('internal','operator') or (source_kind=='operator' and (operator!='vodafone' or not company)):
        raise ImportError('Operator source requires explicit Vodafone company')
    for value in (source_at,period_start,period_end):
        if value: dt.date.fromisoformat(value)
    if period_start and period_end and period_start>period_end:raise ImportError('Invalid declared period')
    root = Path(directory).resolve()
    database = Path(c.execute('PRAGMA database_list').fetchone()[2]).resolve()
    if database != root / 'activations.sqlite':
        raise ImportError('Data directory does not match the database')
    originals = root / 'activation-originals'
    originals.mkdir(mode=0o700, exist_ok=True)
    results = []
    c.execute('BEGIN IMMEDIATE')
    try:
        # Exact historical company + label matches only; never fuzzy-match people,
        # merge companies, or infer ownership from current account activity.
        aliases = site_aliases or {}
        if operator == 'digi':
            if c.execute("SELECT 1 FROM activation_imports WHERE operator<>'digi' LIMIT 1").fetchone():
                raise ImportError('Digi requires its own dedicated database')
            basis = dump([[*key, value] for key, value in sorted(aliases.items())])
            old = c.execute("SELECT value FROM activation_meta WHERE key='digi_site_aliases'").fetchone()
            if old and old[0] != basis:
                raise ImportError('Digi site mapping changed; explicit reconciliation required')
            c.execute("INSERT OR IGNORE INTO activation_meta VALUES('digi_site_aliases',?)", (basis,))
        elif c.execute("SELECT 1 FROM activation_imports WHERE operator='digi' LIMIT 1").fetchone():
            raise ImportError('Digi database cannot contain another operator')
        for source in paths:
            source = Path(source)
            # Parse an immutable staged copy; source changes cannot invalidate the hash binding.
            with tempfile.NamedTemporaryFile(dir=originals, suffix=''.join(source.suffixes)) as staged:
                with source.open('rb') as stream:
                    shutil.copyfileobj(stream, staged)
                staged.flush(); os.fsync(staged.fileno())
                sha = digest(staged.name)
                existing = c.execute('SELECT * FROM activation_imports WHERE sha256=?', (sha,)).fetchone()
                if existing:
                    if existing['operator'] != operator:
                        raise ImportError('Source already bound to another operator')
                    if tuple(existing[k] for k in ('source_kind','source_at','period_start','period_end','company')) != (source_kind,source_at,period_start,period_end,company):
                        raise ImportError('Source already bound to different provenance')
                    archived = originals / (sha + '.xlsx')
                    if not archived.is_file() or digest(archived) != sha:
                        raise ImportError('Archived source missing or checksum mismatch')
                    results.append({'status': 'already_imported', 'sha256': sha})
                    continue
                destination = originals / (sha + '.xlsx')
                if destination.exists():
                    if digest(destination) != sha:
                        raise ImportError('Archived source checksum mismatch')
                else:
                    os.link(staged.name, destination)
                    fd = os.open(originals, os.O_RDONLY)
                    try:
                        os.fsync(fd)
                    finally:
                        os.close(fd)
                batch = c.execute("INSERT INTO activation_imports(sha256,filename,operator,nominal_period,parser_version,imported_at,status) VALUES(?,?,?,?,?,?,'loading')",
                                  (sha, source.name, operator, nominal_period, VERSION, dt.datetime.now(dt.timezone.utc).isoformat())).lastrowid
                c.execute('UPDATE activation_imports SET source_kind=?,source_at=?,period_start=?,period_end=?,company=? WHERE id=?',(source_kind,source_at,period_start,period_end,company,batch))
                count = 0
                records = versions.operator_records(Path(staged.name),workbook) if source_kind=='operator' else workbook(staged.name)
                for rn, raw in records:
                    if source_kind=='operator':
                        serial,ad,county,handset=versions.operator_values(raw)
                        c.execute('INSERT INTO activation_observations VALUES(?,?,?,?,?,?,?,?,?)',(batch,rn,company,operator,serial,ad,county,handset,dump(raw)))
                        count+=1
                        continue
                    values = normalized(raw, sha, rn, operator, aliases)
                    c.execute('INSERT OR IGNORE INTO activation_movements(movement_key,payload_hash,company,provider,imei,serial,movement_date,activation_date,site,agent,is_tr,item_code,item_type,customer_key,quantity,issues,raw_json) VALUES(' + ','.join('?' * 17) + ')', values)
                    movement = c.execute('SELECT id FROM activation_movements WHERE movement_key=? AND payload_hash=?', values[:2]).fetchone()[0]
                    c.execute('INSERT INTO activation_occurrences VALUES(?,?,?)', (batch, rn, movement))
                    count += 1
                c.execute("UPDATE activation_imports SET status='complete',row_count=? WHERE id=?", (count, batch))
                results.append({'status': 'imported', 'sha256': sha, 'rows': count})
        if any(r['status'] == 'imported' for r in results) or facts_need_rebuild(c):
            rebuild(c, operator)
        c.commit()
    except BaseException:
        c.rollback()
        raise
    return {'files': results, **summary(c)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('--operator', required=True, help='Stable network/operator namespace, not the source supplier')
    parser.add_argument('--nominal-period', default='')
    parser.add_argument('--source-kind',choices=['internal','operator'],default='internal')
    parser.add_argument('--source-at',default='',help='Verified source revision date (ISO), never inferred from filename')
    parser.add_argument('--period-start',default='')
    parser.add_argument('--period-end',default='')
    parser.add_argument('--company',default='',help='Required namespace for operator observations')
    parser.add_argument('--preview', action='store_true', help='Use a disposable copy; no changes to target data')
    parser.add_argument('--site-reference-data-dir', type=Path, help='Read-only historical ledger for exact company and TR label aliases (Digi only)')
    parser.add_argument('files', nargs='+', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    aliases = {}
    if args.site_reference_data_dir:
        if args.operator != 'digi' or args.site_reference_data_dir.resolve() == args.data_dir.resolve():
            raise ImportError('Site reference must be a separate read-only ledger for Digi')
        reference = sqlite3.connect((args.site_reference_data_dir.resolve() / 'activations.sqlite').as_uri() + '?mode=ro', uri=True)
        try:
            if reference.execute("SELECT value FROM activation_meta WHERE key='schema_version'").fetchone() not in (('2',),(str(VERSION),)):
                raise ImportError('Unsupported site reference ledger')
            aliases = {(r[0], r[1]): r[2] for r in reference.execute("SELECT company,agent,MIN(site) FROM activation_movements WHERE provider='vodafone' AND is_tr=1 AND site<>'' GROUP BY company,agent HAVING COUNT(DISTINCT site)=1")}
        finally:
            reference.close()
    if args.preview:
        with tempfile.TemporaryDirectory(prefix='activations-preview-') as temp:
            path = args.data_dir / 'activations.sqlite'
            if path.exists():
                source = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
                target = sqlite3.connect(Path(temp) / 'activations.sqlite')
                try:
                    source.backup(target)
                finally:
                    source.close(); target.close()
            c = connect(temp)
            try:
                print(dump({'preview': True, **import_files(c, temp, args.files, operator=args.operator, nominal_period=args.nominal_period, site_aliases=aliases,source_kind=args.source_kind,source_at=args.source_at,period_start=args.period_start,period_end=args.period_end,company=args.company)}))
            finally:
                c.close()
    else:
        c = connect(args.data_dir)
        try:
            print(dump(import_files(c, args.data_dir, args.files, operator=args.operator, nominal_period=args.nominal_period, site_aliases=aliases,source_kind=args.source_kind,source_at=args.source_at,period_start=args.period_start,period_end=args.period_end,company=args.company)))
        finally:
            c.close()

if __name__ == '__main__':
    main()
