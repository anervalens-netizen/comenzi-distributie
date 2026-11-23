"""Compare one calendar month's active seller and partner imports, read-only."""
import argparse
import calendar
import datetime as dt
import json
import sqlite3
from contextlib import closing
from pathlib import Path


def reconcile(directory, month):
    start = dt.date.fromisoformat(month + '-01')
    end = start.replace(day=calendar.monthrange(start.year, start.month)[1])
    period = (start.isoformat(), end.isoformat())
    sources = {'seller': directory / 'sales.sqlite',
               'history': directory / 'client-history/client-sales-history.sqlite'}
    seller_import = None
    partner_imports = []
    with closing(sqlite3.connect(':memory:', uri=True)) as db:
        db.row_factory = sqlite3.Row
        available = set()
        for alias, path in sources.items():
            try:
                path.stat()
            except FileNotFoundError:
                continue
            db.execute('ATTACH DATABASE ? AS ?', (path.resolve().as_uri() + '?mode=ro', alias))
            available.add(alias)
        db.execute('PRAGMA query_only=ON')
        db.execute('BEGIN')
        if len(available) == 2:
            # Pin both snapshots in one statement before reading either source's lines.
            db.execute('SELECT (SELECT COUNT(*) FROM seller.sales_months),'
                       '(SELECT COUNT(*) FROM history.history_imports)').fetchone()
        if 'seller' in available:
            seller_import = db.execute('SELECT import_id, file_hash, imported_at '
                                       'FROM seller.sales_months WHERE month=?', (month,)).fetchone()
        if 'history' in available:
            partner_imports = db.execute("""
                SELECT sha256, imported_at, period_start, period_end FROM history.history_imports
                WHERE state='active' AND period_end>=? AND period_start<=? ORDER BY period_start, id
            """, period).fetchall()
        seller_totals = partner_totals = None
        if seller_import:
            seller_totals = dict(db.execute("""
                SELECT COUNT(*) rows, COALESCE(SUM(value_cents),0) knownCents,
                       COALESCE(SUM(value_cents IS NULL),0) missingValues,
                       COALESCE(SUM(CAST(ROUND(quantity*1000000) AS INTEGER)),0) quantityMicros,
                       MIN(date) firstMovement, MAX(date) lastMovement
                FROM seller.sales_rows WHERE import_id=? AND date BETWEEN ? AND ?
            """, (seller_import['import_id'], *period)).fetchone())
        if partner_imports:
            partner_totals = dict(db.execute("""
                SELECT COUNT(*) rows, COALESCE(SUM(r.value_cents),0) knownCents,
                       COALESCE(SUM(r.value_cents IS NULL),0) missingValues,
                       COALESCE(SUM(r.quantity_micros),0) quantityMicros,
                       MIN(r.date) firstMovement, MAX(r.date) lastMovement
                FROM history.history_rows r JOIN history.history_imports i ON i.id=r.import_id
                WHERE i.state='active' AND i.period_end>=? AND i.period_start<=?
                      AND r.date BETWEEN ? AND ?
            """, (*period, *period)).fetchone())
    differences = None
    if seller_totals is not None and partner_totals is not None:
        differences = {k: partner_totals[k] - seller_totals[k]
                       for k in ('rows', 'knownCents', 'missingValues', 'quantityMicros')}
    return {
        'month': month, 'seller': seller_totals, 'partner': partner_totals,
        'partnerMinusSeller': differences,
        'sellerSource': dict(seller_import) if seller_import else None,
        'partnerSources': [dict(row) for row in partner_imports],
    }


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True, type=Path)
    parser.add_argument('month', help='Calendar month (YYYY-MM)')
    args = parser.parse_args()
    try:
        print(json.dumps(reconcile(args.data_dir, args.month), indent=2))
    except (ValueError, sqlite3.Error) as error:
        parser.exit(1, f'{error}\n')
