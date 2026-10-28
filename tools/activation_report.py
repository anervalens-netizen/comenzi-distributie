#!/usr/bin/env python3
"""Build an atomic, serial-free read model from the private activation ledger."""
import argparse
import fcntl
from activation_versions import FACTS_VERSION
from activation_projection import build_details,validate_rules,insert_details,insert_cohorts
import hashlib
import shutil
import datetime as dt
import json
import os
from pathlib import Path
import sqlite3
import tempfile


class IncrementalReportUnavailable(ValueError):
    pass


def _identity(*parts):
    return hashlib.sha256(json.dumps(list(parts),separators=(',',':')).encode()).hexdigest()


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
        facts_version=dict(source.execute('SELECT key,value FROM activation_meta')).get('facts_version','')
        if schema=='3' and facts_version!=FACTS_VERSION:
            raise ValueError('Activation facts require semantic rebuild through activation_job')
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
        if schema == '3':
            target.execute('CREATE TABLE monthly_contributions(id TEXT PRIMARY KEY,provider TEXT NOT NULL,month TEXT,item_type TEXT,site TEXT,activation_date TEXT)')
            target.execute("CREATE INDEX monthly_contribution_scope ON monthly_contributions(provider,COALESCE(month,''),COALESCE(item_type,'OTHER'),COALESCE(site,''))")
            for f in source.execute("SELECT f.company,f.provider,f.serial,f.month,f.item_type,f.candidate_site,f.activation_date FROM activation_facts f JOIN tr_keys k USING(company,provider,serial)"):
                target.execute('INSERT INTO monthly_contributions VALUES(?,?,?,?,?,?)', (_identity(*f[:3]),f[1],*f[3:]))
        if schema == '3': build_details(source,target)
        target.executemany('INSERT INTO sites VALUES(?,?)', source.execute("SELECT site,CASE WHEN COUNT(DISTINCT agent)=1 THEN MIN(agent) ELSE site END FROM activation_movements WHERE is_tr=1 AND site<>'' GROUP BY site"))
        meta = {'version': '4' if schema == '3' else '2', 'rules': json.dumps(rules,sort_keys=True,separators=(',',':')) if rules else '', 'sourceImports': json.dumps(imports, separators=(',', ':')),
                'latestDate': source.execute('SELECT MAX(activation_date) FROM activation_facts').fetchone()[0] or '',
                'sourcePeriods': json.dumps([{'from':r[0],'to':r[1]} for r in source.execute("SELECT period_start,period_end FROM activation_imports WHERE status='complete'")]) if schema == '3' else '[]',
                'sourceGeneration': dict(source.execute('SELECT key,value FROM activation_meta')).get('generation',''),
                'factsVersion': facts_version,
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


def build_report_incremental(directory, delta, expected_generation, rules=None):
    """Update an existing schema-3 projection for a closed ledger delta.

    The caller must supply all old/new serials, IMEIs and raw TR sites, including
    transitive attribution dependencies. A full reconciliation must use build_report.
    The expected generation is the source generation represented by the old report.
    """
    validate_rules(rules)
    if delta.get('full'):
        raise IncrementalReportUnavailable('Full reconciliation requires a full report rebuild')
    root=Path(directory).resolve()
    with (root / '.activation-job.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        return _build_report_incremental(root,delta,expected_generation,rules)


def _build_report_incremental(root,delta,expected_generation,rules):
    serials=set(delta['serials']); imeis=set(delta['imeis']); sites=set(delta['sites'])
    if any(len(v)!=3 or not all(isinstance(x,str) for x in v) for v in serials | imeis):
        raise ValueError('Invalid affected identities')
    if any(not isinstance(v,str) for v in sites):raise ValueError('Invalid affected sites')
    old=root/'activation-report.sqlite'
    source=sqlite3.connect((root/'activations.sqlite').as_uri()+'?mode=ro',uri=True)
    target=None; temporary=None
    try:
        source.execute('BEGIN')
        smeta=dict(source.execute('SELECT key,value FROM activation_meta'))
        if smeta.get('schema_version')!='3' or smeta.get('facts_version')!=FACTS_VERSION:
            raise ValueError('Unsupported source or facts version')
        with tempfile.NamedTemporaryFile(dir=root,prefix='.activation-report-',suffix='.sqlite',delete=False) as f:
            temporary=Path(f.name)
        shutil.copyfile(old,temporary)
        target=sqlite3.connect(temporary)
        meta=dict(target.execute('SELECT key,value FROM report_meta'))
        rules_json=json.dumps(rules,sort_keys=True,separators=(',',':')) if rules else ''
        if (not expected_generation or meta.get('sourceGeneration')!=expected_generation or
            meta.get('version')!='4' or meta.get('factsVersion')!=FACTS_VERSION or meta.get('rules')!=rules_json):
            raise IncrementalReportUnavailable('Incremental report generation, version or rules mismatch; rebuild required')
        if not target.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='monthly_contributions'").fetchone():
            raise IncrementalReportUnavailable('Incremental report migration required; full rebuild required')
        imports=source.execute("SELECT sha256,operator,row_count,parser_version FROM activation_imports WHERE status='complete' ORDER BY sha256").fetchall()
        if not set(map(tuple,json.loads(meta['sourceImports']))).issubset(set(imports)):
            raise IncrementalReportUnavailable('Report source imports are not a subset; full rebuild required')
        target.execute('BEGIN')
        monthly_keys=set(); dimension_keys=set()
        dimcols='provider,month,site,item_type,county,handset,contradictory,is_tr'
        for identity in serials:
            ident=_identity(*identity)
            monthly_keys.update(target.execute("SELECT provider,COALESCE(month,''),COALESCE(item_type,'OTHER'),COALESCE(site,'') FROM monthly_contributions WHERE id=?",(ident,)).fetchall())
            dimension_keys.update(target.execute('SELECT '+dimcols+' FROM details WHERE id=?',(ident,)).fetchall())
            target.execute('DELETE FROM monthly_contributions WHERE id=?',(ident,))
            target.execute('DELETE FROM details WHERE id=?',(ident,))
            row=source.execute("""SELECT f.provider,f.month,f.item_type,f.candidate_site,f.activation_date
                FROM activation_facts f WHERE f.company=? AND f.provider=? AND f.serial=?
                AND EXISTS(SELECT 1 FROM activation_effective_movements m WHERE m.company=f.company AND m.provider=f.provider AND m.serial=f.serial AND m.is_tr=1)""",identity).fetchone()
            if row:
                target.execute('INSERT INTO monthly_contributions VALUES(?,?,?,?,?,?)',(ident,*row))
                monthly_keys.add((row[0],row[1] if row[1] is not None else '',row[2] if row[2] is not None else 'OTHER',row[3] if row[3] is not None else ''))
            insert_details(source,target,' WHERE f.company=? AND f.provider=? AND f.serial=?',identity)
            dimension_keys.update(target.execute('SELECT '+dimcols+' FROM details WHERE id=?',(ident,)).fetchall())
        for identity in imeis:
            target.execute('DELETE FROM cohorts WHERE id=?',(_identity(*identity),))
            insert_cohorts(source,target,' WHERE company=? AND provider=? AND imei=?',identity)
        for site in sites:
            if not site:continue
            target.execute('DELETE FROM sites WHERE site=?',(site,))
            row=source.execute("SELECT site,CASE WHEN COUNT(DISTINCT agent)=1 THEN MIN(agent) ELSE site END FROM activation_movements WHERE is_tr=1 AND site=? GROUP BY site",(site,)).fetchone()
            if row:target.execute('INSERT INTO sites VALUES(?,?)',tuple(row))
        for key in monthly_keys:
            target.execute('DELETE FROM monthly WHERE provider IS ? AND month IS ? AND item_type IS ? AND site IS ?',key)
            rows=target.execute("SELECT COUNT(*),MIN(activation_date),MAX(activation_date) FROM monthly_contributions WHERE provider IS ? AND COALESCE(month,'') IS ? AND COALESCE(item_type,'OTHER') IS ? AND COALESCE(site,'') IS ? GROUP BY month,item_type,site",key).fetchall()
            for row in rows:target.execute('INSERT INTO monthly VALUES(?,?,?,?,?,?,?)',(key[1],key[2],key[3],*row,key[0]))
        where=' AND '.join(col+' IS ?' for col in dimcols.split(','))
        for key in dimension_keys:
            target.execute('DELETE FROM dimension_monthly WHERE '+where,key)
            row=target.execute('SELECT COUNT(*),MAX(activation_date) FROM details WHERE '+where,key).fetchone()
            if row[0]:target.execute('INSERT INTO dimension_monthly VALUES('+','.join('?'*10)+')',(*key,*row))
        meta.update({'sourceImports':json.dumps(imports,separators=(',',':')),
            'latestDate':source.execute('SELECT MAX(activation_date) FROM activation_facts').fetchone()[0] or '',
            'sourcePeriods':json.dumps([{'from':r[0],'to':r[1]} for r in source.execute("SELECT period_start,period_end FROM activation_imports WHERE status='complete'")]),
            'sourceGeneration':smeta.get('generation',''), 'factsVersion':smeta['facts_version'],
            'builtAt':dt.datetime.now(dt.timezone.utc).isoformat(),
            'importedAt':source.execute("SELECT COALESCE(MAX(imported_at),'') FROM activation_imports WHERE status='complete'").fetchone()[0]})
        if not meta['sourceGeneration']:raise ValueError('Missing source generation')
        target.executemany('INSERT OR REPLACE INTO report_meta VALUES(?,?)',meta.items())
        target.commit()
        counts=dict(target.execute("SELECT CASE WHEN month='' THEN 'undated' ELSE 'dated' END,SUM(count) FROM monthly GROUP BY 1"))
        target.close();target=None
        with temporary.open('rb') as f:os.fsync(f.fileno())
        os.replace(temporary,old);temporary=None
        fd=os.open(root,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
        return {'counts':counts,'imports':len(imports),'builtAt':meta['builtAt'],'mode':'incremental'}
    finally:
        source.close()
        if target:target.close()
        if temporary:temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--rules',type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    print(json.dumps(build_report(args.data_dir,json.loads(args.rules.read_text()) if args.rules else None)))
