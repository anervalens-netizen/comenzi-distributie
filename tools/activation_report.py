#!/usr/bin/env python3
"""Build an atomic, serial-free read model from the private activation ledger."""
import argparse
import fcntl
from activation_projection import build_details,validate_rules
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def build_report(directory, rules=None):
    validate_rules(rules)
    with (Path(directory) / ".activation-job.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _build_report(directory, rules)


def _build_report(directory, rules=None):
    root = Path(directory).resolve()
    source = sqlite3.connect((root / 'activations.sqlite').as_uri() + '?mode=ro', uri=True)
    temporary = None
    target = None
    try:
        source.execute('BEGIN')
        if source.execute("SELECT value FROM activation_meta WHERE key='schema_version'").fetchone() not in (('2',),('3',)):
            raise ValueError('Unsupported activation ledger')
        imports = source.execute("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").fetchall()
        schema = dict(source.execute('SELECT key,value FROM activation_meta'))['schema_version']
        # Determine TR relevance only after the whole movement ledger was reconciled.
        source.execute("CREATE TEMP TABLE tr_keys AS SELECT DISTINCT company,provider,serial FROM " + ("activation_effective_movements" if schema == "3" else "activation_movements") + " WHERE is_tr=1 AND serial<>''")
        source.execute('CREATE UNIQUE INDEX temp.tr_identity ON tr_keys(company,provider,serial)')
        with tempfile.NamedTemporaryFile(dir=root, prefix='.activation-report-', suffix='.sqlite', delete=False) as f:
            temporary = Path(f.name)
        target = sqlite3.connect(temporary)
        target.executescript('''
          CREATE TABLE report_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE monthly(month TEXT NOT NULL,item_type TEXT NOT NULL,site TEXT NOT NULL,count INTEGER NOT NULL,first_date TEXT,last_date TEXT,provider TEXT NOT NULL);
          CREATE INDEX monthly_scope ON monthly(provider,month,site);
          CREATE TABLE sites(site TEXT PRIMARY KEY,label TEXT NOT NULL);
        ''')
        rows = source.execute('''SELECT COALESCE(f.month,''),COALESCE(f.item_type,'OTHER'),COALESCE(f.candidate_site,''),COUNT(*),MIN(f.activation_date),MAX(f.activation_date),f.provider
          FROM activation_facts f JOIN tr_keys k USING(company,provider,serial)
          GROUP BY f.provider,f.month,f.item_type,f.candidate_site''')
        target.executemany('INSERT INTO monthly VALUES(?,?,?,?,?,?,?)', rows)
        if schema == '3': build_details(source,target)
        target.executemany('INSERT INTO sites VALUES(?,?)', source.execute("SELECT site,CASE WHEN COUNT(DISTINCT agent)=1 THEN MIN(agent) ELSE site END FROM activation_movements WHERE is_tr=1 AND site<>'' GROUP BY site"))
        meta = {'version': '4' if schema == '3' else '2', 'rules': json.dumps(rules,sort_keys=True,separators=(',',':')) if rules else '', 'sourceImports': json.dumps(imports, separators=(',', ':')),
                'latestDate': source.execute('SELECT MAX(activation_date) FROM activation_facts').fetchone()[0] or '',
                'sourcePeriods': json.dumps([{'from':r[0],'to':r[1]} for r in source.execute("SELECT period_start,period_end FROM activation_imports WHERE status='complete'")]) if schema == '3' else '[]',
                'sourceGeneration': dict(source.execute('SELECT key,value FROM activation_meta')).get('generation',''),
                'builtAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'importedAt': source.execute("SELECT COALESCE(MAX(imported_at),'') FROM activation_imports WHERE status='complete'").fetchone()[0]}
        target.executemany('INSERT INTO report_meta VALUES(?,?)', meta.items())
        target.commit()
        if target.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Invalid report database')
        counts = dict(target.execute("SELECT CASE WHEN month='' THEN 'undated' ELSE 'dated' END,SUM(count) FROM monthly GROUP BY 1"))
        target.close(); target = None
        with temporary.open('rb') as f:
            os.fsync(f.fileno())
        os.replace(temporary, root / 'activation-report.sqlite')
        temporary = None
        fd = os.open(root, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {'counts': counts, 'imports': len(imports), 'builtAt': meta['builtAt']}
    finally:
        source.close()
        if target:
            target.close()
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--rules',type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(build_report(args.data_dir,json.loads(args.rules.read_text()) if args.rules else None)))
