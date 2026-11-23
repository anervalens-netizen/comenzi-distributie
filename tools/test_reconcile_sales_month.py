import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from reconcile_sales_month import reconcile


class SalesReconciliation(unittest.TestCase):
    def test_active_revisions_partial_coverage_and_missing_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'client-history').mkdir()
            with closing(sqlite3.connect(root / 'sales.sqlite')) as seller:
                seller.executescript("""
                    CREATE TABLE sales_months(month,import_id,file_hash,imported_at);
                    CREATE TABLE sales_rows(import_id,date,value_cents,quantity);
                    INSERT INTO sales_months VALUES('2026-01',2,'seller-example','2026-01-31');
                    INSERT INTO sales_rows VALUES(1,'2026-01-01',900,9),
                        (2,'2026-01-01',100,1.25),(2,'2026-01-10',-40,-0.5);
                """)
            with closing(sqlite3.connect(root / 'client-history/client-sales-history.sqlite')) as partner:
                partner.executescript("""
                    CREATE TABLE history_imports(id,sha256,imported_at,period_start,period_end,state);
                    CREATE TABLE history_rows(import_id,date,value_cents,quantity_micros);
                    INSERT INTO history_imports VALUES
                        (1,'old','2026-01-05','2026-01-01','2026-01-05','superseded'),
                        (2,'current','2026-02-02','2026-01-03','2026-02-01','active');
                    INSERT INTO history_rows VALUES(1,'2026-01-03',900,9000000),
                        (2,'2026-01-03',100,1250000),(2,'2026-01-10',NULL,-500000),
                        (2,'2026-02-01',300,3000000);
                """)
            january = reconcile(root, '2026-01')
            self.assertEqual(january['partnerMinusSeller'], {
                'rows': 0, 'knownCents': 40, 'missingValues': 1, 'quantityMicros': 0})
            self.assertEqual(january['seller']['firstMovement'], '2026-01-01')
            self.assertEqual(january['partner']['firstMovement'], '2026-01-03')
            self.assertEqual([row['sha256'] for row in january['partnerSources']], ['current'])
            february = reconcile(root, '2026-02')
            self.assertIsNone(february['seller'])
            self.assertIsNone(february['partnerMinusSeller'])
            self.assertEqual(february['partner']['rows'], 1)
            self.assertIsNone(reconcile(root, '2026-03')['partner'])


if __name__ == '__main__':
    unittest.main()
