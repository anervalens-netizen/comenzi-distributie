"""Synthetic positive-document chronology and targeted existing-ledger upgrade."""
import json,sqlite3,unittest
import activations as a
import activation_job as job
import activation_report as report
import test_activations as f

class ChronologyTests(unittest.TestCase):
    setUp=f.ActivationsTests.setUp
    tearDown=f.ActivationsTests.tearDown
    fact=f.ActivationsTests.fact
    load=f.ActivationsTests.load

    def test_later_positive_document_remains_assignable(self):
        self.load([f.row(DataVDF='20260401')])
        self.assertEqual(self.fact()['candidate_site'],'SITE-A')
        self.assertEqual(self.fact()['month'],'2026-03')
        self.assertNotIn('post_activation_movement_rule_pending',self.fact()['reasons'])

    def test_later_return_still_blocks_beneficiary(self):
        self.load([f.row(),f.row(DataVDF='20260401',Qtty='-1',DocumentDetailId='RETURN'),
                   f.row(DataVDF='20260402',SiteCode='SITE-B',DocumentDetailId='RESALE')])
        self.assertIsNone(self.fact()['candidate_site'])
        self.assertIn('post_activation_movement_rule_pending',self.fact()['reasons'])

    def test_two_positive_sales_never_selected_arbitrarily(self):
        self.load([f.row(DataVDF='20260401'),f.row(DataVDF='20260402',DocumentDetailId='OTHER',SiteCode='SITE-B')])
        self.assertIsNone(self.fact()['candidate_site'])
        self.assertIn('non_unique_remaining_sale',self.fact()['reasons'])

    def test_empty_batch_upgrades_only_old_blocked_components_and_report(self):
        self.load([f.row(DataVDF='20260401')])
        # Reproduce a pre-fix fact and its read model without changing raw history.
        self.c.execute("UPDATE activation_facts SET candidate_site=NULL,status='unresolved',reasons=?",(json.dumps(["post_activation_movement_rule_pending"]),))
        self.c.execute("DELETE FROM activation_meta WHERE key='chronology_policy_version'");self.c.commit()
        report.build_report(self.root/'data')
        before=self.c.execute('SELECT * FROM activation_movements').fetchall()
        result=job.run_job(self.root/'data',[])
        self.assertEqual(result['report'].get('mode'),'incremental')
        active=self.root/'data/generations'/result['generation'];c=sqlite3.connect(active/'activations.sqlite');c.row_factory=sqlite3.Row
        try:
            self.assertEqual(c.execute('SELECT candidate_site FROM activation_facts').fetchone()[0],'SITE-A')
            self.assertEqual([tuple(r) for r in before],[tuple(r) for r in c.execute('SELECT * FROM activation_movements')])
            generation=c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0]
            c.execute('BEGIN IMMEDIATE');delta=a.reconcile_imports(c,[]);c.commit()
            self.assertFalse(delta['serials'])
            self.assertEqual(c.execute("SELECT value FROM activation_meta WHERE key='generation'").fetchone()[0],generation)
            incremental=sqlite3.connect(active/'activation-report.sqlite')
            snap={t:sorted(incremental.execute('SELECT * FROM '+t).fetchall(),key=repr) for t in ['monthly','monthly_contributions','details','dimension_monthly','cohorts']}
            incremental.close()
            report.build_report(active)
            full=sqlite3.connect(active/'activation-report.sqlite')
            try:
                for t,rows in snap.items():self.assertEqual(rows,sorted(full.execute('SELECT * FROM '+t).fetchall(),key=repr))
            finally:full.close()
        finally:c.close()

    def test_digi_positive_booking_after_operator_activation(self):
        p=f.fixture(self.root/'digi.xlsx',[f.digi_row(Data='2026-04-01')],headers=a.DIGI_HEADERS,header_row=1)
        a.import_files(self.c,self.root/'data',[p],operator='digi',site_aliases={('ExampleCo','TR Example'):'SITE-A'})
        self.assertEqual(self.fact()['candidate_site'],'SITE-A')
        self.assertEqual(self.fact()['month'],'2026-03')

    def legacy_upgrade(self):
        self.c.execute("UPDATE activation_facts SET candidate_site=NULL,status='unresolved',reasons=?",(json.dumps(['post_activation_movement_rule_pending']),))
        self.c.execute("DELETE FROM activation_meta WHERE key='chronology_policy_version'");self.c.commit()
        self.c.execute('BEGIN IMMEDIATE');delta=a.reconcile_imports(self.c,[]);self.c.commit()
        self.assertEqual(self.fact()['candidate_site'],'SITE-A')
        self.assertTrue(delta['imeis'])

    def test_digi_operator_blank_internal_serial_policy_upgrade(self):
        import test_digi_operator as d
        self.aliases=d.DigiOperatorTests.aliases
        d.DigiOperatorTests.internal(self,[f.digi_row(Activat='',DataDigi='',Data='2026-10-16')])
        d.DigiOperatorTests.operator(self,[d.DigiOperatorTests.official(self)])
        self.legacy_upgrade()

    def test_vodafone_operator_blank_internal_serial_policy_upgrade(self):
        import test_activation_versions as v
        v.VersionTests.revision(self,[f.row(Activat='',DataActivare='',DataVDF='20261016')],'2026-10-29')
        v.VersionTests.operator(self,[v.VersionTests.official(self)])
        self.legacy_upgrade()

if __name__=='__main__':unittest.main()
