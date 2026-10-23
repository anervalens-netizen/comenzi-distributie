"""Synthetic acceptance for append-only movement revisions and independent operator evidence."""
import gzip
import json
import sqlite3
import unittest
import activations as a
import test_activations as f

class VersionTests(f.ActivationsTests):
    # Inherit the original acceptance matrix as well.
    def revision(self, rows, at='', **options):
        self.n+=1
        path=f.fixture(self.root/f'revision-{self.n}.xlsx',rows)
        return a.import_files(self.c,self.root/'data',[path],operator='vodafone',source_at=at,**options)

    def operator(self,records,at='2026-10-21',company='ExampleCo'):
        self.n+=1;path=self.root/f'operator-{self.n}.json.gz'
        with gzip.open(path,'wt') as out:json.dump(records,out)
        return a.import_files(self.c,self.root/'data',[path],operator='vodafone',source_kind='operator',company=company,source_at=at,period_start='2026-10-01',period_end='2026-10-20')

    def official(self,**changes):
        value=dict(SerieText='000000000000000001',DATE_OF_ACTIVATION='2026-10-15',COUNTY_OF_ACTIVATION='ARGES',**{'Paid SIM Category':'SIM Zero with Recharge >= 5E'})
        value.update(changes);return value

    def test_activation_update_is_one_movement_and_older_source_cannot_reverse_it(self):
        self.revision([f.row(Activat='',DataActivare='')],'2026-09-01')
        self.revision([f.row(DataActivare='20261015')],'2026-10-21')
        self.revision([f.row(Activat='',DataActivare='',Furnizor='Older provenance')],'2026-08-01')
        fact=self.fact();self.assertEqual(fact['net_quantity'],1);self.assertEqual(fact['month'],'2026-10');self.assertEqual(fact['candidate_site'],'SITE-A')
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM activation_effective_movements').fetchone()[0],1)
        self.assertEqual(len(json.loads(fact['evidence_json'])['versionIds']),3)

    def test_commercial_correction_requires_unique_revision(self):
        self.revision([f.row()],'2026-09-01')
        self.revision([f.row(SiteCode='SITE-B')],'2026-10-21')
        self.assertEqual(self.fact()['candidate_site'],'SITE-B');self.assertEqual(self.fact()['net_quantity'],1)
        self.revision([f.row(SiteCode='SITE-C')],'2026-10-21')
        self.assertIn('changed_source_movement',self.fact()['reasons']);self.assertIsNone(self.fact()['candidate_site'])

    def test_operator_activates_pre2026_without_inventing_serial(self):
        self.revision([f.row(Activat='',DataActivare='')])
        self.assertEqual(a.summary(self.c)['facts'],0)
        self.operator([self.official()]);fact=self.fact()
        self.assertEqual(fact['month'],'2026-10');self.assertEqual(fact['candidate_site'],'SITE-A')
        ev=json.loads(fact['evidence_json']);self.assertEqual(ev['observation']['county'],'ARGES');self.assertIn('importId',ev['observationSources']['serial'][0])

    def test_operator_missing_values_preserve_internal_and_absence_preserves_facts(self):
        self.revision([f.row(DataActivare='20261015',JudetActivare='TIMIS',HandSetType='SIM with initial credit >= 3 EUR')])
        self.operator([self.official(COUNTY_OF_ACTIVATION='<UNASSIGNED>')])
        self.assertEqual(json.loads(self.fact()['evidence_json'])['observation']['county'],'TIMIS')
        self.operator([self.official(SerieText='000000000000000002')],at='2026-10-22')
        self.assertEqual(a.summary(self.c)['facts'],2)
        self.assertEqual(self.c.execute("SELECT month FROM activation_facts WHERE serial='000000000000000001'").fetchone()[0],'2026-10')
        self.assertIn('operator_without_distribution',self.c.execute("SELECT reasons FROM activation_facts WHERE serial='000000000000000002'").fetchone()[0])

    def test_date_county_correction_and_late_old_operator(self):
        self.revision([f.row()])
        self.operator([self.official()])
        self.operator([self.official(DATE_OF_ACTIVATION='2026-10-16',COUNTY_OF_ACTIVATION='COVASNA')],at='2026-10-22')
        self.operator([self.official(DATE_OF_ACTIVATION='2026-09-01')],at='2026-10-20')
        fact=self.fact();self.assertEqual(fact['activation_date'],'2026-10-16');self.assertEqual(json.loads(fact['evidence_json'])['observation']['county'],'COVASNA');self.assertEqual(fact['net_quantity'],1)

    def test_explicit_handset_dash_supersedes_eligible_history_but_missing_does_not(self):
        eligible='SIM with initial credit >= 3 EUR'
        self.revision([f.row(DataActivare='20261015',JudetActivare='ARGES',HandSetType=eligible)],'2026-10-20')
        self.operator([self.official(**{'Paid SIM Category':eligible})],at='2026-10-21')
        self.operator([self.official(COUNTY_OF_ACTIVATION='-',**{'Paid SIM Category':'-'})],at='2026-10-22')
        evidence=json.loads(self.fact()['evidence_json'])
        self.assertEqual(evidence['observation']['handset'],'-')
        self.assertEqual(evidence['observation']['county'],'ARGES')
        source=evidence['observationSources']['handset']
        self.assertEqual(len(source),1)
        selected=self.c.execute('SELECT handset,source_at FROM activation_observations o JOIN activation_imports i ON i.id=o.import_id WHERE o.import_id=? AND o.source_row=?',(source[0]['importId'],source[0]['row'])).fetchone()
        self.assertEqual(tuple(selected),('-','2026-10-22'))
        self.operator([self.official(**{'Paid SIM Category':''})],at='2026-10-23')
        self.assertEqual(json.loads(self.fact()['evidence_json'])['observation']['handset'],'-')

    def test_equal_authority_handset_dash_conflict_remains_explicit(self):
        self.revision([f.row(DataActivare='20261015')],'2026-10-20')
        self.operator([self.official(**{'Paid SIM Category':'SIM with initial credit >= 3 EUR'})])
        self.operator([self.official(**{'Paid SIM Category':'-'})])
        self.assertIn('handset_conflict',json.loads(self.fact()['reasons']))
        self.assertEqual(json.loads(self.fact()['evidence_json'])['observation']['handset'],'')

    def test_partial_month_keeps_old_month_and_company_namespace(self):
        self.revision([f.row()],period_start='2026-01-01',period_end='2026-03-31')
        self.revision([f.row(IMEI='0000000000000000020',Activat='000000000000000002',DocumentDetailId='NEW',DataActivare='20261001')],period_start='2026-10-01',period_end='2026-10-20')
        self.operator([self.official()],company='OtherCo')
        self.assertEqual(self.c.execute("SELECT COUNT(*) FROM activation_facts WHERE company='ExampleCo'").fetchone()[0],2)
        self.assertEqual(self.c.execute("SELECT month FROM activation_facts WHERE company='ExampleCo' AND serial='000000000000000001'").fetchone()[0],'2026-03')

    def test_operator_xlsx_named_headers_strict_text(self):
        import zipfile
        headers=['Paid SIM Category','DATE_OF_ACTIVATION','SerieText','COUNTY_OF_ACTIVATION']
        path=f.fixture(self.root/'op.xlsx',[self.official()],headers=headers,header_row=1)
        # The fixture's single sheet is renamed to the real upstream contract.
        with zipfile.ZipFile(path) as z:parts={n:z.read(n).replace(b'name="SIM"',b'name="Detailed SIM"') if n=='xl/workbook.xml' else z.read(n) for n in z.namelist()}
        with zipfile.ZipFile(path,'w') as z:
            for n,b in parts.items():z.writestr(n,b)
        a.import_files(self.c,self.root/'data',[path],operator='vodafone',source_kind='operator',company='ExampleCo')
        self.assertIn('operator_without_distribution',self.fact()['reasons'])

    def test_exact_excel_text_marker_is_preserved_as_provenance(self):
        value=self.official();value['SerieText']="'"+value['SerieText'];value['serial']=value['SerieText'][1:]
        self.operator([value]);self.assertEqual(self.fact()['serial'],value['serial'])
        raw=self.c.execute('SELECT raw_json FROM activation_observations').fetchone()[0]
        self.assertEqual(json.loads(raw)['SerieText'],value['SerieText'])
        value['SerieText']='x'+value['serial']
        with self.assertRaisesRegex(ValueError,'serial text'):self.operator([value])

    def test_version2_migration_is_resumable(self):
        self.c.close();path=self.root/'data'/'activations.sqlite'
        c=sqlite3.connect(path)
        for column in ['source_kind','source_at','period_start','period_end','company']:c.execute('ALTER TABLE activation_imports DROP COLUMN '+column)
        c.execute("UPDATE activation_meta SET value='2' WHERE key='schema_version'");c.commit();c.close()
        self.c=a.connect(self.root/'data');self.assertEqual(self.c.execute("SELECT value FROM activation_meta WHERE key='schema_version'").fetchone()[0],'3')
        self.c.close();self.c=a.connect(self.root/'data')
        self.revision([f.row()]);self.assertEqual(self.fact()['net_quantity'],1)

if __name__=='__main__':unittest.main()
