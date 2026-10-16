import json
import sqlite3
import unittest
import test_activations as fixtures
row = fixtures.row
from activation_report import build_report


class ReportTests(unittest.TestCase):
    setUp = fixtures.ActivationsTests.setUp
    tearDown = fixtures.ActivationsTests.tearDown
    load = fixtures.ActivationsTests.load
    def test_reporting_counts_activation_once_and_retains_unassigned(self):
        self.load([row(), row(DocumentDetailId='R', DataVDF='20250101', Qtty='-1', TR='SEDIU CENTRAL'),
                   row(DocumentDetailId='S', DataVDF='20250201', SiteCode='SITE-B'),
                   row(DocumentDetailId='U',IMEI='0000000000000000020',Activat='000000000000000002'),
                   row(DocumentDetailId='UR',IMEI='0000000000000000020',Activat='000000000000000002',Qtty='-1',DataVDF='20260401'),
                   row(DocumentDetailId='NONTR',IMEI='0000000000000000030',Activat='000000000000000003',TR='SEDIU CENTRAL')])
        result=build_report(self.root/'data')
        self.assertEqual(result['counts'],{'dated':2})
        c=sqlite3.connect(self.root/'data'/'activation-report.sqlite')
        try:
            self.assertEqual(c.execute('SELECT site,count FROM monthly ORDER BY site').fetchall(),[('',1),('SITE-B',1)])
            self.assertEqual(c.execute('SELECT DISTINCT month FROM monthly').fetchall(),[('2026-03',)])
            self.assertNotIn('serial',[r[1] for r in c.execute('PRAGMA table_info(monthly)')])
            imports=json.loads(c.execute("SELECT value FROM report_meta WHERE key='sourceImports'").fetchone()[0])
            self.assertEqual(len(imports),1)
        finally:c.close()
        self.assertEqual(build_report(self.root/'data')['counts'],result['counts'])

if __name__=='__main__':unittest.main()
