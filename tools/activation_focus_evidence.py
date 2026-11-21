"""Build private Vodafone Focus inputs for one immutable activation generation."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from contextlib import closing

FILE_NAME = 'vodafone-focus-evidence.sqlite'
FORMAT = '1'
IMPORTS = "SELECT sha256,operator,row_count,parser_version FROM ledger.activation_imports WHERE status='complete' ORDER BY sha256"
OPERATOR_FILES = """operator='vodafone' AND status='complete' AND source_kind='operator'
    AND UPPER(TRIM(company)) IN ('VODAFONE','MOBIUP','MOBIUP DISTRIBUTION SRL')
    AND period_start<>'' AND period_end<>''"""


def _signature(db, directory):
    versions = dict(db.execute("SELECT key,value FROM ledger.activation_meta WHERE key IN ('generation','facts_version')"))
    return (FORMAT, directory.name, versions.get('generation', ''), versions.get('facts_version', ''),
            json.dumps(db.execute(IMPORTS).fetchall(), separators=(',', ':')))


def _build(db):
    db.execute('CREATE TABLE activation_imports(id INTEGER PRIMARY KEY,operator,status,source_kind,company,source_at,period_start,period_end)')
    db.execute('INSERT INTO activation_imports SELECT id,operator,status,source_kind,company,source_at,period_start,period_end FROM ledger.activation_imports WHERE '+OPERATOR_FILES)
    db.execute('CREATE TABLE activation_observations(import_id INTEGER,source_row INTEGER,serial TEXT,activation_date TEXT,county TEXT,handset TEXT,raw_json TEXT,PRIMARY KEY(import_id,source_row)) WITHOUT ROWID')
    db.execute("""INSERT INTO activation_observations
        SELECT o.import_id,o.source_row,o.serial,o.activation_date,o.county,o.handset,
        json_object('DEALER_NAME',json_extract(o.raw_json,'$.DEALER_NAME'),'SIM_TYPE',json_extract(o.raw_json,'$.SIM_TYPE'),
                    'FIRST_RECHARGE_VALUE',json_extract(o.raw_json,'$.FIRST_RECHARGE_VALUE'))
        FROM activation_imports f CROSS JOIN ledger.activation_observations o WHERE o.import_id=f.id""")
    db.execute('CREATE TEMP TABLE candidate(serial TEXT PRIMARY KEY) WITHOUT ROWID')
    db.execute("""INSERT OR IGNORE INTO candidate SELECT serial FROM activation_observations
        WHERE length(serial)=18 AND serial NOT GLOB '*[^0-9]*'""")
    db.execute('CREATE TEMP TABLE matched(id INTEGER PRIMARY KEY)')
    for condition in ("m.serial=p.serial", "m.imei>=p.serial||'0' AND m.imei<p.serial||':' AND length(m.imei)=19"):
        db.execute("""INSERT OR IGNORE INTO matched SELECT m.movement_id FROM candidate p
            CROSS JOIN ledger.activation_effective_movements m
            WHERE m.company IN ('MobiUp','MobiCell') AND m.provider='vodafone' AND """ + condition)
    db.execute("""CREATE TABLE activation_effective_movements(movement_id INTEGER PRIMARY KEY,company TEXT,provider TEXT,
        serial TEXT,imei TEXT,site TEXT,is_tr INTEGER,movement_date TEXT,quantity,raw_json TEXT)""")
    fields = ['Activat', 'ItemType', 'Nr', 'DocumentId', 'DocumentDetailId', 'ItemCode', 'CIF', 'CodPunctDeLucru']
    facts = ','.join(f"'{field}',json_extract(m.raw_json,'$.{field}')" for field in fields)
    db.execute(f"""INSERT INTO activation_effective_movements SELECT m.movement_id,m.company,m.provider,m.serial,m.imei,
        m.site,m.is_tr,m.movement_date,m.quantity,json_object({facts})
        FROM matched k CROSS JOIN ledger.activation_effective_movements m WHERE m.movement_id=k.id ORDER BY k.id""")
    db.execute('CREATE INDEX effective_serial ON activation_effective_movements(company,provider,serial)')
    db.execute('CREATE INDEX effective_imei ON activation_effective_movements(company,provider,imei)')
    db.execute('CREATE TABLE activation_movements(id INTEGER PRIMARY KEY,movement_key TEXT)')
    db.execute('CREATE TABLE activation_meta(key TEXT PRIMARY KEY)')
    if db.execute("SELECT 1 FROM ledger.activation_meta WHERE key GLOB 'conflict:*' LIMIT 1").fetchone():
        db.execute("""INSERT INTO activation_movements SELECT o.id,o.movement_key FROM matched k
            CROSS JOIN ledger.activation_movements o WHERE o.id=k.id AND EXISTS(
            SELECT 1 FROM ledger.activation_meta i WHERE i.key='conflict:'||o.movement_key)""")
        db.execute("INSERT OR IGNORE INTO activation_meta SELECT 'conflict:'||movement_key FROM activation_movements")


def build_focus_evidence(directory, force=False):
    directory = Path(directory).resolve(strict=True)
    if directory.parent.name != 'generations':
        raise ValueError('Expected a private activation generation')
    ledger = directory/'activations.sqlite'
    if ledger.is_symlink() or not ledger.is_file() or ledger.stat().st_uid != os.geteuid():
        raise ValueError('Run as the private activation ledger owner')
    destination = directory/FILE_NAME
    dfd = os.open(directory, os.O_RDONLY)
    temp = None
    try:
        fcntl.flock(dfd, fcntl.LOCK_EX)
        with closing(sqlite3.connect(':memory:', uri=True)) as probe:
            probe.execute('ATTACH DATABASE ? AS ledger', (ledger.as_uri()+'?mode=ro',))
            probe.execute('BEGIN')
            if not probe.execute('SELECT 1 FROM ledger.activation_imports WHERE '+OPERATOR_FILES+' LIMIT 1').fetchone():
                return 'unused'
            signature = _signature(probe, directory)
        if not force and destination.is_file() and not destination.is_symlink():
            try:
                with closing(sqlite3.connect(destination.as_uri()+'?mode=ro', uri=True)) as current:
                    if current.execute('SELECT format,directory,generation,facts,imports FROM focus_manifest').fetchone() == signature:
                        return 'current'
            except sqlite3.DatabaseError:
                pass
        fd, temp = tempfile.mkstemp(prefix='.focus-evidence-', suffix='.sqlite', dir=directory)
        os.close(fd)
        with closing(sqlite3.connect(Path(temp).as_uri()+'?mode=rw', uri=True)) as db:
            db.execute('ATTACH DATABASE ? AS ledger', (ledger.as_uri()+'?mode=ro',))
            db.execute('BEGIN')
            if _signature(db, directory) != signature:
                raise ValueError('Activation generation changed during preparation')
            _build(db)
            db.execute('CREATE TABLE focus_manifest(format TEXT,directory TEXT,generation TEXT,facts TEXT,imports TEXT)')
            db.execute('INSERT INTO focus_manifest VALUES(?,?,?,?,?)', signature)
            db.commit()
            if db.execute('PRAGMA main.quick_check').fetchall() != [('ok',)]:
                raise ValueError('Invalid Vodafone Focus evidence')
        with open(temp, 'rb') as handle:
            os.fsync(handle.fileno())
        os.replace(temp, destination)
        os.fsync(dfd)
        return 'rebuilt'
    finally:
        if temp:
            Path(temp).unlink(missing_ok=True)
        os.close(dfd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--generation-dir', required=True, type=Path)
    parser.add_argument('--force', action='store_true', help='Atomically replace an existing projection')
    args = parser.parse_args()
    print(build_focus_evidence(args.generation_dir, args.force))
