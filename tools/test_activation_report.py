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

    def test_activation_before_distribution_keeps_the_same_serial_in_the_cohort(self):
        self.load([row(DataVDF='20261010',DataActivare='20261001',ItemCode='ZERO')])
        f=self.c.execute('SELECT status,reasons FROM activation_facts').fetchone()
        self.assertEqual(f['status'],'unresolved');self.assertEqual(json.loads(f['reasons']),['post_activation_movement_rule_pending'])
        build_report(self.root/'data')
        c=sqlite3.connect(self.root/'data'/'activation-report.sqlite')
        try:self.assertEqual(c.execute('SELECT COUNT(*),SUM(activated) FROM cohorts').fetchone(),(1,1))
        finally:c.close()

    def test_stale_semantics_never_publish_a_fresh_looking_report(self):
        self.load([row()]);build_report(self.root/'data')
        report=self.root/'data'/'activation-report.sqlite';before=report.read_bytes()
        self.c.execute("DELETE FROM activation_meta WHERE key='facts_version'");self.c.commit()
        with self.assertRaisesRegex(ValueError,'semantic rebuild'):build_report(self.root/'data')
        self.assertEqual(report.read_bytes(),before)

if __name__=='__main__':unittest.main()
