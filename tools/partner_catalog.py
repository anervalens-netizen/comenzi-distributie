"""Open the live, read-only partner catalog for owner-side reporting."""
import argparse
import calendar
from datetime import date
import json
import os
import re
import sqlite3
from contextlib import contextmanager, closing
from pathlib import Path

SOURCES = {
    'crm': 'mobiup.sqlite',
    'history': 'client-history/client-sales-history.sqlite',
    'seller': 'sales.sqlite',
}


def fiscal_key(value):
    """A numeric fiscal identifier. Free text, receipt labels and personal IDs stay separate."""
    raw = str(value or '').strip().upper()
    found = re.fullmatch(r'(?:RO\s*)?([0-9]{2,10})', raw)
    return found.group(1) if found else None


def ledger_path(network):
    pointer = network / 'current'
    if pointer.is_symlink():
        generation = pointer.resolve(strict=True)
        if generation.parent != (network / 'generations').resolve():
            raise ValueError('Invalid operator generation location')
        return generation / 'activations.sqlite'
    if pointer.exists():
        raise ValueError('Invalid operator generation pointer')
    return network / 'activations.sqlite'


@contextmanager
def open_catalog(data_dir, activations_dir=None):
    root = Path(activations_dir or os.environ.get('MOBIUP_ACTIVATIONS_DIR') or data_dir).resolve()
    def inputs():
        return {**{k: (data_dir / v).resolve() for k,v in SOURCES.items()},
                'vodafone': ledger_path(root), 'digi': ledger_path(root / 'digi')}
    paths = inputs()
    present = {key: path for key, path in paths.items() if path.is_file()}
    if 'crm' not in present:
        raise FileNotFoundError(paths['crm'])
    with closing(sqlite3.connect(':memory:', uri=True)) as db:
        db.row_factory = sqlite3.Row
        db.create_function('fiscal_key', 1, fiscal_key, deterministic=True)
        for name, path in present.items():
            db.execute(f'ATTACH DATABASE ? AS {name}', (path.as_uri() + '?mode=ro',))
        # Pin all source reads before assembling the crosswalk, including the selected operator generations.
        db.execute('BEGIN')
        db.execute('SELECT ' + ','.join(f'(SELECT COUNT(*) FROM {s}.sqlite_schema)' for s in present)).fetchone()
        if inputs() != paths:
            raise RuntimeError('A source generation changed during open. Retry with a fresh catalog.')
        db.execute('CREATE TEMP TABLE catalog_sources(register TEXT PRIMARY KEY,available INTEGER NOT NULL)')
        db.executemany('INSERT INTO catalog_sources VALUES (?,?)', [(key,int(key in present)) for key in paths])
        if db.execute("SELECT 1 FROM crm.sqlite_schema WHERE type='table' AND name='customer_identity_aliases'").fetchone():
            db.execute('CREATE TEMP VIEW catalog_aliases AS SELECT alias_id,canonical_id FROM crm.customer_identity_aliases')
        else:
            db.execute('CREATE TEMP VIEW catalog_aliases AS SELECT NULL alias_id,NULL canonical_id WHERE 0')
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
    p.add_argument('--activations-dir', type=Path, help='Operator root, defaults to MOBIUP_ACTIVATIONS_DIR or the data directory')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--company', help='CRM PartnerId')
    group.add_argument('--franchise', help='Exact franchise code')
    group.add_argument('--month', help='Review active ERP sales by identity coverage for YYYY-MM')
    group.add_argument('--trace-identity', type=int, nargs='+', metavar='ERP_ID',
                       help='Corroborate active ERP document parties using historical Vodafone movements')
    args = p.parse_args()
    with open_catalog(args.data_dir, args.activations_dir) as db:
        available = {r[0] for r in db.execute('SELECT register FROM catalog_sources WHERE available=1')}
        required = {'history','vodafone'} if args.trace_identity else {'history'} if args.month else set()
        if required - available:
            p.error('Missing source registers: ' + ', '.join(sorted(required - available)))
        if args.trace_identity:
            from partner_catalog_trace import trace_documents
            rows = trace_documents(db, args.trace_identity)
        elif args.company:
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
            history_count = "(SELECT COUNT(*) FROM catalog_erp_identity)" if "history" in available else "NULL"
            rows = db.execute(f"""SELECT (SELECT COUNT(*) FROM catalog_companies) companies,
                (SELECT COUNT(*) FROM catalog_points WHERE source='crm') crm_points,
                (SELECT COUNT(*) FROM catalog_points WHERE source='portfolio') portfolio_only_points,
                {history_count} erp_identities""")
        print(json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
