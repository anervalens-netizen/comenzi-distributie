#!/usr/bin/env python3
"""Offline-only repair of an explicit SQLite copy. No host discovery or network."""
import argparse
import hashlib
import json
import pathlib
import sqlite3


def logical(c):
    return '\n'.join(c.iterdump())


def repair(database, backup, backup_sha256, plan, apply=False):
    if set(plan)-{'counties','merges'} or not (plan.get('counties') or plan.get('merges')):
        raise ValueError('Expected a nonempty counties/merges plan')
    database, backup = pathlib.Path(database).resolve(), pathlib.Path(backup).resolve()
    if database == backup or not backup.is_file():
        raise ValueError('A separate verified SQLite backup is required')
    if hashlib.sha256(backup.read_bytes()).hexdigest() != backup_sha256:
        raise ValueError('Backup checksum mismatch')
    c = sqlite3.connect(database.as_uri()+'?mode=rw', uri=True, timeout=1)
    b = sqlite3.connect(backup.as_uri()+'?mode=ro', uri=True)
    try:
        c.execute('PRAGMA foreign_keys=ON')
        c.execute('BEGIN IMMEDIATE')
        if b.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or logical(c) != logical(b):
            raise ValueError('Backup is corrupt or does not match the current database')
        raw_evidence = c.execute('SELECT address_id,source_json FROM crm_locations ORDER BY address_id').fetchall()
        before_orders = c.execute('SELECT id,payload FROM orders ORDER BY id').fetchall()
        c.execute('CREATE TABLE IF NOT EXISTS location_county_overrides(kind TEXT,id TEXT,county TEXT NOT NULL,PRIMARY KEY(kind,id))')
        c.execute('CREATE TABLE IF NOT EXISTS customer_identity_aliases(alias_id TEXT PRIMARY KEY REFERENCES customers(id),canonical_id TEXT NOT NULL REFERENCES customers(id),original_data TEXT NOT NULL)')
        for kind, table, idcol in [('customer', 'customers', 'id'), ('crm', 'crm_locations', 'address_id')]:
            # Enforce overrides on later imports without touching source_json.
            assignment = "data=json_set(data,'$.county',o.county)" if kind == 'customer' else 'county=o.county'
            for event in ['INSERT', 'UPDATE']:
                c.execute(f'''CREATE TRIGGER IF NOT EXISTS repair_{kind}_{event.lower()} AFTER {event} ON {table}
                WHEN EXISTS(SELECT 1 FROM location_county_overrides WHERE kind='{kind}' AND id=NEW.{idcol})
                BEGIN UPDATE {table} SET {assignment.replace('o.county', f"(SELECT county FROM location_county_overrides WHERE kind='{kind}' AND id=NEW.{idcol})")}
                WHERE {idcol}=NEW.{idcol} AND {"json_extract(data,'$.county')" if kind == 'customer' else 'county'} IS NOT (SELECT county FROM location_county_overrides WHERE kind='{kind}' AND id=NEW.{idcol}); END''')
        c.execute('''CREATE TRIGGER IF NOT EXISTS repair_alias_active AFTER UPDATE OF active ON customers
        WHEN NEW.active!=0 AND EXISTS(SELECT 1 FROM customer_identity_aliases WHERE alias_id=NEW.id)
        BEGIN UPDATE customers SET active=0 WHERE id=NEW.id; END''')
        c.execute('''CREATE TRIGGER IF NOT EXISTS repair_alias_insert AFTER INSERT ON customers
        WHEN NEW.active!=0 AND EXISTS(SELECT 1 FROM customer_identity_aliases WHERE alias_id=NEW.id)
        BEGIN UPDATE customers SET active=0 WHERE id=NEW.id; END''')
        report = {'countyCorrections': 0, 'merges': [], 'orderPayloadsUnchanged': True}
        for item in plan.get('counties', []):
            kind, ident, county = item['kind'], item['id'], item['county'].strip()
            if kind not in ('customer', 'crm') or not county:
                raise ValueError('Invalid county override')
            table, column = ('customers', 'id') if kind == 'customer' else ('crm_locations', 'address_id')
            if not c.execute(f'SELECT 1 FROM {table} WHERE {column}=?', (ident,)).fetchone():
                raise ValueError('Unknown correction ID')
            c.execute('INSERT INTO location_county_overrides VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET county=excluded.county', (kind, ident, county))
            if kind == 'customer':
                c.execute("UPDATE customers SET data=json_set(data,'$.county',?) WHERE id=?", (county, ident))
            else:
                c.execute('UPDATE crm_locations SET county=? WHERE address_id=?', (county, ident))
            report['countyCorrections'] += 1
        for item in plan.get('merges', []):
            source, target = item['from'], item['into']
            if source == target or c.execute('SELECT 1 FROM customer_identity_aliases WHERE alias_id IN (?,?) OR canonical_id=?', (source, target, source)).fetchone():
                raise ValueError('Alias cycles/chains or repeated merge refused')
            rows = [c.execute('SELECT data,active FROM customers WHERE id=?', (i,)).fetchone() for i in (source, target)]
            if any(not r or not r[1] for r in rows):
                raise ValueError('Both merge IDs must be active')
            old, canonical = [json.loads(r[0]) for r in rows]
            def cui(v):
                v = ''.join(x for x in v.upper() if x.isascii() and x.isalnum())
                return v[2:] if v.startswith('RO') else v
            if not cui(old.get('cui', '')) or cui(old.get('cui', '')) != cui(canonical.get('cui', '')):
                raise ValueError('Cross-company merge refused')
            for record in (old, canonical):
                record['historyFranchises'] = sorted(set(record.get('historyFranchises', []) + [v for v in [record.get('crm', {}).get('franchiseCode'), record.get('historyCatalog', {}).get('franchiseCode')] if v]))
            for field in ('warehouseIds', 'historyFranchises'):
                canonical[field] = sorted(set(canonical.get(field, []) + old.get(field, []) + ([old['warehouseId'], canonical['warehouseId']] if field == 'warehouseIds' else [])))
            # Retain every source row, profile, visit, CRM link and request under its
            # historical ID. Alias explicitly maps it to the active canonical ID.
            c.execute('INSERT INTO customer_identity_aliases VALUES(?,?,?)', (source, target, rows[0][0]))
            c.execute('UPDATE customers SET data=? WHERE id=?', (json.dumps(canonical, ensure_ascii=False), target))
            c.execute('UPDATE customers SET active=0 WHERE id=?', (source,))
            refs = [oid for oid, payload in before_orders if contains_id(json.loads(payload), source)]
            report['merges'].append({'alias': source, 'canonical': target, 'orderReferences': refs})
        if c.execute('SELECT address_id,source_json FROM crm_locations ORDER BY address_id').fetchall() != raw_evidence:
            raise ValueError('Raw CRM evidence changed')
        if c.execute('SELECT id,payload FROM orders ORDER BY id').fetchall() != before_orders:
            raise ValueError('Historical order payload changed')
        if c.execute('PRAGMA foreign_key_check').fetchall() or c.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError('Integrity assertion failed')
        if apply:
            c.commit()
        else:
            c.rollback()
        return {**report, 'applied': apply}
    except BaseException:
        c.rollback()
        raise
    finally:
        b.close()
        c.close()


def contains_id(value, ident):
    if isinstance(value, dict):
        return any(contains_id(v, ident) for v in value.values())
    if isinstance(value, list):
        return any(contains_id(v, ident) for v in value)
    return value == ident


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for key in ('database', 'backup', 'backup-sha256', 'plan'):
        p.add_argument('--'+key, required=True)
    p.add_argument('--apply', action='store_true')
    p.add_argument('--offline-copy', action='store_true', required=True, help='Acknowledge this is an offline copy with no application writers')
    a = p.parse_args()
    print(json.dumps(repair(a.database, a.backup, a.backup_sha256, json.loads(pathlib.Path(a.plan).read_text()), a.apply)))
