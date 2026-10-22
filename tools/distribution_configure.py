#!/usr/bin/env python3
"""Apply explicit private reporting rules and additive geographic memberships with recovery."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import os
from client_catalog_plan import county_key


def configure(application,rules,recovery,*,add_counties=None):
    path=Path(application).resolve();recovery=Path(recovery).resolve()
    if path==recovery or recovery.exists():raise ValueError('A new recovery path is required')
    if rules.get('version')!=1 or rules.get('history')!='all' or not rules.get('revision'):raise ValueError('Invalid rules')
    c=sqlite3.connect(path);c.row_factory=sqlite3.Row
    backup=None
    try:
        # Reserve the writer while snapshotting through a separate read connection.
        c.execute('BEGIN IMMEDIATE')
        source=sqlite3.connect(path.as_uri()+'?mode=ro',uri=True);backup=sqlite3.connect(recovery)
        try:source.backup(backup)
        finally:source.close()
        if backup.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('Invalid recovery copy')
        backup.close();backup=None;os.chmod(recovery,0o600)
        ids=set();sites=set()
        for a in rules['assignments']:
            user=c.execute("SELECT site_code FROM users WHERE id=? AND role='agent' AND active=1",(a['userId'],)).fetchone()
            if not user or user['site_code'].strip().upper()!=a['siteCode'].upper() or a['userId'] in ids or a['siteCode'].upper() in sites:raise ValueError('Stale or ambiguous assignment')
            if c.execute("SELECT COUNT(*) FROM users WHERE role='agent' AND UPPER(TRIM(site_code))=?",(a['siteCode'].upper(),)).fetchone()[0]!=1:raise ValueError('Shared historical site')
            ids.add(a['userId']);sites.add(a['siteCode'].upper())
        previous=c.execute("SELECT value FROM settings WHERE key='distribution-rules-v1'").fetchone()
        if previous:
            old=json.loads(previous[0])
            if old['revision']==rules['revision'] and old!=rules:raise ValueError('Changed rules require a new revision')
            c.execute('INSERT OR IGNORE INTO settings VALUES(?,?)',('distribution-rules-archive:'+old['revision'],previous[0]))
        changed=[]
        for agent_id,counties in (add_counties or {}).items():
            user=c.execute("SELECT warehouse_id FROM users WHERE id=? AND role='agent' AND active=1",(agent_id,)).fetchone()
            assignment=next((a for a in rules['assignments'] if a['userId']==agent_id),None)
            if not user or not user[0] or not assignment or any(county_key(raw) not in assignment['counties'] for raw in counties):raise ValueError('Unverified county assignment')
            counties={county_key(raw) for raw in counties}
            for row in c.execute('SELECT id,warehouse_id,data FROM customers WHERE active=1').fetchall():
                p=json.loads(row['data'])
                if county_key(p.get('county','')) not in counties:continue
                members=p.get('warehouseIds',[row['warehouse_id']])
                if user[0] in members:continue
                p['warehouseIds']=sorted(set(members+[user[0]]))
                c.execute('UPDATE customers SET data=? WHERE id=?',(json.dumps(p,ensure_ascii=False,separators=(',',':')),row['id']))
                changed.append(row['id'])
        c.execute("INSERT INTO settings VALUES('distribution-rules-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(rules,ensure_ascii=False,separators=(',',':')),))
        if c.execute('PRAGMA foreign_key_check').fetchall():raise ValueError('Foreign key violation')
        c.commit()
        return {'rulesRevision':rules['revision'],'addedMemberships':len(changed),'recoverySha256':hashlib.sha256(recovery.read_bytes()).hexdigest()}
    except BaseException:c.rollback();raise
    finally:
        if backup:backup.close()
        c.close()

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--application',type=Path,required=True);p.add_argument('--rules',type=Path,required=True);p.add_argument('--recovery',type=Path,required=True);p.add_argument('--add-counties',type=Path)
    a=p.parse_args();os.umask(0o077)
    print(json.dumps(configure(a.application,json.loads(a.rules.read_text()),a.recovery,add_counties=json.loads(a.add_counties.read_text()) if a.add_counties else None)))
