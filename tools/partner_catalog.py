"""Open the live, read-only partner catalog for owner-side reporting."""
import argparse
import calendar
from datetime import date
import json
import re
import sqlite3
from contextlib import contextmanager, closing
from pathlib import Path

SOURCES = {
    'crm': 'mobiup.sqlite',
    'history': 'client-history/client-sales-history.sqlite',
    'seller': 'sales.sqlite',
    'vodafone': 'activations/current/activations.sqlite',
    'digi': 'activations/digi/current/activations.sqlite',
}


def fiscal_key(value):
    """A numeric fiscal identifier. Free text, receipt labels and personal IDs stay separate."""
    raw = str(value or '').strip().upper()
    found = re.fullmatch(r'(?:RO\s*)?([0-9]{2,10})', raw)
    return found.group(1) if found else None


@contextmanager
def open_catalog(data_dir):
    paths = {key: (data_dir / value).resolve(strict=True) for key, value in SOURCES.items()}
    with closing(sqlite3.connect(':memory:', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.create_function('fiscal_key', 1, fiscal_key, deterministic=True)
        for name, path in paths.items():
            db.execute(f'ATTACH DATABASE ? AS {name}', (path.as_uri() + '?mode=ro',))
        # Pin all source reads before assembling the crosswalk, including the selected operator generations.
        db.execute('BEGIN')
        db.execute('SELECT ' + ','.join(f'(SELECT COUNT(*) FROM {s}.sqlite_schema)' for s in paths)).fetchone()
        if any((data_dir / SOURCES[s]).resolve() != path for s, path in paths.items()):
            raise RuntimeError('A source generation changed during open. Retry with a fresh catalog.')
        statements = Path(__file__).with_suffix('.sql').read_text()
        # executescript would commit the pinned read transaction.
        buffer = ''
        for line in statements.splitlines(keepends=True):
            buffer += line
            if sqlite3.complete_statement(buffer):
                db.execute(buffer)
                buffer = ''
        if buffer.strip():
            raise ValueError('Incomplete catalog SQL')
        db.execute('PRAGMA query_only=ON')
        yield db


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--data-dir', type=Path, required=True)
    group = p.add_mutually_exclusive_group()
    group.add_argument('--company', help='CRM PartnerId')
    group.add_argument('--franchise', help='Exact franchise code')
    group.add_argument('--month', help='Review active ERP sales by identity coverage for YYYY-MM')
    args = p.parse_args()
    with open_catalog(args.data_dir) as db:
        if args.company:
            rows = db.execute('SELECT * FROM catalog_points WHERE company_id=? ORDER BY point_key', (args.company,))
        elif args.franchise:
            rows = db.execute('SELECT * FROM catalog_points WHERE franchise_code=?', (args.franchise,))
        elif args.month:
            try:
                start = date.fromisoformat(args.month + '-01')
            except ValueError:
                p.error('Use a calendar month in YYYY-MM format')
            end = start.replace(day=calendar.monthrange(start.year, start.month)[1])
            rows = db.execute('''SELECT evidence, COUNT(*) line_count, SUM(value_cents) known_cents,
                SUM(value_cents IS NULL) missing_values, SUM(quantity_micros) quantity_micros
                FROM catalog_erp_sales WHERE date BETWEEN ? AND ? GROUP BY evidence ORDER BY evidence''',
                (start.isoformat(), end.isoformat()))
        else:
            rows = db.execute("""SELECT (SELECT COUNT(*) FROM catalog_companies) companies,
                (SELECT COUNT(*) FROM catalog_points WHERE source='crm') crm_points,
                (SELECT COUNT(*) FROM catalog_points WHERE source='portfolio') portfolio_only_points,
                (SELECT COUNT(*) FROM catalog_erp_identity) erp_identities""")
        print(json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
