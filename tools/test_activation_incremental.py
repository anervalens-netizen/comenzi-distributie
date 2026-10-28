"""Incremental reconciliations agree with a clean full rebuild on synthetic data."""
import gzip
import json
import tempfile
import unittest
from pathlib import Path
import activations as a
from test_activations import fixture, row


class IncrementalTests(unittest.TestCase):
    def test_full_equivalence_revisions_returns_conflicts_and_orphans(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); data=root/'data'; c=a.connect(data)
            n=0
            def internal(rows, at, company='ExampleCo'):
                nonlocal n
                n+=1; path=fixture(root/f'{n}.xlsx',rows)
                return a.import_files(c,data,[path],operator='vodafone',source_at=at,defer_rebuild=True)
            def official(records, at):
                nonlocal n
                n+=1; path=root/f'{n}.json.gz'
                with gzip.open(path,'wt') as out:json.dump(records,out)
                return a.import_files(c,data,[path],operator='vodafone',source_kind='operator',company='ExampleCo',source_at=at,defer_rebuild=True)
            def rec(*receipts):
                ids=[r['import_id'] for receipt in receipts for r in receipt['files'] if r['status']=='imported']
                c.execute('BEGIN IMMEDIATE'); delta=a.reconcile_imports(c,ids); c.commit()
                actual={table:[tuple(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY 1,2,3')] for table in ('activation_facts','activation_effective_movements')}
                conflicts=sorted(tuple(r) for r in c.execute("SELECT * FROM activation_meta WHERE key LIKE 'conflict:%'"))
                c.execute('BEGIN IMMEDIATE');a.rebuild(c);c.commit()
                expected={table:[tuple(r) for r in c.execute(f'SELECT * FROM {table} ORDER BY 1,2,3')] for table in actual}
                self.assertEqual(actual,expected)
                self.assertEqual(conflicts,sorted(tuple(r) for r in c.execute("SELECT * FROM activation_meta WHERE key LIKE 'conflict:%'")))
                return delta
            op=lambda serial,date: {'SerieText':serial,'DATE_OF_ACTIVATION':date,'COUNTY_OF_ACTIVATION':'Test','Paid SIM Category':'-'}
            first=internal([row(DataActivare='20240115'),row(DocumentDetailId='B',IMEI='0000000000000000020',Activat='000000000000000002')],'2026-01-01')
            self.assertTrue(rec(first)['full'])
            one=internal([row(SiteCode='SITE-B',DataActivare='20241015')],'2026-10-20')
            two=internal([row(DocumentDetailId='RETURN',Qtty='-1',DataVDF='20241016')],'2026-10-21')
            third=official([op('000000000000000001','2024-10-15'),op('000000000000000099','2025-01-02')],'2026-10-22')
            delta=rec(one,two,third)
            self.assertIn(('ExampleCo','vodafone','000000000000000099'),delta['serials'])
            self.assertIn('SITE-A',delta['sites']);self.assertIn('SITE-B',delta['sites'])
            # A different IMEI sharing the serial forces both components to be reconciled.
            conflict=internal([row(DocumentDetailId='C',IMEI='0000000000000000030',Activat='000000000000000001')],'2026-10-23')
            delta=rec(conflict)
            self.assertIn(('ExampleCo','vodafone','0000000000000000010'),delta['imeis'])
            other=internal([row(Firma='OtherCo',DocumentDetailId='D',IMEI='0000000000000000040',Activat='000000000000000001')],'2026-10-24')
            rec(other)
            old=internal([row(SiteCode='SITE-OLD',DataActivare='20200101')],'2020-01-01')
            rec(old)
            c.close()

if __name__=='__main__': unittest.main()
from unittest.mock import patch
from activation_job import run_job
from test_activations import digi_row

class JobIncrementalTests(unittest.TestCase):
    def test_two_batches_one_reconciliation_and_noop_without_rebuild(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); data=root/'data'
            a1=fixture(root/'a.xlsx',[row()])
            a2=fixture(root/'b.xlsx',[row(DocumentDetailId='B',IMEI='0000000000000000020',Activat='000000000000000002')])
            with patch.object(a,'rebuild',wraps=a.rebuild) as rebuild:
                run_job(data,[{'files':[str(a1)],'operator':'vodafone'},{'files':[str(a2)],'operator':'vodafone'}])
                self.assertEqual(rebuild.call_count,1)
            with patch.object(a,'rebuild',wraps=a.rebuild) as rebuild:
                run_job(data,[{'files':[str(a1)],'operator':'vodafone'}])
                self.assertEqual(rebuild.call_count,0)

    def test_digi_row_five_and_excel_date_epochs(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);data=root/'data';c=a.connect(data)
            path=fixture(root/'digi.xlsx',[digi_row()],headers=a.DIGI_HEADERS,header_row=5)
            a.import_files(c,data,[path],operator='digi',site_aliases={('ExampleCo','TR Example'):'SITE-A'})
            self.assertEqual(c.execute('SELECT candidate_site FROM activation_facts').fetchone()[0],'SITE-A')
            c.close()
        self.assertEqual(a.excel_date('1'), '1900-01-01')
        self.assertEqual(a.excel_date('61'), '1900-03-01')
        self.assertEqual(a.excel_date('0',True), '1904-01-01')
        for invalid in ('60','1.5','-1','9999999'):
            with self.assertRaises(a.ImportError):a.excel_date(invalid)
    def test_operator_workbook_styled_excel_date(self):
        import zipfile
        ns=a.NS['s']
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'operator.xlsx'
            def write(style='1',epoch='0'):
                with zipfile.ZipFile(path,'w') as z:
                    z.writestr('xl/workbook.xml',f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="{epoch}"/><sheets><sheet name="Detailed SIM" r:id="r1"/></sheets></workbook>')
                    z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                    z.writestr('xl/styles.xml',f'<styleSheet xmlns="{ns}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>')
                    z.writestr('xl/worksheets/sheet1.xml',f'<worksheet xmlns="{ns}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>SerieText</t></is></c><c r="B1" t="inlineStr"><is><t>DATE_OF_ACTIVATION</t></is></c><c r="C1" t="inlineStr"><is><t>COUNTY_OF_ACTIVATION</t></is></c><c r="D1" t="inlineStr"><is><t>Paid SIM Category</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>000000000000000001</t></is></c><c r="B2" s="{style}"><v>61</v></c><c r="C2" t="inlineStr"><is><t>Test</t></is></c><c r="D2" t="inlineStr"><is><t>-</t></is></c></row></sheetData></worksheet>')
            write(); values=list(a.versions.operator_records(path,a.workbook))
            self.assertEqual(values[0][1]['DATE_OF_ACTIVATION'],'1900-03-01')
            write(epoch='1');values=list(a.versions.operator_records(path,a.workbook))
            self.assertEqual(values[0][1]['DATE_OF_ACTIVATION'],'1904-03-02')
            write(style='0')
            with self.assertRaisesRegex(a.ImportError,'date style'):list(a.versions.operator_records(path,a.workbook))

    def test_connected_identity_lookups_use_complete_index_keys(self):
        # Without statistics SQLite can otherwise choose the opposite identity
        # index and scan an entire company/provider for every touched identity.
        with tempfile.TemporaryDirectory() as d:
            root=Path(d); data=root/'data'; c=a.connect(data)
            first=fixture(root/'one.xlsx',[row()])
            second=fixture(root/'two.xlsx',[row(SiteCode='SITE-B')])
            a.import_files(c,data,[first],operator='vodafone')
            receipt=a.import_files(c,data,[second],operator='vodafone',source_at='2026-10-28',defer_rebuild=True)
            statements=[]
            c.set_trace_callback(statements.append)
            c.execute('BEGIN IMMEDIATE');a.reconcile_imports(c,[receipt['files'][0]['import_id']]);c.commit()
            c.set_trace_callback(None)
            lookups=[q for q in statements if 'INDEXED BY' in q and q.startswith('SELECT')]
            self.assertGreaterEqual(len(lookups),4)
            observed=set()
            for q in lookups:
                if 'WHERE company=' not in q: continue
                expected='serial' if ' AND serial=' in q else 'imei'
                plan=' '.join(r[3] for r in c.execute('EXPLAIN QUERY PLAN '+q))
                self.assertIn('company=? AND provider=? AND '+expected+'=?',plan,plan)
                observed.add(('activation_effective_movements' if 'activation_effective_movements' in q else 'activation_movements',expected))
            self.assertEqual(observed,{('activation_movements','serial'),('activation_movements','imei'),('activation_effective_movements','serial'),('activation_effective_movements','imei')})
            c.close()
