import json
import sqlite3
import unittest
import test_activations as fixtures
from activation_report import build_report, build_report_incremental, IncrementalReportUnavailable

row=fixtures.row

class IncrementalReportTests(unittest.TestCase):
    setUp=fixtures.ActivationsTests.setUp
    tearDown=fixtures.ActivationsTests.tearDown
    load=fixtures.ActivationsTests.load

    def identities(self):
        return (set(tuple(r) for r in self.c.execute('SELECT company,provider,serial FROM activation_movements WHERE serial<>\'\'')),
                set(tuple(r) for r in self.c.execute('SELECT company,provider,imei FROM activation_movements')),
                set(r[0] for r in self.c.execute('SELECT site FROM activation_movements WHERE is_tr=1 AND site<>\'\'')))

    def snapshot(self):
        c=sqlite3.connect(self.root/'data'/'activation-report.sqlite')
        try:
            tables=[r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            result={}
            for table in tables:
                rows=c.execute('SELECT * FROM '+table).fetchall()
                if table=='report_meta':rows=[r for r in rows if r[0]!='builtAt']
                result[table]=sorted(rows,key=repr)
            return result
        finally:c.close()

    def test_delta_matches_full_for_returns_conflicts_labels_and_extrema(self):
        self.load([row(),row(DocumentDetailId='TWO',IMEI='0000000000000000020',Activat='000000000000000002',DataActivare='20260325'),
                   row(DocumentDetailId='THREE',IMEI='0000000000000000030',Activat='000000000000000003',DataActivare='20260301',SiteCode='SITE-B')])
        build_report(self.root/'data')
        old_generation=self.c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]
        old=self.identities()
        self.load([row(DocumentDetailId='RETURN',DataVDF='20250101',TR='SEDIU CENTRAL',SiteCode='OFFICE',Qtty='-1'),
                   row(DocumentDetailId='RESALE',DataVDF='20250201',SiteCode='SITE-B'),
                   row(DocumentDetailId='TWO',IMEI='0000000000000000020',Activat='000000000000000002',DataActivare='20260425',TR='TR Other'),
                   row(DocumentDetailId='FOUR',IMEI='0000000000000000040',Activat='000000000000000004',DataActivare='20260215',SiteCode='SITE-B')])
        new=self.identities()
        delta={'full':False,'serials':{x for x in old[0]|new[0] if not x[2].endswith('003')},
               'imeis':{x for x in old[1]|new[1] if not x[2].endswith('030')}, 'sites':old[2]|new[2]}
        build_report_incremental(self.root/'data',delta,old_generation)
        incremental=self.snapshot()
        build_report(self.root/'data')
        self.assertEqual(incremental,self.snapshot())

    def test_distinct_null_and_empty_groups_keep_full_builder_semantics(self):
        self.load([row(),row(DocumentDetailId='TWO',IMEI='0000000000000000020',Activat='000000000000000002')])
        identities=self.identities()
        self.c.execute("UPDATE activation_facts SET month=NULL,candidate_site=NULL WHERE serial LIKE '%001'")
        self.c.execute("UPDATE activation_facts SET month='',candidate_site='' WHERE serial LIKE '%002'")
        self.c.commit();build_report(self.root/'data')
        generation=self.c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]
        self.c.execute("UPDATE activation_facts SET activation_date='2026-03-16' WHERE serial LIKE '%001'")
        self.c.execute("UPDATE activation_meta SET value='new-generation' WHERE key='generation'")
        self.c.commit()
        delta={'full':False,'serials':identities[0], 'imeis':identities[1], 'sites':identities[2]}
        build_report_incremental(self.root/'data',delta,generation)
        incremental=self.snapshot();build_report(self.root/'data')
        self.assertEqual(incremental,self.snapshot())

    def test_incompatible_generation_or_missing_auxiliary_rejects_without_mutation(self):
        self.load([row()]);build_report(self.root/'data')
        path=self.root/'data'/'activation-report.sqlite';before=path.read_bytes()
        delta={'full':False,'serials':set(),'imeis':set(),'sites':set()}
        with self.assertRaises(IncrementalReportUnavailable):build_report_incremental(self.root/'data',delta,'wrong')
        self.assertEqual(path.read_bytes(),before)
        c=sqlite3.connect(path);c.execute('DROP TABLE monthly_contributions');c.commit();c.close()
        before=path.read_bytes()
        generation=self.c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]
        with self.assertRaises(IncrementalReportUnavailable):build_report_incremental(self.root/'data',delta,generation)
        self.assertEqual(path.read_bytes(),before)

if __name__=='__main__':unittest.main()
