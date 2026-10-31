"""Synthetic Digi operator observations: exact identity and provider/company isolation."""
import datetime as dt
import json
import unittest
import zipfile
import activations as a
import test_activations as f

class DigiOperatorTests(unittest.TestCase):
    setUp=f.ActivationsTests.setUp
    tearDown=f.ActivationsTests.tearDown
    fact=f.ActivationsTests.fact
    aliases={('ExampleCo','TR Example'):'SITE-A'}

    def internal(self, rows):
        self.n+=1
        p=f.fixture(self.root/f'internal-{self.n}.xlsx',rows,headers=a.DIGI_HEADERS,header_row=1)
        return a.import_files(self.c,self.root/'data',[p],operator='digi',site_aliases=self.aliases,source_at='2026-10-29')

    def official(self,serial='0000000000000000010',date='2026-10-15',company='EXAMPLECO'):
        return {'Distribuitor':company,'Seria SIM (iccid)':serial,'Data activare':date}

    def operator(self,rows,at='2026-10-29',numeric=None,numeric_date=False,trailing=False,**kw):
        self.n+=1
        p=f.fixture(self.root/f'op-{self.n}.xlsx',rows,headers=['Distribuitor','Seria SIM (iccid)','Data activare'],header_row=1,numeric=numeric)
        with zipfile.ZipFile(p) as z:items={n:z.read(n) for n in z.namelist()}
        items['xl/workbook.xml']=items['xl/workbook.xml'].replace(b'name="SIM"',b'name="activari"')
        if trailing:
            items['xl/worksheets/sheet1.xml']=items['xl/worksheets/sheet1.xml'].replace(b'</row>',b'<c r="I1" s="0"/></row>',1)
        if numeric_date:
            serial=(dt.date(2026,10,15)-dt.date(1899,12,30)).days
            items['xl/worksheets/sheet1.xml']=items['xl/worksheets/sheet1.xml'].replace(b'<c r="C2" t="inlineStr"><is><t>2026-10-15</t></is></c>',f'<c r="C2" s="1"><v>{serial}</v></c>'.encode())
            items['xl/styles.xml']=f'<styleSheet xmlns="{a.NS["s"]}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'.encode()
        with zipfile.ZipFile(p,'w') as z:
            for n,data in items.items():z.writestr(n,data)
        options=dict(operator='digi',source_kind='operator',company='ExampleCo',source_at=at,period_start='2026-10-01',period_end='2026-10-28',site_aliases=self.aliases)
        options.update(kw)
        return a.import_files(self.c,self.root/'data',[p],**options),p,options

    def test_exact_serial_activates_blank_internal_and_stays_after_internal_refresh(self):
        self.internal([f.digi_row(Activat='',DataDigi='')])
        result,p,options=self.operator([self.official()],numeric_date=True,trailing=True)
        self.assertEqual(result['files'][0]['rows'],1)
        fact=self.fact()
        self.assertEqual((fact['serial'],fact['month'],fact['candidate_site']),('0000000000000000010','2026-10','SITE-A'))
        self.assertEqual(a.import_files(self.c,self.root/'data',[p],**options)['files'][0]['status'],'already_imported')
        self.internal([f.digi_row(DataDigi='2026-09-15')])
        self.assertEqual(self.fact()['candidate_site'],'SITE-A')
        self.assertEqual(self.fact()['activation_date'],'2026-10-15')

    def test_company_isolation_and_missing_distribution(self):
        self.internal([f.digi_row(Canal='OtherCo',Activat='',DataDigi='')])
        self.operator([self.official()])
        fact=self.fact()
        self.assertEqual(fact['company'],'ExampleCo')
        self.assertIsNone(fact['candidate_site'])
        self.assertIn('operator_without_distribution',fact['reasons'])

    def test_latest_correction_and_omission_do_not_delete_old_observation(self):
        self.internal([f.digi_row(Activat='',DataDigi='')])
        self.operator([self.official()],at='2026-10-29')
        self.operator([self.official(date='2026-10-16')],at='2026-10-30')
        self.operator([self.official(serial='0000000000000000020')],at='2026-10-31')
        self.assertEqual(self.c.execute("SELECT activation_date FROM activation_facts WHERE serial='0000000000000000010'").fetchone()[0],'2026-10-16')

    def test_numeric_serial_wrong_company_and_out_of_period_rejected_atomically(self):
        for opts,record in [({'numeric':'Seria SIM (iccid)'},self.official()),({},self.official(company='OtherCo')),({},self.official(date='2026-10-29')),({},self.official(serial='000000000000000001'))]:
            with self.assertRaises(ValueError):self.operator([record],**opts)
        self.assertEqual(self.c.execute('SELECT COUNT(*) FROM activation_imports').fetchone()[0],0)

    def test_incremental_matches_full_and_operator_before_internal(self):
        self.operator([self.official()],defer_rebuild=True)
        batch=self.c.execute('SELECT id FROM activation_imports').fetchone()[0]
        self.c.execute('BEGIN IMMEDIATE');a.reconcile_imports(self.c,[batch]);self.c.commit()
        self.internal([f.digi_row(Activat='',DataDigi='')])
        self.assertEqual(self.fact()['candidate_site'],'SITE-A')
        # Exercise observation -> exact blank-serial IMEI closure, then compare full rebuild.
        result,_,_=self.operator([self.official(date='2026-10-16')],at='2026-10-30',defer_rebuild=True)
        self.c.execute('BEGIN IMMEDIATE');delta=a.reconcile_imports(self.c,[result['files'][0]['import_id']]);self.c.commit()
        self.assertIn(('ExampleCo','digi','0000000000000000010'),delta['imeis'])
        before=[tuple(r) for r in self.c.execute('SELECT * FROM activation_facts ORDER BY company,provider,serial')]
        self.c.execute('BEGIN IMMEDIATE');a.rebuild(self.c);self.c.commit()
        self.assertEqual(before,[tuple(r) for r in self.c.execute('SELECT * FROM activation_facts ORDER BY company,provider,serial')])

    def test_returns_and_retail_remain_unassigned(self):
        self.internal([f.digi_row(Activat='',DataDigi=''),f.digi_row(Activat='',DataDigi='',Data='2026-10-20',Cantitate='-1')])
        self.operator([self.official()])
        self.assertIsNone(self.fact()['candidate_site'])

if __name__=='__main__':unittest.main()
